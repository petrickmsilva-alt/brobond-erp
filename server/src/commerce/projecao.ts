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
//
// SEM TRUNCAMENTO (correção da revisão corretiva): os limites fixos antigos
// (`pageSize: 200_000`) eram um TETO SILENCIOSO — uma empresa com mais vendas
// ou itens que o teto perdia registros sem erro. A leitura agora PAGINA de
// verdade: avança página a página, com ordenação determinística por `id` (a
// ordem padrão do Store), até a última página incompleta. Nenhum registro é
// omitido nem duplicado; conjunto vazio devolve lista vazia.
// ============================================================================
import { getResource } from '../resources';
import { getStore } from '../services';
import type { Resource } from '../resources';
import type { Row, Tx } from '../store';

// Tamanho de página da leitura paginada. Não é um teto: é o passo da iteração.
// Pequeno o bastante para limitar o pico de memória por consulta e grande o
// bastante para não multiplicar idas ao banco.
const TAMANHO_PAGINA = 1_000;

// Tamanho do lote de ids por consulta `sale_id = ANY(...)`. Limita o número de
// parâmetros de uma única instrução (um `ANY` com centenas de milhares de ids é
// caro e pode esbarrar no limite de parâmetros do driver).
const LOTE_IDS = 500;

/**
 * Lê TODAS as linhas de um recurso que satisfazem o filtro, paginando de forma
 * determinística. A ordenação é a padrão do Store (`id`), então a paginação por
 * página não pula nem repete linha. Termina quando uma página vem incompleta.
 */
async function paginarTudo(r: Resource, filter: Record<string, unknown>, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const out: Row[] = [];
  for (let page = 1; ; page += 1) {
    const lote = await s.list(r, { page, pageSize: TAMANHO_PAGINA, filter }, tx);
    out.push(...lote.rows);
    if (lote.rows.length < TAMANHO_PAGINA) break;
  }
  return out;
}

/** Ids de `sales` da empresa — o recorte canônico do tenant (paginado). */
export async function idsDeVendasDaEmpresa(empresaId: number, tx?: Tx): Promise<string[]> {
  const linhas = await paginarTudo(getResource('sales')!, { empresa_id: empresaId }, tx);
  return linhas.map((v) => String(v.id));
}

/** Itens (`sale_items`) de um conjunto de vendas. O chamador DEVE passar ids de
 * vendas já recortados pelo tenant (obtidos por uma leitura scoped de `sales`);
 * é esse recorte que o `sale_id = ANY(...)` do SQL propaga para os itens.
 *
 * Os ids são deduplicados e ordenados ANTES do lote, para que a divisão em
 * lotes seja determinística; cada lote é lido com paginação estável por `id`.
 * Assim cada item aparece em exatamente um lote (nenhuma duplicata) e todos os
 * lotes cobrem o conjunto inteiro (nenhuma omissão). */
export async function itensDeVendas(saleIds: ReadonlyArray<string | number>, tx?: Tx): Promise<Row[]> {
  const ids = [...new Set(saleIds.map(String))].sort();
  if (!ids.length) return [];
  const r = getResource('sale_items')!;
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    out.push(...(await paginarTudo(r, { sale_id: ids.slice(i, i + LOTE_IDS) }, tx)));
  }
  return out;
}

/** Todos os itens da empresa (recorte por tenant no SQL). */
export async function itensDaEmpresa(empresaId: number, tx?: Tx): Promise<Row[]> {
  return itensDeVendas(await idsDeVendasDaEmpresa(empresaId, tx), tx);
}
