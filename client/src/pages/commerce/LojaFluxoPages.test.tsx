// ============================================================================
// COMMERCE — FLUXO B2C DA LOJA PRÓPRIA: /loja (vitrine) → /loja/produto/:slug
// → /loja/carrinho → /loja/checkout → /loja/pedido/:token.
// Contrato de tela (1 arquivo, 5 rotas do cap loja-fluxo): dados públicos
// REAIS da API, carrinho em store próprio (sem modal), checkout que só
// navega com o token devolvido pelo BACKEND (pagamento nunca confirmado no
// frontend) e ZERO MODAL em todo o fluxo.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import LojaInicioPage, { semRepeticaoEntreSecoes } from './loja/LojaInicioPage';
import LojaProdutoPage from './loja/LojaProdutoPage';
import LojaCarrinhoPage from './loja/LojaCarrinhoPage';
import LojaCheckoutPage from './loja/LojaCheckoutPage';
import LojaPedidoPage from './loja/LojaPedidoPage';
import { adicionarAoCarrinho, alterarQuantidade, definirCupom, lerCarrinho, limparCarrinho } from './loja/carinho';

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

const CONFIG = {
  loja_nome: 'BROBOND Store',
  loja_descricao: 'Vitrine oficial BROBOND',
  frete: { provedor: 'manual', valor: 20, gratis_acima: 300, prazo_dias: 5, disponivel: true },
  checkout_expira_minutos: 60,
};

const PREVIEW = {
  itens: [{ produto_id: 7, tamanho_id: null, quantidade: 1, nome: 'Camiseta Brobond', sku: 'CAM-001', preco_unitario: 89.9, preco_original: null, disponivel: 8, subtotal: 89.9, ok: true }],
  subtotal: 89.9, cupom: null, promocao: null, frete: { disponivel: true, provedor: 'manual', valor: 20, gratis: false, prazoDias: 5 },
  desconto: 0, desconto_origem: null, totais: { subtotal: 89.9, desconto: 0, frete: 20, total: 109.9 }, frete_indisponivel: false,
};

const PRODUTO = {
  empresa_id: 1,
  produto: {
    id: 7,
    sku: 'CAM-001',
    slug: 'camiseta-brobond',
    nome: 'Camiseta Brobond',
    resumo: 'Malha penteada',
    descricao: 'Camiseta oficial da marca.',
    destaque: true,
    preco: 89.9,
    preco_original: null,
    promocional: false,
    foto_url: null,
    fotos: [],
  },
  tamanhos: [{ tamanho_id: null, codigo: 'Único', fisico: 10, disponivel: 8, local: 'loja', esgotado: false }],
};

function montar(rota: string, rotas: React.ReactNode) {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={[rota]}>{rotas}</MemoryRouter>
    </ToastProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  limparCarrinho();
  localStorage.removeItem('brobond-loja-checkout-pendente');
});

describe('Loja — Vitrine (/loja)', () => {
  it('exibe os produtos PÚBLICOS publicados (nada de mock/fake) e link por slug', async () => {
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      return {
        total: 1,
        produtos: [{ id: 7, sku: 'CAM-001', slug: 'camiseta-brobond', nome: 'Camiseta Brobond', resumo: 'Malha penteada', destaque: true, preco: 89.9, preco_original: null, promocional: false }],
      };
    });
    render(montar('/loja', <Routes><Route path="/loja" element={<LojaInicioPage />} /></Routes>));
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /camiseta brobond/i });
    expect(link).toHaveAttribute('href', '/loja/produto/camiseta-brobond');
    expect(screen.getByLabelText(/carrinho com 0 item/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira estado honesto (sem vitrine fictícia)', async () => {
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      throw new ApiError(503, 'Loja fora do ar.');
    });
    render(montar('/loja', <Routes><Route path="/loja" element={<LojaInicioPage />} /></Routes>));
    expect(await screen.findByText('Loja fora do ar.')).toBeInTheDocument();
    expect(screen.queryByText('Camiseta Brobond')).toBeNull();
  });
});

describe('Loja — Página de produto (/loja/produto/:slug)', () => {
  it('detalhe público + “Adicionar ao carrinho” atualiza o badge SEM modal', async () => {
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      return PRODUTO;
    });
    const user = userEvent.setup();
    render(
      montar(
        '/loja/produto/camiseta-brobond',
        <Routes>
          <Route path="/loja/produto/:slug" element={<LojaProdutoPage />} />
        </Routes>
      )
    );
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText('R$ 89,90')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /adicionar ao carrinho/i }));
    expect(await screen.findByLabelText(/carrinho com 1 item/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('desabilita somente G com saldo zero e mantém M selecionável', async () => {
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      return {
        ...PRODUTO,
        tamanhos: [
          { tamanho_id: 2, codigo: 'M', fisico: 8, disponivel: 7, local: 'loja', esgotado: false },
          { tamanho_id: 3, codigo: 'G', fisico: 0, disponivel: 0, local: null, esgotado: true },
        ],
      };
    });
    render(montar('/loja/produto/camiseta-brobond', <Routes><Route path="/loja/produto/:slug" element={<LojaProdutoPage />} /></Routes>));
    expect(await screen.findByRole('button', { name: 'M' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'G' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /adicionar ao carrinho/i })).toBeDisabled();
  });
});

describe('Loja — Carrinho (/loja/carrinho)', () => {
  it('mostra o item do store, o resumo com frete real da config e avança por ROTA', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2 });
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      if (caminho === '/loja/preview' && init?.method === 'POST') {
        return {
          itens: [{ produto_id: 7, tamanho_id: null, quantidade: 2, nome: 'Camiseta Brobond', sku: 'CAM-001', preco_unitario: 89.9, preco_original: null, disponivel: 8, subtotal: 179.8, ok: true }],
          subtotal: 179.8,
          cupom: null,
          promocao: null,
          frete: { disponivel: true, provedor: 'manual', valor: 20, gratis: false, prazoDias: 5 },
          desconto: 0,
          desconto_origem: null,
          totais: { subtotal: 179.8, desconto: 0, frete: 20, total: 199.8 },
          frete_indisponivel: false,
        };
      }
      return CONFIG;
    });
    const user = userEvent.setup();
    render(
      montar(
        '/loja/carrinho',
        <Routes>
          <Route path="/loja/carrinho" element={<LojaCarrinhoPage />} />
          <Route path="/loja/checkout" element={<div>rota-checkout</div>} />
        </Routes>
      )
    );
    expect(await screen.findByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText(/199,80/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    const avancar = screen.getAllByRole('button').find((b) => /checkout|finalizar|continuar/i.test(b.textContent ?? ''));
    expect(avancar).toBeTruthy();
    await user.click(avancar!);
    expect(await screen.findByText('rota-checkout')).toBeInTheDocument();
  });

  it('frete não configurado aparece como “Frete não configurado” honesto', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return { ...CONFIG, frete: { provedor: 'nenhum', valor: 0, gratis_acima: null, prazo_dias: null, disponivel: false, motivo: 'Frete não configurado' } };
      if (caminho === '/loja/preview' && init?.method === 'POST') {
        return {
          itens: [{ produto_id: 7, tamanho_id: null, quantidade: 1, nome: 'Camiseta Brobond', sku: 'CAM-001', preco_unitario: 89.9, preco_original: null, disponivel: 8, subtotal: 89.9, ok: true }],
          subtotal: 89.9,
          cupom: null,
          promocao: null,
          frete: { disponivel: false, provedor: 'nenhum', motivo: 'Frete não configurado' },
          desconto: 0,
          desconto_origem: null,
          totais: { subtotal: 89.9, desconto: 0, frete: 0, total: 89.9 },
          frete_indisponivel: true,
          frete_motivo: 'Frete não configurado',
        };
      }
      return CONFIG;
    });
    render(
      montar(
        '/loja/carrinho',
        <Routes>
          <Route path="/loja/carrinho" element={<LojaCarrinhoPage />} />
        </Routes>
      )
    );
    expect((await screen.findAllByText(/frete não configurado/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Loja — revalidação concorrente do carrinho', () => {
  it('resposta atrasada não substitui os totais da quantidade mais recente', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    let antiga!: (value: typeof PREVIEW) => void;
    let consultas = 0;
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/loja/config') return CONFIG;
      consultas++;
      if (consultas === 1) return new Promise((resolve) => { antiga = resolve; });
      return { ...PREVIEW, itens: [{ ...PREVIEW.itens[0], quantidade: 2, subtotal: 179.8 }], totais: { ...PREVIEW.totais, subtotal: 179.8, total: 199.8 } };
    });
    render(montar('/loja/carrinho', <Routes><Route path="/loja/carrinho" element={<LojaCarrinhoPage />} /></Routes>));
    await waitFor(() => expect(consultas).toBe(1));
    act(() => alterarQuantidade(7, null, 2));
    expect(await screen.findByText('R$ 199,80')).toBeInTheDocument();
    await act(async () => { antiga(PREVIEW); });
    expect(screen.getByText('R$ 199,80')).toBeInTheDocument();
    expect(screen.queryByText('R$ 109,90')).toBeNull();
  });
});

async function preencherDados(user: ReturnType<typeof userEvent.setup>, nome = 'Maria Silva') {
  await user.type(document.querySelector<HTMLInputElement>('input[autocomplete="name"]')!, nome);
  await user.type(document.querySelector<HTMLInputElement>('input[type="email"]')!, 'maria@example.com');
  await user.type(screen.getByPlaceholderText('(00) 00000-0000'), '62999990000');
  await user.type(screen.getByPlaceholderText('000.000.000-00'), '12345678909');
}

describe('Loja — Checkout (/loja/checkout)', () => {
  it('POST /loja/checkout → navega só com o token do BACKEND (/loja/pedido/:token)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    definirCupom('OFERTA-TESTE');
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      if (caminho === '/loja/preview') return { ...PREVIEW, cupom: { codigo: 'OFERTA-TESTE', valido: true, aplicado: true, desconto: 10 }, totais: { ...PREVIEW.totais, desconto: 10, total: 99.9 } };
      if (caminho === '/loja/checkout' && init?.method === 'POST') {
        return {
          ok: true,
          sale_id: 'SAL3f00d0000000000000001',
          pedido: { pedido_externo: 'CHK-2026-001', estado: 'AGUARDANDO_PAGAMENTO', total: 109.9, expira_em: '2026-10-28T13:00:00Z', checkout_token: 'tok-publico-123' },
          pagamento: { status: 'PENDING', provider: 'mercadopago', qr_code: null, copia_cola: null, expira_em: null },
          itens: [],
        };
      }
      return CONFIG;
    });
    const user = userEvent.setup();
    render(
      montar(
        '/loja/checkout',
        <Routes>
          <Route path="/loja/checkout" element={<LojaCheckoutPage />} />
          <Route path="/loja/pedido/:token" element={<div>rota-pedido-token</div>} />
          <Route path="/loja/carrinho" element={<div>rota-carrinho</div>} />
        </Routes>
      )
    );
    // Etapa 1 — dados
    await screen.findByRole('button', { name: 'Continuar para entrega' });
    await preencherDados(user);
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    // Etapa 2 — entrega por tabela: endereço obrigatório (frete manual)
    const cep = (await screen.findByPlaceholderText('00000-000')) as HTMLInputElement;
    await waitFor(() => expect(cep.required).toBe(true));
    await user.type(cep, '74000-000');
    await user.type(screen.getByLabelText('Rua *'), 'Rua das Flores');
    await user.type(screen.getByLabelText('Número *'), '10');
    await user.type(screen.getByLabelText('Bairro *'), 'Centro');
    await user.type(screen.getByLabelText('Cidade *'), 'Goiânia');
    await user.type(screen.getByLabelText('UF *'), 'GO');
    await user.click(screen.getByRole('button', { name: 'Continuar para pagamento' }));
    // Etapa 3 — pagamento; Etapa 4 — revisão
    await user.click(await screen.findByRole('button', { name: 'Continuar para revisão' }));
    const confirmar = await screen.findByRole('button', { name: 'Confirmar pedido e pagar' });
    await waitFor(() => expect(confirmar).toBeEnabled());
    expect(fetchMock).not.toHaveBeenCalledWith('/loja/checkout', expect.objectContaining({ method: 'POST' }));
    await user.click(confirmar);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/loja/checkout', expect.objectContaining({ method: 'POST' })));
    expect(fetchMock).toHaveBeenCalledWith('/loja/checkout', expect.objectContaining({ body: expect.stringContaining('"cupom":"OFERTA-TESTE"') }));
    expect(await screen.findByText('rota-pedido-token')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('timeout após o POST recupera pela MESMA chave, sem segundo pedido, e navega com o token recuperado', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const chaveAntes = lerCarrinho().chave;
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return { ...CONFIG, frete: { ...CONFIG.frete, provedor: 'retirada', valor: 0 } };
      if (caminho === '/loja/preview') return PREVIEW;
      if (caminho === '/loja/checkout' && init?.method === 'POST') throw new ApiError(0, 'Tempo de conexão esgotado.');
      if (caminho === `/loja/checkout/${encodeURIComponent(chaveAntes)}` && !init?.method) {
        return {
          ok: true, recuperado: true, sale_id: 'SAL3f00d0000000000000001',
          pedido: { pedido_externo: 'CHK-2026-REC', estado: 'AGUARDANDO_PAGAMENTO', total: 109.9, expira_em: '2026-10-28T13:00:00Z', checkout_token: 'tok-recuperado-123' },
          pagamento: { status: 'PENDING', provider: 'mercadopago', qr_code: null, copia_cola: null, expira_em: null }, itens: [],
        };
      }
      throw new Error(`rota inesperada ${caminho}`);
    });
    const user = userEvent.setup();
    render(montar('/loja/checkout', <Routes>
      <Route path="/loja/checkout" element={<LojaCheckoutPage />} />
      <Route path="/loja/pedido/:token" element={<div>rota-pedido-recuperado</div>} />
    </Routes>));
    await screen.findByRole('button', { name: 'Continuar para entrega' });
    await preencherDados(user);
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para pagamento' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para revisão' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar pedido e pagar' }));
    expect(await screen.findByText('rota-pedido-recuperado')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/loja/checkout' && (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(`/loja/checkout/${encodeURIComponent(chaveAntes)}`);
    expect(localStorage.getItem('brobond-loja-checkout-pendente')).toBeNull();
  });

  it('não confirma sem passar pelas etapas: Dados não tem botão de confirmação e não avança com campos vazios', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    fetchMock.mockImplementation(async (path: string) => path === '/loja/preview' ? PREVIEW : CONFIG);
    const user = userEvent.setup();
    render(montar('/loja/checkout', <Routes><Route path="/loja/checkout" element={<LojaCheckoutPage />} /></Routes>));
    await screen.findByRole('button', { name: 'Continuar para entrega' });
    expect(screen.queryByRole('button', { name: 'Confirmar pedido e pagar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    // campos obrigatórios vazios: continua na etapa Dados
    expect(screen.getByRole('button', { name: 'Continuar para entrega' })).toBeInTheDocument();
    expect(screen.queryByText('Retirada na loja — frete grátis, sem entrega no endereço.')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith('/loja/checkout', expect.anything());
  });

  it('acesso direto com frete indisponível não permite confirmar pedido', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path: string) => path === '/loja/preview'
      ? { ...PREVIEW, frete_indisponivel: true }
      : { ...CONFIG, frete: { ...CONFIG.frete, provedor: 'retirada', valor: 0, disponivel: false } });
    render(montar('/loja/checkout', <Routes><Route path="/loja/checkout" element={<LojaCheckoutPage />} /></Routes>));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    await preencherDados(user);
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para pagamento' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para revisão' }));
    expect(await screen.findByRole('button', { name: 'Confirmar pedido e pagar' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith('/loja/checkout', expect.anything());
  });

  it('retirada não oferece entrega gratuita no endereço nem exige endereço', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    definirCupom('PROMO');
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (path: string) => path === '/loja/preview'
      ? { ...PREVIEW, cupom: { codigo: 'PROMO', valido: true, aplicado: true, desconto: 10 }, totais: { ...PREVIEW.totais, desconto: 10, frete: 0, total: 79.9 } }
      : { ...CONFIG, frete: { ...CONFIG.frete, provedor: 'retirada', valor: 0 } });
    render(montar('/loja/checkout', <Routes><Route path="/loja/checkout" element={<LojaCheckoutPage />} /></Routes>));
    // A única opção marcável no Dados é o consentimento de MARKETING (separado e opcional).
    expect(await screen.findByRole('checkbox', { name: /novidades e ofertas da brobond/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/entrega grátis/i)).toBeNull();
    await preencherDados(user);
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    expect(await screen.findByText('Retirada na loja — frete grátis, sem entrega no endereço.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('00000-000')).toBeNull();
    expect(screen.getByText('R$ 79,90')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/loja/preview', expect.objectContaining({ body: expect.stringContaining('"cupom":"PROMO"') }));
  });

  it('performance: UMA requisição de /loja/config no fluxo (LojaShell + página compartilham o store)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      if (caminho === '/loja/preview') return PREVIEW;
      throw new Error(`rota inesperada ${caminho}`);
    });
    render(montar('/loja/checkout', <Routes><Route path="/loja/checkout" element={<LojaCheckoutPage />} /></Routes>));
    await screen.findByRole('button', { name: 'Continuar para entrega' });
    const configs = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/loja/config'));
    expect(configs).toHaveLength(1);
    // A cotação é a única outra chamada: sem waterfall de config duplicado.
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/loja/preview')).toHaveLength(1);
  });

  it('erro do servidor no pagamento mostra a mensagem, preserva o carrinho e NÃO renova a chave (evita cobrança duplicada)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const chaveAntes = lerCarrinho().chave;
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return { ...CONFIG, frete: { ...CONFIG.frete, provedor: 'retirada', valor: 0 } };
      if (caminho === '/loja/preview') return PREVIEW;
      if (caminho === '/loja/checkout' && init?.method === 'POST') {
        throw new ApiError(502, 'Não foi possível gerar o PIX neste momento. Seu pedido não foi confirmado. Tente novamente.');
      }
      return CONFIG;
    });
    render(montar('/loja/checkout', <Routes><Route path="/loja/checkout" element={<LojaCheckoutPage />} /><Route path="/loja/carrinho" element={<div>rota-carrinho</div>} /></Routes>));
    await screen.findByRole('button', { name: 'Continuar para entrega' });
    await preencherDados(user);
    await user.click(screen.getByRole('button', { name: 'Continuar para entrega' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para pagamento' }));
    await user.click(await screen.findByRole('button', { name: 'Continuar para revisão' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmar pedido e pagar' }));
    expect(await screen.findByText(/Não foi possível gerar o PIX neste momento/)).toBeInTheDocument();
    expect(lerCarrinho().itens).toHaveLength(1);
    expect(lerCarrinho().chave).toBe(chaveAntes);
    expect(screen.queryByText('rota-carrinho')).toBeNull();
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/loja/checkout')).toHaveLength(1);
  });

  it('carrinho vazio redireciona para /loja/carrinho (replace) — sem tela fantasma', async () => {
    fetchMock.mockResolvedValue(CONFIG);
    render(
      montar(
        '/loja/checkout',
        <Routes>
          <Route path="/loja/checkout" element={<LojaCheckoutPage />} />
          <Route path="/loja/carrinho" element={<div>rota-carrinho</div>} />
        </Routes>
      )
    );
    expect(await screen.findByText('rota-carrinho')).toBeInTheDocument();
  });
});

describe('Loja — Acompanhamento (/loja/pedido/:token)', () => {
  it('exibe estado, totais, itens e timeline devolvidos pelo token público', async () => {
    fetchMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
      return {
        sale_id: 'SAL3f00d0000000000000001',
        pedido: { pedido_externo: 'CHK-2026-001', estado: 'PAGO', estado_rotulo: 'Pago', total: 109.9, frete: 20, desconto: 0, cupom: null, expira_em: null, pago_em: '2026-10-28T12:10:00Z', convertido_em: null, criado_em: '2026-10-28T12:00:00Z', checkout_token: 'tok-publico-123' },
        pagamento: { status: 'APPROVED', provider: 'mercadopago', valor: 109.9, qr_code: null, copia_cola: null, expira_em: null },
        venda: null,
        itens: [{ produto_id: 7, produto: 'Camiseta Brobond', tamanho: 'Único', quantidade: 1, preco_unitario: 89.9, subtotal: 89.9 }],
        rastreio: [],
        timeline: [{ em: '2026-10-28T12:10:00Z', rotulo: 'Pagamento confirmado' }],
      };
    });
    render(
      montar(
        '/loja/pedido/tok-publico-123',
        <Routes>
          <Route path="/loja/pedido/:token" element={<LojaPedidoPage />} />
        </Routes>
      )
    );
    expect(await screen.findByText(/CHK-2026-001/)).toBeInTheDocument();
    expect(screen.getByText('Pago')).toBeInTheDocument();
    expect(screen.getByText('Camiseta Brobond')).toBeInTheDocument();
    expect(screen.getByText('Pagamento confirmado')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Loja — Home sem repetição de produto entre seções', () => {
  const p = (id: number) => ({ id, slug: `p-${id}`, nome: `Produto ${id}`, preco: 10 });
  it('um produto em Destaques, Ofertas e Novidades aparece uma vez, na seção de maior prioridade', () => {
    const [destaques, ofertas, novidades] = semRepeticaoEntreSecoes([[p(1), p(2)], [p(2), p(3)], [p(1), p(3), p(4)]]);
    expect(destaques.map((x) => x.id)).toEqual([1, 2]);
    expect(ofertas.map((x) => x.id)).toEqual([3]);
    expect(novidades.map((x) => x.id)).toEqual([4]);
  });
  it('produto único publicado continua visível (não é escondido por deduplicação)', () => {
    const [destaques, ofertas, novidades] = semRepeticaoEntreSecoes([[p(9)], [p(9)], [p(9)]]);
    expect(destaques.map((x) => x.id)).toEqual([9]);
    expect(ofertas).toEqual([]);
    expect(novidades).toEqual([]);
  });
});
