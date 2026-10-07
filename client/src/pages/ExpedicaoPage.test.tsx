// ============================================================================
// EXPEDIÇÃO — contrato de tela (§14)
//
// O que estes testes travam:
//   • a esteira só habilita a próxima etapa (não se pula conferência);
//   • a leitura por código de barras conta por item e compara com o pedido;
//   • divergência (422) NÃO é tratada como erro genérico: vira registro e a
//     tela diz explicitamente que nenhum estoque foi movimentado;
//   • expedir só fica habilitado depois de embalado.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExpedicaoPage from './ExpedicaoPage';
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

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const ETAPAS = ['pendente', 'separacao', 'conferida', 'embalada', 'expedida'] as const;

const SITUACAO = {
  venda_id: 55,
  status_venda: 'aberta',
  etapa: 'separacao',
  etapas: [...ETAPAS],
  itens: [
    { produto_id: 1, sku: 'BOTA-1', nome: 'Bota Country', codigo_barras: '7890000000017', tamanho_id: 3, quantidade: 2 },
    { produto_id: 2, sku: 'CINTO-1', nome: 'Cinto Couro', codigo_barras: '7890000000024', tamanho_id: null, quantidade: 1 },
  ],
  eventos: [{ id: 1, etapa: 'separacao', mensagem: 'Separação iniciada', usuario: 'Ana', criado_em: '2026-10-07T10:00:00.000Z' }],
  divergencias: [],
};

/**
 * Casa pelo prefixo MAIS ESPECÍFICO. Sem isso `/vendas` engole
 * `/vendas/55/expedicao` e a tela recebe a fila no lugar da situação — erro
 * silencioso que faria o teste passar pelo motivo errado.
 */
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
      <ExpedicaoPage />
    </ToastProvider>
  );
}

describe('Expedição — tela', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista a fila por etapa e abre a situação do pedido', async () => {
    mockRotas({
      '/vendas': { rows: [{ id: 55, cliente_id__label: 'Loja Centro', data: '2026-10-07', total: 500, status: 'aberta', expedicao_etapa: 'separacao' }], total: 1, page: 1, pageSize: 50 },
      '/expedicao/divergencias': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/vendas/55/expedicao': SITUACAO,
    });
    renderPage();

    expect(await screen.findByText('Pedido #55')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Pedido #55'));

    expect(await screen.findByText(/venda: aberta/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/vendas/55/expedicao');
    // A esteira mostra as cinco etapas (os rótulos também aparecem no filtro).
    expect(screen.getAllByText('Em separação').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Conferida')).toBeInTheDocument();
    expect(screen.getByText('Embalada')).toBeInTheDocument();
    expect(screen.getByText('Expedida')).toBeInTheDocument();
  });

  it('em separação, só "Conferir" fica habilitado — não se pula etapa', async () => {
    mockRotas({
      '/vendas': { rows: [{ id: 55, cliente_id__label: 'X', data: null, total: 1, status: 'aberta', expedicao_etapa: 'separacao' }], total: 1, page: 1, pageSize: 50 },
      '/expedicao/divergencias': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/vendas/55/expedicao': SITUACAO,
    });
    renderPage();
    fireEvent.click(await screen.findByText('Pedido #55'));
    await screen.findByText(/venda: aberta/);

    expect((screen.getByText('Iniciar separação') as HTMLButtonElement).disabled).toBe(true);
    // "Embalada" é o rótulo da etapa (span); o BOTÃO se chama "Embalar".
    expect((screen.getByText('Embalar') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Expedir') as HTMLButtonElement).disabled).toBe(true);
    // Conferir só habilita com leitura registrada.
    expect((screen.getByText(/^Conferir/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leitura por código de barras conta por item e habilita a conferência', async () => {
    mockRotas({
      '/vendas': { rows: [{ id: 55, cliente_id__label: 'X', data: null, total: 1, status: 'aberta', expedicao_etapa: 'separacao' }], total: 1, page: 1, pageSize: 50 },
      '/expedicao/divergencias': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/vendas/55/expedicao': SITUACAO,
    });
    apiPost.mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByText('Pedido #55'));
    await screen.findByText(/venda: aberta/);

    const campo = screen.getByPlaceholderText(/Leia o código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    fireEvent.change(campo, { target: { value: '7890000000017' } });
    fireEvent.keyDown(campo, { key: 'Enter' });

    // Bota: pedido 2, lido 2.
    await waitFor(() => expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2));
    expect((screen.getByText(/^Conferir \(2\)/) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText(/^Conferir \(2\)/));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/vendas/55/expedicao/conferir', {
        codigos: ['7890000000017', '7890000000017'],
      })
    );
  });

  it('divergência (422) vira registro auditável — e a tela diz que nada foi movimentado', async () => {
    mockRotas({
      '/vendas': { rows: [{ id: 55, cliente_id__label: 'X', data: null, total: 1, status: 'aberta', expedicao_etapa: 'separacao' }], total: 1, page: 1, pageSize: 50 },
      '/expedicao/divergencias': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/vendas/55/expedicao': SITUACAO,
    });
    const { ApiError } = await import('../lib/api');
    apiPost.mockRejectedValue(
      new ApiError(422, 'Divergência na conferência.', {
        divergencia_id: '9',
        faltando: '1',
        sobrando: '0',
        esperado_total: '3',
        lido_total: '2',
      }) as never
    );

    renderPage();
    fireEvent.click(await screen.findByText('Pedido #55'));
    await screen.findByText(/venda: aberta/);

    const campo = screen.getByPlaceholderText(/Leia o código de barras/i);
    fireEvent.change(campo, { target: { value: '7890000000024' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    fireEvent.click(await screen.findByText(/^Conferir \(1\)/));

    expect(await screen.findByText(/Divergência registrada \(#9\)/)).toBeInTheDocument();
    expect(screen.getByText(/faltando 1, sobrando 0/)).toBeInTheDocument();
    // A garantia que importa para a operação:
    expect(screen.getByText(/Nenhum estoque foi movimentado/)).toBeInTheDocument();
  });

  it('expedir chama o endpoint que fatura e baixa estoque', async () => {
    mockRotas({
      '/vendas': { rows: [{ id: 55, cliente_id__label: 'X', data: null, total: 1, status: 'aberta', expedicao_etapa: 'embalada' }], total: 1, page: 1, pageSize: 50 },
      '/expedicao/divergencias': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/vendas/55/expedicao': { ...SITUACAO, etapa: 'embalada' },
    });
    apiPost.mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByText('Pedido #55'));
    await screen.findByText(/venda: aberta/);

    const expedir = screen.getByText('Expedir') as HTMLButtonElement;
    expect(expedir.disabled).toBe(false);
    fireEvent.click(expedir);

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/vendas/55/expedicao/expedir', {}));
  });

  it('aba de divergências lista as abertas e exige descrição para resolver', async () => {
    mockRotas({
      '/vendas': { rows: [], total: 0, page: 1, pageSize: 50 },
      '/expedicao/divergencias': {
        rows: [
          { id: 9, venda_id: 55, esperado: 3, lido: 2, faltando: 1, sobrando: 0, resolvido_em: null, resolucao: null, criado_em: '2026-10-07T10:00:00.000Z' },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      },
    });
    apiPost.mockResolvedValue({ id: 9 } as never);
    renderPage();

    fireEvent.click(await screen.findByText(/Divergências/));
    expect(await screen.findByText('aberta')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Resolver'));
    expect(await screen.findByText(/Resolver divergência #9/)).toBeInTheDocument();

    // Menos de 5 caracteres não registra — o servidor também recusa.
    const area = screen.getByPlaceholderText(/peça localizada/i);
    fireEvent.change(area, { target: { value: 'ok' } });
    expect((screen.getByText('Registrar resolução') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(area, { target: { value: 'Peça reposta no depósito e cliente avisado.' } });
    fireEvent.click(screen.getByText('Registrar resolução'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/expedicao/divergencias/9/resolver', {
        resolucao: 'Peça reposta no depósito e cliente avisado.',
      })
    );
  });
});
