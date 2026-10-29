import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRight,
  ArrowRightLeft,
  BarChart3,
  Calculator,
  ClipboardCheck,
  ClipboardList,
  Cog,
  Clock,
  Factory,
  Flag,
  Handshake,
  HelpCircle,
  History,
  Mail,
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
  PackageOpen,
  Plug,
  ShoppingBag,
  Bot,
  Megaphone,
  Rocket,
  TrendingUp,
  Truck,
  Scale,
  FileText,
  FileUp,
  FileMinus,
  BadgeDollarSign,
  GitBranch,
  Target,
  Network,
  UsersRound,
  Percent,
  IdCard,
  MapPinned,
  ShieldCheck,
  CalendarClock,
  BookOpen,
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
  // 9. Commerce — Fora do Core (COMMERCE OS: 4 grupos reais no lugar do roadmap)
  'Canais',
  'Catálogo',
  'Loja e ofertas',
  'Operação',
  'Inteligência',
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

  {
    id: 'painel-comercial',
    label: 'Painel comercial',
    icon: BarChart3,
    space: 'erp',
    area: 'Meu Negócio',
    group: 'Análises',
    subgroup: 'Desempenho comercial',
    keywords: 'indicadores desempenho meta atingimento comissao ticket medio território equipe',
    path: '/comercial/painel',
    description: 'Indicadores derivados por representante, equipe e território, com meta e atingimento.',
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
    label: 'Grades',
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
    keywords: 'materia prima aviamentos tecido botao ziper etiqueta codigo categoria',
    path: '/insumos',
    resource: 'insumos',
    description: 'Matéria-prima: tecido, botão, zíper, etiqueta e afins.',
  },
  {
    id: 'categorias-insumos',
    label: 'Categorias de Insumos',
    icon: Layers,
    space: 'erp',
    area: 'Cadastros',
    group: 'Materiais',
    subgroup: 'Insumos',
    kind: 'subitem',
    keywords: 'categorias de insumo classificacao materia prima aviamentos embalagem agrupamento',
    path: '/categorias-insumos',
    resource: 'categorias_insumos',
    description: 'Agrupamento da matéria-prima: Matéria-prima, Aviamentos, Identidade de marca, Embalagem...',
  },
  {
    id: 'unidades-medida',
    label: 'Unidades de medida',
    icon: Ruler,
    space: 'erp',
    area: 'Cadastros',
    group: 'Materiais',
    subgroup: 'Insumos',
    kind: 'subitem',
    keywords: 'unidade medida rolo metro quilo caixa grandeza casas decimais conversao',
    path: '/unidades-medida',
    resource: 'unidades_medida',
    minPerfil: 'gerente',
    description: 'Catálogo de unidades da empresa com grandeza. A grandeza impede conversão sem sentido (metro não vira quilo).',
  },
  {
    id: 'conversoes-unidade',
    label: 'Conversões de unidade',
    icon: Scale,
    space: 'erp',
    area: 'Cadastros',
    group: 'Materiais',
    subgroup: 'Insumos',
    kind: 'subitem',
    keywords: 'conversao fator rolo metro caixa unidade de compra unidade de uso',
    path: '/conversoes-unidade',
    resource: 'unidade_conversoes',
    minPerfil: 'gerente',
    description: 'Regras explícitas de conversão (1 rolo = N metros). O ERP converte somente o que está declarado aqui — nunca estima fator.',
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

  // ==========================================================================
  // ESTRUTURA COMERCIAL (MASTER MA-02 · MA-03 · MA-06 · MA-07)
  //
  // Território, equipe, hierarquia, carteira e atribuição são ESTRUTURA
  // ORGANIZACIONAL — não colunas do cadastro de representantes. Cada um tem
  // cadastro próprio, com vigência e histórico, e todos passam pelo padrão
  // LISTA → PÁGINA (formulário em rota própria, nunca em modal/drawer).
  // ==========================================================================
  {
    id: 'territorios',
    label: 'Territórios',
    icon: MapPinned,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Estrutura comercial',
    keywords: 'territorio regiao uf cidade zona canal key account hierarquia comercial',
    path: '/territorios',
    resource: 'territorios',
    description: 'Hierarquia comercial (Brasil → Estado → Região → Cidade → Zona) ou recortes não geográficos.',
  },
  {
    id: 'equipes_comerciais',
    label: 'Equipes comerciais',
    icon: UsersRound,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Estrutura comercial',
    keywords: 'equipe time lider gerente supervisor representantes',
    path: '/equipes-comerciais',
    resource: 'equipes_comerciais',
    description: 'Equipes comerciais com líder, território e composição por vigência.',
  },
  {
    id: 'equipe_membros',
    label: 'Membros de equipe',
    icon: UsersRound,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Estrutura comercial',
    keywords: 'membros composicao equipe participacao vigencia',
    path: '/equipe-membros',
    resource: 'equipe_membros',
    description: 'Composição da equipe com papel, participação e período (histórico preservado).',
  },
  {
    id: 'representante_hierarquia',
    label: 'Hierarquia comercial',
    icon: Network,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Estrutura comercial',
    keywords: 'hierarquia supervisor diretor gerente coordenador ciclo',
    path: '/hierarquia-comercial',
    resource: 'representante_hierarquia',
    description: 'Diretor → Gerente → Supervisor → Representante, com vigência e sem ciclo.',
  },
  {
    id: 'representante_cliente',
    label: 'Carteira de clientes',
    icon: IdCard,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Carteira',
    keywords: 'carteira clientes representante vigencia troca historico compartilhada',
    path: '/carteira-clientes',
    resource: 'representante_cliente',
    description: 'Quem atende cada cliente, de quando até quando — trocar não apaga o histórico.',
  },
  {
    id: 'venda_atribuicao',
    label: 'Atribuição comercial',
    icon: GitBranch,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Atribuição',
    keywords: 'atribuicao contribuicao participacao venda representante equipe territorio',
    path: '/atribuicao-comercial',
    resource: 'venda_atribuicao',
    description: 'Participação de cada representante na venda (contribuição ≠ comissão).',
  },

  // ==========================================================================
  // CRM 3.0 — funil de vendas (leads, oportunidades, atividades, motivos)
  // ==========================================================================
  {
    id: 'crm-leads',
    label: 'Leads',
    icon: Mail,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Funil',
    keywords: 'lead contato potencial funil qualificacao origem conversao',
    path: '/crm/leads',
    resource: 'crm_leads',
    minPerfil: 'gerente',
    description: 'Topo do funil: contato potencial ainda não convertido em cliente, com origem, status, valor estimado e responsável.',
  },
  {
    id: 'crm-oportunidades',
    label: 'Oportunidades',
    icon: Target,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Funil',
    keywords: 'oportunidade negociacao pipeline estagio previsao fechamento proposta',
    path: '/crm/oportunidades',
    resource: 'crm_oportunidades',
    minPerfil: 'gerente',
    description: 'Negociação em pipeline, com estágio, valor, probabilidade e previsão de fechamento. Perdida exige motivo.',
  },
  {
    id: 'crm-atividades',
    label: 'Atividades',
    icon: Clock,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Funil',
    keywords: 'atividade chamada visita email reuniao tarefa follow-up interacao',
    path: '/crm/atividades',
    resource: 'crm_atividades',
    minPerfil: 'gerente',
    description: 'Registro de interações com leads, oportunidades e clientes — chamada, visita, e-mail, reunião, tarefa e follow-up.',
  },
  {
    id: 'crm-motivos-perda',
    label: 'Motivos de perda',
    icon: Flag,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Funil',
    keywords: 'motivo perda oportunidade cancelada concorrente preço prazo',
    path: '/crm/motivos-perda',
    resource: 'crm_motivos_perda',
    minPerfil: 'gerente',
    description: 'Catálogo de motivos pelos quais uma oportunidade foi perdida. Oportunidade perdida exige motivo.',
  },
  // --------------------------------------------------------------------------
  // CRM 3.0 — evolução (migration 0051): painel, agenda, funil e origem/campanha
  // --------------------------------------------------------------------------
  {
    id: 'crm-painel',
    label: 'Painel do CRM',
    icon: TrendingUp,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Inteligência',
    keywords: 'crm painel dashboard leads conversao pipeline forecast previsao atividades atrasos representante',
    path: '/crm/painel',
    minPerfil: 'gerente',
    description: 'Leads, conversão, pipeline, forecast ponderado, conversão por origem, atividades atrasadas e desempenho por responsável.',
  },
  {
    id: 'crm-agenda',
    label: 'Agenda do CRM',
    icon: Clock,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Inteligência',
    keywords: 'agenda lembretes hoje atrasadas proximas atividades vencidas follow-up',
    path: '/crm/agenda',
    minPerfil: 'gerente',
    description: 'Compromissos de hoje, atrasados e próximos — com lembrete, prioridade e responsável.',
  },
  {
    id: 'crm-estagio-historico',
    label: 'Histórico de estágio',
    icon: History,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Inteligência',
    keywords: 'historico estagio mudanca trilha funil auditoria oportunidade',
    path: '/crm/estagio-historico',
    resource: 'crm_estagio_historico',
    minPerfil: 'gerente',
    description: 'Trilha do funil: toda mudança de estágio, com usuário, data e observação. Gravada pelo servidor — não é editável.',
  },
  {
    id: 'crm-funis',
    label: 'Funis',
    icon: GitBranch,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Configuração',
    keywords: 'funil configuracao etapas ordem probabilidade pipeline padrao',
    path: '/crm/funis',
    resource: 'crm_funis',
    minPerfil: 'gerente',
    description: 'Funis comerciais da empresa. O funil padrão é único por empresa (garantido pelo banco).',
  },
  {
    id: 'crm-etapas',
    label: 'Etapas do funil',
    icon: Layers,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Configuração',
    keywords: 'etapa estagio ordem probabilidade funil configuracao',
    path: '/crm/etapas',
    resource: 'crm_etapas',
    minPerfil: 'gerente',
    description: 'Ordem, nome e probabilidade de cada etapa do funil. A chave é o vocabulário aceito pelo banco.',
  },
  {
    id: 'crm-origens',
    label: 'Origens',
    icon: Share2,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Configuração',
    keywords: 'origem canal indicacao site feira outbound campanha aquisicao',
    path: '/crm/origens',
    resource: 'crm_origens',
    minPerfil: 'gerente',
    description: 'Catálogo controlado de origens de lead — base da conversão por origem no painel.',
  },
  {
    id: 'crm-campanhas',
    label: 'Campanhas',
    icon: Megaphone,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'CRM — Configuração',
    keywords: 'campanha utm investimento midia aquisicao custo por lead',
    path: '/crm/campanhas',
    resource: 'crm_campanhas',
    minPerfil: 'gerente',
    description: 'Campanhas de aquisição vinculadas a uma origem, com investimento e período.',
  },
  {
    id: 'metas',
    label: 'Metas',
    icon: Target,
    space: 'erp',
    area: 'Vendas',
    group: 'Comercial',
    subgroup: 'Metas e desempenho',
    keywords: 'metas objetivo faturamento quantidade margem atingimento realizado periodo',
    path: '/metas',
    resource: 'metas',
    description: 'Metas por representante, equipe, território ou empresa — o realizado é sempre calculado.',
  },
  // ==========================================================================
  // 3. VENDAS (ERP CORE)
  // ==========================================================================
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
    id: 'contagem-ciclica-abc',
    label: 'Contagem Cíclica ABC',
    icon: Repeat,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Contagem cíclica',
    kind: 'subitem',
    keywords: 'contagem ciclica abc rotatividade giro classificacao classe a b c inspecao inventario fisica',
    path: '/contagem-ciclica-abc',
    resource: 'inventarios',
    minPerfil: 'gerente',
    description: 'Contagem rotativa por classe ABC: classifica os itens pelo giro real do período e roda a contagem continuamente.',
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
    id: 'transferencias-estoque',
    label: 'Transferências',
    icon: ArrowRightLeft,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Movimentação',
    keywords: 'transferencia local origem destino transito aprovacao recebimento documento',
    path: '/estoque/transferencias',
    resource: 'estoque_transferencias',
    minPerfil: 'gerente',
    description: 'Documento de transferência entre locais: solicitar, aprovar, expedir e receber — com rastro de cada evento.',
  },
  {
    id: 'reservas-estoque',
    label: 'Reservas de estoque',
    icon: PackageOpen,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Estoque',
    subgroup: 'Movimentação',
    keywords: 'reserva empenho bloqueio disponivel comprometido',
    path: '/estoque/reservas',
    resource: 'estoque_reservas',
    minPerfil: 'gerente',
    description: 'Reservas, empenhos e bloqueios que reduzem o disponível sem movimentar o saldo físico.',
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
  {
    id: 'homologacao-fornecedores',
    label: 'Homologação de fornecedores',
    icon: ShieldCheck,
    space: 'erp',
    area: 'Estoque & Suprimentos',
    group: 'Compras',
    subgroup: 'Fornecedores',
    keywords: 'homologacao fornecedor documento certidao avaliacao desempenho score bloqueio suspensao',
    path: '/compras/fornecedores',
    resource: 'fornecedores',
    minPerfil: 'gerente',
    description: 'Quem pode receber pedido de compra: estado de homologação, documentos com validade, trilha de decisões e desempenho calculado das compras reais.',
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
    id: 'producao-recursos',
    label: 'Recursos de produção',
    icon: Factory,
    space: 'erp',
    area: 'Produção',
    group: 'Planejamento',
    subgroup: 'Capacidade',
    keywords: 'recurso produtivo capacidade diaria costura corte estamparia faccao eficiencia',
    path: '/producao/recursos',
    resource: 'producao_recursos',
    description: 'Onde a peça é feita: capacidade diária informada, eficiência e responsável. A carga e a ocupação são calculadas das ordens.',
  },
  {
    id: 'producao-capacidade',
    label: 'Capacidade e MRP',
    icon: BarChart3,
    space: 'erp',
    area: 'Produção',
    group: 'Planejamento',
    subgroup: 'Capacidade',
    keywords: 'capacidade carga ocupacao gargalo mrp necessidade insumos planejamento',
    path: '/producao/capacidade',
    minPerfil: 'gerente',
    description: 'Ocupação por recurso, gargalo do período e MRP: o que falta produzir e comprar, cruzando vendas em aberto, estoque, OPs, ficha técnica e compras em aberto.',
  },
  {
    id: 'ordens',
    label: 'Ordens de Produção',
    icon: Cog,
    space: 'erp',
    area: 'Produção',
    group: 'Execução',
    subgroup: 'Ordens de produção',
    keywords: 'ordens de producao op cadeias de fabricacao apontamentos perdas refugo faccao',
    path: '/ordens',
    resource: 'ordens',
    description: 'Ordens de produção (OP): liberar, apontar produção e perdas, concluir, cancelar e reabrir.',
  },
  {
    id: 'terceiros-operacionais',
    label: 'Terceiros e facções',
    icon: Handshake,
    space: 'erp',
    area: 'Produção',
    group: 'Execução',
    subgroup: 'Terceirização e custódia',
    keywords: 'terceiros facção faccionamento custódia propriedade material envio retorno',
    path: '/terceiros-operacionais',
    resource: 'terceiros_operacionais',
    minPerfil: 'gerente',
    description: 'Cadastro em página de facções/terceiros; as trilhas de envio/retorno ficam na OP e usam movimentações de insumo e apontamentos canônicos.',
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
    id: 'plano-contas',
    label: 'Plano de contas',
    icon: BookOpen,
    space: 'erp',
    area: 'Financeiro',
    group: 'Operação financeira',
    subgroup: 'Contabilidade',
    keywords: 'plano de contas contabil codigo natureza ativo passivo receita despesa',
    path: '/financeiro/plano-contas',
    resource: 'plano_contas',
    minPerfil: 'gerente',
    description: 'Contas contábeis da empresa (código, natureza, sintética/analítica). Estrutura para a contabilidade — não é apuração de imposto.',
  },
  {
    id: 'balancete',
    label: 'Balancete',
    icon: BarChart3,
    space: 'erp',
    area: 'Financeiro',
    group: 'Operação financeira',
    subgroup: 'Contabilidade',
    keywords: 'balancete debito credito competencia classificacao pendentes contabil',
    path: '/financeiro/balancete',
    minPerfil: 'gerente',
    description: 'Débito e crédito por conta, competência e documento de origem — somando o MESMO livro-caixa, com o que está sem classificação à vista.',
  },
  {
    id: 'importacoes-contabeis',
    label: 'Importações contábeis',
    icon: FileUp,
    space: 'erp',
    area: 'Financeiro',
    group: 'Operação financeira',
    subgroup: 'Contabilidade',
    kind: 'subitem',
    keywords: 'importacao contabil partida dobrada lote hash idempotencia balancete contador',
    path: '/financeiro/importacoes-contabeis',
    resource: 'fin_importacoes_contabeis',
    minPerfil: 'gerente',
    description: 'Lotes de lançamentos contábeis importados do contador. As partidas entram no MESMO livro do financeiro, com a origem marcada.',
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
    id: 'planos_comissao',
    label: 'Planos de comissão',
    icon: BadgeDollarSign,
    space: 'erp',
    area: 'Financeiro',
    group: 'Comissões',
    subgroup: 'Motores de comissão',
    keywords: 'plano comissao politica vigencia base calculo efetivacao',
    path: '/planos-comissao',
    resource: 'planos_comissao',
    minPerfil: 'gerente',
    description: 'Política de comissão: vigência, base de cálculo e momento de efetivação.',
  },
  {
    id: 'regras_comissao',
    label: 'Regras de comissão',
    icon: Percent,
    space: 'erp',
    area: 'Financeiro',
    group: 'Comissões',
    subgroup: 'Motores de comissão',
    keywords: 'regra comissao escopo produto categoria colecao cliente territorio equipe prioridade',
    path: '/regras-comissao',
    resource: 'regras_comissao',
    minPerfil: 'gerente',
    description: 'Regra por escopo com prioridade e vigência; a mais específica vence.',
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

  {
    id: 'fiscal-obrigacoes',
    label: 'Obrigações fiscais',
    icon: ClipboardCheck,
    space: 'erp',
    area: 'Fiscal',
    group: 'Parâmetros fiscais',
    subgroup: 'Cadastro e prazos',
    keywords: 'sped obrigacao acessoria dctf reinf esocial defis das vencimento competencia',
    path: '/fiscal/obrigacoes',
    resource: 'fiscal_obrigacoes',
    minPerfil: 'gerente',
    description: 'Regra de cada obrigação acessória da empresa: periodicidade, dia de vencimento e responsável. O vencimento de cada competência é calculado.',
  },
  {
    id: 'fiscal-calendario',
    label: 'Calendário fiscal',
    icon: CalendarClock,
    space: 'erp',
    area: 'Fiscal',
    group: 'Parâmetros fiscais',
    subgroup: 'Cadastro e prazos',
    keywords: 'calendario fiscal pendencias atrasadas protocolo arquivo entrega sped',
    path: '/fiscal/calendario',
    minPerfil: 'gerente',
    description: 'O que vence quando, o que está atrasado e a prova de cada entrega (protocolo e arquivo). O ERP controla prazo — não calcula imposto.',
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
    group: 'Catálogo',
    subgroup: 'Gestão',
    keywords: 'catalogo multicanal omnichannel produtos preco canal vitrine',
    path: '/commerce/produtos',
    resource: 'commerce_produtos',
    description: 'Catálogo omnichannel com preço por canal, disponibilidade canônica e publicação em cada canal.',
  },
  {
    id: 'commerce-publicacoes',
    label: 'Publicações',
    icon: Rocket,
    space: 'commerce',
    area: 'Commerce',
    group: 'Catálogo',
    subgroup: 'Gestão',
    keywords: 'publicacao fila canal mercado livre nuvemshop woo instagram',
    path: '/commerce/publicacoes',
    minPerfil: 'gerente',
    resource: 'commerce_publicacoes',
    description: 'Fila de publicação por canal com estados, versões idempotentes e erros reais das APIs externas.',
  },
  {
    id: 'commerce-loja',
    label: 'Loja própria',
    icon: Store,
    space: 'commerce',
    area: 'Commerce',
    group: 'Loja e ofertas',
    subgroup: 'Vitrine e ofertas',
    keywords: 'loja vitrine checkout frete configuracao storefront brobond',
    path: '/commerce/loja',
    minPerfil: 'gerente',
    resource: 'commerce_configuracoes',
    description: 'Configuração da vitrine /loja: identidade, frete (FreightProvider), expiração do carrinho e responsável pelo checkout.',
  },
  {
    id: 'commerce-promocoes',
    label: 'Promoções',
    icon: Percent,
    space: 'commerce',
    area: 'Commerce',
    group: 'Loja e ofertas',
    subgroup: 'Vitrine e ofertas',
    keywords: 'promocao desconto campanha vitrine percentual',
    path: '/commerce/promocoes',
    minPerfil: 'gerente',
    resource: 'commerce_promocoes',
    description: 'Promoções automáticas por período e pedido mínimo no carrinho — sem acúmulo com cupom (maior desconto vence).',
  },
  {
    id: 'commerce-cupons',
    label: 'Cupons',
    icon: Receipt,
    space: 'commerce',
    area: 'Commerce',
    group: 'Loja e ofertas',
    subgroup: 'Vitrine e ofertas',
    keywords: 'cupom codigo desconto limite de uso vitrine',
    path: '/commerce/cupons',
    minPerfil: 'gerente',
    resource: 'commerce_cupons',
    description: 'Cupons por código com validade, mínimo e limite de uso atômico — validados no servidor, no checkout.',
  },
  {
    id: 'commerce-pedidos',
    label: 'Pedidos',
    icon: ShoppingCart,
    space: 'commerce',
    area: 'Commerce',
    group: 'Operação',
    subgroup: 'Execução',
    keywords: 'pedidos multicanal inbox omnichannel pagamento conversao',
    path: '/commerce/pedidos',
    resource: 'commerce_pedidos',
    description: 'Inbox único da loja própria e dos canais: pagamento, conversão para venda, itens, rastreio e linha do tempo.',
  },
  {
    id: 'commerce-delivery',
    label: '📦 Delivery',
    icon: Truck,
    space: 'commerce',
    area: 'Commerce',
    group: 'Operação',
    subgroup: 'Execução',
    keywords: 'entregas envios expedicao rastreio fulfillment kits',
    path: '/commerce/delivery',
    resource: 'commerce_rastreio',
    description: 'Fila de envios com etapa de expedição, rastreio e SLA real de pós-faturamento.',
  },
  {
    id: 'commerce-fila',
    label: 'Fila & sync',
    icon: Repeat,
    space: 'commerce',
    area: 'Commerce',
    group: 'Operação',
    subgroup: 'Execução',
    keywords: 'outbox fila sincronizacao retry observabilidade eventos webhook',
    path: '/commerce/fila',
    minPerfil: 'gerente',
    resource: 'commerce_outbox',
    description: 'Outbox de conversões/publicações com backoff, erros de publicação recentes e webhooks de pagamento.',
  },
  {
    id: 'commerce-trends',
    label: 'Trends',
    icon: TrendingUp,
    space: 'commerce',
    area: 'Commerce',
    group: 'Inteligência',
    subgroup: 'Métricas',
    keywords: 'tendencias demanda curva receita crescimento sku analytics',
    path: '/commerce/trends',
    minPerfil: 'gerente',
    description: 'Série diária real de pedidos e receita, tendência por mínimos quadrados e crescimento de SKUs por período.',
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
    subgroup: 'Gestão de parcerias',
    keywords: 'influenciadores creators parcerias',
    path: '/creators',
    description: 'Gerencie criadores, parceiros e oportunidades comerciais.',
  },
  {
    id: 'creator-matches',
    label: 'Matches',
    icon: Handshake,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Gestão de parcerias',
    keywords: 'afinidades matching creators',
    path: '/matches',
    description: 'Encontre oportunidades entre creators e campanhas.',
  },
  {
    id: 'outreach-ai',
    label: 'Outreach AI',
    icon: Bot,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Gestão de parcerias',
    keywords: 'contato assistido ia briefing creators',
    path: '/outreach-ai',
    description: 'Gerencie contatos, oportunidades e interações com creators.',
  },
  {
    id: 'campanhas',
    label: 'Campanhas',
    icon: Megaphone,
    space: 'creators',
    area: 'Creators',
    group: 'Parcerias e campanhas',
    subgroup: 'Gestão de parcerias',
    keywords: 'campanhas marketing influenciadores roi',
    path: '/campanhas',
    description: 'Planeje, acompanhe e gerencie campanhas com creators.',
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
  // BROBOND COMMERCE OS: o grupo "Multicanal" (roadmap/planned) foi
  // substituído pelos 4 grupos operacionais do sistema real.
  'Catálogo': { area: 'Commerce', icon: Package, section: 'commerce' },
  'Loja e ofertas': { area: 'Commerce', icon: Percent, section: 'commerce' },
  'Operação': { area: 'Commerce', icon: Truck, section: 'commerce' },
  'Inteligência': { area: 'Commerce', icon: TrendingUp, section: 'commerce' },
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
  'painel-comercial',
  'contagem-ciclica-abc',
  // BROBOND COMMERCE OS — páginas próprias (ZERO MODAL; detalhe/novo/edição
  // sempre em rota dedicada, nunca sobreposição sobre a lista).
  'commerce-produtos',
  'commerce-publicacoes',
  'commerce-pedidos',
  'commerce-delivery',
  'commerce-trends',
  'commerce-loja',
  'commerce-promocoes',
  'commerce-cupons',
  'commerce-fila',
  // Creators: páginas dedicadas com capacidades verificadas no servidor.
  'creators',
  'creator-matches',
  'outreach-ai',
  'campanhas',
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
 * - /colecoes/novo e /colecoes/:id/editar (listagem em /colecoes)
 * - /tamanhos/novo e /tamanhos/:id/editar (listagem em /tamanhos)
 * - /grades/novo e /grades/:id/editar (listagem em /grades)
 * - /insumos/novo e /insumos/:id/editar (listagem em /insumos)
 * - /fornecedores/novo e /fornecedores/:id/editar (listagem em /fornecedores)
 * - /representantes/novo e /representantes/:id/editar (listagem em /representantes)
 * - /categorias-insumos/novo e /categorias-insumos/:id/editar (listagem em /categorias-insumos)
 *
 * É a lista canônica do padrão LISTA → PÁGINA do BROBOND ERP: quem entra aqui
 * navega (rota filha do módulo) em vez de abrir a superfície do formulário na
 * própria listagem. Demais cadastros simples devem migrar para cá — não para
 * novas superfícies de modal/drawer.
 */
export const FORM_DIRETO = new Set([
  'territorios',
  'equipes_comerciais',
  'equipe_membros',
  'representante_hierarquia',
  'representante_cliente',
  'metas',
  'planos_comissao',
  'regras_comissao',
  'venda_atribuicao',
  'clientes',
  'produtos',
  'vendas',
  'categorias',
  'cores',
  'colecoes',
  'tamanhos',
  'grades',
  'insumos',
  'fornecedores',
  'representantes',
  'categorias_insumos',
  'terceiros_operacionais',
]);

/**
 * Módulos cuja LISTAGEM é uma página dedicada (não o CRUD genérico).
 *
 * Esta lista é a fonte única usada por:
 *   • `pages/ModulePage.tsx` — decide qual página montar;
 *   • `App.tsx` — decide para quais módulos gerar as rotas genéricas
 *     `/:modulo/novo` e `/:modulo/:id/editar` (padrão LISTA → PÁGINA).
 *
 * Consequência: TODO recurso que usa o CRUD genérico tem, obrigatoriamente,
 * rota própria de cadastro e de edição. Não existe "formulário na listagem".
 */
export const MODULOS_PAGINA_PROPRIA = new Set<string>([
  'usuarios',
  'webhooks',
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
  'ncm',
  'comissoes',
  'empresas',
  'inutilizacoes',
  'colecoes',
  'insumos',
  'fornecedores',
  'representantes',
  'territorios',
  'metas',
  'painel-comercial',
  'equipes_comerciais',
  'equipe_membros',
  'representante_hierarquia',
  'representante_cliente',
  'venda_atribuicao',
  'planos_comissao',
  'regras_comissao',
  'crm-painel',
  'crm-agenda',
  'transferencias-estoque',
  'homologacao-fornecedores',
  'producao-capacidade',
  'fiscal-calendario',
  'balancete',
  'contagem-ciclica-abc',
]);

/**
 * O módulo usa o CRUD genérico (lista + páginas de novo/editar)?
 *
 * Regra do ERP 3.0: quem usa o CRUD genérico NUNCA abre superfície sobreposta —
 * o cadastro vive em `/recurso/novo` e a edição em `/recurso/:id/editar`.
 */
export function usaCrudGenerico(m: Module): boolean {
  return (
    !!m.resource &&
    m.space === 'erp' &&
    !m.connector &&
    !MODULOS_PAGINA_PROPRIA.has(m.id) &&
    !DETALHE_DIRETO.has(m.id)
  );
}

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
