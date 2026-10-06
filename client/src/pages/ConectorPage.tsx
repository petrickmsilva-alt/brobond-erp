// ============================================================================
// Hub Omnichannel — PAINEL ANALÍTICO de um conector multicanal.
//
// Esta página é a clonagem fiel do gabarito da interface legada do
// `brobond-ai-commerce`, agora unificada no monorepo mestre. A MESMA
// estrutura vale para os QUATRO canais do Hub (Mercado Livre, Mercado
// Pago, Nuvemshop e Instagram Shopping) — nenhum conector tem layout
// próprio nem estado especial: desde 2026-10-06 os quatro têm motor no
// servidor e a página consulta todos por `/connectors/<slug>/painel`.
//
//   a) bloco superior de KPIs (5 colunas, contadores monoespaçados);
//   b) bloco central dividido — "Vendas do canal" | "Webhooks — eventos
//      recebidos";
//   c) bloco inferior largo — "Conteúdo importado desta plataforma", com
//      o botão de sincronismo em neon abaixo.
//
// COMPLIANCE (Mercado Pago): esta tela NÃO tem — e nunca mais terá —
// campos abertos de Access Token/Public Key nem botão de "salvar
// credenciais". A leitura e a validação das chaves acontecem em segundo
// plano, direto das variáveis de ambiente seguras da Render
// (`POST /connectors/mercadopago/conectar-ambiente`); nenhuma string de
// credencial trafega para o navegador nem aparece em tela.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Inbox,
  Link2,
  Loader2,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Unplug,
  Webhook,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Module } from '../modules';
import { Badge, Spinner, useToast } from '../components/ui';
import ConnectorBrand, { CONNECTOR_BRAND_LABELS, isConnectorBrandId } from '../components/ConnectorBrand';

// ----------------------------------------------------------------------------
// Contratos consumidos de /api/connectors/<slug>/painel
// ----------------------------------------------------------------------------

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
  environmentCredentialsAvailable: boolean;
  requiresReauth: boolean;
  updatedAt: string | null;
};

type PanelSale = {
  id: string;
  reference: string;
  externalOrderId: string | null;
  status: string;
  quantity: number;
  amountCents: number;
  currency: string;
  occurredAt: string;
};

type PanelEvent = {
  id: string;
  externalEventId: string;
  topic: string | null;
  processedAt: string | null;
  createdAt: string;
};

type PanelContent = {
  id: string;
  produto: string | null;
  sku: string | null;
  variacao: string | null;
  tamanho: string | null;
  quantity: number;
  subtotalCents: number;
  occurredAt: string;
  matched: boolean;
};

type ConnectorPanel = {
  provider: string;
  revenueCents: number;
  salesCount: number;
  eventCount: number;
  sales: PanelSale[];
  events: PanelEvent[];
  importedContent: PanelContent[];
};

/**
 * Provedor → slug das rotas `/api/connectors/<slug>/…`. Espelha
 * `CONNECTOR_PROVIDER_SLUGS` do módulo de conectores: os QUATRO canais
 * de produção, todos com motor no servidor. O Instagram entrou no mapa
 * em 2026-10-06, quando ganhou conector próprio ligado à Graph API da
 * Meta — a página consulta a API dele como a de qualquer outro canal.
 */
const PATH: Record<string, string> = {
  MERCADOLIVRE: 'mercadolivre',
  MERCADOPAGO: 'mercadopago',
  NUVEMSHOP: 'nuvemshop',
  INSTAGRAM: 'instagram',
};

// ----------------------------------------------------------------------------
// Formatação
// ----------------------------------------------------------------------------

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function formatMoney(cents: number) {
  return BRL.format((Number(cents) || 0) / 100);
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function formatShortDate(value: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const SALE_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  REFUNDED: 'Estornado',
  CANCELLED: 'Cancelado',
};

// ----------------------------------------------------------------------------
// Peças visuais do gabarito (Dark Slate premium, vidro translúcido)
// ----------------------------------------------------------------------------

/** Superfície de vidro padrão de TODOS os blocos do painel. */
const GLASS = 'rounded-xl bg-slate-950/85 backdrop-blur-xl border border-slate-800/90 shadow-[0_8px_32px_rgba(0,0,0,0.7)]';

function Panel({
  title,
  subtitle,
  children,
  className = '',
  accent = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <section className={`${GLASS} flex flex-col ${className}`}>
      <header className="flex items-baseline justify-between gap-3 border-b border-slate-800/90 px-5 py-3.5">
        <h2 className={`text-[11px] font-bold uppercase tracking-[0.14em] ${accent ? 'text-cyan-300 drop-shadow-[0_0_6px_rgba(34,211,238,0.35)]' : 'text-slate-200'}`}>
          {title}
        </h2>
        {subtitle && (
          <span className={`font-mono text-[11px] font-bold tabular-nums ${accent ? 'text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.4)]' : 'text-slate-400'}`}>
            {subtitle}
          </span>
        )}
      </header>
      <div className="flex min-h-[13rem] flex-1 flex-col">{children}</div>
    </section>
  );
}

/** Estado vazio elegante: ícone em halo + mensagem canônica do gabarito. */
function PanelEmpty({ icon, message, hint }: { icon: React.ReactNode; message: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/90 text-slate-500 shadow-[0_0_24px_rgba(15,23,42,0.8)]">{icon}</div>
      <p className="text-sm font-semibold text-slate-200">{message}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/** Cartão de KPI com contador monoespaçado tabular e glow semântico. */
function Kpi({ label, value, tone = 'slate' }: { label: string; value: string; tone?: 'slate' | 'emerald' | 'amber' | 'red' | 'cyan' }) {
  const tones = {
    slate: 'text-slate-100',
    emerald: 'text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.4)]',
    amber: 'text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.5)]',
    red: 'text-rose-500 font-bold drop-shadow-[0_0_6px_rgba(244,63,94,0.4)]',
    cyan: 'text-cyan-400 drop-shadow-[0_0_6px_rgba(34,211,238,0.4)]',
  } as const;
  return (
    <div className={`${GLASS} px-4 py-3.5`}>
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className={`mt-1.5 truncate font-mono text-2xl font-black tabular-nums tracking-tight ${tones[tone]}`} title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * Pulsação "live" de um canal CONECTADO.
 *
 * O badge ocre de homologação deixou de existir: não há mais canal em
 * modo de prontidão no Hub. Esta pulsação é ligada ao estado REAL da
 * conexão (`status.connected`, que vem do banco), nunca fixada no
 * código — um canal desconectado mostra o rótulo de status dele, e um
 * canal conectado mostra o verde pulsante.
 */
function LivePulse({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-green-500/40 bg-green-950/90 px-3 py-1.5 shadow-[0_0_18px_rgba(34,197,94,0.18)]">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.75)]" />
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-green-300 drop-shadow-[0_0_7px_rgba(74,222,128,0.55)]">{label}</span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// Página
// ----------------------------------------------------------------------------

/** Painel vazio canônico — estado inicial enquanto a consulta carrega. */
const EMPTY_PANEL: ConnectorPanel = {
  provider: '',
  revenueCents: 0,
  salesCount: 0,
  eventCount: 0,
  sales: [],
  events: [],
  importedContent: [],
};

export default function ConectorPage({ module }: { module: Module }) {
  const provider = String(module.connector ?? '');
  const slug = PATH[provider] ?? provider.toLowerCase();

  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [panel, setPanel] = useState<ConnectorPanel>(EMPTY_PANEL);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const toast = useToast();
  // Ativação silenciosa das credenciais de ambiente: UMA vez por canal.
  const envAttempt = useRef('');

  const load = useCallback(() => {
    setError('');
    api
      .get<{ connector: ConnectorStatus; panel: ConnectorPanel }>(`/connectors/${slug}/painel`)
      .then((r) => {
        setStatus(r.connector);
        setPanel(r.panel ?? EMPTY_PANEL);
      })
      .catch((e: ApiError) => setError(e.message || 'Não foi possível carregar o conector.'));
  }, [slug]);

  // Troca de aba entre conectores: zera TUDO (inclusive avisos) antes de
  // recarregar — nenhum resquício de um canal aparece no outro.
  useEffect(() => {
    setStatus(null);
    setPanel(EMPTY_PANEL);
    setError('');
    setBusy('');
    load();
  }, [load]);

  /**
   * Mercado Pago — handshake de COMPLIANCE em segundo plano. Quando a
   * Render já expõe o par de chaves e o canal ainda não está ativo, o
   * painel valida e ativa sozinho, sem exibir, pedir ou transportar
   * qualquer string de credencial.
   */
  useEffect(() => {
    if (!status || status.authModel !== 'credentials') return;
    if (status.connected || !status.environmentCredentialsAvailable) return;
    if (envAttempt.current === status.provider) return;
    envAttempt.current = status.provider;
    let active = true;
    api
      .post<{ connector: ConnectorStatus }>('/connectors/mercadopago/conectar-ambiente', {})
      .then((r) => {
        if (!active) return;
        setStatus(r.connector);
        toast.success('Credenciais do ambiente validadas com segurança.');
        load();
      })
      .catch(() => {
        /* silencioso: o bloco de ambiente pendente já explica o que falta */
      });
    return () => {
      active = false;
    };
    // `toast` é estável o bastante para este efeito de ativação única.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, load]);

  async function autorizar() {
    setBusy('auth');
    setError('');
    try {
      // redirect_uri DINÂMICO: a origem onde o ERP está rodando — num
      // deploy da Render é o host unificado. O backend valida a origem,
      // deriva /api/connectors/<slug>/callback e persiste a URI com o
      // state para repeti-la na troca do código.
      const r = await api.post<{ authorizationUrl: string }>(`/connectors/${slug}/autorizar`, {
        redirect_uri: window.location.origin,
      });
      if (r?.authorizationUrl) window.location.href = r.authorizationUrl;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function sincronizar() {
    setBusy('sync');
    setError('');
    try {
      await api.post(`/connectors/${slug}/sincronizar`, { limite: 50 });
      // Aviso EFÊMERO (toast, 3s, com botão de fechar) — nunca uma barra
      // fixa que sobrevive à troca de abas do Hub.
      toast.success('Sincronização concluída.');
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
      envAttempt.current = r.connector.provider;
      toast.info('Conector desconectado.');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const Icon = module.icon;
  const brandLabel = isConnectorBrandId(provider) ? CONNECTOR_BRAND_LABELS[provider] : module.label;
  const connected = Boolean(status?.connected);
  const syncing = busy === 'sync';

  return (
    <div className="min-h-full space-y-4 bg-slate-950/35 p-4 sm:p-6">
      {/* ---------------------------------------------------------------- */}
      {/* Cabeçalho do canal: logomarca oficial + pulsação live            */}
      {/* ---------------------------------------------------------------- */}
      <header className={`${GLASS} flex flex-wrap items-center justify-between gap-4 px-5 py-4`}>
        <div className="flex min-w-0 items-center gap-4">
          {isConnectorBrandId(provider) ? (
            <ConnectorBrand brand={provider} className="h-12 w-12 shrink-0 rounded-xl shadow-lg shadow-black/30" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-slate-700/90 bg-slate-950/90 text-brand-300 shadow-[0_0_20px_rgba(0,0,0,0.55)]">
              <Icon className="h-6 w-6" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight text-white">{brandLabel}</h1>
            <p className="mt-0.5 line-clamp-2 max-w-2xl text-sm text-slate-400">{status?.description ?? module.description}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <LivePulse label="CONECTADO COM SUCESSO" />
          ) : (
            status && <Badge tone={status.requiresReauth ? 'amber' : 'slate'}>{status.statusLabel}</Badge>
          )}
          {status && (
            <Badge tone={status.authModel === 'oauth2' ? 'blue' : 'slate'}>{status.authModel === 'oauth2' ? 'OAuth2' : 'Credenciais do ambiente'}</Badge>
          )}
          {status?.authModel === 'oauth2' && (
            <button className="btn-secondary" onClick={autorizar} disabled={!status.configured || busy === 'auth'}>
              {busy === 'auth' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {connected ? 'Reautorizar' : 'Conectar conta'}
            </button>
          )}
          {connected && (
            <button className="btn-secondary" onClick={desconectar} disabled={busy === 'off'}>
              {busy === 'off' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Desconectar
            </button>
          )}
        </div>
      </header>

      {/* Erro: inline e DISPENSÁVEL (X), nunca uma barra global fixa. */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/50 bg-rose-950/75 px-4 py-3 text-sm text-rose-300 shadow-[0_8px_24px_rgba(0,0,0,0.45)]" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button className="text-red-300/70 transition-colors hover:text-red-200" onClick={() => setError('')} aria-label="Fechar aviso">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!status && !error && <Spinner label="Consultando o conector..." />}

      {/* Prontidão de ambiente (sem jamais exibir valores de credencial). */}
      {status && !status.configured && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-950/75 px-4 py-3 text-xs text-amber-300 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Variáveis de ambiente pendentes no servidor (Render): <strong className="font-mono">{status.missingEnv.join(', ') || '—'}</strong>. As chaves são lidas e
            validadas em segundo plano — nenhuma credencial é digitada ou exibida neste painel.
          </span>
        </div>
      )}
      {status?.lastError && <p className="px-1 text-xs text-red-400">Último erro: {status.lastError}</p>}

      {status && (
        <>
          {/* ------------------------------------------------------------ */}
          {/* a) Bloco de KPIs superiores — 5 colunas                      */}
          {/* ------------------------------------------------------------ */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Kpi label="Pedidos Importados" value={String(status?.importedCount ?? 0)} tone="emerald" />
            <Kpi label="Pedidos Ignorados" value={String(status?.duplicatedCount ?? 0)} tone="amber" />
            <Kpi label="Falhas" value={String(status?.failedCount ?? 0)} tone="red" />
            <Kpi label="Receita do Canal" value={formatMoney(panel.revenueCents)} tone="amber" />
            <Kpi label="Última Sincronização" value={formatDate(status?.lastSyncAt ?? null)} tone="cyan" />
          </div>

          {/* ------------------------------------------------------------ */}
          {/* b) Bloco central dividido — vendas | webhooks                */}
          {/* ------------------------------------------------------------ */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Vendas do canal" subtitle={`${panel.salesCount} no total`}>
              {panel.sales.length === 0 ? (
                <PanelEmpty
                  icon={<ShoppingCart className="h-6 w-6" />}
                  message="Nenhuma venda registrada"
                  hint="Os pedidos aparecem aqui assim que a primeira sincronização ou webhook do canal for processado."
                />
              ) : (
                <ul className="divide-y divide-slate-800/70">
                  {panel.sales.map((sale) => (
                    <li key={sale.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-slate-300">{sale.externalOrderId || sale.reference}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {formatShortDate(sale.occurredAt)} · {sale.quantity} item(ns) · {SALE_STATUS_LABEL[sale.status] ?? sale.status}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-sm font-semibold tabular-nums text-slate-100">{formatMoney(sale.amountCents)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Webhooks — eventos recebidos" subtitle={`${panel.eventCount} no total`} accent>
              {panel.events.length === 0 ? (
                <PanelEmpty
                  icon={<Webhook className="h-6 w-6" />}
                  message="Nenhum evento recebido"
                  hint="A caixa de entrada mostra cada notificação assinada que a plataforma enviar para o Hub."
                />
              ) : (
                <ul className="divide-y divide-slate-800/70">
                  {panel.events.map((event) => (
                    <li key={event.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-slate-200">{event.topic || 'evento'}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{event.externalEventId}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-[11px] tabular-nums text-slate-400">{formatShortDate(event.createdAt)}</div>
                        <div className={`text-[10px] font-bold uppercase tracking-wider ${event.processedAt ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {event.processedAt ? 'processado' : 'na fila'}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* c) Bloco inferior largo — conteúdo importado + sync neon     */}
          {/* ------------------------------------------------------------ */}
          <Panel title="Conteúdo importado desta plataforma" subtitle={status ? `${status.syncCount} sincronização(ões)` : undefined}>
            {panel.importedContent.length === 0 ? (
              <PanelEmpty
                icon={<PackageSearch className="h-6 w-6" />}
                message="Nenhum conteúdo importado"
                hint="Itens de pedido casados com o catálogo do ERP aparecem aqui após a sincronização."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800/80 text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="px-5 py-2.5 text-left font-bold">Produto</th>
                      <th className="px-5 py-2.5 text-left font-bold">Variação</th>
                      <th className="px-5 py-2.5 text-right font-bold">Qtd.</th>
                      <th className="px-5 py-2.5 text-right font-bold">Subtotal</th>
                      <th className="px-5 py-2.5 text-right font-bold">Importado em</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {panel.importedContent.map((item) => (
                      <tr key={item.id}>
                        <td className="px-5 py-2.5">
                          <span className="text-slate-200">{item.produto ?? 'Sem casamento no catálogo'}</span>
                          {item.sku && <span className="ml-2 font-mono text-[11px] text-slate-500">{item.sku}</span>}
                          {!item.matched && <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-amber-400">pendente</span>}
                        </td>
                        <td className="px-5 py-2.5 text-slate-400">{item.variacao ?? item.tamanho ?? '—'}</td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-200">{item.quantity}</td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-200">{formatMoney(item.subtotalCents)}</td>
                        <td className="px-5 py-2.5 text-right font-mono text-[11px] tabular-nums text-slate-500">{formatShortDate(item.occurredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-800/80 px-5 py-4">
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 px-4 py-2 text-sm font-bold text-slate-950 shadow-lg shadow-orange-500/20 transition-all hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                onClick={sincronizar}
                disabled={!connected || syncing}
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sincronizar vendas na plataforma
              </button>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Inbox className="h-3.5 w-3.5" />
                {connected ? `Loja: ${status?.shopName || status?.shopId || '—'}` : 'Conecte o canal para liberar a sincronização.'}
              </span>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
