import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PaymentPayoutsPage from './PaymentPayoutsPage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'admin' } }) }));
import { apiFetch } from '../../lib/api'; const api = vi.mocked(apiFetch);
function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/commerce/pagamentos/repasses" element={<PaymentPayoutsPage />} />
  <Route path="/commerce/pagamentos/repasses/novo" element={<PaymentPayoutsPage />} />
  <Route path="/commerce/pagamentos/repasses/:id" element={<PaymentPayoutsPage />} />
  <Route path="/commerce/pagamentos/repasses/:id/conciliar" element={<PaymentPayoutsPage />} />
</Routes></MemoryRouter>); }
describe('Repasses de pagamentos — páginas dedicadas', () => {
  beforeEach(() => api.mockReset());
  it('lista dados da API e não cria registros fictícios', async () => {
    api.mockResolvedValue({ rows: [], total: 0 }); page('/commerce/pagamentos/repasses');
    expect(await screen.findByText('Nenhum repasse encontrado.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Importar relatório' })).toHaveAttribute('href', '/commerce/pagamentos/repasses/novo');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('vincula a linha de extrato selecionada na rota própria', async () => {
    api.mockImplementation(async (_path, opts) => opts?.method === 'POST' ? {} : { payout: { id: 7, provider: 'PAGBANK', payout_reference: 'R1', status: 'IMPORTED', net_amount: 1000, settlement_date: '2029-01-01' }, settlements: [] });
    page('/commerce/pagamentos/repasses/7/conciliar');
    fireEvent.change(screen.getByLabelText('ID da transação do extrato'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar vínculo' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/commerce/payments/payouts/7/match', expect.objectContaining({ method: 'POST', body: JSON.stringify({ bank_transaction_id: 12 }) })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
