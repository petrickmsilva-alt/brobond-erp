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

const ESTADO = {
  configuracao: CONFIG.rows[0], empresa_id: 1, status: 'CONFIGURADO', abrir_loja: true,
  vitrine_disponivel: true, frete_configurado: true, responsavel_checkout_id: 1, pendencias: [],
  pagamento: { origem: 'ambiente_commerce', configurado: true, ativo: true, tem_token: true, tem_webhook: true, ambiente: 'teste', conexao_validada: false, credenciais_ambiente_detectadas: true },
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
    fetchMock.mockResolvedValue(ESTADO);
    renderPagina();
    expect(await screen.findByDisplayValue('BROBOND Store')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'Abrir a Loja' })).toHaveAttribute('href', '/loja');
    expect(fetchMock).toHaveBeenCalledWith('/commerce/loja/estado');
  });

  it('salvar grava via PUT na própria tela (nada de modal de confirmação)', async () => {
    fetchMock.mockImplementation(async (caminho: string, init?: RequestInit) => {
      if (init?.method === 'PUT' || init?.method === 'POST') return { ok: true };
      return ESTADO;
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
  it('nome/frete ainda não salvos não habilitam Abrir a Loja; mostra requisito e caminho', async () => {
    fetchMock.mockResolvedValue({ ...ESTADO, abrir_loja: false, frete_configurado: false,
      configuracao: { ...CONFIG.rows[0], frete_provedor: 'nenhum' },
      pendencias: [{ codigo: 'frete', mensagem: 'Selecione e salve o provedor de frete.', caminho: '/commerce/loja#frete' }],
    });
    const user = userEvent.setup();
    const { container } = renderPagina();
    expect(await screen.findByRole('button', { name: 'Abrir a Loja' })).toBeDisabled();
    expect(screen.getByText('Selecione e salve o provedor de frete.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver configuração' })).toHaveAttribute('href', '/commerce/loja#frete');
    await user.selectOptions(screen.getByLabelText('Provedor'), 'retirada');
    expect(screen.getByRole('button', { name: 'Abrir a Loja' })).toBeDisabled();
    expect(container.querySelector('dialog, [role="dialog"], [aria-modal]')).toBeNull();
  });

  it('responsável editável é persistido no mesmo PUT', async () => {
    fetchMock.mockResolvedValue(ESTADO);
    const user = userEvent.setup();
    renderPagina();
    const responsavel = await screen.findByLabelText('Responsável pelo checkout (ID do usuário)');
    await user.clear(responsavel);
    await user.type(responsavel, '42');
    await user.click(screen.getByRole('button', { name: /salvar configuração/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/commerce_configuracoes/3', expect.objectContaining({ body: expect.stringContaining('"checkout_usuario_id":42') })));
  });

  it('falha no diagnóstico nunca mantém botão de abertura aparentemente ativo', async () => {
    fetchMock.mockRejectedValue(new ApiError(503, 'Banco indisponível.'));
    renderPagina();
    expect(await screen.findByText('Banco indisponível.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir a Loja' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Abrir a Loja' })).toBeNull();
  });

});
