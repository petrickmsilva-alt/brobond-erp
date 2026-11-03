// ============================================================================
// /loja/pedido/:token — contrato da página PIX (dados REAIS do provedor) e do
// polling controlado. Fixtures = formato devolvido pelo backend; nenhum QR é
// gerado no navegador e nenhum texto vira imagem.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../../components/ui';
import LojaPedidoPage, { INTERVALO_POLLING_MS } from './LojaPedidoPage';

vi.mock('../../../lib/api', () => ({
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

import { apiFetch } from '../../../lib/api';
const fetchMock = vi.mocked(apiFetch);

// PNG 1x1 real (assinatura \x89PNG) e BR Code EMV de exemplo.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const EMV = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
const CONFIG = { loja_nome: 'BROBOND Store', frete: { provedor: 'manual', valor: 0, disponivel: true }, checkout_expira_minutos: 60 };

function visao(estado: string, pagamento: Record<string, unknown>) {
  return {
    sale_id: 'SAL3f00d0000000000000009',
    pedido: {
      pedido_externo: 'LOJA-8F3K2',
      estado,
      estado_rotulo: estado === 'PAGO' ? 'Pago' : 'Aguardando pagamento',
      total: 80,
      frete: 0,
      desconto: 0,
      cupom: null,
      expira_em: '2099-01-01T13:00:00Z',
      pago_em: estado === 'PAGO' ? '2026-11-03T12:10:00Z' : null,
      convertido_em: null,
      criado_em: '2026-11-03T12:00:00Z',
      checkout_token: 'a'.repeat(64),
    },
    pagamento: { status: 'PENDING', provider: 'mercadopago', metodo: 'pix', valor: 80, copia_cola: null, qr_code_base64: null, ticket_url: null, expira_em: '2099-01-01T13:00:00Z', ...pagamento },
    venda: null,
    itens: [{ produto_id: 7, produto: 'COTTON "B"', tamanho: 'M', quantidade: 1, preco_unitario: 80, subtotal: 80 }],
    rastreio: [],
    timeline: [{ em: '2026-11-03T12:00:00Z', rotulo: 'Pedido recebido' }],
  };
}

function montar() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/loja/pedido/${'a'.repeat(64)}`]}>
        <Routes>
          <Route path="/loja/pedido/:token" element={<LojaPedidoPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

const chamadasDoPedido = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/loja/pedidos/')).length;

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Página do pedido — PIX real do provedor', () => {
  it('AGUARDANDO_PAGAMENTO: QR da imagem base64, Copia e Cola, link do Mercado Pago e status', async () => {
    fetchMock.mockImplementation(async (caminho: string) =>
      caminho.startsWith('/loja/config') ? CONFIG : visao('AGUARDANDO_PAGAMENTO', { copia_cola: EMV, qr_code_base64: PNG, ticket_url: 'https://www.mercadopago.com.br/payments/123/ticket?caller_id=1' })
    );
    montar();
    expect(await screen.findByText('PEDIDO RECEBIDO')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pedido #LOJA-8F3K2');
    expect(screen.getByText('Pagamento via PIX')).toBeInTheDocument();
    const img = screen.getByRole('img', { name: /QR Code PIX do pedido LOJA-8F3K2/ }) as HTMLImageElement;
    expect(img.src).toBe(`data:image/png;base64,${PNG}`);
    expect(screen.getByText('Escaneie o QR Code pelo aplicativo do seu banco')).toBeInTheDocument();
    const campo = screen.getByLabelText('PIX COPIA E COLA') as HTMLTextAreaElement;
    expect(campo.value).toBe(EMV);
    expect(campo.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: /COPIAR CÓDIGO/ })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /ABRIR PAGAMENTO DO MERCADO PAGO/ }) as HTMLAnchorElement;
    expect(link.href).toContain('https://www.mercadopago.com.br/payments/123/ticket');
    expect(screen.getByText('Pagamento aguardando confirmação')).toBeInTheDocument();
    expect(screen.getByText('O pedido será confirmado automaticamente após a aprovação do pagamento.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sem imagem do provedor: NENHUM QR é desenhado; Copia e Cola real continua disponível', async () => {
    fetchMock.mockImplementation(async (caminho: string) =>
      // Campo errado (EMV no lugar da imagem) nunca vira <img>.
      caminho.startsWith('/loja/config') ? CONFIG : visao('AGUARDANDO_PAGAMENTO', { copia_cola: EMV, qr_code_base64: EMV })
    );
    montar();
    expect(await screen.findByText('PEDIDO RECEBIDO')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR Code PIX/ })).toBeNull();
    expect(screen.getByText(/não enviou a imagem do QR Code/)).toBeInTheDocument();
    expect((screen.getByLabelText('PIX COPIA E COLA') as HTMLTextAreaElement).value).toBe(EMV);
  });

  it('polling 12 s: PAGO aparece sem F5 e o polling PARA no estado final', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let pago = false;
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      return pago ? visao('PAGO', { status: 'APPROVED', copia_cola: EMV }) : visao('AGUARDANDO_PAGAMENTO', { copia_cola: EMV, qr_code_base64: PNG });
    });
    montar();
    expect(await screen.findByText('PEDIDO RECEBIDO')).toBeInTheDocument();
    expect(chamadasDoPedido()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVALO_POLLING_MS - 500); });
    expect(chamadasDoPedido()).toBe(1); // nada antes do intervalo
    pago = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(chamadasDoPedido()).toBe(2);
    expect(await screen.findByText('Seu pedido foi confirmado!')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIX COPIA E COLA')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVALO_POLLING_MS * 5); });
    expect(chamadasDoPedido()).toBe(2); // estado final: sem novas consultas
  });

  it('aba oculta não consulta; ao voltar, consulta uma vez', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementation(async (caminho: string) => (caminho.startsWith('/loja/config') ? CONFIG : visao('AGUARDANDO_PAGAMENTO', { copia_cola: EMV })));
    montar();
    expect(await screen.findByText('PEDIDO RECEBIDO')).toBeInTheDocument();
    const oculto = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVALO_POLLING_MS * 3); });
    expect(chamadasDoPedido()).toBe(1);
    oculto.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(chamadasDoPedido()).toBe(2);
    oculto.mockRestore();
  });
});
