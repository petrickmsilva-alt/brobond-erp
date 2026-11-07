// ============================================================================
// MOTOR DE FRETE › API › ROUTER PÚBLICO DE WEBHOOKS
//
// Montado ANTES de `express.json()` e de `requireAuth`:
//   • a sessão do ERP nunca pode barrar o operador (quem bate aqui é a
//     transportadora);
//   • a assinatura HMAC é calculada sobre os BYTES CRUS, que o parser JSON
//     destruiria.
//
// A segurança NÃO vem da sessão: vem da assinatura HMAC-SHA256 com segredo
// INDEPENDENTE por operador, do operador vindo do PATH e da idempotência do
// inbox. O segmento `:provider` é validado contra o registro: qualquer outro
// valor cai no next().
// ============================================================================
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { carrier } from '../providers/contract';
import { registrarCarriers } from '../providers/registry';
import { webhookLiveness, webhookReceber } from '../infrastructure/webhookRecebimento';

/** Corpo CRU: toda assinatura é calculada sobre os bytes exatos recebidos. */
const rawBody = express.raw({ type: '*/*', limit: '2mb' });

export const publicLogisticsWebhookRouter: Router = Router();

registrarCarriers();

publicLogisticsWebhookRouter.all('/api/logistics/webhooks/:provider', rawBody, (req: Request, res: Response, next: NextFunction) => {
  const provider = String(req.params.provider ?? '').trim().toLowerCase();
  if (!carrier(provider)) return next();

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
});
