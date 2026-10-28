// ============================================================================
// OBRIGAÇÃO FISCAL (detalhe) — contrato de tela
//   • obrigação → execuções em um clique (rota direta);
//   • leiaute SPED/EFD é explicitamente não suportado (nada fabricado).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FiscalObrigacaoDetalhePage from './FiscalObrigacaoDetalhePage';
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FiscalObrigacaoDetalhePage', () => {
  it('mostra a obrigação e oferece as execuções em um clique', async () => {
    apiGet.mockResolvedValue({
      id: 12,
      codigo: 'EFD-ICMS/IPI',
      nome: 'Escrituração Fiscal Digital',
      tipo: 'Escrituração',
      periodicidade: 'Mensal',
      dia_vencimento: 10,
      responsavel_id__label: 'Gerente Fiscal',
      ativo: true,
    } as never);
    render(<FiscalObrigacaoDetalhePage />);
    expect(await screen.findByText('Escrituração Fiscal Digital')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /execuções/i });
    expect(link).toHaveAttribute('href', '/fiscal/obrigacoes/12/execucoes');
    expect(screen.getByText(/não suportados/i)).toBeInTheDocument();
  });

  it('erro do servidor é exibido', async () => {
    apiGet.mockRejectedValue(new ApiError(404, 'Obrigação não encontrada.') as never);
    render(<FiscalObrigacaoDetalhePage />);
    expect(await screen.findByText('Obrigação não encontrada.')).toBeInTheDocument();
  });
});
