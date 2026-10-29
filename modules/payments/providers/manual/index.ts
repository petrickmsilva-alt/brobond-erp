import { GenericPaymentProvider } from '../generic';
import { capability, type ProviderContext, type PaymentInput, type PaymentResult } from '../payment-provider';
export class ManualProvider extends GenericPaymentProvider {
  constructor() {
    super('MANUAL', 'manual');
  }
  capabilities(_ctx: ProviderContext) {
    return [capability('MANUAL_PAYMENT', { settlement: 'MANUAL' })];
  }
  async createPaymentIntent(_ctx: ProviderContext, input: PaymentInput): Promise<PaymentResult> {
    return { reference: input.reference, status: 'PENDING_MANUAL_CONFIRMATION' };
  }
  async healthCheck(_ctx: ProviderContext): Promise<'UP'> {
    return 'UP';
  }
}
