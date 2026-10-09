// ============================================================================
// ORDEM DE FABRICAÇÃO (detalhe) — contrato de tela do fluxo E2
//
// O que estes testes protegem:
//   • cada estado mostra exatamente as ações que a máquina de estados permite
//     (o botão errado é o jeito mais fácil de produzir estoque falso);
//   • liberar/iniciar chamam os endpoints de fluxo, não o PUT genérico;
//   • cancelar pede motivo e vai para /cancelar (não para PUT status);
//   • o apontamento manda chave de idempotência, então repetir o clique não
//     baixa insumo duas vezes;
//   • falta de saldo oferece forçar SÓ para gerente/admin, e diz o efeito;
//   • custo previsto × custo real e a trilha aparecem com o dado do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrdemDetail from './OrdemDetail';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';

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

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: '77' }),
}));

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

vi.mock('../lib/meta', () => ({
  useMeta: () => ({
    resources: {
      ordens: { ops: { update: true }, fields: [{ name: 'etapa', options: [{ value: 'corte', label: 'Corte' }] }] },
    },
  }),
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function ordem(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    produto_id: 5,
    tipo: 'tamanho',
    tamanho_id: 3,
    quantidade: 20,
    status: 'planejada',
    etapa: 'corte',
    quantidade_produzida: 0,
    quantidade_perdida: 0,
    custo_previsto: null,
    custo_real: 0,
    ...overrides,
  };
}

function mockGet(o: Record<string, unknown>, apontamentos: unknown[] = [], eventos: unknown[] = []) {
  apiGet.mockImplementation((path: string) => {
    if (String(path).startsWith('/ordens/77/itens')) return Promise.resolve([]);
    if (String(path).startsWith('/ordens/77/apontamentos')) return Promise.resolve(apontamentos);
    if (String(path).startsWith('/ordens/77/eventos')) return Promise.resolve(eventos);
    if (String(path).includes('/options')) return Promise.resolve([{ value: 5, label: 'Camisa Polo' }, { value: 3, label: 'M' }]);
    return Promise.resolve(o);
  });
}

function montar() {
  return render(
    <ToastProvider>
      <OrdemDetail />
    </ToastProvider>
  );
}

describe('OrdemDetail — fluxo E2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.perfil = 'gerente';
  });

  it('OP planejada: libera, inicia, conclui e cancela — mas não aponta', async () => {
    mockGet(ordem());
    montar();
    expect(await screen.findByText(/Ordem de fabricação #77/)).toBeInTheDocument();
    expect(screen.getByText('Liberar para produção')).toBeInTheDocument();
    expect(screen.getByText('Iniciar produção')).toBeInTheDocument();
    expect(screen.getByText('Concluir OP')).toBeInTheDocument();
    expect(screen.getByText('Cancelar')).toBeInTheDocument();
    // nada foi produzido ainda: apontar não faz sentido aqui
    expect(screen.queryByText('Apontar produção')).not.toBeInTheDocument();
    expect(screen.getByText('Planejada')).toBeInTheDocument();
  });

  it('liberar chama POST /liberar (que congela o custo previsto), não o PUT genérico', async () => {
    mockGet(ordem());
    apiPost.mockResolvedValue(ordem({ status: 'liberada', custo_previsto: 600 }));
    montar();
    fireEvent.click(await screen.findByText('Liberar para produção'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/ordens/77/liberar', {}));
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('operador não vê liberar nem cancelar (são ações de gerente)', async () => {
    mockUser.perfil = 'operador';
    mockGet(ordem());
    montar();
    await screen.findByText(/Ordem de fabricação #77/);
    expect(screen.queryByText('Liberar para produção')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelar')).not.toBeInTheDocument();
    expect(screen.getByText('Iniciar produção')).toBeInTheDocument();
  });

  it('OP liberada aponta produção e mostra estado vazio de apontamentos', async () => {
    mockGet(ordem({ status: 'liberada', custo_previsto: 600 }));
    montar();
    expect(await screen.findByText('Apontar produção')).toBeInTheDocument();
    expect(screen.getByText('Liberada')).toBeInTheDocument();
    expect(screen.getByText(/Nenhuma produção apontada ainda/)).toBeInTheDocument();
    expect(screen.getByText('R$ 600,00')).toBeInTheDocument();
  });

  it('o apontamento manda chave de idempotência, tamanho e as perdas', async () => {
    mockGet(ordem({ status: 'em_producao' }));
    apiPost.mockResolvedValue({ id: 9, idempotente: false });
    montar();
    fireEvent.click(await screen.findByText('Apontar produção'));
    expect(await screen.findByText('Registrar apontamento')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Registrar apontamento'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [rota, corpo] = apiPost.mock.calls.find((c) => String(c[0]).includes('/apontamentos'))!;
    expect(String(rota)).toBe('/ordens/77/apontamentos');
    expect((corpo as any).quantidade_produzida).toBe(1);
    expect((corpo as any).quantidade_perdida).toBe(0);
    expect(String((corpo as any).idempotency_key)).toMatch(/^op-77-/);
  });

  it('falta de saldo: só gerente vê a saída de forçar, e ela explica o efeito', async () => {
    mockUser.perfil = 'operador';
    mockGet(ordem({ status: 'parcial', quantidade_produzida: 4 }));
    apiPost.mockRejectedValue(new ApiError(409, 'Sem saldo de insumos: Tecido Piquet (faltam 10 m).'));
    montar();
    fireEvent.click(await screen.findByText('Apontar'));
    fireEvent.click(await screen.findByText('Registrar apontamento'));
    expect(await screen.findByText(/Sem saldo de insumos/)).toBeInTheDocument();
    expect(screen.queryByText('Apontar forçando a baixa')).not.toBeInTheDocument();

    mockUser.perfil = 'gerente';
    mockGet(ordem({ status: 'parcial', quantidade_produzida: 4 }));
    apiPost.mockRejectedValue(new ApiError(409, 'Sem saldo de insumos: Tecido Piquet (faltam 10 m).'));
    montar();
    fireEvent.click(await screen.findByText('Apontar'));
    fireEvent.click(await screen.findByText('Registrar apontamento'));
    expect(await screen.findByText(/fica negativo e a ação fica auditada/)).toBeInTheDocument();
    expect(screen.getByText('Apontar forçando a baixa')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Apontar forçando a baixa'));
    await waitFor(() =>
      expect(apiPost.mock.calls.some((c) => String(c[0]).includes('/apontamentos?forcar=true'))).toBe(true)
    );
  });

  it('cancelar abre o motivo e vai para POST /cancelar', async () => {
    mockGet(ordem({ status: 'liberada' }));
    apiPost.mockResolvedValue(ordem({ status: 'cancelada' }));
    montar();
    fireEvent.click(await screen.findByText('Cancelar'));
    expect(await screen.findByText('Cancelar ordem de produção')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/cliente desistiu da cor/i), { target: { value: 'Insumo indisponível' } });
    fireEvent.click(screen.getByText('Cancelar OP'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/ordens/77/cancelar', { motivo: 'Insumo indisponível' }));
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('concluída: reabrir estorna e o custo real aparece; cancelar some (estado terminal)', async () => {
    mockGet(
      ordem({ status: 'concluida', quantidade_produzida: 20, custo_previsto: 600, custo_real: 640, concluida_em: '2026-10-01T12:00:00Z' }),
      [],
      [{ id: 1, evento: 'atalho', mensagem: 'Conclusão direta a partir de "Planejada"', criado_em: '2026-10-01T12:00:00Z', usuario_id__label: 'Ana' }]
    );
    apiPost.mockResolvedValue(ordem({ status: 'planejada' }));
    montar();
    expect(await screen.findByText('Concluída')).toBeInTheDocument();
    expect(screen.getByText('Reabrir (estorna)')).toBeInTheDocument();
    expect(screen.queryByText('Cancelar')).not.toBeInTheDocument();
    expect(screen.getByText('R$ 640,00')).toBeInTheDocument();
    // variação prevista × real
    expect(screen.getByText('+R$ 40,00')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Histórico da OP'));
    expect(await screen.findByText('Conclusão direta a partir de "Planejada"')).toBeInTheDocument();
    expect(screen.getByText('Atalho de fluxo')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Reabrir (estorna)'));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/ordens/77/reabrir', {}));
  });

  it('lista os apontamentos com boas e refugadas, e totaliza', async () => {
    mockGet(
      ordem({ status: 'parcial', quantidade_produzida: 8, quantidade_perdida: 2 }),
      [
        { id: 1, apontado_em: '2026-10-01T10:00:00Z', tamanho_id: 3, tamanho_id__label: 'M', quantidade_produzida: 5, quantidade_perdida: 1, usuario_id__label: 'Ana' },
        { id: 2, apontado_em: '2026-10-02T10:00:00Z', tamanho_id: 3, tamanho_id__label: 'M', quantidade_produzida: 3, quantidade_perdida: 1, usuario_id__label: 'Bruno' },
      ]
    );
    montar();
    expect(await screen.findByText('Apontamentos de produção')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Bruno')).toBeInTheDocument();
    expect(screen.getByText('Parcial')).toBeInTheDocument();
    // Totais do rodapé da tabela de apontamentos. Escopo no <tfoot> de propósito:
    // "8" e "2" também aparecem no cartão de custo, então getByText sozinho
    // acharia mais de um elemento e o teste provaria menos do que diz.
    const rodape = screen.getByText('Apontamentos de produção').closest('.card')!.querySelector('tfoot') as HTMLElement;
    expect(within(rodape).getAllByText('8')).toHaveLength(1);
    expect(within(rodape).getAllByText('2')).toHaveLength(1);
  });
});
