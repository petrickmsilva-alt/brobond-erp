// ============================================================================
// CONTROLES DA LISTAGEM — modo de visualização, densidade e colunas
//
// São controles de APRESENTAÇÃO: nenhum deles altera a consulta. A coluna Foto
// é fixa (prioritária) e por isso aparece no menu marcada e desabilitada — o
// usuário escolhe apenas as colunas secundárias.
// ============================================================================
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Columns3, LayoutGrid, Rows3, Table2 } from 'lucide-react';
import type { Field } from '../lib/meta';
import {
  DENSIDADES,
  DENSIDADE_INFO,
  type Densidade,
  type ModoVisualizacao,
  rotuloDaColuna,
} from '../lib/lista';

function useFecharAoClicarFora(aberto: boolean, ref: RefObject<HTMLElement>, fechar: () => void) {
  useEffect(() => {
    if (!aberto) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fechar();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') fechar();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [aberto, ref, fechar]);
}

/** [TABELA] [VISUAL] — o modo visual consome os mesmos dados/filtros/paginação. */
export function ModoVisualizacaoControl({
  valor,
  onChange,
}: {
  valor: ModoVisualizacao;
  onChange: (v: ModoVisualizacao) => void;
}) {
  const opcoes: { valor: ModoVisualizacao; label: string; icon: typeof Table2 }[] = [
    { valor: 'tabela', label: 'Tabela', icon: Table2 },
    { valor: 'visual', label: 'Visual', icon: LayoutGrid },
  ];
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm" role="group" aria-label="Modo de visualização">
      {opcoes.map(({ valor: v, label, icon: Icon }) => {
        const ativo = valor === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={ativo}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40 ${
              ativo ? 'bg-navy-800 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
            onClick={() => onChange(v)}
            title={`Exibir em ${label.toLowerCase()}`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Densidade: Compacta (48 px) · Normal (56 px) · Confortável (64 px). */
export function DensidadeMenu({ valor, onChange }: { valor: Densidade; onChange: (v: Densidade) => void }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFecharAoClicarFora(aberto, ref, () => setAberto(false));
  const atual = DENSIDADE_INFO[valor];
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn-secondary !px-2.5"
        onClick={() => setAberto((v) => !v)}
        title={`Densidade: ${atual.label}`}
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={`Densidade da tabela: ${atual.label}`}
      >
        <Rows3 className="h-4 w-4" aria-hidden="true" />
        <span className="hidden lg:inline">{atual.label}</span>
      </button>
      {aberto && (
        <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-modal animate-fade-in" role="menu" aria-label="Densidade da tabela">
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Densidade</p>
          {DENSIDADES.map((d) => {
            const info = DENSIDADE_INFO[d];
            const ativo = d === valor;
            return (
              <button
                key={d}
                type="button"
                role="menuitemradio"
                aria-checked={ativo}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  ativo ? 'bg-navy-50 font-semibold text-navy-800' : 'text-slate-700 hover:bg-slate-50'
                }`}
                onClick={() => {
                  onChange(d);
                  setAberto(false);
                }}
              >
                <span className="flex h-4 w-4 items-center justify-center">{ativo && <Check className="h-3.5 w-3.5" aria-hidden="true" />}</span>
                <span className="flex-1">
                  <span className="block">{info.label}</span>
                  <span className="block text-[11px] font-normal text-slate-400">{info.descricao}</span>
                </span>
                <span className="text-[11px] text-slate-400">{info.thumb}px</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Colunas visíveis. A Foto é prioritária: aparece sempre, marcada e travada —
 * esconder a foto faria a listagem de um catálogo de vestuário perder o que ela
 * tem de mais útil.
 */
export function ColunasMenu({
  campos,
  recurso,
  ocultas,
  onToggle,
  comFoto,
}: {
  campos: Field[];
  recurso: string;
  ocultas: Set<string>;
  onToggle: (nome: string) => void;
  comFoto: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFecharAoClicarFora(aberto, ref, () => setAberto(false));
  const totalOcultas = ocultas.size;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={`btn-secondary !px-2.5 ${totalOcultas ? '!border-brand-400 !text-brand-700' : ''}`}
        onClick={() => setAberto((v) => !v)}
        title="Escolher colunas visíveis"
        aria-expanded={aberto}
        aria-controls="colunas-listagem"
        aria-label="Colunas visíveis"
      >
        <Columns3 className="h-4 w-4" aria-hidden="true" />
        <span className="hidden lg:inline">Colunas</span>
      </button>
      {aberto && (
        <div
          id="colunas-listagem"
          className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-2 shadow-modal animate-fade-in"
          role="group"
          aria-label="Colunas visíveis"
        >
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Colunas visíveis</p>
          <div className="max-h-72 overflow-y-auto">
            {comFoto && (
              <label className="flex cursor-not-allowed items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-sm text-slate-500" title="A foto é uma coluna prioritária da listagem">
                <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 text-navy-800" checked readOnly disabled />
                Foto
                <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-slate-400">fixa</span>
              </label>
            )}
            {campos.map((f) => (
              <label key={f.name} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300 text-navy-800 focus:ring-navy-500/30"
                  checked={!ocultas.has(f.name)}
                  onChange={() => onToggle(f.name)}
                />
                {rotuloDaColuna(f, recurso)}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
