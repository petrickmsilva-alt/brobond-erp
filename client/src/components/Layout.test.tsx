// ============================================================================
// Shell autenticado (ERP-UX-01 · UX-01-A).
//
// Verifica o que o usuário vê de fato na moldura: breadcrumb derivado da fonte
// única de módulos ("Meu Negócio" em "/", nunca "Dashboard"), Sidebar presente,
// CompanySwitcher funcionando (com remontagem do conteúdo na troca de empresa),
// busca global e a garantia de que rota pública não ganha o shell autenticado.
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

const ADMIN = { id: 1, name: 'Petrick Silva', email: 'petrick@brobond.com.br', perfil: 'admin' };
let usuarioAtual: typeof ADMIN | { id: number; name: string; email: string; perfil: string } | null = ADMIN;

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
 * ativa — garante que todo teste comece de um shell já assentado (sem aviso de
 * atualização de estado fora de `act`).
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

describe('Layout — shell e breadcrumb', () => {
  beforeEach(() => {
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
    // O nome antigo não pode sobrar em nenhum ponto do shell.
    await waitFor(() => expect(screen.getByLabelText('Menu principal')).toBeInTheDocument());
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dashboard')).not.toBeInTheDocument();
  });

  it('monta as peças do shell: Sidebar, skip-link, busca global e seletor de empresa', async () => {
    await renderShell('/');
    expect(screen.getByLabelText('Menu principal')).toBeInTheDocument();
    expect(screen.getByText('Pular para o conteúdo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Busca rápida' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Empresa ativa: BroBond Wear. Trocar empresa')).toBeInTheDocument();
  });

  it('em rota de módulo o breadcrumb é clicável e coerente com a URL', async () => {
    const user = userEvent.setup();
    await renderShell('/produtos/12');

    const nav = trilha();
    expect(within(nav).getByRole('link', { name: 'BROBOND ERP' })).toHaveAttribute('href', '/');
    expect(within(nav).getByText('Cadastros')).toBeInTheDocument(); // área, sem link
    expect(within(nav).getByRole('link', { name: 'Produtos' })).toHaveAttribute('href', '/produtos');
    expect(within(nav).getByText('#12')).toHaveAttribute('aria-current', 'page');

    // Clicar no nível intermediário navega de verdade (sem recarregar a página).
    await user.click(within(nav).getByRole('link', { name: 'Produtos' }));
    await waitFor(() => expect(within(trilha()).getByText('Produtos')).toHaveAttribute('aria-current', 'page'));
    expect(within(trilha()).queryByText('#12')).not.toBeInTheDocument();
  });

  it('o breadcrumb cobre o grupo Fiscal (mesma verdade da Sidebar)', async () => {
    await renderShell('/documentos-fiscais');
    const nav = trilha();
    expect(within(nav).getByText('Fiscal')).toBeInTheDocument();
    expect(within(nav).getByText('Documentos fiscais')).toHaveAttribute('aria-current', 'page');
    // E a área Fiscal está na Sidebar — as duas superfícies não divergem.
    const menu = screen.getByLabelText('Menu principal');
    expect(within(menu).getByText('Fiscal')).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Documentos fiscais' })).toHaveAttribute('href', '/documentos-fiscais');
  });

  it('a busca global (Ctrl/Cmd+K) continua funcionando', async () => {
    const user = userEvent.setup();
    await renderShell('/');
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Busca rápida' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Buscar módulo ou ação' })).toBeInTheDocument();
    // O item de topo da busca também vem da fonte única (era "Dashboard").
    expect(screen.getByRole('option', { name: /Meu Negócio/ })).toBeInTheDocument();
  });

  it('trocar a empresa continua remontando o conteúdo (escopo preservado)', async () => {
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
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Conteudo />} />
            </Route>
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('conteúdo da empresa ativa')).toBeInTheDocument();
    expect(montagens).toBe(1);

    await user.click(await screen.findByLabelText('Empresa ativa: BroBond Wear. Trocar empresa'));
    await user.click(await screen.findByRole('button', { name: /BroBond Outlet/ }));

    await waitFor(() => expect(montagens).toBe(2)); // remontou: nada da empresa anterior fica na tela
    expect(vi.mocked(setToken)).toHaveBeenCalledWith('token-da-empresa-2');
  });

  it('rota pública não recebe o shell autenticado', async () => {
    usuarioAtual = null;
    window.history.pushState({}, '', '/login');
    render(<App />);

    expect(await screen.findByText('Acessar o sistema')).toBeInTheDocument();
    expect(screen.queryByLabelText('Menu principal')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Trilha de navegação' })).not.toBeInTheDocument();
  });


  it('UX-02.1: URL direta de módulo gerencial não abre para operador; PDV continua acessível', async () => {
    usuarioAtual = { id: 3, name: 'Operador UX021', email: 'operador@brobond.test', perfil: 'operador' };
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/empresas/ativa') return EMPRESAS;
      if (path === '/dashboard') return { itensAlerta: 0, insumosAlerta: [], ordens: [], comprasPendentes: 0, pecasEstoque: 0, vendasAbertas: 0, valorizacao: { produtosComSaldo: 0, semPrecoAtacado: 0, pecas: 0, custo: 0, atacado: 0, varejo: 0, colecoes: [], produtos: [] }, totais: { produtos: 0, clientes: 0, fornecedores: 0, insumos: 0 }, vendasPorMes: [], producaoPorSemana: [], topProdutos: [], recentes: [], valorEstoque: 0, producao: 0, vendasMes: 0, comissoesPagar: 0, alertas: [] };
      if (path === '/negocios/canais') return { grupos: [] };
      if (path.startsWith('/negocios/resumo')) return { kpis: { faturamentoCents: 0, pedidos: 0, ticketMedioCents: 0, margemPct: 0, pedidosPendentes: 0 }, porCanal: [], porMes: [], topProdutos: [] };
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

    // O destino permitido é provado pela permanência da URL; renderizar a
    // página inteira exigiria montar Meta/API do ModulePage, fora deste gate
    // de rota. O comportamento da tela do PDV é coberto em PdvPage.test.tsx.
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
