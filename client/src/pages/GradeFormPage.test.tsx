// ============================================================================
// CADASTRO DE GRADES — PÁGINA própria (/grades/novo e /grades/:id/editar).
//
// Trava o padrão visual definitivo do BROBOND ERP (LISTA → PÁGINA) para uma
// grade de tamanhos, que além dos campos do cadastro tem uma relação ORDENADA
// com os tamanhos:
//
//   • a página tem título, descrição, Voltar, Cancelar, Salvar grade e
//     Tabela de medidas (na edição); nenhum `role="dialog"`/`aria-modal`;
//   • os campos são os REAIS do recurso `grades` (nome, descricao,
//     instrucoes_medidas, ativo, tamanhos) — nenhum campo inventado;
//   • TAMANHOS: disponíveis viram chips; a grade lista os selecionados com
//     NUMERAÇÃO explícita, ↑ ↓ para reordenar, remoção individual, contagem
//     "N tamanhos selecionados" e SEM duplicidade;
//   • PRÉVIA: nome + sequência "P → M → G" + total acompanham o formulário;
//   • ORIENTAÇÕES DE MEDIÇÃO: `instrucoes_medidas` com a ajuda do catálogo;
//   • validação bloqueia o envio (nome vazio / nenhum tamanho) sem tocar a API;
//   • salvar envia o contrato existente (POST /grades, PUT /grades/:id com
//     `tamanhos` NA ORDEM) e volta para a lista;
//   • edição carrega a ordem gravada e a preserva quando nada muda;
//   • RBAC: perfil sem piso de escrita vê o aviso e não pode salvar (a
//     autorização real continua no servidor).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GradeFormPage from './GradeFormPage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';

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
  // ESPELHO de server/src/resources.ts › grades (sem campo inventado).
  const grades = {
    key: 'grades',
    label: 'Grades',
    singular: 'Grade',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    filterFields: ['ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, maxLength: 60 },
      {
        name: 'tamanhos',
        label: 'Tamanhos',
        type: 'multiref',
        ref: 'tamanhos',
        required: true,
        virtual: true,
        list: true,
      },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, maxLength: 160 },
      { name: 'instrucoes_medidas', label: 'Instruções de medição', type: 'textarea', list: false, maxLength: 600 },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { grades }, modules: [], mode: 'memory' }),
  };
});

const OPCOES = [
  { value: 1, label: 'PP' },
  { value: 2, label: 'P' },
  { value: 3, label: 'M' },
  { value: 4, label: 'G' },
  { value: 5, label: 'GG' },
];

const GRADE_EXISTENTE = {
  id: 7,
  nome: 'Camiseta PP-GG',
  descricao: 'Malha e camisaria básica',
  instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.',
  ativo: true,
  tamanhos: [2, 3, 4],
  tamanhos__label: 'P · M · G',
  tamanhos_total: 3,
};

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/grades/${routeParams.id}/editar` : '/grades/novo']}>
      <ToastProvider>
        <GradeFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar grade/ })[0] as HTMLButtonElement;
}

/**
 * Chip de tamanho disponível ("P", "M"...). O nome acessível é só o código e as
 * opções vêm da API — por isso a busca é assíncrona.
 */
async function chip(codigo: string): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name: codigo })) as HTMLButtonElement;
}

/** Sequência real exibida em "Tamanhos da grade": ["1 P", "2 M", "3 G"]. */
function itensOrdenados(): string[] {
  const numeros = screen.queryAllByTestId('grade-ordem-numero').map((el) => el.textContent ?? '');
  const codigos = screen.queryAllByTestId('grade-tamanho-codigo').map((el) => el.textContent ?? '');
  return numeros.map((n, i) => `${n} ${codigos[i] ?? ''}`.trim());
}

/** Nenhuma superfície sobreposta (modal, drawer, sheet) pode existir na página. */
function semSobreposicao() {
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
}

async function preencherNome(valor: string) {
  fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: valor } });
}

beforeEach(() => {
  routeParams = {};
  mockUser.perfil = 'gerente';
  navigateMock.mockReset();
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/tamanhos/options') return OPCOES as never;
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 21 } as never);
  apiPut.mockResolvedValue({ id: 7 } as never);
});

describe('nova grade — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar, Cancelar e Salvar grade em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Nova grade/ })).toBeInTheDocument();
    expect(screen.getByText('Configure uma grade de tamanhos para utilização no catálogo de produtos.')).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/grades');
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar grade/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('mostra as seções e os campos REAIS do cadastro (nenhum campo inventado)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Identificação da grade/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tamanhos da grade/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Prévia da grade/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Orientações de medição/i })).toBeInTheDocument();

    expect(screen.getByLabelText(/^Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText('Descrição')).toBeInTheDocument();
    expect(screen.getByLabelText('Instruções para o cliente')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Ativo/ })).toBeInTheDocument();

    // Nada de campo novo: só o que existe em server/src/resources.ts › grades.
    expect(screen.queryByLabelText(/ordem/i)).toBeNull();
    expect(screen.queryByLabelText(/cole[çc][aã]o/i)).toBeNull();
  });

  it('lista os tamanhos cadastrados como disponíveis, vindos da API', async () => {
    renderPage();

    expect(await screen.findByRole('group', { name: /Tamanhos disponíveis/i })).toBeInTheDocument();
    for (const opcao of OPCOES) {
      expect(await chip(opcao.label)).toBeInTheDocument();
    }
    expect(screen.getByText('0 tamanhos selecionados')).toBeInTheDocument();
    expect(screen.getByText('Nenhum tamanho na grade ainda.')).toBeInTheDocument();
  });

  it('marcar um tamanho entra na grade com NUMERAÇÃO explícita e atualiza a contagem', async () => {
    renderPage();

    fireEvent.click(await chip('P'));
    expect(screen.getByText('1 tamanho selecionado')).toBeInTheDocument();
    expect(itensOrdenados()).toEqual(['1 P']);
    expect(await chip('P')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(await chip('M'));
    fireEvent.click(await chip('G'));
    expect(screen.getByText('3 tamanhos selecionados')).toBeInTheDocument();
    expect(itensOrdenados()).toEqual(['1 P', '2 M', '3 G']);
  });

  it('não aceita tamanho duplicado: clicar de novo REMOVE da grade', async () => {
    renderPage();

    const p = await chip('P');
    fireEvent.click(p);
    fireEvent.click(p);
    fireEvent.click(p);

    expect(screen.getByText('1 tamanho selecionado')).toBeInTheDocument();
    expect(itensOrdenados()).toEqual(['1 P']);
    expect(p).toHaveAttribute('aria-pressed', 'true');
  });

  it('reordena com ↑ ↓ (acessível por teclado) sem duplicar nem perder tamanho', async () => {
    renderPage();

    fireEvent.click(await chip('P'));
    fireEvent.click(await chip('M'));
    fireEvent.click(await chip('G'));

    // GG entra no fim da sequência e sobe até a posição 1.
    fireEvent.click(await chip('GG'));
    const subirGG = screen.getByRole('button', { name: /Mover GG para cima/ });
    fireEvent.click(subirGG);
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para cima/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para cima/ }));

    expect(itensOrdenados()).toEqual(['1 GG', '2 P', '3 M', '4 G']);
    // O primeiro item não sobe e o último não desce (estados desabilitados).
    expect(screen.getByRole('button', { name: /Mover GG para cima/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Mover G para baixo/ })).toBeDisabled();

    // Descer devolve a ordem anterior.
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para baixo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para baixo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para baixo/ }));
    expect(itensOrdenados()).toEqual(['1 P', '2 M', '3 G', '4 GG']);
  });

  it('remove um tamanho individualmente e mantém a ordem dos demais', async () => {
    renderPage();

    fireEvent.click(await chip('P'));
    fireEvent.click(await chip('M'));
    fireEvent.click(await chip('G'));

    fireEvent.click(screen.getByRole('button', { name: /Remover M da grade/ }));

    expect(screen.getByText('2 tamanhos selecionados')).toBeInTheDocument();
    expect(itensOrdenados()).toEqual(['1 P', '2 G']);
    expect(await chip('M')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a prévia acompanha o formulário em tempo real (nome, sequência e total)', async () => {
    renderPage();

    await preencherNome('Camiseta P ao GG');
    fireEvent.click(await chip('P'));
    fireEvent.click(await chip('M'));
    fireEvent.click(await chip('G'));

    const previa = screen.getByRole('region', { name: /Prévia da grade/i });
    expect(previa).toHaveTextContent('Camiseta P ao GG');
    expect(previa.textContent?.replace(/\s+/g, ' ')).toMatch(/P.*M.*G/);
    expect(previa).toHaveTextContent('3 tamanhos');

    // Sem nome, a prévia não inventa um.
    await preencherNome('   ');
    expect(screen.getByRole('region', { name: /Prévia da grade/i })).toHaveTextContent('Grade sem nome');
  });

  it('bloqueia o envio sem nome e sem tamanho, mostrando o erro no lugar certo', async () => {
    renderPage();

    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/i)).toBeInTheDocument();
    expect(screen.getByText('Campo obrigatório')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nome/)).toHaveAttribute('aria-invalid', 'true');
    expect(apiPost).not.toHaveBeenCalled();

    // Só falta o tamanho: a seção fala de tamanhos, não um texto genérico.
    await preencherNome('Camiseta P ao GG');
    fireEvent.click(botaoSalvar());
    expect(await screen.findByText('Selecione ao menos um tamanho para a grade.')).toBeInTheDocument();
    expect(screen.getByText(/Preencha os campos obrigatórios destacados/i)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    // O foco vai para o grupo de tamanhos (teclado continua operável).
    await waitFor(() => expect(document.activeElement?.id).toBe('grade-primeiro-tamanho'));
  });

  it('salva enviando o contrato existente, com os tamanhos NA ORDEM, e volta para a lista', async () => {
    renderPage();

    await preencherNome('Camiseta P ao GG');
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Malha e camisaria básica' } });
    fireEvent.change(screen.getByLabelText('Instruções para o cliente'), {
      target: { value: 'Meça a peça sobre uma superfície plana, sem esticar.' },
    });
    fireEvent.click(await chip('P'));
    fireEvent.click(await chip('M'));
    fireEvent.click(await chip('G'));

    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [rota, corpo] = apiPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(rota).toBe('/grades');
    expect(corpo).toEqual({
      nome: 'Camiseta P ao GG',
      tamanhos: [2, 3, 4],
      descricao: 'Malha e camisaria básica',
      instrucoes_medidas: 'Meça a peça sobre uma superfície plana, sem esticar.',
      ativo: true,
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/grades'));
  });

  it('texto opcional vazio vai como null (mesma regra do servidor)', async () => {
    renderPage();

    await preencherNome('Grade enxuta');
    fireEvent.click(await chip('P'));
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Instruções para o cliente'), { target: { value: '' } });

    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const corpo = apiPost.mock.calls[0][1] as Record<string, unknown>;
    expect(corpo.descricao).toBeNull();
    expect(corpo.instrucoes_medidas).toBeNull();
  });

  it('desativar na página envia ativo=false e a ajuda explica o que acontece', async () => {
    renderPage();

    const ativo = screen.getByRole('switch', { name: /Ativo/ });
    expect(ativo).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/disponível para categorias, produtos e tabela de medidas/i)).toBeInTheDocument();

    fireEvent.click(ativo);

    expect(ativo).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Grade inativa: sai das listas de seleção, mas tamanhos, produtos e medidas são preservados/i)).toBeInTheDocument();

    await preencherNome('Grade inativa');
    fireEvent.click(await chip('P'));
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect((apiPost.mock.calls[0][1] as Record<string, unknown>).ativo).toBe(false);
  });

  it('mostra o erro devolvido pela API (nome duplicado) no campo', async () => {
    const { ApiError } = await import('../lib/api');
    apiPost.mockRejectedValueOnce(new ApiError(409, 'Já existe um registro com este nome', { nome: 'Já cadastrado' }) as never);
    renderPage();

    await preencherNome('Camiseta P-GG');
    fireEvent.click(await chip('P'));
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um registro com este nome')).toBeInTheDocument();
    expect(await screen.findByText('Já cadastrado')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('respeita o limite de caracteres real do campo (60/160/600)', async () => {
    renderPage();

    expect(await screen.findByLabelText(/^Nome/)).toHaveAttribute('maxlength', '60');
    expect(screen.getByLabelText('Descrição')).toHaveAttribute('maxlength', '160');
    expect(screen.getByLabelText('Instruções para o cliente')).toHaveAttribute('maxlength', '600');
  });

  it('ajuda das orientações de medição é a do catálogo público', async () => {
    renderPage();

    expect(
      await screen.findByText('Estas orientações podem aparecer na tabela de medidas e no catálogo público.')
    ).toBeInTheDocument();
  });
});

describe('editar grade — mesma página, estado real carregado', () => {
  beforeEach(() => {
    routeParams = { id: '7' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/tamanhos/options') return OPCOES as never;
      if (String(path) === '/grades/7') return GRADE_EXISTENTE as never;
      return {} as never;
    });
  });

  it('abre com o título de edição e carrega todos os campos, na ordem gravada', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar grade/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Camiseta PP-GG'));
    expect(screen.getByLabelText('Descrição')).toHaveValue('Malha e camisaria básica');
    expect(screen.getByLabelText('Instruções para o cliente')).toHaveValue(
      'Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm.'
    );
    expect(screen.getByRole('switch', { name: /Ativo/ })).toHaveAttribute('aria-checked', 'true');
    expect(itensOrdenados()).toEqual(['1 P', '2 M', '3 G']);
    expect(screen.getByText('3 tamanhos selecionados')).toBeInTheDocument();

    semSobreposicao();
  });

  it('oferece o atalho para a TABELA DE MEDIDAS da grade (módulo existente)', async () => {
    renderPage();

    const atalho = await screen.findByRole('link', { name: /Abrir a tabela de medidas desta grade/ });
    expect(atalho).toHaveAttribute('href', '/medidas?grade=7');
  });

  it('reordenar e salvar envia PUT com a nova ordem (nada é recriado do zero)', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Editar grade/ });
    await waitFor(() => expect(itensOrdenados()).toHaveLength(3));

    // GG entra no fim e sobe até a posição 1.
    fireEvent.click(await chip('GG'));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para cima/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para cima/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mover GG para cima/ }));
    // P sai da grade.
    fireEvent.click(screen.getByRole('button', { name: /Remover P da grade/ }));

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Grade revisada' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [rota, corpo] = apiPut.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(rota).toBe('/grades/7');
    expect(corpo.tamanhos).toEqual([5, 3, 4]);
    expect(corpo.descricao).toBe('Grade revisada');
    expect(corpo.nome).toBe('Camiseta PP-GG');
    expect(apiPost).not.toHaveBeenCalled();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/grades'));
  });

  it('salvar sem mexer nos tamanhos envia a MESMA ordem carregada', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Editar grade/ });
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Camiseta PP-GG'));

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Só a descrição mudou' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect((apiPut.mock.calls[0][1] as Record<string, unknown>).tamanhos).toEqual([2, 3, 4]);
  });

  it('mostra o estado de carregamento enquanto busca a grade (tela nunca congelada)', async () => {
    renderPage();

    expect(screen.getByText('Carregando grade...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Editar grade/ })).toBeInTheDocument());
  });

  it('falha ao carregar com o erro real e uma saída clara para a lista', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/tamanhos/options') return OPCOES as never;
      const { ApiError } = await import('../lib/api');
      throw new ApiError(404, 'Registro não encontrado') as never;
    });
    renderPage();

    expect(await screen.findByText('Registro não encontrado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/grades');
    expect(screen.queryByLabelText(/^Nome/)).toBeNull();
  });

  it('avisa quando o dicionário de tamanhos não carrega (a grade não some)', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/tamanhos/options') throw new Error('falha de rede');
      return GRADE_EXISTENTE as never;
    });
    renderPage();

    expect(await screen.findByText('Não foi possível carregar os tamanhos cadastrados.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Camiseta PP-GG'));
    expect(itensOrdenados()).toHaveLength(3);
  });
});

describe('RBAC espelhado na página (o servidor continua sendo a autoridade)', () => {
  it('operador vê a página em leitura: aviso, controles desabilitados e salvar bloqueado', async () => {
    mockUser.perfil = 'operador';
    renderPage();

    expect(
      await screen.findByText(/Seu perfil tem acesso somente de leitura a Grades/i)
    ).toBeInTheDocument();
    expect(botaoSalvar()).toBeDisabled();
    expect(botaoSalvar()).toHaveAttribute('title', 'Seu perfil não tem permissão para salvar grades.');
    expect(screen.getByLabelText(/^Nome/)).toBeDisabled();
    expect(await chip('P')).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Ativo/ })).toBeDisabled();

    fireEvent.click(botaoSalvar());
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('admin também pode salvar (piso de escrita é gerente+)', async () => {
    mockUser.perfil = 'admin';
    renderPage();

    await preencherNome('Grade do admin');
    fireEvent.click(await chip('P'));
    expect(botaoSalvar()).not.toBeDisabled();

    fireEvent.click(botaoSalvar());
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
  });
});
