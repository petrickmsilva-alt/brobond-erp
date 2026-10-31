// ============================================================================
// OUTREACH — registro MANUAL do contato com o creator (creator_outreach).
//
// ZERO MODAL: LISTA → /outreach-ai/novo → /outreach-ai/:id → /:id/editar.
//
// O QUE ESTA PÁGINA NÃO FAZ
//   • não gera mensagem por IA e não envia nada: não existe provedor de
//     mensagens homologado nesta instalação. Marcar "Enviado" é a afirmação de
//     um humano de que contatou por fora — o sistema só registra o estado.
//   • não inventa histórico: cada linha é um registro real da empresa ativa.
// ============================================================================
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, PageHeader, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/idempotency';
import { CreatorsNavigation } from './CreatorsNavigation';

type OutreachRow = {
  id: number; creator_id: number; partnership_id: number | null; canal: string;
  assunto: string | null; mensagem: string | null; status: string;
  enviado_em: string | null; respondido_em: string | null; criado_em: string;
};
type CreatorRow = { id: number; name: string; handle: string };
type Page<T> = { rows: T[]; total: number; pageSize: number };

const CANAIS: [string, string][] = [['email', 'E-mail'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['telefone', 'Telefone'], ['outro', 'Outro']];
const STATUS: Record<string, string> = { rascunho: 'Rascunho', enviado: 'Enviado', respondido: 'Respondido', sem_resposta: 'Sem resposta' };
const TRANSICOES: Record<string, string[]> = {
  rascunho: ['rascunho', 'enviado', 'sem_resposta'], enviado: ['enviado', 'respondido', 'sem_resposta'],
  respondido: ['respondido'], sem_resposta: ['sem_resposta', 'enviado', 'respondido'],
};
const dataHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

export default function CreatorOutreachPage() {
  const { id } = useParams(); const { pathname } = useLocation(); const navigate = useNavigate(); const { user } = useAuth();
  const manage = ['admin', 'gerente'].includes(user?.perfil || '');
  const base = '/outreach-ai';
  const creating = pathname === `${base}/novo`; const editing = pathname.endsWith('/editar'); const detailView = Boolean(id) && !editing;

  const [rows, setRows] = useState<Page<OutreachRow> | null>(null); const [row, setRow] = useState<OutreachRow | null>(null);
  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [submittedSearch, setSubmittedSearch] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(!creating); const [busy, setBusy] = useState(false);
  const [creatorId, setCreatorId] = useState(''); const [canal, setCanal] = useState('email'); const [assunto, setAssunto] = useState('');
  const [mensagem, setMensagem] = useState(''); const [status, setStatus] = useState('rascunho');
  const keyFor = useIdempotencyKey();

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<Page<CreatorRow>>('/creators/perfis?pageSize=100', { signal: controller.signal })
      .then((r) => setCreators(r.rows)).catch(() => setCreators([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (creating) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setRow(null);
    const path = id ? `/creators/outreach/${id}` : `/creators/outreach?page=${page}&pageSize=25${submittedSearch ? `&q=${encodeURIComponent(submittedSearch)}` : ''}`;
    apiFetch<OutreachRow | Page<OutreachRow>>(path, { signal: controller.signal }).then((response) => {
      if (!id) { setRows(response as Page<OutreachRow>); return; }
      const data = response as OutreachRow; setRow(data);
      if (editing) { setStatus(data.status || 'rascunho'); }
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Não foi possível carregar os registros.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, creating, editing, page, submittedSearch]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const payload = editing ? { status } : { creator_id: Number(creatorId), canal, assunto: assunto || null, mensagem: mensagem || null, status: 'rascunho' };
      const body = JSON.stringify(payload);
      const result = await apiFetch<{ row: { id: number } }>(`/creators/outreach${editing ? `/${id}` : ''}`,
        { method: editing ? 'PUT' : 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
      navigate(`${base}/${result.row.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  if ((creating || editing) && !manage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  const estados = editing ? (TRANSICOES[String(row?.status)] || ['rascunho']) : ['rascunho'];

  return <div className="min-w-0 space-y-4">
    <PageHeader title={creating ? 'Novo contato' : editing ? 'Editar contato' : id ? `Contato #${id}` : 'Outreach'}
      description="Registro manual do contato com o creator. Nenhuma mensagem é gerada ou enviada por este sistema." />
    <CreatorsNavigation />
    <Alert tone="blue">O envio real depende de provedor homologado. Marcar <strong>Enviado</strong> registra que o contato ocorreu fora do sistema — nada é transmitido automaticamente.</Alert>
    {(id || creating) && <Link className="text-sm text-blue-700 hover:underline" to={editing ? `${base}/${id}` : base}>← Voltar</Link>}
    {error && <Alert tone="red">{error}</Alert>}{loading && <Spinner label="Carregando contatos…" />}

    {(creating || editing) && (creating || row) && !loading && <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      {creating && <><label className="block">Creator<select className="input mt-1" required value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
        <option value="">Selecione…</option>
        {creators.map((c) => <option key={c.id} value={c.id}>{c.name} (@{c.handle})</option>)}
      </select></label>
        <label className="block">Canal<select className="input mt-1" required value={canal} onChange={(e) => setCanal(e.target.value)}>
          {CANAIS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="block">Assunto (opcional)<input className="input mt-1" maxLength={160} value={assunto} onChange={(e) => setAssunto(e.target.value)} /></label>
        <label className="block">Mensagem (opcional)<textarea className="input mt-1" maxLength={4000} rows={5} value={mensagem} onChange={(e) => setMensagem(e.target.value)} /></label></>}
      {editing && <label className="block">Situação<select className="input mt-1" required value={status} onChange={(e) => setStatus(e.target.value)}>
        {estados.map((s) => <option key={s} value={s}>{STATUS[s] || s}</option>)}
      </select></label>}
      <button className="btn-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
    </form>}

    {!creating && !editing && !id && !loading && rows && <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">{manage && <Link className="btn-primary" to={`${base}/novo`}>Novo contato</Link>}
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}>
          <label>Buscar<input className="input ml-2" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <button className="btn-secondary">Buscar</button></form></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>ID</th><th>Creator</th><th>Canal</th><th>Assunto</th><th>Situação</th><th>Enviado em</th><th>Ação</th></tr></thead><tbody>
        {rows.rows.map((r) => <tr key={r.id}><td>{r.id}</td><td><Link className="text-blue-700 hover:underline" to={`/creators/${r.creator_id}`}>#{r.creator_id}</Link></td>
          <td>{CANAIS.find(([v]) => v === r.canal)?.[1] || r.canal}</td><td>{r.assunto || '—'}</td><td>{STATUS[r.status] || r.status}</td><td>{dataHora(r.enviado_em)}</td>
          <td><Link className="text-blue-700 hover:underline" to={`${base}/${r.id}`}>Detalhes</Link></td></tr>)}
        {!rows.rows.length && <tr><td colSpan={7}>Nenhum contato registrado.</td></tr>}</tbody></table></div>
      <Paginacao page={page} total={rows.total} size={rows.pageSize} setPage={setPage} />
    </section>}

    {detailView && !loading && row && <section className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <p>Creator <Link className="text-blue-700 underline" to={`/creators/${row.creator_id}`}>#{row.creator_id}</Link>{row.partnership_id ? <> · parceria <Link className="text-blue-700 underline" to={`/matches/${row.partnership_id}`}>#{row.partnership_id}</Link></> : null}</p>
      <p>Canal: {CANAIS.find(([v]) => v === row.canal)?.[1] || row.canal}</p>
      <p>Assunto: {row.assunto || 'não informado'}</p>
      {row.mensagem && <p className="whitespace-pre-wrap">Mensagem: {row.mensagem}</p>}
      <p>Situação: {STATUS[row.status] || row.status}</p>
      <p>Enviado em: {dataHora(row.enviado_em)} · Respondido em: {dataHora(row.respondido_em)}</p>
      {manage && <Link className="btn-secondary" to={`${base}/${id}/editar`}>Editar</Link>}
    </section>}
  </div>;
}

function Paginacao({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (n: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3 text-sm">
    <button className="btn-secondary" aria-label="Página anterior de contatos" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
    <span>Página {page} · {total} contato(s)</span>
    <button className="btn-secondary" aria-label="Próxima página de contatos" disabled={page * size >= total} onClick={() => setPage(page + 1)}>Próxima</button>
  </div>;
}
