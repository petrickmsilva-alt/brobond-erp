// ============================================================================
// Sidebar — Árvore Master de navegação do BROBOND ERP (ERP-UX-03).
//
// Hierarquia oficial:
//   SEÇÃO (ERP CORE · Commerce · Creators · Utilidades Globais)
//   → ÁREA (Meu Negócio, Cadastros, Vendas, Estoque & Suprimentos, Produção,
//           Financeiro, Fiscal, Administração, Commerce, Creators, Utilidades Globais)
//   → GRUPO (accordion de 2º nível dentro da Área)
//   → SUBGRUPO (cabeçalho visual distinto dos módulos)
//   → MÓDULO (item navegável canônico)
//
// Fonte única: `buildNavigationTree(visibleModules(user))` de `modules.ts`.
// Não há listas paralelas de áreas, grupos ou módulos neste componente.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import {
  buildNavigationTree,
  moduleOfPath,
  visibleModules,
  type Module,
  type ModuleArea,
  type ModuleGroup,
  type NavAreaNode,
  type NavGroupNode,
} from '../modules';
import { Logo } from './Logo';
import { useAuth } from '../auth/AuthContext';

const STORAGE_OPEN_AREAS = 'brobond_nav_areas';
const STORAGE_OPEN_GROUPS = 'brobond_nav_groups';
const STORAGE_COLLAPSED = 'brobond_nav_collapsed';

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

function slug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, meta } = useAuth();
  const location = useLocation();
  const visible = useMemo(() => visibleModules(user), [user]);
  const tree = useMemo(() => buildNavigationTree(visible), [visible]);

  // Módulo, Área e Grupo donos da rota atual (rotas filhas, ex.: /produtos/12,
  // pertencem ao módulo pai — mesma regra do breadcrumb e do título da aba).
  const activeModule = useMemo(() => moduleOfPath(location.pathname, visible), [location.pathname, visible]);
  const activeArea = activeModule?.area;
  const activeGroup = activeModule?.group;

  const [openAreas, setOpenAreas] = useState<string[]>(() => {
    const saved = readStringArray(STORAGE_OPEN_AREAS);
    return activeArea && !saved.includes(activeArea) ? [...saved, activeArea] : saved;
  });

  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    const saved = readStringArray(STORAGE_OPEN_GROUPS);
    return activeGroup && !saved.includes(activeGroup) ? [...saved, activeGroup] : saved;
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => readFlag(STORAGE_COLLAPSED));

  // Deep link / mudança de rota: garante que a Área e o Grupo do módulo ativo abram.
  useEffect(() => {
    if (activeArea) {
      setOpenAreas((prev) => (prev.includes(activeArea) ? prev : [...prev, activeArea]));
    }
  }, [activeArea]);

  useEffect(() => {
    if (activeGroup) {
      setOpenGroups((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]));
    }
  }, [activeGroup]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN_AREAS, JSON.stringify(openAreas));
    } catch {
      /* sem persistência: vale só para esta sessão */
    }
  }, [openAreas]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_OPEN_GROUPS, JSON.stringify(openGroups));
    } catch {
      /* idem */
    }
  }, [openGroups]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_COLLAPSED, collapsed ? '1' : '0');
    } catch {
      /* idem */
    }
  }, [collapsed]);

  // Acessibilidade: Escape fecha o drawer mobile quando estiver aberto.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const toggleArea = useCallback((area: ModuleArea) => {
    setOpenAreas((prev) => (prev.includes(area) ? prev.filter((x) => x !== area) : [...prev, area]));
  }, []);

  const toggleGroup = useCallback((group: ModuleGroup) => {
    setOpenGroups((prev) => (prev.includes(group) ? prev.filter((x) => x !== group) : [...prev, group]));
  }, []);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
          data-testid="sidebar-backdrop"
        />
      )}
      <aside
        id="sidebar-principal"
        aria-label="Menu principal"
        data-collapsed={collapsed ? 'true' : 'false'}
        data-mobile-open={open ? 'true' : 'false'}
        className={`fixed z-30 flex h-full flex-col border-r border-slate-800/60 bg-[#090d16] text-slate-300 transition-[transform,width] duration-200 md:static md:translate-x-0 ${
          collapsed ? 'md:w-[4.25rem]' : 'md:w-[17rem]'
        } w-[17rem] ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div
          className={`flex h-16 shrink-0 items-center border-b border-slate-800/60 ${
            collapsed ? 'justify-center px-2' : 'justify-between px-4'
          }`}
        >
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
          {tree.map((section, sectionIdx) => (
            <div key={section.id} className={sectionIdx === 0 ? 'space-y-0.5' : 'mt-4 space-y-0.5'} data-nav-section={section.id}>
              {collapsed ? (
                sectionIdx > 0 ? <Divider /> : null
              ) : section.label ? (
                <SectionLabel>{section.label}</SectionLabel>
              ) : null}
              {section.areas.map((areaNode) => (
                <NavArea
                  key={areaNode.area}
                  areaNode={areaNode}
                  collapsed={collapsed}
                  isOpen={openAreas.includes(areaNode.area)}
                  isActive={activeArea === areaNode.area}
                  activeGroup={activeGroup}
                  openGroups={openGroups}
                  onClose={onClose}
                  onToggleArea={toggleArea}
                  onToggleGroup={toggleGroup}
                />
              ))}
            </div>
          ))}
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
                <span
                  className="rounded bg-brand-500/15 px-1.5 py-0.5 font-semibold text-brand-300"
                  title="Sem banco de dados: os dados somem ao reiniciar o servidor"
                >
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

function NavArea({
  areaNode,
  collapsed,
  isOpen,
  isActive,
  activeGroup,
  openGroups,
  onClose,
  onToggleArea,
  onToggleGroup,
}: {
  areaNode: NavAreaNode;
  collapsed: boolean;
  isOpen: boolean;
  isActive: boolean;
  activeGroup?: ModuleGroup;
  openGroups: string[];
  onClose: () => void;
  onToggleArea: (area: ModuleArea) => void;
  onToggleGroup: (group: ModuleGroup) => void;
}) {
  const AreaIcon = areaNode.icon;
  const areaPanelId = `nav-area-${slug(areaNode.area)}`;

  // Trilho recolhido: exibe os ícones dos módulos com contexto de área no tooltip.
  if (collapsed) {
    return (
      <div className="space-y-0.5">
        {areaNode.modules.map((m) => (
          <NavItem key={m.id} m={m} collapsed onClose={onClose} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        data-nav-area={areaNode.area}
        onClick={() => onToggleArea(areaNode.area)}
        aria-expanded={isOpen}
        aria-controls={areaPanelId}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          isActive ? 'bg-white/[0.04] text-white' : 'text-slate-300 hover:bg-white/[0.04] hover:text-white'
        }`}
      >
        <AreaIcon
          className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-300'}`}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className="flex-1 truncate">{areaNode.area}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      <div id={areaPanelId} hidden={!isOpen} className="mt-0.5 ml-3.5 space-y-0.5 border-l border-slate-800/80 pl-2">
        {areaNode.groups.map((groupNode) => (
          <NavGroup
            key={groupNode.group}
            groupNode={groupNode}
            isOpen={openGroups.includes(groupNode.group)}
            isActive={activeGroup === groupNode.group}
            onClose={onClose}
            onToggle={onToggleGroup}
          />
        ))}
      </div>
    </div>
  );
}

function NavGroup({
  groupNode,
  isOpen,
  isActive,
  onClose,
  onToggle,
}: {
  groupNode: NavGroupNode;
  isOpen: boolean;
  isActive: boolean;
  onClose: () => void;
  onToggle: (group: ModuleGroup) => void;
}) {
  const GroupIcon = groupNode.icon;
  const groupPanelId = `nav-group-${slug(groupNode.area)}-${slug(groupNode.group)}`;

  return (
    <div>
      <button
        type="button"
        data-nav-group={groupNode.group}
        onClick={() => onToggle(groupNode.group)}
        aria-expanded={isOpen}
        aria-controls={groupPanelId}
        className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          isActive ? 'text-slate-100 font-semibold' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200'
        }`}
      >
        <GroupIcon
          className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-slate-300'}`}
          strokeWidth={1.9}
          aria-hidden="true"
        />
        <span className="flex-1 truncate">{groupNode.group}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      <div id={groupPanelId} hidden={!isOpen} className="mt-0.5 space-y-1 pl-2">
        {groupNode.subgroups.map((sub) => (
          <div key={sub.subgroup} className="space-y-0.5">
            <div
              data-nav-subgroup={sub.subgroup}
              className=" select-none px-2.5 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500"
            >
              {sub.subgroup}
            </div>
            {sub.modules.map((m) => (
              <NavItem key={m.id} m={m} onClose={onClose} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NavItem({ m, collapsed = false, onClose }: { m: Module; collapsed?: boolean; onClose: () => void }) {
  const Icon = m.icon;
  const isPlanned = Boolean(m.planned?.length);

  return (
    <NavLink
      to={m.path}
      end={m.path === '/'}
      onClick={onClose}
      data-module-id={m.id}
      data-planned={isPlanned ? 'true' : undefined}
      title={collapsed ? `${m.area} → ${m.label}${isPlanned ? ' (Em breve)' : ''}` : isPlanned ? `${m.label} — Em breve` : undefined}
      aria-label={collapsed ? m.label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center gap-2 rounded-lg py-[6px] text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
          collapsed ? 'justify-center px-0' : 'px-2.5'
        } ${
          isActive
            ? 'bg-white/[0.08] text-white'
            : isPlanned
              ? 'text-slate-400/80 hover:bg-white/[0.03] hover:text-slate-200'
              : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-400" aria-hidden="true" />}
          <Icon
            className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-brand-400' : 'text-slate-500 group-hover:text-brand-300'}`}
            strokeWidth={2}
            aria-hidden="true"
          />
          {!collapsed && <span className="truncate">{m.label}</span>}
          {!collapsed && isPlanned && (
            <span
              data-planned-badge="Em breve"
              className="ml-auto shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300 after:content-[attr(data-planned-badge)]"
              aria-hidden="true"
            />
          )}
        </>
      )}
    </NavLink>
  );
}
