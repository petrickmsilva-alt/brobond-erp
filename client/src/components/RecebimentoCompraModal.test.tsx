// ============================================================================
// RECEBIMENTO DE COMPRA — contrato de tela (E3.2)
//
// O que estes testes existem para proteger, do lado do usuário:
//
//   • As quatro quantidades (PEDIDO / RECEBIDO / AGORA / PENDENTE) aparecem
//     separadas e com os valores certos. Confundir as quatro é o erro que esta
//     tela existe para impedir.
//   • Nenhum número de custo é inventado pela tela: o que aparece veio da
//     prévia do servidor (`custos`), e sem prévia a célula diz
//     "calcule a prévia".
//   • Custo médio ANTES e DEPOIS, frete rateado e impostos aparecem.
//   • Quantidade acima do que falta é recusada ANTES de chamar o servidor.
//   • A confirmação avisa que vai movimentar estoque e atualizar custo.
//   • Depois de confirmar, mostra o número do recebimento, o estoque
//     movimentado e o custo atualizado.
//   • Recebimento parcial deixa claro que nenhuma conta a pagar foi gerada.
//   • Vazio, erro e retry têm estado próprio.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RecebimentoCompraModal from '../components/RecebimentoCompraModal';
import { ToastProvider } from './ui';
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

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const COMPRA = {
  id: 12,
  status: 'pendente',
  total: 5400,
  frete: 400,
  condicao_pagamento: '30/60/90',
  fin_parcelas: 3,
  fin_vencimento: '2026-11-09',
  fin_forma_pagamento: 'boleto',
};

const ITENS_DETALHE = [
  { id: 101, insumo_id: 5, produto_id: null, quantidade: 100, quantidade_recebida: 0, preco_unitario: 50, unidade: 'un', insumo_id__label: 'Tecido sarja' },
];

const RECEBIMENTOS_VAZIO = { compra_id: 12, itens: [{ item_compra_id: 101, quantidade: 100, quantidade_recebida: 0, restante: 100 }], recebimentos: [] };

const PREVIA = {
  ok: true,
  previsao: true,
  aplicado: false,
  compra_id: 12,
  local: 'loja',
  total: 2160,
  completo: false,
  itens: [{ item_compra_id: 101, quantidade: 100, quantidade_recebida: 40, restante: 60 }],
  custos: [
    {
      item_compra_id: 101,
      insumo_id: 5,
      produto_id: null,
      quantidade: 40,
      local: 'loja',
      custo_frete_rateado: 160,
      custo_impostos: 25,
      custo_unitario_efetivo: 54.63,
      custo_medio_antes: 10,
      custo_medio_depois: 54.63,
    },
  ],
};

const RESULTADO = {
  recebimento_id: 9,
  status: 'parcial',
  total: 2160,
  custos: PREVIA.custos,
};

function montarGet(opts: { recebimentos?: any; itens?: any[]; compra?: any } = {}) {
  apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/recebimentos')) return opts.recebimentos ?? RECEBIMENTOS_VAZIO;
    if (path.endsWith('/itens')) return opts.itens ?? ITENS_DETALHE;
    return opts.compra ?? COMPRA;
  });
}

function abrir() {
  return render(
    <ToastProvider>
      <RecebimentoCompraModal compraId={12} onClose={vi.fn()} onRecebido={vi.fn()} />
    </ToastProvider>
  );
}

async function aguardarTabela() {
  await screen.findByText('Tecido sarja');
}

async function calcularPrevia() {
  fireEvent.click(screen.getByRole('button', { name: /calcular impacto/i }));
  await screen.findByText('Valor incorporado');
}

beforeEach(() => {
  vi.clearAllMocks();
  montarGet();
  apiPost.mockResolvedValue(PREVIA);
});

describe('RecebimentoCompraModal', () => {
  it('mostra PEDIDO / RECEBIDO / AGORA / PENDENTE separados e corretos', async () => {
    abrir();
    await aguardarTabela();

    // Pedido de 100, nada recebido: a prévia sugere receber o que falta (100).
    expect(await screen.findByText('PEDIDO')).toBeTruthy();
    expect(screen.getByText('RECEBIDO')).toBeTruthy();
    expect(screen.getByText('AGORA')).toBeTruthy();
    expect(screen.getByText('PENDENTE')).toBeTruthy();

    const grupo = screen.getByRole('group', { name: /situação do pedido/i });
    expect(grupo.textContent).toMatch(/PEDIDO/);
    expect(grupo.textContent).toMatch(/RECEBIDO/);
    expect(grupo.textContent).toMatch(/PENDENTE/);
  });

  it('recebimento PARCIAL: 100 pedido, 40 já recebidos, 20 agora, 40 pendentes', async () => {
    montarGet({
      recebimentos: {
        compra_id: 12,
        itens: [{ item_compra_id: 101, quantidade: 100, quantidade_recebida: 40, restante: 60 }],
        recebimentos: [{ id: 8, data: '2026-10-09T10:00:00Z', total: 2000, completo: false }],
      },
    });
    abrir();
    await aguardarTabela();

    // Digita 20 no campo "neste recebimento".
    const campo = screen.getByLabelText(/quantidade a receber de tecido sarja/i);
    fireEvent.change(campo, { target: { value: '20' } });

    const grupo = screen.getByRole('group', { name: /situação do pedido/i });
    // PEDIDO 100 · RECEBIDO 40 · AGORA 20 · PENDENTE 40
    expect(grupo.textContent).toContain('100');
    expect(grupo.textContent).toContain('40');
    expect(grupo.textContent).toContain('20');

    // E o histórico do recebimento anterior aparece.
    expect(await screen.findByText(/recebimentos anteriores \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/total recebido/i).parentElement?.textContent).toMatch(/40/);
  });

  it('exibe custo efetivo, custo médio antes/depois, frete e impostos vindos do servidor', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();

    // Custo efetivo por unidade, na linha do item.
    expect(screen.getAllByText(/R\$\s*54,63/).length).toBeGreaterThan(0);
    // Custo médio antes → depois.
    expect(screen.getByText('Custo médio atual')).toBeTruthy();
    expect(screen.getByText('Custo médio projetado')).toBeTruthy();
    expect(screen.getByText('Frete rateado na linha')).toBeTruthy();
    expect(screen.getByText('Impostos na linha')).toBeTruthy();
    // Valores: antes 10,00 e o frete de 160,00.
    expect(screen.getAllByText(/R\$\s*10,00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/R\$\s*160,00/).length).toBeGreaterThan(0);
  });

  it('sem prévia calculada a tela NÃO inventa custo efetivo', async () => {
    abrir();
    await aguardarTabela();
    expect(screen.getAllByText(/calcule a prévia/i).length).toBeGreaterThan(0);
    // O botão de continuar fica desabilitado até haver prévia.
    expect(screen.getByRole('button', { name: /continuar/i })).toBeDisabled();
  });

  it('recusa quantidade acima do que falta ANTES de chamar o servidor', async () => {
    abrir();
    await aguardarTabela();
    const campo = screen.getByLabelText(/quantidade a receber de tecido sarja/i);
    fireEvent.change(campo, { target: { value: '150' } });

    expect(await screen.findByText(/restam 100 — não é possível receber 150/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /calcular impacto/i })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('recusa quantidade negativa', async () => {
    abrir();
    await aguardarTabela();
    fireEvent.change(screen.getByLabelText(/quantidade a receber de tecido sarja/i), { target: { value: '-5' } });
    expect(await screen.findByText(/a quantidade não pode ser negativa/i)).toBeTruthy();
  });

  it('a confirmação avisa que vai movimentar estoque e atualizar custo', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));

    expect(await screen.findByText(/este recebimento irá movimentar o estoque e atualizar o custo dos produtos/i)).toBeTruthy();
    // E mostra o resumo antes de executar.
    expect(screen.getByText(/resumo do que será gravado/i)).toBeTruthy();
    // Ainda não confirmou.
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('após confirmar mostra o número do recebimento, o estoque movimentado e o custo atualizado', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();
    apiPost.mockResolvedValueOnce(RESULTADO);
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirmar recebimento/i }));

    expect(await screen.findByText(/recebimento #9 registrado com sucesso/i)).toBeTruthy();
    // Estoque movimentado.
    expect(screen.getByText('Estoque movimentado')).toBeTruthy();
    expect(screen.getAllByText(/40 unidade\(s\) em "loja"/i).length).toBeGreaterThan(0);
    // Custo atualizado: 10,00 → 54,63.
    expect(screen.getAllByText(/R\$\s*10,00 → R\$\s*54,63/).length).toBeGreaterThan(0);
  });

  it('recebimento parcial deixa explícito que nenhuma conta a pagar foi gerada', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();

    expect(screen.getByText(/a compra continuará/i).textContent).toMatch(/parcial/);
    expect(screen.getByText(/nenhuma conta a pagar é gerada agora/i)).toBeTruthy();
  });

  it('recebimento que completa o pedido avisa que a conta a pagar será gerada', async () => {
    apiPost.mockResolvedValue({ ...PREVIA, completo: true });
    abrir();
    await aguardarTabela();
    await calcularPrevia();
    expect(await screen.findByText(/a conta a pagar será gerada/i)).toBeTruthy();
  });

  it('mostra a condição de pagamento e as parcelas configuradas no pedido', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();
    expect(screen.getByText('Condição de pagamento')).toBeTruthy();
    expect(screen.getAllByText('30/60/90').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3×').length).toBeGreaterThan(0);
    expect(screen.getByText('Forma de pagamento')).toBeTruthy();
    expect(screen.getAllByText('boleto').length).toBeGreaterThan(0);
  });

  it('compra sem itens mostra estado vazio em vez de tabela vazia', async () => {
    montarGet({ recebimentos: { compra_id: 12, itens: [], recebimentos: [] } });
    abrir();
    expect(await screen.findByText(/esta compra não tem itens/i)).toBeTruthy();
  });

  it('sem recebimentos anteriores diz que este será o primeiro', async () => {
    abrir();
    await aguardarTabela();
    expect(await screen.findByText(/nenhum recebimento registrado ainda/i)).toBeTruthy();
  });

  it('erro ao carregar mostra mensagem e botão de tentar de novo', async () => {
    apiGet.mockRejectedValueOnce(new Error('Falha de rede'));
    abrir();
    expect(await screen.findByText(/falha de rede/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeTruthy();
  });

  it('retry recarrega depois do erro', async () => {
    apiGet.mockRejectedValueOnce(new Error('Falha de rede'));
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }));
    await aguardarTabela();
    expect(screen.queryByText(/falha de rede/i)).toBeNull();
  });

  it('erro na prévia mostra a mensagem e não deixa confirmar', async () => {
    apiPost.mockRejectedValueOnce(new Error('O armazém "loja" não está cadastrado.'));
    abrir();
    await aguardarTabela();
    fireEvent.click(screen.getByRole('button', { name: /calcular impacto/i }));

    expect(await screen.findByText(/armazém "loja" não está cadastrado/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /continuar/i })).toBeDisabled();
  });

  it('erro na confirmação volta para a edição com a mensagem', async () => {
    abrir();
    await aguardarTabela();
    await calcularPrevia();
    apiPost.mockRejectedValueOnce(new Error('Estoque insuficiente para o estorno.'));
    fireEvent.click(screen.getByRole('button', { name: /continuar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirmar recebimento/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /calcular impacto/i })).toBeTruthy());
    expect(screen.queryByText(/resumo do que será gravado/i)).toBeNull();
  });
});
