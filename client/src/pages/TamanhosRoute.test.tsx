// ============================================================================
// ROTAS DE TAMANHOS — o roteador REAL do ERP (App.tsx).
//
// Os testes de TamanhoFormPage provam a página; os de TamanhosPage provam que a
// lista NAVEGA para /tamanhos/novo e /tamanhos/:id/editar. Falta o elo do meio:
// o App precisa REGISTRAR essas rotas (ModuleAccess do módulo `tamanhos`). Este
// arquivo cobre exatamente isso, no BrowserRouter de verdade — e repete a
// garantia visual: nenhum `role="dialog"`/`aria-modal` é montado em nenhuma das
// rotas do cadastro.
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
  const tamanhos = {
    key: 'tamanhos',
    label: 'Tamanhos / Grade',
    singular: 'Tamanho',
    labelFields: ['codigo'],
    // Catálogo COMPARTILHADO (global): escrita gerente+.
    minPerfilEscrita: 'gerente' as const,
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true, unique: true, search: true, list: true, maxLength: 10 },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, list: true, maxLength: 60 },
      { name: 'ordem', label: 'Ordem na grade', type: 'integer', min: 0, default: 0, list: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { tamanhos }, modules: [], mode: 'memory' }),
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
    if (String(path) === '/tamanhos/4') return { id: 4, codigo: 'G', descricao: 'Grande', ordem: 4 } as never;
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Tamanhos (LISTA → PÁGINA)', () => {
  it('/tamanhos continua sendo a lista (tela principal) do módulo', async () => {
    abrirRota('/tamanhos');

    expect(await screen.findByRole('heading', { name: 'Tamanhos' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/tamanhos');
    // A listagem consome o contrato existente, sem modal nenhum aberto.
    await waitFor(() => expect(apiGet.mock.calls.some(([p]) => String(p).startsWith('/tamanhos?'))).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('/tamanhos/novo é uma rota registrada e abre a página "Novo tamanho" (sem modal/drawer)', async () => {
    abrirRota('/tamanhos/novo');

    expect(await screen.findByRole('heading', { name: /Novo tamanho/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/tamanhos/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/tamanhos');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('/tamanhos/:id/editar é uma rota registrada e abre a página "Editar tamanho"', async () => {
    abrirRota('/tamanhos/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar tamanho/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Código/)).toHaveValue('G'));
    expect(window.location.pathname).toBe('/tamanhos/4/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
