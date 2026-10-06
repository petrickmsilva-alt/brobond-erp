import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasDatabaseUrl, isDbConnected, migrate } from './db';
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
import { createItem, deleteItem, listItens, updateItem } from './itens';
import {
  checkAccess,
  createRecord,
  deleteRecord,
  getDefaultLocalInfo,
  getRecord,
  getStore,
  listRecords,
  optionsFor,
  toHttpError,
  updateRecord,
} from './services';
import { parseId } from './validate';
import { HttpError } from './errors';
import { assertProductionSecrets, bloquearSenhaProvisoria, corsOrigin, loginRateLimit, securityHeaders } from './security';
import { initSentry, reportarErro } from './log';
import { smtpConfigurado } from './mail';
import { carregarOrigemDoBanco, revisarConfiguracaoOrigem, statusOrigemAsync } from './urlPublica';
import { obterEnderecoPublico, removerEnderecoPublico, salvarEnderecoPublico } from './configSistema';
import { estoqueGrade, estornarMovimentacao, fecharInventario, getInventarioDetalhe, listItensInventario, updateItensInventario } from './estoque';
import { getMedidasGrade, resumoMedidasGrades, saveMedidasGrade } from './medidas';
import { relatorio } from './relatorios';
import { exportarRecurso } from './export';
import { confirmarImportacao, modeloImportacao, previewImportacao } from './importacao';
import {
  aplicarPrecoFicha,
  producaoPainel,
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
import { baixarLancamento, conciliarExtrato, cronRecorrencias, criarLancamentoManual, gerarRecorrencias, rentabilidade, resumoFinanceiro, resumoInvestidores } from './financeiro';
import { vendaPDF, compraPDF } from './pdf';
import { produtoQRCode, produtoQRCodeSVG, produtoQRDados, produtoEtiquetaQR } from './qrcode';
import { listAprovacoes, aprovarPedido, rejeitarPedido, countAprovacoes } from './approval';
import { runScheduled, cronScheduled, scheduledStatus } from './scheduled';
import { listQualidade, createQualidade, relatorioQualidade } from './quality';
import { predicaoDemanda, predicaoInsumos } from './prediction';
import { rateLimitPortal, administrarAcessosPortal, decidirCotacao, gerarAcessoPortal, portalPedidos, portalPedidoDetalhe, recomprarPedido, revogarAcessoPortal } from './portal';
import { notificacoesStatus, verificarAlertasEstoque } from './notifications';
import { openapiJSON, openapiUI } from './openapi';
import { listConversas, listMensagens, sendMessage, countNaoLidas } from './chat';
import { nfeDados, nfeEmitir, nfeStatus } from './nfe';
import { calcularFrete, consultarCEP } from './frete';
import { marketplaceStatus, sincronizarPedidos } from './marketplace';
import { connectorsRouter, initConnectors, publicConnectorsRouter } from './connectors';
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
app.set('trust proxy', 1); // Render/proxies: IP real em X-Forwarded-For
app.use(securityHeaders);
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
    allowedHeaders: ['Content-Type', 'Authorization'],
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

app.use(express.json({ limit: '4mb' })); // fotos chegam em base64 (já reduzidas no navegador)
app.use(express.urlencoded({ extended: true }));

// Log simples de requisições em dev
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api')) console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

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
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, db: isDbConnected() ? 'postgres' : 'memory', uploads: uploadProvider(), version: VERSION })
);
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
// Portal do cliente (acompanhamento de pedidos por CPF/CNPJ)
app.get('/api/portal/:token/pedidos', rateLimitPortal, wrap(portalPedidos));
app.get('/api/portal/:token/pedido/:id', rateLimitPortal, wrap(portalPedidoDetalhe));
app.post('/api/portal/:token/pedido/:id/decisao', rateLimitPortal, wrap(decidirCotacao));
app.post('/api/portal/:token/pedido/:id/recomprar', rateLimitPortal, wrap(recomprarPedido));
// Imagens armazenadas no banco: URL pública protegida por token aleatório
app.get('/api/files/:id/:token', wrap(serveFile));

// ----------------------------------------------------------------------------
// Autenticado
// ----------------------------------------------------------------------------
app.use('/api', wrap(requireAuth));
// Conta com senha provisória (convite, reset ou admin padrão) só lê e só escreve
// no próprio fluxo de troca de senha — ver bloquearSenhaProvisoria.
app.use('/api', bloquearSenhaProvisoria);

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
    res.json({
      resources: publicMeta(),
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
      defaultLocal: await getDefaultLocalInfo(),
      auth: { hash: 'argon2id', mfa_admin_obrigatorio: true, reauth_ttl_segundos: Math.round(Number(process.env.REAUTH_TTL_MS) || 300_000) / 1000 },
    });
  })
);

app.get(
  '/api/dashboard',
  wrap(async (_req, res) => {
    res.json(await getStore().dashboard());
  })
);

// Financeiro — resumo do fluxo de caixa, lançamento manual e recorrências
app.get('/api/financeiro/resumo', wrap(resumoFinanceiro));
app.post('/api/financeiro/lancamentos', wrap(criarLancamentoManual));
app.post('/api/financeiro/lancamentos/:id/baixar', wrap(baixarLancamento));
app.post('/api/financeiro/recorrencias/gerar', wrap(gerarRecorrencias));
app.get('/api/financeiro/rentabilidade', wrap(rentabilidade));
app.get('/api/financeiro/investidores', wrap(resumoInvestidores));
app.post('/api/financeiro/conciliacao', wrap(conciliarExtrato));
app.post('/api/admin/financeiro/recorrencias', wrap(cronRecorrencias));

// Página de detalhe do produto (fotos, grade de estoque, movimentações, OPs, ficha)
app.get('/api/produtos/:id/detalhe', wrap(productDetail));
// Tamanhos da grade do produto (seletores de tamanho sem mistura de grades)
app.get('/api/produtos/:id/tamanhos', wrap(produtoTamanhos));

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

// NF-e
app.get('/api/vendas/:id/nfe/dados', wrap(nfeDados));
app.post('/api/vendas/:id/nfe/emitir', wrap(nfeEmitir));
app.get('/api/vendas/:id/nfe/status', wrap(nfeStatus));

// Frete e CEP
app.get('/api/frete/cep', wrap(consultarCEP));
app.post('/api/frete/calcular', wrap(calcularFrete));

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

// Fase 3 — itens de OP por grade e insumos da ficha técnica (sub-recursos)
app.get('/api/ordens/:id/itens', wrap(listItensOrdem));
app.post('/api/ordens/:id/itens', wrap(createItemOrdem));
app.put('/api/ordens/:id/itens/:itemId', wrap(updateItemOrdem));
app.delete('/api/ordens/:id/itens/:itemId', wrap(deleteItemOrdem));
app.get('/api/fichas/:id/insumos', wrap(listInsumosFicha));
app.post('/api/fichas/:id/insumos', wrap(createInsumoFicha));
app.put('/api/fichas/:id/insumos/:itemId', wrap(updateInsumoFicha));
app.delete('/api/fichas/:id/insumos/:itemId', wrap(deleteInsumoFicha));
app.post('/api/fichas/:id/aplicar-preco', wrap(aplicarPrecoFicha));

// Fase 4 — grade de estoque e inventário
app.get('/api/estoques/grade', wrap(estoqueGrade));
app.get('/api/grades/medidas-resumo', wrap(resumoMedidasGrades));
app.get('/api/grades/:id/medidas', wrap(getMedidasGrade));
app.put('/api/grades/:id/medidas', wrap(saveMedidasGrade));
app.get('/api/inventarios/:id', wrap(getInventarioDetalhe));
app.get('/api/inventarios/:id/itens', wrap(listItensInventario));
app.put('/api/inventarios/:id/itens', wrap(updateItensInventario));
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
    res.json(await optionsFor(r));
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
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const dir = String(req.query.dir || '').toLowerCase() === 'desc' ? 'desc' : String(req.query.dir || '').toLowerCase() === 'asc' ? 'asc' : undefined;
    // Filtros de igualdade: ?f.produto_id=3&f.status=aberta
    const filter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (k.startsWith('f.') && typeof v === 'string' && v !== '') filter[k.slice(2)] = v;
    }
    res.json(
      await listRecords(r, {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        page,
        pageSize,
        sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
        dir,
        filter,
      })
    );
  })
);

app.get(
  '/api/:resource/:id',
  resourceParam,
  wrap(async (req, res) => {
    const r = (req as any).resource;
    checkAccess(r, currentUser(req), 'read');
    res.json(await getRecord(r, parseId(req.params.id)));
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
    res.status(201).json(await createRecord(r, req.body, actor, { req }));
  })
);

// Salvar (editar)
const updateHandler = wrap(async (req: Request, res: Response) => {
  const r = (req as any).resource;
  const actor = currentUser(req);
  checkAccess(r, actor, 'update');
  // ?forcar=true em OP concluída permite consumo de insumos sem saldo (gerente/admin)
  const forcar = req.query.forcar === 'true' || req.query.forcar === '1';
  res.json(await updateRecord(r, parseId(req.params.id), req.body, actor, { forcar }));
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
    await deleteRecord(r, parseId(req.params.id), actor);
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
  if (httpErr.status >= 500) reportarErro(err, { rota: `${req.method} ${req.path}` });
  res.status(httpErr.status).json({ error: httpErr.message, fields: httpErr.fields, ...(httpErr.code ? { code: httpErr.code } : {}) });
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
async function start() {
  if (hasDatabaseUrl()) {
    try {
      await migrate();
    } catch (e: any) {
      console.error('❌ Falha ao migrar o banco:', e?.message || e);
    }
  }
  // Liga o módulo de conectores ao pool do Postgres e à trilha de auditoria.
  initConnectors();
  // Motor analítico 1. MEU NEGÓCIOS: recalcula margens/curva ABC em segundo
  // plano (ciclo no boot + intervalo + pós-ingestão de marketplaces).
  initNegociosEngine();
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

  const port = Number(process.env.PORT) || 3001;
  const httpServer = createServer(app);
  initWebSocket(httpServer);
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`⚡ BROBOND API rodando em http://localhost:${port}`);
    console.log(
      isDbConnected()
        ? '🗄️  Conectado ao Postgres.'
        : hasDatabaseUrl()
          ? '⚠️  DATABASE_URL definida, mas a migração falhou — verifique a conexão.'
          : '⚠️  Sem DATABASE_URL — MODO DEMONSTRAÇÃO (dados em memória, somem ao reiniciar).'
    );
    console.log(`🔐 Administrador: ${ADMIN_EMAIL}`);
  });
}

start().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});
