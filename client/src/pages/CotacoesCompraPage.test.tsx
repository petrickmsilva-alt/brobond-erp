// ============================================================================
// COTAÇÃO DE COMPRA — contrato de tela (E3)
//
// O que estes testes existem para proteger, do lado do usuário:
//
//   • A tela NUNCA mostra um preço que o fornecedor não deu. Item sem cotação
//     aparece como "sem cotação" e o botão de decidir fica DESABILITADO com o
//     motivo — não simplesmente sumido.
//   • Preço de fornecedor sem estoque aparece riscado e não vence.
//   • Operador enxerga que decidir é ato de gerente (botão desabilitado +
//     aviso), em vez de tomar 403 depois de preencher tudo.
//   • Decisão idempotente: se o servidor responde que o pedido já existia, a
//     tela diz isso — o usuário precisa saber que não saiu um pedido duplicado.
//   • Erro de rede mostra mensagem e botão de tentar de novo.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CotacoesCompraPage from './CotacoesCompraPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

// A página lê o perfil para decidir o que o usuário pode fazer.
const authMock = { user: { perfil: 'gerente' } as { perfil: string } | null };
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authMock,
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const COTACAO = { id: 7, titulo: 'Tecidos outubro', status: 'cotando', criterio: 'menor_preco', prazo_validade: null, compra_id: null };

const COMPARATIVO = {
  cotacao: COTACAO,
  resumo: { itens: 2, fornecedores: 2, fornecedores_que_cotaram: 1, itens_sem_cotacao: 1, economia_potencial_total: 40 },
  itens: [
    {
      item_id: 1,
      descricao: 'Tecido Sarja',
      quantidade: 10,
      unidade: 'm',
      cotacoes_recebidas: 1,
      precos: [{ convite_id: 1, fornecedor_id: 11, fornecedor: 'Tecelagem Sul', preco_unitario: 8.5, prazo_entrega_dias: 5, total: 85, disponivel: true }],
      menor_preco: 8.5,
      melhor_fornecedor: 'Tecelagem Sul',
      melhor_prazo_dias: 5,
      economia_potencial: 0,
      escolhido_fornecedor_id: null,
      escolhido_preco: null,
    },
    {
      item_id: 2,
      descricao: 'Linha 40',
      quantidade: 5,
      unidade: 'un',
      cotacoes_recebidas: 0,
      precos: [],
      menor_preco: null,
      melhor_fornecedor: null,
      melhor_prazo_dias: null,
      economia_potencial: 0,
      escolhido_fornecedor_id: null,
      escolhido_preco: null,
    },
  ],
  fornecedores: [
    { convite_id: 1, fornecedor_id: 11, fornecedor: 'Tecelagem Sul', status: 'cotado', itens_cotados: 1, total_cotado: 85, frete: 0, prazo_entrega_dias: 5, condicao_pagamento: '30 dias', respondeu_em: '2026-10-01T10:00:00.000Z' },
    { convite_id: 2, fornecedor_id: 12, fornecedor: 'Aviamentos Norte', status: 'convidado', itens_cotados: 0, total_cotado: null, frete: 0, prazo_entrega_dias: null, condicao_pagamento: null, respondeu_em: null },
  ],
};

const LISTA = { rows: [COTACAO], total: 1, page: 1, pageSize: 100 };
const INSUMOS = { rows: [{ id: 1, nome: 'Tecido Sarja' }], total: 1, page: 1, pageSize: 500 };
const FORNECEDORES = { rows: [{ id: 11, nome: 'Tecelagem Sul' }], total: 1, page: 1, pageSize: 200 };

function mockGet(comparativo: unknown = COMPARATIVO, lista: unknown = LISTA) {
  apiGet.mockImplementation(async (path: string) => {
    if (path.includes('/comparativo')) return comparativo as never;
    if (path.startsWith('/cotacoes_compra')) return lista as never;
    if (path.startsWith('/insumos')) return INSUMOS as never;
    if (path.startsWith('/fornecedores')) return FORNECEDORES as never;
    return { rows: [], total: 0 } as never;
  });
}

function montar() {
  return render(
    <ToastProvider>
      <CotacoesCompraPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.user = { perfil: 'gerente' };
  mockGet();
  apiPost.mockResolvedValue({} as never);
});

describe('CotacoesCompraPage', () => {
  it('carrega a cotação e mostra a matriz item × fornecedor', async () => {
    montar();
    expect(await screen.findByText(/Carregando/i)).toBeTruthy();
    expect(await screen.findByText('#7 Tecidos outubro')).toBeTruthy();
    expect(await screen.findByText('Tecido Sarja')).toBeTruthy();
    expect(screen.getByText('Linha 40')).toBeTruthy();
    expect(screen.getAllByText('Tecelagem Sul').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R$ 8,50').length).toBeGreaterThan(0);
  });

  it('item sem cotação aparece como "sem cotação" e BLOQUEIA a decisão com o motivo', async () => {
    montar();
    expect(await screen.findByText('sem cotação')).toBeTruthy();
    expect(screen.getByText(/1 item\(ns\) sem nenhuma cotação/)).toBeTruthy();

    const decidir = screen.getByRole('button', { name: /Decidir e gerar pedido/ }) as HTMLButtonElement;
    expect(decidir.disabled).toBe(true);
    expect(decidir.title).toMatch(/Há itens sem nenhuma cotação/);
    // Nenhuma decisão foi enviada.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('com todos os itens cotados, decidir confirma e mostra o pedido criado', async () => {
    const completo = {
      ...COMPARATIVO,
      resumo: { ...COMPARATIVO.resumo, itens_sem_cotacao: 0, fornecedores_que_cotaram: 2 },
      itens: COMPARATIVO.itens.map((i) =>
        i.item_id === 2
          ? {
              ...i,
              cotacoes_recebidas: 1,
              precos: [{ convite_id: 2, fornecedor_id: 12, fornecedor: 'Aviamentos Norte', preco_unitario: 4, prazo_entrega_dias: 2, total: 20, disponivel: true }],
              menor_preco: 4,
              melhor_fornecedor: 'Aviamentos Norte',
            }
          : i
      ),
    };
    mockGet(completo);
    apiPost.mockResolvedValue({ compra_id: 99, idempotente: false, mensagem: 'ok', total: 105 } as never);

    montar();
    const decidir = (await screen.findByRole('button', { name: /Decidir e gerar pedido/ })) as HTMLButtonElement;
    expect(decidir.disabled).toBe(false);

    fireEvent.click(decidir);
    // Confirmação obrigatória antes do POST — decisão gera conta a pagar.
    expect(await screen.findByText(/Decidir cotação e gerar pedido de compra/)).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /Gerar pedido de compra/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/cotacoes-compra/7/decidir', {}));
    expect(await screen.findByText(/pedido de compra #99/i)).toBeTruthy();
  });

  it('decisão idempotente avisa que NENHUM pedido duplicado foi criado', async () => {
    const completo = {
      ...COMPARATIVO,
      resumo: { ...COMPARATIVO.resumo, itens_sem_cotacao: 0 },
      itens: COMPARATIVO.itens.map((i) => (i.item_id === 2 ? { ...i, menor_preco: 4, cotacoes_recebidas: 1, precos: [{ convite_id: 2, fornecedor_id: 12, fornecedor: 'Aviamentos Norte', preco_unitario: 4, prazo_entrega_dias: null, total: 20, disponivel: true }] } : i)),
    };
    mockGet(completo);
    apiPost.mockResolvedValue({ compra_id: 42, idempotente: true, mensagem: 'já gerado', total: 105 } as never);

    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Decidir e gerar pedido/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Gerar pedido de compra/ }));
    expect(await screen.findByText(/já havia gerado o pedido #42/i)).toBeTruthy();
    expect(screen.getByText(/Nenhum pedido duplicado/i)).toBeTruthy();
  });

  it('preço de fornecedor sem estoque aparece riscado e não é o "melhor"', async () => {
    const comIndisponivel = {
      ...COMPARATIVO,
      resumo: { ...COMPARATIVO.resumo, itens_sem_cotacao: 1 },
      itens: [
        {
          ...COMPARATIVO.itens[0],
          precos: [
            { convite_id: 1, fornecedor_id: 11, fornecedor: 'Tecelagem Sul', preco_unitario: 2, prazo_entrega_dias: 1, total: 20, disponivel: false },
            { convite_id: 2, fornecedor_id: 12, fornecedor: 'Aviamentos Norte', preco_unitario: 9, prazo_entrega_dias: 4, total: 90, disponivel: true },
          ],
          menor_preco: 9,
          melhor_fornecedor: 'Aviamentos Norte',
        },
        COMPARATIVO.itens[1],
      ],
      fornecedores: COMPARATIVO.fornecedores.map((f) => ({ ...f, status: 'cotado', itens_cotados: 1 })),
    };
    mockGet(comIndisponivel);
    const { container } = montar();

    expect(await screen.findByText('Tecido Sarja')).toBeTruthy();
    // O 2,00 indisponível continua visível (riscado), mas o "melhor" é o 9,00.
    const riscados = container.querySelectorAll('td .line-through');
    expect(riscados.length).toBe(1);
    expect(riscados[0].textContent).toMatch(/2,00$/);
    expect(screen.getAllByText('Aviamentos Norte').length).toBeGreaterThan(1);
  });

  it('operador vê que decidir é ato de gerente (botão desabilitado + aviso)', async () => {
    authMock.user = { perfil: 'operador' };
    const { container } = montar();
    expect(await screen.findByText('Tecido Sarja')).toBeTruthy();
    // O aviso tem <strong> no meio: o texto vem partido em nós separados.
    expect(container.textContent).toMatch(/decidir[\s\S]*exigem perfil de gerente ou administrador/);
    const decidir = screen.getByRole('button', { name: /Decidir e gerar pedido/ }) as HTMLButtonElement;
    expect(decidir.disabled).toBe(true);
    expect(decidir.title).toMatch(/Somente gerentes e administradores/);
  });

  it('cotação já decidida mostra o pedido e não oferece decidir de novo', async () => {
    const decidida = { ...COMPARATIVO, cotacao: { ...COTACAO, status: 'decidida', compra_id: 88 }, resumo: { ...COMPARATIVO.resumo, itens_sem_cotacao: 0 } };
    mockGet(decidida);
    montar();
    expect(await screen.findByText(/gerou o\s*/)).toBeTruthy();
    expect(screen.getByText(/pedido de compra #88/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Decidir e gerar pedido/ })).toBeNull();
    // Sem item/convidar: a cotação decidida é só leitura.
    expect(screen.queryByRole('button', { name: /Item$/ })).toBeNull();
  });

  it('lista vazia oferece criar a primeira cotação', async () => {
    mockGet(COMPARATIVO, { rows: [], total: 0, page: 1, pageSize: 100 });
    montar();
    expect(await screen.findByText('Nenhuma cotação ainda')).toBeTruthy();
    expect(screen.getByText(/Crie a primeira cotação/)).toBeTruthy();
  });

  it('erro de rede mostra a mensagem e um botão de tentar de novo', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/cotacoes_compra')) throw new Error('boom');
      if (path.startsWith('/insumos')) return INSUMOS as never;
      if (path.startsWith('/fornecedores')) return FORNECEDORES as never;
      return { rows: [], total: 0 } as never;
    });
    montar();
    expect(await screen.findByText('Não foi possível carregar as cotações.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tentar de novo/ })).toBeTruthy();
  });

  it('nova cotação exige título antes do POST', async () => {
    mockGet(COMPARATIVO, { rows: [], total: 0, page: 1, pageSize: 100 });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Nova cotação/ }));
    expect(await screen.findByText('Nova cotação de compra')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Criar cotação/ }));
    await waitFor(() => expect(screen.getByText('Dê um título à cotação.')).toBeTruthy());
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Cotação de linhas' } });
    apiPost.mockResolvedValue({ id: 55 } as never);
    fireEvent.click(screen.getByRole('button', { name: /Criar cotação/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/cotacoes_compra', { titulo: 'Cotação de linhas', criterio: 'menor_preco', prazo_validade: null }));
  });

  it('registrar cotação de fornecedor envia só os itens com preço preenchido', async () => {
    const aberto = { ...COMPARATIVO, cotacao: { ...COTACAO, status: 'cotando' } };
    mockGet(aberto);
    const { container } = montar();
    expect(await screen.findByText('#7 Tecidos outubro')).toBeTruthy();

    // Quem já cotou aparece como "Editar preços"; o botão "Registrar cotação"
    // é do fornecedor que ainda não respondeu.
    expect(screen.getByRole('button', { name: /Editar preços/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Registrar cotação$/ }));
    expect(await screen.findByText(/Cotação de Aviamentos Norte/)).toBeTruthy();

    const precoInput = container.querySelector('input[aria-label="Preço unitário de Linha 40"]') as HTMLInputElement;
    expect(precoInput).toBeTruthy();
    fireEvent.change(precoInput, { target: { value: '3,75' } });

    apiPost.mockResolvedValue({ convite: {}, precos: 1 } as never);
    const botoes = screen.getAllByRole('button', { name: /^Registrar cotação$/ });
    expect(botoes.length).toBe(2); // o da lista + o do rodapé do modal
    fireEvent.click(botoes[botoes.length - 1]);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/cotacoes-compra/7/cotar', {
        convite_id: 2,
        frete: undefined,
        precos: [{ item_id: 2, preco_unitario: 3.75, prazo_entrega_dias: null, disponivel: true }],
      })
    );
  });
});
