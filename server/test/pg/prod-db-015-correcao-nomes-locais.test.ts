// ============================================================================
// PROD-DB-01.5 — VALIDAÇÃO da correção administrativa dos nomes de locais.
//
// O script db/admin/005-propagar-nomes-locais-e42.sql NÃO é migration e NUNCA
// roda no boot. Este teste prova que ele é seguro e eficaz, executando-o dentro
// de UMA transação que SEMPRE termina em ROLLBACK: nenhum dado do banco de
// teste é persistido.
//
// Prova:
//   1. a consulta do contador no script é a MESMA da migração 0030 (sem
//      mascarar a regra E4.2);
//   2. reproduz 69 inconsistências classe B (30 estoques + 20 mov.local +
//      10 mov.local_destino + 9 inventários);
//   3. o APPLY reduz o contador para 0 e atualiza exatamente 30/20/10/9 linhas;
//   4. local_id e empresa_id NÃO mudam;
//   5. nenhuma linha de outra empresa é alterada;
//   6. casos classe A abortam (e o dado não é tocado);
//   7. casos classe C abortam (e o dado não é tocado);
//   8. o APPLY é idempotente (segunda passada = 0 UPDATEs).
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-015-correcao-nomes-locais.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.'
  );
}

process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db');

const SCRIPT = fileURLToPath(
  new URL('../../../db/admin/005-propagar-nomes-locais-e42.sql', import.meta.url)
);
const MIGRATION = fileURLToPath(
  new URL('../../../db/migrations/0030_e42_locais_estoque_multempresa.sql', import.meta.url)
);

// As QUATRO parcelas exatas de `nomes_locais_inconsistentes` na migração 0030.
// O script administrativo precisa usar exatamente estas — nada de regra nova.
const PARCELAS = [
  'SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome',
  'SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome',
];

const CONTADOR_SQL = `SELECT
  (${PARCELAS[0]}) +
  (${PARCELAS[1]}) +
  (${PARCELAS[2]}) +
  (${PARCELAS[3]}) AS nomes_locais_inconsistentes`;

// Extrai o bloco DO autocontido do script administrativo (mesmo texto que o
// operador executa em produção), para rodá-lo sem duplicar a regra.
function extrairBloco(script: string): string {
  const m = script.match(/DO \$e42_propagar_nomes_locais\$[\s\S]*?\$e42_propagar_nomes_locais\$;/);
  assert.ok(m, 'o bloco $e42_propagar_nomes_locais$ deve existir em db/admin/005-propagar-nomes-locais-e42.sql');
  return m![0];
}

type Snapshot = { id: number; local_id: number | null; empresa_id: number; local: string | null };

test('PROD-DB-01.5 — a correção propaga o nome canônico, é idempotente e nunca cruza empresa', async () => {
  await migrate();

  const script = readFileSync(SCRIPT, 'utf8');
  const migracao = readFileSync(MIGRATION, 'utf8').replace(/\s+/g, ' ');

  // (1) A consulta do script é a MESMA da migração 0030 — sem mascarar a regra.
  for (const parcela of PARCELAS) {
    assert.ok(
      migracao.includes(parcela),
      `parcela do contador não encontrada verbatim na migração 0030:\n${parcela}`
    );
  }
  const blocoNormalizado = script.replace(/\s+/g, ' ');
  for (const parcela of PARCELAS) {
    assert.ok(
      blocoNormalizado.includes(parcela),
      `o script administrativo deve reproduzir a parcela exata da migração 0030:\n${parcela}`
    );
  }

  const BLOCK = extrairBloco(script);
  assert.ok(pool, 'pool do Postgres deve existir (DATABASE_URL presente)');
  const client = await pool!.connect();
  const notices: string[] = [];
  client.on('notice', (msg) => notices.push(String(msg.message ?? '')));

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const coletarNotices = () => notices.splice(0, notices.length).join('\n');

  try {
    await client.query('BEGIN');

    // ----------------------------------------------------------------------
    // FIXTURE — empresa A com um local renomeado sem propagação (69 classe B).
    // ----------------------------------------------------------------------
    const empA = Number(
      (await client.query(
        `INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`,
        [`PRODDB015 A ${suffix}`, `7${suffix.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`]
      )).rows[0].id
    );
    const localAntigoA = `Local Antigo A ${suffix}`;
    const localNovoA = `Local Novo A ${suffix}`;
    const localExpA = `Expedicao A ${suffix}`;
    const localIdA = Number(
      (await client.query(
        `INSERT INTO locais (nome, empresa_id, ativo, padrao) VALUES ($1, $2, true, true) RETURNING id`,
        [localAntigoA, empA]
      )).rows[0].id
    );
    const localExpIdA = Number(
      (await client.query(
        `INSERT INTO locais (nome, empresa_id, ativo) VALUES ($1, $2, true) RETURNING id`,
        [localExpA, empA]
      )).rows[0].id
    );

    // 30 produtos (a unique legada de estoques é por produto/tamanho/local).
    const produtosA: number[] = (
      await client.query(
        `INSERT INTO produtos (sku, nome, empresa_id)
         SELECT $1 || g, $2 || g, $3 FROM generate_series(1, 30) g RETURNING id`,
        [`SKU015-${suffix}-`, `Produto ${suffix} `, empA]
      )
    ).rows.map((r) => Number(r.id));
    const produtoA = produtosA[0];

    await client.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
       SELECT p, NULL, $1, $2, 1, $3 FROM unnest($4::int[]) p`,
      [localAntigoA, localIdA, empA, produtosA]
    );
    await client.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
       SELECT 'ajuste', $1, $2, $3, 1, $4 FROM generate_series(1, 20)`,
      [produtoA, localAntigoA, localIdA, empA]
    );
    await client.query(
      `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, local_destino, local_destino_id, quantidade, empresa_id)
       SELECT 'transferencia', $1, $2, $3, $4, $5, 1, $6 FROM generate_series(1, 10)`,
      [produtoA, localExpA, localExpIdA, localAntigoA, localIdA, empA]
    );
    await client.query(
      `INSERT INTO inventarios (local, local_id, status, empresa_id)
       SELECT $1, $2, 'aberto', $3 FROM generate_series(1, 9)`,
      [localAntigoA, localIdA, empA]
    );
    // O renome que defasa os textos (sem propagação — o cenário de produção).
    await client.query(`UPDATE locais SET nome = $1 WHERE id = $2`, [localNovoA, localIdA]);

    // ----------------------------------------------------------------------
    // (2) BEFORE — contador e distribuição (só empresa A).
    // ----------------------------------------------------------------------
    const antes = await client.query(CONTADOR_SQL);
    assert.equal(Number(antes.rows[0].nomes_locais_inconsistentes), 69, 'a fixture deve reproduzir exatamente 69');

    const distAntes = await client.query(
      `WITH inc AS (
         SELECT 'estoques.local'::text AS origem FROM estoques e JOIN locais l ON l.id = e.local_id
           WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
         UNION ALL
         SELECT 'movimentacoes.local' FROM movimentacoes m JOIN locais l ON l.id = m.local_id
           WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
         UNION ALL
         SELECT 'movimentacoes.local_destino' FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
           WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
         UNION ALL
         SELECT 'inventarios.local' FROM inventarios inv JOIN locais l ON l.id = inv.local_id
           WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
       ) SELECT origem, count(*)::int AS n FROM inc GROUP BY origem`
    );
    const porOrigem = Object.fromEntries(distAntes.rows.map((r) => [r.origem, Number(r.n)]));
    assert.deepEqual(porOrigem, {
      'estoques.local': 30,
      'movimentacoes.local': 20,
      'movimentacoes.local_destino': 10,
      'inventarios.local': 9,
    });

    // Snapshot para provar que local_id/empresa_id não mudam.
    const snapshotEmpresa = async (emp: number) => {
      const est = await client.query(`SELECT id, local_id, empresa_id, local FROM estoques WHERE empresa_id = $1`, [emp]);
      const mov = await client.query(`SELECT id, local_id, empresa_id, local FROM movimentacoes WHERE empresa_id = $1`, [emp]);
      const inv = await client.query(`SELECT id, local_id, empresa_id, local FROM inventarios WHERE empresa_id = $1`, [emp]);
      return {
        estoques: est.rows as Snapshot[],
        movimentacoes: mov.rows as Snapshot[],
        inventarios: inv.rows as Snapshot[],
      };
    };
    const antesSnap = await snapshotEmpresa(empA);

    // ----------------------------------------------------------------------
    // (3) APPLY — executa o bloco com a dupla confirmação.
    // ----------------------------------------------------------------------
    await client.query('SAVEPOINT sp_apply');
    await client.query(`SELECT set_config('e42.apply','on',true), set_config('e42.confirmacao','PROD-DB-01.5',true)`);
    await client.query(BLOCK);
    const noticesApply = coletarNotices();

    assert.match(noticesApply, /BEFORE nomes_locais_inconsistentes=69/, 'o bloco deve registrar o BEFORE=69');
    assert.match(noticesApply, /estoques\.local=30/, 'deve atualizar 30 estoques');
    assert.match(noticesApply, /movimentacoes\.local=20/, 'deve atualizar 20 movimentações (origem)');
    assert.match(noticesApply, /movimentacoes\.local_destino=10/, 'deve atualizar 10 movimentações (destino)');
    assert.match(noticesApply, /inventarios\.local=9/, 'deve atualizar 9 inventários');
    assert.match(noticesApply, /AFTER nomes_locais_inconsistentes=0/, 'o AFTER deve ser 0');

    const depois = await client.query(CONTADOR_SQL);
    assert.equal(Number(depois.rows[0].nomes_locais_inconsistentes), 0, 'após o APPLY o contador deve ser 0');

    // ----------------------------------------------------------------------
    // (4) local_id e empresa_id NÃO mudam.
    // ----------------------------------------------------------------------
    const depoisSnap = await snapshotEmpresa(empA);
    for (const tabela of ['estoques', 'movimentacoes', 'inventarios'] as const) {
      const a = antesSnap[tabela];
      const b = depoisSnap[tabela];
      assert.equal(b.length, a.length, `${tabela}: mesma quantidade de linhas`);
      const key = (r: Snapshot) => `${r.id}`;
      const mapa = new Map(b.map((r) => [key(r), r]));
      for (const r of a) {
        const d = mapa.get(key(r))!;
        assert.equal(d.local_id, r.local_id, `${tabela} id=${r.id}: local_id não pode mudar`);
        assert.equal(d.empresa_id, r.empresa_id, `${tabela} id=${r.id}: empresa_id não pode mudar`);
      }
    }
    // O texto dos saldos/movimentações/inventários agora é o nome canônico.
    assert.ok(
      depoisSnap.estoques.every((r) => r.local === localNovoA),
      'todos os textos de estoque devem virar o nome canônico'
    );

    // ----------------------------------------------------------------------
    // (5) Idempotência — segunda passada = 0 UPDATEs.
    // ----------------------------------------------------------------------
    await client.query('SAVEPOINT sp_idem');
    await client.query(`SELECT set_config('e42.apply','on',true), set_config('e42.confirmacao','PROD-DB-01.5',true)`);
    await client.query(BLOCK);
    const noticesIdem = coletarNotices();
    assert.match(noticesIdem, /atualizados: estoques\.local=0, movimentacoes\.local=0, movimentacoes\.local_destino=0, inventarios\.local=0/);
    const depoisIdem = await client.query(CONTADOR_SQL);
    assert.equal(Number(depoisIdem.rows[0].nomes_locais_inconsistentes), 0);

    // ----------------------------------------------------------------------
    // (6) Isolamento entre empresas: uma linha de OUTRA empresa nunca é
    //     alterada para o nome de um local alheio.
    // ----------------------------------------------------------------------
    const empB = Number(
      (await client.query(
        `INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`,
        [`PRODDB015 B ${suffix}`, `8${suffix.replace(/\D/g, '').padEnd(13, '0').slice(0, 13)}`]
      )).rows[0].id
    );
    const localAntigoB = `Local Antigo B ${suffix}`;
    const localNovoB = `Local Novo B ${suffix}`;
    const localIdB = Number(
      (await client.query(`INSERT INTO locais (nome, empresa_id, ativo) VALUES ($1, $2, true) RETURNING id`, [localAntigoB, empB])).rows[0].id
    );
    const produtoB = Number(
      (await client.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKU015B-${suffix}`, `Produto B ${suffix}`, empB])).rows[0].id
    );
    await client.query(
      `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id) VALUES ($1, NULL, $2, $3, 1, $4)`,
      [produtoB, localAntigoB, localIdB, empB]
    );
    await client.query(`UPDATE locais SET nome = $1 WHERE id = $2`, [localNovoB, localIdB]);

    await client.query('SAVEPOINT sp_b');
    await client.query(`SELECT set_config('e42.apply','on',true), set_config('e42.confirmacao','PROD-DB-01.5',true)`);
    await client.query(BLOCK);
    coletarNotices();
    const bDepois = await client.query(`SELECT local, local_id, empresa_id FROM estoques WHERE produto_id = $1`, [produtoB]);
    assert.equal(bDepois.rows[0].local, localNovoB, 'a linha da empresa B deve receber o nome canônico do PRÓPRIO local');
    assert.equal(Number(bDepois.rows[0].empresa_id), empB, 'empresa_id da linha B não pode mudar');
    assert.equal(Number(bDepois.rows[0].local_id), localIdB, 'local_id da linha B não pode mudar');
    assert.notEqual(bDepois.rows[0].local, localNovoA, 'a linha B jamais pode receber o nome de um local da empresa A');

    // ----------------------------------------------------------------------
    // (7) Caso classe A (texto de local NULL com local_id canônico) ABORTA.
    //     `movimentacoes.local` é anulável, então é o caminho A alcançável
    //     após a 0030 (a FK composta impede vínculo cruzado de empresa).
    // ----------------------------------------------------------------------
    const movA = Number(
      (await client.query(
        `INSERT INTO movimentacoes (tipo, produto_id, local, local_id, quantidade, empresa_id)
         VALUES ('ajuste', $1, NULL, $2, 1, $3) RETURNING id`,
        [produtoA, localIdA, empA]
      )).rows[0].id
    );
    await client.query('SAVEPOINT sp_a');
    await client.query(`SELECT set_config('e42.apply','on',true), set_config('e42.confirmacao','PROD-DB-01.5',true)`);
    await assert.rejects(client.query(BLOCK), /classe A/, 'caso classe A deve abortar o script');
    await client.query('ROLLBACK TO SAVEPOINT sp_a');
    const movAposA = await client.query(`SELECT local FROM movimentacoes WHERE id = $1`, [movA]);
    assert.equal(movAposA.rows[0].local, null, 'o caso classe A não pode ser alterado');
    await client.query(`DELETE FROM movimentacoes WHERE id = $1`, [movA]);

    // ----------------------------------------------------------------------
    // (8) Caso classe C (diferença só de caixa/espaço) ABORTA e não é alterado.
    // ----------------------------------------------------------------------
    const produtoC = Number(
      (await client.query(`INSERT INTO produtos (sku, nome, empresa_id) VALUES ($1, $2, $3) RETURNING id`, [`SKU015C-${suffix}`, `Produto C ${suffix}`, empA])).rows[0].id
    );
    const textoC = localNovoA.toLowerCase();
    const estC = Number(
      (await client.query(
        `INSERT INTO estoques (produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
         VALUES ($1, NULL, $2, $3, 1, $4) RETURNING id`,
        [produtoC, textoC, localIdA, empA]
      )).rows[0].id
    );
    await client.query('SAVEPOINT sp_c');
    await client.query(`SELECT set_config('e42.apply','on',true), set_config('e42.confirmacao','PROD-DB-01.5',true)`);
    await assert.rejects(client.query(BLOCK), /classe C/, 'caso classe C deve abortar o script');
    await client.query('ROLLBACK TO SAVEPOINT sp_c');
    const estAposC = await client.query(`SELECT local FROM estoques WHERE id = $1`, [estC]);
    assert.equal(estAposC.rows[0].local, textoC, 'o caso classe C não pode ser alterado');

    console.log('\n=== PROD-DB-01.5 — correção validada (transação revertida ao final) ===');
    console.log('  BEFORE=69 (30/20/10/9) → APPLY → AFTER=0; idempotente; isolamento por empresa OK; A e C abortam');
  } finally {
    // Nada é persistido: o teste inteiro roda numa transação revertida.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
