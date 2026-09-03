export type Module = {
  id: string;
  label: string;
  icon: string;
  /** null = item de topo (Dashboard) */
  group: string | null;
  path: string;
  /** nome do recurso da API (tabela) quando houver listagem */
  resource?: string;
  description: string;
};

// Fonte única de verdade para o menu lateral E as rotas.
export const MODULES: Module[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: '🏠',
    group: null,
    path: '/',
    description: 'Visão geral do negócio: KPIs de estoque, produção e vendas.',
  },

  // Cadastros
  {
    id: 'produtos',
    label: 'Produtos',
    icon: '👕',
    group: 'Cadastros',
    path: '/produtos',
    resource: 'produtos',
    description: 'Catálogo de peças acabadas (SKU, cor, coleção).',
  },
  {
    id: 'insumos',
    label: 'Insumos',
    icon: '🧵',
    group: 'Cadastros',
    path: '/insumos',
    resource: 'insumos',
    description: 'Matéria-prima: tecido, botão, zíper, etiqueta...',
  },
  {
    id: 'fornecedores',
    label: 'Fornecedores',
    icon: '🏭',
    group: 'Cadastros',
    path: '/fornecedores',
    resource: 'fornecedores',
    description: 'De quem você compra os insumos.',
  },
  {
    id: 'representantes',
    label: 'Representantes',
    icon: '🤝',
    group: 'Cadastros',
    path: '/representantes',
    resource: 'representantes',
    description: 'Vendedores externos e comissões.',
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: '🏪',
    group: 'Cadastros',
    path: '/clientes',
    resource: 'clientes',
    description: 'Lojas/atalistas que compram de você.',
  },
  {
    id: 'tamanhos',
    label: 'Tamanhos / Grade',
    icon: '📐',
    group: 'Cadastros',
    path: '/tamanhos',
    resource: 'tamanhos',
    description: 'Grade PP, P, M, G, GG.',
  },
  {
    id: 'colecoes',
    label: 'Coleções',
    icon: '🌟',
    group: 'Cadastros',
    path: '/colecoes',
    resource: 'colecoes',
    description: 'Coleções e temporadas.',
  },

  // Estoque
  {
    id: 'estoque',
    label: 'Estoque Físico',
    icon: '📍',
    group: 'Estoque',
    path: '/estoque',
    resource: 'estoques',
    description: 'Localização física e quantidades por tamanho.',
  },
  {
    id: 'movimentacoes',
    label: 'Movimentações',
    icon: '🔄',
    group: 'Estoque',
    path: '/movimentacoes',
    resource: 'movimentacoes',
    description: 'Entradas e saídas com motivo.',
  },
  {
    id: 'inventario',
    label: 'Inventário',
    icon: '🧮',
    group: 'Estoque',
    path: '/inventario',
    description: 'Contagem e ajustes de saldo.',
  },

  // Produção
  {
    id: 'ordens',
    label: 'Ordens de Fabricação',
    icon: '⚙️',
    group: 'Produção',
    path: '/ordens',
    resource: 'ordens',
    description: 'Ordens de produção (OP).',
  },
  {
    id: 'fichas',
    label: 'Ficha Técnica / BOM',
    icon: '📋',
    group: 'Produção',
    path: '/fichas',
    resource: 'fichas',
    description: 'Quanto de cada insumo vira 1 peça.',
  },
  {
    id: 'custo',
    label: 'Custo de Fabricação',
    icon: '💲',
    group: 'Produção',
    path: '/custo',
    description: 'Insumos + mão de obra + indiretos → preço de custo.',
  },

  // Compras
  {
    id: 'compras',
    label: 'Compras',
    icon: '🛒',
    group: 'Compras',
    path: '/compras',
    resource: 'compras',
    description: 'Pedidos de compra de insumos e recebimento.',
  },

  // Vendas
  {
    id: 'vendas',
    label: 'Vendas',
    icon: '💰',
    group: 'Vendas',
    path: '/vendas',
    resource: 'vendas',
    description: 'Pedidos de venda e comissão de representantes.',
  },

  // Relatórios
  {
    id: 'relatorios',
    label: 'Relatórios',
    icon: '📊',
    group: 'Relatórios',
    path: '/relatorios',
    description: 'Valoração de estoque, margem e giro.',
  },

  // Configurações
  {
    id: 'usuarios',
    label: 'Usuários',
    icon: '👤',
    group: 'Configurações',
    path: '/usuarios',
    resource: 'usuarios',
    description: 'Acesso e permissões.',
  },
  {
    id: 'config',
    label: 'Configurações',
    icon: '🛠️',
    group: 'Configurações',
    path: '/config',
    description: 'Perfil da empresa, logo e parâmetros.',
  },
];

export const MODULE_GROUPS = [
  'Cadastros',
  'Estoque',
  'Produção',
  'Compras',
  'Vendas',
  'Relatórios',
  'Configurações',
];
