// ============================================================================
// Barreira contra regressão da navegação (ERP-UX-01 · UX-01-B · ERP-UX-03).
//
// Verifica a Árvore Master (Seção → Área → Grupo → Subgrupo → Módulo) no
// componente Sidebar real, perfil a perfil, garantindo:
//   • correspondência 1:1 com `visibleModules(user)` e `buildNavigationTree`;
//   • RBAC de admin, gerente e operador (incluindo capacidades comerciais);
//   • densidade controlada (accordion de Área e de Grupo);
//   • abertura automática de Área + Grupo na rota atual e em deep links;
//   • identificação visual de itens `planned` ("Em breve");
//   • acessibilidade por teclado, colapso desktop/tablet e drawer mobile.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar';
import { MODULES, MODULE_AREAS, MODULE_GROUPS, NAV_SECTIONS, visibleModules } from '../modules';

const PERFIS = ['admin', 'gerente', 'operador'] as const;
type Perfil = (typeof PERFIS)[number];

let usuario: { perfil: Perfil; perm_politicas?: string; perm_catalogos?: string } | null = null;

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuario, meta: { version: '0.6.0', mode: 'postgres' }, logout: vi.fn(), loading: false }),
}));

/** Renderiza a Sidebar real e devolve exatamente o que foi para a tela. */
function renderSidebar(perfil: Perfil, perm_politicas?: string, rota = '/', onClose = () => {}) {
  usuario = { perfil, perm_politicas };
  const { container, unmount } = render(
    <MemoryRouter initialEntries={[rota]}>
      <Sidebar open onClose={onClose} />
    </MemoryRouter>
  );
  const itens = [...container.querySelectorAll('nav a')].map((a) => ({
    path: a.getAttribute('href') ?? '',
    label: a.textContent?.trim() ?? '',
    planned: a.getAttribute('data-planned') === 'true',
  }));
  const areas = [...container.querySelectorAll('nav button[data-nav-area]')].map((b) => b.getAttribute('data-nav-area') ?? '');
  const grupos = [...container.querySelectorAll('nav button[data-nav-group]')].map((b) => b.getAttribute('data-nav-group') ?? '');
  const subgrupos = [...container.querySelectorAll('nav [data-nav-subgroup]')].map((el) => el.getAttribute('data-nav-subgroup') ?? '');
  return { itens, areas, grupos, subgrupos, container, unmount };
}

describe('Sidebar — Árvore Master renderizada × fonte única', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  for (const perfil of PERFIS) {
    it(`${perfil}: renderiza exatamente os módulos de visibleModules(MODULES)`, () => {
      const { itens, unmount } = renderSidebar(perfil);
      const esperados = visibleModules({ perfil }).map((m) => m.path);

      expect(itens.map((i) => i.path).sort()).toEqual([...esperados].sort());
      expect(itens).toHaveLength(esperados.length);
      unmount();
    });

    it(`${perfil}: todo item renderizado existe em MODULES e usa o rótulo declarado`, () => {
      const { itens, unmount } = renderSidebar(perfil);
      for (const item of itens) {
        const declarado = MODULES.find((m) => m.path === item.path);
        expect(declarado, `item renderizado sem módulo correspondente em MODULES: ${item.path}`).toBeDefined();
        expect(item.label, `rótulo divergente em ${item.path}`).toBe(declarado?.label);
      }
      expect(itens.length).toBeGreaterThan(0);
      unmount();
    });

    it(`${perfil}: renderiza toda Área e todo Grupo declarados que tenham módulo visível (e só esses)`, () => {
      const { areas, grupos, subgrupos, unmount } = renderSidebar(perfil);
      const visiveis = visibleModules({ perfil });
      const areasEsperadas = MODULE_AREAS.filter((a) => visiveis.some((m) => m.area === a));
      const gruposEsperados = MODULE_GROUPS.filter((g) => visiveis.some((m) => m.group === g));

      expect(areas).toEqual([...areasEsperadas]);
      expect(grupos).toEqual([...gruposEsperados]);
      expect(subgrupos.length).toBeGreaterThan(0);

      for (const a of MODULE_AREAS.filter((area) => !visiveis.some((m) => m.area === area))) {
        expect(areas, `área vazia renderizada: ${a}`).not.toContain(a);
      }
      for (const g of MODULE_GROUPS.filter((group) => !visiveis.some((m) => m.group === group))) {
        expect(grupos, `grupo vazio renderizado: ${g}`).not.toContain(g);
      }
      unmount();
    });
  }

  it('Fiscal aparece quando o perfil tem autorização (P0 do ERP-UX-01)', () => {
    const fiscais = ['/documentos-fiscais', '/regras-fiscais', '/ncm', '/inutilizacoes'];

    for (const perfil of ['admin', 'gerente'] as const) {
      const { itens, areas, unmount } = renderSidebar(perfil);
      expect(areas, `${perfil} não vê a área Fiscal`).toContain('Fiscal');
      for (const path of fiscais) {
        expect(itens.map((i) => i.path), `${perfil} não vê ${path}`).toContain(path);
      }
      unmount();
    }

    const { itens, areas, grupos, unmount } = renderSidebar('operador');
    expect(areas).toContain('Fiscal');
    expect(grupos).toContain('Operação fiscal');
    expect(grupos).not.toContain('Parâmetros fiscais');
    expect(itens.map((i) => i.path)).toContain('/documentos-fiscais');
    for (const path of ['/regras-fiscais', '/ncm', '/inutilizacoes']) {
      expect(itens.map((i) => i.path)).not.toContain(path);
    }
    unmount();
  });

  it('RBAC preservado: adminOnly e minPerfil continuam escondendo o que escondiam', () => {
    const operador = renderSidebar('operador');
    const pathsOperador = operador.itens.map((i) => i.path);
    for (const m of MODULES.filter((m) => m.adminOnly)) {
      expect(pathsOperador, `operador vendo item adminOnly: ${m.path}`).not.toContain(m.path);
    }
    for (const m of MODULES.filter((m) => m.minPerfil === 'gerente')) {
      expect(pathsOperador, `operador vendo item de gerente: ${m.path}`).not.toContain(m.path);
    }
    expect(operador.areas).not.toContain('Administração');
    expect(operador.areas).not.toContain('Financeiro');
    expect(operador.areas).toContain('Utilidades Globais');
    operador.unmount();

    const gerente = renderSidebar('gerente');
    expect(gerente.areas).not.toContain('Administração');
    expect(gerente.areas).toContain('Financeiro');
    expect(gerente.areas).toContain('Utilidades Globais');
    gerente.unmount();

    const admin = renderSidebar('admin');
    expect(admin.itens).toHaveLength(MODULES.length);
    expect(admin.areas).toContain('Administração');
    admin.unmount();
  });

  it('RBAC preservado: permissão específica de políticas comerciais abre o item para o operador', () => {
    const semPermissao = renderSidebar('operador');
    expect(semPermissao.itens.map((i) => i.path)).not.toContain('/politicas-comerciais');
    semPermissao.unmount();

    const comPermissao = renderSidebar('operador', 'permitir');
    expect(comPermissao.itens.map((i) => i.path)).toContain('/politicas-comerciais');
    comPermissao.unmount();
  });

  it('densidade controlada: apenas a Área e o Grupo da rota atual iniciam abertos por padrão', () => {
    const { container, unmount } = renderSidebar('admin', undefined, '/');
    const areaMeuNegocio = container.querySelector('nav button[data-nav-area="Meu Negócio"]');
    const areaCadastros = container.querySelector('nav button[data-nav-area="Cadastros"]');
    const areaVendas = container.querySelector('nav button[data-nav-area="Vendas"]');
    const grupoVisao = container.querySelector('nav button[data-nav-group="Visão do negócio"]');
    const grupoAnalises = container.querySelector('nav button[data-nav-group="Análises"]');

    expect(areaMeuNegocio).toHaveAttribute('aria-expanded', 'true');
    expect(areaCadastros).toHaveAttribute('aria-expanded', 'false');
    expect(areaVendas).toHaveAttribute('aria-expanded', 'false');
    expect(grupoVisao).toHaveAttribute('aria-expanded', 'true');
    expect(grupoAnalises).toHaveAttribute('aria-expanded', 'false');
    unmount();
  });

  it('módulo ativo e deep links abrem automaticamente a Área e o Grupo corretos', () => {
    const casos = [
      { rota: '/documentos-fiscais', area: 'Fiscal', grupo: 'Operação fiscal', pathAtivo: '/documentos-fiscais' },
      { rota: '/produtos/12', area: 'Cadastros', grupo: 'Produtos', pathAtivo: '/produtos' },
      { rota: '/vendas/123', area: 'Vendas', grupo: 'Comercial', pathAtivo: '/vendas' },
      { rota: '/ordens/45', area: 'Produção', grupo: 'Execução', pathAtivo: '/ordens' },
      { rota: '/compras/9', area: 'Estoque & Suprimentos', grupo: 'Compras', pathAtivo: '/compras' },
      { rota: '/fichas/3', area: 'Produção', grupo: 'Engenharia', pathAtivo: '/fichas' },
      { rota: '/conectores/mercado-livre', area: 'Commerce', grupo: 'Canais', pathAtivo: '/conectores/mercado-livre' },
    ];

    for (const c of casos) {
      localStorage.clear();
      const { container, unmount } = renderSidebar('admin', undefined, c.rota);
      const botaoArea = container.querySelector(`nav button[data-nav-area="${c.area}"]`);
      const botaoGrupo = container.querySelector(`nav button[data-nav-group="${c.grupo}"]`);
      const linkAtivo = container.querySelector(`nav a[href="${c.pathAtivo}"]`);

      expect(botaoArea, `Área ${c.area} deveria abrir em ${c.rota}`).toHaveAttribute('aria-expanded', 'true');
      expect(botaoGrupo, `Grupo ${c.grupo} deveria abrir em ${c.rota}`).toHaveAttribute('aria-expanded', 'true');
      expect(linkAtivo, `Módulo ${c.pathAtivo} deveria estar ativo em ${c.rota}`).toHaveAttribute('aria-current', 'page');
      unmount();
    }
  });

  it('accordion funciona por clique e por teclado (Enter/Space) em Áreas e Grupos', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderSidebar('admin', undefined, '/');

    const botaoVendas = container.querySelector('nav button[data-nav-area="Vendas"]') as HTMLButtonElement;
    const botaoBalcao = container.querySelector('nav button[data-nav-group="Balcão"]') as HTMLButtonElement;

    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');
    expect(botaoBalcao).toHaveAttribute('aria-expanded', 'false');

    // Abrir Área Vendas com clique
    await user.click(botaoVendas);
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'true');
    expect(botaoBalcao).toHaveAttribute('aria-expanded', 'false');

    // Abrir Grupo Balcão via teclado (Enter)
    botaoBalcao.focus();
    await user.keyboard('{Enter}');
    expect(botaoBalcao).toHaveAttribute('aria-expanded', 'true');

    // Fechar Grupo Balcão via teclado (Space)
    await user.keyboard(' ');
    expect(botaoBalcao).toHaveAttribute('aria-expanded', 'false');

    // Fechar Área Vendas com clique
    await user.click(botaoVendas);
    expect(botaoVendas).toHaveAttribute('aria-expanded', 'false');
    unmount();
  });

  it('identifica claramente todos os 8 itens planned com data-planned e badge Em breve', () => {
    const { itens, container, unmount } = renderSidebar('admin');
    const plannedRenderizados = itens.filter((i) => i.planned);
    expect(plannedRenderizados).toHaveLength(8);
    expect(plannedRenderizados.map((i) => i.path).sort()).toEqual(
      [
        '/commerce/produtos',
        '/commerce/pedidos',
        '/commerce/trends',
        '/commerce/delivery',
        '/creators',
        '/matches',
        '/outreach-ai',
        '/campanhas',
      ].sort()
    );
    expect(container.querySelectorAll('nav a[data-planned="true"] [data-planned-badge="Em breve"]')).toHaveLength(8);
    unmount();
  });

  it('é o drawer de navegação do mobile/tablet: fecha por botão, backdrop e Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container, getByLabelText, getByTestId, unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar open onClose={onClose} />
      </MemoryRouter>
    );

    const aside = container.querySelector('aside')!;
    expect(aside).toHaveAttribute('data-mobile-open', 'true');

    // Fechar drawer mobile por botão, backdrop e tecla Escape
    await user.click(getByLabelText('Fechar menu'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(getByTestId('sidebar-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('toda área e todo grupo declarados têm uma seção de Sidebar (nenhum item fica órfão)', () => {
    const areasEmSecoes = NAV_SECTIONS.flatMap((s) => s.areas);
    const gruposEmSecoes = NAV_SECTIONS.flatMap((s) => s.groups);
    expect([...areasEmSecoes].sort()).toEqual([...MODULE_AREAS].sort());
    expect([...gruposEmSecoes].sort()).toEqual([...MODULE_GROUPS].sort());
  });
});
