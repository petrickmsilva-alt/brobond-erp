// ============================================================================
// CADASTRO DE CORES — PÁGINA própria (/cores/novo e /cores/:id/editar).
//
// Trava o padrão visual definitivo do BROBOND ERP para cadastros simples:
// LISTA → PÁGINA. Nada de modal central, drawer, sheet ou overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar cor;
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados (campos reais:
//     Nome, Código HEX, Ativo) — nenhum campo inventado;
//   • o preview HEX acompanha a digitação em tempo real e normaliza ao sair
//     do campo (#abc → #AABBCC), com a mesma regra do servidor;
//   • HEX inválido mostra o erro e NÃO chega à API;
//   • nome vazio bloqueia o envio e mantém o que foi digitado;
//   • salvar envia o contrato existente (POST /cores, PUT /cores/:id) e volta
//     para a lista; cancelar/voltar também vão para /cores sem chamar a API;
//   • RBAC: perfil sem piso de escrita vê o aviso e não pode salvar (a
//     autorização real continua no servidor).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CorFormPage from './CorFormPage';
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
  // ESPELHO de server/src/resources.ts › cores (sem campo inventado).
  const cores = {
    key: 'cores',
    label: 'Cores',
    singular: 'Cor',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 40, placeholder: 'Azul marinho' },
      { name: 'hex', label: 'Código HEX', type: 'color', maxLength: 7, search: true, placeholder: '#172038', hint: 'Opcional. Ex.: #172038.' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { cores }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/cores/${routeParams.id}/editar` : '/cores/novo']}>
      <ToastProvider>
        <CorFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar cor/ })[0] as HTMLButtonElement;
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

describe('nova cor — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar cor em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Nova cor/ })).toBeInTheDocument();
    expect(screen.getByText('Cadastre uma cor para utilização no catálogo de produtos.')).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/cores');
    // Cancelar e Salvar cor existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar cor/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    expect(await screen.findByLabelText(/^Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText('Código HEX')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();
    // A amostra visual é um bloco da página, não um overlay.
    expect(screen.getByRole('region', { name: 'Amostra visual' })).toBeInTheDocument();
    // Nenhum campo extra (ex.: descrição, referência, SKU) aparece.
    expect(screen.queryByLabelText(/Descrição/)).toBeNull();
  });

  it('cria a cor enviando o contrato existente (nome aparado + HEX canônico) e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: '  Azul marinho  ' } });
    fireEvent.change(screen.getByLabelText('Código HEX'), { target: { value: '172038' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/cores', { nome: 'Azul marinho', hex: '#172038', ativo: true });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cores'));
  });

  it('HEX vazio é permitido e vira null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Cinza mescla' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/cores', { nome: 'Cinza mescla', hex: null, ativo: true }));
  });

  it('a amostra visual acompanha o HEX em tempo real e normaliza ao sair do campo', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Azul marinho' } });
    const hex = screen.getByLabelText('Código HEX');

    fireEvent.change(hex, { target: { value: '#172038' } });
    expect(screen.getByRole('img', { name: /Amostra da cor Azul marinho: #172038/i })).toHaveStyle({ backgroundColor: '#172038' });

    fireEvent.change(hex, { target: { value: '#F5F5F0' } });
    expect(screen.getByRole('img', { name: /Amostra da cor Azul marinho: #F5F5F0/i })).toHaveStyle({ backgroundColor: '#F5F5F0' });

    // Forma curta é expandida ao sair do campo (mesma regra do servidor).
    fireEvent.change(hex, { target: { value: '#abc' } });
    fireEvent.blur(hex);
    expect(hex).toHaveValue('#AABBCC');
  });

  it('HEX inválido mostra erro claro e não é enviado à API', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Azul' } });
    fireEvent.change(screen.getByLabelText('Código HEX'), { target: { value: '#12' } });

    // Erro em tempo real na prévia…
    expect(screen.getByText('Informe o HEX no formato #RRGGBB (ex.: #172038).')).toBeInTheDocument();

    fireEvent.click(botaoSalvar());

    // …e o envio é bloqueado, com a página intacta (nada de modal por cima).
    await waitFor(() => expect(screen.getAllByText(/formato #RRGGBB/i).length).toBeGreaterThan(1));
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Nova cor/ })).toBeInTheDocument();
    semSobreposicao();
  });

  it('nome vazio bloqueia o envio e preserva o HEX digitado', async () => {
    renderPage();

    const hex = await screen.findByLabelText('Código HEX');
    fireEvent.change(hex, { target: { value: '#172038' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Campo obrigatório')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(hex).toHaveValue('#172038');
  });

  it('nome duplicado (409) mantém a página aberta com a mensagem do servidor no campo', async () => {
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este nome.', { nome: 'Já cadastrado' }));
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'azul marinho' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um registro com este nome.')).toBeInTheDocument();
    expect(screen.getByText('Já cadastrado')).toBeInTheDocument();
    // Continua na PÁGINA (sem formulário sobreposto) para corrigir o nome.
    expect(screen.getByRole('heading', { name: /Nova cor/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Azul marinho' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cores'));
  });

  it('cancelar volta para /cores sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Nova cor/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/cores');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('perfil sem alçada de escrita vê o aviso e não pode salvar (o servidor continua barrando)', async () => {
    mockUser.perfil = 'operador';
    renderPage();

    expect(await screen.findByText(/acesso somente de leitura a Cores/)).toBeInTheDocument();
    expect(botaoSalvar()).toBeDisabled();
  });
});

describe('editar cor — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/cores/4') return { id: 4, nome: 'Cinza mescla', hex: '#9CA3AF', ativo: false } as never;
      return {} as never;
    });
  });

  it('abre a página "Editar cor" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar cor/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Cinza mescla'));
    expect(screen.getByLabelText('Código HEX')).toHaveValue('#9CA3AF');
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();
    expect(screen.getByText(/Alterando a cor “Cinza mescla”/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Amostra da cor Cinza mescla: #9CA3AF/i })).toHaveStyle({ backgroundColor: '#9CA3AF' });
    semSobreposicao();
  });

  it('salva por PUT preservando o status e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Cinza mescla'));

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Cinza mescla escuro' } });
    fireEvent.change(screen.getByLabelText('Código HEX'), { target: { value: '#6b7280' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/cores/4', { nome: 'Cinza mescla escuro', hex: '#6B7280', ativo: false })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cores'));
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async () => {
      throw new ApiError(404, 'Cor não encontrado(a).');
    });
    renderPage();

    expect(await screen.findByText('Cor não encontrado(a).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/cores');
    semSobreposicao();
  });
});
