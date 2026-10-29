import { configDaEmpresa } from '../../../server/src/gateway';
import { decifrarSegredo, cifrarSegredo } from '../../../server/src/segredos';
import { getStore } from '../../../server/src/services';
import { providerRegistry } from '../providers/registry';
import { R_METHODS, R_ROUTING } from '../infrastructure/resources';
import { routePayment, type Candidate, type RoutingContext } from '../orchestration/provider-router';
import { METHODS, type ProviderCode } from '../domain/payment';
import type { ProviderContext } from '../providers/payment-provider';
export async function account(empresaId: number, code: ProviderCode, operationKey = '') {
  const provider = providerRegistry.get(code);
  let config = await configDaEmpresa(empresaId, provider.legacyId);
  if (!config && ['STRIPE', 'PAGBANK'].includes(code)) {
    const { empresaDaVitrine } = await import('../../../server/src/commerce/loja-base');
    if ((await empresaDaVitrine()) === empresaId) {
      const prefix = code;
      const token = process.env[`${prefix}_${code === 'STRIPE' ? 'SECRET_KEY' : 'ACCESS_TOKEN'}`]?.trim();
      const webhook = process.env[`${prefix}_WEBHOOK_SECRET`]?.trim();
      if (token && (code === 'PAGBANK' || webhook)) {
        const credentials = {
          [code === 'STRIPE' ? 'secret_key' : 'access_token']: token,
          enabled_methods: process.env[`${prefix}_ENABLED_METHODS`] || '',
          return_url: process.env[`${prefix}_RETURN_URL`] || '',
          notification_url: process.env[`${prefix}_NOTIFICATION_URL`] || '',
          capture_mode: process.env[`${prefix}_CAPTURE_MODE`] || 'automatic',
        };
        config = {
          id: null,
          empresa_id: empresaId,
          provider: provider.legacyId,
          ativo: true,
          ambiente: process.env[`${prefix}_ENVIRONMENT`] === 'producao' ? 'producao' : 'teste',
          origem: 'ambiente_commerce',
          credenciais_cifradas: cifrarSegredo(JSON.stringify(credentials)),
          webhook_segredo_cifrado: cifrarSegredo(webhook || token),
        };
      }
    }
  }
  let credentials: Record<string, string> = {};
  try {
    credentials = JSON.parse(decifrarSegredo(config?.credenciais_cifradas) || '{}');
  } catch {
    /* corrupt ciphertext fails closed */
  }
  const context: ProviderContext = {
    empresaId,
    credentials,
    operationKey,
    webhookSecret: decifrarSegredo(config?.webhook_segredo_cifrado) || (code === 'PAGBANK' ? credentials.access_token || null : null),
    environment: config?.ambiente === 'producao' ? 'producao' : 'teste',
  };
  const capabilities = config?.ativo === true ? provider.capabilities(context) : [];
  return { provider, config, context, capabilities };
}
export async function candidates(input: RoutingContext): Promise<Candidate[]> {
  const s = getStore();
  const [rules, method] = await Promise.all([
    s.list(R_ROUTING, { page: 1, pageSize: 1000, filter: { empresa_id: input.empresaId, method: input.method } }),
    s.findOneWhere(R_METHODS, { empresa_id: input.empresaId, code: input.method }),
  ]);
  if (method?.enabled === false) return [];
  const settings = method?.settings || {};
  if (
    (settings.min != null && input.amount < settings.min) ||
    (settings.max != null && input.amount > settings.max) ||
    (settings.channels && !settings.channels.includes(input.channel)) ||
    (settings.countries && !settings.countries.includes(input.country)) ||
    (settings.currencies && !settings.currencies.includes(input.currency)) ||
    (settings.maxInstallments && input.installments > settings.maxInstallments)
  )
    return [];
  const out: Candidate[] = [];
  for (const p of providerRegistry.list()) {
    const a = await account(input.empresaId, p.code);
    const cap = a.capabilities.find((c) => c.method === input.method);
    if (!cap) continue;
    // Compatibility rule is explicit and explainable; never silently picks a newly configured provider.
    const selected = rules.rows.length
      ? rules.rows.filter((r) => r.provider === p.code && r.enabled === true)
      : (p.code === 'MERCADO_PAGO' || (process.env.NODE_ENV === 'test' && p.legacyId === 'mock')) &&
          input.method === 'PIX' &&
          input.channel === 'OWN_STORE'
        ? [{ id: null, priority: 100, conditions: {}, provider: p.code }]
        : [];
    for (const rule of selected)
      out.push({
        provider: p,
        context: a.context,
        capability: cap,
        priority: Number(rule.priority),
        conditions: rule.conditions || {},
        health: a.config?.health_status || null,
        ruleId: rule.id,
      });
  }
  return routePayment(input, out);
}
export async function availableMethods(input: Omit<RoutingContext, 'method'>) {
  const out = [];
  for (const method of METHODS) {
    const routes = await candidates({ ...input, method });
    if (routes.length)
      out.push({
        code: method,
        max_installments: Math.max(...routes.map((r) => r.capability.maxInstallments)),
        asynchronous: routes[0].capability.asynchronous,
        required_fields: routes[0].capability.requiredCustomerFields,
        installments: Array.from({ length: routes[0].capability.maxInstallments }, (_, i) => ({
          installments: i + 1,
          total: input.amount,
          interest: 0,
          merchant_interest: 0,
          customer_interest: 0,
        })),
      });
  }
  return out;
}
export async function readiness(empresaId: number) {
  const providers = await Promise.all(
    providerRegistry.list().map(async (p) => {
      const a = await account(empresaId, p.code);
      const configured = a.capabilities.length > 0;
      return {
        code: p.code,
        name: (
          {
            MERCADO_PAGO: 'Mercado Pago',
            PAGBANK: 'PagBank',
            STRIPE: 'Stripe',
            PIX_DIRECT: 'Banco / PSP',
            ACQUIRER_GENERIC: 'Adquirente',
            BOLETO_GENERIC: 'Boleto / Banco',
            MANUAL: 'Manual',
          } as Record<string, string>
        )[p.code],
        status:
          a.config?.ativo === false
            ? 'DISABLED'
            : !configured
              ? 'NOT_CONFIGURED'
              : a.config?.health_status === 'UP'
                ? 'CONNECTED'
                : a.config?.health_status === 'DOWN'
                  ? 'ERROR'
                  : a.config?.health_status === 'DEGRADED'
                    ? 'DEGRADED'
                    : 'CONFIGURED',
        origin: a.config?.origem === 'ambiente_commerce' ? 'ambiente_commerce' : 'banco',
        environment: a.config?.ambiente || null,
        capabilities: a.capabilities,
        methods: a.capabilities.map((c) => c.method),
        credential: configured ? '••••••••' : null,
        webhook: !!a.context.webhookSecret,
        health_checked_at: a.config?.health_checked_at || null,
        last_error: a.config?.last_error || null,
      };
    })
  );
  const methods = await availableMethods({
    empresaId,
    channel: 'OWN_STORE',
    country: 'BR',
    currency: 'BRL',
    amount: 10000,
    installments: 1,
  });
  const rules = await getStore().list(R_ROUTING, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId } });
  return {
    engine: 'Payment Engine',
    configured: methods.length > 0,
    providers,
    methods,
    routing: rules.total
      ? rules.rows.some((r) => r.enabled === true)
        ? 'PUBLISHED'
        : 'DISABLED'
      : providers.some((p) => p.code === 'MERCADO_PAGO' && p.methods.includes('PIX'))
        ? 'LEGACY_COMPATIBILITY'
        : 'NOT_CONFIGURED',
    external_homologation: 'PENDING',
    full_go_live: false,
  };
}
