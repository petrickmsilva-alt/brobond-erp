import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronRight, Clock, FileText, Package, Printer, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';
import { Logo } from '../components/Logo';

type Pedido = { id: number; data: string; status: string; status_label: string; total: number; previsao_entrega: string | null; condicao_pagamento: string | null };
type Lista = { cliente: { nome: string; email: string | null }; acesso_seguro: boolean; pedidos: Pedido[] };
type Detalhe = Pedido & { frete: number; desconto: number; observacoes: string | null; pode_decidir: boolean; documentos: { tipo: string; referencia: string }[]; itens: { produto: string; sku: string; tamanho: string; quantidade: number; preco_unitario: number; subtotal: number; foto: string | null }[]; decisoes: { decisao: string; responsavel: string; mensagem: string | null; criado_em: string }[] };
type Decisao = 'aceitar' | 'recusar' | 'alteracao';

// Tokens identificam contextos distintos; trocar de link desmonta o estado anterior.
export default function PortalCliente() {
  const { token } = useParams();
  return <PortalClienteConteudo key={token} />;
}

function PortalClienteConteudo() {
  const { token, '*': subpath = '' } = useParams();
  const navigate = useNavigate();
  const base = `/portal/${encodeURIComponent(token ?? '')}`;
  const pedidoMatch = /^pedido\/(\d+)\/?$/.exec(subpath);
  const pedidoId = pedidoMatch ? Number(pedidoMatch[1]) : null;
  const [data, setData] = useState<Lista | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [busy, setBusy] = useState(false);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [responsavel, setResponsavel] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [confirmacao, setConfirmacao] = useState<Decisao | 'recomprar' | null>(null);

  const carregar = useCallback(async () => {
    setErro('');
    try {
      setData(await api.get<Lista>(`/portal/${encodeURIComponent(token ?? '')}/pedidos`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Portal indisponível.');
    }
  }, [token]);
  useEffect(() => { void carregar(); }, [carregar]);
  useEffect(() => {
    let cancelado = false;
    setDetalhe(null);
    setConfirmacao(null);
    setErro('');
    if (pedidoId === null) { setCarregandoDetalhe(false); return; }
    setCarregandoDetalhe(true);
    api.get<Detalhe>(`/portal/${encodeURIComponent(token ?? '')}/pedido/${pedidoId}`)
      .then((d) => { if (!cancelado) setDetalhe(d); })
      .catch((e: unknown) => { if (!cancelado) setErro(e instanceof ApiError ? e.message : 'Pedido indisponível.'); })
      .finally(() => { if (!cancelado) setCarregandoDetalhe(false); });
    return () => { cancelado = true; };
  }, [token, pedidoId]);

  async function recomprar() {
    if (!detalhe) return;
    setBusy(true); setErro('');
    try {
      const d = await api.post<{ mensagem: string }>(`/portal/${encodeURIComponent(token ?? '')}/pedido/${detalhe.id}/recomprar`, {});
      setAviso(d.mensagem); setConfirmacao(null); navigate(base); await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível solicitar a recompra.');
    } finally { setBusy(false); }
  }
  async function decidir(decisao: Decisao) {
    if (!detalhe || responsavel.trim().length < 2) { setErro('Informe o nome do responsável pela decisão.'); return; }
    if (decisao !== 'aceitar' && !mensagem.trim()) { setErro('Descreva o motivo ou a alteração desejada.'); return; }
    setBusy(true); setErro('');
    try {
      await api.post(`/portal/${encodeURIComponent(token ?? '')}/pedido/${detalhe.id}/decisao`, { decisao, responsavel, mensagem });
      setAviso('Decisão registrada.'); setMensagem(''); setConfirmacao(null); navigate(base); await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível registrar a decisão.');
    } finally { setBusy(false); }
  }

  if (erro && !data) return <Estado titulo="Não foi possível acessar o portal" texto={erro} />;
  if (!data) return <Estado titulo="Carregando seu portal" texto="Aguarde um instante..." />;
  const lista = !subpath;
  return <div className="min-h-full bg-slate-50">
    <header className="bg-navy-900 px-5 py-7 text-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
        <div><Logo variant="light" height={34} /><h1 className="mt-4 text-xl font-bold">Olá, {data.cliente.nome}</h1><p className="text-sm text-navy-300">Acompanhe propostas e pedidos em um ambiente seguro.</p></div>
        <button className="rounded-lg p-2 text-navy-200 hover:bg-white/10" onClick={() => void carregar()} aria-label="Atualizar"><RefreshCw className={`h-5 w-5 ${busy ? 'animate-spin' : ''}`} /></button>
      </div>
    </header>
    <main className="mx-auto max-w-5xl px-4 py-6">
      {erro && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{erro}</p>}
      {aviso && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{aviso}</p>}
      {lista ? <>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3"><Resumo label="Pedidos e propostas" valor={data.pedidos.length} icon={<Package />} /><Resumo label="Aguardando decisão" valor={data.pedidos.filter((p) => p.status === 'cotacao').length} icon={<Clock />} /><Resumo label="Concluídos" valor={data.pedidos.filter((p) => ['faturada','entregue'].includes(p.status)).length} icon={<CheckCircle2 />} /></div>
        <section className="card overflow-hidden !p-0">
          <div className="border-b border-slate-200 px-5 py-3"><h2 className="font-bold text-navy-900">Histórico comercial</h2></div>
          {!data.pedidos.length ? <p className="py-12 text-center text-sm text-slate-400">Nenhum pedido encontrado.</p> : <ul className="divide-y divide-slate-100">{data.pedidos.map((p) => <li key={p.id}>
            <Link className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-50" to={`${base}/pedido/${p.id}`} onClick={() => setAviso('')}>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-50 text-navy-600"><FileText className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><b className="text-sm text-navy-900">Pedido #{p.id}</b><span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{p.status_label}</span><span className="mt-1 block text-xs text-slate-400">{formatDate(p.data)}{p.condicao_pagamento ? ` · ${p.condicao_pagamento}` : ''}</span></span>
              <b className="text-sm tabular-nums text-navy-900">{formatMoney(p.total)}</b><ChevronRight className="h-4 w-4 text-slate-300" />
            </Link>
          </li>)}</ul>}
        </section>
        <p className="mt-6 text-center text-[11px] text-slate-400">Link pessoal e revogável · não encaminhe a terceiros</p>
      </> : <>
        <Link className="btn-secondary mb-4" to={base}>Voltar ao histórico</Link>
        {carregandoDetalhe && <p role="status">Carregando pedido...</p>}
        {!carregandoDetalhe && !detalhe && !erro && <p>Pedido não encontrado.</p>}
        {detalhe && <section className="card max-w-3xl !p-0">
          <div className="border-b p-5"><h2 className="text-lg font-bold text-navy-900">Pedido #{detalhe.id}</h2><p className="text-xs text-slate-400">{detalhe.status_label} · {formatDate(detalhe.data)}</p></div>
          <div className="space-y-4 p-5">
            <div className="space-y-2">{detalhe.itens.map((i, n) => <div key={n} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 p-3"><div><p className="text-sm font-semibold text-navy-900">{i.produto}</p><p className="text-xs text-slate-400">{i.sku} · Tam. {i.tamanho} · {i.quantidade} × {formatMoney(i.preco_unitario)}</p></div><b className="text-sm">{formatMoney(i.subtotal)}</b></div>)}</div>
            <div className="flex justify-between rounded-lg bg-slate-50 p-3"><span>Total</span><b className="text-lg">{formatMoney(detalhe.total)}</b></div>
            <div className="flex flex-wrap gap-2"><button className="btn-secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Imprimir / salvar PDF</button>{detalhe.documentos.map((d, i) => <span key={i} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"><b>{d.tipo}:</b> {d.referencia}</span>)}</div>
            {['aberta','faturada','entregue'].includes(detalhe.status) && <button className="btn-secondary w-full justify-center" disabled={busy} onClick={() => setConfirmacao('recomprar')}><RotateCcw className="h-4 w-4" /> Repetir este pedido com preços atuais</button>}
            {detalhe.pode_decidir && <div className="rounded-xl border border-navy-100 bg-navy-50/40 p-4">
              <h3 className="font-bold text-navy-900">Responder à proposta</h3>
              <label className="mt-3 block text-sm font-medium">Nome do responsável *<input className="input mt-1" value={responsavel} onChange={(e) => setResponsavel(e.target.value)} /></label>
              <label className="mt-2 block text-sm font-medium">Mensagem, motivo da recusa ou alteração desejada<textarea className="input mt-1" rows={3} value={mensagem} onChange={(e) => setMensagem(e.target.value)} /></label>
              <div className="mt-3 flex flex-wrap gap-2"><button className="btn-accent" disabled={busy} onClick={() => setConfirmacao('aceitar')}><CheckCircle2 className="h-4 w-4" /> Aceitar proposta</button><button className="btn-secondary" disabled={busy} onClick={() => setConfirmacao('alteracao')}><RotateCcw className="h-4 w-4" /> Pedir alteração</button><button className="btn-secondary !text-red-600" disabled={busy} onClick={() => setConfirmacao('recusar')}><XCircle className="h-4 w-4" /> Recusar</button></div>
              <p className="mt-2 text-[11px] text-slate-400">O aceite registra responsável, data, IP e a versão exata dos itens e valores.</p>
            </div>}
            {confirmacao && <section aria-label="Confirmar ação" className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm text-amber-950">{confirmacao === 'recomprar' ? 'Criar uma nova cotação com estes itens e os preços atuais?' : `Confirmar a decisão: ${confirmacao === 'alteracao' ? 'pedir alteração' : confirmacao}?`}</p>
              <div className="mt-3 flex flex-wrap gap-2"><button className="btn-accent" disabled={busy} onClick={() => confirmacao === 'recomprar' ? void recomprar() : void decidir(confirmacao)}>Confirmar</button><button className="btn-secondary" disabled={busy} onClick={() => setConfirmacao(null)}>Cancelar</button></div>
            </section>}
            {detalhe.decisoes.length > 0 && <div><h3 className="text-sm font-bold text-navy-900">Histórico de decisões</h3>{detalhe.decisoes.map((d, i) => <p key={i} className="mt-2 text-xs text-slate-500">{formatDateTime(d.criado_em)} · <b>{d.responsavel}</b> — {d.decisao}{d.mensagem ? `: ${d.mensagem}` : ''}</p>)}</div>}
          </div>
        </section>}
      </>}
    </main>
  </div>;
}
function Estado({ titulo, texto }: { titulo: string; texto: string }) { return <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 p-8 text-center"><Logo height={38} /><h1 className="mt-5 text-xl font-bold text-navy-900">{titulo}</h1><p className="mt-2 text-sm text-slate-500">{texto}</p></div>; }
function Resumo({ label, valor, icon }: { label: string; valor: number; icon: ReactNode }) { return <div className="card flex items-center gap-3 p-4"><span className="text-navy-500 [&>svg]:h-5 [&>svg]:w-5">{icon}</span><div><b className="block text-xl text-navy-900">{valor}</b><span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span></div></div>; }
