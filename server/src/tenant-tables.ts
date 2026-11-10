// ============================================================================
// CLASSIFICAÇÃO DE TENANCY DAS TABELAS SEM `empresa_id`
//
// Nem toda tabela precisa de `empresa_id`. O erro perigoso é a tabela que
// DEVERIA ter isolamento por empresa e não tem. Este registro torna a decisão
// explícita e verificável: toda tabela sem `empresa_id` precisa declarar POR QUE
// não tem — e um teste de governança trava a completude contra o DDL real
// (server/test/tenant-tables-classificacao.test.ts).
//
// Categorias:
//   'global'        — não pertence a uma empresa (infra ou raiz de tenancy).
//   'referencia'    — catálogo global compartilhado por todas as empresas.
//   'compartilhada' — dado transversal, escopado por outra chave (namespace).
//   'herda-tenant'  — pertence a uma linha tenant-owned via FK; o isolamento
//                     vem do pai (a FK garante a mesma empresa).
//   'projecao'      — read model analítico; herda a empresa da fonte.
//   'legado'        — estrutura antiga mantida por compatibilidade.
// ============================================================================

export type CategoriaTenancy =
  | 'global'
  | 'referencia'
  | 'compartilhada'
  | 'herda-tenant'
  | 'projecao'
  | 'legado';

export type ClassificacaoTenancy = {
  categoria: CategoriaTenancy;
  /** Como o isolamento é garantido (ou por que não se aplica). */
  motivo: string;
  /** Tabela-pai que carrega `empresa_id`, quando o isolamento é herdado. */
  herdaDe?: string;
};

/**
 * Tabelas sem coluna `empresa_id` e a razão arquitetural de cada uma.
 * Fonte da verdade do `TENANT-GOVERNANCE.md`.
 */
export const TABELAS_SEM_EMPRESA_ID: Record<string, ClassificacaoTenancy> = {
  // --- Raiz de tenancy e infraestrutura --------------------------------
  empresas: { categoria: 'global', motivo: 'É a própria tabela de empresas (raiz do tenancy).' },
  sessoes: { categoria: 'global', motivo: 'Sessão de usuário; um usuário pode acessar N empresas (vínculo em usuario_empresas).' },
  login_tentativas: { categoria: 'global', motivo: 'Rate limit de login por chave (IP/usuário), antes de haver tenant.' },
  cron_job_locks: { categoria: 'global', motivo: 'Lock de coordenação de cron; infraestrutura, não dado de negócio.' },
  cron_work_items: { categoria: 'global', motivo: 'Unidade de trabalho de cron; infraestrutura, não dado de negócio.' },

  // --- Compartilhada (escopo por outra chave) --------------------------
  configuracoes: { categoria: 'compartilhada', motivo: 'Chave-valor; o escopo por empresa é feito por namespace de chave (ex.: logistica:empresa:<id>).' },
  arquivos: { categoria: 'compartilhada', motivo: 'Armazenamento polimórfico por (recurso, registro_id); o isolamento é herdado do recurso referenciado.' },

  // --- Catálogos de referência globais ---------------------------------
  tamanhos: { categoria: 'referencia', motivo: 'Catálogo de tamanhos (PP..GG) compartilhado por todas as empresas.' },
  grades: { categoria: 'referencia', motivo: 'Grade de tamanhos, referência global de produto.' },
  grade_tamanhos: { categoria: 'referencia', motivo: 'Junção grade × tamanho; referência global.' },
  medidas: { categoria: 'referencia', motivo: 'Medidas de grade (largura/comprimento), referência global.' },
  medida_valores: { categoria: 'referencia', motivo: 'Valores por medida × tamanho, referência global.' },
  categorias: { categoria: 'referencia', motivo: 'Categoria de produto, referência global compartilhada.' },
  cores: { categoria: 'referencia', motivo: 'Cor de produto, referência global compartilhada.' },
  impostos_ncm: { categoria: 'referencia', motivo: 'Alíquota por NCM: tabela fiscal nacional, igual para todas as empresas.' },
  fiscal_layouts: { categoria: 'referencia', motivo: 'Registro versionado de leiautes SPED/EFD (Fase 9.5): referência nacional por versão/vigência, igual para todas as empresas. Semeada por migração; só leitura.' },

  // --- Isolamento herdado do pai (FK tenant-owned) ---------------------
  catalogo_compartilhamentos: { categoria: 'herda-tenant', motivo: 'FK para catalogos(id), que tem empresa_id.', herdaDe: 'catalogos' },
  catalogo_eventos: { categoria: 'herda-tenant', motivo: 'FK para catalogos(id), que tem empresa_id.', herdaDe: 'catalogos' },
  portal_acessos: { categoria: 'herda-tenant', motivo: 'FK para clientes(id), que tem empresa_id.', herdaDe: 'clientes' },
  cotacao_decisoes: { categoria: 'herda-tenant', motivo: 'FK para vendas(id), que tem empresa_id.', herdaDe: 'vendas' },

  // --- Projeção analítica ----------------------------------------------
  sale_items: { categoria: 'projecao', motivo: 'Itens da projeção analítica `sales`; a empresa vem de sales.empresa_id.', herdaDe: 'sales' },
};

/**
 * Verifica se um conjunto de tabelas sem `empresa_id` está inteiramente
 * classificado. Devolve as tabelas NÃO classificadas (cada uma é um GAP: uma
 * tabela sem `empresa_id` cuja razão de isolamento não foi declarada).
 */
export function tabelasSemClassificacao(tabelasSemEmpresaId: string[]): string[] {
  return tabelasSemEmpresaId.filter((t) => !(t in TABELAS_SEM_EMPRESA_ID)).sort();
}
