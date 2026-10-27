// ============================================================================
// ERP 3.0 — INVENTÁRIO ARQUITETURAL AUTOMÁTICO (`npm run architecture:audit`)
// ----------------------------------------------------------------------------
// Este script é a FONTE OFICIAL DOS NÚMEROS do ERP 3.0. Nada aqui é digitado à
// mão: o inventário é lido do CÓDIGO REAL a cada execução —
//
//   db/schema.sql + db/migrations/*.sql .... tabelas, índices, constraints
//   server/src/resources.ts ............... recursos, escopo, RBAC, ops
//   client/src/modules.ts ................. módulos, áreas, grupos
//   server/src/index.ts ................... rotas HTTP
//   prisma/schema.prisma .................. modelos Prisma (bounded context)
//   server/test + client/src .............. testes (arquivos e casos)
//   modules/ + server/src/modules ......... módulos de integração
//
// Saída:
//   • relatório no stdout;
//   • docs/ERP-3.0-ARCHITECTURE-INVENTORY.json (dados brutos, versionável);
//   • exit 1 quando encontra ERRO de coerência (--check é o padrão, use
//     --no-check para apenas relatar).
//
// Regras verificadas (as mesmas que audit:menu já cobre para o menu, agora
// aplicadas ao inventário inteiro):
//   ERRO  recurso com `empresa: true` cuja tabela não tem `empresa_id`;
//   ERRO  tabela com `empresa_id` cuja listagem não declara escopo de empresa;
//   ERRO  recurso apontando para tabela que não existe no SQL;
//   ERRO  modelo Prisma mapeado para tabela inexistente no SQL do ERP;
//   ERRO  recurso CRM sem `empresa: true` ou sem `minPerfil`;
//   AVISO recurso com `empresa: true` sem teste de isolamento A × B;
//   AVISO tabela com `empresa_id` sem nenhum recurso (fora do CRUD genérico).
// ============================================================================
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES, type Resource } from '../server/src/resources';
import { MODULES, MODULE_GROUPS } from '../client/src/modules';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...p: string[]) => readFileSync(path.join(raiz, ...p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(e)) continue;
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(raiz, p).split(path.sep).join('/');

// ---------------------------------------------------------------------------
// 1. SQL — tabelas, colunas, índices, constraints
// ---------------------------------------------------------------------------
const arquivosSql = [
  'db/schema.sql',
  ...readdirSync(path.join(raiz, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `db/migrations/${f}`),
];

type TabelaSql = { nome: string; colunas: Set<string>; origem: string[]; indices: Set<string>; constraints: Set<string> };
const tabelas = new Map<string, TabelaSql>();
let indicesSql = 0;
let constraintsSql = 0;
const indicesVistos = new Set<string>();
const constraintsVistos = new Set<string>();
const arquivosComTabela = new Set<string>();

/** Remove comentários de linha para não capturar DDL comentada. */
const semComentarios = (sql: string) => sql.replace(/--[^\n]*/g, '');

for (const arquivo of arquivosSql) {
  const sql = semComentarios(ler(...arquivo.split('/')));

  // Blocos CREATE TABLE: do "CREATE TABLE" até o ");" correspondente.
  const regexTabela = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi;
  for (const m of sql.matchAll(regexTabela)) {
    const nome = m[1].toLowerCase();
    const corpo = m[2];
    const t = tabelas.get(nome) ?? { nome, colunas: new Set(), origem: [], indices: new Set(), constraints: new Set() };
    for (const col of corpo.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s+/gim)) t.colunas.add(col[1].toLowerCase());
    t.origem.push(arquivo);
    tabelas.set(nome, t);
    arquivosComTabela.add(arquivo);
  }

  // ALTER TABLE ... ADD COLUMN [IF NOT EXISTS] coluna (uma instrução por vez)
  for (const stmt of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]*?);/gi)) {
    const t = tabelas.get(stmt[1].toLowerCase());
    if (!t) continue;
    for (const col of stmt[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      t.colunas.add(col[1].toLowerCase());
    }
  }

  // Índices nomeados (CREATE [UNIQUE] INDEX [IF NOT EXISTS] nome)
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
    if (!indicesVistos.has(m[1])) {
      indicesVistos.add(m[1]);
      indicesSql++;
    }
  }

  // Constraints nomeadas (ADD CONSTRAINT / CONSTRAINT inline no CREATE TABLE)
  for (const m of sql.matchAll(/(?:ADD\s+)?CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)) {
    if (!constraintsVistos.has(m[1])) {
      constraintsVistos.add(m[1]);
      constraintsSql++;
    }
  }
}

/** Tabelas efetivamente criadas/alteradas pela cadeia versionada. */
const migrationsSql = arquivosSql.length - 1;
const arquivosSqlComAlteracao = arquivosSql.filter((a) => a !== 'db/schema.sql' && ler(...a.split('/')).trim().length > 0);

// ---------------------------------------------------------------------------
// 2. Prisma — modelos e tabelas mapeadas
// ---------------------------------------------------------------------------
const prismaSrc = ler('prisma', 'schema.prisma');
type ModeloPrisma = { modelo: string; tabela: string | null; campos: number; temEmpresa: boolean; temUsuarioTenancy: boolean };
const modelosPrisma: ModeloPrisma[] = [];
for (const m of prismaSrc.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm)) {
  const corpo = m[2];
  const map = corpo.match(/@@map\("([^"]+)"\)/);
  modelosPrisma.push({
    modelo: m[1],
    tabela: map ? map[1] : null,
    campos: [...corpo.matchAll(/^\s{2}([A-Za-z0-9_]+)\s+\S/gm)].length,
    temEmpresa: /^\s{2}empresaId\b/m.test(corpo),
    temUsuarioTenancy: /^\s{2}usuarioId\b/m.test(corpo),
  });
}
const migrationsPrisma = readdirSync(path.join(raiz, 'prisma', 'migrations')).filter((d) =>
  statSync(path.join(raiz, 'prisma', 'migrations', d)).isDirectory()
).length;

// ---------------------------------------------------------------------------
// 3. Recursos (API) — escopo de empresa, RBAC, operações
// ---------------------------------------------------------------------------
const recursos = Object.values(RESOURCES) as Resource[];
const recursoPorTabela = new Map<string, Resource>();
for (const r of recursos) recursoPorTabela.set(r.table ?? r.key, r);

const tenantados = recursos.filter((r) => r.empresa === true);
const recursosComTabela = recursos.filter((r) => !!r.table);
const rbacRestrito = recursos.filter((r) => r.adminOnly || r.minPerfil === 'admin' || r.minPerfil === 'gerente');
const somenteLeitura = recursos.filter((r) => r.ops && !r.ops.create && !r.ops.update && !r.ops.delete);

const COLUNAS_EMPRESA = [...tabelas.entries()]
  .filter(([, t]) => t.colunas.has('empresa_id'))
  .map(([nome]) => nome)
  .sort();

/**
 * Tabelas em que `empresa_id` NÃO é dimensão de filtro do CRUD genérico.
 * Mesma lista (e mesmo motivo) de scripts/auditar-menu.ts.
 */
const TABELAS_SEM_ESCOPO_CRUD = new Set(['usuarios', 'usuario_empresas', 'empresa_fiscal_config', 'empresas', 'auditoria']);

// ---------------------------------------------------------------------------
// 4. Rotas HTTP
// ---------------------------------------------------------------------------
const indexSrc = ler('server', 'src', 'index.ts');
const rotas = [...indexSrc.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => ({
  metodo: m[1].toUpperCase(),
  caminho: m[2],
}));
const rotasPublicas = rotas.filter((r) => /^\/api\/(health|publico|portal|auth|convites|files|print\/agent)/.test(r.caminho));
const routersMontados = [...indexSrc.matchAll(/app\.use\('([^']+)',\s*([A-Za-z0-9_]+)\)/g)].map((m) => ({ base: m[1], router: m[2] }));

// ---------------------------------------------------------------------------
// 5. Módulos de navegação / domínios
// ---------------------------------------------------------------------------
const modulos = MODULES;
const areas = [...new Set(modulos.map((m) => m.area))];
const grupos = MODULE_GROUPS;

// ---------------------------------------------------------------------------
// 6. Testes
// ---------------------------------------------------------------------------
const arquivosTesteServer = walk(path.join(raiz, 'server', 'test')).filter((f) => f.endsWith('.test.ts'));
const arquivosTesteClient = walk(path.join(raiz, 'client', 'src')).filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'));
const contarCasos = (arquivos: string[]) =>
  arquivos.reduce((acc, f) => acc + [...ler(rel(f)).matchAll(/^\s*(?:test|it)\(/gm)].length, 0);
const testesServer = { arquivos: arquivosTesteServer.length, casos: contarCasos(arquivosTesteServer) };
const testesClient = { arquivos: arquivosTesteClient.length, casos: contarCasos(arquivosTesteClient) };

/**
 * Cobertura de isolamento A × B por ARQUIVO de teste.
 *
 * Critério: o arquivo precisa declarar as duas empresas (`escopoDeSistema(1)` e
 * `escopoDeSistema(2)`, ou `empresaB`) E citar o recurso pelo nome da chave.
 * É uma verificação estrutural, não uma prova de execução — o gate real é a
 * suíte (`npm test`). Serve para apontar domínio sem NENHUM teste de tenancy.
 */
const arquivosTesteComDuasEmpresas = arquivosTesteServer.filter((f) => {
  const src = ler(rel(f));
  return /escopoDeSistema\(2\)|empresaB|empresa B/i.test(src) && /escopoDeSistema\(1\)|empresaA|empresa A/i.test(src);
});
const fonteTestesIsolamento = arquivosTesteComDuasEmpresas.map((f) => ler(rel(f))).join('\n');
const testeIsolamento = (r: Resource) => new RegExp(`\\b${r.key}\\b`).test(fonteTestesIsolamento);

// ---------------------------------------------------------------------------
// 7. Integrações (bounded context commerce)
// ---------------------------------------------------------------------------
const arquivosModulos = walk(path.join(raiz, 'modules')).filter((f) => f.endsWith('.ts'));
const arquivosServerModules = walk(path.join(raiz, 'server', 'src', 'modules')).filter((f) => f.endsWith('.ts'));

// ---------------------------------------------------------------------------
// 8. Verificações
// ---------------------------------------------------------------------------
type Achado = { nivel: 'ERRO' | 'AVISO'; regra: string; mensagem: string };
const achados: Achado[] = [];
const erro = (regra: string, mensagem: string) => achados.push({ nivel: 'ERRO', regra, mensagem });
const aviso = (regra: string, mensagem: string) => achados.push({ nivel: 'AVISO', regra, mensagem });

for (const r of recursosComTabela) {
  const t = tabelas.get(r.table!);
  if (!t) {
    erro('RECURSO_SEM_TABELA', `O recurso "${r.key}" aponta para a tabela "${r.table}", que não é criada em db/schema.sql nem em db/migrations.`);
    continue;
  }
  if (r.empresa === true && !t.colunas.has('empresa_id')) {
    erro('EMPRESA_SEM_COLUNA', `O recurso "${r.key}" declara empresa: true, mas "${r.table}" não tem empresa_id.`);
  }
}

for (const tabela of COLUNAS_EMPRESA) {
  if (TABELAS_SEM_ESCOPO_CRUD.has(tabela)) continue;
  const r = recursoPorTabela.get(tabela);
  if (!r) {
    aviso('TABELA_SEM_RECURSO', `A tabela "${tabela}" tem empresa_id, mas nenhum recurso a expõe no CRUD genérico (escopo aplicado por endpoint próprio).`);
    continue;
  }
  if (r.empresa !== true) {
    erro('COLUNA_SEM_ESCOPO', `A tabela "${tabela}" tem empresa_id, mas o recurso "${r.key}" não declara empresa: true — a listagem não filtraria por empresa.`);
  }
}

for (const r of tenantados) {
  if (!testeIsolamento(r)) {
    aviso('TENANT_SEM_TESTE', `O recurso "${r.key}" é multiempresa, mas não há teste de isolamento A × B que o cite nominalmente.`);
  }
}

// CRM 3.0: todo recurso do funil precisa de tenant e de alçada explícita.
const recursosCrm = recursos.filter((r) => r.key.startsWith('crm_'));
for (const r of recursosCrm) {
  if (r.empresa !== true) erro('CRM_SEM_TENANT', `O recurso CRM "${r.key}" não declara empresa: true.`);
  if (!r.adminOnly && !r.minPerfil) erro('CRM_SEM_RBAC', `O recurso CRM "${r.key}" não declara minPerfil nem adminOnly.`);
}

// Prisma: cada modelo mapeado precisa existir no SQL do ERP.
for (const m of modelosPrisma) {
  if (!m.tabela) continue;
  if (!tabelas.has(m.tabela)) {
    erro('PRISMA_TABELA_AUSENTE', `O modelo Prisma "${m.modelo}" mapeia "${m.tabela}", que não existe no SQL do ERP (db/schema.sql + migrations).`);
  }
}

// Prisma: nenhuma tabela pode existir só no Prisma (regra da Fase 3).
const tabelasPrisma = new Set(modelosPrisma.map((m) => m.tabela).filter(Boolean) as string[]);
const tabelasForaDoPrisma = [...tabelas.keys()].filter((t) => !tabelasPrisma.has(t)).sort();

// ---------------------------------------------------------------------------
// 9. Relatório
// ---------------------------------------------------------------------------
const numero = (n: number) => n.toLocaleString('pt-BR');
const coberturaTenant = recursosComTabela.length
  ? (tenantados.length / recursosComTabela.length) * 100
  : 0;

const inventario = {
  gerado_em: new Date().toISOString(),
  fonte_de_verdade_do_schema: 'db/schema.sql + db/migrations/*.sql (PostgreSQL); Prisma = bounded context do commerce',
  migrations: { sql: migrationsSql, sql_com_conteudo: arquivosSqlComAlteracao.length, prisma: migrationsPrisma },
  tabelas: {
    total: tabelas.size,
    com_empresa_id: COLUNAS_EMPRESA.length,
    sem_empresa_id: tabelas.size - COLUNAS_EMPRESA.length,
    fora_do_prisma: tabelasForaDoPrisma.length,
  },
  indices: indicesSql,
  constraints: constraintsSql,
  recursos: {
    total: recursos.length,
    com_tabela: recursosComTabela.length,
    multiempresa: tenantados.length,
    somente_leitura: somenteLeitura.length,
    rbac_restrito: rbacRestrito.length,
    cobertura_tenant_pct: Number(coberturaTenant.toFixed(1)),
  },
  crm: recursosCrm.map((r) => ({ key: r.key, empresa: r.empresa === true, minPerfil: r.minPerfil ?? null, adminOnly: !!r.adminOnly })),
  modulos: {
    total: modulos.length,
    navegaveis: modulos.filter((m) => !m.planned?.length).length,
    planejados: modulos.filter((m) => !!m.planned?.length).length,
    areas: areas.length,
    grupos: grupos.length,
    com_recurso: modulos.filter((m) => !!m.resource).length,
  },
  rotas: {
    total: rotas.length,
    por_metodo: rotas.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.metodo]: (acc[r.metodo] ?? 0) + 1 }), {}),
    publicas_por_desenho: rotasPublicas.length,
    routers_montados: routersMontados,
  },
  prisma: {
    total_modelos: modelosPrisma.length,
    com_empresa_id: modelosPrisma.filter((m) => m.temEmpresa).length,
    com_usuario_id: modelosPrisma.filter((m) => m.temUsuarioTenancy).length,
    modelos: modelosPrisma,
  },
  testes: { server: testesServer, client: testesClient, total: testesServer.casos + testesClient.casos },
  integracoes: { arquivos_modules: arquivosModulos.length, arquivos_server_modules: arquivosServerModules.length },
  achados,
  tabelas_sem_empresa_id: [...tabelas.keys()].filter((t) => !COLUNAS_EMPRESA.includes(t)).sort(),
  tabelas_fora_do_prisma: tabelasForaDoPrisma,
};

console.log('\n┌───────────────────────────────────────────────────────────────────┐');
console.log('│  BROBOND ERP 3.0 — INVENTÁRIO ARQUITETURAL (lido do código)       │');
console.log('└───────────────────────────────────────────────────────────────────┘');
console.log(`│ migrations SQL .......... ${numero(inventario.migrations.sql)}`);
console.log(`│ migrations Prisma ....... ${numero(inventario.migrations.prisma)}`);
console.log(`│ tabelas ................ ${numero(inventario.tabelas.total)} (com empresa_id: ${numero(inventario.tabelas.com_empresa_id)})`);
console.log(`│ índices ................. ${numero(inventario.indices)}`);
console.log(`│ constraints ............. ${numero(inventario.constraints)}`);
console.log(`│ recursos de API ......... ${numero(inventario.recursos.total)} (multiempresa: ${numero(inventario.recursos.multiempresa)})`);
console.log(`│ cobertura de tenant ..... ${inventario.recursos.cobertura_tenant_pct}% dos recursos com tabela`);
console.log(`│ RBAC restrito ........... ${numero(inventario.recursos.rbac_restrito)} recursos`);
console.log(`│ módulos ................. ${numero(inventario.modulos.total)} (áreas: ${inventario.modulos.areas}, grupos: ${inventario.modulos.grupos})`);
console.log(`│ rotas HTTP .............. ${numero(inventario.rotas.total)}`);
// MÉTRICAS SEPARADAS, DE PROPÓSITO:
//   • SQL  → "tabela possui empresa_id" (fonte de verdade do tenant);
//   • Prisma → "modelo tem empresaId" (campo do bounded context commerce).
// Somar as duas num único número esconderia que o Prisma é recorte parcial.
console.log(`│ modelos Prisma .......... ${numero(inventario.prisma.total_modelos)} (com empresaId: ${inventario.prisma.com_empresa_id})`);
console.log(`│ métricas distintas ...... SQL: ${inventario.tabelas.com_empresa_id}/${inventario.tabelas.total} tabelas com empresa_id · Prisma: ${inventario.prisma.com_empresa_id}/${inventario.prisma.total_modelos} modelos com empresaId`);
console.log(`│ testes .................. ${numero(inventario.testes.total)} casos em ${numero(testesServer.arquivos + testesClient.arquivos)} arquivos`);
console.log('└───────────────────────────────────────────────────────────────────┘');

const erros = achados.filter((a) => a.nivel === 'ERRO');
const avisos = achados.filter((a) => a.nivel === 'AVISO');
if (avisos.length) {
  console.log(`\n⚠️  AVISOS (${avisos.length})`);
  for (const a of avisos.slice(0, 20)) console.log(`   [${a.regra}] ${a.mensagem}`);
  if (avisos.length > 20) console.log(`   ... e mais ${avisos.length - 20}.`);
}
if (erros.length) {
  console.log(`\n❌ ERROS (${erros.length})`);
  for (const a of erros) console.log(`   [${a.regra}] ${a.mensagem}`);
} else {
  console.log('\n✅ Sem erros de coerência: recursos × tabelas × tenant × Prisma.');
}

const destino = path.join(raiz, 'docs', 'ERP-3.0-ARCHITECTURE-INVENTORY.json');
writeFileSync(destino, JSON.stringify(inventario, null, 2) + '\n', 'utf8');
console.log(`\n📄 Inventário completo: ${rel(destino)}`);

const check = !process.argv.includes('--no-check');
if (check && erros.length) process.exit(1);
