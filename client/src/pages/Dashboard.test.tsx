// ============================================================================
// Dashboard — estoque valorizado em três bases.
//
// Motivo: o antigo cartão "Valor do estoque" (só a custo) saiu; no lugar entram
// três leituras do mesmo saldo — custo de produção, atacado e varejo — em três
// níveis (por unidade, por coleção e todas as peças). Os testes travam esse
// contrato de tela.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import * as AuthContext from '../auth/AuthContext';
import { api } from '../lib/api';

vi.mock('../auth/AuthContext', async () => {
  const actual = await vi.importActual<typeof AuthContext>('../auth/AuthContext');
  return { ...actual, useAuth: vi.fn() };
});

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {},
  downloadFile: vi.fn(),
}));

const useAuthMock = vi.mocked(AuthContext.useAuth);
const apiGet = vi.mocked(api.get);

const DASHBOARD = {
  valorEstoque: 522.5,
  pecasEstoque: 17,
  valorizacao: {
    pecas: 17,
    custo: 522.5,
    atacado: 1000,
    varejo: 1310,
    produtosComSaldo: 3,
    semPrecoAtacado: 1,
    colecoes: [
      { colecao: 'Verão 2026', pecas: 15, custo: 502.5, atacado: 950, varejo: 1250 },
      { colecao: 'Sem coleção', pecas: 2, custo: 20, atacado: 50, varejo: 60 },
    ],
    produtos: [
      { id: 1, produto: 'CAM-001 — Camisa Polo', colecao: 'Verão 2026', pecas: 10, custo_unit: 40, atacado_unit: 70, varejo_unit: 100, atacado_definido: true, custo: 400, atacado: 700, varejo: 1000 },
      { id: 2, produto: 'BER-002 — Bermuda Sarja', colecao: 'Verão 2026', pecas: 5, custo_unit: 20.5, atacado_unit: 50, varejo_unit: 50, atacado_definido: false, custo: 102.5, atacado: 250, varejo: 250 },
      { id: 3, produto: 'ACE-003 — Boné', colecao: null, pecas: 2, custo_unit: 10, atacado_unit: 25, varejo_unit: 30, atacado_definido: true, custo: 20, atacado: 50, varejo: 60 },
    ],
  },
  itensAlerta: 0,
  producao: 0,
  vendasAbertas: 0,
  comprasPendentes: 0,
  vendasMes: 0,
  comissoesPagar: 0,
  vendasPorMes: [],
  alertas: [],
  insumosAlerta: [],
  ordens: [],
  totais: { produtos: 3, clientes: 0, fornecedores: 0, insumos: 0 },
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

describe('Dashboard — estoque valorizado', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
    apiGet.mockReset();
    useAuthMock.mockReturnValue({ user: { id: 1, name: 'Ana Silva', perfil: 'operador' }, loading: false } as unknown as ReturnType<typeof AuthContext.useAuth>);
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/dashboard') return DASHBOARD as never;
      throw new Error(`GET inesperado: ${url}`);
    });
  });

  it('troca o cartão "Valor do estoque" pelos três custos (produção, atacado, varejo)', async () => {
    renderDashboard();
    expect(await screen.findByText('Custo de produção')).toBeInTheDocument();
    expect(screen.getByText('Custo no atacado')).toBeInTheDocument();
    expect(screen.getByText('Custo no varejo')).toBeInTheDocument();
    expect(screen.queryByText('Valor do estoque')).not.toBeInTheDocument();

    expect(within(screen.getByTestId('kpi-custo')).getByText('R$ 522,50')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-atacado')).getByText('R$ 1.000,00')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-varejo')).getByText('R$ 1.310,00')).toBeInTheDocument();
    // Aviso de produtos valorizados pelo varejo por falta de preço de atacado
    expect(within(screen.getByTestId('kpi-atacado')).getByText(/1 produto\(s\) sem preço de atacado/)).toBeInTheDocument();
  });

  it('mostra os três níveis: por coleção (padrão), por unidade e todas as peças', async () => {
    const user = userEvent.setup();
    renderDashboard();
    const painel = await screen.findByTestId('valorizacao');

    // Por coleção (padrão): linha da coleção com peças e as três bases
    const linhaVerao = within(painel).getByText('Verão 2026').closest('tr')!;
    expect(within(linhaVerao).getByText('15')).toBeInTheDocument();
    expect(within(linhaVerao).getByText('R$ 502,50')).toBeInTheDocument();
    expect(within(linhaVerao).getByText('R$ 950,00')).toBeInTheDocument();
    expect(within(linhaVerao).getByText('R$ 1.250,00')).toBeInTheDocument();
    expect(within(painel).getByText('Sem coleção')).toBeInTheDocument();

    // Por unidade: custo da unidade + total das peças do produto, com link para o produto
    await user.click(within(painel).getByRole('tab', { name: 'Por unidade' }));
    const linhaPolo = within(painel).getByText('CAM-001 — Camisa Polo').closest('tr')!;
    expect(within(linhaPolo).getByText('R$ 40,00')).toBeInTheDocument(); // custo unitário
    expect(within(linhaPolo).getByText('R$ 70,00')).toBeInTheDocument(); // atacado unitário
    expect(within(linhaPolo).getByText('R$ 100,00')).toBeInTheDocument(); // varejo unitário
    expect(within(linhaPolo).getByText('R$ 400,00')).toBeInTheDocument(); // 10 peças a custo
    expect(within(linhaPolo).getByRole('link', { name: 'CAM-001 — Camisa Polo' })).toHaveAttribute('href', '/produtos/1');
    // Produto sem atacado cadastrado é marcado
    const linhaBermuda = within(painel).getByText('BER-002 — Bermuda Sarja').closest('tr')!;
    expect(within(linhaBermuda).getByText('*')).toBeInTheDocument();

    // Busca filtra a lista por unidade
    await user.type(within(painel).getByLabelText('Buscar produto'), 'boné');
    expect(within(painel).getByText('ACE-003 — Boné')).toBeInTheDocument();
    expect(within(painel).queryByText('CAM-001 — Camisa Polo')).not.toBeInTheDocument();

    // Todas as peças: um total por base
    await user.click(within(painel).getByRole('tab', { name: 'Todas as peças' }));
    expect(within(painel).getByText('Custo de todas as peças · Produção')).toBeInTheDocument();
    expect(within(painel).getByText('R$ 522,50')).toBeInTheDocument();
    expect(within(painel).getByText('R$ 1.000,00')).toBeInTheDocument();
    expect(within(painel).getByText('R$ 1.310,00')).toBeInTheDocument();
  });

  it('sem peças em estoque, avisa em vez de mostrar tabela vazia', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/dashboard') return { ...DASHBOARD, pecasEstoque: 0, valorizacao: { ...DASHBOARD.valorizacao, pecas: 0, custo: 0, atacado: 0, varejo: 0, produtosComSaldo: 0, semPrecoAtacado: 0, colecoes: [], produtos: [] } } as never;
      throw new Error(`GET inesperado: ${url}`);
    });
    renderDashboard();
    expect(await screen.findByText('Nenhuma peça em estoque para valorizar.')).toBeInTheDocument();
  });
});
