import { useState } from 'react';
import { formatMoney } from '../../lib/format';

/** Valores em reais, já calculados pelo servidor (sem recalcular margem aqui). */
export type PontoVenda = { mes: string; faturamento: number; lucro: number };

/** "2026-10" → "10/26" */
function rotuloMes(mes: string) {
  const [y, m] = mes.split('-');
  return `${m}/${y.slice(2)}`;
}

/**
 * Faturamento por mês do período, em barras SVG. O tooltip mostra faturamento e
 * lucro bruto do mês. Também existe uma tabela oculta visualmente para leitores
 * de tela, com os mesmos valores.
 */
export default function SalesChart({ pontos }: { pontos: PontoVenda[] }) {
  const [ativo, setAtivo] = useState<number | null>(null);
  const max = Math.max(1, ...pontos.map((p) => p.faturamento));
  const altura = 160;
  const largura = Math.max(320, pontos.length * 56);
  const slot = largura / pontos.length;
  const bw = Math.min(36, slot - 14);
  const sel = ativo !== null ? pontos[ativo] : null;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${largura} ${altura + 26}`}
          className="h-56 w-full min-w-[320px]"
          role="img"
          aria-label="Faturamento por mês do período"
        >
          <line x1={0} y1={altura + 1} x2={largura} y2={altura + 1} className="stroke-line" strokeWidth={1} />
          {pontos.map((p, i) => {
            const h = Math.max(p.faturamento > 0 ? 3 : 1, (p.faturamento / max) * (altura - 8));
            const x = i * slot + (slot - bw) / 2;
            const destaque = ativo === i;
            return (
              <g
                key={p.mes}
                tabIndex={0}
                onMouseEnter={() => setAtivo(i)}
                onMouseLeave={() => setAtivo(null)}
                onFocus={() => setAtivo(i)}
                onBlur={() => setAtivo(null)}
                className="cursor-default outline-none focus-visible:opacity-80"
                aria-label={`${rotuloMes(p.mes)}: ${formatMoney(p.faturamento)}`}
              >
                <rect x={i * slot} y={0} width={slot} height={altura} fill="transparent" />
                <rect
                  className="barra fill-primary dark:fill-accent"
                  x={x}
                  y={altura - h}
                  width={bw}
                  height={h}
                  rx={3}
                  opacity={p.faturamento > 0 ? (destaque ? 1 : 0.85) : 0.35}
                />
                <text x={i * slot + slot / 2} y={altura + 17} textAnchor="middle" fontSize={11} className="fill-muted">
                  {rotuloMes(p.mes)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {sel && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-2 top-0 z-10 w-56 rounded-lg border border-line bg-surface p-3 text-xs shadow-modal"
        >
          <p className="font-semibold text-ink">{rotuloMes(sel.mes)}</p>
          <dl className="mt-2 space-y-1">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Faturamento</dt>
              <dd className="font-mono tabular-nums text-ink">{formatMoney(sel.faturamento)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Lucro bruto</dt>
              <dd className="font-mono tabular-nums text-ink">{formatMoney(sel.lucro)}</dd>
            </div>
          </dl>
        </div>
      )}

      <table className="sr-only">
        <caption>Faturamento por mês</caption>
        <thead>
          <tr>
            <th scope="col">Mês</th>
            <th scope="col">Faturamento</th>
            <th scope="col">Lucro bruto</th>
          </tr>
        </thead>
        <tbody>
          {pontos.map((p) => (
            <tr key={p.mes}>
              <td>{rotuloMes(p.mes)}</td>
              <td>{formatMoney(p.faturamento)}</td>
              <td>{formatMoney(p.lucro)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
