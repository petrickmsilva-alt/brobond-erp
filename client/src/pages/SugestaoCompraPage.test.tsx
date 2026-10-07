// ============================================================================
// SUGESTÃO DE COMPRA — contrato de tela (§17)
//
// A regra que estes testes existem para proteger: **a sugestão é um cálculo.**
// Nada cria pedido sozinho. A tela tem que dizer isso, e o pedido só nasce de
// um POST explícito com fornecedor escolhido e quantidade revisada.
//
// Cobre também: o pedido entra como pendente (não recebido), a quantidade pode
// ser revisada para baixo, e item com quantidade zero não embarca.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SugestaoCompraPage from './SugestaoCompraPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

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

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const SUGESTAO = {
  empresa_id: 1,
  periodo_consumo_dias: 90,
  automatico: false,
  total_itens: 2,
  total_unidades: 30,
  custo_estimado: 1500,
  por_fornecedor: [
    { fornecedor_id: 11, itens: 2, unidades: 30, custo: 1500 },
  ],
  itens: [
    {
      produto_id: 1,
      sku: 'BOTA-1',
      nome: 'Bota Country',
      estoque_atual: 2,
      estoque_min: 10,
      estoque_max: 40,
      consumo_medio_mensal: 8,
      em_pedidos_venda: 3,
      em_compras_transito: 0,
      disponivel_projetado: -1,
      sugerido: 20,
      fornecedor_id: 11,
      codigo_fornecedor: 'F-100',
      custo_unitario: 50,
      custo_total: 1000,
      motivo: 'estoque abaixo do mínimo',
    },
    {
      produto_id: 2,
      sku: 'CINTO-1',
      nome: 'Cinto Couro',
      estoque_atual: 0,
      estoque_min: 5,
      estoque_max: 20,
      consumo_medio_mensal: 4,
      em_pedidos_venda: 0,
      em_compras_transito: 0,
      disponivel_projetado: 0,
      sugerido: 10,
      fornecedor_id: 11,
      codigo_fornecedor: null,
      custo_unitario: 50,
      custo_total: 500,
      motivo: 'estoque zerado',
    },
  ],
};

const FORNECEDORES = {
  rows: [
    { id: 11, nome: 'Couro Nobre Ltda' },
    { id: 12, nome: 'Solados Sul' },
  ],
  total: 2,
  page: 1,
  pageSize: 200,
};

/** Casa pelo prefixo mais específico — `/fornecedores` não pode engolir o resto. */
function mockRotas(rotas: Record<string, unknown>) {
  const chaves = Object.keys(rotas).sort((a, b) => b.length - a.length);
  apiGet.mockImplementation(((path: string) => {
    for (const chave of chaves) {
      if (path.startsWith(chave)) return Promise.resolve(rotas[chave]);
    }
    return Promise.reject(new Error(`rota não mockada: ${path}`));
  }) as never);
}

function renderPage() {
  return render(
    <ToastProvider>
      <SugestaoCompraPage />
    </ToastProvider>
  );
}

describe('Sugestão de compra — tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declara na tela que o cálculo NÃO é automático', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/fornecedores': FORNECEDORES });
    renderPage();

    expect(await screen.findByText('Bota Country')).toBeInTheDocument();
    expect(screen.getByText(/Isto é um cálculo/)).toBeInTheDocument();
    expect(screen.getByText(/automático: não/)).toBeInTheDocument();
    expect(screen.getByText(/Nada vira pedido sem você confirmar/)).toBeInTheDocument();
    // Nenhum POST foi feito só de abrir a tela — a sugestão não cria nada.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('mostra a base do cálculo: atual, mínimo, em venda e em trânsito', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/fornecedores': FORNECEDORES });
    renderPage();
    await screen.findByText('Bota Country');

    // Linha da Bota: atual 2, mínimo 10, em venda 3, em trânsito 0.
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('estoque abaixo do mínimo')).toBeInTheDocument();
    expect(screen.getByText('estoque zerado')).toBeInTheDocument();
    // Aparece na linha, no select e no painel "Por fornecedor".
    expect(screen.getAllByText(/Couro Nobre Ltda/).length).toBeGreaterThanOrEqual(3);
  });

  it('revisar a quantidade para baixo recalcula o custo e o total enviado', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/fornecedores': FORNECEDORES });
    renderPage();
    await screen.findByText('Bota Country');

    // Custo inicial: 20*50 + 10*50 = 1500.
    expect(screen.getByText('R$ 1.500,00')).toBeInTheDocument();

    const campoBota = screen.getByDisplayValue('20');
    fireEvent.change(campoBota, { target: { value: '5' } });

    // 5*50 + 10*50 = 750.
    expect(await screen.findByText('R$ 750,00')).toBeInTheDocument();
    expect(screen.getByText(/sugerido 20/)).toBeInTheDocument();
  });

  it('criar pedido exige fornecedor e envia só itens com quantidade > 0', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/fornecedores': FORNECEDORES });
    apiPost.mockResolvedValue({ id: 77, total: 750, status: 'pendente' } as never);
    renderPage();
    await screen.findByText('Bota Country');

    // Sem fornecedor o botão fica desabilitado.
    expect((screen.getByText(/Criar pedido \(2 itens\)/) as HTMLButtonElement).disabled).toBe(true);

    // Zera a bota — ela não pode embarcar.
    fireEvent.change(screen.getByDisplayValue('20'), { target: { value: '0' } });

    fireEvent.change(await screen.findByLabelText('Fornecedor'), { target: { value: '11' } });

    fireEvent.click(await screen.findByText(/Criar pedido/));

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [rota, corpo] = apiPost.mock.calls[0] as [string, { fornecedor_id: number; itens: Array<{ produto_id: number; quantidade: number }> }];
    expect(rota).toBe('/suprimentos/sugestao-compra/gerar');
    expect(corpo.fornecedor_id).toBe(11);
    expect(corpo.itens).toEqual([{ produto_id: 2, quantidade: 10 }]);
  });

  it('o pedido criado é anunciado como PENDENTE — não como recebido', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/fornecedores': FORNECEDORES });
    apiPost.mockResolvedValue({ id: 77, total: 1500 } as never);
    renderPage();
    await screen.findByText('Bota Country');

    fireEvent.change(await screen.findByLabelText('Fornecedor'), { target: { value: '11' } });
    fireEvent.click(await screen.findByText(/Criar pedido/));

    expect((await screen.findAllByText(/#77/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pendente/).length).toBeGreaterThan(0);
    expect(screen.getByText(/precisa de aprovação antes de qualquer recebimento/)).toBeInTheDocument();
  });

  it('sem produto abaixo do mínimo, diz que não há o que comprar', async () => {
    mockRotas({
      '/suprimentos/sugestao-compra?dias=90': { ...SUGESTAO, total_itens: 0, total_unidades: 0, custo_estimado: 0, itens: [], por_fornecedor: [] },
      '/fornecedores': FORNECEDORES,
    });
    renderPage();

    expect(await screen.findByText('Nada a comprar')).toBeInTheDocument();
    expect(screen.getByText(/Produtos sem estoque_min não entram no cálculo/)).toBeInTheDocument();
  });

  it('mudar o período de consumo recalcula no servidor', async () => {
    mockRotas({ '/suprimentos/sugestao-compra?dias=90': SUGESTAO, '/suprimentos/sugestao-compra?dias=30': SUGESTAO, '/fornecedores': FORNECEDORES });
    renderPage();
    await screen.findByText('Bota Country');

    fireEvent.change(screen.getByLabelText('Consumo'), { target: { value: '30' } });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/suprimentos/sugestao-compra?dias=30'));
  });
});
