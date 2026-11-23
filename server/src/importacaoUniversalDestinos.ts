// ============================================================================
// REGISTRO ÚNICO DE DESTINOS DO MOTOR UNIVERSAL DE INGESTÃO
// ----------------------------------------------------------------------------
// Toda entrada (interface, atalho de módulo ou adaptador) usa este catálogo.
// Ele NÃO contém regra de leitura, mapeamento ou gravação: essas regras ficam
// no núcleo (`importacaoUniversal*`) e nos adaptadores de destino.
// ============================================================================

export type DestinoImportacao =
  | 'universal'
  | 'produtos'
  | 'estoque'
  | 'clientes'
  | 'fornecedores'
  | 'insumos'
  | 'politica_comercial';

export type DestinoImportacaoDef = {
  id: DestinoImportacao;
  rotulo: string;
  descricao: string;
  entidades: string[];
  colunasModelo: string[];
  adaptador: 'nucleo' | 'politica_comercial';
};

export const DESTINOS_IMPORTACAO: DestinoImportacaoDef[] = [
  {
    id: 'universal',
    rotulo: 'Detecção automática',
    descricao: 'O motor classifica cada aba e aplica os adaptadores detectados.',
    entidades: ['produto', 'sku', 'variacao', 'estoque', 'preco', 'movimentacao', 'cliente', 'fornecedor', 'insumo'],
    colunasModelo: ['sku', 'nome', 'categoria', 'cor', 'tamanho', 'quantidade', 'custo', 'preco_venda', 'local'],
    adaptador: 'nucleo',
  },
  {
    id: 'produtos',
    rotulo: 'Produtos e catálogo',
    descricao: 'Produto-pai, SKUs, variações, atributos, custos e preços.',
    entidades: ['produto', 'sku', 'variacao', 'preco'],
    colunasModelo: ['sku', 'nome', 'categoria', 'colecao', 'cor', 'tamanho', 'codigo_barras', 'custo', 'preco_venda', 'ativo'],
    adaptador: 'nucleo',
  },
  {
    id: 'estoque',
    rotulo: 'Estoque físico',
    descricao: 'Saldos por SKU, tamanho e local, com movimentação de ajuste auditada.',
    entidades: ['estoque'],
    colunasModelo: ['sku', 'tamanho', 'local', 'quantidade'],
    adaptador: 'nucleo',
  },
  {
    id: 'clientes',
    rotulo: 'Clientes',
    descricao: 'Cadastro de clientes com identificação por documento ou e-mail.',
    entidades: ['cliente'],
    colunasModelo: ['nome', 'cnpj_cpf', 'pessoa', 'tipo_cliente', 'telefone', 'email', 'ativo'],
    adaptador: 'nucleo',
  },
  {
    id: 'fornecedores',
    rotulo: 'Fornecedores',
    descricao: 'Cadastro de fornecedores com identificação por documento ou e-mail.',
    entidades: ['fornecedor'],
    colunasModelo: ['nome', 'cnpj_cpf', 'contato', 'telefone', 'email', 'ativo'],
    adaptador: 'nucleo',
  },
  {
    id: 'insumos',
    rotulo: 'Insumos',
    descricao: 'Insumos de produção com unidade, custo médio e fornecedor.',
    entidades: ['insumo'],
    colunasModelo: ['nome', 'unidade', 'custo_medio', 'fornecedor', 'ativo'],
    adaptador: 'nucleo',
  },
  {
    id: 'politica_comercial',
    rotulo: 'Política comercial',
    descricao: 'Planilha-base oficial: catálogo, hierarquia, custos, política e inventário.',
    entidades: ['produto', 'variacao', 'preco', 'estoque'],
    colunasModelo: ['item', 'categoria master', 'descrição', 'tamanho', 'código industria', 'custo unitário fabricação'],
    adaptador: 'politica_comercial',
  },
];

export function normalizarDestinoImportacao(valor: unknown): DestinoImportacao {
  const texto = String(valor ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias: Record<string, DestinoImportacao> = {
    saldos: 'estoque',
    saldo_estoque: 'estoque',
    'saldos_iniciais_de_estoque': 'estoque',
    estoques: 'estoque',
    produto: 'produtos',
    cliente: 'clientes',
    fornecedor: 'fornecedores',
    insumo: 'insumos',
    politica: 'politica_comercial',
    'politica_comercial': 'politica_comercial',
  };
  const candidato = alias[texto] ?? texto as DestinoImportacao;
  return DESTINOS_IMPORTACAO.some((d) => d.id === candidato) ? candidato : 'universal';
}

export function destinoImportacao(valor: unknown): DestinoImportacaoDef {
  return DESTINOS_IMPORTACAO.find((d) => d.id === normalizarDestinoImportacao(valor)) ?? DESTINOS_IMPORTACAO[0];
}

export function modeloCsvDestino(valor: unknown): string {
  const destino = destinoImportacao(valor);
  const linha = destino.colunasModelo.map((coluna, i) => ['CAM-100', 'Camisa Polo', 'Camisa', 'Azul', 'M', '150', '28,50', '69,90', 'LOJA'][i] ?? '');
  return `\uFEFF${destino.colunasModelo.join(';')}\r\n${linha.join(';')}`;
}
