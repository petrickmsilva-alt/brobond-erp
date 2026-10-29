// ============================================================================
// COMMERCE — /commerce/pedidos (pedidos omnichannel, lista → detalhe em rota).
// Contrato: estados reais do vocabulário, ZERO MODAL, navegação por rota.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePedidosPage from './PedidosPage';

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

const PEDIDO = {
  sale_id: 'SAL3f00d0000000000000001',
  pedido_id: 101,
  canal: 'BROBOND',
  pedido_externo: 'CHK-2026-001',
  ocorrida_em: '2026-10-28T12:00:00Z',
  status_venda: 'PENDING',
  estado: 'PAGO',
  estado_rotulo: 'Pago',
  pagamento: 'PIX',
  total: 254.7,
  comprador: { nome: 'Maria Silva', email: 'maria@example.com' },
  venda_id: null,
  convertido_em: null,
  expedicao: null,
  rastreio: null,
  expira_em: null,
};

function renderPagina(rota = '/commerce/pedidos') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/pedidos" element={<CommercePedidosPage />} />
          <Route path="/commerce/pedidos/:saleId" element={<div>rota-detalhe-pedido</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Pedidos omnichannel (/commerce/pedidos)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza pedidos reais com estado, comprador e total', async () => {
    fetchMock.mockResolvedValue({ total: 1, pedidos: [PEDIDO] });
    renderPagina();
    expect(await screen.findByText('CHK-2026-001')).toBeInTheDocument();
    expect((await screen.findAllByText('Pago')).length).toBeGreaterThan(0);
    expect(screen.getByText('Maria Silva')).toBeInTheDocument();
    expect(screen.getByText('R$ 254,70')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clique no pedido abre a ROTA DE DETALHE (nunca drawer/modal)', async () => {
    fetchMock.mockResolvedValue({ total: 1, pedidos: [PEDIDO] });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('CHK-2026-001');
    await user.click(screen.getByText('CHK-2026-001'));
    expect(await screen.findByText('rota-detalhe-pedido')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(500, 'Falha ao consultar pedidos.'); });
    renderPagina();
    expect(await screen.findByText('Falha ao consultar pedidos.')).toBeInTheDocument();
  });
});
