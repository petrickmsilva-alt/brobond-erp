// ============================================================================
// CADASTROS › GRADES — lista profissional (a tela principal do módulo).
//
// Trava o contrato da LISTAGEM depois da virada LISTA → PÁGINA:
//   A. abre com cabeçalho e as colunas GRADE · TAMANHOS · MEDIDAS · STATUS ·
//      UTILIZAÇÃO · DESCRIÇÃO · AÇÕES, todas com dados REAIS do payload;
//   B. busca vai para o servidor (`q=`) e sobrevive ao debounce;
//   C. filtro Todas/Ativas/Inativas usa o recorte existente (`f.ativo`);
//   D. "Nova grade" NAVEGA para /grades/novo — página normal do ERP, sem modal,
//      sem drawer e sem overlay;
//   E. editar NAVEGA para /grades/:id/editar (botão e duplo clique);
//   F. "Tabela de medidas" leva ao módulo existente (/medidas?grade=<id>);
//   G. a coluna MEDIDAS mostra o estado real (sem tabela / parcial / completa)
//      e a UTILIZAÇÃO só aparece quando existe vínculo — nada inventado;
//   H. SEM N+1: a listagem inteira é UMA chamada; nenhuma consulta por grade;
//   I. ação Desativar usa o PUT existente e mantém o registro;
//   J/K. operador SEM piso de escrita: lê e navega, mas não cria/edita/exclui;
//   L. exclusão bloqueada abre o diagnóstico de vínculos e oferece
//      "Desativar grade" em vez de forçar o DELETE;
//   M. grade sem vínculo segue o fluxo normal de exclusão.
//
// O formulário (identificação, tamanhos ordenados, prévia, orientações de
// medição) é coberto por GradeFormPage.test.tsx — aqui só se garante que a
// lista manda para a página.
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
  const grades = {
    key: 'grades',
    label: 'Grades',
    singular: 'Grade',
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
    uso: { recurso: 'produtos', campo: 'grade_id', singular: 'produto', plural: 'produtos' },
    orderBy: { field: 'nome', dir: 'asc' as const },
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, unique: true, search: true, list: true, maxLength: 60 },
      { name: 'tamanhos', label: 'Tamanhos', type: 'multiref', ref: 'tamanhos', required: true, virtual: true, list: true },
      { name: 'descricao', label: 'Descrição', type: 'text', search: true, list: true, maxLength: 160 },
      { name: 'instrucoes_medidas', label: 'Instruções de medição', type: 'textarea', list: false, maxLength: 600 },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, list: true },
      { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true, list: false },
      { name: 'atualizado_em', label: 'Atualizado em', type: 'datetime', readonly: true, list: false },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { grades }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const MODULE = {
  id: 'grades',
  label: 'Grades',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Cadastros',
  group: 'Produtos',
  subgroup: 'Grades e medidas',
  path: '/grades',
  resource: 'grades',
  description: 'Grades de tamanhos usadas no catálogo de produtos.',
} as Module;

/**
 * Linhas no formato REAL devolvido por GET /api/grades: cadastro + `tamanhos`
 * ordenados + anotações em lote (utilização e estado da tabela de medidas).
 */
const LINHAS = [
  {
    id: 3,
    nome: 'Camiseta PP-GG',
    descricao: 'Malha e camisaria básica',
    ativo: true,
    tamanhos: [1, 2, 3, 4],
    tamanhos__label: 'PP · P · M · G',
    tamanhos_total: 4,
    uso_vinculado: 18,
    uso_categorias: 2,
    uso_vinculado_label: '18 produtos · 2 categorias',
    medidas_status: 'completa',
    medidas_colunas: 3,
    medidas_celulas_total: 12,
    medidas_celulas_preenchidas: 12,
    medidas_pct: 100,
  },
  {
    id: 1,
    nome: 'Calça 36-48',
    descricao: 'Sarja e jeans',
    ativo: true,
    tamanhos: [6, 7, 8],
    tamanhos__label: '36 · 38 · 40',
    tamanhos_total: 3,
    uso_vinculado: 7,
    uso_categorias: 0,
    uso_vinculado_label: '7 produtos',
    medidas_status: 'parcial',
    medidas_colunas: 2,
    medidas_celulas_total: 6,
    medidas_celulas_preenchidas: 3,
    medidas_pct: 50,
  },
  {
    id: 2,
    nome: 'Infantil 2-10',
    descricao: '',
    ativo: true,
    tamanhos: [20, 21],
    tamanhos__label: '2 · 4',
    tamanhos_total: 2,
    uso_vinculado: 0,
    uso_categorias: 0,
    uso_vinculado_label: '',
    medidas_status: 'sem_tabela',
    medidas_colunas: 0,
    medidas_celulas_total: 0,
    medidas_celulas_preenchidas: 0,
    medidas_pct: 0,
  },
  {
    id: 4,
    nome: 'Acessórios',
    descricao: 'Cintos e bolsas',
    ativo: false,
    tamanhos: [30],
    tamanhos__label: 'Único',
    tamanhos_total: 1,
    uso_vinculado: 0,
    uso_categorias: 1,
    uso_vinculado_label: '1 categoria',
    medidas_status: 'sem_tabela',
    medidas_colunas: 0,
    medidas_celulas_total: 0,
    medidas_celulas_preenchidas: 0,
    medidas_pct: 0,
  },
];

/** Diagnóstico real devolvido pelo servidor ao bloquear o DELETE (409). */
const DIAGNOSTICO = {
  recurso: 'grades',
  recursoLabel: 'Grades',
  singular: 'Grade',
  id: 3,
  empresaId: 1,
  rotulo: 'Camiseta PP-GG',
  status: null,
  origem: 'postgresql' as const,
  bloqueado: true,
  podeExcluir: false,
  titulo: 'Não é possível excluir Grade Camiseta PP-GG',
  resumo: 'Não é possível excluir Grade Camiseta PP-GG: existem 21 registros vinculados em Categorias e Produtos.',
  orientacao:
    'Desative o registro (campo Ativo) em vez de excluí-lo: o histórico do sistema depende dele.',
  totalRegistros: 24,
  totalBloqueantes: 21,
  modulos: ['Categorias', 'Produtos', 'Grades', 'Medidas'],
  modulosBloqueantes: ['Categorias', 'Produtos'],
  vinculos: [
    {
      modulo: 'Produtos',
      icone: 'produtos',
      tabela: 'produtos',
      colunas: ['grade_id'],
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
    {
      modulo: 'Categorias',
      icone: 'categorias',
      tabela: 'categorias',
      colunas: ['grade_id'],
      recurso: 'categorias',
      quantidade: 3,
      ids: [11],
      idsTruncados: false,
      unidade: ['categoria', 'categorias'] as [string, string],
      tipo: 'operacional' as const,
      politica: 'seguir' as const,
      acao: 'NO_ACTION' as const,
      impeditivo: true,
      protegido: false,
      bloqueia: true,
      motivo: 'vínculo ativo — o banco recusa a exclusão enquanto estes registros existirem',
    },
    {
      modulo: 'Grades',
      icone: 'grades',
      tabela: 'grade_tamanhos',
      colunas: ['grade_id'],
      recurso: 'grade_tamanhos',
      quantidade: 4,
      ids: [101, 102],
      idsTruncados: false,
      unidade: ['item', 'itens'] as [string, string],
      tipo: 'composicao' as const,
      politica: 'compor' as const,
      acao: 'CASCADE' as const,
      impeditivo: false,
      protegido: false,
      bloqueia: false,
      motivo: 'faz parte do registro — os tamanhos da grade são excluídos junto com ela',
    },
  ],
  geradoEm: '2026-10-26T12:00:00.000Z',
};

/** Última URL pedida à listagem de grades. */
function ultimaLista(): string {
  const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/grades?'));
  return chamadas[chamadas.length - 1] ?? '';
}

/**
 * Monta a listagem com as rotas de destino REGISTRADAS (o roteador real do
 * ERP). Assim o teste prova a navegação — e não uma abertura de formulário.
 */
function renderPagina() {
  return render(
    <MemoryRouter initialEntries={['/grades']}>
      <ToastProvider>
        <Routes>
          <Route path="/grades" element={<ModulePage module={MODULE} />} />
          <Route path="/grades/novo" element={<div>Página nova grade</div>} />
          <Route path="/grades/:id/editar" element={<div>Página editar grade</div>} />
          <Route path="/medidas" element={<div>Módulo tabela de medidas</div>} />
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

/** Botão "Nova grade" do cabeçalho (o FAB mobile é o segundo, oculto no desktop). */
function botaoNovaGrade(): HTMLElement {
  return screen.getAllByRole('button', { name: /Nova grade/i })[0];
}

/** Linha da tabela pelo nome da grade. */
function linha(nome: string): HTMLElement {
  const cell = screen.getByText(nome);
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`linha da grade "${nome}" não encontrada`);
  return tr as HTMLElement;
}

beforeEach(() => {
  auth.user = { id: 1, name: 'Admin', perfil: 'admin' };
  vi.clearAllMocks();
  apiGet.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/grades?')) {
      return { rows: LINHAS, total: LINHAS.length, page: 1, pageSize: 25 } as never;
    }
    return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
  });
  apiPost.mockResolvedValue({ id: 21 } as never);
  apiPut.mockResolvedValue({} as never);
  apiDel.mockResolvedValue({ ok: true } as never);
});

describe('Grades — lista profissional', () => {
  it('A. abre com cabeçalho e as colunas GRADE · TAMANHOS · MEDIDAS · STATUS · UTILIZAÇÃO · AÇÕES', async () => {
    renderPagina();

    expect(await screen.findByRole('heading', { name: /Grades/ })).toBeInTheDocument();
    expect(screen.getByText('Grades de tamanhos usadas no catálogo de produtos.')).toBeInTheDocument();

    const cabecalhos = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(cabecalhos).toEqual(['#', 'Grade', 'Tamanhos', 'Medidas', 'Status', 'Utilização', 'Descrição', 'Ações']);

    const camiseta = linha('Camiseta PP-GG');
    expect(within(camiseta).getByText('PP · P · M · G')).toBeInTheDocument();
    expect(within(camiseta).getByText('Completa')).toBeInTheDocument();
    expect(within(camiseta).getByText('Ativo')).toBeInTheDocument();
    expect(within(camiseta).getByText('18 produtos · 2 categorias')).toBeInTheDocument();
    expect(within(camiseta).getByText('Malha e camisaria básica')).toBeInTheDocument();

    // Instruções de medição NÃO viram coluna (list: false) — vivem na página.
    expect(cabecalhos).not.toContain('Instruções de medição');
  });

  it('B. busca por nome/descrição chega ao servidor como `q`', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

    fireEvent.change(screen.getByLabelText('Buscar grade...'), { target: { value: 'camiseta' } });

    await waitFor(() => expect(ultimaLista()).toContain('q=camiseta'), { timeout: 2000 });
    // A busca continua sendo a MESMA listagem paginada (nenhum endpoint novo).
    expect(ultimaLista()).toContain('page=1');
  });

  it('C. filtro Todas/Ativas/Inativas usa o recorte `f.ativo` existente', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

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

  it('D. "Nova grade" NAVEGA para /grades/novo — sem modal, sem drawer, sem overlay', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

    fireEvent.click(botaoNovaGrade());

    // A página normal do ERP é montada pelo roteador…
    expect(await screen.findByText('Página nova grade')).toBeInTheDocument();
    // …e NENHUMA superfície sobreposta é aberta (nem modal, nem drawer/sheet).
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // Nada de formulário aberto sobre a lista: a lista saiu da tela.
    expect(screen.queryByText('Camiseta PP-GG')).toBeNull();
    // E nenhuma grade foi criada sem passar pela página.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('E. editar NAVEGA para /grades/:id/editar (botão e duplo clique)', async () => {
    const primeira = renderPagina();
    await screen.findByText('Acessórios');

    fireEvent.click(within(linha('Acessórios')).getByLabelText('Editar'));
    expect(await screen.findByText('Página editar grade')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    primeira.unmount();

    renderPagina();
    await screen.findByText('Calça 36-48');
    fireEvent.doubleClick(linha('Calça 36-48'));
    expect(await screen.findByText('Página editar grade')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('F. "Tabela de medidas" leva ao módulo existente, já na grade certa', async () => {
    renderPagina();
    await screen.findByText('Calça 36-48');

    fireEvent.click(within(linha('Calça 36-48')).getByLabelText('Tabela de medidas de Calça 36-48'));

    expect(await screen.findByText('Módulo tabela de medidas')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('G. mostra o estado REAL da tabela de medidas e só fala de utilização quando existe vínculo', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

    // Completa / parcial com o percentual real / sem tabela.
    expect(within(linha('Camiseta PP-GG')).getByText('Completa')).toBeInTheDocument();
    expect(within(linha('Calça 36-48')).getByText('Parcial · 50%')).toBeInTheDocument();
    expect(within(linha('Infantil 2-10')).getByText('Sem tabela')).toBeInTheDocument();

    // Sem produtos nem categorias (e sem descrição): traço, nunca "0 produtos".
    expect(within(linha('Infantil 2-10')).getAllByText('—')).toHaveLength(2);
    expect(within(linha('Infantil 2-10')).queryByText(/produto/)).toBeNull();
    // Só categorias vinculadas também é utilização real.
    expect(within(linha('Acessórios')).getByText('1 categoria')).toBeInTheDocument();
    expect(within(linha('Acessórios')).getByText('Inativo')).toBeInTheDocument();
  });

  it('H. a listagem inteira é UMA chamada — nenhuma consulta por grade (sem N+1)', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

    const chamadas = apiGet.mock.calls.map(([p]) => String(p));
    expect(chamadas.filter((p) => p.startsWith('/grades?'))).toHaveLength(1);
    // Nada de uma chamada por linha nem de merge com o resumo de medidas: o
    // estado da tabela já vem anotado no payload da listagem.
    expect(chamadas.filter((p) => /^\/grades\/\d+$/.test(p))).toHaveLength(0);
    expect(chamadas.filter((p) => p.includes('medidas-resumo'))).toHaveLength(0);
    expect(chamadas.filter((p) => p.includes('/medidas'))).toHaveLength(0);
  });

  it('I. ação Desativar usa o PUT existente e mantém o registro (nenhum DELETE)', async () => {
    renderPagina();
    await screen.findByText('Camiseta PP-GG');

    fireEvent.click(within(linha('Camiseta PP-GG')).getByLabelText('Desativar'));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/grades/3', { ativo: false }));
    expect(apiDel).not.toHaveBeenCalled();
  });

  it('J/K. operador lê e navega, mas não cria/edita/exclui (RBAC do servidor preservado)', async () => {
    auth.user = { id: 2, name: 'Operador', perfil: 'operador' };
    renderPagina();

    expect(await screen.findByText('Camiseta PP-GG')).toBeInTheDocument();
    expect(screen.getByText(/Apenas gerentes e administradores podem incluir, alterar ou excluir/i)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Nova grade/i })).toBeNull();
    expect(screen.queryByLabelText('Editar')).toBeNull();
    expect(screen.queryByLabelText('Excluir')).toBeNull();
    expect(screen.queryByLabelText('Desativar')).toBeNull();
    // O atalho de leitura continua disponível: ir para a tabela de medidas.
    expect(screen.getByLabelText('Tabela de medidas de Camiseta PP-GG')).toBeInTheDocument();
    // Nem o duplo clique abre o formulário.
    fireEvent.doubleClick(linha('Camiseta PP-GG'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Página editar grade')).toBeNull();
  });
});

describe('Grades — exclusão com diagnóstico de vínculos', () => {
  it('L. grade vinculada não é excluída: abre o diagnóstico e oferece desativar', async () => {
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
    await screen.findByText('Camiseta PP-GG');

    fireEvent.click(within(linha('Camiseta PP-GG')).getByLabelText('Excluir'));
    const confirmacao = blocoPorTitulo('Excluir grade?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    // O DELETE foi tentado e recusado pelo servidor (a FK é a proteção final).
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/grades/3'));
    await screen.findByText('Exclusão bloqueada por vínculos');
    const diagnostico = blocoPorTitulo('Exclusão bloqueada por vínculos');

    // Frase do padrão: a voz do cadastro, não o resumo técnico do servidor.
    expect(
      within(diagnostico).getByText('Não é possível excluir esta grade porque existem registros vinculados.')
    ).toBeInTheDocument();
    // ...e o diagnóstico segue dizendo ONDE, QUANTOS e POR QUÊ.
    expect(within(diagnostico).getByText('Produtos')).toBeInTheDocument();
    expect(within(diagnostico).getByText('Categorias')).toBeInTheDocument();
    expect(within(diagnostico).getByText(/18 registros/)).toBeInTheDocument();
    expect(within(diagnostico).getAllByText(/vínculo ativo/i).length).toBeGreaterThan(0);
    expect(within(diagnostico).getByText(/Nada foi apagado/i)).toBeInTheDocument();

    // A saída recomendada é DESATIVAR — nunca forçar o DELETE.
    fireEvent.click(within(diagnostico).getByRole('button', { name: 'Desativar grade' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/grades/3', { ativo: false }));
    expect(apiDel).toHaveBeenCalledTimes(1);
  });

  it('M. grade sem vínculo segue o fluxo normal de exclusão', async () => {
    renderPagina();
    await screen.findByText('Infantil 2-10');

    fireEvent.click(within(linha('Infantil 2-10')).getByLabelText('Excluir'));
    const confirmacao = blocoPorTitulo('Excluir grade?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/grades/2'));
    await waitFor(() => expect(screen.queryByText('Excluir grade?')).toBeNull());
    // A lista é recarregada depois da exclusão (mesma página, mesmo contrato).
    await waitFor(() => expect(ultimaLista()).toContain('/grades?page=1'));
  });
});

describe('Grades — estados da lista', () => {
  it('sem grades cadastradas mostra o vazio do próprio cadastro', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/grades?')) return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
      return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
    });
    renderPagina();

    expect(await screen.findByText('Nenhuma grade cadastrada')).toBeInTheDocument();
    expect(
      screen.getByText('Cadastre a primeira grade de tamanhos para organizar o estoque dos produtos.')
    ).toBeInTheDocument();
  });

  it('erro na listagem aparece na tela com a opção de tentar de novo', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/grades?')) throw new Error('Falha de rede');
      return { rows: [], total: 0, page: 1, pageSize: 25 } as never;
    });
    renderPagina();

    expect(await screen.findByText(/Falha de rede/i)).toBeInTheDocument();
  });
});
