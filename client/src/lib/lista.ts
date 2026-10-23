// ============================================================================
// LISTAGEM DE RECURSOS — configuração de apresentação
//
// Este módulo concentra APENAS apresentação: ordem/rótulo/largura das colunas,
// densidade da tabela, modo tabela × visual e os chips dos filtros ativos.
//
// Nada aqui conhece regra de negócio, endpoint ou paginação: a listagem
// continua consumindo exatamente a página que o servidor devolveu. Isso é
// deliberado — uma listagem não pode virar um segundo backend.
// ============================================================================
import type { Field, Option } from './meta';
import { formatDate, formatMoney } from './format';

// ----------------------------------------------------------------------------
// Densidade
// ----------------------------------------------------------------------------
export type Densidade = 'compacta' | 'normal' | 'confortavel';

export const DENSIDADES: readonly Densidade[] = ['compacta', 'normal', 'confortavel'] as const;

export type DensidadeConfig = {
  label: string;
  /** Lado da miniatura em px — a foto acompanha a densidade, nunca desaparece. */
  thumb: number;
  /** Respiro vertical da célula. */
  celula: string;
  cabecalho: string;
  descricao: string;
};

export const DENSIDADE_INFO: Record<Densidade, DensidadeConfig> = {
  compacta: { label: 'Compacta', thumb: 48, celula: 'py-1', cabecalho: 'py-1.5', descricao: 'Mais linhas por tela' },
  normal: { label: 'Normal', thumb: 56, celula: 'py-2', cabecalho: 'py-2.5', descricao: 'Equilíbrio entre foto e densidade' },
  confortavel: { label: 'Confortável', thumb: 64, celula: 'py-3', cabecalho: 'py-3', descricao: 'Foto maior, leitura folgada' },
};

export const DENSIDADE_PADRAO: Densidade = 'normal';

/**
 * Preferência antiga (`brobond_tabela_compacta`, booleana) → três níveis.
 * Lida uma única vez, quando a chave nova ainda não existe.
 */
export function densidadeLegada(): Densidade | null {
  try {
    const raw = localStorage.getItem('brobond_tabela_compacta');
    if (raw === null) return null;
    return raw === '1' ? 'compacta' : DENSIDADE_PADRAO;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Modo de visualização (tabela = padrão; visual = cartões)
// ----------------------------------------------------------------------------
export type ModoVisualizacao = 'tabela' | 'visual';

export const MODOS_VISUALIZACAO: readonly ModoVisualizacao[] = ['tabela', 'visual'] as const;
export const MODO_PADRAO: ModoVisualizacao = 'tabela';

// ----------------------------------------------------------------------------
// Configuração por recurso
// ----------------------------------------------------------------------------
export type ColunaLargura = { min: string; max: string };

export type ListaConfig = {
  /** Colunas prioritárias: as declaradas aqui vêm primeiro, nesta ordem. */
  prioridade: string[];
  /** Rótulo de apresentação (não altera `sort`/contrato da API). */
  rotulos: Record<string, string>;
  /** Classes Tailwind literais (o JIT só gera classes escritas por extenso). */
  larguras: Record<string, ColunaLargura>;
  /** Campo usado como título no modo visual. */
  titulo: string;
  /** Campos exibidos no cartão do modo visual. */
  card: string[];
};

const LARGURA_PADRAO: ColunaLargura = { min: 'min-w-[120px]', max: 'max-w-[220px]' };

const LISTA_PADRAO: ListaConfig = { prioridade: [], rotulos: {}, larguras: {}, titulo: '', card: [] };

/**
 * Produtos: a foto é a primeira coluna (fixa) e o restante segue a ordem em que
 * uma empresa de vestuário procura a peça — identificação (produto/SKU),
 * classificação (categoria/coleção/cor/grade), preço, estoque e status.
 */
const CONFIG_PRODUTOS: ListaConfig = {
  prioridade: ['nome', 'sku', 'categoria_id', 'colecao_id', 'cor_id', 'grade_id', 'preco_venda', 'estoque', 'formato', 'custo', 'ativo'],
  rotulos: {
    nome: 'Produto',
    sku: 'SKU',
    categoria_id: 'Categoria',
    colecao_id: 'Coleção',
    cor_id: 'Cor',
    grade_id: 'Grade',
    preco_venda: 'Preço',
    estoque: 'Estoque',
    formato: 'Formato',
    custo: 'Custo',
    ativo: 'Status',
  },
  larguras: {
    nome: { min: 'min-w-[240px]', max: 'max-w-[320px]' },
    sku: { min: 'min-w-[120px]', max: 'max-w-[160px]' },
    categoria_id: { min: 'min-w-[130px]', max: 'max-w-[170px]' },
    colecao_id: { min: 'min-w-[120px]', max: 'max-w-[160px]' },
    cor_id: { min: 'min-w-[110px]', max: 'max-w-[140px]' },
    grade_id: { min: 'min-w-[120px]', max: 'max-w-[150px]' },
    preco_venda: { min: 'min-w-[120px]', max: 'max-w-[140px]' },
    estoque: { min: 'min-w-[100px]', max: 'max-w-[120px]' },
    formato: { min: 'min-w-[120px]', max: 'max-w-[150px]' },
    custo: { min: 'min-w-[110px]', max: 'max-w-[130px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
  },
  titulo: 'nome',
  card: ['sku', 'categoria_id', 'cor_id', 'colecao_id', 'grade_id', 'preco_venda', 'estoque', 'ativo'],
};

const LISTA_POR_RECURSO: Record<string, ListaConfig> = {
  produtos: CONFIG_PRODUTOS,
};

export function configDaLista(recurso: string): ListaConfig {
  return LISTA_POR_RECURSO[recurso] ?? LISTA_PADRAO;
}

/**
 * Coluna sintética de ESTOQUE.
 *
 * A listagem genérica de produtos devolve o cadastro + fotos; o saldo por
 * tamanho/local vive no contrato de estoque (uma consulta por produto). Montar
 * essa coluna com uma chamada por linha seria justamente o N+1 que a listagem
 * precisa evitar, então a coluna mostra o saldo QUANDO ele já vem no payload e
 * um traço neutro quando não vem — nunca um número inventado.
 */
export const CAMPO_ESTOQUE: Field = {
  name: 'estoque',
  label: 'Estoque',
  type: 'integer',
  virtual: true,
  list: true,
  form: false,
  hint: 'Saldo por tamanho e local fica na grade de estoque do produto.',
};

/**
 * Coluna `#` (id) dos demais recursos: é o identificador que o operador usa em
 * atendimento/auditoria. Produtos dispensam — lá a identificação é SKU + nome.
 */
export const CAMPO_ID: Field = { name: 'id', label: '#', type: 'text', virtual: true, list: true, form: false };

export function usaColunaEstoque(recurso: string): boolean {
  return recurso === 'produtos';
}

/** Ordena os campos visíveis pela prioridade do recurso (o resto mantém a ordem do domínio). */
export function camposOrdenados(fields: Field[], recurso: string): Field[] {
  const { prioridade } = configDaLista(recurso);
  if (!prioridade.length) return fields.slice();
  const peso = new Map(prioridade.map((nome, i) => [nome, i]));
  return fields
    .map((f, indice) => ({ f, indice }))
    .sort((a, b) => {
      const pa = peso.has(a.f.name) ? peso.get(a.f.name)! : prioridade.length;
      const pb = peso.has(b.f.name) ? peso.get(b.f.name)! : prioridade.length;
      return pa === pb ? a.indice - b.indice : pa - pb;
    })
    .map(({ f }) => f);
}

export function rotuloDaColuna(f: Field, recurso: string): string {
  return configDaLista(recurso).rotulos[f.name] ?? f.label;
}

export function larguraDaColuna(f: Field, recurso: string): ColunaLargura {
  return configDaLista(recurso).larguras[f.name] ?? LARGURA_PADRAO;
}

export function campoTitulo(recurso: string): string {
  return configDaLista(recurso).titulo;
}

/** Campos do cartão (modo visual) — interseção entre a config e o que está visível. */
export function camposDoCard(fields: Field[], recurso: string): Field[] {
  const { card } = configDaLista(recurso);
  if (!card.length) {
    // Sem configuração: os primeiros campos úteis (sem id sintético e sem
    // texto longo, que estouraria o cartão).
    return fields.filter((f) => f.name !== 'id' && f.type !== 'textarea').slice(0, 4);
  }
  const porNome = new Map(fields.map((f) => [f.name, f]));
  return card.map((nome) => porNome.get(nome)).filter((f): f is Field => !!f);
}

/** Números ficam à direita, alinhados pela vírgula (tabular-nums). */
export function alinhamentoDaColuna(f: Field): string {
  return ['money', 'number', 'integer', 'percent'].includes(f.type) ? 'text-right tabular-nums' : '';
}

// ----------------------------------------------------------------------------
// Estoque (somente leitura do que já veio no payload)
// ----------------------------------------------------------------------------
const CHAVES_SALDO = ['estoque', 'estoque_total', 'saldo_estoque', 'quantidade_estoque'];

/** Saldo já presente na linha (quando o payload traz), ou null. */
export function saldoDaLinha(row: Record<string, any>): number | null {
  for (const chave of CHAVES_SALDO) {
    const valor = row[chave];
    if (valor === undefined || valor === null || valor === '') continue;
    const n = Number(valor);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function estoqueMinimoDaLinha(row: Record<string, any>): number | null {
  const n = Number(row.estoque_min);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------------
// Filtros ativos → chips
// ----------------------------------------------------------------------------
export type ChipFiltro = {
  /** Chaves de `filtros` que o chip representa (remover = limpar todas). */
  chaves: string[];
  rotulo: string;
  valor: string;
};

function rotuloDaOpcao(f: Field, valor: string, opcoes: Record<string, Option[]>): string {
  if (f.type === 'boolean') return valor === 'true' ? 'Sim' : 'Não';
  if (f.type === 'select') return f.options?.find((o) => o.value === valor)?.label ?? valor;
  if (f.type === 'ref') {
    const lista = f.ref ? opcoes[f.ref] : undefined;
    return lista?.find((o) => String(o.value) === valor)?.label ?? `#${valor}`;
  }
  return valor;
}

function valorDeFaixa(f: Field, bruto: string): string {
  if (f.type === 'money') return formatMoney(bruto);
  return bruto;
}

/**
 * Um chip por filtro preenchido (faixas de data e de valor viram um chip só).
 * É a fonte do contador "N filtros ativos" e da remoção individual.
 */
export function chipsDeFiltros(
  fields: Field[],
  filtros: Record<string, string>,
  opcoes: Record<string, Option[]> = {}
): ChipFiltro[] {
  const chips: ChipFiltro[] = [];
  for (const f of fields) {
    if (['date', 'datetime'].includes(f.type)) {
      const de = filtros[`${f.name}_de`] ?? '';
      const ate = filtros[`${f.name}_ate`] ?? '';
      if (!de && !ate) continue;
      const partes: string[] = [];
      partes.push(de ? `de ${formatDate(de)}` : 'sem início');
      partes.push(ate ? `até ${formatDate(ate)}` : 'sem fim');
      chips.push({
        chaves: [...(de ? [`${f.name}_de`] : []), ...(ate ? [`${f.name}_ate`] : [])],
        rotulo: f.label,
        valor: partes.join(' '),
      });
      continue;
    }
    if (['money', 'number', 'integer', 'percent'].includes(f.type)) {
      const min = filtros[`${f.name}_min`] ?? '';
      const max = filtros[`${f.name}_max`] ?? '';
      if (!min && !max) continue;
      const partes: string[] = [];
      if (min) partes.push(`a partir de ${valorDeFaixa(f, min)}`);
      if (max) partes.push(`até ${valorDeFaixa(f, max)}`);
      chips.push({
        chaves: [...(min ? [`${f.name}_min`] : []), ...(max ? [`${f.name}_max`] : [])],
        rotulo: f.label,
        valor: partes.join(' '),
      });
      continue;
    }
    const valor = filtros[f.name] ?? '';
    if (!valor) continue;
    chips.push({ chaves: [f.name], rotulo: f.label, valor: rotuloDaOpcao(f, valor, opcoes) });
  }
  return chips;
}
