import { paymentsRouter, checkoutMethods } from '../../modules/payments/api/routes';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootFailure, dbStatus, hasDatabaseUrl, isDbConnected, isDbDegraded, migrate, migrationError } from './db';
import {
  ADMIN_EMAIL,
  changePassword,
  currentUser,
  ensureAdmin,
  forgotPassword,
  getPreferences,
  listarSessoes,
  login,
  loginMFA,
  logout,
  logoutAll,
  me,
  migrarSenhasLegadas,
  mfaDesafio,
  reautenticar,
  requireAuth,
  requireRole,
  resetPassword,
  revogarSessaoHandler,
  savePreferences,
  verificarAuditoriaHandler,
} from './auth';
import { mfaStatus, mfaSetup, mfaAtivar, mfaDesativar, mfaCodigos } from './mfa';
import { aceitarConvite, infoConvite, reenviarConvite, senhaTemporaria, resetarMfaUsuario, resumoUsuarios, atividadeUsuario, sessoesUsuario, desativarUsuario, ativarUsuario, desbloquearUsuario, bloquearUsuario, encerrarSessoesUsuario, revogarSessaoUsuario, forcarTrocaSenha, politicaSenhaPublica, obterPoliticaSenha, salvarPoliticaSenha, certificacaoUsuarios, exportarCertificacao, certificarUsuario } from './usuariosAdmin';
import { listarWebhooks, criarWebhook, atualizarWebhook, excluirWebhook, testarWebhook, listarEntregas, reenviarEntrega } from './webhooks';
import { limpezaPeriodica } from './sessoes';
import { getPublicResource, publicMeta } from './resources';
import { deleteFile, listFiles, serveFile, updateFile, uploadFile, uploadProvider, uploadsConfigError } from './uploads';
import { produtoTamanhos, productDetail } from './detail';
import { buscarProdutos } from './productSearch';
import { createItem, deleteItem, listItens, updateItem } from './itens';
import {
  checkAccess,
  createRecord,
  diagnosticarDependencias,
  escopoDe,
  deleteRecord,
  getDefaultLocalInfo,
  getRecord,
  getStore,
  listRecords,
  optionsFor,
  toHttpError,
  updateRecord,
  metaComOpcoesDinamicas,
} from './services';
import { parseId } from './validate';
import { HttpError } from './errors';
import { assertProductionSecrets, bloquearSenhaProvisoria, corsOrigin, loginRateLimit, securityHeaders, trustProxySetting } from './security';
import { initSentry, log, reportarErro } from './log';
import { requestObservability } from './observability';
import { smtpConfigurado } from './mail';
import { carregarOrigemDoBanco, revisarConfiguracaoOrigem, statusOrigemAsync } from './urlPublica';
import { obterEnderecoPublico, removerEnderecoPublico, salvarEnderecoPublico } from './configSistema';
import { estoqueDisponivel, estoqueGrade, estornarMovimentacao, fecharInventario, getInventarioDetalhe, listItensInventario, updateItensInventario, conferirContagemCiclica, aprovarContagemCiclica, cancelarContagemCiclica } from './estoque';
import { criarContagemCiclica, listarPlanosContagemCiclica } from './contagemCiclica';
import { getMedidasGrade, resumoMedidasGrades, saveMedidasGrade } from './medidas';
import { listarEventosTerceirizacao, registrarEventoTerceirizacao } from './terceirizacao';
import { relatorio } from './relatorios';
import { exportarRecurso } from './export';
import { confirmarImportacao, modeloImportacao, previewImportacao } from './importacao';
import {
  aplicarPrecoFicha,
  cancelarOrdem,
  concluirOrdemHandler,
  criarApontamento,
  iniciarOrdem,
  liberarOrdem,
  listApontamentos,
  listEventosOrdem,
  planejamentoProducao,
  producaoPainel,
  reabrirOrdem,
  createInsumoFicha,
  createItemOrdem,
  deleteInsumoFicha,
  deleteItemOrdem,
  listInsumosFicha,
  listItensOrdem,
  updateInsumoFicha,
  updateItemOrdem,
} from './producao';
import { adminBackup, adminBackupXlsx, backupInfo } from './backup';
import { catalogoEmbed, catalogoPublico, compartilharCatalogo, criarPedidoCatalogo, eventoCatalogo, inteligenciaCatalogos, rateLimitPublico, revogarCompartilhamento } from './catalogos';
// ---- BROBOND COMMERCE OS (0068) — vitrine pública + operação omnichannel ----
import {
  listarProdutosCommerce,
  obterProdutoCommerce,
  projetarProdutoCommerce,
  atualizarProdutoCommerce,
  salvarPrecoCanal,
  publicarProduto,
  listarPublicacoes,
  obterPublicacaoCommerce,
  listarOfertasCommerce,
  obterOfertaCommerce,
  reprocessarPublicacao,
  despublicarProduto,
} from './commerce/catalogo';
import {
  lojaConfigPublica,
  lojaProdutoPublico,
  lojaPreview,
  lojaCriarCheckout,
  lojaPedidoPublico,
  lojaProdutosPublicos,
} from './commerce/vitrine';
import {
  cancelarPedidoCommerce,
  converterPedidoCommerce,
  detalharPedidoCommerce,
  listarDeliveryCommerce,
  listarErrosCommerce,
  listarEventosCommerce,
  listarFulfillmentCommerce,
  listarPagamentosCommerce,
  listarPedidosCommerce,
  listarReservasCommerce,
  registrarHooksCommerce,
  salvarRastreioCommerce,
} from './commerce/pedidos';
import {
  criarCupom,
  criarPromocao,
  excluirCupom,
  excluirPromocao,
  atualizarCupom,
  atualizarPromocao,
  listarCupons,
  listarPromocoes,
} from './commerce/promocoes';
import { estadoLoja } from './commerce/estado-loja';
import { capacidadesCreators, listCreatorsEntity, detailCreatorsEntity, createCreatorsEntity, updateCreatorsEntity, listCreatorAttributions } from './creators';
import { analyticsCommerce, trendsCommerce } from './commerce/analytics';
import { processarComercioAgendado, reprocessarOutbox } from './commerce/outbox';
import { baixarLancamento, conciliarExtrato, cronRecorrencias, criarLancamentoManual, gerarRecorrencias, recebiveisCartao, rentabilidade, resumoFinanceiro, resumoInvestidores } from './financeiro';
import { comissoesDaVenda, resumoComissoes } from './comissoes';
import {
  apiAcompanhamentoMeta,
  apiApurarComissao,
  apiArvoreTerritorios,
  apiIndicadores,
  apiPainelRepresentante,
} from './comercial';
import {
  cancelarCobranca,
  configurarGateway,
  criarCobranca,
  cronWebhooks,
  detalheCobranca,
  estornarCobranca,
  listarCobrancas,
  listarEventosWebhook,
  listarGateways,
  reprocessarEvento,
} from './gateway';
import { conciliarLinhaManual, importarExtrato, listarExtrato, marcarDivergencia } from './extrato';
import { importarCnab, listarParsersHandler } from './cnab';
import { vendaPDF, compraPDF } from './pdf';
import { produtoQRCode, produtoQRCodeSVG, produtoQRDados, produtoEtiquetaQR } from './qrcode';
import { listAprovacoes, aprovarPedido, rejeitarPedido, countAprovacoes } from './approval';
import { runScheduled, cronScheduled, scheduledStatus } from './scheduled';
import { listQualidade, createQualidade, relatorioQualidade } from './quality';
import { predicaoDemanda, predicaoInsumos } from './prediction';
import { rateLimitPortal, administrarAcessosPortal, decidirCotacao, gerarAcessoPortal, portalPedidos, portalPedidoDetalhe, recomprarPedido, revogarAcessoPortal } from './portal';
import { clientePorDocumentoHandler } from './clientes';
import { notificacoesStatus, verificarAlertasEstoque } from './notifications';
import { openapiJSON, openapiUI } from './openapi';
import { listConversas, listMensagens, sendMessage, countNaoLidas } from './chat';
import { nfeDados, nfeEmitir, nfeStatus } from './nfe';
import {
  emitirDocumento,
  previaDocumento,
  situacaoFiscalVenda,
  eventosDocumento,
  consultarDocumento,
  cancelarDocumento,
  inutilizarNumeracao,
  obterConfigFiscal,
  salvarConfigFiscal,
} from './fiscal';
import { consultarCepHandler } from './cep';
import { gerarVariacoes, listarVariacoes, previaVariacoes } from './variacoes';
import { importarXmlCompra, packingCheck } from './suprimentos';
import { calcularFrete, consultarCEP } from './frete';
// ------------------------- FASE P1 ------------------------------------------
import {
  gravarItensLista,
  historicoLista,
  listarItensLista,
  precoProduto,
  removerItemLista,
  resolverLista,
} from './listasPreco';
import {
  aprovarProposta,
  cancelarProposta,
  converterProposta,
  criarProposta,
  detalharProposta,
  enviarProposta,
  eventosProposta,
  listarItens as listarItensProposta,
  recusarProposta,
  reescreverItens as reescreverItensProposta,
} from './propostas';
import {
  aprovarTransferencia,
  calcularDisponibilidade as _calcularDisponibilidade,
  cancelarTransferencia,
  criarReserva,
  criarTransferencia,
  detalharTransferencia,
  disponibilidadeHandler,
  expedirTransferencia,
  liberarReserva,
  receberTransferencia,
} from './estoqueTransferencia';
import {
  agendaDeAtividades,
  converterLead,
  forecastCrm,
  historicoDaOportunidade,
  mudarEstagioOportunidade,
  painelCrm,
  reordenarEtapasDoFunil,
} from './crm';
import {
  abrirCaixa,
  buscarProduto as pdvBuscarProduto,
  caixaAberto,
  cancelarVendaPdv,
  cupomPdvHtmlHandler,
  cupomPdvPdfHandler,
  emitirCupomPdvHandler,
  fecharCaixa,
  movimentoCaixa,
  pagamentosVenda,
  reimprimirCupomPdvHandler,
  resumoCaixaHandler,
  venderPdv,
} from './pdv';
import {
  cancelarJobHandler,
  criarJobHandler,
  detalheJobHandler,
  listarJobsHandler,
  manutencaoImpressaoHandler,
  reimprimirJobHandler,
  resumoOperacionalImpressaoHandler,
  retryJobHandler,
} from './printJobs';
import {
  atualizarAgenteHandler,
  autenticarAgente,
  claimHandler as printClaimHandler,
  criarCodigoPareamentoHandler,
  exigirNonceAgente,
  failHandler as printFailHandler,
  heartbeatHandler as printHeartbeatHandler,
  leaseHandler as printLeaseHandler,
  listarAgentesHandler,
  listarImpressorasDetectadasHandler,
  parearAgenteHandler,
  printedHandler as printPrintedHandler,
  printingHandler as printPrintingHandler,
  reativarAgenteHandler,
  revogarAgenteHandler,
  rotacionarTokenHandler as printRotacionarTokenHandler,
} from './printAgents';
import {
  atualizarTerminalHandler,
  criarTerminalHandler,
  listarTerminaisHandler,
  removerTerminalHandler,
} from './printTerminals';
import {
  fallbackHtmlJobHandler,
  fallbackPdfJobHandler,
} from './printFallback';
import {
  fallbackDocumentoHtmlHandler,
  fallbackDocumentoPdfHandler,
  imprimirDocumentoHandler,
  imprimirTesteTerminalHandler,
  reimprimirDocumentoHandler,
} from './printDocuments';
import {
  imprimirEtiquetasHandler,
  imprimirEtiquetasProdutoHandler,
} from './printLabels';
import {
  atualizarStatusEnvio,
  buscarPorCodigo as buscarEnvioPorCodigo,
  cancelarEnvio,
  cotarFrete,
  envioDaVenda,
  eventosEnvio,
  gerarEnvio,
  obterConfigHandler as obterConfigLogisticaHandler,
  rastrearEnvio,
  salvarConfigHandler as salvarConfigLogisticaHandler,
} from './logistica';
import {
  autorizarDevolucao,
  cancelarDevolucao,
  conferirPedido,
  criarDevolucao,
  embalarPedido,
  expedirPedido,
  listarDivergencias,
  obterDevolucao,
  receberDevolucao,
  recusarDevolucao,
  registrarRastreamento,
  resolverDivergencia,
  separarPedido,
  situacaoExpedicao,
} from './expedicao';
import {
  aprovarCompra,
  gerarCompraDaSugestao,
  listarRecebimentos,
  receberParcial,
  sugestaoCompra,
} from './compras';
import { capacidadeProducao, mrpProducao } from './producaoCapacidade';
import {
  calendarioFiscal,
  historicoObrigacaoFiscal,
  registrarEntregaFiscal,
} from './fiscalObrigacoes';
import { listarEvidenciasFiscais, listarExecucoesFiscais, executarObrigacaoFiscal, registrarEvidenciaFiscal } from './fiscalExecucoes';
import { balanceteFinanceiro, resumoPlanoContas } from './financeiroContabil';
import { listarPeriodos, obterPeriodo, alterarPeriodo } from './financeiroPeriodos';
import {
  confirmarImportacaoContabil,
  confirmarImportacaoPlano,
  previewImportacaoContabil,
  previewImportacaoPlano,
} from './financeiroImportacao';
import { listarConversoes } from './unidades';
import {
  alterarHomologacao,
  desempenhoDoFornecedor,
  homologacaoDoFornecedor,
  painelDeCompras,
} from './comprasFornecedor';
import {
  abrirCotacao,
  atualizarItemCotacao,
  cancelarCotacao,
  comparativoCotacao,
  convidarFornecedores,
  cotarFornecedor,
  criarItemCotacao,
  decidirCotacaoCompra,
  recusarCotacao,
  removerItemCotacao,
} from './cotacoesCompra';
import { marketplaceStatus, sincronizarPedidos } from './marketplace';
import { connectorsRouter, initConnectors, publicConnectorsRouter } from './connectors';
import { publicGatewayRouter } from './gateway';
import { importarPedidosLoja, produtosLoja, sincronizarEstoqueLoja, statusLoja } from './loja';
import {
  initNegociosEngine,
  negociosABC,
  negociosABCRecalcular,
  negociosCanais,
  negociosMargens,
  negociosMargensRecalcular,
  negociosResumo,
  negociosVendaManual,
} from './negocios';
import { initWebSocket, wsStatus } from './websocket';
import { concederEmpresa, empresaAtiva, listarEmpresasDoUsuario, revogarEmpresa, trocarEmpresaAtiva } from './empresasApi';
import { createServer } from 'node:http';

assertProductionSecrets();
// Links de e-mail (convite de acesso, redefinição) só funcionam com origem absoluta.
// Avisamos no boot em vez de deixar o usuário descobrir que o link é "URL inválida".
const AVISO_ORIGEM = revisarConfiguracaoOrigem();
initSentry();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = process.env.npm_package_version || '0.6.0';
const app = express();

app.disable('x-powered-by');
// SEC-02: confiança de proxy EXPLÍCITA por ambiente (TRUST_PROXY). Padrão
// seguro: sem configuração, os cabeçalhos X-Forwarded-* NÃO são aceitos e o IP
// (rate limit, sessões, auditoria) é o da conexão TCP real — um cliente não
// consegue trocar de bucket forjando o X-Forwarded-For. Produção na Render
// define TRUST_PROXY=1 no render.yaml (um proxy confiável).
app.set('trust proxy', trustProxySetting());
app.use(securityHeaders);
app.use(requestObservability);
// Endpoints públicos também são consumidos por FORA do ERP: o site de varejo
// (brobond.com.br) busca o catálogo por JavaScript e o incorpora em iframe.
// Liberamos a leitura por CORS (sem credenciais, sem cookie) — os dados do
// catálogo já são públicos pelo próprio token do link.
app.use('/api/publico', (req: Request, res: Response, next: NextFunction) => {
  res.removeHeader('Access-Control-Allow-Credentials'); // ACAO "*" não combina com credenciais
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(
  cors({
    origin: corsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID', 'X-Correlation-ID'],
    exposedHeaders: ['X-Request-ID', 'X-Correlation-ID'],
  })
);
// O cors() global roda depois do middleware público e recoloca
// Access-Control-Allow-Credentials: ele não combina com Allow-Origin "*"
// (navegador ignora). Endpoints públicos são anônimos — sem cookie, sem sessão.
app.use('/api/publico', (_req: Request, res: Response, next: NextFunction) => {
  res.removeHeader('Access-Control-Allow-Credentials');
  next();
});
// Conectores de marketplace: callbacks de OAuth e webhooks de pedido chegam
// de FORA (Mercado Livre, Mercado Pago, Nuvemshop), sem cookie e sem
// Bearer. O router é montado aqui — depois do cors(), ANTES do express.json()
// e muito antes de requireAuth/bloquearSenhaProvisoria — por dois motivos:
// (1) a sessão do ERP nunca pode barrar um provedor externo e (2) a assinatura
// HMAC é calculada sobre os BYTES CRUS, que o parser JSON destruiria. Segmento
// que não seja um dos quatro provedores cai no next() e segue para as rotas de
// sempre (inclusive o CRUD autenticado de /api/webhooks).
app.use(publicConnectorsRouter);
// P2: webhooks de GATEWAY DE PAGAMENTO também chegam de fora, sem sessão, com
// assinatura sobre os bytes crus. Mesmo padrão do router de conectores: monta
// antes do express.json() e do requireAuth. Provedor desconhecido cai no 404
// do próprio router; nada aqui afeta as rotas autenticadas.
app.use(publicGatewayRouter);

app.use(express.json({ limit: '4mb' })); // fotos chegam em base64 (já reduzidas no navegador)
app.use(express.urlencoded({ extended: true }));

/** Envolve handlers async e encaminha erros para o middleware global. */
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Carrega o recurso da rota (404 se não existir). */
function resourceParam(req: Request, _res: Response, next: NextFunction) {
  const r = getPublicResource(req.params.resource);
  if (!r) return next(new HttpError(404, 'Recurso não encontrado'));
  (req as any).resource = r;
  next();
}

// ----------------------------------------------------------------------------
// Público
// ----------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  // PROD-DB-01.2 — três estados explícitos (nunca confundir degradado com
  // demonstração):
  //   db:"memory"            → modo demonstração (sem DATABASE_URL);
  //   db:"postgres"          → PostgreSQL conectado E pronto (200);
  //   db:"postgres-degraded" → DATABASE_URL configurada, banco NÃO pronto (503).
  // A Render usa este path como healthCheckPath: só promove a instância com 200,
  // ou seja, apenas em `ready`. O corpo NÃO expõe o texto do erro (pode conter
  // nomes de tabela/coluna) — ele fica no log e em `migrationError()`. A FASE
  // que falhou (PROD-DB-02: 'bootstrap' vs 'migrations') é exposta porque é
  // diagnóstico operacional, não dado sensível.
  const status = dbStatus();
  const db = status === 'demo' ? 'memory' : status === 'ready' ? 'postgres' : 'postgres-degraded';
  const fase = status === 'degraded' ? bootFailure()?.fase : undefined;
  const body = { ok: status !== 'degraded', db, ...(fase ? { fase } : {}), uploads: uploadProvider(), version: VERSION };
  if (status === 'degraded') return res.status(503).json(body);
  res.json(body);
});

// ----------------------------------------------------------------------------
// PROD-DB-01.1 — prontidão do banco obrigatório.
//
// Quando DATABASE_URL existe mas o banco não está pronto (falha da cadeia
// versionada ou bootstrap do db/schema.sql incompleto), a instância NÃO pode
// atender negócio: serviria com schema desatualizado — foi assim que /vendas
// respondeu 42703 em produção. O health responde 503 (a Render não promove a
// instância) e este middleware bloqueia as rotas de negócio. Só continuam
// respondendo o health e a autenticação (necessária para diagnóstico/acesso);
// os webhooks dos provedores são montados antes do express.json() e seguem
// intactos. Sem DATABASE_URL (modo demonstração) nada aqui bloqueia.
// ----------------------------------------------------------------------------
const ROTAS_PERMITIDAS_SEM_BANCO_PRONTO = [/^\/api\/auth\//];
function bloqueioDeProntidao(req: Request, res: Response, next: NextFunction) {
  if (!isDbDegraded()) return next();
  if (req.path === '/api/health') return next();
  if (ROTAS_PERMITIDAS_SEM_BANCO_PRONTO.some((re) => re.test(req.path))) return next();
  return res.status(503).json({ error: 'Banco de dados não está pronto. O serviço está indisponível até a migração concluir.' });
}
app.use(bloqueioDeProntidao);
app.post('/api/auth/login', loginRateLimit, wrap(login));
// Segundo fator do login (TOTP): ticket de 10 min emitido no 1º passo.
app.post('/api/auth/login/mfa', wrap(loginMFA));
// QR/segredo do cadastro TOTP guiado (exige o ticket do 1º passo).
app.post('/api/auth/mfa/desafio', wrap(mfaDesafio));
// "Esqueci minha senha" — públicos (mesmo limite de tentativas do login)
app.post('/api/auth/forgot', loginRateLimit, wrap(forgotPassword));
app.post('/api/auth/reset', wrap(resetPassword));
// Convites de acesso (público + rate limit): validar e aceitar
app.get('/api/convites/:token', wrap(infoConvite));
app.post('/api/convites/aceitar', loginRateLimit, wrap(aceitarConvite));
// Regras públicas da política de senha (medidor das telas de convite/reset)
app.get('/api/auth/politica-senha', wrap(politicaSenhaPublica));
// Catálogo público (somente leitura; rate limit próprio)
app.get('/api/publico/catalogo/:token', rateLimitPublico, wrap(catalogoPublico));
// Versão incorporável (iframe) do catálogo — usada no site de varejo.
app.get('/api/publico/catalogo/:token/embed', rateLimitPublico, wrap(catalogoEmbed));
// Pedido pelo catálogo — cria uma cotação de venda no ERP (sem login, rate limit)
app.post('/api/publico/catalogo/:token/pedido', rateLimitPublico, wrap(criarPedidoCatalogo));
app.post('/api/publico/catalogo/:token/evento', rateLimitPublico, wrap(eventoCatalogo));
// ---- VITRINE PRÓPRIA /loja (Commerce OS) — pública, rate limit próprio ----
// Loja B2C do tenant resolvido por env/unicidade (nunca por dado do cliente).
app.get('/api/loja/config', rateLimitPublico, wrap(lojaConfigPublica));
app.get('/api/loja/produtos', rateLimitPublico, wrap(lojaProdutosPublicos));
app.get('/api/loja/produtos/:slug', rateLimitPublico, wrap(lojaProdutoPublico));
app.post('/api/loja/preview', rateLimitPublico, wrap(lojaPreview));
app.post('/api/loja/payment-methods', rateLimitPublico, wrap(checkoutMethods));
app.post('/api/commerce/checkout/payment-intent', rateLimitPublico, wrap(lojaCriarCheckout));
app.post('/api/loja/checkout', rateLimitPublico, wrap(lojaCriarCheckout));
app.get('/api/loja/pedidos/:token', rateLimitPublico, wrap(lojaPedidoPublico));
// Portal do cliente (acompanhamento de pedidos por CPF/CNPJ)
app.get('/api/portal/:token/pedidos', rateLimitPortal, wrap(portalPedidos));
app.get('/api/portal/:token/pedido/:id', rateLimitPortal, wrap(portalPedidoDetalhe));
app.post('/api/portal/:token/pedido/:id/decisao', rateLimitPortal, wrap(decidirCotacao));
app.post('/api/portal/:token/pedido/:id/recomprar', rateLimitPortal, wrap(recomprarPedido));
// Imagens armazenadas no banco: URL pública protegida por token aleatório
app.get('/api/files/:id/:token', wrap(serveFile));

// ----------------------------------------------------------------------------
// IMPRESSÃO P1 — rotas do AGENTE LOCAL (machine identity, sem JWT de usuário).
//
// Montadas de propósito ANTES do requireAuth: o agente não é um usuário e a
// sessão do ERP nunca pode barrá-lo (mesmo racional dos webhooks públicos).
// A autenticação aqui é a da máquina: pareamento por código temporário de
// uso único; depois, Bearer de machine token revogável + nonce anti-replay
// nas chamadas mutantes (printAgents.ts). O bloqueioDeProntidao (acima)
// continua valendo: sem banco pronto, o agente recebe 503 e tenta de novo.
// ----------------------------------------------------------------------------
app.post('/api/print/agent/pair', wrap(parearAgenteHandler));
app.post('/api/print/agent/heartbeat', autenticarAgente, exigirNonceAgente, wrap(printHeartbeatHandler));
app.post('/api/print/agent/claim', autenticarAgente, exigirNonceAgente, wrap(printClaimHandler));
app.post('/api/print/agent/jobs/:id/printing', autenticarAgente, exigirNonceAgente, wrap(printPrintingHandler));
app.post('/api/print/agent/jobs/:id/printed', autenticarAgente, exigirNonceAgente, wrap(printPrintedHandler));
app.post('/api/print/agent/jobs/:id/fail', autenticarAgente, exigirNonceAgente, wrap(printFailHandler));
app.post('/api/print/agent/jobs/:id/lease', autenticarAgente, exigirNonceAgente, wrap(printLeaseHandler));

// ----------------------------------------------------------------------------
// Autenticado
// ----------------------------------------------------------------------------
app.use('/api', wrap(requireAuth));
// Conta com senha provisória (convite, reset ou admin padrão) só lê e só escreve
// no próprio fluxo de troca de senha — ver bloquearSenhaProvisoria.
app.use('/api', bloquearSenhaProvisoria);

// PROD-DB-01.3 — o acesso de emergência (id 0, perfil 'admin') é um ADMIN
// SINTÉTICO: existe para diagnóstico e recuperação enquanto o banco está fora,
// não para operar. Sem esta lista explícita, o token passava por requireRole e
// chegava a handlers administrativos/escrita. Aqui ele fica restrito a
// diagnóstico estritamente leitura + encerrar a própria sessão. Qualquer outra
// rota responde 403 (negado por desenho) — as rotas de negócio já respondem 503
// pelo bloqueioDeProntidao, que roda antes. `requireAuth` (acima) garante que
// esse token só é aceito no estado degradado.
const ROTAS_EMERGENCIA: Array<[string, string]> = [
  ['GET', '/auth/me'],
  ['GET', '/auth/politica-senha'],
  ['POST', '/auth/logout'],
];
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const u = (req as { user?: { id?: number } }).user;
  if (!u || Number(u.id) > 0) return next();
  // `req.path` é relativo ao mount (`/api`): comparar sem o prefixo.
  const caminho = req.baseUrl + req.path;
  const permitida = ROTAS_EMERGENCIA.some(([metodo, rota]) => req.method === metodo && caminho === `/api${rota}`);
  if (permitida) return next();
  return res.status(403).json({
    error: 'O acesso de emergência é restrito a diagnóstico e recuperação enquanto o banco está indisponível.',
    code: 'EMERGENCIA_RESTRITA',
  });
});

// SEC-03 — TODO o prefixo /api/admin/* exige privilégio administrativo
// verificado no SERVIDOR (guard canônico requireRole, derivado da identidade
// autenticada do JWT/sessão — nunca de role/perfil/empresa_id do cliente).
// O `admin` do caminho não autoriza nada por si: sem este guard, um gerente
// autenticado alcançava dados globais (auditoria, status, crons, backup).
// Administradores reais seguem entrando normalmente; qualquer outro perfil
// autenticado recebe 403. O acesso de emergência (id 0) NÃO alcança este
// prefixo: o guard de emergência acima o barra antes.
app.use('/api/admin', requireRole('admin'));

app.get('/api/auth/me', me);
app.post('/api/auth/change-password', wrap(changePassword));
// Reautenticação (step-up): confirma a senha para ações sensíveis (5 min).
app.post('/api/auth/reautenticar', wrap(reautenticar));
// Sessões por dispositivo
app.post('/api/auth/logout', wrap(logout));
app.post('/api/auth/logout-all', wrap(logoutAll));
app.get('/api/auth/sessoes', wrap(listarSessoes));
app.post('/api/auth/sessoes/:sid/revogar', wrap(revogarSessaoHandler));
// MFA/TOTP (autogerenciado)
app.get('/api/auth/mfa/status', wrap(mfaStatus));
app.post('/api/auth/mfa/setup', wrap(mfaSetup));
app.post('/api/auth/mfa/ativar', wrap(mfaAtivar));
app.post('/api/auth/mfa/desativar', wrap(mfaDesativar));
app.post('/api/auth/mfa/codigos', wrap(mfaCodigos));
// Preferências por usuário (Fase 7 — JSONB no banco, espelhadas no navegador)
app.get('/api/auth/preferences', wrap(getPreferences));
app.put('/api/auth/preferences', wrap(savePreferences));
// Administração de acesso: convite, senha temporária (exibição única), MFA de terceiros
app.post('/api/usuarios/:id/senha-temporaria', wrap(senhaTemporaria));
app.post('/api/usuarios/:id/reenviar-convite', wrap(reenviarConvite));
app.post('/api/usuarios/:id/resetar-mfa', wrap(resetarMfaUsuario));
// Gestão profissional de usuários (admin): painel, ficha e ciclo de vida.
// (Antes das rotas genéricas: /api/usuarios/resumo não pode cair em /:id.)
app.get('/api/usuarios/resumo', wrap(resumoUsuarios));
// Onda 4: política de senha + certificação (antes das rotas genéricas)
app.get('/api/usuarios/politica-senha', wrap(obterPoliticaSenha));
app.put('/api/usuarios/politica-senha', wrap(salvarPoliticaSenha));
app.get('/api/usuarios/certificacao', wrap(certificacaoUsuarios));
app.get('/api/usuarios/certificacao/export', wrap(exportarCertificacao));
app.post('/api/usuarios/:id/certificar', wrap(certificarUsuario));
// Endereço público do ERP (base dos links de e-mail/portal/QR) — configuração
// self-service do admin: resolve o "URL inválida" sem redeploy (configSistema.ts).
app.get('/api/admin/config/endereco-publico', wrap(obterEnderecoPublico));
app.put('/api/admin/config/endereco-publico', wrap(salvarEnderecoPublico));
app.delete('/api/admin/config/endereco-publico', wrap(removerEnderecoPublico));
// Onda 4: webhooks de eventos de usuário (admin)
app.get('/api/webhooks', wrap(listarWebhooks));
app.post('/api/webhooks', wrap(criarWebhook));
app.put('/api/webhooks/:id', wrap(atualizarWebhook));
app.delete('/api/webhooks/:id', wrap(excluirWebhook));
app.post('/api/webhooks/:id/testar', wrap(testarWebhook));
app.get('/api/webhooks/:id/entregas', wrap(listarEntregas));
app.post('/api/webhooks/entregas/:id/reenviar', wrap(reenviarEntrega));
app.get('/api/usuarios/:id/atividade', wrap(atividadeUsuario));
app.get('/api/usuarios/:id/sessoes', wrap(sessoesUsuario));
app.post('/api/usuarios/:id/desativar', wrap(desativarUsuario));
app.post('/api/usuarios/:id/ativar', wrap(ativarUsuario));
app.post('/api/usuarios/:id/desbloquear', wrap(desbloquearUsuario));
app.post('/api/usuarios/:id/bloquear', wrap(bloquearUsuario));
app.post('/api/usuarios/:id/encerrar-sessoes', wrap(encerrarSessoesUsuario));
app.post('/api/usuarios/:id/sessoes/:sid/encerrar', wrap(revogarSessaoUsuario));
app.post('/api/usuarios/:id/forcar-troca-senha', wrap(forcarTrocaSenha));
// Auditoria segura: verificação da cadeia de hashes (admin)
app.get('/api/admin/auditoria/verificar', wrap(verificarAuditoriaHandler));

// Metadados dos módulos (campos, tipos, opções) — o front monta formulários com isso
app.get(
  '/api/meta',
  wrap(async (req, res) => {
    const ator = currentUser(req);
    res.json({
      // `metaComOpcoesDinamicas` resolve os campos `optionsFrom` (ex.: etapa do
      // funil do CRM) para a EMPRESA da sessão — a lista de etapas que o
      // formulário mostra é a do cadastro, não uma constante do código.
      resources: await metaComOpcoesDinamicas(escopoDe(ator)),
      mode: getStore().kind,
      uploads: uploadProvider(),
      uploadsConfigError: uploadsConfigError(),
      version: VERSION,
      user: currentUser(req),
      smtp: { configurado: smtpConfigurado() },
      // Origem usada nos links de e-mail (convite/redefinição). APP_URL ausente
      // significa link derivado da requisição; `aviso` vem preenchido quando isso
      // pode resultar em URL inválida para quem recebeu o e-mail.
      emailLinks: { ...(await statusOrigemAsync(req)), aviso: AVISO_ORIGEM },
      // Local padrão (origem das movimentações) para o front pré-selecionar os formulários.
      defaultLocal: await getDefaultLocalInfo(undefined, escopoDe(currentUser(req))),
      auth: { hash: 'argon2id', mfa_admin_obrigatorio: true, reauth_ttl_segundos: Math.round(Number(process.env.REAUTH_TTL_MS) || 300_000) / 1000 },
    });
  })
);

app.get(
  '/api/dashboard',
  wrap(async (req, res) => {
    // MULTIEMPRESA: o painel é da empresa ativa do ator (nunca de todas por padrão).
    res.json(await getStore().dashboard(escopoDe(currentUser(req))));
  })
);

// Financeiro — resumo do fluxo de caixa, lançamento manual e recorrências
app.get('/api/financeiro/resumo', wrap(resumoFinanceiro));
// ---- FINANCEIRO 3.0: importação contábil (preview → confirmação) ------------
// Nada é gravado no preview. A confirmação é transacional, idempotente pelo
// hash do conteúdo e grava as partidas no LIVRO ÚNICO (lancamentos_financeiros).
app.post('/api/financeiro/importacao-contabil/preview', wrap(previewImportacaoContabil));
app.post('/api/financeiro/importacao-contabil', wrap(confirmarImportacaoContabil));
// ---- P2-13: importação do PLANO DE CONTAS (preview → aplicação) --------------
// A importação de partidas só funciona se as contas existirem; esta rota fecha
// o caminho (o contador entrega plano + razão). Nunca apaga conta.
app.post('/api/financeiro/plano-contas/importar/preview', wrap(previewImportacaoPlano));
app.post('/api/financeiro/plano-contas/importar', wrap(confirmarImportacaoPlano));
// ---- ESTOQUE 3.0: conversões de unidade DECLARADAS (P3-04) -------------------
app.get('/api/estoque/unidades/conversoes', wrap(listarConversoes));
app.post('/api/financeiro/lancamentos', wrap(criarLancamentoManual));
app.post('/api/financeiro/lancamentos/:id/baixar', wrap(baixarLancamento));
app.post('/api/financeiro/recorrencias/gerar', wrap(gerarRecorrencias));
app.get('/api/financeiro/rentabilidade', wrap(rentabilidade));
app.get('/api/financeiro/investidores', wrap(resumoInvestidores));
app.post('/api/financeiro/conciliacao', wrap(conciliarExtrato));
app.post('/api/admin/financeiro/recorrencias', wrap(cronRecorrencias));

// P2 — comissões efetivadas por recebimento
app.get('/api/financeiro/comissoes', wrap(resumoComissoes));
app.get('/api/financeiro/comissoes/venda/:id', wrap(comissoesDaVenda));

// P2 — recebíveis de cartão (bruto × taxa × líquido por vencimento)
app.get('/api/financeiro/cartao/recebiveis', wrap(recebiveisCartao));

// ============================================================================
// MASTER (MA-02..MA-08) — INTELIGÊNCIA COMERCIAL
//
// Rotas DERIVADAS: não gravam indicador, não aceitam número manual. Todas
// exigem autenticação (o bloco acima já está sob `requireAuth`) e recorte de
// empresa server-side (`escopoDoAtor`) — a empresa nunca vem do cliente.
// ============================================================================
app.get('/api/comercial/indicadores', wrap(apiIndicadores));
app.get('/api/comercial/territorios/arvore', wrap(apiArvoreTerritorios));
app.get('/api/comercial/metas/:id/acompanhamento', wrap(apiAcompanhamentoMeta));
app.get('/api/comercial/representantes/:id/painel', wrap(apiPainelRepresentante));
app.post('/api/comercial/vendas/:id/apurar-comissao', wrap(apiApurarComissao));

// P2 — gateway de pagamento (adapters): config, cobranças, webhooks
app.get('/api/financeiro/gateway/providers', wrap(listarGateways));
app.put('/api/financeiro/gateway/config', wrap(configurarGateway));
app.post('/api/financeiro/gateway/cobrancas', wrap(criarCobranca));
app.get('/api/financeiro/gateway/cobrancas', wrap(listarCobrancas));
app.get('/api/financeiro/gateway/cobrancas/:id', wrap(detalheCobranca));
app.post('/api/financeiro/gateway/cobrancas/:id/cancelar', wrap(cancelarCobranca));
app.post('/api/financeiro/gateway/cobrancas/:id/estornar', wrap(estornarCobranca));
app.get('/api/financeiro/gateway/webhooks', wrap(listarEventosWebhook));
app.post('/api/financeiro/gateway/webhooks/:id/reprocessar', wrap(reprocessarEvento));
app.post('/api/admin/financeiro/gateway/webhooks/processar', wrap(cronWebhooks));

// P2 — extrato bancário persistente (OFX/CSV) e conciliação
app.post('/api/financeiro/extrato/importar', wrap(importarExtrato));
app.get('/api/financeiro/extrato', wrap(listarExtrato));
app.post('/api/financeiro/extrato/:id/conciliar', wrap(conciliarLinhaManual));
app.post('/api/financeiro/extrato/:id/divergir', wrap(marcarDivergencia));

// P2 — CNAB: camada de parsers e importação de retorno
app.get('/api/financeiro/cnab/parsers', wrap(listarParsersHandler));
app.post('/api/financeiro/cnab/importar', wrap(importarCnab));

// Smart Product Search central (antes das rotas /:id e do CRUD genérico).
app.get('/api/produtos/busca', wrap(buscarProdutos));
// Alias em inglês para integrações; mesmo contrato e mesmo isolamento.
app.get('/api/produtos/search', wrap(buscarProdutos));
// Página de detalhe do produto (fotos, grade de estoque, movimentações, OPs, ficha)
app.get('/api/produtos/:id/detalhe', wrap(productDetail));
// Tamanhos da grade do produto (seletores de tamanho sem mistura de grades)
app.get('/api/produtos/:id/tamanhos', wrap(produtoTamanhos));

// Suprimentos e expedição — as duas operações são transacionais.
// O parser cru é montado apenas nesta rota para aceitar XML direto e
// multipart/form-data (o express.json global já foi executado antes).
app.post('/api/suprimentos/compras/importar-xml', express.raw({ limit: '12mb', type: () => true }), wrap(importarXmlCompra));
// Packing check: valida o array de leituras antes da transição para faturada.
app.post('/api/vendas/:id/packing-check', wrap(packingCheck));
// Nomes alternativos usados por integrações do módulo de expedição.
app.post('/api/vendas/:id/conferir', wrap(packingCheck));
app.post('/api/vendas/:id/checkout', wrap(packingCheck));
app.post('/api/pedidos/:id/packing-check', wrap(packingCheck));
app.post('/api/expedicao/packing-check', wrap(packingCheck));

// Itens de pedidos de venda/compra (sub-recursos) — antes das rotas genéricas
app.get('/api/vendas/:id/itens', wrap(listItens));
app.post('/api/vendas/:id/itens', wrap(createItem));
app.put('/api/vendas/:id/itens/:itemId', wrap(updateItem));
app.delete('/api/vendas/:id/itens/:itemId', wrap(deleteItem));
app.get('/api/compras/:id/itens', wrap(listItens));
app.post('/api/compras/:id/itens', wrap(createItem));
app.put('/api/compras/:id/itens/:itemId', wrap(updateItem));
app.delete('/api/compras/:id/itens/:itemId', wrap(deleteItem));

// PDF dos pedidos (antes das rotas genéricas)
app.get('/api/vendas/:id/pdf', wrap(vendaPDF));
app.get('/api/compras/:id/pdf', wrap(compraPDF));

// Gestão administrativa dos acessos seguros ao portal
app.get('/api/clientes/:id/portal-acessos', wrap(administrarAcessosPortal));
app.post('/api/clientes/:id/portal-acessos', wrap(gerarAcessoPortal));
app.post('/api/clientes/:id/portal-acessos/:acessoId/revogar', wrap(revogarAcessoPortal));

// Duplicidade de CPF/CNPJ no cadastro de clientes — consulta recortada pela
// empresa ativa do ator. ANTES do CRUD genérico: /api/:resource/:id trataria
// "por-documento" como um id. O front usa para avisar "já existe um cliente
// com este CPF" e oferecer [Abrir cliente] antes mesmo de salvar.
app.get('/api/clientes/por-documento', wrap(clientePorDocumentoHandler));

// Inteligência comercial e gestão de compartilhamentos (antes do CRUD genérico)
app.get('/api/catalogos/inteligencia', wrap(inteligenciaCatalogos));
app.post('/api/catalogos/compartilhamentos/:id/revogar', wrap(revogarCompartilhamento));

// Central profissional de compartilhamento de catálogos
app.post('/api/catalogos/:id/compartilhar', wrap(compartilharCatalogo));

// QR Code de produtos
app.get('/api/produtos/:id/qrcode', wrap(produtoQRCode));
app.get('/api/produtos/:id/qrcode/svg', wrap(produtoQRCodeSVG));
app.get('/api/produtos/:id/qrcode/dados', wrap(produtoQRDados));
app.get('/api/produtos/:id/qrcode/etiqueta', wrap(produtoEtiquetaQR));

// Qualidade (controle de defeitos em OPs)
app.get('/api/ordens/:id/qualidade', wrap(listQualidade));
app.post('/api/ordens/:id/qualidade', wrap(createQualidade));
app.get('/api/relatorios/qualidade', wrap(relatorioQualidade));

// Aprovações (workflow)
app.get('/api/aprovacoes/count', wrap(countAprovacoes));
app.get('/api/aprovacoes', wrap(listAprovacoes));
app.post('/api/aprovacoes/:id/aprovar', wrap(aprovarPedido));
app.post('/api/aprovacoes/:id/rejeitar', wrap(rejeitarPedido));

// Previsão de demanda (IA)
app.get('/api/predicao/demanda', wrap(predicaoDemanda));
app.get('/api/predicao/insumos', wrap(predicaoInsumos));

// Relatórios agendados (admin)
app.get('/api/admin/scheduled/status', wrap(scheduledStatus));
app.get('/api/admin/scheduled/run', wrap(runScheduled));
app.post('/api/admin/scheduled/cron', wrap(cronScheduled));

// Notificações (status)
app.get('/api/admin/notificacoes/status', (_req, res) => res.json(notificacoesStatus()));

// Documentação OpenAPI (pública)
app.get('/api/docs/openapi.json', wrap(openapiJSON));
app.get('/api/docs', wrap(openapiUI));

// Chat interno
app.get('/api/chat/conversas', wrap(listConversas));
app.get('/api/chat/nao-lidas', wrap(countNaoLidas));
app.get('/api/chat/:userId/mensagens', wrap(listMensagens));
app.post('/api/chat/:userId/mensagens', wrap(sendMessage));

// NF-e — endpoints legados (preparação dos dados e modo simulação explícito).
// Continuam no ar para não quebrar a UI atual; a emissão REAL é /fiscal/*.
app.get('/api/vendas/:id/nfe/dados', wrap(nfeDados));
app.post('/api/vendas/:id/nfe/emitir', wrap(nfeEmitir));
app.get('/api/vendas/:id/nfe/status', wrap(nfeStatus));

// PRODUTOS — variações (SKUs filhos) geradas de forma determinística.
app.get('/api/produtos/:id/variacoes', wrap(listarVariacoes));
app.get('/api/produtos/:id/variacoes/previa', wrap(previaVariacoes));
app.post('/api/produtos/:id/variacoes', wrap(gerarVariacoes));

// FISCAL — NF-e (55) e NFC-e (65) atrás do FiscalProvider.
// `autorizado` só existe com chave + protocolo devolvidos pela SEFAZ.
app.get('/api/vendas/:id/fiscal', wrap(situacaoFiscalVenda));
app.get('/api/vendas/:id/fiscal/previa', wrap(previaDocumento));
app.post('/api/vendas/:id/fiscal/emitir', wrap(emitirDocumento));
app.get('/api/fiscal/documentos/:id/eventos', wrap(eventosDocumento));
app.post('/api/fiscal/documentos/:id/consultar', wrap(consultarDocumento));
app.post('/api/fiscal/documentos/:id/cancelar', wrap(cancelarDocumento));
app.post('/api/fiscal/inutilizar', wrap(inutilizarNumeracao));
app.get('/api/fiscal/config', wrap(obterConfigFiscal));
app.put('/api/fiscal/config', wrap(salvarConfigFiscal));

// Frete e CEP
app.get('/api/cep/:cep', wrap(consultarCepHandler));
app.get('/api/frete/cep', wrap(consultarCEP));
app.post('/api/frete/calcular', wrap(calcularFrete));

// ==========================================================================
// FASE P1 — listas de preço, propostas, PDV, logística, expedição e compras
// Todas ANTES das rotas genéricas /api/:resource.
// ==========================================================================

// ---- Listas de preço ----
// GET /api/listas-preco/resolver precisa vir antes de /api/listas_preco/:id.
app.get('/api/listas-preco/resolver', wrap(resolverLista));
app.get('/api/listas-preco/:id/itens', wrap(listarItensLista));
app.put('/api/listas-preco/:id/itens', wrap(gravarItensLista));
app.delete('/api/listas-preco/:id/itens/:produtoId', wrap(removerItemLista));
app.get('/api/listas-preco/:id/historico', wrap(historicoLista));
app.get('/api/produtos/:id/preco', wrap(precoProduto));

// ---- Propostas comerciais ----
app.post('/api/propostas', wrap(criarProposta));
app.get('/api/propostas/:id', wrap(detalharProposta));
app.get('/api/propostas/:id/itens', wrap(listarItensProposta));
app.post('/api/propostas/:id/itens', wrap(reescreverItensProposta));
app.get('/api/propostas/:id/eventos', wrap(eventosProposta));
app.post('/api/propostas/:id/enviar', wrap(enviarProposta));
app.post('/api/propostas/:id/aprovar', wrap(aprovarProposta));
app.post('/api/propostas/:id/recusar', wrap(recusarProposta));
app.post('/api/propostas/:id/cancelar', wrap(cancelarProposta));
app.post('/api/propostas/:id/converter', wrap(converterProposta));

// ---- CRM 3.0 — Lead → Oportunidade (transacional, idempotente, auditável) ----
app.post('/api/crm/leads/:id/converter', wrap(converterLead));
// ---- CRM 3.0 evolução (migration 0051): funil, histórico, agenda, forecast ----
// Transição explícita de estágio (idempotente, grava histórico na transação).
app.post('/api/crm/oportunidades/:id/estagio', wrap(mudarEstagioOportunidade));
// Trilha do funil da própria oportunidade.
app.get('/api/crm/oportunidades/:id/historico', wrap(historicoDaOportunidade));
// Agenda de atividades: hoje / atrasadas / próximas / concluídas.
app.get('/api/crm/atividades/agenda', wrap(agendaDeAtividades));
// Previsão comercial ponderada por probabilidade (derivada, nunca persistida).
app.get('/api/crm/forecast', wrap(forecastCrm));
// Painel comercial do CRM (leads, pipeline, conversão, atividades, pessoas).
// Filtros (período, funil, origem, etapa, status, responsável) são resolvidos
// no SERVIDOR — a tela só exibe.
app.get('/api/crm/painel', wrap(painelCrm));
// Reordenação TRANSACIONAL das etapas do funil (0058). Lista completa do funil,
// sem duplicata, com auditoria e rollback.
app.post('/api/crm/funis/:id/etapas/reordenar', wrap(reordenarEtapasDoFunil));

// ---- ESTOQUE 3.0: transferência formal, reserva e disponibilidade ----
// Documento com máquina de estados — o saldo só muda na expedição e no
// recebimento, pelos lançamentos oficiais de movimentação.
app.get('/api/estoque/disponibilidade', wrap(disponibilidadeHandler));
app.post('/api/estoque/transferencias', wrap(criarTransferencia));
app.get('/api/estoque/transferencias/:id', wrap(detalharTransferencia));
app.post('/api/estoque/transferencias/:id/aprovar', wrap(aprovarTransferencia));
app.post('/api/estoque/transferencias/:id/expedir', wrap(expedirTransferencia));
app.post('/api/estoque/transferencias/:id/receber', wrap(receberTransferencia));
app.post('/api/estoque/transferencias/:id/cancelar', wrap(cancelarTransferencia));
// Reserva/empenho/bloqueio: comprometimento com checagem de disponível.
app.post('/api/estoque/reservas', wrap(criarReserva));
app.post('/api/estoque/reservas/:id/liberar', wrap(liberarReserva));

// ---- PDV ----
app.get('/api/pdv/caixas/aberto', wrap(caixaAberto));
app.post('/api/pdv/caixas', wrap(abrirCaixa));
app.get('/api/pdv/caixas/:id/resumo', wrap(resumoCaixaHandler));
app.post('/api/pdv/caixas/:id/movimentos', wrap(movimentoCaixa));
app.post('/api/pdv/caixas/:id/fechar', wrap(fecharCaixa));
app.get('/api/pdv/buscar', wrap(pdvBuscarProduto));
app.post('/api/pdv/vendas', wrap(venderPdv));
app.post('/api/pdv/vendas/:id/cancelar', wrap(cancelarVendaPdv));
app.post('/api/pdv/vendas/:id/cupom', wrap(emitirCupomPdvHandler));
app.post('/api/pdv/vendas/:id/reimprimir', wrap(reimprimirCupomPdvHandler));
app.get('/api/pdv/vendas/:id/cupom/html', wrap(cupomPdvHtmlHandler));
app.get('/api/pdv/vendas/:id/cupom/pdf', wrap(cupomPdvPdfHandler));

// Creators: capacidades reais, sem simular dados ou operações ausentes.
app.get('/api/creators/capabilities', wrap(capacidadesCreators));
for (const [path, entity] of [['perfis', 'profile'], ['campanhas', 'campaign'], ['parcerias', 'partnership']] as const) {
  app.get(`/api/creators/${path}`, wrap(listCreatorsEntity(entity)));
  app.post(`/api/creators/${path}`, wrap(createCreatorsEntity(entity)));
  app.get(`/api/creators/${path}/:id`, wrap(detailCreatorsEntity(entity)));
  app.put(`/api/creators/${path}/:id`, wrap(updateCreatorsEntity(entity)));
}
app.get('/api/creators/parcerias/:id/atribuicoes', wrap(listCreatorAttributions));

// ------------------------------------------------------------------------------
// BROBOND COMMERCE OS — catálogo, publicação multicanal, pedidos omnichannel,
// promoções/cupons, fulfillment/delivery/rastreio, trends e observabilidade.
// RBAC por recurso (checkAccess/checkFluxo) — nada aqui depende de esconder botão.
// ------------------------------------------------------------------------------
app.get('/api/commerce/loja/estado', wrap(estadoLoja));
app.get('/api/commerce/produtos', wrap(listarProdutosCommerce));
app.post('/api/commerce/produtos', wrap(projetarProdutoCommerce));
app.get('/api/commerce/produtos/:id', wrap(obterProdutoCommerce));
app.put('/api/commerce/produtos/:id', wrap(atualizarProdutoCommerce));
app.put('/api/commerce/produtos/:id/precos', wrap(salvarPrecoCanal));
app.post('/api/commerce/produtos/:id/despublicar', wrap(despublicarProduto));
app.get('/api/commerce/publicacoes', wrap(listarPublicacoes));
app.get('/api/commerce/publicacoes/:id', wrap(obterPublicacaoCommerce));
app.post('/api/commerce/publicacoes', wrap(publicarProduto));
app.post('/api/commerce/publicacoes/:id/reprocessar', wrap(reprocessarPublicacao));
app.get('/api/commerce/ofertas', wrap(listarOfertasCommerce));
app.get('/api/commerce/ofertas/:id', wrap(obterOfertaCommerce));
app.get('/api/commerce/pedidos', wrap(listarPedidosCommerce));
app.get('/api/commerce/pedidos/:saleId', wrap(detalharPedidoCommerce));
app.post('/api/commerce/pedidos/:saleId/converter', wrap(converterPedidoCommerce));
app.post('/api/commerce/pedidos/:saleId/cancelar', wrap(cancelarPedidoCommerce));
app.post('/api/commerce/pedidos/:saleId/rastreio', wrap(salvarRastreioCommerce));
app.get('/api/commerce/reservas', wrap(listarReservasCommerce));
app.get('/api/commerce/fulfillment', wrap(listarFulfillmentCommerce));
app.get('/api/commerce/delivery', wrap(listarDeliveryCommerce));
app.use('/api/commerce/payments', paymentsRouter);
app.get('/api/commerce/pagamentos', wrap(listarPagamentosCommerce));
app.get('/api/commerce/eventos', wrap(listarEventosCommerce));
app.post('/api/commerce/outbox/:id/reprocessar', wrap(reprocessarOutbox));
app.get('/api/commerce/erros', wrap(listarErrosCommerce));
app.get('/api/commerce/promocoes', wrap(listarPromocoes));
app.post('/api/commerce/promocoes', wrap(criarPromocao));
app.put('/api/commerce/promocoes/:id', wrap(atualizarPromocao));
app.delete('/api/commerce/promocoes/:id', wrap(excluirPromocao));
app.get('/api/commerce/cupons', wrap(listarCupons));
app.post('/api/commerce/cupons', wrap(criarCupom));
app.put('/api/commerce/cupons/:id', wrap(atualizarCupom));
app.delete('/api/commerce/cupons/:id', wrap(excluirCupom));
app.get('/api/commerce/analytics', wrap(analyticsCommerce));
app.get('/api/commerce/trends', wrap(trendsCommerce));

// ----------------------------------------------------------------------------
// IMPRESSÃO P0..P6 — fila, documentos, etiquetas, terminais e agentes.
// ----------------------------------------------------------------------------
app.get('/api/print/resumo', wrap(resumoOperacionalImpressaoHandler));
app.post('/api/print/manutencao', requireRole('admin', 'gerente'), wrap(manutencaoImpressaoHandler));
app.get('/api/print/impressoras-detectadas', wrap(listarImpressorasDetectadasHandler));

app.post('/api/print/jobs', wrap(criarJobHandler));
app.get('/api/print/jobs', wrap(listarJobsHandler));
app.get('/api/print/jobs/:id', wrap(detalheJobHandler));
app.get('/api/print/jobs/:id/html', wrap(fallbackHtmlJobHandler));
app.get('/api/print/jobs/:id/pdf', wrap(fallbackPdfJobHandler));
app.post('/api/print/jobs/:id/cancelar', wrap(cancelarJobHandler));
app.post('/api/print/jobs/:id/retry', wrap(retryJobHandler));
app.post('/api/print/jobs/:id/reimprimir', wrap(reimprimirJobHandler));

app.post('/api/print/etiquetas', wrap(imprimirEtiquetasHandler));
app.post('/api/produtos/:id/etiquetas', wrap(imprimirEtiquetasProdutoHandler));

app.post('/api/print/documentos/:tipo/:id', wrap(imprimirDocumentoHandler));
app.post('/api/print/documentos/:tipo/:id/reimprimir', wrap(reimprimirDocumentoHandler));
app.get('/api/print/documentos/:tipo/:id/html', wrap(fallbackDocumentoHtmlHandler));
app.get('/api/print/documentos/:tipo/:id/pdf', wrap(fallbackDocumentoPdfHandler));

app.get('/api/print/terminals', wrap(listarTerminaisHandler));
app.post('/api/print/terminals', requireRole('admin', 'gerente'), wrap(criarTerminalHandler));
app.patch('/api/print/terminals/:id', requireRole('admin', 'gerente'), wrap(atualizarTerminalHandler));
app.delete('/api/print/terminals/:id', requireRole('admin', 'gerente'), wrap(removerTerminalHandler));
app.post('/api/print/terminals/:id/teste', requireRole('admin', 'gerente'), wrap(imprimirTesteTerminalHandler));

app.post('/api/print/pairing', requireRole('admin', 'gerente'), wrap(criarCodigoPareamentoHandler));
app.get('/api/print/agents', requireRole('admin', 'gerente'), wrap(listarAgentesHandler));
app.patch('/api/print/agents/:id', requireRole('admin', 'gerente'), wrap(atualizarAgenteHandler));
app.post('/api/print/agents/:id/revogar', requireRole('admin', 'gerente'), wrap(revogarAgenteHandler));
app.post('/api/print/agents/:id/reativar', requireRole('admin', 'gerente'), wrap(reativarAgenteHandler));
app.post('/api/print/agents/:id/rotacionar-token', requireRole('admin', 'gerente'), wrap(printRotacionarTokenHandler));
app.get('/api/pdv/vendas/:id/pagamentos', wrap(pagamentosVenda));

// ---- Logística ----
app.get('/api/logistica/config', wrap(obterConfigLogisticaHandler));
app.put('/api/logistica/config', wrap(salvarConfigLogisticaHandler));
app.get('/api/logistica/frete', wrap(cotarFrete));
app.get('/api/envios/rastreio/:codigo', wrap(buscarEnvioPorCodigo));
app.get('/api/envios/:id/eventos', wrap(eventosEnvio));
app.post('/api/envios/:id/rastrear', wrap(rastrearEnvio));
app.post('/api/envios/:id/status', wrap(atualizarStatusEnvio));
app.post('/api/envios/:id/cancelar', wrap(cancelarEnvio));
app.get('/api/vendas/:id/envio', wrap(envioDaVenda));
app.post('/api/vendas/:id/envio', wrap(gerarEnvio));

// ---- Expedição (separação → conferência → embalagem → expedição) ----
app.get('/api/vendas/:id/expedicao', wrap(situacaoExpedicao));
app.post('/api/vendas/:id/expedicao/separar', wrap(separarPedido));
app.post('/api/vendas/:id/expedicao/conferir', wrap(conferirPedido));
app.post('/api/vendas/:id/expedicao/embalar', wrap(embalarPedido));
app.post('/api/vendas/:id/expedicao/expedir', wrap(expedirPedido));
app.get('/api/expedicao/divergencias', wrap(listarDivergencias));
app.post('/api/expedicao/divergencias/:id/resolver', wrap(resolverDivergencia));

// ---- Logística reversa ----
app.post('/api/devolucoes', wrap(criarDevolucao));
app.get('/api/devolucoes/:id', wrap(obterDevolucao));
app.post('/api/devolucoes/:id/autorizar', wrap(autorizarDevolucao));
app.post('/api/devolucoes/:id/rastreamento', wrap(registrarRastreamento));
app.post('/api/devolucoes/:id/receber', wrap(receberDevolucao));
app.post('/api/devolucoes/:id/recusar', wrap(recusarDevolucao));
app.post('/api/devolucoes/:id/cancelar', wrap(cancelarDevolucao));

// ---- FISCAL 3.0: calendário de obrigações acessórias ----
// O ERP controla prazo e prova (protocolo/arquivo); NÃO calcula imposto nem
// escreve alíquota — o motor tributário continua em fiscalRegras.ts.
app.get('/api/fiscal/calendario', wrap(calendarioFiscal));
app.get('/api/fiscal/obrigacoes/:id/historico', wrap(historicoObrigacaoFiscal));
app.post('/api/fiscal/obrigacoes/:id/entregas', wrap(registrarEntregaFiscal));
app.get('/api/fiscal/obrigacoes/:id/execucoes', wrap(listarExecucoesFiscais));
app.post('/api/fiscal/obrigacoes/:id/execucoes', wrap(executarObrigacaoFiscal));
app.get('/api/fiscal/execucoes/:id/evidencias', wrap(listarEvidenciasFiscais));
app.post('/api/fiscal/execucoes/:id/evidencias', wrap(registrarEvidenciaFiscal));

// ---- FINANCEIRO 3.0: estrutura contábil (não é contabilidade) ----
// Balancete e resumo do plano de contas leem o MESMO livro-caixa; não existe
// segundo financeiro nem partida dobrada gerada por código.
app.get('/api/financeiro/balancete', wrap(balanceteFinanceiro));
app.get('/api/financeiro/periodos', wrap(listarPeriodos));
app.get('/api/financeiro/periodos/:competencia', wrap(obterPeriodo));
app.post('/api/financeiro/periodos/:competencia/:acao', wrap(alterarPeriodo));
app.get('/api/financeiro/plano-contas/resumo', wrap(resumoPlanoContas));

// ---- PRODUÇÃO 3.0: capacidade/carga e MRP (somente leitura) ----
// Nenhuma rota aqui cria OP ou pedido de compra: capacidade e MRP são leitura.
app.get('/api/producao/capacidade', wrap(capacidadeProducao));
app.get('/api/producao/mrp', wrap(mrpProducao));

// ---- COMPRAS 3.0: homologação de fornecedor + painel ----
// A homologação é um PROCESSO sobre o cadastro existente: estado em
// `fornecedores`, documentos em `fornecedor_documentos`, trilha em
// `fornecedor_homologacao_eventos`. Nenhum cadastro paralelo.
app.get('/api/compras/painel', wrap(painelDeCompras));
app.get('/api/compras/fornecedores/:id/homologacao', wrap(homologacaoDoFornecedor));
app.post('/api/compras/fornecedores/:id/homologacao', wrap(alterarHomologacao));
app.get('/api/compras/fornecedores/:id/desempenho', wrap(desempenhoDoFornecedor));

// ---- Compras: aprovação e recebimento parcial ----
app.post('/api/compras/:id/aprovar', wrap(aprovarCompra));
app.get('/api/compras/:id/recebimentos', wrap(listarRecebimentos));
app.post('/api/compras/:id/receber', wrap(receberParcial));

// ---- Cotação de compra (E3): rascunho → cotando → decidida ----
// O pedido de compra só nasce em /decidir, e nasce uma única vez
// (CAS no status + índice único em cotacoes_compra.compra_id).
app.get('/api/cotacoes-compra/:id/comparativo', wrap(comparativoCotacao));
app.post('/api/cotacoes-compra/:id/itens', wrap(criarItemCotacao));
app.put('/api/cotacoes-compra/:id/itens/:itemId', wrap(atualizarItemCotacao));
app.delete('/api/cotacoes-compra/:id/itens/:itemId', wrap(removerItemCotacao));
app.post('/api/cotacoes-compra/:id/convidar', wrap(convidarFornecedores));
app.post('/api/cotacoes-compra/:id/abrir', wrap(abrirCotacao));
app.post('/api/cotacoes-compra/:id/cotar', wrap(cotarFornecedor));
app.post('/api/cotacoes-compra/:id/recusar', wrap(recusarCotacao));
app.post('/api/cotacoes-compra/:id/decidir', wrap(decidirCotacaoCompra));
app.post('/api/cotacoes-compra/:id/cancelar', wrap(cancelarCotacao));

// ---- Sugestão de compra (só calcula; gerar exige ação explícita) ----
app.get('/api/suprimentos/sugestao-compra', wrap(sugestaoCompra));
app.post('/api/suprimentos/sugestao-compra/gerar', wrap(gerarCompraDaSugestao));

// MULTIEMPRESA — seletor de empresa (persistente na sessão) e concessões.
// Precisam vir ANTES das rotas genéricas /api/:resource.
app.get('/api/empresas/ativa', wrap(empresaAtiva));
app.post('/api/empresas/ativa', wrap(trocarEmpresaAtiva));
app.get('/api/usuarios/:id/empresas', wrap(listarEmpresasDoUsuario));
app.post('/api/usuarios/:id/empresas', wrap(concederEmpresa));
app.delete('/api/usuarios/:id/empresas/:empresaId', wrap(revogarEmpresa));

// Conectores oficiais (Mercado Livre, Mercado Pago, Nuvemshop)
app.use('/api/connectors', connectorsRouter);

// 1. MEU NEGÓCIOS — motor analítico real (margem por pedido, curva ABC
// contínua e agregadores de BI com filtros estritos De/Até, empresa_id e
// canal: Loja Física, E-commerce, Marketplaces).
app.get('/api/negocios/canais', wrap(negociosCanais));
app.get('/api/negocios/resumo', wrap(negociosResumo));
app.get('/api/negocios/margens', wrap(negociosMargens));
app.post('/api/negocios/margens/recalcular', wrap(negociosMargensRecalcular));
app.get('/api/negocios/abc', wrap(negociosABC));
app.post('/api/negocios/abc/recalcular', wrap(negociosABCRecalcular));
app.post('/api/negocios/vendas', wrap(negociosVendaManual));

// Marketplace
app.get('/api/marketplace/status', wrap(marketplaceStatus));
app.post('/api/marketplace/sincronizar', wrap(sincronizarPedidos));
// Loja virtual própria (WordPress + WooCommerce) — brobond.com.br
app.get('/api/marketplace/loja/status', wrap(statusLoja));
app.get('/api/marketplace/loja/produtos', wrap(produtosLoja));
app.post('/api/marketplace/loja/pedidos', wrap(importarPedidosLoja));
app.post('/api/marketplace/loja/estoque', wrap(sincronizarEstoqueLoja));

// WebSocket status
app.get('/api/admin/ws/status', (_req, res) => res.json(wsStatus()));

// Cockpit da Produção — KPIs das OPs (antes das rotas genéricas)
app.get('/api/producao/painel', wrap(producaoPainel));
// E2 — plano de produção por semana + necessidade de insumos (MRP com dado real).
app.get('/api/producao/planejamento', wrap(planejamentoProducao));

// Fase 3 — itens de OP por grade e insumos da ficha técnica (sub-recursos)
app.get('/api/ordens/:id/itens', wrap(listItensOrdem));
app.post('/api/ordens/:id/itens', wrap(createItemOrdem));
app.put('/api/ordens/:id/itens/:itemId', wrap(updateItemOrdem));
app.delete('/api/ordens/:id/itens/:itemId', wrap(deleteItemOrdem));
// E2 — fluxo da OP: liberação, apontamentos (com perda), conclusão, cancelamento
// e reabertura. Todas as rotas ficam ANTES das genéricas para que
// /api/ordens/:id/apontamentos não caia em /api/:resource/:id.
app.post('/api/ordens/:id/liberar', wrap(liberarOrdem));
app.post('/api/ordens/:id/iniciar', wrap(iniciarOrdem));
app.get('/api/ordens/:id/apontamentos', wrap(listApontamentos));
app.post('/api/ordens/:id/apontamentos', wrap(criarApontamento));
app.get('/api/ordens/:id/custodia', wrap(listarEventosTerceirizacao));
app.post('/api/ordens/:id/custodia', wrap(registrarEventoTerceirizacao));
app.get('/api/ordens/:id/eventos', wrap(listEventosOrdem));
app.post('/api/ordens/:id/concluir', wrap(concluirOrdemHandler));
app.post('/api/ordens/:id/cancelar', wrap(cancelarOrdem));
app.post('/api/ordens/:id/reabrir', wrap(reabrirOrdem));
app.get('/api/fichas/:id/insumos', wrap(listInsumosFicha));
app.post('/api/fichas/:id/insumos', wrap(createInsumoFicha));
app.put('/api/fichas/:id/insumos/:itemId', wrap(updateInsumoFicha));
app.delete('/api/fichas/:id/insumos/:itemId', wrap(deleteInsumoFicha));
app.post('/api/fichas/:id/aplicar-preco', wrap(aplicarPrecoFicha));

// Fase 4 — grade de estoque e inventário
app.get('/api/estoques/grade', wrap(estoqueGrade));
app.get('/api/estoques/disponivel', wrap(estoqueDisponivel));
app.get('/api/grades/medidas-resumo', wrap(resumoMedidasGrades));
app.get('/api/grades/:id/medidas', wrap(getMedidasGrade));
app.put('/api/grades/:id/medidas', wrap(saveMedidasGrade));
app.get('/api/inventarios/ciclicas', wrap(listarPlanosContagemCiclica));
app.post('/api/inventarios/ciclicas', wrap(criarContagemCiclica));
app.get('/api/inventarios/:id', wrap(getInventarioDetalhe));
app.get('/api/inventarios/:id/itens', wrap(listItensInventario));
app.put('/api/inventarios/:id/itens', wrap(updateItensInventario));
app.post('/api/inventarios/:id/ciclica/conferir', wrap(conferirContagemCiclica));
app.post('/api/inventarios/:id/ciclica/aprovar', wrap(aprovarContagemCiclica));
app.post('/api/inventarios/:id/ciclica/cancelar', wrap(cancelarContagemCiclica));
app.post('/api/inventarios/:id/fechar', wrap(fecharInventario));
app.post('/api/movimentacoes/:id/estornar', wrap(estornarMovimentacao));

// Fase 5 — relatórios, importação e exportação
app.get('/api/relatorios/:nome', wrap(async (req, res) => relatorio(req, res, req.params.nome)));
app.post('/api/importar/preview', wrap(previewImportacao));
app.post('/api/importar/confirmar', wrap(confirmarImportacao));
app.get('/api/importar/modelo', wrap(modeloImportacao));
app.get('/api/:resource/export', wrap(async (req, res) => exportarRecurso(req, res, req.params.resource)));

// Fase 6 — backup (admin)
app.get('/api/admin/backup', wrap(adminBackup));
app.get('/api/admin/backup/xlsx', wrap(adminBackupXlsx));
app.get('/api/admin/backup/info', wrap(backupInfo));

// DIAGNÓSTICO DE DEPENDÊNCIAS — "por que não posso excluir?".
// Antes das rotas genéricas /api/:resource/:id. Somente leitura, recortado pela
// empresa ativa do ator: vínculo de outra empresa nem é contado (404 no alvo).
app.get(
  '/api/:resource/:id/dependencias',
  resourceParam,
  wrap(async (req: Request, res: Response) => {
    const r = (req as any).resource;
    const actor = currentUser(req);
    checkAccess(r, actor, 'read');
    res.json(await diagnosticarDependencias(r, parseId(req.params.id), escopoDe(actor)));
  })
);

// Fotos / anexos de um registro
app.get('/api/:resource/:id/arquivos', wrap(listFiles));
app.post('/api/:resource/:id/arquivos', wrap(uploadFile));
app.put('/api/:resource/:id/arquivos/:fid', wrap(updateFile));
app.delete('/api/:resource/:id/arquivos/:fid', wrap(deleteFile));

// Opções para selects (id + rótulo)
app.get(
  '/api/:resource/options',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    res.json(await optionsFor(r, escopoDe(currentUser(req))));
  })
);

// Listagem com busca, paginação e ordenação
app.get(
  '/api/:resource',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    const page = Math.max(1, Number(req.query.page) || 1);
    // Página do servidor: o cliente pede 25/50/100 e recebe SÓ aquela página.
    // O teto de 500 atende os seletores que precisam do cadastro inteiro
    // (fornecedores/insumos/clientes em modais) sem abrir a porta para "baixe o
    // catálogo todo" — a listagem de Produtos usa 25/50/100.
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 25));
    const dir = String(req.query.dir || '').toLowerCase() === 'desc' ? 'desc' : String(req.query.dir || '').toLowerCase() === 'asc' ? 'asc' : undefined;
    // Filtros de igualdade: ?f.produto_id=3&f.status=aberta
    const filter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (k.startsWith('f.') && typeof v === 'string' && v !== '') filter[k.slice(2)] = v;
    }
    res.json(
      await listRecords(
        r,
        {
          q: typeof req.query.q === 'string' ? req.query.q : undefined,
          page,
          pageSize,
          sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
          dir,
          filter,
        },
        // MULTIEMPRESA: o recorte do ator é aplicado dentro do serviço — um
        // `?f.empresa_id=` enviado pelo cliente é descartado lá.
        escopoDe(currentUser(req))
      )
    );
  })
);

app.get(
  '/api/:resource/:id',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    res.json(await getRecord(r, parseId(req.params.id), escopoDe(currentUser(req))));
  })
);

// Incluir
app.post(
  '/api/:resource',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    const actor = currentUser(req);
    checkAccess(r, actor, 'create');
    res.status(201).json(await createRecord(r, req.body, actor, { req, escopo: escopoDe(actor) }));
  })
);

// Salvar (editar)
const updateHandler = wrap(async (req: Request, res: Response) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  // ?forcar=true em OP concluída permite consumo de insumos sem saldo (gerente/admin)
  const forcar = req.query.forcar === 'true' || req.query.forcar === '1';
  res.json(await updateRecord(r, parseId(req.params.id), req.body, actor, { forcar, escopo: escopoDe(actor) }));
});
app.put('/api/:resource/:id', resourceParam, updateHandler);
app.patch('/api/:resource/:id', resourceParam, updateHandler);

// Excluir
app.delete(
  '/api/:resource/:id',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    const actor = currentUser(req);
    checkAccess(r, actor, 'delete');
    await deleteRecord(r, parseId(req.params.id), actor, escopoDe(actor));
    res.json({ ok: true });
  })
);

// Rotas /api desconhecidas
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Rota não encontrada')));

// ----------------------------------------------------------------------------
// Front buildado (produção — mesmo serviço na Render). Depois das rotas /api.
// ----------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// ----------------------------------------------------------------------------
// Erros
// ----------------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
  }
  const httpErr = toHttpError(err, (req as any).resource);
  if (httpErr.status >= 500) reportarErro(new Error('Erro interno de requisição HTTP'), { method: req.method, rota: typeof req.route?.path === 'string' ? req.route.path : '(middleware)', request_id: res.locals.requestId, status: httpErr.status });
  res.status(httpErr.status).json({
    error: httpErr.message,
    fields: httpErr.fields,
    ...(httpErr.code ? { code: httpErr.code } : {}),
    // Dados estruturados do erro (ex.: diagnóstico de dependências). `fields`
    // continua sendo só erro por campo de formulário.
    ...(httpErr.details ? { details: httpErr.details } : {}),
  });
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
async function start() {
  const port = Number(process.env.PORT) || 3001;
  const httpServer = createServer(app);
  initWebSocket(httpServer);

  // Render only considers a deployment ready after it can connect to PORT.
  // Start listening before database migrations and other boot tasks: a slow or
  // temporarily unavailable Postgres must not make the platform report
  // "no open ports detected". The health endpoint remains available while the
  // application finishes its initialization.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.removeListener('error', reject);
      console.log(`⚡ BROBOND API rodando em http://0.0.0.0:${port}`);
      resolve();
    });
  });

  if (hasDatabaseUrl()) {
    try {
      await migrate();
    } catch (e: any) {
      console.error('❌ Falha ao migrar o banco:', e?.message || e);
    }
    // PROD-DB-01.1 — banco obrigatório quebrado não vira "serviço saudável".
    // Em produção o processo encerra para a plataforma reiniciar (a recuperação
    // é: corrigir a causa e o restart volta pronto). Fora de produção a
    // instância segue de pé, porém com as rotas de negócio bloqueadas (503).
    if (isDbDegraded()) {
      // PROD-DB-02 — a FASE é parte do diagnóstico: 'bootstrap' é defeito de
      // estrutura (não se resolve corrigindo dado); 'migrations' é regra de dado
      // (ex.: E4.2 recusando dado legado) e exige decisão humana.
      const falha = bootFailure();
      const fase = falha ? `fase=${falha.fase}` : 'fase=desconhecida';
      if (process.env.NODE_ENV === 'production') {
        console.error(`❌ Banco obrigatório não está pronto [${fase}] (${migrationError()}) — encerrando o processo (exit 1) para reinício pela plataforma.`);
        process.exit(1);
      }
      console.error(`⚠️  Banco obrigatório não está pronto [${fase}] (${migrationError()}) — rotas de negócio bloqueadas (503) até a migração concluir.`);
      return;
    }
  }
  // Liga o módulo de conectores ao pool do Postgres e à trilha de auditoria.
  initConnectors();
  // Motor analítico 1. MEU NEGÓCIOS: recalcula margens/curva ABC em segundo
  // plano (ciclo no boot + intervalo + pós-ingestão de marketplaces).
  initNegociosEngine();
  // Commerce OS: gancho pré-faturamento da ponte (reservas + frete do
  // checkout), ouvinte de cobrança do gateway (pagamento → conversão) e
  // ouvinte de ingestão (projeção + conversão automática de canais pagos).
  registrarHooksCommerce();
  // Fila do commerce com cadência própria (backstop além do cron externo):
  // publicações enfileiradas e conversões com retry não dependem de alguém
  // abrir a tela. Sem efeito em teste (o runner controla o ciclo).
  if (process.env.NODE_ENV !== 'test') {
    const filaCommerce = setInterval(() => {
      void processarComercioAgendado().then((result) => {
        if (result.falhas.length) log.warn('commerce_scheduled_failures', { etapas: result.falhas });
      }).catch(() => log.error('commerce_scheduled_unavailable'));
    }, 60_000);
    filaCommerce.unref?.();
  }
  await ensureAdmin();
  await migrarSenhasLegadas();
  // Endereço público salvo no banco (Configurações › Sistema): já entra no
  // cache do urlPublica.ts antes da primeira requisição, para o primeiro
  // convite do processo já sair com a base certa.
  await carregarOrigemDoBanco(true);
  await limpezaPeriodica();
  // Limpeza diária de sessões encerradas e buckets de rate limit velhos.
  const limpeza = setInterval(() => void limpezaPeriodica().catch(() => undefined), 24 * 3600_000);
  limpeza.unref?.();

  console.log(
    isDbConnected()
      ? '🗄️  Conectado ao Postgres.'
      : hasDatabaseUrl()
        ? '⚠️  DATABASE_URL definida, mas a migração falhou — verifique a conexão.'
        : '⚠️  Sem DATABASE_URL — MODO DEMONSTRAÇÃO (dados em memória, somem ao reiniciar).'
  );
  console.log(`🔐 Administrador: ${ADMIN_EMAIL}`);
}

start().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});
