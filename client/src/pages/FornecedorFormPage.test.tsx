// ============================================================================
// CADASTRO DE FORNECEDORES — PÁGINA própria (/fornecedores/novo e /fornecedores/:id/editar).
//
// Trava o padrão visual do BROBOND ERP: LISTA → PÁGINA, exatamente como Cores,
// Coleções, Grades e Insumos. O cadastro de fornecedores DEIXOU de ser um
// formulário sobreposto (modal/drawer) à lista — nada de modal central, drawer,
// sheet, dialog ou overlay.
//
//   • a página tem título, descrição, Voltar, Cancelar e Salvar fornecedor
//     (na edição: "Salvar alterações");
//   • nenhum `role="dialog"`/`aria-modal` é renderizado;
//   • o formulário é o RecordForm dirigido por metadados, com as SEÇÕES reais
//     do recurso (Identificação · Fiscal · Endereço · Contato · Comercial) — e
//     os campos são EXATAMENTE os que existem em `fornecedores`
//     (db/schema.sql + migration 0021): nenhum campo inventado (nada de
//     código/SKU de fornecedor, NCM, categoria, limite de crédito, banco/PIX,
//     foto ou tabela de preços);
//   • PF/PJ preservados: o dicionário de tipo de pessoa (pj/pf/estrangeiro) é o
//     do servidor; a máscara de CPF/CNPJ é a compartilhada do ERP e o dígito
//     verificador continua sendo conferido pela API (autoridade);
//   • salvar envia o contrato existente (POST /fornecedores, PUT
//     /fornecedores/:id) e volta para a lista; cancelar/voltar também vão para
//     /fornecedores sem API;
//   • nome vazio bloqueia o envio (a validação é a COMPARTILHADA do ERP);
//   • erro 409 (CNPJ duplicado) mantém a página aberta com a mensagem;
//   • RBAC: `fornecedores` é cadastro por empresa (sem piso de escrita) — a
//     página continua operável; a autorização real é do servidor.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FornecedorFormPage from './FornecedorFormPage';
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
  // ESPELHO de server/src/resources.ts › fornecedores (sem campo inventado),
  // incluindo as seções que o RecordForm agrupa.
  const endereco = (section = 'Endereço') => [
    { name: 'cep', label: 'CEP', type: 'cep', maxLength: 9, list: false, section },
    { name: 'logradouro', label: 'Logradouro', type: 'text', maxLength: 160, list: false, wide: true, section },
    { name: 'numero', label: 'Número', type: 'text', maxLength: 20, list: false, section },
    { name: 'complemento', label: 'Complemento', type: 'text', maxLength: 80, list: false, section },
    { name: 'bairro', label: 'Bairro', type: 'text', maxLength: 80, list: false, section },
    { name: 'cidade', label: 'Cidade', type: 'text', maxLength: 80, list: false, search: true, section },
    { name: 'uf', label: 'UF', type: 'uf', maxLength: 2, list: false, section },
    { name: 'codigo_municipio', label: 'Código IBGE do município', type: 'text', maxLength: 7, list: false, section },
  ];
  const fornecedores = {
    key: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    filterFields: ['pessoa', 'uf', 'ativo'],
    fields: [
      { name: 'nome', label: 'Razão social / Nome', type: 'text', required: true, search: true, maxLength: 160, section: 'Identificação' },
      {
        name: 'pessoa',
        label: 'Tipo de pessoa',
        type: 'select',
        required: true,
        default: 'pj',
        section: 'Identificação',
        options: [
          { value: 'pj', label: 'Pessoa jurídica', tone: 'blue' },
          { value: 'pf', label: 'Pessoa física', tone: 'slate' },
          { value: 'estrangeiro', label: 'Estrangeiro', tone: 'amber' },
        ],
      },
      { name: 'cnpj', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20, section: 'Identificação' },
      { name: 'razao_social', label: 'Razão social', type: 'text', maxLength: 160, list: false, wide: true, search: true, section: 'Identificação' },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', maxLength: 160, list: false, search: true, section: 'Identificação' },
      { name: 'ie', label: 'Inscrição estadual', type: 'text', maxLength: 30, list: false, search: true, section: 'Fiscal' },
      {
        name: 'indicador_ie',
        label: 'Indicador de IE',
        type: 'select',
        required: true,
        default: '1',
        list: false,
        section: 'Fiscal',
        options: [
          { value: '1', label: '1 — Contribuinte de ICMS', tone: 'green' },
          { value: '2', label: '2 — Isento de Inscrição Estadual', tone: 'amber' },
          { value: '9', label: '9 — Não contribuinte', tone: 'slate' },
        ],
      },
      { name: 'im', label: 'Inscrição municipal', type: 'text', maxLength: 30, list: false, section: 'Fiscal' },
      ...endereco(),
      { name: 'contato', label: 'Pessoa de contato', type: 'text', maxLength: 80, search: true, section: 'Contato' },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, search: true, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, search: true, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, search: true, section: 'Contato' },
      { name: 'prazo_entrega_dias', label: 'Prazo de entrega (dias)', type: 'integer', min: 0, list: false, section: 'Comercial' },
      { name: 'condicao_pagamento', label: 'Condição de pagamento', type: 'text', maxLength: 60, list: false, section: 'Comercial' },
      { name: 'observacoes', label: 'Observações', type: 'textarea', maxLength: 2000, list: false, wide: true, section: 'Comercial' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { fornecedores }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);

/** Payload completo de criação só com o nome preenchido (padrões do recurso). */
const PAYLOAD_MINIMO = {
  nome: 'Têxtil Bella',
  pessoa: 'pj',
  cnpj: null,
  razao_social: null,
  nome_fantasia: null,
  ie: null,
  indicador_ie: '1',
  im: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: null,
  uf: null,
  codigo_municipio: null,
  contato: null,
  telefone: null,
  whatsapp: null,
  email: null,
  prazo_entrega_dias: null,
  condicao_pagamento: null,
  observacoes: null,
  ativo: true,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[routeParams.id ? `/fornecedores/${routeParams.id}/editar` : '/fornecedores/novo']}>
      <ToastProvider>
        <FornecedorFormPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function botaoSalvar(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: /Salvar (fornecedor|alterações)/ })[0] as HTMLButtonElement;
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
  apiGet.mockResolvedValue({} as never);
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({ id: 4 } as never);
});

describe('novo fornecedor — página própria do ERP', () => {
  it('renderiza título, descrição, Voltar e Salvar fornecedor em página normal (sem modal/drawer)', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Novo fornecedor/ })).toBeInTheDocument();
    expect(
      screen.getByText('Cadastre o fornecedor com os dados fiscais, de endereço e de contato usados nas compras e na NF-e de entrada.')
    ).toBeInTheDocument();

    // Voltar é um LINK para a lista (navegação normal do ERP).
    expect(screen.getByRole('link', { name: /Voltar/ })).toHaveAttribute('href', '/fornecedores');
    // Cancelar e Salvar fornecedor existem no cabeçalho e no rodapé da página.
    expect(screen.getAllByRole('button', { name: /Cancelar/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Salvar fornecedor/ }).length).toBeGreaterThan(0);

    semSobreposicao();
  });

  it('organiza o formulário nas seções reais do recurso', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Novo fornecedor/ });

    expect(screen.getByRole('heading', { name: 'Identificação' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fiscal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Endereço' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contato' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Comercial' })).toBeInTheDocument();
  });

  it('mostra os campos reais do cadastro e nada inventado', async () => {
    renderPage();

    // Identificação
    expect(await screen.findByLabelText(/Razão social \/ Nome/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tipo de pessoa/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^CNPJ \/ CPF/)).toBeInTheDocument();
    expect(screen.getByLabelText('Razão social')).toBeInTheDocument();
    expect(screen.getByLabelText('Nome fantasia')).toBeInTheDocument();
    // Fiscal
    expect(screen.getByLabelText('Inscrição estadual')).toBeInTheDocument();
    expect(screen.getByLabelText(/Indicador de IE/)).toBeInTheDocument();
    expect(screen.getByLabelText('Inscrição municipal')).toBeInTheDocument();
    // Endereço
    expect(screen.getByLabelText('CEP')).toBeInTheDocument();
    expect(screen.getByLabelText('Logradouro')).toBeInTheDocument();
    expect(screen.getByLabelText('Número')).toBeInTheDocument();
    expect(screen.getByLabelText('Complemento')).toBeInTheDocument();
    expect(screen.getByLabelText('Bairro')).toBeInTheDocument();
    expect(screen.getByLabelText('Cidade')).toBeInTheDocument();
    expect(screen.getByLabelText('UF')).toBeInTheDocument();
    expect(screen.getByLabelText('Código IBGE do município')).toBeInTheDocument();
    // Contato
    expect(screen.getByLabelText('Pessoa de contato')).toBeInTheDocument();
    expect(screen.getByLabelText('Telefone')).toBeInTheDocument();
    expect(screen.getByLabelText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
    // Comercial
    expect(screen.getByLabelText('Prazo de entrega (dias)')).toBeInTheDocument();
    expect(screen.getByLabelText('Condição de pagamento')).toBeInTheDocument();
    expect(screen.getByLabelText('Observações')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).toBeChecked();

    // Nenhum campo INVENTADO aparece (o domínio de `fornecedores` não tem nenhum
    // deles — código/SKU próprio, NCM, categoria, limite de crédito, dados
    // bancários/PIX, foto, tabela de preços).
    expect(screen.queryByLabelText(/SKU|NCM|Categoria|Limite de cr[eé]dito|Banco|PIX|Ag[eê]ncia|Conta corrente|Foto|Imagem|Tabela de pre[çc]o/i)).toBeNull();
    expect(screen.queryByLabelText(/^Código(?! IBGE)/i)).toBeNull();
  });

  it('PF/PJ preservados: tipo de pessoa começa "pj" e o dicionário é o do servidor', async () => {
    renderPage();

    const pessoa = await screen.findByLabelText(/Tipo de pessoa/);
    expect(pessoa).toHaveValue('pj');
    expect(screen.getByRole('option', { name: 'Pessoa jurídica' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Pessoa física' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Estrangeiro' })).toBeInTheDocument();
    // O indicador de IE (campo indIEDest da NF-e) começa no padrão do recurso.
    expect(screen.getByLabelText(/Indicador de IE/)).toHaveValue('1');
  });

  it('a máscara de CNPJ/CPF é a compartilhada do ERP (digitação mascarada)', async () => {
    renderPage();

    const doc = await screen.findByLabelText(/^CNPJ \/ CPF/);
    fireEvent.change(doc, { target: { value: '12345678000195' } });
    expect(doc).toHaveValue('12.345.678/0001-95');

    fireEvent.change(doc, { target: { value: '52998224725' } });
    expect(doc).toHaveValue('529.982.247-25');
  });

  it('cria o fornecedor enviando o contrato existente e volta para a lista', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Razão social \/ Nome/), { target: { value: '  Têxtil Bella  ' } });
    fireEvent.change(screen.getByLabelText(/^CNPJ \/ CPF/), { target: { value: '12345678000195' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Goiânia' } });
    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '6233334444' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'contato@textilbella.com.br' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/fornecedores', {
      ...PAYLOAD_MINIMO,
      cnpj: '12.345.678/0001-95',
      cidade: 'Goiânia',
      telefone: '+55 (62) 3333-4444',
      email: 'contato@textilbella.com.br',
    });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/fornecedores'));
  });

  it('só o nome obrigatório: campos vazios viram null no payload (contrato preservado)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Razão social \/ Nome/), { target: { value: 'Têxtil Bella' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fornecedores', PAYLOAD_MINIMO));
  });

  it('nome vazio bloqueia o envio e mantém a página aberta', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo fornecedor/ });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText(/Preencha os campos obrigatórios destacados/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('CNPJ duplicado (409 do servidor) mantém a página aberta com a mensagem e o erro no campo', async () => {
    apiPost.mockRejectedValueOnce(
      new ApiError(409, 'Já existe um fornecedor cadastrado com este CNPJ ou CPF.', { cnpj: 'Já cadastrado' }, 'fornecedor_duplicado')
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Razão social \/ Nome/), { target: { value: 'Têxtil Bella' } });
    fireEvent.change(screen.getByLabelText(/^CNPJ \/ CPF/), { target: { value: '12345678000195' } });
    fireEvent.click(botaoSalvar());

    expect(await screen.findByText('Já existe um fornecedor cadastrado com este CNPJ ou CPF.')).toBeInTheDocument();
    expect(screen.getByText('Já cadastrado')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Novo fornecedor/ })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    semSobreposicao();
  });

  it('desabilita o Salvar enquanto envia (anti duplo submit)', async () => {
    let resolver: (v: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise((r) => { resolver = r; }) as never);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Razão social \/ Nome/), { target: { value: 'Têxtil Bella' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(botaoSalvar()).toBeDisabled());
    fireEvent.click(botaoSalvar());
    expect(apiPost).toHaveBeenCalledTimes(1);

    resolver({ id: 9 });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/fornecedores'));
  });

  it('cancelar volta para /fornecedores sem chamar a API', async () => {
    renderPage();

    await screen.findByRole('heading', { name: /Novo fornecedor/ });
    fireEvent.click(screen.getAllByRole('button', { name: /Cancelar/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/fornecedores');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('desativar o fornecedor desmarca o Ativo e vai no payload (desativação preserva o histórico)', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Razão social \/ Nome/), { target: { value: 'Têxtil Bella' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ativo' }));
    fireEvent.click(botaoSalvar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/fornecedores', expect.objectContaining({ ativo: false })));
  });

  it('RBAC preservado: o operador (que já opera o cadastro) pode salvar', async () => {
    mockUser.perfil = 'operador';
    renderPage();

    await screen.findByRole('heading', { name: /Novo fornecedor/ });
    expect(botaoSalvar()).not.toBeDisabled();
    expect(screen.queryByText(/somente de leitura/)).toBeNull();
  });
});

describe('editar fornecedor — página própria do ERP', () => {
  beforeEach(() => {
    routeParams = { id: '4' };
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/fornecedores/4') {
        return {
          id: 4,
          nome: 'João da Silva',
          pessoa: 'pf',
          cnpj: '52998224725',
          razao_social: null,
          nome_fantasia: null,
          ie: null,
          indicador_ie: '9',
          im: null,
          cep: null,
          logradouro: null,
          numero: null,
          complemento: null,
          bairro: null,
          cidade: 'Anápolis',
          uf: 'GO',
          codigo_municipio: null,
          contato: null,
          telefone: '62999998888',
          whatsapp: null,
          email: null,
          prazo_entrega_dias: null,
          condicao_pagamento: null,
          observacoes: null,
          ativo: false,
        } as never;
      }
      return {} as never;
    });
  });

  it('abre a página "Editar fornecedor" com os dados do registro carregados', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Editar fornecedor/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Razão social \/ Nome/)).toHaveValue('João da Silva'));
    expect(screen.getByLabelText(/Tipo de pessoa/)).toHaveValue('pf');
    expect(screen.getByLabelText('Cidade')).toHaveValue('Anápolis');
    expect(screen.getByLabelText('UF')).toHaveValue('GO');
    expect(screen.getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();
    expect(screen.getByText(/Alterando o fornecedor “João da Silva”/)).toBeInTheDocument();
    semSobreposicao();
  });

  it('na edição o botão de salvar é "Salvar alterações" (convenção do ERP)', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Editar fornecedor/ });
    const botoes = screen.getAllByRole('button', { name: /Salvar alterações/ });
    expect(botoes.length).toBeGreaterThan(0);
    // Na criação o rótulo é o do recurso ("Salvar fornecedor").
    expect(screen.queryByRole('button', { name: /^Salvar fornecedor$/ })).toBeNull();
  });

  it('salva por PUT preservando os demais campos e volta para a lista', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Razão social \/ Nome/)).toHaveValue('João da Silva'));

    fireEvent.change(screen.getByLabelText(/Razão social \/ Nome/), { target: { value: 'João Souza' } });
    fireEvent.click(botaoSalvar());

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/fornecedores/4', {
        nome: 'João Souza',
        pessoa: 'pf',
        cnpj: '52998224725',
        razao_social: null,
        nome_fantasia: null,
        ie: null,
        indicador_ie: '9',
        im: null,
        cep: null,
        logradouro: null,
        numero: null,
        complemento: null,
        bairro: null,
        cidade: 'Anápolis',
        uf: 'GO',
        codigo_municipio: null,
        contato: null,
        telefone: '62999998888',
        whatsapp: null,
        email: null,
        prazo_entrega_dias: null,
        condicao_pagamento: null,
        observacoes: null,
        ativo: false,
      })
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/fornecedores'));
  });

  it('registro inexistente (404) mostra o erro do servidor e o Voltar para a lista', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/fornecedores/4') throw new ApiError(404, 'Fornecedor não encontrado(a).');
      return {} as never;
    });
    renderPage();

    expect(await screen.findByText('Fornecedor não encontrado(a).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Voltar para a lista/ })).toHaveAttribute('href', '/fornecedores');
    semSobreposicao();
  });
});
