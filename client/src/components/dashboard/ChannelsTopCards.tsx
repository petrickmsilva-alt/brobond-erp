import { Link } from 'react-router-dom';
import { Layers, Trophy } from 'lucide-react';
import { EmptyState } from '../ui';
import { CardHeader } from '../ui-kit';
import { centavosParaReais, formatMoney, formatNumber, formatPct } from '../../lib/format';
import type { ResumoBI } from './types';

/** Faturamento e margem por grupo de canal (Loja Física, E-commerce, Marketplaces). */
export function CanaisCard({ porCanal }: { porCanal: ResumoBI['porCanal'] }) {
  const total = porCanal.reduce((s, c) => s + c.faturamentoCents, 0);
  return (
    <section aria-labelledby="canais-titulo" className="flex flex-col rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
      <CardHeader title={<span id="canais-titulo">Canais de venda</span>} icon={Layers} subtitle="Pedidos faturados no período" />
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Canal</th>
              <th scope="col" className="text-right">Pedidos</th>
              <th scope="col" className="text-right">Faturamento</th>
              <th scope="col" className="text-right">Participação</th>
              <th scope="col" className="text-right">Margem</th>
            </tr>
          </thead>
          <tbody>
            {porCanal.map((c) => (
              <tr key={c.grupo}>
                <td className="font-medium text-ink">
                  {c.label}
                  <span className="block text-xs font-normal text-muted">{c.canais.length} canal(is)</span>
                </td>
                <td className="text-right font-mono tabular-nums">{formatNumber(c.pedidos)}</td>
                <td className="text-right font-mono tabular-nums">{formatMoney(centavosParaReais(c.faturamentoCents))}</td>
                <td className="text-right font-mono tabular-nums">{formatPct(total > 0 ? (c.faturamentoCents / total) * 100 : 0)}</td>
                <td className="text-right font-mono tabular-nums">{c.pedidos > 0 ? formatPct(c.margemPct) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Produtos mais vendidos no período (ranking por faturamento do servidor). */
export function TopProdutosCard({ itens }: { itens: ResumoBI['topProdutos'] }) {
  return (
    <section aria-labelledby="top-titulo" className="flex flex-col rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
      <CardHeader title={<span id="top-titulo">Produtos mais vendidos</span>} icon={Trophy} subtitle="Top 10 por faturamento no período" />
      {itens.length === 0 ? (
        <EmptyState title="Nenhum produto faturado no período" description="Quando houver pedidos faturados, o ranking aparece aqui." />
      ) : (
        <ol className="divide-y divide-line">
          {itens.map((p, i) => (
            <li key={p.productId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <Link to={`/produtos/${p.productId}`} className="block truncate text-sm font-medium text-ink hover:underline">
                  {p.produto || p.sku || `Produto #${p.productId}`}
                </Link>
                <span className="text-xs text-muted">{formatNumber(p.quantidade)} peça(s)</span>
              </div>
              <span className="shrink-0 font-mono text-sm tabular-nums text-ink">{formatMoney(centavosParaReais(p.faturamentoCents))}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
