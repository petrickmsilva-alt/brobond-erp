// ============================================================================
// COMMERCE — FLUXO B2C DA LOJA PRÓPRIA: /loja (vitrine) → /loja/produto/:slug
// → /loja/carrinho → /loja/checkout → /loja/pedido/:token.
// Contrato de tela (1 arquivo, 5 rotas do cap loja-fluxo): dados públicos
// REAIS da API, carrinho em store próprio (sem modal), checkout que só
// navega com o token devolvido pelo BACKEND (pagamento nunca confirmado no
// frontend) e ZERO MODAL em todo o fluxo.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import LojaInicioPage from './loja/LojaInicioPage';
import LojaProdutoPage from './loja/LojaProdutoPage';
import LojaCarrinhoPage from './loja/LojaCarrinhoPage';
import LojaCheckoutPage from './loja/LojaCheckoutPage';
import LojaPedidoPage from './loja/LojaPedidoPage';
import { adicionarAoCarrinho, limparCarrinho } from './loja/carinho';

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

describe('Loja — Checkout (/loja/checkout)', () => {
  it('POST /loja/checkout → navega só com o token do BACKEND (/loja/pedido/:token)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (caminho.startsWith('/loja/config')) return CONFIG;
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
    // espera a config carregar (frete manual exige endereço) e preenche o formulário
    const cep = (await screen.findByPlaceholderText('00000-000')) as HTMLInputElement;
    await waitFor(() => expect(cep.required).toBe(true));
    const nome = document.querySelector<HTMLInputElement>('input[autocomplete="name"]')!;
    const email = document.querySelector<HTMLInputElement>('input[type="email"]')!;
    fireEvent.change(nome, { target: { value: 'Maria Silva' } });
    fireEvent.change(email, { target: { value: 'maria@example.com' } });
    fireEvent.change(cep, { target: { value: '74000-000' } });
    const obrigatorios = Array.from(document.querySelectorAll<HTMLInputElement>('input[required]')).filter(
      (i) => i !== nome && i !== email && i !== cep
    );
    const valores = ['Rua das Flores', '10', 'Centro', 'Goiânia', 'GO'];
    obrigatorios.forEach((input, idx) => fireEvent.change(input, { target: { value: valores[idx] ?? 'Goiânia' } }));
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).toBeTruthy();
    await user.click(submit!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/loja/checkout', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('rota-pedido-token')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
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
