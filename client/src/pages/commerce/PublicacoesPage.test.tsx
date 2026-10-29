// ============================================================================
// COMMERCE — /commerce/publicacoes (fila multicanal DRAFT→PUBLISHED/ERROR).
// Contrato: estados reais da fila, reprocessar por AÇÃO (POST), ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommercePublicacoesPage from './PublicacoesPage';

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

const PUBLICACOES = {
  total: 2,
  publicacoes: [
    { id: 1, produto_id: 7, produto: 'Camiseta Brobond', canal: 'BROBOND', versao: 3, estado: 'PUBLISHED', external_id: 'camiseta-brobond', tentativas: 1, ultimo_erro: null, proxima_tentativa_em: null, publicado_em: '2026-10-20T12:00:00Z', atualizado_em: '2026-10-20T12:00:00Z' },
    { id: 2, produto_id: 8, produto: 'Tênis Runner', canal: 'MERCADOLIVRE', versao: 1, estado: 'ERROR', external_id: null, tentativas: 3, ultimo_erro: 'Credencial ML inválida', proxima_tentativa_em: '2026-10-29T00:00:00Z', publicado_em: null, atualizado_em: '2026-10-28T09:00:00Z' },
  ],
};

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/publicacoes']}>
        <CommercePublicacoesPage />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Fila de publicações (/commerce/publicacoes)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('exibe estados reais da fila (PUBLISHED e ERROR com o erro honesto)', async () => {
    fetchMock.mockResolvedValue(PUBLICACOES);
    renderPagina();
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText('Tênis Runner')).toBeInTheDocument();
    expect(screen.getByText(/Credencial ML inválida/)).toBeInTheDocument();
    expect(screen.getByText(/2 publicação/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reprocessar dispara POST /commerce/publicacoes/:id/reprocessar (ação, não modal)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true };
      return PUBLICACOES;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    // o reprocessar aparece junto da publicação com ERROR, nome "produto · canal"
    const reprocessar = await screen.findByRole('button', { name: /Tênis Runner · Mercado Livre/i });
    await user.click(reprocessar);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/commerce/publicacoes/2/reprocessar', expect.objectContaining({ method: 'POST' }))
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(503, 'Fila indisponível.'); });
    renderPagina();
    expect(await screen.findByText('Fila indisponível.')).toBeInTheDocument();
  });
});
