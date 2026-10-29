import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CreditCard, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { PaymentNavigation, paymentSections } from './PaymentNavigation';
import { dataHora, grana } from './shared';
type RecordData = Record<string, any>;
const endpoints: Record<string, string> = {
  provedores: 'providers',
  metodos: 'methods',
  regras: 'routing',
  transacoes: 'transactions',
  reembolsos: 'refunds',
  disputas: 'disputes',
  reconciliacao: 'reconciliation',
  webhooks: 'webhooks',
};
const methods = [
  'PIX',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'BOLETO',
  'DIGITAL_WALLET',
  'BUY_NOW_PAY_LATER',
  'BANK_TRANSFER',
  'GIFT_CARD',
  'MANUAL_PAYMENT',
  'OTHER',
];
const providers = ['MERCADO_PAGO', 'PAGBANK', 'STRIPE', 'PIX_DIRECT', 'ACQUIRER_GENERIC', 'BOLETO_GENERIC', 'MANUAL'];
const labels: Record<string, string> = {
  id: 'ID',
  order_id: 'Pedido',
  customer_ref: 'Cliente / Referência',
  method: 'Método',
  provider: 'Provider',
  amount: 'Valor',
  status: 'Status',
  created_at: 'Criado em',
  updated_at: 'Atualizado em',
  code: 'Código',
  name: 'Nome',
  enabled: 'Habilitado',
  priority: 'Prioridade',
  payment_intent_id: 'Payment Intent',
  provider_reference: 'Referência',
  gross_amount: 'Bruto',
  net_amount: 'Líquido',
  provider_fee: 'Taxa provider',
  refund_amount: 'Reembolsado',
  signature_ok: 'Assinatura',
  retry_count: 'Tentativas',
  received_at: 'Recebido em',
  processed_at: 'Processado em',
  event_id: 'Evento',
  requested_amount: 'Solicitado',
  captured_amount: 'Capturado',
  refunded_amount: 'Reembolsado',
  started_at: 'Início',
  completed_at: 'Conclusão',
  failure_code: 'Falha',
  provider_transaction_id: 'Transação externa',
};
const moneyFields = [
  'amount',
  'gross_amount',
  'net_amount',
  'provider_fee',
  'refund_amount',
  'requested_amount',
  'captured_amount',
  'refunded_amount',
];
const columns: Record<string, string[]> = {
  metodos: ['code', 'name', 'providers', 'enabled'],
  regras: ['method', 'provider', 'priority', 'conditions', 'enabled'],
  transacoes: ['id', 'order_id', 'customer_ref', 'method', 'provider', 'amount', 'status', 'created_at', 'updated_at'],
  reembolsos: ['id', 'payment_intent_id', 'amount', 'status', 'created_at'],
  disputas: ['id', 'payment_intent_id', 'provider_reference', 'amount', 'status', 'created_at'],
  reconciliacao: ['id', 'payment_intent_id', 'provider', 'gross_amount', 'provider_fee', 'net_amount', 'status'],
  webhooks: ['id', 'provider', 'event_id', 'signature_ok', 'status', 'retry_count', 'received_at', 'processed_at'],
};
function value(key: string, v: unknown) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (key === 'conditions' && typeof v === 'object') {
    const c = v as RecordData;
    return [
      c.channel || 'Todos os canais',
      c.min != null ? `Mín. ${grana(c.min / 100)}` : '',
      c.max != null ? `Máx. ${grana(c.max / 100)}` : '',
      c.fallback ? 'Fallback habilitado' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (moneyFields.includes(key)) return grana(Number(v) / 100);
  if (/_at$/.test(key)) return dataHora(String(v));
  return String(v);
}
function Status({ status }: { status: unknown }) {
  const s = String(status || '—');
  return (
    <Badge
      tone={
        ['CONNECTED', 'PAID', 'MATCHED', 'RESOLVED', 'COMPLETED', 'UP'].includes(s)
          ? 'green'
          : ['FAILED', 'ERROR', 'DOWN', 'DIVERGENT', 'CHARGEBACK'].includes(s)
            ? 'red'
            : 'slate'
      }
    >
      {s}
    </Badge>
  );
}
function Records({ rows, fields, section }: { rows: RecordData[]; fields: string[]; section?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-alt text-xs uppercase text-muted">
          <tr>
            {fields.map((k) => (
              <th key={k} className="whitespace-nowrap px-4 py-3">
                {labels[k] || k}
              </th>
            ))}
            {section && <th className="px-4 py-3">Ação</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {!rows.length && (
            <tr>
              <td className="px-4 py-10 text-center text-muted" colSpan={fields.length + 1}>
                Nenhum registro encontrado.
              </td>
            </tr>
          )}
          {rows.map((r, n) => (
            <tr key={r.id || r.code || n} className="hover:bg-surface-alt">
              {fields.map((k) => (
                <td key={k} className="whitespace-nowrap px-4 py-3">
                  {k === 'status' ? <Status status={r[k]} /> : value(k, r[k])}
                </td>
              ))}
              {section && (
                <td className="px-4 py-3">
                  <Link
                    className="font-medium text-blue-700 hover:underline"
                    to={`/commerce/pagamentos/${section}/${r.id || r.code}${['metodos', 'regras'].includes(section) ? '/editar' : ''}`}
                  >
                    {['metodos', 'regras'].includes(section) ? 'Configurar' : 'Detalhes'}
                  </Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function PaymentEnginePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { id, code } = useParams();
  const { user } = useAuth();
  const canManage = ['admin', 'gerente'].includes(user?.perfil || '');
  const section = location.pathname.split('/')[3] || '';
  const action = location.pathname.split('/')[5] || '';
  const isForm =
    location.pathname.endsWith('/editar') ||
    location.pathname.endsWith('/novo') ||
    ['reembolsar', 'capturar', 'cancelar', 'confirmar', 'resolver'].includes(action);
  const title = paymentSections.find(([p]) => p === section)?.[1] || 'Pagamentos';
  const [data, setData] = useState<RecordData | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState<RecordData>({
    enabled: false,
    environment: 'teste',
    method: 'PIX',
    provider: 'MERCADO_PAGO',
    priority: 1,
    min: 0,
    max: '',
    maxInstallments: 1,
    status: 'RESOLVED',
    conditions: {},
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const path = section === 'transacoes' && id ? `transactions/${id}` : endpoints[section] || '';
      const r = await apiFetch<RecordData>(
        `/commerce/payments/${path}?page=${page}&pageSize=25&q=${encodeURIComponent(search)}&status=${encodeURIComponent(filter)}`
      );
      setData(r);
      if (section === 'regras' && id) {
        const rule = r.rows?.find((r: RecordData) => Number(r.id) === Number(id));
        if (rule) setForm((f) => ({ ...f, ...rule, ...rule.conditions }));
      }
      if (section === 'metodos' && code) {
        const m = r.methods?.find((m: RecordData) => m.code === code);
        if (m) setForm((f) => ({ ...f, ...m, ...m.settings }));
      }
      if (section === 'provedores' && code) {
        const p = r.providers?.find((p: RecordData) => p.code === code);
        if (p)
          setForm((f) => ({
            ...f,
            environment: p.environment || 'teste',
            enabled: p.status !== 'DISABLED' && p.status !== 'NOT_CONFIGURED',
          }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar Payment Engine.');
    } finally {
      setBusy(false);
    }
  }, [section, id, code, page, search, filter]);
  useEffect(() => {
    void load();
  }, [load]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (section === 'provedores') {
        if (form.password) await apiFetch('/auth/reautenticar', { method: 'POST', body: JSON.stringify({ senha: form.password }) });
        setForm((f) => ({ ...f, password: '' }));
        const credentials: Record<string, string> = {};
        if (form.token) credentials[code === 'STRIPE' ? 'secret_key' : 'access_token'] = form.token;
        if (form.enabled_methods) credentials.enabled_methods = form.enabled_methods;
        if (form.return_url) credentials.return_url = form.return_url;
        if (form.notification_url) credentials.notification_url = form.notification_url;
        if (form.capture_mode) credentials.capture_mode = form.capture_mode;
        await apiFetch(`/commerce/payments/providers/${code}`, {
          method: 'PUT',
          body: JSON.stringify({
            enabled: form.enabled,
            environment: form.environment,
            ...(Object.keys(credentials).length ? { credentials } : {}),
            ...(form.webhook_secret ? { webhook_secret: form.webhook_secret } : {}),
          }),
        });
      } else if (section === 'metodos') {
        await apiFetch(`/commerce/payments/methods/${code}`, {
          method: 'PUT',
          body: JSON.stringify({
            enabled: form.enabled,
            settings: {
              min: Number(form.min || 0),
              ...(form.max !== '' ? { max: Number(form.max) } : {}),
              maxInstallments: Number(form.maxInstallments || 1),
            },
          }),
        });
      } else if (section === 'regras') {
        await apiFetch('/commerce/payments/routing', {
          method: 'PUT',
          body: JSON.stringify({
            rules: [
              ...(data?.rows || []).filter(
                (r: RecordData) =>
                  Number(r.id) !== Number(id) && !(r.method === form.method && Number(r.priority) === Number(form.priority))
              ),
              {
                method: form.method,
                provider: form.provider,
                priority: Number(form.priority),
                enabled: form.enabled,
                conditions: {
                  ...(form.channel ? { channel: form.channel } : {}),
                  min: Number(form.min || 0),
                  ...(form.max !== '' ? { max: Number(form.max) } : {}),
                  fallback: !!form.fallback,
                },
              },
            ],
          }),
        });
      } else if (section === 'reconciliacao') {
        await apiFetch(`/commerce/payments/reconciliation/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ status: form.status, note: form.note }),
        });
      } else {
        const op = (
          { reembolsar: 'refund', capturar: 'capture', cancelar: 'cancel', confirmar: 'manual-confirm' } as Record<string, string>
        )[action];
        await apiFetch(`/commerce/payments/${id}/${op}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(form.amount ? { amount: Math.round(Number(form.amount) * 100) } : {}),
        });
      }
      navigate(`/commerce/pagamentos/${section}${section === 'transacoes' && id ? `/${id}` : ''}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }
  const input = (name: string, label: string, type = 'text') => (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        className="input w-full"
        type={type}
        step={type === 'number' ? '0.01' : undefined}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        value={form[name] ?? ''}
        onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
      />
    </label>
  );
  const select = (name: string, label: string, options: string[]) => (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <select className="input w-full" value={form[name] || ''} onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  const checkbox = (name: string, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={!!form[name]} onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.checked }))} />
      {label}
    </label>
  );
  return (
    <div className="space-y-5">
      <PageHeader
        title={isForm ? `${title} · Configuração` : title}
        description="BRO BOND · Payment Engine — operação, rastreabilidade e controle por empresa"
      />
      <PaymentNavigation />
      {error && <Alert tone="red">{error}</Alert>}
      {busy ? (
        <div className="flex items-center gap-2 py-8">
          <Spinner />
          Carregando pagamentos…
        </div>
      ) : isForm ? (
        <form onSubmit={(e) => void submit(e)} className="max-w-2xl space-y-5 rounded-xl border border-line bg-surface p-6">
          {!canManage ? (
            <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-muted">
                <ShieldCheck size={18} />
                Alterações auditadas. Nenhum segredo existente é exibido.
              </div>
              {section === 'provedores' && (
                <>
                  <h2 className="text-lg font-semibold">{code}</h2>
                  {input('password', 'Sua senha para autorizar a configuração (administrador)', 'password')}
                  {select('environment', 'Ambiente', ['teste', 'producao'])}
                  {checkbox('enabled', 'Provider habilitado')}
                  {code !== 'MANUAL' && (
                    <>
                      {input('token', 'Credencial — deixe vazio para preservar', 'password')}
                      {input('webhook_secret', 'Segredo de webhook — deixe vazio para preservar', 'password')}
                      {input('enabled_methods', 'Métodos habilitados na conta (códigos separados por vírgula)')}
                      {code === 'STRIPE' && (
                        <>
                          {input('return_url', 'URL HTTPS de retorno')}
                          {select('capture_mode', 'Captura de cartão', ['automatic', 'manual'])}
                        </>
                      )}
                      {code === 'PAGBANK' && input('notification_url', 'URL HTTPS de notificações')}
                      <p className="text-xs text-muted">
                        Webhook: /api/gateway/webhooks/
                        {({ MERCADO_PAGO: 'mercadopago', PAGBANK: 'pagbank', STRIPE: 'stripe' } as Record<string, string>)[code || ''] ||
                          code?.toLowerCase()}
                        . Salvar não significa conexão ou homologação externa.
                      </p>
                    </>
                  )}
                </>
              )}
              {section === 'metodos' && (
                <>
                  <h2 className="text-lg font-semibold">{code}</h2>
                  {checkbox('enabled', 'Método habilitado')}
                  {input('min', 'Mínimo (centavos)', 'number')}
                  {input('max', 'Máximo (centavos)', 'number')}
                  {input('maxInstallments', 'Máximo de parcelas', 'number')}
                  <p className="text-sm text-muted">
                    A capacidade real do adapter limita a configuração. Regras por canal, país e moeda são verificadas pelo backend.
                  </p>
                </>
              )}
              {section === 'regras' && (
                <>
                  {select('method', 'Método', methods)}
                  {select('provider', 'Provider', providers)}
                  {input('priority', 'Prioridade (menor primeiro)', 'number')}
                  {select('channel', 'Canal', [
                    '',
                    'OWN_STORE',
                    'MERCADO_LIVRE',
                    'NUVEMSHOP',
                    'INSTAGRAM',
                    'MARKETPLACE',
                    'SOCIAL_COMMERCE',
                    'POS',
                  ])}
                  {input('min', 'Valor mínimo (centavos)', 'number')}
                  {input('max', 'Valor máximo (centavos)', 'number')}
                  {checkbox('enabled', 'Regra publicada')}
                  {checkbox('fallback', 'Permitir esta rota como fallback técnico seguro')}
                </>
              )}
              {section === 'reconciliacao' && (
                <>
                  {select('status', 'Resultado', ['PARTIAL', 'DIVERGENT', 'RESOLVED'])}
                  {input('note', 'Evidência / justificativa (mínimo 8 caracteres)')}
                </>
              )}
              {section === 'transacoes' && (
                <>
                  <h2 className="text-lg font-semibold">
                    {action} · Payment Intent #{id}
                  </h2>
                  {action === 'reembolsar' && input('amount', 'Valor a reembolsar (R$)', 'number')}
                  <p className="text-sm text-muted">
                    A operação será validada e enviada ao provider pelo Payment Engine. Um retorno pendente não confirma movimentação
                    financeira.
                  </p>
                </>
              )}
              <div className="flex gap-3">
                <button className="btn-primary" disabled={saving}>
                  {saving ? 'Processando…' : 'Salvar / Executar'}
                </button>
                <Link className="btn-secondary" to={`/commerce/pagamentos/${section}`}>
                  Voltar
                </Link>
              </div>
            </>
          )}
        </form>
      ) : section === 'provedores' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.providers?.map((p: RecordData) => (
            <article key={p.code} className="space-y-4 rounded-xl border border-line bg-surface p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{p.name}</h2>
                <Status status={p.status} />
              </div>
              <dl className="space-y-2 text-sm">
                <div>Ambiente: {p.environment || 'Não configurado'}</div>
                <div>Credenciais: {p.credential || 'Não configuradas'}</div>
                <div>Webhook: {p.webhook ? 'Configurado' : 'Não configurado'}</div>
                <div>Último health check: {dataHora(p.health_checked_at)}</div>
                <div>Último erro: {p.last_error || '—'}</div>
              </dl>
              <div className="flex flex-wrap gap-1">
                {p.methods.length ? (
                  p.methods.map((m: string) => <Badge key={m}>{m}</Badge>)
                ) : (
                  <span className="text-sm text-muted">Nenhum método disponível.</span>
                )}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">Capabilities</summary>
                {p.capabilities?.map((c: RecordData) => (
                  <p className="py-2" key={c.method}>
                    {c.method} · {c.countries.join(', ')} · {c.currencies.join(', ')} · Refund {c.refund ? 'sim' : 'não'} · Parcela máxima{' '}
                    {c.maxInstallments} · 3DS {c.threeDS ? 'sim' : 'não'}
                  </p>
                ))}
              </details>
              {user?.perfil === 'admin' && (
                <div className="flex flex-wrap gap-2">
                  <Link className="btn-secondary" to={`/commerce/pagamentos/provedores/${p.code}/editar`}>
                    Configurar
                  </Link>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      void apiFetch(`/commerce/payments/providers/${p.code}/health`, { method: 'POST' })
                        .then(() => load())
                        .catch((e) => setError(e.message));
                    }}
                  >
                    Verificar conexão
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : section === 'transacoes' && id && data?.intent ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-5">
            <div>
              <h2 className="text-lg font-semibold">Payment Intent #{id}</h2>
              <p className="text-sm text-muted">Correlação: {data.intent.correlation_id}</p>
            </div>
            <Status status={data.intent.status} />
          </div>
          <Records rows={[data.intent]} fields={['order_id', 'method', 'provider', 'amount', 'status', 'created_at']} />
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {['PAID', 'CAPTURED', 'PARTIALLY_REFUNDED'].includes(data.intent.status) && (
                <Link className="btn-secondary" to={`${location.pathname}/reembolsar`}>
                  Reembolsar
                </Link>
              )}
              {data.intent.status === 'AUTHORIZED' && (
                <Link className="btn-secondary" to={`${location.pathname}/capturar`}>
                  Capturar
                </Link>
              )}
              {['PENDING', 'AUTHORIZED', 'REQUIRES_ACTION', 'PENDING_MANUAL_CONFIRMATION'].includes(data.intent.status) && (
                <Link className="btn-secondary" to={`${location.pathname}/cancelar`}>
                  Cancelar
                </Link>
              )}
              {data.intent.status === 'PENDING_MANUAL_CONFIRMATION' && (
                <Link className="btn-primary" to={`${location.pathname}/confirmar`}>
                  Confirmar pagamento manual
                </Link>
              )}
            </div>
          )}
          <h3 className="font-semibold">Tentativas e timeline</h3>
          <Records
            rows={data.attempts || []}
            fields={[
              'id',
              'provider',
              'provider_transaction_id',
              'requested_amount',
              'captured_amount',
              'refunded_amount',
              'status',
              'failure_code',
              'started_at',
              'completed_at',
            ]}
          />
          {(['operations', 'refunds', 'disputes', 'settlements'] as const).map((k) => (
            <section key={k} className="space-y-2">
              <h3 className="font-semibold">
                {
                  {
                    operations: 'Operações auditáveis',
                    refunds: 'Reembolsos',
                    disputes: 'Disputas',
                    settlements: 'Liquidação e reconciliação',
                  }[k]
                }
              </h3>
              <Records
                rows={data[k] || []}
                fields={
                  k === 'settlements'
                    ? ['id', 'gross_amount', 'provider_fee', 'net_amount', 'status']
                    : ['id', 'amount', 'status', 'created_at']
                }
              />
            </section>
          ))}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Busca
              <input
                className="input mt-1"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="text-sm">
              Status
              <input
                className="input mt-1"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <button className="btn-secondary" onClick={() => void load()}>
              <RefreshCw size={16} />
              Atualizar
            </button>
            {section === 'reconciliacao' && canManage && <Link className="btn-secondary" to="/commerce/pagamentos/repasses">Repasses e extrato</Link>}
            {section === 'regras' && canManage && (
              <Link className="btn-primary" to="/commerce/pagamentos/regras/novo">
                Nova regra
              </Link>
            )}
          </div>
          <Records
            rows={data?.rows || data?.methods || []}
            fields={columns[section] || ['id', 'status']}
            section={['transacoes', 'metodos', 'regras'].includes(section) ? section : undefined}
          />
          {section === 'reconciliacao' &&
            canManage &&
            data?.rows?.map((r: RecordData) => (
              <Link key={r.id} className="btn-secondary mr-2" to={`/commerce/pagamentos/reconciliacao/${r.id}/resolver`}>
                Registrar evidência #{r.id}
              </Link>
            ))}
          <div className="flex items-center justify-between text-sm text-muted">
            <span>{data?.total ?? data?.methods?.length ?? 0} registro(s)</span>
            <div className="flex gap-2">
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </button>
              <span className="p-2">{page}</span>
              <button className="btn-secondary" disabled={page * 25 >= Number(data?.total || 0)} onClick={() => setPage((p) => p + 1)}>
                Próxima
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
