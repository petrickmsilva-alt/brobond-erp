// ============================================================================
// MERCADO LIVRE — LEITURA SOMENTE-GET DOS ANÚNCIOS DO VENDEDOR (Ordem Final, 2.4)
//
// Só faz GET. Não cria, não altera, não pausa e não exclui anúncios.
// Alimenta reconciliarAnunciosMercadoLivre (função pura do item 9).
//
// Endpoints (documentação oficial "Items & Searches", Mercado Livre):
//   GET /users/{user_id}/items/search?status=active&offset=N&limit=N  → IDs dos anúncios
//   GET /items?ids=ID1,ID2,...&attributes=id,seller_custom_field,status  → multiget (máx. 20 por chamada)
// O SKU do anúncio fica em `seller_custom_field`.
//
// Nunca é chamado em produção pelo sistema: quem executa é um operador, com token autorizado.
// Sem token, sem identidade ou com falha de busca, a função LANÇA erro (falha fechada).
// O token nunca aparece em mensagem de erro.
// ============================================================================
import type { AnuncioRemotoML } from './reconciliacaoMercadoLivre';

export type FetchLeitura = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<Response>;

export type ResultadoLeituraAnuncios = {
  anuncios: AnuncioRemotoML[];
  /** IDs que a busca devolveu mas que não puderam ser lidos no multiget (não entram no relatório). */
  nao_lidos: string[];
  total_informado: number;
};

const BASE_PADRAO = 'https://api.mercadolibre.com';
const PAGINA_BUSCA = 50;
const LOTE_MULTIGET = 20;
const MAXIMO_ANUNCIOS = 1000;

export async function lerAnunciosMercadoLivre(opcoes: {
  token: string;
  sellerId: string | number;
  fetchImpl?: FetchLeitura;
  baseUrl?: string;
  status?: string;
}): Promise<ResultadoLeituraAnuncios> {
  const token = String(opcoes.token || '').trim();
  const seller = String(opcoes.sellerId ?? '').trim();
  if (!token) throw new Error('leitura de anúncios: token ausente');
  if (!/^\d+$/.test(seller)) throw new Error('leitura de anúncios: identidade do vendedor inválida');
  const base = (opcoes.baseUrl || BASE_PADRAO).replace(/\/+$/, '');
  const status = opcoes.status ?? 'active';
  const fetchImpl: FetchLeitura = opcoes.fetchImpl ?? ((url, init) => fetch(url, init));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // 1) IDs dos anúncios, paginados por offset.
  const ids: string[] = [];
  let total = 0;
  for (let offset = 0; ; offset += PAGINA_BUSCA) {
    const url = `${base}/users/${seller}/items/search?status=${encodeURIComponent(status)}&offset=${offset}&limit=${PAGINA_BUSCA}`;
    const resp = await fetchImpl(url, { method: 'GET', headers });
    if (!resp.ok) throw new Error(`leitura de anúncios: busca recusada (HTTP ${resp.status})`);
    const corpo = (await resp.json()) as { results?: unknown; paging?: { total?: unknown } };
    const resultados = Array.isArray(corpo.results) ? corpo.results.map((x) => String(x)) : [];
    total = Number(corpo.paging?.total) || total;
    ids.push(...resultados);
    if (resultados.length === 0 || ids.length >= total || ids.length >= MAXIMO_ANUNCIOS) break;
  }
  const unicos = [...new Set(ids)].slice(0, MAXIMO_ANUNCIOS);

  // 2) Detalhes em lotes (multiget), só com os atributos de interesse.
  const anuncios: AnuncioRemotoML[] = [];
  const nao_lidos: string[] = [];
  for (let i = 0; i < unicos.length; i += LOTE_MULTIGET) {
    const lote = unicos.slice(i, i + LOTE_MULTIGET);
    const url = `${base}/items?ids=${lote.map(encodeURIComponent).join(',')}&attributes=id,seller_custom_field,status`;
    const resp = await fetchImpl(url, { method: 'GET', headers });
    if (!resp.ok) throw new Error(`leitura de anúncios: detalhes recusados (HTTP ${resp.status})`);
    const corpo = (await resp.json()) as unknown;
    const itens = Array.isArray(corpo) ? corpo : [];
    const lidos = new Set<string>();
    for (const entrada of itens as Array<{ code?: unknown; body?: { id?: unknown; seller_custom_field?: unknown } }>) {
      if (Number(entrada?.code) !== 200 || !entrada.body) continue;
      const id = String(entrada.body.id ?? '');
      if (!id) continue;
      lidos.add(id);
      const sku = entrada.body.seller_custom_field;
      anuncios.push({ id, sku: sku === undefined || sku === null || String(sku).trim() === '' ? null : String(sku) });
    }
    for (const id of lote) if (!lidos.has(id)) nao_lidos.push(id);
  }
  return { anuncios, nao_lidos, total_informado: total };
}
