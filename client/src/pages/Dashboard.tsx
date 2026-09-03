import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Boxes, Cog, Factory, History, Receipt, Scissors, Shirt, ShoppingCart, Store, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { ACAO_LABEL, formatDate, formatMoney, formatNumber, formatRelative } from '../lib/format';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';
import type { Tone } from '../lib/meta';

type Dashboard = {
  valorEstoque: number;
  pecasEstoque: number;
  itensAlerta: number;
  producao: number;
  vendasAbertas: number;
  comprasPendentes: number;
  totais: { produtos: number; clientes: number; fornecedores: number; insumos: number };
  alertas: { produto: string; tamanho: string; local: string; quantidade: number; estoque_min: number }[];
  ordens: { id: number; produto: string; tamanho: string; quantidade: number; status: string; previsao: string | null }[];
  recentes: { data: string; usuario: string | null; acao: string; recurso: string | null; descricao: string }[];
};

const STATUS_TONE: Record<string, Tone> = { planejada: 'slate', em_producao: 'blue', concluida: 'green', cancelada: 'red' };
const STATUS_LABEL: Record<string, string> = { planejada: 'Planejada', em_producao: 'Em produção', concluida: 'Concluída', cancelada: 'Cancelada' };
const ACAO_TONE: Record<string, Tone> = { criar: 'green', editar: 'blue', excluir: 'red', login: 'slate', senha: 'amber' };

export default function Dashboard() {
  const { user, meta } = useAuth();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Dashboard>('/dashboard')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = (user?.name || '').split(' ')[0];

  const kpis = data
    ? [
        { label: 'Valor do estoque', value: formatMoney(data.valorEstoque), sub: `${formatNumber(data.pecasEstoque)} peças`, icon: Wallet, to: '/estoque', accent: 'bg-navy-800' },
        { label: 'Itens em alerta', value: formatNumber(data.itensAlerta), sub: 'abaixo do mínimo', icon: AlertTriangle, to: '/estoque', accent: data.itensAlerta > 0 ? 'bg-red-600' : 'bg-emerald-600' },
        { label: 'Produção em andamento', value: formatNumber(data.producao), sub: 'ordens abertas', icon: Cog, to: '/ordens', accent: 'bg-brand-500' },
        { label: 'Vendas em aberto', value: formatNumber(data.vendasAbertas), sub: `${formatNumber(data.comprasPendentes)} compras pendentes`, icon: Receipt, to: '/vendas', accent: 'bg-navy-600' },
      ]
    : [];

  const cadastros = data
    ? [
        { label: 'Produtos', value: data.totais.produtos, icon: Shirt, to: '/produtos' },
        { label: 'Insumos', value: data.totais.insumos, icon: Scissors, to: '/insumos' },
        { label: 'Clientes', value: data.totais.clientes, icon: Store, to: '/clientes' },
        { label: 'Fornecedores', value: data.totais.fornecedores, icon: Factory, to: '/fornecedores' },
      ]
    : [];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ''}`}
        description="Resumo da operação BROBOND em tempo real."
        actions={
          <Link to="/movimentacoes" className="btn-primary">
            <Boxes className="h-4 w-4" /> Lançar movimentação
          </Link>
        }
      />

      {meta?.mode === 'memory' && (
        <div className="mb-4">
          <Alert tone="amber">
            <strong>Modo demonstração:</strong> o servidor está sem banco de dados (variável <code>DATABASE_URL</code>). Tudo funciona, mas os dados são apagados
            ao reiniciar. Configure o Postgres para uso real.
          </Alert>
        </div>
      )}

      {error && <Alert tone="red">{error}</Alert>}
      {!data && !error && <Spinner />}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((k) => (
              <Link key={k.label} to={k.to} className="card group flex items-center gap-4 p-5 transition-shadow hover:shadow-modal">
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white ${k.accent}`}>
                  <k.icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-2xl font-bold tabular-nums text-navy-900">{k.value}</div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{k.label}</div>
                  <div className="text-xs text-slate-400">{k.sub}</div>
                </div>
              </Link>
            ))}
          </div>

          {/* Cadastros */}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cadastros.map((c) => (
              <Link key={c.label} to={c.to} className="card flex items-center justify-between px-4 py-3 hover:bg-navy-50/50">
                <span className="flex items-center gap-2 text-sm text-slate-600">
                  <c.icon className="h-4 w-4 text-navy-400" /> {c.label}
                </span>
                <span className="text-lg font-bold tabular-nums text-navy-900">{formatNumber(c.value)}</span>
              </Link>
            ))}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* Alertas de estoque */}
            <Panel title="Estoque abaixo do mínimo" icon={AlertTriangle} to="/estoque" empty={data.alertas.length === 0} emptyText="Nenhum item abaixo do estoque mínimo.">
              <table className="table">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th>Tam.</th>
                    <th className="text-right">Saldo</th>
                    <th className="text-right">Mín.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.alertas.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <div className="max-w-[180px] truncate font-medium text-slate-800">{a.produto}</div>
                        <div className="text-xs text-slate-400">{a.local}</div>
                      </td>
                      <td>{a.tamanho}</td>
                      <td className="text-right font-semibold tabular-nums text-red-600">{a.quantidade}</td>
                      <td className="text-right tabular-nums text-slate-500">{a.estoque_min}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* Ordens em andamento */}
            <Panel title="Ordens de fabricação abertas" icon={Cog} to="/ordens" empty={data.ordens.length === 0} emptyText="Nenhuma ordem planejada ou em produção.">
              <table className="table">
                <thead>
                  <tr>
                    <th>OP</th>
                    <th>Produto</th>
                    <th className="text-right">Qtd.</th>
                    <th>Previsão</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ordens.map((o) => (
                    <tr key={o.id}>
                      <td className="font-mono text-xs text-slate-400">#{o.id}</td>
                      <td>
                        <div className="max-w-[160px] truncate font-medium text-slate-800">{o.produto}</div>
                        <Badge tone={STATUS_TONE[o.status] || 'slate'}>{STATUS_LABEL[o.status] || o.status}</Badge>
                        {o.tamanho && <span className="ml-1 text-xs text-slate-400">{o.tamanho}</span>}
                      </td>
                      <td className="text-right tabular-nums">{o.quantidade}</td>
                      <td className="text-xs text-slate-500">{formatDate(o.previsao)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* Atividade recente */}
            <Panel title="Atividade recente" icon={History} to={user?.perfil === 'admin' ? '/auditoria' : undefined} empty={data.recentes.length === 0} emptyText="Nenhuma atividade registrada ainda.">
              <ul className="divide-y divide-slate-100">
                {data.recentes.map((r, i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-2.5">
                    <Badge tone={ACAO_TONE[r.acao] || 'slate'}>{ACAO_LABEL[r.acao] || r.acao}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-700">{r.descricao}</div>
                      <div className="text-xs text-slate-400">
                        {r.usuario || 'Sistema'} · {formatRelative(r.data)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <QuickLink to="/produtos" icon={Shirt} title="Cadastrar produto" text="SKU, cor, coleção, custo e preço." />
            <QuickLink to="/ordens" icon={Cog} title="Abrir ordem de fabricação" text="Ao concluir, as peças entram no estoque." />
            <QuickLink to="/compras" icon={ShoppingCart} title="Registrar compra" text="Pedidos de insumos por fornecedor." />
          </div>
        </>
      )}
    </div>
  );
}

function Panel({ title, icon: Icon, to, empty, emptyText, children }: { title: string; icon: any; to?: string; empty: boolean; emptyText: string; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-navy-900">
          <Icon className="h-4 w-4 text-navy-400" /> {title}
        </h2>
        {to && (
          <Link to={to} className="flex items-center gap-1 text-xs font-medium text-navy-600 hover:text-navy-800">
            Ver tudo <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </header>
      {empty ? <p className="px-4 py-8 text-center text-sm text-slate-400">{emptyText}</p> : <div className="overflow-x-auto">{children}</div>}
    </section>
  );
}

function QuickLink({ to, icon: Icon, title, text }: { to: string; icon: any; title: string; text: string }) {
  return (
    <Link to={to} className="card flex items-center gap-3 p-4 transition-colors hover:border-navy-300">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        <div className="truncate text-xs text-slate-500">{text}</div>
      </div>
      <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-slate-300" />
    </Link>
  );
}
