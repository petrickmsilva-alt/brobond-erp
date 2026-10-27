// ============================================================================
// CADASTRO DE FORNECEDORES — LISTA (tela principal).
//
// Trava o padrão LISTA → PÁGINA do BROBOND ERP (o MESMO de Cores, Coleções,
// Grades e Insumos):
//   • a LISTA é a tela; "Novo fornecedor" NAVEGA para /fornecedores/novo e
//     "Editar" NAVEGA para /fornecedores/:id/editar — nunca abre modal, drawer
//     ou overlay (o cadastro de fornecedores DEIXOU de ser um formulário
//     sobreposto à lista);
//   • a lista vem do servidor (GET /fornecedores) com busca (q), paginação
//     server-side, ordenação (sort/dir) e filtros (f.ativo, f.pessoa, f.uf) —
//     sem SQL paralelo no front;
//   • as colunas mostram só dado REAL: nome, tipo de pessoa (pf/pj/estrangeiro),
//     CNPJ/CPF formatado, nome fantasia, localização (cidade · UF do próprio
//     registro), telefone, e-mail, status e utilização (pedidos de compra,
//     contagem agregada pelo servidor — nunca N+1);
//   • DELETE bloqueado (409 dependencias_vinculadas) abre o "Ver vínculos" e a
//     saída oferecida é DESATIVAR (preserva compras/recebimentos/cotações);
//   • operador não vê a ação de excluir (a autoridade real é a API).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FornecedoresPage from './FornecedoresPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError, downloadFile } from '../lib/api';
import type { DiagnosticoDependencias } from '../components/DependenciasModal';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../lib/api', () => {
  class ApiErrorMock extends Error {
    status: number;
    fields?: Record<string, string>;
    code?: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      message: string,
      fields?: Record<string, string>,
      code?: string,
      details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.fields = fields;
      this.code = code;
      this.details = details;
    }
  }
  return {
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
    ApiError: ApiErrorMock,
    downloadFile: vi.fn(),
  };
});

const mockUser: { perfil: 'admin' | 'gerente' | 'operador' } = { perfil: 'gerente' };
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  // ESPELHO de server/src/resources.ts › fornecedores (sem campo inventado).
  const fornecedores = {
    key: 'fornecedores',
    label: 'Fornecedores',
    singular: 'Fornecedor',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    filterFields: ['pessoa', 'uf', 'ativo'],
    notice:
      'Um fornecedor em uso por compras, insumos ou produtos NÃO é excluído — ele é DESATIVADO: sai das opções de novos cadastros, mas o histórico (compras, recebimentos, cotações) continua apontando para ele.',
    fields: [
      { name: 'nome', label: 'Razão social / Nome', type: 'text', required: true, search: true, maxLength: 160 },
      {
        name: 'pessoa',
        label: 'Tipo de pessoa',
        type: 'select',
        required: true,
        default: 'pj',
        options: [
          { value: 'pj', label: 'Pessoa jurídica', tone: 'blue' },
          { value: 'pf', label: 'Pessoa física', tone: 'slate' },
          { value: 'estrangeiro', label: 'Estrangeiro', tone: 'amber' },
        ],
      },
      { name: 'cnpj', label: 'CNPJ / CPF', type: 'document', search: true, maxLength: 20 },
      { name: 'nome_fantasia', label: 'Nome fantasia', type: 'text', maxLength: 160, list: false, search: true },
      { name: 'cidade', label: 'Cidade', type: 'text', maxLength: 80, list: false, search: true },
      { name: 'uf', label: 'UF', type: 'uf', maxLength: 2, list: false },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, search: true },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, search: true },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true },
    ],
  };
  return { ...actual, useMeta: () => ({ resources: { fornecedores }, modules: [] }) };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);
const downloadFileMock = vi.mocked(downloadFile);

const LISTA = {
  rows: [
    {
      id: 1,
      nome: 'Têxtil Bella',
      pessoa: 'pj',
      cnpj: '12345678000195',
      nome_fantasia: 'Bella Malharia',
      cidade: 'Goiânia',
      uf: 'GO',
      telefone: '6233334444',
      email: 'contato@textilbella.com.br',
      ativo: true,
      uso_vinculado: 2,
      uso_vinculado_label: '2 compras',
    },
    {
      id: 2,
      nome: 'João da Silva',
      pessoa: 'pf',
      cnpj: '52998224725',
      nome_fantasia: null,
      cidade: 'Anápolis',
      uf: 'GO',
      telefone: null,
      email: null,
      ativo: false,
      uso_vinculado: 0,
      uso_vinculado_label: '0 compras',
    },
    {
      id: 3,
      nome: 'China Fabrics Ltd',
      pessoa: 'estrangeiro',
      cnpj: null,
      nome_fantasia: null,
      cidade: null,
      uf: null,
      telefone: null,
      email: 'sales@chinafabrics.com',
      ativo: true,
      uso_vinculado: 1,
      uso_vinculado_label: '1 compra',
    },
  ],
  total: 3,
  page: 1,
  pageSize: 25,
};

// Diagnóstico no formato REAL do servidor (server/src/dependencias.ts):
// compras do fornecedor são histórico (FK NO ACTION) — bloqueiam a exclusão.
const DIAG: DiagnosticoDependencias = {
  recurso: 'fornecedores',
  recursoLabel: 'Fornecedores',
  singular: 'Fornecedor',
  id: 1,
  empresaId: 1,
  rotulo: 'Têxtil Bella',
  status: null,
  origem: 'postgresql',
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Fornecedor Têxtil Bella',
  resumo: '2 registros vinculados em Compras.',
  orientacao: 'Desative o fornecedor (campo Ativo) em vez de excluí-lo.',
  totalRegistros: 2,
  totalBloqueantes: 2,
  modulos: ['Compras'],
  modulosBloqueantes: ['Compras'],
  geradoEm: '2026-10-26T12:00:00.000Z',
  vinculos: [
    {
      tabela: 'compras',
      modulo: 'Compras',
      quantidade: 2,
      icone: 'compras',
      colunas: ['fornecedor_id'],
      recurso: 'compras',
      ids: [10, 11],
      idsTruncados: false,
      unidade: ['compra', 'compras'],
      tipo: 'historico',
      politica: 'seguir',
      acao: 'NO_ACTION',
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'compras do fornecedor',
    },
  ],
};

function montar() {
  return render(
    <ToastProvider>
      <FornecedoresPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  navigateMock.mockReset();
  mockUser.perfil = 'gerente';
  apiGet.mockResolvedValue(LISTA as never);
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 1 } as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Fornecedores — lista (A)', () => {
  it('lê os fornecedores do servidor e mostra tipo, documento, localização, contatos, status e utilização', async () => {
    montar();
    expect(await screen.findByText('Têxtil Bella')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/fornecedores?'));

    // Colunas do domínio — o cabeçalho mostra exatamente o que existe.
    expect(screen.getByRole('columnheader', { name: /Fornecedor/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Tipo/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /CNPJ \/ CPF/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Nome fantasia/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Localização/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Telefone/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /E-mail/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Utilização/ })).toBeInTheDocument();

    // Tipo de pessoa: badge textual para os três casos reais do dicionário.
    expect(screen.getAllByText('PJ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PF').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Estrangeiro').length).toBeGreaterThan(0);

    // Documento formatado (CNPJ e CPF reais, nunca o número cru).
    expect(screen.getByText('12.345.678/0001-95')).toBeInTheDocument();
    expect(screen.getByText('529.982.247-25')).toBeInTheDocument();

    // Localização: cidade · UF do próprio registro; "—" quando não há.
    expect(screen.getByText('Goiânia · GO')).toBeInTheDocument();
    expect(screen.getByText('Anápolis · GO')).toBeInTheDocument();

    // Telefone formatado (máscara nacional do ERP) e e-mail real.
    expect(screen.getByText('+55 (62) 3333-4444')).toBeInTheDocument();
    expect(screen.getByText('contato@textilbella.com.br')).toBeInTheDocument();

    // Status textual (não só cor).
    expect(screen.getAllByText(/Ativo/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Inativo/).length).toBeGreaterThan(0);

    // Utilização: contagem REAL agregada pelo servidor (pedidos de compra).
    expect(screen.getByText('2 compras')).toBeInTheDocument();
    expect(screen.getByText('1 compra')).toBeInTheDocument();
  });

  it('mostra a orientação de desativação (notice do recurso) no topo da lista', async () => {
    montar();
    expect(await screen.findByText(/NÃO é excluído — ele é DESATIVADO/)).toBeInTheDocument();
  });

  it('mostra estado vazio orientado quando não há fornecedores', async () => {
    apiGet.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 } as never);
    montar();
    expect(await screen.findByText('Nenhum fornecedor cadastrado')).toBeInTheDocument();
    expect(screen.getByText(/Cadastre o primeiro fornecedor para usar nas compras/)).toBeInTheDocument();
  });

  it('mostra o estado de erro quando a API falha', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'Falha ao carregar fornecedores.') as never);
    montar();
    expect(await screen.findByText('Falha ao carregar fornecedores.')).toBeInTheDocument();
  });

  it('o modo visual (cartões) consome as MESMAS linhas, sem consulta nova', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    const chamadasAntes = apiGet.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Visual/ }));

    // O modo visual não refaz a consulta: consome as mesmas linhas.
    expect(await screen.findByTestId('lista-cards')).toBeInTheDocument();
    expect(screen.getByText('Têxtil Bella')).toBeInTheDocument();
    expect(screen.getByText('12.345.678/0001-95')).toBeInTheDocument();
    expect(screen.getByText('2 compras')).toBeInTheDocument();
    expect(apiGet.mock.calls.length).toBe(chamadasAntes);
  });
});

describe('Fornecedores — busca, filtros e ordenação (B, C)', () => {
  it('a busca envia o termo ao servidor (q), sem SQL paralelo', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.change(screen.getByLabelText('Buscar fornecedor'), { target: { value: 'textil' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=textil')));
  });

  it('o filtro rápido de status envia f.ativo ao servidor (Todos/Ativos/Inativos)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.click(screen.getByRole('button', { name: 'Inativos' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=false')));
    fireEvent.click(screen.getByRole('button', { name: 'Ativos' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=true')));
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).not.toContain('f.ativo=');
    });
  });

  it('o filtro de tipo envia f.pessoa ao servidor (dicionário pf/pj/estrangeiro)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.change(screen.getByLabelText('Filtrar por tipo'), { target: { value: 'pf' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.pessoa=pf')));
  });

  it('o filtro de UF envia f.uf ao servidor (UFs reais do Brasil)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    expect(screen.getByRole('option', { name: 'GO' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filtrar por UF'), { target: { value: 'GO' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.uf=GO')));
  });

  it('"Limpar filtros" remove todo o recorte de uma vez', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.change(screen.getByLabelText('Buscar fornecedor'), { target: { value: 'bella' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=bella')));
    fireEvent.click(screen.getByRole('button', { name: 'Inativos' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=false')));

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).not.toContain('q=');
      expect(ultima).not.toContain('f.ativo=');
    });
  });

  it('a ordenação vai ao servidor (sort/dir) e volta ao padrão do recurso', async () => {
    montar();
    await screen.findByText('Têxtil Bella');

    fireEvent.click(screen.getByRole('button', { name: 'CNPJ / CPF' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('sort=cnpj&dir=asc')));

    fireEvent.click(screen.getByRole('button', { name: 'CNPJ / CPF' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('sort=cnpj&dir=desc')));

    fireEvent.click(screen.getByRole('button', { name: 'CNPJ / CPF' }));
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).not.toContain('sort=');
    });
  });
});

describe('Fornecedores — navegação para a página própria (D, F)', () => {
  it('"Novo fornecedor" NAVEGA para /fornecedores/novo (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.click(screen.getAllByRole('button', { name: /Novo fornecedor/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/fornecedores/novo');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
    // A lista permanece intacta.
    expect(screen.getByText('João da Silva')).toBeInTheDocument();
  });

  it('"Editar" NAVEGA para /fornecedores/:id/editar (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor Têxtil Bella' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Editar' }));

    expect(navigateMock).toHaveBeenCalledWith('/fornecedores/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('duplo clique na linha abre a página de edição (atalho da listagem)', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.doubleClick(screen.getByText('Têxtil Bella'));
    expect(navigateMock).toHaveBeenCalledWith('/fornecedores/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Fornecedores — exportação e importação (contratos existentes)', () => {
  it('exporta a lista atual em CSV/XLSX pelo endpoint genérico, honrando os filtros', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.change(screen.getByLabelText('Filtrar por tipo'), { target: { value: 'pj' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.pessoa=pj')));

    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));
    const [urlCsv, nomeCsv] = downloadFileMock.mock.calls[0];
    expect(String(urlCsv)).toContain('/fornecedores/export?format=csv');
    expect(String(urlCsv)).toContain('f.pessoa=pj');
    // A exportação cobre o recorte inteiro: nunca leva a paginação da tela.
    expect(String(urlCsv)).not.toContain('page=');
    expect(nomeCsv).toBe('fornecedores.csv');

    fireEvent.click(screen.getByRole('button', { name: /XLSX/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(2));
    expect(String(downloadFileMock.mock.calls[1][0])).toContain('format=xlsx');
  });

  it('"Importar" usa o ImportModal padrão do ERP com o tipo fornecedores', async () => {
    const primeira = montar();
    await screen.findByText('Têxtil Bella');
    expect(screen.getByRole('button', { name: /Importar/ })).toBeInTheDocument();
    primeira.unmount();

    // O operador não importa (regra já existente do CRUD genérico).
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('Têxtil Bella');
    expect(screen.queryByRole('button', { name: /Importar/ })).toBeNull();
  });
});

describe('Fornecedores — colunas visíveis (persistência)', () => {
  it('ocultar uma coluna vale para a tela e persiste no navegador', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    expect(screen.getByRole('columnheader', { name: /E-mail/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Colunas visíveis' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'E-mail' }));

    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /E-mail/ })).toBeNull());
    // A MESMA chave do CRUD genérico: a preferência do usuário sobrevive.
    expect(localStorage.getItem('brobond_colunas_ocultas_fornecedores')).toContain('email');
    // As demais colunas continuam.
    expect(screen.getByRole('columnheader', { name: /Fornecedor/ })).toBeInTheDocument();
  });
});

describe('Fornecedores — status (G)', () => {
  it('desativa pela linha com PUT { ativo: false }', async () => {
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor Têxtil Bella' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/fornecedores/1', { ativo: false }));
  });

  it('reativa pela linha com PUT { ativo: true }', async () => {
    montar();
    await screen.findByText('João da Silva');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor João da Silva' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/fornecedores/2', { ativo: true }));
  });
});

describe('Fornecedores — RBAC (H)', () => {
  // O RBAC é PRESERVADO como está: `fornecedores` é cadastro POR EMPRESA, sem
  // `minPerfilEscrita` — o operador que já acessa o cadastro continua podendo
  // criar/editar (é o que o servidor autoriza). O que o servidor NÃO permite ao
  // operador é EXCLUIR; por isso a ação de excluir não aparece para ele.
  it('operador vê criar/editar, mas NÃO vê excluir (o servidor bloqueia o DELETE)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('Têxtil Bella');
    expect(screen.getByRole('button', { name: /Novo fornecedor/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor Têxtil Bella' }));
    expect(await screen.findByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });
});

describe('Fornecedores — exclusão com diagnóstico (K, L, M)', () => {
  it('DELETE bloqueado abre o "Ver vínculos" e oferece DESATIVAR (preserva o histórico)', async () => {
    apiDel.mockRejectedValue(
      new ApiError(409, 'Existem registros vinculados.', undefined, 'dependencias_vinculadas', { dependencias: DIAG }) as never
    );
    montar();
    await screen.findByText('Têxtil Bella');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor Têxtil Bella' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));

    // Confirmação padrão do ERP.
    const confirm = await screen.findByRole('button', { name: 'Excluir' });
    fireEvent.click(confirm);

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/fornecedores/1'));
    // Diagnóstico com os módulos e as quantidades reais (compras do fornecedor).
    expect(await screen.findByText('Exclusão bloqueada por vínculos')).toBeInTheDocument();
    expect(screen.getByText('Compras')).toBeInTheDocument();
    expect(screen.getByText('2 compras')).toBeInTheDocument();

    // A saída é desativar, não forçar a exclusão.
    fireEvent.click(screen.getByRole('button', { name: 'Desativar fornecedor' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/fornecedores/1', { ativo: false }));
  });

  it('fornecedor sem vínculos segue a regra atual de exclusão (DELETE direto)', async () => {
    montar();
    await screen.findByText('China Fabrics Ltd');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do fornecedor China Fabrics Ltd' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/fornecedores/3'));
  });
});
