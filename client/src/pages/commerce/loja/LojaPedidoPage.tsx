// ============================================================================
// BROBOND STORE — ACOMPANHAMENTO DO PEDIDO. Rota /loja/pedido/:token.
//
// O token aleatório (256 bits) é a credencial: sem ele a rota responde 404
// idêntico ao pedido inexistente (nunca confirma existência alheia).
//
// PIX: QR Code e Copia e Cola vêm EXCLUSIVAMENTE do payload real do provider
// persistido no backend. Nenhum QR é gerado no navegador. Webhook é a fonte
// primária de confirmação; polling CONTROLADO (45 s, limite de tentativas,
// pausa com aba oculta) é apenas complemento — nunca polling agressivo.
// Abrir/renderizar esta página JAMAIS marca o pedido como pago.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, ExternalLink, MessageCircle, PackageCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch, ApiError } from '../../../lib/api';
import { LojaShell, precoLoja } from './LojaShell';

type CompradorPublico = { nome: string | null; email: string | null; whatsapp: string | null; documento_mascarado: string | null; marketing_opt_in: boolean };

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
    comprador?: CompradorPublico | null;
    endereco?: Record<string, unknown> | null;
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
    qr_code_base64?: string | null;
    ticket_url?: string | null;
    copia_cola: string | null;
    provider_order_id?: string | null;
    engine_status?: string;
    action?: { type?: string; url?: string };
    expira_em: string | null;
  };
  venda: { id: number; numero: string; status: string | null; faturada_em: string | null; expedicao_etapa: string | null } | null;
  itens: { produto_id: number; produto: string; tamanho: string | null; quantidade: number; preco_unitario: number; subtotal: number }[];
  rastreio: { transportadora: string | null; codigo: string | null; url: string | null; status: string | null; estimativa_em: string | null }[];
  timeline: { em: string; rotulo: string }[];
};

const ROTULO_PAGAMENTO: Record<string, string> = {
  PENDING: 'Aguardando pagamento',
  IN_PROCESS: 'Pagamento em processamento',
  PROCESSING: 'Pagamento em processamento',
  AUTHORIZED: 'Pagamento autorizado',
  APPROVED: 'Pagamento aprovado',
  REJECTED: 'Pagamento recusado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Estornado',
  EXPIRED: 'Expirado',
  ERROR: 'Erro no pagamento',
};
const TERMINAIS = new Set(['APPROVED', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'EXPIRED', 'ERROR']);
const INTERVALO_POLLING_MS = 45_000;
const MAX_POLLING = 8;

/** Apenas base64 de imagem real, jamais string EMV ou QR fabricado. */
function base64QrValido(valor: string | null | undefined): boolean {
  return !!valor && /^[A-Za-z0-9+/=\s]+$/.test(valor) && valor.replace(/\s/g, '').length >= 64;
}

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
  const [copiado, setCopiado] = useState(false);
  const [tentativas, setTentativas] = useState(0);
  const emVoo = useRef<AbortController | null>(null);

  const carregar = useCallback(async (silencioso = false) => {
    emVoo.current?.abort();
    const controller = new AbortController();
    emVoo.current = controller;
    if (!silencioso) { setCarregando(true); setErro(''); }
    try {
      const r = await apiFetch<Visao>(`/loja/pedidos/${encodeURIComponent(String(token))}`, { signal: controller.signal });
      if (!controller.signal.aborted) setVisao(r);
    } catch (e) {
      if (!controller.signal.aborted && !silencioso) setErro(e instanceof ApiError ? e.message : 'Pedido não encontrado.');
    } finally {
      if (!controller.signal.aborted && !silencioso) setCarregando(false);
    }
  }, [token]);

  useEffect(() => { void carregar(); return () => emVoo.current?.abort(); }, [carregar]);

  // Polling CONTROLADO: somente pagamento não-terminal, aba visível, teto de 8
  // consultas. Webhook assinado continua sendo a confirmação primária.
  const pollingAtivo = !!visao && !TERMINAIS.has(visao.pagamento.status) && tentativas < MAX_POLLING;
  useEffect(() => {
    if (!pollingAtivo) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setTentativas((n) => n + 1);
      void carregar(true);
    }, INTERVALO_POLLING_MS);
    return () => window.clearInterval(id);
  }, [pollingAtivo, carregar]);

  const copiar = async () => {
    if (!visao?.pagamento.copia_cola) return;
    try {
      await navigator.clipboard.writeText(visao.pagamento.copia_cola);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 2500);
    } catch { setCopiado(false); }
  };

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
          <Link to="/loja" className="btn-secondary mt-4 inline-flex">Voltar para a loja</Link>
        </div>
      </LojaShell>
    );
  }

  const p = visao.pedido;
  const pag = visao.pagamento;
  const pagoAprovado = ['APPROVED', 'AUTHORIZED'].includes(pag.status) || p?.estado === 'CONVERTIDO';
  const aguardando = !TERMINAIS.has(pag.status);
  const qr = base64QrValido(pag.qr_code_base64) ? `data:image/png;base64,${pag.qr_code_base64!.replace(/\s/g, '')}` : null;
  const comprador = p?.comprador;

  return (
    <LojaShell tituloDocumento={`Pedido ${p?.pedido_externo ?? ''}`}>
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="rounded-2xl border border-line bg-surface p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className={`flex h-9 w-9 items-center justify-center rounded-full ${pagoAprovado ? 'bg-emerald-100' : 'bg-navy-50'}`}>
                {pagoAprovado ? <PackageCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5 text-navy-700" aria-hidden="true" />}
              </span>
              <div>
                <h1 className="text-xl font-semibold">Pedido {p?.pedido_externo ?? '—'}</h1>
                <p className="text-sm text-muted">Recebido em {dataHoraBR(p?.criado_em)}</p>
              </div>
            </div>
            <span className="rounded-full bg-navy-50 px-3 py-1 text-sm font-medium text-navy-700">{p?.estado_rotulo ?? '—'}</span>
          </div>

          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Pagamento</dt>
              <dd className="mt-1 font-medium">{ROTULO_PAGAMENTO[pag.status] ?? pag.status}</dd>
            </div>
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Total</dt>
              <dd className="mt-1 font-semibold tabular-nums">{precoLoja(p?.total ?? pag.valor ?? 0)}</dd>
            </div>
            <div className="rounded-xl bg-canvas p-3">
              <dt className="text-muted">Pagamento expira em</dt>
              <dd className="mt-1 font-medium">{dataHoraBR(pag.expira_em ?? p?.expira_em)}</dd>
            </div>
          </dl>
          {comprador && (comprador.email || comprador.whatsapp) && (
            <div className="mt-4 rounded-xl border border-line bg-canvas p-3 text-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Atualizações do pedido</h2>
              <p className="mt-2 text-xs text-muted">Enviaremos a confirmação, o PIX, o pagamento aprovado e o rastreio para os contatos abaixo.</p>
              {comprador.email && <p className="mt-1 break-all">{comprador.email}</p>}
              {comprador.whatsapp && <p className="mt-0.5 flex items-center gap-1.5"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> WhatsApp: {comprador.whatsapp}</p>}
              <p className="mt-1 text-[11px] text-muted">Dados mascarados para sua privacidade.</p>
            </div>
          )}
        </div>

        {/* PIX — somente dados reais do provider, sem QR fabricado */}
        {aguardando && (qr || pag.copia_cola || pag.ticket_url) && (
          <section className="rounded-2xl border border-line bg-surface p-6" aria-labelledby="titulo-pix">
            <h2 id="titulo-pix" className="text-lg font-semibold">Pague com PIX</h2>
            <p className="mt-1 text-sm text-muted">Escaneie o QR Code ou use o Copia e Cola no aplicativo do seu banco. A confirmação chega pelo processador — esta tela não confirma pagamento.</p>
            <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              {qr ? (
                <img src={qr} alt={`QR Code PIX real do pedido ${p?.pedido_externo ?? ''}`} width={240} height={240} loading="eager" decoding="async"
                  className="h-56 w-56 rounded-xl border border-line bg-white p-2" />
              ) : (
                <div className="flex h-56 w-56 shrink-0 items-center justify-center rounded-xl border border-dashed border-line bg-canvas p-4 text-center text-xs text-muted" role="img" aria-label="QR Code ainda não fornecido pelo processador">
                  QR Code ainda não fornecido pelo processador. Use o Copia e Cola abaixo.
                </div>
              )}
              <div className="w-full space-y-3">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">PIX Copia e Cola</span>
                  {pag.copia_cola ? (
                    <>
                      <p className="mt-1 break-all rounded-lg border border-line bg-canvas p-3 font-mono text-xs">{pag.copia_cola}</p>
                      <button type="button" onClick={() => void copiar()} className="btn-secondary mt-2 min-h-11 w-full text-xs">
                        {copiado ? 'Copiado!' : <><Copy className="h-4 w-4" aria-hidden="true" /> Copiar código PIX</>}
                      </button>
                    </>
                  ) : (
                    <p className="mt-1 text-sm text-muted">Código ainda não disponível. Use “Atualizar status” em instantes.</p>
                  )}
                </div>
                {pag.ticket_url && /^https:\/\//.test(pag.ticket_url) && (
                  <a href={pag.ticket_url} target="_blank" rel="noreferrer noopener" className="btn-primary inline-flex min-h-11 w-full justify-center text-xs">
                    <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir pagamento no Mercado Pago
                  </a>
                )}
                {/* Identificador REAL devolvido pelo provedor (Orders API); nunca fabricado. */}
                {pag.provider_order_id && (
                  <p className="break-all text-[11px] text-muted">
                    Order ID no provedor: <span className="font-mono">{pag.provider_order_id}</span>
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-muted">
                  Após pagar, o status é atualizado pelo webhook assinado do provider. Esta página consulta o servidor em intervalos controlados apenas como complemento.
                </p>
              </div>
            </div>
          </section>
        )}

        {!aguardando && (
          <div className={`rounded-2xl border p-5 ${pagoAprovado ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`} role="status">
            <p className="font-medium">{pagoAprovado ? 'Pagamento confirmado pelo processador.' : ROTULO_PAGAMENTO[pag.status] ?? pag.status}</p>
            <p className="mt-1 text-sm opacity-90">
              {pagoAprovado
                ? 'Seu pedido segue para preparação e entrega. O acompanhamento abaixo é atualizado pela equipe e pelo ERP.'
                : 'O pedido não foi concluído. Em caso de dúvida, entre em contato com a loja usando os dados do pedido.'}
            </p>
          </div>
        )}

        {visao.pagamento.engine_status === 'REQUIRES_ACTION' && pag.action?.url?.startsWith('https://') && (
          <a className="btn-primary inline-flex" href={pag.action.url} rel="noreferrer">Concluir pagamento em ambiente seguro</a>
        )}
        {visao.pagamento.engine_status === 'PENDING_MANUAL_CONFIRMATION' && <p className="text-sm">Aguardando confirmação manual por um responsável autorizado.</p>}

        <section className="rounded-2xl border border-line bg-surface p-6" aria-labelledby="titulo-itens">
          <h2 id="titulo-itens" className="text-sm font-semibold uppercase tracking-wider text-muted">Itens do pedido</h2>
          <ul className="mt-3 divide-y divide-line">
            {visao.itens.map((i) => (
              <li key={`${i.produto_id}-${i.tamanho}`} className="flex justify-between gap-3 py-3 text-sm">
                <span><span className="font-medium">{i.produto}</span>{i.tamanho ? <span className="text-muted"> · {i.tamanho}</span> : null} <span className="text-muted">× {i.quantidade}</span></span>
                <span className="shrink-0 font-medium tabular-nums">{precoLoja(i.subtotal)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Frete</dt><dd>{precoLoja(p?.frete ?? 0)}</dd></div>
            {!!p?.desconto && <div className="flex justify-between"><dt className="text-muted">Desconto {p.cupom ? `(${p.cupom})` : ''}</dt><dd>− {precoLoja(p.desconto)}</dd></div>}
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd>{precoLoja(p?.total ?? 0)}</dd></div>
          </dl>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-6" aria-labelledby="titulo-acompanhamento">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="titulo-acompanhamento" className="text-sm font-semibold uppercase tracking-wider text-muted">Acompanhamento</h2>
            <button type="button" className="btn-secondary min-h-10 text-xs" onClick={() => void carregar()} disabled={carregando}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar status
            </button>
          </div>
          <ol className="mt-4 space-y-3">
            {visao.timeline.map((ev, idx) => (
              <li key={`${ev.em}-${idx}`} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <div><span className="font-medium">{ev.rotulo}</span><span className="ml-2 text-xs text-muted">{dataHoraBR(ev.em)}</span></div>
              </li>
            ))}
            {!visao.timeline.length && <li className="text-sm text-muted">Sem movimentações registradas ainda.</li>}
          </ol>
          {visao.venda && (
            <p className="mt-4 text-xs text-muted">Venda ERP: <b>{visao.venda.numero}</b>{visao.venda.status ? ` · ${visao.venda.status}` : ''}</p>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-6" aria-labelledby="titulo-entrega">
          <h2 id="titulo-entrega" className="text-sm font-semibold uppercase tracking-wider text-muted">Entrega e rastreio</h2>
          {!visao.rastreio.length ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted"><PackageCheck className="h-4 w-4" aria-hidden="true" /> Sem código de rastreio ainda — o código aparece aqui quando a expedição for registrada.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {visao.rastreio.map((r, i) => (
                <li key={`${r.codigo}-${i}`} className="rounded-xl bg-canvas p-3 text-sm">
                  <div className="font-medium capitalize">{String(r.status ?? '').replace(/_/g, ' ') || '—'}</div>
                  <div className="mt-1 text-xs text-muted">{r.transportadora ?? '—'}{r.codigo ? ` · ${r.codigo}` : ''}{r.estimativa_em ? ` · previsão ${r.estimativa_em}` : ''}</div>
                  {r.url && /^https:\/\//.test(r.url) && <a className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline" href={r.url} target="_blank" rel="noreferrer noopener">Rastrear <ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <Link to="/loja" className="btn-secondary text-xs">Voltar para a loja</Link>
          <p className="text-xs text-muted">Guarda este link: ele é sua credencial de acompanhamento.</p>
        </div>
      </div>
    </LojaShell>
  );
}
