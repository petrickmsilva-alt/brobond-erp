// BL-017 — carteira compartilhada validada contra PostgreSQL real.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('BL-017 exige DATABASE_URL PostgreSQL real; não é permitido pular este teste.');
}
process.env.NODE_ENV = 'test';
let encerrarPool: (() => Promise<void>) | null = null;
after(async () => { if (encerrarPool) await encerrarPool(); });

test('BL-017: trigger garante participação agregada, takeover e concorrência', async () => {
  const { migrate, query, pool } = await import('../../src/db');
  await migrate();
  assert.ok(pool, 'PostgreSQL real obrigatório');
  encerrarPool = () => pool.end();

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord } = await import('../../src/services');
  const sufixo = `BL017-${Date.now()}-${process.pid}`;
  const admin = { id: 1, name: 'Admin BL017 PG', perfil: 'admin' as const };
  const empresa = await createRecord(RESOURCES.empresas, { nome: sufixo }, admin);
  const empresaId = Number(empresa.id);
  const ator = { ...admin, empresa_id: empresaId, empresas: [empresaId] };
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente ${sufixo}` }, ator);
  const clienteId = Number(cliente.id);
  const reps = await query(
    `INSERT INTO representantes (empresa_id, nome)
     SELECT $1, $2 || ' ' || n::text
       FROM generate_series(1, 4) AS n
     RETURNING id`,
    [empresaId, `Representante ${sufixo}`]
  );
  const repIds = reps.rows.map((r: { id: number }) => Number(r.id));

  const inserir = (representanteId: number, participacao: number, inicio = '2026-01-01') =>
    query(
      `INSERT INTO representante_cliente
       (empresa_id, representante_id, cliente_id, inicio, status, participacao_pct)
       VALUES ($1,$2,$3,$4,'ativo',$5) RETURNING id`,
      [empresaId, representanteId, clienteId, inicio, participacao]
    );

  const a = await inserir(repIds[0], 40);
  await inserir(repIds[1], 60);
  await assert.rejects(
    () => inserir(repIds[2], 1),
    (error: any) => error.code === '23514' && error.constraint === 'representante_cliente_participacao_aberta'
  );
  await query('UPDATE representante_cliente SET participacao_pct = 30 WHERE id = $1', [a.rows[0].id]);
  await inserir(repIds[2], 10);
  const soma = await query(
    `SELECT SUM(participacao_pct)::numeric AS total
       FROM representante_cliente
      WHERE empresa_id=$1 AND cliente_id=$2 AND status='ativo' AND fim IS NULL`,
    [empresaId, clienteId]
  );
  assert.equal(Number(soma.rows[0].total), 100);

  // Takeover integral encerra o histórico parcial e libera 100% ao novo titular.
  await query(
    `UPDATE representante_cliente
        SET fim='2026-06-30', status='encerrado'
      WHERE empresa_id=$1 AND cliente_id=$2 AND status='ativo' AND fim IS NULL`,
    [empresaId, clienteId]
  );
  await inserir(repIds[3], 100, '2026-07-01');
  const ativos = await query(
    `SELECT count(*)::int AS n FROM representante_cliente
      WHERE empresa_id=$1 AND cliente_id=$2 AND status='ativo' AND fim IS NULL`,
    [empresaId, clienteId]
  );
  assert.equal(ativos.rows[0].n, 1);

  // A integridade temporal também bloqueia SQL direto com fim finito sobreposto.
  const clienteFinito = await createRecord(RESOURCES.clientes, { nome: `Cliente finito ${sufixo}` }, ator);
  const clienteFinitoId = Number(clienteFinito.id);
  await query(
    `INSERT INTO representante_cliente
     (empresa_id, representante_id, cliente_id, inicio, fim, status, participacao_pct)
     VALUES ($1,$2,$3,'2026-01-01','2026-12-31','ativo',100)`,
    [empresaId, repIds[0], clienteFinitoId]
  );
  await assert.rejects(
    () => query(
      `INSERT INTO representante_cliente
       (empresa_id, representante_id, cliente_id, inicio, status, participacao_pct)
       VALUES ($1,$2,$3,'2026-06-01','ativo',10)`,
      [empresaId, repIds[1], clienteFinitoId]
    ),
    (error: any) => error.code === '23514' && error.constraint === 'representante_cliente_vigencia_sobreposta'
  );

  const clienteAberto = await createRecord(RESOURCES.clientes, { nome: `Cliente aberto ${sufixo}` }, ator);
  const clienteAbertoId = Number(clienteAberto.id);
  await query(
    `INSERT INTO representante_cliente
     (empresa_id, representante_id, cliente_id, inicio, status, participacao_pct)
     VALUES ($1,$2,$3,'2026-01-01','ativo',60)`,
    [empresaId, repIds[0], clienteAbertoId]
  );
  await assert.rejects(
    () => query(
      `INSERT INTO representante_cliente
       (empresa_id, representante_id, cliente_id, inicio, fim, status, participacao_pct)
       VALUES ($1,$2,$3,'2026-06-01','2026-12-31','ativo',40)`,
      [empresaId, repIds[1], clienteAbertoId]
    ),
    (error: any) => error.code === '23514' && error.constraint === 'representante_cliente_vigencia_sobreposta'
  );

  // SQL direto também não pode inserir um histórico encerrado sobre uma
  // atribuição integral incompatível (o trigger não pode ignorar status encerrado).
  const clienteEncerrado = await createRecord(RESOURCES.clientes, { nome: `Cliente encerrado inválido ${sufixo}` }, ator);
  const clienteEncerradoId = Number(clienteEncerrado.id);
  await query(
    `INSERT INTO representante_cliente
     (empresa_id, representante_id, cliente_id, inicio, status, participacao_pct)
     VALUES ($1,$2,$3,'2026-01-01','ativo',100)`,
    [empresaId, repIds[0], clienteEncerradoId]
  );
  await assert.rejects(
    () => query(
      `INSERT INTO representante_cliente
       (empresa_id, representante_id, cliente_id, inicio, fim, status, participacao_pct)
       VALUES ($1,$2,$3,'2026-06-01','2026-12-31','encerrado',100)`,
      [empresaId, repIds[1], clienteEncerradoId]
    ),
    (error: any) => error.code === '23514' && error.constraint === 'representante_cliente_vigencia_sobreposta'
  );

  // Duas transações independentes tentam consumir 60% simultaneamente.
  const primeiro = await pool.connect();
  const segundo = await pool.connect();
  try {
    await query('DELETE FROM representante_cliente WHERE empresa_id=$1 AND cliente_id=$2', [empresaId, clienteId]);
    await primeiro.query('BEGIN');
    await primeiro.query(
      `INSERT INTO representante_cliente (empresa_id,representante_id,cliente_id,inicio,status,participacao_pct)
       VALUES ($1,$2,$3,'2026-01-01','ativo',60)`,
      [empresaId, repIds[0], clienteId]
    );
    await segundo.query('BEGIN');
    const concorrente = segundo.query(
      `INSERT INTO representante_cliente (empresa_id,representante_id,cliente_id,inicio,status,participacao_pct)
       VALUES ($1,$2,$3,'2026-01-01','ativo',60)`,
      [empresaId, repIds[1], clienteId]
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await primeiro.query('COMMIT');
    await assert.rejects(concorrente, (error: any) =>
      error.code === '23514' && error.constraint === 'representante_cliente_participacao_aberta'
    );
    await segundo.query('ROLLBACK');
    const final = await query(
      `SELECT SUM(participacao_pct)::numeric AS total, count(*)::int AS n
         FROM representante_cliente
        WHERE empresa_id=$1 AND cliente_id=$2 AND status='ativo' AND fim IS NULL`,
      [empresaId, clienteId]
    );
    assert.equal(Number(final.rows[0].total), 60);
    assert.equal(final.rows[0].n, 1);
  } finally {
    await primeiro.release();
    await segundo.release();
  }
});
