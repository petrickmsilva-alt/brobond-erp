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
  /** Placeholder da busca da listagem (padrão: "Buscar em <módulo>..."). */
  buscaPlaceholder?: string;
  /** Rótulo do botão de inclusão (padrão: "Novo <singular>") — só apresentação. */
  rotuloNovo?: string;
  /** Estado vazio sem nenhum registro cadastrado (padrão genérico). */
  vazioTitulo?: string;
  vazioDescricao?: string;
  /**
   * Habilita a ação Ativar/Desativar na linha (PUT `{ ativo: !ativo }` no
   * contrato existente do recurso). Só para recursos em que alternar o status
   * é uma operação normal de cadastro.
   */
  alternarAtivo?: boolean;
  /** Substantivo do contador da listagem (padrão: "registro"/"registros"). */
  contagem?: { singular: string; plural: string };
  /**
   * Campo que guarda o HEX da amostra visual. Quando declarado, a tabela ganha
   * uma coluna AMOSTRA (primeira, antes do nome) alimentada por esse campo —
   * a cor fica com presença visual sem depender só dela (nome e HEX seguem
   * visíveis). Vazio = recurso sem amostra.
   */
  amostra?: string;
  /** Título da PÁGINA de edição (padrão: "Editar <singular>"). */
  rotuloEditar?: string;
  /** Descrição da PÁGINA de cadastro/edição — texto de apoio do formulário. */
  descricaoCadastro?: string;
  /** Rótulo do botão de salvar da página (padrão: "Salvar"). */
  rotuloSalvar?: string;
  /**
   * Texto exibido quando a exclusão é recusada por vínculos. Quando ausente, o
   * modal usa o resumo técnico devolvido pelo servidor.
   */
  mensagemVinculos?: string;
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

/**
 * Categorias: entidade organizadora dos produtos. A tabela segue a ordem em que
 * a pessoa procura o tipo de peça — Categoria, Descrição, Grade padrão e Status —
 * com a grade herdada pelos produtos sempre visível (não escondida).
 */
const CONFIG_CATEGORIAS: ListaConfig = {
  prioridade: ['nome', 'descricao', 'grade_id', 'ativo'],
  rotulos: {
    nome: 'Categoria',
    descricao: 'Descrição',
    grade_id: 'Grade padrão',
    ativo: 'Status',
  },
  larguras: {
    nome: { min: 'min-w-[200px]', max: 'max-w-[280px]' },
    descricao: { min: 'min-w-[200px]', max: 'max-w-[320px]' },
    grade_id: { min: 'min-w-[150px]', max: 'max-w-[200px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
  },
  titulo: 'nome',
  card: ['descricao', 'grade_id', 'ativo'],
  buscaPlaceholder: 'Buscar categoria...',
  rotuloNovo: 'Nova categoria',
  vazioTitulo: 'Nenhuma categoria cadastrada',
  vazioDescricao: 'Cadastre sua primeira categoria para organizar seus produtos.',
  alternarAtivo: true,
  contagem: { singular: 'categoria', plural: 'categorias' },
};

/**
 * Cores: cadastro simples no padrão do BROBOND ERP — LISTA → PÁGINA
 * (`/cores/novo`, `/cores/:id/editar`), nunca formulário sobreposto.
 * A ordem das colunas é a da pergunta que se faz ao revisar a cartela: qual é a
 * cor (amostra + nome), como ela é representada (HEX), ela está disponível
 * (status) e onde ela é usada (utilização).
 */
const CONFIG_CORES: ListaConfig = {
  prioridade: ['amostra', 'nome', 'hex', 'ativo', 'uso_vinculado'],
  rotulos: {
    amostra: 'Amostra',
    nome: 'Cor',
    hex: 'HEX',
    ativo: 'Status',
    uso_vinculado: 'Utilização',
  },
  larguras: {
    amostra: { min: 'min-w-[88px]', max: 'max-w-[96px]' },
    nome: { min: 'min-w-[200px]', max: 'max-w-[300px]' },
    hex: { min: 'min-w-[120px]', max: 'max-w-[140px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
    uso_vinculado: { min: 'min-w-[130px]', max: 'max-w-[160px]' },
  },
  titulo: 'nome',
  card: ['amostra', 'nome', 'hex', 'ativo', 'uso_vinculado'],
  amostra: 'hex',
  buscaPlaceholder: 'Buscar cor...',
  rotuloNovo: 'Nova cor',
  rotuloEditar: 'Editar cor',
  descricaoCadastro: 'Cadastre uma cor para utilização no catálogo de produtos.',
  rotuloSalvar: 'Salvar cor',
  mensagemVinculos: 'Não é possível excluir esta cor porque existem registros vinculados.',
  vazioTitulo: 'Nenhuma cor cadastrada',
  vazioDescricao: 'Cadastre a primeira cor para padronizar o catálogo de produtos.',
  alternarAtivo: true,
  contagem: { singular: 'cor', plural: 'cores' },
};

/**
 * Coleções: cadastro POR EMPRESA no padrão LISTA → PÁGINA do BROBOND ERP
 * (`/colecoes/novo`, `/colecoes/:id/editar`) — o formulário é uma página do ERP,
 * nunca modal/drawer. A ordem das colunas é a da pergunta que se faz ao revisar
 * o catálogo: qual é a coleção (nome), quando ela vale (temporada/ano), ela está
 * disponível (status) e onde ela é usada (utilização).
 */
const CONFIG_COLECOES: ListaConfig = {
  prioridade: ['nome', 'temporada', 'ano', 'ativo', 'uso_vinculado'],
  rotulos: {
    nome: 'Coleção',
    temporada: 'Temporada',
    ano: 'Ano',
    ativo: 'Status',
    uso_vinculado: 'Utilização',
  },
  larguras: {
    nome: { min: 'min-w-[200px]', max: 'max-w-[300px]' },
    temporada: { min: 'min-w-[130px]', max: 'max-w-[160px]' },
    ano: { min: 'min-w-[90px]', max: 'max-w-[110px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
    uso_vinculado: { min: 'min-w-[130px]', max: 'max-w-[160px]' },
  },
  titulo: 'nome',
  card: ['nome', 'temporada', 'ano', 'ativo', 'uso_vinculado'],
  buscaPlaceholder: 'Buscar coleção...',
  rotuloNovo: 'Nova coleção',
  rotuloEditar: 'Editar coleção',
  descricaoCadastro: 'Cadastre uma coleção para organizar os produtos do catálogo.',
  rotuloSalvar: 'Salvar coleção',
  mensagemVinculos: 'Não é possível excluir esta coleção porque existem produtos vinculados.',
  vazioTitulo: 'Nenhuma coleção cadastrada',
  vazioDescricao: 'Cadastre sua primeira coleção para organizar os produtos do catálogo.',
  alternarAtivo: true,
  contagem: { singular: 'coleção', plural: 'coleções' },
};

/**
 * Grades: entidade ESTRUTURAL do catálogo (conjunto nomeado de tamanhos, com
 * ordem). Cadastro no padrão LISTA → PÁGINA (`/grades/novo`,
 * `/grades/:id/editar`), nunca formulário sobreposto.
 *
 * A ordem das colunas é a da pergunta que se faz ao revisar as grades do
 * catálogo: qual é a grade, quais tamanhos ela tem (na ordem dela), como está a
 * tabela de medidas, ela está disponível e onde é usada.
 */
const CONFIG_GRADES: ListaConfig = {
  // `#` fica à esquerda como nos demais cadastros genéricos do ERP; depois vêm
  // as colunas do domínio: GRADE · TAMANHOS · MEDIDAS · STATUS · UTILIZAÇÃO.
  prioridade: ['id', 'nome', 'tamanhos', 'medidas_status', 'ativo', 'uso_vinculado', 'descricao'],
  rotulos: {
    id: '#',
    nome: 'Grade',
    tamanhos: 'Tamanhos',
    medidas_status: 'Medidas',
    ativo: 'Status',
    uso_vinculado: 'Utilização',
    descricao: 'Descrição',
  },
  larguras: {
    nome: { min: 'min-w-[200px]', max: 'max-w-[280px]' },
    tamanhos: { min: 'min-w-[180px]', max: 'max-w-[280px]' },
    medidas_status: { min: 'min-w-[130px]', max: 'max-w-[150px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
    uso_vinculado: { min: 'min-w-[150px]', max: 'max-w-[200px]' },
    descricao: { min: 'min-w-[180px]', max: 'max-w-[300px]' },
  },
  titulo: 'nome',
  card: ['tamanhos', 'medidas_status', 'ativo', 'uso_vinculado'],
  buscaPlaceholder: 'Buscar grade...',
  rotuloNovo: 'Nova grade',
  rotuloEditar: 'Editar grade',
  descricaoCadastro: 'Configure uma grade de tamanhos para utilização no catálogo de produtos.',
  rotuloSalvar: 'Salvar grade',
  mensagemVinculos: 'Não é possível excluir esta grade porque existem registros vinculados.',
  vazioTitulo: 'Nenhuma grade cadastrada',
  vazioDescricao: 'Cadastre a primeira grade de tamanhos para organizar o estoque dos produtos.',
  alternarAtivo: true,
  contagem: { singular: 'grade', plural: 'grades' },
};

/**
 * Insumos: matéria-prima da produção. Cadastro no padrão LISTA → PÁGINA
 * (`/insumos/novo`, `/insumos/:id/editar`), nunca formulário sobreposto.
 *
 * A ordem das colunas é a da pergunta que se faz ao revisar o estoque de
 * matéria-prima: qual é o insumo, em que unidade ele é comprado, de quem vem,
 * quanto custa, quanto tem em estoque, se está ativo e onde ele é usado.
 *
 * `estoque_saldo` e `uso_vinculado` são campos VIRTUAIS: o servidor os anota
 * na listagem (agregados, uma consulta por página) — nenhum número inventado
 * aqui.
 */
const CONFIG_INSUMOS: ListaConfig = {
  prioridade: ['nome', 'unidade', 'fornecedor_id', 'custo_medio', 'estoque_saldo', 'ativo', 'uso_vinculado'],
  rotulos: {
    nome: 'Insumo',
    unidade: 'Unidade',
    fornecedor_id: 'Fornecedor',
    custo_medio: 'Custo médio',
    estoque_saldo: 'Estoque',
    ativo: 'Status',
    uso_vinculado: 'Utilização',
  },
  larguras: {
    nome: { min: 'min-w-[200px]', max: 'max-w-[280px]' },
    unidade: { min: 'min-w-[120px]', max: 'max-w-[150px]' },
    fornecedor_id: { min: 'min-w-[150px]', max: 'max-w-[200px]' },
    custo_medio: { min: 'min-w-[120px]', max: 'max-w-[140px]' },
    estoque_saldo: { min: 'min-w-[110px]', max: 'max-w-[130px]' },
    ativo: { min: 'min-w-[110px]', max: 'max-w-[120px]' },
    uso_vinculado: { min: 'min-w-[150px]', max: 'max-w-[200px]' },
  },
  titulo: 'nome',
  card: ['unidade', 'fornecedor_id', 'custo_medio', 'estoque_saldo', 'ativo', 'uso_vinculado'],
  buscaPlaceholder: 'Buscar insumo...',
  rotuloNovo: 'Novo insumo',
  rotuloEditar: 'Editar insumo',
  descricaoCadastro: 'Cadastre a matéria-prima usada na produção, a unidade de compra, o custo e o fornecedor.',
  rotuloSalvar: 'Salvar insumo',
  mensagemVinculos: 'Não é possível excluir este insumo porque existem registros vinculados.',
  vazioTitulo: 'Nenhum insumo cadastrado',
  vazioDescricao: 'Cadastre a primeira matéria-prima para usar nas fichas técnicas e nas compras.',
  alternarAtivo: true,
  contagem: { singular: 'insumo', plural: 'insumos' },
};

const LISTA_POR_RECURSO: Record<string, ListaConfig> = {
  produtos: CONFIG_PRODUTOS,
  categorias: CONFIG_CATEGORIAS,
  cores: CONFIG_CORES,
  colecoes: CONFIG_COLECOES,
  grades: CONFIG_GRADES,
  insumos: CONFIG_INSUMOS,
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
 * Coluna sintética de AMOSTRA da cor.
 *
 * Mesmo padrão da coluna Estoque de Produtos: uma coluna calculada no front, a
 * partir de dados que a API já devolveu (o HEX do registro). Não há consulta
 * por linha nem endpoint novo.
 */
export const CAMPO_AMOSTRA: Field = {
  name: 'amostra',
  label: 'Amostra',
  type: 'text',
  virtual: true,
  list: true,
  form: false,
  hint: 'Amostra visual gerada a partir do código HEX.',
};

/**
 * Coluna sintética de UTILIZAÇÃO.
 *
 * O número vem do servidor (`uso_vinculado`, contagem real recortada pela
 * empresa ativa — ver `Resource.uso`). O front só apresenta: zero vira "—",
 * porque "0 produtos" polui a leitura da cartela.
 */
export const CAMPO_USO: Field = {
  name: 'uso_vinculado',
  label: 'Utilização',
  type: 'integer',
  virtual: true,
  list: true,
  form: false,
  hint: 'Quantos registros da empresa ativa usam este cadastro.',
};

/**
 * Coluna sintética do ESTADO DA TABELA DE MEDIDAS (grades).
 *
 * O valor vem ANOTADO pelo servidor no payload da listagem
 * (`medidas_status`/`medidas_pct`), calculado pela MESMA função de completude
 * do módulo de medidas (server/src/medidas.ts › resumoMedidasPorGrade) — o
 * front não recalcula nada e não faz uma consulta por grade.
 */
export const CAMPO_MEDIDAS: Field = {
  name: 'medidas_status',
  label: 'Medidas',
  type: 'text',
  virtual: true,
  list: true,
  form: false,
  hint: 'Situação da tabela de medidas da grade (sem tabela, parcial ou completa).',
};

/** Estados reais da tabela de medidas de uma grade (mesmos do servidor). */
export type StatusMedidas = 'sem_tabela' | 'parcial' | 'completa';

export const ROTULO_STATUS_MEDIDAS: Record<StatusMedidas, string> = {
  sem_tabela: 'Sem tabela',
  parcial: 'Parcial',
  completa: 'Completa',
};

/** A listagem deste recurso ganha a coluna MEDIDAS? */
export function usaColunaMedidas(recurso: string): boolean {
  return recurso === 'grades';
}

/**
 * Estado da tabela de medidas da linha (null quando o payload não trouxe —
 * ex.: recurso que não tem tabela de medidas). Nenhum estado é inventado: sem
 * dado, a coluna mostra o traço neutro.
 */
export function statusMedidasDaLinha(row: Record<string, any>): StatusMedidas | null {
  const bruto = String(row?.medidas_status ?? '');
  return bruto === 'sem_tabela' || bruto === 'parcial' || bruto === 'completa' ? bruto : null;
}

/** A linha tem utilização (produtos OU categorias vinculados)? */
export function temUtilizacao(row: Record<string, any>): boolean {
  const produtos = Number(row?.uso_vinculado);
  const categorias = Number(row?.uso_categorias);
  return (Number.isFinite(produtos) && produtos > 0) || (Number.isFinite(categorias) && categorias > 0);
}

/**
 * Coluna `#` (id) dos demais recursos: é o identificador que o operador usa em
 * atendimento/auditoria. Produtos dispensam — lá a identificação é SKU + nome.
 */
export const CAMPO_ID: Field = { name: 'id', label: '#', type: 'text', virtual: true, list: true, form: false };

export function usaColunaEstoque(recurso: string): boolean {
  return recurso === 'produtos';
}

/** Campo de onde sai a amostra visual (null = recurso sem coluna Amostra). */
export function campoDaAmostra(recurso: string): string | null {
  return configDaLista(recurso).amostra ?? null;
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

/** Placeholder da busca — padrão "Buscar em <módulo>..." quando não configurado. */
export function placeholderBusca(recurso: string, rotuloPadrao: string): string {
  return configDaLista(recurso).buscaPlaceholder ?? `Buscar em ${rotuloPadrao}...`;
}

/** Rótulo do botão de inclusão — padrão "Novo <singular>" quando não configurado. */
export function rotuloNovo(recurso: string, singular: string): string {
  return configDaLista(recurso).rotuloNovo ?? `Novo ${singular.toLowerCase()}`;
}

/** Título da PÁGINA de EDIÇÃO — padrão "Editar <singular>". */
export function rotuloEditar(recurso: string, singular: string): string {
  return configDaLista(recurso).rotuloEditar ?? `Editar ${singular.toLowerCase()}`;
}

/** Descrição da PÁGINA de cadastro/edição (texto de apoio do formulário). */
export function descricaoDoCadastro(recurso: string): string | undefined {
  return configDaLista(recurso).descricaoCadastro;
}

/** Rótulo do botão de salvar da página de cadastro (padrão: "Salvar"). */
export function rotuloSalvar(recurso: string): string {
  return configDaLista(recurso).rotuloSalvar ?? 'Salvar';
}

/**
 * Mensagem de exclusão bloqueada por vínculos (null = usa o resumo do servidor).
 * O diagnóstico continua sendo a fonte dos números e dos módulos; aqui fica só
 * a frase que o operador lê, na voz do cadastro.
 */
export function mensagemDeVinculos(recurso: string): string | null {
  return configDaLista(recurso).mensagemVinculos ?? null;
}

/** Título/descrição do estado vazio sem registros — genérico quando não configurado. */
export function textoVazio(recurso: string, singular: string): { titulo: string; descricao: string } {
  const c = configDaLista(recurso);
  const rotulo = rotuloNovo(recurso, singular);
  return {
    titulo: c.vazioTitulo ?? `Nenhum(a) ${singular.toLowerCase()} cadastrado(a)`,
    descricao: c.vazioDescricao ?? `Clique em "${rotulo}" para fazer o primeiro cadastro.`,
  };
}

/** A listagem oferece Ativar/Desativar na linha para este recurso? */
export function permiteAlternarAtivo(recurso: string): boolean {
  return configDaLista(recurso).alternarAtivo === true;
}

/** Substantivo do contador do recurso (undefined = genérico "registro"/"registros"). */
export function contagemDe(recurso: string): { singular: string; plural: string } | undefined {
  return configDaLista(recurso).contagem;
}

/** Contador da listagem ("1–3 de 3 categorias"); genérico quando não configurado. */
export function textoContagem(recurso: string, de: number, ate: number, total: number): string {
  if (total === 0) return 'Nenhum registro';
  const c = contagemDe(recurso);
  const nome = c ? (total === 1 ? c.singular : c.plural) : total === 1 ? 'registro' : 'registros';
  return `${de}–${ate} de ${total} ${nome}`;
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
  opcoes: Record<string, Option[]> = {},
  /**
   * Filtros rápidos do recurso (Todas/Ativas/Inativas): o chip mostra o rótulo
   * do recorte escolhido ("Ativas") em vez do valor técnico ("Sim").
   */
  rapidos: { field: string; options: { value: string; label: string }[] }[] = []
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
    const rapido = rapidos.find((r) => r.field === f.name)?.options.find((o) => o.value === valor);
    chips.push({ chaves: [f.name], rotulo: f.label, valor: rapido?.label ?? rotuloDaOpcao(f, valor, opcoes) });
  }
  return chips;
}
