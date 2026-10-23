// ============================================================================
// CADASTRO DE CATEGORIAS — página própria (fora do modal genérico).
//
// Trava o contrato de UX do fluxo /categorias/novo e /categorias/:id/editar:
//   • não há modal: a criação e a edição acontecem em página, com breadcrumb,
//     Voltar e Salvar categoria;
//   • o nome é obrigatório e o erro aparece junto do campo, SEM perder o que foi
//     digitado e SEM chamar a API;
//   • o payload segue o contrato existente do recurso (nome, descricao,
//     grade_id, ativo) — sem campo novo e sem endpoint novo;
//   • a grade padrão vem de /grades/options;
//   • o erro do servidor (409 de nome duplicado) chega com o campo destacado;
//   • o botão Salvar fica desabilitado durante o envio (anti duplo submit);
//   • cancelar volta para /categorias; salvar com sucesso também.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CategoriaFormPage from './CategoriaFormPage';
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
  const categorias = {
    key: 'categorias',
    label: 'Categorias',
    singular: 'Categoria',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 60, placeholder: 'Camisa, Camiseta, Calça, Bermuda...' },
      { name: 'descricao', label: 'Descrição', type: 'text', maxLength: 160 },
      { name: 'grade_id', label: 'Grade padrão', type: 'ref', ref: 'grades' },
      { name: 'ativo', label: 'Ativo', type: 'boolean' },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { categorias }, modules: [] }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/categorias/${routeParams.id}/editar` : '/categorias/novo']}>
      <ToastProvider>
        <CategoriaFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

const GRADES = [
  { value: 1, label: 'Camisaria (PP, P, M, G)' },
  { value: 2, label: 'Calça numérica (36–48)' },
];

beforeEach(() => {
  routeParams = {};
  mockUser.perfil = 'gerente';
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/grades/options')) return GRADES as never;
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 5, nome: 'Camisa', ativo: true } as never);
});

describe('nova categoria (página própria)', () => {
  it('não usa modal e oferece breadcrumb, Voltar e Salvar categoria', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Nova categoria/ })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: /Voltar/ })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Salvar categoria/ }).length).toBeGreaterThan(0);
  });

  it('carrega as grades existentes no select de Grade padrão com o texto auxiliar', async () => {
    renderPage();
    const select = await screen.findByLabelText(/Grade padrão/);
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(3));
    expect(screen.getByText(/A grade será usada como padrão para novos produtos desta categoria/)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/grades/options');
  });

  it('nome vazio bloqueia o envio, mostra o erro junto do campo e NÃO chama a API', async () => {
    renderPage();
    const salvar = (await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0];
    fireEvent.click(salvar);
    expect(await screen.findByText('Informe o nome da categoria.')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('preserva os valores digitados quando a validação falha', async () => {
    renderPage();
    const nome = await screen.findByLabelText(/Nome/);
    const descricao = screen.getByLabelText(/Descrição/);
    fireEvent.change(nome, { target: { value: '  Camisa  ' } });
    fireEvent.change(descricao, { target: { value: 'Camisas sociais' } });
    // Nome em branco não é o caso aqui: força o erro limpando o nome depois de
    // digitar a descrição — o que foi digitado na descrição deve permanecer.
    fireEvent.change(nome, { target: { value: '' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);
    expect(await screen.findByText('Informe o nome da categoria.')).toBeTruthy();
    expect((descricao as HTMLInputElement).value).toBe('Camisas sociais');
  });

  it('salva pelo contrato existente (nome, descricao, grade_id, ativo) e volta para /categorias', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Camisa' } });
    fireEvent.change(screen.getByLabelText(/Descrição/), { target: { value: 'Camisas sociais e casuais' } });
    fireEvent.change(screen.getByLabelText(/Grade padrão/), { target: { value: '1' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/categorias', {
      nome: 'Camisa',
      descricao: 'Camisas sociais e casuais',
      grade_id: 1,
      ativo: true,
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias'));
  });

  it('descrição vazia e grade não escolhida viram null no payload (não string vazia)', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Bermuda' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0]);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/categorias', {
      nome: 'Bermuda',
      descricao: null,
      grade_id: null,
      ativo: true,
    }));
  });

  it('cancelar volta para /categorias sem chamar a API', async () => {
    renderPage();
    const voltar = await screen.findByRole('link', { name: /Voltar/ });
    expect(voltar).toHaveAttribute('href', '/categorias');
    // O botão Cancelar (ação explícita) usa o router — mesmo destino.
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);
    expect(navigateMock).toHaveBeenCalledWith('/categorias');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();
    fireEvent.change(await screen.findByLabelText(/Nome/), { target: { value: 'Camisa' } });
    const salvar = (await screen.findAllByRole('button', { name: /Salvar categoria/ }))[0];
    fireEvent.click(salvar);
    await waitFor(() => expect(salvar).toBeDisabled());
    // Segundo clique durante o envio não dispara outra requisição.
    fireEvent.click(salvar);
    expect(apiPost).toHaveBeenCalledTimes(1);
    resolver({ id: 99 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias'));
  });
});

describe('editar categoria (página própria)', () => {
  beforeEach(() => {
    routeParams = { id: '5' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/grades/options')) return GRADES as never;
      if (String(path).startsWith('/categorias/5')) return { id: 5, nome: 'Calça', descricao: 'Jeans e sarja', grade_id: 2, ativo: false } as never;
      return {} as never;
    });
  });

  it('mostra "Editar categoria" com o nome do registro sendo editado', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Editar categoria/ })).toBeTruthy();
    expect(screen.getByText(/Alterando a categoria “Calça”/)).toBeTruthy();
  });

  it('carrega os dados existentes no formulário', async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Calça'));
    expect((screen.getByLabelText(/Descrição/) as HTMLInputElement).value).toBe('Jeans e sarja');
    await waitFor(() => expect((screen.getByLabelText(/Grade padrão/) as HTMLSelectElement).value).toBe('2'));
    expect(screen.getByRole('switch', { name: /Ativo/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('salva com PUT no registro e volta para /categorias', async () => {
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Calça'));
    fireEvent.change(screen.getByLabelText(/Nome/), { target: { value: 'Calça jeans' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar alterações/ }))[0]);
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/categorias/5', {
      nome: 'Calça jeans',
      descricao: 'Jeans e sarja',
      grade_id: 2,
      ativo: false,
    }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/categorias'));
  });

  it('erro do servidor (nome duplicado) destaca o campo e mantém o valor digitado', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este nome.', { nome: 'Já cadastrado' }));
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Calça'));
    fireEvent.change(screen.getByLabelText(/Nome/), { target: { value: 'Camisa' } });
    fireEvent.click((await screen.findAllByRole('button', { name: /Salvar alterações/ }))[0]);
    expect(await screen.findByText('Já cadastrado')).toBeTruthy();
    expect(await screen.findByText('Já existe um registro com este nome.')).toBeTruthy();
    expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Camisa');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('perfil sem alçada de escrita vê o aviso e não pode salvar', async () => {
    mockUser.perfil = 'operador';
    renderPage();
    await waitFor(() => expect((screen.getByLabelText(/Nome/) as HTMLInputElement).value).toBe('Calça'));
    expect(screen.getByText(/acesso somente de leitura a Categorias/)).toBeTruthy();
    expect((screen.getAllByRole('button', { name: /Salvar alterações/ })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/grades/options')) return GRADES as never;
      throw new ApiError(404, 'Categoria não encontrado(a).');
    });
    renderPage();
    expect(await screen.findByText('Categoria não encontrado(a).')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toBeTruthy();
  });
});
