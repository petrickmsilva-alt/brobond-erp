// ============================================================================
// COMMERCE — /commerce/fila (observabilidade: outbox, publicações, webhooks).
// Contrato: estados/tentativas reais de CADA fila; sem modal; erro honesto.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceFilaPage from './FilaPage';

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

const EVENTOS = {
  outbox: [
    { id: 1, tipo: 'pedido.convertido', chave: 'SAL1', estado: 'PENDENTE', tentativas: 0, ultimo_erro: null, proxima_tentativa_em: null, atualizado_em: '2026-10-28T12:00:00Z' },
    { id: 2, tipo: 'evento.enviado', chave: 'PED-2', estado: 'PROCESSADO', tentativas: 1, ultimo_erro: null, proxima_tentativa_em: null, atualizado_em: '2026-10-28T12:01:00Z' },
  ],
  publicacoes: [
    { id: 9, produto_id: 7, canal: 'MERCADOLIVRE', estado: 'ERROR', tentativas: 3, ultimo_erro: 'Timeout do canal', atualizado_em: '2026-10-28T09:00:00Z' },
  ],
  webhooks: [
    { id: 5, provider: 'mercadopago', status: 'processado', erro: null, criado_em: '2026-10-28T10:00:00Z', processado_em: '2026-10-28T10:00:02Z' },
  ],
};

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/fila']}>
        <CommerceFilaPage />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Fila de sincronização (/commerce/fila)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('exibe outbox, publicações e webhooks com estados/tentativas reais', async () => {
    fetchMock.mockResolvedValue(EVENTOS);
    renderPagina();
    expect(await screen.findByText('pedido.convertido')).toBeInTheDocument();
    expect(screen.getByText('Timeout do canal')).toBeInTheDocument();
    expect(screen.getByText('mercadopago')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sem eventos: estado vazio honesto (nunca linhas fictícias)', async () => {
    fetchMock.mockResolvedValue({ outbox: [], publicacoes: [], webhooks: [] });
    renderPagina();
    expect((await screen.findAllByText(/nenhum|vazia|vazio/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(500, 'Outbox fora do ar.'); });
    renderPagina();
    expect(await screen.findByText('Outbox fora do ar.')).toBeInTheDocument();
  });
});
