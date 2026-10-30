// ============================================================================
// CUSTOMER 360 — CONTRATO DA TELA (/clientes/:id/360)
//
// O Customer 360 é LEITURA DERIVADA do servidor (GET /api/customer360/:id):
// receita, pedidos, ticket médio, LTV, produtos, devoluções e tickets vêm
// prontos. Este teste trava só o contrato da TELA:
//
//   A. busca o endpoint do cliente da rota (não de outra fonte);
//   B. exibe os números reais devolvidos pelo servidor;
//   C. lista produtos e tickets recebidos;
//   D. mostra estado vazio honesto quando o cliente não tem histórico;
//   E. erro do servidor vira mensagem — a tela não engole a falha.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Customer360Page from './Customer360Page';
import { api, ApiError } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
    }
  },
  downloadFile: vi.fn(),
}));

const apiGet = vi.mocked(api.get);

const BASE = {
  cliente: { id: 7, nome: 'Maria Souza', email: 'maria@x.invalid', telefone: null, tipo: 'pf' },
  metricas: {
    cliente_id: 7, receita_total: 1500, pedidos: 3, ticket_medio: 500,
    primeira_compra: '2025-01-10T00:00:00.000Z', ultima_compra: '2026-02-01T00:00:00.000Z',
    recencia_dias: 12, frequencia: 3, ltv: 1500, devolucoes: 1, tickets: 1,
  },
  produtos: [{ produto_id: 1, nome: 'Camisa Azul', categoria: 'Camisas', quantidade: 4, receita: 1200 }],
  devolucoes: [{ id: 5, numero: 'DEV-1', status: 'autorizada', motivo: 'Tamanho', criado_em: '2026-01-20T00:00:00.000Z' }],
  tickets: [{ id: 9, numero: 'TKT-000001', assunto: 'Peça com defeito', status: 'aberto', prioridade: 'alta', canal: 'whatsapp', criado_em: '2026-01-25T00:00:00.000Z', resolvido_em: null }],
  interacoes: [],
  canais: ['whatsapp'],
  gerado_em: '2026-02-13T00:00:00.000Z',
};

function renderPagina(id = '7') {
  return render(
    <MemoryRouter initialEntries={[`/clientes/${id}/360`]}>
      <Routes>
        <Route path="/clientes/:id/360" element={<Customer360Page />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Customer 360 — visão derivada do cliente', () => {
  it('A. busca o endpoint do cliente da rota', async () => {
    apiGet.mockResolvedValue(BASE as never);
    renderPagina('7');
    await screen.findByText(/Maria Souza/);
    expect(apiGet).toHaveBeenCalledWith('/customer360/7');
  });

  it('B. exibe os números reais devolvidos pelo servidor', async () => {
    apiGet.mockResolvedValue(BASE as never);
    renderPagina();
    await screen.findByText(/Maria Souza/);
    expect(screen.getAllByText(/1\.500,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(screen.getByText('12 dias')).toBeInTheDocument();
  });

  it('C. lista produtos e tickets recebidos', async () => {
    apiGet.mockResolvedValue(BASE as never);
    renderPagina();
    await screen.findByText('Camisa Azul');
    expect(screen.getByText('TKT-000001')).toBeInTheDocument();
    expect(screen.getByText('DEV-1')).toBeInTheDocument();
  });

  it('D. estado vazio honesto quando não há histórico', async () => {
    apiGet.mockResolvedValue({ ...BASE, produtos: [], tickets: [], devolucoes: [], canais: [] } as never);
    renderPagina();
    await screen.findByText(/Maria Souza/);
    expect(screen.getByText(/Nenhuma compra registrada/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhum ticket para este cliente/)).toBeInTheDocument();
  });

  it('E. erro do servidor vira mensagem', async () => {
    apiGet.mockRejectedValue(new ApiError(404, 'Cliente não encontrado nesta empresa.'));
    renderPagina();
    expect(await screen.findByText(/Cliente não encontrado nesta empresa/)).toBeInTheDocument();
  });
});
