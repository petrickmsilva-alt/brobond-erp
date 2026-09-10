import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  ChevronRight,
  Cog,
  Factory,
  Package,
  Search,
  ShoppingCart,
  Store,
  Wallet,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, formatNumber } from '../lib/format';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { BarrasVerticais } from '../components/Charts';

/** Valorização do estoque em três bases: custo de produção, atacado e varejo. */
type Valorizacao = {
  pecas: number;
  custo: number;
  atacado: number;
  varejo: number;
  produtosComSaldo: number;
  semPrecoAtacado: number;
  colecoes: { colecao: string; pecas: number; custo: number; atacado: number; varejo: number }[];
  produtos: {
    id: number;
    produto: string;
    colecao: string | null;
    pecas: number;
    custo_unit: number;
    atacado_unit: number;
    varejo_unit: number;
    atacado_definido: boolean;
    custo: number;
    atacado: number;
    varejo: number;
  }[];
};

type DashboardData = {
  valorEstoque: number;
  pecasEstoque: number;
  valorizacao: Valorizacao;
  itensAlerta: number;
  producao: number;
  vendasAbertas: number;
  comprasPendentes: number;
  vendasMes: number;
  comissoesPagar: number;
  vendasPorMes: { mes: string; total: number }[];
  alertas: { produto: string; tamanho: string; local: string; quantidade: number; estoque_min: number }[];
  insumosAlerta: { insumo: string; quantidade: number; estoque_min: number }[];
  ordens: { id: number; produto: string; tamanho: string; quantidade: number; status: string; previsao: string | null }[];
  totais: { produtos: number; clientes: number; fornecedores: number; insumos: number };
};

type ResumoFin = {
  saldoContasTotal: number;
  aReceberVencidas: number;
  aPagarVencidas: number;
  aPagar30: number;
  aReceber30: number;
};

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [fin, setFin] = useState<ResumoFin | null>(null);
  const [error, setError] = useState('');
  const podeFin = user?.perfil === 'admin' || user?.perfil === 'gerente';

  useEffect(() => {
    api
      .get<DashboardData>('/dashboard')
      .then(setData)
      .catch((e) => setError(e.message));

    if (podeFin) {
      api
        .get<ResumoFin>('/financeiro/resumo')
        .then(setFin)
        .catch(() => {});
    }
  }, [podeFin]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = (user?.name || '').split(' ')[0];

  const kpis = data
    ? [
        { label: 'Vendas do mês', value: formatMoney(data.vendasMes), sub: `${formatNumber(data.vendasAbertas)} em aberto`, icon: Banknote, to: '/vendas', accent: 'bg-emerald-600' },
        ...(podeFin
          ? [{ label: 'Saldo em contas', value: formatMoney(fin?.saldoContasTotal ?? 0), sub: `${formatMoney(fin?.aReceber30 ?? 0)} a receber · ${formatMoney(fin?.aPagar30 ?? 0)} a pagar`, icon: Wallet, to: '/financeiro', accent: 'bg-navy-800' }]
          : []),
        { label: 'Itens em alerta', value: formatNumber(data.itensAlerta), sub: 'abaixo do mínimo', icon: AlertTriangle, to: '/estoque', accent: data.itensAlerta > 0 ? 'bg-red-600' : 'bg-slate-500' },
        { label: 'Peças em estoque', value: formatNumber(data.pecasEstoque), sub: `${formatNumber(data.valorizacao?.produtosComSaldo ?? 0)} produto(s) com saldo`, icon: Package, to: '/estoque', accent: 'bg-brand-500' },
      ].slice(0, 4)
    : [];

  // Estoque valorizado nas três bases — o mesmo saldo lido a custo de produção,
  // a preço de atacado e a preço de varejo.
  const val = data?.valorizacao;
  const custos = val
    ? [
        { key: 'custo' as const, label: 'Custo de produção', value: val.custo, sub: 'Ficha técnica: insumos + mão de obra + indiretos', icon: Factory, accent: 'bg-navy-800', to: '/custo' },
        { key: 'atacado' as const, label: 'Custo no atacado', value: val.atacado, sub: val.semPrecoAtacado > 0 ? `${formatNumber(val.semPrecoAtacado)} produto(s) sem preço de atacado (usa varejo)` : 'Preço de atacado × peças em estoque', icon: Boxes, accent: 'bg-brand-500', to: '/relatorios?relatorio=estoque-posicao' },
        { key: 'varejo' as const, label: 'Custo no varejo', value: val.varejo, sub: 'Preço de venda × peças em estoque', icon: Store, accent: 'bg-emerald-600', to: '/relatorios?relatorio=estoque-posicao' },
      ]
    : [];

  const atencao = data
    ? [
        { label: 'Estoque abaixo do mínimo', msg: `${data.alertas.length} item(ns)`, to: '/estoque', ativo: data.alertas.length > 0 },
        { label: 'Insumos em alerta', msg: `${data.insumosAlerta.length} insumo(s)`, to: '/relatorios?relatorio=insumos-minimo', ativo: data.insumosAlerta.length > 0 },
        { label: 'Contas a pagar vencidas', msg: formatMoney(fin?.aPagarVencidas ?? 0), to: '/financeiro', ativo: (fin?.aPagarVencidas ?? 0) > 0 },
        { label: 'Contas a receber vencidas', msg: formatMoney(fin?.aReceberVencidas ?? 0), to: '/financeiro', ativo: (fin?.aReceberVencidas ?? 0) > 0 },
        { label: 'Pedidos de venda em aberto', msg: `${data.vendasAbertas} pedido(s)`, to: '/vendas', ativo: data.vendasAbertas > 0 },
        { label: 'Compras pendentes', msg: `${data.comprasPendentes} compra(s)`, to: '/compras', ativo: data.comprasPendentes > 0 },
        { label: 'Ordens de fabricação abertas', msg: `${data.ordens.length} OP(s)`, to: '/ordens', ativo: data.ordens.length > 0 },
      ].filter((a) => a.ativo)
    : [];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ''}`}
        description="Visão executiva da operação. Relatórios aprofundados ficam nos módulos e em Relatórios."
        actions={
          <Link to="/movimentacoes" className="btn-primary">
            <Boxes className="h-4 w-4" /> Lançar movimentação
          </Link>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}
      {!data && !error && <Spinner />}

      {data && (
        <>
          {/* KPIs estratégicos */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((k) => (
              <Link key={k.label} to={k.to} className="card group flex items-center gap-4 p-5 transition-shadow hover:shadow-modal">
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white ${k.accent}`}>
                  <k.icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xl font-bold tabular-nums text-navy-900 dark:text-white sm:text-2xl">{k.value}</div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-navy-300">{k.label}</div>
                  <div className="truncate text-xs text-slate-400 dark:text-navy-300">{k.sub}</div>
                </div>
              </Link>
            ))}
          </div>

          {/* Estoque valorizado — custo de produção × atacado × varejo */}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {custos.map((c) => (
              <Link key={c.key} to={c.to} className="card group flex items-center gap-4 p-5 transition-shadow hover:shadow-modal" data-testid={`kpi-${c.key}`}>
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white ${c.accent}`}>
                  <c.icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xl font-bold tabular-nums text-navy-900 dark:text-white sm:text-2xl">{formatMoney(c.value)}</div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-navy-300">{c.label}</div>
                  <div className="truncate text-xs text-slate-400 dark:text-navy-300" title={c.sub}>{c.sub}</div>
                </div>
              </Link>
            ))}
          </div>

          {val && <ValorizacaoPainel val={val} />}

          {/* Precisa de atenção — apenas o que exige ação */}
          <section className="card mt-4 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-navy-800">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
                <AlertTriangle className="h-4 w-4 text-red-500" /> Precisa de atenção
              </h2>
              <span className="text-xs text-slate-400 dark:text-navy-300">O que exige ação hoje</span>
            </div>
            {atencao.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400 dark:text-navy-300">Nada exige ação imediata. 🎉</p>
            ) : (
              <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 dark:divide-navy-800">
                {atencao.map((a) => (
                  <Link key={a.label} to={a.to} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-navy-50/50 dark:hover:bg-navy-800/40">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-navy-900 dark:text-slate-100">{a.label}</p>
                      <p className="text-xs text-slate-400 dark:text-navy-300">{a.msg}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 dark:text-navy-600" />
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Desempenho — um único gráfico de tendência */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section className="card p-4 lg:col-span-2">
              <h2 className="text-sm font-semibold text-navy-900 dark:text-white">Vendas faturadas — últimos 12 meses</h2>
              <div className="mt-3">
                {data.vendasPorMes.length === 0 || data.vendasPorMes.every((v) => v.total === 0) ? (
                  <p className="py-8 text-center text-sm text-slate-400 dark:text-navy-300">Sem vendas faturadas no período.</p>
                ) : (
                  <BarrasVerticais
                    rotulos={data.vendasPorMes.map((v) => `${v.mes.slice(5)}/${v.mes.slice(2, 4)}`)}
                    valores={data.vendasPorMes.map((v) => v.total)}
                    formatar={formatMoney}
                    titulo="Vendas por mês"
                  />
                )}
              </div>
            </section>

            <section className="card p-4">
              <h2 className="text-sm font-semibold text-navy-900 dark:text-white">Cadastros ativos</h2>
              <p className="text-xs text-slate-400 dark:text-navy-300">Base cadastral em uma linha.</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex justify-between rounded-lg border border-slate-100 px-3 py-2 dark:border-navy-800"><span className="text-slate-500 dark:text-navy-300">Produtos</span><strong className="tabular-nums text-navy-900 dark:text-slate-100">{formatNumber(data.totais.produtos)}</strong></li>
                <li className="flex justify-between rounded-lg border border-slate-100 px-3 py-2 dark:border-navy-800"><span className="text-slate-500 dark:text-navy-300">Insumos</span><strong className="tabular-nums text-navy-900 dark:text-slate-100">{formatNumber(data.totais.insumos)}</strong></li>
                <li className="flex justify-between rounded-lg border border-slate-100 px-3 py-2 dark:border-navy-800"><span className="text-slate-500 dark:text-navy-300">Clientes</span><strong className="tabular-nums text-navy-900 dark:text-slate-100">{formatNumber(data.totais.clientes)}</strong></li>
                <li className="flex justify-between rounded-lg border border-slate-100 px-3 py-2 dark:border-navy-800"><span className="text-slate-500 dark:text-navy-300">Fornecedores</span><strong className="tabular-nums text-navy-900 dark:text-slate-100">{formatNumber(data.totais.fornecedores)}</strong></li>
              </ul>
            </section>
          </div>

          {/* Ações rápidas */}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <QuickLink to="/produtos" icon={Package} title="Cadastrar produto" text="SKU, cor, coleção, custo e preço." />
            <QuickLink to="/ordens" icon={Cog} title="Abrir ordem de fabricação" text="Ao concluir, as peças entram no estoque." />
            <QuickLink to="/compras" icon={ShoppingCart} title="Registrar compra" text="Pedidos de insumos por fornecedor." />
          </div>
        </>
      )}
    </div>
  );
}

type Nivel = 'unidade' | 'colecao' | 'total';

const NIVEIS: { key: Nivel; label: string; desc: string }[] = [
  { key: 'unidade', label: 'Por unidade', desc: 'Custo da unidade de cada produto e o total das peças em estoque dele.' },
  { key: 'colecao', label: 'Por coleção', desc: 'Custo do valor total de cada coleção (peças em estoque dos produtos dela).' },
  { key: 'total', label: 'Todas as peças', desc: 'Custo de todas as peças no estoque, somando tamanhos, locais e coleções.' },
];

const BASES = [
  { key: 'custo' as const, label: 'Produção', cor: 'text-navy-900 dark:text-white' },
  { key: 'atacado' as const, label: 'Atacado', cor: 'text-brand-700 dark:text-brand-400' },
  { key: 'varejo' as const, label: 'Varejo', cor: 'text-emerald-700 dark:text-emerald-400' },
];

/** Painel "Estoque valorizado": as três bases (produção, atacado, varejo) em três níveis. */
function ValorizacaoPainel({ val }: { val: Valorizacao }) {
  const [nivel, setNivel] = useState<Nivel>('colecao');
  const [q, setQ] = useState('');

  const produtos = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return val.produtos;
    return val.produtos.filter((p) => `${p.produto} ${p.colecao || ''}`.toLowerCase().includes(term));
  }, [val.produtos, q]);

  const semSaldo = val.produtosComSaldo === 0;
  const atual = NIVEIS.find((n) => n.key === nivel)!;

  return (
    <section className="card mt-4 overflow-hidden" data-testid="valorizacao">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-navy-800">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
            <Package className="h-4 w-4 text-brand-500" /> Estoque valorizado
          </h2>
          <p className="text-xs text-slate-400 dark:text-navy-300">{atual.desc}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {nivel === 'unidade' && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input className="input !py-1.5 pl-8 text-xs sm:w-56" placeholder="Buscar produto ou coleção..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar produto" />
            </div>
          )}
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 text-xs dark:bg-navy-800" role="tablist" aria-label="Nível da valorização">
            {NIVEIS.map((n) => (
              <button
                key={n.key}
                type="button"
                role="tab"
                aria-selected={nivel === n.key}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium ${nivel === n.key ? 'bg-white text-navy-900 shadow dark:bg-navy-900 dark:text-white' : 'text-slate-500 dark:text-navy-300'}`}
                onClick={() => setNivel(n.key)}
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {semSaldo ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400 dark:text-navy-300">Nenhuma peça em estoque para valorizar.</p>
      ) : nivel === 'total' ? (
        <div className="grid grid-cols-1 divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-navy-800">
          {BASES.map((b) => (
            <div key={b.key} className="px-4 py-5 text-center">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-navy-300">Custo de todas as peças · {b.label}</div>
              <div className={`mt-1 text-2xl font-bold tabular-nums ${b.cor}`}>{formatMoney(val[b.key])}</div>
              <div className="mt-1 text-xs text-slate-400 dark:text-navy-300">
                {formatNumber(val.pecas)} peças · média {formatMoney(val.pecas ? val[b.key] / val.pecas : 0)}/peça
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{nivel === 'colecao' ? 'Coleção' : 'Produto'}</th>
                {nivel === 'unidade' && <th className="hidden md:table-cell">Coleção</th>}
                <th className="text-right">Peças</th>
                {nivel === 'unidade' && (
                  <>
                    <th className="text-right">Custo unit.</th>
                    <th className="text-right">Atacado unit.</th>
                    <th className="text-right">Varejo unit.</th>
                  </>
                )}
                <th className="text-right">Produção</th>
                <th className="text-right">Atacado</th>
                <th className="text-right">Varejo</th>
              </tr>
            </thead>
            <tbody>
              {nivel === 'colecao'
                ? val.colecoes.map((c) => (
                    <tr key={c.colecao}>
                      <td className="font-medium text-navy-900 dark:text-slate-100">{c.colecao}</td>
                      <td className="text-right tabular-nums">{formatNumber(c.pecas)}</td>
                      <td className="text-right tabular-nums font-semibold">{formatMoney(c.custo)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.atacado)}</td>
                      <td className="text-right tabular-nums">{formatMoney(c.varejo)}</td>
                    </tr>
                  ))
                : produtos.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/produtos/${p.id}`} className="font-medium text-navy-900 hover:underline dark:text-slate-100">
                          {p.produto}
                        </Link>
                      </td>
                      <td className="hidden text-slate-500 md:table-cell dark:text-navy-300">{p.colecao || '—'}</td>
                      <td className="text-right tabular-nums">{formatNumber(p.pecas)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.custo_unit)}</td>
                      <td className="text-right tabular-nums" title={p.atacado_definido ? undefined : 'Sem preço de atacado cadastrado — usa o preço de varejo'}>
                        {formatMoney(p.atacado_unit)}
                        {!p.atacado_definido && <span className="ml-1 text-[10px] text-amber-600">*</span>}
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(p.varejo_unit)}</td>
                      <td className="text-right tabular-nums font-semibold">{formatMoney(p.custo)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.atacado)}</td>
                      <td className="text-right tabular-nums">{formatMoney(p.varejo)}</td>
                    </tr>
                  ))}
              {nivel === 'unidade' && produtos.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-slate-400 dark:text-navy-300">Nenhum produto encontrado.</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold dark:bg-navy-800/60">
                <td className="px-4 py-2 text-navy-900 dark:text-white">Todas as peças</td>
                {nivel === 'unidade' && <td className="hidden md:table-cell" />}
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(val.pecas)}</td>
                {nivel === 'unidade' && <td colSpan={3} />}
                <td className="px-4 py-2 text-right tabular-nums text-navy-900 dark:text-white">{formatMoney(val.custo)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(val.atacado)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(val.varejo)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-navy-800 dark:text-navy-300">
        <span>
          Produção = custo unitário do produto (ficha técnica). Atacado/varejo = preço de tabela × peças.
          {val.semPrecoAtacado > 0 && <> * Sem preço de atacado cadastrado, vale o preço de varejo.</>}
          {nivel === 'unidade' && val.produtosComSaldo > val.produtos.length && <> Exibindo os {formatNumber(val.produtos.length)} produtos de maior custo (de {formatNumber(val.produtosComSaldo)}).</>}
        </span>
        <Link to="/relatorios?relatorio=estoque-posicao" className="inline-flex items-center gap-1 font-medium text-navy-700 hover:underline dark:text-navy-200">
          Relatório completo <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </section>
  );
}

function QuickLink({ to, icon: Icon, title, text }: { to: string; icon: any; title: string; text: string }) {
  return (
    <Link to={to} className="card flex items-center gap-3 p-4 transition-colors hover:border-navy-300 dark:hover:border-navy-600">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700 dark:bg-navy-800 dark:text-navy-300">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</div>
        <div className="truncate text-xs text-slate-500 dark:text-navy-300">{text}</div>
      </div>
      <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-300 dark:text-navy-600" />
    </Link>
  );
}
