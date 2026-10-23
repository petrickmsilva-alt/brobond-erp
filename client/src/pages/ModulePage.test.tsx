// ============================================================================
// LISTAGEM PAGINADA (ModulePage) — paginação, busca, filtro e ordenação
// SERVER-SIDE, com o recorte preservado ao trocar de página.
//
// Trava o contrato que a tela de Produtos passou a usar:
//   • o front pede `page`/`pageSize` e recebe SÓ a página — nunca o catálogo;
//   • 25/50/100 por página, primeira/anterior/próxima/última;
//   • contador "de N registros" usa o TOTAL do servidor, não as linhas da página;
//   • busca e filtro viram parâmetros da requisição e sobrevivem à paginação;
//   • ordenação por coluna vira `sort`/`dir` e é preservada ao paginar.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ModulePage from './ModulePage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';
import type { Module } from '../modules';

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    fields?: Record<string, string>;
    constructor(status: number, message: string, fields?: Record<string, string>) {
      super(message);
      this.status = status;
      this.fields = fields;
      this.name = 'ApiError';
    }
  },
  downloadFile: vi.fn(),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Admin', perfil: 'admin' } }),
}));

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  const produtos = {
    key: 'produtos',
    table: 'produtos',
    label: 'Produtos',
    singular: 'Produto',
    labelFields: ['sku', 'nome'],
    ops: { create: true, update: true, delete: true },
    images: { max: 5 },
    detail: true,
    searchFields: ['sku', 'nome', 'codigo_barras'],
    filterFields: ['categoria_id', 'formato', 'ativo', 'preco_venda'],
    fields: [
      { name: 'sku', label: 'SKU / Referência', type: 'text', required: true, list: true, search: true },
      { name: 'nome', label: 'Nome', type: 'text', required: true, list: true, search: true },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias', list: true },
      { name: 'formato', label: 'Formato', type: 'select', default: 'simples', list: true, options: [{ value: 'simples', label: 'Simples' }, { value: 'variacao', label: 'Com variação' }] },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, list: true },
      { name: 'preco_venda', label: 'Preço de venda (varejo)', type: 'money', list: true, default: 0 },
    ],
  };
  const categorias = {
    key: 'categorias',
    table: 'categorias',
    label: 'Categorias',
    singular: 'Categoria',
    labelFields: ['nome'],
    ops: { create: true, update: true, delete: true },
    minPerfilEscrita: 'gerente',
    filterFields: ['grade_id', 'ativo'],
    fields: [
      { name: 'nome', label: 'Nome', type: 'text', required: true, list: true, search: true },
      { name: 'descricao', label: 'Descrição', type: 'text', list: true, search: true },
      { name: 'grade_id', label: 'Grade padrão', type: 'ref', ref: 'grades', list: true },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, list: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { produtos, categorias }, modules: [], mode: 'memory' }),
  };
});

const apiGet = vi.mocked(api.get);

const MODULE = {
  id: 'produtos',
  label: 'Produtos',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Cadastros',
  group: 'Produtos',
  subgroup: 'Cadastro principal',
  path: '/produtos',
  resource: 'produtos',
  description: 'Catálogo de peças acabadas.',
} as Module;

/** Resposta do servidor para uma página: `total` é do conjunto, não da página. */
function pagina(numeros: number[], total: number, page: number, pageSize: number) {
  return {
    rows: numeros.map((n) => ({
      id: n,
      sku: `ESC-${String(n).padStart(3, '0')}`,
      nome: `Produto Escala ${String(n).padStart(3, '0')}`,
      categoria_id: 1,
      formato: 'simples',
      ativo: true,
      preco_venda: n * 10,
    })),
    total,
    page,
    pageSize,
  };
}

/** Última URL pedida ao endpoint de produtos. */
function ultimaLista(): string {
  const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/produtos?'));
  return chamadas[chamadas.length - 1] ?? '';
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/produtos']}>
      <ToastProvider>
        <ModulePage module={MODULE} />
      </ToastProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  apiGet.mockReset();
  localStorage.clear();
  apiGet.mockImplementation(((path: string) => {
    if (String(path).endsWith('/options')) return Promise.resolve([{ value: 1, label: 'Camisetas' }]);
    if (String(path).startsWith('/produtos?')) {
      const url = new URL(`http://x${path}`);
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 25);
      const inicio = (page - 1) * pageSize + 1;
      const qtd = Math.max(0, Math.min(pageSize, 1248 - (inicio - 1)));
      const numeros = Array.from({ length: qtd }, (_, i) => inicio + i);
      return Promise.resolve(pagina(numeros, 1248, page, pageSize));
    }
    return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
  }) as never);
});

describe('paginação server-side', () => {
  it('pede a página ao servidor e mostra o contador do TOTAL, não das linhas', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    expect(ultimaLista()).toContain('page=1');
    expect(ultimaLista()).toContain('pageSize=25');
  });

  it('primeira/anterior desabilitados na página 1; próxima/última habilitados', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    expect(screen.getByRole('button', { name: 'Primeira página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Última página' })).toBeEnabled();
  });

  it('Próxima busca a página seguinte no servidor', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await screen.findByText(/26–50 de 1248 registros/);
    await waitFor(() => expect(ultimaLista()).toContain('page=2'));
  });

  it('Última página salta para o fim do conjunto', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    fireEvent.click(screen.getByRole('button', { name: 'Última página' }));
    await screen.findByText(/1226–1248 de 1248 registros/);
    await waitFor(() => expect(ultimaLista()).toContain('page=50'));
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Última página' })).toBeDisabled();
  });

  it('trocar para 50 por página volta à página 1 e pede 50 ao servidor', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await screen.findByText(/26–50 de 1248 registros/);

    const seletor = screen.getByLabelText('Por página');
    fireEvent.change(seletor, { target: { value: '50' } });
    await screen.findByText(/1–50 de 1248 registros/);
    expect(ultimaLista()).toContain('page=1');
    expect(ultimaLista()).toContain('pageSize=50');
  });

  it('100 por página é aceito e a última página traz só o resto', async () => {
    renderPage();
    await screen.findByText(/1–25 de 1248 registros/);
    fireEvent.change(screen.getByLabelText('Por página'), { target: { value: '100' } });
    await screen.findByText(/1–100 de 1248 registros/);
    fireEvent.click(screen.getByRole('button', { name: 'Última página' }));
    await screen.findByText(/1201–1248 de 1248 registros/);
  });
});

describe('busca e filtro são do servidor e sobrevivem à paginação', () => {
  it('a busca vira parâmetro `q` da requisição (não filtra a página no front)', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    fireEvent.change(screen.getByPlaceholderText(/Buscar em produtos/i), { target: { value: 'ESC-042' } });
    await waitFor(() => expect(ultimaLista()).toContain('q=ESC-042'));
    expect(ultimaLista()).toContain('page=1');
  });

  it('busca + paginação: o termo continua na requisição da página seguinte', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    fireEvent.change(screen.getByPlaceholderText(/Buscar em produtos/i), { target: { value: 'Escala' } });
    await waitFor(() => expect(ultimaLista()).toContain('q=Escala'));
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(ultimaLista()).toContain('page=2'));
    expect(ultimaLista()).toContain('q=Escala');
  });

  it('filtro de faixa de preço vira `f.preco_venda_min/_max` e é preservado ao paginar', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));

    fireEvent.change(await screen.findByLabelText(/Preço de venda \(varejo\) mínimo/), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText(/Preço de venda \(varejo\) máximo/), { target: { value: '600' } });
    await waitFor(() => expect(ultimaLista()).toContain('f.preco_venda_min=200'));
    expect(ultimaLista()).toContain('f.preco_venda_max=600');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(ultimaLista()).toContain('page=2'));
    expect(ultimaLista()).toContain('f.preco_venda_min=200');
    expect(ultimaLista()).toContain('f.preco_venda_max=600');
  });

  it('o botão Filtros só aparece para recurso com filtros declarados', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    expect(screen.getByRole('button', { name: /Filtros/ })).toBeInTheDocument();
  });
});

describe('cadastro em página própria (sem modal)', () => {
  it('"Novo produto" leva para /produtos/novo em vez de abrir modal', async () => {
    render(
      <MemoryRouter initialEntries={['/produtos']}>
        <ToastProvider>
          <Routes>
            <Route path="/produtos" element={<ModulePage module={MODULE} />} />
            <Route path="/produtos/novo" element={<div>Página de cadastro</div>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    await screen.findByText(/de 1248 registros/);
    fireEvent.click(screen.getAllByRole("button", { name: /Novo produto/i })[0]);
    expect(await screen.findByText('Página de cadastro')).toBeInTheDocument();
    // O modal genérico de cadastro não é montado.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ordenação server-side', () => {
  it('clicar no cabeçalho envia `sort`/`dir` ao servidor', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    const cabecalho = screen.getByRole('columnheader', { name: /SKU/ });
    fireEvent.click(within(cabecalho).getByRole('button'));
    await waitFor(() => expect(ultimaLista()).toContain('sort=sku'));
    expect(ultimaLista()).toContain('dir=asc');

    fireEvent.click(within(cabecalho).getByRole('button'));
    await waitFor(() => expect(ultimaLista()).toContain('dir=desc'));
  });

  it('a ordenação é preservada ao trocar de página', async () => {
    renderPage();
    await screen.findByText(/de 1248 registros/);
    fireEvent.click(within(screen.getByRole('columnheader', { name: /SKU/ })).getByRole('button'));
    await waitFor(() => expect(ultimaLista()).toContain('sort=sku'));
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(ultimaLista()).toContain('page=2'));
    expect(ultimaLista()).toContain('sort=sku');
    expect(ultimaLista()).toContain('dir=asc');
  });
});

// ============================================================================
// LISTAGEM DE CATEGORIAS — o cadastro saiu do modal e a lista ficou navegável.
//
// Trava o que a página /categorias precisa entregar:
//   • busca própria ("Buscar categoria...") por nome/descrição, no servidor;
//   • botão "Nova categoria" navega para /categorias/novo (sem modal);
//   • editar navega para /categorias/:id/editar (sem modal);
//   • Ativar/Desativar é um PUT no contrato existente, sem abrir formulário;
//   • estado vazio profissional com a chamada para o primeiro cadastro;
//   • colunas Categoria / Descrição / Grade padrão / Status, com a grade
//     visível (nada de esconder informação relevante).
// ============================================================================
const MODULE_CATEGORIAS = {
  id: 'categorias',
  label: 'Categorias',
  icon: (() => null) as unknown as Module['icon'],
  space: 'erp',
  area: 'Cadastros',
  group: 'Produtos',
  subgroup: 'Classificações',
  path: '/categorias',
  resource: 'categorias',
  description: 'Tipos de peça.',
} as Module;

const CATEGORIAS = {
  rows: [
    { id: 1, nome: 'Camisa', descricao: 'Camisas sociais', grade_id: 1, ativo: true },
    { id: 2, nome: 'Calça', descricao: 'Jeans e sarja', grade_id: 2, ativo: false },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

function renderCategorias(resposta: unknown = CATEGORIAS) {
  apiGet.mockImplementation(((path: string) => {
    if (String(path).endsWith('/options')) return Promise.resolve([{ value: 1, label: 'Camisaria' }]);
    if (String(path).startsWith('/categorias?')) return Promise.resolve(resposta);
    return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
  }) as never);
  return render(
    <MemoryRouter initialEntries={['/categorias']}>
      <ToastProvider>
        <Routes>
          <Route path="/categorias" element={<ModulePage module={MODULE_CATEGORIAS} />} />
          <Route path="/categorias/novo" element={<div>Página nova categoria</div>} />
          <Route path="/categorias/:id/editar" element={<div>Página editar categoria</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

function ultimaListaCategorias(): string {
  const chamadas = apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/categorias?'));
  return chamadas[chamadas.length - 1] ?? '';
}

describe('categorias — listagem profissionalizada', () => {
  it('mostra as colunas Categoria, Descrição, Grade padrão e Status sem esconder informação', async () => {
    renderCategorias();
    await screen.findByText('Camisa');
    expect(screen.getByRole('columnheader', { name: /Categoria/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Descrição/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Grade padrão/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByText('Camisas sociais')).toBeInTheDocument();
  });

  it('a busca tem placeholder próprio e vai ao servidor (nome e descrição)', async () => {
    renderCategorias();
    const busca = await screen.findByPlaceholderText('Buscar categoria...');
    fireEvent.change(busca, { target: { value: 'jeans' } });
    await waitFor(() => expect(ultimaListaCategorias()).toContain('q=jeans'));
    expect(ultimaListaCategorias()).toContain('page=1');
  });

  it('declara os filtros de grade padrão e status (server-side)', async () => {
    renderCategorias();
    await screen.findByText('Camisa');
    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    expect(await screen.findByLabelText(/Grade padrão/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Ativo/)).toBeInTheDocument();
  });

  it('"Nova categoria" navega para /categorias/novo em vez de abrir modal', async () => {
    renderCategorias();
    await screen.findByText('Camisa');
    fireEvent.click(screen.getAllByRole('button', { name: /Nova categoria/i })[0]);
    expect(await screen.findByText('Página nova categoria')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Editar navega para /categorias/:id/editar (sem modal)', async () => {
    renderCategorias();
    await screen.findByText('Camisa');
    fireEvent.click(screen.getAllByTitle('Editar')[0]);
    expect(await screen.findByText('Página editar categoria')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Ativar/Desativar usa o PUT do contrato existente, sem abrir o formulário', async () => {
    const apiPut = vi.mocked(api.put);
    apiPut.mockResolvedValue({ id: 2, ativo: true } as never);
    renderCategorias();
    await screen.findByText('Calça');

    // A linha inativa oferece "Ativar"; a ativa, "Desativar".
    const ativar = screen.getAllByRole('button', { name: 'Ativar' })[0];
    fireEvent.click(ativar);
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/categorias/2', { ativo: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('estado vazio traz a mensagem profissional e o botão de primeiro cadastro', async () => {
    renderCategorias({ rows: [], total: 0, page: 1, pageSize: 25 });
    expect(await screen.findByText('Nenhuma categoria cadastrada')).toBeInTheDocument();
    expect(screen.getByText('Cadastre sua primeira categoria para organizar seus produtos.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Nova categoria/i }).length).toBeGreaterThan(0);
  });

  it('o contador mostra o total do servidor com o substantivo do cadastro', async () => {
    renderCategorias();
    await screen.findByText('Camisa');
    expect(screen.getByText('1–2 de 2 categorias')).toBeInTheDocument();
  });
});
