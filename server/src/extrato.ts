// ============================================================================
// EXTRATO BANCÁRIO PERSISTENTE (P2 §13/§14) — OFX/CSV → conta → transações
// → matching → conciliação.
//
//   • cada linha importada fica gravada em `fin_extrato_transacoes`;
//   • a importação é IDEMPOTENTE por (conta, hash da linha): o FITID do OFX
//     (ou um hash do conteúdo) impede que a mesma transação entre duas vezes;
//   • matching com critério confiável (candidato ÚNICO por valor/líquido +
//     data): casa sozinho; ambiguidade fica para confirmação manual;
//   • confirmação manual e divergência são endpoints próprios, auditados.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import type { Resource } from './resources';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { currentUser, type AuthUser } from './auth';
import { aplicarFiltroEmpresa, assertRegistroDaEmpresa, escopoDoAtor } from './empresa';
import { round2 } from './utils';
import { casarLinhaExtrato, efetuarBaixa, pareceOFX, parseLinhasExtrato, type LinhaExtrato } from './financeiro';
import type { Row } from './store';

export const R_EXTRATO: Resource = {
  key: 'fin_extrato_transacoes',
  table: 'fin_extrato_transacoes',
  label: 'Transações de extrato',
  singular: 'Transação de extrato',
  labelFields: ['descricao'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'conta_id', label: 'Conta', type: 'integer' },
    { name: 'origem', label: 'Origem', type: 'text' },
    { name: 'linha_hash', label: 'Identificador', type: 'text', readonly: true },
    { name: 'fitid', label: 'FITID', type: 'text' },
    { name: 'data', label: 'Data', type: 'date' },
    { name: 'valor', label: 'Valor', type: 'money' },
    { name: 'direcao', label: 'Direção', type: 'text' },
    { name: 'descricao', label: 'Descrição', type: 'text' },
    { name: 'documento', label: 'Documento', type: 'text' },
    { name: 'codigo_movimento', label: 'Cód. movimento', type: 'text' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'status', label: 'Status', type: 'text' },
    { name: 'motivo', label: 'Motivo', type: 'text' },
    { name: 'conciliado_em', label: 'Conciliado em', type: 'datetime', readonly: true },
    { name: 'importado_em', label: 'Importado em', type: 'datetime', readonly: true },
  ],
};

/**
 * Identificador estável da linha: FITID quando o banco fornece (OFX), senão
 * um hash do conteúdo. É a chave da idempotência de importação.
 */
export function hashLinhaExtrato(linha: { fitid?: string | null; data?: string; valor?: number; direcao?: string; descricao?: string; documento?: string; codigo_movimento?: string }): string {
  const fitid = String(linha.fitid || '').trim();
  if (fitid) return `fitid:${fitid.toLowerCase()}`;
  const base = [String(linha.data || ''), round2(Number(linha.valor || 0)).toFixed(2), String(linha.direcao || ''), String(linha.descricao || '').toLowerCase().trim(), String(linha.documento || ''), String(linha.codigo_movimento || '')].join('|');
  return `h:${createHash('sha1').update(base).digest('hex')}`;
}

export async function linhaDuplicada(contaId: number, hash: string): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(R_EXTRATO, { conta_id: contaId, linha_hash: hash });
}

/**
 * POST /api/financeiro/extrato/importar
 * Importa OFX/CSV colado para uma conta, sem duplicatas, e concilia o que
 * casar com critério confiável (candidato único por valor/líquido + data).
 */
export async function importarExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const contaId = Number(body.conta_id || 0);
  if (!(contaId > 0)) throw new HttpError(400, 'Informe a conta bancária da importação (conta_id).', { conta_id: 'Obrigatório' });
  const s = getStore();
  const conta = assertRegistroDaEmpresa(getResource('contas_financeiras')!, await s.get(getResource('contas_financeiras')!, contaId), escopo);

  const conteudo = String(body.conteudo || body.texto || body.csv || body.extrato || body.ofx || '');
  const fonte = pareceOFX(conteudo) ? 'ofx' : 'csv';
  const linhas = conteudo ? parseLinhasExtrato({ [fonte === 'ofx' ? 'ofx' : 'texto']: conteudo }) : parseLinhasExtrato(body);
  if (!linhas.length) throw new HttpError(400, 'Nenhuma linha válida no extrato. Cole o conteúdo OFX ou linhas data;valor;descrição.');

  const importadas: Row[] = [];
  let duplicadas = 0;
  for (const linha of linhas) {
    const hash = hashLinhaExtrato(linha);
    if (await linhaDuplicada(contaId, hash)) {
      duplicadas++;
      continue;
    }
    const row = await s.insert(R_EXTRATO, {
      empresa_id: escopo.empresaId,
      conta_id: contaId,
      origem: fonte,
      linha_hash: hash,
      fitid: linha.fitid ?? null,
      data: linha.data || null,
      valor: round2(linha.valor),
      direcao: linha.direcao ?? 'entrada',
      descricao: linha.descricao || null,
      status: 'importada',
    });
    importadas.push(row);
  }

  // Matching + conciliação das linhas novas.
  const lancR = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 100000, filter: aplicarFiltroEmpresa(getResource('lancamentos_financeiros')!, undefined, escopo) });
  const pendentes = lancR.rows.filter((l) => String(l.status) === 'pendente' && ['receita', 'despesa'].includes(String(l.tipo)));
  const conciliadas: { extrato_id: number; lancamento_id: number; valor: number }[] = [];
  const pendentesDeConciliar: { extrato_id: number; data: string | null; valor: number; descricao: string | null }[] = [];

  for (const linha of importadas) {
    const achado = casarLinhaExtrato({ data: String(linha.data || ''), valor: Number(linha.valor), descricao: String(linha.descricao || '') }, pendentes);
    if (!achado) {
      pendentesDeConciliar.push({ extrato_id: Number(linha.id), data: (linha.data as string | null) ?? null, valor: Number(linha.valor), descricao: (linha.descricao as string | null) ?? null });
      continue;
    }
    try {
      await efetuarBaixa(
        { id: actor.id || null, name: actor.name },
        Number(achado.id),
        { data: String(linha.data || undefined) || undefined, conta_id: contaId, origem: 'extrato', nota: `Conciliado com extrato ${fonte.toUpperCase()}${linha.fitid ? ` (FITID ${linha.fitid})` : ''} — ${String(linha.descricao || '').slice(0, 80)}` }
      );
    } catch {
      // Título deixou de estar pendente (corrida): a linha segue para manual.
      pendentesDeConciliar.push({ extrato_id: Number(linha.id), data: (linha.data as string | null) ?? null, valor: Number(linha.valor), descricao: (linha.descricao as string | null) ?? null });
      continue;
    }
    await s.update(R_EXTRATO, Number(linha.id), { status: 'conciliada', lancamento_id: Number(achado.id), conciliado_em: new Date().toISOString() });
    pendentes.splice(pendentes.indexOf(achado), 1);
    conciliadas.push({ extrato_id: Number(linha.id), lancamento_id: Number(achado.id), valor: Number(linha.valor) });
  }

  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'fin_extrato_transacoes',
    registro_id: contaId,
    descricao: `Extrato ${fonte.toUpperCase()} importado na conta "${conta.nome}": ${importadas.length} linha(s) nova(s), ${duplicadas} duplicada(s) ignorada(s), ${conciliadas.length} conciliada(s)`,
    dados: { conta_id: contaId, fonte, importadas: importadas.length, duplicadas, conciliadas: conciliadas.length },
  });

  res.json({ ok: true, fonte, conta_id: contaId, importadas: importadas.length, duplicadas, conciliadas: conciliadas.length, conciliadas_detalhe: conciliadas, pendentes: pendentesDeConciliar });
}

/** GET /api/financeiro/extrato — linhas importadas (filtro conta/status). */
export async function listarExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const filtro: Record<string, unknown> = {};
  if (req.query.conta_id) filtro.conta_id = Number(req.query.conta_id);
  if (req.query.status) filtro.status = String(req.query.status);
  const out = await s.list(R_EXTRATO, { page: Math.max(1, Number(req.query.page) || 1), pageSize: Math.min(500, Number(req.query.pageSize) || 100), filter: aplicarFiltroEmpresa(R_EXTRATO, filtro, escopo) });
  res.json({ total: out.total, linhas: out.rows });
}

/**
 * POST /api/financeiro/extrato/:id/conciliar — confirmação MANUAL.
 * O operador casa a linha do extrato com o título que ele escolheu; baixa
 * parcial quando a linha vale menos que o título.
 */
export async function conciliarLinhaManual(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const linha = assertRegistroDaEmpresa(R_EXTRATO, await s.get(R_EXTRATO, Number(req.params.id)), escopo);
  if (String(linha.status) === 'conciliada') throw new HttpError(409, 'Esta linha já está conciliada.');
  const lancId = Number((req.body || {}).lancamento_id || 0);
  if (!(lancId > 0)) throw new HttpError(400, 'Informe o lançamento a conciliar (lancamento_id).', { lancamento_id: 'Obrigatório' });
  const lanc = assertRegistroDaEmpresa(getResource('lancamentos_financeiros')!, await s.get(getResource('lancamentos_financeiros')!, lancId), escopo);
  if (String(lanc.status) !== 'pendente') throw new HttpError(409, 'Só se concilia lançamento pendente.');

  const valorLinha = Number(linha.valor || 0);
  const valorTitulo = Number(lanc.valor || 0);
  const resultado = await efetuarBaixa(
    { id: actor.id || null, name: actor.name },
    lancId,
    {
      valor: valorLinha < valorTitulo ? valorLinha : null,
      data: linha.data ? String(linha.data).slice(0, 10) : undefined,
      conta_id: linha.conta_id ?? lanc.conta_id ?? null,
      origem: 'extrato',
      nota: `Conciliação manual — linha #${linha.id} do extrato (${linha.origem})${valorLinha !== valorTitulo ? ` · valor da linha ${valorLinha.toFixed(2)} × título ${valorTitulo.toFixed(2)}` : ''}`,
    }
  );
  await s.update(R_EXTRATO, Number(linha.id), { status: 'conciliada', lancamento_id: lancId, conciliado_em: new Date().toISOString(), motivo: null });
  res.json({ ok: true, extrato_id: Number(linha.id), lancamento_id: lancId, parcial: resultado.parcial, restante: resultado.restante });
}

/** POST /api/financeiro/extrato/:id/divergir — marca divergência (auditoria). */
export async function marcarDivergencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const s = getStore();
  const linha = assertRegistroDaEmpresa(R_EXTRATO, await s.get(R_EXTRATO, Number(req.params.id)), escopo);
  if (String(linha.status) === 'conciliada') throw new HttpError(409, 'Linha já conciliada — o caminho é o estorno, não divergência.');
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5) throw new HttpError(400, 'Descreva a divergência (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  await s.update(R_EXTRATO, Number(linha.id), { status: 'divergente', motivo });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'fin_extrato_transacoes',
    registro_id: Number(linha.id),
    descricao: `Divergência registrada na linha de extrato #${linha.id} (${Number(linha.valor || 0).toFixed(2)} — ${String(linha.descricao || '').slice(0, 60)})`,
    dados: { motivo },
  });
  res.json({ ok: true, extrato_id: Number(linha.id), status: 'divergente' });
}
