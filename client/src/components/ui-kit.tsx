// ============================================================================
// UI KIT — camada complementar do design system (componentes reutilizáveis).
//
// Complementa `ui.tsx` (que continua intacto) com os componentes de dados,
// navegação e formulário que as telas do ERP precisam em comum:
//
//   DataTable · Pagination · Combobox · DatePicker · DateRangePicker ·
//   Tabs · Switch · Checkbox · Dropdown · BulkActions · Breadcrumb
//
// Regras de todos eles:
//   • nenhum dado fictício: tudo chega por props (o chamador traz os dados);
//   • acessibilidade: rótulos, papéis ARIA e estado (aria-*) explícitos;
//   • teclado: navegação completa sem mouse, com foco visível;
//   • nenhuma ação dispara sozinha: ações em lote só expõem callbacks.
// ============================================================================
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowDown, ArrowUp, MoreHorizontal } from 'lucide-react';
import {
  descreverDiaBR,
  diaDaSemana,
  diasNoMes,
  formatarDiaBR,
  lerDia,
  nomeDoMesBR,
  paraIso,
  somarDias,
  somarMeses,
  validarIntervalo,
} from '../lib/datas';

function cx(...partes: Array<string | false | null | undefined>): string {
  return partes.filter(Boolean).join(' ');
}

/** Texto para comparação sem caixa e sem acento ("Ação" casa com "acao"). */
function normalizarTexto(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ----------------------------------------------------------------------------
// Checkbox — marcado, desmarcado, indeterminado (seleção parcial), desabilitado.
// ----------------------------------------------------------------------------

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled = false,
  label,
  'aria-label': ariaLabel,
  id,
  name,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  'aria-label'?: string;
  id?: string;
  name?: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const inputId = id ?? autoId;
  // O estado indeterminado existe só no DOM: sincroniza a cada renderização,
  // porque o clique nativo limpa a propriedade sem passar pelo React.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  });
  return (
    <label
      htmlFor={inputId}
      className={cx('inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', className)}
    >
      <input
        ref={ref}
        id={inputId}
        name={name}
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-navy-700 focus:ring-2 focus:ring-navy-500/40 focus:ring-offset-0 disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label && <span>{label}</span>}
    </label>
  );
}

// ----------------------------------------------------------------------------
// Switch — liga/desliga (role="switch"). Espaço e Enter alternam (botão nativo).
// ----------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  description?: ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const buttonId = id ?? autoId;
  const labelId = `${buttonId}-rotulo`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-slate-800 dark:text-slate-100">
          {label}
        </span>
        {description && <span className="block text-xs text-slate-500 dark:text-navy-300">{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        id={buttonId}
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50',
          checked ? 'bg-navy-700' : 'bg-slate-300 dark:bg-navy-700',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <span className={cx('inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} aria-hidden="true" />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tabs — abas com ARIA completo, foco móvel (roving tabindex) e setas.
// ----------------------------------------------------------------------------

export type TabItem = { id: string; label: ReactNode; disabled?: boolean; content?: ReactNode };

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  className,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  label: string;
  className?: string;
}) {
  const base = useId();
  const botoes = useRef(new Map<string, HTMLButtonElement>());
  const habilitadas = items.filter((i) => !i.disabled);
  const ativa = items.find((i) => i.id === value && !i.disabled) ?? habilitadas[0];

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const ids = habilitadas.map((i) => i.id);
    if (!ids.length) return;
    const pos = ids.indexOf(id);
    let alvo: string | undefined;
    if (e.key === 'ArrowRight') alvo = ids[(pos + 1) % ids.length];
    else if (e.key === 'ArrowLeft') alvo = ids[(pos - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') alvo = ids[0];
    else if (e.key === 'End') alvo = ids[ids.length - 1];
    if (alvo === undefined) return;
    e.preventDefault();
    botoes.current.get(alvo)?.focus();
    onValueChange(alvo);
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-navy-800">
        {items.map((item) => {
          const selecionada = ativa?.id === item.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) botoes.current.set(item.id, el);
                else botoes.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              aria-selected={selecionada}
              aria-controls={`${base}-painel`}
              tabIndex={selecionada ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.id)}
              onKeyDown={(e) => onKeyDown(e, item.id)}
              className={cx(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40',
                selecionada ? 'border-navy-700 text-navy-900 dark:border-brand-400 dark:text-white' : 'border-transparent text-slate-500 hover:text-navy-900 dark:text-navy-300 dark:hover:text-white',
                item.disabled && 'cursor-not-allowed opacity-50'
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {ativa && (
        <div role="tabpanel" id={`${base}-painel`} aria-labelledby={`${base}-tab-${ativa.id}`} tabIndex={0} className="pt-4 focus:outline-none">
          {ativa.content}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Dropdown — menu de ações: abre com clique/setas, navega com teclado, Esc fecha
// e devolve o foco ao gatilho. Itens desabilitados não recebem foco.
// ----------------------------------------------------------------------------

export type MenuItem = { id: string; label: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode };

export function Dropdown({
  trigger,
  items,
  label,
  align = 'end',
  disabled = false,
  className,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  /** Nome acessível do gatilho (útil quando o gatilho é só um ícone). */
  label?: string;
  align?: 'start' | 'end';
  disabled?: boolean;
  className?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const gatilho = useRef<HTMLButtonElement>(null);
  const itens = useRef(new Map<string, HTMLButtonElement>());
  const foco = useRef<'primeiro' | 'ultimo' | null>(null);
  const menuId = useId();

  const habilitados = () => items.filter((i) => !i.disabled).map((i) => i.id);

  // Ao abrir por teclado, leva o foco ao primeiro (ou último) item habilitado.
  useEffect(() => {
    if (!aberto || !foco.current) return;
    const ids = habilitados();
    const alvo = foco.current === 'primeiro' ? ids[0] : ids[ids.length - 1];
    foco.current = null;
    if (alvo) itens.current.get(alvo)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  // Clique fora fecha o menu (sem mover o foco).
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [aberto]);

  const fechar = (devolverFoco: boolean) => {
    setAberto(false);
    if (devolverFoco) gatilho.current?.focus();
  };

  const moverFoco = (delta: 1 | -1 | 'inicio' | 'fim') => {
    const ids = habilitados();
    if (!ids.length) return;
    const atual = document.activeElement as HTMLElement | null;
    const pos = ids.findIndex((id) => itens.current.get(id) === atual);
    let alvo: string;
    if (delta === 'inicio') alvo = ids[0];
    else if (delta === 'fim') alvo = ids[ids.length - 1];
    else alvo = ids[(pos + delta + ids.length) % ids.length];
    itens.current.get(alvo)?.focus();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      foco.current = e.key === 'ArrowDown' ? 'primeiro' : 'ultimo';
      if (aberto) moverFoco(e.key === 'ArrowDown' ? 1 : -1);
      else setAberto(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      fechar(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moverFoco(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moverFoco(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moverFoco('inicio');
    } else if (e.key === 'End') {
      e.preventDefault();
      moverFoco('fim');
    } else if (e.key === 'Tab') {
      setAberto(false);
    }
  };

  return (
    <div ref={raiz} className={cx('relative inline-block', className)}>
      <button
        ref={gatilho}
        type="button"
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-controls={aberto ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          // WAI-ARIA menu button: abrir (mouse ou teclado) leva o foco ao primeiro item.
          if (!aberto) foco.current = 'primeiro';
          setAberto((v) => !v);
        }}
        onKeyDown={onTriggerKey}
        className="btn-secondary"
      >
        {trigger}
      </button>
      {aberto && (
        <div
          id={menuId}
          role="menu"
          aria-orientation="vertical"
          onKeyDown={onMenuKey}
          className={cx(
            'absolute z-40 mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-800 dark:bg-navy-900',
            align === 'end' ? 'right-0' : 'left-0'
          )}
        >
          {items.map((item) => (
            <button
              key={item.id}
              ref={(el) => {
                if (el) itens.current.set(item.id, el);
                else itens.current.delete(item.id);
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                fechar(true);
                item.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus:bg-slate-100 focus:outline-none dark:focus:bg-navy-800',
                item.danger ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-200',
                item.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-100 dark:hover:bg-navy-800'
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Pagination — primeira, anterior, próxima, última, com estados desabilitados.
// ----------------------------------------------------------------------------

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  label = 'Paginação',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  label?: string;
}) {
  const tamanho = Math.max(1, pageSize);
  const totalPaginas = Math.max(1, Math.ceil(Math.max(0, total) / tamanho));
  const atual = Math.min(Math.max(1, page), totalPaginas);
  const noPrimeira = atual <= 1;
  const noUltima = atual >= totalPaginas;
  const botao = 'btn-secondary !px-2.5 !py-1.5 disabled:cursor-not-allowed disabled:opacity-50';
  const sizeId = useId();

  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600 dark:text-navy-200">
      <p>
        Página <span className="font-semibold tabular-nums">{atual}</span> de <span className="font-semibold tabular-nums">{totalPaginas}</span>
        <span className="text-slate-400"> · </span>
        <span className="tabular-nums">{total}</span> registro{total === 1 ? '' : 's'}
      </p>
      <div className="flex items-center gap-1">
        <button type="button" className={botao} aria-label="Primeira página" disabled={noPrimeira} onClick={() => onPageChange(1)}>
          <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className={botao} aria-label="Página anterior" disabled={noPrimeira} onClick={() => onPageChange(atual - 1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Anterior</span>
        </button>
        <button type="button" className={botao} aria-label="Próxima página" disabled={noUltima} onClick={() => onPageChange(atual + 1)}>
          <span className="hidden sm:inline">Próxima</span>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className={botao} aria-label="Última página" disabled={noUltima} onClick={() => onPageChange(totalPaginas)}>
          <ChevronsRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {pageSizeOptions && onPageSizeChange && (
        <div className="flex items-center gap-2">
          <label htmlFor={sizeId} className="text-xs">
            Por página
          </label>
          <select id={sizeId} className="input !w-auto !py-1.5" value={tamanho} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
    </nav>
  );
}

// ----------------------------------------------------------------------------
// Combobox — campo com busca, lista filtrada, teclado (setas, Enter, Esc).
// ----------------------------------------------------------------------------

export type ComboboxOption = { value: string; label: string; disabled?: boolean };

export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder = 'Digite para buscar…',
  emptyText = 'Nenhum resultado encontrado.',
  disabled = false,
  id,
  name,
}: {
  label: string;
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listaId = `${inputId}-opcoes`;
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [destacado, setDestacado] = useState(-1);

  const selecionada = options.find((o) => o.value === value) ?? null;
  const filtradas = useMemo(() => {
    const termo = normalizarTexto(busca);
    return termo ? options.filter((o) => normalizarTexto(o.label).includes(termo)) : options;
  }, [busca, options]);

  const indicesHabilitados = filtradas.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const destacadaOpcao = destacado >= 0 && destacado < filtradas.length ? filtradas[destacado] : null;

  const escolher = (opcao: ComboboxOption) => {
    if (opcao.disabled) return;
    onChange(opcao.value);
    setBusca('');
    setAberto(false);
    setDestacado(-1);
  };

  const mover = (delta: 1 | -1) => {
    if (!indicesHabilitados.length) return;
    const pos = indicesHabilitados.indexOf(destacado);
    const proximo = pos === -1 ? (delta === 1 ? indicesHabilitados[0] : indicesHabilitados[indicesHabilitados.length - 1]) : indicesHabilitados[(pos + delta + indicesHabilitados.length) % indicesHabilitados.length];
    setDestacado(proximo);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!aberto) setAberto(true);
      mover(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!aberto) setAberto(true);
      mover(-1);
    } else if (e.key === 'Enter') {
      if (aberto && destacadaOpcao) {
        e.preventDefault();
        escolher(destacadaOpcao);
      }
    } else if (e.key === 'Escape') {
      if (aberto) {
        e.preventDefault();
        setAberto(false);
        setBusca('');
        setDestacado(-1);
      }
    }
  };

  return (
    <div className="relative">
      <label htmlFor={inputId} className="label">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        type="text"
        role="combobox"
        autoComplete="off"
        className="input"
        placeholder={placeholder}
        disabled={disabled}
        value={aberto ? busca : selecionada?.label ?? ''}
        aria-expanded={aberto}
        aria-controls={aberto ? listaId : undefined}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={destacadaOpcao ? `${listaId}-${destacado}` : undefined}
        onFocus={() => !disabled && setAberto(true)}
        onBlur={() => {
          setAberto(false);
          setBusca('');
          setDestacado(-1);
        }}
        onChange={(e) => {
          setBusca(e.target.value);
          setAberto(true);
          setDestacado(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {aberto && (
        <div className="absolute z-40 mt-1 w-full">
          {filtradas.length === 0 ? (
            <div role="status" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg dark:border-navy-800 dark:bg-navy-900 dark:text-navy-300">
              {emptyText}
            </div>
          ) : (
            <ul
              id={listaId}
              role="listbox"
              aria-label={label}
              className="max-h-60 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-800 dark:bg-navy-900"
              // O clique na opção não pode tirar o foco do campo antes da escolha.
              onMouseDown={(e) => e.preventDefault()}
            >
              {filtradas.map((o, i) => (
                <li
                  key={o.value}
                  id={`${listaId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  onClick={() => escolher(o)}
                  onMouseEnter={() => !o.disabled && setDestacado(i)}
                  className={cx(
                    'cursor-pointer px-3 py-2 text-sm',
                    i === destacado && 'bg-navy-50 dark:bg-navy-800',
                    o.value === value && 'font-semibold',
                    o.disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {o.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// DatePicker — calendário pt-BR com teclado: setas (dia/semana), PageUp/PageDown
// (mês), Home/End (semana), Enter/Espaço (escolhe), Esc (fecha).
// ----------------------------------------------------------------------------

function hojeIso(): string {
  const d = new Date();
  return paraIso({ ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() });
}

const CABECALHO_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const NOME_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function DatePicker({
  id,
  label,
  value,
  onChange,
  min,
  max,
  disabled = false,
  invalid = false,
  describedBy,
  placeholder = 'dd/mm/aaaa',
}: {
  id?: string;
  label: string;
  /** Dia civil `AAAA-MM-DD` ou vazio. */
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  const autoId = useId();
  const campoId = id ?? autoId;
  const dialogoId = `${campoId}-calendario`;
  const [aberto, setAberto] = useState(false);
  const base = lerDia(value) ?? lerDia(hojeIso())!;
  const [mesVisivel, setMesVisivel] = useState({ ano: base.ano, mes: base.mes });
  const [diaFocado, setDiaFocado] = useState<string>(value || hojeIso());
  const raiz = useRef<HTMLDivElement>(null);
  const gatilho = useRef<HTMLButtonElement>(null);
  const celulas = useRef(new Map<string, HTMLButtonElement>());
  const focarAoMudar = useRef(false);

  const abrir = () => {
    if (disabled) return;
    const ref = lerDia(value) ?? lerDia(hojeIso())!;
    setMesVisivel({ ano: ref.ano, mes: ref.mes });
    setDiaFocado(value || hojeIso());
    focarAoMudar.current = true;
    setAberto(true);
  };

  const fechar = (devolverFoco: boolean) => {
    setAberto(false);
    if (devolverFoco) gatilho.current?.focus();
  };

  // Foco vai para o dia destacado sempre que o calendário abre ou o dia muda por teclado.
  useEffect(() => {
    if (!aberto || !focarAoMudar.current) return;
    focarAoMudar.current = false;
    celulas.current.get(diaFocado)?.focus();
  }, [aberto, diaFocado, mesVisivel]);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [aberto]);

  const desabilitado = (iso: string) => (min !== undefined && iso < min) || (max !== undefined && iso > max);

  const irPara = (iso: string) => {
    const d = lerDia(iso);
    if (!d) return;
    setDiaFocado(iso);
    if (d.ano !== mesVisivel.ano || d.mes !== mesVisivel.mes) setMesVisivel({ ano: d.ano, mes: d.mes });
    // O efeito de foco move o cursor para a célula depois do render.
    focarAoMudar.current = true;
  };

  const escolher = (iso: string) => {
    if (desabilitado(iso)) return;
    onChange(iso);
    fechar(true);
  };

  const onGridKey = (e: KeyboardEvent<HTMLButtonElement>, iso: string) => {
    const teclas: Record<string, string> = {
      ArrowLeft: somarDias(iso, -1),
      ArrowRight: somarDias(iso, 1),
      ArrowUp: somarDias(iso, -7),
      ArrowDown: somarDias(iso, 7),
      PageUp: somarMeses(iso, -1),
      PageDown: somarMeses(iso, 1),
      Home: somarDias(iso, -diaDaSemana(iso)),
      End: somarDias(iso, 6 - diaDaSemana(iso)),
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      fechar(true);
    } else if (teclas[e.key]) {
      e.preventDefault();
      irPara(teclas[e.key]);
    }
  };

  // Grade do mês visível.
  const primeiroDia = paraIso({ ano: mesVisivel.ano, mes: mesVisivel.mes, dia: 1 });
  const offset = diaDaSemana(primeiroDia);
  const totalDias = diasNoMes(mesVisivel.ano, mesVisivel.mes);
  const dias: (string | null)[] = [];
  for (let i = 0; i < offset; i++) dias.push(null);
  for (let d = 1; d <= totalDias; d++) dias.push(paraIso({ ano: mesVisivel.ano, mes: mesVisivel.mes, dia: d }));
  while (dias.length % 7 !== 0) dias.push(null);
  const semanas: (string | null)[][] = [];
  for (let i = 0; i < dias.length; i += 7) semanas.push(dias.slice(i, i + 7));

  const hoje = hojeIso();
  const mesDoFoco = `${mesVisivel.ano}-${String(mesVisivel.mes).padStart(2, '0')}`;
  // A célula "tabulável" da grade é o dia focado se ele estiver no mês visível.
  const diaNoFoco = diaFocado.startsWith(`${mesDoFoco}-`) ? diaFocado : primeiroDia;

  return (
    <div ref={raiz} className="relative">
      <label htmlFor={campoId} className="label">
        {label}
      </label>
      <button
        ref={gatilho}
        id={campoId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={aberto ? dialogoId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (aberto ? fechar(true) : abrir())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !aberto) {
            e.preventDefault();
            abrir();
          }
        }}
        className={cx('input flex items-center justify-between text-left tabular-nums', invalid && 'input-error', !value && 'text-slate-400 dark:text-slate-500')}
      >
        <span>{value ? formatarDiaBR(value) : placeholder}</span>
        <span aria-hidden="true" className="text-xs text-slate-400">
          📅
        </span>
      </button>

      {aberto && (
        <div
          id={dialogoId}
          role="dialog"
          aria-modal="false"
          aria-label={`Escolher data: ${label}`}
          className="absolute z-40 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-xl dark:border-navy-800 dark:bg-navy-900"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              className="btn-icon"
              aria-label="Mês anterior"
              onClick={() => setMesVisivel((m) => (m.mes === 1 ? { ano: m.ano - 1, mes: 12 } : { ano: m.ano, mes: m.mes - 1 }))}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <p className="text-sm font-semibold capitalize text-navy-900 dark:text-white" aria-live="polite">
              {nomeDoMesBR(mesVisivel.ano, mesVisivel.mes)}
            </p>
            <button
              type="button"
              className="btn-icon"
              aria-label="Próximo mês"
              onClick={() => setMesVisivel((m) => (m.mes === 12 ? { ano: m.ano + 1, mes: 1 } : { ano: m.ano, mes: m.mes + 1 }))}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div role="grid" aria-label={nomeDoMesBR(mesVisivel.ano, mesVisivel.mes)} className="w-full">
            <div role="row" className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase text-slate-400">
              {CABECALHO_SEMANA.map((letra, i) => (
                <div role="columnheader" key={i} aria-label={NOME_SEMANA[i]} className="py-1">
                  {letra}
                </div>
              ))}
            </div>
            {semanas.map((semana, si) => (
              <div role="row" key={si} className="grid grid-cols-7 gap-0.5">
                {semana.map((iso, di) =>
                  iso === null ? (
                    <div role="gridcell" key={di} aria-hidden="true" />
                  ) : (
                    <div role="gridcell" key={iso} aria-selected={iso === value} className="p-0.5">
                      <button
                        ref={(el) => {
                          if (el) celulas.current.set(iso, el);
                          else celulas.current.delete(iso);
                        }}
                        type="button"
                        aria-label={descreverDiaBR(iso)}
                        aria-pressed={iso === value}
                        tabIndex={iso === diaNoFoco ? 0 : -1}
                        disabled={desabilitado(iso)}
                        onFocus={() => setDiaFocado(iso)}
                        onClick={() => escolher(iso)}
                        onKeyDown={(e) => onGridKey(e, iso)}
                        className={cx(
                          'flex h-8 w-full items-center justify-center rounded-md text-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50',
                          iso === value ? 'bg-navy-800 font-semibold text-white' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-navy-800',
                          iso === hoje && iso !== value && 'ring-1 ring-navy-300 dark:ring-navy-600',
                          desabilitado(iso) && 'cursor-not-allowed opacity-40 hover:bg-transparent'
                        )}
                      >
                        {lerDia(iso)!.dia}
                      </button>
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-2 dark:border-navy-800">
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => onChange('')}>
              Limpar
            </button>
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => escolher(hoje)} disabled={desabilitado(hoje)}>
              Hoje
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// DateRangePicker — início e fim, com validação de intervalo (datas invertidas).
// ----------------------------------------------------------------------------

export function DateRangePicker({
  idPrefix,
  value,
  onChange,
  labelInicio = 'Data inicial',
  labelFim = 'Data final',
  min,
  max,
  disabled = false,
}: {
  idPrefix?: string;
  value: { de: string; ate: string };
  onChange: (value: { de: string; ate: string }) => void;
  labelInicio?: string;
  labelFim?: string;
  /** Limites externos (ex.: início do exercício). Não restringem um ao outro. */
  min?: string;
  max?: string;
  disabled?: boolean;
}) {
  const autoId = useId();
  const prefixo = idPrefix ?? autoId;
  const erro = validarIntervalo(value.de, value.ate);
  const erroId = `${prefixo}-erro`;
  return (
    <div role="group" aria-label="Período" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <DatePicker
        id={`${prefixo}-de`}
        label={labelInicio}
        value={value.de}
        onChange={(de) => onChange({ de, ate: value.ate })}
        min={min}
        max={max}
        disabled={disabled}
        invalid={!!erro}
        describedBy={erro ? erroId : undefined}
      />
      <DatePicker
        id={`${prefixo}-ate`}
        label={labelFim}
        value={value.ate}
        onChange={(ate) => onChange({ de: value.de, ate })}
        min={min}
        max={max}
        disabled={disabled}
        invalid={!!erro}
        describedBy={erro ? erroId : undefined}
      />
      {erro && (
        <p id={erroId} role="alert" className="text-xs font-medium text-red-600 sm:col-span-2 dark:text-red-400">
          {erro}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// DataTable — tabela reutilizável: colunas, ordenação, seleção, ações,
// carregamento (skeleton), estado vazio e responsividade.
// ----------------------------------------------------------------------------

export type Column<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Presente = coluna ordenável; devolve o valor usado na comparação. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** Some em telas pequenas (md para cima mostra). */
  hideOnMobile?: boolean;
};

export type SortState = { columnId: string; direction: 'asc' | 'desc' } | null;

function compararValores(a: string | number | null | undefined, b: string | number | null | undefined, direcao: 'asc' | 'desc'): number {
  const aVazio = a === null || a === undefined || a === '';
  const bVazio = b === null || b === undefined || b === '';
  // Vazios vão sempre para o fim, em qualquer direção.
  if (aVazio && bVazio) return 0;
  if (aVazio) return 1;
  if (bVazio) return -1;
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'pt-BR', { numeric: true, sensitivity: 'base' });
  return direcao === 'asc' ? r : -r;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  loadingRows = 5,
  emptyMessage = 'Nenhum registro encontrado.',
  selection,
  actions,
  sort,
  onSortChange,
  onRowActivate,
  className,
}: {
  /** Nome acessível da tabela (lido por leitores de tela; visível só para eles). */
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  loadingRows?: number;
  emptyMessage?: ReactNode;
  selection?: { selected: string[]; onChange: (keys: string[]) => void; rowLabel?: (row: T) => string };
  /** Coluna de ações (botões do próprio chamador). */
  actions?: (row: T) => ReactNode;
  /** Ordenação controlada. Sem ela, a tabela ordena sozinha ao clicar no cabeçalho. */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  onRowActivate?: (row: T) => void;
  className?: string;
}) {
  const [internal, setInternal] = useState<SortState>(null);
  const ordenacao = sort !== undefined ? sort : internal;
  const aplicarOrdenacao = (next: SortState) => {
    if (sort === undefined) setInternal(next);
    onSortChange?.(next);
  };

  const linhasOrdenadas = useMemo(() => {
    if (!ordenacao) return rows;
    const coluna = columns.find((c) => c.id === ordenacao.columnId);
    if (!coluna?.sortValue) return rows;
    const sv = coluna.sortValue;
    return [...rows].sort((a, b) => compararValores(sv(a), sv(b), ordenacao.direction));
  }, [rows, columns, ordenacao]);

  const alternarOrdem = (columnId: string) => {
    const atual = ordenacao?.columnId === columnId ? ordenacao.direction : null;
    aplicarOrdenacao({ columnId, direction: atual === 'asc' ? 'desc' : 'asc' });
  };

  const selecionadas = new Set(selection?.selected ?? []);
  const todasSelecionadas = rows.length > 0 && rows.every((r) => selecionadas.has(rowKey(r)));
  const algumaSelecionada = rows.some((r) => selecionadas.has(rowKey(r)));
  const totalColunas = columns.length + (selection ? 1 : 0) + (actions ? 1 : 0);

  const alternarLinha = (key: string, marcado: boolean) => {
    if (!selection) return;
    const proximo = new Set(selection.selected);
    if (marcado) proximo.add(key);
    else proximo.delete(key);
    selection.onChange([...proximo]);
  };

  const alternarTodas = (marcado: boolean) => {
    if (!selection) return;
    const proximo = new Set(selection.selected);
    for (const r of rows) {
      if (marcado) proximo.add(rowKey(r));
      else proximo.delete(rowKey(r));
    }
    selection.onChange([...proximo]);
  };

  const classeCelula = (c: Column<T>) => cx(c.hideOnMobile && 'hidden md:table-cell', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center');

  return (
    <div className={cx('overflow-x-auto rounded-lg border border-slate-200 dark:border-navy-800', className)} aria-busy={loading || undefined}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {selection && (
              <th scope="col" className="w-10">
                <Checkbox checked={todasSelecionadas} indeterminate={!todasSelecionadas && algumaSelecionada} onChange={alternarTodas} aria-label="Selecionar todas as linhas" disabled={rows.length === 0} />
              </th>
            )}
            {columns.map((c) => {
              const ativa = ordenacao?.columnId === c.id ? ordenacao.direction : null;
              const ariaSort = c.sortValue ? (ativa === 'asc' ? 'ascending' : ativa === 'desc' ? 'descending' : 'none') : undefined;
              return (
                <th key={c.id} scope="col" aria-sort={ariaSort} className={classeCelula(c)}>
                  {c.sortValue ? (
                    <button type="button" onClick={() => alternarOrdem(c.id)} className="inline-flex items-center gap-1 font-semibold hover:text-navy-900 dark:hover:text-white">
                      {c.header}
                      {ativa === 'asc' && <ArrowUp className="h-3 w-3" aria-hidden="true" />}
                      {ativa === 'desc' && <ArrowDown className="h-3 w-3" aria-hidden="true" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {actions && (
              <th scope="col" className="text-right">
                <span className="sr-only">Ações</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <>
              <tr>
                <td colSpan={totalColunas}>
                  <span role="status" className="text-sm text-slate-500">
                    Carregando…
                  </span>
                </td>
              </tr>
              {Array.from({ length: loadingRows }).map((_, i) => (
                <tr key={`sk-${i}`} aria-hidden="true">
                  {Array.from({ length: totalColunas }).map((__, j) => (
                    <td key={j}>
                      <div className="h-4 w-full animate-pulse rounded bg-slate-200 dark:bg-navy-800" />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          ) : linhasOrdenadas.length === 0 ? (
            <tr>
              <td colSpan={totalColunas} className="py-8 text-center text-slate-400 dark:text-navy-300">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            linhasOrdenadas.map((row) => {
              const key = rowKey(row);
              const marcada = selecionadas.has(key);
              return (
                <tr
                  key={key}
                  data-selected={marcada || undefined}
                  tabIndex={onRowActivate ? 0 : undefined}
                  onKeyDown={
                    onRowActivate
                      ? (e) => {
                          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            onRowActivate(row);
                          }
                        }
                      : undefined
                  }
                  onClick={
                    onRowActivate
                      ? (e) => {
                          // Clique em controle interno (botão, checkbox, link) não ativa a linha.
                          if ((e.target as HTMLElement).closest('button,input,a,label,select')) return;
                          onRowActivate(row);
                        }
                      : undefined
                  }
                  className={cx(marcada && 'bg-navy-50/60 dark:bg-navy-800/50', onRowActivate && 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50')}
                >
                  {selection && (
                    <td>
                      <Checkbox
                        checked={marcada}
                        onChange={(v) => alternarLinha(key, v)}
                        aria-label={selection.rowLabel ? `Selecionar ${selection.rowLabel(row)}` : 'Selecionar linha'}
                      />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.id} className={classeCelula(c)}>
                      {c.cell(row)}
                    </td>
                  ))}
                  {actions && <td className="text-right">{actions(row)}</td>}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ----------------------------------------------------------------------------
// BulkActions — barra de ações sobre os registros selecionados.
// Só EXPÕE callbacks: nada é executado sem o clique do usuário.
// ----------------------------------------------------------------------------

export type BulkAction = { id: string; label: string; onRun: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean };

export function BulkActions({
  selectedCount,
  actions,
  onClear,
  maxVisible = 3,
  className,
}: {
  selectedCount: number;
  actions: BulkAction[];
  onClear: () => void;
  /** Quantas ações aparecem na barra; as demais vão para "Mais ações". */
  maxVisible?: number;
  className?: string;
}) {
  if (selectedCount <= 0) return null;
  const visiveis = actions.slice(0, maxVisible);
  const extras = actions.slice(maxVisible);
  return (
    <div
      role="region"
      aria-label="Ações em lote"
      className={cx('flex flex-wrap items-center gap-2 rounded-lg border border-navy-200 bg-navy-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-800/60', className)}
    >
      <span aria-live="polite" className="text-sm font-semibold text-navy-900 dark:text-white">
        {selectedCount} {selectedCount === 1 ? 'selecionado' : 'selecionados'}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {visiveis.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={a.onRun}
            disabled={a.disabled}
            className={cx('btn-secondary !py-1.5 !text-xs', a.danger && '!text-red-600 dark:!text-red-400')}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
        {extras.length > 0 && (
          <Dropdown
            label="Mais ações em lote"
            trigger={
              <>
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs">Mais</span>
              </>
            }
            items={extras.map((a) => ({ id: a.id, label: a.label, onSelect: a.onRun, disabled: a.disabled, danger: a.danger, icon: a.icon }))}
          />
        )}
      </div>
      <button type="button" onClick={onClear} className="btn-ghost ml-auto !py-1 !text-xs">
        Limpar seleção
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Breadcrumb — trilha de navegação. O último item é a página atual.
// Em telas pequenas, mostra só o pai imediato e o item atual.
// ----------------------------------------------------------------------------

export type BreadcrumbItem = { label: string; href?: string; onNavigate?: () => void };

export function Breadcrumb({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  if (items.length === 0) return null;
  const ultimo = items.length - 1;
  return (
    <nav aria-label="Trilha de navegação" className={className}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {items.map((item, i) => {
          const atual = i === ultimo;
          // Em telas pequenas, só o pai imediato e o atual aparecem.
          const ocultoNoMobile = i < ultimo - 1;
          return (
            <li key={`${item.label}-${i}`} className={cx('flex min-w-0 items-center gap-1.5', ocultoNoMobile && 'hidden sm:flex')}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
              {atual ? (
                <span aria-current="page" className="truncate font-semibold text-navy-900 dark:text-white">
                  {item.label}
                </span>
              ) : item.href ? (
                <a
                  href={item.href}
                  onClick={
                    item.onNavigate
                      ? (e) => {
                          e.preventDefault();
                          item.onNavigate?.();
                        }
                      : undefined
                  }
                  className="truncate text-slate-500 hover:text-navy-900 hover:underline dark:text-navy-300 dark:hover:text-white"
                >
                  {item.label}
                </a>
              ) : (
                <button type="button" onClick={item.onNavigate} className="truncate text-slate-500 hover:text-navy-900 hover:underline dark:text-navy-300 dark:hover:text-white">
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
