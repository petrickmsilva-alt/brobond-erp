import express, { type Request, type Response, type NextFunction } from 'express';
import { currentUser, exigirReautenticacao } from '../../../server/src/auth';
import { escopoDoAtor } from '../../../server/src/empresa';
import { checkAccess, getStore } from '../../../server/src/services';
import { getResource } from '../../../server/src/resources';
import { HttpError } from '../../../server/src/errors';
import { R_GATEWAY_CONFIGS, R_GATEWAY_WEBHOOK_EVENTS } from '../../../server/src/gateway';
import { cifrarSegredo, chaveFraca } from '../../../server/src/segredos';
import { METHODS, PROVIDERS, RECONCILIATION_STATES, type ProviderCode } from '../domain/payment';
import { readiness, account, availableMethods } from '../application/configuration';
import { paymentEngine } from '../orchestration/payment-orchestrator';
import {
  R_METHODS,
  R_ROUTING,
  R_INTENTS,
  R_ATTEMPTS,
  R_OPERATIONS,
  R_REFUNDS,
  R_DISPUTES,
  R_SETTLEMENTS,
} from '../infrastructure/resources';
import { locked } from '../infrastructure/locking';
import { listPayouts, payoutDetail, importPayout, matchPayout } from '../application/payouts';
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};
export const paymentsRouter = express.Router();
paymentsRouter.get('/payouts', wrap(listPayouts));
paymentsRouter.get('/payouts/:id', wrap(payoutDetail));
paymentsRouter.post('/payouts/import', wrap(importPayout));
paymentsRouter.post('/payouts/:id/match', wrap(matchPayout));
function authorize(req: Request, manage = false) {
  const actor = currentUser(req);
  if (!actor) throw new HttpError(401, 'Autenticação necessária.');
  checkAccess(getResource('commerce_pedidos')!, actor, 'read');
  if (manage && !['admin', 'gerente'].includes(actor.perfil)) throw new HttpError(403, 'Apenas gerentes e administradores.');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
async function audit(req: Request, event: string, id: number | null = null, tx?: import('../../../server/src/store').Tx) {
  const { actor, empresaId } = authorize(req, true);
  await getStore().audit(
    {
      empresa_id: empresaId,
      usuario_id: actor.id,
      usuario: actor.name,
      acao: 'ajuste',
      recurso: 'payment_engine',
      registro_id: id,
      descricao: event,
    },
    tx
  );
}
const invalid = () => new HttpError(400, 'Configuração de pagamento inválida.');
paymentsRouter.get(
  '/',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req);
    res.json(await readiness(empresaId));
  })
);
paymentsRouter.get(
  '/providers',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    res.json({ providers: (await readiness(empresaId)).providers });
  })
);
paymentsRouter.put(
  '/providers/:code',
  wrap(async (req, res) => {
    const { empresaId, actor } = authorize(req, true);
    if (actor.perfil !== 'admin') throw new HttpError(403, 'Apenas administradores configuram providers.');
    exigirReautenticacao(req);
    const code = String(req.params.code) as ProviderCode;
    if (!PROVIDERS.includes(code)) throw invalid();
    const b = req.body || {};
    if (!['teste', 'producao'].includes(b.environment) || typeof b.enabled !== 'boolean') throw invalid();
    if (process.env.NODE_ENV === 'production' && chaveFraca()) throw new HttpError(503, 'Chave dedicada de criptografia necessária.');
    const allowed = ['access_token', 'secret_key', 'enabled_methods', 'return_url', 'notification_url', 'capture_mode'];
    const credentials = b.credentials;
    if (
      credentials &&
      (typeof credentials !== 'object' ||
        Array.isArray(credentials) ||
        Object.keys(credentials).some((k) => !allowed.includes(k) || typeof credentials[k] !== 'string'))
    )
      throw invalid();
    if (credentials?.capture_mode && !['manual', 'automatic'].includes(credentials.capture_mode)) throw invalid();
    if (credentials?.return_url && !/^https:\/\//.test(credentials.return_url)) throw invalid();
    if (credentials?.notification_url && !/^https:\/\//.test(credentials.notification_url)) throw invalid();
    await locked(empresaId, `provider:${code}`, async (tx) => {
      const a = await account(empresaId, code);
      const old = a.config;
      const data = {
        empresa_id: empresaId,
        provider: a.provider.legacyId,
        ativo: b.enabled,
        ambiente: b.environment,
        ...(credentials
          ? { credenciais_cifradas: cifrarSegredo(JSON.stringify({ ...a.context.credentials, ...credentials })) }
          : old && !old.id
            ? { credenciais_cifradas: old.credenciais_cifradas }
            : {}),
        ...(typeof b.webhook_secret === 'string' && b.webhook_secret
          ? { webhook_segredo_cifrado: cifrarSegredo(b.webhook_secret) }
          : old && !old.id
            ? { webhook_segredo_cifrado: old.webhook_segredo_cifrado }
            : {}),
        health_status: null,
        health_checked_at: null,
        last_error: null,
        atualizado_em: new Date().toISOString(),
      };
      if (old?.id) await getStore().update(R_GATEWAY_CONFIGS, Number(old.id), data, tx);
      else await getStore().insert(R_GATEWAY_CONFIGS, data, tx);
      await audit(req, `provider ${code} ${b.enabled ? 'enabled/updated' : 'disabled'}`, old?.id || null, tx);
    });
    res.json({ ok: true });
  })
);
paymentsRouter.post(
  '/providers/:code/health',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    const code = String(req.params.code) as ProviderCode;
    if (!PROVIDERS.includes(code)) throw invalid();
    const a = await account(empresaId, code);
    if (a.config?.health_checked_at && Date.now() - new Date(a.config.health_checked_at).getTime() < 60_000)
      throw new HttpError(429, 'Aguarde um minuto entre verificações.');
    const status = await a.provider.healthCheck(a.context);
    if (a.config?.id)
      await getStore().update(R_GATEWAY_CONFIGS, Number(a.config.id), {
        health_status: status,
        health_checked_at: new Date().toISOString(),
        last_error: status === 'DOWN' ? 'PROVIDER_UNAVAILABLE' : null,
      });
    await audit(req, `provider ${code} health ${status}`);
    res.json({ status });
  })
);
paymentsRouter.get(
  '/methods',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req);
    const configured = await getStore().list(R_METHODS, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
    const ready = await readiness(empresaId);
    res.json({
      methods: METHODS.map((code) => ({
        code,
        name: configured.rows.find((r) => r.code === code)?.name || code,
        enabled: configured.rows.find((r) => r.code === code)?.enabled ?? ready.methods.some((m) => m.code === code),
        settings: configured.rows.find((r) => r.code === code)?.settings || {},
        providers: ready.providers.filter((p) => p.methods.includes(code)).map((p) => p.code),
      })),
    });
  })
);
paymentsRouter.put(
  '/methods/:code',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    const code = String(req.params.code);
    const b = req.body || {};
    if (!METHODS.includes(code as (typeof METHODS)[number]) || typeof b.enabled !== 'boolean') throw invalid();
    const settings = validateConditions(b.settings || {});
    await locked(empresaId, `method:${code}`, async (tx) => {
      const old = await getStore().findOneWhere(R_METHODS, { empresa_id: empresaId, code }, tx);
      const data = { empresa_id: empresaId, code, name: code, enabled: b.enabled, settings, updated_at: new Date().toISOString() };
      if (old) await getStore().update(R_METHODS, Number(old.id), data, tx);
      else await getStore().insert(R_METHODS, data, tx);
      await audit(req, `method ${code} ${b.enabled ? 'enabled' : 'disabled'}`, old?.id || null, tx);
    });
    res.json({ ok: true });
  })
);
function validateConditions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const b = value as Record<string, unknown>;
  const allowed = [
    'channel',
    'store',
    'channels',
    'countries',
    'currencies',
    'min',
    'max',
    'maxInstallments',
    'startHour',
    'endHour',
    'cost',
    'fallback',
    'transactionLimit',
  ];
  if (Object.keys(b).some((k) => !allowed.includes(k))) throw invalid();
  for (const k of ['min', 'max', 'maxInstallments', 'startHour', 'endHour', 'cost', 'transactionLimit'])
    if (b[k] != null && (!Number.isSafeInteger(b[k]) || Number(b[k]) < 0)) throw invalid();
  if (b.min != null && b.max != null && Number(b.min) > Number(b.max)) throw invalid();
  for (const k of ['channels', 'countries', 'currencies'])
    if (b[k] != null && (!Array.isArray(b[k]) || !(b[k] as unknown[]).every((v) => typeof v === 'string' && v.length <= 32)))
      throw invalid();
  for (const k of ['channel', 'store']) if (b[k] != null && (typeof b[k] !== 'string' || String(b[k]).length > 64)) throw invalid();
  if (b.fallback != null && typeof b.fallback !== 'boolean') throw invalid();
  return b;
}
paymentsRouter.get(
  '/routing',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    res.json(
      await getStore().list(R_ROUTING, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId }, sort: 'priority', dir: 'asc' })
    );
  })
);
paymentsRouter.put(
  '/routing',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    const rules = req.body?.rules;
    if (!Array.isArray(rules) || rules.length > 100) throw invalid();
    const seen = new Set<string>();
    for (const r of rules) {
      if (
        !METHODS.includes(r.method) ||
        !PROVIDERS.includes(r.provider) ||
        !Number.isSafeInteger(r.priority) ||
        r.priority < 0 ||
        typeof r.enabled !== 'boolean'
      )
        throw invalid();
      r.conditions = validateConditions(r.conditions || {});
      const k = `${r.method}:${r.priority}`;
      if (seen.has(k)) throw invalid();
      seen.add(k);
    }
    await locked(empresaId, 'routing', async (tx) => {
      const old = await getStore().list(R_ROUTING, { page: 1, pageSize: 1000, filter: { empresa_id: empresaId } }, tx);
      // Existing rules remain as disabled records; no destructive migration or silent replacement.
      for (const o of old.rows) await getStore().update(R_ROUTING, Number(o.id), { enabled: false }, tx);
      for (const r of rules) {
        const o = old.rows.find((o) => o.method === r.method && Number(o.priority) === r.priority);
        const data = {
          empresa_id: empresaId,
          method: r.method,
          provider: r.provider,
          priority: r.priority,
          enabled: r.enabled,
          conditions: r.conditions,
          updated_at: new Date().toISOString(),
        };
        if (o) await getStore().update(R_ROUTING, Number(o.id), data, tx);
        else await getStore().insert(R_ROUTING, data, tx);
      }
      await audit(req, 'routing changed', null, tx);
    });
    res.json({ ok: true });
  })
);
for (const [path, resource] of [
  ['transactions', R_INTENTS],
  ['refunds', R_REFUNDS],
  ['disputes', R_DISPUTES],
  ['reconciliation', R_SETTLEMENTS],
  ['webhooks', R_GATEWAY_WEBHOOK_EVENTS],
] as const) {
  paymentsRouter.get(
    `/${path}`,
    wrap(async (req, res) => {
      const { empresaId } = authorize(req, path !== 'transactions');
      const filter: Record<string, unknown> = { empresa_id: empresaId };
      if (req.query.status) filter.status = String(req.query.status);
      const result = await getStore().list(resource, {
        page: Math.max(1, Number(req.query.page) || 1),
        pageSize: Math.min(100, Math.max(1, Number(req.query.pageSize) || 25)),
        q: String(req.query.q || ''),
        filter,
        sort: 'id',
        dir: 'desc',
      });
      if (path === 'webhooks')
        result.rows = result.rows.map((w) => ({
          id: w.id,
          provider: w.provider,
          event_id: w.evento_id,
          signature_ok: w.assinatura_ok,
          status: w.status,
          retry_count: w.tentativas,
          payload_hash: w.payload_hash,
          correlation_id: w.correlation_id,
          received_at: w.recebido_em,
          processed_at: w.processado_em,
          error: w.erro,
        }));
      res.json(result);
    })
  );
}
paymentsRouter.get(
  '/transactions/:id',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req);
    const id = Number(req.params.id);
    const intent = await paymentEngine.intent(empresaId, id);
    const fetch = async (r: typeof R_INTENTS) =>
      (await getStore().list(r, { page: 1, pageSize: 100, filter: { empresa_id: empresaId, payment_intent_id: id } })).rows;
    res.json({
      intent,
      attempts: (await fetch(R_ATTEMPTS)).map(({ request_cifradas: _request, ...safe }) => safe),
      operations: await fetch(R_OPERATIONS),
      refunds: await fetch(R_REFUNDS),
      disputes: await fetch(R_DISPUTES),
      settlements: await fetch(R_SETTLEMENTS),
    });
  })
);
for (const op of ['refund', 'capture', 'cancel', 'manual-confirm'] as const)
  paymentsRouter.post(
    '/:id/' + op,
    wrap(async (req, res) => {
      const { empresaId } = authorize(req, true);
      await audit(req, `${op} authorized`, Number(req.params.id));
      res.json(
        await paymentEngine.mutate(empresaId, Number(req.params.id), op, String(req.get('Idempotency-Key') || ''), req.body?.amount)
      );
    })
  );
paymentsRouter.post(
  '/reconciliation/:id/resolve',
  wrap(async (req, res) => {
    const { empresaId } = authorize(req, true);
    const id = Number(req.params.id);
    const b = req.body || {};
    if (
      !RECONCILIATION_STATES.includes(b.status) ||
      !['MATCHED', 'PARTIAL', 'DIVERGENT', 'RESOLVED'].includes(b.status) ||
      typeof b.note !== 'string' ||
      b.note.trim().length < 8 ||
      b.note.length > 500
    )
      throw invalid();
    await locked(empresaId, `settlement:${id}`, async (tx) => {
      const old = await getStore().findOneWhere(R_SETTLEMENTS, { empresa_id: empresaId, id }, tx);
      if (!old) throw new HttpError(404, 'Liquidação não encontrada.');
      if (b.status === 'MATCHED') throw new HttpError(409, 'Conciliação MATCHED exige vínculo do repasse ao extrato bancário.');
      await getStore().update(
        R_SETTLEMENTS,
        id,
        { status: b.status, evidence: { ...old.evidence, note: b.note, actor: currentUser(req).id }, updated_at: new Date().toISOString() },
        tx
      );
      await audit(req, 'reconciliation resolved', id, tx);
    });
    res.json({ ok: true });
  })
);
export async function checkoutMethods(req: Request, res: Response) {
  const { empresaDaVitrine } = await import('../../../server/src/commerce/loja-base');
  const empresaId = await empresaDaVitrine();
  if (!empresaId) throw new HttpError(409, 'Vitrine não configurada.');
  // Quote endpoint never accepts a browser price: use the existing cart pricing/freight pipeline.
  const { quotePaymentMethods } = await import('../../../server/src/commerce/vitrine');
  res.json(await quotePaymentMethods(empresaId, req));
}
