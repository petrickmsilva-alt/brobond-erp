import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { CardHeader, DataTable, ErrorState, LoadingState, Pagination, type DataTableColumn } from '../ui-kit';
import { centavosParaReais, formatMoney, formatNumber, formatPct } from '../../lib/format';
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
type LinhaAbc = AbcResp['linhas'][number];

const POR_PAGINA = 10;

const COLUNAS: DataTableColumn<LinhaAbc>[] = [
  {
    key: 'produto',
    header: 'Produto',
    render: (l) => (
      <Link to={`/produtos/${l.produtoId}`} className="font-medium text-ink hover:underline">
        {l.produto || l.sku || `Produto #${l.produtoId}`}
      </Link>
    ),
  },
  {
    key: 'receita',
    header: 'Receita',
    align: 'right',
    render: (l) => <span className="font-mono tabular-nums">{formatMoney(centavosParaReais(l.faturamentoCents))}</span>,
  },
  {
    key: 'participacao',
    header: 'Participação',
    align: 'right',
    render: (l) => <span className="font-mono tabular-nums">{formatPct(l.pctTotal)}</span>,
  },
  {
    key: 'classe',
    header: 'Classe',
    render: (l) => (
      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded bg-line/60 px-1.5 text-[11px] font-bold text-ink">
        {l.classe}
      </span>
    ),
  },
];

export default function AbcCard({ abc, loading, error, onRetry }: { abc: AbcResp | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const [pagina, setPagina] = useState(1);
  // Novo retrato do servidor → volta à primeira página para não exibir página vazia.
  useEffect(() => {
    setPagina(1);
  }, [abc]);

  // A ordem vem pronta do servidor (maior receita primeiro); aqui só se fatia a página.
  const totalPaginas = abc ? Math.max(1, Math.ceil(abc.linhas.length / POR_PAGINA)) : 1;
  const paginaSegura = Math.min(pagina, totalPaginas);
  const linhasPagina = useMemo(
    () => (abc ? abc.linhas.slice((paginaSegura - 1) * POR_PAGINA, paginaSegura * POR_PAGINA) : []),
    [abc, paginaSegura],
  );

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

              <div className="mt-4 border-t border-line">
                <DataTable
                  columns={COLUNAS}
                  rows={linhasPagina}
                  caption={`Produtos por receita, página ${paginaSegura} de ${totalPaginas}`}
                  empty="Ainda não há vendas faturadas para classificar."
                  getRowKey={(l) => l.produtoId}
                />
                {abc.linhas.length > POR_PAGINA && (
                  <p className="border-t border-line px-4 pt-2.5 text-xs text-muted" aria-live="polite">
                    Mostrando {formatNumber(linhasPagina.length)} de {formatNumber(abc.linhas.length)} produtos classificados.
                  </p>
                )}
                <Pagination page={paginaSegura} totalPages={totalPaginas} onChange={setPagina} label="Paginação da curva ABC" />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
