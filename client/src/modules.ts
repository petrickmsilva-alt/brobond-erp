import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  ArrowRightLeft,
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
  LayoutGrid,
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
  PieChart,
  CircleDollarSign,
  Repeat,
  Webhook,
  Briefcase,
  CreditCard,
  Cloud,
  Instagram,
  Package,
  Plug,
  ShoppingBag,
  Bot,
  Megaphone,
  TrendingUp,
  Truck,
  Scale,
  FileText,
  FileUp,
  FileMinus,
  BadgeDollarSign,
} from 'lucide-react';

export type ModuleSpace = 'erp' | 'commerce' | 'creators' | 'utilidades';

export type ModuleKind = 'modulo' | 'subitem' | 'acao';

/**
 * As 11 áreas principais da Árvore Master do BROBOND ERP (ERP-UX-02 / ERP-UX-03).
 *
 * A ordem aqui é a ordem canônica das áreas na navegação:
 *   • 8 áreas do ERP CORE
 *   • Commerce (fora do Core)
 *   • Creators (fora do Core)
 *   • Utilidades Globais (conta pessoal e suporte)
 */
export const MODULE_AREAS = [
  'Meu Negócio',
  'Cadastros',
  'Vendas',
  'Estoque & Suprimentos',
  'Produção',
  'Financeiro',
  'Fiscal',
  'Administração',
  'Commerce',
  'Creators',
  'Utilidades Globais',
] as const;

export type ModuleArea = (typeof MODULE_AREAS)[number];

/**
 * Os grupos funcionais dentro de cada Área da Árvore Master.
 *
 * Junto com `MODULE_AREAS`, `AREA_META`, `GROUP_META` e `MODULES`, forma a
 * **fonte única de verdade** (Single Source of Truth) para Sidebar, Breadcrumb,
 * Header, Command Palette (Ctrl+K), rotas e `audit:menu`.
 */
export const MODULE_GROUPS = [
  // 1. Meu Negócio
  'Visão do negócio',
  'Análises',
  // 2. Cadastros
  'Produtos',
  'Materiais',
  'Pessoas',
  // 3. Vendas
  'Comercial',
  'Balcão',
  'Atendimento e entrega',
  'Pós-venda',
  // 4. Estoque & Suprimentos
  'Estoque',
  'Compras',
  // 5. Produção
  'Planejamento',
  'Execução',
  'Engenharia',
  // 6. Financeiro
  'Operação financeira',
  'Tesouraria',
  'Comissões',
  'Capital',
  'Parâmetros financeiros',
  // 7. Fiscal
  'Operação fiscal',
  'Parâmetros fiscais',
  // 8. Administração
  'Organização e acesso',
  'Governança',
  'Automações',
  // 9. Commerce — Fora do Core
  'Canais',
  'Multicanal',
  // 10. Creators — Fora do Core
  'Parcerias e campanhas',
  // 11. Utilidades Globais
  'Conta e suporte',
] as const;

export type ModuleGroup = (typeof MODULE_GROUPS)[number];

export type Module = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Espaço macro: ERP Core, Commerce, Creators ou Utilidades Globais */
  space: ModuleSpace;
  /** Área principal da Árvore Master (nível 1) */
  area: ModuleArea;
  /** Grupo funcional dentro da Área (nível 2) */
  group: ModuleGroup;
  /** Subgrupo organizacional dentro do Grupo (nível 3) */
  subgroup: string;
  /** Classificação estrutural na planta canônica (módulo, subitem ou ação) */
  kind?: ModuleKind;
  /** Sinônimos e termos de domínio para busca no Command Palette (Ctrl+K) */
  keywords?: string;
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
  /**
   * Provedor do Hub Omnichannel quando o módulo é um conector multicanal.
   *
   * Os QUATRO canais usam EXATAMENTE o mesmo painel analítico (gabarito
   * do brobond-ai-commerce) e o mesmo contrato de API: desde 2026-10-06
   * o `INSTAGRAM` também tem motor no servidor (Graph API da Meta), e a
   * página consulta `/api/connectors/instagram/painel` como a dos demais.
   */
  connector?: 'MERCADOLIVRE' | 'MERCADOPAGO' | 'NUVEMSHOP' | 'INSTAGRAM';
};

// Fonte única de verdade para a Árvore Master: Sidebar, Command Palette, Breadcrumb e Rotas.
export const MODULES: Module[] = [
  // ==========================================================================
  // 1. MEU NEGÓCIO (ERP CORE)
  // ==========================================================================
  {
    id: 'dashboard',
    label: 'Meu Negócio',
    icon: LayoutDashboard,
    space: 'erp',
    area: 'Meu Negócio',
    group: 'Visão do negócio',
    subgroup: 'Visão do negócio',
    keywords: 'visao executiva bi kpis faturamento margem curva abc canais',
    path: '/',
    description: 'Visão geral do negócio: estoque, produção, compras e vendas.',
  },
  {
    id: 'relatorios',
    label: 'Relatórios',
    icon: BarChart3,
    space: 'erp',
    area: 'Meu Negócio',
    group: 'Análises',
    subgroup: 'Central de relatórios',
    keywords: 'central de relatorios exportacao csv xlsx analises bi',
    path: '/relatorios',
    description: 'Posição de estoque, movimentações, produção, vendas, curva ABC e insumos mínimos.',
  },

  // ==========================================================================
  // 2. CADASTROS (ERP CORE)
  // ==========================================================================
  {
    id: 'produtos',
    label: 'Produtos',
    icon: Shirt,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Cadastro principal',
    keywords: 'pecas acabadas sku ean catalogo fichas variacoes',
    path: '/produtos',
    resource: 'produtos',
    description: 'Catálogo de peças acabadas: fotos, SKU, categoria, cor, coleção, custo e preço.',
  },
  {
    id: 'categorias',
    label: 'Categorias',
    icon: Layers,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Classificações',
    keywords: 'categorias de produto tipos de peca classificacao',
    path: '/categorias',
    resource: 'categorias',
    description: 'Tipos de peça: camisa, camiseta, calça, bermuda...',
  },
  {
    id: 'cores',
    label: 'Cores',
    icon: Palette,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Classificações',
    keywords: 'cartela de cores variantes hex',
    path: '/cores',
    resource: 'cores',
    description: 'Cores padronizadas usadas no catálogo de produtos.',
  },
  {
    id: 'colecoes',
    label: 'Coleções',
    icon: Tags,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Classificações',
    keywords: 'colecoes temporadas lancamentos',
    path: '/colecoes',
    resource: 'colecoes',
    description: 'Coleções e temporadas.',
  },
  {
    id: 'grades',
    label: 'Grade',
    icon: LayoutGrid,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Grades e medidas',
    keywords: 'grades de tamanho conjuntos numeracao',
    path: '/grades',
    resource: 'grades',
    description: 'Conjuntos nomeados de tamanhos (Camiseta PP-GG, Calça 36-48, Calçado 34-44...) vinculados a produtos e categorias.',
  },
  {
    id: 'tamanhos',
    label: 'Tamanhos',
    icon: Ruler,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Grades e medidas',
    keywords: 'dicionario de tamanhos pp p m g gg',
    path: '/tamanhos',
    resource: 'tamanhos',
    description: 'Dicionário de tamanhos: PP, P, M, G, GG, 36, 38, 40...',
  },
  {
    id: 'medidas',
    label: 'Tabela de Medidas',
    icon: Ruler,
    space: 'erp',
    area: 'Cadastros',
    group: 'Produtos',
    subgroup: 'Grades e medidas',
    keywords: 'medidas modelagem gabarito instrucoes de medicao',
    path: '/medidas',
    description: 'Medidas por tamanho de cada grade, com painel de completude, modelos prontos, cópia entre grades, instruções para o cliente e impressão.',
  },
  {
    id: 'insumos',
    label: 'Insumos',
    icon: Scissors,
    space: 'erp',
    area: 'Cadastros',
    group: 'Materiais',
    subgroup: 'Insumos',
    keywords: 'materia prima aviamentos tecido botao ziper etiqueta',
    path: '/insumos',
    resource: 'insumos',
    description: 'Matéria-prima: tecido, botão, zíper, etiqueta e afins.',
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: Store,
    space: 'erp',
    area: 'Cadastros',
    group: 'Pessoas',
    subgroup: 'Clientes, fornecedores e representantes',
    keywords: 'pessoas compradores lojistas atacadistas portal do cliente',
    path: '/clientes',
    resource: 'clientes',
    description: 'Lojas e atacadistas que compram de você.',
  },
  {
    id: 'fornecedores',
    label: 'Fornecedores',
    icon: Factory,
    space: 'erp',
    area: 'Cadastros',
    group: 'Pessoas',
    subgroup: 'Clientes, fornecedores e representantes',
    keywords: 'pessoas parceiros suprimentos compras',
    path: '/fornecedores',
    resource: 'fornecedores',
    description: 'Empresas de quem você compra insumos.',
  },
  {
    id: 'representantes',
    label: 'Representantes',
    icon: Handshake,
    space: 'erp',
    area: 'Cadastros',
    group: 'Pessoas',
    subgroup: 'Clientes, fornecedores e representantes',
    keywords: 'pessoas vendedores comerciais prepostos comissao',
    path: '/representantes',
    resource: 'representantes',
    description: 'Vendedores externos, regiões e comissões.',
  },

  // ==========================================================================
  // 3. VENDAS (ERP CORE)
  // ==========================================================================
  {
    id: 'vendas',
    label: 'Vendas',
    icon: Receipt,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Pedidos e negociação',
    keywords: 'pedidos de venda comercial faturamento',
    path: '/vendas',
    resource: 'vendas',
    description: 'Pedidos de venda com itens; ao faturar, as peças saem do estoque e a comissão é calculada.',
  },
  {
    id: 'propostas',
    label: 'Propostas comerciais',
    icon: FileText,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Pedidos e negociação',
    keywords: 'orcamentos propostas negociacao conversao pedido',
    path: '/propostas',
    resource: 'propostas',
    description: 'Rascunho → enviada → aprovada → convertida em pedido. A conversão é idempotente: uma proposta nunca vira dois pedidos.',
  },
  {
    id: 'catalogos',
    label: 'Catálogos públicos',
    icon: Share2,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Oferta e preço',
    keywords: 'catalogo digital vitrine link publico compartilhamento',
    path: '/catalogos',
    resource: 'catalogos',
    description: 'Compartilhe produtos com preço por link — sem login para o cliente.',
  },
  {
    id: 'politicas-comerciais',
    label: 'Políticas comerciais',
    icon: Tags,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Oferta e preço',
    keywords: 'regras comerciais descontos alcada minimo multiplo',
    path: '/politicas-comerciais',
    resource: 'politicas_comerciais',
    minPerfil: 'gerente',
    description: 'Preços, mínimos, múltiplos e regras sazonais por canal, coleção, catálogo ou cliente.',
  },
  {
    id: 'listas-preco',
    label: 'Listas de preço',
    icon: Tags,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Oferta e preço',
    keywords: 'tabelas de preco atacado varejo vigencia precificacao',
    path: '/listas-preco',
    resource: 'listas_preco',
    minPerfil: 'gerente',
    description: 'Tabelas de preço por produto e variação, com vigência, prioridade e histórico. O preço usado na venda é gravado no item e nunca recalculado.',
  },
  {
    id: 'pdv',
    label: 'PDV — venda balcão',
    icon: Receipt,
    space: 'erp',
    area: 'Vendas',
    group: 'Balcão',
    subgroup: 'Venda e gestão de caixa',
    keywords: 'frente de caixa balcao varejo scanner nfce',
    path: '/pdv',
    description: 'Venda de balcão por código de barras, SKU, desconto e pagamento. O servidor recalcula preço, desconto, frete, impostos e total — a tela mostra apenas prévia.',
  },
  {
    id: 'pdv-caixas',
    label: 'Caixas do PDV',
    icon: CreditCard,
    space: 'erp',
    area: 'Vendas',
    group: 'Balcão',
    subgroup: 'Venda e gestão de caixa',
    keywords: 'gestao de caixas gaveta abertura fechamento sangria suprimento',
    path: '/pdv-caixas',
    resource: 'pdv_caixas',
    minPerfil: 'gerente',
    description: 'Abertura e fechamento de caixa, suprimentos, sangrias e a diferença entre o esperado e o contado.',
  },
  {
    id: 'expedicao',
    label: 'Expedição',
    icon: ClipboardList,
    space: 'erp',
    area: 'Vendas',
    group: 'Atendimento e entrega',
    subgroup: 'Expedição e logística',
    keywords: 'entrega separacao conferencia embalagem packing',
    path: '/expedicao',
    description: 'Separação → conferência → embalagem → expedição. Conferência por código de barras, com divergência registrada e auditada.',
  },
  {
    id: 'divergencias',
    label: 'Divergências de conferência',
    icon: ClipboardCheck,
    space: 'erp',
    area: 'Vendas',
    group: 'Atendimento e entrega',
    subgroup: 'Expedição e logística',
    kind: 'subitem',
    keywords: 'erros conferencia sobra falta expedicao',
    path: '/divergencias',
    resource: 'divergencias_conferencia',
    description: 'Itens faltando ou sobrando na conferência, com o esperado, o lido e a resolução aplicada.',
  },
  {
    id: 'envios',
    label: 'Logística e envios',
    icon: Truck,
    space: 'erp',
    area: 'Vendas',
    group: 'Atendimento e entrega',
    subgroup: 'Expedição e logística',
    keywords: 'entrega envios rastreio frete transportadora etiqueta',
    path: '/envios',
    resource: 'envios',
    minPerfil: 'gerente',
    description: 'Cotação, geração de envio, etiqueta e rastreio por transportadora. Credenciais só em configuração segura — nunca no código.',
  },
  {
    id: 'devolucoes',
    label: 'Devoluções e reversa',
    icon: Repeat,
    space: 'erp',
    area: 'Vendas',
    group: 'Pós-venda',
    subgroup: 'Devoluções',
    keywords: 'pos-venda devolucoes logistica reversa trocas estorno',
    path: '/devolucoes',
    resource: 'devolucoes',
    description: 'Solicitação → autorização → rastreio → recebimento → conferência. Só item em bom estado volta ao estoque. As ações disponíveis vêm do servidor.',
  },

  // ==========================================================================
  // 4. ESTOQUE & SUPRIMENTOS (ERP CORE)
  // ==========================================================================
  {
    id: 'estoque',
    label: 'Estoque Físico',
    icon: Warehouse,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Posição e controle',
    keywords: 'saldo fisico grade de estoque posicao minimo',
    path: '/estoque',
    description: 'Grade de saldo por produto × tamanho × local, com estoque mínimo.',
  },
  {
    id: 'movimentacoes',
    label: 'Movimentações',
    icon: ArrowLeftRight,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Posição e controle',
    keywords: 'entradas saidas ajustes transferencias de estoque kardex',
    path: '/movimentacoes',
    resource: 'movimentacoes',
    description: 'Entradas, saídas, ajustes e transferências — cada lançamento atualiza o saldo.',
  },
  {
    id: 'inventario',
    label: 'Inventário',
    icon: ClipboardCheck,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Posição e controle',
    keywords: 'contagem fisica balanco ajuste de saldo',
    path: '/inventario',
    description: 'Contagem física e acerto de saldos. Abra uma contagem por local, digite as quantidades e gere os ajustes.',
  },
  {
    id: 'locais',
    label: 'Locais de Estoque',
    icon: Building2,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Locais',
    kind: 'subitem',
    keywords: 'almoxarifado depositos loja expedicao faccao',
    path: '/locais',
    resource: 'locais',
    description: 'Loja, expedição e facção onde as peças ficam guardadas.',
  },
  {
    id: 'compras',
    label: 'Compras',
    icon: ShoppingCart,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Pedidos e negociação',
    keywords: 'pedidos de compra suprimentos aquisicao insumos',
    path: '/compras',
    resource: 'compras',
    description: 'Pedidos de compra de insumos; ao receber, os insumos entram no estoque.',
  },
  {
    id: 'cotacoes-compra',
    label: 'Cotação de compra',
    icon: Scale,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Pedidos e negociação',
    keywords: 'cotacoes tomada de preco comparativo fornecedores',
    path: '/cotacoes-compra',
    resource: 'cotacoes_compra',
    description: 'Peça preço a vários fornecedores, compare lado a lado e gere o pedido de compra uma única vez. Nenhum preço é estimado: item sem resposta bloqueia a decisão.',
  },
  {
    id: 'compra-recebimentos',
    label: 'Recebimentos de compra',
    icon: Warehouse,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Recebimentos',
    kind: 'subitem',
    keywords: 'recebimento parcial total entrada de mercadoria',
    path: '/compra-recebimentos',
    resource: 'compra_recebimentos',
    description: 'Recebimentos parciais e totais dos pedidos de compra. O estoque sobe exatamente pelo recebido — nunca pelo pedido.',
  },
  {
    id: 'importar-nfe-compra',
    label: 'Importar NF-e de entrada',
    icon: FileUp,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Entrada por XML',
    kind: 'acao',
    keywords: 'xml nfe entrada nota fiscal fornecedor',
    path: '/importar-nfe-compra',
    minPerfil: 'gerente',
    description: 'Leia o XML da nota do fornecedor, confira o de-para dos SKUs e crie a compra já recebida. Validar não grava nada.',
  },
  {
    id: 'sugestao-compra',
    label: 'Sugestão de compra',
    icon: Calculator,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Reposição',
    keywords: 'reposicao necessidade de compra estoque minimo',
    path: '/sugestao-compra',
    minPerfil: 'gerente',
    description: 'O que comprar a partir do estoque atual, mínimo e máximo, do consumo, dos pedidos em aberto e das compras em trânsito. Nunca gera pedido sozinha.',
  },
  {
    id: 'depara-fornecedor',
    label: 'De-Para de produtos',
    icon: ArrowLeftRight,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Parâmetros do fornecedor',
    kind: 'subitem',
    keywords: 'codigos do fornecedor associacao sku xml',
    path: '/depara-fornecedor',
    resource: 'produto_fornecedor_skus',
    description: 'Traduz o código que o fornecedor usa na NF-e para o SKU interno do ERP. É só associação: não cria produto.',
  },

  // ==========================================================================
  // 5. PRODUÇÃO (ERP CORE)
  // ==========================================================================
  {
    id: 'planejamento-producao',
    label: 'Planejamento de Produção',
    icon: Factory,
    space: 'erp',
    area: 'Produção',
    group: 'Planejamento',
    subgroup: 'Plano e necessidade',
    keywords: 'pcp cronograma necessidade de insumos ordens planejadas',
    path: '/planejamento-producao',
    description: 'Ordens planejadas por semana, atrasos e os insumos que faltam para cumprir o plano.',
  },
  {
    id: 'ordens',
    label: 'Cadeias de Fabricação',
    icon: Cog,
    space: 'erp',
    area: 'Produção',
    group: 'Execução',
    subgroup: 'Ordens de produção',
    keywords: 'ordens de producao op apontamentos perdas refugo faccao',
    path: '/ordens',
    resource: 'ordens',
    description: 'Ordens de produção (OP): liberar, apontar produção e perdas, concluir, cancelar e reabrir.',
  },
  {
    id: 'fichas',
    label: 'Ficha Técnica / BOM',
    icon: ClipboardList,
    space: 'erp',
    area: 'Produção',
    group: 'Engenharia',
    subgroup: 'Ficha técnica e custo',
    keywords: 'fichas tecnicas bom estrutura de produto consumo insumos',
    path: '/fichas',
    resource: 'fichas',
    description: 'Mão de obra, custos indiretos e margem por produto.',
  },
  {
    id: 'custo',
    label: 'Custos',
    icon: Calculator,
    space: 'erp',
    area: 'Produção',
    group: 'Engenharia',
    subgroup: 'Ficha técnica e custo',
    keywords: 'custo de fabricacao formacao de preco margem perdas',
    path: '/custo',
    description: 'Insumos + mão de obra + indiretos → preço de custo e preço sugerido de venda.',
  },

  // ==========================================================================
  // 6. FINANCEIRO (ERP CORE)
  // ==========================================================================
  {
    id: 'financeiro',
    label: 'Financeiro',
    icon: Wallet,
    space: 'erp',
    area: 'Financeiro',
    group: 'Operação financeira',
    subgroup: 'Visão e títulos',
    keywords: 'visao financeira contas a pagar contas a receber dre fluxo de caixa conciliacao rentabilidade relatorios financeiros',
    path: '/financeiro',
    minPerfil: 'gerente',
    description: 'Fluxo de caixa, receitas, despesas, custos, contas a receber/pagar e aportes de investidores.',
  },
  {
    id: 'lancamentos',
    label: 'Lançamentos',
    icon: Coins,
    space: 'erp',
    area: 'Financeiro',
    group: 'Operação financeira',
    subgroup: 'Visão e títulos',
    keywords: 'titulos contas a pagar contas a receber livro caixa receitas despesas baixas',
    path: '/lancamentos',
    resource: 'lancamentos_financeiros',
    minPerfil: 'gerente',
    description: 'Livro-caixa: receitas, despesas, investimentos e estornos.',
  },
  {
    id: 'contas-financeiras',
    label: 'Contas',
    icon: Landmark,
    space: 'erp',
    area: 'Financeiro',
    group: 'Tesouraria',
    subgroup: 'Contas e transferências',
    keywords: 'contas financeiras bancarias caixa pix cartao boleto tesouraria',
    path: '/contas-financeiras',
    resource: 'contas_financeiras',
    minPerfil: 'gerente',
    description: 'Caixa, banco, Pix, cartão e boleto.',
  },
  {
    id: 'transferencias',
    label: 'Transferências',
    icon: ArrowRightLeft,
    space: 'erp',
    area: 'Financeiro',
    group: 'Tesouraria',
    subgroup: 'Contas e transferências',
    keywords: 'transferencias financeiras entre contas bancarias tesouraria',
    path: '/transferencias',
    resource: 'transferencias_financeiras',
    minPerfil: 'gerente',
    description: 'Mova dinheiro entre contas (Caixa → Banco Inter, Mercado Pago → Banco Inter) sem poluir receitas e despesas.',
  },
  {
    id: 'comissoes',
    label: 'Comissões',
    icon: BadgeDollarSign,
    space: 'erp',
    area: 'Financeiro',
    group: 'Comissões',
    subgroup: 'Apuração comercial',
    keywords: 'comissoes representantes apuracao repasse vendas',
    path: '/comissoes',
    minPerfil: 'gerente',
    description:
      'Apuração por representante, efetivada conforme o recebimento da venda, com estornos e livro por venda.',
  },
  {
    id: 'investidores',
    label: 'Investidores / Sócios',
    icon: PiggyBank,
    space: 'erp',
    area: 'Financeiro',
    group: 'Capital',
    subgroup: 'Investidores e aportes',
    keywords: 'socios investidores participacao distribuicao de lucros',
    path: '/investidores',
    resource: 'investidores',
    minPerfil: 'gerente',
    description: 'Quem aporta capital, participação e distribuição de lucros.',
  },
  {
    id: 'aportes',
    label: 'Aportes',
    icon: Wallet,
    space: 'erp',
    area: 'Financeiro',
    group: 'Capital',
    subgroup: 'Investidores e aportes',
    keywords: 'capital social aportes emprestimo de socio reinvestimento',
    path: '/aportes',
    resource: 'aportes',
    minPerfil: 'gerente',
    description: 'Capital inicial, aportes, reinvestimento e empréstimo de sócio.',
  },
  {
    id: 'categorias-financeiras',
    label: 'Categorias',
    icon: CircleDollarSign,
    space: 'erp',
    area: 'Financeiro',
    group: 'Parâmetros financeiros',
    subgroup: 'Classificação e recorrência',
    kind: 'subitem',
    keywords: 'categorias financeiras plano de contas classificacao dre',
    path: '/categorias-financeiras',
    resource: 'categorias_financeiras',
    minPerfil: 'gerente',
    description: 'Classificação dos lançamentos financeiros.',
  },
  {
    id: 'centros-custo',
    label: 'Centros de custo',
    icon: PieChart,
    space: 'erp',
    area: 'Financeiro',
    group: 'Parâmetros financeiros',
    subgroup: 'Classificação e recorrência',
    kind: 'subitem',
    keywords: 'rateio gerencial departamentos centros de custo',
    path: '/centros-custo',
    resource: 'centros_custo',
    minPerfil: 'gerente',
    description: 'Rateio gerencial por área: Loja, Produção/Facção, Administrativo, Marketing.',
  },
  {
    id: 'recorrencias-financeiras',
    label: 'Recolhimentos e recorrências',
    icon: Repeat,
    space: 'erp',
    area: 'Financeiro',
    group: 'Parâmetros financeiros',
    subgroup: 'Classificação e recorrência',
    kind: 'subitem',
    keywords: 'recorrencias financeiras despesas fixas assinaturas aluguel folha',
    path: '/recorrencias-financeiras',
    resource: 'recorrencias_financeiras',
    minPerfil: 'gerente',
    description: 'Despesas/receitas fixas: aluguel, energia, folha, facção, assinaturas — geradas automaticamente.',
  },

  // ==========================================================================
  // 7. FISCAL (ERP CORE)
  // ==========================================================================
  {
    id: 'documentos-fiscais',
    label: 'Documentos fiscais',
    icon: FileText,
    space: 'erp',
    area: 'Fiscal',
    group: 'Operação fiscal',
    subgroup: 'Emissão e numeração',
    keywords: 'nfe nfce danfe notas fiscais sefaz protocolo',
    path: '/documentos-fiscais',
    resource: 'documentos_fiscais',
    description: 'NF-e e NFC-e emitidas, rejeitadas ou pendentes, com chave, protocolo e DANFE.',
  },
  {
    id: 'inutilizacoes',
    label: 'Inutilizações',
    icon: FileMinus,
    space: 'erp',
    area: 'Fiscal',
    group: 'Operação fiscal',
    subgroup: 'Emissão e numeração',
    keywords: 'inutilizacao de numeracao faixa sefaz fiscal',
    path: '/inutilizacoes',
    resource: 'inutilizacoes_fiscais',
    minPerfil: 'gerente',
    description: 'Comunicação à SEFAZ das faixas de numeração que não serão usadas, com protocolo e status reais.',
  },
  {
    id: 'regras-fiscais',
    label: 'Regras fiscais',
    icon: Scale,
    space: 'erp',
    area: 'Fiscal',
    group: 'Parâmetros fiscais',
    subgroup: 'Regras e tributação',
    keywords: 'cfop cst csosn icms pis cofins ipi parametrizacao fiscal',
    path: '/regras-fiscais',
    resource: 'regras_fiscais',
    minPerfil: 'gerente',
    description: 'CFOP, CST/CSOSN e alíquotas por NCM, UF e operação — sem alíquota escrita no código.',
  },
  {
    id: 'ncm',
    label: 'NCM / Tributação',
    icon: Calculator,
    space: 'erp',
    area: 'Fiscal',
    group: 'Parâmetros fiscais',
    subgroup: 'Regras e tributação',
    keywords: 'ncm aliquotas impostos tributacao classificacao fiscal',
    path: '/ncm',
    resource: 'impostos_ncm',
    minPerfil: 'gerente',
    description: 'Alíquotas por NCM usadas pelo motor de impostos de cada venda: chave mais longa vence, chave vazia é a padrão.',
  },

  // ==========================================================================
  // 8. ADMINISTRAÇÃO (ERP CORE)
  // ==========================================================================
  {
    id: 'empresas',
    label: 'Empresas',
    icon: Building2,
    space: 'erp',
    area: 'Administração',
    group: 'Organização e acesso',
    subgroup: 'Empresas e usuários',
    keywords: 'multiempresa unidades filiais cnpj tenant concessoes',
    path: '/empresas',
    minPerfil: 'admin',
    description:
      'Empresas do grupo: cadastro, situação, acessos por usuário. A empresa ativa da sessão é escolhida no seletor do topo.',
  },
  {
    id: 'usuarios',
    label: 'Usuários',
    icon: Users,
    space: 'erp',
    area: 'Administração',
    group: 'Organização e acesso',
    subgroup: 'Empresas e usuários',
    keywords: 'permissoes perfis acessos seguranca sessoes convites rbac',
    path: '/usuarios',
    resource: 'usuarios',
    description: 'Quem acessa o sistema, perfis de permissão e senhas.',
    adminOnly: true,
  },
  {
    id: 'auditoria',
    label: 'Auditoria',
    icon: History,
    space: 'erp',
    area: 'Administração',
    group: 'Governança',
    subgroup: 'Rastreabilidade e segurança',
    keywords: 'logs trilha de auditoria seguranca historico alteracoes',
    path: '/auditoria',
    resource: 'auditoria',
    description: 'Histórico de inclusões, alterações, exclusões e logins.',
    adminOnly: true,
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    icon: Webhook,
    space: 'erp',
    area: 'Administração',
    group: 'Automações',
    subgroup: 'Eventos e integrações outbound',
    keywords: 'automacoes webhooks eventos notificacoes integracoes outbound',
    path: '/webhooks',
    description: 'Integrações: avise sistemas externos sobre eventos de usuários.',
    adminOnly: true,
  },

  // ==========================================================================
  // 9. COMMERCE — FORA DO ERP CORE
  // ==========================================================================
  {
    id: 'conector-mercadolivre',
    label: 'Mercado Livre',
    icon: ShoppingBag,
    space: 'commerce',
    area: 'Commerce',
    group: 'Canais',
    subgroup: 'Conectores reais',
    keywords: 'marketplace meli conector integracao canal',
    path: '/conectores/mercado-livre',
    minPerfil: 'gerente',
    connector: 'MERCADOLIVRE',
    description: 'Conexão OAuth2 oficial com o Mercado Livre: importação de pedidos e sincronização de vendas.',
  },
  {
    id: 'conector-mercadopago',
    label: 'Mercado Pago',
    icon: CreditCard,
    space: 'commerce',
    area: 'Commerce',
    group: 'Canais',
    subgroup: 'Conectores reais',
    keywords: 'pagamentos checkout conector integracao canal',
    path: '/conectores/mercado-pago',
    minPerfil: 'gerente',
    connector: 'MERCADOPAGO',
    description: 'Checkout e faturamento via credenciais provisionadas no ambiente seguro do servidor.',
  },
  {
    id: 'conector-nuvemshop',
    label: 'Nuvemshop',
    icon: Cloud,
    space: 'commerce',
    area: 'Commerce',
    group: 'Canais',
    subgroup: 'Conectores reais',
    keywords: 'loja virtual ecommerce conector integracao canal',
    path: '/conectores/nuvemshop',
    minPerfil: 'gerente',
    connector: 'NUVEMSHOP',
    description:
      'Plataforma-ponte do Hub: conexão OAuth2 oficial com a Nuvemshop para triangulação de vendas (catálogo e pedidos, inclusive os da vitrine do TikTok).',
  },
  {
    id: 'conector-instagram',
    label: 'Instagram Shopping',
    icon: Instagram,
    space: 'commerce',
    area: 'Commerce',
    group: 'Canais',
    subgroup: 'Conectores reais',
    keywords: 'meta sacolinha social commerce conector integracao canal',
    path: '/conectores/instagram',
    minPerfil: 'gerente',
    connector: 'INSTAGRAM',
    description:
      'Conexão direta com a Graph API da Meta: catálogo da sacolinha, webhook assinado de interações em tempo real e ingestão de pedido no canal INSTAGRAM_SHOPPING.',
  },
  {
    id: 'commerce-produtos',
    label: 'Produtos',
    icon: Package,
    space: 'commerce',
    area: 'Commerce',
    group: 'Multicanal',
    subgroup: 'Roadmap',
    keywords: 'catalogo multicanal omnichannel publicacao planejado',
    path: '/commerce/produtos',
    description: 'Catálogo omnichannel, variantes, SKUs e publicação por canal.',
    planned: ['Catálogo unificado para todos os canais.', 'Variações, estoque disponível e regras de publicação.', 'Fila de publicação com histórico por canal.'],
  },
  {
    id: 'commerce-pedidos',
    label: 'Pedidos',
    icon: ShoppingCart,
    space: 'commerce',
    area: 'Commerce',
    group: 'Multicanal',
    subgroup: 'Roadmap',
    keywords: 'pedidos multicanal inbox omnichannel planejado',
    path: '/commerce/pedidos',
    description: 'Orquestração de pedidos, status de pagamento e expedição.',
    planned: ['Inbox único de pedidos de todos os canais.', 'Reserva de estoque e atualização de status.', 'Roteamento para separação e expedição.'],
  },
  {
    id: 'commerce-trends',
    label: 'Trends',
    icon: TrendingUp,
    space: 'commerce',
    area: 'Commerce',
    group: 'Multicanal',
    subgroup: 'Roadmap',
    keywords: 'tendencias demanda multicanal planejado',
    path: '/commerce/trends',
    description: 'Tendências de vendas, produtos e performance por canal.',
    planned: ['Curvas de demanda por SKU e canal.', 'Comparativos de receita e conversão.', 'Alertas de oportunidade baseados no histórico.'],
  },
  {
    id: 'commerce-delivery',
    label: '📦 Delivery',
    icon: Truck,
    space: 'commerce',
    area: 'Commerce',
    group: 'Multicanal',
    subgroup: 'Roadmap',
    keywords: 'entregas multicanal kits fulfillment planejado',
    path: '/commerce/delivery',
    description: 'Fila de Envios de Kits de Moda e acompanhamento de entrega.',
    planned: ['Fila de kits prontos para expedição.', 'Etiquetas, transportadora e rastreio.', 'Atualização de entrega para o pedido de origem.'],
  },

  // ==========================================================================
  // 10. CREATORS — FORA DO ERP CORE
  // ==========================================================================
  {
    id: 'creators',
    label: 'Creators',
    icon: Users,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Roadmap',
    keywords: 'influenciadores creators parcerias planejado',
    path: '/creators',
    description: 'Base de creators, perfis, nichos e métricas de audiência.',
    planned: ['Cadastro e enriquecimento de perfis.', 'Métricas de alcance, afinidade e performance.', 'Histórico de parcerias e entregas.'],
  },
  {
    id: 'creator-matches',
    label: 'Matches',
    icon: Handshake,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Roadmap',
    keywords: 'afinidades matching creators planejado',
    path: '/matches',
    description: 'Matching entre creators e campanhas com inteligência de afinidade.',
    planned: ['Recomendação de creators por objetivo e público.', 'Score de afinidade por campanha.', 'Aprovação e histórico dos matches.'],
  },
  {
    id: 'outreach-ai',
    label: 'Outreach AI',
    icon: Bot,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Roadmap',
    keywords: 'contato assistido ia briefing creators planejado',
    path: '/outreach-ai',
    description: 'Abordagens assistidas por IA para iniciar conversas com creators.',
    planned: ['Briefing contextual por creator.', 'Mensagens assistidas com aprovação humana.', 'Histórico de contatos e respostas.'],
  },
  {
    id: 'campanhas',
    label: 'Campanhas',
    icon: Megaphone,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Roadmap',
    keywords: 'campanhas marketing influenciadores roi planejado',
    path: '/campanhas',
    description: 'Planejamento e acompanhamento de campanhas com creators.',
    planned: ['Briefing, cronograma e orçamento.', 'Entregáveis e aprovações por campanha.', 'Resultados, conversões e ROI.'],
  },

  // ==========================================================================
  // 11. UTILIDADES GLOBAIS
  // ==========================================================================
  {
    id: 'config',
    label: 'Configurações',
    icon: Settings,
    space: 'utilidades',
    area: 'Utilidades Globais',
    group: 'Conta e suporte',
    subgroup: 'Preferências e ajuda',
    keywords: 'minha conta preferencias tema senha mfa sessoes backup',
    path: '/config',
    description: 'Sua conta, senha, preferências e informações do sistema.',
  },
  {
    id: 'ajuda',
    label: 'Ajuda',
    icon: HelpCircle,
    space: 'utilidades',
    area: 'Utilidades Globais',
    group: 'Conta e suporte',
    subgroup: 'Preferências e ajuda',
    keywords: 'suporte documentacao guia rapido manual atalhos',
    path: '/ajuda',
    description: 'Guia rápido: como usar cada módulo do BROBOND ERP.',
  },
];

export type NavSectionId = ModuleSpace;

/** Metadados visuais e estruturais de cada uma das 11 Áreas principais. */
export const AREA_META: Record<
  ModuleArea,
  {
    icon: LucideIcon;
    section: NavSectionId;
    description: string;
  }
> = {
  'Meu Negócio': {
    icon: LayoutDashboard,
    section: 'erp',
    description: 'Porta de entrada gerencial, indicadores executivos e central de relatórios.',
  },
  Cadastros: {
    icon: Package,
    section: 'erp',
    description: 'Produtos, classificações, grades, medidas, insumos e pessoas.',
  },
  Vendas: {
    icon: Briefcase,
    section: 'erp',
    description: 'Jornada comercial, propostas, políticas, PDV, expedição, entrega e pós-venda.',
  },
  'Estoque & Suprimentos': {
    icon: Warehouse,
    section: 'erp',
    description: 'Posição de estoque, movimentações, inventário, locais e ciclo de compras.',
  },
  Produção: {
    icon: Factory,
    section: 'erp',
    description: 'Planejamento fabril, ordens de produção (OP), fichas técnicas e custos.',
  },
  Financeiro: {
    icon: Wallet,
    section: 'erp',
    description: 'Visão financeira, lançamentos, tesouraria, comissões, capital e parâmetros.',
  },
  Fiscal: {
    icon: Scale,
    section: 'erp',
    description: 'Documentos fiscais, inutilizações, regras fiscais e NCM / tributação.',
  },
  Administração: {
    icon: Building2,
    section: 'erp',
    description: 'Empresas, usuários, governança, auditoria e automações do sistema.',
  },
  Commerce: {
    icon: ShoppingBag,
    section: 'commerce',
    description: 'Canais integrados e operação multicanal fora do ERP Core.',
  },
  Creators: {
    icon: Users,
    section: 'creators',
    description: 'Relacionamento com creators, matches, outreach e campanhas fora do ERP Core.',
  },
  'Utilidades Globais': {
    icon: Settings,
    section: 'utilidades',
    description: 'Minha conta, preferências, segurança pessoal e guia de ajuda.',
  },
};

/** Ícone, área pai e seção de cada grupo funcional da Árvore Master. */
export const GROUP_META: Record<
  ModuleGroup,
  {
    area: ModuleArea;
    icon: LucideIcon;
    /** seção macro da Sidebar */
    section: NavSectionId;
  }
> = {
  'Visão do negócio': { area: 'Meu Negócio', icon: LayoutDashboard, section: 'erp' },
  Análises: { area: 'Meu Negócio', icon: BarChart3, section: 'erp' },
  Produtos: { area: 'Cadastros', icon: Shirt, section: 'erp' },
  Materiais: { area: 'Cadastros', icon: Scissors, section: 'erp' },
  Pessoas: { area: 'Cadastros', icon: Users, section: 'erp' },
  Comercial: { area: 'Vendas', icon: Receipt, section: 'erp' },
  Balcão: { area: 'Vendas', icon: CreditCard, section: 'erp' },
  'Atendimento e entrega': { area: 'Vendas', icon: Truck, section: 'erp' },
  'Pós-venda': { area: 'Vendas', icon: Repeat, section: 'erp' },
  Estoque: { area: 'Estoque & Suprimentos', icon: Warehouse, section: 'erp' },
  Compras: { area: 'Estoque & Suprimentos', icon: ShoppingCart, section: 'erp' },
  Planejamento: { area: 'Produção', icon: Factory, section: 'erp' },
  Execução: { area: 'Produção', icon: Cog, section: 'erp' },
  Engenharia: { area: 'Produção', icon: ClipboardList, section: 'erp' },
  'Operação financeira': { area: 'Financeiro', icon: Wallet, section: 'erp' },
  Tesouraria: { area: 'Financeiro', icon: Landmark, section: 'erp' },
  Comissões: { area: 'Financeiro', icon: BadgeDollarSign, section: 'erp' },
  Capital: { area: 'Financeiro', icon: PiggyBank, section: 'erp' },
  'Parâmetros financeiros': { area: 'Financeiro', icon: PieChart, section: 'erp' },
  'Operação fiscal': { area: 'Fiscal', icon: FileText, section: 'erp' },
  'Parâmetros fiscais': { area: 'Fiscal', icon: Scale, section: 'erp' },
  'Organização e acesso': { area: 'Administração', icon: Building2, section: 'erp' },
  Governança: { area: 'Administração', icon: History, section: 'erp' },
  Automações: { area: 'Administração', icon: Webhook, section: 'erp' },
  Canais: { area: 'Commerce', icon: Plug, section: 'commerce' },
  Multicanal: { area: 'Commerce', icon: ShoppingBag, section: 'commerce' },
  'Parcerias e campanhas': { area: 'Creators', icon: Megaphone, section: 'creators' },
  'Conta e suporte': { area: 'Utilidades Globais', icon: Settings, section: 'utilidades' },
};

/** Módulos que usam página própria (não CRUD genérico nem PlannedModule). */
export const PAGES_ESPECIAIS = [
  'estoque',
  'medidas',
  'inventario',
  'custo',
  'planejamento-producao',
  'relatorios',
  'financeiro',
  'ajuda',
  'pdv',
  'expedicao',
  'cotacoes-compra',
  'importar-nfe-compra',
  'sugestao-compra',
  'devolucoes',
  'envios',
  'usuarios',
  'webhooks',
  'ncm',
  'inutilizacoes',
  'comissoes',
  'empresas',
  'colecoes',
] as const;

/** Módulos cuja listagem abre diretamente a página de detalhe. */
export const DETALHE_DIRETO = new Set(['ordens', 'fichas']);

/**
 * Recursos cujo cadastro/edição vive em PÁGINA PRÓPRIA (nunca em modal, drawer
 * ou qualquer formulário sobreposto à lista):
 * - /clientes/novo e /clientes/:id/editar (listagem em /clientes)
 * - /produtos/novo e /produtos/:id/editar (listagem em /produtos)
 * - /vendas/novo e /vendas/:id/editar (listagem em /vendas e detalhe em /vendas/:id)
 * - /categorias/novo e /categorias/:id/editar (listagem em /categorias)
 * - /cores/novo e /cores/:id/editar (listagem em /cores)
 *
 * É a lista canônica do padrão LISTA → PÁGINA do BROBOND ERP: quem entra aqui
 * navega (rota filha do módulo) em vez de abrir a superfície do formulário na
 * própria listagem. Demais cadastros simples devem migrar para cá — não para
 * novas superfícies de modal/drawer.
 */
export const FORM_DIRETO = new Set(['clientes', 'produtos', 'vendas', 'categorias', 'cores']);

export type NavSection = {
  id: NavSectionId;
  /** Cabeçalho da seção na Sidebar (null = sem rótulo). */
  label: string | null;
  /** Áreas desta seção, na ordem declarada em `MODULE_AREAS`. */
  areas: ModuleArea[];
  /** Grupos desta seção, na ordem declarada em `MODULE_GROUPS`. */
  groups: ModuleGroup[];
};

const SECTION_LABEL: Record<NavSectionId, string | null> = {
  erp: 'ERP CORE',
  commerce: 'Commerce',
  creators: 'Creators',
  utilidades: 'Utilidades Globais',
};

/**
 * Seções da Sidebar **derivadas** de `MODULE_AREAS` + `MODULE_GROUPS` + `AREA_META` + `GROUP_META`.
 * Nenhuma lista paralela é mantida na Sidebar.
 */
export const NAV_SECTIONS: NavSection[] = (['erp', 'commerce', 'creators', 'utilidades'] as const).map((id) => ({
  id,
  label: SECTION_LABEL[id],
  areas: MODULE_AREAS.filter((a) => AREA_META[a].section === id),
  groups: MODULE_GROUPS.filter((g) => GROUP_META[g].section === id),
}));

export type NavSubgroupNode = {
  subgroup: string;
  modules: Module[];
};

export type NavGroupNode = {
  group: ModuleGroup;
  area: ModuleArea;
  icon: LucideIcon;
  subgroups: NavSubgroupNode[];
  modules: Module[];
};

export type NavAreaNode = {
  area: ModuleArea;
  section: NavSectionId;
  icon: LucideIcon;
  description: string;
  groups: NavGroupNode[];
  modules: Module[];
};

export type NavSectionNode = {
  id: NavSectionId;
  label: string | null;
  areas: NavAreaNode[];
};

/**
 * Constrói a árvore hierárquica (Seção → Área → Grupo → Subgrupo → Módulo)
 * diretamente a partir da lista de módulos (ex.: `visibleModules(user)`).
 * Seções, áreas, grupos e subgrupos sem módulos visíveis são omitidos.
 */
export function buildNavigationTree(modulos: Module[] = MODULES): NavSectionNode[] {
  return NAV_SECTIONS.map((sec) => {
    const areas: NavAreaNode[] = sec.areas
      .map((area) => {
        const areaModules = modulos.filter((m) => m.area === area);
        if (!areaModules.length) return null;
        const areaGroups = MODULE_GROUPS.filter((g) => GROUP_META[g].area === area);
        const groups: NavGroupNode[] = areaGroups
          .map((group) => {
            const groupModules = areaModules.filter((m) => m.group === group);
            if (!groupModules.length) return null;
            const subgroupNames: string[] = [];
            for (const m of groupModules) {
              if (!subgroupNames.includes(m.subgroup)) subgroupNames.push(m.subgroup);
            }
            const subgroups: NavSubgroupNode[] = subgroupNames.map((subgroup) => ({
              subgroup,
              modules: groupModules.filter((m) => m.subgroup === subgroup),
            }));
            return {
              group,
              area,
              icon: GROUP_META[group].icon,
              subgroups,
              modules: groupModules,
            };
          })
          .filter((g): g is NavGroupNode => g !== null);

        if (!groups.length) return null;
        return {
          area,
          section: sec.id,
          icon: AREA_META[area].icon,
          description: AREA_META[area].description,
          groups,
          modules: areaModules,
        };
      })
      .filter((a): a is NavAreaNode => a !== null);

    return {
      id: sec.id,
      label: sec.label,
      areas,
    };
  }).filter((sec) => sec.areas.length > 0);
}

export function findModuleByResource(resource: string): Module | undefined {
  return MODULES.find((m) => m.resource === resource);
}

/**
 * Módulo dono de uma rota — regra única para o título da aba, o breadcrumb e a
 * abertura da árvore na Sidebar. Rotas filhas (ex.: `/produtos/12`) pertencem ao
 * módulo pai. Recebe a lista já filtrada (ex.: `visibleModules`) quando o
 * chamador precisa respeitar RBAC.
 */
export function moduleOfPath(pathname: string, modulos: Module[] = MODULES): Module | undefined {
  return (
    modulos.find((m) => m.path === pathname) ||
    modulos.filter((m) => m.path !== '/').find((m) => pathname.startsWith(m.path + '/'))
  );
}

/**
 * Módulos visíveis para o usuário logado, respeitando perfil mínimo e permissões
 * herdadas (mesma regra usada pela Sidebar, CommandPalette e ModuleAccess).
 */
export function visibleModules(
  user?: {
    perfil?: string;
    perm_politicas?: string;
    perm_catalogos?: string;
    perm_compartilhar?: string;
    perm_metricas?: string;
  } | null
): Module[] {
  const isAdmin = user?.perfil === 'admin';
  // Espelho da descoberta (nunca da autorização): a mesma semântica de
  // `podeComercial` no servidor — admin sempre; permitir/negar vencem;
  // herdar segue gerente. O servidor continua barrando a API.
  const comercial = (valor?: string): boolean => {
    if (isAdmin) return true;
    if (valor === 'permitir') return true;
    if (valor === 'negar') return false;
    return user?.perfil === 'gerente';
  };
  return MODULES.filter((m) => {
    if (m.adminOnly && !isAdmin) return false;
    if (m.minPerfil === 'admin' && !isAdmin) return false;
    if (m.id === 'politicas-comerciais') return comercial(user?.perm_politicas);
    if (m.id === 'catalogos') {
      return comercial(user?.perm_catalogos) || comercial(user?.perm_compartilhar) || comercial(user?.perm_metricas);
    }
    if (m.minPerfil === 'gerente' && !isAdmin && user?.perfil !== 'gerente') return false;
    return true;
  });
}
