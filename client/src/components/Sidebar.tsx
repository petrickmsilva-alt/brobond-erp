import { NavLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { MODULES, MODULE_GROUPS, type Module } from '../modules';
import { Logo } from './Logo';
import { useAuth } from '../auth/AuthContext';

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, meta } = useAuth();
  const isAdmin = user?.perfil === 'admin';
  const visible = MODULES.filter((m) => {
    if (m.adminOnly && !isAdmin) return false;
    if (m.minPerfil === 'admin' && !isAdmin) return false;
    if (m.minPerfil === 'gerente' && !isAdmin && user?.perfil !== 'gerente') return false;
    return true;
  });
  const top = visible.find((m) => m.group === null);

  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-navy-950/50 backdrop-blur-[1px] md:hidden" onClick={onClose} />}
      <aside
        className={`fixed z-30 flex h-full w-64 flex-col bg-navy-900 text-navy-100 transition-transform duration-200 md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-5">
          <Logo variant="light" height={30} withTagline={false} />
          <button className="rounded-md p-1 text-navy-300 hover:bg-white/10 hover:text-white md:hidden" onClick={onClose} aria-label="Fechar menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {top && <NavItem m={top} onClose={onClose} />}

          {MODULE_GROUPS.map((g) => {
            const items = visible.filter((m) => m.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-400">{g}</div>
                <div className="space-y-0.5">
                  {items.map((m) => (
                    <NavItem key={m.id} m={m} onClose={onClose} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-white/10 px-5 py-3 text-[11px] text-navy-400">
          <div className="flex items-center justify-between">
            <span>BROBOND ERP{meta?.version ? ` v${meta.version.replace(/^v/, '')}` : ''}</span>
            {meta?.mode === 'memory' && (
              <span className="rounded bg-brand-500/20 px-1.5 py-0.5 font-semibold text-brand-300" title="Sem banco de dados: os dados somem ao reiniciar o servidor">
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
        `group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
          isActive ? 'bg-white/10 text-white shadow-inner' : 'text-navy-200 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-400' : 'text-navy-300 group-hover:text-brand-300'}`} strokeWidth={2} />
          <span className="truncate">{m.label}</span>
        </>
      )}
    </NavLink>
  );
}
