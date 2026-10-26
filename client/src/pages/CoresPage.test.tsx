// ============================================================================
// CADASTROS › CORES — padrão profissional (lista + drawer).
//
// Trava o contrato da tela:
//   A. lista abre com cabeçalho, amostra, nome, HEX, status e utilização;
//   B. busca vai para o servidor (`q=`) e sobrevive ao debounce;
//   C. filtro Ativas/Inativas usa o contrato existente (`f.ativo`), sem SQL novo;
//   D. "Nova cor" abre DRAWER lateral (não o modal central);
//   E. criar envia o payload canônico (HEX em #RRGGBB, status preservado);
//   F. a amostra acompanha o HEX em tempo real;
//   G. HEX inválido mostra erro e NÃO chega à API;
//   H. editar abre o mesmo drawer com os dados preenchidos e salva por PUT;
//   I. o status do registro é preservado na edição e há ação de desativar;
//   J/K. operador SEM piso de escrita: lê, mas não cria/edita/exclui;
//   L. exclusão bloqueada usa o diagnóstico de vínculos (PR #83) e oferece
//      "Desativar cor" em vez de forçar o DELETE;
//   M. cor sem vínculo segue o fluxo normal de exclusão.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    editor: 'drawer',
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

function renderPagina() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ModulePage module={MODULE} />
      </ToastProvider>
    </MemoryRouter>
  );
}

/**
 * Modal do ERP com título: o `Modal` genérico não liga o título ao `role=dialog`
 * por aria-labelledby (comportamento histórico), então localizamos pelo texto e
 * subimos até o diálogo.
 */
function dialogPorTitulo(titulo: string): HTMLElement {
  const el = screen.getByText(titulo);
  const dlg = el.closest('[role="dialog"]');
  if (!dlg) throw new Error(`diálogo "${titulo}" não encontrado`);
  return dlg as HTMLElement;
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
  });
});

describe('Cores — drawer de cadastro e edição', () => {
  it('D. "Nova cor" abre o DRAWER (não o modal central) com os campos do metadado', async () => {
    renderPagina();
    fireEvent.click(botaoNovaCor());
    // (o segundo "Nova cor" é o atalho flutuante do celular — mesmo destino)

    const drawer = screen.getByRole('dialog', { name: 'Nova cor' });
    expect(within(drawer).getByText('Cadastre uma cor para utilização no catálogo de produtos.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText(/^Nome/)).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Código HEX')).toBeInTheDocument();
    expect(within(drawer).getByRole('checkbox', { name: 'Ativo' })).toBeChecked();
    expect(within(drawer).getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Salvar cor' })).toBeInTheDocument();
    // O formulário não duplica a barra de ações dentro do corpo.
    expect(within(drawer).queryByRole('button', { name: /Incluir/ })).toBeNull();
    // A lista continua no documento, atrás do painel (contexto preservado).
    expect(await screen.findByText('Preto')).toBeInTheDocument();
  });

  it('E. cria cor válida enviando HEX canônico', async () => {
    renderPagina();
    fireEvent.click(botaoNovaCor());
    // (o segundo "Nova cor" é o atalho flutuante do celular — mesmo destino)
    const drawer = screen.getByRole('dialog', { name: 'Nova cor' });

    fireEvent.change(within(drawer).getByLabelText(/^Nome/), { target: { value: '  Azul marinho  ' } });
    fireEvent.change(within(drawer).getByLabelText('Código HEX'), { target: { value: '172038' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Salvar cor' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/cores', { nome: 'Azul marinho', hex: '#172038', ativo: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nova cor' })).toBeNull());
  });

  it('E2. nome duplicado mantém o drawer aberto com a mensagem amigável', async () => {
    const { ApiError } = await import('../lib/api');
    apiPost.mockRejectedValueOnce(
      new (ApiError as unknown as new (s: number, m: string, f?: Record<string, string>) => Error)(
        409,
        'Já existe um registro com este nome.',
        { nome: 'Já cadastrado' }
      )
    );
    renderPagina();
    fireEvent.click(botaoNovaCor());
    const drawer = screen.getByRole('dialog', { name: 'Nova cor' });

    fireEvent.change(within(drawer).getByLabelText(/^Nome/), { target: { value: 'azul marinho' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Salvar cor' }));

    // Regra de unicidade existente: a API recusa e a tela explica no campo.
    await waitFor(() => expect(within(drawer).getByText('Já existe um registro com este nome.')).toBeInTheDocument());
    expect(within(drawer).getByText('Já cadastrado')).toBeInTheDocument();
    // O drawer continua aberto para corrigir o nome.
    expect(screen.getByRole('dialog', { name: 'Nova cor' })).toBeInTheDocument();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('F. a amostra acompanha o HEX em tempo real', async () => {
    renderPagina();
    fireEvent.click(botaoNovaCor());
    // (o segundo "Nova cor" é o atalho flutuante do celular — mesmo destino)
    const drawer = screen.getByRole('dialog', { name: 'Nova cor' });
    const hex = within(drawer).getByLabelText('Código HEX');

    fireEvent.change(within(drawer).getByLabelText(/^Nome/), { target: { value: 'Azul marinho' } });
    fireEvent.change(hex, { target: { value: '#172038' } });
    expect(within(drawer).getByRole('img', { name: /Amostra da cor Azul marinho: #172038/i })).toHaveStyle({ backgroundColor: '#172038' });

    fireEvent.change(hex, { target: { value: '#F5F5F0' } });
    expect(within(drawer).getByRole('img', { name: /Amostra da cor Azul marinho: #F5F5F0/i })).toHaveStyle({ backgroundColor: '#F5F5F0' });

    // Forma curta é expandida ao sair do campo (mesma regra do servidor).
    fireEvent.change(hex, { target: { value: '#abc' } });
    fireEvent.blur(hex);
    expect(hex).toHaveValue('#AABBCC');
  });

  it('G. HEX inválido mostra erro claro e não é enviado à API', async () => {
    renderPagina();
    fireEvent.click(botaoNovaCor());
    // (o segundo "Nova cor" é o atalho flutuante do celular — mesmo destino)
    const drawer = screen.getByRole('dialog', { name: 'Nova cor' });

    fireEvent.change(within(drawer).getByLabelText(/^Nome/), { target: { value: 'Azul' } });
    fireEvent.change(within(drawer).getByLabelText('Código HEX'), { target: { value: '#12' } });

    // Erro em tempo real na prévia.
    expect(within(drawer).getByText('Informe o HEX no formato #RRGGBB (ex.: #172038).')).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole('button', { name: 'Salvar cor' }));

    await waitFor(() => expect(within(drawer).getAllByText(/formato #RRGGBB/i).length).toBeGreaterThan(1));
    expect(apiPost).not.toHaveBeenCalled();
    // O drawer permanece aberto para corrigir o campo.
    expect(screen.getByRole('dialog', { name: 'Nova cor' })).toBeInTheDocument();
  });

  it('H/I. edita a cor preservando o status atual', async () => {
    renderPagina();
    await screen.findByText('Cinza mescla');
    fireEvent.click(within(linha('Cinza mescla')).getByLabelText('Editar'));

    const drawer = screen.getByRole('dialog', { name: 'Editar cor' });
    const nome = within(drawer).getByLabelText(/^Nome/);
    expect(nome).toHaveValue('Cinza mescla');
    expect(within(drawer).getByRole('checkbox', { name: 'Ativo' })).not.toBeChecked();

    fireEvent.change(nome, { target: { value: 'Cinza mescla escuro' } });
    fireEvent.change(within(drawer).getByLabelText('Código HEX'), { target: { value: '#6b7280' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Salvar cor' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/cores/4', { nome: 'Cinza mescla escuro', hex: '#6B7280', ativo: false }));
  });

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
    const confirmacao = dialogPorTitulo('Excluir cor?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    // O DELETE foi tentado e recusado pelo servidor (FK é a proteção final).
    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/cores/3'));
    await screen.findByText('Exclusão bloqueada por vínculos');
    const diagnostico = dialogPorTitulo('Exclusão bloqueada por vínculos');
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
    const confirmacao = dialogPorTitulo('Excluir cor?');
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(apiDel).toHaveBeenCalledWith('/cores/1'));
    await waitFor(() => expect(screen.queryByText('Excluir cor?')).toBeNull());
    // A lista é recarregada depois da exclusão (mesma página, mesmo contrato).
    await waitFor(() => expect(ultimaLista()).toContain('/cores?page=1'));
  });
});
