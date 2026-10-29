// Gestão interna de disputas: fatos declarados manualmente não são chamadas ao
// provedor. Não altera saldos, cobranças, intent ou livro financeiro.
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from '../../../server/src/auth';
import { escopoDoAtor } from '../../../server/src/empresa';
import { HttpError } from '../../../server/src/errors';
import { getResource } from '../../../server/src/resources';
import { checkAccess, getStore } from '../../../server/src/services';
import type { Row, Tx } from '../../../server/src/store';
import { R_ATTEMPTS, R_DISPUTES, R_DISPUTE_EVENTS, R_DISPUTE_EVIDENCE, R_INTENTS } from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';

function actorOf(req: Request) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  if (!Number.isSafeInteger(actor.id) || actor.id < 1 || !['admin', 'gerente'].includes(actor.perfil))
    throw new HttpError(403, 'Apenas gerentes e administradores autenticados gerenciam disputas.');
  checkAccess(getResource('commerce_pedidos')!, actor, 'read');
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
function id(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'Identificador inválido.');
  return n;
}
function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${name} inválido.`);
  const v = value.trim();
  if (v.length < min || v.length > max || Array.from(v).some((c) => { const n = c.charCodeAt(0); return (n < 32 && ![9, 10, 13].includes(n)) || n === 127; })) throw new HttpError(400, `${name} inválido.`);
  return v;
}
function optionalText(value: unknown, name: string, max: number): string | null {
  return value == null || value === '' ? null : text(value, name, 1, max);
}
function key(req: Request) {
  const value = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new HttpError(400, 'Informe Idempotency-Key com 8 a 160 caracteres seguros.');
  return value;
}
function page(value: unknown, fallback = 1, max = 100000) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'Página inválida.');
  return n;
}
function dueDate(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new HttpError(400, 'Prazo inválido.');
  return value;
}
function hash(value: object) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function noCache(res: Response) { res.setHeader('Cache-Control', 'private, no-store'); }
function clean(row: Row) {
  const { idempotency_key: _key, request_hash: _hash, ...safe } = row;
  return safe;
}
async function audit(req: Request, disputeId: number, descricao: string, dados: object, tx: Tx) {
  const { actor, empresaId } = actorOf(req);
  // O conteúdo da evidência, motivo e referência externa não entra no feed de auditoria.
  await getStore().audit({ empresa_id: empresaId, usuario_id: actor.id, usuario: actor.name,
    acao: 'ajuste', recurso: 'payment_disputes', registro_id: disputeId, descricao, dados }, tx);
}
async function dispute(empresaId: number, disputeId: number, tx?: Tx) {
  const row = await getStore().findOneWhere(R_DISPUTES, { empresa_id: empresaId, id: disputeId }, tx);
  if (!row) throw new HttpError(404, 'Disputa não encontrada.');
  return row;
}
function rethrowConflict(error: unknown): never {
  if ((error as { code?: string })?.code === '23505') throw new HttpError(409, 'Disputa ou chave já registrada; atualize e revise os dados.');
  throw error;
}

export async function listDisputes(req: Request, res: Response) {
  const { empresaId } = actorOf(req);
  const filter: Record<string, unknown> = { empresa_id: empresaId };
  if (req.query.status) filter.status = text(req.query.status, 'Situação', 1, 32);
  const q = req.query.q == null ? '' : text(req.query.q, 'Busca', 0, 100);
  const result = await getStore().list(R_DISPUTES, { page: page(req.query.page), pageSize: page(req.query.pageSize, 25, 100),
    q, filter, sort: 'id', dir: 'desc' });
  noCache(res); res.json(result);
}

export async function disputeDetail(req: Request, res: Response) {
  const { empresaId } = actorOf(req);
  const s = getStore(); const disputeId = id(req.params.id);
  const row = await dispute(empresaId, disputeId);
  const [evidence, events] = await Promise.all([
    s.list(R_DISPUTE_EVIDENCE, { page: page(req.query.evidence_page), pageSize: 25, filter: { empresa_id: empresaId, dispute_id: disputeId }, sort: 'id', dir: 'desc' }),
    s.list(R_DISPUTE_EVENTS, { page: page(req.query.events_page), pageSize: 25, filter: { empresa_id: empresaId, dispute_id: disputeId }, sort: 'id', dir: 'desc' }),
  ]);
  noCache(res);
  res.json({ dispute: row, evidence: { ...evidence, rows: evidence.rows.map(clean) }, events: { ...events, rows: events.rows.map(clean) },
    provider_submission: 'NAO_SUPORTADO', source: 'Registro interno; informações manuais não são verificadas no provedor.' });
}

export async function registerDispute(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req); const s = getStore(); const b = req.body || {};
  const intentId = id(b.payment_intent_id); const reference = text(b.provider_reference, 'Referência da transação', 1, 160);
  const externalId = text(b.external_dispute_id, 'Identificador externo', 1, 160);
  const reason = text(b.reason, 'Motivo', 8, 500); const due = dueDate(b.due_date);
  const amount = b.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000_000) throw new HttpError(400, 'Valor da disputa inválido (centavos).');
  const operationKey = key(req);
  const requestHash = hash({ kind: 'REGISTER', intentId, reference, externalId, reason, due, amount });
  try {
    const result = await locked(empresaId, `intent:${intentId}`, async (tx) => {
      const previous = await s.findOneWhere(R_DISPUTE_EVENTS, { empresa_id: empresaId, idempotency_key: operationKey }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new HttpError(409, 'Chave de idempotência usada com outros dados.');
        return { dispute: await dispute(empresaId, Number(previous.dispute_id), tx), idempotente: true };
      }
      const intent = await s.findOneWhere(R_INTENTS, { empresa_id: empresaId, id: intentId }, tx);
      if (!intent) throw new HttpError(404, 'Pagamento não encontrado.');
      const attempt = await s.findOneWhere(R_ATTEMPTS, { empresa_id: empresaId, payment_intent_id: intentId, provider_transaction_id: reference }, tx);
      if (!attempt || !['MERCADO_PAGO', 'PAGBANK', 'STRIPE'].includes(String(attempt.provider))) throw new HttpError(422, 'Referência não pertence a uma tentativa suportada deste pagamento.');
      if (!['CAPTURED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CHARGEBACK'].includes(String(intent.status)) || amount > Number(intent.amount))
        throw new HttpError(409, 'Pagamento ou valor incompatível com registro de disputa.');
      const provider = String(attempt.provider);
      const external = await s.findOneWhere(R_DISPUTES, { empresa_id: empresaId, provider, external_dispute_id: externalId }, tx);
      if (external) throw new HttpError(409, 'Identificador externo já registrado neste provedor.');
      const old = await s.findOneWhere(R_DISPUTES, { empresa_id: empresaId, provider_reference: reference }, tx);
      const now = new Date().toISOString(); let row: Row;
      if (old) {
        if (Number(old.payment_intent_id) !== intentId || old.external_dispute_id) throw new HttpError(409, 'Transação já possui disputa registrada.');
        const changed = await s.tryUpdateIf(R_DISPUTES, Number(old.id),
          { empresa_id: empresaId, external_dispute_id: null, version: old.version ?? null },
          { provider, external_dispute_id: externalId, due_date: due, reason, amount, version: Number(old.version || 0) + 1, updated_at: now }, tx);
        if (!changed) throw new HttpError(409, 'Disputa mudou durante o registro; atualize e tente novamente.');
        row = changed;
      } else {
        row = await s.insert(R_DISPUTES, { empresa_id: empresaId, payment_intent_id: intentId, provider_reference: reference,
          provider, external_dispute_id: externalId, due_date: due, reason, amount, origin: 'MANUAL', version: 0,
          status: 'DISPUTE_OPENED', created_at: now, updated_at: now }, tx);
      }
      await s.insert(R_DISPUTE_EVENTS, { empresa_id: empresaId, dispute_id: row.id, kind: 'REGISTER', from_status: old?.status || null,
        to_status: row.status, idempotency_key: operationKey, request_hash: requestHash, created_by: actor.id, created_at: now }, tx);
      await audit(req, Number(row.id), 'Disputa registrada manualmente', { provider, origin: row.origin, status: row.status }, tx);
      return { dispute: row, idempotente: false };
    }, 'read committed');
    noCache(res); res.status(result.idempotente ? 200 : 201).json(result);
  } catch (error) { rethrowConflict(error); }
}

export async function addDisputeEvidence(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req); const s = getStore(); const disputeId = id(req.params.id); const b = req.body || {};
  if (!['NOTE', 'DOCUMENT_REFERENCE'].includes(b.kind)) throw new HttpError(400, 'Tipo de evidência inválido.');
  const description = text(b.description, 'Descrição', 3, 200);
  const content = text(b.content, 'Conteúdo', 1, b.kind === 'NOTE' ? 4000 : 200);
  const operationKey = key(req); const requestHash = hash({ disputeId, kind: b.kind, description, content });
  try {
    const result = await locked(empresaId, `dispute:${disputeId}`, async (tx) => {
      const row = await dispute(empresaId, disputeId, tx);
      const previous = await s.findOneWhere(R_DISPUTE_EVIDENCE, { empresa_id: empresaId, dispute_id: disputeId, idempotency_key: operationKey }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash) throw new HttpError(409, 'Chave de idempotência usada com outra evidência.');
        return { evidence: clean(previous), idempotente: true };
      }
      if (['WON', 'LOST', 'CLOSED'].includes(String(row.status))) throw new HttpError(409, 'Disputa encerrada não aceita novas evidências.');
      const evidence = await s.insert(R_DISPUTE_EVIDENCE, { empresa_id: empresaId, dispute_id: disputeId, kind: b.kind,
        description, content, idempotency_key: operationKey, request_hash: requestHash, created_by: actor.id, created_at: new Date().toISOString() }, tx);
      await audit(req, disputeId, 'Evidência registrada internamente', { evidence_id: evidence.id, kind: b.kind }, tx);
      return { evidence: clean(evidence), idempotente: false };
    }, 'read committed');
    noCache(res); res.status(result.idempotente ? 200 : 201).json(result);
  } catch (error) { rethrowConflict(error); }
}

const TRANSITIONS: Record<string, string[]> = {
  DISPUTE_OPENED: ['UNDER_REVIEW', 'EVIDENCE_REQUIRED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  UNDER_REVIEW: ['EVIDENCE_REQUIRED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  EVIDENCE_REQUIRED: ['UNDER_REVIEW', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  EVIDENCE_SUBMITTED: ['UNDER_REVIEW', 'EVIDENCE_REQUIRED', 'WON', 'LOST', 'CLOSED'],
  WON: ['CLOSED'], LOST: ['CLOSED'], CLOSED: [],
};
export async function transitionDispute(req: Request, res: Response) {
  const { empresaId, actor } = actorOf(req); const s = getStore(); const disputeId = id(req.params.id); const b = req.body || {};
  const target = text(b.status, 'Estado', 3, 32); const note = text(b.note, 'Justificativa', 8, 500);
  const externalReference = optionalText(b.external_reference, 'Referência externa', 160);
  if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 0) throw new HttpError(400, 'Versão esperada inválida.');
  if (['EVIDENCE_SUBMITTED', 'WON', 'LOST'].includes(target) && (!externalReference || b.confirm_external !== true))
    throw new HttpError(400, 'Confirme o fato ocorrido fora do sistema e informe sua referência externa.');
  const operationKey = key(req);
  const requestHash = hash({ kind: 'TRANSITION', disputeId, target, note, externalReference, expectedVersion: b.expected_version, confirmed: b.confirm_external === true });
  try {
    const result = await locked(empresaId, `dispute:${disputeId}`, async (tx) => {
      const row = await dispute(empresaId, disputeId, tx);
      const previous = await s.findOneWhere(R_DISPUTE_EVENTS, { empresa_id: empresaId, idempotency_key: operationKey }, tx);
      if (previous) {
        if (previous.request_hash !== requestHash || Number(previous.dispute_id) !== disputeId) throw new HttpError(409, 'Chave de idempotência usada com outros dados.');
        return { dispute: row, idempotente: true };
      }
      if (Number(row.version || 0) !== b.expected_version) throw new HttpError(409, 'Versão da disputa mudou; atualize antes de continuar.');
      if (!TRANSITIONS[String(row.status)]?.includes(target)) throw new HttpError(409, 'Transição de disputa não permitida.');
      if (target === 'EVIDENCE_SUBMITTED') {
        const evidence = await s.list(R_DISPUTE_EVIDENCE, { page: 1, pageSize: 1, filter: { empresa_id: empresaId, dispute_id: disputeId } }, tx);
        if (!evidence.total) throw new HttpError(409, 'Registre ao menos uma evidência antes de informar envio externo.');
      }
      const now = new Date().toISOString();
      const changed = await s.tryUpdateIf(R_DISPUTES, disputeId, { empresa_id: empresaId, status: row.status, version: row.version ?? null },
        { status: target, version: b.expected_version + 1, resolved_at: ['WON', 'LOST', 'CLOSED'].includes(target) ? now : null, updated_at: now }, tx);
      if (!changed) throw new HttpError(409, 'Disputa mudou durante a operação; atualize e tente novamente.');
      await s.insert(R_DISPUTE_EVENTS, { empresa_id: empresaId, dispute_id: disputeId, kind: 'TRANSITION', from_status: row.status,
        to_status: target, note, external_reference: externalReference, idempotency_key: operationKey, request_hash: requestHash,
        created_by: actor.id, created_at: now }, tx);
      await audit(req, disputeId, 'Estado de disputa alterado manualmente', { from: row.status, to: target, external_asserted: b.confirm_external === true }, tx);
      return { dispute: changed, idempotente: false };
    }, 'read committed');
    noCache(res); res.json(result);
  } catch (error) { rethrowConflict(error); }
}
