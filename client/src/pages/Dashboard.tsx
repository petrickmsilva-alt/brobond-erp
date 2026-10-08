// ============================================================================
// Meu Negócio — Dashboard (Etapa 2 do redesign).
//
// Fonte dos dados: o motor analítico do servidor (/api/negocios/*), os
// indicadores operacionais de /api/dashboard e o resumo financeiro de
// /api/financeiro/resumo. A tela NÃO recalcula margem, CMV, impostos, curva ABC
// nem estoque: apenas organiza e apresenta o que o servidor calculou.
//
// Regras:
//   • a empresa é sempre a empresa ativa (validada pelo servidor). Sem empresa
//     identificada, os indicadores comerciais não são exibidos — nunca se
//     misturam dados de empresas diferentes;
//   • cada bloco tem carregamento, erro (com nova tentativa) e vazio próprios;
//   • variações comparam com o período anterior de mesma duração.
// ============================================================================
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Boxes, ChevronRight, Cog, Factory, Package, RotateCcw, ShoppingCart, Store, Wallet, Receipt, Warehouse } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { PageHeader, Alert } from '../components/ui';
import { CardHeader, ErrorState, LoadingState, StatCard } from '../components/ui-kit';
import { centavosParaReais, formatMoney, formatNumber, formatPct } from '../lib/format';
import { janelaDoPeriodo, variacaoPct } from '../lib/periodo';
import type { FiltrosDashboard } from '../components/dashboard/DashboardFilters';
import { useApiQuery } from '../lib/useApiQuery';
import DashboardFilters from '../components/dashboard/DashboardFilters';
import SalesChart from '../components/dashboard/SalesChart';
import MarginCard from '../components/dashboard/MarginCard';
import AbcCard from '../components/dashboard/AbcCard';
import AlertsCard, { type Alerta } from '../components/dashboard/AlertsCard';
import { CanaisCard, TopProdutosCard } from '../components/dashboard/ChannelsTopCards';
import ValorizacaoPainel from '../components/dashboard/ValorizacaoPainel';
import type { AbcResp, CanaisResp, DashboardData, EmpresaAtivaResp, ResumoBI, ResumoFin } from '../components/dashboard/types';

const ESCOPO_NAO_IDENTIFICADO = 'Não foi possível identificar a empresa ativa. Os indicadores comerciais ficam ocultos para não misturar dados de empresas. Tente recarregar a página.';

export default function Dashboard() {
  const { user } = useAuth();
  const podeFin = user?.perfil === 'admin' || user?.perfil === 'gerente';
  const [hoje] = useState(() => new Date());
  const [filtros, setFiltros] = useState<FiltrosDashboard>({ preset: '30d', custom: { de: '', ate: '' }, canal: '' });

  // ---- Fontes ----------------------------------------------------------------
  const empresaQ = useApiQuery<EmpresaAtivaResp>('/empresas/ativa');
  const canaisQ = useApiQuery<CanaisResp>('/negocios/canais');
  const dashQ = useApiQuery<DashboardData>('/dashboard');
  const finQ = useApiQuery<ResumoFin>(podeFin ? '/financeiro/resumo' : null);

  // Escopo de empresa: consolidado (só quando o perfil pode) ou a empresa ativa.
  // Sem nenhum dos dois, a consulta comercial fica desligada.
  const escopo: string | null = useMemo(() => {
    const e = empresaQ.data;
    if (!e) return null;
    if (e.consolidado) return '';
    if (e.empresa_id === null) return null;
    return `empresa_id=${e.empresa_id}`;
  }, [empresaQ.data]);

  const janela = useMemo(() => janelaDoPeriodo(filtros.preset, hoje, filtros.custom), [filtros.preset, filtros.custom, hoje]);
  const canalQS = filtros.canal ? `canal=${encodeURIComponent(filtros.canal)}` : '';
  const juntar = (...partes: string[]) => partes.filter(Boolean).join('&');

  const pathAtual = janela && escopo !== null ? `/negocios/resumo?${juntar(`de=${janela.de}`, `ate=${janela.ate}`, escopo, canalQS)}` : null;
  const pathAnterior = janela && escopo !== null ? `/negocios/resumo?${juntar(`de=${janela.prevDe}`, `ate=${janela.prevAte}`, escopo, canalQS)}` : null;
  const pathAbc = escopo !== null ? (escopo ? `/negocios/abc?${escopo}` : '/negocios/abc') : null;

  const atualQ = useApiQuery<ResumoBI>(pathAtual);
  const anteriorQ = useApiQuery<ResumoBI>(pathAnterior);
  const abcQ = useApiQuery<AbcResp>(pathAbc);

  const cur = atualQ.data;
  const ant = anteriorQ.data;
  const dash = dashQ.data;
  const fin = finQ.data;

  // ---- Variações (comparação entre dois resumos do servidor) -----------------
  const deltas = {
    faturamento: cur && ant ? variacaoPct(cur.kpis.faturamentoCents, ant.kpis.faturamentoCents) : null,
    pedidos: cur && ant ? variacaoPct(cur.kpis.pedidos, ant.kpis.pedidos) : null,
    ticket: cur && ant ? variacaoPct(cur.kpis.ticketMedioCents, ant.kpis.ticketMedioCents) : null,
    margemPp: cur && ant ? cur.kpis.margemPct - ant.kpis.margemPct : null,
  };

  // ---- Alertas "Precisa de atenção" ------------------------------------------
  const hojeISO = useMemo(() => {
    const d = hoje;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, [hoje]);

  const alertas: Alerta[] = [];
  const semVerificacao: string[] = ['compras atrasadas por data (o painel recebe só a quantidade de pendentes, sem datas)'];
  if (dash) {
    if (dash.itensAlerta > 0)
      alertas.push({ id: 'estoque-min', rotulo: 'Itens abaixo do estoque mínimo', detalhe: `${formatNumber(dash.itensAlerta)} item(ns) de produto × tamanho × local`, to: '/estoque' });
    if (dash.insumosAlerta.length > 0)
      alertas.push({ id: 'insumos-min', rotulo: 'Insumos abaixo do mínimo', detalhe: `${formatNumber(dash.insumosAlerta.length)} insumo(s)`, to: '/relatorios?relatorio=insumos-minimo' });
    const atrasadas = dash.ordens.filter((o) => o.previsao && o.previsao.slice(0, 10) < hojeISO).length;
    if (atrasadas > 0) alertas.push({ id: 'ops-atraso', rotulo: 'Ordens de fabricação em atraso', detalhe: `${formatNumber(atrasadas)} OP(s) com prazo vencido`, to: '/ordens' });
    if (dash.comprasPendentes > 0) alertas.push({ id: 'compras', rotulo: 'Compras pendentes', detalhe: `${formatNumber(dash.comprasPendentes)} compra(s)`, to: '/compras' });
  } else {
    semVerificacao.push('estoque, produção e compras');
  }
  if (cur && cur.kpis.pedidosPendentes > 0)
    alertas.push({ id: 'aguardando-pgto', rotulo: 'Pedidos aguardando pagamento', detalhe: `${formatNumber(cur.kpis.pedidosPendentes)} no período`, to: '/vendas' });
  if (podeFin && fin) {
    if (fin.aPagarVencidas > 0) alertas.push({ id: 'pagar-venc', rotulo: 'Contas a pagar vencidas', detalhe: formatMoney(fin.aPagarVencidas), to: '/financeiro' });
    if (fin.aReceberVencidas > 0) alertas.push({ id: 'receber-venc', rotulo: 'Contas a receber vencidas', detalhe: formatMoney(fin.aReceberVencidas), to: '/financeiro' });
    // Vencem hoje: filtro por data sobre as listas que o próprio resumo entrega
    // (mesmo padrão do alerta de OPs em atraso — nada é recalculado).
    const vencemHoje = (lista: { vencimento: string | null; valor: number }[]) => lista.filter((l) => l.vencimento === hojeISO);
    const pagarHoje = vencemHoje(fin.aPagarLista);
    const receberHoje = vencemHoje(fin.aReceberLista);
    if (pagarHoje.length > 0)
      alertas.push({ id: 'pagar-hoje', rotulo: 'Contas a pagar vencem hoje', detalhe: `${formatNumber(pagarHoje.length)} conta(s) · ${formatMoney(somaValores(pagarHoje))}`, to: '/financeiro' });
    if (receberHoje.length > 0)
      alertas.push({ id: 'receber-hoje', rotulo: 'Contas a receber vencem hoje', detalhe: `${formatNumber(receberHoje.length)} conta(s) · ${formatMoney(somaValores(receberHoje))}`, to: '/financeiro' });
  } else if (!podeFin) {
    semVerificacao.push('contas a pagar e a receber (perfil gerente)');
  }

  // ---- Helpers de exibição ---------------------------------------------------
  const grupos = canaisQ.data?.grupos.map((g) => ({ grupo: g.grupo, label: g.label })) ?? [];
  const janelaTexto = janela ? `${formatData(janela.de)} a ${formatData(janela.ate)}` : 'intervalo inválido';
  const erroCustom = filtros.preset === 'personalizado' && !janela ? 'Informe um intervalo válido: a data inicial deve ser anterior ou igual à final.' : null;

  const pontosMes = (cur?.porMes ?? []).map((m) => ({
    mes: m.mes,
    faturamento: centavosParaReais(m.faturamentoCents),
    lucro: centavosParaReais(m.lucroBrutoCents),
  }));

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  })();
  const firstName = (user?.name || '').split(' ')[0];

  const val = dash?.valorizacao;

  // Atualização global: refaz as consultas raiz (empresa, canais, operação,
  // financeiro). As comerciais (resumo atual/anterior, ABC) reagem sozinhas —
  // ao recarregar a empresa o escopo passa por null e volta, disparando-as de
  // novo. Recarregá-las aqui também geraria chamadas duplicadas em voo.
  const raizes = [empresaQ, canaisQ, dashQ, finQ];
  const carregandoAlgum = [...raizes, atualQ, anteriorQ, abcQ].some((q) => q.loading);
  const atualizarTudo = () => raizes.forEach((q) => q.reload());

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title="Meu Negócio"
        description={`${greeting}${firstName ? `, ${firstName}` : ''} — como a operação está agora, com comparação ao período anterior.`}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={atualizarTudo}
              disabled={carregandoAlgum}
              aria-label="Recarregar todos os blocos do painel"
              title="Recarregar todos os blocos"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
            <Link to="/movimentacoes" className="btn-primary">
              <Boxes className="h-4 w-4" /> Lançar movimentação
            </Link>
          </>
        }
      />

      <DashboardFilters
        valor={filtros}
        onChange={setFiltros}
        grupos={grupos}
        empresa={empresaQ.data?.empresa ?? null}
        janelaTexto={janelaTexto}
        erroCustom={erroCustom}
      />

      {/* 1. KPIs comerciais do período */}
      {empresaQ.error || (empresaQ.data && empresaQ.data.empresa_id === null && !empresaQ.data.consolidado) ? (
        <Alert tone="red">{ESCOPO_NAO_IDENTIFICADO}</Alert>
      ) : (
        <section aria-label="Indicadores do período">
          {atualQ.error && !atualQ.loading ? (
            <div className="rounded-xl border border-line bg-surface shadow-card">
              <ErrorState message={atualQ.error} onRetry={atualQ.reload} title="Não foi possível carregar os indicadores do período" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {atualQ.loading || !cur ? (
                ['Faturamento', 'Pedidos', 'Ticket médio', 'Margem bruta'].map((l) => (
                  <div key={l} className="rounded-xl border border-line bg-surface p-4 shadow-card">
                    <LoadingState rows={2} label={`Carregando ${l.toLowerCase()}`} />
                  </div>
                ))
              ) : (
                <>
                  <StatCard testId="kpi-faturamento" label="Faturamento" value={formatMoney(centavosParaReais(cur.kpis.faturamentoCents))} delta={deltas.faturamento} icon={Banknote} hint="receita líquida" to="/vendas" />
                  <StatCard testId="kpi-pedidos" label="Pedidos" value={formatNumber(cur.kpis.pedidos)} delta={deltas.pedidos} icon={Receipt} hint="faturados" to="/vendas" />
                  <StatCard testId="kpi-ticket" label="Ticket médio" value={formatMoney(centavosParaReais(cur.kpis.ticketMedioCents))} delta={deltas.ticket} icon={Wallet} hint="por pedido" to="/vendas" />
                  <StatCard
                    testId="kpi-margem"
                    label="Margem bruta"
                    value={formatPct(cur.kpis.margemPct)}
                    delta={deltas.margemPp}
                    deltaUnit=" p.p."
                    icon={Package}
                    hint="lucro ÷ receita"
                    to="/relatorios"
                  />
                </>
              )}
            </div>
          )}
          {anteriorQ.error && <p className="mt-2 text-xs text-muted">Comparação com o período anterior indisponível agora.</p>}
        </section>
      )}

      {/* 2. Desempenho: faturamento por mês + margem */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section aria-labelledby="vendas-titulo" className="rounded-xl border border-line bg-surface shadow-card dark:shadow-none lg:col-span-2">
          <CardHeader title={<span id="vendas-titulo">Faturamento por mês</span>} icon={Banknote} subtitle="Pedidos faturados do período, por mês" />
          <div className="p-4">
            {atualQ.loading ? (
              <LoadingState label="Carregando faturamento" />
            ) : atualQ.error ? (
              <IndisponivelPeriodo />
            ) : !cur || pontosMes.length === 0 || pontosMes.every((p) => p.faturamento === 0) ? (
              <p className="py-10 text-center text-sm text-muted">Nenhuma venda faturada neste período.</p>
            ) : (
              <SalesChart pontos={pontosMes} />
            )}
          </div>
        </section>

        {cur ? (
          <MarginCard kpis={cur.kpis} />
        ) : (
          <section className="rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
            <CardHeader title="Margem do período" icon={Factory} />
            {atualQ.error ? <IndisponivelPeriodo /> : <LoadingState label="Carregando margem" />}
          </section>
        )}
      </div>

      {/* 3. Atenção + canais */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <AlertsCard alertas={alertas} semVerificacao={semVerificacao} />
        <section className="lg:col-span-2">
          {cur ? (
            <CanaisCard porCanal={cur.porCanal} />
          ) : (
            <div className="rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
              <CardHeader title="Canais de venda" icon={ShoppingCart} />
              {atualQ.error ? <IndisponivelPeriodo /> : <LoadingState label="Carregando canais" />}
            </div>
          )}
        </section>
      </div>

      {/* 4. Curva ABC + top produtos */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <AbcCard abc={abcQ.data} loading={abcQ.loading} error={abcQ.error} onRetry={abcQ.reload} />
        </div>
        {cur ? (
          <TopProdutosCard itens={cur.topProdutos} />
        ) : (
          <div className="rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
            <CardHeader title="Produtos mais vendidos" icon={Package} />
            {atualQ.error ? <IndisponivelPeriodo /> : <LoadingState label="Carregando produtos" />}
          </div>
        )}
      </div>

      {/* 5. Operação agora (indicadores operacionais, sem período) */}
      <section aria-label="Operação agora">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Operação agora</h2>
        {dashQ.error && !dashQ.loading ? (
          <div className="rounded-xl border border-line bg-surface shadow-card">
            <ErrorState message={dashQ.error} onRetry={dashQ.reload} title="Não foi possível carregar a operação" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {dashQ.loading || !dash ? (
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border border-line bg-surface p-4 shadow-card">
                  <LoadingState rows={2} label="Carregando operação" />
                </div>
              ))
            ) : (
              <>
                {podeFin && fin && (
                  <StatCard testId="op-saldo" label="Saldo em contas" value={formatMoney(fin.saldoContasTotal)} icon={Wallet} hint={`${formatMoney(fin.aReceber30)} a receber em 30 dias`} to="/financeiro" />
                )}
                <StatCard testId="op-pecas" label="Peças em estoque" value={formatNumber(dash.pecasEstoque)} icon={Warehouse} hint={`${formatNumber(dash.valorizacao.produtosComSaldo)} produto(s) com saldo`} to="/estoque" />
                <StatCard testId="op-ordens" label="Ordens de fabricação" value={formatNumber(dash.ordens.length)} icon={Cog} hint="abertas" to="/ordens" />
                <StatCard testId="op-vendas" label="Pedidos em aberto" value={formatNumber(dash.vendasAbertas)} icon={ShoppingCart} hint="todos os períodos" to="/vendas" />
              </>
            )}
          </div>
        )}
      </section>

      {/* 6. Estoque valorizado — produção × atacado × varejo */}
      <section aria-label="Estoque valorizado">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Estoque valorizado</h2>
        {dashQ.loading || !val ? (
          dashQ.error ? (
            <div className="rounded-xl border border-line bg-surface shadow-card"><ErrorState message={dashQ.error} onRetry={dashQ.reload} /></div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-line bg-surface p-4 shadow-card">
                  <LoadingState rows={2} label="Carregando valorização" />
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard
                testId="kpi-custo"
                label="Custo de produção"
                value={formatMoney(val.custo)}
                icon={Factory}
                hint="Ficha técnica: insumos + mão de obra + indiretos"
                to="/custo"
              />
              <StatCard
                testId="kpi-atacado"
                label="Custo no atacado"
                value={formatMoney(val.atacado)}
                icon={Boxes}
                hint={val.semPrecoAtacado > 0 ? `${formatNumber(val.semPrecoAtacado)} produto(s) sem preço de atacado (usa varejo)` : 'Preço de atacado × peças em estoque'}
                to="/relatorios?relatorio=estoque-posicao"
              />
              <StatCard testId="kpi-varejo" label="Custo no varejo" value={formatMoney(val.varejo)} icon={Store} hint="Preço de venda × peças em estoque" to="/relatorios?relatorio=estoque-posicao" />
            </div>
            <div className="mt-4">
              <ValorizacaoPainel val={val} />
            </div>
          </>
        )}
      </section>

      {/* 7. Base cadastral e ações rápidas */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section aria-labelledby="cadastros-titulo" className="rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
          <CardHeader title={<span id="cadastros-titulo">Base cadastral</span>} subtitle="Cadastros ativos no sistema" />
          {dash ? (
            <dl className="divide-y divide-line px-4">
              {[
                ['Produtos', dash.totais.produtos, '/produtos'],
                ['Insumos', dash.totais.insumos, '/insumos'],
                ['Clientes', dash.totais.clientes, '/clientes'],
                ['Fornecedores', dash.totais.fornecedores, '/fornecedores'],
              ].map(([rotulo, valor, to]) => (
                <div key={rotulo as string} className="flex items-center justify-between py-2.5">
                  <dt>
                    <Link to={to as string} className="text-sm text-ink-soft hover:text-ink hover:underline">
                      {rotulo}
                    </Link>
                  </dt>
                  <dd className="font-mono text-sm font-semibold tabular-nums text-ink">{formatNumber(valor)}</dd>
                </div>
              ))}
            </dl>
          ) : dashQ.error ? (
            <ErrorState message={dashQ.error} onRetry={dashQ.reload} />
          ) : (
            <LoadingState label="Carregando cadastros" />
          )}
        </section>

        <div className="grid grid-cols-1 gap-3 lg:col-span-2">
          <QuickLink to="/produtos" icon={Package} title="Cadastrar produto" text="SKU, cor, coleção, custo e preço." />
          <QuickLink to="/ordens" icon={Cog} title="Abrir ordem de fabricação" text="Ao concluir, as peças entram no estoque." />
          <QuickLink to="/compras" icon={ShoppingCart} title="Registrar compra" text="Pedidos de insumos por fornecedor." />
        </div>
      </div>
    </div>
  );
}

/** Seções dependentes do período mostram isto; quem tenta de novo é o bloco de indicadores acima. */
function IndisponivelPeriodo() {
  return <p className="px-4 py-8 text-center text-sm text-muted">Indisponível: veja o aviso dos indicadores e use "Tentar novamente".</p>;
}

function formatData(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Soma de exibição (mesmo padrão das participações por canal): os valores são do servidor. */
function somaValores(lista: { valor: number }[]) {
  return lista.reduce((s, l) => s + l.valor, 0);
}

function QuickLink({ to, icon: Icon, title, text }: { to: string; icon: typeof Package; title: string; text: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:shadow-none">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-canvas text-ink-soft">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="truncate text-xs text-muted">{text}</div>
      </div>
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
    </Link>
  );
}
