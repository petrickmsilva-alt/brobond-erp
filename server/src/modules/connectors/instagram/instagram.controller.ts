// ============================================================================
// Instagram Shopping — camada HTTP do conector (rotas PÚBLICAS da Meta).
//
// Rotas servidas aqui:
//   GET  /api/webhooks/instagram  — handshake `hub.challenge` do cadastro
//                                   do webhook no app da Meta
//   POST /api/webhooks/instagram  — entregas assinadas em tempo real
//
// POR QUE UM CONTROLLER PRÓPRIO (e não o despachante genérico):
//
//   1. a Meta valida a URL com um GET que exige o `hub.challenge` de
//      volta em TEXTO PURO — o GET genérico responde JSON e o cadastro
//      falharia;
//   2. a assinatura é `sha256=<hex>` em `x-hub-signature-256` sobre os
//      BYTES CRUS, um terceiro formato além dos três já existentes;
//   3. um POST da Meta traz VÁRIAS entradas (`entry[]`) e vários eventos
//      por entrada — o contrato genérico é "um corpo, um evento".
//
// Isolamento: este arquivo importa SOMENTE o módulo do Instagram. Mexer
// aqui não toca em Mercado Livre, Mercado Pago nem Nuvemshop.
// ============================================================================
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { hasDatabaseUrl } from '../../../db';
import {
  connectorErrorMessage,
  connectorWebhookPath,
  instagramConnectorService,
  WebhookSignatureError,
} from '../../../../../modules/connectors/index';

/** Slug canônico do canal nas rotas públicas. */
export const INSTAGRAM_WEBHOOK_SLUG = 'instagram';

/** Caminho público do webhook, para cadastro no app da Meta. */
export const INSTAGRAM_WEBHOOK_PATH = connectorWebhookPath(INSTAGRAM_WEBHOOK_SLUG);

/**
 * Corpo CRU. O HMAC da Meta é calculado sobre os bytes exatos: depois de
 * `express.json()` o payload já foi reserializado e a assinatura nunca
 * mais bate.
 */
const rawBody = express.raw({ type: '*/*', limit: '2mb' });

function rawBodyString(req: Request): string {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return '';
}

function headerRecord(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function queryRecord(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0] as string;
  }
  return out;
}

/**
 * Router PÚBLICO do Instagram. Montado ANTES do despachante genérico de
 * `/api/webhooks/:provider` e fora do middleware de sessão: quem bate
 * aqui é a Meta, sem cookie e sem Bearer. A segurança vem do
 * `hub.verify_token` (cadastro) e do HMAC do app secret (entregas).
 */
export const instagramWebhookRouter: Router = Router();

/**
 * Handshake de verificação. A Meta chama com
 * `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` e só habilita
 * o push quando recebe o challenge de volta, em `text/plain`.
 *
 * Sem os parâmetros de handshake a rota responde liveness — é o que um
 * monitor externo (ou o próprio operador) usa para conferir a URL.
 */
instagramWebhookRouter.get(`${INSTAGRAM_WEBHOOK_PATH}`, (req: Request, res: Response) => {
  const query = queryRecord(req);
  if (!query['hub.mode'] && !query['hub.challenge']) {
    res.status(200).json({ ok: true, provider: 'INSTAGRAM', endpoint: INSTAGRAM_WEBHOOK_PATH });
    return;
  }
  const challenge = instagramConnectorService.verifySubscription(query);
  if (challenge === null) {
    console.warn('⚠️  Handshake do webhook do Instagram recusado: hub.verify_token inválido ou ausente.');
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }
  res.status(200).type('text/plain').send(challenge);
});

/** Entregas em tempo real (assinadas). */
instagramWebhookRouter.post(`${INSTAGRAM_WEBHOOK_PATH}`, rawBody, (req: Request, res: Response) => {
  void (async () => {
    try {
      if (!hasDatabaseUrl()) {
        // Sem banco não há como gravar o evento de forma idempotente.
        // 503 faz a Meta reentregar depois — perder a entrega em
        // silêncio seria pior.
        res.status(503).json({ error: 'Conector do Instagram indisponível: banco de dados não configurado.' });
        return;
      }
      const result = await instagramConnectorService.handleWebhook({
        headers: headerRecord(req),
        rawBody: rawBodyString(req),
        query: queryRecord(req),
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        res.status(401).json({ error: error.message });
        return;
      }
      console.warn('⚠️  Webhook do Instagram recusado:', connectorErrorMessage(error));
      res.status(400).json({ error: connectorErrorMessage(error) });
    }
  })();
});

/** Qualquer outro verbo no endpoint segue o fluxo normal do ERP. */
instagramWebhookRouter.all(`${INSTAGRAM_WEBHOOK_PATH}`, (_req: Request, _res: Response, next: NextFunction) => next());
