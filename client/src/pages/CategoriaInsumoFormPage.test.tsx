// ============================================================================
// CADASTRO DE CATEGORIAS DE INSUMOS — página própria (fora do modal genérico).
//
// Trava o contrato de UX do fluxo /categorias-insumos/novo e
// /categorias-insumos/:id/editar, o MESMO padrão LISTA → PÁGINA de Cores,
// Coleções, Categorias, Grades e Insumos:
//   • não há modal/drawer: a criação e a edição acontecem em página, com
//     Voltar e Salvar categoria;
//   • o nome é obrigatório e o erro aparece junto do campo, SEM perder o que foi
//     digitado e SEM chamar a API;
//   • o payload segue o contrato existente do recurso (nome, descricao, pai_id,
//     ativo) — sem campo novo e sem endpoint novo;
//   • a taxonomia é a PRÓPRIA do insumo: o seletor de categoria-pai aponta para
//     `categorias_insumos` (um nível), nunca para `categorias` do produto;
//   • o erro do servidor (409 de nome duplicado) chega com o campo destacado;
//   • o botão Salvar fica desabilitado durante o envio (anti duplo submit);
//   • cancelar volta para /categorias-insumos; salvar com sucesso também.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CategoriaInsumoFormPage from './CategoriaInsumoFormPage';
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
  // ESPELHO de server/src/resources.ts › categorias_insumos (sem campo inventado).
  const categorias_insumos = {
    key: 'categorias_insumos',
    label: 'Categorias de Insumos',
    singular: 'Categoria de insumo',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, uniqueEmpresa: true, maxLength: 60 },
      { name: 'descricao', label: 'Descrição', type: 'text', maxLength: 160 },
      { name: 'pai_id', label: 'Categoria-pai', type: 'ref', ref: 'categorias_insumos', list: false },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { categorias_insumos }, modules: [] }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/categorias-insumos/${routeParams.id}/editar` : '/categorias-insumos/novo']}>
      <ToastProvider>
        <CategoriaInsumoFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

const PAIS = [
  { value: 1, label: 'Aviamentos' },
  { value: 2, label: 'Embalagem' },
];

beforeEach(() => {
  routeParams = {};
  mockUser.perfil = 'gerente';
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/categorias_insumos/options')) return PAIS as never;
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 5, nome: 'Malhas', ativo: true } as never);
});

describe('nova categoria de insumo (página própria)', () => {
  it('não usa modal e oferece Voltar e Salvar categoria', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Nova categoria de insumo/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/categorias-insumos');
    expect(screen.getAllByRole('button', { name: /Salvar categoria/ }).length).toBeGreaterThan(0);
  });

  it('a categoria-pai vem da taxonomia PRÓPRIA do insumo (um nível)', async () => {
    renderPage();
    const select = await screen.findByLabelText(/Categoria-pai/);
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(3));
    expect(apiGet).toHaveBeenCalledWith('/categorias_insumos/options');
  });

  it('nome vazio bloqueia o envio, mostra o erro junto do campo e NÃO chama a API', async () => {
    renderPage();
    const salvar = (await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0];
    fireEvent.click(salvar);
    expect(await screen.findByText('Campo obrigatório')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('preserva os valores digitados quando a validação falha', async () => {
    renderPage();
    const nome = await screen.findByLabelText(/Nome/);
    const descricao = screen.getByLabelText(/Descrição/);
    fireEvent.change(descricao, { target: { value: 'Tecidos planos e malhas' } });
    fireEvent.change(nome, { target: { value: '' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);
    expect(await screen.findByText('Campo obrigatório')).toBeTruthy();
    expect((descricao as HTMLInputElement).value).toBe('Tecidos planos e malhas');
  });

  it('salva pelo contrato existente (nome, descricao, pai_id, ativo) e volta para /categorias-insumos', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Linhas e Fios' } });
    fireEvent.change(screen.getByLabelText(/Descrição/), { target: { value: 'Linhas, fios e cadarços' } });
    fireEvent.change(screen.getByLabelText(/Categoria-pai/), { target: { value: '1' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // Refs vão como texto no payload (o servidor coerce para inteiro) — o MESMO
    // contrato do CRUD genérico e das demais páginas LISTA → PÁGINA.
    expect(apiPost).toHaveBeenCalledWith('/categorias_insumos', {
      nome: 'Linhas e Fios',
      descricao: 'Linhas, fios e cadarços',
      pai_id: '1',
      ativo: true,
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias-insumos'));
  });

  it('descrição vazia e pai não escolhido viram null no payload (não string vazia)', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Embalagem' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/categorias_insumos', {
        nome: 'Embalagem',
        descricao: null,
        pai_id: null,
        ativo: true,
      })
    );
  });

  it('cancelar volta para /categorias-insumos sem chamar a API', async () => {
    renderPage();
    const voltar = await screen.findByRole('link', { name: /Voltar/ });
    expect(voltar).toHaveAttribute('href', '/categorias-insumos');
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);
    expect(navigateMock).toHaveBeenCalledWith('/categorias-insumos');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Botões' } });
    const salvar = (await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0];
    fireEvent.click(salvar);
    await waitFor(() => expect(salvar).toBeDisabled());
    fireEvent.click(salvar);
    expect(apiPost).toHaveBeenCalledTimes(1);
    resolver({ id: 99 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias-insumos'));
  });
});

describe('editar categoria de insumo (página própria)', () => {
  beforeEach(() => {
    routeParams = { id: '5' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/categorias_insumos/options')) return PAIS as never;
      if (String(path).startsWith('/categorias_insumos/5')) {
        return { id: 5, nome: 'Malhas', descricao: 'Malha penteada e suplex', pai_id: 2, ativo: false } as never;
      }
      return {} as never;
    });
  });

  it('mostra "Editar categoria de insumo" com o nome do registro sendo editado', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Editar categoria de insumo/ })).toBeTruthy();
    expect(screen.getByText(/Alterando a categoria “Malhas”/)).toBeTruthy();
  });

  it('carrega os dados existentes no formulário', async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Malhas'));
    expect((screen.getByLabelText(/Descrição/) as HTMLInputElement).value).toBe('Malha penteada e suplex');
    await waitFor(() => expect((screen.getByLabelText(/Categoria-pai/) as HTMLSelectElement).value).toBe('2'));
    // `ativo` é um checkbox no RecordForm (padrão do ERP), não um switch.
    expect((screen.getByLabelText(/Ativo/) as HTMLInputElement).checked).toBe(false);
  });

  it('salva com PUT no registro e volta para /categorias-insumos', async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Malhas'));
    fireEvent.change(screen.getByLabelText(/Nome/), { target: { value: 'Malhas e Suplex' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar alterações/ }))[0]);
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/categorias_insumos/5', {
        nome: 'Malhas e Suplex',
        descricao: 'Malha penteada e suplex',
        pai_id: '2',
        ativo: false,
      })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias-insumos'));
  });

  it('erro do servidor (nome duplicado) destaca o campo e mantém o valor digitado', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este nome.', { nome: 'Já cadastrado' }));
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Malhas'));
    fireEvent.change(screen.getByLabelText(/Nome/), { target: { value: 'Aviamentos' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar alterações/ }))[0]);
    expect(await screen.findByText('Já cadastrado')).toBeTruthy();
    expect(await screen.findByText('Já existe um registro com este nome.')).toBeTruthy();
    expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Aviamentos');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/categorias_insumos/options')) return PAIS as never;
      throw new ApiError(404, 'Categoria não encontrado(a).');
    });
    renderPage();
    expect(await screen.findByText('Categoria não encontrado(a).')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toBeTruthy();
  });
});
