// ============================================================================
// Shell autenticado (ERP-UX-01 · UX-01-A · ERP-UX-03).
//
// Verifica o que o usuário vê na moldura autenticada:
//   • Breadcrumb representando a Árvore Master ("BROBOND ERP › Área › Módulo › #id");
//   • "Meu Negócio" em "/", nunca "Dashboard";
//   • Command Palette (Ctrl/Cmd+K) usando a mesma fonte (`visibleModules`), com
//     contexto Área → Grupo, busca por rota/área/módulo/sinônimo sem acento e
//     identificação de módulos `planned`;
//   • CompanySwitcher remontando o conteúdo na troca de empresa sem quebrar a
//     navegação;
//   • Acessibilidade do drawer mobile e proteção de rotas públicas/RBAC.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Layout from './Layout';
import { ToastProvider } from './ui';
import App from '../App';
import { api, setToken } from '../lib/api';
import { MODULES, moduleOfPath } from '../modules';

const ADMIN = { id: 1, name: 'Petrick Silva', email: 'petrick@brobond.com.br', perfil: 'admin' };
let usuarioAtual: typeof ADMIN | { id: number; name: string; email: string; perfil: string; perm_politicas?: string } | null = ADMIN;

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuarioAtual, meta: { version: '0.6.0', mode: 'postgres' }, logout: vi.fn(), loading: false }),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn() }, setToken: vi.fn() };
});
const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

const EMPRESAS = {
  empresa_id: 1,
  empresa: 'BroBond Wear',
  consolidado: false,
  pode_consolidar: false,
  empresa_padrao: 1,
  empresas: [
    { id: 1, nome: 'BroBond Wear', cnpj: null, ativa: true },
    { id: 2, nome: 'BroBond Outlet', cnpj: '00.000.000/0001-00', ativa: false },
  ],
};

/**
 * Renderiza o shell e espera o CompanySwitcher concluir a leitura da empresa
 * ativa — garante que todo teste comece de um shell já assentado.
 */
async function renderShell(rota: string) {
  const view = render(
    <MemoryRouter initialEntries={[rota]}>
      <ToastProvider>
        <Layout />
      </ToastProvider>
    </MemoryRouter>
  );
  await screen.findByLabelText(/^Empresa ativa:/);
  return view;
}

function trilha() {
  return screen.getByRole('navigation', { name: 'Trilha de navegação' });
}

describe('Layout — shell, breadcrumb e Command Palette (ERP-UX-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    usuarioAtual = ADMIN;
    apiGet.mockReset();
    apiPost.mockReset();
    vi.mocked(setToken).mockReset();
    apiGet.mockResolvedValue(EMPRESAS);
  });

  it('em "/" a moldura diz "Meu Negócio" e não existe mais "Dashboard" no shell', async () => {
    await renderShell('/');
    const nav = trilha();
    expect(within(nav).getByText('Meu Negócio')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByText('Dashboard')).not.toBeInTheDocument();
    expect(document.title).toBe('Meu Negócio · BROBOND ERP');
    expect(document.title).not.toContain('Dashboard');
    await waitFor(() => expect(screen.getByLabelText('Menu principal')).toBeInTheDocument());
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dashboard')).not.toBeInTheDocument();
  });

  it('matriz de regressão: todas as 70 rotas de módulos e as 5 rotas de detalhe resolvem para o módulo e área corretos', () => {
    for (const m of MODULES) {
      const resolvido = moduleOfPath(m.path);
      expect(resolvido?.id, `Rota ${m.path} não resolveu para ${m.id}`).toBe(m.id);
      expect(resolvido?.area).toBe(m.area);
      expect(resolvido?.group).toBe(m.group);
    }

    const detalhes = [
      { path: '/produtos/12', id: 'produtos', area: 'Cadastros' },
      { path: '/fichas/7', id: 'fichas', area: 'Produção' },
      { path: '/ordens/45', id: 'ordens', area: 'Produção' },
      { path: '/compras/88', id: 'compras', area: 'Estoque & Suprimentos' },
      { path: '/vendas/123', id: 'vendas', area: 'Vendas' },
    ];
    for (const d of detalhes) {
      const resolvido = moduleOfPath(d.path);
      expect(resolvido?.id).toBe(d.id);
      expect(resolvido?.area).toBe(d.area);
    }
  });

  it('monta as peças do shell: Top Navigation, skip-link, busca global e seletor de empresa', async () => {
    await renderShell('/');
    expect(screen.getByTestId('top-navigation')).toBeInTheDocument();
    expect(screen.getByText('Pular para o conteúdo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Busca rápida' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Empresa ativa: BroBond Wear. Trocar empresa')).toBeInTheDocument();
  });

  it('UX-05: a Top Navigation é a navegação principal do desktop e alcança as 11 Áreas', async () => {
    const user = userEvent.setup();
    await renderShell('/vendas');

    const topnav = screen.getByTestId('top-navigation');
    // A Área do módulo ativo já vem marcada na barra superior.
    const botaoVendas = within(topnav).getByRole('button', { name: /^Vendas/ });
    expect(botaoVendas).toHaveAttribute('aria-current', 'page');

    await user.click(botaoVendas);
    expect(within(topnav).getByRole('menuitem', { name: 'Vendas' })).toHaveAttribute('aria-current', 'page');
    expect(within(topnav).getByRole('menuitem', { name: /^PDV — venda balcão$/ })).toBeInTheDocument();
  });

  it('em rota de módulo o breadcrumb é clicável e representa a Árvore Master (BROBOND ERP › Área › Módulo › #id)', async () => {
    const user = userEvent.setup();
    await renderShell('/produtos/12');

    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'BROBOND ERP' })).toHaveAttribute('href', '/');
    expect(within(nav).getByText('Cadastros')).toBeInTheDocument(); // área da Árvore Master, sem link
    expect(within(nav).getByRole('link', { name: 'Produtos' })).toHaveAttribute('href', '/produtos');
    expect(within(nav).getByText('#12')).toHaveAttribute('aria-current', 'page');

    // Clicar no nível intermediário navega de verdade (sem recarregar a página).
    await user.click(within(nav).getByRole('link', { name: 'Produtos' }));
    await waitFor(() => expect(within(trilha()).getByText('Produtos')).toHaveAttribute('aria-current', 'page'));
    expect(within(trilha()).queryByText('#12')).not.toBeInTheDocument();
  });

  it('Cores: as páginas de cadastro/edição (/cores/novo e /cores/:id/editar) têm trilha própria e o nível Cores volta para a lista', async () => {
    // Padrão LISTA → PÁGINA: a rota filha pertence ao módulo Cores e o
    // breadcrumb completo é BROBOND ERP › Cadastros › Cores › Novo/Editar.
    const casos = [
      { rota: '/cores/novo', ultimo: 'Novo' },
      { rota: '/cores/4/editar', ultimo: 'Editar' },
    ];

    for (const c of casos) {
      const user = userEvent.setup();
      const view = await renderShell(c.rota);
      const nav = trilha();
      expect(within(nav).getByRole('link', { name: 'BROBOND ERP' })).toHaveAttribute('href', '/');
      expect(within(nav).getByText('Cadastros')).toBeInTheDocument(); // área, sem link
      expect(within(nav).getByRole('link', { name: 'Cores' })).toHaveAttribute('href', '/cores');
      expect(within(nav).getByText(c.ultimo)).toHaveAttribute('aria-current', 'page');

      // Clicar em "Cores" devolve para a LISTA (sem recarregar a página).
      await user.click(within(nav).getByRole('link', { name: 'Cores' }));
      await waitFor(() =>
        expect(within(trilha()).getAllByText('Cores').at(-1)).toHaveAttribute('aria-current', 'page')
      );
      expect(within(trilha()).queryByText(c.ultimo)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('o breadcrumb reflete as novas áreas da Árvore Master (Vendas, Estoque & Suprimentos, Produção, Fiscal, Administração, Commerce, Creators, Utilidades Globais)', async () => {
    const casos = [
      { rota: '/vendas/123', area: 'Vendas', modulo: 'Vendas', id: '#123' },
      { rota: '/ordens/45', area: 'Produção', modulo: 'Cadeias de Fabricação', id: '#45' },
      { rota: '/compras/88', area: 'Estoque & Suprimentos', modulo: 'Compras', id: '#88' },
      { rota: '/fornecedores', area: 'Cadastros', modulo: 'Fornecedores' },
      { rota: '/expedicao', area: 'Vendas', modulo: 'Expedição' },
      { rota: '/documentos-fiscais', area: 'Fiscal', modulo: 'Documentos fiscais' },
      { rota: '/empresas', area: 'Administração', modulo: 'Empresas' },
      { rota: '/conectores/mercado-livre', area: 'Commerce', modulo: 'Mercado Livre' },
      { rota: '/creators', area: 'Creators', modulo: 'Creators' },
      { rota: '/config', area: 'Utilidades Globais', modulo: 'Configurações' },
    ];

    for (const c of casos) {
      const view = await renderShell(c.rota);
      const nav = trilha();
      expect(within(nav).getAllByText(c.area).length, `Área ${c.area} ausente no breadcrumb de ${c.rota}`).toBeGreaterThanOrEqual(1);
      expect(within(nav).getAllByText(c.modulo).length, `Módulo ${c.modulo} ausente no breadcrumb de ${c.rota}`).toBeGreaterThanOrEqual(1);
      if (c.id) {
        expect(within(nav).getByText(c.id)).toHaveAttribute('aria-current', 'page');
      } else {
        const candidatos = within(nav).getAllByText(c.modulo);
        expect(candidatos[candidatos.length - 1]).toHaveAttribute('aria-current', 'page');
      }
      view.unmount();
    }
  });

  it('a busca global (Ctrl/Cmd+K) usa a mesma fonte, exibe contexto Área → Grupo, busca por rota/sinônimo e respeita planned e RBAC', async () => {
    const user = userEvent.setup();
    await renderShell('/');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Busca rápida' });
    expect(dialog).toBeInTheDocument();

    const input = screen.getByRole('combobox', { name: 'Buscar módulo ou ação' });
    expect(screen.getByRole('option', { name: /Meu Negócio/ })).toBeInTheDocument();

    // Busca por módulo mostra contexto Área → Grupo e rota
    await user.clear(input);
    await user.type(input, 'propostas');
    const optPropostas = screen.getByRole('option', { name: /Propostas comerciais/ });
    expect(within(optPropostas).getByText('Vendas → Comercial')).toBeInTheDocument();
    expect(within(optPropostas).getByText('/propostas')).toBeInTheDocument();

    // Busca por rota direta (/ncm)
    await user.clear(input);
    await user.type(input, '/ncm');
    const optNcm = screen.getByRole('option', { name: /NCM \/ Tributação/ });
    expect(within(optNcm).getByText('Fiscal → Parâmetros fiscais')).toBeInTheDocument();

    // Busca sem acento por sinônimo de domínio ("ordens de producao")
    await user.clear(input);
    await user.type(input, 'ordens de producao');
    const optOrdens = screen.getByRole('option', { name: /Cadeias de Fabricação/ });
    expect(within(optOrdens).getByText('Produção → Execução')).toBeInTheDocument();

    // Busca por "Produtos" prioriza o módulo operacional (Cadastros) antes do planned (Commerce)
    await user.clear(input);
    await user.type(input, 'Produtos');
    const opcoes = screen.getAllByRole('option');
    expect(opcoes[0]).toHaveAttribute('data-path', '/produtos');
    expect(opcoes[0]).not.toHaveAttribute('data-planned');
    const plannedProdutos = opcoes.find((el) => el.getAttribute('data-path') === '/commerce/produtos');
    expect(plannedProdutos).toHaveAttribute('data-planned', 'true');
    expect(within(plannedProdutos!).getByText('Em breve')).toBeInTheDocument();
  });

  it('Command Palette respeita RBAC: operador não encontra módulos de gerente ou admin', async () => {
    const user = userEvent.setup();
    usuarioAtual = { id: 3, name: 'Operador', email: 'op@brobond.test', perfil: 'operador' };
    await renderShell('/');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Busca rápida' });

    const opcoes = screen.getAllByRole('option');
    const paths = opcoes.map((o) => o.getAttribute('data-path')).filter(Boolean);
    expect(paths).toContain('/pdv');
    expect(paths).toContain('/vendas');
    expect(paths).not.toContain('/empresas');
    expect(paths).not.toContain('/usuarios');
    expect(paths).not.toContain('/financeiro');
    expect(paths).not.toContain('/ncm');
  });

  it('trocar a empresa continua remontando o conteúdo (escopo preservado) sem quebrar a navegação', async () => {
    const user = userEvent.setup();
    let montagens = 0;
    function Conteudo() {
      useEffect(() => {
        montagens += 1;
      }, []);
      return <p>conteúdo da empresa ativa</p>;
    }

    apiPost.mockResolvedValue({ token: 'token-da-empresa-2', empresa: 'BroBond Outlet' });
    render(
      <MemoryRouter initialEntries={['/vendas']}>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route path="vendas" element={<Conteudo />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('conteúdo da empresa ativa')).toBeInTheDocument();
    expect(montagens).toBe(1);
    expect(within(trilha()).getAllByText('Vendas').length).toBeGreaterThanOrEqual(1);

    await user.click(await screen.findByLabelText('Empresa ativa: BroBond Wear. Trocar empresa'));
    await user.click(await screen.findByRole('button', { name: /BroBond Outlet/ }));

    await waitFor(() => expect(montagens).toBe(2));
    expect(vi.mocked(setToken)).toHaveBeenCalledWith('token-da-empresa-2');
    expect(within(trilha()).getAllByText('Vendas').length).toBeGreaterThanOrEqual(1);
  });

  it('mobile drawer abre pelo botão do header e fecha com Escape', async () => {
    const user = userEvent.setup();
    await renderShell('/');
    const botaoAbrir = screen.getByRole('button', { name: 'Abrir menu' });
    const aside = screen.getByLabelText('Menu principal');

    expect(aside).toHaveAttribute('data-mobile-open', 'false');
    await user.click(botaoAbrir);
    expect(aside).toHaveAttribute('data-mobile-open', 'true');

    await user.keyboard('{Escape}');
    expect(aside).toHaveAttribute('data-mobile-open', 'false');
  });

  it('rota pública não recebe o shell autenticado', async () => {
    usuarioAtual = null;
    window.history.pushState({}, '', '/login');
    render(<App />);

    expect(await screen.findByText('Acessar o sistema')).toBeInTheDocument();
    expect(screen.queryByLabelText('Menu principal')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Trilha de navegação' })).not.toBeInTheDocument();
  });

  it('UX-02.1 / UX-03: URL direta de módulo gerencial não abre para operador; PDV continua acessível', async () => {
    usuarioAtual = { id: 3, name: 'Operador UX021', email: 'operador@brobond.test', perfil: 'operador' };
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/empresas/ativa') return EMPRESAS;
      if (path === '/dashboard')
        return {
          itensAlerta: 0,
          insumosAlerta: [],
          ordens: [],
          comprasPendentes: 0,
          pecasEstoque: 0,
          vendasAbertas: 0,
          valorizacao: { produtosComSaldo: 0, semPrecoAtacado: 0, pecas: 0, custo: 0, atacado: 0, varejo: 0, colecoes: [], produtos: [] },
          totais: { produtos: 0, clientes: 0, fornecedores: 0, insumos: 0 },
          vendasPorMes: [],
          producaoPorSemana: [],
          topProdutos: [],
          recentes: [],
          valorEstoque: 0,
          producao: 0,
          vendasMes: 0,
          comissoesPagar: 0,
          alertas: [],
        };
      if (path === '/negocios/canais') return { grupos: [] };
      if (path.startsWith('/negocios/resumo'))
        return { kpis: { faturamentoCents: 0, pedidos: 0, ticketMedioCents: 0, margemPct: 0, pedidosPendentes: 0 }, porCanal: [], porMes: [], topProdutos: [] };
      if (path.startsWith('/negocios/abc')) return { linhas: [] };
      return {};
    });
    window.history.pushState({}, '', '/listas-preco');
    const bloqueada = render(
      <ToastProvider>
        <App />
      </ToastProvider>
    );
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    bloqueada.unmount();

    window.history.pushState({}, '', '/pdv');
    const pdv = render(
      <ToastProvider>
        <App />
      </ToastProvider>
    );
    await waitFor(() => expect(window.location.pathname).toBe('/pdv'));
    pdv.unmount();
  });

  it('sem sessão, "/" redireciona para o login (proteção preservada)', async () => {
    usuarioAtual = null;
    window.history.pushState({}, '', '/');
    render(<App />);

    expect(await screen.findByText('Acessar o sistema')).toBeInTheDocument();
    expect(screen.queryByLabelText('Menu principal')).not.toBeInTheDocument();
  });
});
