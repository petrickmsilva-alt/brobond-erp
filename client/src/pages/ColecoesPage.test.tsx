// ============================================================================
// CADASTRO DE COLEÇÕES — LISTA (tela principal).
//
// Trava o padrão LISTA → PÁGINA do BROBOND ERP (o MESMO de Cores):
//   • a LISTA é a tela; "Nova coleção" NAVEGA para /colecoes/novo e "Editar"
//     NAVEGA para /colecoes/:id/editar — nunca abre modal, drawer ou overlay;
//   • a lista vem do servidor (GET /colecoes) com busca (q) e filtro de status
//     (f.ativo), sem SQL paralelo no front;
//   • "Utilização" mostra a contagem REAL de produtos (ou "—");
//   • DELETE bloqueado (409 dependencias_vinculadas) abre o "Ver vínculos" e a
//     saída oferecida é DESATIVAR (preserva o histórico);
//   • operador não vê os controles de escrita (a autoridade real é a API).
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ColecoesPage from './ColecoesPage';
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
    constructor(status: number, message: string, fields?: Record<string, string>, code?: string, details?: Record<string, unknown>) {
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
  const colecoes = {
    key: 'colecoes',
    label: 'Coleções',
    singular: 'Coleção',
    labelFields: ['nome'],
    // SEM minPerfilEscrita: cadastro por empresa, operável por quem já tem acesso.
    ops: { create: true, update: true, delete: true },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, maxLength: 80, placeholder: 'Verão 2027, Coleção Premium...' },
      {
        name: 'temporada',
        label: 'Temporada',
        type: 'select',
        options: [
          { value: 'Verão', label: 'Verão' },
          { value: 'Inverno', label: 'Inverno' },
          { value: 'Outono', label: 'Outono' },
        ],
      },
      { name: 'ano', label: 'Ano', type: 'integer', min: 2000, max: 2100 },
      { name: 'ativo', label: 'Ativo', type: 'boolean' },
    ],
  };
  return { ...actual, useMeta: () => ({ resources: { colecoes }, modules: [] }) };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const LISTA = {
  rows: [
    { id: 1, nome: 'Verão 2027', temporada: 'Verão', ano: 2027, ativo: true, produtos_vinculados: 32 },
    { id: 2, nome: 'Inverno 2026', temporada: 'Inverno', ano: 2026, ativo: false, produtos_vinculados: 0 },
    { id: 3, nome: 'Coleção Premium', temporada: null, ano: null, ativo: true },
  ],
  total: 3,
  page: 1,
  pageSize: 25,
};

const DIAG: DiagnosticoDependencias = {
  recurso: 'colecoes',
  recursoLabel: 'Coleções',
  singular: 'Coleção',
  id: 1,
  empresaId: 1,
  rotulo: 'Verão 2027',
  status: null,
  origem: 'postgresql',
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Coleção Verão 2027',
  resumo: '3 registros vinculados em Produtos.',
  orientacao: 'Desative a coleção (campo Ativo) em vez de excluí-la.',
  totalRegistros: 32,
  totalBloqueantes: 32,
  modulos: ['Produtos'],
  modulosBloqueantes: ['Produtos'],
  geradoEm: '2026-10-26T12:00:00.000Z',
  vinculos: [
    {
      tabela: 'produtos',
      modulo: 'Produtos',
      quantidade: 32,
      icone: 'produtos',
      colunas: ['colecao_id'],
      recurso: 'produtos',
      ids: [1, 2, 3],
      idsTruncados: true,
      unidade: ['produto', 'produtos'],
      tipo: 'historico',
      politica: 'proteger',
      acao: 'NO_ACTION',
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'produtos do catálogo vinculados a esta coleção',
    },
  ],
};

function montar() {
  return render(
    <ToastProvider>
      <ColecoesPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
  mockUser.perfil = 'gerente';
  apiGet.mockResolvedValue(LISTA as never);
  apiPost.mockResolvedValue({ id: 99 } as never);
  apiPut.mockResolvedValue({ id: 1 } as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Coleções — lista (A)', () => {
  it('lê as coleções do servidor e mostra coleção, status e utilização real', async () => {
    montar();
    expect(await screen.findByText('Verão 2027')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/colecoes?'));

    // Status textual (não só cor) — Ativa/Inativa.
    expect(screen.getAllByText('● Ativa').length).toBeGreaterThan(0);
    expect(screen.getByText('● Inativa')).toBeInTheDocument();

    // Utilização: contagem REAL do servidor; sem contagem vira "—".
    expect(screen.getByText('32 produtos')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('mostra estado vazio orientado quando não há coleções', async () => {
    apiGet.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 } as never);
    montar();
    expect(await screen.findByText('Nenhuma coleção cadastrada')).toBeInTheDocument();
    expect(screen.getByText(/Cadastre sua primeira coleção/)).toBeInTheDocument();
  });
});

describe('Coleções — busca e filtro (B, C)', () => {
  it('a busca envia o termo ao servidor (q), sem SQL paralelo', async () => {
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.change(screen.getByLabelText('Buscar coleção'), { target: { value: 'verão' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('q=ver%C3%A3o')));
  });

  it('o filtro de status envia f.ativo ao servidor', async () => {
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: 'false' } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('f.ativo=false')));
  });
});

describe('Coleções — navegação para a página própria (D, F)', () => {
  it('"Nova coleção" NAVEGA para /colecoes/novo (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.click(screen.getAllByRole('button', { name: /Nova coleção/ })[0]);

    expect(navigateMock).toHaveBeenCalledWith('/colecoes/novo');
    // Nenhuma superfície sobreposta é montada na lista.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
    // A lista permanece intacta.
    expect(screen.getByText('Inverno 2026')).toBeInTheDocument();
  });

  it('"Editar" NAVEGA para /colecoes/:id/editar (sem modal/drawer/overlay)', async () => {
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.click(screen.getByRole('button', { name: 'Ações da coleção Verão 2027' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Editar' }));

    expect(navigateMock).toHaveBeenCalledWith('/colecoes/1/editar');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.querySelector('[data-drawer], [data-sheet]')).toBeNull();
  });
});


describe('Coleções — status (G)', () => {
  it('desativa pela linha com PUT { ativo: false }', async () => {
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.click(screen.getByRole('button', { name: 'Ações da coleção Verão 2027' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desativar' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/colecoes/1', { ativo: false }));
  });
});

describe('Coleções — RBAC (H)', () => {
  // O RBAC é PRESERVADO como está: `colecoes` é cadastro POR EMPRESA, sem
  // `minPerfilEscrita` — o operador que já acessa o cadastro continua podendo
  // criar/editar (é o que o servidor autoriza). O que o servidor NÃO permite ao
  // operador é EXCLUIR; por isso a ação de excluir não aparece para ele.
  it('operador vê criar/editar, mas NÃO vê excluir (o servidor bloqueia o DELETE)', async () => {
    mockUser.perfil = 'operador';
    montar();
    await screen.findByText('Verão 2027');
    expect(screen.getByRole('button', { name: /Nova coleção/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações da coleção Verão 2027' }));
    expect(await screen.findByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });
});

describe('Coleções — exclusão com diagnóstico (K, L, M)', () => {
  it('DELETE bloqueado abre o "Ver vínculos" e oferece DESATIVAR (preserva o histórico)', async () => {
    apiDel.mockRejectedValue(new ApiError(409, 'Existem registros vinculados.', undefined, 'dependencias_vinculadas', { dependencias: DIAG }) as never);
    montar();
    await screen.findByText('Verão 2027');
    fireEvent.click(screen.getByRole('button', { name: 'Ações da coleção Verão 2027' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));

    // Confirmação padrão do ERP.
    const confirm = await screen.findByRole('button', { name: 'Tentar excluir' });
    fireEvent.click(confirm);

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/colecoes/1'));
    // Diagnóstico com os módulos e as quantidades reais.
    expect(await screen.findByText('Exclusão bloqueada por vínculos')).toBeInTheDocument();
    expect(screen.getByText('Produtos')).toBeInTheDocument();
    expect(screen.getByText('32 produtos')).toBeInTheDocument();

    // A saída é desativar, não forçar a exclusão.
    fireEvent.click(screen.getByRole('button', { name: 'Desativar coleção' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/colecoes/1', { ativo: false }));
  });

  it('coleção sem vínculos segue a regra atual de exclusão (DELETE direto)', async () => {
    montar();
    await screen.findByText('Coleção Premium');
    fireEvent.click(screen.getByRole('button', { name: 'Ações da coleção Coleção Premium' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/colecoes/3'));
  });
});
