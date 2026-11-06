// ============================================================================
// COMMERCE OS — WOOCOMMERCE MULTI-STORE › RECEPÇÃO DE WEBHOOK (rota PÚBLICA).
//
// Montada ANTES de `express.json()` e de `requireAuth`: quem bate aqui é a
// LOJA, não o navegador do operador. A segurança NÃO vem da sessão e sim da
// ASSINATURA HMAC sobre os BYTES CRUS (o parser JSON destruiria a assinatura).
//
// A loja vem SEMPRE do path (`/api/commerce/woocommerce/webhooks/:store`) —
// nunca do corpo. É isso que impede um atacante de escolher o segredo de
// validação enviando `store_key` no payload.
//
// Fluxo do POST (rápido, sem trabalho pesado):
//   1. rate limit por IP;
//   2. teto de tamanho do corpo;
//   3. loja do path (RETAIL | WHOLESALE) → config + segredo DAQUELA loja;
//   4. assinatura HMAC-SHA256 em tempo constante (recusa 401);
//   5. janela de timestamp (quando a loja informa);
//   6. estrutura mínima do evento;
//   7. registro IDEMPOTENTE no inbox;
//   8. enfileiramento no outbox (worker processa depois);
//   9. resposta rápida (200/202).
//
// Assinatura inválida é REGISTRADA (auditoria/métrica) e recusada — nunca
// enfileirada. Nenhuma resposta carrega segredo, credencial ou o corpo remoto.
// ============================================================================
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { log } from '../../log';
import { getStore } from '../../services';
import { getResource } from '../../resources';
import { exigirConfigStore, ehStoreKey, multiStoreHabilitado, type StoreKey } from './registry';
import {
  HEADER_ASSINATURA,
  HEADER_DELIVERY,
  HEADER_ENTREGA_HORA,
  HEADER_FONTE,
  HEADER_RECURSO,
  HEADER_TIMESTAMP,
  consumirRateLimit,
  ipDoPedido,
  limiteBytes,
  minimizarPayload,
  recursoExterno,
  topicoDoEvento,
  validarAssinatura,
  validarTimestamp,
} from './webhookSeguranca';
import { hashCorpo, registrarEntrega } from './webhookInbox';

const R_WOO_WEBHOOKS = () => getResource('woocommerce_webhook_events')!;

/** Cabeçalhos em minúsculas (o Node já normaliza, mas o teste injeta cru). */
function headers(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = v;
  return out;
}

function corpoCru(req: Request): Buffer {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.alloc(0);
}

/** Loja do path — identificador fechado, nunca derivado do corpo. */
function lojaDoPath(req: Request): StoreKey | null {
  const bruto = String(req.params.store ?? '').trim().toUpperCase();
  return ehStoreKey(bruto) ? bruto : null;
}

/** Estrutura mínima: objeto JSON não vazio com um id de recurso. */
function corpoValido(corpo: Record<string, unknown>): boolean {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return false;
  return Object.keys(corpo).length > 0;
}

/** Liveness/handshake: a plataforma valida a URL antes de habilitar o push. */
export function webhookLiveness(req: Request, res: Response): void {
  const store = lojaDoPath(req);
  if (!store) {
    res.status(404).json({ error: 'Loja desconhecida.' });
    return;
  }
  res.status(200).json({ ok: true, store_key: store, endpoint: `/api/commerce/woocommerce/webhooks/${store}` });
}

/**
 * Recebe a entrega. Responde rápido: o processamento é assíncrono (outbox).
 *
 * Códigos: 404 loja desconhecida · 429 rate limit · 413 corpo grande ·
 * 503 banco/modo indisponível · 401 assinatura/timestamp inválidos ·
 * 400 estrutura inválida · 200 aceito · 202 duplicado.
 */
export async function webhookReceber(req: Request, res: Response): Promise<void> {
  const inicio = Date.now();
  const store = lojaDoPath(req);
  if (!store) {
    res.status(404).json({ error: 'Loja desconhecida.' });
    return;
  }

  const ip = ipDoPedido(req.headers as Record<string, unknown>, req.socket?.remoteAddress);
  const limite = consumirRateLimit(ip);
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.retryAfterSeg));
    res.status(429).json({ error: 'Muitas entregas. Tente novamente em instantes.' });
    return;
  }

  const h = headers(req);
  const cru = corpoCru(req);
  if (cru.length > limiteBytes()) {
    res.status(413).json({ error: 'Payload acima do limite aceito.' });
    return;
  }
  if (!cru.length) {
    res.status(400).json({ error: 'Corpo vazio.' });
    return;
  }

  // Modo multi-loja desligado: o endpoint não aceita entrega (falha fechada,
  // nada é registrado — a loja não deve ter webhook cadastrado ainda).
  if (!multiStoreHabilitado()) {
    res.status(503).json({ error: 'Modo multi-loja desligado.' });
    return;
  }

  // Assinatura ANTES de qualquer efeito. Falha fechada: sem segredo da loja,
  // o endpoint não aceita nada.
  const assinatura = validarAssinatura(cru, String(h[HEADER_ASSINATURA] ?? ''), store);
  const timestamp = validarTimestamp(String(h[HEADER_ENTREGA_HORA] ?? h[HEADER_TIMESTAMP] ?? ''));

  let corpo: Record<string, unknown>;
  try {
    corpo = JSON.parse(cru.toString('utf8')) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: 'Corpo não é JSON válido.' });
    return;
  }
  if (!corpoValido(corpo)) {
    res.status(400).json({ error: 'Estrutura de evento inválida.' });
    return;
  }

  const assinaturaOk = assinatura.ok && timestamp.ok;
  const topic = topicoDoEvento(h, corpo);
  const recurso = String(h[HEADER_RECURSO] ?? '').trim() || topic.split('.')[0] || 'desconhecido';
  const entregaId = String(h[HEADER_DELIVERY] ?? '').trim() || null;
  const correlationId = randomUUID();

  if (!assinaturaOk) {
    // Registro forense da rejeição (sem corpo: nada de PII). Nunca enfileira.
    const motivo = !assinatura.ok ? assinatura.motivo : !timestamp.ok ? timestamp.motivo : 'Assinatura inválida.';
    await registrarRejeicao(store, { topic, recurso, entregaId, corpo: cru, correlationId, motivo });
    log.warn('woo_webhook_rejeitado', { store_key: store, topic, motivo: assinatura.ok ? 'timestamp' : 'assinatura' });
    res.status(401).json({ error: 'Assinatura inválida.' });
    return;
  }

  let cfg;
  try {
    cfg = exigirConfigStore(store);
  } catch {
    res.status(503).json({ error: `A loja ${store} não está configurada.` });
    return;
  }

  const dados = {
    topic,
    recurso,
    external_delivery_id: entregaId,
    external_resource_id: recursoExterno(corpo),
    payload: minimizarPayload(corpo),
    payload_hash: hashCorpo(cru),
    assinatura_ok: true,
    correlation_id: correlationId,
  };

  try {
    const entrega = await registrarEntrega(cfg, cfg.empresaId, dados);
    log.info('woo_webhook_recebido', {
      store_key: store,
      topic,
      entrega_id: entrega.id,
      duplicado: entrega.duplicado,
      correlation_id: correlationId,
      latencia_ms: Date.now() - inicio,
    });
    if (entrega.duplicado) res.status(202).json({ ok: true, duplicado: true, store_key: store, entrega_id: entrega.id });
    else res.status(200).json({ ok: true, store_key: store, entrega_id: entrega.id });
  } catch (e) {
    log.error('woo_webhook_falha', { store_key: store, topic, correlation_id: correlationId });
    // 503 faz a loja reentregar — perder o evento em silêncio seria pior.
    res.status(503).json({ error: 'Não foi possível registrar a entrega; a loja deve reentregar.' });
    void e;
  }
}

/** Rejeição registrada sem corpo (auditoria e métrica de eventos rejeitados). */
async function registrarRejeicao(
  store: StoreKey,
  dados: { topic: string; recurso: string; entregaId: string | null; corpo: Buffer; correlationId: string; motivo: string }
): Promise<void> {
  try {
    await getStore().insert(R_WOO_WEBHOOKS(), {
      empresa_id: exigirConfigStore(store).empresaId,
      store_key: store,
      topic: dados.topic,
      recurso: dados.recurso,
      external_delivery_id: dados.entregaId,
      external_resource_id: null,
      payload: null,
      payload_hash: hashCorpo(dados.corpo),
      assinatura_ok: false,
      status: 'rejeitado',
      attempts: 0,
      correlation_id: dados.correlationId,
      received_at: new Date().toISOString(),
      last_error: dados.motivo.slice(0, 500),
    });
  } catch {
    /* o log de segurança já registrou; nada mais a fazer aqui */
  }
}

/** Caminho público de UMA loja (usado na documentação e no diagnóstico). */
export function caminhoWebhook(store: StoreKey): string {
  return `/api/commerce/woocommerce/webhooks/${store}`;
}

export { HEADER_FONTE };
