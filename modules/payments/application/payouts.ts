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
import { R_PAYOUTS, R_SETTLEMENTS, R_PAYOUT_REVISIONS, R_PAYOUT_UNLINKS } from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';

function actorOf(req: Request) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
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
  res.setHeader('Cache-Control', 'private, no-store'); res.json(result);
}
export async function payoutDetail(req: Request, res: Response) {
  const { empresaId } = actorOf(req);
  const s = getStore(); const payoutId = id(req.params.id);
  const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: payoutId });
  if (!payout) throw new HttpError(404, 'Repasse não encontrado.');
  const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } });
  const revisions = await s.list(R_PAYOUT_REVISIONS, { page: page(req.query.revisions_page, 1, 100000), pageSize: 25,
    filter: { empresa_id: empresaId, payout_id: payoutId }, sort: 'revision', dir: 'desc' });
  const unlinks = await s.list(R_PAYOUT_UNLINKS, { page: page(req.query.unlinks_page, 1, 100000), pageSize: 25,
    filter: { empresa_id: empresaId, payout_id: payoutId }, sort: 'id', dir: 'desc' });
  const currentReport = reportFromSettlements(payout, settlements.rows);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ payout, settlements: settlements.rows, report: currentReport,
    revisions: { ...revisions, rows: revisions.rows.map(({ report: _report, idempotency_key: _key, request_hash: _hash, ...row }) => row) },
    unlinks: { ...unlinks, rows: unlinks.rows.map(({ idempotency_key: _key, request_hash: _hash, ...row }) => row) } });
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
    await s.insert(R_PAYOUT_REVISIONS, { empresa_id: empresaId, payout_id: payout.id, revision: 1,
      content_hash: hash, report, reason: 'Importação inicial do relatório', created_by: actor.id || null, created_at: now }, tx);
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
      if (Number(payout.bank_transaction_id) !== bankId) throw new HttpError(409, 'Repasse já vinculado a outro lançamento de extrato.');
      const currentBank = await s.findOneWhere(R_EXTRATO, { empresa_id: empresaId, id: bankId }, tx);
      const currentSettlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } }, tx);
      const currentReport = reportFromSettlements(payout, currentSettlements.rows);
      const lines = new Map(currentReport?.transactions.map((line) => [line.provider_reference, line]) || []);
      if (!bankMatches(currentBank, Number(payout.net_amount)) || !currentReport || currentSettlements.total !== currentSettlements.rows.length ||
          currentSettlements.rows.some((row) => row.status !== 'MATCHED' || !lines.has(String(row.provider_reference)) || mismatch(row, lines.get(String(row.provider_reference))!)))
        throw new HttpError(409, 'Conciliação anterior não corresponde mais às evidências atuais.');
      return { payout, idempotente: true };
    }
    if (payout.status === 'DIVERGENT') throw new HttpError(409, 'Resolva as divergências do provedor antes de conciliar.');
    const bank = await s.findOneWhere(R_EXTRATO, { empresa_id: empresaId, id: bankId }, tx);
    if (!bank) throw new HttpError(404, 'Transação de extrato não encontrada.');
    if (!bankMatches(bank, Number(payout.net_amount)))
      throw new HttpError(409, 'Extrato deve ser uma entrada não divergente com o mesmo valor líquido do repasse.');
    if (await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, bank_transaction_id: bankId }, tx)) throw new HttpError(409, 'Transação de extrato já vinculada a outro repasse.');
    const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } }, tx);
    const statement = reportFromSettlements(payout, settlements.rows);
    const statementLines = new Map(statement?.transactions.map((line) => [line.provider_reference, line]) || []);
    if (settlements.total !== settlements.rows.length || !statement || settlements.rows.some((r) => r.status === 'DIVERGENT' ||
        !statementLines.has(String(r.provider_reference)) || mismatch(r, statementLines.get(String(r.provider_reference))!)))
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

/** Reconstroi apenas se a evidência preservada produzir exatamente o hash original. */
function reportFromSettlements(payout: Row, settlements: Row[]) {
  if (!settlements.length || settlements.some((r) => !r.evidence?.provider_report)) return null;
  try {
    const { report, hash } = normalizePayout({ provider: payout.provider, payout_reference: payout.payout_reference,
      settlement_date: String(payout.settlement_date).slice(0, 10), net_amount: Number(payout.net_amount),
      transactions: settlements.map((r) => r.evidence.provider_report) });
    return hash === payout.content_hash ? report : null;
  } catch { return null; }
}
function operationKey(req: Request) {
  const key = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new HttpError(400, 'Informe Idempotency-Key com 8 a 160 caracteres seguros.');
  return key;
}
function reasonText(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 500 || Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new HttpError(400, 'Informe uma justificativa de 8 a 500 caracteres.');
  return value.trim();
}
function mismatch(settlement: Row, line: Line) {
  return Number(settlement.gross_amount) !== line.gross_amount || Number(settlement.refund_amount || 0) !== line.refund_amount ||
    Number(settlement.chargeback_amount || 0) !== line.chargeback_amount;
}
function bankMatches(bank: Row | null, netAmount: number) {
  // Uma linha já aplicada a um título financeiro não pode virar também
  // repasse por mera coincidência de valor. Vínculos legados exigem revisão.
  return !!bank && bank.direcao === 'entrada' && bank.status === 'importada' && !bank.lancamento_id && !bank.baixa_lancamento_id && Math.round(Number(bank.valor) * 100) === netAmount;
}
function requestDigest(value: object) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function duplicateConflict(error: unknown): never {
  if ((error as { code?: string })?.code === '23505') throw new HttpError(409, 'Operação já registrada; atualize e revise os dados.');
  throw error;
}

/**
 * Corrige uma transcrição do MESMO repasse e das MESMAS transações. Versões
 * anteriores são preservadas. Não consulta provedor nem cria movimentação.
 */
export async function correctPayout(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req); const payoutId = id(req.params.id); const s = getStore();
  const reason = reasonText(req.body?.reason); const expectedHash = req.body?.expected_hash;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new HttpError(400, 'Hash esperado inválido.');
  const { report, hash } = normalizePayout(req.body?.report); const key = operationKey(req);
  const requestHash = requestDigest({ expectedHash, reason, report });
  try {
    const result = await locked(empresaId, 'payout-bank-match', async (tx) => {
      const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: payoutId }, tx);
      if (!payout) throw new HttpError(404, 'Repasse não encontrado.');
      const previous = await s.findOneWhere(R_PAYOUT_REVISIONS, { empresa_id: empresaId, payout_id: payoutId, idempotency_key: key }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new HttpError(409, 'Chave de idempotência usada com outros dados.');
        return { payout, revision: Number(previous.revision), idempotente: true };
      }
      if (payout.content_hash !== expectedHash) throw new HttpError(409, 'Relatório foi alterado; atualize antes de corrigir.');
      if (payout.provider !== report.provider || payout.payout_reference !== report.payout_reference)
        throw new HttpError(409, 'Provedor e referência do repasse não podem ser alterados.');
      if (hash === expectedHash) throw new HttpError(409, 'O relatório corrigido é igual ao atual.');
      const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } }, tx);
      if (!settlements.rows.length || settlements.rows.length !== settlements.total) throw new HttpError(409, 'Liquidações incompletas.');
      const oldReport = reportFromSettlements(payout, settlements.rows);
      if (!oldReport) throw new HttpError(409, 'Evidência original incompleta ou hash divergente; correção automática bloqueada.');
      const byRef = new Map(settlements.rows.map((row) => [String(row.provider_reference), row]));
      if (report.transactions.length !== byRef.size || report.transactions.some((line) => !byRef.has(line.provider_reference)))
        throw new HttpError(409, 'A correção deve preservar o conjunto de transações do repasse.');
      const revisions = await s.list(R_PAYOUT_REVISIONS, { page: 1, pageSize: 1, filter: { empresa_id: empresaId, payout_id: payoutId }, sort: 'revision', dir: 'desc' }, tx);
      let revision = 1;
      if (!revisions.total) {
        // Repasse legado: reconstrução verificável; não inventa uma versão.
        await s.insert(R_PAYOUT_REVISIONS, { empresa_id: empresaId, payout_id: payoutId, revision: 1, content_hash: expectedHash,
          report: oldReport, reason: 'Reconstrução verificável do relatório original', created_by: payout.created_by || null, created_at: payout.created_at || new Date().toISOString() }, tx);
      } else {
        revision = Number(revisions.rows[0].revision);
        if (revisions.rows[0].content_hash !== expectedHash) throw new HttpError(409, 'Histórico de versões não corresponde ao relatório atual.');
      }
      if (await s.findOneWhere(R_PAYOUT_REVISIONS, { empresa_id: empresaId, payout_id: payoutId, content_hash: hash }, tx))
        throw new HttpError(409, 'Esta versão já existiu; não é possível reaplicá-la silenciosamente.');
      const targets = report.transactions.map((line) => ({ line, settlement: byRef.get(line.provider_reference)!, divergent: mismatch(byRef.get(line.provider_reference)!, line) }));
      const bank = payout.bank_transaction_id ? await s.findOneWhere(R_EXTRATO, { empresa_id: empresaId, id: payout.bank_transaction_id }, tx) : null;
      const invalidBank = !!payout.bank_transaction_id && !bankMatches(bank, report.net_amount);
      const anyDivergence = targets.some((t) => t.divergent) || invalidBank;
      const status = anyDivergence ? 'DIVERGENT' : payout.bank_transaction_id ? 'MATCHED' : 'IMPORTED';
      const now = new Date().toISOString();
      const changed = await s.tryUpdateIf(R_PAYOUTS, payoutId,
        { empresa_id: empresaId, content_hash: expectedHash, status: payout.status, bank_transaction_id: payout.bank_transaction_id ?? null },
        { content_hash: hash, settlement_date: report.settlement_date, net_amount: report.net_amount, status, updated_at: now }, tx);
      if (!changed) throw new HttpError(409, 'Repasse mudou durante a correção; atualize e tente novamente.');
      for (const { line, settlement, divergent } of targets) {
        const applied = await s.tryUpdateIf(R_SETTLEMENTS, Number(settlement.id),
          { empresa_id: empresaId, payout_id: payoutId, gross_amount: settlement.gross_amount, refund_amount: settlement.refund_amount,
            chargeback_amount: settlement.chargeback_amount, status: settlement.status },
          { settlement_date: report.settlement_date, provider_fee: line.provider_fee, gateway_fee: line.gateway_fee,
            installment_fee: line.installment_fee, antifraud_fee: line.antifraud_fee, net_amount: line.net_amount,
            status: divergent ? 'DIVERGENT' : status === 'MATCHED' ? 'MATCHED' : 'UNRECONCILED',
            evidence: { ...(settlement.evidence || {}), provider_report: line }, updated_at: now }, tx);
        if (!applied) throw new HttpError(409, 'Liquidação mudou durante a correção; atualize e tente novamente.');
      }
      await s.insert(R_PAYOUT_REVISIONS, { empresa_id: empresaId, payout_id: payoutId, revision: revision + 1, content_hash: hash,
        previous_hash: expectedHash, report, reason, idempotency_key: key, request_hash: requestHash, created_by: actor.id || null, created_at: now }, tx);
      await audit(req, payoutId, 'Relatório de repasse corrigido manualmente', { before_hash: expectedHash, after_hash: hash, revision: revision + 1, before_status: payout.status, after_status: status }, tx);
      return { payout: changed, revision: revision + 1, idempotente: false };
    }, 'read committed');
    res.json(result);
  } catch (error) { duplicateConflict(error); }
}

/** Desfaz apenas o vínculo da conciliação, preservando extrato, ledger e histórico. */
export async function unlinkPayout(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req); const payoutId = id(req.params.id); const s = getStore();
  const bankId = id(req.body?.bank_transaction_id); const reason = reasonText(req.body?.reason); const key = operationKey(req);
  const requestHash = requestDigest({ bankId, reason });
  try {
    const result = await locked(empresaId, 'payout-bank-match', async (tx) => {
      const payout = await s.findOneWhere(R_PAYOUTS, { empresa_id: empresaId, id: payoutId }, tx);
      if (!payout) throw new HttpError(404, 'Repasse não encontrado.');
      const previous = await s.findOneWhere(R_PAYOUT_UNLINKS, { empresa_id: empresaId, payout_id: payoutId, idempotency_key: key }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new HttpError(409, 'Chave de idempotência usada com outros dados.');
        return { payout, idempotente: true };
      }
      if (Number(payout.bank_transaction_id) !== bankId) throw new HttpError(409, 'Vínculo de extrato mudou; atualize e tente novamente.');
      const settlements = await s.list(R_SETTLEMENTS, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId, payout_id: payoutId } }, tx);
      if (!settlements.rows.length || settlements.rows.length !== settlements.total) throw new HttpError(409, 'Liquidações incompletas.');
      const report = reportFromSettlements(payout, settlements.rows);
      if (!report) throw new HttpError(409, 'Evidência original incompleta ou hash divergente; desvinculação automática bloqueada.');
      const lines = new Map(report.transactions.map((line) => [line.provider_reference, line]));
      const targets = settlements.rows.map((settlement) => ({ settlement, divergent: mismatch(settlement, lines.get(String(settlement.provider_reference))!) }));
      const status = targets.some((t) => t.divergent) ? 'DIVERGENT' : 'IMPORTED';
      const now = new Date().toISOString();
      const changed = await s.tryUpdateIf(R_PAYOUTS, payoutId, { empresa_id: empresaId, status: payout.status, bank_transaction_id: bankId, content_hash: payout.content_hash },
        { bank_transaction_id: null, status, updated_at: now }, tx);
      if (!changed) throw new HttpError(409, 'Repasse mudou durante a desvinculação; atualize e tente novamente.');
      for (const { settlement, divergent } of targets) {
        const applied = await s.tryUpdateIf(R_SETTLEMENTS, Number(settlement.id),
          { empresa_id: empresaId, payout_id: payoutId, status: settlement.status, refund_amount: settlement.refund_amount, chargeback_amount: settlement.chargeback_amount },
          { status: divergent ? 'DIVERGENT' : 'UNRECONCILED', updated_at: now }, tx);
        if (!applied) throw new HttpError(409, 'Liquidação mudou durante a desvinculação; atualize e tente novamente.');
      }
      await s.insert(R_PAYOUT_UNLINKS, { empresa_id: empresaId, payout_id: payoutId, bank_transaction_id: bankId,
        reason, idempotency_key: key, request_hash: requestHash, created_by: actor.id || null, created_at: now }, tx);
      await audit(req, payoutId, 'Vínculo do repasse com extrato desfeito', { before: { bank_transaction_id: bankId, status: payout.status }, after: { bank_transaction_id: null, status } }, tx);
      return { payout: changed, idempotente: false };
    }, 'read committed');
    res.json(result);
  } catch (error) { duplicateConflict(error); }
}
