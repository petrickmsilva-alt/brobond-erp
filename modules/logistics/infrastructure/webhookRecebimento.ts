// ============================================================================
// MOTOR DE FRETE › INFRA › RECEPÇÃO DE WEBHOOK DE TRANSPORTADORA
//
// Recebe a entrega CRUA (bytes), valida a assinatura HMAC sobre os bytes,
// aplica o rate limit, registra no inbox idempotente e enfileira no outbox.
// NÃO processa rastreio aqui — quem processa é o worker (`logistics-webhook`),
// que consulta o evento e atualiza o envio com idempotência e não regressão.
//
// A EMPRESA dona do operador é resolvida por `LOGISTICS_<PROVIDER>_EMPRESA_ID`
// (default: empresa padrão). O operador vem da ROTA, nunca do corpo.
// ============================================================================
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { EMPRESA_PADRAO } from '../../../server/src/empresa';
import { carrier } from '../providers/contract';
import {
  validarAssinatura,
  validarTimestamp,
  webhookHabilitado,
  consumirRateLimit,
  ipDoPedido,
  limiteBytes,
  HEADER_ASSINATURA,
  HEADER_DELIVERY,
  HEADER_EVENTO,
  HEADER_TIMESTAMP,
} from './webhookSeguranca';
import { registrarEntrega, hashCorpo } from './webhookInbox';

/** Empresa dona do operador (explícita por operador; default: padrão). */
export function empresaDoProvider(provider: string): number {
  const bruto = Number(String(process.env[`LOGISTICS_${provider.toUpperCase()}_EMPRESA_ID`] ?? '').trim());
  if (Number.isInteger(bruto) && bruto > 0) return bruto;
  const global = Number(String(process.env.LOGISTICS_EMPRESA_ID ?? '').trim());
  if (Number.isInteger(global) && global > 0) return global;
  return EMPRESA_PADRAO;
}

/** Corpo cru a partir do Buffer do express.raw. */
function corpoCru(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  // Fallback defensivo: re-serializa (a assinatura pode não conferir, mas não
  // lançamos aqui — a validação de assinatura decide).
  return Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
}

function corpoJson(buf: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function webhookReceber(req: Request, res: Response): Promise<void> {
  const provider = String(req.params.provider ?? '').trim().toLowerCase();
  const adapter = carrier(provider);

  // Operador desconhecido: 404 sem processar nada.
  if (!adapter) {
    res.status(404).json({ error: 'Operador de logística desconhecido.' });
    return;
  }
  // Endpoint desabilitado sem segredo configurado (falha fechada).
  if (!webhookHabilitado(provider)) {
    res.status(404).json({ error: 'Webhook não habilitado para este operador.' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  const ip = ipDoPedido(req.headers as Record<string, unknown>, req.socket?.remoteAddress);
  const rate = consumirRateLimit(ip);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfterSeg));
    res.status(429).json({ error: 'Excesso de requisições.' });
    return;
  }

  const buf = corpoCru(req);
  if (buf.length > limiteBytes()) {
    res.status(413).json({ error: 'Corpo acima do limite.' });
    return;
  }

  // Timestamp: janela de tolerância (replay).
  const ts = validarTimestamp(req.header(HEADER_TIMESTAMP) as string | undefined);
  if (!ts.ok) {
    res.status(400).json({ error: ts.motivo });
    return;
  }

  // Assinatura HMAC sobre os BYTES CRUS.
  const assinatura = validarAssinatura(buf, req.header(HEADER_ASSINATURA) as string | undefined, provider);
  const empresaId = empresaDoProvider(provider);
  const payload = corpoJson(buf);
  const deliveryId = (req.header(HEADER_DELIVERY) as string | undefined)?.trim() || (typeof payload.id === 'string' ? payload.id : null) || null;
  const eventType = (req.header(HEADER_EVENTO) as string | undefined)?.trim() || (typeof payload.event === 'string' ? payload.event : null) || null;
  const correlationId = req.header('x-correlation-id') as string | undefined;

  // Assinatura inválida: registra para auditoria/métrica, responde 401 e NÃO
  // enfileira (o inbox grava com status 'rejeitado').
  if (!assinatura.ok) {
    try {
      await registrarEntrega(empresaId, {
        provider,
        event_type: eventType,
        external_delivery_id: deliveryId,
        payload,
        payload_hash: hashCorpo(buf),
        assinatura_ok: false,
        correlation_id: correlationId ?? null,
      });
    } catch {
      /* registro best-effort */
    }
    res.status(401).json({ error: 'Assinatura inválida.' });
    return;
  }

  try {
    const r = await registrarEntrega(empresaId, {
      provider,
      event_type: eventType,
      external_delivery_id: deliveryId,
      payload,
      payload_hash: hashCorpo(buf),
      assinatura_ok: true,
      correlation_id: correlationId ?? null,
    });
    res.status(202).json({ ok: true, duplicado: r.duplicado, inbox_id: r.id });
  } catch (e) {
    // Nunca vaza detalhe interno; o log fica no servidor.
    console.error('[logistics:webhook] falha ao registrar entrega', { provider, erro: e instanceof Error ? e.message : String(e) });
    res.status(500).json({ error: 'Falha ao receber a entrega.' });
  }
}

/** GET liveness: valida que a URL está viva antes de o operador habilitar o push. */
export function webhookLiveness(req: Request, res: Response): void {
  const provider = String(req.params.provider ?? '').trim().toLowerCase();
  const adapter = carrier(provider);
  if (!adapter || !webhookHabilitado(provider)) {
    res.status(404).json({ error: 'Webhook não habilitado para este operador.' });
    return;
  }
  res.status(200).json({ ok: true, provider });
}

/** Hash de assinatura exposto para testes de idempotência. */
export function hashDoCorpo(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
