import { TestPaymentProvider } from './testing';
import type { ProviderCode } from '../domain/payment';
import type { PaymentProvider } from './payment-provider';
import { MercadoPagoProvider } from './mercado-pago';
import { StripeProvider } from './stripe';
import { PagBankProvider } from './pagbank';
import { ManualProvider } from './manual';
import { GenericPaymentProvider } from './generic';
export class ProviderRegistry {
  private providers = new Map<ProviderCode, PaymentProvider>();
  register(provider: PaymentProvider) {
    if (this.providers.has(provider.code)) throw new Error('Provider already registered');
    this.providers.set(provider.code, provider);
  }
  get(code: ProviderCode) {
    const p = this.providers.get(code);
    if (!p) throw new Error('Provider not registered');
    return p;
  }
  list() {
    return [...this.providers.values()];
  }
}
export const providerRegistry = new ProviderRegistry();

/**
 * Provedor sem adaptador real: instância DIRETA da base fail-closed
 * (GenericPaymentProvider). Não pode ser oferecido para configuração nem para
 * roteamento (P3-01). Atenção: todos os adaptadores reais (Mercado Pago,
 * Stripe, PagBank, Manual) herdam da base — por isso a comparação é de classe
 * exata, nunca `instanceof`.
 */
export function provedorImplementado(provider: PaymentProvider): boolean {
  return provider.constructor !== GenericPaymentProvider;
}
for (const p of [
  new MercadoPagoProvider(),
  new StripeProvider(),
  new PagBankProvider(),
  new ManualProvider(),
  process.env.NODE_ENV === 'test' ? new TestPaymentProvider() : new GenericPaymentProvider(),
  new GenericPaymentProvider('PIX_DIRECT', 'pix_direct'),
  new GenericPaymentProvider('BOLETO_GENERIC', 'boleto_generic'),
])
  providerRegistry.register(p);
