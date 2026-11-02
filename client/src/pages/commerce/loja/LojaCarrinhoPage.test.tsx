// ============================================================================
// /loja/carrinho — regressão do bug "badge = 1, linhas = 0, totais = …".
//
// Causa raiz (código anterior): as LINHAS eram desenhadas SOMENTE a partir da
// resposta de POST /loja/preview. Qualquer falha/atraso/descarte dessa
// resposta (erro de rede, 4xx/5xx, item que saiu da vitrine → 409 do carrinho
// INTEIRO, ou o descarte por sequência) deixava o badge (lido do storage) em 1,
// zero linhas e totais "…", sem como remover o item nem tentar de novo.
// Agora linhas = storage; valores = servidor; estados explícitos.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaCarrinhoPage from './LojaCarrinhoPage';
import { adicionarAoCarrinho, alterarQuantidade, definirCupom, lerCarrinho, limparCarrinho, normalizarQuantidade } from './carinho';

vi.mock('../../../lib/api', () => ({
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

import { apiFetch, ApiError } from '../../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const CONFIG = {
  loja_nome: 'BROBOND',
  loja_descricao: null,
  frete: { provedor: 'retirada', valor: 0, gratis_acima: null, prazo_dias: null, disponivel: true },
  checkout_expira_minutos: 60,
  checkout_disponivel: true,
};

const NOME = 'COTTON "B"';
const SKU = 'CAM-BAS-PREM-VERM-"B" LOGO BRANCA';

function cotacao(qtd: number, extra: Record<string, unknown> = {}) {
  const subtotal = 80 * qtd;
  return {
    payment_methods: [{ code: 'PIX', max_installments: 1 }],
    itens: [
      { produto_id: 7, tamanho_id: null, quantidade: qtd, nome: NOME, sku: SKU, variante: null, foto_url: 'https://img.example/cotton-b.jpg', preco_unitario: 80, preco_original: null, disponivel: 8, subtotal, ok: true },
    ],
    subtotal,
    cupom: null,
    promocao: null,
    frete: { disponivel: true, provedor: 'retirada', valor: 0, gratis: true, prazoDias: null },
    desconto: 0,
    desconto_origem: null,
    totais: { subtotal, desconto: 0, frete: 0, total: subtotal },
    frete_indisponivel: false,
    pronto_para_checkout: true,
    ...extra,
  };
}

function montar(inicial = '/loja/carrinho') {
  return render(
    <MemoryRouter initialEntries={[inicial]}>
      <Routes>
        <Route path="/loja" element={<div>vitrine</div>} />
        <Route path="/loja/carrinho" element={<LojaCarrinhoPage />} />
        <Route path="/loja/checkout" element={<div>rota-checkout</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function api(preview: (corpo: any, init: RequestInit) => unknown | Promise<unknown>) {
  fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
    if (caminho.startsWith('/loja/config')) return CONFIG;
    if (caminho === '/loja/preview') return preview(JSON.parse(String(init?.body ?? '{}')), init ?? {});
    throw new Error(`rota inesperada ${caminho}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  limparCarrinho();
});

describe('Carrinho — linhas reais, valores do servidor', () => {
  it('mostra imagem, nome, SKU, preço unitário, quantidade, subtotal e totais reais (R$ 80,00)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    api((c) => cotacao(c.itens[0].quantidade));
    montar();
    expect(await screen.findByText(NOME)).toBeInTheDocument();
    expect(screen.getByText(`SKU: ${SKU}`)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: NOME })).toHaveAttribute('src', 'https://img.example/cotton-b.jpg');
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00'));
    expect(screen.queryByText('…')).toBeNull();
    const resumo = screen.getByRole('complementary', { name: /resumo do pedido/i });
    expect(within(resumo).getByText('Retirada na loja')).toBeInTheDocument();
    expect(within(resumo).getAllByText('R$ 0,00').length).toBeGreaterThanOrEqual(2); // desconto e frete
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeEnabled();
    expect(screen.getByRole('link', { name: /continuar comprando/i })).toHaveAttribute('href', '/loja');
  });

  it('o corpo enviado ao servidor NÃO contém preço, desconto, frete nem total', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2, nome: NOME });
    const corpos: any[] = [];
    api((c) => {
      corpos.push(c);
      return cotacao(2);
    });
    montar();
    await screen.findByText(NOME);
    expect(corpos[0]).toEqual({ itens: [{ produto_id: 7, tamanho_id: null, quantidade: 2 }] });
    expect(JSON.stringify(corpos[0])).not.toMatch(/preco|total|desconto|frete/i);
  });
});

describe('Carrinho — estados explícitos', () => {
  it('EMPTY: “Seu carrinho está vazio.” com ação de continuar comprando', async () => {
    api(() => cotacao(1));
    montar();
    expect(await screen.findByText('Seu carrinho está vazio.')).toBeInTheDocument();
    expect(document.querySelector('[data-estado-carrinho="EMPTY"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: /continuar comprando/i })).toHaveAttribute('href', '/loja');
    expect(fetchMock).not.toHaveBeenCalledWith('/loja/preview', expect.anything());
  });

  it('LOADING: a linha (snapshot) já aparece e os valores ficam “—”, nunca “…” indefinido', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME, sku: SKU });
    api(() => new Promise(() => undefined)); // nunca responde
    montar();
    expect(await screen.findByText(NOME)).toBeInTheDocument();
    expect(document.querySelector('[data-estado-carrinho="LOADING"]')).not.toBeNull();
    expect(screen.getByTestId('total-carrinho')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeDisabled();
  });

  it('ERROR (o bug original): falha da cotação mantém a linha, mostra a mensagem e permite tentar de novo', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME, sku: SKU });
    let falhar = true;
    api((c) => {
      if (falhar) throw new ApiError(500, 'Erro interno');
      return cotacao(c.itens[0].quantidade);
    });
    const user = userEvent.setup();
    montar();
    expect(await screen.findByText('Não foi possível calcular o carrinho. Tente novamente.')).toBeInTheDocument();
    expect(screen.getByText(NOME)).toBeInTheDocument(); // linha NÃO some (badge 1 ⇒ 1 linha)
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeDisabled();
    falhar = false;
    await user.click(screen.getByRole('button', { name: /tentar novamente/i }));
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00'));
    expect(screen.queryByText('Não foi possível calcular o carrinho. Tente novamente.')).toBeNull();
  });

  it('INVALID: item que saiu da loja continua visível e removível; checkout bloqueado', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    adicionarAoCarrinho({ produto_id: 9, tamanho_id: null, quantidade: 1, nome: 'Boné' });
    api((c) => {
      const itens = c.itens.map((i: any) =>
        i.produto_id === 9
          ? { produto_id: 9, tamanho_id: null, quantidade: 1, nome: 'Item indisponível', sku: '', preco_unitario: 0, preco_original: null, disponivel: 0, subtotal: 0, ok: false, indisponivel: true, aviso: 'Este item não está mais disponível na loja. Remova-o para continuar.' }
          : cotacao(1).itens[0]
      );
      return { ...cotacao(1), itens, pronto_para_checkout: false };
    });
    const user = userEvent.setup();
    montar();
    expect((await screen.findAllByText(/não está mais disponível na loja/i)).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-estado-carrinho="INVALID"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /remover boné do carrinho/i }));
    expect(lerCarrinho().itens.map((i) => i.produto_id)).toEqual([7]);
  });

  it('INVALID: frete indisponível mostra “Frete indisponível para esta configuração.” e não inventa valor', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    api(() =>
      cotacao(1, {
        frete: { disponivel: false, provedor: 'nenhum', motivo: 'Frete não configurado' },
        frete_indisponivel: true,
        frete_motivo: 'Frete não configurado',
        pronto_para_checkout: false,
      })
    );
    montar();
    expect((await screen.findAllByText(/Frete indisponível para esta configuração/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeDisabled();
  });

  it('estoque insuficiente: aviso do servidor, “+” travado no limite e checkout bloqueado', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 9 });
    api(() => ({
      ...cotacao(9),
      itens: [{ ...cotacao(9).itens[0], disponivel: 8, ok: false, aviso: 'Só 8 em estoque.' }],
      pronto_para_checkout: false,
    }));
    montar();
    expect(await screen.findByText('Só 8 em estoque.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`aumentar quantidade de ${NOME}`, 'i') })).toBeDisabled();
    expect(screen.getByRole('button', { name: /continuar para o checkout/i })).toBeDisabled();
  });
});

describe('Carrinho — quantidade, concorrência e persistência', () => {
  it('nunca aceita 0, negativo, NaN, Infinity ou string inválida', () => {
    for (const ruim of [0, -1, NaN, Infinity, -Infinity, 1.5, 'abc', '', '1e3', null, undefined, {}]) {
      expect(normalizarQuantidade(ruim)).toBeNull();
    }
    expect(normalizarQuantidade(3)).toBe(3);
    expect(normalizarQuantidade('4')).toBe(4);
    expect(normalizarQuantidade(500)).toBe(99);
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2 });
    const antes = lerCarrinho();
    for (const ruim of [0, -3, NaN, Infinity, 'x']) expect(alterarQuantidade(7, null, ruim)).toBe(false);
    expect(lerCarrinho()).toBe(antes); // snapshot intacto: nada removido nem corrompido
    expect(adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: NaN })).toBe(false);
    expect(lerCarrinho().itens[0].quantidade).toBe(2);
  });

  it('“−” fica desabilitado em 1 (remoção é só pelo botão Remover)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    api((c) => cotacao(c.itens[0].quantidade));
    montar();
    await screen.findByText(NOME);
    expect(screen.getByRole('button', { name: new RegExp(`diminuir quantidade de ${NOME}`, 'i') })).toBeDisabled();
  });

  it('duas atualizações rápidas: a resposta ANTIGA nunca sobrescreve a NOVA (e a requisição antiga é abortada)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const resolvers: Array<(v: unknown) => void> = [];
    const sinais: AbortSignal[] = [];
    api((c, init) => {
      sinais.push(init.signal as AbortSignal);
      if (c.itens[0].quantidade === 1) return new Promise((r) => resolvers.push(r));
      return cotacao(c.itens[0].quantidade);
    });
    montar();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    act(() => void alterarQuantidade(7, null, 2));
    act(() => void alterarQuantidade(7, null, 3));
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 240,00'));
    expect(sinais[0].aborted).toBe(true);
    await act(async () => resolvers[0](cotacao(1))); // resposta antiga chega por último
    expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 240,00');
    expect(screen.queryByText('R$ 80,00', { selector: '[data-testid="total-carrinho"]' })).toBeNull();
  });

  it('sobrevive à navegação e ao reload: o storage reidrata o mesmo carrinho, com cupom e chave', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2, nome: NOME, sku: SKU });
    definirCupom('promo10');
    const bruto = JSON.parse(localStorage.getItem('brobond-loja-carrinho')!);
    expect(bruto.itens).toHaveLength(1);
    expect(bruto.cupom).toBe('PROMO10');
    expect(bruto.chave.length).toBeGreaterThanOrEqual(8);
    // “F5”: módulo recarregado lê o storage
    vi.resetModules();
    const fresco = await import('./carinho');
    expect(fresco.lerCarrinho().itens).toEqual([expect.objectContaining({ produto_id: 7, quantidade: 2, nome: NOME })]);
    expect(fresco.lerCarrinho().cupom).toBe('PROMO10');
    expect(fresco.lerCarrinho().chave).toBe(bruto.chave);
  });
});

describe('Carrinho — cupom e checkout', () => {
  it('cupom é enviado ao servidor, mostra o desconto que o SERVIDOR calculou e é removível', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    api((c) => {
      const base = cotacao(1);
      if (c.cupom === 'OFF10') {
        return {
          ...base,
          cupom: { codigo: 'OFF10', valido: true, aplicado: true, desconto: 8 },
          desconto: 8,
          desconto_origem: 'cupom',
          totais: { subtotal: 80, desconto: 8, frete: 0, total: 72 },
        };
      }
      return base;
    });
    const user = userEvent.setup();
    montar();
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00'));
    await user.type(screen.getByLabelText(/cupom de desconto/i), 'off10');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 72,00'));
    expect(screen.getByText(/Cupom OFF10 aplicado/)).toBeInTheDocument();
    expect(lerCarrinho().cupom).toBe('OFF10'); // persistido para o checkout
    await user.click(screen.getByRole('button', { name: /remover cupom/i }));
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00'));
    expect(lerCarrinho().cupom).toBe('');
  });

  it('só avança ao checkout (por ROTA, sem modal) quando o servidor liberou', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    api((c) => cotacao(c.itens[0].quantidade));
    const user = userEvent.setup();
    montar();
    const botao = await screen.findByRole('button', { name: /continuar para o checkout/i });
    await waitFor(() => expect(botao).toBeEnabled());
    await user.click(botao);
    expect(await screen.findByText('rota-checkout')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
