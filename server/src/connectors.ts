// Conectores de marketplace — camada HTTP do módulo `modules/connectors`.
//
// Autenticado (sessão do ERP):
//   GET    /api/connectors                      — cartões dos quatro canais
//   GET    /api/connectors/:provider            — status de um canal
//   GET    /api/connectors/:provider/painel     — status + telemetria
//          analítica (vendas, eventos de webhook, conteúdo importado)
//   POST   /api/connectors/:provider/autorizar  — inicia o OAuth (aceita o
//          redirect_uri dinâmico: a origem da Render onde o painel roda)
//   POST   /api/connectors/mercadopago/conectar — credenciais de produção
//   POST   /api/connectors/:provider/sincronizar— rodada de catálogo
//   DELETE /api/connectors/:provider            — desconecta
//
// PÚBLICO (sem sessão, por projeto — ver `publicConnectorsRouter`):
//   GET|POST /api/connectors/:provider/callback — retorno do OAuth
//   GET|POST /api/webhooks/:provider            — pedidos em tempo real
//
// O INSTAGRAM tem controller próprio
// (`modules/connectors/instagram/instagram.controller.ts`), montado
// ANTES do despachante genérico: a Meta exige handshake `hub.challenge`
// em texto puro e assina com `x-hub-signature-256`.
//
// O módulo é agnóstico de framework: tudo que o Express conhece dele
// entra por `modules/connectors/index.ts`. Aqui ficam apenas tradução de
// HTTP, injeção do banco/auditoria e as regras de montagem.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { currentUser } from './auth';
import { empresaExplicitaAudit } from './empresa';
import { hasDatabaseUrl, pool, withTransaction } from './db';
import { HttpError } from './errors';
import { getResource } from './resources';
import { getStore } from './services';
import { instagramWebhookRouter } from './modules/connectors/instagram/instagram.controller';
import {
  appUrl,
  connectorWebhookPath,
  CONNECTOR_PROVIDER_LABELS,
  ConnectorError,
  connectorErrorMessage,
  connectorPanelService,
  connectorService,
  connectorSyncService,
  handleProviderWebhook,
  instagramConnectorService,
  parseConnectorProvider,
  setConnectorAuditLogger,
  setConnectorDatabase,
  WebhookSignatureError,
  type ConnectorProviderName,
} from '../../modules/connectors/index';

// ----------------------------------------------------------------------------
// Boot do módulo
// ----------------------------------------------------------------------------

/**
 * Liga o módulo de conectores à infraestrutura do ERP: pool do Postgres
 * (com transação real para a ingestão) e trilha de auditoria.
 *
 * Idempotente — chamar duas vezes não duplica nada.
 */
export function initConnectors(): void {
  setConnectorDatabase({
    async query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      if (!pool) throw new Error('NO_DB');
      const result = await pool.query(text, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    // Venda e itens entram juntos: a ingestão roda dentro de uma
    // transação de verdade, com o MESMO client do pool.
    transaction(fn) {
      return withTransaction(async (client) =>
        fn({
          async query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]) {
            const result = await client.query(text, params ? [...params] : undefined);
            return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
          },
        })
      );
    },
  });

  setConnectorAuditLogger(async (entry) => {
    // A tabela connectors é por usuário: a empresa do evento é a do dono.
    let empresaId: number | null = null;
    try {
      const dono = entry.usuarioId ? await getStore().findOneWhere(getResource('usuarios')!, { id: entry.usuarioId }) : null;
      if (dono && Number(dono.empresa_id) > 0) empresaId = Number(dono.empresa_id);
    } catch {
      /* best-effort: sem empresa resolvida cai na padrão */
    }
    await getStore().audit({
      usuario_id: entry.usuarioId || null,
      usuario: null,
      acao: 'editar',
      recurso: 'connectors',
      registro_id: null,
      descricao: `${CONNECTOR_PROVIDER_LABELS[entry.provider]}: ${entry.action}`,
      dados: { connectorId: entry.connectorId ?? null, ...(entry.metadata ?? {}) },
      empresa_id: empresaExplicitaAudit(empresaId, null),
    });
  });
}

// ----------------------------------------------------------------------------
// Utilitários de rota
// ----------------------------------------------------------------------------

/**
 * O módulo exige Postgres: a credencial fica cifrada em `connectors` e a
 * idempotência da ingestão depende das chaves únicas criadas na Fase 1.
 * Sem DATABASE_URL o ERP roda em memória (modo demonstração) e os
 * conectores respondem 503 com a ação concreta — nunca um 500 opaco.
 */
function assertConnectorsDatabase(): void {
  if (!hasDatabaseUrl()) {
    throw new HttpError(503, 'Conectores de marketplace exigem banco de dados. Configure DATABASE_URL para conectar as contas.');
  }
}

/** Lê e valida o segmento `:provider` da rota (404 se desconhecido). */
function providerParam(req: Request): ConnectorProviderName {
  const provider = parseConnectorProvider(req.params.provider);
  if (!provider) throw new HttpError(404, 'Conector não encontrado.');
  return provider;
}

/** Traduz os erros de domínio do módulo para HTTP. */
function toConnectorHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ConnectorError) {
    return new HttpError(error.httpStatus ?? 409, error.message);
  }
  console.error('Erro inesperado em conectores:', error);
  return new HttpError(500, connectorErrorMessage(error));
}

const run = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch((error) => next(toConnectorHttpError(error)));
};

// ----------------------------------------------------------------------------
// Rotas autenticadas (painel)
// ----------------------------------------------------------------------------

export const connectorsRouter: Router = Router({ mergeParams: true });

connectorsRouter.get(
  '/',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    res.json({ connectors: await connectorService.listStatus(actor.id) });
  })
);

connectorsRouter.post(
  '/mercadopago/conectar-ambiente',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    const connector = await connectorService.connectMercadoPagoFromEnvironment(actor.id);
    res.json({ ok: true, connector: await connectorService.getStatus(actor.id, connector.provider) });
  })
);

connectorsRouter.post(
  '/mercadopago/conectar',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    const accessToken = String(req.body?.accessToken ?? '').trim();
    const publicKey = String(req.body?.publicKey ?? '').trim();
    if (!accessToken || !publicKey) {
      throw new HttpError(400, 'Informe o Access Token e a Public Key de produção do Mercado Pago.');
    }
    const connector = await connectorService.connectMercadoPago(actor.id, {
      accessToken,
      publicKey,
    });
    res.json({ ok: true, connector: await connectorService.getStatus(actor.id, connector.provider) });
  })
);

connectorsRouter.get(
  '/:provider',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    res.json(await connectorService.getStatus(actor.id, providerParam(req)));
  })
);

connectorsRouter.get(
  '/:provider/painel',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    const provider = providerParam(req);
    const limite = Number(req.query.limite ?? 10);
    // O painel é SOMENTE LEITURA: status (sem segredos) + telemetria
    // analítica (vendas, eventos de webhook e conteúdo importado).
    //
    // O Instagram responde pelas CONSULTAS DO PRÓPRIO SERVIÇO
    // (`InstagramConnectorService`): mesma forma de DTO, origem de dados
    // independente — é ele que alimenta "Pedidos Importados", "Receita
    // do Canal" e a caixa "Webhooks — eventos recebidos" do canal.
    const [connector, panel] = await Promise.all([
      connectorService.getStatus(actor.id, provider),
      provider === 'INSTAGRAM'
        ? instagramConnectorService.getPanel(actor.id, limite)
        : connectorPanelService.getPanel(actor.id, provider, limite),
    ]);
    res.json({ connector, panel });
  })
);

connectorsRouter.post(
  '/:provider/autorizar',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    // `redirect_uri` dinâmico: a ORIGEM em que o navegador do operador está
    // (na Render, https://brobond-erp.onrender.com). O caminho canônico do
    // callback é derivado e validado no módulo — nunca montado no cliente.
    const redirectBase = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';
    res.json(await connectorService.startAuthorization(actor.id, providerParam(req), { redirectBase }));
  })
);

connectorsRouter.post(
  '/:provider/sincronizar',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    const provider = providerParam(req);
    const limite = Number(req.body?.limite ?? req.query.limite ?? 50);
    res.json(await connectorSyncService.sync(actor.id, provider, limite));
  })
);

connectorsRouter.delete(
  '/:provider',
  run(async (req, res) => {
    assertConnectorsDatabase();
    const actor = currentUser(req);
    const provider = providerParam(req);
    await connectorService.disconnect(actor.id, provider);
    res.json({ ok: true, connector: await connectorService.getStatus(actor.id, provider) });
  })
);

// ----------------------------------------------------------------------------
// Rotas públicas (OAuth callback + webhooks)
// ----------------------------------------------------------------------------

/**
 * Router PÚBLICO. Montado ANTES de `requireAuth`/`bloquearSenhaProvisoria`
 * porque quem bate nele é o provedor externo, não o navegador do
 * operador: Mercado Livre, Mercado Pago e Nuvemshop chegam sem cookie
 * e sem Bearer. O bloqueio de sessão aqui transformaria todo
 * webhook em 401 e toda conexão em erro.
 *
 * A segurança NÃO vem da sessão e sim de:
 *   • callback OAuth → `state` de uso único, atado ao `usuario_id`;
 *   • webhook → assinatura HMAC do provedor sobre os BYTES CRUS, e o
 *     responsável resolvido pelo `shop_id` já gravado no conector.
 */
export const publicConnectorsRouter: Router = Router();

// O Instagram entra PRIMEIRO: handshake `hub.challenge` em texto puro e
// assinatura `x-hub-signature-256` não cabem no despachante genérico.
// Ele responde apenas por `/api/webhooks/instagram`; todo o resto segue
// o fluxo de sempre.
publicConnectorsRouter.use(instagramWebhookRouter);

/**
 * Corpo CRU. Toda assinatura é calculada sobre os bytes exatos — depois
 * de `express.json()` o payload já foi reserializado e o HMAC nunca mais
 * bate. Por isso este router é montado antes do parser global e lê o
 * corpo com `express.raw({ type: '*\/*' })`.
 */
const rawBody = express.raw({ type: '*/*', limit: '2mb' });

function rawBodyString(req: Request): string {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return '';
}

function queryRecord(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}

function headerRecord(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** Página mínima de retorno do OAuth (o provedor abre isso no navegador). */
function callbackPage(title: string, message: string, ok: boolean): string {
  const cor = ok ? '#047857' : '#b91c1c';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<main style="background:#fff;border-radius:12px;padding:32px;max-width:460px;box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center">
<h1 style="color:${cor};font-size:20px;margin:0 0 12px">${title}</h1>
<p style="color:#334155;line-height:1.5;margin:0 0 20px">${message}</p>
<a href="${appUrl('/conectores')}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">Voltar ao ERP</a>
</main></body></html>`;
}

// Retorno do consentimento OAuth. Responde HTML porque quem é
// redirecionado para cá é o NAVEGADOR do operador.
publicConnectorsRouter.all('/api/connectors/:provider/callback', rawBody, (req: Request, res: Response, next: NextFunction) => {
  const provider = parseConnectorProvider(req.params.provider);
  if (!provider) return next(); // slug desconhecido segue o fluxo normal (404 do /api)
  void (async () => {
    const query = queryRecord(req);
    // Alguns provedores devolvem o callback como formulário POST; outros,
    // inclusive Mercado Livre e Nuvemshop, usam query string.
    const form = new URLSearchParams(rawBodyString(req));
    const value = (name: string) => query[name] ?? form.get(name) ?? '';
    const code = value('code') || value('auth_code');
    const state = value('state');
    const erroProvedor = value('error_description') || value('error');
    try {
      if (!hasDatabaseUrl()) {
        throw new ConnectorError('Conectores exigem banco de dados configurado (DATABASE_URL).', provider);
      }
      if (erroProvedor) {
        throw new ConnectorError(`Autorização recusada pelo provedor: ${erroProvedor}`, provider);
      }
      if (!code || !state) {
        throw new ConnectorError('Retorno de autorização incompleto (code/state ausentes).', provider);
      }
      await connectorService.handleOAuthCallback(provider, {
        code,
        state,
        shopId: query.shop_id ?? null,
      });
      res
        .status(200)
        .type('html')
        .send(
          callbackPage(
            `${CONNECTOR_PROVIDER_LABELS[provider]} conectado`,
            'A conta foi vinculada ao seu usuário. Já pode fechar esta janela e voltar ao painel de conectores.',
            true
          )
        );
    } catch (error) {
      const mensagem = connectorErrorMessage(error);
      console.warn(`⚠️  Callback OAuth recusado (${provider}):`, mensagem);
      res
        .status(400)
        .type('html')
        .send(callbackPage(`Não foi possível conectar ${CONNECTOR_PROVIDER_LABELS[provider]}`, mensagem, false));
    }
  })();
});

// Webhooks de pedido em tempo real.
//
// CUIDADO DE ROTEAMENTO: o ERP já tem um CRUD AUTENTICADO em
// /api/webhooks (listar, :id/testar, entregas/:id/reenviar). Quando o
// segmento não é um dos provedores registrados, este router chama next() e a
// requisição segue para o CRUD de sempre — nenhuma rota existente muda
// de comportamento.
publicConnectorsRouter.all('/api/webhooks/:provider', rawBody, (req: Request, res: Response, next: NextFunction) => {
  const provider = parseConnectorProvider(req.params.provider);
  if (!provider) return next();

  // GET é handshake/liveness: a plataforma valida a URL antes de
  // habilitar o push.
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({ ok: true, provider, endpoint: connectorWebhookPath(req.params.provider) });
    return;
  }
  if (req.method !== 'POST') return next();

  void (async () => {
    try {
      if (!hasDatabaseUrl()) {
        // Sem banco não há como gravar o evento de forma idempotente.
        // 503 faz o provedor reentregar depois — perder a venda em
        // silêncio seria pior.
        res.status(503).json({ error: 'Conectores indisponíveis: banco de dados não configurado.' });
        return;
      }
      const result = await handleProviderWebhook(provider, {
        headers: headerRecord(req),
        rawBody: rawBodyString(req),
        // URL ESTÁTICA (APP_URL): o provedor assina a URL cadastrada no
        // painel dele, não o Host que chega no proxy.
        url: appUrl(connectorWebhookPath(req.params.provider)),
        query: queryRecord(req),
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        res.status(401).json({ error: error.message });
        return;
      }
      console.warn(`⚠️  Webhook recusado (${provider}):`, connectorErrorMessage(error));
      res.status(400).json({ error: connectorErrorMessage(error) });
    }
  })();
});
