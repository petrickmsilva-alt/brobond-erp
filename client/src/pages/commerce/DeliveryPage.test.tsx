// ============================================================================
// COMMERCE — /commerce/delivery (expedição/rastreio dos pedidos convertidos).
// Contrato: linhas reais da fila de envio, detalhe em rota própria, ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceDeliveryPage from './DeliveryPage';

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
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const LINHA = {
  sale_id: 'SAL3f00d0000000000000001',
  pedido_externo: 'CHK-2026-001',
  canal: 'BROBOND',
  venda_id: 55,
  numero: 'VND-0055',
  estado_entrega: 'EM_TRANSITO',
  expedicao_etapa: 'separacao',
  dias_desde_faturamento: 3,
  atrasado: true,
  rastreio: { codigo: 'BR123', transportadora: 'Correios', url: null, status: 'postado', estimativa_em: null },
};

function renderPagina(rota = '/commerce/delivery') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/delivery" element={<CommerceDeliveryPage />} />
          <Route path="/commerce/pedidos/:saleId" element={<div>rota-detalhe-pedido</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Delivery (/commerce/delivery)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza a fila real de envios com venda, atraso e rastreio', async () => {
    fetchMock.mockResolvedValue({ total: 1, linhas: [LINHA] });
    renderPagina();
    expect(await screen.findByText('CHK-2026-001')).toBeInTheDocument();
    expect(screen.getByText('Correios')).toBeInTheDocument();
    expect(screen.getByText('BR123')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('abrir pedido navega para a rota própria do detalhe', async () => {
    fetchMock.mockResolvedValue({ total: 1, linhas: [LINHA] });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('CHK-2026-001');
    // a linha da fila é um botão com o pedido_externo → rota do detalhe
    const abrir = await screen.findByRole('button', { name: 'CHK-2026-001' });
    await user.click(abrir);
    expect(await screen.findByText('rota-detalhe-pedido')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(503, 'Fila de envios indisponível.'); });
    renderPagina();
    expect(await screen.findByText('Fila de envios indisponível.')).toBeInTheDocument();
  });
});
