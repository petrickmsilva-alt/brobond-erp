import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownRight, ArrowRightLeft, ArrowUpRight, CalendarClock, Coins, CreditCard, Download, HandCoins, Landmark, LineChart, Plus, RefreshCw, Repeat, ScanLine, TrendingDown, TrendingUp, Users, Wallet } from 'lucide-react';
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
  tipo: string;
  nome: string;
  valor: number;
  vencimento: string | null;
  parcelas: number;
  total_parcelas?: number;
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

type FluxoLinha = { periodo: string; label: string; entradas: number; saidas: number; liquido: number; acumulado: number };
type FluxoProjetado = { saldoBase: number; semanal: FluxoLinha[]; mensal: FluxoLinha[] };
type RentabilidadeItem = { produto: string; receita: number; cmv: number; margem: number; margem_pct: number; quantidade: number };
type Rentabilidade = { receitaTotal: number; cmvTotal: number; margemTotal: number; margemPctTotal: number; quantidadeTotal: number; porProduto: RentabilidadeItem[]; porCanal: RentabilidadeItem[] };
type InvestidorResumo = { id: number; nome: string; tipo: string; participacao_pct: number; totalAportado: number; totalDistribuido: number; posicao: number; quantidadeAportes: number; ultimoAporte: string | null };
type InvestidoresResumo = { totalInvestido: number; totalDistribuido: number; aportesNoMes: number; porInvestidor: InvestidorResumo[] };
type ConciliacaoResult = { ok: boolean; totalLinhas: number; confirmados: { data: string; valor: number; descricao: string; lancamento_id: number }[]; naoConfirmados: { data: string; valor: number; descricao: string; motivo: string }[] };

type Resumo = {
  mes: string;
  saldoContas: { conta_id: number; nome: string; tipo: string; saldo: number; previsto: number }[];
  saldoContasTotal: number;
  receitasMes: number;
  despesasMes: number;
  investimentosMes: number;
  taxasMes: number;
  semaforo: { status: 'verde' | 'amarelo' | 'vermelho'; minAcumulado: number; periodo: string | null };
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
  agingReceber: { faixas: { a_vencer: number; vencido_1_30: number; vencido_31_60: number; vencido_61_90: number; vencido_90_mais: number }; clientes: { nome: string; total: number; vencido: number }[] };
  categorias: { categoria: string; receita: number; despesa: number; investimento: number }[];
  porCentroCusto: { centro: string; receita: number; despesa: number; investimento: number }[];
  vendasPorCanal: { canal: string; valor: number }[];
  dre: { receita: number; cmv: number; mao_obra: number; despesas_operacionais: number; despesas_financeiras: number; receitas_financeiras: number; impostos: number; investimentos: number; taxas_operadoras: number };
  lucroBruto: number;
  resultadoOperacional: number;
  resultadoFinanceiro: number;
  resultadoGeral: number;
  recorrencias: Recurrencia[];
  fluxoProjetado: FluxoProjetado;
  recentes: Lanc[];
  contasTotal: number;
  aportesTotal: number;
};

const TABS = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'receberpagar', label: 'A receber / pagar' },
  { id: 'dre', label: 'DRE' },
  { id: 'fluxo', label: 'Fluxo projetado' },
  { id: 'rentabilidade', label: 'Rentabilidade' },
  { id: 'investidores', label: 'Investidores' },
  { id: 'conciliacao', label: 'Conciliação' },
];

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
  const [rentab, setRentab] = useState<Rentabilidade | null>(null);
  const [investidores, setInvestidores] = useState<InvestidoresResumo | null>(null);
  const [tab, setTab] = useState('visao');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [concTexto, setConcTexto] = useState('');
  const [conciliando, setConciliando] = useState(false);
  const [concResult, setConcResult] = useState<ConciliacaoResult | null>(null);
  const [baixaAlvo, setBaixaAlvo] = useState<{ lanc: ContaPendente; lado: 'receita' | 'despesa' } | null>(null);
  const [baixaForm, setBaixaForm] = useState({ data: '', conta_id: '', forma_pagamento: '', juros: '', multa: '', desconto: '' });
  const [baixando, setBaixando] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [d, r, i] = await Promise.all([
        api.get<Resumo>('/financeiro/resumo'),
        api.get<Rentabilidade>('/financeiro/rentabilidade'),
        api.get<InvestidoresResumo>('/financeiro/investidores'),
      ]);
      setData(d);
      setRentab(r);
      setInvestidores(i);
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

  /** Abre a baixa: receber (receita) ou pagar (despesa) um título pendente. */
  function abrirBaixa(lanc: ContaPendente, lado: 'receita' | 'despesa') {
    setBaixaAlvo({ lanc, lado });
    setBaixaForm({ data: new Date().toISOString().slice(0, 10), conta_id: '', forma_pagamento: '', juros: '', multa: '', desconto: '' });
  }

  async function confirmarBaixa() {
    if (!baixaAlvo) return;
    const num = (s: string) => Number(String(s).replace(',', '.')) || 0;
    setBaixando(true);
    try {
      await api.post(`/financeiro/lancamentos/${baixaAlvo.lanc.id}/baixar`, {
        data: baixaForm.data || undefined,
        conta_id: baixaForm.conta_id ? Number(baixaForm.conta_id) : undefined,
        forma_pagamento: baixaForm.forma_pagamento || undefined,
        juros: num(baixaForm.juros),
        multa: num(baixaForm.multa),
        desconto: num(baixaForm.desconto),
      });
      toast.success(baixaAlvo.lado === 'receita' ? 'Recebimento baixado.' : 'Pagamento baixado.');
      setBaixaAlvo(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível dar baixa.');
    } finally {
      setBaixando(false);
    }
  }

  async function conciliar() {
    setConciliando(true);
    setConcResult(null);
    try {
      const r = await api.post<ConciliacaoResult>('/financeiro/conciliacao', { texto: concTexto });
      setConcResult(r);
      toast.success(r.confirmados.length > 0 ? `${r.confirmados.length} lançamento(s) conciliado(s).` : 'Nenhum lançamento conciliado.');
      if (r.confirmados.length > 0) await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível conciliar o extrato.');
    } finally {
      setConciliando(false);
    }
  }

  /** Exporta o resultado da conciliação em CSV (abre no Excel). */
  function exportarConciliacao() {
    if (!concResult) return;
    const linhas = [
      'Situação;Data;Valor;Descrição;Observação',
      ...concResult.confirmados.map((l) => `Conciliado;${l.data};${String(l.valor).replace('.', ',')};${l.descricao};Lançamento #${l.lancamento_id}`),
      ...concResult.naoConfirmados.map((l) => `Pendente;${l.data};${String(l.valor).replace('.', ',')};${l.descricao};${l.motivo}`),
    ];
    const blob = new Blob([`\uFEFF${linhas.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conciliacao-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
        description="Visão executiva do caixa e indicadores financeiros. Detalhes por aba."
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
            <Link to="/transferencias" className="btn-secondary" title="Mover dinheiro entre contas (Caixa → Banco Inter, Mercado Pago → Banco Inter)">
              <ArrowRightLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Transferir</span>
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
          {/* Tabs — mantém a página limpa; cada assunto tem seu lugar */}
          <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${tab === t.id ? 'bg-navy-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ---------------- VISÃO GERAL ---------------- */}
          {tab === 'visao' && (
            <>
              {data.semaforo && data.semaforo.status !== 'verde' && (
                <div className="mb-4">
                  <Alert tone={data.semaforo.status === 'vermelho' ? 'red' : 'amber'}>
                    {data.semaforo.status === 'vermelho'
                      ? `Atenção: a projeção de caixa fica NEGATIVA em ${formatMoney(data.semaforo.minAcumulado)}${data.semaforo.periodo ? ` na ${data.semaforo.periodo.toLowerCase()}` : ''}. Antecipe recebíveis ou renegocie pagamentos.`
                      : `Caixa apertado à frente: o acumulado projetado cai para ${formatMoney(data.semaforo.minAcumulado)}${data.semaforo.periodo ? ` na ${data.semaforo.periodo.toLowerCase()}` : ''} — queda de mais de 30% sobre o saldo atual.`}
                  </Alert>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi icon={<Wallet className="h-5 w-5" />} label="Saldo em contas" value={formatMoney(data.saldoContasTotal)} tone={pos(data.saldoContasTotal).replace('text-', '')} />
                <Kpi icon={<TrendingUp className="h-5 w-5" />} label="Receitas no mês" value={formatMoney(data.receitasMes)} tone="emerald" />
                <Kpi icon={<TrendingDown className="h-5 w-5" />} label="Despesas no mês" value={formatMoney(data.despesasMes)} tone="red" />
                <Kpi icon={<CreditCard className="h-5 w-5" />} label="Resultado do mês" value={formatMoney(data.resultadoOperacionalMes)} tone={data.resultadoOperacionalMes >= 0 ? 'emerald' : 'red'} />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Kpi icon={<ArrowUpRight className="h-5 w-5" />} label="A receber" value={formatMoney(data.aReceber)} tone="amber" small />
                <Kpi icon={<ArrowDownRight className="h-5 w-5" />} label="A pagar" value={formatMoney(data.aPagar)} tone="amber" small />
                <Kpi icon={<CreditCard className="h-5 w-5" />} label="Taxas MP/cartão (mês)" value={formatMoney(data.taxasMes || 0)} tone="red" small />
                <Kpi icon={<HandCoins className="h-5 w-5" />} label="Aportes confirmados" value={formatMoney(data.aportesTotal)} tone="blue" small />
                <Kpi icon={<CalendarClock className="h-5 w-5" />} label="Vencidos" value={formatMoney(data.aReceberVencidas + data.aPagarVencidas)} tone="red" small />
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <section className="card p-4">
                  <h2 className="text-sm font-bold text-navy-900">Saldo por conta</h2>
                  <div className="mt-3 space-y-2">
                    {data.saldoContas.length === 0 && <p className="text-xs text-slate-400">Cadastre uma conta financeira.</p>}
                    {data.saldoContas.map((c) => (
                      <div key={c.conta_id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-navy-900">{c.nome}</p>
                          <p className="text-[11px] capitalize text-slate-400">
                            {c.tipo}
                            {c.previsto !== undefined && c.previsto !== c.saldo && (
                              <span className={c.previsto >= 0 ? 'text-slate-400' : 'text-red-500'}> · previsto {formatMoney(c.previsto)}</span>
                            )}
                          </p>
                        </div>
                        <span className={`text-sm font-semibold tabular-nums ${c.saldo >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(c.saldo)}</span>
                      </div>
                    ))}
                  </div>
                  <Link to="/contas-financeiras" className="btn-secondary mt-3 w-full justify-center">Gerenciar contas</Link>
                </section>

                <section className="card p-4">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                    <AlertTriangle className="h-4 w-4 text-red-500" /> Contas em aberto
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-400">Vencidos e próximos 30 dias.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <AgendaKpi label="A receber (30d)" valor={data.aReceber30} tone="green" />
                    <AgendaKpi label="A pagar (30d)" valor={data.aPagar30} tone="red" />
                    <AgendaKpi label="Receb. vencidos" valor={data.aReceberVencidas} tone="red" />
                    <AgendaKpi label="Pag. vencidos" valor={data.aPagarVencidas} tone="red" />
                  </div>
                  <div className="mt-3 space-y-1.5 text-xs">
                    {data.aPagarLista.slice(0, 4).map((l) => (
                      <div key={`p-${l.id}`} className="flex justify-between rounded bg-slate-50 px-2 py-1.5">
                        <span className="truncate">{l.nome} {l.parcelas > 1 ? `(${l.parcelas}x)` : ''}</span>
                        <span className="tabular-nums text-red-600">{formatMoney(l.valor)}</span>
                      </div>
                    ))}
                    {data.aReceberLista.slice(0, 4).map((l) => (
                      <div key={`r-${l.id}`} className="flex justify-between rounded bg-slate-50 px-2 py-1.5">
                        <span className="truncate">{l.nome} {l.parcelas > 1 ? `(${l.parcelas}x)` : ''}</span>
                        <span className="tabular-nums text-emerald-600">{formatMoney(l.valor)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Link to="/vendas" className="btn-secondary flex-1 justify-center">Vendas</Link>
                    <Link to="/compras" className="btn-secondary flex-1 justify-center">Compras</Link>
                  </div>
                </section>

                <section className="card p-4">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                    <Repeat className="h-4 w-4 text-navy-500" /> Recorrências
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-400">Aluguel, energia, folha, facção.</p>
                  <div className="mt-3 space-y-2">
                    {data.recorrencias.length === 0 && <p className="text-xs text-slate-400">Nenhuma recorrência cadastrada.</p>}
                    {data.recorrencias.slice(0, 4).map((r) => (
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
              </div>

              <section className="card mt-4 overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-bold text-navy-900">Últimos lançamentos</h2>
                    <p className="text-xs text-slate-400">Livro-caixa integrado a vendas, compras, custos e aportes.</p>
                  </div>
                  <div className="flex gap-2">
                    <Link to="/relatorios?relatorio=faturamento" className="btn-secondary" title="Faturamento mensal com comparação anual">
                      <LineChart className="h-4 w-4" /> Faturamento
                    </Link>
                    <button className="btn-secondary" onClick={() => setTab('dre')}>Ver DRE</button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Descrição</th>
                        <th className="hidden md:table-cell">Categoria</th>
                        <th className="text-right">Valor</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentes.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-sm text-slate-400">Nenhum lançamento financeiro no sistema.</td>
                        </tr>
                      )}
                      {data.recentes.slice(0, 8).map((l) => (
                        <tr key={l.id}>
                          <td className="whitespace-nowrap text-xs text-slate-500">{l.data}</td>
                          <td className="max-w-[240px] truncate font-medium text-navy-900">{l.descricao}</td>
                          <td className="hidden text-sm text-slate-600 md:table-cell">{l.categoria}</td>
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

          {/* ---------------- A RECEBER / PAGAR ---------------- */}
          {tab === 'receberpagar' && (
            <>
              <section className="card mb-4 overflow-hidden">
                <div className="border-b border-slate-200 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                    <AlertTriangle className="h-4 w-4 text-red-500" /> Envelhecimento do contas a receber
                  </h2>
                  <p className="text-xs text-slate-400">Inadimplência por faixa de atraso e maiores devedores.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-5">
                  <AgendaKpi label="A vencer" valor={data.agingReceber?.faixas.a_vencer || 0} tone="green" />
                  <AgendaKpi label="Vencido 1–30d" valor={data.agingReceber?.faixas.vencido_1_30 || 0} tone="amber" />
                  <AgendaKpi label="Vencido 31–60d" valor={data.agingReceber?.faixas.vencido_31_60 || 0} tone="red" />
                  <AgendaKpi label="Vencido 61–90d" valor={data.agingReceber?.faixas.vencido_61_90 || 0} tone="red" />
                  <AgendaKpi label="Vencido 90d+" valor={data.agingReceber?.faixas.vencido_90_mais || 0} tone="red" />
                </div>
                {(data.agingReceber?.clientes || []).length > 0 && (
                  <div className="border-t border-slate-100 px-4 pb-3 pt-2">
                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Maiores em aberto</h3>
                    <ul className="grid gap-1 sm:grid-cols-2">
                      {data.agingReceber!.clientes.slice(0, 6).map((c) => (
                        <li key={c.nome} className="flex items-center justify-between rounded bg-slate-50 px-2.5 py-1.5 text-xs">
                          <span className="truncate text-slate-600">{c.nome}</span>
                          <span className="shrink-0 tabular-nums">
                            <span className="font-semibold text-navy-900">{formatMoney(c.total)}</span>
                            {c.vencido > 0 && <span className="ml-1.5 text-red-600">({formatMoney(c.vencido)} venc.)</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              <div className="grid gap-4 lg:grid-cols-2">
                <TitulosCard
                  titulo="Contas a receber"
                  tom="receita"
                  lista={data.aReceberLista}
                  total={data.aReceber}
                  onBaixar={(l) => abrirBaixa(l, 'receita')}
                />
                <TitulosCard
                  titulo="Contas a pagar"
                  tom="despesa"
                  lista={data.aPagarLista}
                  total={data.aPagar}
                  onBaixar={(l) => abrirBaixa(l, 'despesa')}
                />
              </div>
            </>
          )}

          {/* ---------------- DRE ---------------- */}
          {tab === 'dre' && (
            <section className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="text-sm font-bold text-navy-900">DRE gerencial — {data.mes}</h2>
                  <p className="text-xs text-slate-400">Receita, custo, despesas e resultado do mês (lançamentos confirmados).</p>
                </div>
                <div className="flex gap-2">
                  <Link to="/relatorios?relatorio=dre" className="btn-secondary !px-2.5 !py-1 text-xs" title="DRE de qualquer período, com exportação">
                    <Download className="h-3.5 w-3.5" /> DRE por período
                  </Link>
                  <Link to="/relatorios?relatorio=razao-financeiro" className="btn-secondary !px-2.5 !py-1 text-xs" title="Livro-caixa com saldo acumulado e exportação">
                    <Download className="h-3.5 w-3.5" /> Razão financeiro
                  </Link>
                </div>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <DreLinha label="Receita" value={data.dre.receita} tone="green" />
                <DreLinha label="Custo mercadoria/insumos (CMV)" value={-data.dre.cmv} tone="red" />
                <DreLinha label="Mão de obra / produção" value={-data.dre.mao_obra} tone="red" />
                <DreLinha label="Despesas operacionais" value={-data.dre.despesas_operacionais} tone="red" />
                <DreLinha label="Impostos" value={-data.dre.impostos} tone="red" />
                <DreLinha label="Despesas financeiras" value={-data.dre.despesas_financeiras} tone="red" />
                <DreLinha label="Receitas financeiras (juros/multa)" value={data.dre.receitas_financeiras} tone="green" />
                <DreLinha label="Taxas de operadoras (MP/cartão)" value={-data.dre.taxas_operadoras} tone="red" />
                <DreLinha label="Lucro bruto" value={data.lucroBruto} tone={data.lucroBruto >= 0 ? 'green' : 'red'} bold />
                <DreLinha label="Resultado operacional" value={data.resultadoOperacional} tone={data.resultadoOperacional >= 0 ? 'green' : 'red'} bold />
                <DreLinha label="Resultado financeiro" value={data.resultadoFinanceiro} tone={data.resultadoFinanceiro >= 0 ? 'green' : 'red'} bold />
                <DreLinha label="Investimentos (aporte)" value={data.dre.investimentos} tone="blue" />
              </div>
              <div className="border-t border-slate-200 px-4 py-3 text-right text-sm">
                <span className="mr-2 font-semibold text-slate-500">Resultado geral do mês</span>
                <span className={`text-base font-bold tabular-nums ${data.resultadoGeral >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(data.resultadoGeral)}</span>
              </div>
              <div className="grid gap-4 border-t border-slate-100 p-4 md:grid-cols-2 lg:grid-cols-3">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por categoria</h3>
                  <ul className="space-y-1.5">
                    {data.categorias.slice(0, 8).map((c) => (
                      <li key={c.categoria} className="flex justify-between text-sm">
                        <span className="truncate text-slate-600">{c.categoria}</span>
                        <span className={`tabular-nums ${c.despesa > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{formatMoney(c.despesa > 0 ? -c.despesa : c.receita + c.investimento)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por centro de custo (mês)</h3>
                  <ul className="space-y-1.5">
                    {(data.porCentroCusto || []).length === 0 && <li className="text-sm text-slate-400">Vincule centros de custo aos lançamentos.</li>}
                    {(data.porCentroCusto || []).slice(0, 8).map((c) => {
                      const liquido = c.receita + c.investimento - c.despesa;
                      return (
                        <li key={c.centro} className="flex justify-between text-sm" title={`Receita ${formatMoney(c.receita + c.investimento)} · Despesa ${formatMoney(c.despesa)}`}>
                          <span className="truncate text-slate-600">{c.centro}</span>
                          <span className={`tabular-nums ${liquido >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(liquido)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <Link to="/centros-custo" className="mt-2 inline-block text-xs font-medium text-navy-600 hover:underline">Gerenciar centros de custo →</Link>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Vendas por canal (mês)</h3>
                  <ul className="space-y-1.5">
                    {data.vendasPorCanal.length === 0 && <li className="text-sm text-slate-400">Sem vendas faturadas no mês.</li>}
                    {data.vendasPorCanal.map((c) => (
                      <li key={c.canal} className="flex justify-between text-sm">
                        <span className="text-slate-600">{CANAL_LABEL[c.canal] || c.canal}</span>
                        <span className="tabular-nums text-emerald-600">{formatMoney(c.valor)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}

          {/* ---------------- FLUXO PROJETADO ---------------- */}
          {tab === 'fluxo' && (
            <section className="card overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                  <LineChart className="h-4 w-4 text-navy-500" /> Fluxo de caixa projetado
                </h2>
                <p className="text-xs text-slate-400">Pendências e recorrências futuras sobre o saldo atual de {formatMoney(data.fluxoProjetado.saldoBase)}.</p>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Semanal</h3>
                  <table className="table">
                    <thead><tr><th>Período</th><th className="text-right">Entradas</th><th className="text-right">Saídas</th><th className="text-right">Saldo</th></tr></thead>
                    <tbody>
                      {data.fluxoProjetado.semanal.map((l) => (
                        <tr key={l.periodo}>
                          <td className="text-xs text-slate-500">{l.label}</td>
                          <td className="text-right text-xs tabular-nums text-emerald-600">{formatMoney(l.entradas)}</td>
                          <td className="text-right text-xs tabular-nums text-red-600">{formatMoney(l.saidas)}</td>
                          <td className={`text-right text-xs font-semibold tabular-nums ${l.acumulado >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(l.acumulado)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Mensal</h3>
                  <table className="table">
                    <thead><tr><th>Período</th><th className="text-right">Entradas</th><th className="text-right">Saídas</th><th className="text-right">Saldo</th></tr></thead>
                    <tbody>
                      {data.fluxoProjetado.mensal.map((l) => (
                        <tr key={l.periodo}>
                          <td className="text-xs text-slate-500">{l.label}</td>
                          <td className="text-right text-xs tabular-nums text-emerald-600">{formatMoney(l.entradas)}</td>
                          <td className="text-right text-xs tabular-nums text-red-600">{formatMoney(l.saidas)}</td>
                          <td className={`text-right text-xs font-semibold tabular-nums ${l.acumulado >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatMoney(l.acumulado)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {/* ---------------- RENTABILIDADE ---------------- */}
          {tab === 'rentabilidade' && (
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Landmark className="h-4 w-4 text-navy-500" /> Rentabilidade
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">Margem de vendas faturadas/entregues (receita − custo do produto).</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <AgendaKpi label="Receita" valor={rentab?.receitaTotal || 0} tone="green" />
                <AgendaKpi label="CMV" valor={rentab?.cmvTotal || 0} tone="red" />
                <AgendaKpi label="Margem" valor={rentab?.margemTotal || 0} tone="green" />
                <AgendaKpi label="Margem %" valor={rentab?.margemPctTotal || 0} tone="green" />
              </div>
              <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por canal</h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(rentab?.porCanal || []).map((c) => (
                  <div key={c.produto} className="flex justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm">
                    <span className="capitalize text-slate-600">{c.produto}</span>
                    <span className="tabular-nums text-slate-700">{formatMoney(c.receita)} · {c.margem_pct.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
              <h3 className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Por produto</h3>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Produto</th><th className="text-right">Qtd.</th><th className="text-right">Receita</th><th className="text-right">CMV</th><th className="text-right">Margem</th><th className="text-right">%</th></tr></thead>
                  <tbody>
                    {(rentab?.porProduto || []).map((p) => (
                      <tr key={p.produto}>
                        <td className="max-w-[220px] truncate font-medium text-navy-900">{p.produto}</td>
                        <td className="text-right tabular-nums text-slate-500">{p.quantidade}</td>
                        <td className="text-right tabular-nums text-emerald-600">{formatMoney(p.receita)}</td>
                        <td className="text-right tabular-nums text-red-600">{formatMoney(p.cmv)}</td>
                        <td className="text-right font-semibold tabular-nums text-navy-900">{formatMoney(p.margem)}</td>
                        <td className="text-right tabular-nums text-slate-500">{p.margem_pct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---------------- INVESTIDORES ---------------- */}
          {tab === 'investidores' && (
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Users className="h-4 w-4 text-navy-500" /> Investidores / Sócios
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">Aportes confirmados, participação e distribuição de lucro.</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <AgendaKpi label="Total investido" valor={investidores?.totalInvestido || 0} tone="green" />
                <AgendaKpi label="No mês" valor={investidores?.aportesNoMes || 0} tone="blue" />
                <AgendaKpi label="Distribuído" valor={investidores?.totalDistribuido || 0} tone="red" />
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Investidor / Sócio</th><th>Tipo</th><th className="text-right">Part. %</th><th className="text-right">Aportes</th><th className="text-right">Total aportado</th><th className="text-right">Distribuído</th><th className="text-right">Posição</th></tr></thead>
                  <tbody>
                    {(investidores?.porInvestidor || []).length === 0 && (
                      <tr><td colSpan={7} className="py-8 text-center text-sm text-slate-400">Nenhum investidor cadastrado.</td></tr>
                    )}
                    {(investidores?.porInvestidor || []).map((i) => (
                      <tr key={i.id}>
                        <td className="font-medium text-navy-900">{i.nome}</td>
                        <td className="capitalize text-slate-500">{i.tipo}</td>
                        <td className="text-right tabular-nums text-slate-500">{i.participacao_pct}%</td>
                        <td className="text-right tabular-nums text-slate-500">{i.quantidadeAportes}</td>
                        <td className="text-right tabular-nums text-emerald-600">{formatMoney(i.totalAportado)}</td>
                        <td className="text-right tabular-nums text-red-600">{formatMoney(i.totalDistribuido)}</td>
                        <td className="text-right font-semibold tabular-nums text-navy-900">{formatMoney(i.posicao)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex gap-2">
                <Link to="/investidores" className="btn-secondary flex-1 justify-center">Investidores</Link>
                <Link to="/aportes" className="btn-secondary flex-1 justify-center">Aportes</Link>
              </div>
            </section>
          )}

          {/* ---------------- CONCILIAÇÃO ---------------- */}
          {tab === 'conciliacao' && (
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <ScanLine className="h-4 w-4 text-navy-500" /> Conciliação bancária
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">Cole o extrato (data;valor;descrição) e o ERP casa com lançamentos pendentes.</p>
              <textarea
                className="input mt-3 h-28 resize-none font-mono text-xs"
                placeholder={'2026-09-04;1800,00;ALUGUEL\n2026-09-04;320,00;ENERGIA'}
                value={concTexto}
                onChange={(e) => setConcTexto(e.target.value)}
              />
              <button className="btn-accent mt-2 w-full justify-center" onClick={conciliar} disabled={conciliando || !concTexto.trim()}>
                <RefreshCw className={`h-4 w-4 ${conciliando ? 'animate-spin' : ''}`} /> Conciliar extrato
              </button>
              {concResult && (
                <div className="mt-3 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <p className={`font-semibold ${concResult.confirmados.length > 0 ? 'text-emerald-600' : 'text-slate-500'}`}>{concResult.confirmados.length} conciliado(s) · {concResult.naoConfirmados.length} pendente(s) de revisão</p>
                    <button className="btn-secondary !px-2 !py-1 text-[11px]" onClick={exportarConciliacao} title="Baixar o resultado em CSV">
                      <Download className="h-3.5 w-3.5" /> Exportar
                    </button>
                  </div>
                  {concResult.naoConfirmados.slice(0, 6).map((l, idx) => (
                    <p key={idx} className="rounded bg-amber-50 px-2 py-1 text-amber-700">• {l.data} · {formatMoney(l.valor)} · {l.motivo}</p>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ---------------- MODAL DE BAIXA ---------------- */}
          {baixaAlvo && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/40 p-4" onClick={() => !baixando && setBaixaAlvo(null)}>
              <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-sm font-bold text-navy-900">{baixaAlvo.lado === 'receita' ? 'Receber' : 'Pagar'} — {formatMoney(baixaAlvo.lanc.valor)}</h2>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {baixaAlvo.lanc.nome}
                  {baixaAlvo.lanc.total_parcelas && baixaAlvo.lanc.total_parcelas > 1 ? ` · parcela ${baixaAlvo.lanc.parcelas}/${baixaAlvo.lanc.total_parcelas}` : ''}
                  {baixaAlvo.lanc.vencimento ? ` · venc. ${baixaAlvo.lanc.vencimento}` : ''}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="text-xs font-medium text-slate-500">
                    Data da baixa
                    <input type="date" className="input mt-1" value={baixaForm.data} onChange={(e) => setBaixaForm({ ...baixaForm, data: e.target.value })} />
                  </label>
                  <label className="text-xs font-medium text-slate-500">
                    Conta
                    <select className="input mt-1" value={baixaForm.conta_id} onChange={(e) => setBaixaForm({ ...baixaForm, conta_id: e.target.value })}>
                      <option value="">Manter atual</option>
                      {data.saldoContas.map((c) => (
                        <option key={c.conta_id} value={c.conta_id}>{c.nome}</option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 text-xs font-medium text-slate-500">
                    Forma de pagamento
                    <select className="input mt-1" value={baixaForm.forma_pagamento} onChange={(e) => setBaixaForm({ ...baixaForm, forma_pagamento: e.target.value })}>
                      <option value="">Manter atual</option>
                      <option value="pix">Pix</option>
                      <option value="cartao_credito">Cartão de crédito</option>
                      <option value="cartao_debito">Cartão de débito</option>
                      <option value="boleto">Boleto</option>
                      <option value="dinheiro">Dinheiro</option>
                      <option value="transferencia">Transferência</option>
                      <option value="outros">Outros</option>
                    </select>
                  </label>
                  <label className="text-xs font-medium text-slate-500">
                    Juros (R$)
                    <input type="text" inputMode="decimal" className="input mt-1" placeholder="0,00" value={baixaForm.juros} onChange={(e) => setBaixaForm({ ...baixaForm, juros: e.target.value })} />
                  </label>
                  <label className="text-xs font-medium text-slate-500">
                    Multa (R$)
                    <input type="text" inputMode="decimal" className="input mt-1" placeholder="0,00" value={baixaForm.multa} onChange={(e) => setBaixaForm({ ...baixaForm, multa: e.target.value })} />
                  </label>
                  <label className="col-span-2 text-xs font-medium text-slate-500">
                    Desconto (R$)
                    <input type="text" inputMode="decimal" className="input mt-1" placeholder="0,00" value={baixaForm.desconto} onChange={(e) => setBaixaForm({ ...baixaForm, desconto: e.target.value })} />
                  </label>
                </div>
                {(Number(String(baixaForm.juros).replace(',', '.')) > 0 || Number(String(baixaForm.multa).replace(',', '.')) > 0 || Number(String(baixaForm.desconto).replace(',', '.')) > 0) && (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    Líquido na conta:{' '}
                    <strong className="text-navy-900 tabular-nums">
                      {formatMoney(
                        baixaAlvo.lanc.valor +
                          (Number(String(baixaForm.juros).replace(',', '.')) || 0) +
                          (Number(String(baixaForm.multa).replace(',', '.')) || 0) -
                          (Number(String(baixaForm.desconto).replace(',', '.')) || 0)
                      )}
                    </strong>{' '}
                    — juros/multa e desconto viram lançamentos financeiros próprios (o DRE mostra cada um na linha certa).
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <button className="btn-secondary flex-1 justify-center" onClick={() => setBaixaAlvo(null)} disabled={baixando}>Cancelar</button>
                  <button className="btn-accent flex-1 justify-center" onClick={confirmarBaixa} disabled={baixando}>
                    {baixando ? 'Baixando...' : `${baixaAlvo.lado === 'receita' ? 'Confirmar recebimento' : 'Confirmar pagamento'}`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Card de títulos em aberto (receitas ou despesas) com ação de baixa. */
function TitulosCard({ titulo, tom, lista, total, onBaixar }: { titulo: string; tom: 'receita' | 'despesa'; lista: ContaPendente[]; total: number; onBaixar: (l: ContaPendente) => void }) {
  const cor = tom === 'receita' ? 'text-emerald-600' : 'text-red-600';
  const hojeS = new Date().toISOString().slice(0, 10);
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-bold text-navy-900">{titulo}</h2>
        <span className={`text-sm font-bold tabular-nums ${cor}`}>{formatMoney(total)}</span>
      </div>
      <div className="max-h-[420px] divide-y divide-slate-50 overflow-y-auto">
        {lista.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">Nada em aberto. 🎉</p>}
        {lista.slice(0, 60).map((l) => {
          const atraso = l.vencimento ? Math.floor((Date.parse(hojeS) - Date.parse(l.vencimento)) / 86400000) : 0;
          const vencido = atraso > 0;
          return (
            <div key={l.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-navy-900">
                  {l.nome}
                  {l.total_parcelas && l.total_parcelas > 1 && <span className="ml-1 text-[11px] font-normal text-slate-400">({l.parcelas}/{l.total_parcelas})</span>}
                </p>
                <p className={`text-[11px] ${vencido ? 'font-semibold text-red-600' : 'text-slate-400'}`}>
                  {l.vencimento ? `venc. ${l.vencimento}` : 'sem vencimento'}
                  {vencido && ` · ${atraso}d em atraso`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`text-sm font-semibold tabular-nums ${cor}`}>{formatMoney(l.valor)}</span>
                <button className="btn-secondary !px-2.5 !py-1 text-[11px]" onClick={() => onBaixar(l)} title={tom === 'receita' ? 'Registrar recebimento' : 'Registrar pagamento'}>
                  <HandCoins className="h-3.5 w-3.5" /> Baixar
                </button>
              </div>
            </div>
          );
        })}
        {lista.length > 60 && <p className="px-4 py-2 text-center text-[11px] text-slate-400">+ {lista.length - 60} título(s) — filtre no módulo Lançamentos</p>}
      </div>
    </section>
  );
}

function DreLinha({ label, value, tone, bold }: { label: string; value: number; tone: 'green' | 'red' | 'blue'; bold?: boolean }) {
  const color = tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : 'text-navy-700';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
      <span className="min-w-0 truncate text-xs text-slate-500">{label}</span>
      <span className={`shrink-0 tabular-nums ${bold ? 'text-sm font-bold' : 'text-[13px] font-semibold'} ${color}`}>{formatMoney(value)}</span>
    </div>
  );
}

function AgendaKpi({ label, valor, tone }: { label: string; valor: number; tone: 'green' | 'red' | 'amber' | 'blue' }) {
  const color = tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : tone === 'blue' ? 'text-navy-700' : 'text-amber-600';
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className={`text-base font-bold tabular-nums ${color}`}>{formatMoney(valor)}</p>
      <p className="text-[10px] text-slate-400">{label}</p>
    </div>
  );
}

function Kpi({ icon, label, value, tone, small }: { icon: React.ReactNode; label: string; value: string; tone?: string; small?: boolean }) {
  const tint = tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : tone === 'red' ? 'bg-red-50 text-red-600' : tone === 'amber' ? 'bg-amber-50 text-amber-600' : tone === 'blue' ? 'bg-navy-50 text-navy-700' : 'bg-slate-100 text-slate-600';
  return (
    <div className="card p-4">
      <div className={`mb-2 inline-flex h-9 w-9 items-center justify-center rounded-lg ${tint}`}>{icon}</div>
      <p className={`font-semibold tabular-nums ${small ? 'text-lg' : 'text-2xl'}`}>{value}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  );
}
