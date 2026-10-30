// ============================================================================
// ROTAS DE INSUMOS — o roteador REAL do ERP (App.tsx).
//
// Os testes de InsumosPage provam que a lista NAVEGA para /insumos/novo e
// /insumos/:id/editar; os de InsumoFormPage provam a página. Falta o elo do
// meio: o App precisa REGISTRAR essas rotas (ModuleAccess do módulo
// `insumos`). Este arquivo cobre exatamente isso, no BrowserRouter de verdade —
// e repete a garantia visual: nenhum `role="dialog"`/`aria-modal` é montado.
//
// Também cobre a LINHA: a lista continua em /insumos (o módulo do App), sem
// formulário sobreposto.
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
  // ESPELHO de server/src/resources.ts › insumos (sem campo inventado).
  const insumos = {
    key: 'insumos',
    label: 'Insumos',
    singular: 'Insumo',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    filterFields: ['categoria_id', 'unidade', 'fornecedor_id', 'ativo'],
    fields: [
      { name: 'codigo_insumo', label: 'Código', type: 'text', uniqueEmpresa: true, maxLength: 40 },
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 120 },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias_insumos' },
      {
        name: 'unidade',
        label: 'Unidade',
        type: 'select',
        required: true,
        default: 'un',
        options: [
          { value: 'un', label: 'Unidade (un)' },
          { value: 'm', label: 'Metro (m)' },
        ],
      },
      { name: 'custo_medio', label: 'Custo médio', type: 'money', min: 0, default: 0 },
      { name: 'fornecedor_id', label: 'Fornecedor principal', type: 'ref', ref: 'fornecedores' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  const fornecedores = {
    key: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    fields: [{ name: 'nome', label: 'Nome', type: 'text', required: true }],
  };
  const categorias_insumos = {
    key: 'categorias_insumos',
    label: 'Categorias de Insumos',
    singular: 'Categoria de insumo',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 60 },
      { name: 'descricao', label: 'Descrição', type: 'text', maxLength: 160 },
      { name: 'pai_id', label: 'Categoria-pai', type: 'ref', ref: 'categorias_insumos' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { insumos, fornecedores, categorias_insumos }, modules: [], mode: 'memory' }),
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
    if (String(path) === '/insumos/4') {
      return { id: 4, nome: 'Malha penteada', unidade: 'm', custo_medio: 12.5, fornecedor_id: 1, ativo: true } as never;
    }
    if (String(path) === '/fornecedores/options') return [{ value: 1, label: 'Têxtil Bella' }] as never;
    if (String(path) === '/categorias_insumos/options') return [{ value: 10, label: 'Malhas' }] as never;
    if (String(path) === '/categorias_insumos/7') {
      return { id: 7, nome: 'Aviamentos', descricao: null, pai_id: null, ativo: true } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Insumos (LISTA → PÁGINA)', () => {
  it('/insumos continua sendo a LISTA (sem formulário sobreposto)', async () => {
    abrirRota('/insumos');

    expect(await screen.findByRole('heading', { name: 'Insumos' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Novo insumo/ }).length).toBeGreaterThan(0);
    // A lista NÃO abre nenhum formulário por conta própria.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
  });

  it('/insumos/novo é uma rota registrada e abre a página "Novo insumo" (sem modal/drawer)', async () => {
    abrirRota('/insumos/novo');

    expect(await screen.findByRole('heading', { name: /Novo insumo/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/insumos/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/insumos');
    // O formulário vive na ROTA, nunca sobreposto à lista.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
  });

  it('/insumos/:id/editar é uma rota registrada e abre a página "Editar insumo"', async () => {
    abrirRota('/insumos/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar insumo/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Malha penteada'));
    expect(window.location.pathname).toBe('/insumos/4/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});

describe('App — rotas de Categorias de Insumos (LISTA → PÁGINA)', () => {
  it('/categorias-insumos/novo abre a página "Nova categoria de insumo" (sem modal/drawer)', async () => {
    abrirRota('/categorias-insumos/novo');

    expect(await screen.findByRole('heading', { name: /Nova categoria de insumo/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/categorias-insumos/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/categorias-insumos');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
  });

  it('/categorias-insumos/:id/editar abre a página "Editar categoria de insumo"', async () => {
    abrirRota('/categorias-insumos/7/editar');

    expect(await screen.findByRole('heading', { name: /Editar categoria de insumo/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Aviamentos'));
    expect(window.location.pathname).toBe('/categorias-insumos/7/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
