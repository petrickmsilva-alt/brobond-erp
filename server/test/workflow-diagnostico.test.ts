// ============================================================================
// VERIFICAÇÃO ESTÁTICA DO WORKFLOW DIAGNÓSTICO — sem rede e sem banco.
//
// Prova que o verificador REPROVA desvios reais (escrita no banco, segredo fora
// do step de conexão, gatilho extra, permissão ampla, action solta) e APROVA o
// workflow entregue. É a trava que impede um comando destrutivo entrar sem
// ninguém perceber.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRANCH_AUTORIZADA, ENVIRONMENT_AUTORIZADO, ENVIRONMENT_PROIBIDO, verificarWorkflow, WORKFLOW_PADRAO } from '../../scripts/verificar-workflow-diagnostico.mjs';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const textoDoWorkflow = readFileSync(`${RAIZ}${WORKFLOW_PADRAO}`, 'utf8');

const aprovado = (texto: string) => verificarWorkflow(texto).ok;
const detalhe = (texto: string, nome: string) => verificarWorkflow(texto).checagens.find((c) => c.nome === nome);

test('o workflow entregue é aprovado por todas as verificações', () => {
  const r = verificarWorkflow(textoDoWorkflow);
  const reprovadas = r.checagens.filter((c) => !c.ok).map((c) => `${c.nome}: ${c.detalhe}`);
  assert.deepEqual(reprovadas, []);
  assert.equal(r.ok, true);
});

test('reprova SQL de escrita em qualquer step', () => {
  const alterado = textoDoWorkflow.replace(
    'node --import tsx scripts/diagnostico-conexao-producao.ts',
    'psql "$DATABASE_URL" -c "DELETE FROM vendas"'
  );
  assert.notEqual(alterado, textoDoWorkflow);
  assert.equal(aprovado(alterado), false);
  assert.equal(detalhe(alterado, 'sem-comandos-destrutivos')?.ok, false);
});

test('reprova migração, saneamento e carga cadastral', () => {
  for (const comando of ['npx prisma migrate deploy', 'node --import tsx scripts/saneamento-go-live.ts --executar', 'npm run db:deploy']) {
    const alterado = textoDoWorkflow.replace('node scripts/verificar-workflow-diagnostico.mjs', comando);
    assert.equal(aprovado(alterado), false, comando);
  }
});

test('reprova segredo injetado fora do step de conexão', () => {
  const alterado = textoDoWorkflow.replace(
    '        run: npm ci --no-audit --no-fund',
    '        env:\n          DATABASE_URL: ${{ secrets.DATABASE_URL }}\n        run: npm ci --no-audit --no-fund'
  );
  assert.notEqual(alterado, textoDoWorkflow);
  assert.equal(detalhe(alterado, 'segredo-somente-no-step-de-conexao')?.ok, false);
});

test('reprova gatilho extra (push, pull_request, schedule)', () => {
  const alterado = textoDoWorkflow.replace('on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n  push:');
  assert.equal(detalhe(alterado, 'gatilho-exclusivo-workflow_dispatch')?.ok, false);
});

test('reprova permissão de escrita', () => {
  const alterado = textoDoWorkflow.replace('permissions:\n  contents: read', 'permissions:\n  contents: write');
  assert.equal(detalhe(alterado, 'permissao-minima')?.ok, false);
});

test('reprova action sem versão fixada', () => {
  const alterado = textoDoWorkflow.replace('actions/checkout@v4', 'actions/checkout@main');
  assert.equal(detalhe(alterado, 'acoes-fixadas')?.ok, false);
});

test('reprova exposição de ambiente/segredo', () => {
  const alterado = textoDoWorkflow.replace('run: npm ci --no-audit --no-fund', 'run: |\n          printenv | sort');
  assert.equal(detalhe(alterado, 'sem-exposicao-de-segredo')?.ok, false);
});

test('reprova execução em branch não autorizada', () => {
  const alterado = textoDoWorkflow.replaceAll(BRANCH_AUTORIZADA, 'main');
  assert.equal(detalhe(alterado, 'branch-restrita')?.ok, false);
});

test('reprova ausência de concorrência e de timeout', () => {
  const semConc = textoDoWorkflow.replace(/concurrency:\n(?:.*\n){2}/, '');
  assert.equal(detalhe(semConc, 'concorrencia')?.ok, false);
  const semTimeout = textoDoWorkflow.replace('    timeout-minutes: 10\n', '');
  assert.equal(detalhe(semTimeout, 'timeout')?.ok, false);
});

test('reprova YAML inválido', () => {
  assert.equal(detalhe('jobs: [\n', 'yaml-valido')?.ok, false);
});

// ── Isolamento do Environment (migration-diagnostic, nunca production) ──────

test('o workflow usa o environment isolado migration-diagnostic', () => {
  assert.match(textoDoWorkflow, /^\s*environment:\s*migration-diagnostic\s*$/m);
  assert.equal(detalhe(textoDoWorkflow, 'environment-isolado')?.ok, true);
  assert.equal(ENVIRONMENT_AUTORIZADO, 'migration-diagnostic');
});

test('o workflow não usa production como environment', () => {
  assert.equal(ENVIRONMENT_PROIBIDO, 'production');
  assert.doesNotMatch(textoDoWorkflow, /^\s*environment:\s*production\s*$/m);
  assert.equal(detalhe(textoDoWorkflow, 'environment-proibido-ausente')?.ok, true);
});

test('o verificador aprova o YAML com o environment correto', () => {
  const r = verificarWorkflow(textoDoWorkflow);
  assert.equal(r.ok, true);
  assert.equal(r.checagens.find((c) => c.nome === 'environment-isolado')?.ok, true);
});

test('o verificador reprova um workflow adulterado para usar production', () => {
  const adulterado = textoDoWorkflow.replace('environment: migration-diagnostic', 'environment: production');
  assert.notEqual(adulterado, textoDoWorkflow);
  assert.equal(aprovado(adulterado), false);
  assert.equal(detalhe(adulterado, 'environment-isolado')?.ok, false);
  assert.equal(detalhe(adulterado, 'environment-proibido-ausente')?.ok, false);
});

test('o verificador reprova environment diferente do isolado', () => {
  const adulterado = textoDoWorkflow.replace('environment: migration-diagnostic', 'environment: homologacao');
  assert.equal(detalhe(adulterado, 'environment-isolado')?.ok, false);
  assert.equal(detalhe(adulterado, 'environment-proibido-ausente')?.ok, true);
});

test('todas as proteções anteriores continuam aprovadas no workflow entregue', () => {
  const nomes = verificarWorkflow(textoDoWorkflow).checagens.map((c) => c.nome);
  for (const protecao of [
    'yaml-valido',
    'gatilho-exclusivo-workflow_dispatch',
    'permissao-minima',
    'environment-isolado',
    'branch-restrita',
    'concorrencia',
    'timeout',
    'node-compativel',
    'instalacao-reproduzivel',
    'segredo-somente-no-step-de-conexao',
    'sem-comandos-destrutivos',
    'sem-exposicao-de-segredo',
    'acoes-fixadas',
    'environment-proibido-ausente',
  ]) {
    assert.ok(nomes.includes(protecao), `proteção ausente: ${protecao}`);
  }
});
