import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BarChart3, Eye, Link2, Link2Off, RefreshCw, ShoppingBag, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { Alert, Badge, useToast } from './ui';

type Insight = {
  periodo_dias: number;
  resumo: { enviados: number; visualizados: number; convertidos: number; taxa_abertura: number; taxa_conversao: number; produtos_visualizados: number; carrinhos_iniciados: number; valor_solicitado: number };
  recentes: { id: number; catalogo: string; cliente: string; vendedor: string; canal: string; criado_em: string; expira_em: string | null; primeiro_acesso_em: string | null; ultimo_acesso_em: string | null; acessos: number; status: 'ativo' | 'expirado' | 'revogado' }[];
};

const statusTone = { ativo: 'green', expirado: 'amber', revogado: 'red' } as const;

export default function CatalogoInsights() {
  const toast = useToast();
  const [dias, setDias] = useState(30);
  const [data, setData] = useState<Insight | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setErro('');
    try { setData(await api.get<Insight>(`/catalogos/inteligencia?dias=${dias}`)); }
    catch (e) { setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os indicadores.'); }
    finally { setBusy(false); }
  }, [dias]);
  useEffect(() => { load(); }, [load]);

  async function revogar(id: number) {
    if (!window.confirm('Revogar este link? O cliente perderá o acesso imediatamente.')) return;
    try { await api.post(`/catalogos/compartilhamentos/${id}/revogar`, {}); toast.success('Link revogado.'); await load(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'Não foi possível revogar o link.'); }
  }

  const r = data?.resumo;
  return (
    <section className="mb-4 space-y-3" aria-label="Inteligência comercial dos catálogos">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="flex items-center gap-2 text-sm font-bold text-navy-900"><BarChart3 className="h-4 w-4 text-brand-600" /> Funil dos catálogos</h2><p className="text-xs text-slate-400">Links individuais e conversão comercial.</p></div>
        <div className="flex gap-2"><select className="input !py-1.5 text-xs" value={dias} onChange={(e) => setDias(Number(e.target.value))}><option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option><option value={365}>12 meses</option></select><button className="btn-icon" onClick={load} disabled={busy} aria-label="Atualizar indicadores"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /></button></div>
      </div>
      {erro && <Alert tone="red">{erro}</Alert>}
      {r && <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Kpi icon={<Link2 />} label="Enviados" valor={r.enviados} detalhe="links individuais" />
          <Kpi icon={<Eye />} label="Visualizados" valor={r.visualizados} detalhe={`${r.taxa_abertura}% de abertura`} />
          <Kpi icon={<Users />} label="Carrinhos" valor={r.carrinhos_iniciados} detalhe={`${r.produtos_visualizados} produtos vistos`} />
          <Kpi icon={<ShoppingBag />} label="Convertidos" valor={r.convertidos} detalhe={`${r.taxa_conversao}% de conversão`} />
          <Kpi icon={<BarChart3 />} label="Valor solicitado" valor={formatMoney(r.valor_solicitado)} detalhe="cotações originadas" />
        </div>
        <div className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-2.5"><h3 className="text-sm font-bold text-navy-900">Compartilhamentos recentes</h3></div>
          {data!.recentes.length === 0 ? <p className="px-4 py-8 text-center text-sm text-slate-400">Nenhum link individual no período.</p> : <div className="overflow-x-auto"><table className="table text-xs"><thead><tr><th>Cliente / catálogo</th><th>Responsável</th><th>Canal</th><th>Acessos</th><th>Último acesso</th><th>Status</th><th></th></tr></thead><tbody>{data!.recentes.map((x) => <tr key={x.id}><td><div className="font-semibold text-navy-900">{x.cliente}</div><div className="text-slate-400">{x.catalogo} · {formatDateTime(x.criado_em)}</div></td><td>{x.vendedor}</td><td className="capitalize">{x.canal}</td><td className="tabular-nums">{x.acessos}</td><td>{x.ultimo_acesso_em ? formatDateTime(x.ultimo_acesso_em) : 'Ainda não abriu'}</td><td><Badge tone={statusTone[x.status]}>{x.status}</Badge></td><td>{x.status === 'ativo' && <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => revogar(x.id)} title="Revogar link" aria-label="Revogar link"><Link2Off className="h-4 w-4" /></button>}</td></tr>)}</tbody></table></div>}
        </div>
      </>}
    </section>
  );
}

function Kpi({ icon, label, valor, detalhe }: { icon: ReactNode; label: string; valor: ReactNode; detalhe: string }) {
  return <div className="card flex items-center gap-3 p-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-600 [&>svg]:h-4 [&>svg]:w-4">{icon}</span><div className="min-w-0"><div className="truncate text-lg font-bold tabular-nums text-navy-900">{valor}</div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="truncate text-[10px] text-slate-400">{detalhe}</div></div></div>;
}
