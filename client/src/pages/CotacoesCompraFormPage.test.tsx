// ============================================================================
// COTAÇÃO DE COMPRA — formulário de criação em PÁGINA PRÓPRIA (ZERO MODAL)
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CotacoesCompraFormPage from './CotacoesCompraFormPage';
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

const authMock = { user: { perfil: 'gerente' } as { perfil: string } | null };
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authMock,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

const apiPost = vi.mocked(api.post);

beforeEach(() => {
  vi.clearAllMocks();
  apiPost.mockResolvedValue({ id: 55 } as never);
});

function montar() {
  return render(
    <ToastProvider>
      <CotacoesCompraFormPage />
    </ToastProvider>
  );
}

describe('CotacoesCompraFormPage', () => {
  it('exige título antes do POST e não navega', async () => {
    montar();
    expect(await screen.findByText('Nova cotação de compra')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Criar cotação/ }));
    await waitFor(() => expect(screen.getByText('Dê um título à cotação.')).toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('cria a cotação e navega para o documento em /cotacoes-compra/:id', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText('Título'), { target: { value: 'Cotação de linhas' } });
    fireEvent.change(screen.getByLabelText('Validade das propostas'), { target: { value: '2026-11-30' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar cotação/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/cotacoes_compra', {
        titulo: 'Cotação de linhas',
        criterio: 'menor_preco',
        prazo_validade: '2026-11-30',
      })
    );
    expect(navigateMock).toHaveBeenCalledWith('/cotacoes-compra/55');
  });

  it('erro do servidor é exibido na página (sem modal)', async () => {
    apiPost.mockRejectedValue(new ApiError(422, 'Título em uso.') as never);
    montar();
    fireEvent.change(await screen.findByLabelText('Título'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar cotação/ }));
    expect((await screen.findAllByText('Título em uso.')).length).toBeGreaterThan(0);
  });
});
