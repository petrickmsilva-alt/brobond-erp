import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { currentUser } from './auth';
import { checkAccess, createRecord, escopoDe, getStore, toHttpError } from './services';
import { RESOURCES } from './resources';

const PERFIL_RANK: Record<string, number> = { operador: 1, gerente: 2, admin: 3 };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ClassificacaoAbc = { produto_id: number; quantidade_saida_periodo: number; percentual_acumulado: number; classe: 'A' | 'B' | 'C'; prioridade: number; prioridade_classe: number };

/** ABC determinística sobre quantidades de saídas reais, incluindo itens sem giro como C. */
export function calcularClassificacaoAbc(consumo: ReadonlyMap<number, number>, produtosComSaldo: number[], faixaA = 80, faixaB = 95): ClassificacaoAbc[] {
  if (!Number.isFinite(faixaA) || !Number.isFinite(faixaB) || faixaA <= 0 || faixaA >= faixaB || faixaB >= 100) throw new Error('Faixas ABC inválidas.');
  const quantidades = new Map<number, number>();
  for (const [id, qtd] of consumo) if (Number.isInteger(id) && id > 0 && Number.isFinite(qtd) && qtd >= 0) quantidades.set(id, (quantidades.get(id) || 0) + qtd);
  for (const id of produtosComSaldo) if (Number.isInteger(id) && id > 0 && !quantidades.has(id)) quantidades.set(id, 0);
  const ordenados = [...quantidades.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const total = ordenados.reduce((sum, [, qty]) => sum + qty, 0);
  let acumulado = 0;
  return ordenados.map(([produto_id, quantidade_saida_periodo], index) => {
    const inicio = total > 0 ? acumulado / total * 100 : 100;
    const classe: ClassificacaoAbc['classe'] = quantidade_saida_periodo === 0 || total === 0 ? 'C' : inicio < faixaA ? 'A' : inicio < faixaB ? 'B' : 'C';
    acumulado += quantidade_saida_periodo;
    return { produto_id, quantidade_saida_periodo, percentual_acumulado: total > 0 ? Number((acumulado / total * 100).toFixed(4)) : 0, classe, prioridade: index + 1, prioridade_classe: classe === 'A' ? 1 : classe === 'B' ? 2 : 3 };
  });
}

function dateOnly(value: unknown, label: string): string {
  const date = String(value ?? '').trim();
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, `${label} inválida.`);
  }
  return date;
}

/** Cria o plano e o snapshot na transação canônica de inventários. */
export async function criarContagemCiclica(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'create');
  if ((PERFIL_RANK[actor.perfil || 'operador'] ?? 0) < PERFIL_RANK.gerente) {
    throw new HttpError(403, 'Somente gerentes e administradores podem planejar contagens cíclicas.');
  }
  const escopo = escopoDe(actor);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const localId = Number(body.local_id);
  if (!Number.isInteger(localId) || localId <= 0) throw new HttpError(400, 'Selecione um local válido.');
  const inicio = dateOnly(body.periodo_inicio, 'Data inicial do período');
  const fim = dateOnly(body.periodo_fim, 'Data final do período');
  const planejada = dateOnly(body.data_planejada, 'Data planejada');
  if (inicio > fim) throw new HttpError(400, 'O período inicial deve ser anterior ou igual ao final.');
  const responsavel = body.responsavel_id == null || body.responsavel_id === '' ? null : Number(body.responsavel_id);
  if (responsavel !== null && (!Number.isInteger(responsavel) || responsavel <= 0)) throw new HttpError(400, 'Responsável inválido.');
  const key = String(body.idempotency_key ?? '').trim();
  if (key.length < 8 || key.length > 120) throw new HttpError(400, 'Informe uma chave idempotente de 8 a 120 caracteres.');

  const faixaA = Number(body.faixa_a ?? 80);
  const faixaB = Number(body.faixa_b ?? 95);
  if (!Number.isFinite(faixaA) || !Number.isFinite(faixaB) || faixaA <= 0 || faixaA >= faixaB || faixaB >= 100) {
    throw new HttpError(400, 'Faixas cumulativas inválidas: 0 < A < B < 100.');
  }

  const s = getStore();
  try {
    const local = await s.findOneWhere(RESOURCES.locais, { id: localId, empresa_id: escopo.empresaId });
    if (!local) throw new HttpError(404, 'Local não encontrado.');
    if (responsavel !== null && !await s.findOneWhere(RESOURCES.usuarios, { id: responsavel, empresa_id: escopo.empresaId })) {
      throw new HttpError(404, 'Responsável não encontrado.');
    }
    const existente = await s.findOneWhere(RESOURCES.inventarios, { empresa_id: escopo.empresaId, idempotency_key: key });
    if (existente) {
      const faixasExistentes = typeof existente.abc_faixas === 'string' ? JSON.parse(String(existente.abc_faixas)) : existente.abc_faixas;
      if (Number(existente.local_id) !== localId || String(existente.abc_periodo_inicio).slice(0, 10) !== inicio || String(existente.abc_periodo_fim).slice(0, 10) !== fim || String(existente.data_planejada).slice(0, 10) !== planejada || Number(existente.responsavel_id || 0) !== Number(responsavel || 0) || Number(faixasExistentes?.A) !== faixaA || Number(faixasExistentes?.B) !== faixaB) {
        throw new HttpError(409, 'A chave idempotente já foi usada com parâmetros diferentes.');
      }
      res.status(200).json(existente);
      return;
    }

    const [movimentos, estoques] = await Promise.all([
      s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }),
      s.list(RESOURCES.estoques, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId, local_id: localId } }),
    ]);
    if (movimentos.total > movimentos.rows.length || estoques.total > estoques.rows.length) throw new HttpError(409, 'O histórico de movimentações ou o estoque excede o limite seguro para classificação ABC; nenhum plano foi criado.');
    const consumo = new Map<number, number>();
    for (const movimento of movimentos.rows) {
      const dia = String(movimento.data ?? movimento.criado_em ?? '').slice(0, 10);
      if (movimento.tipo !== 'saida' || movimento.estornado === true || dia < inicio || dia > fim) continue;
      if (movimento.local_id != null ? Number(movimento.local_id) !== localId : String(movimento.local ?? '') !== String(local.nome)) continue;
      const produtoId = Number(movimento.produto_id);
      const quantidade = Math.abs(Number(movimento.quantidade));
      if (Number.isInteger(produtoId) && produtoId > 0 && Number.isFinite(quantidade)) {
        consumo.set(produtoId, (consumo.get(produtoId) || 0) + quantidade);
      }
    }
    for (const stock of estoques.rows) {
      const produtoId = Number(stock.produto_id);
      if (Number.isInteger(produtoId) && produtoId > 0 && !consumo.has(produtoId)) consumo.set(produtoId, 0);
    }
    const abcResultado = calcularClassificacaoAbc(consumo, [], faixaA, faixaB);
    const criado = await createRecord(RESOURCES.inventarios, { local_id: localId, observacoes: `Contagem cíclica ABC — ${inicio} a ${fim}` }, actor, {
      escopo,
      cyclicCounting: {
        modalidade: 'ciclica_abc',
        contagem_status: 'PLANEJADA',
        idempotency_key: key,
        classificacao_abc: null,
        prioridade: null,
        data_planejada: planejada,
        responsavel_id: responsavel,
        abc_periodo_inicio: inicio,
        abc_periodo_fim: fim,
        abc_criterio: 'quantidade_saida_movimentacoes_periodo',
        abc_faixas: { A: faixaA, B: faixaB, C: 100, unidade: 'percentual cumulativo' },
        abc_calculado_em: new Date().toISOString(),
        abc_resultado: abcResultado,
      },
    });
    res.status(201).json(criado);
  } catch (error) {
    throw toHttpError(error, RESOURCES.inventarios);
  }
}

export async function listarPlanosContagemCiclica(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const planos = await s.list(RESOURCES.inventarios, { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, modalidade: 'ciclica_abc' }, sort: 'data_planejada', dir: 'asc' });
  res.json(planos.rows);
}
