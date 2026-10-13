import { describe, expect, it } from 'vitest';
import { GROUP_META, MODULES, MODULE_GROUPS, NAV_SECTIONS, moduleOfPath, visibleModules } from './modules';

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

  it('UX-02.1: operador não descobre os destinos gerenciais fechados nos P0', () => {
    const visiveis = visibleModules({ perfil: 'operador' }).map((m) => m.id);
    for (const id of ['empresas', 'listas-preco', 'envios', 'conector-mercadolivre', 'conector-mercadopago', 'conector-nuvemshop', 'conector-instagram', 'pdv-caixas']) {
      expect(visiveis, `operador não deveria descobrir ${id}`).not.toContain(id);
    }
    expect(visiveis).toContain('pdv');
  });

  it('UX-02.1: gerente/admin descobrem listas, envios e conectores (sem ampliar operador)', () => {
    for (const perfil of ['gerente', 'admin'] as const) {
      const visiveis = visibleModules({ perfil }).map((m) => m.id);
      for (const id of ['listas-preco', 'envios', 'conector-mercadolivre', 'conector-mercadopago', 'conector-nuvemshop', 'conector-instagram']) {
        expect(visiveis, `${perfil} deveria descobrir ${id}`).toContain(id);
      }
    }
    expect(visibleModules({ perfil: 'gerente' }).map((m) => m.id)).not.toContain('empresas');
    expect(visibleModules({ perfil: 'admin' }).map((m) => m.id)).toContain('empresas');
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

// ----------------------------------------------------------------------------
// Fonte única da navegação (ERP-UX-01): a Sidebar renderiza o que está aqui.
// ----------------------------------------------------------------------------
describe('NAV_SECTIONS (fonte única do menu)', () => {
  it('cobre toda área declarada exatamente uma vez, na ordem de MODULE_GROUPS', () => {
    const nasSecoes = NAV_SECTIONS.flatMap((s) => s.groups);
    expect([...nasSecoes].sort()).toEqual([...MODULE_GROUPS].sort());
    expect(nasSecoes).toHaveLength(MODULE_GROUPS.length);
    // A ordem renderizada é a ordem declarada.
    expect(nasSecoes).toEqual([...MODULE_GROUPS]);
  });

  it('cada área pertence à seção que GROUP_META declara', () => {
    for (const secao of NAV_SECTIONS) {
      for (const g of secao.groups) expect(GROUP_META[g].section).toBe(secao.id);
    }
  });

  it('ERP-05: o grupo Fiscal é renderizável (aparece em alguma seção) e tem 4 módulos', () => {
    expect(NAV_SECTIONS.some((s) => s.groups.includes('Fiscal'))).toBe(true);
    expect(MODULES.filter((m) => m.group === 'Fiscal').map((m) => m.id)).toEqual([
      'documentos-fiscais',
      'regras-fiscais',
      'ncm',
      'inutilizacoes',
    ]);
  });
});

describe('moduleOfPath (regra única de rota → módulo)', () => {
  it('casa a rota exata e as rotas filhas com o módulo dono', () => {
    expect(moduleOfPath('/')?.id).toBe('dashboard');
    expect(moduleOfPath('/documentos-fiscais')?.id).toBe('documentos-fiscais');
    expect(moduleOfPath('/produtos/12')?.id).toBe('produtos');
    expect(moduleOfPath('/vendas/7')?.id).toBe('vendas');
    expect(moduleOfPath('/conectores/mercado-livre')?.id).toBe('conector-mercadolivre');
  });

  it('devolve undefined para rota que não pertence a módulo nenhum', () => {
    expect(moduleOfPath('/dev/componentes')).toBeUndefined();
    expect(moduleOfPath('/rota-que-nao-existe')).toBeUndefined();
  });

  it('respeita a lista recebida (RBAC): módulo invisível não é dono da rota', () => {
    const visiveisOperador = visibleModules({ perfil: 'operador' });
    expect(moduleOfPath('/regras-fiscais', visiveisOperador)).toBeUndefined();
    expect(moduleOfPath('/documentos-fiscais', visiveisOperador)?.id).toBe('documentos-fiscais');
  });
});
