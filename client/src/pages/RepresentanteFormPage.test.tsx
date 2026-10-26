// ============================================================================
// CADASTRO DE REPRESENTANTES — PÁGINA própria
// (/representantes/novo e /representantes/:id/editar).
//
// Trava o padrão visual do BROBOND ERP: LISTA → PÁGINA, exatamente como
// Clientes, Fornecedores, Insumos, Cores, Coleções, Grades e Tamanhos. O
// cadastro de representantes DEIXOU de ser um formulário sobreposto
// (modal/drawer) à lista — nada de modal central, drawer, sheet, dialog ou
// overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar representante
//     (na edição: "Salvar alterações");
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados, com as SEÇÕES reais
//     do recurso (Identificação · Comercial · Acesso ao ERP · Contato ·
//     Situação profissional) — e os campos são EXATAMENTE os que existem em
//     `representantes` (db/schema.sql + migration 0021): nome, cpf, cargo,
//     regiao, comissao_pct, usuario_id, telefone, whatsapp, email, admissao,
//     desligamento, observacoes e ativo. Nenhum campo inventado (salário, meta,
//     limite de crédito, banco/PIX, foto, ranking, faturamento ou "vendas
//     totais" persistidas);
//   • CPF: máscara compartilhada do ERP; o dígito verificador e a unicidade por
//     empresa são do SERVIDOR (409 com erro no campo, a página não fecha);
//   • comissão: 0–100% com o texto de que a comissão é paga sobre faturas
//     LIQUIDADAS (a apuração em comissoes.ts não é tocada);
//   • desligamento: registra a situação profissional e NÃO apaga histórico;
//   • salvar envia o contrato existente (POST /representantes, PUT
//     /representantes/:id) e volta para a lista; cancelar/voltar também vão
//     para /representantes sem chamar a API;
//   • RBAC: `representantes` é cadastro por empresa (sem piso de escrita) — a
//     página continua operável; a autorização real é do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RepresentanteFormPage from './RepresentanteFormPage';
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
  // ESPELHO de server/src/resources.ts › representantes (sem campo inventado),
  // incluindo as seções que o RecordForm agrupa.
  const representantes = {
    key: 'representantes',
    label: 'Representantes',
    singular: 'Representante',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true, section: 'Identificação' },
      {
        name: 'cpf',
        label: 'CPF',
        type: 'document',
        documento: 'cpf',
        search: true,
        maxLength: 14,
        section: 'Identificação',
        hint: 'CPF único por empresa (índice uq_representantes_cpf_empresa). O dígito verificador é conferido no servidor.',
      },
      { name: 'cargo', label: 'Cargo', type: 'text', maxLength: 60, search: true, section: 'Identificação' },
      { name: 'regiao', label: 'Região', type: 'text', maxLength: 80, search: true, section: 'Identificação' },
      {
        name: 'comissao_pct',
        label: 'Comissão padrão (%)',
        type: 'percent',
        min: 0,
        max: 100,
        default: 0,
        section: 'Comercial',
        hint: 'A comissão é paga sobre faturas efetivamente LIQUIDADAS, não sobre a venda criada.',
      },
      {
        name: 'usuario_id',
        label: 'Usuário do sistema',
        type: 'ref',
        ref: 'usuarios',
        list: false,
        search: true,
        section: 'Acesso ao ERP',
        hint: 'Vínculo OPCIONAL e único por empresa (uq_representantes_usuario_empresa).',
      },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, search: true, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, search: true, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, search: true, section: 'Contato' },
      { name: 'admissao', label: 'Admissão', type: 'date', list: false, section: 'Situação profissional' },
      {
        name: 'desligamento',
        label: 'Desligamento',
        type: 'date',
        list: false,
        section: 'Situação profissional',
        hint: 'Preencher aqui registra apenas a situação profissional: NÃO apaga o histórico de vendas nem as comissões já apuradas.',
      },
      {
        name: 'ativo',
        label: 'Ativo',
        type: 'boolean',
        default: true,
        section: 'Situação profissional',
        hint: 'Inativo sai das opções de novos cadastros e do vínculo com novos pedidos; o histórico comercial permanece.',
      },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Situação profissional' },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { representantes }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

/** Payload completo de criação só com o nome preenchido (padrões do recurso). */
const PAYLOAD_MINIMO = {
  nome: 'Ana Souza',
  cpf: null,
  cargo: null,
  regiao: null,
  comissao_pct: '0',
  usuario_id: null,
  telefone: null,
  whatsapp: null,
  email: null,
  admissao: null,
  desligamento: null,
  observacoes: null,
  ativo: true,
};

const USUARIOS = [
  { value: 7, label: 'Ana Souza' },
  { value: 9, label: 'Marina Alves' },
];

const REGISTRO = {
  id: 4,
  nome: 'Carlos Lima',
  cpf: '52998224725',
  cargo: 'Representante',
  regiao: 'Norte',
  comissao_pct: 3.5,
  usuario_id: 7,
  telefone: '62999998888',
  whatsapp: null,
  email: 'carlos@brobond.com.br',
  admissao: '2024-03-01',
  desligamento: null,
  observacoes: null,
  ativo: false,
  criado_em: '2024-03-01T10:00:00.000Z',
  atualizado_em: '2024-03-02T10:00:00.000Z',
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/representantes/${routeParams.id}/editar` : '/representantes/novo']}>
      <ToastProvider>
        <RepresentanteFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar (representante|alterações)/ })[0] as HTMLButtonElement;
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
  // `/usuarios/options` é o MESMO contrato do RecordForm genérico.
  apiGet.mockImplementation(async (path: string) =>
    String(path) === '/usuarios/options' ? (USUARIOS as never) : ({} as never)
  );
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 4 } as never);
});

describe('novo representante — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar representante em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Novo representante/ })).toBeInTheDocument();
    expect(
      screen.getByText('Cadastre o representante com o cargo, a região, a comissão padrão e o contato usados nas vendas, propostas e comissões.')
    ).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/representantes');
    // Cancelar e Salvar representante existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar representante/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('organiza o formulário nas seções reais do recurso', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Novo representante/ });

    expect(screen.getByRole('heading', { name: 'Identificação' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Comercial' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Acesso ao ERP' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contato' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Situação profissional' })).toBeInTheDocument();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    // Identificação
    expect(await screen.findByLabelText(/^Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText('CPF')).toBeInTheDocument();
    expect(screen.getByLabelText('Cargo')).toBeInTheDocument();
    expect(screen.getByLabelText('Região')).toBeInTheDocument();
    // Comercial
    expect(screen.getByLabelText(/Comissão padrão/)).toBeInTheDocument();
    // Acesso ao ERP
    expect(screen.getByLabelText('Usuário do sistema')).toBeInTheDocument();
    // Contato
    expect(screen.getByLabelText('Telefone')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
    // Situação profissional
    expect(screen.getByLabelText('Admissão')).toBeInTheDocument();
    expect(screen.getByLabelText('Desligamento')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();
    expect(screen.getByLabelText('Observações')).toBeInTheDocument();

    // Nenhum campo INVENTADO aparece (o domínio de `representantes` não tem
    // nenhum deles — salário, meta, limite de crédito, dados bancários/PIX,
    // foto, ranking, faturamento ou "vendas totais" persistidas).
    expect(
      screen.queryByLabelText(/Sal[aá]rio|Meta|Limite de cr[eé]dito|Banco|PIX|Ag[eê]ncia|Conta corrente|Foto|Imagem|Ranking|Faturamento|Comiss[aã]o acumulada/i)
    ).toBeNull();
    semSobreposicao();
  });

  it('a máscara de CPF é a compartilhada do ERP (digitação mascarada)', async () => {
    renderPage();

    const cpf = await screen.findByLabelText('CPF');
    fireEvent.change(cpf, { target: { value: '52998224725' } });
    expect(cpf).toHaveValue('529.982.247-25');
  });

  it('comissão começa em 0 e o texto explica que ela incide sobre faturas liquidadas', async () => {
    renderPage();

    expect(await screen.findByLabelText(/Comissão padrão/)).toHaveValue('0');
    expect(screen.getByText(/A comissão é paga sobre faturas efetivamente LIQUIDADAS/)).toBeInTheDocument();
  });

  it('cria o representante enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: '  Ana Souza  ' } });
    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '52998224725' } });
    fireEvent.change(screen.getByLabelText('Cargo'), { target: { value: 'Vendedora' } });
    fireEvent.change(screen.getByLabelText('Região'), { target: { value: 'Centro-Oeste' } });
    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '6233334444' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@brobond.com.br' } });
    fireEvent.change(screen.getByLabelText('Usuário do sistema'), { target: { value: '7' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/representantes', {
      ...PAYLOAD_MINIMO,
      nome: 'Ana Souza',
      cpf: '529.982.247-25',
      cargo: 'Vendedora',
      regiao: 'Centro-Oeste',
      telefone: '+55 (62) 3333-4444',
      email: 'ana@brobond.com.br',
      usuario_id: '7',
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/representantes'));
  });

  it('só o nome é obrigatório: campos vazios viram null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Ana Souza' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/representantes', PAYLOAD_MINIMO));
  });

  it('nome vazio bloqueia o envio e mantém a página aberta', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo representante/ });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('CPF duplicado (409 do servidor) mantém a página aberta com a mensagem e o erro no campo', async () => {
    apiPost.mockRejectedValueOnce(
      new ApiError(409, 'Já existe um representante cadastrado com este CPF.', { cpf: 'Já cadastrado' }, 'representante_duplicado')
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Ana Souza' } });
    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '52998224725' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um representante cadastrado com este CPF.')).toBeInTheDocument();
    expect(screen.getByText('Já cadastrado')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Novo representante/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('usuário do sistema é OPCIONAL (— Nenhum —) e usa /usuarios/options', async () => {
    renderPage();

    const usuario = await screen.findByLabelText('Usuário do sistema');
    await waitFor(() => expect(usuario).not.toBeDisabled());
    expect(screen.getByRole('option', { name: '— Nenhum —' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/usuarios/options');
  });

  it('desligamento registra a situação profissional sem apagar histórico', async () => {
    renderPage();

    expect(await screen.findByLabelText('Desligamento')).toBeInTheDocument();
    expect(screen.getByText(/NÃO apaga o histórico de vendas nem as comissões já apuradas/)).toBeInTheDocument();
    expect(screen.getByText(/o histórico comercial permanece/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Carlos Lima' } });
    fireEvent.change(screen.getByLabelText('Desligamento'), { target: { value: '2026-01-31' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/representantes', expect.objectContaining({ desligamento: '2026-01-31' }))
    );
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome/), { target: { value: 'Ana Souza' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/representantes'));
  });

  it('cancelar volta para /representantes sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo representante/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/representantes');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('RBAC preservado: o operador (que já opera o cadastro) pode salvar', async () => {
    mockUser.perfil = 'operador';
    renderPage();

    await screen.findByRole('heading', { name: /Novo representante/ });
    expect(botaoSalvar()).not.toBeDisabled();
    expect(screen.queryByText(/somente de leitura/)).toBeNull();
  });
});

describe('editar representante — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) =>
      String(path) === '/usuarios/options' ? (USUARIOS as never) : (REGISTRO as never)
    );
  });

  it('abre a página "Editar representante" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar representante/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Carlos Lima'));
    // O formulário compartilhado exibe o valor gravado (dígitos); a máscara
    // atua na digitação e a formatação aparece na lista/ficha.
    expect(screen.getByLabelText('CPF')).toHaveValue('52998224725');
    expect(screen.getByLabelText('Cargo')).toHaveValue('Representante');
    expect(screen.getByLabelText('Região')).toHaveValue('Norte');
    expect(screen.getByLabelText(/Comissão padrão/)).toHaveValue('3,5');
    expect(screen.getByLabelText('Usuário do sistema')).toHaveValue('7');
    expect(screen.getByLabelText('Telefone')).toHaveValue('62999998888');
    expect(screen.getByLabelText('E-mail')).toHaveValue('carlos@brobond.com.br');
    expect(screen.getByLabelText('Admissão')).toHaveValue('2024-03-01');
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();
    expect(screen.getByText(/Alterando o representante “Carlos Lima”/)).toBeInTheDocument();
    semSobreposicao();
  });

  it('na edição o botão de salvar é "Salvar alterações" (convenção do ERP)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Editar representante/ });
    expect(screen.getAllByRole('button', { name: /Salvar alterações/ }).length).toBeGreaterThan(0);
    // Na criação o rótulo é o do recurso ("Salvar representante").
    expect(screen.queryByRole('button', { name: /^Salvar representante$/ })).toBeNull();
  });

  it('salva por PUT preservando os demais campos e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/^Nome/)).toHaveValue('Carlos Lima'));

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Carlos Souza' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/representantes/4', {
        nome: 'Carlos Souza',
        cpf: '52998224725',
        cargo: 'Representante',
        regiao: 'Norte',
        comissao_pct: '3,5',
        usuario_id: '7',
        telefone: '62999998888',
        whatsapp: null,
        email: 'carlos@brobond.com.br',
        admissao: '2024-03-01',
        desligamento: null,
        observacoes: null,
        ativo: false,
      })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/representantes'));
  });

  it('registro inexistente ou de outra empresa (404) mostra o caminho de volta, sem modal', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/usuarios/options') return USUARIOS as never;
      throw new ApiError(404, 'Representante não encontrado.');
    });
    renderPage();

    // 404 = inexistente OU de outra empresa (multiempresa): a página continua
    // sendo uma ROTA, com o caminho de volta — nenhum modal de erro.
    expect(await screen.findByRole('heading', { name: /Representante não encontrado/ })).toBeInTheDocument();
    expect(screen.getByText(/Não encontramos este representante na empresa ativa/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/representantes');
    semSobreposicao();
  });
});
