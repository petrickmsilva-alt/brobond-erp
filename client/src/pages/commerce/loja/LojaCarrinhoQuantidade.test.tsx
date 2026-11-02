// ============================================================================
// /loja/carrinho — REGRESSÃO DEFINITIVA DOS BOTÕES + / −.
//
// Os testes antigos chamavam `alterarQuantidade()` DIRETO e por isso nunca
// exerciam o clique real. Aqui TUDO começa por `userEvent.click` no botão da
// tela: a intenção precisa ir ao servidor, voltar confirmada e só então mudar
// a quantidade, o subtotal, o total e o storage.
//
// Casos: 1→2, 2→3, 3→2, 2→1, 1→− (bloqueado), estoque=2 (bloqueado),
// + + − concorrente, resposta antiga depois da nova, erro da API + retry,
// isolamento multiempresa (nenhum tenant/valor monetário vem do browser),
// persistência/abas, Remover e zero modal.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaCarrinhoPage from './LojaCarrinhoPage';
import { CAMINHO_QUANTIDADE, MENSAGEM_ERRO_QUANTIDADE } from './quantidade';
import { adicionarAoCarrinho, lerCarrinho, limparCarrinho, removerDoCarrinho } from './carinho';

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
const SKU = 'CAM-BAS-PREM-VERM';

function cotacao(qtd: number, disponivel = 8) {
  const subtotal = 80 * qtd;
  return {
    payment_methods: [{ code: 'PIX', max_installments: 1 }],
    itens: [
      { produto_id: 7, tamanho_id: null, quantidade: qtd, nome: NOME, sku: SKU, variante: null, foto_url: null, preco_unitario: 80, preco_original: null, disponivel, subtotal, ok: true },
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
  };
}

type Mutacao = (corpo: any, init: RequestInit) => unknown | Promise<unknown>;

const corposMutacao: any[] = [];
let mutacao: Mutacao;

function preparar(opcoes: { disponivel?: number; mutacao?: Mutacao } = {}) {
  const disponivel = opcoes.disponivel ?? 8;
  corposMutacao.length = 0;
  mutacao = opcoes.mutacao ?? ((corpo) => ({
    produto_id: 7,
    tamanho_id: null,
    quantidade: corpo.alvo.quantidade,
    disponivel,
  }));
  fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
    if (caminho.startsWith('/loja/config')) return CONFIG;
    if (caminho === '/loja/preview') {
      const corpo = JSON.parse(String(init?.body ?? '{}'));
      return cotacao(corpo.itens[0].quantidade, disponivel);
    }
    if (caminho === CAMINHO_QUANTIDADE) {
      const corpo = JSON.parse(String(init?.body ?? '{}'));
      corposMutacao.push(corpo);
      return mutacao(corpo, init ?? {});
    }
    throw new Error(`rota inesperada ${caminho}`);
  });
}

function montar() {
  return render(
    <MemoryRouter initialEntries={['/loja/carrinho']}>
      <Routes>
        <Route path="/loja/carrinho" element={<LojaCarrinhoPage />} />
        <Route path="/loja/checkout" element={<div>rota-checkout</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function botoes() {
  return {
    mais: screen.getByRole('button', { name: new RegExp(`aumentar quantidade de ${NOME}`, 'i') }) as HTMLButtonElement,
    menos: screen.getByRole('button', { name: new RegExp(`diminuir quantidade de ${NOME}`, 'i') }) as HTMLButtonElement,
  };
}

async function esperarQuantidade(qtd: number) {
  await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${NOME}`)).toHaveTextContent(String(qtd)));
  expect(lerCarrinho().itens[0].quantidade).toBe(qtd); // estado confirmado E persistido
}

beforeEach(() => {
  fetchMock.mockReset();
  limparCarrinho();
});

describe('Carrinho — + / − com confirmação do servidor', () => {
  it('caso 1: 1 → + → 2 (subtotal da linha, subtotal geral e total recalculados)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME, sku: SKU });
    preparar();
    const user = userEvent.setup();
    montar();
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00'));
    await user.click(botoes().mais);
    await esperarQuantidade(2);
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 160,00'));
    expect(screen.getAllByText('R$ 160,00').length).toBeGreaterThanOrEqual(2); // subtotal da linha + subtotal geral + total
    expect(corposMutacao).toHaveLength(1); // uma única mutação por clique
    expect(corposMutacao[0].alvo.quantidade).toBe(2);
    expect(corposMutacao[0].itens[0].quantidade).toBe(2);
  });

  it('caso 2: 2 → + → 3', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2, nome: NOME });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    await esperarQuantidade(3);
    expect(corposMutacao.at(-1)!.alvo.quantidade).toBe(3);
  });

  it('caso 3: 3 → − → 2', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 3, nome: NOME });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().menos);
    await esperarQuantidade(2);
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 160,00'));
  });

  it('caso 4: 2 → − → 1 (e "−" continua sem remover o item)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2, nome: NOME });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().menos);
    await esperarQuantidade(1);
    expect(botoes().menos).toBeDisabled();
    expect(screen.getByRole('button', { name: new RegExp(`remover ${NOME} do carrinho`, 'i') })).toBeInTheDocument();
    expect(lerCarrinho().itens).toHaveLength(1);
  });

  it('caso 5: 1 → − é bloqueado (não zera, não remove, não chama a API)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    expect(botoes().menos).toBeDisabled();
    await user.click(botoes().menos);
    expect(lerCarrinho().itens[0].quantidade).toBe(1);
    expect(corposMutacao).toHaveLength(0);
    // Remover continua sendo a ÚNICA ação de exclusão.
    await user.click(screen.getByRole('button', { name: new RegExp(`remover ${NOME} do carrinho`, 'i') }));
    expect(lerCarrinho().itens).toHaveLength(0);
    expect(await screen.findByText('Seu carrinho está vazio.')).toBeInTheDocument();
  });

  it('caso 6: estoque = 2 e quantidade = 2 → "+" bloqueado com mensagem clara do servidor', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2, nome: NOME });
    preparar({ disponivel: 2 });
    const user = userEvent.setup();
    montar();
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 160,00'));
    expect(botoes().mais).toBeDisabled();
    await user.click(botoes().mais);
    expect(await screen.findByText('Só há 2 unidades disponíveis.')).toBeInTheDocument();
    expect(lerCarrinho().itens[0].quantidade).toBe(2);
    expect(corposMutacao).toHaveLength(0);
  });

  it('caso 6b: estoque mudou no servidor → 409 com mensagem, sem estado falso e sem remover', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    preparar({
      disponivel: 8, // última cotação (cache) ainda diz 8
      mutacao: () => { throw new ApiError(409, 'Só há 1 unidade disponível.'); },
    });
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    expect(await screen.findByText('Só há 1 unidade disponível.')).toBeInTheDocument();
    expect(lerCarrinho().itens[0].quantidade).toBe(1); // rollback para o último estado confirmado
    expect(screen.getByLabelText(`Quantidade de ${NOME}`)).toHaveTextContent('1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('casos 7 e 8: + + − concorrentes → estado final 2; respostas ANTIGAS não sobrescrevem a nova', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    const chamadas: Array<{ corpo: any; resolver: (v: unknown) => void }> = [];
    preparar({
      // O mock ignora o AbortController de propósito: simula respostas que
      // chegam FORA DE ORDEM mesmo depois de substituídas.
      mutacao: (corpo) => new Promise((resolver) => chamadas.push({ corpo, resolver })),
    });
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    await user.click(botoes().mais);
    await user.click(botoes().menos);
    await waitFor(() => expect(chamadas).toHaveLength(3));
    expect(chamadas.map((c) => c.corpo.alvo.quantidade)).toEqual([2, 3, 2]);
    expect(lerCarrinho().itens[0].quantidade).toBe(1); // NENHUM optimistic update
    // A resposta MAIS NOVA chega primeiro e confirma 2.
    await act(async () => chamadas[2].resolver({ produto_id: 7, tamanho_id: null, quantidade: 2, disponivel: 8 }));
    await esperarQuantidade(2);
    // Respostas antigas chegam DEPOIS e não podem sobrescrever.
    await act(async () => {
      chamadas[0].resolver({ produto_id: 7, tamanho_id: null, quantidade: 2, disponivel: 8 });
      chamadas[1].resolver({ produto_id: 7, tamanho_id: null, quantidade: 3, disponivel: 8 });
    });
    await waitFor(() => expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 160,00'));
    expect(lerCarrinho().itens[0].quantidade).toBe(2);
    expect(screen.getByLabelText(`Quantidade de ${NOME}`)).toHaveTextContent('2');
  });

  it('caso 9: erro da API → estado confirmado preservado, erro inline e nova tentativa', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    let falhar = true;
    preparar({
      mutacao: (corpo) => {
        if (falhar) throw new ApiError(500, 'Erro interno');
        return { produto_id: 7, tamanho_id: null, quantidade: corpo.alvo.quantidade, disponivel: 8 };
      },
    });
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    expect(await screen.findByText(MENSAGEM_ERRO_QUANTIDADE)).toBeInTheDocument();
    expect(lerCarrinho().itens[0].quantidade).toBe(1);
    expect(screen.getByLabelText(`Quantidade de ${NOME}`)).toHaveTextContent('1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('total-carrinho')).toHaveTextContent('R$ 80,00');
    falhar = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await esperarQuantidade(2);
    expect(screen.queryByText(MENSAGEM_ERRO_QUANTIDADE)).toBeNull();
  });

  it('caso 10: isolamento multiempresa — o browser NÃO envia empresa_id nem valores monetários', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    await esperarQuantidade(2);
    const corpo = corposMutacao[0];
    expect(Object.keys(corpo).sort()).toEqual(['alvo', 'itens']);
    expect(Object.keys(corpo.alvo).sort()).toEqual(['produto_id', 'quantidade', 'tamanho_id']);
    expect(Object.keys(corpo.itens[0]).sort()).toEqual(['produto_id', 'quantidade', 'tamanho_id']);
    expect(JSON.stringify(corpo)).not.toMatch(/empresa_id|unit_price|discount|freight|"total"|preco|desconto|frete/i);
    // O cupom (quando existe) continua sendo enviado e preservado.
    const { definirCupom } = await import('./carinho');
    definirCupom('OFF10');
    await waitFor(() => expect(screen.getByText(/Cupom/i)).toBeInTheDocument());
    await user.click(botoes().mais);
    await esperarQuantidade(3);
    expect(corposMutacao.at(-1)!.cupom).toBe('OFF10');
    expect(lerCarrinho().cupom).toBe('OFF10');
  });

  it('persistência após + + − e sincronização entre abas (sem perder Remover)', async () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1, nome: NOME, sku: SKU });
    preparar();
    const user = userEvent.setup();
    montar();
    await screen.findByText(NOME);
    await user.click(botoes().mais);
    await esperarQuantidade(2);
    await user.click(botoes().mais);
    await esperarQuantidade(3);
    await user.click(botoes().menos);
    await esperarQuantidade(2);
    expect(JSON.parse(localStorage.getItem('brobond-loja-carrinho')!).itens[0].quantidade).toBe(2);
    // Reidratação (F5) e evento de storage de outra aba.
    vi.resetModules();
    const fresco = await import('./carinho');
    expect(fresco.lerCarrinho().itens[0].quantidade).toBe(2);
    const outraAba = { ...fresco.lerCarrinho(), itens: [{ ...fresco.lerCarrinho().itens[0], quantidade: 4 }] };
    await act(async () => {
      localStorage.setItem('brobond-loja-carrinho', JSON.stringify(outraAba));
      window.dispatchEvent(new StorageEvent('storage', { key: 'brobond-loja-carrinho' }));
    });
    await waitFor(() => expect(screen.getByLabelText(`Quantidade de ${NOME}`)).toHaveTextContent('4'));
    // Remover continua removendo (e não é substituído pelo "−").
    await user.click(screen.getByRole('button', { name: new RegExp(`remover ${NOME} do carrinho`, 'i') }));
    expect(await screen.findByText('Seu carrinho está vazio.')).toBeInTheDocument();
    expect(removerDoCarrinho).toBeTypeOf('function');
  });
});
