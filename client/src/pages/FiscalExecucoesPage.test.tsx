// ============================================================================
// EXECUÇÕES FISCAIS — contrato de tela (obrigação → execução → evidência)
//   • histórico por obrigação e competência, idempotente;
//   • leiaute SPED/EFD registra NAO_SUPORTADO — nenhum VALIDADO inventado;
//   • evidências são append-only (referência + SHA-256 + tamanho).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FiscalExecucoesPage from './FiscalExecucoesPage';
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
  useParams: () => ({ id: '12' }),
  useNavigate: () => vi.fn(),
}));

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const EXECUCAO = {
  id: 90,
  periodo: '2026-09',
  status: 'NAO_SUPORTADO',
  started_at: '2026-10-01T00:00:00.000Z',
  finished_at: '2026-10-01T00:00:01.000Z',
  executed_by: 1,
  versao: 'n/a',
  execution_hash: 'abc123',
  resultado: 'NAO_SUPORTADO',
};

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/execucoes')) return { execucoes: [EXECUCAO] } as never;
    if (path.endsWith('/evidencias')) return [{ id: 1, arquivo_ref: 'arquivo.zip', hash_sha256: 'def456', tamanho_bytes: 1024, timestamp: '2026-10-01T00:00:00.000Z', resultado: 'NAO_SUPORTADO' }] as never;
    return [] as never;
  });
  apiPost.mockResolvedValue({ ...EXECUCAO, idempotente: false, layout_suportado: false } as never);
});

function montar() {
  return render(
    <ToastProvider>
      <FiscalExecucoesPage />
    </ToastProvider>
  );
}

describe('FiscalExecucoesPage', () => {
  it('mostra o histórico e as evidências por execução', async () => {
    montar();
    expect(await screen.findByText('Execuções fiscais')).toBeInTheDocument();
    expect(screen.getByText('2026-09')).toBeInTheDocument();
    expect(screen.getAllByText('NAO_SUPORTADO').length).toBeGreaterThan(0);
    expect(screen.getByText(/arquivo\.zip/)).toBeInTheDocument();
    expect(screen.getByText(/não suportado/i)).toBeInTheDocument();
  });

  it('registrar tentativa é idempotente e não inventa VALIDADO', async () => {
    montar();
    await screen.findByText('Execuções fiscais');
    fireEvent.click(screen.getByRole('button', { name: /Registrar execução/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fiscal/obrigacoes/12/execucoes', { periodo: expect.any(String) }));
    expect(screen.queryByText('VALIDADO')).not.toBeInTheDocument();
  });

  it('evidência é registrada apenas com metadados (append-only)', async () => {
    montar();
    await screen.findByText('Execuções fiscais');
    fireEvent.change(screen.getByLabelText('Execução'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Referência de arquivo'), { target: { value: 'novo.zip' } });
    fireEvent.change(screen.getByLabelText('SHA-256'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('Tamanho em bytes'), { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar evidência/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fiscal/execucoes/90/evidencias', { arquivo_ref: 'novo.zip', hash_sha256: 'abc', tamanho_bytes: 2048 }));
  });

  it('erro do servidor é exibido', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'Não foi possível carregar o histórico fiscal.') as never);
    montar();
    expect(await screen.findByText('Não foi possível carregar o histórico fiscal.')).toBeInTheDocument();
  });
});
