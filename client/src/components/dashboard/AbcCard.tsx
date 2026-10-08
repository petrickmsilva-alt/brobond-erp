import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { CardHeader, ErrorState, LoadingState } from '../ui-kit';
import { centavosParaReais, formatMoney, formatPct } from '../../lib/format';
import type { AbcResp } from './types';

const CLASSES = ['A', 'B', 'C'] as const;
const DESCRICAO: Record<'A' | 'B' | 'C', string> = {
  A: 'Produtos que concentram a maior parte da receita',
  B: 'Participação intermediária',
  C: 'Cauda de baixa participação',
};

/**
 * Curva ABC da empresa (motor do servidor). É o histórico acumulado da empresa:
 * o endpoint não filtra por período, e a tela deixa isso explícito.
 */
export default function AbcCard({ abc, loading, error, onRetry }: { abc: AbcResp | null; loading: boolean; error: string | null; onRetry: () => void }) {
  return (
    <section aria-labelledby="abc-titulo" className="flex flex-col rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
      <CardHeader
        title={<span id="abc-titulo">Curva ABC de produtos</span>}
        icon={BarChart3}
        subtitle="Histórico acumulado da empresa (não segue o período)"
      />

      {loading && <LoadingState label="Carregando curva ABC" />}
      {error && !loading && <ErrorState message={error} onRetry={onRetry} />}

      {abc && !loading && !error && (
        <>
          {abc.linhas.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Ainda não há vendas faturadas para classificar.</p>
          ) : (
            <>
              <ul className="space-y-3 px-4 pt-4" aria-label="Participação de cada classe no faturamento">
                {CLASSES.map((c) => {
                  const r = abc.resumo.find((x) => x.classe === c);
                  const pct = abc.totalFaturamentoCents > 0 ? ((r?.faturamentoCents ?? 0) / abc.totalFaturamentoCents) * 100 : 0;
                  return (
                    <li key={c}>
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="font-semibold text-ink">
                          Classe {c} <span className="font-normal text-muted">· {DESCRICAO[c]}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-soft">
                          {r?.itens ?? 0} item(ns) · {formatPct(pct)}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-line/60" aria-hidden="true">
                        <div className="h-full rounded-full bg-primary dark:bg-accent" style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4 overflow-x-auto border-t border-line">
                <table className="table table-compact">
                  <caption className="sr-only">Top produtos por receita, com participação e classe</caption>
                  <thead>
                    <tr>
                      <th scope="col">Produto</th>
                      <th scope="col" className="text-right">Receita</th>
                      <th scope="col" className="text-right">Participação</th>
                      <th scope="col">Classe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...abc.linhas].sort((a, b) => b.faturamentoCents - a.faturamentoCents).slice(0, 10).map((l) => (
                      <tr key={l.produtoId}>
                        <td className="max-w-[16rem] truncate">
                          <Link to={`/produtos/${l.produtoId}`} className="font-medium text-ink hover:underline">
                            {l.produto || l.sku || `Produto #${l.produtoId}`}
                          </Link>
                        </td>
                        <td className="text-right font-mono tabular-nums">{formatMoney(centavosParaReais(l.faturamentoCents))}</td>
                        <td className="text-right font-mono tabular-nums">{formatPct(l.pctTotal)}</td>
                        <td>
                          <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded bg-line/60 px-1.5 text-[11px] font-bold text-ink">
                            {l.classe}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
