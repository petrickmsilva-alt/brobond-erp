// ============================================================================
// COMMERCE — DETALHE DO PEDIDO. Rota /commerce/pedidos/:saleId.
//
// Fonte única: GET /commerce/pedidos/:saleId (sales + projeção + venda
// operacional + cobrança + rastreio + linha do tempo derivada). Ações:
//   • converter — ponte canônica (409 honesto se item sem produto);
//   • cancelar — só antes da conversão/pagamento, com confirmação INLINE;
//   • rastreio — grava em commerce_rastreio (etapa de expedição continua no ERP).
// ZERO MODAL: tudo em seções desta página.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, RefreshCw, Truck } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, PageHeader, Spinner, useToast } from '../../components/ui';
import {
  EstadoBadge,
  ROTULO_PAGAMENTO,
  ROTULO_PEDIDO,
  ROTULO_RASTREIO,
  TONE_PAGAMENTO,
  TONE_PEDIDO,
  TONE_RASTREIO,
  dataHora,
  grana,
} from './shared';

type Visao = {
  sale_id: string;
  pedido: {
    id: number;
    canal: string;
    pedido_externo: string;
    estado: string;
    estado_rotulo: string;
    pagamento_estado: string | null;
    total: number;
    frete: number;
    desconto: number;
    cupom: string | null;
    comprador: { nome?: string | null; email?: string | null; telefone?: string | null } | null;
    endereco: Record<string, string | null> | null;
    expira_em: string | null;
    pago_em: string | null;
    convertido_em: string | null;
    erro: string | null;
    criado_em: string | null;
  } | null;
  pagamento: {
    status: string;
    provider: string | null;
    metodo: string | null;
    valor: number | null;
    qr_code: string | null;
    copia_cola: string | null;
    expira_em: string | null;
    provider_ref: string | null;
  };
  venda: { id: number; numero: string; status: string | null; faturada_em: string | null; expedicao_etapa: string | null; cliente_id: number | null } | null;
  itens: { produto_id: number; produto: string; tamanho: string | null; quantidade: number; preco_unitario: number; subtotal: number }[];
  rastreio: { transportadora: string | null; codigo: string | null; url: string | null; status: string | null; estimativa_em: string | null; atualizado_em: string | null }[];
  timeline: { em: string; rotulo: string }[];
};

const STATUS_RASTREIO = ['postado', 'em_transito', 'saiu_entrega', 'entregue', 'devolvido', 'extraviado'];

export default function CommercePedidoDetalhePage() {
  const { saleId } = useParams();
  const toast = useToast();
  const navigate = useNavigate();

  const [visao, setVisao] = useState<Visao | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [acao, setAcao] = useState<'converter' | 'cancelar' | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [confirmandoCancel, setConfirmandoCancel] = useState(false);

  const [rastreio, setRastreio] = useState({ transportadora: '', codigo: '', url: '', status: 'postado', estimativa_em: '' });
  const [salvandoRastreio, setSalvandoRastreio] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Visao>(`/commerce/pedidos/${encodeURIComponent(String(saleId))}`);
      setVisao(r);
      const atual = r.rastreio[0];
      setRastreio({
        transportadora: atual?.transportadora ?? '',
        codigo: atual?.codigo ?? '',
        url: atual?.url ?? '',
        status: atual?.status ?? 'postado',
        estimativa_em: atual?.estimativa_em ?? '',
      });
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Pedido não encontrado.');
    } finally {
      setCarregando(false);
    }
  }, [saleId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const converter = async () => {
    setConfirmando(true);
    setAcao('converter');
    setErro('');
    try {
      const r = await apiFetch<{ ok: boolean; estado: string; venda_id: number | null; pendencia?: string }>(
        `/commerce/pedidos/${encodeURIComponent(String(saleId))}/converter`,
        { method: 'POST' }
      );
      if (r.ok) toast.success(`Convertido em venda operacional #${r.venda_id}.`);
      else toast.info?.(r.pendencia ?? `Conversão pendente: ${r.estado}.`);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao converter o pedido.');
    } finally {
      setConfirmando(false);
      setAcao(null);
    }
  };

  const cancelar = async () => {
    setConfirmandoCancel(true);
    setAcao('cancelar');
    setErro('');
    try {
      await apiFetch(`/commerce/pedidos/${encodeURIComponent(String(saleId))}/cancelar`, {
        method: 'POST',
        body: JSON.stringify({ motivo: 'Cancelado pela tela de pedidos' }),
      });
      toast.success('Pedido cancelado — reservas e cupom liberados.');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao cancelar o pedido.');
    } finally {
      setConfirmandoCancel(false);
      setAcao(null);
    }
  };

  const salvarRastreio = async () => {
    setSalvandoRastreio(true);
    setErro('');
    try {
      await apiFetch(`/commerce/pedidos/${encodeURIComponent(String(saleId))}/rastreio`, {
        method: 'POST',
        body: JSON.stringify({
          transportadora: rastreio.transportadora || null,
          codigo: rastreio.codigo || null,
          url: rastreio.url || null,
          status: rastreio.status,
          estimativa_em: rastreio.estimativa_em || null,
        }),
      });
      toast.success('Rastreio salvo.');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar o rastreio.');
    } finally {
      setSalvandoRastreio(false);
    }
  };

  if (carregando) return <Spinner label="Carregando pedido…" />;
  if (!visao) {
    return (
      <div className="space-y-4">
        <Alert tone="red">{erro || 'Pedido não encontrado.'}</Alert>
        <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/pedidos')}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Voltar aos pedidos
        </button>
      </div>
    );
  }

  const p = visao.pedido;
  const estado = p?.estado ?? 'AGUARDANDO_PAGAMENTO';
  const convertido = estado === 'CONVERTIDO' || estado === 'ESTORNADO' || !!visao.venda;
  const bloqueadoPAGAMENTO = ['PAGO', 'PAGAMENTO_AUTORIZADO'].includes(estado) && !convertido;
  const terminado = ['CANCELADO', 'EXPIRADO'].includes(estado);
  const podeConverter = !!p && !convertido && estado !== 'AGUARDANDO_PAGAMENTO';
  const podeCancelar = !!p && !convertido && !bloqueadoPAGAMENTO && !terminado;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p?.pedido_externo || visao.sale_id.slice(0, 12)}
            <EstadoBadge estado={estado} mapa={TONE_PEDIDO} rotulos={ROTULO_PEDIDO} />
          </span>
        }
        description={`Venda analítica ${visao.sale_id} · canal ${p?.canal ?? '—'} · recebido ${dataHora(p?.criado_em ?? null)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/pedidos')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Pedidos
            </button>
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
          </div>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      {/* Ações */}
      {(podeConverter || podeCancelar) && (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4" aria-label="Ações do pedido">
          {podeConverter && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-primary" disabled={confirmando} onClick={() => void converter()}>
                {confirmando && acao === 'converter' ? 'Convertendo…' : 'Converter em venda'}
              </button>
              <ConfirmacaoInline
                open={confirmando && acao === 'converter'}
                title="Conversão em andamento"
                message="A ponte valida itens, reservas e faturamento — não feche a página."
                confirmLabel="Entendi"
                busy={confirmando}
                onCancel={() => setConfirmando(false)}
                onConfirm={() => setConfirmando(false)}
              />
            </div>
          )}
          {podeCancelar && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-danger" onClick={() => setAcao('cancelar')}>
                Cancelar pedido
              </button>
              <ConfirmacaoInline
                open={acao === 'cancelar'}
                title="Cancelar este pedido?"
                message="Reservas de estoque e o uso de cupom voltam a ficar disponíveis. O cancelamento fica na trilha de auditoria."
                confirmLabel="Sim, cancelar"
                danger
                busy={confirmandoCancel}
                onCancel={() => setAcao(null)}
                onConfirm={() => void cancelar()}
              />
            </div>
          )}
          {bloqueadoPAGAMENTO && (
            <p className="text-sm text-muted">
              Pagamento reconhecido: o estorno (quando for o caso) acontece em Financeiro → Gateway e se propaga para o
              pedido.
            </p>
          )}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Pagamento */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="pagamento">
          <h2 id="pagamento" className="text-sm font-semibold uppercase tracking-wide text-muted">Pagamento</h2>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">Status</span>
              <Badge tone={TONE_PAGAMENTO[visao.pagamento.status] ?? 'slate'}>
                {ROTULO_PAGAMENTO[visao.pagamento.status] ?? visao.pagamento.status}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">Provedor</span>
              <span>{visao.pagamento.provider ?? '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">Valor cobrado</span>
              <span className="tabular-nums">{grana(visao.pagamento.valor ?? p?.total ?? null)}</span>
            </div>
            {p?.pago_em && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Confirmado em</span>
                <span>{dataHora(p.pago_em)}</span>
              </div>
            )}
            {p?.expira_em && !p.pago_em && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Expira em</span>
                <span className="text-warning">{dataHora(p.expira_em)}</span>
              </div>
            )}
            {visao.pagamento.copia_cola && (
              <div className="pt-2">
                <div className="text-xs text-muted">PIX copia e cola</div>
                <div className="mt-1 flex items-start gap-2">
                  <code className="block max-h-20 flex-1 overflow-auto rounded bg-canvas p-2 text-xs break-all">{visao.pagamento.copia_cola}</code>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(visao.pagamento.copia_cola ?? '');
                      toast.success('Código PIX copiado.');
                    }}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" /> Copiar
                  </button>
                </div>
              </div>
            )}
            {p?.erro && <Alert tone="amber">{p.erro}</Alert>}
          </div>
        </section>

        {/* Cliente e entrega */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="cliente">
          <h2 id="cliente" className="text-sm font-semibold uppercase tracking-wide text-muted">Cliente e entrega</h2>
          <div className="mt-3 space-y-1 text-sm">
            <div className="font-medium">{p?.comprador?.nome ?? '—'}</div>
            <div className="text-muted">{p?.comprador?.email ?? ''}</div>
            {p?.comprador?.telefone && <div className="text-muted">{p.comprador.telefone}</div>}
            {p?.endereco ? (
              <address className="mt-2 not-italic text-ink-soft">
                {p.endereco.rua}, {p.endereco.numero}
                {p.endereco.complemento ? ` — ${p.endereco.complemento}` : ''}
                <br />
                {p.endereco.bairro} · {p.endereco.cidade}/{p.endereco.uf}
                <br />
                CEP {p.endereco.cep || '—'}
              </address>
            ) : (
              <div className="mt-2 text-muted">Retirada na loja (sem endereço de entrega).</div>
            )}
            <div className="mt-3 flex gap-4 text-sm">
              <span className="text-muted">Frete <b className="ml-1 text-ink">{grana(p?.frete ?? 0)}</b></span>
              <span className="text-muted">Desconto <b className="ml-1 text-ink">{grana(p?.desconto ?? 0)}</b></span>
              {p?.cupom && <Badge tone="blue">Cupom {p.cupom}</Badge>}
            </div>
          </div>
        </section>

        {/* Venda operacional */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="venda-op">
          <h2 id="venda-op" className="text-sm font-semibold uppercase tracking-wide text-muted">Venda operacional</h2>
          {visao.venda ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Venda</span>
                <Link className="font-medium text-primary hover:underline" to={`/vendas/${visao.venda.id}`}>
                  #{visao.venda.numero}
                </Link>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Status</span>
                <Badge tone={visao.venda.status === 'faturada' ? 'green' : 'blue'}>{visao.venda.status ?? '—'}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Etapa de expedição</span>
                <span>{visao.venda.expedicao_etapa ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Faturada em</span>
                <span>{dataHora(visao.venda.faturada_em)}</span>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Ainda não convertida — a conversão usa a ponte sales → vendas e acontece após o pagamento confirmado do
              checkout da loja própria.
            </p>
          )}
          {p?.convertido_em && <p className="mt-2 text-xs text-muted">Convertido em {dataHora(p.convertido_em)}</p>}
        </section>
      </div>

      {/* Itens */}
      <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="itens">
        <h2 id="itens" className="text-sm font-semibold uppercase tracking-wide text-muted">Itens</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <caption className="sr-only">Itens do pedido</caption>
            <thead>
              <tr>
                <th scope="col">Produto</th>
                <th scope="col">Tamanho</th>
                <th scope="col" className="text-right">Qtd</th>
                <th scope="col" className="text-right">Unitário</th>
                <th scope="col" className="text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {visao.itens.map((i, idx) => (
                <tr key={`${i.produto_id}-${idx}`}>
                  <td>
                    <Link className="hover:text-primary hover:underline" to={`/produtos/${i.produto_id}`}>
                      {i.produto}
                    </Link>
                  </td>
                  <td>{i.tamanho ?? '—'}</td>
                  <td className="text-right tabular-nums">{i.quantidade}</td>
                  <td className="text-right tabular-nums">{grana(i.preco_unitario)}</td>
                  <td className="text-right tabular-nums">{grana(i.subtotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="text-right font-medium">Total do pedido</td>
                <td className="text-right font-semibold tabular-nums">{grana(p?.total ?? null)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Linha do tempo */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="timeline">
          <h2 id="timeline" className="text-sm font-semibold uppercase tracking-wide text-muted">Linha do tempo</h2>
          <ol className="mt-3 space-y-3">
            {visao.timeline.length === 0 && <li className="text-sm text-muted">Sem eventos registrados.</li>}
            {visao.timeline.map((ev, idx) => (
              <li key={`${ev.em}-${idx}`} className="flex items-baseline gap-3 text-sm">
                <span className="tabular-nums text-muted">{dataHora(ev.em)}</span>
                <span className="font-medium">{ev.rotulo}</span>
              </li>
            ))}
          </ol>
          {visao.rastreio.length > 0 && (
            <ul className="mt-4 space-y-2 border-t border-line pt-3">
              {visao.rastreio.map((r, idx) => (
                <li key={idx} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={TONE_RASTREIO[r.status ?? ''] ?? 'slate'}>{ROTULO_RASTREIO[r.status ?? ''] ?? r.status}</Badge>
                  <span className="text-muted">{r.transportadora ?? '—'}</span>
                  <span className="font-mono text-xs">{r.codigo ?? ''}</span>
                  {r.url && (
                    <a className="text-primary hover:underline" href={r.url} target="_blank" rel="noreferrer">
                      rastrear
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Rastreio (escrita) */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="rastreio">
          <h2 id="rastreio" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Truck className="h-4 w-4" aria-hidden="true" /> Rastreio da entrega
          </h2>
          {visao.venda ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-ink-soft">Transportadora</span>
                <input className="input mt-1" value={rastreio.transportadora} onChange={(e) => setRastreio((r) => ({ ...r, transportadora: e.target.value }))} maxLength={80} />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Código de rastreio</span>
                <input className="input mt-1 font-mono" value={rastreio.codigo} onChange={(e) => setRastreio((r) => ({ ...r, codigo: e.target.value }))} maxLength={80} />
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Status</span>
                <select className="input mt-1" value={rastreio.status} onChange={(e) => setRastreio((r) => ({ ...r, status: e.target.value }))}>
                  {STATUS_RASTREIO.map((s) => (
                    <option key={s} value={s}>
                      {ROTULO_RASTREIO[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Entrega estimada</span>
                <input type="date" className="input mt-1" value={rastreio.estimativa_em} onChange={(e) => setRastreio((r) => ({ ...r, estimativa_em: e.target.value }))} />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="text-ink-soft">URL de rastreio</span>
                <input type="url" className="input mt-1" value={rastreio.url} onChange={(e) => setRastreio((r) => ({ ...r, url: e.target.value }))} placeholder="https://…" maxLength={300} />
              </label>
              <div className="sm:col-span-2">
                <button type="button" className="btn-primary" disabled={salvandoRastreio} onClick={() => void salvarRastreio()}>
                  {salvandoRastreio ? 'Salvando…' : 'Salvar rastreio'}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Pedido ainda não convertido em venda — não há entrega para rastrear.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
