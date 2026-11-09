// ============================================================================
// LEITURA TENANT-SCOPED DA PROJEÇÃO ANALÍTICA (`sales` / `sale_items`) — BL-016
//
// `sale_items` NÃO tem `empresa_id`: é a projeção analítica de `sales` e a
// empresa vem do CABEÇALHO (ver `tenant-tables.ts`, categoria `projecao`). Toda
// leitura de itens precisa, portanto, recortar pela empresa NO PRÓPRIO BANCO.
//
// O caminho é o conjunto de ids de `sales` da empresa aplicado como
// `sale_id = ANY(...)` — o mesmo `= ANY` que o Store monta a partir de um
// filtro com valor de LISTA.
//
// POR QUE ISTO EXISTE: ler `sale_items` com `filter: {}` e depois descartar por
// `sale_id` em JS traz os itens de TODAS as empresas para a memória antes de
// jogá-los fora — vazamento de dado entre tenants no processo, custo de leitura
// desnecessário e paginação truncada por um `pageSize` fixo. Aqui o recorte é
// SQL: nenhuma linha de outra empresa é lida.
// ============================================================================
import { getResource } from '../resources';
import { getStore } from '../services';
import type { Row, Tx } from '../store';

// Tetos defensivos: acima disso a leitura precisa paginar (o Store entrega uma
// página só). São folgados de propósito — o gargalo real é o banco, não a página.
const PAGINA_VENDAS = 200_000;
const PAGINA_ITENS = 200_000;

/** Ids de `sales` da empresa — o recorte canônico do tenant. */
export async function idsDeVendasDaEmpresa(empresaId: number, tx?: Tx): Promise<string[]> {
  const out = await getStore().list(
    getResource('sales')!,
    { page: 1, pageSize: PAGINA_VENDAS, filter: { empresa_id: empresaId } },
    tx
  );
  return out.rows.map((v) => String(v.id));
}

/** Itens (`sale_items`) de um conjunto de vendas. O chamador DEVE passar ids de
 * vendas já recortados pelo tenant (obtidos por uma leitura scoped de `sales`);
 * é esse recorte que o `sale_id = ANY(...)` do SQL propaga para os itens. */
export async function itensDeVendas(saleIds: ReadonlyArray<string | number>, tx?: Tx): Promise<Row[]> {
  const ids = [...new Set(saleIds.map(String))];
  if (!ids.length) return [];
  const out = await getStore().list(
    getResource('sale_items')!,
    { page: 1, pageSize: PAGINA_ITENS, filter: { sale_id: ids } },
    tx
  );
  return out.rows;
}

/** Todos os itens da empresa (recorte por tenant no SQL). */
export async function itensDaEmpresa(empresaId: number, tx?: Tx): Promise<Row[]> {
  return itensDeVendas(await idsDeVendasDaEmpresa(empresaId, tx), tx);
}
