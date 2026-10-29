import type { Resource, Field } from '../../../server/src/resources';
const resource = (table: string, fields: [string, string][]): Resource => ({
  key: table,
  table,
  label: table,
  singular: table,
  labelFields: ['id'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'desc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer' },
    ...fields.map(([name, type]) => ({ name, label: name, type, search: type === 'text' && name !== 'request_cifradas' }) as Field),
  ],
});
export const R_INTENTS = resource('payment_intents', [
  ['order_id', 'integer'],
  ['customer_ref', 'text'],
  ['channel', 'text'],
  ['currency', 'text'],
  ['minor_units', 'integer'],
  ['amount', 'integer'],
  ['method', 'text'],
  ['provider', 'text'],
  ['status', 'text'],
  ['idempotency_key', 'text'],
  ['correlation_id', 'text'],
  ['active_operation', 'integer'],
  ['cobranca_id', 'integer'],
  ['metadata', 'json'],
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
]);
export const R_ATTEMPTS = resource('payment_attempts', [
  ['payment_intent_id', 'integer'],
  ['provider', 'text'],
  ['provider_transaction_id', 'text'],
  ['method', 'text'],
  ['requested_amount', 'integer'],
  ['authorized_amount', 'integer'],
  ['captured_amount', 'integer'],
  ['refunded_amount', 'integer'],
  ['status', 'text'],
  ['failure_code', 'text'],
  ['failure_message', 'text'],
  ['started_at', 'datetime'],
  ['completed_at', 'datetime'],
  ['idempotency_key', 'text'],
  ['correlation_id', 'text'],
  ['safe_reference', 'json'],
  ['request_cifradas', 'text'],
]);
export const R_OPERATIONS = resource('payment_operations', [
  ['payment_intent_id', 'integer'],
  ['operation', 'text'],
  ['idempotency_key', 'text'],
  ['request_hash', 'text'],
  ['status', 'text'],
  ['amount', 'integer'],
  ['result', 'json'],
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
]);
export const R_METHODS = resource('payment_methods', [
  ['code', 'text'],
  ['name', 'text'],
  ['enabled', 'boolean'],
  ['settings', 'json'],
  ['updated_at', 'datetime'],
]);
export const R_ROUTING = resource('payment_routing_rules', [
  ['method', 'text'],
  ['provider', 'text'],
  ['priority', 'integer'],
  ['enabled', 'boolean'],
  ['conditions', 'json'],
  ['updated_at', 'datetime'],
]);
export const R_REFUNDS = resource('payment_refunds', [
  ['payment_intent_id', 'integer'],
  ['operation_id', 'integer'],
  ['amount', 'integer'],
  ['status', 'text'],
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
]);
export const R_DISPUTES = resource('payment_disputes', [
  ['payment_intent_id', 'integer'],
  ['provider_reference', 'text'],
  ['status', 'text'],
  ['amount', 'integer'],
  ['reason', 'text'],
  ['provider', 'text'], ['external_dispute_id', 'text'], ['due_date', 'date'],
  ['origin', 'text'], ['version', 'integer'], ['resolved_at', 'datetime'],
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
]);
export const R_SETTLEMENTS = resource('payment_settlements', [
  ['payment_intent_id', 'integer'],
  ['provider', 'text'],
  ['provider_reference', 'text'],
  ['settlement_date', 'date'],
  ['gross_amount', 'integer'],
  ['provider_fee', 'integer'],
  ['gateway_fee', 'integer'],
  ['installment_fee', 'integer'],
  ['antifraud_fee', 'integer'],
  ['net_amount', 'integer'],
  ['refund_amount', 'integer'],
  ['chargeback_amount', 'integer'],
  ['payout_reference', 'text'],
  ['payout_id', 'integer'],
  ['status', 'text'],
  ['evidence', 'json'],
  ['created_at', 'datetime'],
  ['updated_at', 'datetime'],
]);
export const R_PAYOUTS = resource('payment_payouts', [
  ['provider', 'text'], ['payout_reference', 'text'], ['settlement_date', 'date'],
  ['currency', 'text'], ['net_amount', 'integer'], ['content_hash', 'text'],
  ['status', 'text'], ['bank_transaction_id', 'integer'], ['created_by', 'integer'],
  ['created_at', 'datetime'], ['updated_at', 'datetime'],
]);
export const R_DISPUTE_EVIDENCE = resource('payment_dispute_evidence', [
  ['dispute_id', 'integer'], ['kind', 'text'], ['description', 'text'], ['content', 'text'],
  ['idempotency_key', 'text'], ['request_hash', 'text'], ['created_by', 'integer'], ['created_at', 'datetime'],
]);
export const R_DISPUTE_EVENTS = resource('payment_dispute_events', [
  ['dispute_id', 'integer'], ['kind', 'text'], ['from_status', 'text'], ['to_status', 'text'],
  ['note', 'text'], ['external_reference', 'text'], ['idempotency_key', 'text'], ['request_hash', 'text'],
  ['created_by', 'integer'], ['created_at', 'datetime'],
]);
export const R_PAYOUT_REVISIONS = resource('payment_payout_revisions', [
  ['payout_id', 'integer'], ['revision', 'integer'], ['content_hash', 'text'], ['report', 'json'],
  ['reason', 'text'], ['previous_hash', 'text'], ['idempotency_key', 'text'], ['request_hash', 'text'],
  ['created_by', 'integer'], ['created_at', 'datetime'],
]);
export const R_PAYOUT_UNLINKS = resource('payment_payout_unlinks', [
  ['payout_id', 'integer'], ['bank_transaction_id', 'integer'], ['reason', 'text'],
  ['idempotency_key', 'text'], ['request_hash', 'text'], ['created_by', 'integer'], ['created_at', 'datetime'],
]);
export const PAYMENT_RESOURCES = [R_INTENTS, R_ATTEMPTS, R_OPERATIONS, R_METHODS, R_ROUTING, R_REFUNDS, R_DISPUTES,
  R_DISPUTE_EVIDENCE, R_DISPUTE_EVENTS, R_SETTLEMENTS, R_PAYOUTS, R_PAYOUT_REVISIONS, R_PAYOUT_UNLINKS];
