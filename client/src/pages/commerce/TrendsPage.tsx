// ============================================================================
// COMMERCE — TRENDS. Rota /commerce/trends.
//
// Série diária REAL (pedidos/receita por dia), tendência por mínimos quadrados
// e crescimento de SKUs entre metades do período. Sem dado no banco a tela
// mostra empty state honesto — nunca série fabricada, nunca “—” como número.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Minus, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { Metrica, grana, dataHora } from './shared';

type Trends = {
  periodo: { dias: number; inicio: string; fim: string };
  serie: { dia: string; pedidos: number; receita: number }[];
  totais: { pedidos: number; receita: number; media_diaria: number };
  tendencia: { slope: number; direcao: 'alta' | 'baixa' | 'estavel' };
  melhor_dia: { dia: string; pedidos: number; receita: number };
  pior_dia: { dia: string; pedidos: number; receita: number };
  top_crescimento: { produto_id: number; produto: string; qtd_inicio: number; qtd_fim: number; variacao_pct: number }[];
  vazio: boolean;
};

const DIAS = [15, 30, 60, 90];

export default function CommerceTrendsPage() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState<Trends | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await apiFetch<Trends>(`/commerce/trends?dias=${dias}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as tendências.');
    } finally {
      setCarregando(false);
    }
  }, [dias]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const maxReceita = Math.max(1, ...(dados?.serie.map((p) => p.receita) ?? [1]));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Trends"
        description="Curvas de demanda calculadas sobre os pedidos reais dos canais — receita diária, tendência e aceleração de SKUs."
        actions={
          <label className="text-sm">
            <span className="sr-only">Período</span>
            <select className="input w-40" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
              {DIAS.map((d) => (
                <option key={d} value={d}>
                  Últimos {d} dias
                </option>
              ))}
            </select>
          </label>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Calculando tendências…" />
      ) : !dados ? (
        <Alert tone="amber">Sem dados para exibir.</Alert>
      ) : dados.vazio ? (
        <EmptyState
          icon={<Wallet className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum pedido no período"
          description={`Ainda não há pedidos registrados nos últimos ${dados.periodo.dias} dias. Assim que a primeira venda chegar, as curvas aparecem aqui.`}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metrica rotulo="Pedidos no período" valor={dados.totais.pedidos} />
            <Metrica rotulo="Receita no período" valor={grana(dados.totais.receita)} />
            <Metrica rotulo="Média diária" valor={grana(dados.totais.media_diaria)} />
            <Metrica
              rotulo="Tendência"
              valor={
                <span className="flex items-center gap-2">
                  {dados.tendencia.direcao === 'alta' && <TrendingUp className="h-6 w-6 text-success" aria-label="Alta" />}
                  {dados.tendencia.direcao === 'baixa' && <TrendingDown className="h-6 w-6 text-danger" aria-label="Baixa" />}
                  {dados.tendencia.direcao === 'estavel' && <Minus className="h-6 w-6 text-muted" aria-label="Estável" />}
                  {dados.tendencia.direcao === 'alta' ? 'Alta' : dados.tendencia.direcao === 'baixa' ? 'Baixa' : 'Estável'}
                </span>
              }
              nota={`inclinação ${dados.tendencia.slope} R$/dia (mínimos quadrados)`}
            />
          </div>

          {/* Série diária (gráfico de barras acessível com tabela equivalente) */}
          <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="serie">
            <h2 id="serie" className="text-sm font-semibold uppercase tracking-wide text-muted">Receita diária</h2>
            <ul className="mt-3 flex h-40 items-end gap-[3px]" role="img" aria-label={`Gráfico de receita dos últimos ${dados.periodo.dias} dias; detalhes na tabela abaixo`}>
              {dados.serie.map((p) => (
                <li
                  key={p.dia}
                  className="group relative min-h-[2px] flex-1 rounded-t bg-primary/80 hover:bg-primary"
                  style={{ height: `${Math.max(2, Math.round((p.receita / maxReceita) * 100))}%` }}
                  title={`${p.dia}: ${grana(p.receita)} em ${p.pedidos} pedido(s)`}
                >
                  <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[10px] text-white group-hover:block">
                    {grana(p.receita)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex justify-between text-xs text-muted">
              <span>{dados.serie[0]?.dia}</span>
              <span>{dados.serie[dados.serie.length - 1]?.dia}</span>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-primary hover:underline">Ver tabela com os números</summary>
              <div className="mt-2 max-h-64 overflow-auto">
                <table className="table">
                  <caption className="sr-only">Receita e pedidos por dia</caption>
                  <thead>
                    <tr>
                      <th scope="col">Dia</th>
                      <th scope="col" className="text-right">Pedidos</th>
                      <th scope="col" className="text-right">Receita</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.serie.map((p) => (
                      <tr key={p.dia}>
                        <td className="tabular-nums">{p.dia}</td>
                        <td className="text-right tabular-nums">{p.pedidos}</td>
                        <td className="text-right tabular-nums">{grana(p.receita)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="dias-extremos">
              <h2 id="dias-extremos" className="text-sm font-semibold uppercase tracking-wide text-muted">Dias extremos</h2>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-success">Melhor dia</span>
                  <span className="tabular-nums">{dados.melhor_dia.dia || '—'} · {grana(dados.melhor_dia.receita)} em {dados.melhor_dia.pedidos} pedido(s)</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-danger">Pior dia</span>
                  <span className="tabular-nums">{dados.pior_dia.dia || '—'} · {grana(dados.pior_dia.receita)} em {dados.pior_dia.pedidos} pedido(s)</span>
                </div>
                <p className="text-xs text-muted">
                  Comparação entre a primeira e a segunda metade do período de {dados.periodo.dias} dias (início {dataHora(dados.periodo.inicio)}).
                </p>
              </div>
            </section>

            <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="crescimento">
              <h2 id="crescimento" className="text-sm font-semibold uppercase tracking-wide text-muted">Top crescimento de SKUs</h2>
              {dados.top_crescimento.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Sem variação de quantidade entre as metades do período.</p>
              ) : (
                <ul className="mt-3 space-y-2 text-sm">
                  {dados.top_crescimento.map((c) => (
                    <li key={c.produto_id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{c.produto}</span>
                      <span className="shrink-0 tabular-nums">
                        {c.qtd_inicio} → {c.qtd_fim}{' '}
                        <b className={c.variacao_pct >= 0 ? 'text-success' : 'text-danger'}>
                          {c.variacao_pct >= 0 ? '+' : ''}
                          {c.variacao_pct}%
                        </b>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
