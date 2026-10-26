// ============================================================================
// CADASTRO DE COLEÇÕES — PÁGINA própria (/colecoes/novo e /colecoes/:id/editar).
//
// Trava o padrão visual do BROBOND ERP para cadastros simples: LISTA → PÁGINA,
// exatamente como Cores. Nada de modal central, drawer, sheet ou overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar coleção;
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados (campos reais: Nome,
//     Temporada, Ano, Ativo) — nenhum campo inventado;
//   • salvar envia o contrato existente (POST /colecoes, PUT /colecoes/:id) e
//     volta para a lista; cancelar/voltar também vão para /colecoes sem API;
//   • nome vazio bloqueia o envio (a validação é a COMPARTILHADA do ERP);
//   • RBAC: `colecoes` é cadastro por empresa (sem piso de escrita) — a página
//     continua operável; a autorização real é do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ColecaoFormPage from './ColecaoFormPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';

const navigateMock = vi.fn();
let routeParams: Record<string, string> = {};

vi.mock('../lib/api', () => {
  class ApiErrorMock extends Error {
    status: number;
    fields?: Record<string, string>;
    code?: string;
    constructor(status: number, message: string, fields?: Record<string, string>, code?: string) {
      super(message);
      this.status = status;
      this.fields = fields;
      this.code = code;
    }
  }
  return {
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    ApiError: ApiErrorMock,
    downloadFile: vi.fn(),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => routeParams,
    useNavigate: () => navigateMock,
  };
});

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  // ESPELHO de server/src/resources.ts › colecoes (sem campo inventado).
  const colecoes = {
    key: 'colecoes',
    label: 'Coleções',
    singular: 'Coleção',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 80, placeholder: 'Verão 2027, Coleção Premium...' },
      {
        name: 'temporada',
        label: 'Temporada',
        type: 'select',
        options: [
          { value: 'Verão', label: 'Verão' },
          { value: 'Outono', label: 'Outono' },
          { value: 'Inverno', label: 'Inverno' },
          { value: 'Primavera', label: 'Primavera' },
          { value: 'Atemporal', label: 'Atemporal' },
        ],
      },
      { name: 'ano', label: 'Ano', type: 'integer', min: 2000, max: 2100 },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { colecoes }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/colecoes/${routeParams.id}/editar` : '/colecoes/novo']}>
      <ToastProvider>
        <ColecaoFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar coleção/ })[0] as HTMLButtonElement;
}

/** Nenhuma superfície sobreposta (modal, drawer, sheet) pode existir na página. */
function semSobreposicao() {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
}

beforeEach(() => {
  routeParams = {};
  mockUser.perfil = 'gerente';
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async () => ({}) as never);
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 4 } as never);
});

describe('nova coleção — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar coleção em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Nova coleção/ })).toBeInTheDocument();
    expect(screen.getByText('Cadastre uma coleção para organizar os produtos do catálogo.')).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/colecoes');
    // Cancelar e Salvar coleção existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar coleção/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    expect(await screen.findByLabelText(/^Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText('Temporada')).toBeInTheDocument();
    expect(screen.getByLabelText('Ano')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();
    // Nenhum campo extra (ex.: descrição, código, imagem) aparece.
    expect(screen.queryByLabelText(/Descrição/)).toBeNull();
    expect(screen.queryByLabelText(/Código/)).toBeNull();
  });

  it('cria a coleção enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: '  Verão 2028  ' } });
    fireEvent.change(screen.getByLabelText('Temporada'), { target: { value: 'Verão' } });
    fireEvent.change(screen.getByLabelText('Ano'), { target: { value: '2028' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/colecoes', { nome: 'Verão 2028', temporada: 'Verão', ano: '2028', ativo: true });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/colecoes'));
  });

  it('temporada/ano vazios viram null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Coleção Premium' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/colecoes', { nome: 'Coleção Premium', temporada: null, ano: null, ativo: true }));
  });

  it('nome vazio bloqueia o envio e mantém a página aberta', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('heading', { name: /Nova coleção/ }).then(() => botaoSalvar()));

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('nome duplicado (409) mantém a página aberta com a mensagem do servidor no campo', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este nome.', { nome: 'Já cadastrado' }));
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'verão 2027' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um registro com este nome.')).toBeInTheDocument();
    // Continua na PÁGINA (sem formulário sobreposto) para corrigir o nome.
    expect(screen.getByRole('heading', { name: /Nova coleção/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Verão 2028' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/colecoes'));
  });

  it('cancelar volta para /colecoes sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Nova coleção/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/colecoes');
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('editar coleção — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/colecoes/4') return { id: 4, nome: 'Verão 2027', temporada: 'Verão', ano: 2027, ativo: false } as never;
      return {} as never;
    });
  });

  it('abre a página "Editar coleção" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar coleção/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Verão 2027'));
    expect(screen.getByLabelText('Temporada')).toHaveValue('Verão');
    expect(screen.getByLabelText('Ano')).toHaveValue(2027);
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();
    expect(screen.getByText(/Alterando a coleção “Verão 2027”/)).toBeInTheDocument();
    semSobreposicao();
  });

  it('salva por PUT preservando o status e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Verão 2027'));

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Verão 2027 Premium' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/colecoes/4', { nome: 'Verão 2027 Premium', temporada: 'Verão', ano: '2027', ativo: false })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/colecoes'));
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async () => {
      throw new ApiError(404, 'Coleção não encontrada.');
    });
    renderPage();

    expect(await screen.findByText('Coleção não encontrada.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/colecoes');
    semSobreposicao();
  });
});
