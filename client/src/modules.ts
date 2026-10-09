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

// Fonte única de verdade para o menu lateral E as rotas.
export const MODULES: Module[] = [
  {
    id: 'dashboard',
    label: 'Meu Negócio',
    icon: LayoutDashboard,
    group: null,
    path: '/',
    description: 'Visão geral do negócio: estoque, produção, compras e vendas.',
  },

  // 📦 Engenharia & Catálogo
  { id: 'produtos', label: 'Produtos', icon: Shirt, group: 'Cadastros', path: '/produtos', resource: 'produtos', description: 'Catálogo de peças acabadas: fotos, SKU, categoria, cor, coleção, custo e preço.' },
  { id: 'categorias', label: 'Categorias', icon: Layers, group: 'Cadastros', path: '/categorias', resource: 'categorias', description: 'Tipos de peça: camisa, camiseta, calça, bermuda...' },
  { id: 'cores', label: 'Cores', icon: Palette, group: 'Cadastros', path: '/cores', resource: 'cores', description: 'Cores padronizadas com amostra visual.' },
  { id: 'insumos', label: 'Insumos', icon: Scissors, group: 'Cadastros', path: '/insumos', resource: 'insumos', description: 'Matéria-prima: tecido, botão, zíper, etiqueta e afins.' },
  { id: 'tamanhos', label: 'Tamanhos', icon: Ruler, group: 'Cadastros', path: '/tamanhos', resource: 'tamanhos', description: 'Dicionário de tamanhos: PP, P, M, G, GG, 36, 38, 40...' },
  { id: 'grades', label: 'Grade', icon: LayoutGrid, group: 'Cadastros', path: '/grades', resource: 'grades', description: 'Conjuntos nomeados de tamanhos (Camiseta PP-GG, Calça 36-48, Calçado 34-44...) vinculados a produtos e categorias.' },
  { id: 'medidas', label: 'Tabela de Medidas', icon: Ruler, group: 'Cadastros', path: '/medidas', description: 'Medidas por tamanho de cada grade, com painel de completude, modelos prontos, cópia entre grades, instruções para o cliente e impressão.' },
  { id: 'colecoes', label: 'Coleções', icon: Tags, group: 'Cadastros', path: '/colecoes', resource: 'colecoes', description: 'Coleções e temporadas.' },
  { id: 'fichas', label: 'Ficha Técnica / BOM', icon: ClipboardList, group: 'Produção', path: '/fichas', resource: 'fichas', description: 'Mão de obra, custos indiretos e margem por produto.' },

  // 🏭 Operações & Fábrica
  { id: 'ordens', label: 'Cadeias de Fabricação', icon: Cog, group: 'Produção', path: '/ordens', resource: 'ordens', description: 'Ordens de produção (OP): liberar, apontar produção e perdas, concluir, cancelar e reabrir.' },
  {
    id: 'planejamento-producao',
    label: 'Planejamento de Produção',
    icon: Factory,
    group: 'Produção',
    path: '/planejamento-producao',
    description: 'Ordens planejadas por semana, atrasos e os insumos que faltam para cumprir o plano.',
  },
  {
    id: 'custo',
    label: 'Custos',
    icon: Calculator,
    group: 'Produção',
    path: '/custo',
    description: 'Insumos + mão de obra + indiretos → preço de custo e preço sugerido de venda.',
  },
  { id: 'estoque', label: 'Estoque Físico', icon: Warehouse, group: 'Estoque', path: '/estoque', description: 'Grade de saldo por produto × tamanho × local, com estoque mínimo.' },
  { id: 'movimentacoes', label: 'Movimentações', icon: ArrowLeftRight, group: 'Estoque', path: '/movimentacoes', resource: 'movimentacoes', description: 'Entradas, saídas, ajustes e transferências — cada lançamento atualiza o saldo.' },
  { id: 'locais', label: 'Locais de Estoque', icon: Building2, group: 'Estoque', path: '/locais', resource: 'locais', description: 'Loja, expedição e facção onde as peças ficam guardadas.' },
  {
    id: 'inventario',
    label: 'Inventário',
    icon: ClipboardCheck,
    group: 'Estoque',
    path: '/inventario',
    description: 'Contagem física e acerto de saldos. Abra uma contagem por local, digite as quantidades e gere os ajustes.',
  },

  // 🔌 Hub Omnichannel — conectores multicanal (Fase 2)
  {
    id: 'conector-mercadolivre',
    label: 'Mercado Livre',
    icon: ShoppingBag,
    group: 'Integrações',
    path: '/conectores/mercado-livre',
    minPerfil: 'gerente',
    connector: 'MERCADOLIVRE',
    description: 'Conexão OAuth2 oficial com o Mercado Livre: importação de pedidos e sincronização de vendas.',
  },
  {
    id: 'conector-mercadopago',
    label: 'Mercado Pago',
    icon: CreditCard,
    group: 'Integrações',
    path: '/conectores/mercado-pago',
    minPerfil: 'gerente',
    connector: 'MERCADOPAGO',
    description: 'Checkout e faturamento via credenciais provisionadas no ambiente seguro do servidor.',
  },
  {
    id: 'conector-nuvemshop',
    label: 'Nuvemshop',
    icon: Cloud,
    group: 'Integrações',
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
    group: 'Integrações',
    path: '/conectores/instagram',
    minPerfil: 'gerente',
    connector: 'INSTAGRAM',
    description:
      'Conexão direta com a Graph API da Meta: catálogo da sacolinha, webhook assinado de interações em tempo real e ingestão de pedido no canal INSTAGRAM_SHOPPING.',
  },

  // 🛒 Gestão de Commerce — esqueleto das operações digitais e fulfillment
  // Esses módulos são páginas de prontidão: a rota e o contrato visual ficam
  // disponíveis desde já, sem inventar chamadas de API antes do domínio estar
  // implementado.
  { id: 'commerce-produtos', label: 'Produtos', icon: Package, group: 'Gestão de Commerce', path: '/commerce/produtos', description: 'Catálogo omnichannel, variantes, SKUs e publicação por canal.', planned: ['Catálogo unificado para todos os canais.', 'Variações, estoque disponível e regras de publicação.', 'Fila de publicação com histórico por canal.'] },
  { id: 'commerce-pedidos', label: 'Pedidos', icon: ShoppingCart, group: 'Gestão de Commerce', path: '/commerce/pedidos', description: 'Orquestração de pedidos, status de pagamento e expedição.', planned: ['Inbox único de pedidos de todos os canais.', 'Reserva de estoque e atualização de status.', 'Roteamento para separação e expedição.'] },
  { id: 'commerce-trends', label: 'Trends', icon: TrendingUp, group: 'Gestão de Commerce', path: '/commerce/trends', description: 'Tendências de vendas, produtos e performance por canal.', planned: ['Curvas de demanda por SKU e canal.', 'Comparativos de receita e conversão.', 'Alertas de oportunidade baseados no histórico.'] },
  { id: 'commerce-delivery', label: '📦 Delivery', icon: Truck, group: 'Gestão de Commerce', path: '/commerce/delivery', description: 'Fila de Envios de Kits de Moda e acompanhamento de entrega.', planned: ['Fila de kits prontos para expedição.', 'Etiquetas, transportadora e rastreio.', 'Atualização de entrega para o pedido de origem.'] },

  // 👥 Ecossistema Creators — relacionamento, matching e campanhas
  { id: 'creators', label: 'Creators', icon: Users, group: 'Ecossistema Creators', path: '/creators', description: 'Base de creators, perfis, nichos e métricas de audiência.', planned: ['Cadastro e enriquecimento de perfis.', 'Métricas de alcance, afinidade e performance.', 'Histórico de parcerias e entregas.'] },
  { id: 'creator-matches', label: 'Matches', icon: Handshake, group: 'Ecossistema Creators', path: '/matches', description: 'Matching entre creators e campanhas com inteligência de afinidade.', planned: ['Recomendação de creators por objetivo e público.', 'Score de afinidade por campanha.', 'Aprovação e histórico dos matches.'] },
  { id: 'outreach-ai', label: 'Outreach AI', icon: Bot, group: 'Ecossistema Creators', path: '/outreach-ai', description: 'Abordagens assistidas por IA para iniciar conversas com creators.', planned: ['Briefing contextual por creator.', 'Mensagens assistidas com aprovação humana.', 'Histórico de contatos e respostas.'] },
  { id: 'campanhas', label: 'Campanhas', icon: Megaphone, group: 'Ecossistema Creators', path: '/campanhas', description: 'Planejamento e acompanhamento de campanhas com creators.', planned: ['Briefing, cronograma e orçamento.', 'Entregáveis e aprovações por campanha.', 'Resultados, conversões e ROI.'] },

  // Vendas
  { id: 'vendas', label: 'Vendas', icon: Receipt, group: 'Vendas', path: '/vendas', resource: 'vendas', description: 'Pedidos de venda com itens; ao faturar, as peças saem do estoque e a comissão é calculada.' },
  { id: 'politicas-comerciais', label: 'Políticas comerciais', icon: Tags, group: 'Vendas', path: '/politicas-comerciais', resource: 'politicas_comerciais', minPerfil: 'gerente', description: 'Preços, mínimos, múltiplos e regras sazonais por canal, coleção, catálogo ou cliente.' },
  { id: 'clientes', label: 'Clientes', icon: Store, group: 'Vendas', path: '/clientes', resource: 'clientes', description: 'Lojas e atacadistas que compram de você.' },
  { id: 'representantes', label: 'Representantes', icon: Handshake, group: 'Vendas', path: '/representantes', resource: 'representantes', description: 'Vendedores externos, regiões e comissões.' },
  { id: 'catalogos', label: 'Catálogos públicos', icon: Share2, group: 'Vendas', path: '/catalogos', resource: 'catalogos', description: 'Compartilhe produtos com preço por link — sem login para o cliente.' },
  { id: 'regras-fiscais', label: 'Regras fiscais', icon: Scale, group: 'Vendas', path: '/regras-fiscais', resource: 'regras_fiscais', minPerfil: 'gerente', description: 'CFOP, CST/CSOSN e alíquotas por NCM, UF e operação — sem alíquota escrita no código.' },
  { id: 'documentos-fiscais', label: 'Documentos fiscais', icon: FileText, group: 'Vendas', path: '/documentos-fiscais', resource: 'documentos_fiscais', description: 'NF-e e NFC-e emitidas, rejeitadas ou pendentes, com chave, protocolo e DANFE.' },
  { id: 'listas-preco', label: 'Listas de preço', icon: Tags, group: 'Vendas', path: '/listas-preco', resource: 'listas_preco', minPerfil: 'gerente', description: 'Tabelas de preço por produto e variação, com vigência, prioridade e histórico. O preço usado na venda é gravado no item e nunca recalculado.' },
  { id: 'propostas', label: 'Propostas comerciais', icon: FileText, group: 'Vendas', path: '/propostas', resource: 'propostas', description: 'Rascunho → enviada → aprovada → convertida em pedido. A conversão é idempotente: uma proposta nunca vira dois pedidos.' },
  { id: 'pdv-caixas', label: 'Caixas do PDV', icon: CreditCard, group: 'Vendas', path: '/pdv-caixas', resource: 'pdv_caixas', minPerfil: 'gerente', description: 'Abertura e fechamento de caixa, suprimentos, sangrias e a diferença entre o esperado e o contado.' },
  { id: 'pdv', label: 'PDV — venda balcão', icon: Receipt, group: 'Vendas', path: '/pdv', description: 'Venda de balcão por código de barras, SKU, desconto e pagamento. O servidor recalcula preço, desconto, frete, impostos e total — a tela mostra apenas prévia.' },

  // 🛒 Suprimentos
  { id: 'compras', label: 'Compras', icon: ShoppingCart, group: 'Compras', path: '/compras', resource: 'compras', description: 'Pedidos de compra de insumos; ao receber, os insumos entram no estoque.' },
  { id: 'fornecedores', label: 'Fornecedores', icon: Factory, group: 'Compras', path: '/fornecedores', resource: 'fornecedores', description: 'Empresas de quem você compra insumos.' },
  { id: 'cotacoes-compra', label: 'Cotação de compra', icon: Scale, group: 'Compras', path: '/cotacoes-compra', resource: 'cotacoes_compra', description: 'Peça preço a vários fornecedores, compare lado a lado e gere o pedido de compra uma única vez. Nenhum preço é estimado: item sem resposta bloqueia a decisão.' },
  { id: 'compra-recebimentos', label: 'Recebimentos de compra', icon: Warehouse, group: 'Compras', path: '/compra-recebimentos', resource: 'compra_recebimentos', description: 'Recebimentos parciais e totais dos pedidos de compra. O estoque sobe exatamente pelo recebido — nunca pelo pedido.' },
  { id: 'importar-nfe-compra', label: 'Importar NF-e de entrada', icon: FileUp, group: 'Compras', path: '/importar-nfe-compra', minPerfil: 'gerente', description: 'Leia o XML da nota do fornecedor, confira o de-para dos SKUs e crie a compra já recebida. Validar não grava nada.' },
  { id: 'depara-fornecedor', label: 'De-Para de produtos', icon: ArrowLeftRight, group: 'Compras', path: '/depara-fornecedor', resource: 'produto_fornecedor_skus', description: 'Traduz o código que o fornecedor usa na NF-e para o SKU interno do ERP. É só associação: não cria produto.' },
  { id: 'sugestao-compra', label: 'Sugestão de compra', icon: Calculator, group: 'Compras', path: '/sugestao-compra', minPerfil: 'gerente', description: 'O que comprar a partir do estoque atual, mínimo e máximo, do consumo, dos pedidos em aberto e das compras em trânsito. Nunca gera pedido sozinha.' },

  // 🚚 Logística & Expedição — P1
  { id: 'expedicao', label: 'Expedição', icon: ClipboardList, group: 'Logística & Expedição', path: '/expedicao', description: 'Separação → conferência → embalagem → expedição. Conferência por código de barras, com divergência registrada e auditada.' },
  { id: 'divergencias', label: 'Divergências de conferência', icon: ClipboardCheck, group: 'Logística & Expedição', path: '/divergencias', resource: 'divergencias_conferencia', description: 'Itens faltando ou sobrando na conferência, com o esperado, o lido e a resolução aplicada.' },
  { id: 'envios', label: 'Logística e envios', icon: Truck, group: 'Logística & Expedição', path: '/envios', resource: 'envios', minPerfil: 'gerente', description: 'Cotação, geração de envio, etiqueta e rastreio por transportadora. Credenciais só em configuração segura — nunca no código.' },
  { id: 'devolucoes', label: 'Devoluções e reversa', icon: Repeat, group: 'Logística & Expedição', path: '/devolucoes', resource: 'devolucoes', description: 'Solicitação → autorização → rastreio → recebimento → conferência. Só item em bom estado volta ao estoque. As ações disponíveis vêm do servidor.' },

  // 💰 Inteligência Financeira
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
  { id: 'transferencias', label: 'Transferências', icon: ArrowRightLeft, group: 'Financeiro', path: '/transferencias', resource: 'transferencias_financeiras', minPerfil: 'gerente', description: 'Mova dinheiro entre contas (Caixa → Banco Inter, Mercado Pago → Banco Inter) sem poluir receitas e despesas.' },
  { id: 'centros-custo', label: 'Centros de custo', icon: PieChart, group: 'Financeiro', path: '/centros-custo', resource: 'centros_custo', minPerfil: 'gerente', description: 'Rateio gerencial por área: Loja, Produção/Facção, Administrativo, Marketing.' },
  { id: 'investidores', label: 'Investidores / Sócios', icon: PiggyBank, group: 'Financeiro', path: '/investidores', resource: 'investidores', minPerfil: 'gerente', description: 'Quem aporta capital, participação e distribuição de lucros.' },
  { id: 'aportes', label: 'Aportes', icon: Wallet, group: 'Financeiro', path: '/aportes', resource: 'aportes', minPerfil: 'gerente', description: 'Capital inicial, aportes, reinvestimento e empréstimo de sócio.' },
  { id: 'recorrencias-financeiras', label: 'Recolhimentos e recorrências', icon: Repeat, group: 'Financeiro', path: '/recorrencias-financeiras', resource: 'recorrencias_financeiras', minPerfil: 'gerente', description: 'Despesas/receitas fixas: aluguel, energia, folha, facção, assinaturas — geradas automaticamente.' },

  // 📊 Relatórios & Auditoria
  {
    id: 'relatorios',
    label: 'Relatórios',
    icon: BarChart3,
    group: 'Relatórios',
    path: '/relatorios',
    description: 'Posição de estoque, movimentações, produção, vendas, curva ABC e insumos mínimos.',
  },
  { id: 'usuarios', label: 'Usuários', icon: Users, group: 'Configurações', path: '/usuarios', resource: 'usuarios', description: 'Quem acessa o sistema, perfis de permissão e senhas.', adminOnly: true },
  { id: 'auditoria', label: 'Auditoria', icon: History, group: 'Configurações', path: '/auditoria', resource: 'auditoria', description: 'Histórico de inclusões, alterações, exclusões e logins.', adminOnly: true },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook, group: 'Integrações', path: '/webhooks', description: 'Integrações: avise sistemas externos sobre eventos de usuários.', adminOnly: true },
  { id: 'config', label: 'Configurações', icon: Settings, group: 'Configurações', path: '/config', description: 'Sua conta, senha, preferências e informações do sistema.' },
  { id: 'ajuda', label: 'Ajuda', icon: HelpCircle, group: 'Configurações', path: '/ajuda', description: 'Guia rápido: como usar cada módulo do BROBOND ERP.' },
];

/**
 * As 9 grandes categorias colapsáveis da Sidebar (Fase 3 — padrão visual
 * "Brobond AI ERP"). A ordem aqui é a ordem dos accordions na navegação.
 */
export const MODULE_GROUPS = [
  // ERP CORE — áreas de negócio, na ordem da navegação.
  'Cadastros',
  'Vendas',
  'Compras',
  'Estoque',
  'Produção',
  'Logística & Expedição',
  'Financeiro',
  'Relatórios',
  // COMMERCE / INTEGRAÇÕES — seção separada, recolhida por padrão.
  'Integrações',
  'Gestão de Commerce',
  'Ecossistema Creators',
  // Administração do sistema.
  'Configurações',
] as const;

export type ModuleGroup = (typeof MODULE_GROUPS)[number];

/** Ícone e seção de cada área de negócio (cabeçalho da Sidebar). */
export const GROUP_META: Record<ModuleGroup, { icon: LucideIcon; /** seção da Sidebar */ section: 'erp' | 'commerce' | 'sistema' }> = {
  Cadastros: { icon: Package, section: 'erp' },
  Vendas: { icon: Briefcase, section: 'erp' },
  Compras: { icon: ShoppingCart, section: 'erp' },
  Estoque: { icon: Warehouse, section: 'erp' },
  Produção: { icon: Factory, section: 'erp' },
  'Logística & Expedição': { icon: Truck, section: 'erp' },
  Financeiro: { icon: Wallet, section: 'erp' },
  Relatórios: { icon: BarChart3, section: 'erp' },
  Integrações: { icon: Plug, section: 'commerce' },
  'Gestão de Commerce': { icon: ShoppingBag, section: 'commerce' },
  'Ecossistema Creators': { icon: Users, section: 'commerce' },
  Configurações: { icon: Settings, section: 'sistema' },
};

/** Módulos que usam página própria (não CRUD genérico nem PlannedModule). */
export const PAGES_ESPECIAIS = ['estoque', 'inventario', 'custo', 'relatorios', 'financeiro', 'pdv', 'expedicao', 'cotacoes-compra', 'sugestao-compra', 'devolucoes', 'envios'] as const;

/** Módulos cuja listagem abre diretamente a página de detalhe. */
export const DETALHE_DIRETO = new Set(['ordens', 'fichas']);

export function findModuleByResource(resource: string): Module | undefined {
  return MODULES.find((m) => m.resource === resource);
}

/**
 * Módulos visíveis para o usuário logado, respeitando perfil mínimo e permissões
 * herdadas (mesma regra usada pela Sidebar e reaproveitada pelo CommandPalette,
 * para nunca sugerir um destino que o usuário não pode acessar).
 */
export function visibleModules(user?: { perfil?: string; perm_politicas?: string } | null): Module[] {
  const isAdmin = user?.perfil === 'admin';
  return MODULES.filter((m) => {
    if (m.adminOnly && !isAdmin) return false;
    if (m.minPerfil === 'admin' && !isAdmin) return false;
    if (m.minPerfil === 'gerente' && !isAdmin && user?.perfil !== 'gerente') {
      if (!(m.id === 'politicas-comerciais' && user?.perm_politicas === 'permitir')) return false;
    }
    return true;
  });
}
