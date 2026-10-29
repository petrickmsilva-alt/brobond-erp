// ============================================================================
// COMMERCE — /commerce/produtos (lista do catálogo multicanal).
// Contrato de tela: dado REAL da API, ZERO MODAL (novo/detalhe em rotas
// próprias), RBAC espelhado (escrita de vitrine = gerente/admin) e erro
// honesto no lugar de dado fake.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceProdutosPage from './ProdutosPage';

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

const LINHA = {
  id: 7,
  sku: 'CAM-001',
  nome: 'Camiseta Brobond',
  ativo: true,
  preco_base: 89.9,
  disponivel: 12,
  na_vitrine: true,
  slug: 'camiseta-brobond',
  publicacoes: { BROBOND: { estado: 'PUBLISHED', versao: 2, external_id: 'camiseta-brobond', ultimo_erro: null } },
  precos: { MERCADOLIVRE: { preco: 99.9, promo: 94.9, origem: 'canal' } },
};

function renderPagina(rota = '/commerce/produtos') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/produtos" element={<CommerceProdutosPage />} />
          <Route path="/commerce/produtos/novo" element={<div>rota-novo-produto</div>} />
          <Route path="/commerce/produtos/:id" element={<div>rota-detalhe-produto</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Catálogo multicanal (/commerce/produtos)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza as linhas reais da API (preço, disponibilidade, vitrine, canais)', async () => {
    fetchMock.mockResolvedValue({ total: 1, produtos: [LINHA] });
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText(/CAM-001/)).toBeInTheDocument();
    expect(screen.getByText('R$ 89,90')).toBeInTheDocument();
    expect(screen.getByText('Na vitrine')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/1 produto\(s\) no catálogo/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('“Projetar produto” navega para a ROTA PRÓPIA — nunca abre modal', async () => {
    fetchMock.mockResolvedValue({ total: 0, produtos: [] });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Nenhum produto ainda');
    await user.click(screen.getByRole('button', { name: /projetar produto/i }));
    expect(await screen.findByText('rota-novo-produto')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clique no produto abre a ROTA DE DETALHE (lista ≠ detalhe)', async () => {
    fetchMock.mockResolvedValue({ total: 1, produtos: [LINHA] });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    await user.click(screen.getByRole('button', { name: 'Camiseta Brobond' }));
    expect(await screen.findByText('rota-detalhe-produto')).toBeInTheDocument();
  });

  it('erro da API vira Alert honesto — nunca linha fictícia', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(503, 'Sem conexão com o catálogo.'); });
    renderPagina();
    expect(await screen.findByText('Sem conexão com o catálogo.')).toBeInTheDocument();
    expect(screen.queryByText('Camiseta Brobond')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
