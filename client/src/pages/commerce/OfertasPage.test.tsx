// ============================================================================
// COMMERCE — /commerce/ofertas: ofertas por canal com vigência e precedência
// vinda do servidor (preco_efetivo). ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceOfertasPage from './OfertasPage';

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

function renderPagina(rota = '/commerce/ofertas') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/ofertas" element={<CommerceOfertasPage />} />
          <Route path="/commerce/ofertas/novo" element={<div>rota-nova-oferta</div>} />
          <Route path="/commerce/ofertas/:id" element={<div>rota-detalhe-oferta</div>} />
          <Route path="/commerce/produtos/:id" element={<div>rota-produto</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Ofertas (/commerce/ofertas)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza ofertas REAIS com vigência, preço final do servidor e publicação', async () => {
    fetchMock.mockResolvedValue({ total: 1, ofertas: [OFERTA] });
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getAllByText('Mercado Livre').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R$ 120,00').length).toBeGreaterThan(0);
    expect(screen.getByText('promo R$ 99,90')).toBeInTheDocument();
    expect(screen.getByText('Vigente')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/ofertas');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filtra por canal via API (parâmetro real)', async () => {
    fetchMock.mockResolvedValue({ total: 1, ofertas: [OFERTA] });
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    const filtro = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    filtro.value = 'NUVEMSHOP';
    filtro.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0] ?? '')).toContain('canal=NUVEMSHOP');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio orienta sem inventar oferta', async () => {
    fetchMock.mockResolvedValue({ total: 0, ofertas: [] });
    renderPagina();
    expect(await screen.findByText('Nenhuma oferta de canal')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('navega para nova oferta e para o detalhe (rotas próprias)', async () => {
    fetchMock.mockResolvedValue({ total: 1, ofertas: [OFERTA] });
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    expect(screen.getByRole('button', { name: /Nova oferta/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(await screen.findByText('rota-detalhe-oferta')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
