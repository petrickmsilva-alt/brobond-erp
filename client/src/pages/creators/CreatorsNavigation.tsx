import { NavLink } from 'react-router-dom';
import { MODULES } from '../../modules';

export function CreatorsNavigation() {
  return <nav aria-label="Módulos de Creators" className="flex flex-wrap gap-2 rounded-xl border border-line bg-surface p-3">
    {MODULES.filter((item) => item.space === 'creators').map((item) => <NavLink key={item.id} to={item.path} end
      className={({ isActive }) => `${isActive ? 'btn-primary' : 'btn-secondary'} max-w-full`}>
      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
    </NavLink>)}
  </nav>;
}
