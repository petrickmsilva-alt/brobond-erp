// ============================================================================
// FASE 9.2 — CAIXA DE ENTRADA INTERNA DO CRM (/crm/notificacoes).
//
// A tela consome o endpoint próprio `GET /api/crm/notificacoes` (recortado por
// empresa E por usuário no servidor) e as duas transições idempotentes de
// leitura. Nenhuma regra de negócio vive aqui: a idempotência e o recorte de
// destinatário são do servidor.
//
// Prova:
//   1. renderiza os avisos com tipo, severidade e estado de leitura;
//   2. filtro por tipo vira query na API (o recorte continua no servidor);
//   3. "marcar como lida" só reflete depois da resposta (nada de otimismo);
//   4. "marcar todas" é idempotente do ponto de vista da tela (reexibe a caixa);
//   5. estado vazio é legítimo (não é erro);
//   6. erro de leitura é recuperável (mostra a mensagem e permite tentar de novo).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ui';
import CrmNotificacoesPage from './CrmNotificacoesPage';

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

import { api, ApiError } from '../lib/api';
const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

const CAIXA = {
  itens: [
    {
      id: 11,
      atividade_id: 7,
      tipo: 'lembrete',
      severidade: 'media',
      titulo: 'Lembrete: ligar para o cliente',
      detalhe: 'Atividade vence hoje.',
      usuario_id: 3,
      lida_em: null,
      criado_em: '2026-11-09T12:00:00.000Z',
    },
    {
      id: 12,
      atividade_id: null,
      tipo: 'vencida',
      severidade: 'alta',
      titulo: 'Atividade vencida',
      detalhe: 'Prazo estourado em 2 dias.',
      usuario_id: 3,
      lida_em: '2026-11-09T13:00:00.000Z',
      criado_em: '2026-11-09T09:00:00.000Z',
    },
  ],
  total: 2,
  nao_lidas: 1,
  page: 1,
  pageSize: 30,
};

function renderPagina() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CrmNotificacoesPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Fase 9.2 — Caixa de entrada do CRM', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renderiza os avisos com tipo, severidade e o estado de leitura de cada um', async () => {
    getMock.mockResolvedValue(CAIXA);
    renderPagina();

    expect(await screen.findByText('Lembrete: ligar para o cliente')).toBeInTheDocument();
    expect(screen.getByText('Atividade vencida')).toBeInTheDocument();
    // O tipo é lido por texto (não só por cor) — no selo do aviso e no filtro.
    expect(screen.getAllByText('Lembrete').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Vencida').length).toBeGreaterThanOrEqual(1);
    // Só a não lida tem o selo e o botão de marcar.
    expect(screen.getByText('Não lida')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Marcar como lida' })).toHaveLength(1);
    expect(screen.getByText('Lida')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith('/crm/notificacoes');
  });

  it('o filtro por tipo vira query e mantém o recorte no servidor', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(CAIXA);
    renderPagina();
    await screen.findByText('Lembrete: ligar para o cliente');

    getMock.mockClear();
    getMock.mockResolvedValue({ ...CAIXA, itens: [CAIXA.itens[0]], total: 1, nao_lidas: 1 });
    await user.selectOptions(screen.getByLabelText('Filtrar por tipo'), 'lembrete');

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/crm/notificacoes?tipo=lembrete'));
    // O filtro é do servidor — a tela não corta a lista em memória.
    expect(await screen.findByText('Lembrete: ligar para o cliente')).toBeInTheDocument();
    expect(screen.queryByText('Atividade vencida')).not.toBeInTheDocument();
  });

  it('"marcar como lida" só reflete depois da resposta do servidor', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(CAIXA);
    postMock.mockResolvedValue({ ok: true });
    renderPagina();
    await screen.findByText('Lembrete: ligar para o cliente');

    getMock.mockClear();
    getMock.mockResolvedValue({ ...CAIXA, itens: CAIXA.itens.map((n) => ({ ...n, lida_em: n.lida_em ?? '2026-11-09T14:00:00.000Z' })), nao_lidas: 0 });

    await user.click(screen.getByRole('button', { name: 'Marcar como lida' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/crm/notificacoes/11/lida', {}));
    // Recarrega a caixa (o estado real vem do servidor, não de otimismo local).
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/crm/notificacoes'));
    expect(await screen.findByText('Tudo lido por aqui.')).toBeInTheDocument();
  });

  it('"marcar todas" é idempotente: sem pendências o botão fica desabilitado', async () => {
    getMock.mockResolvedValue({ ...CAIXA, nao_lidas: 0, itens: CAIXA.itens.map((n) => ({ ...n, lida_em: '2026-11-09T14:00:00.000Z' })) });
    renderPagina();
    await screen.findByText('Lembrete: ligar para o cliente');

    expect(screen.getByRole('button', { name: /Marcar todas como lidas/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Marcar como lida' })).not.toBeInTheDocument();
  });

  it('caixa vazia é estado legítimo (não é erro)', async () => {
    getMock.mockResolvedValue({ itens: [], total: 0, nao_lidas: 0, page: 1, pageSize: 30 });
    renderPagina();

    expect(await screen.findByText('Caixa de entrada vazia')).toBeInTheDocument();
    expect(screen.queryByText(/não foi possível/i)).not.toBeInTheDocument();
  });

  it('erro de leitura é recuperável: mostra a mensagem e permite tentar de novo', async () => {
    const user = userEvent.setup();
    getMock.mockRejectedValueOnce(new ApiError(500, 'Falha ao carregar a caixa.'));
    renderPagina();

    expect(await screen.findByText('Falha ao carregar a caixa.')).toBeInTheDocument();

    getMock.mockResolvedValue(CAIXA);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Lembrete: ligar para o cliente')).toBeInTheDocument();
  });
});
