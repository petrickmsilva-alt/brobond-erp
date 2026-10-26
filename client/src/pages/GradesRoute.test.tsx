// ============================================================================
// ROTAS DE GRADES — o roteador REAL do ERP (App.tsx).
//
// Os testes de ModulePage provam que a lista NAVEGA para /grades/novo e
// /grades/:id/editar; os de GradeFormPage provam a página. Falta o elo do meio:
// o App precisa REGISTRAR essas rotas (ModuleAccess do módulo `grades`). Este
// arquivo cobre exatamente isso, no BrowserRouter de verdade — e repete a
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
  const grades = {
    key: 'grades',
    label: 'Grades',
    singular: 'Grade',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    filterFields: ['ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 60 },
      { name: 'tamanhos', label: 'Tamanhos', type: 'multiref', ref: 'tamanhos', required: true, virtual: true },
      { name: 'descricao', label: 'Descrição', type: 'text', maxLength: 160 },
      { name: 'instrucoes_medidas', label: 'Instruções de medição', type: 'textarea', list: false, maxLength: 600 },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { grades, tamanhos: { key: 'tamanhos', label: 'Tamanhos / Grade', singular: 'Tamanho', labelFields: ['codigo'], ops: {}, fields: [] } }, modules: [], mode: 'memory' }),
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

const GRADE = {
  id: 7,
  nome: 'Camiseta PP-GG',
  descricao: 'Malha e camisaria básica',
  instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.',
  ativo: true,
  tamanhos: [2, 3, 4, 5],
  tamanhos__label: 'P · M · G · GG',
  tamanhos_total: 4,
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
    if (String(path) === '/grades/7') return GRADE as never;
    if (String(path) === '/tamanhos/options')
      return [
        { value: 1, label: 'PP' },
        { value: 2, label: 'P' },
        { value: 3, label: 'M' },
        { value: 4, label: 'G' },
        { value: 5, label: 'GG' },
      ] as never;
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Grades (LISTA → PÁGINA)', () => {
  it('/grades/novo é uma rota registrada e abre a página "Nova grade" (sem modal/drawer)', async () => {
    abrirRota('/grades/novo');

    expect(await screen.findByRole('heading', { name: /Nova grade/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/grades/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/grades');
    // O formulário vive na ROTA, nunca sobreposto à lista.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('/grades/:id/editar é uma rota registrada e abre a página "Editar grade"', async () => {
    abrirRota('/grades/7/editar');

    expect(await screen.findByRole('heading', { name: /Editar grade/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Camiseta PP-GG'));
    expect(window.location.pathname).toBe('/grades/7/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
