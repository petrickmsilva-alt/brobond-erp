#!/usr/bin/env node
// ============================================================================
// VERIFICAÇÃO ESTÁTICA DO WORKFLOW DIAGNÓSTICO — sem rede e sem banco.
//
// Lê `.github/workflows/brobond-migracao-producao.yml` e prova, por análise do
// YAML e do texto dos steps, que o executor é EXCLUSIVAMENTE diagnóstico:
//
//   • YAML válido e gatilho único `workflow_dispatch`;
//   • permissão mínima (`contents: read`, nada de escrita);
//   • environment ISOLADO `migration-diagnostic` (nunca `production`) e branch de execução restrita;
//   • concorrência e timeout declarados;
//   • Node compatível com o projeto e instalação reproduzível (`npm ci`);
//   • `secrets.DATABASE_URL` injetado SOMENTE no step que abre a conexão;
//   • nenhum comando destrutivo (SQL de escrita, migração, saneamento, carga);
//   • nenhum step imprime segredo nem despeja o ambiente;
//   • actions fixadas por versão (nunca `@main`).
//
// Uso: node scripts/verificar-workflow-diagnostico.mjs [caminho-do-workflow]
// Sai com código ≠ 0 quando qualquer verificação reprova.
// ============================================================================
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BRANCH_AUTORIZADA = 'ops/workflow-migracao-producao-diagnostico';
export const WORKFLOW_PADRAO = '.github/workflows/brobond-migracao-producao.yml';
export const NODE_COMPATIVEL = '24';
/** Environment ISOLADO da homologação. O de `production` NÃO pode ser usado aqui. */
export const ENVIRONMENT_AUTORIZADO = 'migration-diagnostic';
/** Environment que o workflow JAMAIS deve usar (isola a homologação do de produção). */
export const ENVIRONMENT_PROIBIDO = 'production';

// Assinaturas REAIS de operação que altera o banco — o veredito é sobre o que o
// step EXECUTA, não sobre palavras soltas na prosa. `SELECT`, `pg_catalog`,
// `current_setting`, `to_regclass` e `pg_stat_ssl` são permitidos.
const PADROES_DESTRUTIVOS = [
  { nome: 'SQL de escrita', re: /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE)\b/ },
  { nome: 'migração Prisma', re: /prisma\s+migrate|\bdb:deploy\b|\bmigrate\s+(?:deploy|dev|reset)\b/ },
  { nome: 'cadeia de migrações SQL', re: /db\/(?:migrations|bootstrap\.sql|schema\.sql)/ },
  { nome: 'saneamento go-live', re: /saneamento-go-live|LIMPAR-HOMOLOGACAO/ },
  { nome: 'carga cadastral', re: /carga\/politica|carga-politica|cargaPolitica|cargaPoliticaComercial/ },
  { nome: 'restauração/escrita de dump', re: /pg_restore|\bpsql\b/ },
];

// Padrões que expõem segredo ou o ambiente inteiro nos logs.
const PADROES_EXPOSICAO = [
  { nome: 'despejo de ambiente', re: /(?:^|[\s;&|])(?:printenv|env)(?:\s|$)/m },
  { nome: 'trace do shell', re: /set\s+-[a-z]*x/i },
  { nome: 'objeto de segredos', re: /toJSON\(\s*secrets\s*\)|secrets\s*\|\s*toJSON/i },
  { nome: 'impressão da credencial', re: /echo[^\n]*\$(?:\{)?DATABASE_URL/i },
];

function lerYaml() {
  try {
    return require('js-yaml');
  } catch (e) {
    throw new Error(`js-yaml indisponível — instale as dependências (npm ci): ${e.message}`);
  }
}

function stepsDoWorkflow(doc) {
  const jobs = doc?.jobs ?? {};
  const lista = [];
  for (const [id, job] of Object.entries(jobs)) {
    for (const step of job?.steps ?? []) lista.push({ job: id, step });
  }
  return lista;
}

/**
 * Verifica o conteúdo do workflow. Função pura: recebe o texto, devolve as
 * checagens. Não acessa disco, rede nem banco.
 */
export function verificarWorkflow(texto, { branch = BRANCH_AUTORIZADA, nodeCompativel = NODE_COMPATIVEL, environment = ENVIRONMENT_AUTORIZADO } = {}) {
  const checagens = [];
  const registrar = (nome, ok, detalhe) => checagens.push({ nome, ok: !!ok, detalhe });

  let doc;
  try {
    doc = lerYaml().load(texto);
    registrar('yaml-valido', doc && typeof doc === 'object', doc ? 'YAML analisado com sucesso' : 'YAML não produziu um objeto');
  } catch (e) {
    registrar('yaml-valido', false, `YAML inválido: ${e.message}`);
    return { ok: false, checagens };
  }

  // YAML 1.1 lê `on` como a chave booleana `true`; aceitamos as duas formas.
  const gatilhos = doc.on ?? doc[true] ?? doc.true;
  const chavesGatilho = gatilhos && typeof gatilhos === 'object' ? Object.keys(gatilhos) : [];
  const gatilhoUnico = chavesGatilho.length === 1 && chavesGatilho[0] === 'workflow_dispatch';
  registrar(
    'gatilho-exclusivo-workflow_dispatch',
    gatilhoUnico,
    gatilhoUnico ? 'único gatilho: workflow_dispatch' : `gatilhos encontrados: ${JSON.stringify(chavesGatilho)}`
  );

  const permissoes = doc.permissions ?? {};
  const chavesPermissao = Object.keys(permissoes);
  const permissaoMinima = chavesPermissao.length === 1 && permissoes.contents === 'read';
  registrar(
    'permissao-minima',
    permissaoMinima,
    permissaoMinima ? 'permissions: { contents: read }' : `permissions: ${JSON.stringify(permissoes)}`
  );

  const jobs = doc.jobs ?? {};
  const ids = Object.keys(jobs);
  const umJob = ids.length === 1;
  registrar('job-unico', umJob, umJob ? `job: ${ids[0]}` : `jobs: ${JSON.stringify(ids)}`);
  const job = umJob ? jobs[ids[0]] : null;

  const ambientes = Object.values(jobs)
    .map((j) => j?.environment)
    .filter((e) => e !== undefined && e !== null);
  const ambienteDoJob = ambientes.length === 1 ? ambientes[0] : ambientes.length === 0 ? null : ambientes;
  const usaProibido = ambientes.some((e) => e === ENVIRONMENT_PROIBIDO);
  const ambienteOk = job?.environment === environment && !usaProibido;
  registrar(
    'environment-isolado',
    ambienteOk,
    usaProibido
      ? `environment ${ENVIRONMENT_PROIBIDO} é PROIBIDO — use o isolado "${environment}"`
      : job?.environment === environment
        ? `environment isolado: "${environment}"`
        : `environment: ${JSON.stringify(ambienteDoJob ?? null)} (esperado "${environment}")`
  );

  const passos = stepsDoWorkflow(doc);
  const guardaBranch = passos.find(({ step }) => typeof step?.run === 'string' && step.run.includes('GITHUB_REF_NAME') && step.run.includes(branch));
  registrar(
    'branch-restrita',
    !!guardaBranch,
    guardaBranch ? `step "${guardaBranch.step.name ?? '(sem nome)'}" restringe a ${branch}` : `nenhum step restringe a execução à branch ${branch}`
  );

  const concorrencia = doc.concurrency;
  const temConcorrencia = !!concorrencia && typeof concorrencia === 'object' && !!concorrencia.group && concorrencia['cancel-in-progress'] === false;
  registrar(
    'concorrencia',
    temConcorrencia,
    temConcorrencia ? `concurrency.group=${concorrencia.group} (cancel-in-progress: false)` : `concurrency: ${JSON.stringify(concorrencia ?? null)}`
  );

  const timeout = job?.['timeout-minutes'];
  registrar('timeout', typeof timeout === 'number' && timeout > 0, `timeout-minutes: ${JSON.stringify(timeout ?? null)}`);

  const setupNode = passos.find(({ step }) => typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@'));
  const versaoNode = String(setupNode?.step?.with?.['node-version'] ?? '');
  registrar(
    'node-compativel',
    versaoNode === nodeCompativel,
    setupNode ? `actions/setup-node node-version: ${versaoNode}` : 'sem actions/setup-node'
  );

  const instalacao = passos.find(({ step }) => typeof step?.run === 'string' && /npm\s+ci\b/.test(step.run));
  registrar('instalacao-reproduzivel', !!instalacao, instalacao ? 'usa `npm ci` (lockfile)' : 'nenhum step usa `npm ci`');

  // O segredo só pode aparecer no step que abre a conexão (o único com env DATABASE_URL).
  const comSegredo = passos.filter(({ step }) => JSON.stringify(step).includes('secrets.DATABASE_URL'));
  const stepConexao = passos.filter(({ step }) => step?.env && 'DATABASE_URL' in step.env);
  const segredoSoNaConexao = comSegredo.length === 1 && stepConexao.length === 1 && comSegredo[0].step === stepConexao[0].step;
  registrar(
    'segredo-somente-no-step-de-conexao',
    segredoSoNaConexao,
    segredoSoNaConexao
      ? `secrets.DATABASE_URL presente apenas em "${comSegredo[0].step.name ?? '(sem nome)'}"`
      : `steps com secrets.DATABASE_URL: ${comSegredo.length}; steps com env.DATABASE_URL: ${stepConexao.length}`
  );

  const destrutivos = [];
  for (const { step } of passos) {
    if (typeof step?.run !== 'string') continue;
    for (const { nome, re } of PADROES_DESTRUTIVOS) {
      const m = step.run.match(re);
      if (m) destrutivos.push(`${step.name ?? '(sem nome)'} → ${nome} ("${m[0]}")`);
    }
  }
  registrar(
    'sem-comandos-destrutivos',
    destrutivos.length === 0,
    destrutivos.length === 0 ? 'nenhum comando destrutivo nos steps' : destrutivos.join('; ')
  );

  const exposicoes = [];
  for (const { step } of passos) {
    if (typeof step?.run !== 'string') continue;
    for (const { nome, re } of PADROES_EXPOSICAO) {
      if (re.test(step.run)) exposicoes.push(`${step.name ?? '(sem nome)'} → ${nome}`);
    }
  }
  registrar(
    'sem-exposicao-de-segredo',
    exposicoes.length === 0,
    exposicoes.length === 0 ? 'nenhum step imprime segredo ou o ambiente' : exposicoes.join('; ')
  );

  const actions = passos.map(({ step }) => step?.uses).filter((u) => typeof u === 'string');
  const frouxas = actions.filter((u) => /@(?:main|master)$/i.test(u) || !/@/.test(u));
  registrar('acoes-fixadas', frouxas.length === 0, frouxas.length === 0 ? `actions fixadas: ${actions.join(', ')}` : `actions sem versão: ${frouxas.join(', ')}`);

  // Trava dura: `environment: production` não pode reaparecer em NENHUM lugar do
  // arquivo (nem em comentário ou mensagem), para não reacoplar a homologação ao
  // Environment de produção.
  const apontaProducao = new RegExp(`environment:\\s*${ENVIRONMENT_PROIBIDO}\\b`).test(texto);
  registrar(
    'environment-proibido-ausente',
    !apontaProducao,
    apontaProducao
      ? `o workflow aponta para "environment: ${ENVIRONMENT_PROIBIDO}" — a homologação deve usar "${ENVIRONMENT_AUTORIZADO}"`
      : `nenhuma referência a "environment: ${ENVIRONMENT_PROIBIDO}"`
  );

  return { ok: checagens.every((c) => c.ok), checagens };
}

function main() {
  const alvo = process.argv[2] ?? path.join(RAIZ, WORKFLOW_PADRAO);
  let texto;
  try {
    texto = readFileSync(alvo, 'utf8');
  } catch (e) {
    console.error(`VERIFICAÇÃO FALHOU: não foi possível ler ${alvo}: ${e.message}`);
    process.exit(2);
  }

  console.log(`▶ VERIFICAÇÃO ESTÁTICA DO WORKFLOW — ${path.relative(RAIZ, alvo)}`);
  const { ok, checagens } = verificarWorkflow(texto);
  for (const c of checagens) console.log(`  ${c.ok ? '✔' : '✖'} ${c.nome}: ${c.detalhe}`);
  if (!ok) {
    console.error(`\n✖ ${checagens.filter((c) => !c.ok).length} verificação(ões) reprovada(s).`);
    process.exit(1);
  }
  console.log(`\n✔ ${checagens.length} verificações aprovadas — o workflow é exclusivamente diagnóstico.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
