// ============================================================================
// AUDITORIA DE CAPACIDADES — reconciliação CAPACIDADE → API → RESOURCE →
// TABELA → PÁGINA → ROTA → MENU → RBAC → TENANCY → TESTE
// ----------------------------------------------------------------------------
// Fonte única de verdade dos MÓDULOS continua sendo `client/src/modules.ts`
// (MODULES). Este mecanismo NÃO cria uma segunda fonte de verdade: ele declara,
// em `docs/ERP-3.0-CAPACITIES.json`, as CAPACIDADES operacionais (módulo,
// submódulo, detalhe de documento, ação e infraestrutura) e as reconcilia
// contra o que o código realmente implementa.
//
// Tipos de capacidade (seção 7):
//   A `modulo`     — módulo principal (ex.: Inventário)
//   B `submodulo`  — capacidade operacional (ex.: Contagem Cíclica ABC)
//   C `detalhe`    — detalhe de documento (ex.: execuções de uma obrigação)
//   D `acao`       — ação (ex.: registrar entrega, nova cotação)
//   E `infra`      — infraestrutura (healthcheck, webhook, callback OAuth)
//   Infraestrutura NUNCA é módulo de produto.
//
// Uso (via auditar-menu.ts):  npm run audit:menu
// Como módulo: import { auditarCapacidades } from './capacidades-audit';
// ============================================================================
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, PAGES_ESPECIAIS, type Module } from '../client/src/modules';
import { RESOURCES } from '../server/src/resources';

export type CapacidadeTipo = 'modulo' | 'submodulo' | 'detalhe' | 'acao' | 'infra';

export type Capacidade = {
  id: string;
  label: string;
  tipo: CapacidadeTipo;
  /** módulo pai (para submodulo/detalhe/acao). */
  parente?: string;
  /** recurso da API, quando a capacidade opera sobre um CRUD. */
  recurso?: string;
  /** tabela canônica do domínio (fonte de verdade SQL). */
  tabela?: string;
  /** rota própria, quando a capacidade tem página. */
  rota?: string;
  /** a capacidade aparece na árvore de navegação? */
  menu: boolean;
  /** perfil mínimo coerente com o servidor. */
  rbac?: 'operador' | 'gerente' | 'admin';
  /** obrigatório quando menu === false. */
  justificativa?: string;
  /** teste de regressão da capacidade. */
  teste?: string;
};

export type CapacidadeAchado = { nivel: 'ERRO' | 'AVISO'; regra: string; mensagem: string };

export type CapacidadeRegistro = {
  versao: string;
  capacidades: Capacidade[];
  /** recursos operacionais que não são telas (sub-recursos/infra) — com o motivo. */
  recursos_sem_dono_permitido?: Record<string, string>;
};

const raizPadrao = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(e)) walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** Tabelas realmente presentes em db/schema.sql + db/migrations. */
export function coletarTabelas(raiz = raizPadrao): Set<string> {
  const tabelas = new Set<string>();
  const fontes = [readFileSync(path.join(raiz, 'db', 'schema.sql'), 'utf8'), ...readdirSync(path.join(raiz, 'db', 'migrations')).sort().map((f) => readFileSync(path.join(raiz, 'db', 'migrations', f), 'utf8'))];
  for (const sql of fontes) {
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)) tabelas.add(m[1]);
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) tabelas.add(m[1]);
  }
  return tabelas;
}

/** Rotas explícitas declaradas em App.tsx (`<Route path="..." />`). */
export function coletarRotasExplicitas(raiz = raizPadrao): Set<string> {
  const appSrc = readFileSync(path.join(raiz, 'client', 'src', 'App.tsx'), 'utf8');
  const rotas = new Set<string>();
  for (const m of appSrc.matchAll(/<Route\s+(?:index\s+)?path="([^"]+)"/g)) {
    rotas.add(m[1].startsWith('/') ? m[1] : '/' + m[1]);
  }
  if (/<Route\s+index\s+element/.test(appSrc)) rotas.add('/');
  return rotas;
}

/**
 * Aplica a auditoria de capacidades e devolve achados + contadores.
 * `registro` pode ser um objeto equivalente para testes de gate negativo.
 */
export function auditarCapacidades(
  registro: CapacidadeRegistro,
  raiz = raizPadrao,
  opts: { modulos?: Module[] } = {}
): {
  erros: CapacidadeAchado[];
  avisos: CapacidadeAchado[];
  contadores: Record<string, number>;
} {
  const erros: CapacidadeAchado[] = [];
  const avisos: CapacidadeAchado[] = [];
  const erro = (regra: string, mensagem: string) => erros.push({ nivel: 'ERRO', regra, mensagem });
  const aviso = (regra: string, mensagem: string) => avisos.push({ nivel: 'AVISO', regra, mensagem });

  const modulos = opts.modulos ?? MODULES;
  const tabelas = coletarTabelas(raiz);
  const rotasExplicitas = coletarRotasExplicitas(raiz);
  const porId = new Map(modulos.map((m) => [m.id, m] as const));
  const recursosPermitidosSemDono = new Set(Object.keys(registro.recursos_sem_dono_permitido ?? {}));

  // Módulos que o ModulePage trata com página especializada (`module.id === 'x'`).
  const mpSrc = readFileSync(path.join(raiz, 'client', 'src', 'pages', 'ModulePage.tsx'), 'utf8');
  const mpBranches = new Set([...mpSrc.matchAll(/module\.id === '([^']+)'/g)].map((m) => m[1]));
  // Módulos cuja rota é declarada diretamente no App.tsx (não passa pelo
  // ModulePage): raiz ("/" → Dashboard) e Configurações ("/config" → Settings).
  const MODULOS_PAGINA_DIRETA = new Set(['dashboard', 'config']);

  for (const cap of registro.capacidades) {
    // ------------------------------------------------------------------
    // 1. CAPACIDADE → MENU (capacidade operacional precisa de entrada navegável)
    // ------------------------------------------------------------------
    if (cap.menu && cap.tipo !== 'infra') {
      const mod: Module | undefined = porId.get(cap.id) ?? modulos.find((m) => m.path === cap.rota);
      if (!mod) {
        erro('CAPACIDADE_SEM_MENU', `A capacidade "${cap.label}" (${cap.id}) declara menu:true mas não tem módulo na árvore MODULES — fica fora da navegação.`);
      } else {
        if (cap.rota && mod.path !== cap.rota) {
          erro('CAPACIDADE_ROTA_DIFERENTE', `A capacidade "${cap.id}" declara a rota "${cap.rota}", mas o módulo "${mod.id}" usa "${mod.path}".`);
        }
        if (cap.rbac && cap.rbac !== 'operador') {
          const esperado = cap.rbac === 'gerente' ? ['gerente', 'admin'] : ['admin'];
          if (!esperado.includes(mod.minPerfil ?? 'operador')) {
            erro('CAPACIDADE_RBAC_DIFERENTE', `A capacidade "${cap.id}" espera RBAC ${cap.rbac}, mas o módulo declara ${mod.minPerfil ?? 'operador'}.`);
          }
        }
        // ROTA → PÁGINA: toda rota operacional deve ter uma página válida.
        const temPagina =
          PAGES_ESPECIAIS.includes(mod.id) ||
          MODULOS_PAGINA_DIRETA.has(mod.id) ||
          mod.connector != null ||
          (mod.planned?.length ?? 0) > 0 ||
          mpBranches.has(mod.id) ||
          !!mod.resource;
        if (!temPagina) {
          erro('ROTA_SEM_PAGINA', `A rota "${mod.path}" do módulo "${mod.id}" não possui página válida no ModulePage.`);
        }
      }
    }

    // ------------------------------------------------------------------
    // 2. INFRAESTRUTURA não é módulo de produto
    // ------------------------------------------------------------------
    if (cap.tipo === 'infra' && cap.menu) {
      erro('INFRA_NO_MENU', `A capacidade de infraestrutura "${cap.id}" não pode aparecer no menu de módulos.`);
    }

    // ------------------------------------------------------------------
    // 3. menu:false exige justificativa formal
    // ------------------------------------------------------------------
    if (!cap.menu && !cap.justificativa) {
      erro('CAPACIDADE_SEM_JUSTIFICATIVA', `A capacidade "${cap.id}" não aparece no menu e não tem justificativa.`);
    }

    // ------------------------------------------------------------------
    // 4. CAPACIDADE → RECURSO (API) e → TABELA (SQL)
    // ------------------------------------------------------------------
    if (cap.recurso && !RESOURCES[cap.recurso]) {
      erro('CAPACIDADE_RECURSO_INVALIDO', `A capacidade "${cap.id}" declara o recurso "${cap.recurso}", que não existe em server/src/resources.ts.`);
    }
    if (cap.tabela && !tabelas.has(cap.tabela)) {
      erro('CAPACIDADE_TABELA_INVALIDA', `A capacidade "${cap.id}" declara a tabela "${cap.tabela}", que não existe em db/schema.sql nem em db/migrations.`);
    }

    // ------------------------------------------------------------------
    // 5. ROTA → PÁGINA (rota própria precisa existir)
    // ------------------------------------------------------------------
    if (cap.rota) {
      const existe =
        rotasExplicitas.has(cap.rota) ||
        // rota gerada pelo CRUD genérico (/recurso/novo, /recurso/:id/editar)
        /^\/[^/]+\/(novo|editar)$/.test(cap.rota) ||
        /^\/[^/]+\/:id(\/editar)?$/.test(cap.rota) ||
        // rota de módulo gerada a partir de MODULES
        MODULES.some((m) => m.path === cap.rota);
      if (!existe) {
        erro('ROTA_SEM_PAGINA', `A capacidade "${cap.id}" declara a rota "${cap.rota}", que não existe no App.tsx nem é gerada por MODULES.`);
      }
    }

    // ------------------------------------------------------------------
    // 6. CAPACIDADE → TESTE
    // ------------------------------------------------------------------
    if (cap.teste && !existsSync(path.join(raiz, cap.teste))) {
      aviso('CAPACIDADE_SEM_TESTE', `A capacidade "${cap.id}" declara o teste "${cap.teste}", que não existe.`);
    }
  }

  // ------------------------------------------------------------------
  // 7. RECURSO → CAPACIDADE (resource operacional sem dono falha)
  // ------------------------------------------------------------------
  const capacidadesComRecurso = new Set(registro.capacidades.map((c) => c.recurso).filter(Boolean) as string[]);
  for (const r of Object.values(RESOURCES)) {
    if (r.internal) continue;
    if (recursosPermitidosSemDono.has(r.key)) continue;
    if (capacidadesComRecurso.has(r.key)) continue;
    if (modulos.some((m) => m.resource === r.key)) continue;
    erro('RECURSO_SEM_DONO', `O recurso operacional "${r.key}" (${r.label}) não é referência de nenhuma capacidade nem módulo — sem dono funcional.`);
  }

  // ------------------------------------------------------------------
  // 8. MÓDULO planned com implementação funcional (regressão do PR #94)
  // ------------------------------------------------------------------
  for (const m of modulos) {
    if (!m.planned?.length) continue;
    const temBackend = !!m.resource && !!RESOURCES[m.resource];
    const temPaginaPropria = !!m.connector || (PAGES_ESPECIAIS as readonly string[]).includes(m.id);
    if (temBackend || temPaginaPropria) {
      erro('PLANNED_OBSOLETO', `O módulo "${m.id}" está marcado "planned" mas já tem ${temBackend ? `recurso de API (${m.resource})` : 'página própria'} — remova a marcação.`);
    }
  }

  const contadores = {
    capacidades: registro.capacidades.length,
    capacidades_menu: registro.capacidades.filter((c) => c.menu).length,
    capacidades_infra: registro.capacidades.filter((c) => c.tipo === 'infra').length,
    apis: Object.keys(RESOURCES).length,
    recursos_sem_dono_permitidos: recursosPermitidosSemDono.size,
    tabelas: tabelas.size,
    rotas: rotasExplicitas.size,
    modulos: modulos.length,
  };
  return { erros, avisos, contadores };
}

/** Carrega o registro canônico de capacidades. */
export function carregarRegistro(raiz = raizPadrao): CapacidadeRegistro {
  const json = JSON.parse(readFileSync(path.join(raiz, 'docs', 'ERP-3.0-CAPACITIES.json'), 'utf8')) as CapacidadeRegistro;
  return json;
}
