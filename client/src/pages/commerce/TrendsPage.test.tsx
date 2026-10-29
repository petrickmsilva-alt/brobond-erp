// ============================================================================
// COMMERCE — /commerce/trends (analytics real da operação, sem dado fake).
// Contrato: período/totais/tendência vieram da API; vazio = mensagem honesta.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceTrendsPage from './TrendsPage';

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

const TRENDS = {
  periodo: { dias: 30, inicio: '2026-09-28', fim: '2026-10-28' },
  serie: [
    { dia: '2026-10-26', pedidos: 4, receita: 520 },
    { dia: '2026-10-27', pedidos: 6, receita: 810 },
    { dia: '2026-10-28', pedidos: 5, receita: 640 },
  ],
  totais: { pedidos: 15, receita: 1970, media_diaria: 656.67 },
  tendencia: { slope: 0.5, direcao: 'alta' },
  melhor_dia: { dia: '2026-10-27', pedidos: 6, receita: 810 },
  pior_dia: { dia: '2026-10-26', pedidos: 4, receita: 520 },
  top_crescimento: [{ produto_id: 7, produto: 'Camiseta Brobond', qtd_inicio: 3, qtd_fim: 9, variacao_pct: 200 }],
  vazio: false,
};

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/trends']}>
        <CommerceTrendsPage />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Trends (/commerce/trends)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('renderiza totais, tendência e top crescimento REAIS da API', async () => {
    fetchMock.mockResolvedValue(TRENDS);
    renderPagina();
    expect(await screen.findByText(/15/)).toBeInTheDocument();
    expect(screen.getByText(/alta/i)).toBeInTheDocument();
    expect(screen.getByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText(/R\$ 1\.970,00|1970,00/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('trocar o período refaz a chamada com ?dias= (não inventa série local)', async () => {
    fetchMock.mockResolvedValue(TRENDS);
    const user = userEvent.setup();
    renderPagina();
    await screen.findByText('Camiseta Brobond');
    const periodo = await screen.findByRole('combobox');
    await user.selectOptions(periodo, '60');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce/trends?dias=60'));
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(503, 'Sem dados de analytics.'); });
    renderPagina();
    expect(await screen.findByText('Sem dados de analytics.')).toBeInTheDocument();
  });
});
