import { getStore } from '../services';
import { getResource } from '../resources';
import type { Row, Tx } from '../store';

/** Tamanhos de uma grade, na ordem canônica. */
export async function gradeTamanhosDoProduto(gradeId: number, tx?: Tx): Promise<number[]> {
  const s = getStore();
  const out = await s.list(getResource('grade_tamanhos')!, {
    page: 1,
    pageSize: 500,
    filter: { grade_id: gradeId },
    sort: 'ordem',
    dir: 'asc',
  }, tx);
  return out.rows.map((r) => Number(r.tamanho_id)).filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Nome/título curto de produtos por id (escopados). */
export async function nomesProdutos(empresaId: number, ids: number[], tx?: Tx): Promise<Map<number, string>> {
  const s = getStore();
  const mapa = new Map<number, string>();
  for (const id of [...new Set(ids)]) {
    const p: Row | null = await s.findOneWhere(getResource('produtos')!, { id, empresa_id: empresaId }, tx);
    if (p) mapa.set(id, String(p.nome || p.sku || `#${id}`));
  }
  return mapa;
}
