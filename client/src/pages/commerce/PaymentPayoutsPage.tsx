import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
import { Alert, PageHeader } from '../../components/ui';
import { PaymentNavigation } from './PaymentNavigation';
import { useAuth } from '../../auth/AuthContext';
import { grana } from './shared';

type Line = { provider_reference: string; gross_amount: string; provider_fee: string; gateway_fee: string; installment_fee: string; antifraud_fee: string; refund_amount: string; chargeback_amount: string; net_amount: string };
const emptyLine = (): Line => ({ provider_reference: '', gross_amount: '', provider_fee: '0', gateway_fee: '0', installment_fee: '0', antifraud_fee: '0', refund_amount: '0', chargeback_amount: '0', net_amount: '' });
const fields: [keyof Line, string][] = [['provider_reference', 'Referência da transação'], ['gross_amount', 'Bruto (centavos)'], ['provider_fee', 'Taxa do provedor'], ['gateway_fee', 'Taxa de gateway'], ['installment_fee', 'Taxa de parcelas'], ['antifraud_fee', 'Taxa antifraude'], ['refund_amount', 'Reembolso'], ['chargeback_amount', 'Chargeback'], ['net_amount', 'Líquido (centavos)']];
const base = '/commerce/pagamentos/repasses';
export default function PaymentPayoutsPage() {
  const { id } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const { user } = useAuth(); const canManage = ['admin', 'gerente'].includes(user?.perfil || '');
  const novo = location.pathname.endsWith('/novo'); const conciliar = location.pathname.endsWith('/conciliar');
  const [rows, setRows] = useState<any[]>([]); const [payout, setPayout] = useState<any>(null); const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('PAGBANK'); const [reference, setReference] = useState(''); const [date, setDate] = useState(''); const [net, setNet] = useState(''); const [lines, setLines] = useState<Line[]>([emptyLine()]); const [bankId, setBankId] = useState('');
  useEffect(() => {
    if (novo || !canManage) return;
    const controller = new AbortController();
    setError('');
    const path = id ? `/commerce/payments/payouts/${id}` : `/commerce/payments/payouts?page=${page}&pageSize=25`;
    apiFetch<any>(path, { signal: controller.signal }).then((data) => {
      if (id) { setPayout(data.payout); setRows(data.settlements || []); }
      else { setRows(data.rows || []); setTotal(Number(data.total || 0)); }
    }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Falha ao carregar repasses.'); });
    return () => controller.abort();
  }, [id, novo, page, canManage]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (novo) {
        const transactions = lines.map((line) => Object.fromEntries(Object.entries(line).map(([key, val]) => [key, key === 'provider_reference' ? val : Number(val)])));
        const result = await apiFetch<any>('/commerce/payments/payouts/import', { method: 'POST', body: JSON.stringify({ provider, payout_reference: reference, settlement_date: date, net_amount: Number(net), transactions }) });
        navigate(`${base}/${result.payout.id}`);
      } else {
        await apiFetch(`/commerce/payments/payouts/${id}/match`, { method: 'POST', body: JSON.stringify({ bank_transaction_id: Number(bankId) }) });
        navigate(`${base}/${id}`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha ao salvar.'); } finally { setBusy(false); }
  }
  if (!canManage) return <Alert tone="red">Acesso restrito a gerentes e administradores.</Alert>;
  return <div className="space-y-5">
    <PageHeader title={novo ? 'Importar relatório de repasse' : id ? `Repasse #${id}` : 'Repasses do provedor'} description="Evidência manual sobre pagamentos e extrato existentes; não movimenta caixa." />
    <PaymentNavigation />
    <Link className="text-sm text-blue-700 hover:underline" to={novo || id ? base : '/commerce/pagamentos/reconciliacao'}>← Voltar</Link>
    {error && <Alert tone="red">{error}</Alert>}
    {novo ? <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted">Transcreva valores efetivamente fornecidos pelo provedor. Valores são inteiros em centavos; nenhum arquivo ou layout é presumido.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label>Provedor<select className="input mt-1" value={provider} onChange={(e) => setProvider(e.target.value)}><option>PAGBANK</option><option>MERCADO_PAGO</option><option>STRIPE</option></select></label>
        <label>Referência do repasse<input className="input mt-1" required maxLength={160} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label>Data de liquidação<input className="input mt-1" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Total líquido (centavos)<input className="input mt-1" type="number" min="0" step="1" required value={net} onChange={(e) => setNet(e.target.value)} /></label>
      </div>
      {lines.map((line, i) => <fieldset key={i} className="rounded-xl border border-line p-4"><legend className="px-2 font-semibold">Transação {i + 1}</legend><div className="grid gap-3 md:grid-cols-3">
        {fields.map(([key, label]) => <label key={key}>{label}<input className="input mt-1" required type={key === 'provider_reference' ? 'text' : 'number'} min={key === 'provider_reference' ? undefined : '0'} step={key === 'provider_reference' ? undefined : '1'} value={line[key]} onChange={(e) => setLines((old) => old.map((v, n) => n === i ? { ...v, [key]: e.target.value } : v))} /></label>)}
      </div>{lines.length > 1 && <button className="btn-secondary mt-3" type="button" onClick={() => setLines((old) => old.filter((_, n) => n !== i))}>Remover transação {i + 1}</button>}</fieldset>)}
      <div className="flex flex-wrap gap-2"><button className="btn-secondary" type="button" disabled={lines.length >= 1000} onClick={() => setLines((old) => [...old, emptyLine()])}>Adicionar transação</button><button className="btn-primary" disabled={busy}>{busy ? 'Importando…' : 'Importar relatório'}</button></div>
    </form> : id ? <>
      {payout && <div className="space-y-3 rounded-xl border border-line p-4"><p><strong>{payout.provider}</strong> · {payout.payout_reference}</p><p>Data: {String(payout.settlement_date).slice(0, 10)} · Líquido: {grana(Number(payout.net_amount) / 100)} · Situação: {payout.status}</p><p>Extrato vinculado: {payout.bank_transaction_id || 'não vinculado'}</p>
        {!conciliar && payout.status === 'IMPORTED' && <Link className="btn-primary" to={`${base}/${id}/conciliar`}>Vincular ao extrato</Link>}
        {payout.status === 'DIVERGENT' && <p className="text-red-700">Há divergências. A vinculação automática fica bloqueada; requer revisão operacional.</p>}
      </div>}
      {conciliar && <form className="space-y-3" onSubmit={submit}><p>Informe a linha de entrada já importada no extrato financeiro. O valor deve corresponder exatamente ao líquido deste repasse.</p><label>ID da transação do extrato<input className="input mt-1" type="number" min="1" step="1" required value={bankId} onChange={(e) => setBankId(e.target.value)} /></label><button className="btn-primary" disabled={busy}>{busy ? 'Conciliando…' : 'Confirmar vínculo'}</button></form>}
      <h2 className="font-semibold">Liquidações vinculadas</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Referência</th><th>Bruto interno</th><th>Bruto informado</th><th>Líquido informado</th><th>Situação</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.provider_reference}</td><td>{grana(Number(r.gross_amount) / 100)}</td><td>{r.evidence?.provider_report ? grana(Number(r.evidence.provider_report.gross_amount) / 100) : "—"}</td><td>{grana(Number(r.net_amount) / 100)}</td><td>{r.status}</td></tr>)}</tbody></table></div>
    </> : <>
      <Link className="btn-primary" to={`${base}/novo`}>Importar relatório</Link><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Repasse</th><th>Provedor</th><th>Data</th><th>Líquido</th><th>Situação</th><th>Ação</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.payout_reference}</td><td>{r.provider}</td><td>{String(r.settlement_date).slice(0, 10)}</td><td>{grana(Number(r.net_amount) / 100)}</td><td>{r.status}</td><td><Link className="text-blue-700 hover:underline" to={`${base}/${r.id}`}>Detalhes</Link></td></tr>)}{!rows.length && <tr><td colSpan={6}>Nenhum repasse encontrado.</td></tr>}</tbody></table></div><div className="flex gap-3"><button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><span>Página {page} · {total} registros</span><button className="btn-secondary" disabled={page * 25 >= total} onClick={() => setPage(page + 1)}>Próxima</button></div>
    </>}
  </div>;
}
