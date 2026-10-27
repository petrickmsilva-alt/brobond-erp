// ============================================================================
// ROTAS DE REPRESENTANTES — o roteador REAL do ERP (App.tsx).
//
// Os testes de RepresentantesPage provam que a lista NAVEGA para
// /representantes/novo e /representantes/:id/editar; os de
// RepresentanteFormPage provam a página. Falta o elo do meio: o App precisa
// REGISTRAR essas rotas (ModuleAccess do módulo `representantes`). Este arquivo
// cobre exatamente isso, no BrowserRouter de verdade — e repete a garantia
// visual: nenhum `role="dialog"`/`aria-modal` é montado (o cadastro de
// representantes deixou de ser um formulário sobreposto à lista).
//
// Também cobre a LINHA e o BREADCRUMB do shell:
//   /representantes            → LISTA (BROBOND ERP › Cadastros › Representantes)
//   /representantes/novo       → página "Novo representante" (› Novo)
//   /representantes/:id        → página da FICHA + PAINEL (uma rota, não modal)
//   /representantes/:id/editar → página "Editar representante" (› Editar)
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
  // ESPELHO de server/src/resources.ts › representantes (sem campo inventado).
  const representantes = {
    key: 'representantes',
    label: 'Representantes',
    singular: 'Representante',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    filterFields: ['usuario_id', 'ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 120, section: 'Identificação' },
      { name: 'cpf', label: 'CPF', type: 'document', documento: 'cpf', maxLength: 14, section: 'Identificação' },
      { name: 'cargo', label: 'Cargo', type: 'text', maxLength: 60, section: 'Identificação' },
      { name: 'regiao', label: 'Região', type: 'text', maxLength: 80, section: 'Identificação' },
      { name: 'comissao_pct', label: 'Comissão padrão (%)', type: 'percent', min: 0, max: 100, default: 0, section: 'Comercial' },
      { name: 'usuario_id', label: 'Usuário do sistema', type: 'ref', ref: 'usuarios', list: false, section: 'Acesso ao ERP' },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, section: 'Contato' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, section: 'Situação profissional' },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { representantes }, modules: [], mode: 'memory' }),
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
    if (String(path) === '/usuarios/options') return [] as never;
    if (String(path) === '/comercial/representantes/4/painel') {
      return {
        representante: {
          id: 4,
          codigo: 'REP00004',
          nome: 'Carlos Lima',
          tipo_pessoa: 'PF',
          tipo_representante: 'GERENTE',
          cpf: '52998224725',
          cnpj: null,
          razao_social: null,
          nome_fantasia: null,
          cargo: 'Representante',
          registro_profissional: null,
          orgao_registro: null,
          data_nascimento: null,
          admissao: null,
          desligamento: null,
          ativo: true,
          comissao_pct: 3.5,
          contato: { telefone: null, celular: null, whatsapp: null, email: null },
          endereco: { cep: null, logradouro: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null, pais: 'Brasil' },
          regiao_legado: 'Norte',
        },
        estrutura: { territorio: null, equipes: [], hierarquia: { supervisores: [], subordinados: [] } },
        carteira: { vigentes: 0, encerrados: 0, cancelados: 0, total: 0, clientes_ativos: 0, clientes_inativos: 0, clientes: [] },
        metas: { total: 0, ativas: 0, linhas: [] },
        comissao: { padrao_pct: 3.5, apurado_total: 0, estornado_total: 0, efetivado_total: 0, apuracoes: 0, eventos: 0 },
        indicadores: { vendas: 0, faturamento: 0, pedidos: 0, clientes: 0, pecas: 0, ticket_medio: 0, comissao: 0, meta: null, atingimento_pct: null },
        ranking: { posicao: null, total: 0, faturamento: 0 },
      } as never;
    }
    if (String(path) === '/representantes/4') {
      return {
        id: 4,
        nome: 'Carlos Lima',
        cpf: '52998224725',
        cargo: 'Representante',
        regiao: 'Norte',
        comissao_pct: 3.5,
        usuario_id: null,
        telefone: null,
        email: null,
        ativo: true,
      } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
});

describe('App — rotas do cadastro de Representantes (LISTA → PÁGINA)', () => {
  it('/representantes continua sendo a LISTA (sem formulário sobreposto) com o breadcrumb do módulo', async () => {
    abrirRota('/representantes');

    expect(await screen.findByRole('heading', { name: 'Representantes' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Novo representante/ }).length).toBeGreaterThan(0);
    // A lista NÃO abre nenhum formulário por conta própria.
    semSobreposicao();

    // Breadcrumb do shell: BROBOND ERP › Cadastros › Representantes (página atual).
    await waitFor(() => expect(trilha()).toBeInTheDocument());
    const nav = trilha();
    expect(within(nav).getByText('Cadastros')).toBeInTheDocument();
    const folhas = within(nav).getAllByText('Representantes');
    expect(folhas[folhas.length - 1]).toHaveAttribute('aria-current', 'page');
  });

  it('/representantes/novo é uma rota registrada e abre a página "Novo representante" (sem modal/drawer)', async () => {
    abrirRota('/representantes/novo');

    expect(await screen.findByRole('heading', { name: /Novo representante/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/representantes/novo');
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/representantes');
    // O formulário vive na ROTA, nunca sobreposto à lista.
    semSobreposicao();

    // Breadcrumb: BROBOND ERP › Cadastros › Representantes (link) › Novo.
    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'Representantes' })).toHaveAttribute('href', '/representantes');
    expect(within(nav).getByText('Novo')).toHaveAttribute('aria-current', 'page');
  });

  it('/representantes/:id é uma rota registrada e abre a FICHA com painel (página, não modal)', async () => {
    abrirRota('/representantes/4');

    expect(await screen.findByRole('heading', { name: /Carlos Lima/ })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/comercial/representantes/4/painel');
    expect(window.location.pathname).toBe('/representantes/4');
    // A ficha é uma PÁGINA do módulo, com caminho de volta para a lista.
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/representantes');
    semSobreposicao();
  });

  it('/representantes/:id/editar é uma rota registrada e abre a página "Editar representante"', async () => {
    abrirRota('/representantes/4/editar');

    expect(await screen.findByRole('heading', { name: /Editar representante/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Carlos Lima'));
    expect(window.location.pathname).toBe('/representantes/4/editar');
    semSobreposicao();

    // Breadcrumb: BROBOND ERP › Cadastros › Representantes (link) › Editar.
    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'Representantes' })).toHaveAttribute('href', '/representantes');
    expect(within(nav).getByText('Editar')).toHaveAttribute('aria-current', 'page');
  });
});
