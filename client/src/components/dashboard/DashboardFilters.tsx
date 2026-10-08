import { useId } from 'react';
import { Combobox, DateRangePicker, FilterBar } from '../ui-kit-negocios';
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
          <DateRangePicker
            legend="Período personalizado"
            de={valor.custom.de}
            ate={valor.custom.ate}
            onChange={(custom) => onChange({ ...valor, custom })}
            hint="Intervalo fechado: inclui os dias inicial e final."
          />
        )}

        <Combobox
          label="Canal"
          value={valor.canal}
          onChange={(canal) => onChange({ ...valor, canal })}
          options={[{ value: '', label: 'Todos os canais' }, ...grupos.map((g) => ({ value: g.grupo, label: g.label }))]}
          placeholder="Buscar canal…"
        />

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
