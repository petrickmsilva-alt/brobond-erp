import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import type { Tone } from '../lib/meta';

// ----------------------------------------------------------------------------
// Toasts (notificações)
// ----------------------------------------------------------------------------
type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: ToastKind; message: string };
type ToastCtx = { push: (kind: ToastKind, message: string) => void };

const ToastContext = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, message }]);
    // Todo aviso é efêmero e desaparece após 3s (inclusive erros). O
    // botão de fechar continua disponível para dispensar antes do prazo.
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-modal animate-slide-in ${
              t.kind === 'success'
                ? 'border-emerald-200 bg-white text-emerald-800 dark:border-emerald-800/60 dark:bg-navy-900 dark:text-emerald-400'
                : t.kind === 'error'
                  ? 'border-red-200 bg-white text-red-800 dark:border-red-800/60 dark:bg-navy-900 dark:text-red-400'
                  : 'border-navy-200 bg-white text-navy-800 dark:border-navy-700 dark:bg-navy-900 dark:text-navy-200'
            }`}
          >
            {t.kind === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />}
            {t.kind === 'error' && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
            {t.kind === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-navy-600" />}
            <span className="flex-1">{t.message}</span>
            <button
              className="text-slate-400 hover:text-slate-600 dark:text-navy-300 dark:hover:text-navy-300"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              aria-label="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastContext);
  if (!c) throw new Error('useToast deve ser usado dentro de ToastProvider');
  return {
    success: (m: string) => c.push('success', m),
    error: (m: string) => c.push('error', m),
    info: (m: string) => c.push('info', m),
  };
}

// ----------------------------------------------------------------------------
// Painel INLINE (nunca modal, nunca drawer, nunca sheet)
// ----------------------------------------------------------------------------
/**
 * ZERO MODAL — regra de produto do BROBOND ERP.
 *
 * `PainelInline` é o substituto DIRETO do antigo componente de modal. Ele
 * ocupa uma faixa do próprio conteúdo da página (sem `position: fixed`, sem
 * `inset-0`, sem backdrop, sem prender o foco, sem ESC para fechar) e mantém a
 * MESMA API (`open`, `title`, `subtitle`, `footer`), de modo que nenhum fluxo
 * de negócio precisou ser reescrito — só a superfície mudou.
 *
 * Regra: se o conteúdo é um cadastro/edição/detalhe de verdade, ele pertence a
 * uma PÁGINA (`/recurso/novo`, `/recurso/:id/editar`). O painel inline serve a
 * blocos auxiliares do próprio fluxo (leitura de código, conferência, ajuda,
 * exibição única de um segredo) — nunca como página disfarçada.
 */
export function PainelInline({
  open,
  onClose: _onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);
  if (!open) return null;
  const largura = size === 'sm' ? 'max-w-xl' : size === 'lg' ? 'max-w-4xl' : size === 'xl' ? 'max-w-6xl' : 'max-w-3xl';
  return (
    <section
      ref={box}
      aria-label={typeof title === 'string' ? title : undefined}
      className={`mt-4 w-full ${largura} rounded-xl border border-slate-200 bg-white shadow-sm dark:border-navy-800 dark:bg-navy-900`}
    >
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-3 dark:border-navy-800">
        <div>
          <h2 className="text-base font-bold text-navy-900 dark:text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-navy-300">{subtitle}</p>}
        </div>
        {_onClose && (
          <button className="btn-icon -mr-2" onClick={_onClose} aria-label="Fechar painel" type="button">
            <X className="h-5 w-5" />
          </button>
        )}
      </header>
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <footer className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-navy-800 dark:bg-navy-800/40">
          {footer}
        </footer>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Confirmação INLINE (nunca modal)
// ----------------------------------------------------------------------------
/**
 * ZERO MODAL — regra de produto do BROBOND ERP.
 *
 * Não existe `PainelInline`, `Dialog`, `Drawer` nem `Sheet` no ERP. Confirmações de
 * ação crítica acontecem **na própria página**, como um bloco de decisão no
 * fluxo do conteúdo: sem sobreposição, sem prender o foco, sem bloquear o
 * resto da tela. O bloco aparece onde foi declarado e é trazido para a área
 * visível quando abre.
 *
 * A decisão de negócio não muda: quem cancela não executa nada, quem confirma
 * dispara a mesma ação que antes. O que muda é a superfície.
 */
export function ConfirmacaoInline({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={box}
      role="group"
      aria-live="polite"
      aria-label={title}
      className={`mt-3 rounded-xl border-2 p-4 ${
        danger ? 'border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/30' : 'border-navy-200 bg-navy-50/70 dark:border-navy-700 dark:bg-navy-900/40'
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        {danger && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/60">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-navy-900 dark:text-white">{title}</p>
          <div className="mt-1 text-sm text-slate-600 dark:text-navy-300">{message}</div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <button className="btn-secondary" onClick={onCancel} disabled={busy} type="button">
            {cancelLabel}
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy} type="button">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Badge / etiquetas
// ----------------------------------------------------------------------------
const TONE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:ring-emerald-800/60',
  red: 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-400 dark:ring-red-800/60',
  amber: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-800/30 dark:text-brand-300 dark:ring-brand-700/50',
  blue: 'bg-navy-50 text-navy-700 ring-1 ring-navy-200 dark:bg-navy-800/50 dark:text-navy-300 dark:ring-navy-700',
  slate: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200 dark:bg-navy-800 dark:text-navy-300 dark:ring-navy-700',
};

export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${TONE[tone]}`}>{children}</span>;
}

// ----------------------------------------------------------------------------
// Estados
// ----------------------------------------------------------------------------
export function Spinner({ label = 'Carregando...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-navy-50 text-navy-500 dark:bg-navy-800 dark:text-navy-300">{icon}</div>}
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-navy-300">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'blue', children }: { tone?: Tone; children: ReactNode }) {
  const styles: Record<Tone, string> = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300',
    red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300',
    amber: 'border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-700/50 dark:bg-brand-800/20 dark:text-brand-300',
    blue: 'border-navy-200 bg-navy-50 text-navy-800 dark:border-navy-700 dark:bg-navy-800/40 dark:text-navy-200',
    slate: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-navy-700 dark:bg-navy-800/40 dark:text-navy-300',
  };
  const isNegative = tone === 'red';
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${styles[tone]}`} role={isNegative ? 'alert' : undefined} aria-live={isNegative ? 'assertive' : 'polite'}>
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-navy-900 sm:text-2xl dark:text-white">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500 dark:text-navy-300">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
