// ============================================================================
// Sidebar — Fase 3 "Brobond AI ERP" (Dark Mode Premium).
//
// Os links do ERP foram reorganizados em 9 grandes categorias: o Dashboard
// (link direto, sempre no topo) e 9 blocos colapsáveis (accordion). O estado
// aberto/fechado é React local + persistência em localStorage, com a categoria
// da rota atual sempre expandida automaticamente.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { GROUP_META, MODULE_GROUPS, visibleModules, type Module, type ModuleGroup } from '../modules';
import { Logo } from './Logo';
import { useAuth } from '../auth/AuthContext';

const STORAGE_KEY = 'brobond_nav_groups';

function readOpen(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, meta } = useAuth();
  const location = useLocation();
  const visible = useMemo(() => visibleModules(user), [user]);
  const top = visible.find((m) => m.group === null);

  // Categoria dona da rota atual — fica sempre expandida.
  const activeGroup = useMemo(() => {
    const path = location.pathname;
    const hit =
      visible.find((m) => m.path === path) || visible.filter((m) => m.path !== '/').find((m) => path.startsWith(m.path + '/'));
    return (hit?.group as ModuleGroup | undefined) ?? undefined;
  }, [location.pathname, visible]);

  const [openGroups, setOpenGroups] = useState<string[]>(() => readOpen());

  useEffect(() => {
    if (activeGroup) setOpenGroups((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]));
  }, [activeGroup]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(openGroups));
    } catch {
      /* sem persistência: vale só para esta sessão */
    }
  }, [openGroups]);

  const toggle = useCallback((g: string) => {
    setOpenGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }, []);

  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden" onClick={onClose} />}
      <aside
        className={`fixed z-30 flex h-full w-[17rem] flex-col border-r border-slate-800/60 bg-[#090d16]/95 text-slate-300 backdrop-blur-xl transition-transform duration-200 md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-800/60 px-5">
          <Logo variant="light" height={28} withTagline={false} />
          <button
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-white md:hidden"
            onClick={onClose}
            aria-label="Fechar menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-4" aria-label="Navegação principal">
          {top && <NavItem m={top} onClose={onClose} />}

          {MODULE_GROUPS.map((g) => {
            const items = visible.filter((m) => m.group === g);
            if (!items.length) return null;
            const isOpen = openGroups.includes(g) || activeGroup === g;
            const info = GROUP_META[g];
            const GroupIcon = info.icon;
            const panelId = `nav-${g.replace(/[^a-zA-Z]+/g, '-').toLowerCase()}`;
            return (
              <div key={g} className="pt-0.5">
                <button
                  type="button"
                  onClick={() => toggle(g)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] font-semibold tracking-wide transition-colors ${
                    activeGroup === g ? 'bg-white/[0.06] text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                  }`}
                >
                  <GroupIcon className={`h-4 w-4 shrink-0 ${activeGroup === g ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-400'}`} strokeWidth={2} />
                  <span className="flex-1 truncate">
                    <span className="mr-1.5" aria-hidden>
                      {info.emoji}
                    </span>
                    {g}
                  </span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{items.length}</span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                <div
                  id={panelId}
                  hidden={!isOpen}
                  className="mt-0.5 space-y-0.5 border-l border-slate-800/60 pl-2.5 ml-4"
                >
                  {items.map((m) => (
                    <NavItem key={m.id} m={m} onClose={onClose} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-slate-800/60 px-5 py-3 text-[11px] text-slate-500">
          <div className="flex items-center justify-between">
            <span className="font-mono">BROBOND AI ERP{meta?.version ? ` v${meta.version.replace(/^v/, '')}` : ''}</span>
            {meta?.mode === 'memory' && (
              <span
                className="rounded bg-brand-500/15 px-1.5 py-0.5 font-semibold text-brand-300"
                title="Sem banco de dados: os dados somem ao reiniciar o servidor"
              >
                DEMO
              </span>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function NavItem({ m, onClose }: { m: Module; onClose: () => void }) {
  const Icon = m.icon;
  return (
    <NavLink
      to={m.path}
      end={m.path === '/'}
      onClick={onClose}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[13px] font-medium transition-colors ${
          isActive
            ? 'bg-brand-500/10 text-white ring-1 ring-inset ring-brand-500/25'
            : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-300'}`} strokeWidth={2} />
          <span className="truncate">{m.label}</span>
        </>
      )}
    </NavLink>
  );
}
