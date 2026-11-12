// ============================================================================
// PROVA EM POSTGRESQL 16.14 REAL — Migration 0121 + scripts/perf/indices-concurrently.mjs
//
// Executado automaticamente no job `testes-postgres` do CI:
//   1. Confirma que após `migrate()` os 5 índices GIN da Migration 0121 existem
//      em `public` com `indisvalid = true` e `indisready = true`.
//   2. Em um schema isolado (`perf_homolog_pg_<sufixo>`), exercita:
//      • dry-run com índices ausentes (nada criado);
//      • `--apply` criando os 5 índices com `CREATE INDEX CONCURRENTLY` real;
//      • segunda execução `--apply` pulando os 5 índices já válidos e prontos;
//      • índice inválido REAL em `pg_index` (`indisvalid = false`, produzido por
//        um `CREATE UNIQUE INDEX CONCURRENTLY` interrompido por chave duplicada),
//        comprovando que o script detecta `indisvalid = false`, retorna código
//        != 0, instrui recuperação manual e NUNCA executa DROP automaticamente.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// @ts-expect-error — módulo ESM operacional em scripts/perf/
import { INDICES, consultarEstadoIndice, executarHomologacaoIndices } from '../../../scripts/perf/indices-concurrently.mjs';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
const esquemaIsolado = `perf_homolog_pg_${sufixo}`;

const loggerSilencioso = {
  log: () => undefined,
  error: () => undefined,
};

test('PostgreSQL real: Migration 0121 + homologação CONCURRENTLY + detecção de indisvalid=false real', { skip }, async () => {
  const { migrate } = await import('../../src/db');
  await migrate();

  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await cliente.connect();

  try {
    // 1. Verifica os 5 índices reais da Migration 0121 no schema public
    const resPublic = await executarHomologacaoIndices(cliente, {
      aplicar: false,
      esquema: 'public',
      logger: loggerSilencioso,
    });
    assert.equal(resPublic.ok, true);
    assert.equal(resPublic.codigoSaida, 0);
    assert.equal(resPublic.pendentes.length, 0);
    assert.equal(resPublic.indices.length, 5);
    for (const est of resPublic.indices) {
      assert.equal(est.existe, true, `índice public.${est.nome} deve existir após migrate()`);
      assert.equal(est.indisvalid, true, `índice public.${est.nome} deve ter indisvalid=true`);
      assert.equal(est.indisready, true, `índice public.${est.nome} deve ter indisready=true`);
    }

    // 2. Schema isolado para testar CREATE INDEX CONCURRENTLY e índice inválido real
    await cliente.query(`CREATE SCHEMA ${esquemaIsolado}`);
    await cliente.query(
      `CREATE TABLE ${esquemaIsolado}.produtos (id serial PRIMARY KEY, nome text, sku text, codigo_barras text)`
    );
    await cliente.query(`CREATE TABLE ${esquemaIsolado}.clientes (id serial PRIMARY KEY, nome text)`);
    await cliente.query(`CREATE TABLE ${esquemaIsolado}.fornecedores (id serial PRIMARY KEY, nome text)`);

    // 2a. Dry-run não cria nada
    const dryRun = await executarHomologacaoIndices(cliente, {
      aplicar: false,
      esquema: esquemaIsolado,
      logger: loggerSilencioso,
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.pendentes.length, 5);
    assert.ok(dryRun.indices.every((i: { existe: boolean }) => i.existe === false));

    // 2b. --apply cria os 5 índices GIN com CREATE INDEX CONCURRENTLY real
    const aplicado = await executarHomologacaoIndices(cliente, {
      aplicar: true,
      esquema: esquemaIsolado,
      logger: loggerSilencioso,
    });
    assert.equal(aplicado.ok, true);
    assert.equal(aplicado.codigoSaida, 0);
    assert.equal(aplicado.criados, 5);
    assert.ok(aplicado.indices.every((i: { indisvalid: boolean; indisready: boolean }) => i.indisvalid && i.indisready));

    // 2c. Reexecução idempotente pula os 5 válidos e prontos
    const reaplicado = await executarHomologacaoIndices(cliente, {
      aplicar: true,
      esquema: esquemaIsolado,
      logger: loggerSilencioso,
    });
    assert.equal(reaplicado.ok, true);
    assert.equal(reaplicado.criados, 0);

    // 2d. Produz um índice REAL com indisvalid=false em pg_index (falha de CONCURRENTLY por duplicidade)
    await cliente.query(`DROP INDEX ${esquemaIsolado}.perf_clientes_nome_trgm`);
    await cliente.query(`INSERT INTO ${esquemaIsolado}.clientes (nome) VALUES ('DUP'), ('DUP')`);
    await assert.rejects(() =>
      cliente.query(
        `CREATE UNIQUE INDEX CONCURRENTLY perf_clientes_nome_trgm ON ${esquemaIsolado}.clientes (nome)`
      )
    );

    const estadoInvalidoAntes = await consultarEstadoIndice(
      cliente,
      INDICES.find((i: { nome: string }) => i.nome === 'perf_clientes_nome_trgm'),
      esquemaIsolado
    );
    assert.equal(estadoInvalidoAntes.existe, true, 'PostgreSQL deve deixar o índice inválido em pg_index');
    assert.equal(estadoInvalidoAntes.indisvalid, false, 'indisvalid real deve ser false');

    const errosCapturados: string[] = [];
    const bloqueado = await executarHomologacaoIndices(cliente, {
      aplicar: true,
      esquema: esquemaIsolado,
      logger: {
        log: () => undefined,
        error: (...a: unknown[]) => errosCapturados.push(a.map(String).join(' ')),
      },
    });
    assert.equal(bloqueado.ok, false);
    assert.equal(bloqueado.codigoSaida, 1);
    assert.equal(bloqueado.indiceProblema, 'perf_clientes_nome_trgm');
    assert.match(errosCapturados.join('\n'), /DROP INDEX CONCURRENTLY/);

    // Prova que o script NÃO executou DROP automaticamente: o índice inválido permanece até ação humana
    const estadoInvalidoDepois = await consultarEstadoIndice(
      cliente,
      INDICES.find((i: { nome: string }) => i.nome === 'perf_clientes_nome_trgm'),
      esquemaIsolado
    );
    assert.equal(estadoInvalidoDepois.existe, true, 'script NUNCA deve executar DROP automaticamente');
  } finally {
    await cliente.query(`DROP SCHEMA IF EXISTS ${esquemaIsolado} CASCADE`).catch(() => undefined);
    await cliente.end().catch(() => undefined);
  }
});
