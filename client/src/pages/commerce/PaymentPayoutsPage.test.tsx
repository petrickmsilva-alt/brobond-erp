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
  <Route path="/commerce/pagamentos/repasses/:id/corrigir" element={<PaymentPayoutsPage />} />
  <Route path="/commerce/pagamentos/repasses/:id/desvincular" element={<PaymentPayoutsPage />} />
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
  it('atualiza situação e extrato no detalhe depois de conciliar', async () => {
    let matched = false;
    api.mockImplementation(async (_path, opts) => {
      if (opts?.method === 'POST') { matched = true; return {}; }
      return { payout: { id: 7, provider: 'PAGBANK', payout_reference: 'R1', status: matched ? 'MATCHED' : 'IMPORTED', bank_transaction_id: matched ? 12 : null, net_amount: 1000, settlement_date: '2029-01-01' }, settlements: [] };
    });
    page('/commerce/pagamentos/repasses/7/conciliar');
    await screen.findByText(/Situação: IMPORTED/);
    fireEvent.change(screen.getByLabelText('ID da transação do extrato'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar vínculo' }));
    expect(await screen.findByText(/Situação: MATCHED/)).toBeInTheDocument();
    expect(screen.getByText(/Extrato vinculado: 12/)).toBeInTheDocument();
  });
  it('corrige relatório na rota dedicada e preserva referência e chave idempotente', async () => {
    const report = { provider: 'PAGBANK', payout_reference: 'R1', settlement_date: '2029-01-01', net_amount: 1000,
      transactions: [{ provider_reference: 'T1', gross_amount: 1000, provider_fee: 0, gateway_fee: 0, installment_fee: 0, antifraud_fee: 0, refund_amount: 0, chargeback_amount: 0, net_amount: 1000 }] };
    api.mockImplementation(async (_path, opts) => opts?.method === 'POST' ? {} : { payout: { id: 7, content_hash: 'a'.repeat(64) }, report, settlements: [] });
    page('/commerce/pagamentos/repasses/7/corrigir');
    const reason = await screen.findByLabelText('Justificativa da correção');
    expect(screen.getByLabelText('Referência da transação')).toHaveAttribute('readonly');
    fireEvent.change(reason, { target: { value: 'Correção de transcrição' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar correção' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/commerce/payments/payouts/7/correct', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }) })));
    const call = api.mock.calls.find(([path]) => path.endsWith('/correct')); const payload = JSON.parse(String(call?.[1]?.body));
    expect(payload.expected_hash).toBe('a'.repeat(64)); expect(payload.report.transactions[0].provider_reference).toBe('T1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

});
