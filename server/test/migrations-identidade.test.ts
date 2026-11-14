// ============================================================================
// ETAPA 01 — MIGRATION FORENSICS: regressão do critério de identidade/sequência.
//
// O runner (server/src/db.ts) identifica migration pelo NOME COMPLETO e ordena
// lexicalmente. O gate final agora usa o MESMO modelo (scripts/migrations-
// identidade.ts). Este teste trava:
//   • a cadeia real do repositório passa sem P0 (a colisão 0121 é histórica,
//     registrada com plano de reconciliação — nunca silenciada);
//   • duplicidade NOVA de prefixo é P0 (o gate não foi afrouxado);
//   • buraco na sequência de prefixos distintos é P0;
//   • arquivo sem prefixo é P0;
//   • a lista de colisões históricas casa EXATAMENTE com os arquivos em disco
//     (se alguém renomear/adicionar arquivo no prefixo, o teste acusa).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { auditarSequenciaMigrations, COLISOES_HISTORICAS } from '../../scripts/migrations-identidade';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const reais = readdirSync(new URL('../../db/migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

test('cadeia real: nenhum P0; colisão 0121 reportada como histórica (P2), nunca silenciada', () => {
  const achados = auditarSequenciaMigrations(reais);
  const p0 = achados.filter((a) => a.severidade === 'P0');
  assert.deepEqual(p0, [], `cadeia real não pode ter P0: ${JSON.stringify(p0)}`);
  const historicas = achados.filter((a) => a.id === 'MIGRATION_COLISAO_HISTORICA');
  assert.equal(historicas.length, 1, 'a colisão 0121 precisa aparecer no relatório');
  assert.match(historicas[0].mensagem, /0121_operational_control_plane\.sql/);
  assert.match(historicas[0].mensagem, /0121_perf_busca_trigram_e_listagens\.sql/);
  assert.match(historicas[0].mensagem, /BLOQUEADO/);
});

test('registro de colisões históricas casa exatamente com os arquivos em disco', () => {
  for (const [prefixo, arquivos] of Object.entries(COLISOES_HISTORICAS)) {
    const noDisco = reais.filter((f) => f.startsWith(`${prefixo}_`)).sort();
    assert.deepEqual(noDisco, [...arquivos].sort(), `prefixo ${prefixo}: registro histórico ≠ disco (rename sem atualizar o registro?)`);
  }
});

test('duplicidade NOVA de prefixo continua P0 (gate não foi relaxado)', () => {
  const nomes = [...reais, '0122_experimento_a.sql', '0122_experimento_b.sql'];
  const achados = auditarSequenciaMigrations(nomes);
  const p0 = achados.filter((a) => a.severidade === 'P0');
  assert.equal(p0.length, 1);
  assert.equal(p0[0].id, 'MIGRATION_PREFIXO_DUPLICADO');
  assert.match(p0[0].mensagem, /0122/);
});

test('alterar o CONJUNTO de arquivos de um prefixo histórico sem atualizar o registro é P0', () => {
  // Simula um terceiro arquivo 0121 (ou rename parcial): não pode passar como
  // "colisão histórica" — o registro exige igualdade exata do conjunto.
  const nomes = [...reais, '0121_terceiro_intruso.sql'];
  const achados = auditarSequenciaMigrations(nomes);
  assert.ok(achados.some((a) => a.id === 'MIGRATION_PREFIXO_DUPLICADO' && a.severidade === 'P0'));
});

test('buraco na sequência de prefixos distintos é P0', () => {
  const nomes = reais.filter((f) => !f.startsWith('0050_'));
  const achados = auditarSequenciaMigrations(nomes);
  assert.ok(achados.some((a) => a.id === 'MIGRATION_SEQUENCIA' && a.severidade === 'P0'));
});

test('arquivo sem prefixo numérico é P0', () => {
  const achados = auditarSequenciaMigrations([...reais, 'sem_numero.sql']);
  assert.ok(achados.some((a) => a.id === 'MIGRATION_NOME' && a.severidade === 'P0'));
});

test('ordem de entrada não importa: auditor ordena como o runner (lexical)', () => {
  const a = auditarSequenciaMigrations(reais);
  const b = auditarSequenciaMigrations([...reais].reverse());
  assert.deepEqual(a, b);
});

test('sequência limpa sem colisões não produz achado algum', () => {
  const limpa = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
  assert.deepEqual(auditarSequenciaMigrations(limpa), []);
});
