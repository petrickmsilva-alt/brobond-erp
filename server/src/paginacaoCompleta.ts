// Complete tenant-scoped Store reads; callers should use a transaction when a
// consistent cross-page snapshot is required.
import { getStore } from './services';
import type { Resource } from './resources';
import type { Row, Tx } from './store';

type OpcoesListaCompleta = { pageSize?: number; sort?: string; dir?: 'asc' | 'desc' };

/** Lê todas as linhas do filtro, sem truncar o histórico por um limite de página. */
export async function listarTodos(r: Resource, filter: Record<string, unknown>, tx?: Tx, opcoes: OpcoesListaCompleta = {}): Promise<Row[]> {
  const pageSize = opcoes.pageSize && opcoes.pageSize > 0 ? Math.floor(opcoes.pageSize) : 1000;
  const linhas: Row[] = [];
  let total = 0;
  for (let page = 1; page === 1 || linhas.length < total; page++) {
    const resultado = await getStore().list(
      r,
      { page, pageSize, sort: opcoes.sort, dir: opcoes.dir, filter },
      tx
    );
    if (page === 1) total = resultado.total;
    if (!resultado.rows.length && linhas.length < total) {
      throw new Error(`Leitura paginada incompleta do recurso ${r.key}: ${linhas.length} de ${total} linhas.`);
    }
    linhas.push(...resultado.rows);
  }
  return linhas;
}
