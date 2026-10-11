// ============================================================================
// Barreira contra regressão da navegação (ERP-UX-01 · UX-01-B).
//
// O problema que este arquivo existe para impedir: o código declarar uma coisa
// e a Sidebar renderizar outra (o grupo Fiscal ficou meses declarado em
// `MODULES`/`MODULE_GROUPS` e nunca apareceu para o usuário).
//
// Por isso o teste executa o componente REAL e compara, perfil a perfil, o
// menu efetivamente renderizado com a fonte única (`visibleModules(MODULES)`).
// Testar só os arrays declarativos não pegaria o defeito — foi exatamente o que
// os gates antigos faziam.
// ============================================================================
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar';
import { MODULES, MODULE_GROUPS, NAV_SECTIONS, visibleModules } from '../modules';

const PERFIS = ['admin', 'gerente', 'operador'] as const;
type Perfil = (typeof PERFIS)[number];

let usuario: { perfil: Perfil; perm_politicas?: string } | null = null;

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuario, meta: { version: '0.6.0', mode: 'postgres' }, logout: vi.fn(), loading: false }),
}));

/** Renderiza a Sidebar real e devolve exatamente o que foi para a tela. */
function renderSidebar(perfil: Perfil, perm_politicas?: string, rota = '/') {
  usuario = { perfil, perm_politicas };
  const { container, unmount } = render(
    <MemoryRouter initialEntries={[rota]}>
      <Sidebar open onClose={() => {}} />
    </MemoryRouter>
  );
  const itens = [...container.querySelectorAll('nav a')].map((a) => ({
    path: a.getAttribute('href') ?? '',
    label: a.textContent?.trim() ?? '',
  }));
  const grupos = [...container.querySelectorAll('nav button[aria-controls]')].map((b) => b.textContent?.trim() ?? '');
  return { itens, grupos, container, unmount };
}

describe('Sidebar — menu renderizado × fonte única', () => {
  for (const perfil of PERFIS) {
    it(`${perfil}: renderiza exatamente os módulos de visibleModules(MODULES)`, () => {
      const { itens, unmount } = renderSidebar(perfil);
      const esperados = visibleModules({ perfil }).map((m) => m.path);

      // Nenhum declarado de fora; nenhum renderizado sem correspondência oficial.
      expect(itens.map((i) => i.path).sort()).toEqual([...esperados].sort());
      // Sem repetição: a quantidade renderizada é a quantidade esperada.
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

    it(`${perfil}: renderiza toda área declarada que tenha módulo visível (e só essas)`, () => {
      const { grupos, unmount } = renderSidebar(perfil);
      const visiveis = visibleModules({ perfil });
      const esperados = MODULE_GROUPS.filter((g) => visiveis.some((m) => m.group === g));

      // Igualdade de lista: presença E ordem (a ordem da fonte única).
      expect(grupos).toEqual([...esperados]);
      // Um grupo declarado sem nenhum módulo visível não vira cabeçalho vazio.
      for (const g of MODULE_GROUPS.filter((g) => !visiveis.some((m) => m.group === g))) {
        expect(grupos, `área vazia renderizada: ${g}`).not.toContain(g);
      }
      unmount();
    });
  }

  it('Fiscal aparece quando o perfil tem autorização (P0 do ERP-UX-01)', () => {
    const fiscais = ['/documentos-fiscais', '/regras-fiscais', '/ncm', '/inutilizacoes'];

    for (const perfil of ['admin', 'gerente'] as const) {
      const { itens, grupos, unmount } = renderSidebar(perfil);
      expect(grupos, `${perfil} não vê a área Fiscal`).toContain('Fiscal');
      for (const path of fiscais) {
        expect(itens.map((i) => i.path), `${perfil} não vê ${path}`).toContain(path);
      }
      unmount();
    }

    // Operador: vê o único módulo fiscal sem `minPerfil`; os restritos continuam fora.
    const { itens, grupos, unmount } = renderSidebar('operador');
    expect(grupos).toContain('Fiscal');
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
    operador.unmount();

    const admin = renderSidebar('admin');
    expect(admin.itens).toHaveLength(MODULES.length);
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

  it('a área da rota atual é destacada e abre (rotas filhas pertencem ao módulo pai)', () => {
    const { container, unmount } = renderSidebar('admin', undefined, '/documentos-fiscais');
    const botaoFiscal = [...container.querySelectorAll('nav button[aria-controls]')].find((b) => b.textContent?.includes('Fiscal'));
    expect(botaoFiscal).toBeDefined();
    expect(botaoFiscal).toHaveAttribute('aria-expanded', 'true');
    unmount();

    const filho = renderSidebar('admin', undefined, '/produtos/12');
    const botaoCadastros = [...filho.container.querySelectorAll('nav button[aria-controls]')].find((b) => b.textContent?.includes('Cadastros'));
    expect(botaoCadastros).toHaveAttribute('aria-expanded', 'true');
    filho.unmount();
  });

  it('toda área declarada tem uma seção de Sidebar (nenhum grupo declarado fica órfão)', () => {
    const emSecoes = NAV_SECTIONS.flatMap((s) => s.groups);
    expect([...emSecoes].sort()).toEqual([...MODULE_GROUPS].sort());
  });
});
