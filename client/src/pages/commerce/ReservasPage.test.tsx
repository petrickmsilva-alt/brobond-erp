// ============================================================================
// COMMERCE — /commerce/reservas: lista reservas do ESTOQUE CANÔNICO via API
// real. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceReservasPage from './ReservasPage';

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

const RESERVA = {
  id: 31,
  produto_id: 7,
  produto: 'Camiseta Brobond',
  tamanho_id: 12,
  local_id: 1,
  tipo: 'reserva',
  quantidade: 2,
  status: 'ativa',
  origem_recurso: 'commerce_checkout',
  origem_id: 55,
  motivo: 'Checkout LOJA-ABC123',
  criado_em: '2026-10-21T09:00:00.000Z',
  liberada_em: null,
};

function renderPagina(rota = '/commerce/reservas') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/reservas" element={<CommerceReservasPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Reservas (/commerce/reservas)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza reservas REAIS com origem do checkout e quantidade', async () => {
    fetchMock.mockResolvedValue({ total: 1, reservas: [RESERVA] });
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getAllByText('Ativa').length).toBeGreaterThan(0);
    expect(screen.getByText('commerce_checkout #55')).toBeInTheDocument();
    expect(screen.getByText('Checkout LOJA-ABC123')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=ativa');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('trocar o status recarrega pela API (servidor é a autoridade)', async () => {
    fetchMock.mockResolvedValue({ total: 1, reservas: [RESERVA] });
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    const filtro = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    filtro.value = 'liberada';
    filtro.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0] ?? '')).toContain('status=liberada');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio não inventa reserva', async () => {
    fetchMock.mockResolvedValue({ total: 0, reservas: [] });
    renderPagina();
    expect(await screen.findByText('Nenhuma reserva')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
