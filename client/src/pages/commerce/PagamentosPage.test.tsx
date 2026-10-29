// ============================================================================
// COMMERCE — /commerce/pagamentos: consome a API real do gateway e navega
// para o pedido. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePagamentosPage from './PagamentosPage';

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { apiFetch } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const PAGAMENTO = {
  cobranca_id: 9,
  provider: 'mercadopago',
  metodo: 'pix',
  valor: 189.9,
  status_gateway: 'paga',
  status: 'APPROVED',
  criado_em: '2026-10-20T12:00:00.000Z',
  atualizado_em: '2026-10-20T12:05:00.000Z',
  pedido: { pedido_externo: 'LOJA-ABC123', estado: 'PAGO', sale_id: 'SAL3f00d0000000000000001' },
  lancamento_id: 77,
  venda_id: null,
};

function renderPagina(rota = '/commerce/pagamentos') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/pagamentos" element={<CommercePagamentosPage />} />
          <Route path="/commerce/pedidos/:saleId" element={<div>rota-detalhe-pedido</div>} />
          <Route path="/vendas/:id" element={<div>rota-venda</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Pagamentos (/commerce/pagamentos)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza as cobranças REAIS da API com pedido vinculado e estado', async () => {
    fetchMock.mockResolvedValue({ total: 1, pagamentos: [PAGAMENTO] });
    renderPagina();
    expect(await screen.findByText('LOJA-ABC123')).toBeInTheDocument();
    expect(screen.getByText('mercadopago')).toBeInTheDocument();
    expect(screen.getByText('R$ 189,90')).toBeInTheDocument();
    expect(screen.getAllByText('Aprovado').length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[0][0]).toContain('/commerce/pagamentos');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filtra por estado chamando a API com o parâmetro', async () => {
    fetchMock.mockResolvedValue({ total: 1, pagamentos: [PAGAMENTO] });
    renderPagina();
    await screen.findByText('LOJA-ABC123');
    const selects = screen.getAllByRole('combobox');
    const filtro = selects[0] as HTMLSelectElement;
    filtro.value = 'PENDING';
    filtro.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      const ultima = fetchMock.mock.calls.at(-1)?.[0] ?? '';
      expect(String(ultima)).toContain('status=PENDING');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto (sem inventar cobranças)', async () => {
    fetchMock.mockResolvedValue({ total: 0, pagamentos: [] });
    renderPagina();
    expect(await screen.findByText('Nenhuma cobrança')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
