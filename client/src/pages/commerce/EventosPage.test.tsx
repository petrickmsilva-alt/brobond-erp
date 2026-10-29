// ============================================================================
// COMMERCE — /commerce/eventos: linha do tempo REAL de outbox + publicações
// + webhooks via /commerce/eventos. ZERO MODAL.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceEventosPage from './EventosPage';

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

const EVENTOS = {
  outbox: [
    {
      id: 4,
      tipo: 'conversao',
      chave: 'sale:SAL1',
      estado: 'ERRO',
      tentativas: 5,
      ultimo_erro: 'Falha ao converter',
      atualizado_em: '2026-10-28T10:00:00.000Z',
    },
  ],
  publicacoes: [
    {
      id: 2,
      produto_id: 7,
      canal: 'MERCADOLIVRE',
      estado: 'ERROR',
      tentativas: 3,
      ultimo_erro: 'Credencial ML inválida',
      atualizado_em: '2026-10-28T11:00:00.000Z',
    },
  ],
  webhooks: [
    {
      id: 11,
      provider: 'mercadopago',
      status: 'erro',
      erro: 'Cobrança não encontrada',
      criado_em: '2026-10-28T12:00:00.000Z',
      processado_em: null,
    },
  ],
};

function renderPagina(rota = '/commerce/eventos') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>
        <Routes>
          <Route path="/commerce/eventos" element={<CommerceEventosPage />} />
          <Route path="/commerce/fila" element={<div>rota-fila</div>} />
          <Route path="/commerce/erros" element={<div>rota-erros</div>} />
          <Route path="/commerce/publicacoes/:id" element={<div>rota-publicacao</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Eventos (/commerce/eventos)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('consome /commerce/eventos e monta a linha do tempo das 3 origens', async () => {
    fetchMock.mockResolvedValue(EVENTOS);
    renderPagina();
    expect(await screen.findByText('Credencial ML inválida')).toBeInTheDocument();
    expect(screen.getByText('Falha ao converter')).toBeInTheDocument();
    expect(screen.getByText('Cobrança não encontrada')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('/commerce/eventos');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filtra por origem na linha do tempo', async () => {
    fetchMock.mockResolvedValue(EVENTOS);
    renderPagina();
    await screen.findByText('Credencial ML inválida');
    const filtro = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    filtro.value = 'webhook';
    filtro.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(screen.queryByText('Credencial ML inválida')).toBeNull();
      expect(screen.getByText('Cobrança não encontrada')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio é honesto', async () => {
    fetchMock.mockResolvedValue({ outbox: [], publicacoes: [], webhooks: [] });
    renderPagina();
    expect(await screen.findByText('Nenhum evento')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
