// ============================================================================
// COMMERCE — /commerce/ofertas/novo e /:id/editar: grava em
// /commerce/produtos/:id/precos com validação de dinheiro. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceOfertaFormPage from './OfertaFormPage';

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

const PRODUTO = { id: 7, sku: 'SKU-7', nome: 'Camiseta Brobond', preco_base: 89.9 };
const OFERTA = {
  id: 41,
  produto_id: 7,
  sku: 'SKU-7',
  nome: 'Camiseta Brobond',
  preco_base: 89.9,
  canal: 'MERCADOLIVRE',
  preco: 120,
  preco_promo: null,
  vigencia_inicio: '2026-10-01',
  vigencia_fim: null,
  vigente: true,
  preco_efetivo: { preco: 120, promo: null, origem: 'canal' },
  publicacao_estado: 'PUBLISHED',
  publicacao_id: 2,
  atualizado_em: '2026-10-20T10:00:00.000Z',
};

function renderNova() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/ofertas/novo']}>
        <Routes>
          <Route path="/commerce/ofertas/novo" element={<CommerceOfertaFormPage />} />
          <Route path="/commerce/ofertas" element={<div>rota-ofertas</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

function renderEditar() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/ofertas/41/editar']}>
        <Routes>
          <Route path="/commerce/ofertas/:id/editar" element={<CommerceOfertaFormPage />} />
          <Route path="/commerce/ofertas" element={<div>rota-ofertas</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Form de oferta (novo/editar)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('NOVO: busca produto, grava preço por canal via PUT /produtos/:id/precos', async () => {
    fetchMock.mockResolvedValue({ produtos: [PRODUTO], total: 1 });
    renderNova();
    await userEvent.type(screen.getByPlaceholderText(/mín. 2 caracteres/), 'camiseta');
    await vi.waitFor(() => expect(String(fetchMock.mock.calls[0][0])).toContain('/commerce/produtos?q=camiseta'));
    await userEvent.click(await screen.findByRole('button', { name: /Camiseta Brobond/ }));
    const preco = screen.getByLabelText(/Preço \(R\$\) \*/);
    await userEvent.clear(preco);
    await userEvent.type(preco, '129,90');
    // vírgula brasileira não é número válido para o servidor — usar ponto:
    await userEvent.clear(preco);
    await userEvent.type(preco, '129.90');
    fetchMock.mockResolvedValue({ ok: true, preco: {} });
    await userEvent.click(screen.getByRole('button', { name: /Salvar oferta/ }));
    await vi.waitFor(() => {
      const chamada = fetchMock.mock.calls.find(([p, o]) => p === '/commerce/produtos/7/precos' && o?.method === 'PUT');
      expect(chamada).toBeTruthy();
      expect(String(chamada![1]?.body)).toContain('"canal":"BROBOND"');
      expect(String(chamada![1]?.body)).toContain('"preco":129.9');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('EDITAR: carrega a oferta real e valida promo >= preço antes do PUT', async () => {
    fetchMock.mockResolvedValue({ oferta: OFERTA });
    renderEditar();
    expect(await screen.findByDisplayValue('120')).toBeInTheDocument();
    const promo = screen.getByLabelText(/Preço promocional \(R\$\)/);
    await userEvent.type(promo, '150');
    fetchMock.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Salvar oferta/ }));
    expect(await screen.findByText('O preço promocional precisa ser menor que o preço do canal.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('EDITAR: grava PUT mesmo sem promoção (canal é identidade, readonly)', async () => {
    fetchMock.mockResolvedValue({ oferta: OFERTA });
    renderEditar();
    await screen.findByDisplayValue('120');
    const canal = screen.getByLabelText(/Canal \*/);
    expect(canal).toBeDisabled();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, preco: {} });
    await userEvent.click(screen.getByRole('button', { name: /Salvar oferta/ }));
    await vi.waitFor(() => {
      const chamada = fetchMock.mock.calls.find(([p, o]) => p === '/commerce/produtos/7/precos' && o?.method === 'PUT');
      expect(chamada).toBeTruthy();
      expect(String(chamada![1]?.body)).toContain('"canal":"MERCADOLIVRE"');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro 400 do servidor aparece na tela (sem mascarar)', async () => {
    fetchMock.mockResolvedValue({ oferta: OFERTA });
    renderEditar();
    await screen.findByDisplayValue('120');
    fetchMock.mockRejectedValue(new ApiError(400, 'Informe um preço maior ou igual a zero.'));
    await userEvent.click(screen.getByRole('button', { name: /Salvar oferta/ }));
    expect(await screen.findByText('Informe um preço maior ou igual a zero.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
