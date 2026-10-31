// ============================================================================
// DIAGNÓSTICO DE DEPENDÊNCIAS ANTES DA EXCLUSÃO
//
// Problema de produção: ao excluir um registro referenciado, o ERP respondia
// apenas "Este registro está em uso em outro módulo e não pode ser excluído".
// O usuário não sabia QUAL módulo, QUANTOS registros, QUAIS ids, nem por que a
// exclusão era proibida.
//
// Esta camada transforma a violação de FK (23503) — e as travas de HISTÓRICO
// que o ERP aplica mesmo quando o banco cascatearia — em um diagnóstico
// legível, reutilizável por qualquer recurso (vendas, compras, clientes,
// produtos, categorias, fornecedores, locais...).
//
// Princípios (não negociáveis):
//   • A FK continua sendo a proteção final: nada aqui apaga, cascateia ou
//     força exclusão. O diagnóstico só LÊ.
//   • As relações vêm de METADADOS CONFIÁVEIS:
//       - PostgreSQL: catálogo (pg_constraint) — nenhuma relação inventada,
//         nenhuma relação esquecida;
//       - MemStore: o mesmo mapa declarativo abaixo (resources.ts + RELACOES_FK).
//   • Nomes de tabela/coluna nunca vêm do input do usuário; valores entram
//     sempre como parâmetro ($1, $2...) e o recorte de empresa é obrigatório.
//   • Multiempresa: toda contagem é limitada à empresa do registro-alvo.
//   • O diagnóstico NÃO grava nada (nem auditoria): a tentativa bloqueada não
//     altera o estado do sistema.
//
// Classificação de cada vínculo (o que o usuário vê):
//   composicao  — faz parte do próprio registro (itens do pedido). Some junto.
//   historico   — trilha protegida (estoque, caixa, financeiro, expedição,
//                 fiscal, comissões, devoluções). NUNCA é apagada.
//   operacional — elo de operação (proposta convertida, pedido multicanal...).
//   trilha      — auditoria: permanece registrada e não impede a exclusão.
//   anexo       — arquivos do registro (removidos junto quando permitido).
//
// Um vínculo BLOQUEIA quando:
//   • a FK é NO ACTION/RESTRICT (o banco recusa o DELETE), ou
//   • a política do ERP é "proteger" (histórico que não pode ser apagado nem
//     desligado — mesmo que a FK fosse CASCADE/SET NULL).
// ============================================================================
import { HttpError } from './errors';
import { getResource, RESOURCES, type Resource } from './resources';
import { labelOf, type Row } from './store';

/** Tipo/natureza do vínculo, usado pela UI para explicar o papel do registro. */
export type TipoVinculo = 'composicao' | 'historico' | 'operacional' | 'trilha' | 'anexo';

/** O que o ERP faz por POLÍTICA com este vínculo (independente da FK). */
export type PoliticaVinculo = 'seguir' | 'proteger' | 'desvincular';

/** Ação referencial efetiva (ON DELETE) ou vínculo lógico (sem FK). */
export type AcaoReferencial = 'NO_ACTION' | 'RESTRICT' | 'CASCADE' | 'SET_NULL' | 'SET_DEFAULT' | 'LOGICO';

/** Uma tabela dependente com suas colunas de referência já agregadas. */
export type RelacaoDependente = {
  tabela: string;
  /** Colunas do dependente que apontam para o alvo (ex.: ['empresa_id', 'venda_id']). */
  colunas: string[];
  /** Quantidade de registros dependentes (exata, limitada à empresa). */
  quantidade: number;
  /** Até LIMITE_IDS ids, em ordem crescente. */
  ids: number[];
  idsTruncados: boolean;
  acao: AcaoReferencial;
  /** true quando existe constraint real no banco; false para vínculo lógico. */
  fk: boolean;
};

/** Vínculo já classificado — é o que a API devolve e a UI apresenta. */
export type VinculoDependencia = {
  modulo: string;
  icone: string;
  tabela: string;
  colunas: string[];
  /** Recurso dependente, quando a tabela pertence a um recurso do ERP. */
  recurso: string | null;
  quantidade: number;
  ids: number[];
  idsTruncados: boolean;
  unidade: [string, string];
  tipo: TipoVinculo;
  politica: PoliticaVinculo;
  acao: AcaoReferencial;
  /** O banco recusa o DELETE por FK (NO ACTION/RESTRICT). */
  impeditivo: boolean;
  /** Histórico protegido por política: apagar/desligar não é permitido. */
  protegido: boolean;
  /** Conclusão: este vínculo impede a exclusão. */
  bloqueia: boolean;
  /** Explicação em português do porquê (mostrada ao usuário). */
  motivo: string;
};

export type DiagnosticoDependencias = {
  recurso: string;
  recursoLabel: string;
  singular: string;
  id: number;
  empresaId: number;
  rotulo: string;
  status: string | null;
  origem: 'postgresql' | 'memoria';
  /** Existe ao menos um vínculo bloqueante (impeditivo ou protegido). */
  bloqueado: boolean;
  podeExcluir: boolean;
  /** Título curto para o modal. */
  titulo: string;
  /** Mensagem de uma linha (toast/erro HTTP). */
  resumo: string;
  /** O que fazer no lugar de excluir (ex.: "mantenha como CANCELADO"). */
  orientacao: string;
  totalRegistros: number;
  totalBloqueantes: number;
  modulos: string[];
  modulosBloqueantes: string[];
  vinculos: VinculoDependencia[];
  geradoEm: string;
};

/** Quantos ids de cada vínculo são devolvidos (a quantidade é sempre exata). */
export const LIMITE_IDS_POR_VINCULO = 20;

// ----------------------------------------------------------------------------
// 1) MÓDULOS — como cada tabela dependente se apresenta ao usuário.
//    `icone` é uma chave; o front mapeia para o ícone do design system.
// ----------------------------------------------------------------------------
type InfoModulo = { modulo: string; icone: string; unidade?: [string, string] };

export const MODULOS_POR_TABELA: Record<string, InfoModulo> = {
  arquivos: { modulo: 'Anexos', icone: 'anexos', unidade: ['anexo', 'anexos'] },
  auditoria: { modulo: 'Auditoria', icone: 'auditoria', unidade: ['evento', 'eventos'] },
  catalogo_compartilhamentos: { modulo: 'Catálogo', icone: 'catalogo', unidade: ['compartilhamento', 'compartilhamentos'] },
  catalogo_eventos: { modulo: 'Catálogo', icone: 'catalogo', unidade: ['evento', 'eventos'] },
  catalogos: { modulo: 'Catálogo', icone: 'catalogo' },
  categorias: { modulo: 'Categorias', icone: 'categorias' },
  categorias_financeiras: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['categoria', 'categorias'] },
  centros_custo: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['centro de custo', 'centros de custo'] },
  clientes: { modulo: 'Clientes', icone: 'clientes' },
  colecoes: { modulo: 'Coleções', icone: 'colecoes', unidade: ['coleção', 'coleções'] },
  comissoes_eventos: { modulo: 'Comissões', icone: 'financeiro', unidade: ['evento', 'eventos'] },
  compra_recebimento_itens: { modulo: 'Compras', icone: 'compras', unidade: ['item', 'itens'] },
  compra_recebimentos: { modulo: 'Compras', icone: 'compras', unidade: ['recebimento', 'recebimentos'] },
  compras: { modulo: 'Compras', icone: 'compras', unidade: ['compra', 'compras'] },
  connector_events: { modulo: 'Integrações', icone: 'integracoes', unidade: ['evento', 'eventos'] },
  connector_oauth_states: { modulo: 'Integrações', icone: 'integracoes' },
  connectors: { modulo: 'Integrações', icone: 'integracoes', unidade: ['conector', 'conectores'] },
  contas_financeiras: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['conta', 'contas'] },
  cores: { modulo: 'Cores', icone: 'produtos', unidade: ['cor', 'cores'] },
  cotacao_compra_fornecedores: { modulo: 'Cotações de compra', icone: 'compras', unidade: ['convite', 'convites'] },
  cotacao_compra_itens: { modulo: 'Cotações de compra', icone: 'compras', unidade: ['item', 'itens'] },
  cotacao_compra_precos: { modulo: 'Cotações de compra', icone: 'compras', unidade: ['preço', 'preços'] },
  cotacao_decisoes: { modulo: 'Portal do cliente', icone: 'portal', unidade: ['decisão', 'decisões'] },
  cotacoes_compra: { modulo: 'Cotações de compra', icone: 'compras', unidade: ['cotação', 'cotações'] },
  devolucao_itens: { modulo: 'Devoluções', icone: 'devolucoes', unidade: ['item', 'itens'] },
  devolucoes: { modulo: 'Devoluções', icone: 'devolucoes', unidade: ['devolução', 'devoluções'] },
  divergencias_conferencia: { modulo: 'Expedição', icone: 'expedicao', unidade: ['divergência', 'divergências'] },
  documentos_fiscais: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['documento fiscal', 'documentos fiscais'] },
  documentos_fiscais_eventos: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['evento', 'eventos'] },
  empresa_fiscal_config: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['configuração', 'configurações'] },
  empresas: { modulo: 'Empresas', icone: 'empresas', unidade: ['empresa', 'empresas'] },
  envio_eventos: { modulo: 'Expedição', icone: 'expedicao', unidade: ['evento', 'eventos'] },
  envios: { modulo: 'Expedição', icone: 'expedicao', unidade: ['envio', 'envios'] },
  estoque_insumos: { modulo: 'Estoque', icone: 'estoque', unidade: ['saldo', 'saldos'] },
  estoques: { modulo: 'Estoque', icone: 'estoque', unidade: ['saldo', 'saldos'] },
  // MASTER (MA-02..MA-07): fundação comercial
  territorios: { modulo: 'Territórios', icone: 'comercial', unidade: ['território', 'territórios'] },
  equipes_comerciais: { modulo: 'Equipes comerciais', icone: 'comercial', unidade: ['equipe', 'equipes'] },
  equipe_membros: { modulo: 'Equipes comerciais', icone: 'comercial', unidade: ['membro', 'membros'] },
  representante_hierarquia: { modulo: 'Hierarquia comercial', icone: 'comercial', unidade: ['vínculo', 'vínculos'] },
  representante_cliente: { modulo: 'Carteira de clientes', icone: 'comercial', unidade: ['vínculo de carteira', 'vínculos de carteira'] },
  metas: { modulo: 'Metas', icone: 'comercial', unidade: ['meta', 'metas'] },
  planos_comissao: { modulo: 'Comissões', icone: 'financeiro', unidade: ['plano', 'planos'] },
  regras_comissao: { modulo: 'Comissões', icone: 'financeiro', unidade: ['regra', 'regras'] },
  comissoes_apuradas: { modulo: 'Comissões', icone: 'financeiro', unidade: ['apuração', 'apurações'] },
  venda_atribuicao: { modulo: 'Atribuição comercial', icone: 'comercial', unidade: ['atribuição', 'atribuições'] },
  expedicao_eventos: { modulo: 'Expedição', icone: 'expedicao', unidade: ['evento', 'eventos'] },
  fichas_tecnicas: { modulo: 'Produção', icone: 'producao', unidade: ['ficha', 'fichas'] },
  fin_extrato_transacoes: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['transação', 'transações'] },
  fornecedor_contatos: { modulo: 'Fornecedores', icone: 'fornecedores', unidade: ['contato', 'contatos'] },
  fornecedores: { modulo: 'Fornecedores', icone: 'fornecedores', unidade: ['fornecedor', 'fornecedores'] },
  gateway_cobrancas: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['cobrança', 'cobranças'] },
  gateway_configs: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['configuração', 'configurações'] },
  gateway_webhook_events: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['evento', 'eventos'] },
  grade_tamanhos: { modulo: 'Grades', icone: 'produtos', unidade: ['tamanho', 'tamanhos'] },
  grades: { modulo: 'Grades', icone: 'produtos', unidade: ['grade', 'grades'] },
  importacoes_nfe: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['importação', 'importações'] },
  impostos_ncm: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['alíquota', 'alíquotas'] },
  insumos: { modulo: 'Insumos', icone: 'estoque', unidade: ['insumo', 'insumos'] },
  inutilizacoes_fiscais: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['inutilização', 'inutilizações'] },
  inventarios: { modulo: 'Inventário', icone: 'estoque', unidade: ['inventário', 'inventários'] },
  investidores: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['investidor', 'investidores'] },
  itens_compra: { modulo: 'Itens da compra', icone: 'itens', unidade: ['item', 'itens'] },
  itens_ficha_tecnica: { modulo: 'Ficha técnica', icone: 'producao', unidade: ['insumo', 'insumos'] },
  itens_inventario: { modulo: 'Inventário', icone: 'itens', unidade: ['item', 'itens'] },
  itens_ordem: { modulo: 'Itens da OP', icone: 'itens', unidade: ['item', 'itens'] },
  itens_venda: { modulo: 'Itens da venda', icone: 'itens', unidade: ['item', 'itens'] },
  lancamentos_financeiros: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['lançamento', 'lançamentos'] },
  lista_preco_itens: { modulo: 'Listas de preço', icone: 'comercial', unidade: ['item', 'itens'] },
  listas_preco: { modulo: 'Listas de preço', icone: 'comercial', unidade: ['lista', 'listas'] },
  listas_preco_historico: { modulo: 'Listas de preço', icone: 'comercial', unidade: ['registro', 'registros'] },
  locais: { modulo: 'Locais', icone: 'estoque', unidade: ['local', 'locais'] },
  medida_valores: { modulo: 'Medidas', icone: 'produtos', unidade: ['valor', 'valores'] },
  medidas: { modulo: 'Medidas', icone: 'produtos', unidade: ['medida', 'medidas'] },
  movimentacoes: { modulo: 'Estoque', icone: 'estoque', unidade: ['movimentação', 'movimentações'] },
  movimentacoes_insumos: { modulo: 'Estoque', icone: 'estoque', unidade: ['movimentação', 'movimentações'] },
  ordens_apontamentos: { modulo: 'Produção', icone: 'producao', unidade: ['apontamento', 'apontamentos'] },
  ordens_eventos: { modulo: 'Produção', icone: 'producao', unidade: ['evento', 'eventos'] },
  ordens_fabricacao: { modulo: 'Produção', icone: 'producao', unidade: ['ordem', 'ordens'] },
  pdv_caixa_movimentos: { modulo: 'Caixa', icone: 'caixa', unidade: ['movimento', 'movimentos'] },
  pdv_caixas: { modulo: 'Caixa', icone: 'caixa', unidade: ['caixa', 'caixas'] },
  pdv_pagamentos: { modulo: 'Caixa', icone: 'caixa', unidade: ['pagamento', 'pagamentos'] },
  politicas_comerciais: { modulo: 'Comercial', icone: 'comercial', unidade: ['política', 'políticas'] },
  portal_acessos: { modulo: 'Portal do cliente', icone: 'portal', unidade: ['acesso', 'acessos'] },
  print_agent_nonces: { modulo: 'Impressão', icone: 'impressao', unidade: ['registro', 'registros'] },
  print_agents: { modulo: 'Impressão', icone: 'impressao', unidade: ['agente', 'agentes'] },
  print_jobs: { modulo: 'Impressão', icone: 'impressao', unidade: ['trabalho', 'trabalhos'] },
  print_pairing_codes: { modulo: 'Impressão', icone: 'impressao', unidade: ['código', 'códigos'] },
  print_terminals: { modulo: 'Impressão', icone: 'impressao', unidade: ['terminal', 'terminais'] },
  produto_abc: { modulo: 'Produtos', icone: 'produtos', unidade: ['curva ABC', 'curvas ABC'] },
  produto_composicao: { modulo: 'Produtos', icone: 'produtos', unidade: ['componente', 'componentes'] },
  produto_fornecedor_skus: { modulo: 'Produtos', icone: 'produtos', unidade: ['SKU', 'SKUs'] },
  produtos: { modulo: 'Produtos', icone: 'produtos', unidade: ['produto', 'produtos'] },
  proposta_eventos: { modulo: 'Propostas', icone: 'propostas', unidade: ['evento', 'eventos'] },
  proposta_itens: { modulo: 'Propostas', icone: 'propostas', unidade: ['item', 'itens'] },
  propostas: { modulo: 'Propostas', icone: 'propostas', unidade: ['proposta', 'propostas'] },
  recorrencias_financeiras: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['recorrência', 'recorrências'] },
  regras_fiscais: { modulo: 'Fiscal', icone: 'fiscal', unidade: ['regra', 'regras'] },
  representantes: { modulo: 'Representantes', icone: 'representantes', unidade: ['representante', 'representantes'] },
  sale_items: { modulo: 'Vendas multicanal', icone: 'vendas', unidade: ['item', 'itens'] },
  sales: { modulo: 'Vendas multicanal', icone: 'vendas', unidade: ['pedido multicanal', 'pedidos multicanal'] },
  sessoes: { modulo: 'Segurança', icone: 'sistema', unidade: ['sessão', 'sessões'] },
  tamanhos: { modulo: 'Tamanhos', icone: 'produtos', unidade: ['tamanho', 'tamanhos'] },
  transferencias_financeiras: { modulo: 'Financeiro', icone: 'financeiro', unidade: ['transferência', 'transferências'] },
  usuario_empresas: { modulo: 'Usuários', icone: 'usuarios', unidade: ['acesso', 'acessos'] },
  usuarios: { modulo: 'Usuários', icone: 'usuarios', unidade: ['usuário', 'usuários'] },
  vendas: { modulo: 'Vendas', icone: 'vendas', unidade: ['pedido', 'pedidos'] },
  webhook_entregas: { modulo: 'Integrações', icone: 'integracoes', unidade: ['entrega', 'entregas'] },
  webhooks: { modulo: 'Integrações', icone: 'integracoes', unidade: ['webhook', 'webhooks'] },
};

// ----------------------------------------------------------------------------
// 2) REGRAS POR RELAÇÃO — só o que difere do padrão.
//    Chave: `${alvo}.${tabela}` ou `${alvo}.${tabela}.${coluna}`.
//
//    politica:
//      seguir      — a FK decide (CASCADE/SET NULL não impedem; NO ACTION impede)
//      proteger    — mesmo sem FK impeditiva, o ERP recusa: é histórico
//      desvincular — a própria rotina de exclusão desfaz o vínculo antes
//                    (exclusão de LOCAL: saldos/movimentações/inventários
//                    mantêm o nome do local como histórico)
// ----------------------------------------------------------------------------
type RegraRelacao = {
  alvo: string;
  tabela: string;
  coluna?: string;
  tipo: TipoVinculo;
  politica: PoliticaVinculo;
  motivo?: string;
};

export const REGRAS_RELACAO: RegraRelacao[] = [
  // ---- VENDAS: o caso central desta entrega -------------------------------
  // Estoque: a movimentação guarda venda_id (composite com empresa_id) e a FK
  // é NO ACTION — o banco recusa o DELETE. É o histórico que o cancelamento
  // do pedido NÃO apaga (o estorno é uma nova movimentação).
  { alvo: 'vendas', tabela: 'movimentacoes', tipo: 'historico', politica: 'seguir', motivo: 'histórico de movimentação de estoque (saída e estorno do pedido)' },
  { alvo: 'vendas', tabela: 'comissoes_eventos', tipo: 'historico', politica: 'seguir', motivo: 'histórico de comissão do representante' },
  { alvo: 'vendas', tabela: 'devolucoes', tipo: 'historico', politica: 'seguir', motivo: 'histórico de devolução vinculado ao pedido' },
  { alvo: 'vendas', tabela: 'gateway_cobrancas', tipo: 'historico', politica: 'seguir', motivo: 'cobrança do gateway de pagamento' },
  // Caixa/PDV: ON DELETE CASCADE no banco, mas é histórico de recebimento —
  // a política do ERP é não apagar.
  { alvo: 'vendas', tabela: 'pdv_pagamentos', tipo: 'historico', politica: 'proteger', motivo: 'pagamentos registrados no caixa do PDV' },
  // Expedição/logística (CASCADE): apagar o pedido apagaria a trilha.
  { alvo: 'vendas', tabela: 'envios', tipo: 'historico', politica: 'proteger', motivo: 'envio/logística do pedido' },
  { alvo: 'vendas', tabela: 'expedicao_eventos', tipo: 'historico', politica: 'proteger', motivo: 'trilha de expedição do pedido' },
  { alvo: 'vendas', tabela: 'divergencias_conferencia', tipo: 'historico', politica: 'proteger', motivo: 'divergências registradas na conferência' },
  // Fiscal (SET NULL): o documento fiscal não pode perder o vínculo.
  { alvo: 'vendas', tabela: 'documentos_fiscais', tipo: 'historico', politica: 'proteger', motivo: 'documento fiscal emitido para o pedido' },
  // Comercial: decisão do cliente na cotação que originou o pedido.
  { alvo: 'vendas', tabela: 'cotacao_decisoes', tipo: 'historico', politica: 'proteger', motivo: 'decisão do cliente na cotação de origem' },
  // Proposta convertida: a FK é SET NULL, mas o CHECK do banco exige vínculo
  // em 'convertida' — desligar o vínculo quebraria a regra de consistência.
  { alvo: 'vendas', tabela: 'propostas', tipo: 'operacional', politica: 'proteger', motivo: 'proposta convertida neste pedido' },
  // Venda multicanal: o registro analítico não pode perder o elo operacional.
  { alvo: 'vendas', tabela: 'sales', tipo: 'operacional', politica: 'proteger', motivo: 'pedido multicanal ligado a esta venda' },
  // Composição: itens do pedido são parte do próprio registro.
  { alvo: 'vendas', tabela: 'itens_venda', tipo: 'composicao', politica: 'seguir' },

  // ---- FUNDAÇÃO COMERCIAL (MASTER MA-02..MA-07) ---------------------------
  // Carteira, atribuição e comissão apurada são HISTÓRICO: apagar o
  // representante/cliente/território não pode reescrever a história comercial.
  { alvo: '', tabela: 'representante_cliente', tipo: 'historico', politica: 'proteger', motivo: 'carteira temporal do representante (histórico de quem atendia o cliente)' },
  { alvo: '', tabela: 'venda_atribuicao', tipo: 'historico', politica: 'proteger', motivo: 'atribuição comercial congelada na venda' },
  { alvo: '', tabela: 'comissoes_apuradas', tipo: 'historico', politica: 'proteger', motivo: 'comissão apurada por venda e representante' },
  { alvo: '', tabela: 'regras_comissao', tipo: 'operacional', politica: 'proteger', motivo: 'regra que precifica a comissão' },
  { alvo: '', tabela: 'planos_comissao', tipo: 'operacional', politica: 'proteger', motivo: 'plano de comissão com vigência' },
  { alvo: '', tabela: 'metas', tipo: 'operacional', politica: 'proteger', motivo: 'meta comercial do período' },
  { alvo: '', tabela: 'equipe_membros', tipo: 'composicao', politica: 'seguir', motivo: 'composição da equipe' },
  { alvo: '', tabela: 'representante_hierarquia', tipo: 'historico', politica: 'proteger', motivo: 'hierarquia comercial com vigência' },
  { alvo: '', tabela: 'equipes_comerciais', tipo: 'operacional', politica: 'proteger', motivo: 'equipe comercial' },
  { alvo: '', tabela: 'territorios', tipo: 'operacional', politica: 'proteger', motivo: 'território comercial (a exclusão deixaria vínculos órfãos)' },
  // Marketing: evento de catálogo não é histórico do pedido.
  { alvo: 'vendas', tabela: 'catalogo_eventos', tipo: 'operacional', politica: 'seguir', motivo: 'evento de catálogo que originou o pedido' },
  // Ondas 4–5: fidelidade e atendimento apontam para o pedido canônico.
  { alvo: 'vendas', tabela: 'loyalty_movements', tipo: 'historico', politica: 'proteger', motivo: 'movimento de pontos de fidelidade originado no pedido' },
  { alvo: 'vendas', tabela: 'service_tickets', tipo: 'historico', politica: 'proteger', motivo: 'ticket de atendimento vinculado ao pedido' },

  // ---- COMPRAS ------------------------------------------------------------
  { alvo: 'compras', tabela: 'itens_compra', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'compras', tabela: 'compra_recebimentos', tipo: 'historico', politica: 'proteger', motivo: 'recebimento da compra — entrada no estoque e no custo' },
  { alvo: 'compras', tabela: 'compra_recebimento_itens', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'compras', tabela: 'movimentacoes', tipo: 'historico', politica: 'seguir', motivo: 'histórico de movimentação de estoque da compra' },
  { alvo: 'compras', tabela: 'movimentacoes_insumos', tipo: 'historico', politica: 'seguir', motivo: 'histórico de movimentação de insumos da compra' },
  { alvo: 'compras', tabela: 'importacoes_nfe', tipo: 'historico', politica: 'seguir', motivo: 'NF-e importada que gerou a compra' },
  { alvo: 'compras', tabela: 'cotacoes_compra', tipo: 'operacional', politica: 'seguir', motivo: 'cotação de compra gerada a partir desta compra' },

  // ---- LOCAIS: a exclusão de local desfaz o vínculo e preserva o nome -----
  { alvo: 'locais', tabela: 'estoques', tipo: 'historico', politica: 'desvincular', motivo: 'saldo do local — o vínculo é desfeito e o nome do local permanece no histórico' },
  { alvo: 'locais', tabela: 'movimentacoes', tipo: 'historico', politica: 'desvincular', motivo: 'movimentação do local — o vínculo é desfeito e o nome do local permanece no histórico' },
  { alvo: 'locais', tabela: 'inventarios', tipo: 'historico', politica: 'desvincular', motivo: 'inventário do local — o vínculo é desfeito e o nome do local permanece no histórico' },
  { alvo: 'locais', tabela: 'vendas', tipo: 'operacional', politica: 'seguir', motivo: 'local de saída de pedidos de venda' },
  { alvo: 'locais', tabela: 'pdv_caixas', tipo: 'operacional', politica: 'seguir', motivo: 'caixa do PDV aberto/fechado neste local' },
  { alvo: 'locais', tabela: 'ordens_fabricacao', tipo: 'operacional', politica: 'seguir', motivo: 'local de produção de ordens de fabricação' },

  // ---- CLIENTES -----------------------------------------------------------
  // Vendas/propostas/devoluções: FK NO ACTION. É o histórico comercial do
  // cliente — o cadastro em uso se desativa, não se exclui.
  { alvo: 'clientes', tabela: 'vendas', tipo: 'historico', politica: 'seguir', motivo: 'pedidos de venda do cliente' },
  { alvo: 'clientes', tabela: 'propostas', tipo: 'historico', politica: 'seguir', motivo: 'propostas comerciais do cliente' },
  { alvo: 'clientes', tabela: 'devolucoes', tipo: 'historico', politica: 'seguir', motivo: 'devoluções do cliente' },
  { alvo: 'clientes', tabela: 'portal_acessos', tipo: 'operacional', politica: 'seguir', motivo: 'acesso ao portal do cliente (revogado junto)' },
  { alvo: 'clientes', tabela: 'politicas_comerciais', tipo: 'operacional', politica: 'seguir', motivo: 'política comercial negociada com o cliente' },
  { alvo: 'clientes', tabela: 'cotacao_decisoes', tipo: 'historico', politica: 'proteger', motivo: 'decisões do cliente em cotações' },

  // ---- REPRESENTANTES -----------------------------------------------------
  // O representante é o vendedor do histórico comercial. Excluir o cadastro
  // NÃO pode apagar (nem desligar) vendas, propostas e comissões já apuradas:
  // a FK é NO ACTION — o banco já recusa — e a política é declarada para o
  // diagnóstico explicar POR QUE a saída é DESATIVAR/DESLIGAR. Nada de
  // CASCADE, nada de remover FK, nada de balcão de exclusão forçada.
  { alvo: 'representantes', tabela: 'vendas', tipo: 'historico', politica: 'proteger', motivo: 'pedidos de venda do representante' },
  { alvo: 'representantes', tabela: 'comissoes_eventos', tipo: 'historico', politica: 'proteger', motivo: 'comissões apuradas do representante' },
  { alvo: 'representantes', tabela: 'propostas', tipo: 'historico', politica: 'proteger', motivo: 'propostas comerciais do representante' },
  { alvo: 'representantes', tabela: 'clientes', tipo: 'operacional', politica: 'seguir', motivo: 'clientes atendidos por este representante (vendedor padrão)' },

  // ---- PRODUTOS -----------------------------------------------------------
  // Estoque, pedidos, fichas e OPs usam FK NO ACTION: o produto é histórico.
  { alvo: 'produtos', tabela: 'estoques', tipo: 'historico', politica: 'seguir', motivo: 'saldo de estoque do produto' },
  { alvo: 'produtos', tabela: 'movimentacoes', tipo: 'historico', politica: 'seguir', motivo: 'movimentações de estoque do produto' },
  { alvo: 'produtos', tabela: 'itens_venda', tipo: 'historico', politica: 'seguir', motivo: 'itens de pedidos de venda' },
  { alvo: 'produtos', tabela: 'itens_compra', tipo: 'historico', politica: 'seguir', motivo: 'itens de compras' },
  { alvo: 'produtos', tabela: 'itens_inventario', tipo: 'historico', politica: 'seguir', motivo: 'contagens de inventário' },
  { alvo: 'produtos', tabela: 'fichas_tecnicas', tipo: 'operacional', politica: 'seguir', motivo: 'ficha técnica do produto' },
  { alvo: 'produtos', tabela: 'ordens_fabricacao', tipo: 'operacional', politica: 'seguir', motivo: 'ordens de fabricação do produto' },
  { alvo: 'produtos', tabela: 'proposta_itens', tipo: 'historico', politica: 'seguir', motivo: 'itens de propostas comerciais' },
  { alvo: 'produtos', tabela: 'cotacao_compra_itens', tipo: 'historico', politica: 'seguir', motivo: 'itens de cotações de compra' },
  { alvo: 'produtos', tabela: 'devolucao_itens', tipo: 'historico', politica: 'seguir', motivo: 'itens de devolução' },
  { alvo: 'produtos', tabela: 'produto_fornecedor_skus', tipo: 'operacional', politica: 'seguir', motivo: 'SKU do produto no fornecedor' },
  { alvo: 'produtos', tabela: 'produto_composicao', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'produtos', tabela: 'lista_preco_itens', tipo: 'operacional', politica: 'seguir', motivo: 'item de lista de preço' },
  { alvo: 'produtos', tabela: 'listas_preco_historico', tipo: 'operacional', politica: 'seguir', motivo: 'histórico de preço do produto' },
  { alvo: 'produtos', tabela: 'produto_abc', tipo: 'operacional', politica: 'seguir', motivo: 'curva ABC do produto (recalculável)' },
  { alvo: 'produtos', tabela: 'catalogo_eventos', tipo: 'operacional', politica: 'seguir', motivo: 'evento de catálogo do produto' },
  { alvo: 'produtos', tabela: 'sale_items', tipo: 'operacional', politica: 'seguir', motivo: 'item de venda multicanal' },

  // ---- FORNECEDORES / CATEGORIAS / COLEÇÕES / GRADES ----------------------
  { alvo: 'fornecedores', tabela: 'compras', tipo: 'historico', politica: 'seguir', motivo: 'compras do fornecedor' },
  { alvo: 'fornecedores', tabela: 'insumos', tipo: 'operacional', politica: 'seguir', motivo: 'insumos cadastrados para o fornecedor' },
  { alvo: 'fornecedores', tabela: 'produtos', tipo: 'operacional', politica: 'seguir', motivo: 'produtos do fornecedor' },
  { alvo: 'fornecedores', tabela: 'fornecedor_contatos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'categorias', tabela: 'produtos', tipo: 'historico', politica: 'seguir', motivo: 'produtos da categoria' },
  { alvo: 'categorias', tabela: 'catalogos', tipo: 'operacional', politica: 'seguir', motivo: 'catálogo que usa esta categoria' },
  // COLEÇÕES: a coleção organiza o catálogo. Os PRODUTOS que a referenciam são
  // histórico do negócio — apagá-los (ou desligar o vínculo) reescreveria o
  // passado. Por isso a política é `proteger`: a exclusão é recusada com o
  // diagnóstico completo e a coleção se DESATIVA (campo Ativo), preservando os
  // produtos. As regras valem nos DOIS modos (o MemStore lê este mesmo mapa).
  { alvo: 'colecoes', tabela: 'produtos', tipo: 'historico', politica: 'proteger', motivo: 'produtos do catálogo vinculados a esta coleção' },
  { alvo: 'colecoes', tabela: 'catalogos', tipo: 'operacional', politica: 'proteger', motivo: 'catálogo que usa esta coleção como filtro' },
  { alvo: 'colecoes', tabela: 'politicas_comerciais', tipo: 'operacional', politica: 'seguir', motivo: 'política comercial da coleção' },
  { alvo: 'grades', tabela: 'grade_tamanhos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'grades', tabela: 'medidas', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'medidas', tabela: 'medida_valores', tipo: 'composicao', politica: 'seguir' },

  // ---- FINANCEIRO ---------------------------------------------------------
  { alvo: 'categorias_financeiras', tabela: 'categorias_financeiras', tipo: 'operacional', politica: 'seguir', motivo: 'subcategoria vinculada' },
  { alvo: 'lancamentos_financeiros', tabela: 'comissoes_eventos', tipo: 'historico', politica: 'seguir', motivo: 'evento de comissão liquidado por este lançamento' },
  { alvo: 'lancamentos_financeiros', tabela: 'fin_extrato_transacoes', tipo: 'operacional', politica: 'seguir', motivo: 'conciliação bancária do lançamento' },
  { alvo: 'lancamentos_financeiros', tabela: 'gateway_cobrancas', tipo: 'historico', politica: 'seguir', motivo: 'cobrança do gateway liquidada por este lançamento' },

  // ---- PRODUÇÃO / EXPEDIÇÃO / OUTROS -------------------------------------
  { alvo: 'ordens_fabricacao', tabela: 'itens_ordem', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'ordens_fabricacao', tabela: 'ordens_eventos', tipo: 'historico', politica: 'seguir', motivo: 'trilha de transições da OP' },
  { alvo: 'ordens_fabricacao', tabela: 'ordens_apontamentos', tipo: 'historico', politica: 'seguir', motivo: 'apontamentos de produção da OP' },
  { alvo: 'devolucoes', tabela: 'devolucao_itens', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'documentos_fiscais', tabela: 'documentos_fiscais_eventos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'envios', tabela: 'envio_eventos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'pdv_caixas', tabela: 'pdv_caixa_movimentos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'pdv_caixas', tabela: 'pdv_pagamentos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'propostas', tabela: 'proposta_itens', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'propostas', tabela: 'proposta_eventos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'fichas_tecnicas', tabela: 'itens_ficha_tecnica', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'inventarios', tabela: 'itens_inventario', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'cotacoes_compra', tabela: 'cotacao_compra_itens', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'cotacoes_compra', tabela: 'cotacao_compra_fornecedores', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'cotacao_compra_fornecedores', tabela: 'cotacao_compra_precos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'cotacao_compra_itens', tabela: 'cotacao_compra_precos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'catalogos', tabela: 'catalogo_compartilhamentos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'catalogos', tabela: 'catalogo_eventos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'catalogo_compartilhamentos', tabela: 'catalogo_eventos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'sales', tabela: 'sale_items', tipo: 'composicao', politica: 'seguir' },

  // ---- ERP 3.0: composições dos documentos das migrations 0051..0056 --------
  // Histórico de estágio do CRM é parte da oportunidade (nasce com ela e só
  // existe por causa dela). Sem esta regra, a própria trilha que o CRM 3.0
  // criou impediria excluir uma oportunidade criada por engano.
  { alvo: 'crm_oportunidades', tabela: 'crm_oportunidade_estagio_historico', tipo: 'composicao', politica: 'seguir' },
  // Documento de transferência: itens e eventos são o próprio documento.
  { alvo: 'estoque_transferencias', tabela: 'estoque_transferencia_itens', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'estoque_transferencias', tabela: 'estoque_transferencia_eventos', tipo: 'composicao', politica: 'seguir' },
  // Homologação: documentos e trilha pertencem ao cadastro do fornecedor.
  // (Fornecedor em uso continua sendo DESATIVADO, não excluído — ver services.)
  { alvo: 'fornecedores', tabela: 'fornecedor_documentos', tipo: 'composicao', politica: 'seguir' },
  { alvo: 'fornecedores', tabela: 'fornecedor_homologacao_eventos', tipo: 'composicao', politica: 'seguir' },
  // Obrigação fiscal: a entrega pertence à obrigação.
  { alvo: 'fiscal_obrigacoes', tabela: 'fiscal_obrigacao_entregas', tipo: 'composicao', politica: 'seguir' },

  { alvo: 'usuarios', tabela: 'usuario_empresas', tipo: 'operacional', politica: 'seguir', motivo: 'concessões de acesso a empresas (revogadas junto)' },
  { alvo: 'usuarios', tabela: 'connector_oauth_states', tipo: 'operacional', politica: 'seguir' },
  { alvo: 'empresas', tabela: 'empresa_fiscal_config', tipo: 'operacional', politica: 'seguir', motivo: 'configuração fiscal da empresa' },
  { alvo: 'empresas', tabela: 'usuario_empresas', tipo: 'operacional', politica: 'seguir', motivo: 'usuários com acesso à empresa' },
];

/**
 * FKs que NÃO são declaradas como `ref` em resources.ts (o MemStore não as vê
 * sozinho) e/ou cuja ação referencial difere do padrão NO ACTION.
 * A lista de VENDAS e COMPRAS é completa (um teste PostgreSQL garante que o
 * catálogo real não tem nenhuma FK para essas tabelas fora daqui).
 */
export type RelacaoFkDeclarada = { alvo: string; tabela: string; colunas: string[]; acao: AcaoReferencial };

export const RELACOES_FK: RelacaoFkDeclarada[] = [
  // MASTER (MA-02..MA-07) — FKs reais da fundação comercial. O PostgreSQL as
  // descobre sozinho no catálogo; esta declaração existe para o MemStore
  // responder EXATAMENTE o mesmo diagnóstico (paridade declarada, não fingida).
  { alvo: 'territorios', tabela: 'territorios', colunas: ['territorio_pai_id'], acao: 'NO_ACTION' },
  // ERP 3.0 — FKs declaradas das migrations 0051..0056.
  // OP alocada a um recurso produtivo: o recurso em uso é desativado, não
  // excluído (histórico de carga depende dele).
  { alvo: 'producao_recursos', tabela: 'ordens_fabricacao', colunas: ['recurso_id'], acao: 'NO_ACTION' },
  // Plano de contas hierárquico (auto-referência).
  { alvo: 'plano_contas', tabela: 'plano_contas', colunas: ['pai_id'], acao: 'NO_ACTION' },
  // Classificação contábil do lançamento: apagar a conta em uso é bloqueado.
  { alvo: 'plano_contas', tabela: 'lancamentos_financeiros', colunas: ['conta_contabil_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'representante_cliente', colunas: ['territorio_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'metas', colunas: ['territorio_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'regras_comissao', colunas: ['territorio_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'venda_atribuicao', colunas: ['territorio_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'equipes_comerciais', colunas: ['territorio_id'], acao: 'NO_ACTION' },
  { alvo: 'territorios', tabela: 'territorios', colunas: ['responsavel_id'], acao: 'NO_ACTION' },
  { alvo: 'equipes_comerciais', tabela: 'equipe_membros', colunas: ['equipe_id'], acao: 'CASCADE' },
  { alvo: 'equipes_comerciais', tabela: 'metas', colunas: ['equipe_id'], acao: 'NO_ACTION' },
  { alvo: 'equipes_comerciais', tabela: 'regras_comissao', colunas: ['equipe_id'], acao: 'NO_ACTION' },
  { alvo: 'equipes_comerciais', tabela: 'venda_atribuicao', colunas: ['equipe_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'representante_cliente', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'representante_hierarquia', colunas: ['supervisor_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'representante_hierarquia', colunas: ['subordinado_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'equipe_membros', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'metas', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'regras_comissao', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'venda_atribuicao', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'representantes', tabela: 'comissoes_apuradas', colunas: ['representante_id'], acao: 'NO_ACTION' },
  { alvo: 'clientes', tabela: 'representante_cliente', colunas: ['cliente_id'], acao: 'NO_ACTION' },
  { alvo: 'clientes', tabela: 'regras_comissao', colunas: ['cliente_id'], acao: 'NO_ACTION' },
  { alvo: 'planos_comissao', tabela: 'regras_comissao', colunas: ['plano_id'], acao: 'CASCADE' },
  { alvo: 'planos_comissao', tabela: 'comissoes_apuradas', colunas: ['plano_id'], acao: 'NO_ACTION' },
  { alvo: 'regras_comissao', tabela: 'comissoes_apuradas', colunas: ['regra_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'venda_atribuicao', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'comissoes_apuradas', colunas: ['venda_id'], acao: 'NO_ACTION' },

  // vendas — todas as FKs de entrada (pg_constraint em 16.14)
  { alvo: 'vendas', tabela: 'itens_venda', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'movimentacoes', colunas: ['empresa_id', 'venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'comissoes_eventos', colunas: ['venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'devolucoes', colunas: ['venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'devolucoes', colunas: ['empresa_id', 'venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'gateway_cobrancas', colunas: ['venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'pdv_pagamentos', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'envios', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'expedicao_eventos', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'divergencias_conferencia', colunas: ['venda_id'], acao: 'CASCADE' },
  { alvo: 'vendas', tabela: 'documentos_fiscais', colunas: ['venda_id'], acao: 'SET_NULL' },
  { alvo: 'vendas', tabela: 'propostas', colunas: ['venda_id'], acao: 'SET_NULL' },
  { alvo: 'vendas', tabela: 'sales', colunas: ['operational_venda_id'], acao: 'SET_NULL' },
  { alvo: 'vendas', tabela: 'catalogo_eventos', colunas: ['pedido_id'], acao: 'SET_NULL' },
  { alvo: 'vendas', tabela: 'cotacao_decisoes', colunas: ['venda_id'], acao: 'CASCADE' },
  // COMMERCE OS (0068) — pedido omnichannel e rastreio presos à venda convertida.
  { alvo: 'vendas', tabela: 'commerce_pedidos', colunas: ['venda_id'], acao: 'SET_NULL' },
  { alvo: 'vendas', tabela: 'commerce_rastreio', colunas: ['venda_id'], acao: 'NO_ACTION' },
  // Ondas 4–5: o pedido faturado é a origem do crédito de fidelidade e do
  // ticket de atendimento — vínculo histórico protegido, nunca apagado.
  { alvo: 'vendas', tabela: 'loyalty_movements', colunas: ['venda_id'], acao: 'NO_ACTION' },
  { alvo: 'vendas', tabela: 'service_tickets', colunas: ['venda_id'], acao: 'NO_ACTION' },

  // compras — todas as FKs de entrada
  { alvo: 'compras', tabela: 'itens_compra', colunas: ['compra_id'], acao: 'CASCADE' },
  { alvo: 'compras', tabela: 'itens_compra', colunas: ['compra_id', 'empresa_id'], acao: 'NO_ACTION' },
  { alvo: 'compras', tabela: 'compra_recebimentos', colunas: ['compra_id'], acao: 'CASCADE' },
  { alvo: 'compras', tabela: 'compra_recebimentos', colunas: ['empresa_id', 'compra_id'], acao: 'CASCADE' },
  { alvo: 'compras', tabela: 'cotacoes_compra', colunas: ['compra_id'], acao: 'SET_NULL' },
  { alvo: 'compras', tabela: 'importacoes_nfe', colunas: ['compra_id'], acao: 'NO_ACTION' },
  { alvo: 'compras', tabela: 'movimentacoes', colunas: ['compra_id'], acao: 'NO_ACTION' },
  { alvo: 'compras', tabela: 'movimentacoes', colunas: ['compra_id', 'empresa_id'], acao: 'NO_ACTION' },
  { alvo: 'compras', tabela: 'movimentacoes_insumos', colunas: ['compra_id'], acao: 'NO_ACTION' },
  { alvo: 'compras', tabela: 'movimentacoes_insumos', colunas: ['empresa_id', 'compra_id'], acao: 'NO_ACTION' },

  // clientes
  { alvo: 'clientes', tabela: 'cotacao_decisoes', colunas: ['cliente_id'], acao: 'CASCADE' },
  { alvo: 'clientes', tabela: 'politicas_comerciais', colunas: ['cliente_id'], acao: 'CASCADE' },
  { alvo: 'clientes', tabela: 'portal_acessos', colunas: ['cliente_id'], acao: 'CASCADE' },
  { alvo: 'clientes', tabela: 'catalogo_compartilhamentos', colunas: ['cliente_id'], acao: 'SET_NULL' },

  // representantes — `comissoes_eventos.representante_id` é coluna REAL sem
  // `ref` em resources.ts. Sem esta declaração o modo demonstração não enxerga
  // o vínculo (o catálogo do PostgreSQL enxerga sempre). As demais FKs para
  // `representantes` (vendas, clientes, propostas) são descobertas pelos
  // campos `ref` dos próprios recursos — ver `refsPara`.
  { alvo: 'representantes', tabela: 'comissoes_eventos', colunas: ['representante_id'], acao: 'NO_ACTION' },

  // produtos
  { alvo: 'produtos', tabela: 'produto_composicao', colunas: ['produto_id'], acao: 'CASCADE' },
  { alvo: 'produtos', tabela: 'produto_composicao', colunas: ['componente_id'], acao: 'RESTRICT' },
  { alvo: 'produtos', tabela: 'produtos', colunas: ['produto_pai_id'], acao: 'RESTRICT' },
  { alvo: 'produtos', tabela: 'lista_preco_itens', colunas: ['produto_id'], acao: 'CASCADE' },
  { alvo: 'produtos', tabela: 'listas_preco_historico', colunas: ['produto_id'], acao: 'CASCADE' },
  { alvo: 'produtos', tabela: 'produto_abc', colunas: ['produto_id'], acao: 'CASCADE' },
  { alvo: 'produtos', tabela: 'catalogo_eventos', colunas: ['produto_id'], acao: 'SET_NULL' },
  { alvo: 'produtos', tabela: 'sale_items', colunas: ['product_id'], acao: 'SET_NULL' },

  // fornecedores / categorias / coleções / grades / medidas
  { alvo: 'fornecedores', tabela: 'fornecedor_contatos', colunas: ['fornecedor_id'], acao: 'CASCADE' },
  { alvo: 'colecoes', tabela: 'politicas_comerciais', colunas: ['colecao_id'], acao: 'CASCADE' },
  { alvo: 'grades', tabela: 'grade_tamanhos', colunas: ['grade_id'], acao: 'CASCADE' },
  { alvo: 'grades', tabela: 'medidas', colunas: ['grade_id'], acao: 'CASCADE' },
  { alvo: 'grades', tabela: 'categorias', colunas: ['grade_id'], acao: 'NO_ACTION' },
  { alvo: 'grades', tabela: 'produtos', colunas: ['grade_id'], acao: 'NO_ACTION' },
  { alvo: 'medidas', tabela: 'medida_valores', colunas: ['medida_id'], acao: 'CASCADE' },
  { alvo: 'tamanhos', tabela: 'grade_tamanhos', colunas: ['tamanho_id'], acao: 'CASCADE' },
  { alvo: 'tamanhos', tabela: 'medida_valores', colunas: ['tamanho_id'], acao: 'CASCADE' },

  // locais
  { alvo: 'locais', tabela: 'estoques', colunas: ['local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'estoques', colunas: ['empresa_id', 'local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'movimentacoes', colunas: ['local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'movimentacoes', colunas: ['empresa_id', 'local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'movimentacoes', colunas: ['local_destino_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'movimentacoes', colunas: ['empresa_id', 'local_destino_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'inventarios', colunas: ['local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'inventarios', colunas: ['empresa_id', 'local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'ordens_fabricacao', colunas: ['local_producao_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'pdv_caixas', colunas: ['local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'pdv_caixas', colunas: ['empresa_id', 'local_id'], acao: 'NO_ACTION' },
  { alvo: 'locais', tabela: 'vendas', colunas: ['empresa_id', 'local_saida_id'], acao: 'NO_ACTION' },

  // demais composições relevantes
  { alvo: 'ordens_fabricacao', tabela: 'itens_ordem', colunas: ['ordem_id'], acao: 'CASCADE' },
  { alvo: 'ordens_fabricacao', tabela: 'ordens_eventos', colunas: ['ordem_id'], acao: 'CASCADE' },
  { alvo: 'ordens_fabricacao', tabela: 'ordens_apontamentos', colunas: ['ordem_id'], acao: 'CASCADE' },
  { alvo: 'devolucoes', tabela: 'devolucao_itens', colunas: ['devolucao_id'], acao: 'CASCADE' },
  { alvo: 'documentos_fiscais', tabela: 'documentos_fiscais_eventos', colunas: ['documento_id'], acao: 'CASCADE' },
  { alvo: 'envios', tabela: 'envio_eventos', colunas: ['envio_id'], acao: 'CASCADE' },
  { alvo: 'pdv_caixas', tabela: 'pdv_caixa_movimentos', colunas: ['caixa_id'], acao: 'CASCADE' },
  { alvo: 'pdv_caixas', tabela: 'pdv_pagamentos', colunas: ['caixa_id'], acao: 'SET_NULL' },
  { alvo: 'propostas', tabela: 'proposta_itens', colunas: ['proposta_id'], acao: 'CASCADE' },
  { alvo: 'propostas', tabela: 'proposta_eventos', colunas: ['proposta_id'], acao: 'CASCADE' },
  { alvo: 'fichas_tecnicas', tabela: 'itens_ficha_tecnica', colunas: ['ficha_id'], acao: 'CASCADE' },
  { alvo: 'inventarios', tabela: 'itens_inventario', colunas: ['inventario_id'], acao: 'CASCADE' },
  { alvo: 'cotacoes_compra', tabela: 'cotacao_compra_itens', colunas: ['cotacao_id'], acao: 'CASCADE' },
  { alvo: 'cotacoes_compra', tabela: 'cotacao_compra_fornecedores', colunas: ['cotacao_id'], acao: 'CASCADE' },
  { alvo: 'cotacao_compra_fornecedores', tabela: 'cotacao_compra_precos', colunas: ['convite_id'], acao: 'CASCADE' },
  { alvo: 'cotacao_compra_itens', tabela: 'cotacao_compra_precos', colunas: ['item_id'], acao: 'CASCADE' },
  { alvo: 'catalogos', tabela: 'catalogo_compartilhamentos', colunas: ['catalogo_id'], acao: 'CASCADE' },
  { alvo: 'catalogos', tabela: 'catalogo_eventos', colunas: ['catalogo_id'], acao: 'CASCADE' },
  { alvo: 'catalogo_compartilhamentos', tabela: 'catalogo_eventos', colunas: ['compartilhamento_id'], acao: 'CASCADE' },
  { alvo: 'sales', tabela: 'sale_items', colunas: ['sale_id'], acao: 'CASCADE' },
  { alvo: 'usuarios', tabela: 'usuario_empresas', colunas: ['usuario_id'], acao: 'CASCADE' },
  { alvo: 'usuarios', tabela: 'connector_oauth_states', colunas: ['usuario_id'], acao: 'CASCADE' },
  { alvo: 'usuarios', tabela: 'connectors', colunas: ['usuario_id'], acao: 'RESTRICT' },
  { alvo: 'usuarios', tabela: 'connector_events', colunas: ['usuario_id'], acao: 'RESTRICT' },
  { alvo: 'usuarios', tabela: 'sales', colunas: ['usuario_id'], acao: 'RESTRICT' },
  { alvo: 'empresas', tabela: 'usuario_empresas', colunas: ['empresa_id'], acao: 'CASCADE' },
  { alvo: 'empresas', tabela: 'empresa_fiscal_config', colunas: ['empresa_id'], acao: 'CASCADE' },
  { alvo: 'empresas', tabela: 'regras_fiscais', colunas: ['empresa_id'], acao: 'CASCADE' },
  { alvo: 'empresas', tabela: 'auditoria', colunas: ['empresa_id'], acao: 'NO_ACTION' },
];

/** Código `confdeltype` do PostgreSQL → ação referencial. */
export function acaoDeCodigo(codigo: string | null | undefined): AcaoReferencial {
  switch (String(codigo || '').toLowerCase()) {
    case 'a':
      return 'NO_ACTION';
    case 'r':
      return 'RESTRICT';
    case 'c':
      return 'CASCADE';
    case 'n':
      return 'SET_NULL';
    case 'd':
      return 'SET_DEFAULT';
    default:
      return 'LOGICO';
  }
}

/** Uma FK NO ACTION/RESTRICT impede o DELETE; as demais apenas acompanham. */
export function acaoImpeditiva(acao: AcaoReferencial): boolean {
  return acao === 'NO_ACTION' || acao === 'RESTRICT';
}

/** Entre duas ações, a "mais forte" (a que decide o comportamento do DELETE). */
const FORCA_ACAO: AcaoReferencial[] = ['NO_ACTION', 'RESTRICT', 'SET_DEFAULT', 'SET_NULL', 'CASCADE', 'LOGICO'];
export function acaoMaisForte(a: AcaoReferencial, b: AcaoReferencial): AcaoReferencial {
  return FORCA_ACAO.indexOf(a) <= FORCA_ACAO.indexOf(b) ? a : b;
}

// ----------------------------------------------------------------------------
// 3) VÍNCULOS LÓGICOS — referências por coluna textual, sem FK no banco.
//
//    São relações REAIS do sistema (gravadas pelos próprios módulos), mas o
//    banco não as protege. O diagnóstico as classifica por política:
//      • auditoria            → trilha preservada, NÃO bloqueia;
//      • lançamentos (venda)  → histórico financeiro, BLOQUEIA;
//      • impressão            → operacional, não bloqueia;
//      • anexos               → removidos junto, não bloqueia.
// ----------------------------------------------------------------------------
export type VinculoLogico = {
  tabela: string;
  modulo: string;
  icone: string;
  unidade: [string, string];
  tipo: TipoVinculo;
  politica: PoliticaVinculo;
  motivo: string;
  escopoEmpresa: boolean;
  /** Colunas → valores que identificam os dependentes deste registro. */
  chave: (r: Resource, id: number) => Record<string, string | number | Array<string | number>> | null;
};

/** `referencia_tipo` usado pelo Financeiro para cada origem. */
const REFERENCIA_FINANCEIRA: Record<string, string> = {
  vendas: 'venda',
  compras: 'compra',
};

/** Prefixo de `print_jobs.source_ref` (`<prefixo>:<id>`) por recurso. */
const PREFIXO_IMPRESSAO: Record<string, string> = {
  vendas: 'venda',
  compras: 'compra',
  ordens: 'ordem',
  propostas: 'proposta',
  cotacoes_compra: 'cotacao_compra',
};

export const VINCULOS_LOGICOS: VinculoLogico[] = [
  {
    tabela: 'auditoria',
    modulo: 'Auditoria',
    icone: 'auditoria',
    unidade: ['evento', 'eventos'],
    tipo: 'trilha',
    politica: 'seguir',
    motivo: 'a trilha de auditoria permanece registrada — ela não impede a exclusão',
    escopoEmpresa: true,
    chave: (r, id) => ({ recurso: r.key, registro_id: id }),
  },
  {
    tabela: 'lancamentos_financeiros',
    modulo: 'Financeiro',
    icone: 'financeiro',
    unidade: ['lançamento', 'lançamentos'],
    tipo: 'historico',
    politica: 'proteger',
    motivo: 'histórico financeiro: contas a receber/pagar, parcelas e baixas desta origem',
    escopoEmpresa: true,
    chave: (r, id) => (REFERENCIA_FINANCEIRA[r.key] ? { referencia_tipo: REFERENCIA_FINANCEIRA[r.key], referencia_id: id } : null),
  },
  {
    tabela: 'print_jobs',
    modulo: 'Impressão',
    icone: 'impressao',
    unidade: ['trabalho', 'trabalhos'],
    tipo: 'operacional',
    politica: 'seguir',
    motivo: 'trabalhos de impressão já enfileirados para este documento',
    escopoEmpresa: true,
    chave: (r, id) => {
      const prefixo = PREFIXO_IMPRESSAO[r.key];
      return prefixo ? { source_ref: [`${prefixo}:${id}`, `${r.key}:${id}`] } : null;
    },
  },
  {
    tabela: 'arquivos',
    modulo: 'Anexos',
    icone: 'anexos',
    unidade: ['anexo', 'anexos'],
    tipo: 'anexo',
    politica: 'seguir',
    motivo: 'anexos do registro — são removidos junto com ele',
    escopoEmpresa: false,
    chave: (r, id) => ({ recurso: r.key, registro_id: id }),
  },
];

// ----------------------------------------------------------------------------
// 4) Classificação de um vínculo.
// ----------------------------------------------------------------------------
export function infoDaTabela(tabela: string): InfoModulo {
  const info = MODULOS_POR_TABELA[tabela];
  if (info) return info;
  const recurso = Object.values(RESOURCES).find((x) => x.table === tabela);
  return {
    modulo: recurso?.label || tabela,
    icone: 'sistema',
    unidade: ['registro', 'registros'],
  };
}

function regraDe(alvoTabela: string, tabela: string, colunas: string[]): RegraRelacao | null {
  const chaves = colunas.map((c) => `${alvoTabela}.${tabela}.${c}`);
  const exata = REGRAS_RELACAO.find((x) => x.coluna && chaves.includes(`${x.alvo}.${x.tabela}.${x.coluna}`));
  if (exata) return exata;
  const porTabela = REGRAS_RELACAO.find((x) => !x.coluna && x.alvo === alvoTabela && x.tabela === tabela);
  if (porTabela) return porTabela;
  const global = REGRAS_RELACAO.find((x) => !x.coluna && !x.alvo && x.tabela === tabela);
  return global ?? null;
}

/**
 * Traduz uma relação crua em vínculo classificado.
 * `alvoTabela` é a tabela do registro que se pretende excluir.
 *
 * Regras:
 *   • vínculo LÓGICO (sem FK) usa os metadados declarados em VINCULOS_LOGICOS;
 *   • COMPOSIÇÃO nunca bloqueia: o serviço remove os filhos do próprio registro
 *     ANTES do DELETE (a FK continua sendo a última linha de defesa);
 *   • DESVINCULAR nunca bloqueia: a rotina de exclusão desfaz o vínculo antes;
 *   • o resto bloqueia por FK impeditiva (NO ACTION/RESTRICT) ou por POLÍTICA
 *     de proteção do histórico.
 */
export function classificarRelacao(alvoTabela: string, rel: RelacaoDependente): VinculoDependencia {
  // Vínculo LÓGICO (sem FK): os metadados vêm do próprio descritor. Sem isto,
  // `lancamentos_financeiros` cairia no default "trilha" e não protegeria nada.
  const logico = rel.fk ? null : VINCULOS_LOGICOS.find((l) => l.tabela === rel.tabela) ?? null;
  const info = logico ? { modulo: logico.modulo, icone: logico.icone, unidade: logico.unidade } : infoDaTabela(rel.tabela);
  const regra = regraDe(alvoTabela, rel.tabela, rel.colunas);
  const tipo: TipoVinculo = logico?.tipo ?? regra?.tipo ?? (rel.fk ? 'operacional' : 'trilha');
  const politica: PoliticaVinculo = logico?.politica ?? regra?.politica ?? 'seguir';
  const impeditivo = rel.fk && acaoImpeditiva(rel.acao);
  const protegido = politica === 'proteger';
  const desvinculavel = politica === 'desvincular';
  const bloqueia = !desvinculavel && tipo !== 'composicao' && (impeditivo || protegido);
  const recurso = Object.values(RESOURCES).find((x) => x.table === rel.tabela)?.key ?? null;

  let motivo = logico?.motivo ?? regra?.motivo ?? '';
  if (!motivo) {
    if (tipo === 'composicao') motivo = 'faz parte da composição do próprio registro — é removido junto quando a exclusão é permitida';
    else if (tipo === 'trilha') motivo = 'trilha preservada — não impede a exclusão';
    else if (tipo === 'anexo') motivo = 'anexos do registro — são removidos junto com ele';
    else if (desvinculavel) motivo = 'vínculo desfeito na exclusão; o histórico permanece com o nome do local';
    else if (protegido) motivo = 'histórico protegido — a exclusão apagaria ou desligaria estes registros';
    else if (impeditivo) motivo = 'vínculo ativo — o banco recusa a exclusão enquanto estes registros existirem';
    else motivo = 'vínculo de acompanhamento — não impede a exclusão';
  }

  return {
    modulo: info.modulo,
    icone: info.icone,
    tabela: rel.tabela,
    colunas: rel.colunas,
    recurso,
    quantidade: rel.quantidade,
    ids: rel.ids,
    idsTruncados: rel.idsTruncados,
    unidade: info.unidade ?? ['registro', 'registros'],
    tipo,
    politica,
    acao: rel.acao,
    impeditivo,
    protegido,
    bloqueia,
    motivo,
  };
}

// ----------------------------------------------------------------------------
// 5) Montagem do diagnóstico (função PURA — recebe as relações já coletadas).
// ----------------------------------------------------------------------------
const ORDEM_TIPO: TipoVinculo[] = ['historico', 'operacional', 'composicao', 'trilha', 'anexo'];

function listaDeModulos(modulos: string[]): string {
  const unicos = [...new Set(modulos)];
  if (unicos.length <= 1) return unicos[0] ?? '';
  if (unicos.length === 2) return `${unicos[0]} e ${unicos[1]}`;
  return `${unicos.slice(0, -1).join(', ')} e ${unicos[unicos.length - 1]}`;
}

function orientacaoPadrao(r: Resource, row: Row, bloqueado: boolean): string {
  if (!bloqueado) return 'Nenhum vínculo impede a exclusão deste registro.';
  const status = String(row.status ?? '').toLowerCase();
  if (r.key === 'vendas') {
    if (status === 'cancelada') {
      return 'Este pedido deve permanecer como CANCELADO. A exclusão física não é permitida porque existem registros históricos vinculados.';
    }
    return 'Cancele o pedido (o estorno é automático) em vez de excluí-lo: o histórico de estoque, caixa, financeiro e fiscal precisa ser preservado.';
  }
  if (r.key === 'compras') {
    return 'Cancele a compra em vez de excluí-la: o recebimento e o histórico de estoque, financeiro e fiscal precisam ser preservados.';
  }
  if (r.key === 'colecoes') {
    return 'Desative a coleção (campo Ativo) em vez de excluí-la: ela sai das opções de novos cadastros, mas os produtos e o histórico continuam apontando para ela.';
  }
  if (r.fields.some((f) => f.name === 'ativo')) {
    return 'Desative o registro (campo Ativo) em vez de excluí-lo: o histórico do sistema depende dele.';
  }
  return 'Remova os vínculos indicados acima antes de excluir, ou mantenha o registro.';
}

export function montarDiagnostico(
  r: Resource,
  row: Row,
  relacoes: RelacaoDependente[],
  opts: { origem: 'postgresql' | 'memoria'; empresaId?: number }
): DiagnosticoDependencias {
  const id = Number(row.id);
  const empresaId = Number(opts.empresaId ?? row.empresa_id ?? 1);
  const rotulo = labelOf(r, row);

  const vinculos = relacoes
    .filter((rel) => rel.quantidade > 0)
    .map((rel) => classificarRelacao(r.table, rel))
    .sort((a, b) => {
      if (a.bloqueia !== b.bloqueia) return a.bloqueia ? -1 : 1;
      const t = ORDEM_TIPO.indexOf(a.tipo) - ORDEM_TIPO.indexOf(b.tipo);
      if (t !== 0) return t;
      if (a.modulo !== b.modulo) return a.modulo.localeCompare(b.modulo, 'pt-BR');
      return a.tabela.localeCompare(b.tabela);
    });

  const bloqueantes = vinculos.filter((v) => v.bloqueia);
  const bloqueado = bloqueantes.length > 0;
  const totalRegistros = vinculos.reduce((n, v) => n + v.quantidade, 0);
  const totalBloqueantes = bloqueantes.reduce((n, v) => n + v.quantidade, 0);
  const modulos = [...new Set(vinculos.map((v) => v.modulo))];
  const modulosBloqueantes = [...new Set(bloqueantes.map((v) => v.modulo))];

  const titulo = `Não é possível excluir ${r.singular} ${rotulo}`;
  const vendaCancelada = r.key === 'vendas' && String(row.status ?? '').toLowerCase() === 'cancelada';
  const resumo = bloqueado
    ? vendaCancelada
      ? `Venda cancelada com histórico. A exclusão física não é permitida — ${totalBloqueantes} ${totalBloqueantes === 1 ? 'registro vinculado' : 'registros vinculados'} em ${listaDeModulos(modulosBloqueantes)}.`
      : `${titulo}: existem ${totalBloqueantes} ${totalBloqueantes === 1 ? 'registro vinculado' : 'registros vinculados'} em ${listaDeModulos(modulosBloqueantes)}.`
    : `${r.singular} ${rotulo} não possui vínculos que impeçam a exclusão.`;

  return {
    recurso: r.key,
    recursoLabel: r.label,
    singular: r.singular,
    id,
    empresaId,
    rotulo,
    status: row.status === undefined || row.status === null ? null : String(row.status),
    origem: opts.origem,
    bloqueado,
    podeExcluir: !bloqueado,
    titulo,
    resumo,
    orientacao: orientacaoPadrao(r, row, bloqueado),
    totalRegistros,
    totalBloqueantes,
    modulos,
    modulosBloqueantes,
    vinculos,
    geradoEm: new Date().toISOString(),
  };
}

/**
 * Recursos cuja exclusão exige uma checagem PRÉVIA de histórico: a FK do banco
 * é CASCADE/SET NULL e, sozinha, apagaria ou desligaria a trilha em silêncio.
 * Calculado a partir do próprio mapa de regras (não de uma lista paralela).
 */
function recursoDaTabela(tabela: string): string | null {
  return Object.values(RESOURCES).find((x) => x.table === tabela)?.key ?? null;
}

/**
 * Erro HTTP 409 padrão de "exclusão bloqueada por vínculos".
 * `code` estável para o front abrir o modal de diagnóstico; o diagnóstico
 * completo vai em `details.dependencias`.
 */
export function erroDependencias(diag: DiagnosticoDependencias): HttpError {
  return new HttpError(409, diag.resumo, undefined, 'dependencias_vinculadas', { dependencias: diag });
}

export const RECURSOS_COM_HISTORICO_PROTEGIDO: ReadonlySet<string> = new Set(
  [
    // Recursos cujo DELETEs precisam de checagem PRÉVIA: alguma relação de
    // entrada tem política `proteger` (histórico que a FK CASCADE/SET NULL
    // apagaria ou desligaria em silêncio).
    ...REGRAS_RELACAO.filter((rg) => rg.politica === 'proteger').map((rg) => recursoDaTabela(rg.alvo)),
    // Vínculos lógicos protegidos (sem FK): só contam para o recurso que
    // realmente os possui.
    ...VINCULOS_LOGICOS.filter((l) => l.politica === 'proteger').flatMap((l) =>
      Object.values(RESOURCES)
        .filter((x) => l.chave(x, 1) !== null)
        .map((x) => x.key)
    ),
  ].filter((k): k is string => Boolean(k))
);

/** O recurso precisa checar vínculos históricos antes de tentar o DELETE? */
export function temHistoricoProtegido(r: Resource): boolean {
  return RECURSOS_COM_HISTORICO_PROTEGIDO.has(r.key);
}

/**
 * Avalia (no MemStore, sem catálogo) se uma coluna declarada como `ref` é, na
 * verdade, CASCADE/SET NULL/RESTRICT no PostgreSQL. Mantém o modo demonstração
 * alinhado ao banco quando a relação está mapeada.
 */
export function acaoDeclarada(tabelaDependente: string, coluna: string): AcaoReferencial {
  const rel = RELACOES_FK.find((x) => x.tabela === tabelaDependente && x.colunas.length === 1 && x.colunas[0] === coluna);
  return rel?.acao ?? 'NO_ACTION';
}

/** Relações de entrada declaradas para uma tabela (usado pelo MemStore). */
export function relacoesDeclaradasPara(alvoTabela: string): RelacaoFkDeclarada[] {
  return RELACOES_FK.filter((x) => x.alvo === alvoTabela);
}

/** Recursos com `ref` para a tabela-alvo (o MemStore não tem catálogo). */
export function refsPara(alvoTabela: string): Array<{ tabela: string; coluna: string; recurso: string }> {
  const out: Array<{ tabela: string; coluna: string; recurso: string }> = [];
  for (const outro of Object.values(RESOURCES)) {
    for (const f of outro.fields) {
      if (f.type !== 'ref' || !f.ref) continue;
      const alvo = getResource(f.ref);
      if (alvo?.table === alvoTabela) out.push({ tabela: outro.table, coluna: f.name, recurso: outro.key });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// 6) Validação de identificadores (defesa em profundidade ao montar SQL).
//    Mesmo vindo do catálogo, um nome só entra no SQL se for simples.
// ----------------------------------------------------------------------------
const IDENTIFICADOR = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function identificadorSeguro(nome: string): boolean {
  return IDENTIFICADOR.test(String(nome ?? ''));
}

export function citarIdentificador(nome: string): string {
  if (!identificadorSeguro(nome)) throw new Error(`Identificador inválido em metadado: ${nome}`);
  return `"${nome}"`;
}
