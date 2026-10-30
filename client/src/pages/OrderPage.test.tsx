import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OrderPage from './OrderPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ id: '7' }), useNavigate: () => vi.fn() };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Vendedor', perfil: 'gerente' } }),
}));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  const resource = {
    key: 'vendas',
    label: 'Vendas',
    singular: 'Venda',
    labelFields: ['id'],
    ops: { create: true, update: true, delete: true },
    fields: [{ name: 'status', label: 'Status', type: 'select' as const, options: [{ value: 'aberta', label: 'Aberta' }] }],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { vendas: resource, compras: { ...resource, key: 'compras' } }, modules: [] }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

const pedido = {
  id: 7,
  status: 'aberta',
  data: '2026-10-22',
  cliente_id: null,
  representante_id: null,
  desconto: 0,
  frete: 0,
  observacoes: '',
};

const variante = {
  id: 101,
  produto_pai_id: 10,
  sku: 'CAM-VERM-G',
  nome: 'Camiseta Premium Vermelha G',
  codigo_barras: '7895550001112',
  descricao: null,
  cor: 'Vermelha',
  categoria: 'Camisetas',
  marca: 'BroBond',
  preco_venda: 95,
  ativo: true,
  variacao_tamanho_id: 4,
  estoque_disponivel: 8,
  tamanhos: [{ tamanho_id: 4, tamanho: 'G', quantidade: 8 }],
};

const pai = {
  ...variante,
  id: 10,
  produto_pai_id: null,
  sku: 'CAM-PREM',
  nome: 'Camiseta Premium',
  variacao_tamanho_id: null,
  variacoes: [variante],
};

describe('OrderPage — Smart Product Search em /vendas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation(((path: string) => {
      if (path === '/vendas/7') return Promise.resolve(pedido);
      if (path === '/vendas/7/itens') return Promise.resolve([]);
      if (path.endsWith('/options')) return Promise.resolve(path === '/tamanhos/options' ? [{ value: 4, label: 'G' }] : []);
      if (path.startsWith('/produtos/busca')) {
        return Promise.resolve({ rows: [pai], total: 1, page: 1, pageSize: 20, hasMore: false });
      }
      if (path.startsWith('/estoques/disponivel')) {
        return Promise.resolve({
          quantidade: 8,
          local_id: 3,
          local: 'Loja Matriz',
          estoque_fisico: 8,
          tamanho_id: 4,
          semantica: 'estoque_vendavel_no_local_de_saida',
        });
      }
      return Promise.reject(new Error(`rota não mockada: ${path}`));
    }) as never);
    apiPost.mockResolvedValue({});
  });

  it('seleciona variação e envia produto pai + tamanho + preço, sem pré-carregar catálogo', async () => {
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);
    const campo = await screen.findByRole('combobox', { name: 'Buscar produto da venda' });
    fireEvent.change(campo, { target: { value: 'camiseta vermelha' } });
    const opcao = await screen.findByRole('option', { name: /CAM-VERM-G/ });
    fireEvent.click(opcao);

    await screen.findByDisplayValue('95');
    await waitFor(() => expect(campo).toHaveValue('CAM-VERM-G — Camiseta Premium Vermelha G'));
    // O seletor não pré-carrega o cadastro do pai (`GET /produtos/10`): ele
    // resolve o item inteiro pela busca. A única leitura com o id do pai é a
    // disponibilidade canônica, que precisa ser por produto+tamanho.
    expect(apiGet.mock.calls.some(([path]) => String(path).split('?')[0] === '/produtos/10')).toBe(false);
    const chamadaDisponivel = apiGet.mock.calls
      .map(([path]) => String(path))
      .find((path) => path.startsWith('/estoques/disponivel'));
    expect(chamadaDisponivel).toBeDefined();
    expect(chamadaDisponivel).toContain('produto_id=10');
    expect(chamadaDisponivel).toContain('tamanho_id=4');
    expect(screen.getByDisplayValue('G')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar item' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/vendas/7/itens', {
      produto_id: 10,
      tamanho_id: 4,
      quantidade: 1,
      preco_unitario: 95,
      desconto_pct: 0,
    }));
    expect(apiGet.mock.calls.some(([path]) => String(path).includes('/produtos/options'))).toBe(false);
    expect(apiGet.mock.calls.some(([path]) => String(path).includes('/produtos?pageSize='))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Formação profissional do preço da venda
// ---------------------------------------------------------------------------

const itemDescontado = {
  id: 501,
  venda_id: 7,
  produto_id: 10,
  tamanho_id: 4,
  quantidade: 1,
  preco_unitario: 90,
  desconto_pct: 20,
  subtotal: 72,
  preco_tabela: 90,
  produto_id__label: 'CAM-VERM-G — Camiseta Premium Vermelha G',
  tamanho_id__label: 'G',
  persistido: true,
};

function mockVendaComItens(itens: unknown[]) {
  apiGet.mockImplementation(((path: string) => {
    if (path === '/vendas/7') return Promise.resolve({ ...pedido, total: 72 });
    if (path === '/vendas/7/itens') return Promise.resolve(itens);
    if (path.endsWith('/options')) return Promise.resolve([]);
    return Promise.reject(new Error(`rota não mockada: ${path}`));
  }) as never);
}

describe('OrderPage — formação profissional do preço', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPut.mockResolvedValue({});
  });

  it('mostra preço de tabela, preço de venda, desconto % e desconto R$ por linha', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);

    await screen.findByText('CAM-VERM-G — Camiseta Premium Vermelha G');
    expect(screen.getByRole('columnheader', { name: 'Preço tabela' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Preço venda' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Desc. %' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Desc. R$' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Subtotal' })).toBeInTheDocument();

    // tabela 90 · venda 90 · desc 20% · desc R$ 18 · subtotal 72
    expect(screen.getAllByText('R$ 90,00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R$ 72,00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getByText('R$ 18,00')).toBeInTheDocument();
  });

  it('resumo mostra preço bruto → desconto real → subtotal líquido → frete → total', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);

    await screen.findByText('Preço bruto da venda');
    expect(screen.getByText('Descontos concedidos')).toBeInTheDocument();
    expect(screen.getByText('Subtotal líquido')).toBeInTheDocument();
    expect(screen.getByText('Frete')).toBeInTheDocument();
    expect(screen.getByText('Total da venda')).toBeInTheDocument();
    // O desconto das linhas aparece no resumo (regressão do "Desconto − R$ 0,00").
    expect(screen.getByText('− R$ 18,00')).toBeInTheDocument();
  });

  it('editar o desconto % recalcula o desconto R$ sobre o PREÇO DE VENDA (a tabela não é base)', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);
    await screen.findByText('CAM-VERM-G — Camiseta Premium Vermelha G');

    fireEvent.click(screen.getByRole('button', { name: /Editar item CAM-VERM-G/ }));
    const campoDesc = screen.getByRole('spinbutton', { name: /Desconto percentual/ });
    fireEvent.change(campoDesc, { target: { value: '20.5' } });

    const campoVenda = screen.getByRole('textbox', { name: /Preço de venda/ }) as HTMLInputElement;
    const campoRs = screen.getByRole('textbox', { name: /Desconto em reais/ }) as HTMLInputElement;
    // O preço de venda (90) permanece: só o desconto muda. 90 × 20,5% = 18,45.
    expect(campoVenda.value).toBe('90');
    expect(campoRs.value).toBe('18.45');
  });

  it('editar o preço de venda MANTÉM o desconto atual e recalcula o desconto R$', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);
    await screen.findByText('CAM-VERM-G — Camiseta Premium Vermelha G');

    fireEvent.click(screen.getByRole('button', { name: /Editar item CAM-VERM-G/ }));
    const campoVenda = screen.getByRole('textbox', { name: /Preço de venda/ });
    fireEvent.change(campoVenda, { target: { value: '100' } });

    // O desconto (20%) é preservado; 100 × 20% = 20,00.
    expect((screen.getByRole('spinbutton', { name: /Desconto percentual/ }) as HTMLInputElement).value).toBe('20');
    expect((screen.getByRole('textbox', { name: /Desconto em reais/ }) as HTMLInputElement).value).toBe('20');
  });

  it('editar o desconto R$ recalcula o desconto % sobre o PREÇO DE VENDA', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);
    await screen.findByText('CAM-VERM-G — Camiseta Premium Vermelha G');

    fireEvent.click(screen.getByRole('button', { name: /Editar item CAM-VERM-G/ }));
    const campoRs = screen.getByRole('textbox', { name: /Desconto em reais/ });
    fireEvent.change(campoRs, { target: { value: '15' } });

    expect((screen.getByRole('textbox', { name: /Preço de venda/ }) as HTMLInputElement).value).toBe('90');
    // 15 / 90 = 16,67%.
    expect((screen.getByRole('spinbutton', { name: /Desconto percentual/ }) as HTMLInputElement).value).toBe('16.67');
  });

  it('salvar envia o PREÇO DE VENDA como base do desconto (nunca a tabela)', async () => {
    mockVendaComItens([itemDescontado]);
    render(<ToastProvider><OrderPage tipo="venda" /></ToastProvider>);
    await screen.findByText('CAM-VERM-G — Camiseta Premium Vermelha G');

    fireEvent.click(screen.getByRole('button', { name: /Editar item CAM-VERM-G/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Preço de venda/ }), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar item CAM-VERM-G/ }));

    // Gerente sem permissão explícita NÃO envia `preco_tabela`: o servidor é a
    // autoridade e recusaria a alteração da referência.
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/vendas/7/itens/501', {
        produto_id: 10,
        tamanho_id: 4,
        quantidade: 1,
        preco_unitario: 100,
        desconto_pct: 20,
      })
    );
  });
});

describe('OrderPage — aprovação de compra', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation(((path: string) => {
      if (path === '/compras/7') return Promise.resolve({ id: 7, status: 'pendente', data: '2026-10-22', frete: 0, total: 10 });
      if (path === '/compras/7/itens') return Promise.resolve([{ id: 20, insumo_id: 3, quantidade: 1, preco_unitario: 10 }]);
      if (path.endsWith('/options')) return Promise.resolve([]);
      return Promise.reject(new Error(`rota não mockada: ${path}`));
    }) as never);
    apiPost.mockResolvedValue({});
  });
  it('aprova pela rota específica e não oferece recebimento antes da aprovação', async () => {
    render(<ToastProvider><OrderPage tipo="compra" /></ToastProvider>);
    const botao = await screen.findByRole('button', { name: 'Aprovar compra' });
    expect(screen.queryByRole('button', { name: 'Receber compra' })).toBeNull();
    expect(screen.getByText(/alçada configurada para esta empresa/i)).toBeInTheDocument();
    fireEvent.click(botao);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/compras/7/aprovar', {}));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
