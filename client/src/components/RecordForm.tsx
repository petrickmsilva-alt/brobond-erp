import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Eraser, Eye, EyeOff, Loader2, Plus, Save } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { Field, Option, ResourceMeta } from '../lib/meta';
import { maskDocument, maskPhone, toInputValue } from '../lib/format';

export type FormValues = Record<string, string | boolean>;

/** Valores iniciais do formulário (defaults do recurso ou registro existente). */
export function initialValues(r: ResourceMeta, row?: Record<string, any> | null): FormValues {
  const out: FormValues = {};
  for (const f of r.fields) {
    if (f.form === false || f.readonly || f.type === 'images') continue;
    if (row) {
      out[f.name] = f.type === 'boolean' ? Boolean(row[f.name]) : f.type === 'password' ? '' : toInputValue(f, row[f.name]);
    } else {
      out[f.name] = f.type === 'boolean' ? Boolean(f.default ?? false) : f.default !== undefined && f.default !== null ? String(f.default) : '';
    }
  }
  return out;
}

/** Converte valores do formulário no payload da API. */
export function toPayload(r: ResourceMeta, values: FormValues, editing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of r.fields) {
    if (f.form === false || f.readonly || f.type === 'images') continue;
    const v = values[f.name];
    if (f.type === 'boolean') {
      out[f.name] = Boolean(v);
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (f.type === 'password') {
      if (s) out[f.name] = s;
      else if (!editing) out[f.name] = '';
      continue;
    }
    out[f.name] = s === '' ? null : s;
  }
  return out;
}

export function RecordForm({
  resource,
  values,
  errors,
  onChange,
  onSubmit,
  onClear,
  editing,
  busy,
  refOptions,
  autoFocus = true,
  before,
}: {
  resource: ResourceMeta;
  values: FormValues;
  errors: Record<string, string>;
  onChange: (name: string, value: string | boolean) => void;
  onSubmit: () => void;
  onClear: () => void;
  editing: boolean;
  busy: boolean;
  refOptions: Record<string, Option[]>;
  autoFocus?: boolean;
  /** conteúdo exibido antes dos campos (ex.: galeria de fotos) */
  before?: ReactNode;
}) {
  const fields = useMemo(() => resource.fields.filter((f) => f.form !== false && !f.readonly && f.type !== 'images'), [resource]);
  const firstName = fields[0]?.name;
  // Agrupa por seção preservando a ordem de aparição
  const sections = useMemo(() => {
    const out: { title: string | undefined; fields: Field[] }[] = [];
    for (const f of fields) {
      const last = out[out.length - 1];
      if (last && last.title === f.section) last.fields.push(f);
      else out.push({ title: f.section, fields: [f] });
    }
    return out;
  }, [fields]);

  return (
    <form
      id={`form-${resource.key}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
      noValidate
    >
      {before}
      {sections.map((sec, i) => (
        <div key={sec.title ?? i}>
          {sec.title && (
            <h3 className="mb-3 mt-2 border-b border-slate-200 pb-1.5 text-xs font-bold uppercase tracking-wide text-navy-700">{sec.title}</h3>
          )}
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
            {sec.fields.map((f) => (
              <div key={f.name} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                <FieldInput
                  field={f}
                  value={values[f.name]}
                  error={errors[f.name]}
                  onChange={(v) => onChange(f.name, v)}
                  options={f.type === 'ref' && f.ref ? refOptions[f.ref] : undefined}
                  editing={editing}
                  autoFocus={autoFocus && f.name === firstName}
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
        <button type="button" className="btn-secondary" onClick={onClear} disabled={busy} title="Limpar os campos do formulário">
          <Eraser className="h-4 w-4" /> Limpar
        </button>
        <button type="submit" className={editing ? 'btn-primary' : 'btn-accent'} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {editing ? 'Salvar alterações' : 'Incluir'}
        </button>
      </div>
    </form>
  );
}

function FieldInput({
  field: f,
  value,
  error,
  onChange,
  options,
  editing,
  autoFocus,
  disabled,
}: {
  field: Field;
  value: string | boolean | undefined;
  error?: string;
  onChange: (v: string | boolean) => void;
  options?: Option[];
  editing: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = `f-${f.name}`;
  const required = f.required || (!editing && f.requiredOnCreate);
  const cls = `input ${error ? 'input-error' : ''}`;
  const [show, setShow] = useState(false);

  const label = (
    <label htmlFor={id} className="label">
      {f.label}
      {required && <span className="ml-0.5 text-red-500">*</span>}
    </label>
  );
  const help = error ? (
    <p className="mt-1 text-xs font-medium text-red-600">{error}</p>
  ) : f.hint ? (
    <p className="mt-1 text-xs text-slate-400">{f.hint}</p>
  ) : null;

  if (f.type === 'boolean') {
    return (
      <div className="flex h-full flex-col justify-end">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-navy-800 focus:ring-navy-500/30"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
          <span className="text-sm font-medium text-slate-700">{f.label}</span>
        </label>
        {help}
      </div>
    );
  }

  if (f.type === 'select') {
    return (
      <div>
        {label}
        <select id={id} className={cls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled} autoFocus={autoFocus}>
          <option value="">{required ? 'Selecione...' : '— Nenhum —'}</option>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {help}
      </div>
    );
  }

  if (f.type === 'ref') {
    const loaded = options !== undefined;
    return (
      <div>
        {label}
        <select id={id} className={cls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled || !loaded} autoFocus={autoFocus}>
          <option value="">{!loaded ? 'Carregando...' : options.length === 0 ? 'Nenhum cadastrado' : required ? 'Selecione...' : '— Nenhum —'}</option>
          {options?.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
        {loaded && options.length === 0 && !error ? (
          <p className="mt-1 text-xs text-brand-700">Cadastre primeiro em "{refLabel(f.ref)}".</p>
        ) : (
          help
        )}
      </div>
    );
  }

  if (f.type === 'color') {
    const v = String(value ?? '');
    const valid = /^#[0-9a-fA-F]{6}$/.test(v);
    return (
      <div>
        {label}
        <div className="flex items-center gap-2">
          <input
            type="color"
            className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
            value={valid ? v : '#888888'}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            disabled={disabled}
            aria-label={`${f.label} (seletor)`}
          />
          <input
            id={id}
            type="text"
            className={`${cls} font-mono uppercase`}
            value={v}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#1F3A5F"
            maxLength={7}
            disabled={disabled}
            autoFocus={autoFocus}
          />
          {v && (
            <button type="button" className="btn-icon" title="Limpar cor" onClick={() => onChange('')} disabled={disabled}>
              <Eraser className="h-4 w-4" />
            </button>
          )}
        </div>
        {help}
      </div>
    );
  }

  if (f.type === 'textarea') {
    return (
      <div>
        {label}
        <textarea id={id} className={`${cls} min-h-[88px]`} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} maxLength={f.maxLength} placeholder={f.placeholder} disabled={disabled} autoFocus={autoFocus} />
        {help}
      </div>
    );
  }

  if (f.type === 'password') {
    return (
      <div>
        {label}
        <div className="relative">
          <input
            id={id}
            type={show ? 'text' : 'password'}
            className={`${cls} pr-10`}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={editing ? 'Deixe em branco para manter' : 'Mínimo de 6 caracteres'}
            autoComplete="new-password"
            disabled={disabled}
            autoFocus={autoFocus}
          />
          <button type="button" className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600" onClick={() => setShow((s) => !s)} tabIndex={-1} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {help}
      </div>
    );
  }

  const inputType =
    f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : f.type === 'integer' ? 'number' : 'text';
  const inputMode = f.type === 'money' || f.type === 'number' || f.type === 'percent' ? 'decimal' : f.type === 'integer' ? 'numeric' : f.type === 'phone' || f.type === 'document' ? 'tel' : undefined;
  const prefix = f.type === 'money' ? 'R$' : undefined;
  const suffix = f.type === 'percent' ? '%' : undefined;

  const handle = (raw: string) => {
    if (f.type === 'document') return onChange(maskDocument(raw));
    if (f.type === 'phone') return onChange(maskPhone(raw));
    onChange(raw);
  };

  return (
    <div>
      {label}
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-400">{prefix}</span>}
        <input
          id={id}
          type={inputType}
          inputMode={inputMode}
          className={`${cls} ${prefix ? 'pl-9' : ''} ${suffix ? 'pr-8' : ''}`}
          value={String(value ?? '')}
          onChange={(e) => handle(e.target.value)}
          placeholder={f.placeholder || (f.type === 'money' ? '0,00' : undefined)}
          maxLength={f.maxLength}
          min={f.type === 'integer' ? f.min : undefined}
          max={f.type === 'integer' ? f.max : undefined}
          step={f.type === 'integer' ? 1 : undefined}
          autoComplete="off"
          disabled={disabled}
          autoFocus={autoFocus}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-slate-400">{suffix}</span>}
      </div>
      {help}
    </div>
  );
}

const REF_LABELS: Record<string, string> = {
  produtos: 'Produtos',
  categorias: 'Categorias',
  cores: 'Cores',
  tamanhos: 'Tamanhos / Grade',
  colecoes: 'Coleções',
  fornecedores: 'Fornecedores',
  clientes: 'Clientes',
  representantes: 'Representantes',
  insumos: 'Insumos',
};
function refLabel(ref?: string) {
  return (ref && REF_LABELS[ref]) || ref || '';
}

/** Carrega as opções de todos os campos de referência do recurso. */
export function useRefOptions(resource: ResourceMeta, reloadKey = 0) {
  const [opts, setOpts] = useState<Record<string, Option[]>>({});
  const refs = useMemo(() => Array.from(new Set(resource.fields.filter((f) => f.type === 'ref' && f.ref).map((f) => f.ref!))), [resource]);
  const refsKey = refs.join(',');

  useEffect(() => {
    let alive = true;
    setOpts({});
    Promise.all(
      refs.map((ref) =>
        api
          .get<Option[]>(`/${ref}/options`)
          .then((o) => [ref, o] as const)
          .catch(() => [ref, []] as const)
      )
    ).then((pairs) => {
      if (alive) setOpts(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey, reloadKey]);

  return opts;
}

/** Extrai erros por campo de um ApiError. */
export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}
