import { describe, expect, it } from 'vitest';
import {
  AREA_META,
  GROUP_META,
  MODULES,
  MODULE_AREAS,
  MODULE_GROUPS,
  FORM_DIRETO,
  NAV_SECTIONS,
  PAGES_ESPECIAIS,
  MODULOS_PAGINA_PROPRIA,
  buildNavigationTree,
  moduleOfPath,
  visibleModules,
} from './modules';

const ROTAS_CANONICAS_ESPERADAS: Record<string, string> = {
  dashboard: '/',
  relatorios: '/relatorios',
  produtos: '/produtos',
  categorias: '/categorias',
  cores: '/cores',
  colecoes: '/colecoes',
  grades: '/grades',
  tamanhos: '/tamanhos',
  medidas: '/medidas',
  insumos: '/insumos',
  'categorias-insumos': '/categorias-insumos',
  clientes: '/clientes',
  fornecedores: '/fornecedores',
  representantes: '/representantes',
  vendas: '/vendas',
  propostas: '/propostas',
  catalogos: '/catalogos',
  'politicas-comerciais': '/politicas-comerciais',
  'listas-preco': '/listas-preco',
  pdv: '/pdv',
  'pdv-caixas': '/pdv-caixas',
  expedicao: '/expedicao',
  divergencias: '/divergencias',
  envios: '/envios',
  devolucoes: '/devolucoes',
  estoque: '/estoque',
  movimentacoes: '/movimentacoes',
  inventario: '/inventario',
  'contagem-ciclica-abc': '/contagem-ciclica-abc',
  locais: '/locais',
  compras: '/compras',
  'cotacoes-compra': '/cotacoes-compra',
  'compra-recebimentos': '/compra-recebimentos',
  'importar-nfe-compra': '/importar-nfe-compra',
  'sugestao-compra': '/sugestao-compra',
  'depara-fornecedor': '/depara-fornecedor',
  'planejamento-producao': '/planejamento-producao',
  ordens: '/ordens',
  'terceiros-operacionais': '/terceiros-operacionais',
  fichas: '/fichas',
  custo: '/custo',
  financeiro: '/financeiro',
  lancamentos: '/lancamentos',
  'contas-financeiras': '/contas-financeiras',
  transferencias: '/transferencias',
  comissoes: '/comissoes',
  investidores: '/investidores',
  aportes: '/aportes',
  'categorias-financeiras': '/categorias-financeiras',
  'centros-custo': '/centros-custo',
  'recorrencias-financeiras': '/recorrencias-financeiras',
  'documentos-fiscais': '/documentos-fiscais',
  inutilizacoes: '/inutilizacoes',
  'regras-fiscais': '/regras-fiscais',
  ncm: '/ncm',
  empresas: '/empresas',
  usuarios: '/usuarios',
  auditoria: '/auditoria',
  webhooks: '/webhooks',
  'conector-mercadolivre': '/conectores/mercado-livre',
  'conector-mercadopago': '/conectores/mercado-pago',
  'conector-nuvemshop': '/conectores/nuvemshop',
  'conector-instagram': '/conectores/instagram',
  'commerce-produtos': '/commerce/produtos',
  'commerce-publicacoes': '/commerce/publicacoes',
  'commerce-loja': '/commerce/loja',
  'commerce-promocoes': '/commerce/promocoes',
  'commerce-cupons': '/commerce/cupons',
  'commerce-pedidos': '/commerce/pedidos',
  'commerce-delivery': '/commerce/delivery',
  'commerce-fila': '/commerce/fila',
  'commerce-trends': '/commerce/trends',
  creators: '/creators',
  'creator-matches': '/matches',
  'outreach-ai': '/outreach-ai',
  campanhas: '/campanhas',
  config: '/config',
  ajuda: '/ajuda',
};

describe('ERP-UX-03 — Árvore Master e preservação das funções/rotas', () => {
  it('preserva exatamente os 105 módulos e todas as 105 URLs sem duplicidade nem remoção', () => {
    // 70 da Árvore Master original + 10 da FUNDAÇÃO COMERCIAL (MASTER
    // MA-02..MA-08: territórios, equipes, hierarquia, carteira, atribuição,
    // metas, painel comercial e os dois cadastros do motor de comissão)
    // + 1 do cadastro mestre de Insumos (Categorias de Insumos)
    // + 4 do CRM 3.0 (leads, oportunidades, atividades, motivos de perda)
    // + 2 do CRM 3.0 evolução (painel e agenda de atividades)
    // + 16 da EVOLUÇÃO ERP 3.0 (estoque: transferências, reservas; compras:
    //   homologação; produção: recursos, capacidade/MRP; fiscal: obrigações,
    //   calendário; financeiro: plano de contas, balancete)
    // + 4 do hardening P2/P3 (P3-04: unidades de medida e conversões
    //   declaradas; P2-13: importações contábeis; P3-05/06: terceiros e facções).
    // + 1 do PR #95 — capacidade própria "Contagem Cíclica ABC" (P2-16) sob
    //   Estoque & Suprimentos → Estoque, com página e rota próprias.
    // + 5 do BROBOND COMMERCE OS (0068): Publicações, Loja própria, Promoções,
    //   Cupons e Fila & sync — os 4 antigos "planned" do Multicanal continuam,
    //   agora implementados e sem a marcação de planejamento.
    // + 28 das ONDAS 4–5 (D1 atendimento/CDP, D2 fidelidade/afiliados,
    //   D3 Data/BI, D4 IA, D5 demanda/suprimento, D6 ocorrências/scorecard,
    //   D7 EPM) — todos com página e rota próprias, ZERO MODAL.
    expect(MODULES).toHaveLength(139);
    const ids = MODULES.map((m) => m.id);
    const paths = MODULES.map((m) => m.path);
    expect(new Set(ids).size).toBe(139);
    expect(new Set(paths).size).toBe(139);

    for (const [id, pathEsperado] of Object.entries(ROTAS_CANONICAS_ESPERADAS)) {
      const mod = MODULES.find((m) => m.id === id);
      expect(mod, `módulo ${id} deve continuar existindo`).toBeDefined();
      expect(mod?.path, `URL do módulo ${id} não pode mudar`).toBe(pathEsperado);
    }
  });

  it('implementa as 11 áreas principais da Árvore Master na ordem aprovada', () => {
    expect([...MODULE_AREAS]).toEqual([
      'Meu Negócio',
      'Cadastros',
      'Vendas',
      'Estoque & Suprimentos',
      'Produção',
      'Financeiro',
      'Fiscal',
      'Administração',
      'Commerce',
      'Creators',
      'Utilidades Globais',
    ]);
    for (const area of MODULE_AREAS) {
      expect(AREA_META[area]).toBeDefined();
      expect(MODULES.some((m) => m.area === area), `área ${area} deve ter módulos`).toBe(true);
    }
  });

  it('separa ERP CORE (92), Commerce (13), Creators (4) e Utilidades Globais (2)', () => {
    expect(MODULES.filter((m) => m.space === 'erp')).toHaveLength(120);
    // 4 conectores de canal + 9 módulos do BROBOND COMMERCE OS
    expect(MODULES.filter((m) => m.space === 'commerce')).toHaveLength(13);
    expect(MODULES.filter((m) => m.space === 'creators')).toHaveLength(4);
    expect(MODULES.filter((m) => m.space === 'utilidades')).toHaveLength(2);
  });

  it('garante casa canônica única por módulo (Pessoas em Cadastros, Entrega/Pós-venda em Vendas, Compras em Estoque & Suprimentos, Webhooks em Administração, Conta/Ajuda em Utilidades Globais)', () => {
    const porArea = (area: string) => MODULES.filter((m) => m.area === area).map((m) => m.id);

    expect(porArea('Meu Negócio')).toEqual([
      'dashboard',
      'relatorios',
      'painel-comercial',
      // ONDAS 4–5 / D2+D4 — growth e IA na casa gerencial (não em Administração:
      // Administração é exclusiva de admin).
      'marketing-automations',
      'marketing-runs',
      'ai-providers',
      'ai-prompts',
      'ai-recommendations',
      'ai-executions',
      // ONDAS 4–5 / D3 — Data e BI.
      'bi-read-models',
    ]);
    expect(porArea('Cadastros')).toEqual([
      'produtos',
      'categorias',
      'cores',
      'colecoes',
      'grades',
      'tamanhos',
      'medidas',
      'insumos',
      'categorias-insumos',
      // ESTOQUE 3.0 / P3-04 — unidade de medida e conversão declarada
      'unidades-medida',
      'conversoes-unidade',
      'clientes',
      'fornecedores',
      'representantes',
    ]);
    expect(porArea('Vendas')).toEqual([
      'vendas',
      'propostas',
      'catalogos',
      'politicas-comerciais',
      'listas-preco',
      // ESTRUTURA COMERCIAL (MASTER): cadastros próprios, no grupo Comercial
      // da área de Vendas (depois dos pedidos e antes do balcão).
      'territorios',
      'equipes_comerciais',
      'equipe_membros',
      'representante_hierarquia',
      'representante_cliente',
      'venda_atribuicao',
      // CRM 3.0 — funil de vendas (grupo Comercial, subgrupo CRM — Funil)
      'crm-leads',
      'crm-oportunidades',
      'crm-atividades',
      'crm-motivos-perda',
      // CRM 3.0 — evolução: painel, agenda, configuração do funil e trilha
      'crm-painel',
      'crm-agenda',
      'crm-estagio-historico',
      'crm-funis',
      'crm-etapas',
      'crm-origens',
      'crm-campanhas',
      'metas',
      'pdv',
      'pdv-caixas',
      'expedicao',
      'divergencias',
      'envios',
      // ONDAS 4–5 / D6 — ocorrência de envio (TMS) na Logística.
      'envio-ocorrencias',
      'devolucoes',
      // ONDAS 4–5 / D1 — atendimento (Service), segmentação/CDP.
      'service-tickets',
      'service-painel',
      'service-sla',
      'service-categorias',
      'customer-segments',
      'customer-consents',
      'customer-preferences',
      // ONDAS 4–5 / D2 — fidelidade e afiliados.
      'loyalty-programs',
      'loyalty-movements',
      'loyalty-tiers',
      'affiliate-commissions',
    ]);
    expect(porArea('Estoque & Suprimentos')).toEqual([
      'estoque',
      'movimentacoes',
      'inventario',
      // CONTAGEM CÍCLICA ABC (P2-16) — capacidade própria sob Estoque.
      'contagem-ciclica-abc',
      'locais',
      // ESTOQUE 3.0 — transferência formal (documento) e reservas
      'transferencias-estoque',
      'reservas-estoque',
      // ONDAS 4–5 / D6 — scorecard de fornecedor (supplier collaboration).
      'fornecedor-scorecards',
      // COMPRAS 3.0 — homologação de fornecedor (processo sobre o cadastro)
      'homologacao-fornecedores',
      'compras',
      'cotacoes-compra',
      'compra-recebimentos',
      'importar-nfe-compra',
      'sugestao-compra',
      'depara-fornecedor',
    ]);
    expect(porArea('Produção')).toEqual([
      // ONDAS 4–5 / D5 — demanda, suprimento e S&OP.
      'demand-forecasts',
      'supply-plans',
      'sop-scenarios',
      'planejamento-producao',
      // PRODUÇÃO 3.0 — recursos produtivos e capacidade/MRP
      'producao-recursos',
      'producao-capacidade',
      'ordens',
      'terceiros-operacionais',
      'fichas',
      'custo',
    ]);
    expect(porArea('Financeiro')).toEqual([
      // ONDAS 4–5 / D7 — EPM (orçamento, cenário, ativo, projeto) no MESMO
      // financeiro existente (sem segundo ledger).
      'epm-budgets',
      'epm-scenarios',
      'epm-assets',
      'epm-projects',
      'epm-project-tasks',
      'financeiro',
      'lancamentos',
      // FINANCEIRO 3.0 — estrutura contábil (não é contabilidade)
      'plano-contas',
      'balancete',
      // FINANCEIRO 3.0 / P2-13 — lote de importação contábil (mesmo livro)
      'importacoes-contabeis',
      'contas-financeiras',
      'transferencias',
      'comissoes',
      // MOTOR DE COMISSÃO (MASTER MA-05): plano + regra, no grupo Comissões.
      'planos_comissao',
      'regras_comissao',
      'investidores',
      'aportes',
      'categorias-financeiras',
      'centros-custo',
      'recorrencias-financeiras',
    ]);
    expect(porArea('Fiscal')).toEqual([
      'documentos-fiscais',
      'inutilizacoes',
      'regras-fiscais',
      'ncm',
      // FISCAL 3.0 — obrigações acessórias: cadastro da regra + calendário
      'fiscal-obrigacoes',
      'fiscal-calendario',
    ]);
    expect(porArea('Administração')).toEqual(['empresas', 'usuarios', 'auditoria', 'webhooks']);
    expect(porArea('Commerce')).toEqual([
      'conector-mercadolivre',
      'conector-mercadopago',
      'conector-nuvemshop',
      'conector-instagram',
      // BROBOND COMMERCE OS — ordem do menu (Catálogo → Loja e ofertas → Operação → Inteligência)
      'commerce-produtos',
      'commerce-publicacoes',
      'commerce-loja',
      'commerce-promocoes',
      'commerce-cupons',
      'commerce-pedidos',
      'commerce-delivery',
      'commerce-fila',
      'commerce-trends',
    ]);
    expect(porArea('Creators')).toEqual(['creators', 'creator-matches', 'outreach-ai', 'campanhas']);
    expect(porArea('Utilidades Globais')).toEqual(['config', 'ajuda']);
  });

  it('constrói a árvore hierárquica (Seção → Área → Grupo → Subgrupo → Módulo) sem perder nenhum item', () => {
    const tree = buildNavigationTree(MODULES);
    const modulosNaArvore = tree.flatMap((s) =>
      s.areas.flatMap((a) => a.groups.flatMap((g) => g.subgroups.flatMap((sub) => sub.modules.map((m) => m.id))))
    );
    expect(modulosNaArvore).toEqual(MODULES.map((m) => m.id));
    // 24 legadas + 9 páginas Commerce + 4 páginas Creators.
    expect(PAGES_ESPECIAIS).toHaveLength(37);
  });
});

describe('visibleModules', () => {
  it('operador não vê módulos adminOnly nem exclusivos de gerente', () => {
    const visiveis = visibleModules({ perfil: 'operador' });
    expect(visiveis.some((m) => m.adminOnly)).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'gerente')).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'admin')).toBe(false);
  });

  it('gerente vê módulos de gerente mas não adminOnly nem Administração', () => {
    const visiveis = visibleModules({ perfil: 'gerente' });
    expect(visiveis.some((m) => m.id === 'financeiro')).toBe(true);
    expect(visiveis.some((m) => m.id === 'usuarios')).toBe(false);
    expect(visiveis.some((m) => m.area === 'Administração')).toBe(false);
    expect(visiveis.some((m) => m.area === 'Utilidades Globais')).toBe(true);
  });

  it('admin vê todos os módulos cadastrados', () => {
    const visiveis = visibleModules({ perfil: 'admin' });
    expect(visiveis).toHaveLength(MODULES.length);
  });

  it('UX-02.1: operador não descobre os destinos gerenciais fechados nos P0', () => {
    const visiveis = visibleModules({ perfil: 'operador' }).map((m) => m.id);
    for (const id of [
      'empresas',
      'listas-preco',
      'envios',
      'conector-mercadolivre',
      'conector-mercadopago',
      'conector-nuvemshop',
      'conector-instagram',
      'pdv-caixas',
    ]) {
      expect(visiveis, `operador não deveria descobrir ${id}`).not.toContain(id);
    }
    expect(visiveis).toContain('pdv');
  });

  it('UX-02.1: gerente/admin descobrem listas, envios e conectores (sem ampliar operador)', () => {
    for (const perfil of ['gerente', 'admin'] as const) {
      const visiveis = visibleModules({ perfil }).map((m) => m.id);
      for (const id of [
        'listas-preco',
        'envios',
        'conector-mercadolivre',
        'conector-mercadopago',
        'conector-nuvemshop',
        'conector-instagram',
      ]) {
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

  it('UX-02.1: permissões comerciais refletem herdar/permitir/negar na descoberta', () => {
    expect(visibleModules({ perfil: 'gerente', perm_politicas: 'negar' }).map((m) => m.id)).not.toContain('politicas-comerciais');
    expect(visibleModules({ perfil: 'gerente', perm_politicas: 'herdar' }).map((m) => m.id)).toContain('politicas-comerciais');
    expect(visibleModules({ perfil: 'operador', perm_politicas: 'permitir' }).map((m) => m.id)).toContain('politicas-comerciais');

    expect(visibleModules({ perfil: 'operador' }).map((m) => m.id)).not.toContain('catalogos');
    expect(visibleModules({ perfil: 'operador', perm_compartilhar: 'permitir' }).map((m) => m.id)).toContain('catalogos');
    expect(
      visibleModules({ perfil: 'gerente', perm_catalogos: 'negar', perm_compartilhar: 'negar', perm_metricas: 'negar' }).map((m) => m.id)
    ).not.toContain('catalogos');
    expect(visibleModules({ perfil: 'gerente', perm_catalogos: 'negar', perm_metricas: 'permitir' }).map((m) => m.id)).toContain(
      'catalogos'
    );
  });

  it('ERP-05 / UX-03: a área Fiscal concentra documentos, inutilizações, regras e NCM', () => {
    expect(MODULE_AREAS).toContain('Fiscal');
    const fiscal = MODULES.filter((m) => m.area === 'Fiscal').map((m) => m.id);
    expect(fiscal).toEqual([
      'documentos-fiscais',
      'inutilizacoes',
      'regras-fiscais',
      'ncm',
      // FISCAL 3.0 — obrigações acessórias continuam em Fiscal (casa canônica).
      'fiscal-obrigacoes',
      'fiscal-calendario',
    ]);
    expect(MODULES.filter((m) => m.area === 'Vendas').map((m) => m.id)).not.toContain('documentos-fiscais');
    expect(MODULES.filter((m) => m.area === 'Vendas').map((m) => m.id)).not.toContain('regras-fiscais');

    const ncm = MODULES.find((m) => m.id === 'ncm');
    expect(ncm?.resource).toBe('impostos_ncm');
    expect(ncm?.minPerfil).toBe('gerente');
    const inut = MODULES.find((m) => m.id === 'inutilizacoes');
    expect(inut?.resource).toBe('inutilizacoes_fiscais');
    expect(inut?.minPerfil).toBe('gerente');
  });

  it('operador não vê os módulos fiscais restritos a gerente', () => {
    const visiveis = visibleModules({ perfil: 'operador' }).map((m) => m.id);
    expect(visiveis).not.toContain('ncm');
    expect(visiveis).not.toContain('inutilizacoes');
    expect(visiveis).not.toContain('regras-fiscais');
    expect(visiveis).toContain('documentos-fiscais');
  });

  it('registra Commerce (Canais + grupos do COMMERCE OS) e Creators fora do Core, sem planned indevido', () => {
    // O grupo "Multicanal" (roadmap) saiu do menu; o sistema real entrou com
    // 4 grupos operacionais.
    expect(MODULE_GROUPS).toEqual(expect.arrayContaining(['Canais', 'Catálogo', 'Loja e ofertas', 'Operação', 'Inteligência', 'Parcerias e campanhas']));
    expect(MODULE_GROUPS as readonly string[]).not.toContain('Multicanal');
    // "Comercial" continua sendo o grupo da área Vendas (ERP); nenhum módulo
    // do espaço commerce pode reivindicá-lo.
    expect(MODULES.filter((m) => m.space === 'commerce' && m.group === 'Comercial')).toEqual([]);

    const commerceOs = MODULES.filter(
      (m) => m.area === 'Commerce' && ['Catálogo', 'Loja e ofertas', 'Operação', 'Inteligência'].includes(m.group)
    );
    expect(commerceOs.map((m) => m.id)).toEqual([
      'commerce-produtos',
      'commerce-publicacoes',
      'commerce-loja',
      'commerce-promocoes',
      'commerce-cupons',
      'commerce-pedidos',
      'commerce-delivery',
      'commerce-fila',
      'commerce-trends',
    ]);
    // NENHUM módulo commerce permanece "planned" — o sistema está implementado.
    expect(MODULES.filter((m) => m.space === 'commerce' && m.planned?.length)).toEqual([]);
    expect(MODULES.filter((m) => (m.group as string) === 'Multicanal')).toEqual([]);

    const creators = MODULES.filter((m) => m.area === 'Creators');
    expect(creators.map((m) => m.label)).toEqual(['Creators', 'Matches', 'Outreach AI', 'Campanhas']);
    expect(creators.every((m) => !m.planned && m.subgroup === 'Gestão de parcerias')).toBe(true);
  });

  it('sem usuário logado, aplica as mesmas regras de um perfil não-admin/gerente', () => {
    const visiveis = visibleModules(null);
    expect(visiveis.some((m) => m.adminOnly)).toBe(false);
    expect(visiveis.some((m) => m.minPerfil === 'gerente')).toBe(false);
  });

  it('todo módulo pertence a uma Área e a um Grupo declarados com metadados consistentes', () => {
    const orfaosGrupo = MODULES.filter((m) => !(MODULE_GROUPS as readonly string[]).includes(m.group));
    const orfaosArea = MODULES.filter((m) => !(MODULE_AREAS as readonly string[]).includes(m.area));
    expect(orfaosGrupo.map((m) => m.id)).toEqual([]);
    expect(orfaosArea.map((m) => m.id)).toEqual([]);
    for (const g of MODULE_GROUPS) {
      expect(GROUP_META[g]).toBeDefined();
      expect(AREA_META[GROUP_META[g].area].section).toBe(GROUP_META[g].section);
    }
    for (const m of MODULES) {
      expect(GROUP_META[m.group].area).toBe(m.area);
      expect(AREA_META[m.area].section).toBe(m.space);
      expect(m.subgroup.trim().length).toBeGreaterThan(0);
    }
  });

  it('a navegação usa Meu Negócio como porta de entrada gerencial', () => {
    const dash = MODULES.find((m) => m.id === 'dashboard');
    expect(dash?.label).toBe('Meu Negócio');
    expect(dash?.area).toBe('Meu Negócio');
    expect(dash?.group).toBe('Visão do negócio');
    expect(dash?.path).toBe('/');
  });
});

describe('NAV_SECTIONS (fonte única do menu)', () => {
  it('cobre toda área e todo grupo declarados exatamente uma vez, na ordem canônica', () => {
    const areasNasSecoes = NAV_SECTIONS.flatMap((s) => s.areas);
    expect(areasNasSecoes).toEqual([...MODULE_AREAS]);

    const gruposNasSecoes = NAV_SECTIONS.flatMap((s) => s.groups);
    expect(gruposNasSecoes).toEqual([...MODULE_GROUPS]);
  });

  it('cada área e cada grupo pertencem à seção declarada em AREA_META / GROUP_META', () => {
    for (const secao of NAV_SECTIONS) {
      for (const a of secao.areas) expect(AREA_META[a].section).toBe(secao.id);
      for (const g of secao.groups) expect(GROUP_META[g].section).toBe(secao.id);
    }
  });
});

describe('FORM_DIRETO (cadastro em página própria, nunca em modal)', () => {
  it('inclui os cadastros que já vivem em página própria', () => {
    expect([...FORM_DIRETO].sort()).toEqual([
      'categorias',
      'categorias_insumos',
      'clientes',
      'colecoes',
      'cores',
      // FUNDAÇÃO COMERCIAL (MASTER): todos em PÁGINA PRÓPRIA.
      'equipe_membros',
      'equipes_comerciais',
      'fornecedores',
      'grades',
      'insumos',
      'metas',
      'planos_comissao',
      'produtos',
      'regras_comissao',
      'representante_cliente',
      'representante_hierarquia',
      'representantes',
      'tamanhos',
      'terceiros_operacionais',
      'territorios',
      'venda_atribuicao',
      'vendas',
    ]);
  });

  it('Cores entra no padrão LISTA → PÁGINA: inventário e edição vivem no módulo /cores', () => {
    expect(FORM_DIRETO.has('cores')).toBe(true);
    const cores = MODULES.find((m) => m.id === 'cores');
    expect(cores?.path).toBe('/cores');
    // As rotas filhas pertencem ao módulo pai (breadcrumb e acesso usam isso).
    expect(moduleOfPath('/cores')?.id).toBe('cores');
    expect(moduleOfPath('/cores/novo')?.id).toBe('cores');
    expect(moduleOfPath('/cores/12/editar')?.id).toBe('cores');
  });

  it('Coleções entra no padrão LISTA → PÁGINA: cadastro e edição vivem no módulo /colecoes', () => {
    expect(FORM_DIRETO.has('colecoes')).toBe(true);
    const colecoes = MODULES.find((m) => m.id === 'colecoes');
    expect(colecoes?.path).toBe('/colecoes');
    expect(moduleOfPath('/colecoes')?.id).toBe('colecoes');
    expect(moduleOfPath('/colecoes/novo')?.id).toBe('colecoes');
    expect(moduleOfPath('/colecoes/12/editar')?.id).toBe('colecoes');
  });

  it('Tamanhos entra no padrão LISTA → PÁGINA: cadastro e edição vivem no módulo /tamanhos', () => {
    expect(FORM_DIRETO.has('tamanhos')).toBe(true);
    const tamanhos = MODULES.find((m) => m.id === 'tamanhos');
    expect(tamanhos?.path).toBe('/tamanhos');
    expect(moduleOfPath('/tamanhos')?.id).toBe('tamanhos');
    expect(moduleOfPath('/tamanhos/novo')?.id).toBe('tamanhos');
    expect(moduleOfPath('/tamanhos/12/editar')?.id).toBe('tamanhos');
  });

  it('Grades entra no padrão LISTA → PÁGINA: criação e edição vivem no módulo /grades', () => {
    expect(FORM_DIRETO.has('grades')).toBe(true);
    const grades = MODULES.find((m) => m.id === 'grades');
    expect(grades?.path).toBe('/grades');
    // As rotas filhas pertencem ao módulo pai (breadcrumb e acesso usam isso).
    expect(moduleOfPath('/grades')?.id).toBe('grades');
    expect(moduleOfPath('/grades/novo')?.id).toBe('grades');
    expect(moduleOfPath('/grades/12/editar')?.id).toBe('grades');
  });

  it('Insumos entra no padrão LISTA → PÁGINA: criação e edição vivem no módulo /insumos', () => {
    expect(FORM_DIRETO.has('insumos')).toBe(true);
    const insumos = MODULES.find((m) => m.id === 'insumos');
    expect(insumos?.path).toBe('/insumos');
    // As rotas filhas pertencem ao módulo pai (breadcrumb e acesso usam isso).
    expect(moduleOfPath('/insumos')?.id).toBe('insumos');
    expect(moduleOfPath('/insumos/novo')?.id).toBe('insumos');
    expect(moduleOfPath('/insumos/12/editar')?.id).toBe('insumos');
  });

  it('Categorias de Insumos entra no padrão LISTA → PÁGINA: criação e edição vivem no módulo /categorias-insumos', () => {
    expect(FORM_DIRETO.has('categorias_insumos')).toBe(true);
    // O id do módulo usa hífen; o recurso da API usa sublinhado — a rota-base
    // vem do MÓDULO, nunca do nome do recurso.
    const categorias = MODULES.find((m) => m.resource === 'categorias_insumos');
    expect(categorias?.path).toBe('/categorias-insumos');
    expect(moduleOfPath('/categorias-insumos')?.id).toBe('categorias-insumos');
    expect(moduleOfPath('/categorias-insumos/novo')?.id).toBe('categorias-insumos');
    expect(moduleOfPath('/categorias-insumos/12/editar')?.id).toBe('categorias-insumos');
  });

  it('Fornecedores entra no padrão LISTA → PÁGINA: cadastro e edição vivem no módulo /fornecedores (nunca em modal)', () => {
    expect(FORM_DIRETO.has('fornecedores')).toBe(true);
    const fornecedores = MODULES.find((m) => m.id === 'fornecedores');
    expect(fornecedores?.path).toBe('/fornecedores');
    // As rotas filhas pertencem ao módulo pai (breadcrumb e acesso usam isso).
    expect(moduleOfPath('/fornecedores')?.id).toBe('fornecedores');
    expect(moduleOfPath('/fornecedores/novo')?.id).toBe('fornecedores');
    expect(moduleOfPath('/fornecedores/12/editar')?.id).toBe('fornecedores');
  });

  it('Representantes entra no padrão LISTA → PÁGINA: cadastro e edição vivem no módulo /representantes (nunca em modal)', () => {
    expect(FORM_DIRETO.has('representantes')).toBe(true);
    const representantes = MODULES.find((m) => m.id === 'representantes');
    expect(representantes?.path).toBe('/representantes');
    // As rotas filhas pertencem ao módulo pai (breadcrumb e acesso usam isso).
    expect(moduleOfPath('/representantes')?.id).toBe('representantes');
    expect(moduleOfPath('/representantes/novo')?.id).toBe('representantes');
    expect(moduleOfPath('/representantes/12/editar')?.id).toBe('representantes');
  });

  it('cada recurso de FORM_DIRETO tem um módulo navegável na mesma rota', () => {
    for (const recurso of FORM_DIRETO) {
      // O recurso da API pode não coincidir com o id do módulo (ex.:
      // `categorias_insumos` → módulo `categorias-insumos`), então casamos pelo
      // campo `resource` do módulo.
      const m = MODULES.find((x) => x.resource === recurso);
      expect(m, `${recurso} precisa de módulo no menu`).toBeTruthy();
      expect(moduleOfPath(m!.path)?.id).toBe(m!.id);
    }
  });
});

describe('moduleOfPath (regra única de rota → módulo)', () => {
  it('casa a rota exata e as rotas filhas com o módulo dono', () => {
    expect(moduleOfPath('/')?.id).toBe('dashboard');
    expect(moduleOfPath('/documentos-fiscais')?.id).toBe('documentos-fiscais');
    expect(moduleOfPath('/produtos/12')?.id).toBe('produtos');
    expect(moduleOfPath('/vendas/7')?.id).toBe('vendas');
    expect(moduleOfPath('/ordens/45')?.id).toBe('ordens');
    expect(moduleOfPath('/fichas/9')?.id).toBe('fichas');
    expect(moduleOfPath('/compras/3')?.id).toBe('compras');
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

describe('PR #95 — auditoria de capacidades (menu × árvore)', () => {
  it('muda o label principal de Produção para "Ordens de Produção" (rota e recurso preservados)', () => {
    const ordens = MODULES.find((m) => m.id === 'ordens');
    expect(ordens?.label).toBe('Ordens de Produção');
    expect(ordens?.path).toBe('/ordens');
    expect(ordens?.resource).toBe('ordens');
    expect(ordens?.area).toBe('Produção');
    expect(ordens?.group).toBe('Execução');
    expect(ordens?.subgroup).toBe('Ordens de produção');
  });

  it('adiciona a capacidade "Contagem Cíclica ABC" sob Estoque & Suprimentos → Estoque', () => {
    const ciclo = MODULES.find((m) => m.id === 'contagem-ciclica-abc');
    expect(ciclo?.label).toBe('Contagem Cíclica ABC');
    expect(ciclo?.area).toBe('Estoque & Suprimentos');
    expect(ciclo?.group).toBe('Estoque');
    expect(ciclo?.subgroup).toBe('Contagem cíclica');
    expect(ciclo?.path).toBe('/contagem-ciclica-abc');
    expect(ciclo?.resource).toBe('inventarios');
    expect(ciclo?.minPerfil).toBe('gerente');
    expect(ciclo?.description).toBeTruthy();
    expect(ciclo?.keywords).toContain('abc');
    expect(PAGES_ESPECIAIS).toContain('contagem-ciclica-abc');
    expect(MODULOS_PAGINA_PROPRIA).toContain('contagem-ciclica-abc');
  });

  it('a capacidade é descoberta pelo Command Palette (via MODULES) e pelo breadcrumb', () => {
    // Command Palette e Breadcrumb derivam de MODULES/moduleOfPath.
    const ciclo = MODULES.find((m) => m.id === 'contagem-ciclica-abc')!;
    expect(moduleOfPath(ciclo.path)?.id).toBe('contagem-ciclica-abc');
    expect(moduleOfPath('/contagem-ciclica-abc')).toBeDefined();
    expect(MODULES.filter((m) => m.group === 'Estoque').some((m) => m.id === 'contagem-ciclica-abc')).toBe(true);
  });

  it('RBAC da capacidade: gerente descobre, operador não', () => {
    expect(visibleModules({ perfil: 'gerente' }).map((m) => m.id)).toContain('contagem-ciclica-abc');
    expect(visibleModules({ perfil: 'admin' }).map((m) => m.id)).toContain('contagem-ciclica-abc');
    expect(visibleModules({ perfil: 'operador' }).map((m) => m.id)).not.toContain('contagem-ciclica-abc');
  });

  it('nenhuma rota operacional fica órfã: toda rota de módulo tem módulo dono', () => {
    const rotas = MODULES.map((m) => m.path);
    for (const rota of rotas) {
      expect(moduleOfPath(rota), `rota ${rota} precisa de módulo dono`).toBeDefined();
    }
  });
});
