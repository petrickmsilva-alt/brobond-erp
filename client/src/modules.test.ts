import { describe, expect, it } from 'vitest';
import { GROUP_META, MODULES, MODULE_GROUPS, visibleModules } from './modules';

describe('visibleModules', () => {
  it('operador não vê módulos adminOnly nem exclusivos de gerente', () => {
    const visiveis = visibleModules({ perfil: 'operador' });
    expect(visiveis.some((m) => m.adminOnly)).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'gerente')).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'admin')).toBe(false);
  });

  it('gerente vê módulos de gerente mas não adminOnly', () => {
    const visiveis = visibleModules({ perfil: 'gerente' });
    expect(visiveis.some((m) => m.id === 'financeiro')).toBe(true);
    expect(visiveis.some((m) => m.id === 'usuarios')).toBe(false);
  });

  it('admin vê todos os módulos cadastrados', () => {
    const visiveis = visibleModules({ perfil: 'admin' });
    expect(visiveis).toHaveLength(MODULES.length);
  });

  it('operador com permissão explícita de políticas comerciais vê o módulo mesmo sem ser gerente', () => {
    const semPermissao = visibleModules({ perfil: 'operador' });
    expect(semPermissao.some((m) => m.id === 'politicas-comerciais')).toBe(false);

    const comPermissao = visibleModules({ perfil: 'operador', perm_politicas: 'permitir' });
    expect(comPermissao.some((m) => m.id === 'politicas-comerciais')).toBe(true);
  });

  it('ERP-05: o grupo Fiscal existe e concentra documentos, regras, NCM e inutilizações', () => {
    expect(MODULE_GROUPS).toContain('Fiscal');
    const fiscal = MODULES.filter((m) => m.group === 'Fiscal').map((m) => m.id);
    expect(fiscal).toEqual(['documentos-fiscais', 'regras-fiscais', 'ncm', 'inutilizacoes']);
    // Fiscal não mora mais dentro de Vendas (auditoria §17: "Fiscal está espalhado").
    expect(MODULES.filter((m) => m.group === 'Vendas').map((m) => m.id)).not.toContain('documentos-fiscais');
    expect(MODULES.filter((m) => m.group === 'Vendas').map((m) => m.id)).not.toContain('regras-fiscais');

    // Os dois recursos que a API expunha sem tela agora têm destino navegável.
    const ncm = MODULES.find((m) => m.id === 'ncm');
    expect(ncm?.resource).toBe('impostos_ncm');
    expect(ncm?.minPerfil).toBe('gerente'); // igual ao minPerfil do recurso no servidor
    const inut = MODULES.find((m) => m.id === 'inutilizacoes');
    expect(inut?.resource).toBe('inutilizacoes_fiscais');
    expect(inut?.minPerfil).toBe('gerente');
  });

  it('operador não vê os módulos fiscais restritos a gerente', () => {
    const visiveis = visibleModules({ perfil: 'operador' }).map((m) => m.id);
    expect(visiveis).not.toContain('ncm');
    expect(visiveis).not.toContain('inutilizacoes');
    expect(visiveis).not.toContain('regras-fiscais');
    expect(visiveis).toContain('documentos-fiscais'); // sem minPerfil: qualquer perfil com RBAC lê
  });

  it('registra o esqueleto completo de Commerce, Creators e Delivery', () => {
    expect(MODULE_GROUPS).toEqual(expect.arrayContaining(['Gestão de Commerce', 'Ecossistema Creators']));

    const commerce = MODULES.filter((m) => m.group === 'Gestão de Commerce');
    expect(commerce.map((m) => m.label)).toEqual(['Produtos', 'Pedidos', 'Trends', '📦 Delivery']);
    expect(commerce.map((m) => m.path)).toEqual(['/commerce/produtos', '/commerce/pedidos', '/commerce/trends', '/commerce/delivery']);

    const creators = MODULES.filter((m) => m.group === 'Ecossistema Creators');
    expect(creators.map((m) => m.label)).toEqual(['Creators', 'Matches', 'Outreach AI', 'Campanhas']);
    expect(creators.every((m) => m.planned && m.planned.length > 0)).toBe(true);
  });

  it('sem usuário logado, aplica as mesmas regras de um perfil não-admin/gerente', () => {
    const visiveis = visibleModules(null);
    expect(visiveis.some((m) => m.adminOnly)).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'gerente')).toBe(false);
  });

  it('todo módulo com área de negócio pertence a um grupo declarado e com metadados de Sidebar', () => {
    const orfaos = MODULES.filter((m) => m.group !== null && !(MODULE_GROUPS as readonly string[]).includes(m.group));
    expect(orfaos.map((m) => m.id)).toEqual([]);
    for (const g of MODULE_GROUPS) expect(GROUP_META[g]).toBeDefined();
  });

  it('a navegação ERP usa as áreas de negócio (Meu Negócio, Cadastros, Vendas, Estoque, Financeiro...)', () => {
    const areas = new Set(MODULES.map((m) => m.group).filter(Boolean));
    for (const a of ['Cadastros', 'Vendas', 'Compras', 'Estoque', 'Produção', 'Financeiro', 'Relatórios', 'Integrações', 'Configurações']) {
      expect(areas.has(a)).toBe(true);
    }
    expect(MODULES.find((m) => m.id === 'dashboard')?.label).toBe('Meu Negócio');
  });
});
