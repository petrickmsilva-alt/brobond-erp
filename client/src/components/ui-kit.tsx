// ============================================================================
// Design System — componentes base (Etapa 1).
//
// Complementa components/ui.tsx sem alterá-lo. Regras:
//   • cores só via tokens semânticos (src/index.css → surface, line, ink...);
//   • estado nunca depende só de cor: sempre há texto (ou ícone + texto);
//   • loading / erro / vazio têm componente próprio e reutilizável.
// ============================================================================
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, RotateCcw, Search, X, type LucideIcon } from 'lucide-react';

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
