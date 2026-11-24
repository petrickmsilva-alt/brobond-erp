import { createHash } from 'node:crypto';
import type { AnaliseSemantica } from './importacaoUniversalSemantica';

// ============================================================================
// NÚCLEO DE HIERARQUIA DO MOTOR UNIVERSAL DE INGESTÃO
// ----------------------------------------------------------------------------
// Resolve produto-pai × variação DENTRO de uma única aba/CSV (ou de várias),
// sem exigir uma aba física de produtos-pai. É um componente do motor
// universal: usa o inventário e o mapeamento semântico canônicos e devolve o
// PLANO que a reconciliação, a prévia e o executor transacional consomem.
//
// Segurança da inferência (contrato):
//   • cor e tamanho são EIXOS, nunca identidade de família;
//   • nome normalizado sozinho NUNCA agrupa produtos;
//   • prefixo genérico de SKU NUNCA agrupa famílias distintas: o padrão só é
//     aceito quando o sufixo removido é explicado por cor/tamanho e a base é
//     consistente com a descrição-base das linhas;
//   • referência/código-base/família explícita são evidências fortes e, quando
//     conflitam entre si (ou com um SKU pai explícito), a família fica
//     AMBÍGUA: o conflito aparece na prévia e só as linhas afetadas são
//     ignoradas na gravação (não bloqueia a importação inteira);
//   • linha sem evidência suficiente vira produto independente — nenhuma
//     variante artificial é inventada.
// ============================================================================

export type CenarioHierarquia = 'A' | 'B' | 'C' | 'D';

export type MapeamentoHierarquia = {
  aba: string;
  colunaOriginal: string;
  campoCanonico: string | null;
  ignorado?: boolean;
  /** Quando false, a coluna existe mas não pode ser usada (mapeamento ambíguo). */
  usar?: boolean;
};

/** Inventário de abas persistido na sessão é estruturalmente compatível. */
export type FonteHierarquia = {
  abas: {
    nome: string;
    linhas: { linhaOrigem: number; valores: Record<string, unknown> }[];
  }[];
};

export type SnapshotHierarquiaERP = {
  id?: number;
  sku: string;
  nome?: string;
  produto_pai_id?: number | null;
};

/**
 * Entidades de catálogo podem conter uma família produto-pai × variação na
 * própria origem. Estoque, movimentação e cadastros auxiliares NÃO são
 * convertidos em produtos por este resolvedor: suas dependências continuam
 * exigindo um SKU/produto existente ou explicitamente criado pela sessão.
 */
export const TIPOS_CATALOGO_HIERARQUIA = new Set<string>(['produto', 'sku', 'variacao', 'preco']);

export type OpcoesHierarquia = {
  produtosERP?: SnapshotHierarquiaERP[];
  /** Tipos de entidade confirmados por aba; limita a inferência a abas de catálogo. */
  tiposPorAba?: Record<string, string>;
};

export type VarianteHierarquia = {
  aba: string;
  linha: number;
  sku: string;
  nome: string;
  cor: string;
  tamanho: string;
  chaveVariacao: string;
  codigoBarras: string;
  acao: 'criar' | 'atualizar' | 'ignorar';
  requerCorrecao: boolean;
  conflitos: string[];
};

export type PaiHierarquia = {
  sku: string;
  nome: string;
  origem: 'linha' | 'inferido' | 'erp';
  acao: 'criar' | 'atualizar' | 'reutilizar';
  existenteNoERP: boolean;
  aba?: string;
  linhaOrigem?: number;
};

export type FamiliaHierarquia = {
  chave: string;
  aba: string;
  cenario: CenarioHierarquia;
  evidencias: string[];
  confianca: number;
  pai: PaiHierarquia;
  /** Linhas físicas que representam o produto-base (não viram variantes). */
  linhasPai: { aba: string; linha: number }[];
  variantes: VarianteHierarquia[];
  conflitos: { tipo: string; descricao: string }[];
  resolvida: boolean;
  totalVariantes: number;
};

export type IndependenteHierarquia = {
  aba: string;
  linha: number;
  sku: string;
  nome: string;
  motivo: string;
};

export type ConflitoHierarquia = {
  tipo: 'conflito_familia' | 'familia_sem_evidencia';
  aba: string;
  linhasOrigem: number[];
  chave: string;
  descricao: string;
};

export type ResumoHierarquiaAba = {
  aplicavel: boolean;
  resolvida: boolean;
  cenario: CenarioHierarquia | null;
  familias: number;
  variantes: number;
  independentes: number;
  evidencias: string[];
  confianca: number;
  paisACriar: number;
  variantesACriar: number;
  variantesAAtualizar: number;
  conflitos: number;
  avisos: string[];
  linhasComConflito: number[];
};

export type PlanoHierarquiaUniversal = {
  familias: FamiliaHierarquia[];
  independentes: IndependenteHierarquia[];
  conflitos: ConflitoHierarquia[];
  porAba: Record<string, ResumoHierarquiaAba>;
  resumo: {
    familias: number;
    familiasResolvidas: number;
    variantes: number;
    independentes: number;
    paisACriar: number;
    variantesACriar: number;
    variantesAAtualizar: number;
    conflitos: number;
  };
};

const norm = (v: unknown): string => String(v ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().toUpperCase().replace(/\s+/g, ' ');
const texto = (v: unknown): string => String(v ?? '').trim();
const slug = (v: unknown): string => norm(v).replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const escapar = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashCurto = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 10).toUpperCase();
const chaveLinha = (aba: string, linha: number): string => `${aba}::${linha}`;

/**
 * Descrição-base: remove o tamanho somente como TOKEN isolado no fim e a cor
 * como palavra isolada (mesmas regras consolidadas na carga oficial — sem
 * partir "MARFIM" com tamanho "M"). Usada apenas como EVIDÊNCIA de apoio.
 */
export function nomeBaseHierarquia(nome: unknown, cor: unknown, tamanho: unknown): string {
  let d = texto(nome);
  const c = texto(cor), t = texto(tamanho);
  if (t) {
    d = d.replace(new RegExp(`[\\s:;\u2014\u2013-]+${escapar(t)}\\s*$`, 'i'), '');
    d = d.replace(new RegExp(`\\b${escapar(t)}\\s*$`, 'i'), '');
    d = d.replace(/\b(tamanho|tam)\b\s*[:;\u2014\u2013-]*\s*$/i, '');
  }
  if (c) {
    d = d.replace(new RegExp(`(^|[^0-9A-Za-z\u00c0-\u00ff])${escapar(c)}(?=[^0-9A-Za-z\u00c0-\u00ff]|$)`, 'gi'), '$1');
    if (d.toUpperCase().endsWith(c.toUpperCase())) d = d.slice(0, d.length - c.length);
  }
  return norm(d).replace(/[\s:;\u2014\u2013-]+$/g, '').trim() || norm(nome);
}

/**
 * Base de SKU comprovada: só devolve base quando ao menos um TOKEN final do SKU
 * é exatamente a cor ou o tamanho da própria linha. Nunca usa "prefixo comum"
 * genérico (ex.: BB100-1 × BB101-1 não produz base alguma).
 */
export function baseSkuPorPadrao(sku: unknown, cor: unknown, tamanho: unknown): string | null {
  const partes = texto(sku).toUpperCase().split(/[-_./\s]+/).filter(Boolean);
  if (partes.length < 2) return null;
  const alvos = new Set<string>();
  for (const token of slug(cor).split('-')) if (token) alvos.add(token);
  for (const token of slug(tamanho).split('-')) if (token) alvos.add(token);
  // Também aceita cor/tamanho colados no sufixo (ex.: "AZULCLARO", "TAM42").
  if (norm(cor)) alvos.add(norm(cor).replace(/\s+/g, ''));
  if (norm(tamanho)) alvos.add(norm(tamanho).replace(/\s+/g, ''));
  if (!alvos.size) return null;
  let removidos = 0;
  while (partes.length > 1 && alvos.has(norm(partes[partes.length - 1]))) {
    partes.pop();
    removidos++;
  }
  if (!removidos) return null;
  const base = partes.join('-');
  if (base.length < 4 || !/[A-Z0-9]/.test(base)) return null;
  return base;
}

type LinhaHierarquia = {
  aba: string;
  linha: number;
  sku: string;
  nome: string;
  nomeBase: string;
  cor: string;
  tamanho: string;
  skuPai: string;
  familiaId: string;
  skuBase: string;
  referencias: string[];
  basePadrao: string | null;
  codigoBarras: string;
  descricao: string;
  categoria: string;
  colecao: string;
  marca: string;
  mapeado: Record<string, unknown>;
};

type ChavePrimaria = { chave: string; cenario: CenarioHierarquia; evidencias: string[] };

function mapeamentosDaAnalise(semantica: AnaliseSemantica, automatico: boolean): MapeamentoHierarquia[] {
  const ambiguos = new Set<string>();
  for (const a of semantica.ambiguidades || []) {
    for (const c of a.colunas) ambiguos.add(`${a.aba}::${c}`);
  }
  return (semantica.sugestoes || []).map((s) => ({
    aba: s.aba,
    colunaOriginal: s.colunaOriginal,
    campoCanonico: s.campoCanonico,
    ignorado: (s as { ignorado?: boolean }).ignorado === true,
    // Na análise (antes da confirmação humana) só aliases exatos/fortes são
    // usados; sugestões parciais nunca autorizam inferência de família.
    usar: !ambiguos.has(`${s.aba}::${s.colunaOriginal}`)
      && (automatico ? s.confianca >= 0.97 : !s.requerConfirmacao),
  }));
}

function linhasMapeadas(
  fonte: FonteHierarquia,
  mapeamentos: MapeamentoHierarquia[],
  tiposPorAba: Record<string, string> = {},
): { aba: string; linhas: LinhaHierarquia[]; aplicavel: boolean; campos: Set<string> }[] {
  const porAba = new Map<string, MapeamentoHierarquia[]>();
  for (const m of mapeamentos) {
    if (!m.campoCanonico || m.ignorado === true || m.usar === false) continue;
    const arr = porAba.get(m.aba) ?? [];
    arr.push(m);
    porAba.set(m.aba, arr);
  }
  return (fonte.abas || []).map((aba) => {
    const cols = porAba.get(aba.nome) ?? [];
    const campos = new Set(cols.map((c) => c.campoCanonico as string));
    const tipoAba = tiposPorAba[aba.nome];
    const entidadeCatalogo = !tipoAba || TIPOS_CATALOGO_HIERARQUIA.has(tipoAba);
    // Uma aba de preço/estoque isolada (SKU + eixo + valor) NÃO é catálogo:
    // exige também identidade comercial/familiar, além de SKU e cor/tamanho.
    const identidadeCatalogo = campos.has('nome') || campos.has('descricao')
      || ['sku_pai', 'sku_base', 'familia_id', 'referencia_comercial', 'politica_comercial', 'codigo_item', 'codigo_industria', 'marca', 'categoria', 'colecao'].some((c) => campos.has(c));
    const aplicavel = entidadeCatalogo && identidadeCatalogo
      && campos.has('sku') && (campos.has('cor') || campos.has('tamanho'));
    const linhas: LinhaHierarquia[] = [];
    if (!aplicavel) return { aba: aba.nome, linhas, aplicavel: false, campos };
    for (const row of aba.linhas || []) {
      const m: Record<string, unknown> = {};
      for (const col of cols) {
        if (row.valores[col.colunaOriginal] !== undefined && !(col.campoCanonico! in m)) {
          m[col.campoCanonico!] = row.valores[col.colunaOriginal];
        }
      }
      const cor = texto(m.cor), tamanho = texto(m.tamanho);
      const nome = texto(m.nome ?? m.descricao);
      const referencias: string[] = [];
      for (const campo of ['referencia_comercial', 'codigo_industria', 'codigo_item', 'referencia_externa']) {
        const valor = norm(m[campo]);
        if (valor) referencias.push(`${campo}:${valor}`);
      }
      linhas.push({
        aba: aba.nome,
        linha: Number(row.linhaOrigem),
        sku: norm(m.sku),
        nome,
        nomeBase: nomeBaseHierarquia(nome, cor, tamanho),
        cor: norm(cor),
        tamanho: norm(tamanho),
        skuPai: norm(m.sku_pai),
        familiaId: norm(m.familia_id),
        skuBase: norm(m.sku_base),
        referencias,
        basePadrao: baseSkuPorPadrao(m.sku, cor, tamanho),
        codigoBarras: texto(m.codigo_barras),
        descricao: texto(m.descricao),
        categoria: texto(m.categoria),
        colecao: texto(m.colecao),
        marca: texto(m.marca),
        mapeado: m,
      });
    }
    return { aba: aba.nome, linhas, aplicavel, campos };
  });
}

function chaveVariacaoDe(l: LinhaHierarquia): string {
  return [l.cor ? `COR:${l.cor}` : '', l.tamanho ? `TAM:${l.tamanho}` : ''].filter(Boolean).join('|');
}

export function construirPlanoHierarquiaUniversal(
  fonte: FonteHierarquia,
  mapeamentos: MapeamentoHierarquia[],
  opcoes: OpcoesHierarquia = {},
): PlanoHierarquiaUniversal {
  const analisadas = linhasMapeadas(fonte, mapeamentos, opcoes.tiposPorAba ?? {});
  const todas = analisadas.flatMap((a) => a.linhas);
  const erpPorSku = new Map<string, SnapshotHierarquiaERP>();
  const erpPorId = new Map<number, SnapshotHierarquiaERP>();
  for (const p of opcoes.produtosERP || []) {
    const sku = norm(p.sku);
    if (!sku) continue;
    if (!erpPorSku.has(sku)) erpPorSku.set(sku, p);
    if (p.id !== undefined) erpPorId.set(Number(p.id), p);
  }
  const linhaPorSku = new Map<string, LinhaHierarquia>();
  for (const l of todas) if (l.sku && !linhaPorSku.has(l.sku)) linhaPorSku.set(l.sku, l);

  // Frequência das evidências fortes: um código que aparece uma única vez é
  // identificador de LINHA (ex.: Código Indústria por tamanho), não de família.
  const freqForte = new Map<string, number>();
  const freqBasePadrao = new Map<string, number>();
  const contar = (mapa: Map<string, number>, chave: string) => mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
  for (const l of todas) {
    if (l.familiaId) contar(freqForte, `familia_id:${l.aba}:${l.familiaId}`);
    if (l.skuBase) contar(freqForte, `sku_base:${l.aba}:${l.skuBase}`);
    for (const ref of l.referencias) contar(freqForte, ref);
    if (l.basePadrao) contar(freqBasePadrao, `${l.aba}:${l.basePadrao}`);
  }

  const primary = (l: LinhaHierarquia): ChavePrimaria | null => {
    if (l.skuPai && l.skuPai !== l.sku) return { chave: `A|${l.skuPai}`, cenario: 'A', evidencias: ['sku_pai'] };
    if (l.familiaId) return { chave: `B1|${l.aba}|${l.familiaId}`, cenario: 'B', evidencias: ['identificador_familia'] };
    if (l.skuBase) {
      const base = slug(l.skuBase);
      // Código-base só é comprovado quando efetivamente aparece no SKU da
      // linha; se não aparece, NÃO aborta as demais evidências (referência
      // comercial ou padrão de SKU ainda podem resolver a família).
      if (l.sku.startsWith(base) || l.sku.includes(`-${base}`)) {
        return { chave: `B2|${l.aba}|${base}`, cenario: 'B', evidencias: ['codigo_base'] };
      }
    }
    const refs = l.referencias.filter((r) => (freqForte.get(r) ?? 0) >= 2);
    if (refs.length) return { chave: `B3|${l.aba}|${refs[0]}`, cenario: 'B', evidencias: ['referencia_comercial'] };
    if (l.basePadrao && (freqBasePadrao.get(`${l.aba}:${l.basePadrao}`) ?? 0) >= 2) {
      return { chave: `C|${l.aba}|${l.basePadrao}`, cenario: 'C', evidencias: ['sku_base_validado'] };
    }
    return null;
  };

  type Grupo = { chave: string; cenario: CenarioHierarquia; evidencias: string[]; linhas: LinhaHierarquia[] };
  const grupos = new Map<string, Grupo>();
  const semChave: LinhaHierarquia[] = [];
  for (const l of todas) {
    const p = primary(l);
    if (!p || !l.sku) { semChave.push(l); continue; }
    const g = grupos.get(p.chave) ?? { chave: p.chave, cenario: p.cenario, evidencias: [...new Set(p.evidencias)], linhas: [] };
    g.evidencias = [...new Set([...g.evidencias, ...p.evidencias])];
    g.linhas.push(l);
    grupos.set(p.chave, g);
  }

  // Ambiguidade real: a MESMA evidência forte (referência, código-base ou
  // família) aparece em linhas que foram atribuídas a chaves primárias
  // distintas. Isso impede misturar famílias e impede que um SKU pai explícito
  // sequestre linhas de outra referência.
  const fortePorChave = new Map<string, Set<string>>();
  for (const [chave, grupo] of grupos) {
    const valores = new Set<string>();
    for (const l of grupo.linhas) {
      for (const ref of l.referencias) if ((freqForte.get(ref) ?? 0) >= 2) valores.add(ref);
      if (l.familiaId) valores.add(`familia_id:${l.aba}:${l.familiaId}`);
      if (l.skuBase) valores.add(`sku_base:${l.aba}:${l.skuBase}`);
    }
    fortePorChave.set(chave, valores);
  }
  const valorParaChaves = new Map<string, Set<string>>();
  for (const [chave, valores] of fortePorChave) {
    for (const valor of valores) {
      const set = valorParaChaves.get(valor) ?? new Set<string>();
      set.add(chave);
      valorParaChaves.set(valor, set);
    }
  }
  const chavesAmbiguas = new Set<string>();
  for (const chaves of valorParaChaves.values()) {
    if (chaves.size > 1) for (const c of chaves) chavesAmbiguas.add(c);
  }

  const usadosPai = new Set<string>();
  const skusVariantes = new Set(todas.map((l) => l.sku).filter(Boolean));
  const familias: FamiliaHierarquia[] = [];
  const conflitos: ConflitoHierarquia[] = [];
  const linhasConsumidas = new Set<string>();
  const paisPorLinha = new Set<string>();

  const skuPaiLivre = (candidato: string, chave: string): string => {
    const base = slug(candidato).slice(0, 30) || 'PAI';
    const conflita = (sku: string) => usadosPai.has(sku) || (skusVariantes.has(sku) && !sku.startsWith('PAI-'))
      || (erpPorSku.get(sku)?.produto_pai_id != null);
    let sku = base;
    if (conflita(sku)) sku = `${base.slice(0, 24)}-${hashCurto(chave)}`;
    let i = 1;
    while (usadosPai.has(sku) || (skusVariantes.has(sku) && sku !== base)) {
      sku = `${base.slice(0, 22)}-${hashCurto(`${chave}:${i}`)}`;
      i++;
      if (i > 20) break;
    }
    usadosPai.add(sku);
    return sku.slice(0, 40);
  };

  for (const [chave, grupo] of grupos) {
    const linhas = grupo.linhas;
    const problemas: { tipo: string; descricao: string }[] = [];
    if (chavesAmbiguas.has(chave)) problemas.push({
      tipo: 'evidencias_conflitantes',
      descricao: 'A mesma referência/código-base aparece em famílias distintas (ou conflita com SKU pai explícito). Corrija a coluna de família antes de vincular estas linhas.',
    });
    const skus = linhas.map((l) => l.sku);
    if (new Set(skus).size !== skus.length) problemas.push({
      tipo: 'sku_duplicado',
      descricao: 'SKU repetido dentro da família: variantes duplicadas não serão criadas.',
    });
    const bases = new Set(linhas.map((l) => l.nomeBase).filter(Boolean));
    if (grupo.cenario !== 'A' && bases.size > 1) problemas.push({
      tipo: 'nome_base_divergente',
      descricao: 'A chave de família reúne descrições-base diferentes; o agrupamento pode misturar produtos distintos.',
    });
    // Evidências adicionais realmente presentes nos dados (nunca só cor/tamanho).
    const evidencias = [...grupo.evidencias];
    if (bases.size === 1 && bases.has(linhas[0].nomeBase) && linhas[0].nomeBase) evidencias.push('nome_normalizado');
    if (linhas.some((l) => l.descricao)) evidencias.push('descricao');
    for (const campo of ['categoria', 'colecao', 'marca'] as const) {
      const valores = new Set(linhas.map((l) => norm(l[campo])).filter(Boolean));
      if (valores.size === 1) evidencias.push(campo);
    }
    if (linhas.some((l) => l.cor)) evidencias.push('cor');
    if (linhas.some((l) => l.tamanho)) evidencias.push('tamanho');

    // Linhas de produto-base: sem cor e sem tamanho, ou o próprio SKU pai
    // explícito. Uma família com mais de uma linha-base é ambígua.
    const linhasPai = linhas.filter((l) => (!l.cor && !l.tamanho)
      || (grupo.cenario === 'A' && l.sku === norm(grupo.chave.split('|')[1])));
    const paiExplicito = grupo.cenario === 'A' ? linhaPorSku.get(norm(grupo.chave.split('|')[1])) : undefined;
    if (linhasPai.length > 1) problemas.push({
      tipo: 'multiplas_linhas_pai',
      descricao: 'Mais de uma linha sem cor/tamanho pode ser o produto-pai; escolha uma referência explícita.',
    });
    const linhaPai = linhasPai.length === 1 ? linhasPai[0] : paiExplicito;
    const variantesLinhas = linhas.filter((l) => l !== linhaPai);

    // Sem eixo de variação real, não há família: viram produtos independentes.
    const eixos = new Set(variantesLinhas.map(chaveVariacaoDe).filter(Boolean));
    const temVariacao = variantesLinhas.length > 0 && (eixos.size >= 2
      || variantesLinhas.some((l) => l.cor || l.tamanho));
    if (grupo.cenario !== 'A' && (!temVariacao || variantesLinhas.length < 2)) {
      for (const l of linhas) semChave.push(l);
      continue;
    }
    if (grupo.cenario === 'A' && !variantesLinhas.length) {
      for (const l of linhas) semChave.push(l);
      continue;
    }
    if (eixos.size !== variantesLinhas.length && !linhasPai.length) problemas.push({
      tipo: 'combinacao_duplicada',
      descricao: 'Duas linhas da família compartilham a mesma combinação de cor e tamanho; nenhuma variante artificial será criada.',
    });

    const confiancaBase: Record<CenarioHierarquia, number> = { A: 0.99, B: 0.95, C: 0.86, D: 0.5 };
    let confianca = confiancaBase[grupo.cenario];
    if (bases.size === 1 && linhas[0].nomeBase) confianca = Math.min(1, confianca + 0.01);
    if (evidencias.includes('categoria') || evidencias.includes('colecao') || evidencias.includes('marca')) confianca = Math.min(1, confianca + 0.01);

    const nomePai = (linhaPai?.nomeBase || linhas[0].nomeBase || linhas[0].nome || 'Produto com variações').slice(0, 120);
    let pai: PaiHierarquia;
    if (linhaPai) {
      pai = {
        sku: linhaPai.sku,
        nome: (linhaPai.nomeBase || linhaPai.nome || nomePai).slice(0, 120),
        origem: 'linha',
        acao: erpPorSku.has(linhaPai.sku) ? 'reutilizar' : 'criar',
        existenteNoERP: erpPorSku.has(linhaPai.sku),
        aba: linhaPai.aba,
        linhaOrigem: linhaPai.linha,
      };
      usadosPai.add(pai.sku);
    } else if (grupo.cenario === 'A') {
      const skuPai = norm(grupo.chave.split('|')[1]);
      const existente = erpPorSku.get(skuPai);
      pai = {
        sku: skuPai.slice(0, 40),
        nome: nomePai,
        origem: existente ? 'erp' : 'inferido',
        acao: existente ? 'reutilizar' : 'criar',
        existenteNoERP: !!existente,
      };
      usadosPai.add(pai.sku);
    } else if (grupo.cenario === 'B' && linhas[0].skuBase) {
      const candidato = slug(linhas[0].skuBase);
      pai = {
        sku: skuPaiLivre(`PAI-${candidato}`, chave),
        nome: nomePai,
        origem: 'inferido',
        acao: erpPorSku.has(`PAI-${candidato}`) ? 'reutilizar' : 'criar',
        existenteNoERP: false,
      };
    } else {
      const candidato = grupo.cenario === 'C' ? `PAI-${linhas[0].basePadrao || ''}` : `PAI-${linhas[0].nomeBase || linhas[0].referencias[0] || ''}`;
      pai = {
        sku: skuPaiLivre(candidato, chave),
        nome: nomePai,
        origem: 'inferido',
        acao: 'criar',
        existenteNoERP: false,
      };
    }
    // Reimportação: um pai já existente é REUTILIZADO, nunca duplicado.
    if (erpPorSku.has(pai.sku) && pai.acao !== 'reutilizar') {
      pai.acao = 'reutilizar';
      pai.existenteNoERP = true;
      if (pai.origem === 'inferido') pai.origem = 'erp';
    }
    if (erpPorSku.get(pai.sku)?.produto_pai_id != null) problemas.push({
      tipo: 'pai_e_variacao_no_erp',
      descricao: `O SKU proposto para o produto-pai (${pai.sku}) já é uma variação de outro produto no ERP.`,
    });

    // SKUs de variante já existentes como filhos de OUTRO pai são conflito
    // real de vínculo: aparecem na prévia e são ignorados na gravação.
    const paiErp = erpPorSku.get(pai.sku);
    const variantes: VarianteHierarquia[] = variantesLinhas.map((l) => {
      const existente = erpPorSku.get(l.sku);
      const paiDoErp = existente?.produto_pai_id == null ? null : erpPorId.get(Number(existente.produto_pai_id));
      const conflitosLinha: string[] = [];
      if (paiDoErp && norm(paiDoErp.sku) !== norm(pai.sku)) {
        conflitosLinha.push(`SKU ${l.sku} já é variação de ${paiDoErp.sku} no ERP.`);
      }
      if (existente && existente.produto_pai_id == null && !paiErp && norm(l.sku) !== norm(pai.sku)) {
        conflitosLinha.push(`SKU ${l.sku} já existe como produto-pai no ERP.`);
      }
      if (skus.filter((s) => s === l.sku).length > 1) conflitosLinha.push(`SKU ${l.sku} duplicado na origem.`);
      if (chaveVariacaoDe(l) === '' ) conflitosLinha.push('Linha sem cor e sem tamanho dentro de família com variações.');
      return {
        aba: l.aba,
        linha: l.linha,
        sku: l.sku,
        nome: l.nome || nomePai,
        cor: l.cor,
        tamanho: l.tamanho,
        chaveVariacao: chaveVariacaoDe(l) || `SKU:${l.sku}`,
        codigoBarras: l.codigoBarras,
        acao: existente ? 'atualizar' : 'criar',
        requerCorrecao: problemas.length > 0 || conflitosLinha.length > 0,
        conflitos: conflitosLinha,
      };
    });

    const resolvida = problemas.length === 0 && variantes.every((v) => !v.requerCorrecao);
    const familia: FamiliaHierarquia = {
      chave,
      aba: linhas[0].aba,
      cenario: grupo.cenario,
      evidencias: [...new Set(evidencias)],
      confianca: Math.round(confianca * 100) / 100,
      pai,
      linhasPai: linhaPai ? [{ aba: linhaPai.aba, linha: linhaPai.linha }] : [],
      variantes,
      conflitos: problemas,
      resolvida,
      totalVariantes: variantes.length,
    };
    familias.push(familia);
    for (const l of linhas) linhasConsumidas.add(chaveLinha(l.aba, l.linha));
    // O produto-base pode estar em OUTRA aba (cenário A explícito): a linha
    // também é consumida pela família e não deve virar produto independente.
    if (linhaPai) {
      linhasConsumidas.add(chaveLinha(linhaPai.aba, linhaPai.linha));
      paisPorLinha.add(chaveLinha(linhaPai.aba, linhaPai.linha));
    }
    if (!resolvida) conflitos.push({
      tipo: 'conflito_familia',
      aba: familia.aba,
      linhasOrigem: linhas.map((l) => l.linha),
      chave: familia.chave,
      descricao: problemas.map((p) => p.descricao).join(' ') || variantes.flatMap((v) => v.conflitos).join(' '),
    });
  }

  // Linhas sem família: produtos independentes (nenhuma variante artificial).
  const independentes: IndependenteHierarquia[] = [];
  const vistosIndependentes = new Set<string>();
  for (const l of semChave) {
    const chave = chaveLinha(l.aba, l.linha);
    if (linhasConsumidas.has(chave) || paisPorLinha.has(chave) || vistosIndependentes.has(chave)) continue;
    vistosIndependentes.add(chave);
    independentes.push({
      aba: l.aba,
      linha: l.linha,
      sku: l.sku,
      nome: l.nome,
      motivo: !l.sku ? 'sem_sku' : (l.cor || l.tamanho) ? 'sem_evidencia_familia' : 'sem_atributos_variacao',
    });
  }
  // Uma linha usada como produto-base de uma família não é independente.
  const independentesFiltrados = independentes.filter((i) => !paisPorLinha.has(chaveLinha(i.aba, i.linha)));
  for (const a of analisadas) {
    if (!a.aplicavel) continue;
    const semEvidencia = independentesFiltrados.filter((i) => i.aba === a.aba && i.motivo === 'sem_evidencia_familia');
    if (semEvidencia.length) conflitos.push({
      tipo: 'familia_sem_evidencia',
      aba: a.aba,
      linhasOrigem: semEvidencia.map((i) => i.linha),
      chave: 'sem_evidencia_familia',
      descricao: 'Linhas com cor/tamanho, mas sem referência, código-base ou padrão de SKU comprovado: importadas como produtos independentes. Nenhuma variante artificial foi criada; informe uma coluna de família para agrupá-las.',
    });
  }

  const porAba: Record<string, ResumoHierarquiaAba> = {};
  for (const a of analisadas) {
    const familiasAba = familias.filter((f) => f.aba === a.aba);
    const resolvidas = familiasAba.filter((f) => f.resolvida);
    const inds = independentesFiltrados.filter((i) => i.aba === a.aba);
    const linhasComConflito = familiasAba.flatMap((f) => f.resolvida ? [] : f.variantes.map((v) => v.linha));
    porAba[a.aba] = {
      aplicavel: a.aplicavel,
      // A hierarquia foi analisada: a ausência de aba de pai NÃO bloqueia a
      // importação. Famílias com conflito real ficam visíveis na prévia e só
      // as suas linhas são ignoradas na gravação.
      resolvida: a.aplicavel,
      cenario: resolvidas[0]?.cenario ?? (inds.length ? 'D' : null),
      familias: resolvidas.length,
      variantes: resolvidas.reduce((n, f) => n + f.variantes.length, 0),
      independentes: inds.length,
      evidencias: [...new Set(resolvidas.flatMap((f) => f.evidencias))],
      confianca: resolvidas.length ? Math.min(...resolvidas.map((f) => f.confianca)) : 0,
      paisACriar: resolvidas.filter((f) => f.pai.acao === 'criar').length,
      variantesACriar: resolvidas.reduce((n, f) => n + f.variantes.filter((v) => v.acao === 'criar' && !v.requerCorrecao).length, 0),
      variantesAAtualizar: resolvidas.reduce((n, f) => n + f.variantes.filter((v) => v.acao === 'atualizar' && !v.requerCorrecao).length, 0),
      conflitos: familiasAba.length - resolvidas.length,
      avisos: inds.some((i) => i.motivo === 'sem_evidencia_familia') ? ['sem_evidencia_familia'] : [],
      linhasComConflito,
    };
  }

  const resolvidas = familias.filter((f) => f.resolvida);
  return {
    familias,
    independentes: independentesFiltrados,
    conflitos,
    porAba,
    resumo: {
      familias: familias.length,
      familiasResolvidas: resolvidas.length,
      variantes: familias.reduce((n, f) => n + f.variantes.length, 0),
      independentes: independentesFiltrados.length,
      paisACriar: resolvidas.filter((f) => f.pai.acao === 'criar').length,
      variantesACriar: resolvidas.reduce((n, f) => n + f.variantes.filter((v) => v.acao === 'criar' && !v.requerCorrecao).length, 0),
      variantesAAtualizar: resolvidas.reduce((n, f) => n + f.variantes.filter((v) => v.acao === 'atualizar' && !v.requerCorrecao).length, 0),
      conflitos: conflitos.length,
    },
  };
}

/** Análise (pré-confirmação humana): usa apenas aliases semânticos fortes. */
export function planoHierarquiaDeAnalise(fonte: FonteHierarquia, semantica: AnaliseSemantica, opcoes: OpcoesHierarquia = {}): PlanoHierarquiaUniversal {
  return construirPlanoHierarquiaUniversal(fonte, mapeamentosDaAnalise(semantica, true), opcoes);
}

/** Reconciliação/executor: usa EXCLUSIVAMENTE o mapeamento confirmado. */
export function planoHierarquiaDeMapeamentos(fonte: FonteHierarquia, mapeamentos: MapeamentoHierarquia[], opcoes: OpcoesHierarquia = {}): PlanoHierarquiaUniversal {
  return construirPlanoHierarquiaUniversal(fonte, mapeamentos.map((m) => ({ ...m, usar: m.ignorado !== true && m.usar !== false })), { ...opcoes, tiposPorAba: opcoes.tiposPorAba });
}
