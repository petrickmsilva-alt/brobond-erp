// ============================================================================
// REGISTRO — página genérica de NOVO / EDITAR (padrão LISTA → PÁGINA)
//
// O que este teste protege:
//   1) TODO recurso do CRUD genérico tem rota real de cadastro e de edição no
//      roteador de verdade (App.tsx) — não é um formulário dentro da listagem;
//   2) a página usa o MESMO contrato do servidor (meta + POST/PUT do recurso);
//   3) ZERO MODAL: nenhum role="dialog"/aria-modal é montado;
//   4) a listagem genérica NAVEGA para a página (não abre sobreposição).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// Origens do CRM: recurso GENÉRICO (não tem formulário dedicado). É o caso que
// antes caía no modal do ModulePage — agora precisa existir como página.
const ORIGENS = {
  key: 'crm_origens',
  label: 'Origens',
  singular: 'Origem',
  labelFields: ['nome'],
  ops: { create: true, update: true, delete: true },
  fields: [
    { name: 'nome', label: 'Nome', type: 'text', required: true },
    {
      name: 'canal',
      label: 'Canal',
      type: 'select',
      options: [
        { value: 'site', label: 'Site' },
        { value: 'evento', label: 'Evento' },
      ],
    },
    { name: 'ativo', label: 'Ativa', type: 'boolean', default: true },
  ],
};

const PIPELINE = {
  key: 'crm_funis',
  label: 'Funis',
  singular: 'Funil',
  labelFields: ['nome'],
  ops: { create: true, update: true, delete: true },
  fields: [
    { name: 'nome', label: 'Nome', type: 'text', required: true },
    { name: 'padrao', label: 'Funil padrão', type: 'boolean', default: false },
  ],
};

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  return {
    ...actual,
    useMeta: () => ({
      resources: { crm_origens: ORIGENS, crm_funis: PIPELINE },
      modules: [],
      mode: 'memory',
      defaultLocal: null,
    }),
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
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

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
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/empresas/ativa') return EMPRESAS as never;
    if (String(path) === '/crm_origens/7') return { id: 7, nome: 'Site', canal: 'site', ativo: true } as never;
    if (String(path) === '/crm_origens/options') return [] as never;
    if (String(path) === '/crm_funis/options') return [] as never;
    if (String(path).startsWith('/crm_origens?')) return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 7 } as never);
});

describe('RegistroPage — cadastro/edição em PÁGINA para o CRUD genérico', () => {
  it('/crm/origens/novo é rota registrada e abre "Nova origem" (sem modal)', async () => {
    abrirRota('/crm/origens/novo');

    expect(await screen.findByRole('heading', { name: /Novo cadastro: Origem/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/crm/origens/novo');
    expect(screen.getByRole('link', { name: /Voltar à lista/i })).toHaveAttribute('href', '/crm/origens');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('cria a origem pelo MESMO contrato da API (POST /crm_origens)', async () => {
    const user = userEvent.setup();
    abrirRota('/crm/origens/novo');
    await screen.findByRole('heading', { name: /Novo cadastro: Origem/i });

    await user.type(screen.getByLabelText(/^Nome/), 'Feira de moda');
    await user.click(screen.getByRole('button', { name: /Incluir Origem/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [rota, payload] = apiPost.mock.calls[0];
    expect(rota).toBe('/crm_origens');
    expect(payload).toMatchObject({ nome: 'Feira de moda', ativo: true });
  });

  it('/crm/origens/7/editar carrega o registro e salva por PUT', async () => {
    const user = userEvent.setup();
    abrirRota('/crm/origens/7/editar');

    expect(await screen.findByRole('heading', { name: /Editar Origem/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Site'));

    await user.clear(screen.getByLabelText(/^Nome/));
    await user.type(screen.getByLabelText(/^Nome/), 'Site institucional');
    // Dois botões com o mesmo rótulo existem na página (cabeçalho e rodapé do
    // formulário) — ambos salvam; usamos o do cabeçalho.
    const [salvar] = screen.getAllByRole('button', { name: /Salvar alterações/i });
    await user.click(salvar);

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][0]).toBe('/crm_origens/7');
  });

  it('outro recurso genérico (funis) também tem página própria de cadastro', async () => {
    abrirRota('/crm/funis/novo');
    expect(await screen.findByRole('heading', { name: /Novo cadastro: Funil/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a listagem genérica NAVEGA ao clicar em Novo (nunca abre sobreposição)', async () => {
    const user = userEvent.setup();
    abrirRota('/crm/origens');

    // Espera a lista carregar (chamada /crm_origens?page=...).
    await waitFor(() => expect(apiGet.mock.calls.some(([p]) => String(p).startsWith('/crm_origens?'))).toBe(true));
    const botoes = await screen.findAllByRole('button', { name: /Novo origem/i });
    await user.click(botoes[0]);

    await waitFor(() => expect(window.location.pathname).toBe('/crm/origens/novo'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('validação local impede POST quando o obrigatório está vazio', async () => {
    const user = userEvent.setup();
    abrirRota('/crm/origens/novo');
    await screen.findByRole('heading', { name: /Novo cadastro: Origem/i });

    const botao = screen.getByRole('button', { name: /Incluir Origem/i });
    fireEvent.click(botao);

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/i)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
