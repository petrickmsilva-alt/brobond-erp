import { Percent } from 'lucide-react';
import { CardHeader } from '../ui-kit-negocios';
import { centavosParaReais, formatMoney, formatNumber, formatPct } from '../../lib/format';
import type { ResumoBI } from './types';

/**
 * Margem do período: a cascata receita → CMV → impostos → frete → lucro bruto.
 * Os números são exatamente os calculados pelo servidor (motor de margem);
 * aqui só são exibidos, nada é recalculado.
 */
export default function MarginCard({ kpis }: { kpis: ResumoBI['kpis'] }) {
  const linhas: { rotulo: string; valor: number; sinal?: '-' | '='; destaque?: boolean }[] = [
    { rotulo: 'Receita líquida', valor: centavosParaReais(kpis.faturamentoCents) },
    { rotulo: 'CMV (custo do produto)', valor: centavosParaReais(kpis.cmvCents), sinal: '-' },
    { rotulo: 'Impostos', valor: centavosParaReais(kpis.impostosCents), sinal: '-' },
    { rotulo: 'Frete', valor: centavosParaReais(kpis.freteCents), sinal: '-' },
    { rotulo: 'Lucro bruto', valor: centavosParaReais(kpis.lucroBrutoCents), sinal: '=', destaque: true },
  ];

  return (
    <section aria-labelledby="margem-titulo" className="flex flex-col rounded-xl border border-line bg-surface shadow-card dark:shadow-none">
      <CardHeader
        title={<span id="margem-titulo">Margem do período</span>}
        icon={Percent}
        subtitle={`${formatNumber(kpis.pedidos)} pedido(s) faturado(s)`}
      />
      <dl className="flex-1 divide-y divide-line px-4">
        {linhas.map((l) => (
          <div key={l.rotulo} className={`flex items-baseline justify-between gap-3 py-2.5 ${l.destaque ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
            <dt className="flex items-center gap-2 text-sm">
              {l.sinal && (
                <span aria-hidden="true" className="w-3 font-mono text-muted">
                  {l.sinal === '-' ? '−' : '='}
                </span>
              )}
              {l.rotulo}
            </dt>
            <dd className="font-mono text-sm tabular-nums">
              {l.sinal === '-' ? `− ${formatMoney(l.valor)}` : formatMoney(l.valor)}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-sm font-semibold text-ink">Margem bruta</dt>
          <dd className="font-mono text-2xl font-semibold tabular-nums text-ink">{formatPct(kpis.margemPct)}</dd>
        </div>
      </dl>
      {kpis.semMargemCalculada > 0 && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-warning">
          {formatNumber(kpis.semMargemCalculada)} pedido(s) ainda sem margem calculada. O motor de margem está processando; o valor pode mudar.
        </p>
      )}
    </section>
  );
}
