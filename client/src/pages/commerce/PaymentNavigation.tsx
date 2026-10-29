import { NavLink } from 'react-router-dom';
export const paymentSections = [
  ['', 'Visão geral'],
  ['provedores', 'Provedores'],
  ['metodos', 'Métodos'],
  ['regras', 'Roteamento'],
  ['transacoes', 'Transações'],
  ['reembolsos', 'Reembolsos'],
  ['atrasados', 'Pagamentos tardios'],
  ['disputas', 'Disputas'],
  ['reconciliacao', 'Reconciliação'],
  ['webhooks', 'Webhooks'],
] as const;
export function PaymentNavigation() {
  return (
    <nav aria-label="Payment Engine" className="flex flex-wrap gap-1 border-b border-line pb-3">
      {paymentSections.map(([path, label]) => (
        <NavLink
          key={path}
          end
          to={`/commerce/pagamentos${path ? `/${path}` : ''}`}
          className={({ isActive }) =>
            `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-ink text-white' : 'text-ink-soft hover:bg-surface-alt'}`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
