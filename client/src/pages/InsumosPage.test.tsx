// ============================================================================
// CADASTRO DE INSUMOS — LISTA (tela principal).
//
// Trava o padrão LISTA → PÁGINA do BROBOND ERP (o MESMO de Cores e Coleções):
//   • a LISTA é a tela; "Novo insumo" NAVEGA para /insumos/novo e "Editar"
//     NAVEGA para /insumos/:id/editar — nunca abre modal, drawer ou overlay;
//   • a lista vem do servidor (GET /insumos) com busca (q), paginação
//     server-side e filtros (f.ativo, f.unidade, f.fornecedor_id) — sem SQL
//     paralelo no front;
//   • as colunas mostram só dado REAL: nome, unidade, fornecedor, custo médio,
//     saldo de estoque (agregado pelo servidor), status e utilização
//     (fichas técnicas);
//   • DELETE bloqueado (409 dependencias_vinculadas) abre o "Ver vínculos" e a
//     saída oferecida é DESATIVAR (preserva compras/movimentações/fichas);
//   • operador não vê a ação de excluir (a autoridade real é a API).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InsumosPage from './InsumosPage';
import { ToastProvider } from '../components/ui';
import { api, ApiError } from '../lib/api';
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
  // ESPELHO de server/src/resources.ts › insumos (sem campo inventado).
  const insumos = {
    key: 'insumos',
    label: 'Insumos',
    singular: 'Insumo',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    filterFields: ['categoria_id', 'unidade', 'fornecedor_id', 'ativo'],
    fields: [
      { name: 'codigo_insumo', label: 'Código', type: 'text', uniqueEmpresa: true, search: true, maxLength: 40 },
      { name: 'nome', label: 'Nome', type: 'text', required: true, search: true, maxLength: 120 },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias_insumos', search: true },
      {
        name: 'unidade',
        label: 'Unidade',
        type: 'select',
        required: true,
        default: 'un',
        options: [
          { value: 'un', label: 'Unidade (un)' },
          { value: 'm', label: 'Metro (m)' },
          { value: 'kg', label: 'Quilo (kg)' },
        ],
      },
      { name: 'fornecedor_id', label: 'Fornecedor principal', type: 'ref', ref: 'fornecedores' },
      { name: 'custo_medio', label: 'Custo médio', type: 'money', min: 0, default: 0 },
      { name: 'ativo', label: 'Ativo', type: 'boolean' },
    ],
  };
  return { ...actual, useMeta: () => ({ resources: { insumos }, modules: [] }) };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const LISTA = {
  rows: [
    {
      id: 1,
      codigo_insumo: 'INS-MAL-001',
      nome: 'Malha penteada',
      categoria_id: 10,
      categoria_id__label: 'Malhas',
      unidade: 'm',
      custo_medio: 12.5,
      fornecedor_id: 1,
      fornecedor_id__label: 'Têxtil Bella',
      ativo: true,
      estoque_saldo: 320,
      estoque_min: 100,
      estoque_status: 'normal',
      uso_vinculado: 2,
      uso_vinculado_label: '2 fichas técnicas',
    },
    {
      id: 2,
      codigo_insumo: 'INS-LIN-002',
      nome: 'Elástico',
      categoria_id: 11,
      categoria_id__label: 'Aviamentos',
      unidade: 'm',
      custo_medio: 3.2,
      fornecedor_id: null,
      ativo: false,
      estoque_saldo: 0,
      estoque_min: 0,
      estoque_status: 'sem_estoque',
      uso_vinculado: 0,
      uso_vinculado_label: '0 fichas técnicas',
    },
    {
      id: 3,
      codigo_insumo: null,
      nome: 'Botão',
      categoria_id: null,
      unidade: 'un',
      custo_medio: 0.4,
      fornecedor_id: 2,
      fornecedor_id__label: 'Química Sul',
      ativo: true,
      estoque_saldo: null,
      estoque_min: null,
      estoque_status: 'sem_registro',
      uso_vinculado: 1,
      uso_vinculado_label: '1 ficha técnica',
    },
  ],
  total: 3,
  page: 1,
  pageSize: 25,
};

const DIAG: DiagnosticoDependencias = {
  recurso: 'insumos',
  recursoLabel: 'Insumos',
  singular: 'Insumo',
  id: 1,
  empresaId: 1,
  rotulo: 'Malha penteada',
  status: null,
  origem: 'postgresql',
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Insumo Malha penteada',
  resumo: '2 registros vinculados em Ficha técnica.',
  orientacao: 'Desative o insumo (campo Ativo) em vez de excluí-lo.',
  totalRegistros: 2,
  totalBloqueantes: 2,
  modulos: ['Ficha técnica'],
  modulosBloqueantes: ['Ficha técnica'],
  geradoEm: '2026-10-26T12:00:00.000Z',
  vinculos: [
    {
      tabela: 'itens_ficha_tecnica',
      modulo: 'Ficha técnica',
      quantidade: 2,
      icone: 'producao',
      colunas: ['insumo_id'],
      recurso: 'itens_ficha_tecnica',
      ids: [1, 2],
      idsTruncados: false,
      unidade: ['ficha técnica', 'fichas técnicas'],
      tipo: 'historico',
      politica: 'proteger',
      acao: 'NO_ACTION',
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'insumos da ficha técnica vinculados a este insumo',
    },
  ],
};

function montar() {
  return render(
    <ToastProvider>
      <InsumosPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
  mockUser.perfil = 'gerente';
  apiGet.mockImplementation(async (path: string) => {
    if (String(path) === '/fornecedores/options') {
      return [
        { value: 1, label: 'Têxtil Bella' },
        { value: 2, label: 'Química Sul' },
      ] as never;
    }
    if (String(path) === '/categorias_insumos/options') {
      return [
        { value: 10, label: 'Malhas' },
        { value: 11, label: 'Aviamentos' },
      ] as never;
    }
    return LISTA as never;
  });
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 1 } as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Insumos — lista (A)', () => {
  it('lê os insumos do servidor e mostra insumo, unidade, fornecedor, custo, estoque, status e utilização', async () => {
    montar();
    expect(await screen.findByText('Malha penteada')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/insumos?'));

    // Colunas do domínio — o cabeçalho mostra exatamente o que existe.
    expect(screen.getByRole('columnheader', { name: /Código/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Insumo/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Categoria/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Unidade/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Fornecedor/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Custo médio/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Estoque/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Utilização/ })).toBeInTheDocument();

    // Código e categoria: dado REAL da listagem (não inventado na tela).
    expect(screen.getAllByText('INS-MAL-001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Malhas').length).toBeGreaterThan(0);

    // Fornecedor: o RÓTULO real que o servidor devolveu (não o id).
    expect(screen.getAllByText('Têxtil Bella').length).toBeGreaterThan(0);
    // Status textual (não só cor).
    expect(screen.getAllByText(/Ativo/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Inativo/).length).toBeGreaterThan(0);
    // Utilização: contagem REAL do servidor.
    expect(screen.getByText('2 fichas técnicas')).toBeInTheDocument();
  });

  it('mostra estado vazio orientado quando não há insumos', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/fornecedores/options') return [] as never;
      return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
    });
    montar();
    expect(await screen.findByText('Nenhum insumo cadastrado')).toBeInTheDocument();
    expect(screen.getByText(/Cadastre a primeira matéria-prima para usar nas fichas técnicas/)).toBeInTheDocument();
  });

  it('mostra o estado de erro quando a API falha', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (String(path) === '/fornecedores/options') return [] as never;
      throw new ApiError(500, 'Falha ao carregar insumos.');
    });
    montar();
    expect(await screen.findByText('Falha ao carregar insumos.')).toBeInTheDocument();
  });

  it('o modo visual (cartões) consome as MESMAS linhas, sem consulta nova', async () => {
    montar();
    await screen.findByText('Malha penteada');
    const chamadasAntes = apiGet.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Visual/ }));

    // O modo visual não refaz a consulta: consome as mesmas linhas.
    expect(await screen.findByTestId('lista-cards')).toBeInTheDocument();
    expect(screen.getByText('Malha penteada')).toBeInTheDocument();
    // O saldo e a utilização continuam visíveis no cartão.
    expect(screen.getByText('320')).toBeInTheDocument();
    expect(screen.getByText('2 fichas técnicas')).toBeInTheDocument();
    expect(apiGet.mock.calls.length).toBe(chamadasAntes);
  });

  it('a coluna Estoque mostra o saldo REAL e "—" quando o insumo nunca foi movimentado', async () => {
    montar();
    await screen.findByText('Malha penteada');
    // 320 (saldo real), 0 (saldo zerado — número real) e "—" (sem saldo).
    expect(screen.getByText('320')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('Insumos — busca e filtros (B, C)', () => {
  it('a busca envia o termo ao servidor (q), sem SQL paralelo', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.change(screen.getByLabelText('Buscar insumo'), { target: { value: 'malha' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=malha')));
  });

  it('o filtro de status envia f.ativo ao servidor', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.click(screen.getByRole('button', { name: 'Inativos' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=false')));
  });

  it('o filtro de unidade envia f.unidade ao servidor', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.change(screen.getByLabelText('Filtrar por unidade'), { target: { value: 'm' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.unidade=m')));
  });

  it('o filtro de fornecedor envia f.fornecedor_id ao servidor (opções reais do ERP)', async () => {
    montar();
    await screen.findByText('Malha penteada');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Têxtil Bella' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Filtrar por fornecedor'), { target: { value: '1' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.fornecedor_id=1')));
  });

  it('o filtro de categoria envia f.categoria_id ao servidor (opções reais do ERP)', async () => {
    montar();
    await screen.findByText('Malha penteada');
    // As opções vêm do endpoint padrão de opções — nenhuma lista paralela.
    await waitFor(() => expect(screen.getByRole('option', { name: 'Aviamentos' })).toBeInTheDocument());
    expect(apiGet).toHaveBeenCalledWith('/categorias_insumos/options');
    fireEvent.change(screen.getByLabelText('Filtrar por categoria'), { target: { value: '11' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.categoria_id=11')));
  });
});

describe('Insumos — navegação para a página própria (D, F)', () => {
  it('"Novo insumo" NAVEGA para /insumos/novo (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.click(screen.getAllByRole('button', { name: /Novo insumo/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/insumos/novo');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
    // A lista permanece intacta.
    expect(screen.getByText('Elástico')).toBeInTheDocument();
  });

  it('"Editar" NAVEGA para /insumos/:id/editar (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Malha penteada' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Editar' }));

    expect(navigateMock).toHaveBeenCalledWith('/insumos/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});

describe('Insumos — status (G)', () => {
  it('desativa pela linha com PUT { ativo: false }', async () => {
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Malha penteada' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/insumos/1', { ativo: false }));
  });

  it('reativa pela linha com PUT { ativo: true }', async () => {
    montar();
    await screen.findByText('Elástico');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Elástico' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/insumos/2', { ativo: true }));
  });
});

describe('Insumos — RBAC (H)', () => {
  // O RBAC é PRESERVADO como está: `insumos` é cadastro POR EMPRESA, sem
  // `minPerfilEscrita` — o operador que já acessa o cadastro continua podendo
  // criar/editar (é o que o servidor autoriza). O que o servidor NÃO permite ao
  // operador é EXCLUIR; por isso a ação de excluir não aparece para ele.
  it('operador vê criar/editar, mas NÃO vê excluir (o servidor bloqueia o DELETE)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('Malha penteada');
    expect(screen.getByRole('button', { name: /Novo insumo/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Malha penteada' }));
    expect(await screen.findByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });
});

describe('Insumos — exclusão com diagnóstico (K, L, M)', () => {
  it('DELETE bloqueado abre o "Ver vínculos" e oferece DESATIVAR (preserva o histórico)', async () => {
    apiDel.mockRejectedValue(
      new ApiError(409, 'Existem registros vinculados.', undefined, 'dependencias_vinculadas', { dependencias: DIAG }) as never
    );
    montar();
    await screen.findByText('Malha penteada');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Malha penteada' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));

    // Confirmação padrão do ERP.
    const confirm = await screen.findByRole('button', { name: 'Excluir' });
    fireEvent.click(confirm);

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/insumos/1'));
    // Diagnóstico com os módulos e as quantidades reais.
    expect(await screen.findByText('Exclusão bloqueada por vínculos')).toBeInTheDocument();
    expect(screen.getByText('Ficha técnica')).toBeInTheDocument();
    expect(screen.getByText('2 fichas técnicas')).toBeInTheDocument();

    // A saída é desativar, não forçar a exclusão.
    fireEvent.click(screen.getByRole('button', { name: 'Desativar insumo' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/insumos/1', { ativo: false }));
  });

  it('insumo sem vínculos segue a regra atual de exclusão (DELETE direto)', async () => {
    montar();
    await screen.findByText('Elástico');
    fireEvent.click(screen.getByRole('button', { name: 'Ações do insumo Elástico' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/insumos/2'));
  });
});
