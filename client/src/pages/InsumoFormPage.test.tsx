// ============================================================================
// CADASTRO DE INSUMOS — PÁGINA própria (/insumos/novo e /insumos/:id/editar).
//
// Trava o padrão visual do BROBOND ERP para cadastros simples: LISTA → PÁGINA,
// exatamente como Cores, Coleções e Grades. Nada de modal central, drawer,
// sheet, dialog ou overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar insumo
//     (na edição: "Salvar alterações");
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados — e os campos são
//     EXATAMENTE os que existem em `insumos` (nome, unidade, custo_medio,
//     fornecedor_id, ativo): nenhum campo inventado (nada de SKU/NCM/descrição/
//     marca/cor/imagem/categoria/estoque mínimo/localização);
//   • salvar envia o contrato existente (POST /insumos, PUT /insumos/:id) e
//     volta para a lista; cancelar/voltar também vão para /insumos sem API;
//   • nome vazio bloqueia o envio (a validação é a COMPARTILHADA do ERP);
//   • RBAC: `insumos` é cadastro por empresa (sem piso de escrita) — a página
//     continua operável; a autorização real é do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InsumoFormPage from './InsumoFormPage';
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
  // ESPELHO de server/src/resources.ts › insumos (sem campo inventado).
  const insumos = {
    key: 'insumos',
    label: 'Insumos',
    singular: 'Insumo',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    filterFields: ['unidade', 'fornecedor_id', 'ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      {
        name: 'unidade',
        label: 'Unidade',
        type: 'select',
        required: true,
        default: 'un',
        options: [
          { value: 'un', label: 'Unidade (un)' },
          { value: 'pc', label: 'Peça (pç)' },
          { value: 'm', label: 'Metro (m)' },
          { value: 'kg', label: 'Quilo (kg)' },
          { value: 'l', label: 'Litro (l)' },
        ],
      },
      { name: 'custo_medio', label: 'Custo médio', type: 'money', min: 0, default: 0 },
      { name: 'fornecedor_id', label: 'Fornecedor', type: 'ref', ref: 'fornecedores' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
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
  return {
    ...actual,
    useMeta: () => ({ resources: { insumos, fornecedores }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/insumos/${routeParams.id}/editar` : '/insumos/novo']}>
      <ToastProvider>
        <InsumoFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar (insumo|alterações)/ })[0] as HTMLButtonElement;
}

/** Nenhuma superfície sobreposta (modal, drawer, sheet, dialog) pode existir. */
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
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/fornecedores/options') {
      return [
        { value: 1, label: 'Têxtil Bella' },
        { value: 2, label: 'Química Sul' },
      ] as never;
    }
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 4 } as never);
});

describe('novo insumo — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar insumo em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Novo insumo/ })).toBeInTheDocument();
    expect(
      screen.getByText('Cadastre a matéria-prima usada na produção, a unidade de compra, o custo e o fornecedor.')
    ).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/insumos');
    // Cancelar e Salvar insumo existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar insumo/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    expect(await screen.findByLabelText(/^Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Unidade/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Custo médio/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Fornecedor')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();

    // Nenhum campo INVENTADO aparece (o domínio de `insumos` não tem nenhum deles).
    expect(screen.queryByLabelText(/Código|SKU|NCM|Descrição|Marca|Cor|Imagem|Categoria|Localiza/i)).toBeNull();
    // O estoque mínimo/máximo NÃO existe em `insumos`: vive em `estoque_insumos`.
    expect(screen.queryByLabelText(/Estoque m[ií]nimo/i)).toBeNull();
    expect(screen.queryByLabelText(/Estoque m[aá]ximo/i)).toBeNull();
  });

  it('a unidade começa com o padrão do recurso ("un") e a lista de opções é a do dicionário', async () => {
    renderPage();

    const unidade = await screen.findByLabelText(/^Unidade/);
    expect(unidade).toHaveValue('un');
    expect(screen.getByRole('option', { name: 'Metro (m)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Quilo (kg)' })).toBeInTheDocument();
  });

  it('o fornecedor usa as opções reais do ERP (nenhum endpoint paralelo)', async () => {
    renderPage();

    const fornecedor = await screen.findByLabelText('Fornecedor');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Têxtil Bella' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Química Sul' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/fornecedores/options');
    expect(fornecedor).toBeInTheDocument();
  });

  it('cria o insumo enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: '  Malha penteada  ' } });
    fireEvent.change(screen.getByLabelText(/^Unidade/), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText(/^Custo médio/), { target: { value: '12,50' } });
    const fornecedor = await screen.findByLabelText('Fornecedor');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Têxtil Bella' })).toBeInTheDocument());
    fireEvent.change(fornecedor, { target: { value: '1' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/insumos', {
      nome: 'Malha penteada',
      unidade: 'm',
      custo_medio: '12,50',
      fornecedor_id: '1',
      ativo: true,
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/insumos'));
  });

  it('campos vazios viram null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Elástico' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/insumos', {
        nome: 'Elástico',
        unidade: 'un',
        custo_medio: '0',
        fornecedor_id: null,
        ativo: true,
      })
    );
  });

  it('nome vazio bloqueia o envio e mantém a página aberta', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo insumo/ });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('erro do servidor (409) mantém a página aberta com a mensagem no campo', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Fornecedor não encontrado(a).', { fornecedor_id: 'Não encontrado(a)' }));
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Zíper' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Fornecedor não encontrado(a).')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Novo insumo/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Malha penteada' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/insumos'));
  });

  it('cancelar volta para /insumos sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo insumo/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/insumos');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('desativar o insumo desmarca o Ativo e vai no payload (desativação preserva o histórico)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Malha penteada' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ativo' }));
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/insumos', expect.objectContaining({ ativo: false })));
  });
});

describe('editar insumo — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/insumos/4') {
        return {
          id: 4,
          nome: 'Malha penteada',
          unidade: 'm',
          custo_medio: 12.5,
          fornecedor_id: 1,
          fornecedor_id__label: 'Têxtil Bella',
          ativo: false,
        } as never;
      }
      if (String(path) === '/fornecedores/options') {
        return [
          { value: 1, label: 'Têxtil Bella' },
          { value: 2, label: 'Química Sul' },
        ] as never;
      }
      return {} as never;
    });
  });

  it('abre a página "Editar insumo" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar insumo/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Malha penteada'));
    expect(screen.getByLabelText(/^Unidade/)).toHaveValue('m');
    expect(screen.getByLabelText(/^Custo médio/)).toHaveValue('12,5');
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();
    expect(screen.getByText(/Alterando o insumo “Malha penteada”/)).toBeInTheDocument();
    semSobreposicao();
  });

  it('na edição o botão de salvar é "Salvar alterações" (convenção do ERP)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Editar insumo/ });
    const botoes = screen.getAllByRole('button', { name: /Salvar alterações/ });
    expect(botoes.length).toBeGreaterThan(0);
    // Na criação o rótulo é o do recurso ("Salvar insumo").
    expect(screen.queryByRole('button', { name: /^Salvar insumo$/ })).toBeNull();
  });

  it('salva por PUT preservando o status e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Malha penteada'));

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Malha penteada premium' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/insumos/4', {
        nome: 'Malha penteada premium',
        unidade: 'm',
        custo_medio: '12,5',
        fornecedor_id: '1',
        ativo: false,
      })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/insumos'));
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/insumos/4') throw new ApiError(404, 'Insumo não encontrado(a).');
      return {} as never;
    });
    renderPage();

    expect(await screen.findByText('Insumo não encontrado(a).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/insumos');
    semSobreposicao();
  });
});
