import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, KeyRound, LogOut, Menu, UserRound } from 'lucide-react';
import Sidebar from './Sidebar';
import { useAuth } from '../auth/AuthContext';
import { MODULES } from '../modules';

const PERFIL_LABEL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };

export default function Layout() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Rotas filhas (ex.: /produtos/12) pertencem ao módulo pai
  const current =
    MODULES.find((m) => m.path === location.pathname) ||
    MODULES.filter((m) => m.path !== '/').find((m) => location.pathname.startsWith(m.path + '/')) ||
    MODULES.find((m) => m.path === '/');

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
    <div className="flex h-full">
      <Sidebar open={open} onClose={() => setOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button className="btn-icon -ml-2 md:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu">
              <Menu className="h-5 w-5" />
            </button>
            <nav className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden text-slate-400 sm:inline">BROBOND ERP</span>
              {current && current.path !== '/' && (
                <>
                  <span className="hidden text-slate-300 sm:inline">/</span>
                  {current.group && <span className="hidden text-slate-400 lg:inline">{current.group}</span>}
                  {current.group && <span className="hidden text-slate-300 lg:inline">/</span>}
                  <span className="truncate font-semibold text-navy-900">{current.label}</span>
                </>
              )}
              {current?.path === '/' && <span className="font-semibold text-navy-900">Dashboard</span>}
            </nav>
          </div>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenu((v) => !v)}
              className="flex items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 transition-colors hover:bg-slate-100"
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-800 text-xs font-bold text-white">{initials}</span>
              <span className="hidden text-left sm:block">
                <span className="block text-sm font-semibold leading-tight text-slate-800">{user?.name}</span>
                <span className="block text-[11px] leading-tight text-slate-400">{PERFIL_LABEL[user?.perfil || ''] || user?.perfil}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-slate-400" />
            </button>

            {menu && (
              <div className="absolute right-0 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-modal animate-fade-in" role="menu">
                <div className="border-b border-slate-100 px-4 py-3">
                  <div className="text-sm font-semibold text-slate-800">{user?.name}</div>
                  <div className="truncate text-xs text-slate-500">{user?.email}</div>
                </div>
                <Link to="/config" onClick={() => setMenu(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50" role="menuitem">
                  <UserRound className="h-4 w-4 text-slate-400" /> Minha conta
                </Link>
                <Link to="/config#senha" onClick={() => setMenu(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50" role="menuitem">
                  <KeyRound className="h-4 w-4 text-slate-400" /> Trocar senha
                </Link>
                <button onClick={logout} className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50" role="menuitem">
                  <LogOut className="h-4 w-4" /> Sair
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
