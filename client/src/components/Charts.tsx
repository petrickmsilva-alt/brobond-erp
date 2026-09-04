// Gráficos leves em SVG puro (sem dependências) para o Dashboard.
export function BarrasVerticais({
  rotulos,
  valores,
  formatar,
  altura = 150,
  cor = '#243E6A',
  titulo,
}: {
  rotulos: string[];
  valores: number[];
  formatar: (v: number) => string;
  altura?: number;
  cor?: string;
  titulo?: string;
}) {
  const max = Math.max(1, ...valores);
  const w = Math.max(280, rotulos.length * 44);
  const bw = Math.min(36, w / rotulos.length - 8);
  return (
    <figure>
      {titulo && <figcaption className="sr-only">{titulo}</figcaption>}
      <svg viewBox={`0 0 ${w} ${altura + 28}`} className="w-full" preserveAspectRatio="none" role="img" aria-label={titulo}>
        <line x1={0} y1={altura + 1} x2={w} y2={altura + 1} stroke="#cbd5e1" strokeWidth={1} />
        {valores.map((v, i) => {
          const h = Math.max(2, (v / max) * (altura - 6));
          const x = i * (w / rotulos.length) + (w / rotulos.length - bw) / 2;
          return (
            <g key={i}>
              <rect x={x} y={altura - h} width={bw} height={h} rx={3} fill={v > 0 ? cor : '#e2e8f0'} opacity={v > 0 ? 1 : 0.5}>
                <title>{`${rotulos[i]}: ${formatar(v)}`}</title>
              </rect>
              <text x={x + bw / 2} y={altura + 16} textAnchor="middle" fontSize={10} fill="#64748b">
                {rotulos[i]}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function BarrasHorizontais({
  itens,
  formatar,
  maxBarras = 10,
}: {
  itens: { rotulo: string; valor: number; sub?: string }[];
  formatar: (v: number) => string;
  maxBarras?: number;
}) {
  const top = itens.slice(0, maxBarras);
  const max = Math.max(1, ...top.map((t) => t.valor));
  if (!top.length) return null;
  return (
    <ul className="space-y-2.5">
      {top.map((t, i) => (
        <li key={i} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate font-medium text-slate-700" title={t.rotulo}>
              {t.rotulo}
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-navy-800">{formatar(t.valor)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-navy-800 transition-all group-hover:bg-brand-500"
              style={{ width: `${Math.max(2, (t.valor / max) * 100)}%` }}
              title={`${t.rotulo}: ${formatar(t.valor)}`}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
