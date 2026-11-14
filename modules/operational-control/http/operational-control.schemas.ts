// ============================================================================
// CONTROL PLANE › HTTP › VALIDAÇÃO DE ENTRADA
//
// Validação explícita (o ERP não usa Zod). Só os campos CONHECIDOS entram:
// `user_id`, `empresa_id`, `role`, `repository`, `branch` livre, `command` são
// IGNORADOS — a superfície aceita é mínima por construção.
// ============================================================================
import { OperationalError } from '../domain/errors';

function texto(valor: unknown, campo: string, { obrigatorio = false, max = 2000 } = {}): string {
  const s = valor === undefined || valor === null ? '' : String(valor).trim();
  if (obrigatorio && !s) throw new OperationalError('PARAMETRO_INVALIDO', `O campo "${campo}" é obrigatório.`, { [campo]: 'obrigatório' });
  if (s.length > max) throw new OperationalError('PARAMETRO_INVALIDO', `O campo "${campo}" excede ${max} caracteres.`, { [campo]: 'muito longo' });
  return s;
}

export type EntradaSolicitar = { workflowKey: string; parameters: Record<string, unknown>; reason: string; ref?: string };

export function validarSolicitar(corpo: unknown): EntradaSolicitar {
  const b = (corpo ?? {}) as Record<string, unknown>;
  const workflowKey = texto(b.workflow_key, 'workflow_key', { obrigatorio: true, max: 120 });
  const reason = texto(b.reason, 'reason', { obrigatorio: true, max: 500 });
  const ref = texto(b.ref, 'ref', { max: 200 }) || undefined;
  const parameters = b.parameters && typeof b.parameters === 'object' && !Array.isArray(b.parameters) ? (b.parameters as Record<string, unknown>) : {};
  return { workflowKey, parameters, reason, ref };
}

export function validarAprovar(corpo: unknown): { confirmation: string } {
  const b = (corpo ?? {}) as Record<string, unknown>;
  return { confirmation: texto(b.confirmation, 'confirmation', { obrigatorio: true, max: 500 }) };
}

export function validarRejeitar(corpo: unknown): { reason: string } {
  const b = (corpo ?? {}) as Record<string, unknown>;
  return { reason: texto(b.reason, 'reason', { obrigatorio: true, max: 500 }) };
}

export function validarCancelar(corpo: unknown): { reason?: string } {
  const b = (corpo ?? {}) as Record<string, unknown>;
  const reason = texto(b.reason, 'reason', { max: 500 });
  return { reason: reason || undefined };
}

/** Filtros de listagem de execuções (query string). */
export function validarFiltroExecucoes(query: Record<string, unknown>): { workflowKey?: string; status?: string; limit?: number; cursor?: string } {
  const workflowKey = texto(query.workflow_key, 'workflow_key', { max: 120 }) || undefined;
  const status = texto(query.status, 'status', { max: 40 }) || undefined;
  const cursor = texto(query.cursor, 'cursor', { max: 200 }) || undefined;
  const limiteBruto = Number(query.limit);
  const limit = Number.isFinite(limiteBruto) && limiteBruto > 0 ? Math.min(Math.floor(limiteBruto), 100) : undefined;
  return { workflowKey, status, limit, cursor };
}

/** Cabeçalho Idempotency-Key (obrigatório nas operações mutáveis de criação). */
export function idempotencyKeyDe(header: unknown): string {
  const k = texto(header, 'Idempotency-Key', { obrigatorio: true, max: 200 });
  return k;
}
