// ============================================================================
// ROTAS DE COLEÇÕES — o roteador REAL do ERP (App.tsx).
//
// Os testes de ColecoesPage provam que a lista NAVEGA para /colecoes/novo e
// /colecoes/:id/editar; os testes de ColecaoFormPage provam a página. Falta o
// elo do meio: o App precisa REGISTRAR essas rotas (ModuleAccess do módulo
// `colecoes`). Este arquivo cobre exatamente isso, no BrowserRouter de verdade
// — e repete a garantia visual: nenhum `role="dialog"`/`aria-modal` é montado.
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
  const colecoes = {
    key: 'colecoes',
    label: 'Coleções',
    singular: 'Coleção',
    labelFields: ['nome'],
    // Cadastro POR EMPRESA: sem minPerfilEscrita.
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, placeholder: 'Verão 2027' },
      { name: 'temporada', label: 'Temporada', type: 'select', options: [{ value: 'Verão', label: 'Verão' }] },
      { name: 'ano', label: 'Ano', type: 'integer', min: 2000, max: 2100 },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { colecoes }, modules: [], mode: 'memory' }),
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
    if (String(path) === '/colecoes/4') return { id: 4, nome: 'Verão 2027', temporada: 'Verão', ano: 2027, ativo: true } as never;
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Coleções (LISTA → PÁGINA)', () => {
  it('/colecoes/novo é uma rota registrada e abre a página "Nova coleção" (sem modal/drawer)', async () => {
    abrirRota('/colecoes/novo');

    expect(await screen.findByRole('heading', { name: /Nova coleção/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/colecoes/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/colecoes');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('/colecoes/:id/editar é uma rota registrada e abre a página "Editar coleção"', async () => {
    abrirRota('/colecoes/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar coleção/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Verão 2027'));
    expect(window.location.pathname).toBe('/colecoes/4/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
