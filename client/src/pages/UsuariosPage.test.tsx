// ============================================================================
// Painel de consulta de usuários: barra de comando, visões rápidas e o caixabox
// de filtros.
//
// Motivo: a tela concentra as decisões de acesso do ERP (perfil, status, senha,
// MFA). Os testes travam o contrato de uso — os filtros ficam dobrados até serem
// pedidos, cada visão aplica o recorte certo, os filtros ativos aparecem como
// chips removíveis e as etiquetas da lista saem em CAIXA (ícone em caixinha +
// rótulo textual), nunca como bolinha colorida.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import UsuariosPage from './UsuariosPage';
import { ToastProvider } from '../components/ui';
import * as AuthContext from '../auth/AuthContext';
import { api } from '../lib/api';

vi.mock('../auth/AuthContext', async () => {
  const actual = await vi.importActual<typeof AuthContext>('../auth/AuthContext');
  return { ...actual, useAuth: vi.fn() };
});

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {},
  downloadFile: vi.fn(),
}));

const useAuthMock = vi.mocked(AuthContext.useAuth);
const apiGet = vi.mocked(api.get);

const RESUMO = {
  totais: {
    total: 42,
    ativos: 30,
    inativos: 12,
    admins: 3,
    gerentes: 9,
    operadores: 20,
    convites_pendentes: 2,
    convites_expirados: 1,
    troca_pendente: 4,
    mfa_ativos: 7,
    bloqueados: 1,
    sem_login_30d: 5,
    nao_certificados: 6,
    logins_hoje: 8,
    falhas_24h: 2,
    acesso_expirado: 1,
    sessoes_ativas: 11,
  },
  alertas: [],
  serie_logins_7d: [],
};

function usuario(id: number, nome: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    nome,
    email: `${nome.split(' ')[0]!.toLowerCase()}@brobond.com.br`,
    perfil: 'admin',
    ativo: true,
    status_conta: 'ativo',
    senha_status: 'propria',
    mfa_ativado_em: null,
    ultimo_login: new Date().toISOString(),
    ...extras,
  };
}

const LISTA = {
  rows: [
    usuario(1, 'Ana Administradora', { id: 1 }),
    usuario(2, 'Bruno Operador', { id: 2, perfil: 'operador', mfa_ativado_em: new Date().toISOString() }),
  ],
  total: 2,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/usuarios']}>
      <ToastProvider>
        <UsuariosPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  apiGet.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/usuarios/resumo')) return RESUMO as never;
    if (String(path).startsWith('/usuarios?')) return LISTA as never;
    return {} as never;
  });
  useAuthMock.mockReturnValue({
    user: { id: 1, name: 'Ana Administradora', email: 'ana@brobond.com.br', perfil: 'admin' },
    meta: { emailLinks: { configurada: true, base: 'https://erp.brobond.com.br', publica: true, appUrlIgnorada: false } },
    login: vi.fn(),
    mfaDesafio: vi.fn(),
    concluirLoginMFA: vi.fn(),
    logout: vi.fn(),
    refreshMeta: vi.fn(),
    loading: false,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
});

describe('Usuários — painel de consulta', () => {
  it('abre com as visões rápidas prontas e o caixabox de filtros visível', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Administradores/ })).toBeInTheDocument());
    // Contagem de cada recorte vem do resumo gerencial.
    expect(screen.getByRole('tab', { name: /Administradores/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Com MFA/ })).toHaveTextContent('7');
    // O caixabox de filtros nasce aberto e o botão reflete o estado.
    expect(screen.getByLabelText('Filtrar por perfil')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filtros/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('dobra/desdobra o caixabox, aplica um recorte e mostra o chip removível', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Todos/ })).toBeInTheDocument());

    // Dobrar esconde os controles (e o filtro aplicado continua valendo).
    await user.click(screen.getByRole('button', { name: /Filtros/ }));
    await waitFor(() => expect(screen.queryByLabelText('Filtrar por perfil')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Filtros/ }));
    const select = await screen.findByLabelText('Filtrar por perfil');
    await user.selectOptions(select, 'admin');

    await waitFor(() => expect(screen.getByText('Filtros ativos')).toBeInTheDocument());
    const chip = screen.getByLabelText('Remover filtro Perfil');
    // O pedido à API leva o filtro.
    await waitFor(() => expect(apiGet.mock.calls.some(([p]) => String(p).includes('f.perfil=admin'))).toBe(true));
    // O botão da barra de comando conta os filtros ativos.
    expect(screen.getByRole('button', { name: /Filtros/ })).toHaveTextContent('1');

    await user.click(chip);
    await waitFor(() => expect(screen.queryByText('Filtros ativos')).not.toBeInTheDocument());
  });

  it('a visão "Administradores" aplica o recorte e "Limpar" zera tudo', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Administradores/ })).toBeInTheDocument());

    await user.click(screen.getByRole('tab', { name: /Administradores/ }));
    await waitFor(() => expect(apiGet.mock.calls.some(([p]) => String(p).includes('f.perfil=admin'))).toBe(true));

    // "Limpar" é o botão da barra de comando ("Limpar tudo" é o do rodapé dos chips).
    await user.click(screen.getByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(screen.queryByText('Filtros ativos')).not.toBeInTheDocument());
  });

  it('mostra as etiquetas da lista em caixa, com rótulo textual e dica (title)', async () => {
    renderPage();
    // A lista é renderizada duas vezes (tabela no desktop, cartões no celular).
    await waitFor(() => expect(screen.getAllByText('Ana Administradora').length).toBeGreaterThan(0));
    // Etiqueta de perfil: caixa com rótulo escrito (não depende de cor/bola).
    const linha = screen.getAllByText('Ana Administradora')[0]!.closest('tr')!;
    expect(within(linha).getByTitle('Acesso total, incluindo usuários e auditoria')).toBeInTheDocument();
    // MFA pendente para admin, ativado para o operador.
    expect(within(linha).getByTitle('MFA é obrigatório para administradores')).toBeInTheDocument();
    const linhaOperador = screen.getAllByText('Bruno Operador')[0]!.closest('tr')!;
    expect(within(linhaOperador).getByTitle('Segundo fator ativo nesta conta')).toBeInTheDocument();
  });
});
