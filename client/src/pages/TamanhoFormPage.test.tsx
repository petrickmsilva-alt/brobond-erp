// ============================================================================
// CADASTRO DE TAMANHOS — PÁGINA própria (/tamanhos/novo e /tamanhos/:id/editar).
//
// Trava o padrão visual do BROBOND ERP para o dicionário de tamanhos: LISTA →
// PÁGINA, exatamente como Cores e Coleções. Nada de modal central, drawer,
// sheet ou overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar tamanho;
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados (campos reais:
//     Código, Descrição, Ordem na grade) — nenhum campo inventado (não existe
//     "Ativo" em Tamanhos, e a página não o cria);
//   • salvar envia o contrato existente (POST /tamanhos, PUT /tamanhos/:id) e
//     volta para a lista; cancelar/voltar também vão para /tamanhos sem API;
//   • código vazio bloqueia o envio (a validação é a COMPARTILHADA do ERP);
//   • RBAC: `tamanhos` é catálogo COMPARTILHADO (escrita gerente+) — perfil
//     operador vê o aviso e não pode salvar; a autorização real é do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TamanhoFormPage from './TamanhoFormPage';
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
  // ESPELHO de server/src/resources.ts › tamanhos (sem campo inventado).
  const tamanhos = {
    key: 'tamanhos',
    label: 'Tamanhos / Grade',
    singular: 'Tamanho',
    labelFields: ['codigo'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true, unique: true, search: true, maxLength: 10, placeholder: 'PP, P, M, G, GG...' },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 60 },
      { name: 'ordem', label: 'Ordem na grade', type: 'integer', min: 0, default: 0, hint: 'Define a sequência (PP=1, P=2, M=3...).' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { tamanhos }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/tamanhos/${routeParams.id}/editar` : '/tamanhos/novo']}>
      <ToastProvider>
        <TamanhoFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar tamanho/ })[0] as HTMLButtonElement;
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

describe('novo tamanho — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar tamanho em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Novo tamanho/ })).toBeInTheDocument();
    expect(screen.getByText('Cadastre um tamanho para compor as grades do catálogo de produtos.')).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/tamanhos');
    // Cancelar e Salvar tamanho existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar tamanho/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    expect(await screen.findByLabelText(/^Código/)).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Ordem na grade')).toBeInTheDocument();
    // Tamanhos NÃO têm campo Ativo no domínio: a página não pode inventá-lo.
    expect(screen.queryByLabelText('Ativo')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('cria o tamanho enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Código/), { target: { value: '  GG  ' } });
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Extra grande' } });
    fireEvent.change(screen.getByLabelText('Ordem na grade'), { target: { value: '5' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/tamanhos', { codigo: 'GG', descricao: 'Extra grande', ordem: '5' });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/tamanhos'));
  });

  it('descrição vazia vira null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Código/), { target: { value: 'Único' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/tamanhos', { codigo: 'Único', descricao: null, ordem: '0' })
    );
  });

  it('código vazio bloqueia o envio e mantém a página aberta', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('heading', { name: /Novo tamanho/ }).then(() => botaoSalvar()));

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('código duplicado (409) mantém a página aberta com a mensagem do servidor no campo', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este código.', { codigo: 'Já cadastrado' }));
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Código/), { target: { value: 'GG' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um registro com este código.')).toBeInTheDocument();
    // Continua na PÁGINA (sem formulário sobreposto) para corrigir o código.
    expect(screen.getByRole('heading', { name: /Novo tamanho/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Código/), { target: { value: 'GG' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/tamanhos'));
  });

  it('cancelar volta para /tamanhos sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo tamanho/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/tamanhos');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('perfil sem alçada de escrita (operador) vê o aviso e não pode salvar', async () => {
    mockUser.perfil = 'operador';
    renderPage();

    expect(await screen.findByText(/acesso somente de leitura a Tamanhos/)).toBeInTheDocument();
    expect(botaoSalvar()).toBeDisabled();
  });
});

describe('editar tamanho — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/tamanhos/4') return { id: 4, codigo: 'G', descricao: 'Grande', ordem: 4 } as never;
      return {} as never;
    });
  });

  it('abre a página "Editar tamanho" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar tamanho/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Código/)).toHaveValue('G'));
    expect(screen.getByLabelText('Descrição')).toHaveValue('Grande');
    expect(screen.getByLabelText('Ordem na grade')).toHaveValue(4);
    expect(screen.getByText(/Alterando o tamanho “G”/)).toBeInTheDocument();
    semSobreposicao();
  });

  it('salva por PUT preservando a ordem e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/^Código/)).toHaveValue('G'));

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Grande ajustado' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/tamanhos/4', { codigo: 'G', descricao: 'Grande ajustado', ordem: '4' })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/tamanhos'));
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async () => {
      throw new ApiError(404, 'Tamanho não encontrado(a).');
    });
    renderPage();

    expect(await screen.findByText('Tamanho não encontrado(a).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/tamanhos');
    semSobreposicao();
  });
});
