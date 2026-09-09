import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import * as AuthContext from '../auth/AuthContext';

// Mocka o AuthContext inteiro: o objetivo aqui é testar a TELA de login (validação,
// exibição de erro, alternância de etapa de MFA), não a integração real com a API.
vi.mock('../auth/AuthContext', async () => {
  const actual = await vi.importActual<typeof AuthContext>('../auth/AuthContext');
  return { ...actual, useAuth: vi.fn() };
});

const useAuthMock = vi.mocked(AuthContext.useAuth);

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Login />
    </MemoryRouter>
  );
}

function baseAuth(overrides: Partial<ReturnType<typeof AuthContext.useAuth>> = {}) {
  return {
    user: null,
    meta: null,
    login: vi.fn(),
    mfaDesafio: vi.fn(),
    concluirLoginMFA: vi.fn(),
    logout: vi.fn(),
    refreshMeta: vi.fn(),
    loading: false,
    ...overrides,
  } as ReturnType<typeof AuthContext.useAuth>;
}

describe('Login', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  it('mostra o spinner de carregamento enquanto a sessão é verificada', () => {
    useAuthMock.mockReturnValue(baseAuth({ loading: true }));
    renderLogin();
    expect(screen.getByText('Carregando...')).toBeInTheDocument();
  });

  it('exige e-mail e senha antes de habilitar o botão de entrar', () => {
    useAuthMock.mockReturnValue(baseAuth());
    renderLogin();
    expect(screen.getByRole('button', { name: /Entrar/ })).toBeDisabled();
  });

  it('chama login() com e-mail e senha ao enviar o formulário', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({});
    useAuthMock.mockReturnValue(baseAuth({ login }));
    renderLogin();

    await user.type(screen.getByLabelText('E-mail'), 'admin@brobond.com.br');
    await user.type(screen.getByLabelText('Senha'), 'senha-super-secreta');
    await user.click(screen.getByRole('button', { name: /Entrar/ }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('admin@brobond.com.br', 'senha-super-secreta', false));
  });

  it('exibe a mensagem de erro (role=alert) quando o login falha', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockRejectedValue(new Error('Credenciais inválidas.'));
    useAuthMock.mockReturnValue(baseAuth({ login }));
    renderLogin();

    await user.type(screen.getByLabelText('E-mail'), 'admin@brobond.com.br');
    await user.type(screen.getByLabelText('Senha'), 'senha-errada');
    await user.click(screen.getByRole('button', { name: /Entrar/ }));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Credenciais inválidas.');
  });

  it('avança para a etapa de MFA quando o login exige verificação em dois fatores', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ mfa_required: true, mfa_ticket: 'ticket-123' });
    useAuthMock.mockReturnValue(baseAuth({ login }));
    renderLogin();

    await user.type(screen.getByLabelText('E-mail'), 'admin@brobond.com.br');
    await user.type(screen.getByLabelText('Senha'), 'senha-super-secreta');
    await user.click(screen.getByRole('button', { name: /Entrar/ }));

    expect(await screen.findByText('Verificação em dois fatores')).toBeInTheDocument();
    expect(screen.getByLabelText(/Código do app autenticador/)).toBeInTheDocument();
  });

  it('alterna entre "app autenticador" e "recuperação" na etapa de MFA', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ mfa_required: true, mfa_ticket: 'ticket-123' });
    useAuthMock.mockReturnValue(baseAuth({ login }));
    renderLogin();

    await user.type(screen.getByLabelText('E-mail'), 'admin@brobond.com.br');
    await user.type(screen.getByLabelText('Senha'), 'senha-super-secreta');
    await user.click(screen.getByRole('button', { name: /Entrar/ }));
    await screen.findByText('Verificação em dois fatores');

    await user.click(screen.getByRole('tab', { name: 'Recuperação' }));
    expect(screen.getByLabelText('Código de recuperação')).toBeInTheDocument();
  });
});
