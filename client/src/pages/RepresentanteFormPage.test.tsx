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
//     do recurso (Identificação · Dados profissionais · Contato · Endereço ·
//     Comercial · Acesso ao ERP · Observações) — e os campos são EXATAMENTE os
//     que existem em `representantes` (db/schema.sql + migrations 0021/0048):
//     código comercial, tipo de pessoa, PF/PJ (CPF/CNPJ, razão social, nome
//     fantasia), tipo de representante, cargo, registro profissional, datas,
//     contato, endereço estruturado, território, comissão padrão, usuário e
//     observações. Nenhum campo inventado (salário, meta, limite de crédito,
//     banco/PIX, foto, ranking, faturamento ou "vendas totais" persistidas);
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
      // ---------------- Identificação ----------------
      { name: 'codigo', label: 'Código', type: 'text', search: true, maxLength: 24, section: 'Identificação', placeholder: 'REP00001' },
      {
        name: 'tipo_pessoa',
        label: 'Tipo de pessoa',
        type: 'select',
        default: 'PF',
        section: 'Identificação',
        options: [
          { value: 'PF', label: 'Pessoa física (CPF)' },
          { value: 'PJ', label: 'Pessoa jurídica (CNPJ)' },
        ],
      },
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true, section: 'Identificação' },
      { name: 'razao_social', label: 'Razão social', type: 'text', search: true, maxLength: 160, section: 'Identificação' },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', search: true, maxLength: 160, section: 'Identificação' },
      { name: 'cpf', label: 'CPF', type: 'document', documento: 'cpf', search: true, maxLength: 14, section: 'Identificação' },
      { name: 'cnpj', label: 'CNPJ', type: 'document', documento: 'cnpj', search: true, maxLength: 18, section: 'Identificação' },
      { name: 'data_nascimento', label: 'Data de nascimento', type: 'date', list: false, section: 'Identificação' },

      // ---------------- Dados profissionais ----------------
      {
        name: 'tipo_representante',
        label: 'Tipo de representante',
        type: 'select',
        default: 'REPRESENTANTE_COMERCIAL',
        section: 'Dados profissionais',
        options: [
          { value: 'INTERNO', label: 'Interno' },
          { value: 'EXTERNO', label: 'Externo' },
          { value: 'REPRESENTANTE_COMERCIAL', label: 'Representante comercial' },
          { value: 'SUPERVISOR', label: 'Supervisor' },
          { value: 'COORDENADOR', label: 'Coordenador' },
          { value: 'GERENTE', label: 'Gerente' },
          { value: 'PARCEIRO', label: 'Parceiro' },
          { value: 'TERCEIRIZADO', label: 'Terceirizado' },
        ],
      },
      { name: 'cargo', label: 'Cargo', type: 'text', maxLength: 60, search: true, section: 'Dados profissionais' },
      { name: 'registro_profissional', label: 'Registro profissional', type: 'text', maxLength: 40, search: true, section: 'Dados profissionais' },
      { name: 'orgao_registro', label: 'Órgão do registro', type: 'text', maxLength: 40, section: 'Dados profissionais' },
      { name: 'admissao', label: 'Admissão', type: 'date', list: false, section: 'Dados profissionais' },
      {
        name: 'desligamento',
        label: 'Desligamento',
        type: 'date',
        list: false,
        section: 'Dados profissionais',
        hint: 'Registra a situação profissional e desativa o cadastro para NOVAS atribuições. NÃO apaga histórico de vendas, carteira, metas nem comissões já apuradas.',
      },
      {
        name: 'ativo',
        label: 'Ativo',
        type: 'boolean',
        default: true,
        section: 'Dados profissionais',
        hint: 'Inativo sai das opções de novos cadastros e do vínculo com novos pedidos; o histórico comercial permanece.',
      },

      // ---------------- Contato ----------------
      { name: 'telefone', label: 'Telefone comercial', type: 'phone', maxLength: 20, search: true, section: 'Contato' },
      { name: 'celular', label: 'Celular', type: 'phone', maxLength: 20, list: false, search: true, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, search: true, section: 'Contato' },
      { name: 'email', label: 'E-mail comercial', type: 'email', maxLength: 160, search: true, section: 'Contato' },

      // ---------------- Endereço ----------------
      { name: 'cep', label: 'CEP', type: 'cep', list: false, section: 'Endereço' },
      { name: 'logradouro', label: 'Logradouro', type: 'text', maxLength: 160, list: false, section: 'Endereço' },
      { name: 'numero', label: 'Número', type: 'text', maxLength: 20, list: false, section: 'Endereço' },
      { name: 'complemento', label: 'Complemento', type: 'text', maxLength: 80, list: false, section: 'Endereço' },
      { name: 'bairro', label: 'Bairro', type: 'text', maxLength: 80, list: false, section: 'Endereço' },
      { name: 'cidade', label: 'Cidade', type: 'text', maxLength: 80, list: false, search: true, section: 'Endereço' },
      { name: 'uf', label: 'UF', type: 'uf', list: false, search: true, section: 'Endereço' },
      { name: 'pais', label: 'País', type: 'text', maxLength: 60, default: 'Brasil', list: false, section: 'Endereço' },

      // ---------------- Comercial ----------------
      {
        name: 'comissao_pct',
        label: 'Comissão padrão (%)',
        type: 'percent',
        min: 0,
        max: 100,
        default: 0,
        section: 'Comercial',
        hint: 'Padrão de referência do cadastro. A comissão efetiva é apurada pelo MOTOR (planos/regras/atribuição) sobre faturas efetivamente LIQUIDADAS — nunca sobre a venda criada.',
      },
      { name: 'territorio_id', label: 'Território', type: 'ref', ref: 'territorios', search: true, section: 'Comercial' },
      { name: 'regiao', label: 'Região (legado)', type: 'text', search: true, maxLength: 80, section: 'Comercial' },

      // ---------------- Acesso ao ERP ----------------
      {
        name: 'usuario_id',
        label: 'Usuário do sistema',
        type: 'ref',
        ref: 'usuarios',
        list: false,
        search: true,
        section: 'Acesso ao ERP',
      },

      // ---------------- Observações ----------------
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Observações' },
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
  codigo: null,
  tipo_pessoa: 'PF',
  nome: 'Ana Souza',
  razao_social: null,
  nome_fantasia: null,
  cpf: null,
  cnpj: null,
  data_nascimento: null,
  tipo_representante: 'REPRESENTANTE_COMERCIAL',
  cargo: null,
  registro_profissional: null,
  orgao_registro: null,
  admissao: null,
  desligamento: null,
  ativo: true,
  telefone: null,
  celular: null,
  whatsapp: null,
  email: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  uf: null,
  pais: 'Brasil',
  comissao_pct: '0',
  territorio_id: null,
  regiao: null,
  usuario_id: null,
  observacoes: null,
};

const USUARIOS = [
  { value: 7, label: 'Ana Souza' },
  { value: 9, label: 'Marina Alves' },
];

const TERRITORIOS = [
  { value: 10, label: 'Centro-Oeste' },
  { value: 11, label: 'Sudeste' },
];

const REGISTRO = {
  id: 4,
  codigo: 'REP00004',
  tipo_pessoa: 'PF',
  nome: 'Carlos Lima',
  razao_social: null,
  nome_fantasia: null,
  cpf: '52998224725',
  cnpj: null,
  data_nascimento: '1985-04-12',
  tipo_representante: 'GERENTE',
  cargo: 'Representante',
  registro_profissional: 'CORE-1234',
  orgao_registro: 'CORE',
  regiao: 'Norte',
  comissao_pct: 3.5,
  territorio_id: 10,
  usuario_id: 7,
  telefone: '62999998888',
  celular: '62988887777',
  whatsapp: null,
  email: 'carlos@brobond.com.br',
  cep: '74000000',
  logradouro: 'Avenida Central',
  numero: '100',
  complemento: null,
  bairro: 'Setor Bueno',
  cidade: 'Goiânia',
  uf: 'GO',
  pais: 'Brasil',
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
  // `/usuarios/options` e `/territorios/options` são os MESMOS contratos de
  // opções do RecordForm genérico (nada de lista digitada na tela).
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/usuarios/options') return USUARIOS as never;
    if (String(path) === '/territorios/options') return TERRITORIOS as never;
    return {} as never;
  });
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 4 } as never);
});

describe('novo representante — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar representante em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Novo representante/ })).toBeInTheDocument();
    // A descrição é a do CADASTRO 2.0 (fonte única em lib/lista.ts): identidade
    // profissional e contato/endereço aqui; equipe, carteira, metas e comissão
    // nos próprios domínios.
    expect(screen.getByText(/identidade profissional \(código, PF\/PJ, CPF\/CNPJ\)/)).toBeInTheDocument();
    expect(screen.getByText(/Equipe, carteira, metas e comissão vivem nos próprios domínios/)).toBeInTheDocument();

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
    expect(screen.getByRole('heading', { name: 'Dados profissionais' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contato' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Endereço' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Comercial' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Acesso ao ERP' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Observações' })).toBeInTheDocument();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    // Identificação
    expect(await screen.findByLabelText('Código')).toBeInTheDocument();
    expect(screen.getByLabelText('Tipo de pessoa')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nome(?! fantasia)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Razão social')).toBeInTheDocument();
    expect(screen.getByLabelText('Nome fantasia')).toBeInTheDocument();
    expect(screen.getByLabelText('CPF')).toBeInTheDocument();
    expect(screen.getByLabelText('CNPJ')).toBeInTheDocument();
    expect(screen.getByLabelText('Data de nascimento')).toBeInTheDocument();
    // Dados profissionais
    expect(screen.getByLabelText('Tipo de representante')).toBeInTheDocument();
    expect(screen.getByLabelText('Cargo')).toBeInTheDocument();
    expect(screen.getByLabelText('Registro profissional')).toBeInTheDocument();
    expect(screen.getByLabelText('Órgão do registro')).toBeInTheDocument();
    expect(screen.getByLabelText('Admissão')).toBeInTheDocument();
    expect(screen.getByLabelText('Desligamento')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();
    // Contato
    expect(screen.getByLabelText('Telefone comercial')).toBeInTheDocument();
    expect(screen.getByLabelText('Celular')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail comercial')).toBeInTheDocument();
    // Endereço ESTRUTURADO (não um texto único)
    expect(screen.getByLabelText('CEP')).toBeInTheDocument();
    expect(screen.getByLabelText('Logradouro')).toBeInTheDocument();
    expect(screen.getByLabelText('Número')).toBeInTheDocument();
    expect(screen.getByLabelText('Complemento')).toBeInTheDocument();
    expect(screen.getByLabelText('Bairro')).toBeInTheDocument();
    expect(screen.getByLabelText('Cidade')).toBeInTheDocument();
    expect(screen.getByLabelText('UF')).toBeInTheDocument();
    expect(screen.getByLabelText('País')).toHaveValue('Brasil');
    // Comercial
    expect(screen.getByLabelText(/Comissão padrão/)).toBeInTheDocument();
    expect(screen.getByLabelText('Território')).toBeInTheDocument();
    expect(screen.getByLabelText('Região (legado)')).toBeInTheDocument();
    // Acesso ao ERP
    expect(screen.getByLabelText('Usuário do sistema')).toBeInTheDocument();
    // Observações
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
    expect(screen.getByText(/apurada pelo MOTOR \(planos\/regras\/atribuição\) sobre faturas efetivamente LIQUIDADAS/)).toBeInTheDocument();
  });

  it('cria o representante enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome(?! fantasia)/), { target: { value: '  Ana Souza  ' } });
    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '52998224725' } });
    fireEvent.change(screen.getByLabelText('Cargo'), { target: { value: 'Vendedora' } });
    fireEvent.change(screen.getByLabelText('Região (legado)'), { target: { value: 'Centro-Oeste' } });
    fireEvent.change(screen.getByLabelText('Telefone comercial'), { target: { value: '6233334444' } });
    fireEvent.change(screen.getByLabelText('Celular'), { target: { value: '62988887777' } });
    fireEvent.change(screen.getByLabelText('E-mail comercial'), { target: { value: 'ana@brobond.com.br' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Goiânia' } });
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'GO' } });
    fireEvent.change(screen.getByLabelText('Logradouro'), { target: { value: 'Avenida Central' } });
    fireEvent.change(screen.getByLabelText('Número'), { target: { value: '100' } });
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
      celular: '+55 (62) 98888-7777',
      email: 'ana@brobond.com.br',
      cidade: 'Goiânia',
      uf: 'GO',
      logradouro: 'Avenida Central',
      numero: '100',
      usuario_id: '7',
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/representantes'));
  });

  it('só o nome é obrigatório: campos vazios viram null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^Nome(?! fantasia)/), { target: { value: 'Ana Souza' } });
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

    fireEvent.change(await screen.findByLabelText(/^Nome(?! fantasia)/), { target: { value: 'Ana Souza' } });
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
    expect(screen.getAllByRole('option', { name: '— Nenhum —' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: 'Ana Souza' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/usuarios/options');
  });

  it('desligamento registra a situação profissional sem apagar histórico', async () => {
    renderPage();

    expect(await screen.findByLabelText('Desligamento')).toBeInTheDocument();
    expect(screen.getByText(/NÃO apaga histórico de vendas, carteira, metas nem comissões já apuradas/)).toBeInTheDocument();
    expect(screen.getByText(/o histórico comercial permanece/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Nome(?! fantasia)/), { target: { value: 'Carlos Lima' } });
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

    fireEvent.change(await screen.findByLabelText(/^Nome(?! fantasia)/), { target: { value: 'Ana Souza' } });
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
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/usuarios/options') return USUARIOS as never;
      if (String(path) === '/territorios/options') return TERRITORIOS as never;
      return REGISTRO as never;
    });
  });

  it('abre a página "Editar representante" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar representante/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Nome(?! fantasia)/)).toHaveValue('Carlos Lima'));
    // O formulário compartilhado exibe o valor gravado (dígitos); a máscara
    // atua na digitação e a formatação aparece na lista/ficha.
    expect(screen.getByLabelText('Código')).toHaveValue('REP00004');
    expect(screen.getByLabelText('Tipo de pessoa')).toHaveValue('PF');
    expect(screen.getByLabelText('CPF')).toHaveValue('52998224725');
    expect(screen.getByLabelText('CNPJ')).toHaveValue('');
    expect(screen.getByLabelText('Tipo de representante')).toHaveValue('GERENTE');
    expect(screen.getByLabelText('Cargo')).toHaveValue('Representante');
    expect(screen.getByLabelText('Registro profissional')).toHaveValue('CORE-1234');
    expect(screen.getByLabelText('Região (legado)')).toHaveValue('Norte');
    expect(screen.getByLabelText(/Comissão padrão/)).toHaveValue('3,5');
    expect(screen.getByLabelText('Território')).toHaveValue('10');
    expect(screen.getByLabelText('Usuário do sistema')).toHaveValue('7');
    expect(screen.getByLabelText('Telefone comercial')).toHaveValue('62999998888');
    expect(screen.getByLabelText('Celular')).toHaveValue('62988887777');
    expect(screen.getByLabelText('E-mail comercial')).toHaveValue('carlos@brobond.com.br');
    expect(screen.getByLabelText('CEP')).toHaveValue('74000000');
    expect(screen.getByLabelText('Logradouro')).toHaveValue('Avenida Central');
    expect(screen.getByLabelText('UF')).toHaveValue('GO');
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
    await waitFor(() => expect(screen.getByLabelText(/^Nome(?! fantasia)/)).toHaveValue('Carlos Lima'));

    fireEvent.change(screen.getByLabelText(/^Nome(?! fantasia)/), { target: { value: 'Carlos Souza' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/representantes/4', {
        codigo: 'REP00004',
        tipo_pessoa: 'PF',
        nome: 'Carlos Souza',
        razao_social: null,
        nome_fantasia: null,
        cpf: '52998224725',
        cnpj: null,
        data_nascimento: '1985-04-12',
        tipo_representante: 'GERENTE',
        cargo: 'Representante',
        registro_profissional: 'CORE-1234',
        orgao_registro: 'CORE',
        admissao: '2024-03-01',
        desligamento: null,
        ativo: false,
        telefone: '62999998888',
        celular: '62988887777',
        whatsapp: null,
        email: 'carlos@brobond.com.br',
        cep: '74000000',
        logradouro: 'Avenida Central',
        numero: '100',
        complemento: null,
        bairro: 'Setor Bueno',
        cidade: 'Goiânia',
        uf: 'GO',
        pais: 'Brasil',
        comissao_pct: '3,5',
        territorio_id: '10',
        regiao: 'Norte',
        usuario_id: '7',
        observacoes: null,
      })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/representantes'));
  });

  it('registro inexistente ou de outra empresa (404) mostra o caminho de volta, sem modal', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/usuarios/options') return USUARIOS as never;
      if (String(path) === '/territorios/options') return TERRITORIOS as never;
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
