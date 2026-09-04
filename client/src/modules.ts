import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  BarChart3,
  Calculator,
  ClipboardCheck,
  ClipboardList,
  Cog,
  Factory,
  Handshake,
  HelpCircle,
  History,
  Palette,
  Layers,
  LayoutDashboard,
  Ruler,
  Scissors,
  Settings,
  Shirt,
  ShoppingCart,
  Store,
  Tags,
  Receipt,
  Users,
  Warehouse,
  Building2,
  Share2,
  Wallet,
  Landmark,
  Coins,
  PiggyBank,
  CircleDollarSign,
} from 'lucide-react';

export type Module = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** null = item de topo (Dashboard) */
  group: string | null;
  path: string;
  /** nome do recurso da API quando houver cadastro/listagem */
  resource?: string;
  description: string;
  /** visível apenas para administradores */
  adminOnly?: boolean;
  /** perfil mínimo para acessar (gerente/admin) */
  minPerfil?: 'gerente' | 'admin';
  /** módulo ainda sem funcionalidade (exibe página de planejamento) */
  planned?: string[];
};

// Fonte única de verdade para o menu lateral E as rotas.
export const MODULES: Module[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    group: null,
    path: '/',
    description: 'Visão geral do negócio: estoque, produção, compras e vendas.',
  },

  // Cadastros
  { id: 'produtos', label: 'Produtos', icon: Shirt, group: 'Cadastros', path: '/produtos', resource: 'produtos', description: 'Catálogo de peças acabadas: fotos, SKU, categoria, cor, coleção, custo e preço.' },
  { id: 'categorias', label: 'Categorias', icon: Layers, group: 'Cadastros', path: '/categorias', resource: 'categorias', description: 'Tipos de peça: camisa, camiseta, calça, bermuda...' },
  { id: 'cores', label: 'Cores', icon: Palette, group: 'Cadastros', path: '/cores', resource: 'cores', description: 'Cores padronizadas com amostra visual.' },
  { id: 'insumos', label: 'Insumos', icon: Scissors, group: 'Cadastros', path: '/insumos', resource: 'insumos', description: 'Matéria-prima: tecido, botão, zíper, etiqueta e afins.' },
  { id: 'fornecedores', label: 'Fornecedores', icon: Factory, group: 'Cadastros', path: '/fornecedores', resource: 'fornecedores', description: 'Empresas de quem você compra insumos.' },
  { id: 'representantes', label: 'Representantes', icon: Handshake, group: 'Cadastros', path: '/representantes', resource: 'representantes', description: 'Vendedores externos, regiões e comissões.' },
  { id: 'clientes', label: 'Clientes', icon: Store, group: 'Cadastros', path: '/clientes', resource: 'clientes', description: 'Lojas e atacadistas que compram de você.' },
  { id: 'tamanhos', label: 'Tamanhos / Grade', icon: Ruler, group: 'Cadastros', path: '/tamanhos', resource: 'tamanhos', description: 'Grade de tamanhos: PP, P, M, G, GG.' },
  { id: 'colecoes', label: 'Coleções', icon: Tags, group: 'Cadastros', path: '/colecoes', resource: 'colecoes', description: 'Coleções e temporadas.' },

  // Estoque
  { id: 'estoque', label: 'Estoque Físico', icon: Warehouse, group: 'Estoque', path: '/estoque', description: 'Grade de saldo por produto × tamanho × local, com estoque mínimo.' },
  { id: 'movimentacoes', label: 'Movimentações', icon: ArrowLeftRight, group: 'Estoque', path: '/movimentacoes', resource: 'movimentacoes', description: 'Entradas, saídas, ajustes e transferências — cada lançamento atualiza o saldo.' },
  { id: 'locais', label: 'Locais de Estoque', icon: Building2, group: 'Estoque', path: '/locais', resource: 'locais', description: 'Almoxarifado, loja, expedição e facção onde as peças ficam guardadas.' },
  {
    id: 'inventario',
    label: 'Inventário',
    icon: ClipboardCheck,
    group: 'Estoque',
    path: '/inventario',
    description: 'Contagem física e acerto de saldos. Abra uma contagem por local, digite as quantidades e gere os ajustes.',
  },

  // Produção
  { id: 'ordens', label: 'Ordens de Fabricação', icon: Cog, group: 'Produção', path: '/ordens', resource: 'ordens', description: 'Ordens de produção (OP). Ao concluir, as peças entram no estoque.' },
  { id: 'fichas', label: 'Ficha Técnica / BOM', icon: ClipboardList, group: 'Produção', path: '/fichas', resource: 'fichas', description: 'Mão de obra, custos indiretos e margem por produto.' },
  {
    id: 'custo',
    label: 'Custo de Fabricação',
    icon: Calculator,
    group: 'Produção',
    path: '/custo',
    description: 'Insumos + mão de obra + indiretos → preço de custo e preço sugerido de venda.',
  },

  // Compras / Vendas
  { id: 'compras', label: 'Compras', icon: ShoppingCart, group: 'Compras', path: '/compras', resource: 'compras', description: 'Pedidos de compra de insumos; ao receber, os insumos entram no estoque.' },
  { id: 'vendas', label: 'Vendas', icon: Receipt, group: 'Vendas', path: '/vendas', resource: 'vendas', description: 'Pedidos de venda com itens; ao faturar, as peças saem do estoque e a comissão é calculada.' },
  { id: 'catalogos', label: 'Catálogos públicos', icon: Share2, group: 'Vendas', path: '/catalogos', resource: 'catalogos', description: 'Compartilhe produtos com preço por link — sem login para o cliente.' },

  // Financeiro
  {
    id: 'financeiro',
    label: 'Financeiro',
    icon: Wallet,
    group: 'Financeiro',
    path: '/financeiro',
    minPerfil: 'gerente',
    description: 'Fluxo de caixa, receitas, despesas, custos, contas a receber/pagar e aportes de investidores.',
  },
  { id: 'lancamentos', label: 'Lançamentos', icon: Coins, group: 'Financeiro', path: '/lancamentos', resource: 'lancamentos_financeiros', minPerfil: 'gerente', description: 'Livro-caixa: receitas, despesas, investimentos e estornos.' },
  { id: 'categorias-financeiras', label: 'Categorias', icon: CircleDollarSign, group: 'Financeiro', path: '/categorias-financeiras', resource: 'categorias_financeiras', minPerfil: 'gerente', description: 'Classificação dos lançamentos financeiros.' },
  { id: 'contas-financeiras', label: 'Contas', icon: Landmark, group: 'Financeiro', path: '/contas-financeiras', resource: 'contas_financeiras', minPerfil: 'gerente', description: 'Caixa, banco, Pix, cartão e boleto.' },
  { id: 'investidores', label: 'Investidores / Sócios', icon: PiggyBank, group: 'Financeiro', path: '/investidores', resource: 'investidores', minPerfil: 'gerente', description: 'Quem aporta capital, participação e distribuição de lucros.' },
  { id: 'aportes', label: 'Aportes', icon: Wallet, group: 'Financeiro', path: '/aportes', resource: 'aportes', minPerfil: 'gerente', description: 'Capital inicial, aportes, reinvestimento e empréstimo de sócio.' },

  // Relatórios
  {
    id: 'relatorios',
    label: 'Relatórios',
    icon: BarChart3,
    group: 'Relatórios',
    path: '/relatorios',
    description: 'Posição de estoque, movimentações, produção, vendas, curva ABC e insumos mínimos.',
  },

  // Configurações
  { id: 'usuarios', label: 'Usuários', icon: Users, group: 'Configurações', path: '/usuarios', resource: 'usuarios', description: 'Quem acessa o sistema, perfis de permissão e senhas.', adminOnly: true },
  { id: 'auditoria', label: 'Auditoria', icon: History, group: 'Configurações', path: '/auditoria', resource: 'auditoria', description: 'Histórico de inclusões, alterações, exclusões e logins.', adminOnly: true },
  { id: 'config', label: 'Configurações', icon: Settings, group: 'Configurações', path: '/config', description: 'Sua conta, senha, preferências e informações do sistema.' },
  { id: 'ajuda', label: 'Ajuda', icon: HelpCircle, group: 'Configurações', path: '/ajuda', description: 'Guia rápido: como usar cada módulo do BROBOND ERP.' },
];

export const MODULE_GROUPS = ['Cadastros', 'Estoque', 'Produção', 'Compras', 'Vendas', 'Financeiro', 'Relatórios', 'Configurações'];

/** Módulos que usam página própria (não CRUD genérico nem PlannedModule). */
export const PAGES_ESPECIAIS = ['estoque', 'inventario', 'custo', 'relatorios', 'financeiro'] as const;

/** Módulos cuja listagem abre diretamente a página de detalhe. */
export const DETALHE_DIRETO = new Set(['ordens', 'fichas']);

export function findModuleByResource(resource: string): Module | undefined {
  return MODULES.find((m) => m.resource === resource);
}
