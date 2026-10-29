// ============================================================================
// COMMERCE — /commerce/fulfillment: pedidos convertidos com venda ERP,
// expedição e rastreio — dados REAIS da API. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceFulfillmentPage from './FulfillmentPage';

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

const LINHA = {
  sale_id: 'SAL3f00d0000000000000001',
  pedido_externo: 'LOJA-XYZ789',
  canal: 'BROBOND',
  venda_id: 55,
  numero: 'VND-0055',
  comprador: 'Maria Compradora',
  status_venda: 'faturada',
  faturada_em: '2026-10-19T10:00:00.000Z',
  expedicao_etapa: 'expedida',
  rastreio: { codigo: 'BR999', status: 'em_transito', transportadora: 'Correios' },
  convertido_em: '2026-10-19T10:05:00.000Z',
};

function renderPagina(rota = '/commerce/fulfillment') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/fulfillment" element={<CommerceFulfillmentPage />} />
          <Route path="/commerce/pedidos/:saleId" element={<div>rota-detalhe-pedido</div>} />
          <Route path="/vendas/:id" element={<div>rota-venda-55</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Fulfillment (/commerce/fulfillment)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza pedidos convertidos com venda ERP, etapa e rastreio reais', async () => {
    fetchMock.mockResolvedValue({ total: 1, linhas: [LINHA] });
    renderPagina();
    expect(await screen.findByText('LOJA-XYZ789')).toBeInTheDocument();
    expect(screen.getByText('VND-0055')).toBeInTheDocument();
    expect(screen.getByText('Expedida')).toBeInTheDocument();
    expect(screen.getByText('BR999')).toBeInTheDocument();
    expect(screen.getByText('Em trânsito')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/commerce/fulfillment');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('linka a venda ERP (rota /vendas/:id) e o pedido commerce', async () => {
    fetchMock.mockResolvedValue({ total: 1, linhas: [LINHA] });
    const { container } = renderPagina();
    await screen.findByText('LOJA-XYZ789');
    const vendaLink = screen.getByText('VND-0055').closest('a');
    expect(vendaLink).toHaveAttribute('href', '/vendas/55');
    const pedidoLink = screen.getByText('LOJA-XYZ789').closest('a');
    expect(pedidoLink).toHaveAttribute('href', '/commerce/pedidos/SAL3f00d0000000000000001');
    expect(container).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto', async () => {
    fetchMock.mockResolvedValue({ total: 0, linhas: [] });
    renderPagina();
    expect(await screen.findByText('Nenhum pedido convertido')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
