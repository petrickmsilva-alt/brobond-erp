// Meu Negócio — contratos com o motor analítico (/api/negocios/*).
// Garante: escopo sempre na empresa ativa, comparação com período anterior,
// bloqueio quando a empresa não é identificada, nova tentativa e canal.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const EMPRESA = { empresa_id: 7, empresa: 'BroBond Wear', consolidado: false, pode_consolidar: false, empresas: [] };

function resumo(faturamentoCents: number, pedidos: number, margemPct = 30) {
  return {
    filtros: {},
    kpis: {
      faturamentoCents,
      pedidos,
      ticketMedioCents: pedidos ? Math.round(faturamentoCents / pedidos) : 0,
      cmvCents: 0,
      impostosCents: 0,
      freteCents: 0,
      lucroBrutoCents: 0,
      margemPct,
      pedidosPendentes: 0,
      semMargemCalculada: 0,
    },
    porCanal: [],
    porMes: [],
    topProdutos: [],
    abc: { resumo: [], totalFaturamentoCents: 0 },
  };
}

const ABC = { resumo: [], totalFaturamentoCents: 0, linhas: [] };
const CANAIS = { grupos: [{ grupo: 'ecommerce', label: 'E-commerce', canais: [] }] };
const DASHBOARD = {
  valorEstoque: 0,
  pecasEstoque: 0,
  valorizacao: { pecas: 0, custo: 0, atacado: 0, varejo: 0, produtosComSaldo: 0, semPrecoAtacado: 0, colecoes: [], produtos: [] },
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
  totais: { produtos: 0, clientes: 0, fornecedores: 0, insumos: 0 },
};

function montarApi(overrides: Record<string, () => Promise<unknown>> = {}) {
  apiGet.mockImplementation(async (url: string) => {
    for (const [prefixo, fn] of Object.entries(overrides)) if (url.startsWith(prefixo)) return fn() as never;
    if (url === '/empresas/ativa') return EMPRESA as never;
    if (url === '/negocios/canais') return CANAIS as never;
    if (url === '/dashboard') return DASHBOARD as never;
    if (url.startsWith('/negocios/abc')) return ABC as never;
    if (url.startsWith('/negocios/resumo')) {
      // Período atual maior que o anterior: +25% em faturamento.
      return (url.includes('canal=') ? resumo(100000, 1) : resumo(100000, 2)) as never;
    }
    throw new Error(`GET inesperado: ${url}`);
  });
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

const chamadasResumo = () => apiGet.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/negocios/resumo'));

describe('Dashboard — motor analítico', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
    apiGet.mockReset();
    useAuthMock.mockReturnValue({ user: { id: 1, name: 'Petrick Silva', perfil: 'gerente' }, loading: false } as unknown as ReturnType<typeof AuthContext.useAuth>);
  });

  it('consulta o resumo sempre com a empresa ativa e com o período anterior de mesma duração', async () => {
    montarApi();
    renderDashboard();
    await screen.findByTestId('kpi-faturamento');

    const urls = chamadasResumo();
    expect(urls.length).toBe(2);
    expect(urls.every((u) => u.includes('empresa_id=7'))).toBe(true);
    expect(urls.some((u) => /de=\d{4}-\d{2}-\d{2}&ate=\d{4}-\d{2}-\d{2}/.test(u))).toBe(true);
  });

  it('mostra faturamento em reais (centavos convertidos)', async () => {
    montarApi();
    renderDashboard();
    const card = await screen.findByTestId('kpi-faturamento');
    expect(within(card).getByText('R$ 1.000,00')).toBeInTheDocument();
  });

  it('sem diferença entre períodos, mostra "estável" em vez de inventar variação', async () => {
    montarApi({ '/negocios/resumo': async () => resumo(100000, 2) });
    renderDashboard();
    const card = await screen.findByTestId('kpi-faturamento');
    expect(await within(card).findByText('estável')).toBeInTheDocument();
  });

  it('calcula a variação a partir dos dois resumos do servidor (atual 125 mil, anterior 100 mil)', async () => {
    // O painel dispara primeiro o período atual e depois o anterior.
    const respostas = [resumo(125000, 2), resumo(100000, 2)];
    montarApi({ '/negocios/resumo': async () => respostas.shift() as never });
    renderDashboard();
    const card = await screen.findByTestId('kpi-faturamento');
    expect(await within(card).findByText(/aumento de 25% em relação ao período anterior/)).toBeInTheDocument();
    expect(within(card).getByText('R$ 1.250,00')).toBeInTheDocument();
  });

  it('sem empresa identificada, não consulta indicadores comerciais e avisa', async () => {
    montarApi({
      '/empresas/ativa': async () => {
        throw new Error('Sessão inválida. Entre novamente.');
      },
    });
    renderDashboard();
    expect(await screen.findByText(/Não foi possível identificar a empresa ativa/)).toBeInTheDocument();
    expect(chamadasResumo()).toHaveLength(0);
    expect(screen.queryByTestId('kpi-faturamento')).not.toBeInTheDocument();
  });

  it('erro no resumo mostra mensagem clara e "Tentar novamente" refaz a consulta', async () => {
    let falhas = 1;
    montarApi({
      '/negocios/resumo': async () => {
        if (falhas-- > 0) throw new Error('Falha temporária ao consultar vendas.');
        return resumo(50000, 1);
      },
    });
    renderDashboard();
    expect(await screen.findByText('Não foi possível carregar os indicadores do período')).toBeInTheDocument();
    expect(screen.getByText('Falha temporária ao consultar vendas.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
    expect(await screen.findByTestId('kpi-faturamento')).toBeInTheDocument();
  });

  it('modo consolidado (perfil autorizado) não envia empresa_id', async () => {
    montarApi({
      '/empresas/ativa': async () => ({ ...EMPRESA, consolidado: true, empresa: null }) as never,
    });
    renderDashboard();
    await screen.findByTestId('kpi-faturamento');
    expect(chamadasResumo().every((u) => !u.includes('empresa_id='))).toBe(true);
  });

  it('filtro de canal é enviado ao servidor', async () => {
    const user = userEvent.setup();
    montarApi();
    renderDashboard();
    await screen.findByTestId('kpi-faturamento');
    await user.click(screen.getByRole('combobox', { name: 'Canal' }));
    await user.click(await screen.findByRole('option', { name: 'E-commerce' }));
    expect(await screen.findByText(/Comparado ao período anterior/)).toBeInTheDocument();
    expect(chamadasResumo().some((u) => u.includes('canal=ecommerce'))).toBe(true);
  });

  it('botão Atualizar refaz todas as consultas da tela', async () => {
    const user = userEvent.setup();
    montarApi();
    renderDashboard();
    await screen.findByTestId('kpi-faturamento');
    const antes = apiGet.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Recarregar todos os blocos do painel' }));
    await screen.findByTestId('kpi-faturamento');
    // 4 raízes (empresa, canais, dashboard, financeiro) + 3 comerciais que
    // reagem ao escopo (resumo atual, resumo anterior e ABC) — sem duplicadas.
    const novas = apiGet.mock.calls.slice(antes).map((c) => String(c[0]));
    expect(novas).toHaveLength(7);
    expect(new Set(novas).size).toBe(7);
  });

  it('alerta as contas a pagar e a receber que vencem hoje (listas do resumo financeiro)', async () => {
    const hoje = new Date();
    const iso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    montarApi({
      '/financeiro/resumo': async () =>
        ({
          saldoContasTotal: 0,
          aReceberVencidas: 0,
          aPagarVencidas: 0,
          aPagar30: 0,
          aReceber30: 0,
          aPagarLista: [
            { vencimento: iso, valor: 100 },
            { vencimento: '2026-01-01', valor: 50 },
          ],
          aReceberLista: [{ vencimento: iso, valor: 200 }],
        }) as never,
    });
    renderDashboard();
    expect(await screen.findByText('Contas a pagar vencem hoje')).toBeInTheDocument();
    expect(screen.getByText('Contas a receber vencem hoje')).toBeInTheDocument();
    // Só o que vence hoje entra na conta (R$ 100,00 — os R$ 50,00 de janeiro, não).
    expect(screen.getByText(/1 conta\(s\) · R\$ 100,00/)).toBeInTheDocument();
  });

  it('período personalizado com datas invertidas não dispara consulta inválida', async () => {
    montarApi();
    renderDashboard();
    await screen.findByTestId('kpi-faturamento');
    await userEvent.selectOptions(screen.getByLabelText('Período'), 'personalizado');
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-10' } });
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-10-01' } });
    expect(await screen.findByText(/Informe um intervalo válido/)).toBeInTheDocument();
  });
});
