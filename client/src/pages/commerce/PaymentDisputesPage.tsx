import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, PageHeader, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/idempotency';
import { PaymentNavigation } from './PaymentNavigation';
import { dataHora, grana } from './shared';

type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };
type Dispute = { id: number; payment_intent_id: number; provider_reference: string; provider: string | null; external_dispute_id: string | null; origin: string; status: string; version: number; amount: number; reason: string | null; due_date: string | null };
type Evidence = { id: number; kind: string; description: string; content: string; created_at: string };
type Event = { id: number; kind: string; from_status: string | null; to_status: string; note: string | null; external_reference: string | null; created_at: string };
type Detail = { dispute: Dispute; evidence: Page<Evidence>; events: Page<Event>; provider_submission: string; source: string };
const BASE = '/commerce/pagamentos/disputas';
const names: Record<string, string> = { DISPUTE_OPENED: 'Aberta', UNDER_REVIEW: 'Em análise', EVIDENCE_REQUIRED: 'Evidências solicitadas', EVIDENCE_SUBMITTED: 'Envio externo registrado', WON: 'Ganha', LOST: 'Perdida', CLOSED: 'Encerrada' };
const edges: Record<string, string[]> = {
  DISPUTE_OPENED: ['UNDER_REVIEW', 'EVIDENCE_REQUIRED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  UNDER_REVIEW: ['EVIDENCE_REQUIRED', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  EVIDENCE_REQUIRED: ['UNDER_REVIEW', 'EVIDENCE_SUBMITTED', 'WON', 'LOST', 'CLOSED'],
  EVIDENCE_SUBMITTED: ['UNDER_REVIEW', 'EVIDENCE_REQUIRED', 'WON', 'LOST', 'CLOSED'], WON: ['CLOSED'], LOST: ['CLOSED'], CLOSED: [],
};

export default function PaymentDisputesPage() {
  const { id } = useParams(); const { pathname } = useLocation(); const navigate = useNavigate(); const { user } = useAuth();
  const canManage = ['admin', 'gerente'].includes(user?.perfil || '');
  const creating = pathname === `${BASE}/novo`;
  const addingEvidence = pathname.endsWith('/evidencias/nova');
  const changing = pathname.endsWith('/alterar');
  const detailView = Boolean(id) && !addingEvidence && !changing;
  const [list, setList] = useState<Page<Dispute> | null>(null); const [detail, setDetail] = useState<Detail | null>(null);
  const [listPage, setListPage] = useState(1); const [evidencePage, setEvidencePage] = useState(1); const [eventsPage, setEventsPage] = useState(1);
  const [loading, setLoading] = useState(!creating); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [intent, setIntent] = useState(''); const [reference, setReference] = useState(''); const [external, setExternal] = useState('');
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [due, setDue] = useState('');
  const [kind, setKind] = useState('NOTE'); const [description, setDescription] = useState(''); const [content, setContent] = useState('');
  const [target, setTarget] = useState(''); const [note, setNote] = useState(''); const [externalRef, setExternalRef] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const keyFor = useIdempotencyKey();
  useEffect(() => {
    if (!canManage || creating) return;
    const controller = new AbortController(); setLoading(true); setError('');
    const path = id ? `/commerce/payments/disputes/${id}?evidence_page=${evidencePage}&events_page=${eventsPage}` : `/commerce/payments/disputes?page=${listPage}&pageSize=25`;
    apiFetch<Detail | Page<Dispute>>(path, { signal: controller.signal }).then((data) => {
      if (id) setDetail(data as Detail); else setList(data as Page<Dispute>);
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Não foi possível carregar disputas.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, pathname, creating, canManage, listPage, evidencePage, eventsPage]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      let path: string; let body: string;
      if (creating) {
        path = '/commerce/payments/disputes';
        body = JSON.stringify({ payment_intent_id: Number(intent), provider_reference: reference, external_dispute_id: external, amount: Number(amount), reason, due_date: due || null });
      } else if (addingEvidence) {
        path = `/commerce/payments/disputes/${id}/evidence`;
        body = JSON.stringify({ kind, description, content });
      } else {
        if (!detail) throw new Error('Atualize os dados da disputa antes de continuar.');
        path = `/commerce/payments/disputes/${id}/transition`;
        body = JSON.stringify({ status: target, note, external_reference: externalRef || null, confirm_external: confirmed, expected_version: Number(detail.dispute.version || 0) });
      }
      const result = await apiFetch<{ dispute?: Dispute }>(path, { method: 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
      navigate(`${BASE}/${creating ? result.dispute?.id : id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  if (!canManage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  const terminal = detail && ['WON', 'LOST', 'CLOSED'].includes(detail.dispute.status);
  const needsExternal = ['EVIDENCE_SUBMITTED', 'WON', 'LOST'].includes(target);
  return <div className="min-w-0 space-y-4">
    <PageHeader title={creating ? 'Registrar disputa' : id ? `Disputa #${id}` : 'Disputas e chargebacks'} description="Registros internos vinculados a pagamentos existentes." />
    <PaymentNavigation />
    <Link className="text-sm text-blue-700 hover:underline" to={id && !detailView ? `${BASE}/${id}` : id || creating ? BASE : '/commerce/pagamentos'}>← Voltar</Link>
    <Alert tone="blue">O sistema não envia evidências nem consulta o desfecho no provedor. Registros externos são declarações manuais e não alteram pagamentos ou caixa.</Alert>
    {error && <Alert tone="red">{error}</Alert>}
    {loading && !creating && <Spinner label="Carregando disputas…" />}
    {creating && <form className="space-y-4 rounded-xl border border-line bg-surface p-4" onSubmit={submit}>
      <p className="text-sm text-muted">Informe apenas uma disputa realmente recebida. A referência deve pertencer a uma tentativa existente no Payment Engine desta empresa.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label>ID do pagamento<input className="input mt-1" type="number" min="1" step="1" required value={intent} onChange={(e) => setIntent(e.target.value)} /></label>
        <label>Referência da transação<input className="input mt-1" maxLength={160} required value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label>ID externo da disputa<input className="input mt-1" maxLength={160} required value={external} onChange={(e) => setExternal(e.target.value)} /></label>
        <label>Valor contestado (centavos)<input className="input mt-1" type="number" min="1" step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Prazo informado (opcional)<input className="input mt-1" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label>Motivo informado<input className="input mt-1" minLength={8} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div><button className="btn-primary" disabled={busy}>{busy ? 'Registrando…' : 'Registrar disputa'}</button>
    </form>}
    {!creating && !id && !loading && list && <section className="space-y-4">
      <Link className="btn-primary" to={`${BASE}/novo`}>Registrar disputa</Link>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>ID</th><th>Pagamento</th><th>Transação</th><th>Valor</th><th>Estado</th><th>Ação</th></tr></thead><tbody>
        {list.rows.map((row) => <tr key={row.id}><td>{row.id}</td><td>{row.payment_intent_id}</td><td>{row.provider_reference}</td><td>{grana(Number(row.amount) / 100)}</td><td>{names[row.status] || row.status}</td><td><Link className="text-blue-700 hover:underline" to={`${BASE}/${row.id}`}>Detalhes</Link></td></tr>)}
        {!list.rows.length && <tr><td colSpan={6}>Nenhuma disputa encontrada.</td></tr>}</tbody></table></div>
      <Pagination label="disputas" page={listPage} total={list.total} pageSize={list.pageSize} setPage={setListPage} />
    </section>}
    {id && !loading && detail && <>
      <section className="space-y-2 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Dados da disputa</h2>
        <p>Pagamento #{detail.dispute.payment_intent_id} · {detail.dispute.provider || 'Provedor não informado'} · transação {detail.dispute.provider_reference}</p>
        <p>Situação: <strong>{names[detail.dispute.status] || detail.dispute.status}</strong> · Valor: {grana(Number(detail.dispute.amount) / 100)} · Origem: {detail.dispute.origin === 'ENGINE' ? 'Payment Engine' : 'registro manual'}</p>
        <p>Disputa externa: {detail.dispute.external_dispute_id || 'não informada'} · Prazo: {detail.dispute.due_date ? String(detail.dispute.due_date).slice(0, 10) : 'não informado'}</p>
        <p>Motivo: {detail.dispute.reason || 'não informado'}</p>
        {detailView && <div className="flex flex-wrap gap-2">{!terminal && <Link className="btn-primary" to={`${BASE}/${id}/evidencias/nova`}>Registrar evidência</Link>}{(edges[detail.dispute.status] || []).length > 0 && <Link className="btn-secondary" to={`${BASE}/${id}/alterar`}>Alterar situação</Link>}</div>}
      </section>
      {addingEvidence && <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <h2 className="font-semibold">Registrar evidência interna</h2><p className="text-sm text-muted">Não inclua dados de cartão, senhas ou credenciais. Referência documental é um identificador; não envia nem hospeda arquivos.</p>
        <label className="block">Tipo<select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value)}><option value="NOTE">Nota textual</option><option value="DOCUMENT_REFERENCE">Referência de documento</option></select></label>
        <label className="block">Descrição<input className="input mt-1" minLength={3} maxLength={200} required value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="block">{kind === 'NOTE' ? 'Conteúdo da nota' : 'Identificador do documento'}<textarea className="input mt-1" maxLength={kind === 'NOTE' ? 4000 : 200} required value={content} onChange={(e) => setContent(e.target.value)} /></label>
        <button className="btn-primary" disabled={busy}>{busy ? 'Registrando…' : 'Salvar evidência'}</button>
      </form>}
      {changing && <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Alterar situação</h2>
        <label className="block">Nova situação<select className="input mt-1" required value={target} onChange={(e) => { setTarget(e.target.value); setConfirmed(false); }}><option value="">Selecione</option>{(edges[detail.dispute.status] || []).map((value) => <option key={value} value={value}>{names[value]}</option>)}</select></label>
        <label className="block">Justificativa<textarea className="input mt-1" minLength={8} maxLength={500} required value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {needsExternal && <><label className="block">Referência do fato externo<input className="input mt-1" maxLength={160} required value={externalRef} onChange={(e) => setExternalRef(e.target.value)} /></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} required onChange={(e) => setConfirmed(e.target.checked)} /><span>Confirmo que este fato já ocorreu fora do sistema; esta ação não envia nada ao provedor.</span></label></>}
        <button className="btn-primary" disabled={busy || !target}>{busy ? 'Salvando…' : 'Registrar situação'}</button>
      </form>}
      {detailView && <><section className="space-y-3 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Evidências internas</h2>
        {!detail.evidence.rows.length && <p>Nenhuma evidência registrada.</p>}
        {detail.evidence.rows.map((e) => <article key={e.id} className="break-words border-b border-line pb-3"><h3 className="font-medium">{e.description}</h3><p className="text-sm text-muted">{e.kind === 'NOTE' ? 'Nota' : 'Referência de documento'} · {dataHora(e.created_at)}</p><p className="whitespace-pre-wrap">{e.content}</p></article>)}
        <Pagination label="evidências" page={evidencePage} total={detail.evidence.total} pageSize={detail.evidence.pageSize} setPage={setEvidencePage} />
      </section><section className="space-y-3 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Histórico manual</h2>
        {!detail.events.rows.length && <p>Nenhum evento manual registrado.</p>}
        {detail.events.rows.map((event) => <article key={event.id} className="break-words border-b border-line pb-3"><p>{names[event.from_status || ''] || event.from_status || 'Registro'} → {names[event.to_status] || event.to_status} · {dataHora(event.created_at)}</p>{event.note && <p>{event.note}</p>}{event.external_reference && <p>Referência externa informada: {event.external_reference}</p>}</article>)}
        <Pagination label="eventos" page={eventsPage} total={detail.events.total} pageSize={detail.events.pageSize} setPage={setEventsPage} />
      </section></>}
    </>}
  </div>;
}
function Pagination({ label, page, total, pageSize, setPage }: { label: string; page: number; total: number; pageSize: number; setPage: (value: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3 text-sm"><button type="button" className="btn-secondary" aria-label={`Página anterior de ${label}`} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {total} registro(s)</span><button type="button" className="btn-secondary" aria-label={`Próxima página de ${label}`} disabled={page * pageSize >= total} onClick={() => setPage(page + 1)}>Próxima</button></div>;
}
