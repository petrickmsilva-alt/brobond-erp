// ============================================================================
// COMMERCE — /commerce/erros: falhas REAIS agregadas pela API e ação de
// reprocessar a publicação. ZERO MODAL (confirmação inline).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceErrosPage from './ErrosPage';

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
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, perfil: 'gerente' } }) }));

import { apiFetch } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const ERROS = {
  total: 2,
  erros: [
    {
      origem: 'publicacao',
      id: 2,
      referencia: 'Produto #7 · MERCADOLIVRE',
      estado: 'ERROR',
      mensagem: 'Credencial ML inválida',
      quando: '2026-10-28T11:00:00.000Z',
      acao: 'reprocessar',
      link: '/commerce/publicacoes/2',
    },
    {
      origem: 'pedido',
      id: 8,
      referencia: 'BROBOND · LOJA-ERR1',
      estado: 'ERRO',
      mensagem: 'Não foi possível iniciar o pagamento do pedido.',
      quando: '2026-10-28T12:00:00.000Z',
      acao: 'detalhe',
      link: '/commerce/pedidos/SALERR',
    },
  ],
};

function renderPagina(rota = '/commerce/erros') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/erros" element={<CommerceErrosPage />} />
          <Route path="/commerce/fila" element={<div>rota-fila</div>} />
          <Route path="/commerce/eventos" element={<div>rota-eventos</div>} />
          <Route path="/commerce/pedidos/:saleId" element={<div>rota-pedido</div>} />
          <Route path="/commerce/publicacoes/:id" element={<div>rota-publicacao</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Erros (/commerce/erros)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza as falhas REAIS de publicação e pedido vindas da API', async () => {
    fetchMock.mockResolvedValue(ERROS);
    renderPagina();
    expect(await screen.findByText('Credencial ML inválida')).toBeInTheDocument();
    expect(screen.getByText('Não foi possível iniciar o pagamento do pedido.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/commerce/erros');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reprocessa a publicação com confirmação inline (nunca modal)', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/commerce/erros')) return ERROS;
      return { ok: true };
    });
    renderPagina();
    await screen.findByText('Credencial ML inválida');
    await userEvent.click(screen.getByRole('button', { name: /Reprocessar/ }));
    // Confirmação INLINE — não existe diálogo sobreposto.
    expect(screen.queryByRole('dialog')).toBeNull();
    const confirmar = await screen.findByRole('button', { name: 'Reprocessar agora' });
    await userEvent.click(confirmar);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p).includes('/commerce/publicacoes/2/reprocessar') && o?.method === 'POST')).toBe(true);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto: sem falhas registradas', async () => {
    fetchMock.mockResolvedValue({ total: 0, erros: [] });
    renderPagina();
    expect(await screen.findByText('Nenhum erro')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
