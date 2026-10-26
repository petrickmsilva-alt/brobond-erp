// ============================================================================
// CADASTRO DE REPRESENTANTES — LISTA (tela principal).
//
// Trava o padrão LISTA → PÁGINA do BROBOND ERP (o MESMO de Clientes,
// Fornecedores, Insumos, Cores, Coleções, Grades e Tamanhos):
//   • a LISTA é a tela; "Novo representante" NAVEGA para /representantes/novo
//     e "Editar" NAVEGA para /representantes/:id/editar — nunca abre modal,
//     drawer, sheet ou overlay (o cadastro de representantes DEIXOU de ser um
//     formulário sobreposto à lista);
//   • a lista vem do servidor (GET /representantes) com busca (q), paginação
//     server-side, ordenação (sort/dir) e filtros (f.ativo, f.usuario_id) — sem
//     SQL paralelo no front;
//   • as colunas mostram só dado REAL: nome, CPF formatado, cargo, região,
//     comissão padrão, usuário vinculado, contato (telefone · e-mail do próprio
//     registro), status e utilização (pedidos de venda da empresa ativa,
//     contagem agregada pelo servidor — nunca N+1);
//   • DELETE bloqueado (409 dependencias_vinculadas) abre o "Ver vínculos" e a
//     saída oferecida é DESATIVAR (preserva vendas/clientes/propostas/comissões);
//   • operador não vê a ação de excluir (a autoridade real é a API).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RepresentantesPage from './RepresentantesPage';
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
  // ESPELHO de server/src/resources.ts › representantes (sem campo inventado).
  const representantes = {
    key: 'representantes',
    label: 'Representantes',
    singular: 'Representante',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    filterFields: ['usuario_id', 'ativo'],
    notice:
      'Desligar ou desativar um representante NÃO apaga histórico: vendas, clientes, propostas e comissões apuradas continuam apontando para ele. Um representante em uso não é excluído — ele é DESATIVADO.',
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120, wide: true, section: 'Identificação' },
      { name: 'cpf', label: 'CPF', type: 'document', documento: 'cpf', search: true, maxLength: 14, section: 'Identificação' },
      { name: 'cargo', label: 'Cargo', type: 'text', maxLength: 60, search: true, section: 'Identificação' },
      { name: 'regiao', label: 'Região', type: 'text', search: true, maxLength: 80, section: 'Identificação' },
      { name: 'comissao_pct', label: 'Comissão padrão (%)', type: 'percent', min: 0, max: 100, default: 0, section: 'Comercial' },
      { name: 'usuario_id', label: 'Usuário do sistema', type: 'ref', ref: 'usuarios', list: false, search: true, section: 'Acesso ao ERP' },
      { name: 'telefone', label: 'Telefone', type: 'phone', maxLength: 20, search: true, section: 'Contato' },
      { name: 'whatsapp', label: 'WhatsApp', type: 'phone', maxLength: 20, list: false, search: true, section: 'Contato' },
      { name: 'email', label: 'E-mail', type: 'email', maxLength: 160, search: true, section: 'Contato' },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, section: 'Situação profissional' },
    ],
  };
  return { ...actual, useMeta: () => ({ resources: { representantes }, modules: [] }) };
});

const apiGet = vi.mocked(api.get);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);
const downloadFileMock = vi.mocked(downloadFile);

const LISTA = {
  rows: [
    {
      id: 1,
      nome: 'Ana Souza',
      cpf: '52998224725',
      cargo: 'Vendedora',
      regiao: 'Centro-Oeste',
      comissao_pct: 3.5,
      usuario_id: 7,
      usuario_id__label: 'Ana Souza',
      telefone: '6233334444',
      whatsapp: '62999998888',
      email: 'ana@brobond.com.br',
      ativo: true,
      uso_vinculado: 12,
      uso_vinculado_label: '12 vendas',
    },
    {
      id: 2,
      nome: 'Carlos Lima',
      cpf: null,
      cargo: 'Representante',
      regiao: 'Norte',
      comissao_pct: 5,
      usuario_id: null,
      usuario_id__label: null,
      telefone: null,
      whatsapp: null,
      email: null,
      ativo: false,
      uso_vinculado: 0,
      uso_vinculado_label: '0 vendas',
    },
    {
      id: 3,
      nome: 'Marina Alves',
      cpf: '11144477735',
      cargo: 'Gerente comercial',
      regiao: 'Sudeste',
      comissao_pct: 2,
      usuario_id: 9,
      usuario_id__label: 'Marina Alves',
      telefone: '1133334444',
      whatsapp: null,
      email: 'marina@brobond.com.br',
      ativo: true,
      uso_vinculado: 3,
      uso_vinculado_label: '3 vendas',
    },
  ],
  total: 3,
  page: 1,
  pageSize: 25,
};

// Diagnóstico no formato REAL do servidor (server/src/dependencias.ts):
// vendas do representante são histórico (FK NO ACTION) — bloqueiam a exclusão.
const DIAG: DiagnosticoDependencias = {
  recurso: 'representantes',
  recursoLabel: 'Representantes',
  singular: 'Representante',
  id: 1,
  empresaId: 1,
  rotulo: 'Ana Souza',
  status: null,
  origem: 'postgresql',
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Representante Ana Souza',
  resumo: '12 registros vinculados em Vendas.',
  orientacao: 'Desative o registro (campo Ativo) em vez de excluí-lo: o histórico do sistema depende dele.',
  totalRegistros: 12,
  totalBloqueantes: 12,
  modulos: ['Vendas'],
  modulosBloqueantes: ['Vendas'],
  geradoEm: '2026-10-26T12:00:00.000Z',
  vinculos: [
    {
      tabela: 'vendas',
      modulo: 'Vendas',
      quantidade: 12,
      icone: 'vendas',
      colunas: ['representante_id'],
      recurso: 'vendas',
      ids: [10, 11],
      idsTruncados: true,
      unidade: ['venda', 'vendas'],
      tipo: 'historico',
      politica: 'proteger',
      acao: 'NO_ACTION',
      impeditivo: true,
      protegido: true,
      bloqueia: true,
      motivo: 'pedidos de venda do representante',
    },
  ],
};

const USUARIOS = [
  { value: 7, label: 'Ana Souza' },
  { value: 9, label: 'Marina Alves' },
];

function montar() {
  return render(
    <ToastProvider>
      <RepresentantesPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  navigateMock.mockReset();
  mockUser.perfil = 'gerente';
  // O filtro de usuário usa o MESMO contrato `/usuarios/options` do ERP; a
  // listagem usa `/representantes?...`.
  apiGet.mockImplementation(async (path: string) => (String(path).startsWith('/usuarios/options') ? (USUARIOS as never) : (LISTA as never)));
  apiPut.mockResolvedValue({ id: 1 } as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Representantes — lista (A)', () => {
  it('lê os representantes do servidor e mostra nome, CPF, cargo, região, comissão, usuário, contato, status e utilização', async () => {
    montar();
    expect((await screen.findAllByText('Ana Souza')).length).toBeGreaterThan(0);
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/representantes?'));

    // Colunas do domínio — o cabeçalho mostra exatamente o que existe.
    expect(screen.getByRole('columnheader', { name: /Representante/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /CPF/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Cargo/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Região/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Comissão/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Usuário/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Contato/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Utilização/ })).toBeInTheDocument();

    // CPF formatado (máscara do ERP) e cargos/regiões reais.
    expect(screen.getByText('529.982.247-25')).toBeInTheDocument();
    expect(screen.getByText('111.444.777-35')).toBeInTheDocument();
    expect(screen.getByText('Vendedora')).toBeInTheDocument();
    expect(screen.getByText('Centro-Oeste')).toBeInTheDocument();

    // Comissão padrão em % (valor real do cadastro).
    expect(screen.getByText('3,5%')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();

    // Usuário vinculado: rótulo vindo do join do servidor.
    expect(screen.getAllByText('Ana Souza').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marina Alves').length).toBeGreaterThan(0);

    // Contato: telefone formatado · e-mail do próprio registro.
    expect(screen.getByText(/\+55 \(62\) 3333-4444 · ana@brobond\.com\.br/)).toBeInTheDocument();

    // Status textual (não só cor).
    expect(screen.getAllByText(/Ativo/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Inativo/).length).toBeGreaterThan(0);

    // Utilização: contagem REAL agregada pelo servidor (pedidos de venda).
    expect(screen.getByText('12 vendas')).toBeInTheDocument();
    expect(screen.getByText('3 vendas')).toBeInTheDocument();
  });

  it('mostra a orientação de desativação (notice do recurso) no topo da lista', async () => {
    montar();
    expect(await screen.findByText(/NÃO apaga histórico/)).toBeInTheDocument();
  });

  it('mostra estado vazio orientado quando não há representantes', async () => {
    apiGet.mockImplementation(async (path: string) =>
      String(path).startsWith('/usuarios/options') ? (USUARIOS as never) : ({ rows: [], total: 0, page: 1, pageSize: 25 } as never)
    );
    montar();
    expect(await screen.findByText('Nenhum representante cadastrado')).toBeInTheDocument();
    expect(screen.getByText(/Cadastre o primeiro representante para vincular vendas, clientes e comissões/)).toBeInTheDocument();
  });

  it('mostra o estado de erro quando a API falha', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/usuarios/options')) return USUARIOS as never;
      throw new ApiError(500, 'Falha ao carregar representantes.') as never;
    });
    montar();
    expect(await screen.findByText('Falha ao carregar representantes.')).toBeInTheDocument();
  });

  it('o modo visual (cartões) consome as MESMAS linhas, sem consulta nova', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    const chamadasAntes = apiGet.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Visual/ }));

    expect(await screen.findByTestId('lista-cards')).toBeInTheDocument();
    expect(screen.getByText('Vendedora')).toBeInTheDocument();
    expect(screen.getByText('12 vendas')).toBeInTheDocument();
    expect(apiGet.mock.calls.length).toBe(chamadasAntes);
  });
});

describe('Representantes — busca, filtros e ordenação (B, C)', () => {
  it('a busca envia o termo ao servidor (q), sem SQL paralelo', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.change(screen.getByLabelText('Buscar representante'), { target: { value: 'ana' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=ana')));
  });

  it('a busca por CPF usa o termo como o operador digita (o servidor compara dígitos)', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.change(screen.getByLabelText('Buscar representante'), { target: { value: '529.982.247-25' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining(`q=${encodeURIComponent('529.982.247-25')}`)));
  });

  it('o filtro rápido de status envia f.ativo ao servidor (Todos/Ativos/Inativos)', async () => {
    montar();
    await screen.findByText('529.982.247-25');
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

  it('o filtro de usuário vinculado envia f.usuario_id ao servidor', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    await waitFor(() => expect(screen.getByLabelText('Filtrar por usuário do sistema')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Filtrar por usuário do sistema'), { target: { value: '7' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.usuario_id=7')));
  });

  it('"Limpar filtros" remove todo o recorte de uma vez', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.change(screen.getByLabelText('Buscar representante'), { target: { value: 'ana' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=ana')));
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
    await screen.findByText('529.982.247-25');

    fireEvent.click(screen.getByRole('button', { name: 'Cargo' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('sort=cargo&dir=asc')));

    fireEvent.click(screen.getByRole('button', { name: 'Cargo' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('sort=cargo&dir=desc')));

    fireEvent.click(screen.getByRole('button', { name: 'Cargo' }));
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).not.toContain('sort=');
    });
  });

  it('as colunas sintéticas (Contato/Utilização) aparecem, mas não oferecem ordenação', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    // São colunas DERIVADAS (não são coluna do banco): o cabeçalho existe, mas
    // não é botão de ordenação — ordenar por elas geraria uma consulta inválida.
    expect(screen.getByRole('columnheader', { name: /Contato/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Utilização/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Contato' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Utilização' })).toBeNull();
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).not.toContain('sort=contato');
      expect(ultima).not.toContain('sort=uso_vinculado');
    });
  });
});

describe('Representantes — paginação server-side (C)', () => {
  it('pede page/pageSize ao servidor e preserva o recorte ao trocar de página', async () => {
    apiGet.mockImplementation(async (path: string) =>
      String(path).startsWith('/usuarios/options')
        ? (USUARIOS as never)
        : ({ ...LISTA, total: 40, pageSize: 25 } as never)
    );
    montar();
    await screen.findByText('529.982.247-25');
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('page=1'));
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('pageSize=25'));

    fireEvent.change(screen.getByLabelText('Buscar representante'), { target: { value: 'ana' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=ana')));

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => {
      const ultima = String(apiGet.mock.calls[apiGet.mock.calls.length - 1][0]);
      expect(ultima).toContain('page=2');
      expect(ultima).toContain('q=ana');
    });
  });
});

describe('Representantes — navegação para a página própria (D, F)', () => {
  it('"Novo representante" NAVEGA para /representantes/novo (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.click(screen.getAllByRole('button', { name: /Novo representante/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/representantes/novo');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
    // A lista permanece intacta.
    expect(screen.getByText('Carlos Lima')).toBeInTheDocument();
  });

  it('"Editar" NAVEGA para /representantes/:id/editar (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Ana Souza' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Editar' }));

    expect(navigateMock).toHaveBeenCalledWith('/representantes/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('duplo clique na linha abre a página de edição (atalho da listagem)', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.doubleClick(screen.getByText('529.982.247-25'));
    expect(navigateMock).toHaveBeenCalledWith('/representantes/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Representantes — exportação (contrato existente)', () => {
  it('exporta a lista atual em CSV/XLSX pelo endpoint genérico, honrando os filtros', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.click(screen.getByRole('button', { name: 'Inativos' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=false')));

    fireEvent.click(screen.getByRole('button', { name: /CSV/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));
    const [urlCsv, nomeCsv] = downloadFileMock.mock.calls[0];
    expect(String(urlCsv)).toContain('/representantes/export?format=csv');
    expect(String(urlCsv)).toContain('f.ativo=false');
    // A exportação cobre o recorte inteiro: nunca leva a paginação da tela.
    expect(String(urlCsv)).not.toContain('page=');
    expect(nomeCsv).toBe('representantes.csv');

    fireEvent.click(screen.getByRole('button', { name: /XLSX/ }));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(2));
    expect(String(downloadFileMock.mock.calls[1][0])).toContain('format=xlsx');
  });
});

describe('Representantes — colunas visíveis (persistência)', () => {
  it('ocultar uma coluna vale para a tela e persiste no navegador', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    expect(screen.getByRole('columnheader', { name: /Região/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Colunas visíveis' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Região' }));

    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Região/ })).toBeNull());
    // A MESMA chave do CRUD genérico: a preferência do usuário sobrevive.
    expect(localStorage.getItem('brobond_colunas_ocultas_representantes')).toContain('regiao');
    expect(screen.getByRole('columnheader', { name: /Representante/ })).toBeInTheDocument();
  });
});

describe('Representantes — status (G)', () => {
  it('desativa pela linha com PUT { ativo: false }', async () => {
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Ana Souza' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/representantes/1', { ativo: false }));
  });

  it('reativa pela linha com PUT { ativo: true }', async () => {
    montar();
    await screen.findByText('Carlos Lima');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Carlos Lima' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/representantes/2', { ativo: true }));
  });
});

describe('Representantes — RBAC (H)', () => {
  // O RBAC é PRESERVADO como está: `representantes` é cadastro POR EMPRESA, sem
  // `minPerfilEscrita` — o operador que já acessa o cadastro continua podendo
  // criar/editar (é o que o servidor autoriza). O que o servidor NÃO permite ao
  // operador é EXCLUIR; por isso a ação de excluir não aparece para ele.
  it('operador vê criar/editar, mas NÃO vê excluir (o servidor bloqueia o DELETE)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('529.982.247-25');
    expect(screen.getByRole('button', { name: /Novo representante/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Ana Souza' }));
    expect(await screen.findByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });
});

describe('Representantes — exclusão com diagnóstico (K, L, M)', () => {
  it('DELETE bloqueado abre o "Ver vínculos" e oferece DESATIVAR (preserva o histórico)', async () => {
    apiDel.mockRejectedValue(
      new ApiError(409, 'Existem registros vinculados.', undefined, 'dependencias_vinculadas', { dependencias: DIAG }) as never
    );
    montar();
    await screen.findByText('529.982.247-25');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Ana Souza' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));

    // Confirmação padrão do ERP.
    const confirm = await screen.findByRole('button', { name: 'Excluir' });
    fireEvent.click(confirm);

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/representantes/1'));
    // Diagnóstico com os módulos e as quantidades reais (vendas do representante).
    expect(await screen.findByText('Exclusão bloqueada por vínculos')).toBeInTheDocument();
    expect(screen.getByText('Vendas')).toBeInTheDocument();
    expect(screen.getByText('12 vendas')).toBeInTheDocument();

    // A saída é desativar, não forçar a exclusão.
    fireEvent.click(screen.getByRole('button', { name: 'Desativar representante' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/representantes/1', { ativo: false }));
  });

  it('representante sem vínculos segue a regra atual de exclusão (DELETE direto)', async () => {
    montar();
    await screen.findByText('Carlos Lima');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do representante Carlos Lima' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/representantes/2'));
  });
});
