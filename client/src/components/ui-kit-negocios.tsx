// ============================================================================
// Design System — componentes base (Etapa 1).
//
// Complementa components/ui.tsx sem alterá-lo. Regras:
//   • cores só via tokens semânticos (src/index.css → surface, line, ink...);
//   • estado nunca depende só de cor: sempre há texto (ou ícone + texto);
//   • loading / erro / vazio têm componente próprio e reutilizável.
// ============================================================================
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Minus, RotateCcw, Search, X, type LucideIcon } from 'lucide-react';

// ----------------------------------------------------------------------------
// Superfícies
// ----------------------------------------------------------------------------

/** Cartão padrão do ERP (superfície + borda 1px, sem sombra pesada). */
export function Card({ className = '', children, as: Tag = 'section' }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' }) {
  return <Tag className={`rounded-xl border border-line bg-surface shadow-card dark:shadow-none ${className}`}>{children}</Tag>;
}

/** Cabeçalho de cartão: título, legenda opcional e ações à direita. */
export function CardHeader({ title, subtitle, icon: Icon, actions }: { title: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />}
          <span className="truncate">{title}</span>
        </h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Estados: carregando, vazio e erro
// ----------------------------------------------------------------------------

/** Bloco animado de carregamento. Decorativo: quem usa informa o texto com LoadingState. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-line/70 ${className}`} />;
}

/** Estado de carregamento de uma seção (lista de linhas esqueleto). */
export function LoadingState({ rows = 3, label = 'Carregando dados…' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2.5 px-4 py-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i % 3 === 2 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** Estado de erro de uma seção, com ação para tentar de novo. Mensagem em linguagem de usuário. */
export function ErrorState({ message, onRetry, title = 'Não foi possível carregar esta seção' }: { message?: string; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-4 py-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          {message && <p className="text-xs text-muted">{message}</p>}
        </div>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-secondary !py-1.5 text-xs">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Tentar novamente
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Status e variações
// ----------------------------------------------------------------------------

type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const STATUS_TONE: Record<StatusTone, { chip: string; dot: string }> = {
  success: { chip: 'bg-success/10 text-success ring-success/30', dot: 'bg-success' },
  warning: { chip: 'bg-warning/10 text-warning ring-warning/30', dot: 'bg-warning' },
  danger: { chip: 'bg-danger/10 text-danger ring-danger/30', dot: 'bg-danger' },
  info: { chip: 'bg-info/10 text-info ring-info/30', dot: 'bg-info' },
  muted: { chip: 'bg-line/50 text-muted ring-line', dot: 'bg-muted' },
};

/**
 * Vocabulário de status do ERP (contas, estoque, pedidos). O texto sempre aparece
 * junto da cor e do ponto, para não depender só de cor (acessibilidade).
 */
export const STATUS_PRESETS: Record<string, { label: string; tone: StatusTone }> = {
  pago: { label: 'Pago', tone: 'success' },
  ativo: { label: 'Ativo', tone: 'success' },
  normal: { label: 'Normal', tone: 'success' },
  aberto: { label: 'Aberto', tone: 'warning' },
  pendente: { label: 'Pendente', tone: 'warning' },
  baixo: { label: 'Baixo', tone: 'warning' },
  parcial: { label: 'Parcial', tone: 'info' },
  vencido: { label: 'Vencido', tone: 'danger' },
  critico: { label: 'Crítico', tone: 'danger' },
  zerado: { label: 'Zerado', tone: 'muted' },
  inativo: { label: 'Inativo', tone: 'muted' },
  cancelado: { label: 'Cancelado', tone: 'muted' },
};

export function StatusBadge({ status, label, tone }: { status: string; label?: string; tone?: StatusTone }) {
  const preset = STATUS_PRESETS[status.toLowerCase()];
  const t = tone ?? preset?.tone ?? 'muted';
  const text = label ?? preset?.label ?? status;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_TONE[t].chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_TONE[t].dot}`} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * Variação em relação ao período anterior. Usa seta + texto ("aumento"/"queda"),
 * então o sentido também é lido sem cor. `inverter` = para custos (subir é ruim).
 */
export function DeltaBadge({ valor, unidade = '%', inverter = false }: { valor: number | null; unidade?: '%' | ' p.p.'; inverter?: boolean }) {
  if (valor === null || !Number.isFinite(valor)) {
    return <span className="text-xs text-muted">sem comparação</span>;
  }
  if (Math.abs(valor) < 0.05) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
        <Minus className="h-3 w-3" aria-hidden="true" /> estável
      </span>
    );
  }
  const sobe = valor > 0;
  const bom = inverter ? !sobe : sobe;
  const Icon = sobe ? ArrowUpRight : ArrowDownRight;
  const texto = `${Math.abs(valor).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}${unidade}`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${bom ? 'text-success' : 'text-danger'}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{texto}</span>
      <span className="sr-only">{`${sobe ? 'aumento' : 'queda'} de ${texto} em relação ao período anterior`}</span>
    </span>
  );
}

/** Indicador de KPI: rótulo, valor grande, variação e legenda. Pode ser link para o detalhe. */
export function StatCard({
  label,
  value,
  hint,
  delta,
  deltaUnit,
  inverterDelta,
  icon: Icon,
  to,
  testId,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: number | null;
  deltaUnit?: '%' | ' p.p.';
  inverterDelta?: boolean;
  icon?: LucideIcon;
  to?: string;
  testId?: string;
}) {
  const corpo = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
      </div>
      <div className="mt-2 truncate font-mono text-2xl font-semibold tabular-nums tracking-tight text-ink" title={typeof value === 'string' ? value : undefined}>
        {value}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {delta !== undefined && <DeltaBadge valor={delta} unidade={deltaUnit} inverter={inverterDelta} />}
        {hint && <span className="truncate text-xs text-muted">{hint}</span>}
      </div>
    </>
  );
  const base = 'block rounded-xl border border-line bg-surface p-4 shadow-card dark:shadow-none';
  if (to) {
    return (
      <Link to={to} data-testid={testId} className={`${base} transition-colors hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}>
        {corpo}
      </Link>
    );
  }
  return (
    <div data-testid={testId} className={base}>
      {corpo}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Filtros e busca
// ----------------------------------------------------------------------------

/** Barra de filtros: campos simples na linha; quebra em telas pequenas. */
export function FilterBar({ children, actions, label = 'Filtros' }: { children: ReactNode; actions?: ReactNode; label?: string }) {
  return (
    <div role="search" aria-label={label} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3">
      {children}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Campo de busca com rótulo acessível e botão de limpar. */
export function SearchInput({ value, onChange, placeholder = 'Buscar…', label = 'Buscar' }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const id = useId();
  return (
    <div className="relative min-w-[12rem] flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input pl-8"
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sobreposições: drawer e tooltip
// ----------------------------------------------------------------------------

/**
 * Painel lateral (drawer) para filtros avançados e detalhes rápidos.
 * Fecha com Esc e com o botão; ao fechar devolve o foco a quem o abriu.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const anterior = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      anterior?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md flex-col bg-surface shadow-modal outline-none animate-slide-in"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="btn-icon shrink-0" aria-label="Fechar painel">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Dica de texto ao passar o mouse ou focar. Para ícones e abreviações; o texto também vai ao aria-describedby. */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span aria-describedby={id}>{children}</span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-medium text-surface shadow-modal group-hover:block group-focus-within:block"
      >
        {content}
      </span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// Abas (tabs) — alternância entre visões do mesmo bloco
// ----------------------------------------------------------------------------

/**
 * Abas acessíveis (tablist/tab) com navegação por setas (esquerda/direita,
 * Home/End) além do clique/toque. Usado onde o bloco tem visões alternativas
 * (ex.: níveis do estoque valorizado).
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const atual = Math.max(
    0,
    tabs.findIndex((t) => t.key === value)
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    let proximo: number | null = null;
    if (e.key === 'ArrowRight') proximo = (atual + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') proximo = (atual - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') proximo = 0;
    else if (e.key === 'End') proximo = tabs.length - 1;
    if (proximo !== null) {
      e.preventDefault();
      onChange(tabs[proximo].key);
      // O foco acompanha a aba (padrão WAI-APG de ativação automática).
      // currentTarget é a tablist (dona do onKeyDown); os filhos são as abas.
      (e.currentTarget.children[proximo] as HTMLElement | undefined)?.focus();
    }
  };

  return (
    <div role="tablist" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-canvas p-1 text-xs" onKeyDown={onKeyDown}>
      {tabs.map((t, i) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === value}
          tabIndex={i === atual ? 0 : -1}
          onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
            t.key === value ? 'bg-surface text-ink shadow-card dark:shadow-none' : 'text-muted hover:text-ink-soft'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Combobox — seleção com busca (listas vindas do servidor)
// ----------------------------------------------------------------------------

export type ComboboxOption = { value: string; label: string; hint?: string };

/**
 * Seleção em lista com filtro por texto. Acessível: input com role=combobox,
 * lista com role=listbox/option, navegação por setas + Enter/Esc, e a lista
 * fecha ao clicar fora. As opções vêm do chamador (ex.: grupos de canal do
 * /api/negocios/canais) — o componente nunca inventa opção.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  placeholder = 'Selecionar…',
  hint,
  id: idProp,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  hint?: string;
  id?: string;
}) {
  const baseId = useId();
  const id = idProp ?? `${baseId}-combo`;
  const listId = `${baseId}-lista`;
  const hintId = `${baseId}-dica`;
  const selecionada = options.find((o) => o.value === value) ?? null;

  const [aberta, setAberta] = useState(false);
  const [texto, setTexto] = useState<string | null>(null); // null = mostra o rótulo selecionado
  const [destaque, setDestaque] = useState(0);
  const caixaRef = useRef<HTMLDivElement>(null);

  const normalizar = (s: string) => s.trim().toLowerCase();
  const filtradas = texto === null || texto === '' ? options : options.filter((o) => normalizar(o.label).includes(normalizar(texto)));
  const visivel = texto ?? selecionada?.label ?? '';

  // Fecha ao clicar fora; ao fechar sem escolher, volta ao rótulo selecionado.
  useEffect(() => {
    if (!aberta) return;
    const onDoc = (e: MouseEvent) => {
      if (caixaRef.current && !caixaRef.current.contains(e.target as Node)) {
        setAberta(false);
        setTexto(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [aberta]);

  const escolher = (v: string) => {
    onChange(v);
    setAberta(false);
    setTexto(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAberta(true);
      setDestaque((d) => Math.min(filtradas.length - 1, (aberta ? d : -1) + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setDestaque((d) => Math.max(0, d - 1));
    } else if (e.key === 'Enter') {
      if (aberta && filtradas[destaque]) {
        e.preventDefault();
        escolher(filtradas[destaque].value);
      }
    } else if (e.key === 'Escape') {
      setAberta(false);
      setTexto(null);
    }
  };

  return (
    <div ref={caixaRef} className="relative min-w-[11rem]">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={aberta}
          aria-controls={listId}
          aria-activedescendant={aberta && filtradas[destaque] ? `${listId}-${destaque}` : undefined}
          aria-describedby={hint ? hintId : undefined}
          autoComplete="off"
          placeholder={placeholder}
          value={visivel}
          onChange={(e) => {
            setTexto(e.target.value);
            setAberta(true);
            setDestaque(0);
          }}
          // Ao focar, limpa o campo para receber o filtro (sem isso, o texto
          // novo seria grudado ao rótulo exibido). A opção atual continua
          // marcada na lista; sair sem escolher restaura o rótulo.
          onFocus={() => {
            setTexto('');
            setAberta(true);
            setDestaque(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Saiu sem escolher (Tab ou clique fora): fecha e restaura o rótulo.
            // (Escolher com o mouse usa mousedown com preventDefault, que não
            // dispara blur — não há corrida aqui.)
            setAberta(false);
            setTexto(null);
          }}
          className="input pr-8"
        />
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {aberta && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-modal"
        >
          {filtradas.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted" aria-disabled="true">
              Nenhuma opção encontrada.
            </li>
          )}
          {filtradas.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => {
                // mousedown (antes do blur) para escolher antes de fechar.
                e.preventDefault();
                escolher(o.value);
              }}
              onMouseEnter={() => setDestaque(i)}
              className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${
                i === destaque ? 'bg-canvas text-ink' : 'text-ink-soft'
              }`}
            >
              <span>
                {o.label}
                {o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
              </span>
              {o.value === value && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Data e intervalo de datas
// ----------------------------------------------------------------------------

/**
 * Campo de data com rótulo, dica e erro acessíveis. Usa o seletor nativo do
 * navegador (type=date): funciona com teclado, leitor de tela e traz o
 * calendário próprio do celular — sem reinventar calendário.
 */
export function DatePicker({
  label,
  value,
  onChange,
  hint,
  error,
  min,
  max,
  id: idProp,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string | null;
  min?: string;
  max?: string;
  id?: string;
}) {
  const baseId = useId();
  const id = idProp ?? `${baseId}-data`;
  const descId = `${baseId}-desc`;
  const temDesc = hint || error;
  return (
    <div>
      <label htmlFor={id} className="label">
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
          {label}
        </span>
      </label>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={temDesc ? descId : undefined}
        className={`input ${error ? '!border-danger' : ''}`}
      />
      {temDesc && (
        <p id={descId} className={`mt-1 text-xs ${error ? 'text-danger' : 'text-muted'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/**
 * Intervalo de datas (De/Até) com legenda e erro do intervalo. O erro (ex.:
 * data inicial depois da final) é anunciado (aria-live) e associado ao grupo.
 */
export function DateRangePicker({
  legend,
  de,
  ate,
  onChange,
  error,
  hint,
}: {
  legend: string;
  de: string;
  ate: string;
  onChange: (v: { de: string; ate: string }) => void;
  error?: string | null;
  hint?: string;
}) {
  const baseId = useId();
  // group + contents (em vez de fieldset): mesma semântica anunciada, sem o
  // bug histórico de fieldset com display:contents em alguns navegadores.
  return (
    <div role="group" aria-label={legend} className="contents">
      <DatePicker label="De" value={de} onChange={(v) => onChange({ de: v, ate })} max={ate || undefined} />
      <DatePicker label="Até" value={ate} onChange={(v) => onChange({ de, ate: v })} min={de || undefined} />
      {(error || hint) && (
        <p id={`${baseId}-erro`} aria-live="polite" className={`w-full text-xs ${error ? 'text-danger' : 'text-muted'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Tabela de dados + paginação
// ----------------------------------------------------------------------------

export type DataTableColumn<T> = {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
};

const ALIGN: Record<string, string> = { left: 'text-left', right: 'text-right', center: 'text-center' };

/**
 * Tabela de dados com cabeçalho, legenda para leitor de tela e estado vazio.
 * As linhas e a ordenação vêm prontas do chamador (em geral, do servidor).
 */
export function DataTable<T>({
  columns,
  rows,
  caption,
  empty,
  getRowKey,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  caption: string;
  empty: ReactNode;
  getRowKey: (row: T, index: number) => string | number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={ALIGN[c.align ?? 'left']}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-sm text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={getRowKey(row, i)}>
                {columns.map((c) => (
                  <td key={c.key} className={ALIGN[c.align ?? 'left']}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Paginação acessível (nav + aria-current na página atual, botões
 * desabilitados nos extremos). Controlada: o chamador detém `page` e fatia
 * as linhas (ou consulta a página no servidor).
 */
export function Pagination({
  page,
  totalPages,
  onChange,
  label = 'Paginação',
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
  label?: string;
}) {
  if (totalPages <= 1) return null;
  const atual = Math.min(Math.max(1, page), totalPages);

  // Janela de páginas: mostra todas até 7; acima disso, 1 … janela … N.
  const janela: (number | '…')[] = [];
  if (totalPages <= 7) {
    for (let p = 1; p <= totalPages; p++) janela.push(p);
  } else {
    const inicio = Math.max(2, Math.min(totalPages - 3, atual - 1));
    janela.push(1);
    if (inicio > 2) janela.push('…');
    for (let p = inicio; p <= Math.min(totalPages - 1, inicio + 2); p++) janela.push(p);
    if (inicio + 2 < totalPages - 1) janela.push('…');
    janela.push(totalPages);
  }

  const btn = 'btn-icon !h-8 !w-8 shrink-0';
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-center gap-1 border-t border-line px-4 py-2.5">
      <button type="button" className={btn} disabled={atual === 1} onClick={() => onChange(1)} aria-label="Primeira página">
        <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" className={btn} disabled={atual === 1} onClick={() => onChange(atual - 1)} aria-label="Página anterior">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      {janela.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} aria-hidden="true" className="px-1 text-xs text-muted">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            aria-label={`Página ${p}`}
            aria-current={p === atual ? 'page' : undefined}
            className={`h-8 min-w-8 rounded-lg px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              p === atual ? 'bg-primary font-semibold text-white dark:bg-accent dark:text-ink' : 'text-ink-soft hover:bg-canvas'
            }`}
          >
            {p}
          </button>
        )
      )}
      <button
        type="button"
        className={btn}
        disabled={atual === totalPages}
        onClick={() => onChange(atual + 1)}
        aria-label="Próxima página"
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={btn}
        disabled={atual === totalPages}
        onClick={() => onChange(totalPages)}
        aria-label="Última página"
      >
        <ChevronsRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </nav>
  );
}
