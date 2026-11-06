// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › ROUTER PÚBLICO DE WEBHOOKS.
//
// Montado ANTES de `express.json()` e de `requireAuth` (ver server/src/index.ts):
//   • a sessão do ERP nunca pode barrar a loja (quem bate aqui é o WooCommerce);
//   • a assinatura HMAC é calculada sobre os BYTES CRUS, que o parser JSON
//     destruiria.
//
// A segurança NÃO vem da sessão: vem da assinatura HMAC-SHA256 com segredo
// INDEPENDENTE por loja, da LOJA vinda do PATH e da idempotência do inbox.
//
// O segmento `:store` é validado contra o registry: qualquer outro valor cai no
// next() e segue para as rotas de sempre (nunca responde por loja inexistente).
// ============================================================================
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { ehStoreKey } from './registry';
import { webhookLiveness, webhookReceber } from './webhookRecebimento';

/** Corpo CRU: toda assinatura é calculada sobre os bytes exatos recebidos. */
const rawBody = express.raw({ type: '*/*', limit: '2mb' });

export const publicWoocommerceWebhookRouter: Router = Router();

publicWoocommerceWebhookRouter.all(
  '/api/commerce/woocommerce/webhooks/:store',
  rawBody,
  (req: Request, res: Response, next: NextFunction) => {
    const store = String(req.params.store ?? '').trim().toUpperCase();
    if (!ehStoreKey(store)) return next();

    // GET/HEAD é liveness: a plataforma valida a URL antes de habilitar o push.
    if (req.method === 'GET' || req.method === 'HEAD') {
      webhookLiveness(req, res);
      return;
    }
    if (req.method !== 'POST') return next();

    void webhookReceber(req, res).catch((e) => {
      // Nunca vaza detalhe interno na resposta pública; o log fica no servidor.
      if (!res.headersSent) res.status(500).json({ error: 'Falha ao receber a entrega.' });
      void e;
    });
  }
);
