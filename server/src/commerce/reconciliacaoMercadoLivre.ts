// ============================================================================
// MERCADO LIVRE — RELATÓRIO DE RECONCILIAÇÃO DE ANÚNCIOS (Fase 4.3, item 9)
//
// Função PURA e somente leitura: recebe os produtos locais e os anúncios já lidos
// do canal, e CLASSIFICA. Não chama a rede, não cria, não altera e não exclui
// anúncios. Qualquer ação fica a cargo de um operador, com base no relatório.
//
// Situações:
//   vinculado               external_id existe no canal e tem o mesmo SKU
//   external_id_divergente  external_id existe, mas o anúncio tem outro SKU
//   sem_anuncio_remoto      external_id informado não existe mais no canal
//   vinculavel_por_sku      sem external_id; exatamente um anúncio com o SKU
//   sku_duplicado_remoto    sem external_id; mais de um anúncio com o SKU
//   sem_sku                 produto sem SKU (o canal exige SKU)
//   anuncio_remoto_sem_produto  anúncio do canal que nenhum produto local reivindica
// ============================================================================

export type ProdutoLocalML = { produto_id: number; sku: string; external_id: string | null };
export type AnuncioRemotoML = { id: string; sku: string | null };

export type SituacaoML =
  | 'vinculado'
  | 'external_id_divergente'
  | 'sem_anuncio_remoto'
  | 'vinculavel_por_sku'
  | 'sku_duplicado_remoto'
  | 'sem_sku'
  | 'anuncio_remoto_sem_produto';

export type LinhaReconciliacaoML = {
  produto_id: number | null;
  sku: string | null;
  external_id: string | null;
  situacao: SituacaoML;
  acao_sugerida: 'nenhuma' | 'revisar' | 'vincular_manualmente';
  external_id_sugerido: string | null;
};

export type RelatorioReconciliacaoML = {
  linhas: LinhaReconciliacaoML[];
  resumo: Record<SituacaoML, number> & { total: number };
  /** Invariantes: a reconciliação nunca exclui nem altera anúncios. */
  exclusoes: 0;
  alteracoes: 0;
};

const normalizaSku = (s: string | null | undefined) => String(s ?? '').trim();

export function reconciliarAnunciosMercadoLivre(
  locais: ProdutoLocalML[],
  remotos: AnuncioRemotoML[]
): RelatorioReconciliacaoML {
  const porId = new Map<string, AnuncioRemotoML>();
  const porSku = new Map<string, AnuncioRemotoML[]>();
  for (const a of remotos) {
    porId.set(String(a.id), a);
    const sku = normalizaSku(a.sku);
    if (sku) porSku.set(sku, [...(porSku.get(sku) ?? []), a]);
  }

  const reivindicados = new Set<string>();
  const linhas: LinhaReconciliacaoML[] = [];

  for (const p of locais) {
    const sku = normalizaSku(p.sku);
    const base = { produto_id: p.produto_id, sku: sku || null, external_id: p.external_id ?? null };
    if (!sku) {
      linhas.push({ ...base, situacao: 'sem_sku', acao_sugerida: 'revisar', external_id_sugerido: null });
      continue;
    }
    if (p.external_id) {
      const remoto = porId.get(String(p.external_id));
      if (!remoto) {
        linhas.push({ ...base, situacao: 'sem_anuncio_remoto', acao_sugerida: 'revisar', external_id_sugerido: null });
        continue;
      }
      reivindicados.add(String(remoto.id));
      const skuRemoto = normalizaSku(remoto.sku);
      linhas.push(
        skuRemoto === sku
          ? { ...base, situacao: 'vinculado', acao_sugerida: 'nenhuma', external_id_sugerido: null }
          : { ...base, situacao: 'external_id_divergente', acao_sugerida: 'revisar', external_id_sugerido: null }
      );
      continue;
    }
    const mesmos = porSku.get(sku) ?? [];
    if (mesmos.length === 1) {
      reivindicados.add(String(mesmos[0].id));
      linhas.push({ ...base, situacao: 'vinculavel_por_sku', acao_sugerida: 'vincular_manualmente', external_id_sugerido: String(mesmos[0].id) });
    } else if (mesmos.length > 1) {
      for (const m of mesmos) reivindicados.add(String(m.id));
      linhas.push({ ...base, situacao: 'sku_duplicado_remoto', acao_sugerida: 'revisar', external_id_sugerido: null });
    } else {
      linhas.push({ ...base, situacao: 'sem_anuncio_remoto', acao_sugerida: 'nenhuma', external_id_sugerido: null });
    }
  }

  for (const a of remotos) {
    if (reivindicados.has(String(a.id))) continue;
    linhas.push({
      produto_id: null,
      sku: normalizaSku(a.sku) || null,
      external_id: String(a.id),
      situacao: 'anuncio_remoto_sem_produto',
      acao_sugerida: 'revisar',
      external_id_sugerido: null,
    });
  }

  const resumo = {
    vinculado: 0, external_id_divergente: 0, sem_anuncio_remoto: 0, vinculavel_por_sku: 0,
    sku_duplicado_remoto: 0, sem_sku: 0, anuncio_remoto_sem_produto: 0, total: linhas.length,
  };
  for (const l of linhas) resumo[l.situacao] += 1;
  return { linhas, resumo, exclusoes: 0, alteracoes: 0 };
}
