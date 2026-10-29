import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentError } from '../domain/payment';
export async function providerRequest(url: string, init: RequestInit): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new PaymentError('TIMEOUT', init.method !== 'GET');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw new PaymentError('RATE_LIMITED');
    if (response.status >= 500) throw new PaymentError('PROVIDER_UNAVAILABLE', init.method !== 'GET');
    if (response.status === 402) throw new PaymentError('PAYMENT_DECLINED');
    throw new PaymentError('INVALID_REQUEST');
  }
  return body;
}
export function validHmac(secret: string | null, payload: string, provided: string) {
  if (!secret || !/^[a-f\d]{64}$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(createHmac('sha256', secret).update(payload).digest('hex')), Buffer.from(provided.toLowerCase()));
}
