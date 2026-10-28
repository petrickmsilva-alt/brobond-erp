// ============================================================================
// CADASTROS › CORES — lista profissional (a tela principal do módulo).
//
// Trava o contrato da LISTAGEM, que não muda com o microfix visual:
//   A. lista abre com cabeçalho, amostra, nome, HEX, status e utilização;
//   B. busca vai para o servidor (`q=`) e sobrevive ao debounce;
//   C. filtro Ativas/Inativas usa o contrato existente (`f.ativo`), sem SQL novo;
//   D. "Nova cor" NAVEGA para /cores/novo — página normal do ERP, sem modal,
//      sem drawer e sem overlay;
//   H. editar NAVEGA para /cores/:id/editar (mesma regra);
//   I. ação Desativar usa o PUT existente e mantém o registro;
//   J/K. operador SEM piso de escrita: lê, mas não cria/edita/exclui;
//   L. exclusão bloqueada usa o diagnóstico de vínculos (PR #83) e oferece
//      "Desativar cor" em vez de forçar o DELETE;
//   M. cor sem vínculo segue o fluxo normal de exclusão.
//
// O formulário em si (campos, HEX, preview, salvar/cancelar) é coberto por
// CorFormPage.test.tsx — aqui só se garante que a lista manda para a página.
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
  // Metadados no formato de GET /api/meta (espelham server/src/resources.ts).
  const cores = {
    key: 'cores',
    label: 'Cores',
    singular: 'Cor',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente',
    filterFields: ['ativo'],
    quickFilters: [
      {
        field: 'ativo',
        label: 'Status',
        options: [
          { value: '', label: 'Todas' },
          { value: 'true', label: 'Ativas' },
          { value: 'false', label: 'Inativas' },
        ],
      },
    ],
    uso: { recurso: 'produtos', campo: 'cor_id', singular: 'produto', plural: 'produtos' },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, list: true },
      { name: 'hex', label: 'Código HEX', type: 'color', search: true, list: true },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, list: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
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
const apiDel = vi.mocked(api.del);

const MODULE = {
  id: 'cores',
  label: 'Cores',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Cadastros',
  group: 'Produtos',
  subgroup: 'Classificações',
  path: '/cores',
  resource: 'cores',
  description: 'Cores padronizadas usadas no catálogo de produtos.',
} as Module;

const LINHAS = [
  { id: 3, nome: 'Azul marinho', hex: '#172038', ativo: true, uso_vinculado: 18, uso_vinculado_label: '18 produtos' },
  { id: 1, nome: 'Preto', hex: '#000000', ativo: true, uso_vinculado: 31, uso_vinculado_label: '31 produtos' },
  { id: 2, nome: 'Off-white', hex: '#F5F5F0', ativo: true, uso_vinculado: 9, uso_vinculado_label: '9 produtos' },
  { id: 4, nome: 'Cinza mescla', hex: '', ativo: false, uso_vinculado: 0, uso_vinculado_label: '0 produtos' },
];

const DIAGNOSTICO = {
  recurso: 'cores',
  recursoLabel: 'Cores',
  singular: 'Cor',
  id: 3,
  empresaId: 1,
  rotulo: 'Azul marinho',
  status: null,
  origem: 'postgresql' as const,
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Cor Azul marinho',
  resumo: 'Não é possível excluir Cor Azul marinho: existem 18 registros vinculados em Produtos.',
  orientacao: 'Desative o registro (campo Ativo) em vez de excluí-lo: o histórico do sistema depende dele.',
  totalRegistros: 18,
  totalBloqueantes: 18,
  modulos: ['Produtos'],
  modulosBloqueantes: ['Produtos'],
  vinculos: [
    {
      modulo: 'Produtos',
      icone: 'produtos',
      tabela: 'produtos',
      colunas: ['cor_id'],
      recurso: 'produtos',
      quantidade: 18,
      ids: [1, 2, 3],
      idsTruncados: true,
      unidade: ['produto', 'produtos'] as [string, string],
      tipo: 'operacional' as const,
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

/** Última URL pedida à listagem de cores. */
function ultimaLista(): string {
  const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/cores?'));
  return chamadas[chamadas.length - 1] ?? '';
}

/**
 * Monta a listagem com as rotas de destino REGISTRADAS (o roteador real do
 * ERP). Assim o teste prova a navegação — e não uma abertura de formulário.
 */
function renderPagina() {
  return render(
    <MemoryRouter initialEntries={['/cores']}>
      <ToastProvider>
        <Routes>
          <Route path="/cores" element={<ModulePage module={MODULE} />} />
          <Route path="/cores/novo" element={<div>Página nova cor</div>} />
          <Route path="/cores/:id/editar" element={<div>Página editar cor</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

/**
 * PainelInline do ERP com título: o `PainelInline` genérico não liga o título ao `role=dialog`
 * por aria-labelledby (comportamento histórico), então localizamos pelo texto e
 * subimos até o diálogo.
 */
function blocoPorTitulo(titulo: string): HTMLElement {
  // ZERO MODAL: confirmação e diagnóstico são blocos INLINE na página (role=group
  // ou <section>), nunca role="dialog". Localizamos pelo texto e subimos até o
  // bloco de decisão.
  const el = screen.getByText(titulo);
  const bloco = el.closest('[role="group"], section');
  if (!bloco) throw new Error(`bloco "${titulo}" não encontrado`);
  return bloco as HTMLElement;
}

/** Botão "Nova cor" do cabeçalho (o FAB mobile é o segundo, oculto no desktop). */
function botaoNovaCor(): HTMLElement {
  const botoes = screen.getAllByRole('button', { name: /Nova cor/i });
  return botoes[0];
}

/** Linha da tabela pelo nome da cor. */
function linha(nome: string): HTMLElement {
  const cell = screen.getByText(nome);
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`linha da cor "${nome}" não encontrada`);
  return tr as HTMLElement;
}

beforeEach(() => {
  auth.user = { id: 1, name: 'Admin', perfil: 'admin' };
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/cores?')) {
      return { rows: LINHAS, total: LINHAS.length, page: 1, pageSize: 25 } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
  apiPost.mockResolvedValue({ id: 9 } as never);
  apiPut.mockResolvedValue({} as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Cores — lista profissional', () => {
  it('A. abre a lista com cabeçalho, amostra, nome, HEX, status e utilização', async () => {
    renderPagina();

    expect(await screen.findByRole('heading', { name: /Cores/ })).toBeInTheDocument();
    expect(screen.getByText('Cores padronizadas usadas no catálogo de produtos.')).toBeInTheDocument();

    // Colunas na ordem do padrão: AMOSTRA · COR · HEX · STATUS · UTILIZAÇÃO.
    const cabecalhos = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(cabecalhos).toEqual(['Amostra', 'Cor', 'HEX', 'Status', 'Utilização', 'Ações']);

    const azul = linha('Azul marinho');
    expect(within(azul).getByText('#172038')).toBeInTheDocument();
    expect(within(azul).getByText('Ativo')).toBeInTheDocument();
    expect(within(azul).getByText('18 produtos')).toBeInTheDocument();

    // Amostra: respeita o HEX real e tem rótulo acessível (não depende só da cor).
    const amostra = within(azul).getByRole('img', { name: /Amostra da cor Azul marinho: #172038/i });
    expect(amostra).toHaveStyle({ backgroundColor: '#172038' });

    // Sem HEX, a amostra é neutra (hachura) e a utilização zero vira "—".
    const cinza = linha('Cinza mescla');
    expect(within(cinza).getByRole('img', { name: /sem código HEX/i })).toBeInTheDocument();
    expect(within(cinza).getByText('Inativo')).toBeInTheDocument();
    // HEX vazio e utilização zero aparecem como "—" (nada de número inventado).
    expect(within(cinza).getAllByText('—')).toHaveLength(2);
    expect(within(cinza).queryByText(/produto/)).toBeNull();
  });

  it('B. busca por nome chega ao servidor como `q`', async () => {
    renderPagina();
    await screen.findByText('Azul marinho');

    fireEvent.change(screen.getByLabelText('Buscar cor...'), { target: { value: 'azul' } });

    await waitFor(() => expect(ultimaLista()).toContain('q=azul'), { timeout: 2000 });
    // A busca continua sendo a MESMA listagem paginada (nenhum endpoint novo).
    expect(ultimaLista()).toContain('page=1');
  });

  it('C. filtro Todas/Ativas/Inativas usa o recorte `f.ativo` existente', async () => {
    renderPagina();
    await screen.findByText('Azul marinho');

    const grupo = screen.getByRole('group', { name: 'Status' });

    fireEvent.click(within(grupo).getByRole('button', { name: 'Inativas' }));
    await waitFor(() => expect(ultimaLista()).toContain('f.ativo=false'));
    expect(within(grupo).getByRole('button', { name: 'Inativas' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Filtros ativos (1)')).toBeInTheDocument();

    fireEvent.click(within(grupo).getByRole('button', { name: 'Ativas' }));
    await waitFor(() => expect(ultimaLista()).toContain('f.ativo=true'));

    fireEvent.click(within(grupo).getByRole('button', { name: 'Todas' }));
    await waitFor(() => expect(ultimaLista()).not.toContain('f.ativo='));
  });

  it('D. "Nova cor" NAVEGA para /cores/novo — sem modal, sem drawer, sem overlay', async () => {
    renderPagina();
    await screen.findByText('Azul marinho');

    fireEvent.click(botaoNovaCor());

    // A página normal do ERP é montada pelo roteador…
    expect(await screen.findByText('Página nova cor')).toBeInTheDocument();
    // …e NENHUMA superfície sobreposta é aberta (nem modal, nem drawer/sheet).
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // Nada de formulário aberto sobre a lista: a lista saiu da tela.
    expect(screen.queryByText('Azul marinho')).toBeNull();
  });

  it('H. editar NAVEGA para /cores/:id/editar (sem formulário sobreposto)', async () => {
    renderPagina();
    await screen.findByText('Cinza mescla');

    fireEvent.click(within(linha('Cinza mescla')).getByLabelText('Editar'));

    expect(await screen.findByText('Página editar cor')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('H2. duplo clique na linha também abre a PÁGINA de edição', async () => {
    renderPagina();
    await screen.findByText('Cinza mescla');

    fireEvent.doubleClick(linha('Cinza mescla'));

    expect(await screen.findByText('Página editar cor')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('J/K. operador lê o catálogo, mas não vê criar/editar/excluir (RBAC do servidor preservado)', async () => {
    auth.user = { id: 2, name: 'Operador', perfil: 'operador' };
    renderPagina();

    expect(await screen.findByText('Azul marinho')).toBeInTheDocument();
    expect(screen.getByText(/Apenas gerentes e administradores podem incluir, alterar ou excluir/i)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Nova cor/i })).toBeNull();
    expect(screen.queryByLabelText('Editar')).toBeNull();
    expect(screen.queryByLabelText('Excluir')).toBeNull();
    expect(screen.queryByLabelText('Desativar')).toBeNull();
    // Nem o atalho de edição por duplo clique abre o formulário.
    fireEvent.doubleClick(linha('Azul marinho'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Página editar cor')).toBeNull();
  });
});

describe('Cores — ações da lista (contrato existente)', () => {
  it('I. ação Desativar usa o PUT existente e mantém o registro', async () => {
    renderPagina();
    await screen.findByText('Azul marinho');
    fireEvent.click(within(linha('Azul marinho')).getByLabelText('Desativar'));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/cores/3', { ativo: false }));
    expect(apiDel).not.toHaveBeenCalled();
  });
});

describe('Cores — exclusão com diagnóstico de vínculos', () => {
  it('L. cor vinculada não é excluída: abre o diagnóstico e oferece desativar', async () => {
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
    await screen.findByText('Azul marinho');

    fireEvent.click(within(linha('Azul marinho')).getByLabelText('Excluir'));
    const confirmacao = blocoPorTitulo('Excluir cor?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    // O DELETE foi tentado e recusado pelo servidor (FK é a proteção final).
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/cores/3'));
    await screen.findByText('Exclusão bloqueada por vínculos');
    const diagnostico = blocoPorTitulo('Exclusão bloqueada por vínculos');
    // Frase do padrão: a voz do cadastro, não o resumo técnico do servidor.
    expect(
      within(diagnostico).getByText('Não é possível excluir esta cor porque existem registros vinculados.')
    ).toBeInTheDocument();
    // ...e o diagnóstico segue dizendo ONDE, QUANTOS e POR QUÊ.
    expect(within(diagnostico).getByText('Produtos')).toBeInTheDocument();
    expect(within(diagnostico).getByText(/18 registros/)).toBeInTheDocument();
    expect(within(diagnostico).getByText(/vínculo ativo/i)).toBeInTheDocument();
    expect(within(diagnostico).getByText(/Nada foi apagado/i)).toBeInTheDocument();

    // A saída recomendada é DESATIVAR — nunca forçar o DELETE.
    fireEvent.click(within(diagnostico).getByRole('button', { name: 'Desativar cor' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/cores/3', { ativo: false }));
    expect(apiDel).toHaveBeenCalledTimes(1);
  });

  it('M. cor sem vínculo segue o fluxo normal de exclusão', async () => {
    renderPagina();
    await screen.findByText('Preto');

    fireEvent.click(within(linha('Preto')).getByLabelText('Excluir'));
    const confirmacao = blocoPorTitulo('Excluir cor?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/cores/1'));
    await waitFor(() => expect(screen.queryByText('Excluir cor?')).toBeNull());
    // A lista é recarregada depois da exclusão (mesma página, mesmo contrato).
    await waitFor(() => expect(ultimaLista()).toContain('/cores?page=1'));
  });
});
