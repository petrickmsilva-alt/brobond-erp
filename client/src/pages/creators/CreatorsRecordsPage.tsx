import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, PageHeader, Spinner } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/idempotency';
import { grana } from '../commerce/shared';
import { CreatorsNavigation } from './CreatorsNavigation';

export type CreatorKind = 'profile' | 'campaign' | 'partnership';
const config = {
  profile: { base: '/creators', api: 'perfis', label: 'Creators', singular: 'creator' },
  campaign: { base: '/campanhas', api: 'campanhas', label: 'Campanhas com creators', singular: 'campanha' },
  partnership: { base: '/matches', api: 'parcerias', label: 'Parcerias manuais', singular: 'parceria' },
} as const;
type CreatorRow = { id: number; name: string; platform: string; handle: string; niche: string | null; status: string; version: number;
  objective: string; starts_on: string; ends_on: string; creator_id: number; campaign_id: number; coupon_id: number | null };
type Attribution = { id: number; order_id: number; estado: string; pagamento_estado: string | null; total: number | string };
type Page<T> = { rows: T[]; total: number; pageSize: number };
const statusLabels: Record<string, string> = { ACTIVE: 'Ativo', INACTIVE: 'Inativo', DRAFT: 'Rascunho', PAUSED: 'Pausado', COMPLETED: 'Concluído', PLANNED: 'Planejada', ENDED: 'Encerrada' };
const transitions: Record<string, string[]> = { DRAFT: ['DRAFT', 'ACTIVE'], ACTIVE: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ENDED'], PAUSED: ['PAUSED', 'ACTIVE', 'COMPLETED', 'ENDED'], COMPLETED: ['COMPLETED'], PLANNED: ['PLANNED', 'ACTIVE', 'ENDED'], ENDED: ['ENDED'] };

export default function CreatorsRecordsPage({ kind }: { kind: CreatorKind }) {
  const cfg = config[kind]; const { id } = useParams(); const { pathname } = useLocation(); const navigate = useNavigate(); const { user } = useAuth();
  const manage = ['admin', 'gerente'].includes(user?.perfil || '');
  const creating = pathname === `${cfg.base}/novo`; const editing = pathname.endsWith('/editar'); const detailView = Boolean(id) && !editing;
  const [rows, setRows] = useState<Page<CreatorRow> | null>(null); const [row, setRow] = useState<CreatorRow | null>(null); const [attributions, setAttributions] = useState<Page<Attribution> | null>(null);
  const [page, setPage] = useState(1); const [attrPage, setAttrPage] = useState(1); const [search, setSearch] = useState(''); const [submittedSearch, setSubmittedSearch] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(!creating); const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [platform, setPlatform] = useState('INSTAGRAM'); const [handle, setHandle] = useState(''); const [niche, setNiche] = useState('');
  const [objective, setObjective] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [status, setStatus] = useState('');
  const [creatorId, setCreatorId] = useState(''); const [campaignId, setCampaignId] = useState(''); const [couponId, setCouponId] = useState('');
  const keyFor = useIdempotencyKey();
  useEffect(() => {
    if (creating) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setRow(null); setAttributions(null);
    const path = id ? `/creators/${cfg.api}/${id}` : `/creators/${cfg.api}?page=${page}&pageSize=25${submittedSearch ? `&q=${encodeURIComponent(submittedSearch)}` : ''}`;
    apiFetch<CreatorRow | Page<CreatorRow>>(path, { signal: controller.signal }).then((response) => {
      if (!id) { setRows(response as Page<CreatorRow>); return; }
      const data = response as CreatorRow;
      setRow(data);
      if (editing) {
        setName(data.name || ''); setPlatform(data.platform || 'INSTAGRAM'); setHandle(data.handle || ''); setNiche(data.niche || '');
        setObjective(data.objective || ''); setStart(String(data.starts_on || '').slice(0, 10)); setEnd(String(data.ends_on || '').slice(0, 10)); setStatus(data.status || '');
      }
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Não foi possível carregar os registros.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, cfg.api, id, creating, editing, page, submittedSearch]);
  useEffect(() => {
    if (kind !== 'partnership' || !detailView || !manage || !id) return;
    const controller = new AbortController();
    apiFetch<Page<Attribution>>(`/creators/parcerias/${id}/atribuicoes?page=${attrPage}&pageSize=25`, { signal: controller.signal }).then(setAttributions)
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Não foi possível carregar atribuições.'); });
    return () => controller.abort();
  }, [kind, id, detailView, manage, attrPage]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      let payload: Record<string, unknown>;
      if (kind === 'profile') payload = { name, platform, handle, niche: niche || null, ...(editing ? { status } : {}) };
      else if (kind === 'campaign') payload = { name, objective, starts_on: start, ends_on: end, ...(editing ? { status } : {}) };
      else payload = editing ? { status } : { creator_id: Number(creatorId), campaign_id: Number(campaignId), coupon_id: couponId ? Number(couponId) : null };
      if (editing) payload.expected_version = Number(row?.version || 0);
      const body = JSON.stringify(payload);
      const result = await apiFetch<{ row: { id: number } }>(`/creators/${cfg.api}${editing ? `/${id}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
      navigate(`${cfg.base}/${result.row.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  if ((creating || editing) && !manage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  const states = kind === 'profile' ? ['ACTIVE', 'INACTIVE'] : (transitions[String(row?.status)] || []).filter((s) => kind === 'campaign' ? s !== 'ENDED' : s !== 'COMPLETED');
  return <div className="min-w-0 space-y-4">
    <PageHeader title={creating ? `Novo ${cfg.singular}` : editing ? `Editar ${cfg.singular}` : id ? `${cfg.label} #${id}` : cfg.label} description={kind === 'partnership' ? 'Vínculos decididos por pessoas, sem recomendação automática.' : 'Dados próprios da empresa ativa.'} />
    <CreatorsNavigation />
    {(id || creating) && <Link className="text-sm text-blue-700 hover:underline" to={editing ? `${cfg.base}/${id}` : cfg.base}>← Voltar</Link>}
    {kind === 'partnership' && <Alert tone="blue">O cupom é opcional e exclusivo da parceria. Atribuições registram checkouts posteriores com o cupom efetivamente aplicado; não calculam comissão nem ROI.</Alert>}
    {error && <Alert tone="red">{error}</Alert>}{loading && <Spinner label="Carregando registros…" />}
    {(creating || editing) && (creating || row) && !loading && <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-4">
      {kind !== 'partnership' && <label className="block">Nome<input className="input mt-1" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>}
      {kind === 'profile' && <><label className="block">Plataforma<select className="input mt-1" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="INSTAGRAM">Instagram</option><option value="TIKTOK">TikTok</option><option value="YOUTUBE">YouTube</option><option value="OTHER">Outra</option></select></label>
        <label className="block">Identificador do perfil<input className="input mt-1" required maxLength={101} value={handle} onChange={(e) => setHandle(e.target.value)} /></label>
        <label className="block">Nicho (opcional)<input className="input mt-1" maxLength={100} value={niche} onChange={(e) => setNiche(e.target.value)} /></label></>}
      {kind === 'campaign' && <><label className="block">Objetivo<textarea className="input mt-1" required minLength={8} maxLength={500} value={objective} onChange={(e) => setObjective(e.target.value)} /></label>
        <div className="grid gap-3 md:grid-cols-2"><label>Início<input className="input mt-1" type="date" required value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Fim<input className="input mt-1" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} /></label></div></>}
      {kind === 'partnership' && creating && <><p>Informe IDs de registros já cadastrados. <Link className="text-blue-700 underline" to="/creators">Ver creators</Link> · <Link className="text-blue-700 underline" to="/campanhas">Ver campanhas</Link> · <Link className="text-blue-700 underline" to="/commerce/cupons">Ver cupons</Link></p>
        <label className="block">ID do creator<input className="input mt-1" type="number" min="1" step="1" required value={creatorId} onChange={(e) => setCreatorId(e.target.value)} /></label>
        <label className="block">ID da campanha<input className="input mt-1" type="number" min="1" step="1" required value={campaignId} onChange={(e) => setCampaignId(e.target.value)} /></label>
        <label className="block">ID do cupom (opcional)<input className="input mt-1" type="number" min="1" step="1" value={couponId} onChange={(e) => setCouponId(e.target.value)} /></label></>}
      {editing && <label className="block">Situação<select className="input mt-1" required value={status} onChange={(e) => setStatus(e.target.value)}>{states.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>}
      <button className="btn-primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
    </form>}
    {!creating && !editing && !id && !loading && rows && <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">{manage && <Link className="btn-primary" to={`${cfg.base}/novo`}>Novo {cfg.singular}</Link>}
        {kind !== 'partnership' && <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}><label>Buscar<input className="input ml-2" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} /></label><button className="btn-secondary">Buscar</button></form>}</div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>ID</th><th>{kind === 'partnership' ? 'Creator / campanha' : 'Nome'}</th><th>Detalhe</th><th>Situação</th><th>Ação</th></tr></thead><tbody>
        {rows.rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{kind === 'partnership' ? `#${r.creator_id} / #${r.campaign_id}` : r.name}</td><td>{kind === 'profile' ? `${r.platform} · @${r.handle}` : kind === 'campaign' ? `${String(r.starts_on).slice(0, 10)} a ${String(r.ends_on).slice(0, 10)}` : r.coupon_id ? `Cupom #${r.coupon_id}` : 'Sem cupom'}</td><td>{statusLabels[r.status] || r.status}</td><td><Link className="text-blue-700 hover:underline" to={`${cfg.base}/${r.id}`}>Detalhes</Link></td></tr>)}
        {!rows.rows.length && <tr><td colSpan={5}>Nenhum registro encontrado.</td></tr>}</tbody></table></div>
      <Pagination label="registros" page={page} total={rows.total} size={rows.pageSize} setPage={setPage} />
    </section>}
    {detailView && !loading && row && <><section className="space-y-2 rounded-xl border border-line bg-surface p-4">
      {kind === 'profile' && <><p><strong>{row.name}</strong> · {row.platform} · @{row.handle}</p><p>Nicho: {row.niche || 'não informado'}</p></>}
      {kind === 'campaign' && <><p><strong>{row.name}</strong></p><p>Objetivo: {row.objective}</p><p>Período: {String(row.starts_on).slice(0, 10)} a {String(row.ends_on).slice(0, 10)}</p></>}
      {kind === 'partnership' && <><p>Creator <Link className="text-blue-700 underline" to={`/creators/${row.creator_id}`}>#{row.creator_id}</Link> · campanha <Link className="text-blue-700 underline" to={`/campanhas/${row.campaign_id}`}>#{row.campaign_id}</Link></p><p>Cupom: {row.coupon_id ? `#${row.coupon_id}` : 'não vinculado'}</p></>}
      <p>Situação: {statusLabels[row.status] || row.status}</p>{manage && <Link className="btn-secondary" to={`${cfg.base}/${id}/editar`}>Editar</Link>}
    </section>
    {kind === 'partnership' && manage && <section className="space-y-3 rounded-xl border border-line bg-surface p-4"><h2 className="font-semibold">Checkouts atribuídos</h2><p className="text-sm text-muted">Consulte a situação atual do pedido; valores não representam receita líquida nem comissão.</p>
      {attributions && <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Pedido</th><th>Situação</th><th>Pagamento</th><th>Total do pedido</th></tr></thead><tbody>{attributions.rows.map((a) => <tr key={a.id}><td>#{a.order_id}</td><td>{a.estado}</td><td>{a.pagamento_estado || '—'}</td><td>{grana(Number(a.total))}</td></tr>)}{!attributions.rows.length && <tr><td colSpan={4}>Nenhum checkout atribuído.</td></tr>}</tbody></table></div><Pagination label="atribuições" page={attrPage} total={attributions.total} size={attributions.pageSize} setPage={setAttrPage} /></>}
    </section>}</>}
  </div>;
}
function Pagination({ label, page, total, size, setPage }: { label: string; page: number; total: number; size: number; setPage: (n: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3 text-sm"><button className="btn-secondary" aria-label={`Página anterior de ${label}`} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {total} registro(s)</span><button className="btn-secondary" aria-label={`Próxima página de ${label}`} disabled={page * size >= total} onClick={() => setPage(page + 1)}>Próxima</button></div>;
}
