// ============================================================================
// CONTROL PLANE › INFRA › RECURSOS (contrato do store)
//
// As tabelas operacionais são declaradas UMA ÚNICA VEZ no registry central
// (`server/src/resources.ts`), como recursos INTERNOS — o CRUD genérico NÃO os
// expõe; o acesso passa pelos handlers dedicados do módulo, que aplicam RBAC,
// recorte por empresa e auditoria. Este arquivo apenas reexporta as chaves,
// evitando uma segunda fonte de verdade do schema (o que faria as duas
// divergirem em silêncio: o store lê `columnsOf(r)` do recurso recebido).
// ============================================================================
import { RESOURCES, type Resource } from '../../../server/src/resources';

export const R_OPERATIONS: Resource = RESOURCES.operational_operations;
export const R_APPROVALS: Resource = RESOURCES.operational_approvals;
export const R_EXECUTIONS: Resource = RESOURCES.operational_executions;
export const R_AUDIT_EVENTS: Resource = RESOURCES.operational_audit_events;
export const R_OAUTH_CLIENTS: Resource = RESOURCES.oauth_clients;
export const R_OAUTH_CODES: Resource = RESOURCES.oauth_authorization_codes;
export const R_OAUTH_TOKENS: Resource = RESOURCES.oauth_tokens;
export const R_OAUTH_CONSENTS: Resource = RESOURCES.oauth_consents;

export const RECURSOS_OPERACIONAIS: Resource[] = [
  R_OPERATIONS,
  R_APPROVALS,
  R_EXECUTIONS,
  R_AUDIT_EVENTS,
  R_OAUTH_CLIENTS,
  R_OAUTH_CODES,
  R_OAUTH_TOKENS,
  R_OAUTH_CONSENTS,
];
