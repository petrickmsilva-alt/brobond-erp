// ============================================================================
// VITRINE — ACOMPANHAMENTO DO PEDIDO. Rota /loja/pedido/:token.
// O token aleatório (256 bits) é a credencial: sem ele a rota responde 404
// idêntico ao pedido inexistente (nunca confirma existência alheia).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PackageCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja } from './LojaShell';

type Visao = {
  sale_id: string;
  pedido: {
    pedido_externo: string;
    estado: string;
    estado_rotulo: string;
    total: number;
    frete: number;
    desconto: number;
    cupom: string | null;
    expira_em: string | null;
    pago_em: string | null;
    convertido_em: string | null;
    criado_em: string | null;
    checkout_token: string | null;
  } | null;
  pagamento: {
    status: string;
    provider: string | null;
    valor: number | null;
    qr_code: string | null;
    copia_cola: string | null;
    engine_status?:string;
    action?: { type:string;url?:string };
    expira_em: string | null;
  };
  venda: { id: number; numero: string; status: string | null; faturada_em: string | null; expedicao_etapa: string | null } | null;
  itens: { produto_id: number; produto: string; tamanho: string | null; quantidade: number; preco_unitario: number; subtotal: number }[];
  rastreio: { transportadora: string | null; codigo: string | null; url: string | null; status: string | null; estimativa_em: string | null }[];
  timeline: { em: string; rotulo: string }[];
};

const ROTULO_PAGAMENTO: Record<string, string> = {
  PENDING: 'Aguardando pagamento',
  AUTHORIZED: 'Pagamento autorizado',
  APPROVED: 'Pagamento aprovado',
  REJECTED: 'Pagamento recusado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Estornado',
  EXPIRED: 'Expirado',
};

function dataHoraBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function LojaPedidoPage() {
  const { token } = useParams();
  const [visao, setVisao] = useState<Visao | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setVisao(await apiFetch<Visao>(`/loja/pedidos/${encodeURIComponent(String(token))}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Pedido não encontrado.');
    } finally {
      setCarregando(false);
    }
  }, [token]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (carregando) {
    return (
      <LojaShell>
        <div className="mx-auto h-64 max-w-2xl animate-pulse rounded-2xl bg-surface" aria-busy="true" aria-label="Carregando pedido" />
      </LojaShell>
    );
  }

  if (!visao) {
    return (
      <LojaShell>
        <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-surface p-8 text-center">
          <h1 className="text-lg font-medium">Pedido não encontrado</h1>
          <p className="mt-1 text-sm text-muted">{erro || 'Verifique o link recebido por e-mail.'}</p>
        </div>
      </LojaShell>
    );
  }

  const p = visao.pedido;
  const pagoAprovado = ['APPROVED', 'AUTHORIZED'].includes(visao.pagamento.status) || p?.estado === 'CONVERTIDO';

  return (
    <LojaShell>
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100">
                  <ShieldCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                </span>
                <div>
                  <h1 className="text-xl font-semibold">Pedido {p?.pedido_externo ?? '—'}</h1>
                  <p className="text-sm text-muted">Recebido em {dataHoraBR(p?.criado_em)}</p>
                </div>
              </div>
            </div>
            <span className="rounded-full bg-navy-50 px-3 py-1 text-sm font-medium text-navy-700">{p?.estado_rotulo ?? '—'}</span>
          </div>

          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Pagamento</dt>
              <dd className="mt-1 font-medium">{ROTULO_PAGAMENTO[visao.pagamento.status] ?? visao.pagamento.status}</dd>
            </div>
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Total</dt>
              <dd className="mt-1 font-semibold tabular-nums">{precoLoja(p?.total ?? 0)}</dd>
            </div>
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Entrega</dt>
              <dd className="mt-1 font-medium">
                {visao.venda
                  ? visao.venda.expedicao_etapa
                    ? `Etapa: ${visao.venda.expedicao_etapa}`
                    : 'Em preparação'
                  : pagoAprovado
                    ? 'Entrará em separação em seguida'
                    : 'Após a confirmação do pagamento'}
              </dd>
            </div>
          </dl>

          {p?.estado === 'AGUARDANDO_PAGAMENTO' && p.expira_em && (
            <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
              Aguardando pagamento até {dataHoraBR(p.expira_em)} — depois disso as peças reservadas voltam para a
              vitrine.
            </p>
          )}

          {visao.pagamento.engine_status === 'REQUIRES_ACTION' && visao.pagamento.action?.url?.startsWith('https://') && <a className="btn-primary" href={visao.pagamento.action.url} rel="noreferrer">Concluir pagamento em ambiente seguro</a>}
          {visao.pagamento.engine_status === 'PENDING_MANUAL_CONFIRMATION' && <p className="text-sm">Aguardando confirmação manual por um responsável autorizado.</p>}
          {visao.pagamento.copia_cola && !pagoAprovado && (
            <div className="mt-4">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">PIX copia e cola</div>
              <div className="mt-1 flex items-start gap-2">
                <code className="block max-h-24 flex-1 overflow-auto rounded-lg bg-canvas p-3 text-xs break-all">
                  {visao.pagamento.engine_status === 'REQUIRES_ACTION' && visao.pagamento.action?.url?.startsWith('https://') && <a className="btn-primary" href={visao.pagamento.action.url} rel="noreferrer">Concluir pagamento em ambiente seguro</a>}
          {visao.pagamento.engine_status === 'PENDING_MANUAL_CONFIRMATION' && <p className="text-sm">Aguardando confirmação manual por um responsável autorizado.</p>}
          {visao.pagamento.copia_cola}
                </code>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(visao.pagamento.copia_cola ?? '');
                  }}
                >
                  Copiar
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Itens</h2>
          <ul className="mt-3 divide-y divide-line">
            {visao.itens.map((i, idx) => (
              <li key={idx} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{i.produto}</span>
                  {i.tamanho && <span className="ml-2 text-muted">· {i.tamanho}</span>}
                  <span className="ml-2 text-muted">× {i.quantidade}</span>
                </span>
                <span className="tabular-nums">{precoLoja(i.subtotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal − desconto</dt>
              <dd className="tabular-nums">{precoLoja(Math.max(0, (p?.total ?? 0) - (p?.frete ?? 0)))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Frete</dt>
              <dd className="tabular-nums">{(p?.frete ?? 0) > 0 ? precoLoja(p!.frete) : 'Grátis'}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{precoLoja(p?.total ?? 0)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Linha do tempo</h2>
            <ol className="mt-3 space-y-3">
              {visao.timeline.map((ev, idx) => (
                <li key={idx} className="flex items-baseline gap-3 text-sm">
                  <span className="tabular-nums text-muted">{dataHoraBR(ev.em)}</span>
                  <span className="font-medium">{ev.rotulo}</span>
                </li>
              ))}
            </ol>
            <button type="button" className="btn-ghost mt-4" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar status
            </button>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Rastreio</h2>
            {visao.rastreio.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <PackageCheck className="h-4 w-4" aria-hidden="true" /> Sem código de rastreio ainda — o código aparece
                aqui quando o pedido for postado.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {visao.rastreio.map((r, idx) => (
                  <li key={idx} className="text-sm">
                    <div className="font-medium capitalize">{String(r.status ?? '').replace(/_/g, ' ') || '—'}</div>
                    <div className="text-muted">
                      {r.transportadora ?? ''}
                      {r.codigo ? ` · ${r.codigo}` : ''}
                    </div>
                    {r.estimativa_em && <div className="text-xs text-muted">Previsão: {r.estimativa_em}</div>}
                    {r.url && (
                      <a className="text-sm text-primary hover:underline" href={r.url} target="_blank" rel="noreferrer">
                        Acompanhar na transportadora
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {visao.venda && (
          <p className="text-center text-xs text-muted">
            Venda operacional #{visao.venda.numero} · faturada em {dataHoraBR(visao.venda.faturada_em)}
          </p>
        )}
      </div>
    </LojaShell>
  );
}
