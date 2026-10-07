// ============================================================================
// DEVOLUÇÃO / REVERSA — contrato de tela (§15)
//
// O que estes testes travam:
//   • **as ações vêm do servidor** (`proximas_acoes`) — a tela não decide o
//     fluxo, então mudar a máquina de estados no backend não quebra a tela;
//   • sem código de rastreamento, receber fica bloqueado E a tela explica por
//     quê (409 do servidor não é mistério para o operador);
//   • só estado `bom` volta ao estoque — avaria/uso/acessório faltando fica
//     registrado sem somar saldo;
//   • recebido não pode exceder o solicitado.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DevolucoesPage from './DevolucoesPage';
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

const ITENS = [
  { id: 101, produto_id: 1, sku: 'BOTA-1', produto: 'Bota Country', tamanho_id: 3, quantidade_solicitada: 2, quantidade_recebida: null, estado: null },
  { id: 102, produto_id: 2, sku: 'CINTO-1', produto: 'Cinto Couro', tamanho_id: null, quantidade_solicitada: 1, quantidade_recebida: null, estado: null },
];

const base = {
  id: 33,
  numero: 'DEV-0001',
  venda_id: 55,
  status: 'autorizada' as const,
  motivo: 'Cliente desistiu da compra',
  tipo: 'arrependimento',
  codigo_rastreamento: null,
  transportadora: null,
  autorizacao_codigo: 'AUT-9',
  autorizada_em: '2026-10-07T10:00:00.000Z',
  recebida_em: null,
  local_entrada: null,
  observacoes: null,
  criado_em: '2026-10-07T09:00:00.000Z',
  itens: ITENS,
};

/** Casa pelo prefixo mais específico — `/devolucoes` não engole `/devolucoes/33`. */
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
      <DevolucoesPage />
    </ToastProvider>
  );
}

function lista(status: string) {
  return {
    rows: [
      {
        id: 33,
        numero: 'DEV-0001',
        venda_id: 55,
        status,
        tipo: 'arrependimento',
        motivo: 'Cliente desistiu da compra',
        codigo_rastreamento: null,
        criado_em: '2026-10-07T09:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
  };
}

describe('Devoluções — tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('as ações mostradas são exatamente as que o servidor mandou em proximas_acoes', async () => {
    mockRotas({
      '/devolucoes?': lista('autorizada'),
      '/devolucoes/33': { ...base, proximas_acoes: ['registrar_rastreamento', 'receber'] },
    });
    renderPage();

    fireEvent.click(await screen.findByText('DEV-0001'));
    expect(await screen.findByText('Registrar rastreio')).toBeInTheDocument();
    expect(screen.getByText('Receber mercadoria')).toBeInTheDocument();
    // Autorizar/recusar/cancelar NÃO estão disponíveis neste status.
    expect(screen.queryByText('Autorizar', { selector: 'button' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelar', { selector: 'button' })).not.toBeInTheDocument();
  });

  it('devolução solicitada oferece autorizar, recusar e cancelar — e nada de receber', async () => {
    mockRotas({
      '/devolucoes?': lista('solicitada'),
      '/devolucoes/33': { ...base, status: 'solicitada', proximas_acoes: ['autorizar', 'recusar', 'cancelar'] },
    });
    renderPage();

    fireEvent.click(await screen.findByText('DEV-0001'));
    expect(await screen.findByText('Autorizar', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByText('Recusar', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByText('Cancelar', { selector: 'button' })).toBeInTheDocument();
    expect(screen.queryByText('Receber mercadoria')).not.toBeInTheDocument();
  });

  it('sem código de rastreamento, receber fica bloqueado e a tela explica o porquê', async () => {
    mockRotas({
      '/devolucoes?': lista('autorizada'),
      '/devolucoes/33': { ...base, codigo_rastreamento: null, proximas_acoes: ['registrar_rastreamento', 'receber'] },
    });
    renderPage();
    fireEvent.click(await screen.findByText('DEV-0001'));

    expect(await screen.findByText(/Sem código de rastreamento o servidor recusa o recebimento/)).toBeInTheDocument();
    expect(screen.getByText(/Mercadoria sem rastreabilidade não entra no estoque/)).toBeInTheDocument();

    // O modal de recebimento também nasce bloqueado.
    fireEvent.click(screen.getByText('Receber mercadoria'));
    expect(await screen.findByText('Receber mercadoria', { selector: 'h2, h3, div' })).toBeInTheDocument();
    expect((screen.getByText('Confirmar recebimento') as HTMLButtonElement).disabled).toBe(true);
  });

  it('só item em estado "bom" volta ao estoque; avaria fica registrada sem somar saldo', async () => {
    mockRotas({
      '/devolucoes?': lista('em_transito'),
      '/devolucoes/33': {
        ...base,
        status: 'em_transito',
        codigo_rastreamento: 'BR123456789',
        proximas_acoes: ['receber'],
      },
    });
    apiPost.mockResolvedValue({ id: 33 } as never);
    renderPage();
    fireEvent.click(await screen.findByText('DEV-0001'));
    await screen.findByText(/Cliente desistiu da compra/);

    // Pré-preenchido: 2 + 1 = 3 unidades em "bom".
    expect(await screen.findByText('3 un voltam ao estoque')).toBeInTheDocument();

    // Marca a Bota como avariada — ela sai do saldo.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const selectBota = selects.find((s) => Array.from(s.options).some((o) => o.value === 'avariado'))!;
    fireEvent.change(selectBota, { target: { value: 'avariado' } });

    expect(await screen.findByText('1 un voltam ao estoque')).toBeInTheDocument();
    expect(screen.getByText('2 un NÃO voltam')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Receber mercadoria'));
    fireEvent.click(await screen.findByText('Confirmar recebimento'));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/devolucoes/33/receber', expect.anything()));
    const corpo = apiPost.mock.calls[0][1] as { itens: Array<{ id: number; quantidade_recebida: number; estado: string }> };
    expect(corpo.itens).toEqual([
      { id: 101, quantidade_recebida: 2, estado: 'avariado' },
      { id: 102, quantidade_recebida: 1, estado: 'bom' },
    ]);
  });

  it('recebido não passa do solicitado — o campo corta no teto', async () => {
    mockRotas({
      '/devolucoes?': lista('em_transito'),
      '/devolucoes/33': {
        ...base,
        status: 'em_transito',
        codigo_rastreamento: 'BR123456789',
        proximas_acoes: ['receber'],
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText('DEV-0001'));
    await screen.findByText('3 un voltam ao estoque');

    // A Cinta tem 1 solicitado; tentar receber 5 corta em 1.
    const campos = screen.getAllByRole('spinbutton');
    fireEvent.change(campos[1], { target: { value: '5' } });
    expect((campos[1] as HTMLInputElement).value).toBe('1');
  });

  it('devolução recebida não oferece ação nenhuma', async () => {
    mockRotas({
      '/devolucoes?': lista('recebida'),
      '/devolucoes/33': {
        ...base,
        status: 'recebida',
        codigo_rastreamento: 'BR123456789',
        recebida_em: '2026-10-07T15:00:00.000Z',
        local_entrada: 'loja',
        proximas_acoes: [],
      },
    });
    renderPage();
    fireEvent.click(await screen.findByText('DEV-0001'));

    expect(await screen.findByText(/Nenhuma ação disponível/)).toBeInTheDocument();
    expect(screen.queryByText('Receber mercadoria')).not.toBeInTheDocument();
  });

  it('solicitar exige pedido e motivo com pelo menos 5 caracteres', async () => {
    mockRotas({ '/devolucoes?': { rows: [], total: 0, page: 1, pageSize: 50 } });
    apiPost.mockResolvedValue({ id: 44 } as never);
    renderPage();

    fireEvent.click(await screen.findByText('Solicitar devolução'));
    expect(await screen.findByText('Solicitar devolução', { selector: 'h2, h3' })).toBeInTheDocument();
    expect((screen.getByText('Solicitar', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Pedido \(venda\)/i), { target: { value: '55' } });
    fireEvent.change(screen.getByPlaceholderText('Mínimo 5 caracteres.'), { target: { value: 'no' } });
    expect((screen.getByText('Solicitar', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Mínimo 5 caracteres.'), {
      target: { value: 'Cliente desistiu da compra' },
    });
    fireEvent.click(screen.getByText('Solicitar', { selector: 'button' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/devolucoes', {
        venda_id: 55,
        motivo: 'Cliente desistiu da compra',
        // O formulário nasce em 'devolucao'; o tipo só muda se o operador escolher.
        tipo: 'devolucao',
      })
    );
  });

  it('registrar rastreio exige código com pelo menos 5 caracteres', async () => {
    mockRotas({
      '/devolucoes?': lista('autorizada'),
      '/devolucoes/33': { ...base, proximas_acoes: ['registrar_rastreamento', 'receber'] },
    });
    apiPost.mockResolvedValue({ id: 33 } as never);
    renderPage();
    fireEvent.click(await screen.findByText('DEV-0001'));

    fireEvent.click(await screen.findByText('Registrar rastreio'));
    expect((screen.getByText('Registrar', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Código de rastreamento/i), { target: { value: 'BR9' } });
    expect((screen.getByText('Registrar', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Código de rastreamento/i), { target: { value: 'BR123456789' } });
    fireEvent.click(screen.getByText('Registrar', { selector: 'button' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/devolucoes/33/rastreamento', { codigo_rastreamento: 'BR123456789' })
    );
  });
});
