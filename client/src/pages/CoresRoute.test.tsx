// ============================================================================
// ROTAS DE CORES — o roteador REAL do ERP (App.tsx).
//
// Os testes de ModulePage provam que a lista NAVEGA para /cores/novo e
// /cores/:id/editar; os testes de CorFormPage provam a página. Falta o elo do
// meio: o App precisa REGISTRAR essas rotas (ModuleAccess do módulo `cores`).
// Este arquivo cobre exatamente isso, no BrowserRouter de verdade — e repete a
// garantia visual: nenhum `role="dialog"`/`aria-modal` é montado.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.status = status;
      this.fields = fields;
    }
  },
  downloadFile: vi.fn(),
  setToken: vi.fn(),
  getToken: () => 'token-de-teste',
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, name: 'Gerente', email: 'gerente@brobond.com.br', perfil: 'gerente' },
    meta: { version: '0.6.0', mode: 'memory' },
    logout: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  const cores = {
    key: 'cores',
    label: 'Cores',
    singular: 'Cor',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, placeholder: 'Azul marinho' },
      { name: 'hex', label: 'Código HEX', type: 'color' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { cores }, modules: [], mode: 'memory' }),
  };
});

const EMPRESAS = {
  empresa_id: 1,
  empresa: 'BroBond Wear',
  consolidado: false,
  pode_consolidar: false,
  empresa_padrao: 1,
  empresas: [{ id: 1, nome: 'BroBond Wear', cnpj: null, ativa: true }],
};

const apiGet = vi.mocked(api.get);

/** Abre o App (BrowserRouter real) já na rota pedida. */
function abrirRota(rota: string) {
  window.history.pushState({}, '', rota);
  return render(
    <ToastProvider>
      <App />
    </ToastProvider>
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/empresas/ativa') return EMPRESAS as never;
    if (String(path) === '/cores/4') return { id: 4, nome: 'Cinza mescla', hex: '#9CA3AF', ativo: true } as never;
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Cores (LISTA → PÁGINA)', () => {
  it('/cores/novo é uma rota registrada e abre a página "Nova cor" (sem modal/drawer)', async () => {
    abrirRota('/cores/novo');

    expect(await screen.findByRole('heading', { name: /Nova cor/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/cores/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/cores');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('/cores/:id/editar é uma rota registrada e abre a página "Editar cor"', async () => {
    abrirRota('/cores/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar cor/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Cinza mescla'));
    expect(window.location.pathname).toBe('/cores/4/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
