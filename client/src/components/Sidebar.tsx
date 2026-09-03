import { NavLink } from 'react-router-dom';
import { MODULES, MODULE_GROUPS, Module } from '../modules';
import { Logo } from './Logo';

export default function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const top = MODULES.find((m) => m.group === null);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-20 md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed md:static z-30 h-full w-64 bg-white border-r border-slate-200 flex flex-col transition-all ${
          open ? 'left-0' : '-left-64'
        } md:left-0`}
      >
        <div className="h-16 flex items-center px-5 border-b border-slate-200 shrink-0">
          <Logo />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {top && <NavItem m={top} onClose={onClose} />}

          {MODULE_GROUPS.map((g) => (
            <div key={g}>
              <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                {g}
              </div>
              <div className="space-y-0.5">
                {MODULES.filter((m) => m.group === g).map((m) => (
                  <NavItem key={m.id} m={m} onClose={onClose} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 text-[11px] text-slate-400 border-t border-slate-200 shrink-0">
          BROBOND ERP v0.1
        </div>
      </aside>
    </>
  );
}

function NavItem({ m, onClose }: { m: Module; onClose: () => void }) {
  return (
    <NavLink
      to={m.path}
      end={m.path === '/'}
      onClick={onClose}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-orange-50 text-orange-700'
            : 'text-slate-600 hover:bg-slate-100'
        }`
      }
    >
      <span className="text-base">{m.icon}</span>
      <span>{m.label}</span>
    </NavLink>
  );
}
