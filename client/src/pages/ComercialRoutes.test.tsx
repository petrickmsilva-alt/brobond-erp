// ============================================================================
// FUNDAÇÃO COMERCIAL — ROTAS e TELAS (App.tsx real).
//
// Prova o padrão LISTA → PÁGINA das telas da evolução Master e a regra de ouro
// do domínio: o REALIZADO é DERIVADO (vem da API), nunca um campo de formulário.
//
//   • /territorios            lista + hierarquia (árvore vinda do servidor)
//   • /territorios/novo       PÁGINA própria (sem dialog nem drawer sobre a lista)
//   • /metas/:id/acompanhamento  meta × realizado × % de atingimento calculados
//   • /comercial/painel       indicadores por representante/território/equipe
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
  const territorios = {
    key: 'territorios',
    label: 'Territórios',
    singular: 'Território',
    labelFields: ['nome'],
    empresa: true,
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true },
      { name: 'codigo', label: 'Código', type: 'text' },
      { name: 'tipo', label: 'Tipo', type: 'select', options: [{ value: 'comercial', label: 'Comercial' }] },
      { name: 'territorio_pai_id', label: 'Território pai', type: 'ref', ref: 'territorios' },
      { name: 'nivel', label: 'Nível', type: 'integer', readonly: true, list: false },
      { name: 'status', label: 'Situação', type: 'select', options: [{ value: 'ativo', label: 'Ativo' }] },
    ],
    filterFields: ['tipo', 'status'],
  };
  const metas = {
    key: 'metas',
    label: 'Metas',
    singular: 'Meta',
    labelFields: ['nome'],
    empresa: true,
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text' },
      { name: 'alvo_tipo', label: 'Alvo', type: 'select', options: [{ value: 'representante', label: 'Representante' }] },
      { name: 'metrica', label: 'Métrica', type: 'select', options: [{ value: 'faturamento', label: 'Faturamento' }] },
      { name: 'periodo_inicio', label: 'Início do período', type: 'date', required: true },
      { name: 'periodo_fim', label: 'Fim do período', type: 'date', required: true },
      { name: 'valor_meta', label: 'Meta (R$)', type: 'money' },
      { name: 'status', label: 'Situação', type: 'select', options: [{ value: 'ativa', label: 'Ativa' }] },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { territorios, metas }, modules: [], mode: 'memory' }),
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

const ARVORE = {
  total: 2,
  arvore: [
    {
      id: 1,
      nome: 'Brasil',
      codigo: 'BR',
      tipo: 'pais',
      nivel: 1,
      status: 'ativo',
      uf: null,
      cidade: null,
      profundidade: 1,
      filhos: [
        { id: 2, nome: 'Goiás', codigo: 'GO', tipo: 'estado', nivel: 2, status: 'ativo', uf: 'GO', cidade: null, profundidade: 2, filhos: [] },
      ],
    },
  ],
};

const ACOMPANHAMENTO = {
  meta: { id: 5, nome: 'Meta julho', periodo_inicio: '2026-07-01', periodo_fim: '2026-07-31', distribuicao: 'linear', meta_valor: 2000 },
  metrica: 'faturamento',
  meta_valor: 2000,
  realizado: 500,
  variacao: -1500,
  atingimento_pct: 25,
  falta: 1500,
  dias_periodo: 31,
  distribuicao_mensal: [{ mes: '2026-07', dias: 31, meta: 2000 }],
  indicadores: {
    faturamento: 500,
    pedidos: 2,
    clientes: 2,
    pecas: 5,
    ticket_medio: 250,
    comissao: 25,
    por_representante: [
      { representante_id: 7, representante: 'Ana', faturamento: 500, pedidos: 2, clientes: 2, ticket_medio: 250, comissao: 25 },
    ],
  },
};

const INDICADORES = {
  janela: { de: '2026-01-01', ate: '2026-12-31' },
  filtros: { representante_id: null, equipe_id: null, territorio_id: null },
  vendas: 3,
  faturamento: 1500,
  pedidos: 3,
  clientes: 2,
  pecas: 9,
  ticket_medio: 500,
  comissao: 75,
  meta: 3000,
  realizado: 1500,
  variacao: -1500,
  atingimento_pct: 50,
  por_representante: [
    {
      representante_id: 7,
      representante: 'Ana',
      vendas: 3,
      faturamento: 1500,
      pedidos: 3,
      clientes: 2,
      pecas: 9,
      ticket_medio: 500,
      comissao: 75,
      meta: 3000,
      atingimento_pct: 50,
    },
  ],
  por_territorio: [{ territorio_id: 2, territorio: 'Goiás', faturamento: 1500, pedidos: 3 }],
  por_equipe: [],
};

const apiGet = vi.mocked(api.get);

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
    const p = String(path);
    if (p === '/empresas/ativa') return EMPRESAS as never;
    if (p.startsWith('/comercial/territorios/arvore')) return ARVORE as never;
    if (p.startsWith('/comercial/metas/')) return ACOMPANHAMENTO as never;
    if (p.startsWith('/comercial/indicadores')) return INDICADORES as never;
    if (p.startsWith('/territorios/1')) {
      return { id: 1, nome: 'Brasil', codigo: 'BR', tipo: 'pais', status: 'ativo', nivel: 1 } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — Fundação comercial (LISTA → PÁGINA)', () => {
  it('/territorios mostra a lista e a ÁRVORE vinda do servidor', async () => {
    abrirRota('/territorios');

    expect(await screen.findByRole('heading', { name: 'Territórios' })).toBeInTheDocument();
    // Hierarquia calculada no servidor: raiz e filho aparecem.
    expect(await screen.findByText('Brasil')).toBeInTheDocument();
    expect(await screen.findByText('Goiás')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/comercial/territorios/arvore'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('/territorios/novo é uma PÁGINA própria (sem dialog/drawer sobre a lista)', async () => {
    abrirRota('/territorios/novo');

    expect(await screen.findByRole('heading', { name: /Novo território/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/territorios/novo');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    // O nível é DERIVADO: não existe input de nível na página de cadastro.
    expect(screen.queryByLabelText(/Nível/i)).toBeNull();
  });

  it('/metas/:id/acompanhamento mostra realizado DERIVADO e % de atingimento (nada digitável)', async () => {
    abrirRota('/metas/5/acompanhamento');

    expect(await screen.findByRole('heading', { name: /Acompanhamento/i })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/comercial/metas/5/acompanhamento');
    expect(await screen.findByText('25%')).toBeInTheDocument();
    // Realizado é número exibido — não há campo de formulário para digitá-lo.
    expect(screen.queryByLabelText(/Realizado/i)).toBeNull();
  });

  it('/comercial/painel exibe indicadores calculados no servidor', async () => {
    abrirRota('/comercial/painel');

    expect(await screen.findByRole('heading', { name: 'Painel comercial' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/comercial/indicadores'));
    // "Ana" aparece no gráfico e na tabela (dois lugares) — qualquer um serve.
    await waitFor(() => expect(screen.getAllByText('Ana').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText('Goiás').length).toBeGreaterThan(0));
  });
});
