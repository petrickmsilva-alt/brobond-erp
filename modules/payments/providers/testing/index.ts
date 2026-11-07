import { GenericPaymentProvider } from '../generic';
import { capability, type Capability, type PaymentInput, type PaymentResult, type ProviderContext } from '../payment-provider';
import type { PaymentMethod } from '../../domain/payment';
/**
 * Adaptador SOMENTE de teste/demonstração (NODE_ENV=test). Encaminha ao
 * `mockProvider` do gateway para manter os fluxos de demonstração (PIX, boleto
 * e cartão tokenizado) funcionando pelo caminho canônico do Engine — o gateway
 * legado não cria mais cobrança por conta própria (ADR-001).
 *
 * Não é registrado fora de `NODE_ENV=test`; em produção o slot
 * `ACQUIRER_GENERIC` é a base fail-closed.
 */
const METODOS: PaymentMethod[] = ['PIX', 'BOLETO', 'CREDIT_CARD', 'DEBIT_CARD'];
const LEGADO: Partial<Record<PaymentMethod, 'pix' | 'boleto' | 'cartao_credito' | 'cartao_debito'>> = {
  PIX: 'pix',
  BOLETO: 'boleto',
  CREDIT_CARD: 'cartao_credito',
  DEBIT_CARD: 'cartao_debito',
};
export class TestPaymentProvider extends GenericPaymentProvider {
  private results = new Map<string, PaymentResult>();
  constructor() {
    super('ACQUIRER_GENERIC', 'mock');
  }
  capabilities(_ctx: ProviderContext): Capability[] {
    if (process.env.NODE_ENV !== 'test') return [];
    return METODOS.map((m) => capability(m, { cancel: true, refund: true, partialRefund: true }));
  }
  async createPaymentIntent(ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    if (process.env.NODE_ENV !== 'test') throw new Error('Test adapter disabled');
    const key = `${ctx.empresaId}:${ctx.operationKey}`;
    const old = this.results.get(key);
    if (old) return old;
    const { mockProvider } = await import('../../../../server/src/gateway');
    const r = await mockProvider.criaCobranca(
      { empresaId: ctx.empresaId, config: {}, credenciais: {}, webhookSegredo: null },
      {
        valor: input.amount / 100,
        metodo: LEGADO[input.method]!,
        referencia: ctx.operationKey,
        payer_email: input.email,
        expira_em: input.expiresAt,
        parcelas: input.installments,
        token: input.token,
      }
    );
    const action: PaymentResult['action'] =
      input.method === 'PIX'
        ? // Contrato canônico: Copia e Cola (BR Code). O mock não devolve imagem —
          // e nada no sistema a fabrica a partir do texto.
          { type: 'PIX', code: r.copia_cola || undefined, expiresAt: r.expires_em || undefined }
        : input.method === 'BOLETO'
          ? { type: 'BOLETO', code: r.linha_digitavel || undefined, nossoNumero: r.nosso_numero || undefined, expiresAt: r.expires_em || undefined }
          : { type: input.method, code: r.nsu || undefined, expiresAt: r.expires_em || undefined };
    const result: PaymentResult = { reference: r.provider_ref, status: 'PENDING', action };
    this.results.set(key, result);
    return result;
  }
}
