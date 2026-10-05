/**
 * Mercado Pago — API oficial, SOMENTE servidor.
 *
 * Fonte: `modules/marketplace/mercadopago/mercadopago.service.ts` +
 * `mercadopago/credentials.ts` do brobond-ai-commerce (PR012/PR014).
 *
 * O Mercado Pago não usa OAuth de redirecionamento aqui: o operador cola
 * no painel o par Access Token + Public Key de PRODUÇÃO, que é validado
 * contra `/users/me` ANTES de ser gravado (credencial nunca é persistida
 * sem passar na validação oficial) e guardado cifrado em `connectors`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderApiError, WebhookSignatureError } from '../core/errors';
import type { NormalizedContent } from '../core/connector.interface';
import type { ConnectorRow } from '../core/types';

const MP_API_BASE_URL = 'https://api.mercadopago.com';
const PROVIDER = 'MERCADOPAGO' as const;

function apiBaseUrl(): string {
  return process.env.MERCADOPAGO_API_BASE_URL?.trim() || MP_API_BASE_URL;
}

// ------------------------------------------------------------------
// Credenciais
// ------------------------------------------------------------------

export interface MercadoPagoEnvironmentCredentials {
  accessToken: string;
  publicKey: string;
}

export interface MercadoPagoEnvironment {
  [key: string]: string | undefined;
  MERCADOPAGO_ACCESS_TOKEN?: string;
  MERCADOPAGO_PUBLIC_KEY?: string;
}

/**
 * Par de credenciais do ambiente (fallback de deploy). A linha cifrada em
 * `connectors` SEMPRE tem precedência. Um par incompleto é tratado de
 * propósito como "não configurado": a UI nunca pode dizer que uma conexão
 * inutilizável está no ar.
 */
export function getMercadoPagoEnvironmentCredentials(env: MercadoPagoEnvironment = process.env): MercadoPagoEnvironmentCredentials | null {
  const accessToken = env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const publicKey = env.MERCADOPAGO_PUBLIC_KEY?.trim();
  if (!accessToken || !publicKey) return null;
  return { accessToken, publicKey };
}

/** `true` só quando as duas cifras existem na linha do responsável. */
export function hasPersistedMercadoPagoCredentials(connector: Pick<ConnectorRow, 'accessToken' | 'publicKey'> | null | undefined): boolean {
  return Boolean(connector?.accessToken && connector.publicKey);
}

// ------------------------------------------------------------------
// Identidade
// ------------------------------------------------------------------

export interface MercadoPagoIdentity {
  userId: string;
  nickname: string | null;
  email: string | null;
  siteId: string | null;
}

interface MpUserResponse {
  id?: number;
  nickname?: string;
  email?: string;
  site_id?: string;
}

/**
 * Valida um Access Token de produção contra a API oficial e devolve a
 * identidade do vendedor. Rejeita token inválido/revogado.
 */
export async function validateMercadoPagoAccessToken(accessToken: string): Promise<MercadoPagoIdentity> {
  let response: Response;
  try {
    response = await fetch(new URL('/users/me', apiBaseUrl()), {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o Mercado Pago.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as MpUserResponse | undefined;
  if (!response.ok || payload?.id === undefined) {
    throw new ProviderApiError('O Access Token do Mercado Pago é inválido ou foi revogado.', response.status || 401, PROVIDER, {
      requiresReauth: true,
    });
  }
  return {
    userId: String(payload.id),
    nickname: payload.nickname ?? null,
    email: payload.email ?? null,
    siteId: payload.site_id ?? null,
  };
}

// ------------------------------------------------------------------
// Pagamentos
// ------------------------------------------------------------------

/** Converte um valor decimal em centavos inteiros, limpando lixo. */
function toAmountCents(amount: number | null | undefined): number {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

interface MpPaymentsSearchResponse {
  results?: Array<{
    id?: number;
    status?: string;
    status_detail?: string;
    transaction_amount?: number;
    currency_id?: string;
    description?: string;
    date_created?: string;
  }>;
  message?: string;
}

/**
 * Busca os pagamentos recentes do checkout (feed de faturamento),
 * normalizados no contrato do framework.
 */
export async function fetchMercadoPagoPayments(accessToken: string, limit: number): Promise<NormalizedContent[]> {
  const url = new URL('/v1/payments/search', apiBaseUrl());
  url.searchParams.set('sort', 'date_created');
  url.searchParams.set('criteria', 'desc');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 50)));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o Mercado Pago.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as MpPaymentsSearchResponse | undefined;
  if (!response.ok) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || 'Não foi possível consultar os pagamentos do Mercado Pago.', status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }

  return (payload?.results ?? [])
    .filter((payment) => payment.id !== undefined)
    .map((payment) => ({
      externalId: `mp:payment:${payment.id}`,
      type: 'POST' as const,
      title: payment.description?.trim() || `Pagamento ${payment.id} — ${payment.status ?? 'desconhecido'}`,
      caption: `Status: ${payment.status ?? '?'} · ${payment.transaction_amount ?? 0} ${payment.currency_id ?? 'BRL'}`,
      priceCents: toAmountCents(payment.transaction_amount),
      currency: payment.currency_id ?? 'BRL',
      publishedAt: payment.date_created ? new Date(payment.date_created) : undefined,
      raw: {
        provider: 'mercadopago',
        paymentId: payment.id,
        status: payment.status,
        statusDetail: payment.status_detail,
        amount: payment.transaction_amount,
        currency: payment.currency_id,
      },
    }));
}

export interface MercadoPagoPaymentItem {
  sku: string | null;
  title: string;
  quantity: number;
  unitPriceCents: number;
}

export interface MercadoPagoPayment {
  id: string;
  /** approved · pending · in_process · rejected · refunded · cancelled · … */
  status: string;
  statusDetail: string | null;
  amountCents: number;
  currencyId: string;
  dateCreated: Date;
  dateApproved: Date | null;
  /** Referência de pedido externa reportada pelo MP (`order.id`), se houver. */
  externalOrderId: string;
  payerEmail: string | null;
  items: MercadoPagoPaymentItem[];
}

interface MpPaymentResponse {
  id?: number;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_created?: string;
  date_approved?: string | null;
  order?: { id?: string | number };
  payer?: { email?: string };
  additional_info?: {
    items?: Array<{
      id?: string;
      title?: string;
      quantity?: number | string;
      unit_price?: number | string;
    }>;
  };
  message?: string;
}

/**
 * Busca um pagamento (`GET /v1/payments/{id}`) — o `data.id` referenciado
 * pelas notificações `payment`.
 */
export async function fetchMercadoPagoPayment(accessToken: string, paymentId: string): Promise<MercadoPagoPayment> {
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/payments/${encodeURIComponent(paymentId)}`, apiBaseUrl()), {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    throw new ProviderApiError('Falha de rede ao contatar o Mercado Pago.', 503, PROVIDER);
  }
  const payload = (await response.json().catch(() => undefined)) as MpPaymentResponse | undefined;
  if (!response.ok || payload?.id === undefined) {
    const status = response.status || 502;
    throw new ProviderApiError(payload?.message || `Não foi possível obter o pagamento ${paymentId} do Mercado Pago.`, status, PROVIDER, {
      requiresReauth: status === 401 || status === 403,
    });
  }

  return {
    id: String(payload.id),
    status: payload.status ?? 'unknown',
    statusDetail: payload.status_detail ?? null,
    amountCents: toAmountCents(payload.transaction_amount),
    currencyId: payload.currency_id ?? 'BRL',
    dateCreated: payload.date_created ? new Date(payload.date_created) : new Date(),
    dateApproved: payload.date_approved ? new Date(payload.date_approved) : null,
    externalOrderId: payload.order?.id !== undefined ? String(payload.order.id) : String(payload.id),
    payerEmail: payload.payer?.email ?? null,
    items: (payload.additional_info?.items ?? []).map((item) => ({
      sku: item.id?.trim() || null,
      title: item.title?.trim() || `Item ${item.id ?? '—'}`,
      quantity: Math.max(1, Math.trunc(Number(item.quantity ?? 1)) || 1),
      unitPriceCents: toAmountCents(Number(item.unit_price ?? 0)),
    })),
  };
}

/** Mapeia o status de um pagamento para o ciclo de vida de `sales`. */
export function mercadoPagoStatusToSaleStatus(status: string): 'PAID' | 'PENDING' | 'REFUNDED' | 'CANCELLED' {
  switch (status) {
    case 'approved':
      return 'PAID';
    case 'refunded':
    case 'charged_back':
      return 'REFUNDED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      // pending · in_process · in_mediation · rejected · …
      return 'PENDING';
  }
}

// ------------------------------------------------------------------
// Webhook
// ------------------------------------------------------------------

/**
 * Verificação oficial da assinatura de webhook do Mercado Pago.
 *
 * A plataforma envia `x-signature: ts=<ts>,v1=<hmac>` e `x-request-id`; o
 * manifesto assinado é `id:<data.id>;request-id:<request-id>;ts:<ts>;`
 * com HMAC-SHA256 do segredo configurado no painel. A verificação é
 * OBRIGATÓRIA sempre que `MERCADOPAGO_WEBHOOK_SECRET` estiver definida.
 */
export function verifyMercadoPagoWebhookSignature(input: {
  dataId: string;
  xSignature: string | null;
  xRequestId: string | null;
}): boolean {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  // Sem segredo configurado o endpoint ainda registra o evento — a
  // aplicação da assinatura fica desligada por decisão de configuração.
  if (!secret) return true;
  if (!input.xSignature || !input.xRequestId) return false;

  const parts = new Map<string, string>();
  for (const part of input.xSignature.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key && value) parts.set(key, value);
  }
  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  if (!ts || !v1) return false;

  const manifest = `id:${input.dataId};request-id:${input.xRequestId};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(v1, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Lança a menos que a verificação passe (guarda uniforme de webhook). */
export function assertMercadoPagoWebhookSignature(input: { dataId: string; xSignature: string | null; xRequestId: string | null }): void {
  if (!verifyMercadoPagoWebhookSignature(input)) {
    throw new WebhookSignatureError(PROVIDER);
  }
}
