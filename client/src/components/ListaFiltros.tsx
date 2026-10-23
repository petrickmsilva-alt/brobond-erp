// ============================================================================
// FILTROS DA LISTAGEM
//
// O painel de filtros é uma ÁREA DA PÁGINA (não um popover sobre a tabela):
// abrir filtros empurra a lista para baixo, nunca cobre a foto nem as colunas.
// O mecanismo é o mesmo de antes — cada campo vira `f.<campo>` na requisição
// server-side — e os chips mostram, sem ambiguidade, o que está ativo.
// ============================================================================
import { RefreshCw, X } from 'lucide-react';
import type { Field, Option } from '../lib/meta';
import type { ChipFiltro } from '../lib/lista';
import { ProductSelector } from './ProductSelector';

/** Um campo de filtro (data, faixa numérica, referência ou lista). */
export function FiltroCampo({
  field,
  filtros,
  opcoes,
  onChange,
}: {
  field: Field;
  filtros: Record<string, string>;
  opcoes?: Option[];
  onChange: (chave: string, valor: string) => void;
}) {
  const id = `filtro-${field.name}`;
  if (field.type === 'date') {
    return (
      <label className="block" htmlFor={id}>
        <span className="label">{field.label}</span>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="date" className="input" value={filtros[`${field.name}_de`] ?? ''} onChange={(e) => onChange(`${field.name}_de`, e.target.value)} aria-label={`${field.label} a partir de`} />
          até
          <input type="date" className="input" value={filtros[`${field.name}_ate`] ?? ''} onChange={(e) => onChange(`${field.name}_ate`, e.target.value)} aria-label={`${field.label} até`} />
        </div>
      </label>
    );
  }
  // Faixa numérica (preço, custo, estoque): mínimo e máximo no servidor.
  if (field.type === 'money' || field.type === 'number' || field.type === 'percent' || field.type === 'integer') {
    const prefixo = field.type === 'money' ? 'R$' : undefined;
    return (
      <label className="block" htmlFor={id}>
        <span className="label">{field.label}</span>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            {prefixo && <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-xs text-slate-400">{prefixo}</span>}
            <input
              id={id}
              type="text"
              inputMode="decimal"
              className={`input ${prefixo ? 'pl-8' : ''}`}
              value={filtros[`${field.name}_min`] ?? ''}
              onChange={(e) => onChange(`${field.name}_min`, e.target.value)}
              placeholder="Mínimo"
              aria-label={`${field.label} mínimo`}
            />
          </div>
          <span className="text-xs text-slate-400">até</span>
          <div className="relative flex-1">
            {prefixo && <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-xs text-slate-400">{prefixo}</span>}
            <input
              type="text"
              inputMode="decimal"
              className={`input ${prefixo ? 'pl-8' : ''}`}
              value={filtros[`${field.name}_max`] ?? ''}
              onChange={(e) => onChange(`${field.name}_max`, e.target.value)}
              placeholder="Máximo"
              aria-label={`${field.label} máximo`}
            />
          </div>
        </div>
      </label>
    );
  }
  const valor = filtros[field.name] ?? '';
  if (field.type === 'ref' && field.ref === 'produtos') {
    return (
      <label className="block" htmlFor={id}>
        <span className="label">{field.label}</span>
        <ProductSelector
          id={id}
          value={valor}
          onChange={(idProduto) => onChange(field.name, idProduto)}
          includeInactive
          aria-label={`Filtrar por ${field.label}`}
        />
      </label>
    );
  }
  return (
    <label className="block" htmlFor={id}>
      <span className="label">{field.label}</span>
      {field.type === 'boolean' ? (
        <select id={id} className="input" value={valor} onChange={(e) => onChange(field.name, e.target.value)}>
          <option value="">Qualquer</option>
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </select>
      ) : (
        <select id={id} className="input" value={valor} onChange={(e) => onChange(field.name, e.target.value)}>
          <option value="">Todos</option>
          {field.type === 'select'
            ? field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            : opcoes?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
        </select>
      )}
    </label>
  );
}

/**
 * Painel em linha (empurra a tabela). O rodapé é o ponto de "aplicar": os
 * filtros já valem a cada mudança (server-side), e "Atualizar lista" força uma
 * nova leitura sem duplicar o mecanismo.
 */
export function PainelFiltros({
  id,
  fields,
  filtros,
  opcoes,
  onChange,
  onAtualizar,
  onFechar,
  atualizando,
  ativos,
}: {
  id: string;
  fields: Field[];
  filtros: Record<string, string>;
  opcoes: Record<string, Option[]>;
  onChange: (chave: string, valor: string) => void;
  onAtualizar: () => void;
  onFechar: () => void;
  atualizando: boolean;
  ativos: number;
}) {
  return (
    <section id={id} className="border-t border-slate-200 bg-slate-50/70 px-4 py-4" aria-label="Filtros da listagem">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-navy-900">Filtros da listagem</h3>
        <span className="text-xs text-slate-500" aria-live="polite">
          {ativos === 0 ? 'Nenhum filtro ativo' : `${ativos} filtro${ativos === 1 ? '' : 's'} ativo${ativos === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {fields.map((f) => (
          <FiltroCampo
            key={f.name}
            field={f}
            filtros={filtros}
            opcoes={f.type === 'ref' && f.ref ? opcoes[f.ref] : undefined}
            onChange={onChange}
          />
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-ghost" onClick={onFechar}>
          Fechar filtros
        </button>
        <button type="button" className="btn-primary" onClick={onAtualizar} disabled={atualizando}>
          <RefreshCw className={`h-4 w-4 ${atualizando ? 'animate-spin' : ''}`} aria-hidden="true" />
          Atualizar lista
        </button>
      </div>
    </section>
  );
}

/** Chips removíveis dos filtros ativos — cada chip corresponde a uma chave (ou faixa). */
export function ChipsFiltros({
  chips,
  onRemover,
}: {
  chips: ChipFiltro[];
  onRemover: (chaves: string[]) => void;
}) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-brand-50/40 px-4 py-2.5" aria-label="Filtros ativos">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Filtros ativos ({chips.length})
      </span>
      <ul className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <li key={chip.chaves.join('|')}>
            <span className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-white py-0.5 pl-2.5 pr-1 text-xs text-slate-700 shadow-sm">
              <span className="font-semibold text-navy-800">{chip.rotulo}:</span>
              <span className="max-w-[180px] truncate" title={chip.valor}>
                {chip.valor}
              </span>
              <button
                type="button"
                className="rounded-full p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40"
                onClick={() => onRemover(chip.chaves)}
                aria-label={`Remover filtro ${chip.rotulo}: ${chip.valor}`}
                title={`Remover filtro ${chip.rotulo}`}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
