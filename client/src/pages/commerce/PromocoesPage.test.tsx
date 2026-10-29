// ============================================================================
// COMMERCE — /commerce/promocoes (lista de promoções com confirmacao INLINE).
// Contrato: dados reais, nova/exclusão em rota própria ou inline, ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePromocoesPage from './PromocoesPage';

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

const PROMOCOES = {
  total: 1,
  promocoes: [
    { id: 5, nome: 'Volta às aulas', tipo: 'percentual', valor: 10, minimo_pedido: 100, data_inicio: '2026-10-01', data_fim: '2026-11-01', ativo: true },
  ],
};

function renderPagina(rota = '/commerce/promocoes') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/promocoes" element={<CommercePromocoesPage />} />
          <Route path="/commerce/promocoes/nova" element={<div>rota-nova-promocao</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Promoções (/commerce/promocoes)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza promoções reais com tipo/valor/vigência', async () => {
    fetchMock.mockResolvedValue(PROMOCOES);
    renderPagina();
    expect(await screen.findByText('Volta às aulas')).toBeInTheDocument();
    expect(document.body.textContent).toContain('10%');
    expect(screen.getByText('Ativa')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('“Nova promoção” navega para rota própria (ZERO MODAL)', async () => {
    fetchMock.mockResolvedValue(PROMOCOES);
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Volta às aulas');
    await user.click(screen.getByRole('button', { name: /nova promoção/i }));
    expect(await screen.findByText('rota-nova-promocao')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('exclusão usa ConfirmacaoInline (inline) + DELETE — nunca overlay', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return { ok: true };
      return PROMOCOES;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Volta às aulas');
    const excluir = screen.getAllByRole('button').find((b) => /excluir/i.test(b.textContent ?? ''));
    expect(excluir).toBeTruthy();
    await user.click(excluir!);
    expect(screen.queryByRole('dialog')).toBeNull();
    // ConfirmacaoInline usa confirmLabel="Excluir" (inline, sem overlay)
    const confirmar = (await screen.findAllByRole('button', { name: 'Excluir' })).at(-1)!;
    await user.click(confirmar);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/promocoes/5', expect.objectContaining({ method: 'DELETE' })));
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(503, 'Promoções fora do ar.'); });
    renderPagina();
    expect(await screen.findByText('Promoções fora do ar.')).toBeInTheDocument();
  });
});
