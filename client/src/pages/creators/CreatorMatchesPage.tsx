// ============================================================================
// MATCHES — afinidade REGISTRADA entre creator, campanha e categoria
// (creator_matches), com score e evidência factuais.
//
// ZERO MODAL: LISTA → /matches/novo → /matches/:id → /matches/:id/editar.
//
// O QUE ESTA PÁGINA NÃO FAZ
//   • não gera recomendação: nenhum algoritmo sugere o par. Uma PESSOA registra
//     a afinidade e informa o score e a evidência (fatos), que ficam gravados.
//   • as parcerias manuais (vínculo comercial) vivem em /matches/parcerias.
// ============================================================================
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, PageHeader, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/idempotency';
import { CreatorsNavigation } from './CreatorsNavigation';

type MatchRow = {
  id: number; creator_id: number; campaign_id: number | null; categoria_id: number | null;
  score: number | string; evidencia: Record<string, unknown> | null; status: string; criado_em: string;
};
type Option = { id: number; name?: string; label?: string; handle?: string };
type Page<T> = { rows: T[]; total: number; pageSize: number };

const STATUS: Record<string, string> = { sugerido: 'Sugerido', aceito: 'Aceito', descartado: 'Descartado' };
const TONE: Record<string, 'blue' | 'green' | 'slate'> = { sugerido: 'blue', aceito: 'green', descartado: 'slate' };
const TRANSICOES: Record<string, string[]> = { sugerido: ['sugerido', 'aceito', 'descartado'], aceito: ['aceito', 'descartado'], descartado: ['descartado'] };
const rotulo = (o?: Option) => (o ? o.name || o.label || (o.handle ? `@${o.handle}` : `#${o.id}`) : '—');

export default function CreatorMatchesPage() {
  const { id } = useParams(); const { pathname } = useLocation(); const navigate = useNavigate(); const { user } = useAuth();
  const manage = ['admin', 'gerente'].includes(user?.perfil || '');
  const base = '/matches';
  const creating = pathname === `${base}/novo`; const editing = pathname.endsWith('/editar'); const detailView = Boolean(id) && !editing;

  const [rows, setRows] = useState<Page<MatchRow> | null>(null); const [row, setRow] = useState<MatchRow | null>(null);
  const [creators, setCreators] = useState<Option[]>([]); const [campanhas, setCampanhas] = useState<Option[]>([]); const [categorias, setCategorias] = useState<Option[]>([]);
  const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [submittedSearch, setSubmittedSearch] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(!creating); const [busy, setBusy] = useState(false);
  const [creatorId, setCreatorId] = useState(''); const [campaignId, setCampaignId] = useState(''); const [categoriaId, setCategoriaId] = useState('');
  const [score, setScore] = useState('0'); const [evidencia, setEvidencia] = useState(''); const [status, setStatus] = useState('sugerido');
  const keyFor = useIdempotencyKey();

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<Page<Option>>('/creators/perfis?pageSize=100', { signal: controller.signal }).then((r) => setCreators(r.rows)).catch(() => setCreators([]));
    apiFetch<Page<Option>>('/creators/campanhas?pageSize=100', { signal: controller.signal }).then((r) => setCampanhas(r.rows)).catch(() => setCampanhas([]));
    apiFetch<{ value: number; label: string }[]>('/categorias/options', { signal: controller.signal })
      .then((o) => setCategorias(o.map((x) => ({ id: x.value, label: x.label })))).catch(() => setCategorias([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (creating) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setRow(null);
    const path = id ? `/creators/matches/${id}` : `/creators/matches?page=${page}&pageSize=25${submittedSearch ? `&q=${encodeURIComponent(submittedSearch)}` : ''}`;
    apiFetch<MatchRow | Page<MatchRow>>(path, { signal: controller.signal }).then((response) => {
      if (!id) { setRows(response as Page<MatchRow>); return; }
      const data = response as MatchRow; setRow(data);
      if (editing) setStatus(data.status || 'sugerido');
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Não foi possível carregar os registros.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, creating, editing, page, submittedSearch]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      let payload: Record<string, unknown>;
      if (editing) payload = { status };
      else {
        let evidenciaObj: Record<string, unknown> = {};
        if (evidencia.trim()) {
          try { evidenciaObj = JSON.parse(evidencia); }
          catch { throw new Error('A evidência deve ser um objeto JSON válido.'); }
          if (typeof evidenciaObj !== 'object' || Array.isArray(evidenciaObj)) throw new Error('A evidência deve ser um objeto JSON.');
        }
        payload = { creator_id: Number(creatorId), campaign_id: campaignId ? Number(campaignId) : null,
          categoria_id: categoriaId ? Number(categoriaId) : null, score: Number(score), evidencia: evidenciaObj, status: 'sugerido' };
      }
      const body = JSON.stringify(payload);
      const result = await apiFetch<{ row: { id: number } }>(`/creators/matches${editing ? `/${id}` : ''}`,
        { method: editing ? 'PUT' : 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
      navigate(`${base}/${result.row.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }

  if ((creating || editing) && !manage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  const estados = editing ? (TRANSICOES[String(row?.status)] || ['sugerido']) : ['sugerido'];

  return <div className="min-w-0 space-y-4">
    <PageHeader title={creating ? 'Nova afinidade' : editing ? 'Editar afinidade' : id ? `Afinidade #${id}` : 'Matches'}
      description="Afinidades registradas por pessoas. O sistema não sugere pares nem fabrica scores." />
    <CreatorsNavigation />
    <Alert tone="blue">Esta tela registra a afinidade e sua evidência. As <Link className="underline" to="/matches/parcerias">parcerias manuais</Link> (vínculo comercial com cupom) ficam separadas.</Alert>
    {(id || creating) && <Link className="text-sm text-blue-700 hover:underline" to={editing ? `${base}/${id}` : base}>← Voltar</Link>}
    {error && <Alert tone="red">{error}</Alert>}{loading && <Spinner label="Carregando afinidades…" />}

    {(creating || editing) && (creating || row) && !loading && <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      {creating && <><label className="block">Creator<select className="input mt-1" required value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
        <option value="">Selecione…</option>{creators.map((c) => <option key={c.id} value={c.id}>{rotulo(c)}</option>)}</select></label>
        <label className="block">Campanha (opcional)<select className="input mt-1" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">Nenhuma</option>{campanhas.map((c) => <option key={c.id} value={c.id}>{rotulo(c)}</option>)}</select></label>
        <label className="block">Categoria (opcional)<select className="input mt-1" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
          <option value="">Nenhuma</option>{categorias.map((c) => <option key={c.id} value={c.id}>{rotulo(c)}</option>)}</select></label>
        <label className="block">Score (0 a 100)<input className="input mt-1" type="number" min="0" max="100" step="0.01" required value={score} onChange={(e) => setScore(e.target.value)} /></label>
        <label className="block">Evidência (JSON, opcional)<textarea className="input mt-1 font-mono" rows={4} placeholder={'{"publicos": ["moda"]}'} value={evidencia} onChange={(e) => setEvidencia(e.target.value)} /></label></>}
      {editing && <label className="block">Situação<select className="input mt-1" required value={status} onChange={(e) => setStatus(e.target.value)}>
        {estados.map((s) => <option key={s} value={s}>{STATUS[s] || s}</option>)}</select></label>}
      <button className="btn-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
    </form>}

    {!creating && !editing && !id && !loading && rows && <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">{manage && <Link className="btn-primary" to={`${base}/novo`}>Nova afinidade</Link>}
        <Link className="btn-secondary" to="/matches/parcerias">Parcerias manuais</Link>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}>
          <label>Buscar<input className="input ml-2" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <button className="btn-secondary">Buscar</button></form></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>ID</th><th>Creator</th><th>Campanha</th><th>Categoria</th><th>Score</th><th>Situação</th><th>Ação</th></tr></thead><tbody>
        {rows.rows.map((r) => <tr key={r.id}><td>{r.id}</td>
          <td><Link className="text-blue-700 hover:underline" to={`/creators/${r.creator_id}`}>#{r.creator_id}</Link></td>
          <td>{r.campaign_id ? <Link className="text-blue-700 hover:underline" to={`/campanhas/${r.campaign_id}`}>#{r.campaign_id}</Link> : '—'}</td>
          <td>{r.categoria_id ?? '—'}</td><td>{Number(r.score).toFixed(2)}</td>
          <td><Badge tone={TONE[r.status] || 'slate'}>{STATUS[r.status] || r.status}</Badge></td>
          <td><Link className="text-blue-700 hover:underline" to={`${base}/${r.id}`}>Detalhes</Link></td></tr>)}
        {!rows.rows.length && <tr><td colSpan={7}>Nenhuma afinidade registrada.</td></tr>}</tbody></table></div>
      <Paginacao page={page} total={rows.total} size={rows.pageSize} setPage={setPage} />
    </section>}

    {detailView && !loading && row && <section className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <p>Creator <Link className="text-blue-700 underline" to={`/creators/${row.creator_id}`}>#{row.creator_id}</Link></p>
      <p>Campanha: {row.campaign_id ? <Link className="text-blue-700 underline" to={`/campanhas/${row.campaign_id}`}>#{row.campaign_id}</Link> : 'não vinculada'}</p>
      <p>Categoria: {row.categoria_id ?? 'não vinculada'}</p>
      <p>Score: {Number(row.score).toFixed(2)}</p>
      <p>Situação: <Badge tone={TONE[row.status] || 'slate'}>{STATUS[row.status] || row.status}</Badge></p>
      <div><p className="font-semibold">Evidência</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-navy-800">{JSON.stringify(row.evidencia ?? {}, null, 2)}</pre></div>
      {manage && <Link className="btn-secondary" to={`${base}/${id}/editar`}>Editar</Link>}
    </section>}
  </div>;
}

function Paginacao({ page, total, size, setPage }: { page: number; total: number; size: number; setPage: (n: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3 text-sm">
    <button className="btn-secondary" aria-label="Página anterior de afinidades" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
    <span>Página {page} · {total} afinidade(s)</span>
    <button className="btn-secondary" aria-label="Próxima página de afinidades" disabled={page * size >= total} onClick={() => setPage(page + 1)}>Próxima</button>
  </div>;
}
