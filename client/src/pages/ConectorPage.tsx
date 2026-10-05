// ============================================================================
// Hub Omnichannel — painel de um conector multicanal (Fase 2 integrada à
// identidade visual da Fase 3). Consome /api/connectors do motor comercial.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, PlugZap, RefreshCw, Unplug } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Module } from '../modules';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';

type ConnectorStatus = {
  provider: string;
  label: string;
  description: string;
  authModel: 'oauth2' | 'credentials';
  status: string;
  statusLabel: string;
  connected: boolean;
  configured: boolean;
  missingEnv: string[];
  shopId: string | null;
  shopName: string | null;
  expiresAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  importedCount: number;
  duplicatedCount: number;
  failedCount: number;
  syncCount: number;
  publicKeyPreview: string | null;
  requiresReauth: boolean;
  updatedAt: string | null;
};

const PATH: Record<string, string> = {
  MERCADOLIVRE: 'mercadolivre',
  MERCADOPAGO: 'mercadopago',
  SHOPEE: 'shopee',
  TIKTOK: 'tiktok',
};

function formatDate(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

export default function ConectorPage({ module }: { module: Module }) {
  const provider = module.connector as string;
  const slug = PATH[provider] ?? provider.toLowerCase();
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [token, setToken] = useState('');
  const [publicKey, setPublicKey] = useState('');

  const load = useCallback(() => {
    setError('');
    api
      .get<ConnectorStatus>(`/connectors/${slug}`)
      .then(setStatus)
      .catch((e: ApiError) => setError(e.message || 'Não foi possível carregar o conector.'));
  }, [slug]);

  useEffect(() => {
    setStatus(null);
    load();
  }, [load]);

  async function autorizar() {
    setBusy('auth');
    setError('');
    try {
      const r = await api.post<{ authorizationUrl: string }>(`/connectors/${slug}/autorizar`, {});
      if (r?.authorizationUrl) window.location.href = r.authorizationUrl;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function conectarMercadoPago(e: React.FormEvent) {
    e.preventDefault();
    setBusy('mp');
    setError('');
    try {
      const r = await api.post<{ connector: ConnectorStatus }>('/connectors/mercadopago/conectar', { accessToken: token, publicKey });
      setStatus(r.connector);
      setToken('');
      setPublicKey('');
      setMsg('Credenciais salvas com segurança.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function sincronizar() {
    setBusy('sync');
    setError('');
    setMsg('');
    try {
      await api.post(`/connectors/${slug}/sincronizar`, { limite: 50 });
      setMsg('Sincronização concluída.');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function desconectar() {
    setBusy('off');
    setError('');
    try {
      const r = await api.del<{ connector: ConnectorStatus }>(`/connectors/${slug}`);
      setStatus(r.connector);
      setMsg('Conector desconectado.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const Icon = module.icon;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800/60 bg-slate-900/60 text-brand-400">
              <Icon className="h-5 w-5" />
            </span>
            {module.label}
          </span>
        }
        description={module.description}
        actions={
          status?.connected ? (
            <button className="btn-secondary" onClick={sincronizar} disabled={busy === 'sync'}>
              {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sincronizar pedidos
            </button>
          ) : undefined
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {msg && <Alert tone="green">{msg}</Alert>}
      {!status && !error && <Spinner label="Consultando o conector..." />}

      {status && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <section className="card p-5 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {status.connected ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <PlugZap className="h-5 w-5 text-slate-400" />}
                <span className="text-base font-semibold text-slate-100">{status.statusLabel}</span>
              </div>
              <Badge tone={status.connected ? 'green' : status.requiresReauth ? 'amber' : 'slate'}>{status.authModel === 'oauth2' ? 'OAuth2' : 'Credenciais'}</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-400">{status.description}</p>

            {!status.configured && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Variáveis de ambiente pendentes no servidor: <strong className="font-mono">{status.missingEnv.join(', ')}</strong>
                </span>
              </div>
            )}
            {status.lastError && <p className="mt-3 text-xs text-red-400">Último erro: {status.lastError}</p>}

            <div className="mt-5 flex flex-wrap gap-2">
              {status.authModel === 'oauth2' && (
                <button className="btn-accent" onClick={autorizar} disabled={!status.configured || busy === 'auth'}>
                  {busy === 'auth' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                  {status.connected ? 'Reautorizar conta' : 'Conectar conta'}
                </button>
              )}
              {status.connected && (
                <button className="btn-secondary" onClick={desconectar} disabled={busy === 'off'}>
                  <Unplug className="h-4 w-4" /> Desconectar
                </button>
              )}
            </div>

            {status.authModel === 'credentials' && (
              <form onSubmit={conectarMercadoPago} className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-800/60 pt-5 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="mp-token">Access Token de produção</label>
                  <input id="mp-token" className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="APP_USR-..." />
                </div>
                <div>
                  <label className="label" htmlFor="mp-key">Public Key</label>
                  <input id="mp-key" className="input font-mono" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="APP_USR-..." />
                </div>
                <div className="sm:col-span-2">
                  <button className="btn-accent" type="submit" disabled={busy === 'mp' || !token || !publicKey}>
                    {busy === 'mp' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Salvar credenciais
                  </button>
                  {status.publicKeyPreview && <span className="ml-3 text-xs text-slate-500">Public key atual: {status.publicKeyPreview}</span>}
                </div>
              </form>
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Telemetria</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ['Loja', status.shopName || status.shopId || '—'],
                ['Pedidos importados', String(status.importedCount)],
                ['Duplicados ignorados', String(status.duplicatedCount)],
                ['Falhas', String(status.failedCount)],
                ['Sincronizações', String(status.syncCount)],
                ['Última sincronização', formatDate(status.lastSyncAt)],
                ['Token expira em', formatDate(status.expiresAt)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-slate-400">{k}</dt>
                  <dd className="truncate font-mono text-slate-100">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
