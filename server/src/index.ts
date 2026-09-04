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
  login,
  logoutAll,
  me,
  migrarSenhasLegadas,
  requireAuth,
  resetPassword,
  savePreferences,
} from './auth';
import { getPublicResource, publicMeta } from './resources';
import { deleteFile, listFiles, serveFile, updateFile, uploadFile, uploadProvider, uploadsConfigError } from './uploads';
import { productDetail } from './detail';
import { createItem, deleteItem, listItens, relatorioComissoes, updateItem } from './itens';
import {
  checkAccess,
  createRecord,
  deleteRecord,
  getRecord,
  getStore,
  listRecords,
  optionsFor,
  toHttpError,
  updateRecord,
} from './services';
import { parseId } from './validate';
import { HttpError } from './errors';
import { assertProductionSecrets, corsOrigin, loginRateLimit, securityHeaders } from './security';
import { initSentry, reportarErro } from './log';
import { smtpConfigurado } from './mail';
import { estoqueGrade, fecharInventario, getInventarioDetalhe, listItensInventario, updateItensInventario } from './estoque';
import { relatorio } from './relatorios';
import { exportarRecurso } from './export';
import { confirmarImportacao, modeloImportacao, previewImportacao } from './importacao';
import {
  aplicarPrecoFicha,
  createInsumoFicha,
  createItemOrdem,
  deleteInsumoFicha,
  deleteItemOrdem,
  listInsumosFicha,
  listItensOrdem,
  updateInsumoFicha,
  updateItemOrdem,
} from './producao';
import { adminBackup, backupInfo } from './backup';
import { catalogoPublico, criarPedidoCatalogo, rateLimitPublico } from './catalogos';
import { criarLancamentoManual, resumoFinanceiro } from './financeiro';
import { vendaPDF, compraPDF } from './pdf';
import { produtoQRCode, produtoQRCodeSVG, produtoQRDados, produtoEtiquetaQR } from './qrcode';
import { listAprovacoes, aprovarPedido, rejeitarPedido, countAprovacoes } from './approval';
import { runScheduled, cronScheduled, scheduledStatus } from './scheduled';
import { listQualidade, createQualidade, relatorioQualidade } from './quality';
import { predicaoDemanda, predicaoInsumos } from './prediction';
import { rateLimitPortal, portalPedidos, portalPedidoDetalhe } from './portal';
import { notificacoesStatus, verificarAlertasEstoque } from './notifications';
import { openapiJSON, openapiUI } from './openapi';
import { listConversas, listMensagens, sendMessage, countNaoLidas } from './chat';
import { nfeDados, nfeEmitir, nfeStatus } from './nfe';
import { calcularFrete, consultarCEP } from './frete';
import { marketplaceStatus, sincronizarPedidos } from './marketplace';
import { initWebSocket, wsStatus } from './websocket';
import { createServer } from 'node:http';

assertProductionSecrets();
initSentry();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = process.env.npm_package_version || '0.5.0';
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/proxies: IP real em X-Forwarded-For
app.use(securityHeaders);
app.use(
  cors({
    origin: corsOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
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
// "Esqueci minha senha" — públicos (mesmo limite de tentativas do login)
app.post('/api/auth/forgot', loginRateLimit, wrap(forgotPassword));
app.post('/api/auth/reset', wrap(resetPassword));
// Catálogo público (somente leitura; rate limit próprio)
app.get('/api/publico/catalogo/:token', rateLimitPublico, wrap(catalogoPublico));
// Pedido pelo catálogo — cria uma cotação de venda no ERP (sem login, rate limit)
app.post('/api/publico/catalogo/:token/pedido', rateLimitPublico, wrap(criarPedidoCatalogo));
// Portal do cliente (acompanhamento de pedidos por CPF/CNPJ)
app.get('/api/portal/:token/pedidos', rateLimitPortal, wrap(portalPedidos));
app.get('/api/portal/:token/pedido/:id', rateLimitPortal, wrap(portalPedidoDetalhe));
// Imagens armazenadas no banco: URL pública protegida por token aleatório
app.get('/api/files/:id/:token', wrap(serveFile));

// ----------------------------------------------------------------------------
// Autenticado
// ----------------------------------------------------------------------------
app.use('/api', wrap(requireAuth));

app.get('/api/auth/me', me);
app.post('/api/auth/change-password', wrap(changePassword));
app.post('/api/auth/logout-all', wrap(logoutAll));
// Preferências por usuário (Fase 7 — JSONB no banco, espelhadas no navegador)
app.get('/api/auth/preferences', wrap(getPreferences));
app.put('/api/auth/preferences', wrap(savePreferences));

// Metadados dos módulos (campos, tipos, opções) — o front monta formulários com isso
app.get('/api/meta', (req, res) => {
  res.json({
    resources: publicMeta(),
    mode: getStore().kind,
    uploads: uploadProvider(),
    uploadsConfigError: uploadsConfigError(),
    version: VERSION,
    user: currentUser(req),
    smtp: { configurado: smtpConfigurado() },
  });
});

app.get(
  '/api/dashboard',
  wrap(async (_req, res) => {
    res.json(await getStore().dashboard());
  })
);

// Financeiro — resumo do fluxo de caixa e lançamento manual rápido
app.get('/api/financeiro/resumo', wrap(resumoFinanceiro));
app.post('/api/financeiro/lancamentos', wrap(criarLancamentoManual));

// Página de detalhe do produto (fotos, grade de estoque, movimentações, OPs, ficha)
app.get('/api/produtos/:id/detalhe', wrap(productDetail));

// Itens de pedidos de venda/compra (sub-recursos) — antes das rotas genéricas
app.get('/api/vendas/:id/itens', wrap(listItens));
app.post('/api/vendas/:id/itens', wrap(createItem));
app.put('/api/vendas/:id/itens/:itemId', wrap(updateItem));
app.delete('/api/vendas/:id/itens/:itemId', wrap(deleteItem));
app.get('/api/compras/:id/itens', wrap(listItens));
app.post('/api/compras/:id/itens', wrap(createItem));
app.put('/api/compras/:id/itens/:itemId', wrap(updateItem));
app.delete('/api/compras/:id/itens/:itemId', wrap(deleteItem));

// Relatório de comissões de representantes (antes de /api/:resource/:id)
app.get('/api/relatorios/comissoes', wrap(relatorioComissoes));

// PDF dos pedidos (antes das rotas genéricas)
app.get('/api/vendas/:id/pdf', wrap(vendaPDF));
app.get('/api/compras/:id/pdf', wrap(compraPDF));

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

// Marketplace
app.get('/api/marketplace/status', wrap(marketplaceStatus));
app.post('/api/marketplace/sincronizar', wrap(sincronizarPedidos));

// WebSocket status
app.get('/api/admin/ws/status', (_req, res) => res.json(wsStatus()));

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
app.get('/api/inventarios/:id', wrap(getInventarioDetalhe));
app.get('/api/inventarios/:id/itens', wrap(listItensInventario));
app.put('/api/inventarios/:id/itens', wrap(updateItensInventario));
app.post('/api/inventarios/:id/fechar', wrap(fecharInventario));

// Fase 5 — relatórios, importação e exportação
app.get('/api/relatorios/:nome', wrap(async (req, res) => relatorio(req, res, req.params.nome)));
app.post('/api/importar/preview', wrap(previewImportacao));
app.post('/api/importar/confirmar', wrap(confirmarImportacao));
app.get('/api/importar/modelo', wrap(modeloImportacao));
app.get('/api/:resource/export', wrap(async (req, res) => exportarRecurso(req, res, req.params.resource)));

// Fase 6 — backup (admin)
app.get('/api/admin/backup', wrap(adminBackup));
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
    res.status(201).json(await createRecord(r, req.body, actor));
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
  res.status(httpErr.status).json({ error: httpErr.message, fields: httpErr.fields });
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
  await ensureAdmin();
  await migrarSenhasLegadas();

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
