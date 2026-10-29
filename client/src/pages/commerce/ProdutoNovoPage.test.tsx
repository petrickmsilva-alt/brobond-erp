// ============================================================================
// COMMERCE — /commerce/produtos/novo (projetar produto EXISTENTE na vitrine).
// Contrato: lista o cadastro canônico do ERP, NUNCA cria produto duplicado,
// ZERO MODAL — ao projetar, navega para o detalhe em rota própria.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceProdutoNovoPage from './ProdutoNovoPage';

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
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Gerente Teste', perfil: 'admin' } }),
}));

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const PRODUTOS = {
  produtos: [
    { id: 11, sku: 'BER-020', nome: 'Bermuda Cargo', preco_venda: 120, ativo: true },
    { id: 12, sku: 'INV-999', nome: 'Inativo Velho', preco_venda: 50, ativo: false },
  ],
};

function renderPagina(rota = '/commerce/produtos/novo') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/produtos/novo" element={<CommerceProdutoNovoPage />} />
          <Route path="/commerce/produtos/:id" element={<div>rota-detalhe-produto</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Projetar produto (/commerce/produtos/novo)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('mostra apenas produtos ATIVOS do ERP (nada fictício, inativos fora)', async () => {
    fetchMock.mockResolvedValue(PRODUTOS);
    renderPagina();
    expect(await screen.findByText('Bermuda Cargo')).toBeInTheDocument();
    expect(screen.getByText(/BER-020/)).toBeInTheDocument();
    expect(screen.queryByText('Inativo Velho')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('projetar chama POST /commerce/produtos e navega para o DETALHE (rota própria)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, produto_commerce: { id: 11, slug: 'bermuda-cargo' } };
      return PRODUTOS;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Bermuda Cargo');
    const botoes = screen.getAllByRole('button');
    const projetar = botoes.find((b) => /projetar/i.test(b.textContent ?? ''));
    expect(projetar).toBeTruthy();
    await user.click(projetar!);
    expect(await screen.findByText('rota-detalhe-produto')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/commerce/produtos', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('falha da API aparece como Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(409, 'Produto já projetado.'); });
    renderPagina();
    expect(await screen.findByText('Produto já projetado.')).toBeInTheDocument();
  });
});
