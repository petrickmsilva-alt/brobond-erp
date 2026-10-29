import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PaymentEnginePage from './PaymentEnginePage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'admin' } }) }));
import { apiFetch } from '../../lib/api';
const api = vi.mocked(apiFetch);
function page(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/commerce/pagamentos/:section" element={<PaymentEnginePage />} />
        <Route path="/commerce/pagamentos/provedores/:code/editar" element={<PaymentEnginePage />} />
        <Route path="/commerce/pagamentos/transacoes/:id" element={<PaymentEnginePage />} />
      </Routes>
    </MemoryRouter>
  );
}
describe('Payment Engine admin — real API surfaces and dedicated routes', () => {
  beforeEach(() => api.mockReset());
  it('does not fabricate connected providers or expose credentials; navigation has no overlay', async () => {
    api.mockResolvedValue({
      providers: [
        {
          code: 'STRIPE',
          name: 'Stripe',
          status: 'NOT_CONFIGURED',
          environment: null,
          credential: null,
          webhook: false,
          methods: [],
          capabilities: [],
          health_checked_at: null,
          last_error: null,
        },
      ],
    });
    page('/commerce/pagamentos/provedores');
    expect(await screen.findByText('NOT_CONFIGURED')).toBeInTheDocument();
    expect(screen.getByText('Nenhum método disponível.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configurar' })).toHaveAttribute('href', '/commerce/pagamentos/provedores/STRIPE/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Payment Engine' })).toBeInTheDocument();
  });
  it('loads empty transactions without invented balances and supports paging/filter API', async () => {
    api.mockResolvedValue({ rows: [], total: 0 });
    page('/commerce/pagamentos/transacoes');
    expect(await screen.findByText('Nenhum registro encontrado.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'PAID' } });
    expect(await screen.findByText('Nenhum registro encontrado.')).toBeInTheDocument();
    expect(api.mock.calls.some((c) => String(c[0]).includes('status=PAID'))).toBe(true);
  });
  it('provider configuration uses password fields and never loads existing tokens into the form', async () => {
    api.mockResolvedValue({ providers: [{ code: 'STRIPE', status: 'CONFIGURED', environment: 'teste' }] });
    page('/commerce/pagamentos/provedores/STRIPE/editar');
    const token = await screen.findByLabelText('Credencial — deixe vazio para preservar');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveValue('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
