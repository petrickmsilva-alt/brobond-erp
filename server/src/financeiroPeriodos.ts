// Controle do período do livro financeiro canônico. Fechamentos legados de
// escrituração continuam com essa abrangência até serem ampliados explicitamente.
// Isto não é um segundo ledger nem inventa fechamento fiscal/SEFAZ.
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { listarTodos } from './paginacaoCompleta';
import { R_EXTRATO } from './extrato';
import { R_GATEWAY_COBRANCAS } from './gateway';
import { R_INTENTS, R_LATE_REVIEWS, R_OPERATIONS, R_PAYOUTS, R_SETTLEMENTS } from '../../modules/payments/infrastructure/resources';
import type { Row, Tx } from './store';

const R = () => getResource('fin_periodos_contabeis')!;
const queues = new Map<number, Promise<unknown>>();
export function competenciaValida(value: unknown): string {
  const s = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s) || s.startsWith('0000')) throw new HttpError(400, 'Competência deve estar no formato AAAA-MM válido.');
  return s;
}

// Escritores PG e fechamento compartilham advisory lock e uma linha de fencing.
// A segunda proteção força 40001 em snapshot SERIALIZABLE antigo. Na memória,
// a fila é somente uma aproximação para demonstração (não simula multiprocesso).
export async function comTravaContabil<T>(empresaId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const executar = () => getStore().transaction(async (tx) => {
    if (tx) await tx.query('SELECT fin_travar_empresa_periodo($1)', [empresaId]);
    return fn(tx);
  }, { isolation: 'read committed' });
  const anterior = queues.get(empresaId) ?? Promise.resolve();
  const proximo = anterior.catch(() => undefined).then(executar);
  queues.set(empresaId, proximo);
  try { return await proximo; } finally { if (queues.get(empresaId) === proximo) queues.delete(empresaId); }
}

export async function assertPeriodosAbertos(empresaId: number, competencias: string[], tx?: Tx): Promise<void> {
  const desejados = new Set(competencias.map(competenciaValida));
  const result = await getStore().list(R(), { page: 1, pageSize: 10000, filter: { empresa_id: empresaId } }, tx);
  if (result.total > result.rows.length) throw new HttpError(409, 'Muitos períodos para validar a escrituração.');
  const fechado = result.rows.find((p) => ['fechando', 'fechado'].includes(String(p.estado)) && desejados.has(String(p.competencia).slice(0, 7)));
  if (fechado) throw new HttpError(409, `A competência ${String(fechado.competencia).slice(0, 7)} está fechada para escrituração.`, undefined, 'PERIODO_FECHADO');
}

type Pendencias = { extratos: number; repasses: number; liquidacoes: number; operacoes: number; pagamentos_tardios: number };
/** Datas ausentes não podem ser presumidas fora da competência e bloqueiam o fechamento. */
async function pendenciasFinanceiras(empresaId: number, competencia: string, tx: Tx): Promise<Pendencias> {
  const inicio = `${competencia}-01`;
  if (tx) {
    const { rows: [r] } = await tx.query(`SELECT
      (SELECT count(*)::int FROM fin_extrato_transacoes e WHERE e.empresa_id=$1 AND e.status IN ('importada','divergente')
        AND (e.data IS NULL OR (e.data >= $2::date AND e.data < $2::date + interval '1 month'))
        AND NOT (e.status='importada' AND EXISTS (
          SELECT 1 FROM payment_payouts p WHERE p.empresa_id=e.empresa_id AND p.bank_transaction_id=e.id
          AND fin_repasse_comprovado(p.empresa_id,p.id)
        ))) AS extratos,
      (SELECT count(*)::int FROM payment_payouts WHERE empresa_id=$1 AND status IN ('IMPORTED','DIVERGENT')
        AND (settlement_date IS NULL OR (settlement_date >= $2::date AND settlement_date < $2::date + interval '1 month'))) AS repasses,
      (SELECT count(*)::int FROM payment_settlements s WHERE s.empresa_id=$1 AND
        (s.status <> 'MATCHED' OR s.dispute_review_required OR NOT EXISTS (
          SELECT 1 FROM payment_payouts p WHERE p.empresa_id=s.empresa_id AND p.id=s.payout_id AND p.status='MATCHED' AND p.bank_transaction_id IS NOT NULL AND fin_repasse_comprovado(p.empresa_id,p.id)))
        AND (s.settlement_date IS NULL OR (s.settlement_date >= $2::date AND s.settlement_date < $2::date + interval '1 month'))) AS liquidacoes,
      ((SELECT count(*)::int FROM payment_operations WHERE empresa_id=$1 AND status IN ('PROCESSING','UNCERTAIN')) +
       (SELECT count(*)::int FROM gateway_cobrancas WHERE empresa_id=$1 AND (estorno_operacao_estado IN ('PROCESSING','UNCERTAIN') OR criacao_operacao_estado IN ('PROCESSING','UNCERTAIN') OR cancelamento_operacao_estado IN ('PROCESSING','UNCERTAIN'))) +
       (SELECT count(*)::int FROM payment_intents WHERE empresa_id=$1 AND status IN ('CREATED','PENDING','PENDING_MANUAL_CONFIRMATION','REQUIRES_ACTION','AUTHORIZED','CAPTURE_PENDING'))) AS operacoes,
      (SELECT count(*)::int FROM payment_late_reviews WHERE empresa_id=$1 AND status='OPEN') AS pagamentos_tardios`, [empresaId, inicio]);
    return { extratos: Number(r.extratos), repasses: Number(r.repasses), liquidacoes: Number(r.liquidacoes), operacoes: Number(r.operacoes), pagamentos_tardios: Number(r.pagamentos_tardios) };
  }
  const [extratos, repasses, liquidacoes, operacoes, tardios, cobrancas, intencoes] = await Promise.all([
    listarTodos(R_EXTRATO, { empresa_id: empresaId }, tx), listarTodos(R_PAYOUTS, { empresa_id: empresaId }, tx),
    listarTodos(R_SETTLEMENTS, { empresa_id: empresaId }, tx), listarTodos(R_OPERATIONS, { empresa_id: empresaId }, tx),
    listarTodos(R_LATE_REVIEWS, { empresa_id: empresaId }, tx), listarTodos(R_GATEWAY_COBRANCAS, { empresa_id: empresaId }, tx),
    listarTodos(R_INTENTS, { empresa_id: empresaId }, tx),
  ]);
  const noMesOuSemData = (v: unknown) => !v || String(v).slice(0, 7) === competencia;
  const comprovada = async (linha: Row): Promise<boolean> => {
    if (linha.status !== 'importada' || linha.direcao !== 'entrada' || !linha.data || !linha.conta_id) return false;
    const payout = repasses.find((p) => p.status === 'MATCHED' && Number(p.bank_transaction_id) === Number(linha.id));
    if (!payout || Math.round(Number(linha.valor) * 100) !== Number(payout.net_amount)) return false;
    const settlements = liquidacoes.filter((s) => Number(s.payout_id) === Number(payout.id));
    if (settlements.length !== 1) return false;
    const settlement = settlements[0];
    if (settlement.status !== 'MATCHED' || settlement.dispute_review_required === true ||
        ['provider_fee', 'gateway_fee', 'installment_fee', 'antifraud_fee', 'refund_amount', 'chargeback_amount'].some((k) => settlement[k] == null || Number(settlement[k]) !== 0)) return false;
    const store = getStore();
    const intent = await store.findOneWhere(R_INTENTS, { empresa_id: empresaId, id: Number(settlement.payment_intent_id) }, tx);
    if (!intent?.cobranca_id || Number(settlement.gross_amount) !== Number(intent.amount) || Number(settlement.net_amount) !== Number(intent.amount) || Number(payout.net_amount) !== Number(intent.amount)) return false;
    const charge = await store.findOneWhere(R_GATEWAY_COBRANCAS, { empresa_id: empresaId, id: Number(intent.cobranca_id) }, tx);
    const order = await store.findOneWhere(getResource('commerce_pedidos')!, { empresa_id: empresaId, id: Number(intent.order_id) }, tx);
    if (!charge?.lancamento_id || charge.status !== 'paga' || !order?.venda_id || Number(charge.venda_id) !== Number(order.venda_id)) return false;
    const title = await store.findOneWhere(getResource('lancamentos_financeiros')!, { empresa_id: empresaId, id: Number(charge.lancamento_id) }, tx);
    return !!title && title.referencia_tipo === 'venda' && Number(title.referencia_id) === Number(order.venda_id) && title.status === 'confirmado' &&
      Math.round(Number(title.valor) * 100) === Number(intent.amount) && title.valor_liquido != null && Math.round(Number(title.valor_liquido) * 100) === Number(intent.amount) && Number(title.taxa_pct ?? 0) === 0 && Number(title.conta_id) === Number(linha.conta_id) && String(title.data_baixa).slice(0, 10) === String(linha.data).slice(0, 10);
  };
  const extratosPendentes = extratos.filter((r) => ['importada', 'divergente'].includes(String(r.status)) && noMesOuSemData(r.data));
  const provas = await Promise.all(extratosPendentes.map(comprovada));
  return {
    extratos: extratosPendentes.filter((_r, i) => !provas[i]).length,
    repasses: repasses.filter((r) => ['IMPORTED', 'DIVERGENT'].includes(String(r.status)) && noMesOuSemData(r.settlement_date)).length,
    liquidacoes: liquidacoes.filter((r) => (r.status !== 'MATCHED' || r.dispute_review_required === true || !repasses.some((p) => Number(p.id) === Number(r.payout_id) && p.status === 'MATCHED' && p.bank_transaction_id)) && noMesOuSemData(r.settlement_date)).length,
    operacoes: operacoes.filter((r) => ['PROCESSING', 'UNCERTAIN'].includes(String(r.status))).length + cobrancas.filter((r) => ['PROCESSING', 'UNCERTAIN'].includes(String(r.estorno_operacao_estado)) || ['PROCESSING', 'UNCERTAIN'].includes(String(r.criacao_operacao_estado)) || ['PROCESSING', 'UNCERTAIN'].includes(String(r.cancelamento_operacao_estado))).length +
      intencoes.filter((r) => ['CREATED', 'PENDING', 'PENDING_MANUAL_CONFIRMATION', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURE_PENDING'].includes(String(r.status))).length,
    pagamentos_tardios: tardios.filter((r) => r.status === 'OPEN').length,
  };
}

function ator(req: Request) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
function pagina(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'Paginação inválida.');
  return n;
}

export async function listarPeriodos(req: Request, res: Response) {
  const { empresaId } = ator(req);
  const page = pagina(req.query.page, 1, 100000);
  const pageSize = pagina(req.query.pageSize, 30, 100);
  const result = await getStore().list(R(), { page, pageSize, filter: { empresa_id: empresaId }, sort: 'competencia', dir: 'desc' });
  res.json(result);
}
export async function obterPeriodo(req: Request, res: Response) {
  const { empresaId } = ator(req);
  const competencia = competenciaValida(req.params.competencia);
  const s = getStore();
  const { periodo, pendencias } = await s.transaction(async (tx) => ({
    periodo: await s.findOneWhere(R(), { empresa_id: empresaId, competencia: `${competencia}-01` }, tx),
    pendencias: await pendenciasFinanceiras(empresaId, competencia, tx),
  }), { isolation: 'read committed' });
  res.json({ competencia, estado: periodo?.estado ?? 'aberto', abrangencia: periodo?.abrangencia ?? null, registrado: !!periodo, periodo, pendencias });
}
export async function alterarPeriodo(req: Request, res: Response) {
  const { actor, empresaId } = ator(req);
  if (!['admin', 'gerente'].includes(actor.perfil)) throw new HttpError(403, 'Somente gerentes e administradores fecham períodos.');
  const competencia = competenciaValida(req.params.competencia);
  const estado = req.params.acao === 'fechar' ? 'fechado' : req.params.acao === 'reabrir' ? 'aberto' : null;
  if (!estado) throw new HttpError(404, 'Ação não encontrada.');
  if (estado === 'aberto' && actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores reabrem períodos.');
  const abrangencia = req.body?.abrangencia ?? 'financeiro';
  if (!['financeiro', 'escrituracao'].includes(abrangencia)) throw new HttpError(400, 'Abrangência deve ser financeiro ou escrituracao.');
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
  if (motivo.length < 8 || motivo.length > 500) throw new HttpError(400, 'Informe um motivo entre 8 e 500 caracteres.');
  const s = getStore();
  const result = await comTravaContabil(empresaId, async (tx) => {
    const antes = await s.findOneWhere(R(), { empresa_id: empresaId, competencia: `${competencia}-01` }, tx);
    if (estado === 'aberto' && (antes?.estado ?? 'aberto') === 'aberto') return { periodo: antes, idempotente: true };
    if (estado === 'fechado' && antes?.estado === 'fechado' && (antes.abrangencia === abrangencia || antes.abrangencia === 'financeiro'))
      return { periodo: antes, idempotente: true };
    if (estado === 'fechado' && abrangencia === 'financeiro') {
      const pendencias = await pendenciasFinanceiras(empresaId, competencia, tx);
      if (Object.values(pendencias).some((n) => n > 0))
        throw new HttpError(409, 'Fechamento bloqueado por pendências financeiras.', undefined, 'CLOSE_BLOCKED', { competencia, pendencias });
    }
    const campo = { abrangencia: estado === 'aberto' ? (antes?.abrangencia ?? abrangencia) : abrangencia, motivo, alterado_por: actor.id || null };
    let depois: Row;
    if (estado === 'fechado') {
      const fechando = antes
        ? (await s.update(R(), Number(antes.id), { ...campo, estado: 'fechando' }, tx))!
        : await s.insert(R(), { empresa_id: empresaId, competencia: `${competencia}-01`, ...campo, estado: 'fechando' }, tx);
      await s.audit({ empresa_id: empresaId, usuario_id: actor.id || null, usuario: actor.name, acao: 'ajuste', recurso: R().key,
        registro_id: Number(fechando.id), descricao: `Fechamento iniciado: ${competencia}`,
        dados: { antes: antes ? { estado: antes.estado, abrangencia: antes.abrangencia } : { estado: 'aberto' }, depois: { estado: 'fechando', abrangencia: campo.abrangencia } } }, tx);
      depois = (await s.update(R(), Number(fechando.id), { estado: 'fechado' }, tx))!;
    } else {
      depois = (await s.update(R(), Number(antes!.id), { ...campo, estado: 'aberto' }, tx))!;
    }
    await s.audit({ empresa_id: empresaId, usuario_id: actor.id || null, usuario: actor.name, acao: 'ajuste', recurso: R().key,
      registro_id: Number(depois.id), descricao: `Período ${estado}: ${competencia}`,
      dados: { antes: estado === 'fechado' ? { estado: 'fechando', abrangencia: campo.abrangencia } : { estado: antes?.estado, abrangencia: antes?.abrangencia }, depois: { estado, abrangencia: campo.abrangencia, motivo } } }, tx);
    return { periodo: depois, idempotente: false };
  });
  res.json(result);
}
