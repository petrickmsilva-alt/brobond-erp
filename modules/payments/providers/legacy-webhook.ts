import type { PaymentProvider as LegacyProvider, GatewayContext } from '../../../server/src/gateway';
import type { PaymentProvider, ProviderContext } from './payment-provider';
import { HttpError } from '../../../server/src/errors';
const context = (ctx: GatewayContext): ProviderContext => ({
  empresaId: ctx.empresaId,
  credentials: ctx.credenciais || {},
  webhookSecret: ctx.webhookSegredo,
  environment: ctx.config?.ambiente === 'producao' ? 'producao' : 'teste',
  operationKey: ctx.operationKey || '',
});
export function webhookCompatibility(provider: PaymentProvider): LegacyProvider {
  const unsupported = async (): Promise<never> => {
    throw new HttpError(405, 'Utilize o Payment Engine.');
  };
  return {
    id: provider.legacyId,
    nome: provider.code,
    metodos: [],
    criaCobranca: unsupported,
    consultaCobranca: unsupported,
    cancelaCobranca: unsupported,
    estornaCobranca: unsupported,
    parseWebhook(raw) {
      const e = provider.parseWebhook(raw);
      return e ? { evento_id: e.id, evento: e.type, provider_ref: e.reference } : null;
    },
    verificaAssinatura(ctx, raw, headers) {
      return provider.verifyWebhook(context(ctx), raw, headers);
    },
    resolveWebhook: async () => null,
  };
}
