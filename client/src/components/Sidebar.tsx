// ============================================================================
// Sidebar — navegação por áreas de negócio do ERP.
//
// Estrutura:
//   • Meu Negócio (início)
//   • ERP CORE: Cadastros, Vendas, Compras, Estoque, Produção, Logística,
//     Financeiro, Relatórios — accordions abertos automaticamente na rota atual
//   • COMMERCE / INTEGRAÇÕES — seção separada, recolhida por padrão
//   • Configurações
//
// Desktop: pode ser recolhida para um trilho só de ícones (preferência salva).
// Mobile: vira drawer (abre pelo botão do header). Tudo que aparece aqui vem de
// `visibleModules`, a mesma regra de permissão usada pelas rotas.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { GROUP_META, visibleModules, type Module, type ModuleGroup } from '../modules';
import { Logo } from './Logo';
import { useAuth } from '../auth/AuthContext';

const STORAGE_OPEN = 'brobond_nav_groups';
const STORAGE_COLLAPSED = 'brobond_nav_collapsed';

const ERP_GROUPS = [
  'Cadastros',
  'Vendas',
  'Compras',
  'Estoque',
  'Produção',
  'Logística & Expedição',
  'Financeiro',
  'Relatórios',
] as const satisfies readonly ModuleGroup[];

const COMMERCE_GROUPS = ['Integrações', 'Gestão de Commerce', 'Ecossistema Creators'] as const satisfies readonly ModuleGroup[];

const SYSTEM_GROUPS = ['Configurações'] as const satisfies readonly ModuleGroup[];

function readStringArray(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function slug(group: string) {
  return group.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z]+/g, '-').toLowerCase();
}

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, meta } = useAuth();
  const location = useLocation();
  const visible = useMemo(() => visibleModules(user), [user]);
  const home = visible.find((m) => m.group === null);

  // Área dona da rota atual (rotas filhas, ex.: /produtos/12, pertencem ao módulo pai).
  const activeGroup = useMemo<ModuleGroup | undefined>(() => {
    const path = location.pathname;
    const hit = visible.find((m) => m.path === path) || visible.filter((m) => m.path !== '/').find((m) => path.startsWith(m.path + '/'));
    return (hit?.group as ModuleGroup | undefined) ?? undefined;
  }, [location.pathname, visible]);

  const [openGroups, setOpenGroups] = useState<string[]>(() => readStringArray(STORAGE_OPEN));
  const [collapsed, setCollapsed] = useState<boolean>(() => readFlag(STORAGE_COLLAPSED));

  // A área da rota atual fica sempre expandida.
  useEffect(() => {
    if (activeGroup) setOpenGroups((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]));
  }, [activeGroup]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN, JSON.stringify(openGroups));
    } catch {
      /* sem persistência: vale só para esta sessão */
    }
  }, [openGroups]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_COLLAPSED, collapsed ? '1' : '0');
    } catch {
      /* idem */
    }
  }, [collapsed]);

  const toggle = useCallback((g: string) => {
    setOpenGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }, []);

  const renderGroup = (group: ModuleGroup) => {
    const items = visible.filter((m) => m.group === group);
    if (!items.length) return null;
    return (
      <NavGroup
        key={group}
        group={group}
        items={items}
        collapsed={collapsed}
        isOpen={openGroups.includes(group) || activeGroup === group}
        isActive={activeGroup === group}
        onClose={onClose}
        onToggle={toggle}
      />
    );
  };

  const commerceVisible = COMMERCE_GROUPS.some((g) => visible.some((m) => m.group === g));

  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        aria-label="Menu principal"
        className={`fixed z-30 flex h-full flex-col border-r border-slate-800/60 bg-[#090d16] text-slate-300 transition-[transform,width] duration-200 md:static md:translate-x-0 ${
          collapsed ? 'md:w-[4.25rem]' : 'md:w-[16.5rem]'
        } w-[16.5rem] ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-slate-800/60 ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
          {collapsed ? (
            <span className="text-base font-bold tracking-tight text-white" aria-label="BROBOND ERP">
              BB
            </span>
          ) : (
            <Logo variant="light" height={26} withTagline={false} />
          )}
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 md:hidden"
            onClick={onClose}
            aria-label="Fechar menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3" aria-label="Navegação principal">
          {home && <NavItem m={home} collapsed={collapsed} onClose={onClose} />}

          <div className="mt-4 space-y-0.5">
            {!collapsed && <SectionLabel>ERP</SectionLabel>}
            {collapsed && <Divider />}
            {ERP_GROUPS.map(renderGroup)}
          </div>

          {commerceVisible && (
            <div className="mt-4 space-y-0.5">
              {!collapsed && <SectionLabel>Commerce / Integrações</SectionLabel>}
              {collapsed && <Divider />}
              {COMMERCE_GROUPS.map(renderGroup)}
            </div>
          )}

          <div className="mt-4 space-y-0.5">
            {collapsed && <Divider />}
            {SYSTEM_GROUPS.map(renderGroup)}
          </div>
        </nav>

        <div className="hidden shrink-0 border-t border-slate-800/60 p-2 md:block">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            {!collapsed && <span>Recolher menu</span>}
          </button>
        </div>

        {!collapsed && (
          <div className="shrink-0 border-t border-slate-800/60 px-4 py-2.5 text-[11px] text-slate-500">
            <div className="flex items-center justify-between">
              <span className="font-mono">BROBOND ERP{meta?.version ? ` v${meta.version.replace(/^v/, '')}` : ''}</span>
              {meta?.mode === 'memory' && (
                <span className="rounded bg-brand-500/15 px-1.5 py-0.5 font-semibold text-brand-300" title="Sem banco de dados: os dados somem ao reiniciar o servidor">
                  DEMO
                </span>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">{children}</p>;
}

function Divider() {
  return <div className="mx-3 my-2 border-t border-slate-800/60" aria-hidden="true" />;
}

function NavGroup({
  group,
  items,
  collapsed,
  isOpen,
  isActive,
  onClose,
  onToggle,
}: {
  group: ModuleGroup;
  items: Module[];
  collapsed: boolean;
  isOpen: boolean;
  isActive: boolean;
  onClose: () => void;
  onToggle: (group: string) => void;
}) {
  const GroupIcon = GROUP_META[group].icon;
  const panelId = `nav-${slug(group)}`;

  // Trilho recolhido: sem cabeçalho de área, só os ícones dos módulos.
  if (collapsed) {
    return (
      <div className="space-y-0.5">
        {items.map((m) => (
          <NavItem key={m.id} m={m} collapsed onClose={onClose} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(group)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          isActive ? 'text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
        }`}
      >
        <GroupIcon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-300'}`} strokeWidth={2} aria-hidden="true" />
        <span className="flex-1 truncate">{group}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      <div id={panelId} hidden={!isOpen} className="mt-0.5 space-y-0.5 pl-3">
        {items.map((m) => (
          <NavItem key={m.id} m={m} onClose={onClose} />
        ))}
      </div>
    </div>
  );
}

function NavItem({ m, collapsed = false, onClose }: { m: Module; collapsed?: boolean; onClose: () => void }) {
  const Icon = m.icon;
  return (
    <NavLink
      to={m.path}
      end={m.path === '/'}
      onClick={onClose}
      title={collapsed ? m.label : undefined}
      aria-label={collapsed ? m.label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center gap-2.5 rounded-lg py-[7px] text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          collapsed ? 'justify-center px-0' : 'px-3'
        } ${
          isActive ? 'bg-white/[0.07] text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-400" aria-hidden="true" />}
          <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-300'}`} strokeWidth={2} aria-hidden="true" />
          {!collapsed && <span className="truncate">{m.label}</span>}
        </>
      )}
    </NavLink>
  );
}
