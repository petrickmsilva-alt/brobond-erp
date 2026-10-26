// ============================================================================
// CADASTROS › TAMANHOS — lista profissional (a tela principal do módulo).
//
// Trava o contrato da LISTAGEM e a mudança de UX que a profissionaliza:
//   A. a lista abre com cabeçalho, código, descrição e ordem — sem coluna
//      "Status" (Tamanhos NÃO têm campo Ativo no domínio);
//   B. busca vai para o servidor (`q=`) e sobrevive ao debounce;
//   D. "Novo tamanho" NAVEGA para /tamanhos/novo — página normal do ERP, sem
//      modal, sem drawer e sem overlay (o modal central foi REMOVIDO);
//   H. editar NAVEGA para /tamanhos/:id/editar (mesma regra);
//   J/K. operador (catálogo compartilhado, escrita gerente+) lê, mas não
//      cria/edita/exclui;
//   L. exclusão bloqueada usa o diagnóstico de vínculos e NÃO força o DELETE
//      (Tamanhos não tem "Ativo": a saída recomendada é o diagnóstico).
//
// O formulário em si (campos, salvar/cancelar) é coberto por
// TamanhoFormPage.test.tsx — aqui só se garante que a lista manda para a página.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ModulePage from './ModulePage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';
import type { Module } from '../modules';

const auth = vi.hoisted(() => ({
  user: { id: 1, name: 'Admin', perfil: 'admin' as 'admin' | 'gerente' | 'operador' },
}));

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
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
  },
  downloadFile: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
}));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  // ESPELHO de server/src/resources.ts › tamanhos (sem campo inventado).
  const tamanhos = {
    key: 'tamanhos',
    label: 'Tamanhos / Grade',
    singular: 'Tamanho',
    labelFields: ['codigo'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente' as const,
    fields: [
      { name: 'codigo', label: 'Código', type: 'text', required: true, unique: true, search: true, list: true, maxLength: 10 },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, list: true, maxLength: 60 },
      { name: 'ordem', label: 'Ordem na grade', type: 'integer', min: 0, default: 0, list: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { tamanhos }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const MODULE = {
  id: 'tamanhos',
  label: 'Tamanhos',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Cadastros',
  group: 'Produtos',
  subgroup: 'Grades e medidas',
  path: '/tamanhos',
  resource: 'tamanhos',
  description: 'Dicionário de tamanhos: PP, P, M, G, GG, 36, 38, 40...',
} as Module;

const LINHAS = [
  { id: 11, codigo: 'PP', descricao: 'Extra pequeno', ordem: 1 },
  { id: 12, codigo: 'M', descricao: 'Médio', ordem: 3 },
  { id: 13, codigo: 'GG', descricao: 'Extra grande', ordem: 5 },
];

const DIAGNOSTICO = {
  recurso: 'tamanhos',
  recursoLabel: 'Tamanhos',
  singular: 'Tamanho',
  id: 12,
  empresaId: 1,
  rotulo: 'M',
  status: null,
  origem: 'postgresql' as const,
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Tamanho M',
  resumo: 'Não é possível excluir Tamanho M: existem 6 registros vinculados em Estoque.',
  orientacao: 'O tamanho tem saldo/movimentação de estoque. Ajuste o estoque antes de excluí-lo.',
  totalRegistros: 6,
  totalBloqueantes: 6,
  modulos: ['Estoque'],
  modulosBloqueantes: ['Estoque'],
  vinculos: [
    {
      modulo: 'Estoque',
      icone: 'estoque',
      tabela: 'estoques',
      colunas: ['tamanho_id'],
      recurso: 'estoques',
      quantidade: 2,
      ids: [41, 42],
      idsTruncados: false,
      unidade: ['saldo', 'saldos'] as [string, string],
      tipo: 'historico' as const,
      politica: 'seguir' as const,
      acao: 'NO_ACTION' as const,
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'vínculo ativo — o banco recusa a exclusão enquanto estes registros existirem',
    },
    {
      modulo: 'Estoque',
      icone: 'estoque',
      tabela: 'movimentacoes',
      colunas: ['tamanho_id'],
      recurso: 'movimentacoes',
      quantidade: 4,
      ids: [101, 102, 103, 104],
      idsTruncados: false,
      unidade: ['movimentação', 'movimentações'] as [string, string],
      tipo: 'historico' as const,
      politica: 'seguir' as const,
      acao: 'NO_ACTION' as const,
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'vínculo ativo — o banco recusa a exclusão enquanto estes registros existirem',
    },
  ],
  geradoEm: '2026-10-26T12:00:00.000Z',
};

/** Última URL pedida à listagem de tamanhos. */
function ultimaLista(): string {
  const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/tamanhos?'));
  return chamadas[chamadas.length - 1] ?? '';
}

/**
 * Monta a listagem com as rotas de destino REGISTRADAS (o roteador real do
 * ERP). Assim o teste prova a navegação — e não uma abertura de formulário.
 */
function renderPagina() {
  return render(
    <MemoryRouter initialEntries={['/tamanhos']}>
      <ToastProvider>
        <Routes>
          <Route path="/tamanhos" element={<ModulePage module={MODULE} />} />
          <Route path="/tamanhos/novo" element={<div>Página novo tamanho</div>} />
          <Route path="/tamanhos/:id/editar" element={<div>Página editar tamanho</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

/** Linha da tabela pelo código do tamanho. */
function linha(codigo: string): HTMLElement {
  const cell = screen.getByText(codigo);
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`linha do tamanho "${codigo}" não encontrada`);
  return tr as HTMLElement;
}

/** Botão "Novo tamanho" do cabeçalho (o FAB mobile é o segundo). */
function botaoNovoTamanho(): HTMLElement {
  return screen.getAllByRole('button', { name: /Novo tamanho/i })[0];
}

beforeEach(() => {
  auth.user = { id: 1, name: 'Admin', perfil: 'admin' };
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/tamanhos?')) {
      return { rows: LINHAS, total: LINHAS.length, page: 1, pageSize: 25 } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({} as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Tamanhos — lista profissional', () => {
  it('A. abre a lista com cabeçalho, código, descrição e ordem (sem coluna Status)', async () => {
    renderPagina();

    expect(await screen.findByRole('heading', { name: /Tamanhos/ })).toBeInTheDocument();
    expect(screen.getByText('Dicionário de tamanhos: PP, P, M, G, GG, 36, 38, 40...')).toBeInTheDocument();

    // Colunas na ordem canônica: # · CÓDIGO · DESCRIÇÃO · ORDEM NA GRADE · AÇÕES.
    const cabecalhos = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(cabecalhos).toEqual(['#', 'Código', 'Descrição', 'Ordem na grade', 'Ações']);

    const gg = linha('GG');
    expect(within(gg).getByText('Extra grande')).toBeInTheDocument();
    expect(within(gg).getByText('5')).toBeInTheDocument();

    // Tamanhos NÃO têm Ativo: nenhuma coluna/ação de status aparece.
    expect(screen.queryByText('Status')).toBeNull();
  });

  it('B. busca por código chega ao servidor como `q`', async () => {
    renderPagina();
    await screen.findByText('GG');

    fireEvent.change(screen.getByLabelText(/Buscar/), { target: { value: 'gg' } });

    await waitFor(() => expect(ultimaLista()).toContain('q=gg'), { timeout: 2000 });
    expect(ultimaLista()).toContain('page=1');
  });

  it('D. "Novo tamanho" NAVEGA para /tamanhos/novo — sem modal, sem drawer, sem overlay', async () => {
    renderPagina();
    await screen.findByText('GG');

    fireEvent.click(botaoNovoTamanho());

    // A página normal do ERP é montada pelo roteador…
    expect(await screen.findByText('Página novo tamanho')).toBeInTheDocument();
    // …e NENHUMA superfície sobreposta é aberta (nem modal, nem drawer/sheet).
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // Nada de formulário aberto sobre a lista: a lista saiu da tela.
    expect(screen.queryByText('GG')).toBeNull();
  });

  it('H. editar NAVEGA para /tamanhos/:id/editar (sem formulário sobreposto)', async () => {
    renderPagina();
    await screen.findByText('M');

    fireEvent.click(within(linha('M')).getByLabelText('Editar'));

    expect(await screen.findByText('Página editar tamanho')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('H2. duplo clique na linha também abre a PÁGINA de edição', async () => {
    renderPagina();
    await screen.findByText('M');

    fireEvent.doubleClick(linha('M'));

    expect(await screen.findByText('Página editar tamanho')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('J/K. operador lê o catálogo, mas não vê criar/editar/excluir (RBAC do servidor preservado)', async () => {
    auth.user = { id: 2, name: 'Operador', perfil: 'operador' };
    renderPagina();

    expect(await screen.findByText('GG')).toBeInTheDocument();
    expect(screen.getByText(/Apenas gerentes e administradores podem incluir, alterar ou excluir/i)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Novo tamanho/i })).toBeNull();
    expect(screen.queryByLabelText('Editar')).toBeNull();
    expect(screen.queryByLabelText('Excluir')).toBeNull();
    // Nem o atalho de edição por duplo clique abre o formulário.
    fireEvent.doubleClick(linha('GG'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Página editar tamanho')).toBeNull();
  });
});

describe('Tamanhos — exclusão com diagnóstico de vínculos', () => {
  it('L. tamanho vinculado não é excluído: abre o diagnóstico e NÃO força o DELETE', async () => {
    const { ApiError } = await import('../lib/api');
    apiDel.mockRejectedValueOnce(
      new (ApiError as unknown as new (s: number, m: string, f?: Record<string, string>, c?: string, d?: Record<string, unknown>) => Error)(
        409,
        DIAGNOSTICO.resumo,
        undefined,
        'dependencias_vinculadas',
        { dependencias: DIAGNOSTICO }
      )
    );
    renderPagina();
    await screen.findByText('M');

    fireEvent.click(within(linha('M')).getByLabelText('Excluir'));
    const confirmacao = dialogPorTitulo('Excluir tamanho?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    // O DELETE foi tentado e recusado pelo servidor (FK é a proteção final).
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/tamanhos/12'));
    await screen.findByText('Exclusão bloqueada por vínculos');
    const diagnostico = dialogPorTitulo('Exclusão bloqueada por vínculos');
    // Frase do padrão: a voz do cadastro, não o resumo técnico do servidor.
    expect(
      within(diagnostico).getByText('Não é possível excluir este tamanho porque existem registros vinculados.')
    ).toBeInTheDocument();
    // ...e o diagnóstico segue dizendo ONDE, QUANTOS e POR QUÊ.
    expect(within(diagnostico).getByText('Estoque')).toBeInTheDocument();
    expect(within(diagnostico).getByText(/Nada foi apagado/i)).toBeInTheDocument();
    // Tamanhos não tem "Ativo": não há atalho de desativar no diagnóstico.
    expect(within(diagnostico).queryByRole('button', { name: /Desativar/i })).toBeNull();
    // Só uma tentativa de DELETE — o diagnóstico é somente leitura.
    expect(apiDel).toHaveBeenCalledTimes(1);
  });
});

/** Modal do ERP com título (o Modal genérico não liga o título ao role=dialog). */
function dialogPorTitulo(titulo: string): HTMLElement {
  const el = screen.getByText(titulo);
  const dlg = el.closest('[role="dialog"]');
  if (!dlg) throw new Error(`diálogo "${titulo}" não encontrado`);
  return dlg as HTMLElement;
}
