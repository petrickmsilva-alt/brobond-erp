import { useId } from 'react';
import { FilterBar } from '../ui-kit';
import { PRESETS_PERIODO, type PresetPeriodo } from '../../lib/periodo';

export type FiltrosDashboard = {
  preset: PresetPeriodo;
  custom: { de: string; ate: string };
  /** grupo de canal (ex.: 'ecommerce') ou '' para todos */
  canal: string;
};

/**
 * Filtros globais do Meu Negócio: período e canal. A empresa é a empresa ativa
 * (seletor do cabeçalho), exibida aqui para que o escopo fique sempre visível.
 */
export default function DashboardFilters({
  valor,
  onChange,
  grupos,
  empresa,
  janelaTexto,
  erroCustom,
}: {
  valor: FiltrosDashboard;
  onChange: (v: FiltrosDashboard) => void;
  grupos: { grupo: string; label: string }[];
  empresa: string | null;
  janelaTexto: string;
  erroCustom: string | null;
}) {
  const idPeriodo = useId();
  const idCanal = useId();
  const idDe = useId();
  const idAte = useId();
  const personalizado = valor.preset === 'personalizado';

  return (
    <div className="space-y-2">
      <FilterBar label="Filtros do painel">
        <div className="min-w-[11rem]">
          <label htmlFor={idPeriodo} className="label">
            Período
          </label>
          <select id={idPeriodo} className="input" value={valor.preset} onChange={(e) => onChange({ ...valor, preset: e.target.value as PresetPeriodo })}>
            {PRESETS_PERIODO.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {personalizado && (
          <>
            <div>
              <label htmlFor={idDe} className="label">
                De
              </label>
              <input id={idDe} type="date" className="input" value={valor.custom.de} onChange={(e) => onChange({ ...valor, custom: { ...valor.custom, de: e.target.value } })} />
            </div>
            <div>
              <label htmlFor={idAte} className="label">
                Até
              </label>
              <input id={idAte} type="date" className="input" value={valor.custom.ate} onChange={(e) => onChange({ ...valor, custom: { ...valor.custom, ate: e.target.value } })} />
            </div>
          </>
        )}

        <div className="min-w-[11rem]">
          <label htmlFor={idCanal} className="label">
            Canal
          </label>
          <select id={idCanal} className="input" value={valor.canal} onChange={(e) => onChange({ ...valor, canal: e.target.value })}>
            <option value="">Todos os canais</option>
            {grupos.map((g) => (
              <option key={g.grupo} value={g.grupo}>
                {g.label}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-[10rem]">
          <span className="label">Empresa</span>
          <p className="flex h-[38px] items-center truncate rounded-lg border border-line bg-canvas px-3 text-sm text-ink" title="Troque no seletor de empresa do cabeçalho">
            {empresa ?? 'Não identificada'}
          </p>
        </div>

        <p className="w-full text-xs text-muted" aria-live="polite">
          {erroCustom ? <span className="text-danger">{erroCustom}</span> : <>Período: {janelaTexto}. Comparado ao período anterior de mesma duração.</>}
        </p>
      </FilterBar>
    </div>
  );
}
