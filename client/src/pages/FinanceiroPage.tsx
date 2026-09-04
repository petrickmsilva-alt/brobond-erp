import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Coins, CreditCard, HandCoins, Plus, RefreshCw, Repeat, TrendingDown, TrendingUp, Wallet, CalendarClock, AlertTriangle } from 'lucide-react';
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
  vencimento: string | null;
  parcela: number;
  total_parcelas: number;
  referencia_tipo: string | null;
  referencia_id: number | null;
  atrasado?: boolean;
};

type ContaPendente = {
  id: number;
  tipo: 'venda' | 'compra';
  nome: string;
  valor: number;
  vencimento: string | null;
  parcelas: number;
  status: string;
  referencia_tipo: string;
  referencia_id: number;
};

type Recurrencia = {
  id: number;
  descricao: string;
  tipo: string;
  categoria: string;
  conta: string;
  valor: number;
  forma_pagamento: string | null;
  frequencia: string;
  dia: number;
  proxima_geracao: string | null;
  status: string;
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
  aReceber30: number;
  aPagar30: number;
  aReceberVencidas: number;
  aPagarVencidas: number;
  aReceberLista: ContaPendente[];
  aPagarLista: ContaPendente[];
  categorias: { categoria: string; receita: number; despesa: number; investimento: number }[];
  vendasPorCanal: { canal: string; valor: number }[];
  dre: { receita: number; cmv: number; mao_obra: number; despesas_operacionais: number; despesas_financeiras: number; impostos: number; investimentos: number };
  lucroBruto: number;
  resultadoOperacional: number;
  resultadoFinanceiro: number;
  resultadoGeral: number;
  recorrencias: Recurrencia[];
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
  const [gerando, setGerando] = useState(false);

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

  async function gerarRecorrencias() {
    setGerando(true);
    try {
      const r = await api.post<{ ok: boolean; gerados: number; descricoes: string[] }>('/financeiro/recorrencias/gerar', {});
      toast.success(r.gerados > 0 ? `${r.gerados} recorrência(s) gerada(s).` : 'Nenhuma recorrência pendente.');
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível gerar as recorrências.');
    } finally {
      setGerando(false);
    }
  }

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
            <Kpi icon={<CalendarClock className="h-5 w-5" />} label="Vencidos (rec. + pag.)" value={formatMoney(data.aReceberVencidas + data.aPagarVencidas)} tone="red" small />
          </div>

          {/* DRE gerencial */}
          <section className="card mt-4 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-navy-900">DRE gerencial — {data.mes}</h2>
                <p className="text-xs text-slate-400">Receita, custo, despesas e resultado do mês (lançamentos confirmados).</p>
              </div>
              <span className="badge !bg-navy-50 !text-navy-700">Base: livro financeiro</span>
            </div>
            <div className="grid gap-x-6 gap-y-1.5 px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <DreLinha label="Receita" value={data.dre.receita} tone="green" />
              <DreLinha label="Custo mercadoria/insumos (CMV)" value={-data.dre.cmv} tone="red" />
              <DreLinha label="Mão de obra / produção" value={-data.dre.mao_obra} tone="red" />
              <DreLinha label="Despesas operacionais" value={-data.dre.despesas_operacionais} tone="red" />
              <DreLinha label="Impostos" value={-data.dre.impostos} tone="red" />
              <DreLinha label="Despesas financeiras" value={-data.dre.despesas_financeiras} tone="red" />
              <DreLinha label="Lucro bruto" value={data.lucroBruto} tone={data.lucroBruto >= 0 ? 'green' : 'red'} bold />
              <DreLinha label="Resultado operacional" value={data.resultadoOperacional} tone={data.resultadoOperacional >= 0 ? 'green' : 'red'} bold />
              <DreLinha label="Resultado financeiro" value={data.resultadoFinanceiro} tone={data.resultadoFinanceiro >= 0 ? 'green' : 'red'} bold />
              <DreLinha label="Investimentos (aporte)" value={data.dre.investimentos} tone="blue" />
            </div>
            <div className="border-t border-slate-200 px-4 py-3 text-right text-sm">
              <span className="mr-2 font-semibold text-slate-500">Resultado geral do mês</span>
              <span className={`text-base font-bold tabular-nums ${data.resultadoGeral >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(data.resultadoGeral)}</span>
            </div>
          </section>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Agenda 30 dias */}
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <AlertTriangle className="h-4 w-4 text-red-500" /> Agenda 30 dias
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">Vencidos, próximos e contas em aberto.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <AgendaKpi label="A receber" valor={data.aReceber30} tone={data.aReceber30 >= 0 ? 'green' : 'red'} />
                <AgendaKpi label="A pagar (30d)" valor={data.aPagar30} tone="red" />
                <AgendaKpi label="Receb. vencidos" valor={data.aReceberVencidas} tone="red" />
                <AgendaKpi label="Pag. vencidos" valor={data.aPagarVencidas} tone="red" />
              </div>
              <ul className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-500">
                {(data.aReceberLista.length === 0 && data.aPagarLista.length === 0) && <li className="text-slate-400">Nenhuma conta em aberto.</li>}
                {data.aPagarLista.slice(0, 5).map((l) => (
                  <li key={`p-${l.id}`} className="flex justify-between">
                    <span className="truncate pr-2">▸ {l.nome} {l.parcelas > 1 ? `(${l.parcelas}x)` : ''}</span>
                    <span className={l.vencimento && l.vencimento < data.mes ? 'text-red-600' : ''}>{formatMoney(l.valor)}</span>
                  </li>
                ))}
                {data.aReceberLista.slice(0, 5).map((l) => (
                  <li key={`r-${l.id}`} className="flex justify-between">
                    <span className="truncate pr-2">◂ {l.nome} {l.parcelas > 1 ? `(${l.parcelas}x)` : ''}</span>
                    <span className={`${l.vencimento && l.vencimento < data.mes ? 'text-red-600' : ''} text-emerald-600`}>{formatMoney(l.valor)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Link to="/vendas" className="btn-secondary flex-1 justify-center">Vendas</Link>
                <Link to="/compras" className="btn-secondary flex-1 justify-center">Compras</Link>
              </div>
            </section>

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

            {/* Recorrências */}
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Repeat className="h-4 w-4 text-navy-500" /> Recorrências
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">Aluguel, energia, folha, facção, assinaturas.</p>
              <div className="mt-3 space-y-2">
                {data.recorrencias.length === 0 && <p className="text-xs text-slate-400">Nenhuma recorrência cadastrada.</p>}
                {data.recorrencias.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-900">{r.descricao}</p>
                      <p className="text-[11px] text-slate-400">{r.frequencia} · próxima {r.proxima_geracao || '—'}</p>
                    </div>
                    <span className={`shrink-0 text-sm font-bold tabular-nums ${r.tipo === 'despesa' ? 'text-red-600' : 'text-emerald-600'}`}>{formatMoney(r.valor)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Link to="/recorrencias-financeiras" className="btn-secondary flex-1 justify-center">Gerenciar</Link>
                <button className="btn-secondary flex-1 justify-center" onClick={gerarRecorrencias} disabled={gerando}>
                  <RefreshCw className={`h-4 w-4 ${gerando ? 'animate-spin' : ''}`} /> Gerar
                </button>
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

function DreLinha({ label, value, tone, bold }: { label: string; value: number; tone: 'green' | 'red' | 'blue'; bold?: boolean }) {
  const color = tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : 'text-blue-600';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
      <span className="min-w-0 truncate text-xs text-slate-500">{label}</span>
      <span className={`shrink-0 tabular-nums ${bold ? 'text-sm font-bold' : 'text-[13px] font-semibold'} ${color}`}>{formatMoney(value)}</span>
    </div>
  );
}

function AgendaKpi({ label, valor, tone }: { label: string; valor: number; tone: 'green' | 'red' | 'amber' }) {
  const color = tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : 'text-amber-600';
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className={`text-base font-bold tabular-nums ${color}`}>{formatMoney(valor)}</p>
      <p className="text-[10px] text-slate-400">{label}</p>
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
