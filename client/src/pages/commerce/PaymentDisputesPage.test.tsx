import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PaymentDisputesPage from './PaymentDisputesPage';
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'admin' } }) }));
import { apiFetch } from '../../lib/api'; const api = vi.mocked(apiFetch);
const d = { id: 7, payment_intent_id: 5, provider_reference: 'trans-1', provider: 'PAGBANK', external_dispute_id: 'disp-1', origin: 'MANUAL', status: 'DISPUTE_OPENED', version: 0, amount: 1000, reason: 'Motivo de teste', due_date: null };
const detail = { dispute: d, evidence: { rows: [], total: 0, page: 1, pageSize: 25 }, events: { rows: [], total: 0, page: 1, pageSize: 25 }, provider_submission: 'NAO_SUPORTADO', source: '' };
function page(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/commerce/pagamentos/disputas" element={<PaymentDisputesPage />} />
  <Route path="/commerce/pagamentos/disputas/novo" element={<PaymentDisputesPage />} />
  <Route path="/commerce/pagamentos/disputas/:id" element={<PaymentDisputesPage />} />
  <Route path="/commerce/pagamentos/disputas/:id/evidencias/nova" element={<PaymentDisputesPage />} />
  <Route path="/commerce/pagamentos/disputas/:id/alterar" element={<PaymentDisputesPage />} />
</Routes></MemoryRouter>); }

describe('Disputas de pagamentos — fluxos sem modal', () => {
  beforeEach(() => api.mockReset());
  it('lista dados reais e acessa detalhe em rota dedicada', async () => {
    api.mockResolvedValue({ rows: [d], total: 1, page: 1, pageSize: 25 });
    const { container } = page('/commerce/pagamentos/disputas');
    expect(await screen.findByText('trans-1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Detalhes' })).toHaveAttribute('href', '/commerce/pagamentos/disputas/7');
    expect(screen.getByText(/não envia evidências nem consulta/)).toBeInTheDocument();
    expect(container.querySelector('[role="dialog"],dialog,[aria-modal]')).toBeNull();
  });
  it('registra evidência com chave idempotente e nunca faz envio externo', async () => {
    api.mockImplementation(async (_path, opts) => opts?.method === 'POST' ? { evidence: { id: 1 } } : detail);
    page('/commerce/pagamentos/disputas/7/evidencias/nova');
    await screen.findByRole('heading', { name: 'Registrar evidência interna' });
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Entrega do pedido' } });
    fireEvent.change(screen.getByLabelText('Conteúdo da nota'), { target: { value: 'Prova interna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar evidência' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/commerce/payments/disputes/7/evidence', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }), body: JSON.stringify({ kind: 'NOTE', description: 'Entrega do pedido', content: 'Prova interna' }) })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('recarrega o detalhe após salvar evidência, sem exigir atualização manual', async () => {
    let saved = false;
    api.mockImplementation(async (_path, opts) => {
      if (opts?.method === 'POST') { saved = true; return { evidence: { id: 10 } }; }
      return saved ? { ...detail, evidence: { ...detail.evidence, total: 1, rows: [{ id: 10, kind: 'NOTE', description: 'Entrega confirmada', content: 'Comprovante interno', created_at: '2029-01-01T12:00:00Z' }] } } : detail;
    });
    page('/commerce/pagamentos/disputas/7/evidencias/nova'); await screen.findByRole('heading', { name: 'Registrar evidência interna' });
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Entrega confirmada' } });
    fireEvent.change(screen.getByLabelText('Conteúdo da nota'), { target: { value: 'Comprovante interno' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar evidência' }));
    expect(await screen.findByRole('heading', { name: 'Entrega confirmada' })).toBeInTheDocument();
    expect(screen.getByText('Comprovante interno')).toBeInTheDocument();
    expect(api.mock.calls.filter(([path, opts]) => path.startsWith('/commerce/payments/disputes/7?') && !opts?.method).length).toBeGreaterThanOrEqual(2);
  });
  it('exige confirmação explícita para desfecho externo declarado', async () => {
    api.mockImplementation(async (_path, opts) => opts?.method === 'POST' ? {} : detail);
    page('/commerce/pagamentos/disputas/7/alterar'); await screen.findByRole('heading', { name: 'Alterar situação' });
    fireEvent.change(screen.getByLabelText('Nova situação'), { target: { value: 'WON' } });
    fireEvent.change(screen.getByLabelText('Justificativa'), { target: { value: 'Resultado no portal' } });
    fireEvent.change(screen.getByLabelText('Referência do fato externo'), { target: { value: 'recibo-001' } });
    fireEvent.click(screen.getByLabelText(/Confirmo que este fato já ocorreu/));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar situação' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/commerce/payments/disputes/7/transition', expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'WON', note: 'Resultado no portal', external_reference: 'recibo-001', confirm_external: true, expected_version: 0 }) })));
  });
});
