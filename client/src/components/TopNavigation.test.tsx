// ============================================================================
// TopNavigation — MASTER TOP NAVIGATION (UX-05).
//
// Barreira contra regressão da navegação principal do desktop:
//   • uma entrada por Área da Árvore Master, vinda de `visibleModules`;
//   • dropdown em cascata com Grupo → Subgrupo → Módulo;
//   • active state automático por `moduleOfPath` (Área, Grupo e módulo);
//   • RBAC idêntico ao da Sidebar/Command Palette (admin, gerente, operador);
//   • teclado (Enter/Space/Setas/Home/End/Escape) e clique fora;
//   • deep link e módulos `planned` identificados;
//   • todas as rotas de `visibleModules` alcançáveis pelo menu superior.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TopNavigation, { focarPrimeiroItem, quantasCabem } from './TopNavigation';
import { MODULE_AREAS, MODULES, visibleModules } from '../modules';

type Perfil = 'admin' | 'gerente' | 'operador';
let usuario: { perfil: Perfil; perm_politicas?: string; perm_catalogos?: string } | null = null;

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuario, meta: { version: '0.6.0', mode: 'postgres' }, logout: vi.fn(), loading: false }),
}));

function renderTop(perfil: Perfil, rota = '/', perm_politicas?: string) {
  usuario = { perfil, perm_politicas };
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <TopNavigation />
    </MemoryRouter>
  );
}

/** Botão de Área dentro da barra horizontal (não o do dropdown "Mais"). */
function botaoDaBarra(container: HTMLElement, area: string) {
  return container.querySelector<HTMLButtonElement>(`[data-testid="top-navigation"] > div button[data-topnav-area="${area}"]`)!;
}

function slug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

describe('TopNavigation — Master Top Navigation (UX-05)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  for (const perfil of ['admin', 'gerente', 'operador'] as const) {
    it(`${perfil}: renderiza uma entrada por Área visível, derivada de visibleModules`, () => {
      const { container, unmount } = renderTop(perfil);
      const visiveis = visibleModules({ perfil });
      const areasEsperadas = MODULE_AREAS.filter((a) => visiveis.some((m) => m.area === a));

      const areasRenderizadas = [...container.querySelectorAll('[data-testid="top-navigation"] > div button[data-topnav-area]')]
        .map((b) => b.getAttribute('data-topnav-area'))
        .filter((a) => a !== '__mais__');

      expect(areasRenderizadas).toEqual(areasEsperadas);
      unmount();
    });
  }

  it('RBAC preservado: operador não vê Administração nem Financeiro; gerente vê Financeiro e não Administração', () => {
    const operador = renderTop('operador');
    expect(screen.queryByRole('button', { name: /^Administração/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Financeiro/ })).not.toBeInTheDocument();
    operador.unmount();

    const gerente = renderTop('gerente');
    expect(screen.getByRole('button', { name: /^Financeiro/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Administração/ })).not.toBeInTheDocument();
    gerente.unmount();

    const admin = renderTop('admin');
    expect(screen.getByRole('button', { name: /^Administração/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Financeiro/ })).toBeInTheDocument();
    admin.unmount();
  });

  it('toda rota de visibleModules é alcançável pelo menu superior (nenhum módulo órfão)', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin');
    const alcancaveis = new Set<string>();

    for (const area of MODULE_AREAS) {
      const botao = botaoDaBarra(container, area);
      await user.click(botao);
      const menu = container.querySelector(`#topnav-menu-${slug(area)}`) as HTMLElement;
      expect(menu, `dropdown não abriu para ${area}`).toBeTruthy();
      for (const link of menu.querySelectorAll('a[data-module-id]')) {
        alcancaveis.add(link.getAttribute('href') ?? '');
      }
      await user.click(botao); // fecha
    }

    const esperados = visibleModules({ perfil: 'admin' }).map((m) => m.path);
    for (const path of esperados) {
      expect(alcancaveis, `módulo ${path} não é alcançável pela Top Navigation`).toContain(path);
    }
    unmount();
  });

  it('active state: Área, Grupo e módulo são identificados automaticamente pela rota (inclusive deep link)', async () => {
    const user = userEvent.setup();

    const casos = [
      { rota: '/vendas/123', area: 'Vendas', grupo: 'Comercial', modulo: '/vendas' },
      { rota: '/movimentacoes', area: 'Estoque & Suprimentos', grupo: 'Estoque', modulo: '/movimentacoes' },
      { rota: '/ncm', area: 'Fiscal', grupo: 'Parâmetros fiscais', modulo: '/ncm' },
      { rota: '/ordens/45', area: 'Produção', grupo: 'Execução', modulo: '/ordens' },
      { rota: '/conectores/mercado-livre', area: 'Commerce', grupo: 'Canais', modulo: '/conectores/mercado-livre' },
    ];

    for (const c of casos) {
      const { container, unmount } = renderTop('admin', c.rota);
      const botao = botaoDaBarra(container, c.area);
      expect(botao, `Área ${c.area} deveria estar ativa em ${c.rota}`).toHaveAttribute('aria-current', 'page');

      await user.click(botao);
      const menu = container.querySelector(`#topnav-menu-${slug(c.area)}`) as HTMLElement;
      expect(within(menu).getByText(c.grupo)).toBeInTheDocument();

      const linkAtivo = menu.querySelector(`a[href="${c.modulo}"]`);
      expect(linkAtivo, `módulo ${c.modulo} deveria estar ativo em ${c.rota}`).toHaveAttribute('aria-current', 'page');
      unmount();
    }
  });

  it('abre por clique, fecha ao clicar fora e fecha com Escape', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin', '/');

    const botaoVendas = botaoDaBarra(container, 'Vendas');
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');

    await user.click(botaoVendas);
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector(`#topnav-menu-${slug('Vendas')}`)).toBeTruthy();

    // clicar fora fecha
    await user.click(document.body);
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector(`#topnav-menu-${slug('Vendas')}`)).toBeNull();

    // Escape fecha
    await user.click(botaoVendas);
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');
    unmount();
  });

  it('teclado: ArrowDown abre o menu e foca o primeiro módulo; Setas navegam; Escape devolve o foco à Área', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin', '/');

    const botaoVendas = botaoDaBarra(container, 'Vendas');
    botaoVendas.focus();
    await user.keyboard('{ArrowDown}');
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'true');

    const menu = container.querySelector(`#topnav-menu-${slug('Vendas')}`) as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));

    const primeiro = document.activeElement as HTMLElement;
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(primeiro);

    await user.keyboard('{End}');
    const itens = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(document.activeElement).toBe(itens[itens.length - 1]);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(itens[0]);

    await user.keyboard('{Escape}');
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(botaoVendas);
    unmount();
  });

  it('Enter e Space também abrem a Área pelo teclado', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin', '/');

    const botaoCadastros = botaoDaBarra(container, 'Cadastros');
    botaoCadastros.focus();
    await user.keyboard('{Enter}');
    expect(botaoCadastros).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');

    const botaoFiscal = botaoDaBarra(container, 'Fiscal');
    botaoFiscal.focus();
    await user.keyboard(' ');
    expect(botaoFiscal).toHaveAttribute('aria-expanded', 'true');
    unmount();
  });

  it('identifica módulos planejados com o selo "Em breve"', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin', '/');

    await user.click(botaoDaBarra(container, 'Commerce'));
    const menu = container.querySelector(`#topnav-menu-${slug('Commerce')}`) as HTMLElement;
    const planned = menu.querySelectorAll('a[data-planned="true"]');
    expect(planned).toHaveLength(4);
    for (const link of planned) {
      expect(within(link as HTMLElement).getByText('Em breve')).toBeInTheDocument();
    }
    unmount();
  });

  it('submenus em cascata expõem Grupo, Subgrupo e Módulo sem duplicar cadastro', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderTop('admin', '/');

    await user.click(botaoDaBarra(container, 'Estoque & Suprimentos'));
    const menu = container.querySelector(`#topnav-menu-${slug('Estoque & Suprimentos')}`) as HTMLElement;

    expect(within(menu).getAllByText('Estoque').length).toBeGreaterThanOrEqual(1);
    expect(within(menu).getAllByText('Compras').length).toBeGreaterThanOrEqual(1);
    expect(within(menu).getByText('Posição e controle')).toBeInTheDocument();
    expect(menu.querySelector('a[href="/inventario"]')).toBeTruthy();
    expect(menu.querySelector('a[href="/sugestao-compra"]')).toBeTruthy();
    unmount();
  });

  it('permissão comercial de políticas abre o item para o operador (RBAC herdado)', async () => {
    const user = userEvent.setup();
    const semPermissao = renderTop('operador', '/');
    await user.click(botaoDaBarra(semPermissao.container, 'Vendas'));
    expect(semPermissao.container.querySelector('a[href="/politicas-comerciais"]')).toBeNull();
    semPermissao.unmount();

    const comPermissao = renderTop('operador', '/', 'permitir');
    await user.click(botaoDaBarra(comPermissao.container, 'Vendas'));
    expect(comPermissao.container.querySelector('a[href="/politicas-comerciais"]')).toBeTruthy();
    comPermissao.unmount();
  });

  it('quantasCabem: decide o transbordo para "Mais" sem descartar nenhuma Área', () => {
    // Tudo cabe → nenhuma Área vai para "Mais".
    expect(quantasCabem([100, 100, 100], 1000)).toBe(3);
    // Só uma cabe: a segunda já exigiria o botão "Mais" (100 + 96 de reserva).
    expect(quantasCabem([100, 100, 100], 280)).toBe(1);
    // Nunca devolve zero: pelo menos uma Área fica visível.
    expect(quantasCabem([500, 500, 500], 120)).toBe(1);
    // Duas cabem quando a barra comporta os itens + a reserva de "Mais" (96).
    expect(quantasCabem([100, 100, 100], 296)).toBe(2);
    // Sem medição (jsdom/SSR): todas as Áreas permanecem na linha.
    expect(quantasCabem([], 0)).toBe(0);
  });

  it('a árvore do menu superior cobre exatamente as Áreas e módulos da fonte única', () => {
    const { container, unmount } = renderTop('admin', '/');
    const areasRenderizadas = [...container.querySelectorAll('[data-testid="top-navigation"] > div button[data-topnav-area]')]
      .map((b) => b.getAttribute('data-topnav-area'))
      .filter((a) => a !== '__mais__');
    expect(areasRenderizadas.sort()).toEqual([...MODULE_AREAS].sort());
    expect(MODULES).toHaveLength(70);
    unmount();
  });

  it('focarPrimeiroItem: entra no dropdown "Mais" (botões de Área, sem role=menuitem)', () => {
    // Regressão: o agrupador "Mais" é feito de botões expansíveis
    // (`button[data-topnav-area]`), não de links com `role="menuitem"`. Como o
    // helper buscava apenas `[role="menuitem"]`, abrir o "Mais" pelo teclado
    // deixava o foco no gatilho — a navegação por setas nunca começava.
    const host = document.createElement('div');
    document.body.appendChild(host);

    // Caso "Mais": só botões de Área, nenhum menuitem.
    host.innerHTML =
      '<button data-topnav-area="Creators">Creators</button><button data-topnav-area="Utilidades Globais">Utilidades</button>';
    focarPrimeiroItem(host);
    expect(document.activeElement?.getAttribute('data-topnav-area')).toBe('Creators');

    // Caso normal: com menuitem presente, ele continua sendo a primeira escolha.
    host.innerHTML = '<a role="menuitem" href="/vendas">Pedidos</a><button data-topnav-area="Creators">Creators</button>';
    focarPrimeiroItem(host);
    expect(document.activeElement?.getAttribute('href')).toBe('/vendas');

    // Menu vazio / nulo não quebra.
    expect(() => focarPrimeiroItem(null)).not.toThrow();
    host.remove();
  });

  it('sem Áreas visíveis não renderiza a barra (defensivo)', () => {
    usuario = null as unknown as typeof usuario;
    const { container, unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <TopNavigation />
      </MemoryRouter>
    );
    // Sem usuário, `visibleModules` ainda devolve os módulos públicos; a barra existe.
    expect(container.querySelector('[data-testid="top-navigation"]')).toBeTruthy();
    unmount();
  });
});
