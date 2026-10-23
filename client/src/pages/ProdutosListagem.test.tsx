// ============================================================================
// LISTAGEM DE PRODUTOS — apresentação e usabilidade
//
// Trava o que a tela /produtos promete depois da revisão de UI:
//   A) a tabela renderiza a foto do produto (coluna prioritária, sempre visível);
//   B) produto sem foto mostra um placeholder consistente;
//   C) clicar na foto abre a galeria (Lightbox) sem sair da listagem;
//   D) abrir/aplicar filtros NÃO esconde a tabela;
//   E) filtros NÃO removem a coluna de foto;
//   + densidade (48/56/64 px), controle de colunas, chips de filtros ativos,
//     modo visual e a garantia de que nada disso dispara consulta nova.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    searchFields: ['sku', 'nome'],
    filterFields: ['categoria_id', 'formato', 'ativo', 'preco_venda'],
    fields: [
      { name: 'sku', label: 'SKU / Referência', type: 'text', required: true, list: true, search: true },
      { name: 'nome', label: 'Nome', type: 'text', required: true, list: true, search: true },
      { name: 'categoria_id', label: 'Categoria', type: 'ref', ref: 'categorias', list: true },
      { name: 'colecao_id', label: 'Coleção', type: 'ref', ref: 'colecoes', list: true },
      { name: 'cor_id', label: 'Cor (cadastro)', type: 'ref', ref: 'cores', list: true },
      { name: 'grade_id', label: 'Grade de tamanhos', type: 'ref', ref: 'grades', list: true },
      { name: 'preco_venda', label: 'Preço de venda (varejo)', type: 'money', list: true, default: 0 },
      { name: 'custo', label: 'Custo unitário', type: 'money', list: true, default: 0 },
      {
        name: 'formato',
        label: 'Formato',
        type: 'select',
        default: 'simples',
        list: true,
        options: [
          { value: 'simples', label: 'Simples' },
          { value: 'variacao', label: 'Com variação' },
        ],
      },
      { name: 'ativo', label: 'Ativo', type: 'boolean', default: true, list: true },
    ],
  };
  return {
    ...actual,
    useMeta: () => ({ resources: { produtos }, modules: [], mode: 'memory' }),
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
  description: 'Catálogo de peças acabadas: fotos, SKU, categoria, cor, coleção, custo e preço.',
} as Module;

const FOTOS_CAMISETA = [
  { id: 11, nome: 'frente.jpg', mime: 'image/jpeg', tamanho_bytes: 1024, url: '/api/files/11/frente.jpg', thumb_url: '/api/files/11/frente.jpg?thumb=1', principal: true, ordem: 1, criado_em: '2026-01-01' },
  { id: 12, nome: 'costas.jpg', mime: 'image/jpeg', tamanho_bytes: 1024, url: '/api/files/12/costas.jpg', thumb_url: '/api/files/12/costas.jpg?thumb=1', principal: false, ordem: 2, criado_em: '2026-01-01' },
];

const LINHAS = [
  {
    id: 1,
    sku: 'CAM-001',
    nome: 'Camiseta Pima',
    categoria_id: 1,
    categoria_id__label: 'Camisetas',
    colecao_id: 2,
    colecao_id__label: 'Verão 2026',
    cor_id: 3,
    cor_id__label: 'Preto',
    cor_id__color: '#111111',
    grade_id: 4,
    grade_id__label: 'Camiseta PP–GG',
    preco_venda: 129.9,
    custo: 40,
    formato: 'simples',
    ativo: true,
    foto_url: '/api/files/11/frente.jpg?thumb=1',
    fotos: FOTOS_CAMISETA,
  },
  {
    id: 2,
    sku: 'CAL-010',
    nome: 'Calça Alfaiataria',
    categoria_id: 1,
    categoria_id__label: 'Calças',
    colecao_id: 2,
    colecao_id__label: 'Verão 2026',
    cor_id: 4,
    cor_id__label: 'Marinho',
    grade_id: 5,
    grade_id__label: 'Calça 36–48',
    preco_venda: 259.9,
    custo: 90,
    formato: 'variacao',
    ativo: false,
    foto_url: null,
    fotos: [],
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/produtos']}>
      <ToastProvider>
        <ModulePage module={MODULE} />
      </ToastProvider>
    </MemoryRouter>
  );
}

/** URLs de listagem pedidas ao servidor (a paginação continua sendo dele). */
function chamadasDeLista(): string[] {
  return apiGet.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/produtos?'));
}

beforeEach(() => {
  apiGet.mockReset();
  localStorage.clear();
  apiGet.mockImplementation(((path: string) => {
    const url = String(path);
    if (url.endsWith('/options')) return Promise.resolve([{ value: 1, label: 'Camisetas' }]);
    if (url.startsWith('/produtos?')) return Promise.resolve({ rows: LINHAS, total: LINHAS.length, page: 1, pageSize: 25 });
    return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
  }) as never);
});

describe('A/B — foto do produto na tabela', () => {
  it('renderiza a miniatura clicável com aria-label e a coluna Foto em primeiro lugar', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    const foto = screen.getByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' });
    // Normal (padrão) = 56 px, sem distorcer a imagem (object-cover no CSS).
    expect(foto).toHaveStyle({ width: '56px', height: '56px' });
    expect(within(foto).getByRole('img')).toHaveAttribute('src', '/api/files/11/frente.jpg?thumb=1');

    const cabecalhos = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(cabecalhos[0]).toBe('Foto');
    expect(cabecalhos).toContain('Produto');
    expect(cabecalhos).toContain('SKU');
    expect(cabecalhos).toContain('Estoque');
    expect(cabecalhos).toContain('Status');
    expect(cabecalhos[cabecalhos.length - 1]).toBe('Ações');
  });

  it('produto sem foto mostra placeholder consistente (não um buraco na linha)', async () => {
    renderPage();
    await screen.findByText('Calça Alfaiataria');
    expect(screen.getByRole('img', { name: 'Sem foto de CAL-010 — Calça Alfaiataria' })).toBeInTheDocument();
  });

  it('mostra o contador de fotos extras na miniatura', async () => {
    renderPage();
    const foto = await screen.findByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' });
    expect(within(foto.parentElement as HTMLElement).getByText('+1')).toBeInTheDocument();
  });
});

describe('C — clique na foto abre a galeria existente', () => {
  it('abre o Lightbox com todas as fotos, sem sair da listagem', async () => {
    renderPage();
    const foto = await screen.findByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' });
    fireEvent.click(foto);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // A imagem ampliada usa a URL cheia (não a miniatura).
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', '/api/files/11/frente.jpg');
    expect(within(dialog).getByRole('button', { name: 'Próxima' })).toBeInTheDocument();
    // Continua na listagem (a tabela segue montada atrás do lightbox).
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('D/E — filtros em área própria, sem esconder a tabela nem a foto', () => {
  it('abrir os filtros empurra a listagem (painel em linha) e a tabela segue visível', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    const painel = await screen.findByRole('region', { name: 'Filtros da listagem' });
    // O painel vem ANTES da tabela no documento — nunca sobrepõe.
    const tabela = screen.getByRole('table');
    expect(painel.compareDocumentPosition(tabela) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Foto' })).toBeInTheDocument();
  });

  it('aplicar um filtro mantém a tabela, a coluna Foto e os dados na tela', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    fireEvent.change(await screen.findByLabelText('Categoria'), { target: { value: '1' } });

    await waitFor(() => expect(chamadasDeLista().at(-1)).toContain('f.categoria_id=1'));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Foto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' })).toBeInTheDocument();

    // Chip do filtro ativo + contador no botão de filtros.
    expect(await screen.findByText(/Filtros ativos \(1\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover filtro Categoria: Camisetas' })).toBeInTheDocument();
  });

  it('"Limpar filtros" volta à listagem normal e remove os chips', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    fireEvent.change(await screen.findByLabelText('Categoria'), { target: { value: '1' } });
    await waitFor(() => expect(chamadasDeLista().at(-1)).toContain('f.categoria_id=1'));

    fireEvent.click(screen.getByRole('button', { name: /Limpar filtros/ }));
    await waitFor(() => expect(chamadasDeLista().at(-1)).not.toContain('f.categoria_id'));
    expect(screen.queryByText(/Filtros ativos/)).toBeNull();
    // A foto continua na primeira coluna depois de limpar.
    expect(screen.getByRole('columnheader', { name: 'Foto' })).toBeInTheDocument();
  });

  it('chips removem apenas o filtro escolhido', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    fireEvent.click(screen.getByRole('button', { name: /Filtros/ }));
    fireEvent.change(await screen.findByLabelText('Categoria'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'variacao' } });
    await waitFor(() => expect(chamadasDeLista().at(-1)).toContain('f.formato=variacao'));

    fireEvent.click(await screen.findByRole('button', { name: 'Remover filtro Categoria: Camisetas' }));
    await waitFor(() => expect(chamadasDeLista().at(-1)).not.toContain('f.categoria_id'));
    expect(chamadasDeLista().at(-1)).toContain('f.formato=variacao');
    expect(screen.getByRole('button', { name: 'Remover filtro Formato: Com variação' })).toBeInTheDocument();
  });
});

describe('controle de colunas e densidade', () => {
  it('esconder uma coluna reorganiza a tabela e NUNCA remove a Foto', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');

    fireEvent.click(screen.getByRole('button', { name: 'Colunas visíveis' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Colunas visíveis' })).getByLabelText('Categoria'));

    expect(screen.queryByRole('columnheader', { name: 'Categoria' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Foto' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Produto' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'SKU' })).toBeInTheDocument();
  });

  it('a Foto aparece travada no menu de colunas', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');
    fireEvent.click(screen.getByRole('button', { name: 'Colunas visíveis' }));
    const menu = screen.getByRole('group', { name: 'Colunas visíveis' });
    const foto = within(menu).getByLabelText(/^Foto/);
    expect(foto).toBeChecked();
    expect(foto).toBeDisabled();
  });

  it('densidade Compacta/Normal/Confortável muda a miniatura (48/56/64 px) sem escondê-la', async () => {
    renderPage();
    const foto = await screen.findByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' });
    expect(foto).toHaveStyle({ width: '56px' });

    fireEvent.click(screen.getByRole('button', { name: 'Densidade da tabela: Normal' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Densidade da tabela' })).getByRole('menuitemradio', { name: /Compacta/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' })).toHaveStyle({ width: '48px' })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Densidade da tabela: Compacta' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Densidade da tabela' })).getByRole('menuitemradio', { name: /Confortável/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ampliar foto de CAM-001 — Camiseta Pima' })).toHaveStyle({ width: '64px' })
    );
  });
});

describe('modo visual (cartões)', () => {
  it('consome os mesmos dados e não dispara consulta nova', async () => {
    renderPage();
    await screen.findByText('Camiseta Pima');
    const antes = chamadasDeLista().length;

    fireEvent.click(screen.getByRole('button', { name: /Visual/ }));

    const cards = await screen.findByTestId('lista-cards');
    expect(within(cards).getByRole('heading', { name: 'Camiseta Pima' })).toBeInTheDocument();
    expect(within(cards).getByText('CAM-001')).toBeInTheDocument();
    // A foto do cartão abre a mesma galeria.
    expect(within(cards).getByRole('button', { name: 'Ampliar foto de Camiseta Pima' })).toBeInTheDocument();
    expect(chamadasDeLista().length).toBe(antes);

    fireEvent.click(screen.getByRole('button', { name: /Tabela/ }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('a paginação server-side continua disponível no modo visual', async () => {
    apiGet.mockImplementation(((path: string) => {
      const url = String(path);
      if (url.endsWith('/options')) return Promise.resolve([{ value: 1, label: 'Camisetas' }]);
      if (url.startsWith('/produtos?')) {
        const p = new URL(`http://x${url}`).searchParams.get('page') ?? '1';
        return Promise.resolve({ rows: LINHAS, total: 50, page: Number(p), pageSize: 25 });
      }
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    }) as never);

    renderPage();
    await screen.findByText('Camiseta Pima');
    fireEvent.click(screen.getByRole('button', { name: /Visual/ }));
    await screen.findByTestId('lista-cards');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(chamadasDeLista().at(-1)).toContain('page=2'));
    expect(screen.getByTestId('lista-cards')).toBeInTheDocument();
  });
});
