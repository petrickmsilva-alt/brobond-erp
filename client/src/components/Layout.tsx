import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, KeyRound, LogOut, Menu, Search, UserRound } from 'lucide-react';
import Sidebar from './Sidebar';
import CommandPalette from './CommandPalette';
import CompanySwitcher from './CompanySwitcher';
import { Breadcrumb, type BreadcrumbItem } from './ui-kit';
import { useAuth } from '../auth/AuthContext';
import { moduleOfPath } from '../modules';

const PERFIL_LABEL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };

/**
 * Rótulo do último nível (registro/filho) do breadcrumb a partir da URL.
 * Nada de mapa de rotas: o nível anterior já veio do módulo dono da rota.
 */
function rotuloDoRegistro(pathname: string): string {
  const ultimo = pathname.split('/').filter(Boolean).pop() ?? '';
  if (/^\d+$/.test(ultimo)) return `#${ultimo}`;
  return ultimo ? ultimo.charAt(0).toUpperCase() + ultimo.slice(1) : '';
}

export default function Layout() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  // Trocar a empresa ativa remonta a tela corrente: nenhum dado da empresa anterior fica visível.
  const [escopoVersao, setEscopoVersao] = useState(0);

  // Busca global (Ctrl/Cmd+K), disponível em qualquer tela do sistema.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Módulo dono da rota (rotas filhas, ex.: /produtos/12, pertencem ao pai) —
  // mesma regra da Sidebar, vinda de `modules.ts`. O item de topo é o Meu
  // Negócio ("/"), então o nome nunca é escrito à mão aqui.
  const inicio = moduleOfPath('/');
  const rota = moduleOfPath(location.pathname);
  const current = rota ?? inicio;

  // Trilha: marca › área › módulo › registro. Todos os níveis, menos o último,
  // são clicáveis e levam à rota que já existe (não cria rota nova).
  const trilha = useMemo<BreadcrumbItem[]>(() => {
    const link = (label: string, href: string): BreadcrumbItem => ({ label, href, onNavigate: () => navigate(href) });
    if (!rota) return [{ label: 'BROBOND ERP' }]; // rota sem módulo (ex.: /dev/componentes)
    const itens: BreadcrumbItem[] = [link('BROBOND ERP', '/')];
    if (rota.group) itens.push({ label: rota.group, semLink: true }); // área não tem página própria
    const descendente = location.pathname !== rota.path;
    itens.push(descendente ? link(rota.label, rota.path) : { label: rota.label });
    if (descendente) itens.push({ label: rotuloDoRegistro(location.pathname) });
    return itens;
  }, [rota, location.pathname, navigate]);

  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menu]);

  useEffect(() => {
    document.title = current && current.path !== '/' ? `${current.label} · BROBOND ERP` : 'BROBOND ERP';
  }, [current]);

  const initials = (user?.name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  return (
    <div className="flex h-full bg-navy-50 dark:bg-transparent">
      <Sidebar open={open} onClose={() => setOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <a
          href="#conteudo-principal"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-lg focus:bg-navy-800 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-modal"
        >
          Pular para o conteúdo
        </a>
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-slate-800/60 dark:bg-[#090d16]/80 dark:backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-3">
            <button className="btn-icon -ml-2 md:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu">
              <Menu className="h-5 w-5" />
            </button>
            <Breadcrumb items={trilha} className="min-w-0" />
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <CompanySwitcher onChange={() => setEscopoVersao((v) => v + 1)} />
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-400 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-600 sm:px-3 dark:border-slate-800/60 dark:bg-slate-900/50 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
              aria-label="Busca rápida"
              title="Busca rápida (Ctrl/Cmd+K)"
            >
              <Search className="h-4 w-4" />
              <span className="hidden md:inline">Buscar...</span>
              <kbd className="hidden rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 md:inline dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400">Ctrl K</kbd>
            </button>

            <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenu((v) => !v)}
              className="flex items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 transition-colors hover:bg-slate-100 dark:hover:bg-navy-800"
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-800 text-xs font-bold text-white dark:bg-brand-500">{initials}</span>
              <span className="hidden text-left sm:block">
                <span className="block text-sm font-semibold leading-tight text-slate-800 dark:text-slate-100">{user?.name}</span>
                <span className="block text-[11px] leading-tight text-slate-400 dark:text-navy-300">{PERFIL_LABEL[user?.perfil || ''] || user?.perfil}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </button>

            {menu && (
              <div className="absolute right-0 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-modal animate-fade-in dark:border-navy-700 dark:bg-navy-900" role="menu">
                <div className="border-b border-slate-100 px-4 py-3 dark:border-navy-800">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{user?.name}</div>
                  <div className="truncate text-xs text-slate-500 dark:text-navy-300">{user?.email}</div>
                </div>
                <Link to="/config" onClick={() => setMenu(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-navy-800" role="menuitem">
                  <UserRound className="h-4 w-4 text-slate-400" /> Minha conta
                </Link>
                <Link to="/config#senha" onClick={() => setMenu(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-navy-800" role="menuitem">
                  <KeyRound className="h-4 w-4 text-slate-400" /> Trocar senha
                </Link>
                <button onClick={logout} className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 dark:border-navy-800 dark:hover:bg-red-950/40" role="menuitem">
                  <LogOut className="h-4 w-4" /> Sair
                </button>
              </div>
            )}
            </div>
          </div>
        </header>

        <main id="conteudo-principal" className="flex-1 overflow-y-auto bg-transparent" tabIndex={-1}>
          <div key={escopoVersao} className="min-h-full">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
