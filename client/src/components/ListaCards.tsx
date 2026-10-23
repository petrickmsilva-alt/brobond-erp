// ============================================================================
// MODO VISUAL — cartões
//
// Segundo modo de visualização, opcional: consome as MESMAS linhas, os MESMOS
// filtros e a MESMA paginação da tabela (nenhuma consulta nova, nenhum endpoint
// paralelo). Ideal para reconhecer a peça pela foto em telas de celular.
// ============================================================================
import type { ReactNode } from 'react';
import { ZoomIn } from 'lucide-react';
import type { Field } from '../lib/meta';
import { rotuloDaColuna } from '../lib/lista';
import { PlaceholderFoto, ValorCampo } from './ListaValores';

export function ListaCards({
  rows,
  fields,
  recurso,
  campoTitulo,
  rotuloLinha,
  onAbrirFoto,
  onAbrirLinha,
  renderAcoes,
  linhaClasse,
}: {
  rows: Record<string, any>[];
  fields: Field[];
  recurso: string;
  campoTitulo: string;
  rotuloLinha: (row: Record<string, any>) => string;
  onAbrirFoto?: (row: Record<string, any>) => void;
  onAbrirLinha?: (row: Record<string, any>) => void;
  renderAcoes?: (row: Record<string, any>) => ReactNode;
  linhaClasse?: (row: Record<string, any>) => string;
}) {
  // O status ganha destaque na imagem; não é repetido na grade de dados.
  const statusField = fields.find((f) => f.name === 'ativo' || f.name === 'status');
  const campos = fields.filter((f) => f !== statusField);

  return (
    // Desktop 3–5 colunas · tablet 2–3 · celular 1–2.
    <ul className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" data-testid="lista-cards">
      {rows.map((row) => {
        const rotulo = rotuloLinha(row);
        const titulo = (campoTitulo && String(row[campoTitulo] ?? '')) || rotulo;
        const fotos: { id: number; url: string }[] = Array.isArray(row.fotos) ? row.fotos : [];
        return (
          <li key={row.id} className={`flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card ${linhaClasse?.(row) ?? ''}`}>
            <div className="relative aspect-[4/5] w-full overflow-hidden bg-slate-100">
              {row.foto_url ? (
                <button
                  type="button"
                  className="group absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset"
                  onClick={() => onAbrirFoto?.(row)}
                  aria-label={`Ampliar foto de ${titulo}`}
                  title={`Ampliar foto de ${titulo}`}
                >
                  <img src={row.foto_url} alt={titulo} className="h-full w-full object-cover" loading="lazy" draggable={false} />
                  <span className="absolute inset-0 flex items-center justify-center bg-navy-950/0 text-white opacity-0 transition group-hover:bg-navy-950/25 group-hover:opacity-100">
                    <ZoomIn className="h-6 w-6" aria-hidden="true" />
                  </span>
                </button>
              ) : (
                <PlaceholderFoto className="absolute inset-0" />
              )}
              {statusField && (
                <span className="pointer-events-none absolute left-2 top-2">
                  <ValorCampo f={statusField} row={row} recurso={recurso} />
                </span>
              )}
              {fotos.length > 1 && (
                <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-navy-950/75 px-2 py-0.5 text-[11px] font-semibold text-white">
                  {fotos.length} fotos
                </span>
              )}
            </div>

            <div className="flex flex-1 flex-col gap-2.5 p-3">
              <h3 className="text-sm font-semibold leading-snug text-navy-900">
                {onAbrirLinha ? (
                  <button
                    type="button"
                    className="line-clamp-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40"
                    onClick={() => onAbrirLinha(row)}
                    title={titulo}
                  >
                    {titulo}
                  </button>
                ) : (
                  titulo
                )}
              </h3>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {campos.map((f) => (
                  <div key={f.name} className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{rotuloDaColuna(f, recurso)}</dt>
                    <dd className={`min-w-0 text-slate-700 ${['money', 'number', 'integer', 'percent'].includes(f.type) ? 'font-semibold tabular-nums' : ''}`}>
                      <ValorCampo f={f} row={row} recurso={recurso} />
                    </dd>
                  </div>
                ))}
              </dl>

              {renderAcoes && (
                <div className="mt-auto flex items-center justify-end gap-1 border-t border-slate-100 pt-2">
                  {renderAcoes(row)}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
