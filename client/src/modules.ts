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
  History,
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
  { id: 'produtos', label: 'Produtos', icon: Shirt, group: 'Cadastros', path: '/produtos', resource: 'produtos', description: 'Catálogo de peças acabadas: SKU, cor, coleção, custo e preço.' },
  { id: 'insumos', label: 'Insumos', icon: Scissors, group: 'Cadastros', path: '/insumos', resource: 'insumos', description: 'Matéria-prima: tecido, botão, zíper, etiqueta e afins.' },
  { id: 'fornecedores', label: 'Fornecedores', icon: Factory, group: 'Cadastros', path: '/fornecedores', resource: 'fornecedores', description: 'Empresas de quem você compra insumos.' },
  { id: 'representantes', label: 'Representantes', icon: Handshake, group: 'Cadastros', path: '/representantes', resource: 'representantes', description: 'Vendedores externos, regiões e comissões.' },
  { id: 'clientes', label: 'Clientes', icon: Store, group: 'Cadastros', path: '/clientes', resource: 'clientes', description: 'Lojas e atacadistas que compram de você.' },
  { id: 'tamanhos', label: 'Tamanhos / Grade', icon: Ruler, group: 'Cadastros', path: '/tamanhos', resource: 'tamanhos', description: 'Grade de tamanhos: PP, P, M, G, GG.' },
  { id: 'colecoes', label: 'Coleções', icon: Tags, group: 'Cadastros', path: '/colecoes', resource: 'colecoes', description: 'Coleções e temporadas.' },

  // Estoque
  { id: 'estoque', label: 'Estoque Físico', icon: Warehouse, group: 'Estoque', path: '/estoque', resource: 'estoques', description: 'Saldo por produto, tamanho e local, com estoque mínimo.' },
  { id: 'movimentacoes', label: 'Movimentações', icon: ArrowLeftRight, group: 'Estoque', path: '/movimentacoes', resource: 'movimentacoes', description: 'Entradas, saídas e ajustes — cada lançamento atualiza o saldo.' },
  {
    id: 'inventario',
    label: 'Inventário',
    icon: ClipboardCheck,
    group: 'Estoque',
    path: '/inventario',
    description: 'Contagem física e acerto de saldos.',
    planned: [
      'Abrir uma contagem por local (almoxarifado, loja, expedição)',
      'Digitar a quantidade contada de cada produto/tamanho',
      'Comparar com o saldo do sistema e gerar os ajustes automaticamente',
    ],
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
    description: 'Insumos + mão de obra + indiretos → preço de custo.',
    planned: [
      'Lista de insumos por peça (consumo × custo médio)',
      'Soma com mão de obra e custos indiretos da ficha técnica',
      'Sugestão de preço de venda a partir da margem',
    ],
  },

  // Compras / Vendas
  { id: 'compras', label: 'Compras', icon: ShoppingCart, group: 'Compras', path: '/compras', resource: 'compras', description: 'Pedidos de compra de insumos e recebimento.' },
  { id: 'vendas', label: 'Vendas', icon: Receipt, group: 'Vendas', path: '/vendas', resource: 'vendas', description: 'Pedidos de venda por cliente e representante.' },

  // Relatórios
  {
    id: 'relatorios',
    label: 'Relatórios',
    icon: BarChart3,
    group: 'Relatórios',
    path: '/relatorios',
    description: 'Valoração de estoque, margem e giro.',
    planned: [
      'Posição de estoque por produto/tamanho/local (com valor)',
      'Movimentações por período',
      'Produção concluída por período e vendas por representante',
      'Exportação em Excel/PDF',
    ],
  },

  // Configurações
  { id: 'usuarios', label: 'Usuários', icon: Users, group: 'Configurações', path: '/usuarios', resource: 'usuarios', description: 'Quem acessa o sistema, perfis de permissão e senhas.', adminOnly: true },
  { id: 'auditoria', label: 'Auditoria', icon: History, group: 'Configurações', path: '/auditoria', resource: 'auditoria', description: 'Histórico de inclusões, alterações, exclusões e logins.', adminOnly: true },
  { id: 'config', label: 'Configurações', icon: Settings, group: 'Configurações', path: '/config', description: 'Sua conta, senha e informações do sistema.' },
];

export const MODULE_GROUPS = ['Cadastros', 'Estoque', 'Produção', 'Compras', 'Vendas', 'Relatórios', 'Configurações'];

export function findModuleByResource(resource: string): Module | undefined {
  return MODULES.find((m) => m.resource === resource);
}
