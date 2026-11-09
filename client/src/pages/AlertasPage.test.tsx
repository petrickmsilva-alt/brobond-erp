// ============================================================================
// FASE 8 — ALERTAS (/alertas).
// A tela consome o painel derivado e dispara as transições auditadas
// (reconhecer/resolver/silenciar) — nenhuma regra de negócio vive aqui.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ui';
import AlertasPage from './AlertasPage';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { api } from '../lib/api';
const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

const PAINEL = {
  totais: { abertos: 1, cientes: 0, resolvidos: 0, silenciados: 0, por_dominio: { estoque: 1 }, por_severidade: { alta: 1 } },
  alertas: [
    {
      id: 42,
      regra_chave: 'ruptura_estoque',
      dominio: 'estoque',
      severidade: 'alta',
      titulo: 'Ruptura de estoque',
      detalhe: 'Produto X zerado no local principal.',
      evidencia: { produto_id: 9 },
      status: 'ABERTO',
      ocorrencias: 2,
      primeira_deteccao: '2026-10-28T12:00:00.000Z',
      ultima_deteccao: '2026-10-28T13:00:00.000Z',
      reconhecido_em: null,
      resolvido_em: null,
      silenciado_ate: null,
    },
  ],
  catálogo: [{ chave: 'ruptura_estoque', nome: 'Ruptura de estoque', dominio: 'estoque', severidade: 'alta', limiar: { minimo: 1 } }],
  gerado_em: '2026-10-28T13:00:00.000Z',
};

function renderPagina() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AlertasPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Fase 8 — Alertas', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renderiza as ocorrências e o catálogo de detectores', async () => {
    getMock.mockResolvedValue(PAINEL);
    renderPagina();
    expect(await screen.findByText('Produto X zerado no local principal.')).toBeInTheDocument();
    expect(screen.getAllByText('Ruptura de estoque').length).toBeGreaterThan(0);
    expect(screen.getByText('ruptura_estoque · Estoque')).toBeInTheDocument();
    expect(getMock.mock.calls[0][0]).toContain('/alerts/painel');
  });

  it('reconhece um alerta aberto chamando o endpoint de transição', async () => {
    getMock.mockResolvedValue(PAINEL);
    postMock.mockResolvedValue({});
    renderPagina();
    const botao = await screen.findByRole('button', { name: 'Reconhecer' });
    await userEvent.click(botao);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/alerts/42/reconhecer', {}));
  });

  it('estado vazio honesto quando não há ocorrências', async () => {
    getMock.mockResolvedValue({ ...PAINEL, alertas: [], totais: { ...PAINEL.totais, abertos: 0 } });
    renderPagina();
    expect(await screen.findByText('Sem alertas')).toBeInTheDocument();
  });
});
