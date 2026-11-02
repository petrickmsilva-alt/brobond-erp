// ============================================================================
// STOREFRONT ENTERPRISE — GALERIA DE PRODUTO (domínio puro, sem store novo).
//
// REAPROVEITA a tabela `arquivos` (via uploads.ts `attachImages`), que já tem
// `url`, `thumb_url`, `principal`, `ordem`. A evolução aditiva acrescentou
// `alt_text`, `ativo` e `variante_id` — sem criar segunda tabela de mídia.
//
// Regra de ouro (prompt §20):
//   • variante COM mídia específica → mostra SOMENTE as mídias da variante;
//   • variante SEM mídia específica → usa as mídias gerais do produto;
//   • mídia inativa nunca aparece; produto sem mídia → lista vazia (a tela
//     mostra o placeholder honesto, sem inventar imagem).
//
// É uma função pura: o estoque/preço/disponibilidade NÃO são decididos aqui e
// nenhum dado vem do navegador — `varianteId` é o tamanho_id já validado pelo
// servidor em `disponibilidadesPorTamanho`.
// ============================================================================
import type { PublicFile } from '../uploads';

export type MidiaGaleria = Pick<
  PublicFile,
  'id' | 'url' | 'thumb_url' | 'alt_text' | 'principal' | 'ordem' | 'variante_id' | 'ativo'
>;

/** Ordem estável: principal → ordem → id (mesma do `filesFor` dos dois stores). */
function ordenar(a: MidiaGaleria, b: MidiaGaleria): number {
  return Number(!!b.principal) - Number(!!a.principal) || a.ordem - b.ordem || a.id - b.id;
}

/**
 * Resolve a galeria a exibir para uma variação selecionada.
 * `fotos` já vem filtrado por `ativo` em `attachImages`, mas filtramos de novo
 * para que a função seja correta também com fixtures de teste.
 */
export function selecionarGaleria(fotos: MidiaGaleria[], varianteId: number | null | undefined): MidiaGaleria[] {
  const ativas = (Array.isArray(fotos) ? fotos : []).filter((f) => f && f.ativo !== false && typeof f.url === 'string' && f.url);
  const gerais = ativas.filter((f) => f.variante_id == null);
  if (varianteId == null) {
    // Nenhuma variação escolhida: se o produto só tem mídia por variação,
    // mostra ao menos a primeira — galeria vazia com foto cadastrada seria
    // pior para o comprador e não inventa dado algum.
    return gerais.length ? gerais.sort(ordenar) : ativas.slice().sort(ordenar).slice(0, 1);
  }
  const daVariante = ativas.filter((f) => Number(f.variante_id) === Number(varianteId));
  return (daVariante.length ? daVariante : gerais).sort(ordenar);
}

/** Visão pública enxuta (payload mínimo: sem mime, token, bytes, nome interno). */
export function midiaPublica(f: MidiaGaleria, nomeProduto: string) {
  return {
    id: Number(f.id),
    url: String(f.url),
    thumb_url: String(f.thumb_url || f.url),
    alt_text: f.alt_text && String(f.alt_text).trim() ? String(f.alt_text).slice(0, 180) : nomeProduto,
    principal: !!f.principal,
    variante_id: f.variante_id == null ? null : Number(f.variante_id),
  };
}

/**
 * Monta o mapa `variante_id → galeria` que a página de produto usa para trocar
 * as fotos ao selecionar um tamanho, sem nova requisição (performance).
 * Só inclui variações que REALMENTE têm mídia própria: as demais caem no
 * fallback do produto, resolvido no cliente com a mesma regra.
 */
export function galeriasPorVariante(fotos: MidiaGaleria[], nomeProduto = ''): Record<string, ReturnType<typeof midiaPublica>[]> {
  const ativas = (Array.isArray(fotos) ? fotos : []).filter((f) => f && f.ativo !== false && f.variante_id != null && f.url);
  const porVariante = new Map<number, MidiaGaleria[]>();
  for (const f of ativas) {
    const chave = Number(f.variante_id);
    const lista = porVariante.get(chave) || [];
    lista.push(f);
    porVariante.set(chave, lista);
  }
  const saida: Record<string, ReturnType<typeof midiaPublica>[]> = {};
  for (const [chave, lista] of porVariante) saida[String(chave)] = lista.sort(ordenar).map((f) => midiaPublica(f, nomeProduto));
  return saida;
}
