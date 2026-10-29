// ============================================================================
// COMMERCE — /commerce/loja (configuração da vitrine + frete da loja).
// Contrato: config real da tabela commerce_configuracoes, frete editável
// (nenhum|retirada|manual), save por ROTA (ZERO MODAL), erro honesto.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/ui';
import CommerceLojaConfigPage from './LojaConfigPage';

vi.mock('../../lib/api', () => ({
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
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Gerente Teste', perfil: 'admin' } }),
}));

import { apiFetch, ApiError } from '../../lib/api';
const fetchMock = vi.mocked(apiFetch);

const CONFIG = {
  rows: [
    {
      id: 3,
      loja_nome: 'BROBOND Store',
      loja_descricao: 'Vitrine oficial',
      frete_provedor: 'manual',
      frete_valor: 20,
      frete_gratis_acima: 300,
      frete_prazo_dias: 5,
      checkout_usuario_id: 1,
      checkout_expira_minutos: 60,
    },
  ],
};

function renderPagina() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/commerce/loja']}>
        <CommerceLojaConfigPage />
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Commerce — Configuração da loja (/commerce/loja)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('carrega a configuração real e aplica frete manual com prazo/valor', async () => {
    fetchMock.mockResolvedValue(CONFIG);
    renderPagina();
    expect(await screen.findByDisplayValue('BROBOND Store')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('salvar grava via PUT na própria tela (nada de modal de confirmação)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'PUT' || init?.method === 'POST') return { ok: true };
      return CONFIG;
    });
    const user = userEvent.setup();
    renderPagina();
    await screen.findByDisplayValue('BROBOND Store');
    const salvar = screen.getByRole('button', { name: /salvar/i });
    await user.click(salvar);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/commerce_configuracoes/3', expect.objectContaining({ method: 'PUT' }))
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('erro da API vira Alert honesto', async () => {
    fetchMock.mockImplementation(async () => { throw new ApiError(409, 'Configuração bloqueada por outro processo.'); });
    renderPagina();
    expect(await screen.findByText('Configuração bloqueada por outro processo.')).toBeInTheDocument();
  });
});
