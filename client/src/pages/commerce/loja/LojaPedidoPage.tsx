// ============================================================================
// BROBOND STORE — ACOMPANHAMENTO DO PEDIDO. Rota /loja/pedido/:token.
//
// O token aleatório (256 bits) é a credencial: sem ele a rota responde 404
// idêntico ao pedido inexistente (nunca confirma existência alheia).
//
// PIX: QR Code (imagem base64), Copia e Cola e link de pagamento vêm
// EXCLUSIVAMENTE do que o provedor devolveu e o backend persistiu, cada um no
// seu campo. Nenhum QR é gerado no navegador e nenhum QR é montado a partir
// do texto. Sem imagem do provedor, a tela usa o Copia e Cola/link reais.
//
// Confirmação: o webhook assinado do provedor é a fonte primária. Esta página
// faz polling CONTROLADO (12 s, uma requisição por vez, AbortController,
// backoff em erro, pausa com aba oculta) e para nos estados finais. Abrir ou
// renderizar esta página JAMAIS marca o pedido como pago.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Copy, ExternalLink, MessageCircle, PackageCheck, RefreshCw, ShieldCheck } from 'lucide-react';
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
    metodo?: string | null;
    valor: number | null;
    copia_cola: string | null;
    qr_code_base64?: string | null;
    ticket_url?: string | null;
    redirect_url?: string | null;
    confirmacao_manual?: boolean;
    expira_em: string | null;
  };
  venda: { id: number; numero: string; status: string | null; faturada_em: string | null; expedicao_etapa: string | null } | null;
  itens: { produto_id: number; produto: string; tamanho: string | null; quantidade: number; preco_unitario: number; subtotal: number }[];
  rastreio: { transportadora: string | null; codigo: string | null; url: string | null; status: string | null; estimativa_em: string | null }[];
  timeline: { em: string; rotulo: string }[];
};

/** Estados do PEDIDO em que o acompanhamento automático termina. */
const ESTADOS_FINAIS = new Set(['PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO', 'CANCELADO', 'EXPIRADO', 'ESTORNADO', 'ERRO']);
const ESTADOS_PAGOS = new Set(['PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO']);
/** Pagamento que já não aceita PIX (mesmo se o pedido ainda não refletiu). */
const PAGAMENTO_ENCERRADO = new Set(['APPROVED', 'AUTHORIZED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'EXPIRED', 'ERROR']);

export const INTERVALO_POLLING_MS = 12_000;
const INTERVALO_MAXIMO_MS = 60_000;
/** Teto de consultas automáticas (~80 min a 12 s); depois só o botão. */
const LIMITE_CONSULTAS = 400;

const PROVEDOR_NOME: Record<string, string> = { mercadopago: 'Mercado Pago', MERCADO_PAGO: 'Mercado Pago', pagbank: 'PagBank', stripe: 'Stripe' };

/** Apenas base64 de IMAGEM real (PNG/JPEG/GIF/WEBP) — jamais o texto EMV. */
function imagemQrSegura(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const limpo = valor.replace(/\s/g, '');
  if (limpo.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(limpo)) return null;
  const mime = limpo.startsWith('iVBORw0KGgo') ? 'image/png'
    : limpo.startsWith('/9j/') ? 'image/jpeg'
      : limpo.startsWith('R0lGOD') ? 'image/gif'
        : limpo.startsWith('UklGR') ? 'image/webp' : null;
  return mime ? `data:${mime};base64,${limpo}` : null;
}

function dataHoraBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function minutosRestantes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 60_000));
}

type Desfecho = { titulo: string; texto: string; tom: 'ok' | 'alerta' };
function desfechoDoPedido(estado: string): Desfecho | null {
  if (ESTADOS_PAGOS.has(estado)) return { titulo: 'PAGAMENTO CONFIRMADO', texto: 'Recebemos a confirmação do pagamento. Seu pedido segue para separação e envio.', tom: 'ok' };
  if (estado === 'EXPIRADO') return { titulo: 'PEDIDO EXPIRADO', texto: 'O prazo de pagamento terminou. Nenhum valor foi cobrado e os itens voltaram ao estoque. Faça um novo pedido se ainda quiser os produtos.', tom: 'alerta' };
  if (estado === 'CANCELADO') return { titulo: 'PEDIDO CANCELADO', texto: 'Este pedido foi cancelado. Se o pagamento não foi aprovado, nenhum valor foi cobrado.', tom: 'alerta' };
  if (estado === 'ESTORNADO') return { titulo: 'PAGAMENTO ESTORNADO', texto: 'O valor deste pedido foi estornado. O prazo de devolução depende do seu banco.', tom: 'alerta' };
  if (estado === 'ERRO') return { titulo: 'PEDIDO NÃO CONFIRMADO', texto: 'Não foi possível concluir este pedido e nenhuma cobrança foi confirmada. Faça um novo pedido ou fale com a loja.', tom: 'alerta' };
  return null;
}

export default function LojaPedidoPage() {
  const { token } = useParams();
  const [visao, setVisao] = useState<Visao | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const [copiado, setCopiado] = useState<'ok' | 'falhou' | null>(null);
  const emVoo = useRef<AbortController | null>(null);
  const montado = useRef(true);
  const campoCopia = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
      emVoo.current?.abort();
    };
  }, []);

  /**
   * Uma requisição por vez. `automatica`: nunca empilha (se já há uma em voo,
   * não dispara outra). Manual/inicial: substitui a anterior.
   * Retorna `true` quando a consulta teve resposta.
   */
  const consultar = useCallback(async (modo: 'inicial' | 'automatica' | 'manual'): Promise<boolean> => {
    if (modo === 'automatica' && emVoo.current) return true;
    emVoo.current?.abort();
    const controller = new AbortController();
    emVoo.current = controller;
    if (modo === 'inicial') { setCarregando(true); setErro(''); }
    if (modo === 'manual') setAtualizando(true);
    try {
      const r = await apiFetch<Visao>(`/loja/pedidos/${encodeURIComponent(String(token))}`, { signal: controller.signal });
      if (!controller.signal.aborted && montado.current) { setVisao(r); setErro(''); }
      return true;
    } catch (e) {
      if (!controller.signal.aborted && montado.current && modo !== 'automatica') {
        setErro(e instanceof ApiError ? e.message : 'Não foi possível consultar o pedido agora.');
      }
      return false;
    } finally {
      if (emVoo.current === controller) emVoo.current = null;
      if (montado.current && !controller.signal.aborted) {
        if (modo === 'inicial') setCarregando(false);
        if (modo === 'manual') setAtualizando(false);
      }
    }
  }, [token]);

  useEffect(() => { void consultar('inicial'); }, [consultar]);

  const estadoPedido = visao?.pedido?.estado ?? '';
  const carregado = !!visao;
  const finalizado = carregado && ESTADOS_FINAIS.has(estadoPedido);

  // Polling controlado: só enquanto o pedido não chegou a um estado final.
  // Re-executa apenas quando "finalizado" muda — não a cada resposta.
  useEffect(() => {
    if (!carregado || finalizado) return;
    let timer: number | undefined;
    let cancelado = false;
    let atraso = INTERVALO_POLLING_MS;
    let consultas = 0;
    const agendar = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void ciclo(), ms);
    };
    const ciclo = async () => {
      if (cancelado || document.hidden || consultas >= LIMITE_CONSULTAS) return; // aba oculta: retoma no visibilitychange
      consultas += 1;
      const ok = await consultar('automatica');
      if (cancelado) return;
      atraso = ok ? INTERVALO_POLLING_MS : Math.min(atraso * 2, INTERVALO_MAXIMO_MS);
      agendar(atraso);
    };
    const aoMudarVisibilidade = () => {
      if (!document.hidden && !cancelado) agendar(0);
      else window.clearTimeout(timer);
    };
    agendar(INTERVALO_POLLING_MS);
    document.addEventListener('visibilitychange', aoMudarVisibilidade);
    return () => {
      cancelado = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
    };
  }, [carregado, finalizado, consultar]);

  const copiar = async () => {
    const codigo = visao?.pagamento.copia_cola;
    if (!codigo) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(codigo);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok && campoCopia.current) {
      // Fallback: seleciona o campo para o cliente copiar manualmente.
      campoCopia.current.focus();
      campoCopia.current.select();
      try { ok = document.execCommand?.('copy') ?? false; } catch { ok = false; }
    }
    setCopiado(ok ? 'ok' : 'falhou');
    window.setTimeout(() => { if (montado.current) setCopiado(null); }, 3000);
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
  const desfecho = desfechoDoPedido(estadoPedido);
  const aguardandoPix = !desfecho && !PAGAMENTO_ENCERRADO.has(pag.status) && (pag.metodo ? pag.metodo === 'pix' : true);
  const qr = imagemQrSegura(pag.qr_code_base64);
  const ticket = pag.ticket_url && /^https:\/\//i.test(pag.ticket_url) ? pag.ticket_url : null;
  const temInstrumento = !!(qr || pag.copia_cola || ticket);
  const expiraEm = pag.expira_em ?? p?.expira_em ?? null;
  const restante = minutosRestantes(expiraEm);
  const valor = p?.total ?? pag.valor ?? 0;
  const provedor = pag.provider ? PROVEDOR_NOME[pag.provider] ?? 'provedor de pagamento' : 'Mercado Pago';
  const comprador = p?.comprador;
  const chamada = desfecho ? (desfecho.tom === 'ok' ? 'PAGAMENTO CONFIRMADO' : desfecho.titulo) : 'PEDIDO RECEBIDO';

  return (
    <LojaShell tituloDocumento={`Pedido ${p?.pedido_externo ?? ''}`}>
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className={`flex h-10 w-10 items-center justify-center rounded-full ${desfecho?.tom === 'ok' ? 'bg-emerald-100' : 'bg-navy-50'}`}>
                {desfecho?.tom === 'ok' ? <PackageCheck className="h-5 w-5 text-emerald-700" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5 text-navy-700" aria-hidden="true" />}
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{chamada}</p>
                <h1 className="text-xl font-semibold sm:text-2xl">Pedido #{p?.pedido_externo ?? '—'}</h1>
                <p className="text-sm text-muted">Recebido em {dataHoraBR(p?.criado_em)}</p>
              </div>
            </div>
            <span className="rounded-full bg-navy-50 px-3 py-1 text-sm font-medium text-navy-700">{p?.estado_rotulo ?? '—'}</span>
          </div>
        </header>

        {desfecho && (
          <div
            className={`rounded-2xl border p-5 ${desfecho.tom === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
            role="status"
            aria-live="polite"
          >
            {desfecho.tom === 'ok' && (
              <p className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> Seu pedido foi confirmado!
              </p>
            )}
            <p className={desfecho.tom === 'ok' ? 'mt-1 text-sm opacity-90' : 'text-sm'}>{desfecho.texto}</p>
          </div>
        )}

        {pag.redirect_url && /^https:\/\//i.test(pag.redirect_url) && !desfecho && (
          <a className="btn-primary inline-flex min-h-12 w-full justify-center sm:w-auto" href={pag.redirect_url} rel="noreferrer noopener">
            Concluir pagamento em ambiente seguro
          </a>
        )}
        {pag.confirmacao_manual && !desfecho && (
          <p className="rounded-2xl border border-line bg-surface p-4 text-sm">Aguardando confirmação manual por um responsável autorizado.</p>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
          {/* PIX — no celular vem logo após o cabeçalho (Pedido → Valor → QR →
              Copiar → Abrir provedor → Status); no desktop fica à direita. */}
          {aguardandoPix && (
            <section className="order-1 rounded-2xl border border-line bg-surface p-5 sm:p-6 lg:order-2" aria-labelledby="titulo-pix">
              <h2 id="titulo-pix" className="text-sm font-semibold uppercase tracking-wider text-muted">Pagamento via PIX</h2>
              <p className="mt-1 text-3xl font-bold tabular-nums" aria-label={`Valor a pagar ${precoLoja(valor)}`}>{precoLoja(valor)}</p>

              {temInstrumento ? (
                <div className="mt-5 space-y-4">
                  {qr ? (
                    <figure className="flex flex-col items-center gap-2">
                      <img src={qr} alt={`QR Code PIX do pedido ${p?.pedido_externo ?? ''}`} width={256} height={256} loading="eager" decoding="async"
                        className="h-60 w-60 rounded-xl border border-line bg-white p-2 sm:h-64 sm:w-64" />
                      <figcaption className="text-center text-sm text-muted">Escaneie o QR Code pelo aplicativo do seu banco</figcaption>
                    </figure>
                  ) : (
                    <p className="rounded-xl border border-dashed border-line bg-canvas p-3 text-center text-sm text-muted">
                      O {provedor} não enviou a imagem do QR Code para este pagamento. Use o PIX Copia e Cola{ticket ? ' ou abra o pagamento' : ''} abaixo.
                    </p>
                  )}

                  {pag.copia_cola && (
                    <div>
                      <label htmlFor="pix-copia-cola" className="text-xs font-semibold uppercase tracking-wider text-muted">PIX COPIA E COLA</label>
                      <textarea
                        id="pix-copia-cola"
                        ref={campoCopia}
                        readOnly
                        rows={3}
                        value={pag.copia_cola}
                        onFocus={(e) => e.currentTarget.select()}
                        className="input mt-1 w-full resize-none break-all font-mono text-xs"
                        spellCheck={false}
                      />
                      <button type="button" onClick={() => void copiar()} className="btn-primary mt-2 min-h-12 w-full text-sm font-semibold">
                        <Copy className="h-4 w-4" aria-hidden="true" /> {copiado === 'ok' ? 'CÓDIGO COPIADO' : 'COPIAR CÓDIGO'}
                      </button>
                      <p className="mt-1 min-h-4 text-xs text-muted" aria-live="polite">
                        {copiado === 'ok' ? 'Código copiado. Cole na área PIX do app do seu banco.' : copiado === 'falhou' ? 'Não foi possível copiar automaticamente: selecione o código acima e copie.' : ''}
                      </p>
                    </div>
                  )}

                  {ticket && (
                    <a href={ticket} target="_blank" rel="noreferrer noopener" className="btn-secondary inline-flex min-h-12 w-full justify-center text-sm font-semibold">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> {provedor === 'Mercado Pago' ? 'ABRIR PAGAMENTO DO MERCADO PAGO' : 'ABRIR PAGAMENTO'}
                    </a>
                  )}
                </div>
              ) : (
                <p className="mt-4 rounded-xl border border-dashed border-line bg-canvas p-3 text-sm text-muted">
                  Os dados do PIX ainda não foram disponibilizados pelo {provedor}. Esta página consulta novamente em instantes.
                </p>
              )}

              <div className="mt-5 rounded-xl bg-canvas p-4" role="status" aria-live="polite">
                <p className="font-semibold">Pagamento aguardando confirmação</p>
                <p className="mt-1 text-sm text-muted">O pedido será confirmado automaticamente após a aprovação do pagamento.</p>
                {expiraEm && (
                  <p className="mt-2 text-sm">
                    Pague até <b>{dataHoraBR(expiraEm)}</b>{restante != null && restante > 0 ? ` (cerca de ${restante} min)` : ''}.
                  </p>
                )}
              </div>
            </section>
          )}

          <section className="order-2 rounded-2xl border border-line bg-surface p-5 sm:p-6 lg:order-1" aria-labelledby="titulo-itens">
            <h2 id="titulo-itens" className="text-sm font-semibold uppercase tracking-wider text-muted">Resumo do pedido</h2>
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
              <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd className="tabular-nums">{precoLoja(p?.total ?? 0)}</dd></div>
            </dl>
            {comprador && (comprador.email || comprador.whatsapp) && (
              <div className="mt-4 rounded-xl border border-line bg-canvas p-3 text-sm">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Atualizações do pedido</h3>
                <p className="mt-2 text-xs text-muted">Enviaremos a confirmação do pedido, do pagamento e o rastreio para os contatos abaixo.</p>
                {comprador.email && <p className="mt-1 break-all">{comprador.email}</p>}
                {comprador.whatsapp && <p className="mt-0.5 flex items-center gap-1.5"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> WhatsApp: {comprador.whatsapp}</p>}
                <p className="mt-1 text-[11px] text-muted">Dados mascarados para sua privacidade.</p>
              </div>
            )}
          </section>
        </div>

        <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="titulo-acompanhamento">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="titulo-acompanhamento" className="text-sm font-semibold uppercase tracking-wider text-muted">Acompanhamento</h2>
            <button type="button" className="btn-secondary min-h-11 text-xs" onClick={() => void consultar('manual')} disabled={atualizando} aria-busy={atualizando}>
              <RefreshCw className={`h-4 w-4 ${atualizando ? 'animate-spin' : ''}`} aria-hidden="true" /> {atualizando ? 'Atualizando…' : 'Atualizar status'}
            </button>
          </div>
          {erro && <p className="mt-2 text-xs text-amber-800" role="alert">{erro}</p>}
          <ol className="mt-4 space-y-3">
            {visao.timeline.map((ev, idx) => (
              <li key={`${ev.em}-${idx}`} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <div><span className="font-medium">{ev.rotulo}</span><span className="ml-2 text-xs text-muted">{dataHoraBR(ev.em)}</span></div>
              </li>
            ))}
            {!visao.timeline.length && <li className="text-sm text-muted">Sem movimentações registradas ainda.</li>}
          </ol>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6" aria-labelledby="titulo-entrega">
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
          <p className="text-xs text-muted">Guarde este link: ele é sua credencial de acompanhamento.</p>
        </div>
      </div>
    </LojaShell>
  );
}
