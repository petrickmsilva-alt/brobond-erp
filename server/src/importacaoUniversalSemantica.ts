import type { ArquivoInventariado, AbaInventariada } from './importacaoUniversalLeitura';

export type CampoCanonico =
  | 'sku' | 'nome' | 'categoria' | 'colecao' | 'cor' | 'tamanho' | 'quantidade'
  | 'custo' | 'custo_aquisicao' | 'custo_fabricacao' | 'custo_adicional' | 'imposto' | 'margem' | 'preco_venda' | 'preco_atacado' | 'preco_promocional' | 'qtd_min_atacado' | 'codigo_barras' | 'ncm' | 'peso_g'
  | 'local' | 'fornecedor' | 'telefone' | 'email' | 'cnpj_cpf' | 'descricao' | 'composicao'
  | 'tipo_movimento' | 'data' | 'referencia_externa';

export type TipoCampo = 'texto' | 'numero' | 'percentual' | 'data' | 'booleano' | 'codigo' | 'desconhecido';

export type SugestaoCampo = {
  aba: string;
  colunaOriginal: string;
  campoCanonico: CampoCanonico | null;
  tipoInferido: TipoCampo;
  confianca: number;
  motivo: string;
  amostras: unknown[];
  requerConfirmacao: boolean;
};

export type AnaliseSemantica = {
  sugestoes: SugestaoCampo[];
  camposDesconhecidos: SugestaoCampo[];
  ambiguidades: { aba: string; campos: CampoCanonico[]; colunas: string[] }[];
  contagemPorTipo: Record<TipoCampo, number>;
};

const DICIONARIO: Record<CampoCanonico, string[]> = {
  sku: ['sku','codigo_sku','referencia','ref','cod_produto','codigo_produto','product_code','item_code','codigo_item','codigo'],
  nome: ['nome','produto','descricao_produto','name','product_name','item','artigo','modelo'],
  categoria: ['categoria','category','grupo','grupo_produto','tipo_produto'],
  colecao: ['colecao','collection','linha','linha_produto','temporada'],
  cor: ['cor','color','colour','variant_color','cor_variacao'],
  tamanho: ['tamanho','size','tam','grade_tamanho','variant_size'],
  quantidade: ['quantidade','qtd','qty','quantity','saldo','estoque','stock','units','unidades'],
  custo: ['custo','cost','custo_unitario','unit_cost','custo_medio','custo_total'],
  custo_aquisicao: ['custo_aquisicao','custo_compra','purchase_cost','acquisition_cost','valor_compra'],
  custo_fabricacao: ['custo_fabricacao','manufacturing_cost','custo_producao','production_cost'],
  custo_adicional: ['custo_adicional','additional_cost','frete','embalagem','custo_extra'],
  imposto: ['imposto','tax','tributo','aliquota','taxa_imposto','icms','ipi','pis','cofins'],
  margem: ['margem','margin','margem_lucro','markup','margem_percentual'],
  preco_venda: ['preco_venda','preco','price','retail_price','preco_retail','valor_venda','preco_sugerido'],
  preco_atacado: ['preco_atacado','atacado','wholesale_price','preco_wholesale','preco_revenda'],
  preco_promocional: ['preco_promocional','promocao','preco_promo','promotional_price','sale_price'],
  qtd_min_atacado: ['qtd_min_atacado','quantidade_minima_atacado','minimum_wholesale_quantity','minimo_atacado'],
  codigo_barras: ['codigo_barras','ean','gtin','barcode','bar_code'],
  ncm: ['ncm','classificacao_fiscal'],
  peso_g: ['peso','peso_g','weight','peso_gramas','gramas'],
  local: ['local','localizacao','deposito','warehouse','location','armazem'],
  fornecedor: ['fornecedor','supplier','vendor','fabricante'],
  telefone: ['telefone','fone','phone','whatsapp','celular'],
  email: ['email','e_mail','mail'],
  cnpj_cpf: ['cnpj','cpf','cnpj_cpf','documento','tax_id'],
  descricao: ['descricao','description','detalhes','observacao'],
  composicao: ['composicao','composition','material','tecido','fabric'],
  tipo_movimento: ['tipo_movimento','movimento','movement_type','entrada_saida','operacao'],
  data: ['data','date','data_movimento','data_entrada','data_saida'],
  referencia_externa: ['referencia_externa','external_id','id_externo','codigo_externo','reference_id'],
};

const ALIAS_TO_FIELD = new Map<string, CampoCanonico>();
for (const [field, aliases] of Object.entries(DICIONARIO) as [CampoCanonico, string[]][]) {
  ALIAS_TO_FIELD.set(field, field);
  for (const alias of aliases) ALIAS_TO_FIELD.set(alias, field);
}

function normalizar(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function inferirTipo(values: unknown[]): TipoCampo {
  const sample = values.filter(v => v !== null && v !== undefined && v !== '').slice(0, 20);
  if (!sample.length) return 'desconhecido';
  const str = sample.map(v => String(v).trim());
  if (str.every(v => /^(true|false|sim|nao|não|yes|no|1|0)$/i.test(v))) return 'booleano';
  if (str.every(v => /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/.test(v))) return 'data';
  const percentCount = str.filter(v => /%$/.test(v)).length;
  if (percentCount >= Math.ceil(str.length * 0.75)) return 'percentual';
  const numeric = str.filter(v => {
    const cleaned = v.replace(/R\$|\s/g, '').replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
    return cleaned !== '' && Number.isFinite(Number(cleaned));
  }).length;
  if (numeric >= Math.ceil(str.length * 0.8)) return 'numero';
  if (str.every(v => /^[\d.\-/]+$/.test(v))) return 'codigo';
  return 'texto';
}

function valoresColuna(aba: AbaInventariada, col: string): unknown[] {
  return aba.linhas.slice(0, 20).map(r => r.valores[col]).filter(v => v !== null && v !== undefined && v !== '');
}

function sugerir(aba: AbaInventariada, coluna: string): SugestaoCampo {
  const norm = normalizar(coluna);
  const exact = ALIAS_TO_FIELD.get(norm);
  if (exact) return {
    aba: aba.nome, colunaOriginal: coluna, campoCanonico: exact,
    tipoInferido: inferirTipo(valoresColuna(aba, coluna)), confianca: norm === exact ? 1 : 0.97,
    motivo: norm === exact ? 'Correspondência exata com o campo canônico.' : 'Alias conhecido no dicionário semântico.',
    amostras: valoresColuna(aba, coluna).slice(0, 5), requerConfirmacao: false,
  };
  const candidates = Object.entries(DICIONARIO).filter(([field, aliases]) =>
    norm.includes(field) || aliases.some(alias => norm.includes(alias) && alias.length >= 4)
  ).map(([field]) => field as CampoCanonico);
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return {
    aba: aba.nome, colunaOriginal: coluna, campoCanonico: unique[0],
    tipoInferido: inferirTipo(valoresColuna(aba, coluna)), confianca: 0.68,
    motivo: 'Correspondência parcial; deve ser confirmada antes de qualquer importação.',
    amostras: valoresColuna(aba, coluna).slice(0, 5), requerConfirmacao: true,
  };
  return {
    aba: aba.nome, colunaOriginal: coluna, campoCanonico: null,
    tipoInferido: inferirTipo(valoresColuna(aba, coluna)), confianca: 0,
    motivo: unique.length > 1 ? 'Nome ambíguo; sem mapeamento automático.' : 'Campo desconhecido preservado; sem mapeamento automático.',
    amostras: valoresColuna(aba, coluna).slice(0, 5), requerConfirmacao: true,
  };
}

export function interpretarCamposUniversal(arquivo: ArquivoInventariado): AnaliseSemantica {
  const sugestoes: SugestaoCampo[] = [];
  for (const aba of arquivo.abas) for (const coluna of aba.cabecalhos) sugestoes.push(sugerir(aba, coluna));
  const bySheet = new Map<string, Map<CampoCanonico, SugestaoCampo[]>>();
  for (const s of sugestoes) {
    if (!s.campoCanonico) continue;
    const sheet = bySheet.get(s.aba) ?? new Map<CampoCanonico, SugestaoCampo[]>();
    const arr = sheet.get(s.campoCanonico) ?? [];
    arr.push(s); sheet.set(s.campoCanonico, arr); bySheet.set(s.aba, sheet);
  }
  const ambiguidades: AnaliseSemantica['ambiguidades'] = [];
  for (const [aba, map] of bySheet) for (const [campo, arr] of map) if (arr.length > 1) {
    ambiguidades.push({ aba, campos: [campo], colunas: arr.map(x => x.colunaOriginal) });
    arr.forEach(x => { x.requerConfirmacao = true; x.motivo = 'Mais de uma coluna sugere o mesmo campo canônico; escolha explicitamente qual usar.'; });
  }
  const contagemPorTipo: Record<TipoCampo, number> = { texto: 0, numero: 0, percentual: 0, data: 0, booleano: 0, codigo: 0, desconhecido: 0 };
  for (const s of sugestoes) contagemPorTipo[s.tipoInferido]++;
  return { sugestoes, camposDesconhecidos: sugestoes.filter(s => !s.campoCanonico), ambiguidades, contagemPorTipo };
}
