// ============================================================================
// Histórico de estados do pedido (OMS — migration 0109).
// Contrato com GET /api/oms/vendas/:id/status-historico: a tela mostra a trilha
// imutável (de → para, canal, autor) e nunca inventa linha quando a API falha.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HistoricoEstadoVenda } from './HistoricoEstadoVenda';
import { ToastProvider } from '../ui';
import { api, ApiError } from '../../lib/api';

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

const apiGet = vi.mocked(api.get);

const TRILHA = [
  { id: 3, status_anterior: 'faturada', status_novo: 'entregue', origem: 'expedicao', motivo: null, referencia_externa: 'NF-123', usuario_nome: 'Ana', criado_em: '2026-11-02T10:00:00Z' },
  { id: 2, status_anterior: 'aberta', status_novo: 'faturada', origem: 'fiscal', motivo: null, referencia_externa: null, usuario_nome: 'Ana', criado_em: '2026-11-01T10:00:00Z' },
  { id: 1, status_anterior: null, status_novo: 'aberta', origem: 'erp', motivo: null, referencia_externa: null, usuario_nome: 'Bruno', criado_em: '2026-10-31T10:00:00Z' },
];

function renderTimeline(vendaId = 42) {
  return render(
    <ToastProvider>
      <HistoricoEstadoVenda etapa={8} vendaId={vendaId} />
    </ToastProvider>,
  );
}

describe('HistoricoEstadoVenda', () => {
  beforeEach(() => apiGet.mockReset());

  it('renderiza a trilha: de → para, canal, autor e referência externa', async () => {
    apiGet.mockResolvedValue(TRILHA);
    renderTimeline();

    expect(await screen.findAllByText('Faturada')).not.toHaveLength(0);
    expect(screen.getAllByText('Entregue').length).toBeGreaterThan(0);
    expect(screen.getByText('Criação')).toBeInTheDocument();
    expect(screen.getByText('Expedição')).toBeInTheDocument();
    expect(screen.getByText('Fiscal')).toBeInTheDocument();
    expect(screen.getByText(/ref\. NF-123/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/oms/vendas/42/status-historico');
  });

  it('mostra estado vazio quando não há transição registrada', async () => {
    apiGet.mockResolvedValue([]);
    renderTimeline();
    expect(await screen.findByText(/Nenhuma transição registrada/)).toBeInTheDocument();
  });

  it('não inventa linha quando a API falha (erro visível)', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(403, 'Sem acesso à trilha.'));
    renderTimeline();
    expect(await screen.findByText('Sem acesso à trilha.')).toBeInTheDocument();
  });
});
