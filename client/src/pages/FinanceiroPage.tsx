import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Coins, CreditCard, HandCoins, Plus, RefreshCw, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../components/ui';

type Lanc = {
  id: number;
  data: string;
  tipo: 'receita' | 'despesa' | 'investimento' | 'estorno';
  descricao: string;
  status: 'confirmado' | 'pendente' | 'cancelado';
  valor: number;
  categoria: string;
  conta: string;
  referencia_tipo: string | null;
  referencia_id: number | null;
};

type Resumo = {
  mes: string;
  saldoContas: { conta_id: number; nome: string; tipo: string; saldo: number }[];
  saldoContasTotal: number;
  receitasMes: number;
  despesasMes: number;
  investimentosMes: number;
  resultadoOperacionalMes: number;
  resultadoCaixaMes: number;
  aReceber: number;
  aPagar: number;
  categorias: { categoria: string; receita: number; despesa: number; investimento: number }[];
  vendasPorCanal: { canal: string; valor: number }[];
  recentes: Lanc[];
  contasTotal: number;
  aportesTotal: number;
};

const CANAL_LABEL: Record<string, string> = {
  balcao: 'Balcão',
  representante: 'Representante',
  whatsapp: 'WhatsApp',
  site_varejo: 'Site varejo',
  site_atacado: 'Site atacado',
  marketplace: 'Marketplace',
};

export default function FinanceiroPage() {
  const toast = useToast();
  const [data, setData] = useState<Resumo | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const d = await api.get<Resumo>('/financeiro/resumo');
      setData(d);
    } catch (e: any) {
      setErr(e.message || 'Erro ao carregar o financeiro.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pos = (v: number) => (v >= 0 ? 'text-emerald-600' : 'text-red-600');

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Wallet className="h-5 w-5" />
            </span>
            Financeiro
          </span>
        }
        description="Fluxo de caixa, receitas, despesas, custos, contas a receber/pagar e aportes de investidores."
        actions={
          <>
            <button className="btn-secondary" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            <Link to="/lancamentos" className="btn-secondary">
              <Coins className="h-4 w-4" />
              <span className="hidden sm:inline">Lançamentos</span>
            </Link>
            <Link to="/aportes" className="btn-accent">
              <HandCoins className="h-4 w-4" /> Aportes
            </Link>
          </>
        }
      />

      {err && (
        <div className="mb-4">
          <Alert tone="red">{err}</Alert>
        </div>
      )}
      {loading && !data && <Spinner />}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={<Wallet className="h-5 w-5" />} label="Saldo em contas" value={formatMoney(data.saldoContasTotal)} tone={pos(data.saldoContasTotal).replace('text-', '')} />
            <Kpi icon={<TrendingUp className="h-5 w-5" />} label="Receitas no mês" value={formatMoney(data.receitasMes)} tone="emerald" />
            <Kpi icon={<TrendingDown className="h-5 w-5" />} label="Despesas no mês" value={formatMoney(data.despesasMes)} tone="red" />
            <Kpi icon={<CreditCard className="h-5 w-5" />} label="Resultado operacional do mês" value={formatMoney(data.resultadoOperacionalMes)} tone={data.resultadoOperacionalMes >= 0 ? 'emerald' : 'red'} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={<ArrowUpRight className="h-5 w-5" />} label="A receber" value={formatMoney(data.aReceber)} tone="amber" small />
            <Kpi icon={<ArrowDownRight className="h-5 w-5" />} label="A pagar" value={formatMoney(data.aPagar)} tone="amber" small />
            <Kpi icon={<HandCoins className="h-5 w-5" />} label="Aportes confirmados" value={formatMoney(data.aportesTotal)} tone="blue" small />
            <Kpi icon={<Coins className="h-5 w-5" />} label="Entradas investimento (mês)" value={formatMoney(data.investimentosMes)} tone="blue" small />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Fluxo por categoria */}
            <section className="card p-4">
              <h2 className="text-sm font-bold text-navy-900">Fluxo por categoria</h2>
              <p className="mt-0.5 text-xs text-slate-400">Lançamentos confirmados (acumulado)</p>
              <div className="mt-3 space-y-2">
                {data.categorias.length === 0 && <p className="text-xs text-slate-400">Nenhum lançamento ainda.</p>}
                {data.categorias.map((c) => (
                  <div key={c.categoria} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-900">{c.categoria}</p>
                      <p className="text-[11px] text-slate-400">Entradas {formatMoney(c.receita + c.investimento)} · Saídas {formatMoney(c.despesa)}</p>
                    </div>
                    <span className={`shrink-0 text-sm font-bold tabular-nums ${c.despesa > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {formatMoney(c.despesa > 0 ? -c.despesa : c.receita + c.investimento)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Vendas por canal */}
            <section className="card p-4">
              <h2 className="text-sm font-bold text-navy-900">Vendas faturadas por canal</h2>
              <p className="mt-0.5 text-xs text-slate-400">No mês atual</p>
              <div className="mt-3 space-y-2">
                {data.vendasPorCanal.length === 0 && <p className="text-xs text-slate-400">Ainda não há vendas faturadas no mês.</p>}
                {data.vendasPorCanal.map((c) => (
                  <div key={c.canal} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                    <span className="text-sm text-slate-700">{CANAL_LABEL[c.canal] || c.canal}</span>
                    <span className="text-sm font-semibold tabular-nums text-emerald-600">{formatMoney(c.valor)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Link to="/vendas" className="btn-secondary flex-1 justify-center">Ver vendas</Link>
                <Link to="/catalogos" className="btn-secondary flex-1 justify-center">Catálogos</Link>
              </div>
            </section>

            {/* Saldo por conta */}
            <section className="card p-4">
              <h2 className="text-sm font-bold text-navy-900">Saldo por conta</h2>
              <p className="mt-0.5 text-xs text-slate-400">{data.contasTotal} conta(s) ativa(s)</p>
              <div className="mt-3 space-y-2">
                {data.saldoContas.length === 0 && <p className="text-xs text-slate-400">Cadastre uma conta financeira para acompanhar o caixa.</p>}
                {data.saldoContas.map((c) => (
                  <div key={c.conta_id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-900">{c.nome}</p>
                      <p className="text-[11px] capitalize text-slate-400">{c.tipo}</p>
                    </div>
                    <span className={`text-sm font-semibold tabular-nums ${c.saldo >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(c.saldo)}</span>
                  </div>
                ))}
              </div>
              <Link to="/contas-financeiras" className="btn-secondary mt-3 w-full justify-center">Gerenciar contas</Link>
            </section>
          </div>

          {/* Últimos lançamentos */}
          <section className="card mt-4 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-navy-900">Últimos lançamentos</h2>
                <p className="text-xs text-slate-400">Livro-caixa integrado a vendas, compras, custos e aportes.</p>
              </div>
              <Link to="/lancamentos" className="btn-secondary">
                <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Novo lançamento</span>
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Descrição</th>
                    <th className="hidden md:table-cell">Categoria</th>
                    <th className="hidden lg:table-cell">Conta</th>
                    <th className="text-right">Valor</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentes.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-sm text-slate-400">
                        Nenhum lançamento financeiro no sistema. Inclua vendas, compras, custos ou um aporte.
                      </td>
                    </tr>
                  )}
                  {data.recentes.slice(0, 20).map((l) => (
                    <tr key={l.id}>
                      <td className="whitespace-nowrap text-xs text-slate-500">{l.data}</td>
                      <td className="max-w-[260px] truncate font-medium text-navy-900">{l.descricao}</td>
                      <td className="hidden text-sm text-slate-600 md:table-cell">{l.categoria}</td>
                      <td className="hidden text-sm text-slate-500 lg:table-cell">{l.conta}</td>
                      <td className={`text-right font-semibold tabular-nums ${l.tipo === 'despesa' ? 'text-red-600' : 'text-emerald-600'}`}>
                        {l.tipo === 'despesa' ? '−' : '+'} {formatMoney(l.valor)}
                      </td>
                      <td>
                        <Badge tone={l.status === 'confirmado' ? 'green' : l.status === 'pendente' ? 'amber' : 'red'}>{l.status === 'confirmado' ? 'Confirmado' : l.status === 'pendente' ? 'Pendente' : 'Cancelado'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, tone, small }: { icon: React.ReactNode; label: string; value: string; tone?: string; small?: boolean }) {
  const tint = tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : tone === 'red' ? 'bg-red-50 text-red-600' : tone === 'amber' ? 'bg-amber-50 text-amber-600' : tone === 'blue' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-600';
  return (
    <div className="card p-4">
      <div className={`mb-2 inline-flex h-9 w-9 items-center justify-center rounded-lg ${tint}`}>{icon}</div>
      <p className={`font-semibold tabular-nums ${small ? 'text-lg' : 'text-2xl'}`}>{value}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  );
}
