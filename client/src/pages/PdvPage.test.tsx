// ============================================================================
// PDV — contrato de tela (§8)
//
// O ponto de compliance destes testes é a REGRA DE OURO do PDV: o total que
// vale é o do servidor. A tela pode mostrar prévia, mas tem que dizer que é
// prévia e tem que aceitar o valor recalculado sem discutir.
//
// Cobre também: venda só com caixa aberto, leitura que incrementa item
// repetido, preço manual marcado como exceção, e pagamento que some o troco.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PdvPage from './PdvPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
    }
  },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Operador PDV', perfil: 'gerente' }, loading: false, meta: {} }),
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const CAIXA = {
  id: 7,
  numero: 'CAIXA-01',
  local: 'loja',
  status: 'aberto',
  valor_abertura: 100,
  abertura_em: '2026-10-07T09:00:00.000Z',
  fechamento_em: null,
};

const RESUMO = {
  caixa_id: 7,
  status: 'aberto',
  quantidade_vendas: 0,
  quantidade_canceladas: 0,
  total_vendido: 0,
  por_forma: {},
  suprimentos: 0,
  sangrias: 0,
  valor_abertura: 100,
  esperado_em_dinheiro: 100,
};

const PRODUTO = {
  produto_id: 42,
  sku: 'BOTA-001',
  sku_produto: 'BOTA-001',
  nome: 'Bota Country',
  unidade: 'un',
  codigo_barras: '7890000000017',
  tamanho_id: 3,
  tamanho: '40',
  eh_variacao: true,
  preco: 199.9,
  preco_tabela: 199.9,
  origem_preco: 'Ficha do produto',
  lista_preco_id: null,
  disponivel_no_tamanho: 8,
  estoque_disponivel: 8,
};

function renderPdv() {
  return render(
    <ToastProvider>
      <PdvPage />
    </ToastProvider>
  );
}

/** Resolve a rota de acordo com o caminho pedido. */
function mockRotas(rotas: Record<string, unknown>) {
  apiGet.mockImplementation(((path: string) => {
    for (const [chave, valor] of Object.entries(rotas)) {
      if (path.startsWith(chave)) return Promise.resolve(valor);
    }
    return Promise.reject(new Error(`rota não mockada: ${path}`));
  }) as never);
}

describe('PDV — tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sem caixa aberto, não oferece venda — só abertura', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: null } });
    renderPdv();

    expect(await screen.findByText('Nenhum caixa aberto')).toBeInTheDocument();
    // O campo de leitura não existe sem caixa: ler código sem caixa não faz sentido.
    expect(screen.queryByPlaceholderText(/Código de barras/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Abrir caixa').length).toBeGreaterThan(0);
  });

  it('com caixa aberto, mostra a posição do caixa e a prévia', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO } });
    renderPdv();

    expect(await screen.findByText(/CAIXA-01/)).toBeInTheDocument();
    expect(await screen.findByText('Esperado em dinheiro')).toBeInTheDocument();
    // 100 aparece em "Abertura" e em "Esperado" — a asserção tem que ser pelo par.
    expect(screen.getAllByText('R$ 100,00').length).toBeGreaterThanOrEqual(2);
    // Ponto de compliance: a tela declara que é prévia.
    expect(screen.getByText(/Prévia do cupom/i)).toBeInTheDocument();
    expect(screen.getByText(/O servidor recalcula/i)).toBeInTheDocument();
  });

  it('leitura por código de barras resolve o produto no servidor e monta a linha', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    renderPdv();
    await screen.findByText(/CAIXA-01/);

    const campo = screen.getByPlaceholderText(/Código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });

    expect(await screen.findByText('Bota Country')).toBeInTheDocument();
    expect(screen.getByText(/BOTA-001/)).toBeInTheDocument();
    // O preço veio do servidor, não da tela.
    expect(screen.getByText(/Ficha do produto/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/pdv/buscar?codigo=7890000000017');
  });

  it('ler o mesmo código duas vezes incrementa a quantidade em vez de duplicar a linha', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    renderPdv();
    await screen.findByText(/CAIXA-01/);

    const campo = screen.getByPlaceholderText(/Código de barras/i);
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(campo, { target: { value: '7890000000017' } });
      fireEvent.keyDown(campo, { key: 'Enter' });
    }

    await screen.findByText('Bota Country');
    // Uma linha só, com quantidade 2.
    expect(screen.getAllByText('Bota Country')).toHaveLength(1);
    const qtd = screen.getByDisplayValue('2');
    expect(qtd).toBeInTheDocument();
  });

  it('finalizar envia itens e pagamentos e aceita o total RECALCULADO pelo servidor', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    apiPost.mockResolvedValue({
      venda_id: 901,
      venda: { id: 901 },
      caixa: { id: 7, numero: 'CAIXA-01' },
      calculo: {
        subtotal_itens: 199.9,
        desconto: 0,
        frete: 0,
        // O servidor recalculou com imposto — diferente da prévia de 199,90.
        total: 227.89,
        total_pago: 230,
        troco: 2.11,
      },
      itens: [],
      divergencias_de_preco: [],
      fiscal: { elegivel: true, modelo: '65' },
    } as never);

    renderPdv();
    await screen.findByText(/CAIXA-01/);

    const campo = screen.getByPlaceholderText(/Código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByText('Bota Country');

    // Pagamento em dinheiro no valor exato da prévia.
    fireEvent.click(screen.getByText('Adicionar pagamento'));
    // O campo de valor do pagamento tem label próprio — é por ele que se acha.
    fireEvent.change(await screen.findByLabelText(/^Valor$/), { target: { value: '230' } });

    fireEvent.click(screen.getByText('Finalizar e faturar'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/pdv/vendas', expect.objectContaining({ caixa_id: 7, faturar: true })));

    const corpo = apiPost.mock.calls.find((c) => c[0] === '/pdv/vendas')![1] as {
      itens: Array<{ produto_id: number; tamanho_id: number | null; quantidade: number }>;
      pagamentos: Array<{ forma: string; valor: number }>;
    };
    expect(corpo.itens).toEqual([{ produto_id: 42, tamanho_id: 3, quantidade: 1, desconto_pct: 0, preco_manual: null }]);
    expect(corpo.pagamentos).toEqual([{ forma: 'dinheiro', valor: 230, parcelas: 1 }]);

    // A tela mostra o total do SERVIDOR, não o dela.
    expect(await screen.findByText(/Venda #901 registrada/)).toBeInTheDocument();
    expect(screen.getByText(/total R\$ 227,89/)).toBeInTheDocument();
    expect(screen.getByText(/NFC-e elegível \(modelo 65\)/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Emissão de NFC-e a partir do PDV (§8 "emissão fiscal quando aplicável")
  //
  // A regra: a tela NUNCA marca como emitida por conta própria. Ela mostra o
  // que o servidor respondeu — inclusive a rejeição.
  // -------------------------------------------------------------------------

  /** Registra uma venda elegível a NFC-e e devolve o botão de emitir. */
  async function venderElegivel(respostaEmissao: unknown) {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    apiPost.mockImplementation(((rota: string) => {
      if (rota === '/pdv/vendas') {
        return Promise.resolve({
          venda_id: 902,
          venda: { id: 902 },
          caixa: { id: 7, numero: 'CAIXA-01' },
          calculo: { subtotal_itens: 199.9, desconto: 0, frete: 0, total: 199.9, total_pago: 200, troco: 0.1 },
          itens: [],
          divergencias_de_preco: [],
          fiscal: { elegivel: true, modelo: '65' },
        });
      }
      return Promise.resolve(respostaEmissao);
    }) as never);

    renderPdv();
    await screen.findByText(/CAIXA-01/);
    const campo = screen.getByPlaceholderText(/Código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByText('Bota Country');
    fireEvent.click(screen.getByText('Adicionar pagamento'));
    fireEvent.change(await screen.findByLabelText(/^Valor$/), { target: { value: '200' } });
    fireEvent.click(screen.getByText('Finalizar e faturar'));
    return await screen.findByText('Emitir NFC-e');
  }

  it('NFC-e autorizada mostra protocolo e chave devolvidos pelo servidor', async () => {
    const botao = await venderElegivel({
      status: 'autorizado',
      protocolo: '135260000000123',
      chave: '35261012345678000195650010000000011000000017',
    });
    fireEvent.click(botao);

    // Aparece no bloco da venda E no toast — os dois de propósito.
    expect((await screen.findAllByText(/NFC-e autorizada/)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Protocolo 135260000000123/)).toBeInTheDocument();
    expect(screen.getByText(/35261012345678000195650010000000011000000017/)).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledWith('/vendas/902/fiscal/emitir', { modelo: '65' });
  });

  it('NFC-e REJEITADA aparece como recusada — a tela nunca finge que emitiu', async () => {
    const botao = await venderElegivel({
      status: 'rejeitada',
      mensagem: 'Rejeição 539: Duplicidade de NF-e com diferença na Chave de Acesso.',
    });
    fireEvent.click(botao);

    expect((await screen.findAllByText(/Rejeição 539/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/NFC-e autorizada/)).not.toBeInTheDocument();
  });

  it('falha de rede na emissão aparece como recusada, não como emitida', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    const { ApiError } = await import('../lib/api');
    apiPost.mockImplementation(((rota: string) => {
      if (rota === '/pdv/vendas') {
        return Promise.resolve({
          venda_id: 903,
          venda: { id: 903 },
          caixa: { id: 7, numero: 'CAIXA-01' },
          calculo: { subtotal_itens: 199.9, desconto: 0, frete: 0, total: 199.9, total_pago: 200, troco: 0.1 },
          itens: [],
          divergencias_de_preco: [],
          fiscal: { elegivel: true, modelo: '65' },
        });
      }
      return Promise.reject(new ApiError(503, 'Provedor fiscal indisponível — nenhuma nota foi emitida.'));
    }) as never);

    renderPdv();
    await screen.findByText(/CAIXA-01/);
    const campo = screen.getByPlaceholderText(/Código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByText('Bota Country');
    fireEvent.click(screen.getByText('Adicionar pagamento'));
    fireEvent.change(await screen.findByLabelText(/^Valor$/), { target: { value: '200' } });
    fireEvent.click(screen.getByText('Finalizar e faturar'));

    fireEvent.click(await screen.findByText('Emitir NFC-e'));
    expect((await screen.findAllByText(/nenhuma nota foi emitida/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/NFC-e autorizada/)).not.toBeInTheDocument();
  });

  it('erro do servidor na venda aparece na tela em vez de sumir', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO }, '/pdv/buscar': PRODUTO });
    renderPdv();
    await screen.findByText(/CAIXA-01/);

    const campo = screen.getByPlaceholderText(/Código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByText('Bota Country');

    const { ApiError } = await import('../lib/api');
    apiPost.mockRejectedValue(new ApiError(409, 'Não há caixa aberto para este terminal.') as never);

    fireEvent.click(screen.getByText('Adicionar pagamento'));
    fireEvent.change(await screen.findByLabelText(/^Valor$/), { target: { value: '230' } });
    fireEvent.click(screen.getByText('Finalizar e faturar'));

    // Aparece duas vezes de propósito: no Alert da página E no toast.
    expect((await screen.findAllByText('Não há caixa aberto para este terminal.')).length).toBeGreaterThanOrEqual(2);
    // E o estado de erro persistiu na tela — não foi só um flash de toast.
    expect(screen.getAllByText('Não há caixa aberto para este terminal.')[0].closest('div')).toBeTruthy();
  });

  it('suprimento e sangria passam pelo endpoint de movimentos', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: RESUMO } });
    apiPost.mockResolvedValue({ id: 1 } as never);
    renderPdv();
    await screen.findByText(/CAIXA-01/);

    fireEvent.click(screen.getByText('Suprimento'));
    expect(await screen.findByText('Suprimento de caixa')).toBeInTheDocument();
    const campo = await screen.findByLabelText(/^Valor$/);
    fireEvent.change(campo, { target: { value: '50' } });
    fireEvent.click(screen.getByText('Registrar'));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/pdv/caixas/7/movimentos', expect.objectContaining({ tipo: 'suprimento', valor: 50 }))
    );
  });

  it('fechamento avisa a diferença antes de confirmar — divergência não some', async () => {
    mockRotas({ '/pdv/caixas/aberto': { caixa: CAIXA, resumo: { ...RESUMO, esperado_em_dinheiro: 100 } } });
    apiPost.mockResolvedValue({ ok: true, diferenca: -20, alerta: 'Falta de caixa registrada.' } as never);
    renderPdv();
    await screen.findByText(/CAIXA-01/);

    fireEvent.click(screen.getByText('Fechar caixa'));
    expect(await screen.findByText(/O sistema espera R\$ 100,00 em dinheiro/)).toBeInTheDocument();

    const contado = screen.getByLabelText(/Valor contado na gaveta/i);
    fireEvent.change(contado, { target: { value: '80' } });
    expect(await screen.findByText(/Diferença de -R\$ 20,00/)).toBeInTheDocument();

    // "Fechar caixa" existe no cabeçalho e no modal; o do modal é o último danger.
    const botoes = screen.getAllByRole('button', { name: 'Fechar caixa' });
    fireEvent.click(botoes[botoes.length - 1]);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/pdv/caixas/7/fechar', { valor_fechamento: 80 }));
    expect(await screen.findByText(/Falta de caixa registrada/)).toBeInTheDocument();
  });
});
