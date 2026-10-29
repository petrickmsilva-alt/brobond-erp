// ============================================================================
// COMMERCE — /commerce/cupons (lista de cupons com exclusão INLINE).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceCuponsPage from './CuponsPage';

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

const CUPONS = {
  total: 1,
  cupons: [
    { id: 2, codigo: 'BEMVINDO10', tipo: 'percentual', valor: 10, minimo_pedido: 80, uso_maximo: 1, uso_atual: 1, validade: '2026-12-31', ativo: true },
  ],
};

function renderPagina(rota = '/commerce/cupons') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/cupons" element={<CommerceCuponsPage />} />
          <Route path="/commerce/cupons/novo" element={<div>rota-novo-cupom</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Cupons (/commerce/cupons)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza cupons reais com código, uso e validade', async () => {
    fetchMock.mockResolvedValue(CUPONS);
    renderPagina();
    expect(await screen.findByText('BEMVINDO10')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/1\s*\/\s*1/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('“Novo cupom” navega para rota própria (ZERO MODAL)', async () => {
    fetchMock.mockResolvedValue(CUPONS);
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('BEMVINDO10');
    await user.click(screen.getByRole('button', { name: /novo cupom/i }));
    expect(await screen.findByText('rota-novo-cupom')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exclusão é ConfirmacaoInline + DELETE (cupom com uso = desativação)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return { ok: true, desativado: true };
      return CUPONS;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('BEMVINDO10');
    const excluir = screen.getAllByRole('button').find((b) => /excluir/i.test(b.textContent ?? ''));
    expect(excluir).toBeTruthy();
    await user.click(excluir!);
    expect(screen.queryByRole('dialog')).toBeNull();
    const confirmar = await screen.findByRole('button', { name: 'Confirmar' });
    await user.click(confirmar);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/cupons/2', expect.objectContaining({ method: 'DELETE' })));
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(500, 'Falha ao listar cupons.'); });
    renderPagina();
    expect(await screen.findByText('Falha ao listar cupons.')).toBeInTheDocument();
  });
});
