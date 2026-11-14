// ============================================================================
// CONTROL PLANE › APLICAÇÃO › LISTAR EXECUÇÕES
//
// Paginação por cursor opaco (id decrescente). Somente metadados — nunca logs
// brutos nem variáveis de ambiente.
// ============================================================================
import { getStore } from '../../../server/src/services';
import { exigirAutorizacao } from '../policies/authorization-policy';
import { R_EXECUTIONS, R_OPERATIONS } from '../infrastructure/resources';
import { serializarExecucao } from './serialize';
import type { ExecutionRow } from '../domain/operation';
import type { OperationalActor } from '../domain/operation';

export type ListarExecucoesFiltro = { workflowKey?: string; status?: string; limit?: number; cursor?: string };

function decodificarCursor(cursor?: string): number | null {
  if (!cursor) return null;
  try {
    const n = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function codificarCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export async function listarExecucoes(actor: OperationalActor, filtro: ListarExecucoesFiltro = {}): Promise<{ executions: Record<string, unknown>[]; next_cursor: string | null }> {
  exigirAutorizacao(actor, 'workflow.read');
  const where: Record<string, unknown> = { empresa_id: actor.empresa_id };
  if (filtro.workflowKey) where.workflow_key = filtro.workflowKey;
  if (filtro.status) where.status = filtro.status;
  const limite = Math.min(Math.max(Number(filtro.limit) || 20, 1), 100);
  const cursor = decodificarCursor(filtro.cursor);

  const res = await getStore().list(R_EXECUTIONS, { page: 1, pageSize: limite + 1, sort: 'id', dir: 'desc', filter: where });
  let linhas = res.rows as ExecutionRow[];
  if (cursor) linhas = linhas.filter((r) => Number(r.id) < cursor);
  const temMais = linhas.length > limite;
  const pagina = linhas.slice(0, limite);

  const publicIds = new Map<number, string>();
  for (const exec of pagina) {
    const op = await getStore().get(R_OPERATIONS, Number(exec.operation_id));
    if (op) publicIds.set(Number(exec.operation_id), String((op as Record<string, unknown>).public_id ?? ''));
  }

  return {
    executions: pagina.map((e) => serializarExecucao(e, publicIds.get(Number(e.operation_id)) ?? null)),
    next_cursor: temMais && pagina.length ? codificarCursor(Number(pagina[pagina.length - 1].id)) : null,
  };
}
