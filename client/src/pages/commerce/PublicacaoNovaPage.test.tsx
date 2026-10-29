// ============================================================================
// COMMERCE — /commerce/publicacoes/novo: CRIAR publicação produto × canais via
// POST real, com validação. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePublicacaoNovaPage from './PublicacaoNovaPage';

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

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const PRODUTO = {
  id: 7,
  sku: 'SKU-7',
  nome: 'Camiseta Brobond',
  preco_base: 89.9,
  disponivel: 10,
  publicacoes: {},
};

function renderPagina(rota = '/commerce/publicacoes/novo') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/publicacoes/novo" element={<CommercePublicacaoNovaPage />} />
          <Route path="/commerce/publicacoes" element={<div>rota-fila</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Nova publicação (/commerce/publicacoes/novo)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('busca produto pela API e publica selecionando canais (POST real)', async () => {
    fetchMock.mockResolvedValue({ produtos: [PRODUTO], total: 1 });
    renderPagina();
    const busca = screen.getByPlaceholderText(/SKU-100 ou Camiseta/);
    await userEvent.type(busca, 'camiseta');
    await vi.waitFor(() => expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/produtos?q=camiseta'));
    await userEvent.click(await screen.findByRole('button', { name: /Camiseta Brobond/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Mercado Livre/ }));
    fetchMock.mockResolvedValue({ ok: true, publicacoes: [] });
    await userEvent.click(screen.getByRole('button', { name: /Publicar nos canais/ }));
    await vi.waitFor(() => {
      const chamada = fetchMock.mock.calls.find(([p, o]) => p === '/commerce/publicacoes' && o?.method === 'POST');
      expect(chamada).toBeTruthy();
      expect(String(chamada![1]?.body)).toContain('"produto_id":7');
      expect(String(chamada![1]?.body)).toContain('MERCADOLIVRE');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exige ao menos um canal (validação honesta, sem submeter)', async () => {
    fetchMock.mockResolvedValue({ produtos: [PRODUTO], total: 1 });
    renderPagina();
    await userEvent.type(screen.getByPlaceholderText(/SKU-100 ou Camiseta/), 'camiseta');
    await userEvent.click(await screen.findByRole('button', { name: /Camiseta Brobond/ }));
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Publicar nos canais/ }));
    expect(await screen.findByText('Marque ao menos um canal.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('mostra o erro real do servidor (ex.: sem projeção no BROBOND)', async () => {
    fetchMock.mockResolvedValue({ produtos: [PRODUTO], total: 1 });
    renderPagina();
    await userEvent.type(screen.getByPlaceholderText(/SKU-100 ou Camiseta/), 'camiseta');
    await userEvent.click(await screen.findByRole('button', { name: /Camiseta Brobond/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Loja própria/ }));
    fetchMock.mockRejectedValue(new ApiError(409, 'Projete o produto na vitrine (slug) antes de publicar no canal BROBOND.'));
    await userEvent.click(screen.getByRole('button', { name: /Publicar nos canais/ }));
    expect(await screen.findByText(/Projete o produto na vitrine/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
