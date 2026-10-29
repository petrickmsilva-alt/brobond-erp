// ============================================================================
// COMMERCE — /commerce/ofertas/:id: detalhe com precedência server-side
// explicitada e link para a publicação. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceOfertaDetalhePage from './OfertaDetalhePage';

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

const OFERTA = {
  id: 41,
  produto_id: 7,
  sku: 'SKU-7',
  nome: 'Camiseta Brobond',
  preco_base: 89.9,
  canal: 'MERCADOLIVRE',
  preco: 120,
  preco_promo: 99.9,
  vigencia_inicio: '2026-10-01',
  vigencia_fim: '2026-12-31',
  vigente: true,
  preco_efetivo: { preco: 120, promo: 99.9, origem: 'canal' },
  publicacao_estado: 'PUBLISHED',
  publicacao_id: 2,
  atualizado_em: '2026-10-20T10:00:00.000Z',
};

function renderPagina(rota = '/commerce/ofertas/41') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/ofertas/:id" element={<CommerceOfertaDetalhePage />} />
          <Route path="/commerce/ofertas" element={<div>rota-ofertas</div>} />
          <Route path="/commerce/ofertas/:id/editar" element={<div>rota-editar-oferta</div>} />
          <Route path="/commerce/publicacoes/:id" element={<div>rota-publicacao</div>} />
          <Route path="/commerce/produtos/:id" element={<div>rota-produto</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Detalhe da oferta (/commerce/ofertas/:id)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza a oferta REAL com precedência server-side documentada', async () => {
    fetchMock.mockResolvedValue({ oferta: OFERTA });
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 120,00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Vigente').length).toBeGreaterThan(0);
    expect(screen.getByText(/Linha de preço do canal COM vigência ativa/)).toBeInTheDocument();
    expect(screen.getAllByText(/vence o maior desconto/).length).toBeGreaterThan(0);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/ofertas/41');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('linka a publicação e o produto canônico', async () => {
    fetchMock.mockResolvedValue({ oferta: OFERTA });
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    const pubLink = screen.getAllByText('Publicada')[0].closest('a');
    expect(pubLink).toHaveAttribute('href', '/commerce/publicacoes/2');
    const produtoLink = screen.getAllByText('Camiseta Brobond').find((el) => el.closest('a'))!.closest('a');
    expect(produtoLink).toHaveAttribute('href', '/commerce/produtos/7');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro 404 é exibido honestamente', async () => {
    const { ApiError } = await import('../../lib/api');
    fetchMock.mockRejectedValue(new ApiError(404, 'Oferta não encontrada.'));
    renderPagina();
    expect(await screen.findByText('Oferta não encontrada.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
