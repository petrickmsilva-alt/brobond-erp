import type { Capability, ProviderContext, PaymentProvider } from '../providers/payment-provider';
import type { PaymentMethod } from '../domain/payment';
export type RoutingContext = {
  empresaId: number;
  method: PaymentMethod;
  channel: string;
  store?: string;
  country: string;
  currency: string;
  amount: number;
  installments: number;
  hour?: number;
};
export type RoutingConditions = {
  channel?: string;
  store?: string;
  countries?: string[];
  currencies?: string[];
  min?: number;
  max?: number;
  maxInstallments?: number;
  startHour?: number;
  endHour?: number;
  cost?: number;
  fallback?: boolean;
  transactionLimit?: number;
};
export type Candidate = {
  provider: PaymentProvider;
  context: ProviderContext;
  capability: Capability;
  priority: number;
  conditions: RoutingConditions;
  health: string | null;
  ruleId: number | null;
};
export function routePayment(context: RoutingContext, candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((c) => {
      const r = c.conditions;
      const cap = c.capability;
      return (
        c.context.empresaId === context.empresaId &&
        cap.method === context.method &&
        !['DOWN', 'NOT_CONFIGURED', 'DISABLED'].includes(c.health || '') &&
        (!r.channel || r.channel === context.channel) &&
        (!r.store || r.store === context.store) &&
        cap.countries.includes(context.country) &&
        cap.currencies.includes(context.currency) &&
        (!r.countries || r.countries.includes(context.country)) &&
        (!r.currencies || r.currencies.includes(context.currency)) &&
        context.amount >= Math.max(cap.min, r.min ?? 0) &&
        context.amount <= Math.min(cap.max, r.max ?? Infinity, r.transactionLimit ?? Infinity) &&
        context.installments <= Math.min(cap.maxInstallments, r.maxInstallments ?? Infinity) &&
        (r.startHour == null || (context.hour ?? new Date().getUTCHours()) >= r.startHour) &&
        (r.endHour == null || (context.hour ?? new Date().getUTCHours()) < r.endHour)
      );
    })
    .sort(
      (a, b) =>
        a.priority - b.priority || (a.conditions.cost ?? 0) - (b.conditions.cost ?? 0) || a.provider.code.localeCompare(b.provider.code)
    );
}
