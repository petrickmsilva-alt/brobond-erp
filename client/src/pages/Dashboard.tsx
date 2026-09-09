import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  ChevronRight,
  Cog,
  Handshake,
  Package,
  Receipt,
  ShoppingCart,
  Wallet,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, formatNumber } from '../lib/format';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { BarrasVerticais } from '../components/Charts';

type DashboardData = {
  valorEstoque: number;
  pecasEstoque: number;
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
        { label: 'Valor do estoque', value: formatMoney(data.valorEstoque), sub: `${formatNumber(data.pecasEstoque)} peças`, icon: Package, to: '/estoque', accent: 'bg-brand-500' },
        { label: 'Itens em alerta', value: formatNumber(data.itensAlerta), sub: 'abaixo do mínimo', icon: AlertTriangle, to: '/estoque', accent: data.itensAlerta > 0 ? 'bg-red-600' : 'bg-slate-500' },
      ].slice(0, 4)
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
