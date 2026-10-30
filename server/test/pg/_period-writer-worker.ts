// Separate OS process holds an uncommitted financial write before close.
import { Client } from 'pg';
const data = JSON.parse(process.env.PERIOD_WRITER_FIXTURE || '{}');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('BEGIN');
await db.query(`INSERT INTO fin_extrato_transacoes(empresa_id,linha_hash,data,valor,direcao,status)
  VALUES($1,$2,$3,10,'entrada','importada')`, [data.company, data.hash, data.date]);
process.send?.({ type: 'ready', pid: db.processID });
process.on('message', async (msg) => {
  if (msg !== 'commit' && msg !== 'rollback') return;
  try { await db.query(msg === 'commit' ? 'COMMIT' : 'ROLLBACK'); process.send?.({ type: 'done' }); }
  finally { await db.end(); process.disconnect?.(); }
});
