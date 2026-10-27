// ============================================================================
// FISCAL 3.0 — CALENDÁRIO DE OBRIGAÇÕES ACESSÓRIAS (migration 0055)
//
// O QUE JÁ EXISTIA (e NÃO é reimplementado aqui)
//   • `fiscal.ts`       — emissão NF-e/NFC-e, eventos, cancelamento, inutilização;
//   • `fiscalRegras.ts` — qual tributação vai no item, a partir de REGRA
//                         CADASTRADA (nenhuma alíquota no código);
//   • `fiscalProvider.ts` — quem fala com a SEFAZ.
//
// O QUE FALTAVA
//   Saber se as obrigações ACESSÓRIAS (SPED Fiscal, Contribuições, Reinf,
//   DCTFWeb, eSocial, SITFIS, DEFIS, DAS...) estão em dia: qual vence quando,
//   o que já foi entregue, com que protocolo e onde está o arquivo.
//
// REGRAS
//   • vencimento é DERIVADO (competência + dia de vencimento da obrigação);
//     "atrasada" também — não existe coluna que envelhece sozinha no banco;
//   • entregar exige PROTOCOLO (a prova da entrega), como o banco também exige;
//   • NENHUM imposto é calculado e NENHUMA alíquota é escrita aqui. Este módulo
//     controla PRAZO e PROVA, não apuração.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa } from './empresa';
import { parseId } from './validate';
import type { Row } from './store';

const R_OBRIGACAO = () => getResource('fiscal_obrigacoes')!;
const R_ENTREGA = () => getResource('fiscal_obrigacao_entregas')!;

const hoje = (): string => new Date().toISOString().slice(0, 10);
const competenciaValida = (v: unknown): string => {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new HttpError(400, 'Informe a competência no formato AAAA-MM.', { competencia: 'Ex.: 2026-03' });
  }
  return s;
};

/** Último dia do mês da competência — sem depender de fuso do servidor. */
const ultimoDia = (competencia: string): string => {
  const [ano, mes] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes, 0));
  return d.toISOString().slice(0, 10);
};

/**
 * Vencimento DA COMPETÊNCIA: dia informado no mês SEGUINTE (padrão das
 * obrigações mensais brasileiras). O dia é limitado ao último dia do mês para
 * não gerar "31 de fevereiro".
 */
export function vencimentoDe(competencia: string, diaVencimento: number): string {
  const [ano, mes] = competencia.split('-').map(Number);
  const seguinte = new Date(Date.UTC(ano, mes, 1));
  const anoAlvo = seguinte.getUTCFullYear();
  const mesAlvo = String(seguinte.getUTCMonth() + 1).padStart(2, '0');
  const limite = ultimoDia(`${anoAlvo}-${mesAlvo}`);
  const dia = Math.min(Math.max(1, diaVencimento), Number(limite.slice(8, 10)));
  return `${anoAlvo}-${mesAlvo}-${String(dia).padStart(2, '0')}`;
}

export type StatusEntrega = 'pendente' | 'entregue' | 'atrasada' | 'dispensada';

/** Status DERIVADO: o banco guarda o fato (entregue/dispensada); o atraso é conta. */
export function statusDerivado(entrega: Row | null, vencimento: string): StatusEntrega {
  if (entrega?.status === 'entregue') return 'entregue';
  if (entrega?.status === 'dispensada') return 'dispensada';
  return vencimento < hoje() ? 'atrasada' : 'pendente';
}

// ----------------------------------------------------------------------------
// GET /api/fiscal/calendario?de=AAAA-MM&ate=AAAA-MM
// ----------------------------------------------------------------------------
export async function calendarioFiscal(req: Request, res: Response) {
  const r = R_OBRIGACAO();
  const actor = currentUser(req);
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();

  const competenciaAtual = hoje().slice(0, 7);
  const de = typeof req.query.de === 'string' && /^\d{4}-\d{2}$/.test(req.query.de) ? req.query.de : competenciaAtual;
  const ate = typeof req.query.ate === 'string' && /^\d{4}-\d{2}$/.test(req.query.ate) ? req.query.ate : de;
  if (ate < de) throw new HttpError(400, 'A competência final não pode ser anterior à inicial.');

  const competencias: string[] = [];
  let [ano, mes] = de.split('-').map(Number);
  for (let guarda = 0; guarda < 60; guarda++) {
    const comp = `${ano}-${String(mes).padStart(2, '0')}`;
    competencias.push(comp);
    if (comp >= ate) break;
    mes += 1;
    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
  }

  const obrigacoes = (await s.list(r, { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, ativo: true }, sort: 'nome', dir: 'asc' })).rows;
  const entregas = (await s.list(R_ENTREGA(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } })).rows;
  const porChave = new Map<string, Row>();
  for (const e of entregas) porChave.set(`${Number(e.obrigacao_id)}#${String(e.competencia)}`, e);

  type Linha = {
    obrigacao_id: number;
    codigo: string;
    nome: string;
    tipo: string;
    periodicidade: string;
    competencia: string;
    vencimento: string;
    status: StatusEntrega;
    entrega_id: number | null;
    protocolo: unknown;
    arquivo_ref: unknown;
    entregue_em: unknown;
    motivo_dispensa: unknown;
    dias_para_vencer: number;
  };
  const linhas: Linha[] = [];
  for (const comp of competencias) {
    for (const ob of obrigacoes) {
      // Obrigação com início posterior à competência não se aplica a ela.
      if (ob.inicio_competencia && String(ob.inicio_competencia).slice(0, 7) > comp) continue;
      if (String(ob.periodicidade) === 'anual' && comp.slice(5, 7) !== '12') continue;
      const entrega = porChave.get(`${Number(ob.id)}#${comp}`) ?? null;
      const venc = vencimentoDe(comp, Number(ob.dia_vencimento ?? 15));
      const status = statusDerivado(entrega, venc);
      linhas.push({
        obrigacao_id: Number(ob.id),
        codigo: String(ob.codigo),
        nome: String(ob.nome),
        tipo: String(ob.tipo),
        periodicidade: String(ob.periodicidade),
        competencia: comp,
        vencimento: venc,
        status,
        entrega_id: entrega ? Number(entrega.id) : null,
        protocolo: entrega?.protocolo ?? null,
        arquivo_ref: entrega?.arquivo_ref ?? null,
        entregue_em: entrega?.entregue_em ?? null,
        motivo_dispensa: entrega?.motivo_dispensa ?? null,
        dias_para_vencer: Math.round((new Date(`${venc}T12:00:00Z`).getTime() - new Date(`${hoje()}T12:00:00Z`).getTime()) / 86400000),
      });
    }
  }

  const contagem = (st: StatusEntrega) => linhas.filter((l) => l.status === st).length;

  return res.json({
    de,
    ate,
    hoje: hoje(),
    regra:
      'O vencimento é calculado (competência + dia da obrigação, no mês seguinte) e o atraso é derivado. O ERP não calcula imposto nem escreve alíquota.',
    resumo: {
      obrigacoes_ativas: obrigacoes.length,
      linhas: linhas.length,
      pendentes: contagem('pendente'),
      atrasadas: contagem('atrasada'),
      entregues: contagem('entregue'),
      dispensadas: contagem('dispensada'),
      proximas: linhas.filter((l) => l.status === 'pendente' && l.dias_para_vencer >= 0 && l.dias_para_vencer <= 30).length,
    },
    obrigacoes: linhas.sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.nome.localeCompare(b.nome)),
  });
}

// ----------------------------------------------------------------------------
// POST /api/fiscal/obrigacoes/:id/entregas — registra/atualiza a entrega
// ----------------------------------------------------------------------------
export async function registrarEntregaFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_OBRIGACAO();
  checkAccess(r, actor, 'update');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const competencia = competenciaValida(body.competencia);
  const status = String(body.status ?? 'entregue');
  if (!['entregue', 'pendente', 'dispensada'].includes(status)) {
    throw new HttpError(400, 'Status de entrega inválido.', { status: 'Use entregue, pendente ou dispensada.' });
  }
  const protocolo = body.protocolo === undefined ? null : String(body.protocolo ?? '').trim() || null;
  const arquivoRef = body.arquivo_ref === undefined ? null : String(body.arquivo_ref ?? '').trim() || null;
  const motivo = body.motivo_dispensa === undefined ? null : String(body.motivo_dispensa ?? '').trim() || null;

  if (status === 'entregue' && !protocolo) {
    throw new HttpError(400, 'Informe o protocolo da entrega.', { protocolo: 'Obrigatório para marcar como entregue' });
  }
  if (status === 'dispensada' && !motivo) {
    throw new HttpError(400, 'Informe o motivo da dispensa.', { motivo_dispensa: 'Obrigatório' });
  }

  const resultado = await s.transaction(async (tx) => {
    const obrigacao = assertRegistroDaEmpresa(r, await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }, tx), escopo);
    const existente = await s.findOneWhere(R_ENTREGA(), { obrigacao_id: id, competencia }, tx);
    const dados: Record<string, unknown> = {
      empresa_id: escopo.empresaId,
      obrigacao_id: id,
      competencia,
      status,
      protocolo: status === 'entregue' ? protocolo : null,
      arquivo_ref: arquivoRef,
      entregue_em: status === 'entregue' ? new Date().toISOString() : null,
      responsavel_id: actor.id ?? null,
      motivo_dispensa: status === 'dispensada' ? motivo : null,
      observacoes: body.observacoes === undefined ? null : String(body.observacoes ?? '') || null,
    };
    const salvo = existente
      ? await s.update(R_ENTREGA(), Number(existente.id), dados, tx)
      : await s.insert(R_ENTREGA(), dados, tx);
    return {
      entrega_id: Number((salvo ?? existente)?.id),
      obrigacao: { id: Number(obrigacao.id), codigo: String(obrigacao.codigo ?? ''), nome: String(obrigacao.nome ?? '') },
      competencia,
      status,
      vencimento: vencimentoDe(competencia, Number(obrigacao.dia_vencimento ?? 15)),
    };
  });

  return res.json({
    ...resultado,
    atualizado: true,
    // O status exibido na tela é sempre o DERIVADO (atraso é conta, não coluna).
    status_derivado: statusDerivado(
      { status: resultado.status } as Row,
      resultado.vencimento
    ),
  });
}

// ----------------------------------------------------------------------------
// GET /api/fiscal/obrigacoes/:id/historico
// ----------------------------------------------------------------------------
export async function historicoObrigacaoFiscal(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_OBRIGACAO();
  checkAccess(r, actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const obrigacao = assertRegistroDaEmpresa(r, await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }), escopo);
  const entregas = (await s.list(R_ENTREGA(), { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, obrigacao_id: id }, sort: 'competencia', dir: 'desc' })).rows;
  return res.json({
    obrigacao: {
      id: Number(obrigacao.id),
      codigo: String(obrigacao.codigo ?? ''),
      nome: String(obrigacao.nome ?? ''),
      tipo: String(obrigacao.tipo ?? ''),
      periodicidade: String(obrigacao.periodicidade ?? 'mensal'),
      dia_vencimento: Number(obrigacao.dia_vencimento ?? 15),
    },
    entregas: entregas.map((e) => ({
      ...e,
      vencimento: vencimentoDe(String(e.competencia), Number(obrigacao.dia_vencimento ?? 15)),
      status_derivado: statusDerivado(e, vencimentoDe(String(e.competencia), Number(obrigacao.dia_vencimento ?? 15))),
    })),
  });
}
