// Manual ingestion of provider settlement reports. This is reconciliation
// evidence over existing payment intents + bank statement lines, never cash.
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from '../../../server/src/auth';
import { escopoDoAtor } from '../../../server/src/empresa';
import { R_EXTRATO } from '../../../server/src/extrato';
import { HttpError } from '../../../server/src/errors';
import { getResource } from '../../../server/src/resources';
import { checkAccess, getStore } from '../../../server/src/services';
import type { Row, Tx } from '../../../server/src/store';
import { PROVIDERS } from '../domain/payment';
import { R_PAYOUTS, R_SETTLEMENTS } from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';

function actorOf(req: Request) {
  const actor = currentUser(req);
  checkAccess(getResource('commerce_pedidos')!, actor, 'read');
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  if (!['admin', 'gerente'].includes(actor.perfil)) throw new HttpError(403, 'Apenas gerentes e administradores conciliam repasses.');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
const integer = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100_000_000_000_000)
    throw new HttpError(400, `${label} deve ser um valor inteiro não negativo em centavos.`);
  return v;
};
function identifier(v: unknown, label: string) {
  if (typeof v !== 'string' || !v.trim() || v.length > 160 || Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new HttpError(400, `${label} inválida.`);
  return v.trim();
}
function date(v: unknown) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v)
    throw new HttpError(400, 'Data de liquidação inválida.');
  return v;
}
type Line = { provider_reference: string; gross_amount: number; provider_fee: number; gateway_fee: number; installment_fee: number; antifraud_fee: number; refund_amount: number; chargeback_amount: number; net_amount: number };
export function normalizePayout(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Informe o relatório de repasse.');
  const b = raw as Record<string, unknown>;
  const provider = identifier(b.provider, 'Provedor');
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number]) || ['MANUAL', 'PIX_DIRECT', 'ACQUIRER_GENERIC', 'BOLETO_GENERIC'].includes(provider))
    throw new HttpError(400, 'Provedor do relatório não suportado.');
  const payout_reference = identifier(b.payout_reference, 'Referência do repasse');
  const settlement_date = date(b.settlement_date);
  const net_amount = integer(b.net_amount, 'Líquido do repasse');
  if (!Array.isArray(b.transactions) || b.transactions.length < 1 || b.transactions.length > 1000) throw new HttpError(400, 'Informe de 1 a 1000 transações.');
  const seen = new Set<string>();
  const transactions: Line[] = b.transactions.map((rawLine: unknown) => {
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) throw new HttpError(400, 'Transação inválida.');
    const l = rawLine as Record<string, unknown>;
    const provider_reference = identifier(l.provider_reference, 'Referência da transação');
    if (seen.has(provider_reference)) throw new HttpError(400, 'Referência de transação duplicada no relatório.');
    seen.add(provider_reference);
    const gross_amount = integer(l.gross_amount, 'Bruto');
    const provider_fee = integer(l.provider_fee ?? 0, 'Taxa do provedor');
    const gateway_fee = integer(l.gateway_fee ?? 0, 'Taxa do gateway');
    const installment_fee = integer(l.installment_fee ?? 0, 'Taxa de parcelas');
    const antifraud_fee = integer(l.antifraud_fee ?? 0, 'Taxa antifraude');
    const refund_amount = integer(l.refund_amount ?? 0, 'Reembolso');
    const chargeback_amount = integer(l.chargeback_amount ?? 0, 'Chargeback');
    const net = integer(l.net_amount, 'Líquido');
    if (gross_amount - provider_fee - gateway_fee - installment_fee - antifraud_fee - refund_amount - chargeback_amount !== net)
      throw new HttpError(400, `Valores da transação ${provider_reference} não fecham.`);
    return { provider_reference, gross_amount, provider_fee, gateway_fee, installment_fee, antifraud_fee, refund_amount, chargeback_amount, net_amount: net };
  }).sort((a, b) => a.provider_reference < b.provider_reference ? -1 : a.provider_reference > b.provider_reference ? 1 : 0);
  const sum = transactions.reduce((n, l) => n + l.net_amount, 0);
  if (!Number.isSafeInteger(sum) || sum !== net_amount) throw new HttpError(400, 'A soma dos líquidos não confere com o repasse.');
  const report = { provider, payout_reference, settlement_date, currency: 'BRL', net_amount, transactions };
  return { report, hash: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
}
async function audit(req: Request, id: number, descricao: string, dados: object, tx: Tx) {
  const { actor, empresaId } = actorOf(req);
  await getStore().audit({ empresa_id: empresaId, usuario_id: actor.id || null, usuario: actor.name, acao: 'ajuste',
    recurso: 'payment_payouts', registro_id: id, descricao, dados }, tx);
}
function page(v: unknown, fallback: number, max: number) {
  if (v === undefined) return fallback;
  const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'Paginação inválida.');
  return n;
}
function id(v: unknown) { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'Identificador inválido.'); return n; }

export async function listPayouts(req: Request, res: Response) {
  const { empresaId } = actorOf(req);
  const result = await getStore().list(R_PAYOUTS, { page: page(req.query.page, 1, 100000), pageSize: page(req.query.pageSize, 25, 100), filter: { empresa_id: empresaId }, sort: 'id', dir: 'desc' });
  res.json(result);
}
export async function payoutDetail(req: Request, res: Response) {
  const { empresaId } = actorOf(req);
  const s = getStore(); const payoutId = id(req.params.id);
  const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: payoutId });
  if (!payout) throw new HttpError(404, 'Repasse não encontrado.');
  const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } });
  res.json({ payout, settlements: settlements.rows });
}
export async function importPayout(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req);
  const { report, hash } = normalizePayout(req.body);
  const s = getStore();
  const result = await locked(empresaId, `payout-import:${report.provider}`, async (tx) => {
    const old = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, provider: report.provider, payout_reference: report.payout_reference }, tx);
    if (old) {
      if (old.content_hash !== hash) throw new HttpError(409, 'Referência de repasse já importada com conteúdo diferente.');
      return { payout: old, idempotente: true };
    }
    // One batched lookup, never a query per transaction.
    const all = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 50000, filter: { empresa_id: empresaId, provider: report.provider } }, tx);
    if (all.total > all.rows.length) throw new HttpError(409, 'Número de liquidações excede o limite seguro da importação.');
    const byReference = new Map(all.rows.map((r) => [String(r.provider_reference), r]));
    const targets: { line: Line; settlement: Row; divergent: boolean }[] = [];
    for (const line of report.transactions) {
      const settlement = byReference.get(line.provider_reference);
      if (!settlement) throw new HttpError(422, `Transação ${line.provider_reference} não existe no Payment Engine desta empresa.`);
      if (settlement.payout_id) throw new HttpError(409, `Transação ${line.provider_reference} já pertence a outro repasse.`);
      const divergent = Number(settlement.gross_amount) !== line.gross_amount || Number(settlement.refund_amount || 0) !== line.refund_amount || Number(settlement.chargeback_amount || 0) !== line.chargeback_amount;
      targets.push({ line, settlement, divergent });
    }
    const now = new Date().toISOString();
    const payout = await s.insert(R_PAYOUTS, { empresa_id: empresaId, provider: report.provider, payout_reference: report.payout_reference,
      settlement_date: report.settlement_date, currency: 'BRL', net_amount: report.net_amount, content_hash: hash,
      status: targets.some((t) => t.divergent) ? 'DIVERGENT' : 'IMPORTED', created_by: actor.id || null, created_at: now, updated_at: now }, tx);
    for (const { line, settlement, divergent } of targets) {
      const applied = await s.tryUpdateIf(R_SETTLEMENTS, Number(settlement.id),
        { empresa_id: empresaId, payout_id: null, gross_amount: settlement.gross_amount, refund_amount: settlement.refund_amount, chargeback_amount: settlement.chargeback_amount, status: settlement.status },
        { payout_id: payout.id, payout_reference: report.payout_reference,
          settlement_date: report.settlement_date, provider_fee: line.provider_fee, gateway_fee: line.gateway_fee,
          installment_fee: line.installment_fee, antifraud_fee: line.antifraud_fee, net_amount: line.net_amount,
          status: divergent ? 'DIVERGENT' : 'UNRECONCILED', evidence: { ...(settlement.evidence || {}), provider_report: line }, updated_at: now }, tx);
      if (!applied) throw new HttpError(409, 'Liquidação mudou durante a importação; atualize e tente novamente.');
    }
    await audit(req, Number(payout.id), 'Relatório de repasse importado', { depois: { provider: report.provider, payout_reference: report.payout_reference, net_amount: report.net_amount, status: payout.status, transactions: targets.length }, hash }, tx);
    return { payout, idempotente: false };
  }, 'read committed');
  res.status(result.idempotente ? 200 : 201).json(result);
}
export async function matchPayout(req: Request, res: Response) {
  const { empresaId } = actorOf(req); const payoutId = id(req.params.id); const bankId = id(req.body?.bank_transaction_id);
  const s = getStore();
  const result = await locked(empresaId, 'payout-bank-match', async (tx) => {
    const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: payoutId }, tx);
    if (!payout) throw new HttpError(404, 'Repasse não encontrado.');
    if (payout.bank_transaction_id) {
      if (payout.status === 'DIVERGENT') throw new HttpError(409, 'O repasse vinculado tornou-se divergente; requer revisão.');
      if (Number(payout.bank_transaction_id) === bankId) return { payout, idempotente: true };
      throw new HttpError(409, 'Repasse já vinculado a outro lançamento de extrato.');
    }
    if (payout.status === 'DIVERGENT') throw new HttpError(409, 'Resolva as divergências do provedor antes de conciliar.');
    const bank = await s.findOneWhere(R_EXTRATO, { empresa_id: empresaId, id: bankId }, tx);
    if (!bank) throw new HttpError(404, 'Transação de extrato não encontrada.');
    if (bank.direcao !== 'entrada' || bank.status === 'ignorada' || Math.round(Number(bank.valor) * 100) !== Number(payout.net_amount))
      throw new HttpError(409, 'Extrato deve ser uma entrada não ignorada com o mesmo valor líquido do repasse.');
    if (await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, bank_transaction_id: bankId }, tx)) throw new HttpError(409, 'Transação de extrato já vinculada a outro repasse.');
    const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } }, tx);
    if (settlements.total !== settlements.rows.length || settlements.rows.length === 0 || settlements.rows.some((r) => r.status === 'DIVERGENT'))
      throw new HttpError(409, 'Liquidações incompletas ou divergentes; nenhuma conciliação foi aplicada.');
    const updated = await s.tryUpdateIf(R_PAYOUTS, payoutId, { empresa_id: empresaId, status: 'IMPORTED', bank_transaction_id: null }, { bank_transaction_id: bankId, status: 'MATCHED', updated_at: new Date().toISOString() }, tx);
    if (!updated) throw new HttpError(409, 'Repasse mudou durante a conciliação; atualize e tente novamente.');
    for (const settlement of settlements.rows) {
      const applied = await s.tryUpdateIf(R_SETTLEMENTS, Number(settlement.id), { empresa_id: empresaId, payout_id: payoutId, status: settlement.status, refund_amount: settlement.refund_amount, chargeback_amount: settlement.chargeback_amount }, { status: 'MATCHED', updated_at: new Date().toISOString() }, tx);
      if (!applied) throw new HttpError(409, 'Liquidação mudou durante a conciliação; atualize e tente novamente.');
    }
    await audit(req, payoutId, 'Repasse conciliado com extrato', { antes: { status: payout.status, bank_transaction_id: null }, depois: { status: 'MATCHED', bank_transaction_id: bankId } }, tx);
    return { payout: updated, idempotente: false };
  }, 'read committed');
  res.json(result);
}
