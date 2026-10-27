// ============================================================================
// ROTAS DE FORNECEDORES — o roteador REAL do ERP (App.tsx).
//
// Os testes de FornecedoresPage provam que a lista NAVEGA para
// /fornecedores/novo e /fornecedores/:id/editar; os de FornecedorFormPage
// provam a página. Falta o elo do meio: o App precisa REGISTRAR essas rotas
// (ModuleAccess do módulo `fornecedores`). Este arquivo cobre exatamente isso,
// no BrowserRouter de verdade — e repete a garantia visual: nenhum
// `role="dialog"`/`aria-modal` é montado (o cadastro de fornecedores deixou de
// ser um formulário sobreposto à lista).
//
// Também cobre a LINHA e o BREADCRUMB do shell:
//   /fornecedores            → LISTA (BROBOND ERP › Cadastros › Fornecedores)
//   /fornecedores/novo       → página "Novo fornecedor" (› Novo)
//   /fornecedores/:id/editar → página "Editar fornecedor" (› Editar)
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  // ESPELHO de server/src/resources.ts › fornecedores (sem campo inventado).
  const fornecedores = {
    key: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    filterFields: ['pessoa', 'uf', 'ativo'],
    fields: [
      { name: 'nome', label: 'Razão social / Nome', type: 'text', required: true, maxLength: 160, section: 'Identificação' },
      {
        name: 'pessoa',
        label: 'Tipo de pessoa',
        type: 'select',
        required: true,
        default: 'pj',
        section: 'Identificação',
        options: [
          { value: 'pj', label: 'Pessoa jurídica', tone: 'blue' },
          { value: 'pf', label: 'Pessoa física', tone: 'slate' },
          { value: 'estrangeiro', label: 'Estrangeiro', tone: 'amber' },
        ],
      },
      { name: 'cnpj', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20, section: 'Identificação' },
      { name: 'cidade', label: 'Cidade', type: 'text', maxLength: 80, list: false, section: 'Endereço' },
      { name: 'uf', label: 'UF', type: 'uf', maxLength: 2, list: false, section: 'Endereço' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { fornecedores }, modules: [], mode: 'memory' }),
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

function trilha() {
  return screen.getByRole('navigation', { name: 'Trilha de navegação' });
}

/** Nenhuma superfície sobreposta (modal, drawer, sheet, dialog) pode existir. */
function semSobreposicao() {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
}

beforeEach(() => {
  localStorage.clear();
  apiGet.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/empresas/ativa') return EMPRESAS as never;
    if (String(path) === '/fornecedores/4') {
      return {
        id: 4,
        nome: 'Têxtil Bella',
        pessoa: 'pj',
        cnpj: '12345678000195',
        cidade: 'Goiânia',
        uf: 'GO',
        ativo: true,
      } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Fornecedores (LISTA → PÁGINA)', () => {
  it('/fornecedores continua sendo a LISTA (sem formulário sobreposto) com o breadcrumb do módulo', async () => {
    abrirRota('/fornecedores');

    expect(await screen.findByRole('heading', { name: 'Fornecedores' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Novo fornecedor/ }).length).toBeGreaterThan(0);
    // A lista NÃO abre nenhum formulário por conta própria.
    semSobreposicao();

    // Breadcrumb do shell: BROBOND ERP › Cadastros › Fornecedores (página atual).
    await waitFor(() => expect(trilha()).toBeInTheDocument());
    const nav = trilha();
    expect(within(nav).getByText('Cadastros')).toBeInTheDocument();
    const folhas = within(nav).getAllByText('Fornecedores');
    expect(folhas[folhas.length - 1]).toHaveAttribute('aria-current', 'page');
  });

  it('/fornecedores/novo é uma rota registrada e abre a página "Novo fornecedor" (sem modal/drawer)', async () => {
    abrirRota('/fornecedores/novo');

    expect(await screen.findByRole('heading', { name: /Novo fornecedor/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/fornecedores/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/fornecedores');
    // O formulário vive na ROTA, nunca sobreposto à lista.
    semSobreposicao();

    // Breadcrumb: BROBOND ERP › Cadastros › Fornecedores (link) › Novo.
    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'Fornecedores' })).toHaveAttribute('href', '/fornecedores');
    expect(within(nav).getByText('Novo')).toHaveAttribute('aria-current', 'page');
  });

  it('/fornecedores/:id/editar é uma rota registrada e abre a página "Editar fornecedor"', async () => {
    abrirRota('/fornecedores/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar fornecedor/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Razão social \/ Nome/)).toHaveValue('Têxtil Bella'));
    expect(window.location.pathname).toBe('/fornecedores/4/editar');
    semSobreposicao();

    // Breadcrumb: BROBOND ERP › Cadastros › Fornecedores (link) › Editar.
    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'Fornecedores' })).toHaveAttribute('href', '/fornecedores');
    expect(within(nav).getByText('Editar')).toHaveAttribute('aria-current', 'page');
  });
});
