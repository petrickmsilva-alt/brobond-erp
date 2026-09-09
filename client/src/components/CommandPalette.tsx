import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, KeyRound, LogOut, Search, UserRound } from 'lucide-react';
import { visibleModules, type Module } from '../modules';
import { useAuth } from '../auth/AuthContext';

type Item = {
  id: string;
  label: string;
  description?: string;
  icon: Module['icon'];
  keywords?: string;
  action: () => void;
};

/**
 * Busca global (Ctrl/Cmd+K): navega para qualquer um dos módulos visíveis para
 * o perfil do usuário sem precisar procurar na sidebar. Aberta pelo Layout.
 */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const modules = visibleModules(user).filter((m) => m.path !== '/');
    const fromModules: Item[] = modules.map((m) => ({
      id: `mod-${m.id}`,
      label: m.label,
      description: m.description,
      icon: m.icon,
      keywords: `${m.group ?? ''} ${m.label}`,
      action: () => navigate(m.path),
    }));
    const extras: Item[] = [
      {
        id: 'acao-minha-conta',
        label: 'Minha conta',
        description: 'Nome, e-mail, perfil e informações do sistema.',
        icon: UserRound,
        action: () => navigate('/config'),
      },
      {
        id: 'acao-trocar-senha',
        label: 'Trocar senha',
        description: 'Definir uma nova senha de acesso.',
        icon: KeyRound,
        action: () => navigate('/config#senha'),
      },
      {
        id: 'acao-sair',
        label: 'Sair',
        description: 'Encerrar a sessão atual.',
        icon: LogOut,
        keywords: 'logout encerrar sessao',
        action: () => logout(),
      },
    ];
    return [
      {
        id: 'mod-dashboard',
        label: 'Dashboard',
        description: 'Visão geral do negócio.',
        icon: modules[0]?.icon ?? UserRound,
        action: () => navigate('/'),
      },
      ...fromModules,
      ...extras,
    ];
  }, [user, navigate, logout]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    const scored = items
      .map((it) => {
        const haystack = `${it.label} ${it.keywords ?? ''} ${it.description ?? ''}`.toLowerCase();
        const labelLower = it.label.toLowerCase();
        let score = -1;
        if (labelLower.startsWith(term)) score = 3;
        else if (labelLower.includes(term)) score = 2;
        else if (haystack.includes(term)) score = 1;
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.it);
  }, [q, items]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      // Aguarda o modal montar antes de focar.
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(item: Item) {
    item.action();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[active];
      if (chosen) choose(chosen);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Busca rápida">
      <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal animate-fade-in dark:bg-navy-900" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3 dark:border-navy-800">
          <Search className="h-4.5 w-4.5 shrink-0 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ir para um módulo... (produtos, vendas, financeiro...)"
            className="w-full border-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 dark:text-slate-100 dark:placeholder:text-navy-500"
            aria-label="Buscar módulo ou ação"
            aria-activedescendant={results[active] ? `cmd-item-${results[active].id}` : undefined}
            role="combobox"
            aria-expanded
            aria-controls="cmd-palette-list"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:inline dark:border-navy-700 dark:bg-navy-800">Esc</kbd>
        </div>

        <div ref={listRef} id="cmd-palette-list" role="listbox" className="flex-1 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-slate-400">Nada encontrado para "{q}".</p>
          ) : (
            results.map((it, idx) => {
              const Icon = it.icon;
              const isActive = idx === active;
              return (
                <button
                  key={it.id}
                  id={`cmd-item-${it.id}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={isActive}
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(it)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isActive ? 'bg-navy-50 dark:bg-navy-800' : 'hover:bg-slate-50 dark:hover:bg-navy-800/60'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isActive ? 'bg-navy-800 text-white dark:bg-brand-500' : 'bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-navy-300'}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-navy-900 dark:text-slate-100">{it.label}</span>
                    {it.description && <span className="block truncate text-xs text-slate-400 dark:text-navy-300">{it.description}</span>}
                  </span>
                  {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-navy-400" />}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-400 dark:border-navy-800 dark:bg-navy-800/40">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-white px-1 py-0.5 dark:border-navy-700 dark:bg-navy-900">↑</kbd>
            <kbd className="rounded border border-slate-200 bg-white px-1 py-0.5 dark:border-navy-700 dark:bg-navy-900">↓</kbd> navegar
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-white px-1 py-0.5 dark:border-navy-700 dark:bg-navy-900">Enter</kbd> abrir
          </span>
        </div>
      </div>
    </div>
  );
}
