import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CommercePrecosPage from './PrecosPage';

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
import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const LINHA = {
  id: 7, sku: 'CAM-001', nome: 'Camiseta Brobond', ativo: true, preco_base: 80, na_vitrine: true,
  precos: { MERCADOLIVRE: { preco: 99.9, promo: 94.9, origem: 'canal' } },
};

function renderPagina() {
  return render(
    <MemoryRouter initialEntries={['/commerce/precos']}>
      <Routes>
        <Route path="/commerce/precos" element={<CommercePrecosPage />} />
        <Route path="/commerce/produtos/:id" element={<div>rota-detalhe-produto</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Commerce — Preços (/commerce/precos)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('mostra preço base e preço por canal vindos do servidor e leva ao detalhe para editar', async () => {
    fetchMock.mockResolvedValue({ total: 1, produtos: [LINHA] });
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*80,00/)).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*94,90/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Editar preços' }));
    expect(await screen.findByText('rota-detalhe-produto')).toBeInTheDocument();
  });

  it('erro da API é mostrado com nova tentativa (nunca tela vazia silenciosa)', async () => {
    fetchMock.mockRejectedValueOnce(new ApiError(500, 'Falha ao carregar')).mockResolvedValueOnce({ total: 1, produtos: [LINHA] });
    renderPagina();
    expect(await screen.findByText(/Falha ao carregar/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
  });

  it('catálogo vazio → estado vazio explícito', async () => {
    fetchMock.mockResolvedValue({ total: 0, produtos: [] });
    renderPagina();
    expect(await screen.findByText('Nenhum produto ainda')).toBeInTheDocument();
  });
});
