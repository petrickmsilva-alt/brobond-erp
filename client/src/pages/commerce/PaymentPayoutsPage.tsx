import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
import { useIdempotencyKey } from '../../lib/idempotency';
import { Alert, PageHeader, Spinner } from '../../components/ui';
import { PaymentNavigation } from './PaymentNavigation';
import { useAuth } from '../../auth/AuthContext';
import { dataHora, grana } from './shared';

type Line = { provider_reference: string; gross_amount: string; provider_fee: string; gateway_fee: string; installment_fee: string; antifraud_fee: string; refund_amount: string; chargeback_amount: string; net_amount: string };
type Payout = { id: number; provider: string; payout_reference: string; settlement_date: string; net_amount: number | string; status: string; bank_transaction_id: number | string | null; content_hash: string };
type Settlement = { id: number; provider_reference: string; gross_amount: number | string; net_amount: number | string; status: string; evidence?: { provider_report?: { gross_amount: number | string } } };
type ReportLine = { [K in keyof Line]: K extends 'provider_reference' ? string : number };
type Report = { provider: string; payout_reference: string; settlement_date: string; net_amount: number; transactions: ReportLine[] };
type Revision = { id: number; revision: number; created_at: string; reason: string; content_hash: string };
type Unlink = { id: number; bank_transaction_id: number; created_at: string; reason: string };
type Page<T> = { rows: T[]; total: number; pageSize: number };
type Detail = { payout: Payout; settlements: Settlement[]; report: Report | null; revisions?: Page<Revision>; unlinks?: Page<Unlink> };
const emptyLine = (): Line => ({ provider_reference: '', gross_amount: '', provider_fee: '0', gateway_fee: '0', installment_fee: '0', antifraud_fee: '0', refund_amount: '0', chargeback_amount: '0', net_amount: '' });
const fields: [keyof Line, string][] = [['provider_reference', 'Referência da transação'], ['gross_amount', 'Bruto (centavos)'], ['provider_fee', 'Taxa do provedor'], ['gateway_fee', 'Taxa de gateway'], ['installment_fee', 'Taxa de parcelas'], ['antifraud_fee', 'Taxa antifraude'], ['refund_amount', 'Reembolso'], ['chargeback_amount', 'Chargeback'], ['net_amount', 'Líquido (centavos)']];
const base = '/commerce/pagamentos/repasses';
export default function PaymentPayoutsPage() {
  const { id } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const { user } = useAuth(); const canManage = ['admin', 'gerente'].includes(user?.perfil || '');
  const novo = location.pathname.endsWith('/novo'); const conciliar = location.pathname.endsWith('/conciliar');
  const corrigir = location.pathname.endsWith('/corrigir'); const desvincular = location.pathname.endsWith('/desvincular');
  const detailView = Boolean(id) && !conciliar && !corrigir && !desvincular;
  const [rows, setRows] = useState<Payout[]>([]); const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [payout, setPayout] = useState<Payout | null>(null); const [currentReport, setCurrentReport] = useState<Report | null>(null);
  const [revisions, setRevisions] = useState<Page<Revision> | null>(null); const [unlinks, setUnlinks] = useState<Page<Unlink> | null>(null);
  const [page, setPage] = useState(1); const [revisionsPage, setRevisionsPage] = useState(1); const [unlinksPage, setUnlinksPage] = useState(1); const [total, setTotal] = useState(0);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(!novo);
  const [provider, setProvider] = useState('PAGBANK'); const [reference, setReference] = useState(''); const [date, setDate] = useState(''); const [net, setNet] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]); const [bankId, setBankId] = useState(''); const [reason, setReason] = useState('');
  const keyFor = useIdempotencyKey();
  useEffect(() => {
    if (novo || !canManage) return;
    const controller = new AbortController(); setLoading(true); setError('');
    const path = id ? `/commerce/payments/payouts/${id}?revisions_page=${revisionsPage}&unlinks_page=${unlinksPage}` : `/commerce/payments/payouts?page=${page}&pageSize=25`;
    apiFetch<Detail | Page<Payout>>(path, { signal: controller.signal }).then((response) => {
      if (id) {
        const data = response as Detail;
        setPayout(data.payout); setSettlements(data.settlements || []); setCurrentReport(data.report || null); setRevisions(data.revisions || null); setUnlinks(data.unlinks || null);
        if (corrigir && data.report) {
          setProvider(data.report.provider); setReference(data.report.payout_reference); setDate(data.report.settlement_date); setNet(String(data.report.net_amount));
          setLines(data.report.transactions.map((line) =>
            Object.fromEntries(fields.map(([key]) => [key, String(line[key] ?? (key === 'provider_reference' ? '' : 0))])) as Line));
        }
      } else { const data = response as Page<Payout>; setRows(data.rows || []); setTotal(Number(data.total || 0)); }
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Falha ao carregar repasses.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, location.pathname, novo, page, revisionsPage, unlinksPage, canManage, corrigir]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (novo || corrigir) {
        const transactions = lines.map((line) => Object.fromEntries(Object.entries(line).map(([key, val]) => [key, key === 'provider_reference' ? val : Number(val)])));
        const report = { provider, payout_reference: reference, settlement_date: date, net_amount: Number(net), transactions };
        if (novo) {
          const result = await apiFetch<{ payout: Payout }>('/commerce/payments/payouts/import', { method: 'POST', body: JSON.stringify(report) });
          navigate(`${base}/${result.payout.id}`);
        } else {
          if (!payout) throw new Error('Atualize os dados do repasse.');
          const body = JSON.stringify({ expected_hash: payout.content_hash, reason, report });
          await apiFetch(`/commerce/payments/payouts/${id}/correct`, { method: 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
          navigate(`${base}/${id}`);
        }
      } else if (desvincular) {
        if (!payout) throw new Error('Atualize os dados do repasse.');
        const body = JSON.stringify({ bank_transaction_id: Number(payout.bank_transaction_id), reason });
        await apiFetch(`/commerce/payments/payouts/${id}/unlink`, { method: 'POST', headers: { 'Idempotency-Key': keyFor(body) }, body });
        navigate(`${base}/${id}`);
      } else {
        await apiFetch(`/commerce/payments/payouts/${id}/match`, { method: 'POST', body: JSON.stringify({ bank_transaction_id: Number(bankId) }) });
        navigate(`${base}/${id}`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao salvar.'); } finally { setBusy(false); }
  }
  if (!canManage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  const showReportForm = novo || (corrigir && payout && currentReport);
  return <div className="min-w-0 space-y-5">
    <PageHeader title={novo ? 'Importar relatório de repasse' : id ? `Repasse #${id}` : 'Repasses do provedor'} description="Evidência manual sobre pagamentos e extrato existentes; não movimenta caixa." />
    <PaymentNavigation />
    <Link className="text-sm text-blue-700 hover:underline" to={id && !detailView ? `${base}/${id}` : novo || id ? base : '/commerce/pagamentos/reconciliacao'}>← Voltar</Link>
    {error && <Alert tone="red">{error}</Alert>}{loading && !novo && <Spinner label="Carregando repasses…" />}
    {showReportForm ? <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted">{novo ? 'Transcreva valores efetivamente fornecidos pelo provedor. Valores são inteiros em centavos; nenhum arquivo ou layout é presumido.' : 'Corrija uma transcrição do mesmo repasse e das mesmas transações. O histórico anterior será preservado; nenhuma consulta ao provedor será feita.'}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label>Provedor<select className="input mt-1" disabled={corrigir} value={provider} onChange={(e) => setProvider(e.target.value)}><option>PAGBANK</option><option>MERCADO_PAGO</option><option>STRIPE</option></select></label>
        <label>Referência do repasse<input className="input mt-1" required maxLength={160} readOnly={corrigir} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label>Data de liquidação<input className="input mt-1" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Total líquido (centavos)<input className="input mt-1" type="number" min="0" step="1" required value={net} onChange={(e) => setNet(e.target.value)} /></label>
      </div>
      {lines.map((line, i) => <fieldset key={i} className="rounded-xl border border-line p-4"><legend className="px-2 font-semibold">Transação {i + 1}</legend><div className="grid gap-3 md:grid-cols-3">
        {fields.map(([key, label]) => <label key={key}>{label}<input className="input mt-1" required readOnly={corrigir && key === 'provider_reference'} type={key === 'provider_reference' ? 'text' : 'number'} min={key === 'provider_reference' ? undefined : '0'} step={key === 'provider_reference' ? undefined : '1'} value={line[key]} onChange={(e) => setLines((old) => old.map((v, n) => n === i ? { ...v, [key]: e.target.value } : v))} /></label>)}
      </div>{novo && lines.length > 1 && <button className="btn-secondary mt-3" type="button" onClick={() => setLines((old) => old.filter((_, n) => n !== i))}>Remover transação {i + 1}</button>}</fieldset>)}
      {corrigir && <label className="block">Justificativa da correção<textarea className="input mt-1" required minLength={8} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <div className="flex flex-wrap gap-2">{novo && <button className="btn-secondary" type="button" disabled={lines.length >= 1000} onClick={() => setLines((old) => [...old, emptyLine()])}>Adicionar transação</button>}<button className="btn-primary" disabled={busy}>{busy ? 'Salvando…' : novo ? 'Importar relatório' : 'Registrar correção'}</button></div>
    </form> : !novo && id ? <>
      {payout && <div className="space-y-3 rounded-xl border border-line p-4"><p><strong>{payout.provider}</strong> · {payout.payout_reference}</p><p>Data: {String(payout.settlement_date).slice(0, 10)} · Líquido: {grana(Number(payout.net_amount) / 100)} · Situação: {payout.status}</p><p>Extrato vinculado: {payout.bank_transaction_id || 'não vinculado'}</p>
        {detailView && <div className="flex flex-wrap gap-2">{payout.status === 'IMPORTED' && <Link className="btn-primary" to={`${base}/${id}/conciliar`}>Vincular ao extrato</Link>}{currentReport && <Link className="btn-secondary" to={`${base}/${id}/corrigir`}>Corrigir relatório</Link>}{payout.bank_transaction_id && <Link className="btn-secondary" to={`${base}/${id}/desvincular`}>Desvincular extrato</Link>}</div>}
        {payout.status === 'DIVERGENT' && <p className="text-red-700">Há divergências. O vínculo automático está bloqueado; revise os valores e o extrato.</p>}
        {!currentReport && <p className="text-red-700">Evidência original indisponível ou inconsistente; correção e desvinculação automáticas estão bloqueadas.</p>}
      </div>}
      {conciliar && <form className="space-y-3" onSubmit={submit}><p>Informe a linha de entrada já importada no extrato financeiro. O valor deve corresponder exatamente ao líquido deste repasse.</p><label>ID da transação do extrato<input className="input mt-1" type="number" min="1" step="1" required value={bankId} onChange={(e) => setBankId(e.target.value)} /></label><button className="btn-primary" disabled={busy}>{busy ? 'Conciliando…' : 'Confirmar vínculo'}</button></form>}
      {desvincular && payout && <form className="space-y-3" onSubmit={submit}><p>Desvincular a linha #{payout.bank_transaction_id} não altera o extrato nem estorna lançamentos financeiros.</p><label className="block">Justificativa<textarea className="input mt-1" required minLength={8} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label><button className="btn-primary" disabled={busy || !payout.bank_transaction_id || !currentReport}>{busy ? 'Salvando…' : 'Confirmar desvinculação'}</button></form>}
      {detailView && <><h2 className="font-semibold">Liquidações vinculadas</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Referência</th><th>Bruto interno</th><th>Bruto informado</th><th>Líquido informado</th><th>Situação</th></tr></thead><tbody>{settlements.map((r) => <tr key={r.id}><td>{r.provider_reference}</td><td>{grana(Number(r.gross_amount) / 100)}</td><td>{r.evidence?.provider_report ? grana(Number(r.evidence.provider_report.gross_amount) / 100) : '—'}</td><td>{grana(Number(r.net_amount) / 100)}</td><td>{r.status}</td></tr>)}</tbody></table></div>
        {revisions && <section className="space-y-2 rounded-xl border border-line p-4"><h2 className="font-semibold">Versões do relatório</h2>{revisions.rows.map((r) => <p className="break-words" key={r.id}>Versão {r.revision} · {dataHora(r.created_at)} · {r.reason} · hash {r.content_hash}</p>)}<Pagination label="versões" page={revisionsPage} total={revisions.total} size={revisions.pageSize} setPage={setRevisionsPage} /></section>}
        {unlinks && <section className="space-y-2 rounded-xl border border-line p-4"><h2 className="font-semibold">Desvinculações</h2>{unlinks.rows.map((r) => <p key={r.id}>Extrato #{r.bank_transaction_id} · {dataHora(r.created_at)} · {r.reason}</p>)}{!unlinks.rows.length && <p>Nenhuma desvinculação registrada.</p>}<Pagination label="desvinculações" page={unlinksPage} total={unlinks.total} size={unlinks.pageSize} setPage={setUnlinksPage} /></section>}
      </>}
    </> : !novo && !loading ? <>
      <Link className="btn-primary" to={`${base}/novo`}>Importar relatório</Link><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Repasse</th><th>Provedor</th><th>Data</th><th>Líquido</th><th>Situação</th><th>Ação</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.payout_reference}</td><td>{r.provider}</td><td>{String(r.settlement_date).slice(0, 10)}</td><td>{grana(Number(r.net_amount) / 100)}</td><td>{r.status}</td><td><Link className="text-blue-700 hover:underline" to={`${base}/${r.id}`}>Detalhes</Link></td></tr>)}{!rows.length && <tr><td colSpan={6}>Nenhum repasse encontrado.</td></tr>}</tbody></table></div><Pagination label="repasses" page={page} total={total} size={25} setPage={setPage} />
    </> : null}
  </div>;
}
function Pagination({ label, page, total, size, setPage }: { label: string; page: number; total: number; size: number; setPage: (n: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3"><button className="btn-secondary" aria-label={`Página anterior de ${label}`} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {total} registros</span><button className="btn-secondary" aria-label={`Próxima página de ${label}`} disabled={page * size >= total} onClick={() => setPage(page + 1)}>Próxima</button></div>;
}
