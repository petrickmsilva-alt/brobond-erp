// ============================================================================
// PLANEJAMENTO DE PRODUÇÃO — contrato de tela (E2)
//
// O que estes testes protegem:
//   • a tela renderiza o plano real que o servidor manda (semana, OPs, atraso);
//   • insumo em falta aparece destacado, insumo com saldo suficiente não;
//   • período sem OP mostra ESTADO VAZIO com caminho para criar — nunca um
//     número inventado;
//   • erro de rede mostra a mensagem e oferece tentar de novo.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlanejamentoProducaoPage from './PlanejamentoProducaoPage';
import { api, ApiError } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const apiGet = vi.mocked(api.get);

const PLANO = {
  de: '2026-10-05',
  ate: '2026-11-30',
  hoje: '2026-10-08',
  resumo: {
    ops: 2,
    planejadas: 40,
    produzidas: 12,
    perdidas: 2,
    faltam: 28,
    atrasadas: 1,
    custo_previsto: 1200,
    insumos_em_falta: 1,
  },
  porSemana: [
    { semana: '2026-10-05', ops: 2, planejadas: 40, produzidas: 12, atrasadas: 1, custo_previsto: 1200 },
  ],
  ordens: [
    {
      id: 77,
      produto: 'Camisa Polo',
      produto_id: 5,
      status: 'parcial',
      previsao: '2026-10-02',
      semana: '2026-09-28',
      planejadas: 30,
      produzidas: 12,
      perdidas: 2,
      faltam: 18,
      atrasada: true,
      custo_previsto: 900,
      responsavel: null,
    },
    {
      id: 78,
      produto: 'Calça Jeans',
      produto_id: 6,
      status: 'liberada',
      previsao: '2026-10-09',
      semana: '2026-10-05',
      planejadas: 10,
      produzidas: 0,
      perdidas: 0,
      faltam: 10,
      atrasada: false,
      custo_previsto: 300,
      responsavel: 'Mesa 3',
    },
  ],
  insumos: [
    { insumo_id: 3, nome: 'Tecido Piquet', unidade: 'm', necessaria: 90, disponivel: 20, faltando: 70 },
    { insumo_id: 4, nome: 'Botão 18L', unidade: 'un', necessaria: 40, disponivel: 500, faltando: 0 },
  ],
};

const VAZIO = {
  de: '2031-01-05',
  ate: '2031-02-01',
  hoje: '2026-10-08',
  resumo: { ops: 0, planejadas: 0, produzidas: 0, perdidas: 0, faltam: 0, atrasadas: 0, custo_previsto: 0, insumos_em_falta: 0 },
  porSemana: [],
  ordens: [],
  insumos: [],
};

describe('PlanejamentoProducaoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pede o período e mostra o resumo real do servidor', async () => {
    apiGet.mockResolvedValue(PLANO as any);
    render(<PlanejamentoProducaoPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(String(apiGet.mock.calls[0][0])).toContain('/producao/planejamento?de=');

    expect(await screen.findByText('Camisa Polo')).toBeInTheDocument();
    expect(screen.getByText('Calça Jeans')).toBeInTheDocument();
    expect(screen.getByText('Planejamento de produção')).toBeInTheDocument();
    // atraso é chamado pelo nome, não escondido em cor
    expect(screen.getByText(/atrasada/)).toBeInTheDocument();
    expect(screen.getByText('semana de 05/10/2026')).toBeInTheDocument();
  });

  it('destaca só o insumo que falta e liga o caminho para a sugestão de compra', async () => {
    apiGet.mockResolvedValue(PLANO as any);
    render(<PlanejamentoProducaoPage />);
    expect(await screen.findByText('Tecido Piquet')).toBeInTheDocument();
    expect(screen.getByText('Botão 18L')).toBeInTheDocument();
    expect(screen.getByText('70 m')).toBeInTheDocument();
    // insumo com saldo suficiente aparece como "ok", não como falta
    expect(screen.getAllByText('ok').length).toBeGreaterThan(0);
    expect(screen.getByText(/Abrir sugestão de compra/)).toBeInTheDocument();
  });

  it('avisa quantos insumos estão em falta e quantas OPs atrasaram', async () => {
    apiGet.mockResolvedValue(PLANO as any);
    render(<PlanejamentoProducaoPage />);
    expect(await screen.findByText(/1 insumo\(s\) em falta/)).toBeInTheDocument();
    expect(screen.getByText(/1 OP\(s\) com previsão vencida/)).toBeInTheDocument();
  });

  it('período sem OP mostra estado vazio com caminho para criar — sem inventar número', async () => {
    apiGet.mockResolvedValue(VAZIO as any);
    render(<PlanejamentoProducaoPage />);
    expect(await screen.findByText('Nenhuma OP no período')).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma ordem planejada/)).toBeInTheDocument();
    expect(screen.getByText('Ir para Cadeias de Fabricação')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma necessidade de insumo')).toBeInTheDocument();
    expect(screen.queryByText(/insumo\(s\) em falta/)).not.toBeInTheDocument();
  });

  it('erro de rede mostra a mensagem e oferece tentar de novo', async () => {
    apiGet.mockRejectedValue(new ApiError(503, 'Banco indisponível'));
    render(<PlanejamentoProducaoPage />);
    expect(await screen.findByText(/Banco indisponível/)).toBeInTheDocument();
    const tentar = screen.getByText('Tentar de novo');
    apiGet.mockResolvedValue(PLANO as any);
    fireEvent.click(tentar);
    expect(await screen.findByText('Camisa Polo')).toBeInTheDocument();
  });
});
