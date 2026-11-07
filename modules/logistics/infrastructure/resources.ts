// ============================================================================
// MOTOR DE FRETE › INFRA › RECURSOS
//
// Declara as tabelas do módulo como recursos do store (mesmo contrato de
// `resources.ts`). São recursos INTERNOS: o CRUD genérico não os expõe; o
// acesso passa pelos handlers dedicados do módulo, que aplicam RBAC, recorte
// por empresa/loja e auditoria.
// ============================================================================
import type { Resource, Field } from '../../../server/src/resources';

const READ_ONLY = { create: false, update: false, delete: false };
const ALL_OPS = { create: true, update: true, delete: true };

function recurso(key: string, table: string, label: string, fields: [string, string][], ops = ALL_OPS): Resource {
  return {
    key,
    table,
    label,
    singular: label,
    labelFields: ['id'],
    internal: true,
    empresa: true,
    ops,
    orderBy: { field: 'id', dir: 'desc' },
    fields: [
      { name: 'empresa_id', label: 'Empresa', type: 'integer' },
      ...fields.map(([name, type]) => ({ name, label: name, type, search: type === 'text' } as Field)),
    ],
  };
}

export const SHIPPING_RULES = recurso('logistics_shipping_rules', 'logistics_shipping_rules', 'Regras de frete', [
  ['store_key', 'text'],
  ['nome', 'text'],
  ['descricao', 'text'],
  ['tipo', 'text'],
  ['prioridade', 'integer'],
  ['ativo', 'boolean'],
  ['condicoes', 'json'],
  ['acoes', 'json'],
  ['inicio_em', 'datetime'],
  ['fim_em', 'datetime'],
  ['criado_por', 'integer'],
  ['criado_em', 'datetime'],
  ['atualizado_em', 'datetime'],
]);

export const QUOTES = recurso('logistics_quotes', 'logistics_quotes', 'Cotações', [
  ['store_key', 'text'],
  ['venda_id', 'integer'],
  ['provider', 'text'],
  ['modalidade', 'text'],
  ['estado', 'text'],
  ['cep_origem', 'text'],
  ['cep_destino', 'text'],
  ['peso_g', 'integer'],
  ['volumes', 'integer'],
  ['valor_declarado', 'number'],
  ['valor_pedido', 'number'],
  ['opcoes', 'json'],
  ['opcao_selecionada', 'text'],
  ['valor_escolhido', 'number'],
  ['prazo_escolhido', 'integer'],
  ['frete_gratis', 'boolean'],
  ['subsidio', 'number'],
  ['valor_final', 'number'],
  ['referencia_externa', 'text'],
  ['motivo', 'text'],
  ['fingerprint', 'text'],
  ['valida_ate', 'datetime'],
  ['criado_por', 'integer'],
  ['criado_em', 'datetime'],
  ['atualizado_em', 'datetime'],
]);

export const PACKAGES = recurso('logistics_packages', 'logistics_packages', 'Volumes', [
  ['envio_id', 'integer'],
  ['indice', 'integer'],
  ['peso_g', 'integer'],
  ['altura_cm', 'number'],
  ['largura_cm', 'number'],
  ['comprimento_cm', 'number'],
  ['codigo_rastreamento', 'text'],
  ['provider_ref', 'text'],
  ['observacao', 'text'],
  ['criado_em', 'datetime'],
  ['atualizado_em', 'datetime'],
]);

export const LABELS = recurso('logistics_labels', 'logistics_labels', 'Etiquetas', [
  ['envio_id', 'integer'],
  ['provider', 'text'],
  ['provider_ref', 'text'],
  ['url_externa', 'text'],
  ['arquivo_id', 'integer'],
  ['mime', 'text'],
  ['tamanho_bytes', 'integer'],
  ['estado', 'text'],
  ['idempotency_key', 'text'],
  ['erro', 'text'],
  ['gerada_em', 'datetime'],
  ['criado_por', 'integer'],
  ['criado_em', 'datetime'],
  ['atualizado_em', 'datetime'],
]);

export const WEBHOOK_INBOX = recurso(
  'logistics_webhook_inbox',
  'logistics_webhook_inbox',
  'Webhooks de transportadora',
  [
    ['provider', 'text'],
    ['external_delivery_id', 'text'],
    ['event_type', 'text'],
    ['payload', 'json'],
    ['payload_hash', 'text'],
    ['assinatura_ok', 'boolean'],
    ['status', 'text'],
    ['attempts', 'integer'],
    ['outbox_id', 'integer'],
    ['correlation_id', 'text'],
    ['received_at', 'datetime'],
    ['processed_at', 'datetime'],
    ['last_error', 'text'],
    ['criado_em', 'datetime'],
    ['atualizado_em', 'datetime'],
  ]
);

export const AUDIT_LOGS = recurso('logistics_audit_logs', 'logistics_audit_logs', 'Auditoria logística', [
  ['store_key', 'text'],
  ['entidade', 'text'],
  ['entidade_id', 'integer'],
  ['acao', 'text'],
  ['descricao', 'text'],
  ['dados', 'json'],
  ['usuario_id', 'integer'],
  ['criado_em', 'datetime'],
], READ_ONLY);

export const R_SHIPPING_RULES = (): Resource => SHIPPING_RULES;
export const R_QUOTES = (): Resource => QUOTES;
export const R_PACKAGES = (): Resource => PACKAGES;
export const R_LABELS = (): Resource => LABELS;
export const R_WEBHOOK_INBOX = (): Resource => WEBHOOK_INBOX;
export const R_AUDIT_LOGS = (): Resource => AUDIT_LOGS;

export const LOGISTICS_RESOURCES: Resource[] = [
  SHIPPING_RULES,
  QUOTES,
  PACKAGES,
  LABELS,
  WEBHOOK_INBOX,
  AUDIT_LOGS,
];

/** Tabelas do módulo (para backup e diagnóstico). */
export const LOGISTICS_TABLES = LOGISTICS_RESOURCES.map((r) => r.table);
