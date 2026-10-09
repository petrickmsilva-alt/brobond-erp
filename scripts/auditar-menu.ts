// ============================================================================
// AUDITORIA AUTOMÁTICA DE MENU × ROTAS × RECURSOS × PERMISSÕES × MULTIEMPRESA
// ----------------------------------------------------------------------------
// Especificação, seção 27: depois de implementar, é preciso COMPROVAR que
//   • nenhum item de menu aponta para rota inexistente;
//   • nenhuma rota fica sem autorização;
//   • nenhuma funcionalidade implementada fica sem entrada navegável quando
//     deveria ser navegável;
//   • nenhum módulo já implementado continua marcado como `planned`;
//   • nenhuma tabela com `empresa_id` fica fora do escopo do recurso.
//
// As fontes lidas aqui são as mesmas usadas em produção — nada é
// re-implementado:
//   client/src/modules.ts    → MODULES, MODULE_GROUPS, GROUP_META
//   client/src/App.tsx       → rotas (explícitas + geradas a partir de MODULES)
//   client/src/**/*.tsx      → recursos que o front realmente consome
//   server/src/resources.ts  → RESOURCES (RBAC: minPerfil / adminOnly / ops)
//   server/src/index.ts      → onde o requireAuth global é instalado
//   db/schema.sql + db/migrations/*.sql → colunas `empresa_id` reais
//
// Uso:  npm run audit:menu
// Saída: relatório no stdout; exit 1 quando há ERRO (bloqueia PR), exit 0 com
// avisos classificados.
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_META, MODULES, MODULE_GROUPS, PAGES_ESPECIAIS } from '../client/src/modules';
import { RESOURCES } from '../server/src/resources';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...p: string[]) => readFileSync(path.join(raiz, ...p), 'utf8');

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

type Achado = { nivel: 'ERRO' | 'AVISO'; regra: string; mensagem: string };
const achados: Achado[] = [];
const erro = (regra: string, mensagem: string) => achados.push({ nivel: 'ERRO', regra, mensagem });
const aviso = (regra: string, mensagem: string) => achados.push({ nivel: 'AVISO', regra, mensagem });

// ---------------------------------------------------------------------------
// 1. Menu → rota (client/src/App.tsx)
// ---------------------------------------------------------------------------
const appSrc = ler('client', 'src', 'App.tsx');

/**
 * Rotas declaradas com <Route path="..." />. Dentro do layout o path é relativo
 * ("config"), nas rotas de topo é absoluto ("/login").
 */
const rotasExplicitas = new Set<string>(
  [...appSrc.matchAll(/<Route\s+(?:index\s+)?path="([^"]+)"/g)].map((m) => (m[1].startsWith('/') ? m[1] : '/' + m[1]))
);
if (/<Route\s+index\s+element/.test(appSrc)) rotasExplicitas.add('/'); // Meu Negócio (rota raiz)

/** O App.tsx gera uma rota para cada módulo, exceto a raiz e as tratadas à mão. */
const geraRotaParaModulo = /MODULES\.filter\(\(m\) => m\.path !== '\/' && m\.id !== 'config'\)/.test(appSrc);

const pathsVistos = new Map<string, string>();
for (const m of MODULES) {
  if (pathsVistos.has(m.path)) {
    erro('MENU_DUP', `Dois módulos apontam para a mesma rota "${m.path}": "${pathsVistos.get(m.path)}" e "${m.id}".`);
  }
  pathsVistos.set(m.path, m.id);

  const rotaExiste =
    rotasExplicitas.has(m.path) ||
    (m.id === 'config' && rotasExplicitas.has('/config')) ||
    (geraRotaParaModulo && m.path !== '/' && m.id !== 'config');
  if (!rotaExiste) erro('MENU_ROTA', `O módulo "${m.id}" aponta para a rota "${m.path}", que não existe no App.tsx.`);
}

// Uma rota absoluta que não é de módulo só é alcançável por link direto — não é
// erro (login, convite, portal, catálogo público), mas fica registrado.
const ROTAS_DE_TOPO_ESPERADAS = new Set(['/', '/login', '/esqueci', '/dev/componentes']);
for (const rota of rotasExplicitas) {
  if (/:|\*/.test(rota) || ROTAS_DE_TOPO_ESPERADAS.has(rota)) continue;
  if (!MODULES.some((m) => m.path === rota)) {
    aviso('ROTA_SEM_MENU', `A rota "${rota}" existe mas nenhum módulo do menu aponta para ela (acesso só por link direto).`);
  }
}

// ---------------------------------------------------------------------------
// 2. Menu → grupo (arquitetura de navegação)
// ---------------------------------------------------------------------------
const gruposDeclarados = new Set<string>(MODULE_GROUPS);
for (const m of MODULES) {
  if (m.group === null) continue;
  if (!gruposDeclarados.has(m.group)) erro('MENU_GRUPO', `O módulo "${m.id}" usa o grupo "${m.group}", que não está em MODULE_GROUPS.`);
}
for (const g of MODULE_GROUPS) {
  if (!GROUP_META[g]) erro('MENU_META', `O grupo "${g}" está em MODULE_GROUPS mas não tem GROUP_META (ícone/seção da Sidebar).`);
  if (!MODULES.some((m) => m.group === g)) aviso('MENU_GRUPO_VAZIO', `O grupo "${g}" está declarado mas não tem nenhum módulo — aparece vazio na Sidebar.`);
}

// ---------------------------------------------------------------------------
// 3. Menu → recurso da API + RBAC (client × server)
// ---------------------------------------------------------------------------
/**
 * `checkAccess` (server/src/services.ts) NÃO aplica `minPerfil` a estes dois
 * recursos: a alçada deles vem das permissões comerciais por usuário
 * (`perm_catalogos`, `perm_politicas`), que o menu já replica em
 * `visibleModules`. Replicar a exceção aqui evita falso positivo.
 */
const ALCADA_POR_PERMISSAO_COMERCIAL = new Set(['catalogos', 'politicas_comerciais']);

for (const m of MODULES) {
  if (!m.resource) continue;
  const r = RESOURCES[m.resource];
  if (!r) {
    erro('MENU_RECURSO', `O módulo "${m.id}" declara o recurso "${m.resource}", que não existe em server/src/resources.ts — a API responderia 404.`);
    continue;
  }
  if (r.internal) erro('MENU_INTERNO', `O módulo "${m.id}" expõe o recurso interno "${m.resource}" (marcado internal: não deve aparecer no menu).`);

  const exigeAdmin = !!r.adminOnly || r.minPerfil === 'admin';
  const exigeGerente = r.minPerfil === 'gerente' && !r.adminOnly && !ALCADA_POR_PERMISSAO_COMERCIAL.has(r.key);
  const declaraAdmin = !!m.adminOnly || m.minPerfil === 'admin';
  const declaraGerente = m.minPerfil === 'gerente' && !m.adminOnly;

  if (exigeAdmin && !declaraAdmin) {
    erro('RBAC_DERIVA_ADMIN', `O recurso "${r.key}" é adminOnly/minPerfil=admin no servidor, mas o módulo "${m.id}" não declara adminOnly — operador e gerente veem o menu e recebem 403.`);
  } else if (exigeGerente && !declaraGerente && !declaraAdmin) {
    erro('RBAC_DERIVA_GERENTE', `O recurso "${r.key}" exige minPerfil=gerente no servidor, mas o módulo "${m.id}" não declara minPerfil — o operador vê o menu e recebe 403.`);
  } else if (!exigeAdmin && !exigeGerente && (declaraAdmin || declaraGerente)) {
    aviso('RBAC_DERIVA_SOLTA', `O módulo "${m.id}" restringe o menu (${declaraAdmin ? 'adminOnly' : 'minPerfil=' + m.minPerfil}) mas o recurso "${r.key}" não restringe no servidor — a API continua acessível por outro caminho.`);
  }
}

// ---------------------------------------------------------------------------
// 4. `planned` só para o que realmente não existe
// ---------------------------------------------------------------------------
for (const m of MODULES) {
  if (!m.planned?.length) continue;
  const temBackend = !!m.resource && !!RESOURCES[m.resource];
  const temPaginaPropria = !!m.connector || (PAGES_ESPECIAIS as readonly string[]).includes(m.id);
  if (temBackend || temPaginaPropria) {
    erro('PLANNED_OBSOLETO', `O módulo "${m.id}" está marcado como "planned" mas já tem ${temBackend ? `recurso de API (${m.resource})` : 'página própria'} — remova a marcação.`);
  }
}

// ---------------------------------------------------------------------------
// 5. Multiempresa — tabela com empresa_id × escopo declarado no recurso
// ---------------------------------------------------------------------------
const tabelasComEmpresaId = new Set<string>();
const sqlFontes = [ler('db', 'schema.sql'), ...readdirSync(path.join(raiz, 'db', 'migrations')).sort().map((f) => ler('db', 'migrations', f))];
for (const sql of sqlFontes) {
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+empresa_id/gi)) tabelasComEmpresaId.add(m[1]);
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    if (/^\s*empresa_id\b/m.test(m[2])) tabelasComEmpresaId.add(m[1]);
  }
}
for (const r of Object.values(RESOURCES)) {
  if (r.empresa && !tabelasComEmpresaId.has(r.table)) {
    erro('EMPRESA_SEM_COLUNA', `O recurso "${r.key}" declara empresa: true mas a tabela "${r.table}" não tem coluna empresa_id em db/schema.sql nem em db/migrations — o filtro por empresa falharia.`);
  }
}

/**
 * Tabelas em que `empresa_id` NÃO é dimensão de filtro do CRUD genérico, com o
 * motivo — e não descuido:
 *   • usuarios ............ usuário é global; o acesso a empresas vem de
 *                           `usuario_empresas` (concessões). Filtrar a lista
 *                           por `usuarios.empresa_id` esconderia quem tem
 *                           acesso concedido a outra empresa.
 *   • usuario_empresas .... É a própria tabela de concessões (empresa_id é a
 *                           chave do vínculo, não um recorte).
 *   • empresa_fiscal_config  Uma linha por empresa, `internal` + adminOnly,
 *                           lida por `fiscal.ts` com filtro explícito.
 *   • empresas ............ A entidade empresa em si.
 */
const EMPRESA_ID_NAO_E_FILTRO = new Set(['usuarios', 'usuario_empresas', 'empresa_fiscal_config', 'empresas']);

const recursosPorTabela = new Map(Object.values(RESOURCES).map((r) => [r.table, r] as const));
for (const tabela of tabelasComEmpresaId) {
  const r = recursosPorTabela.get(tabela);
  if (r && !r.empresa && !r.internal && !EMPRESA_ID_NAO_E_FILTRO.has(tabela)) {
    erro('COLUNA_SEM_ESCOPO', `A tabela "${tabela}" tem empresa_id mas o recurso "${r.key}" não declara empresa: true — a listagem não filtraria por empresa.`);
  }
}

// ---------------------------------------------------------------------------
// 6. Rotas do servidor × autorização
// ---------------------------------------------------------------------------
const indexSrc = ler('server', 'src', 'index.ts');
const linhaAuth = indexSrc.split('\n').findIndex((l) => /app\.use\('\/api',\s*wrap\(requireAuth\)\)/.test(l));
if (linhaAuth < 0) {
  erro('AUTH_GLOBAL', 'O middleware global app.use("/api", requireAuth) não foi encontrado no server/src/index.ts.');
} else {
  const antes = indexSrc.split('\n').slice(0, linhaAuth).join('\n');
  const publicas = [...antes.matchAll(/app\.(?:get|post|put|delete)\(\s*'([^']+)'/g)].map((m) => m[1]);
  const permitidas = [/^\/api\/(health|auth|convites|files|portal|publico)\//];
  for (const p of publicas) {
    if (!permitidas.some((re) => re.test(p))) aviso('ROTA_PUBLICA', `A rota "${p}" é registrada antes do requireAuth global — confirme que é intencionalmente pública.`);
  }
}

// ---------------------------------------------------------------------------
// 7. Recurso de API que nenhum código do front consome
// ---------------------------------------------------------------------------
const recursosConsumidos = new Set<string>();
for (const f of walk(path.join(raiz, 'client', 'src'))) {
  if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/api\.(?:get|post|put|delete|patch|download)\s*(?:<[^>]*>)?\s*\(\s*[`'"]\/?([a-z_][\w]*)/g)) {
    recursosConsumidos.add(m[1]);
  }
  for (const m of src.matchAll(/[`'"]\/api\/([a-z_][\w]*)/g)) recursosConsumidos.add(m[1]);
  // resource: 'x' declarado em modules.ts já é cobertura navegável (CRUD genérico)
  for (const m of src.matchAll(/resource:\s*'([a-z_][\w]*)'/g)) recursosConsumidos.add(m[1]);
}
/**
 * Sub-recursos vivem dentro da tela do pai (itens, eventos, históricos) e
 * tabelas de infraestrutura não são telas. Fora disso, um recurso exposto pela
 * API que o front nunca chama é funcionalidade sem entrada navegável.
 */
const SEM_TELA_PROPRIA = new Set([
  'arquivos', 'grade_tamanhos', 'medida_valores', 'fornecedor_contatos',
  'produto_composicao', 'documentos_fiscais_eventos', 'itens_venda',
  'itens_compra', 'itens_ordem', 'itens_ficha_tecnica', 'itens_inventario',
  'proposta_itens', 'proposta_eventos', 'pdv_pagamentos', 'pdv_caixa_movimentos',
  'envio_eventos', 'expedicao_eventos', 'devolucao_itens',
  'compra_recebimento_itens', 'lista_preco_itens', 'listas_preco_historico',
  'portal_acessos', 'cotacao_decisoes', 'catalogo_compartilhamentos',
  'catalogo_eventos', 'estoque_insumos', 'movimentacoes_insumos',
  'comissoes_eventos', 'gateway_configs', 'gateway_webhook_events',
  'produto_abc', 'produto_fornecedor_skus', 'connector_events',
  'connector_oauth_states', 'sale_items',
]);
const recursosNavegaveis = new Set<string>();
for (const r of Object.values(RESOURCES)) {
  if (r.internal || SEM_TELA_PROPRIA.has(r.key)) continue;
  if (recursosConsumidos.has(r.key)) {
    recursosNavegaveis.add(r.key);
    continue;
  }
  aviso('RECURSO_SEM_MENU', `O recurso "${r.key}" (${r.label}) tem CRUD na API mas nenhum código do front o consome — funcionalidade sem entrada navegável.`);
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const erros = achados.filter((a) => a.nivel === 'ERRO');
const avisos = achados.filter((a) => a.nivel === 'AVISO');

console.log('╭─ AUDITORIA DE MENU × ROTAS × RBAC × MULTIEMPRESA ─────────────────');
console.log(`│ módulos no menu ......... ${MODULES.length}`);
console.log(`│ grupos de navegação ..... ${MODULE_GROUPS.length}`);
console.log(`│ recursos de API ......... ${Object.keys(RESOURCES).length}`);
console.log(`│ recursos navegáveis ..... ${recursosNavegaveis.size}`);
console.log(`│ tabelas com empresa_id .. ${tabelasComEmpresaId.size}`);
console.log(`│ rotas públicas (pré-auth) ${linhaAuth >= 0 ? 'verificadas' : 'NÃO VERIFICADAS'}`);
console.log('╰───────────────────────────────────────────────────────────────────');

if (avisos.length) {
  console.log(`\n⚠️  AVISOS (${avisos.length}) — classificados, não bloqueiam:`);
  for (const a of avisos) console.log(`   [${a.regra}] ${a.mensagem}`);
}
if (erros.length) {
  console.log(`\n❌ ERROS (${erros.length}) — bloqueiam o PR:`);
  for (const a of erros) console.log(`   [${a.regra}] ${a.mensagem}`);
  process.exitCode = 1;
} else {
  console.log('\n✅ Sem erros: menu, rotas, recursos, permissões e escopo por empresa estão coerentes.');
}
