// ============================================================================
// COMMERCE — /commerce/pedidos/:saleId (detalhe omnichannel).
// Contrato: visão completa da API (pagamento, itens, timeline, rastreio),
// ações com ConfirmacaoInline (inline, ZERO MODAL), cancelar via rota própria
// de confirmação inline e erro honesto.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePedidoDetalhePage from './PedidoDetalhePage';

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

const VISAO = {
  sale_id: 'SAL3f00d0000000000000001',
  pedido: {
    id: 101,
    canal: 'BROBOND',
    pedido_externo: 'CHK-2026-001',
    estado: 'PAGO',
    estado_rotulo: 'Pago',
    pagamento_estado: 'PENDING',
    total: 254.7,
    frete: 20,
    desconto: 15,
    cupom: 'BEMVINDO10',
    comprador: { nome: 'Maria Silva', email: 'maria@example.com', telefone: null },
    endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Goiânia', uf: 'GO', cep: '74000-000' },
    expira_em: null,
    pago_em: null,
    convertido_em: null,
    erro: null,
    criado_em: '2026-10-28T12:00:00Z',
  },
  pagamento: { status: 'PENDING', provider: 'mercadopago', metodo: 'pix', valor: 254.7, qr_code: null, copia_cola: null, expira_em: null, provider_ref: 'MP-991' },
  venda: null,
  itens: [{ produto_id: 7, produto: 'Camiseta Brobond', tamanho: 'M', quantidade: 2, preco_unitario: 99.9, subtotal: 199.8 }],
  rastreio: [],
  timeline: [
    { em: '2026-10-28T12:00:00Z', rotulo: 'Checkout criado' },
    { em: '2026-10-28T12:05:00Z', rotulo: 'Pagamento iniciado' },
  ],
};

function renderPagina(rota = '/commerce/pedidos/SAL3f00d0000000000000001') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/pedidos/:saleId" element={<CommercePedidoDetalhePage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Detalhe do pedido (/commerce/pedidos/:saleId)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('exibe visão completa: pagamento, comprador, itens e timeline reais', async () => {
    fetchMock.mockResolvedValue(VISAO);
    renderPagina();
    expect(await screen.findByText('Maria Silva')).toBeInTheDocument();
    expect(screen.getByText('Camiseta Brobond')).toBeInTheDocument();
    expect(document.body.textContent).toContain('BEMVINDO10');
    expect(screen.getByText('Checkout criado')).toBeInTheDocument();
    expect(screen.getByText(/Mercado Pago|mercadopago/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelar usa ConfirmacaoInline (inline) e chama POST /cancelar — ZERO MODAL', async () => {
    const visaoCancelavel = {
      ...VISAO,
      pedido: { ...VISAO.pedido!, estado: 'AGUARDANDO_PAGAMENTO', estado_rotulo: 'Aguardando pagamento' },
    };
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'POST' && caminho.includes('/cancelar')) return { ok: true, estado: 'CANCELADO' };
      return visaoCancelavel;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Maria Silva');
    const cancelar = await screen.findByRole('button', { name: 'Cancelar pedido' });
    await user.click(cancelar);
    // a confirmação é INLINE (ConfirmacaoInline), nunca dialog/overlay
    expect(screen.queryByRole('dialog')).toBeNull();
    const confirmar = await screen.findByRole('button', { name: 'Sim, cancelar' });
    await user.click(confirmar);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/commerce/pedidos/SAL3f00d0000000000000001/cancelar',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(404, 'Pedido não encontrado neste tenant.'); });
    renderPagina();
    expect(await screen.findByText('Pedido não encontrado neste tenant.')).toBeInTheDocument();
  });
});

describe('pagamento tardio em pedido encerrado', () => {
  it('não oferece conversão e encaminha para revisão do pagamento', async () => {
    fetchMock.mockResolvedValue({ ...VISAO, pedido: { ...VISAO.pedido!, estado: 'EXPIRADO', erro: 'Pagamento tardio em revisão' },
      pagamento: { ...VISAO.pagamento, engine_intent_id: 42, late_review_status: 'OPEN' } });
    renderPagina();
    expect(await screen.findByText('Pagamento tardio em revisão')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Converter em venda' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Revisar pagamento e eventual estorno' })).toHaveAttribute('href', '/commerce/pagamentos/transacoes/42');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
