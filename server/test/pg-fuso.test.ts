// ============================================================================
// FUSO DO NEGÓCIO contra Postgres REAL — Etapa 2.1, Parte 4.
//
// Prova que os agrupamentos de /api/dashboard (mês/semana civil) usam
// America/Sao_Paulo no SQL de verdade, não só no memdb:
//   • 31 do mês 21:00 BR (= dia seguinte 00:00 UTC) continua no mês anterior;
//   • 00:00 BR do dia 1 já é o mês corrente (inclusive no KPI vendasMes);
//   • domingo 23:59 BR entra na semana civil da segunda anterior;
//   • as fronteiras são 03:00 UTC (00:00 BR), independente do fuso da sessão.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('dashboard (PG): fronteiras SQL de America/Sao_Paulo são 03:00 UTC (independente da sessão)', { skip }, async () => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  // A fronteira do dia civil: meia-noite de Brasília em UTC.
  const fronteira = await query(`SELECT timezone('America/Sao_Paulo', '2026-01-31'::date::timestamp) AS f`);
  assert.equal(new Date(fronteira.rows[0].f).toISOString(), '2026-01-31T03:00:00.000Z');

  // Um instante 31/01 21:00 BR agrupa no mês civil de janeiro.
  const mes = await query(
    `SELECT to_char(date_trunc('month', $1::timestamptz AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes`,
    ['2026-01-31T21:00:00-03:00']
  );
  assert.equal(mes.rows[0].mes, '2026-01');

  // O mesmo instante em UTC puro seria fevereiro — é exatamente o bug corrigido.
  const mesUtc = await query(`SELECT to_char(date_trunc('month', $1::timestamptz), 'YYYY-MM') AS mes`, ['2026-01-31T21:00:00-03:00']);
  assert.equal(mesUtc.rows[0].mes, '2026-02', 'sanidade: em UTC o instante cai em fevereiro');

  // Semana civil: domingo 23:59 BR pertence à semana da segunda anterior.
  const semana = await query(
    `SELECT to_char(date_trunc('week', $1::timestamptz AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS semana`,
    ['2026-10-04T23:59:59-03:00']
  );
  assert.equal(semana.rows[0].semana, '2026-09-28');
});

test('dashboard (PG): faturamento de 21:00–23:59 BR do último dia entra no mês civil correto', { skip }, async () => {
  const { query, migrate } = await import('../src/db');
  await migrate();
  const { getStore } = await import('../src/services');
  const { partesCivil, inicioMesCivil } = await import('../src/fuso');

  const antes = await getStore().dashboard();
  const hoje = new Date();
  const ultimoDiaMesAnterior = new Date(inicioMesCivil(hoje).getTime() - 1);
  const pUlt = partesCivil(ultimoDiaMesAnterior);
  const isoUlt = `${pUlt.ano}-${String(pUlt.mes).padStart(2, '0')}-${String(pUlt.dia).padStart(2, '0')}`;
  const mesAnterior = isoUlt.slice(0, 7);
  const pMes = partesCivil(inicioMesCivil(hoje));
  const isoMes = `${pMes.ano}-${String(pMes.mes).padStart(2, '0')}-01`;

  const ids: number[] = [];
  try {
    for (const [quando, total] of [
      [`${isoUlt}T20:59:00-03:00`, 100],
      [`${isoUlt}T21:00:00-03:00`, 200],
      [`${isoUlt}T23:59:59-03:00`, 300],
      [`${isoMes}T00:00:00-03:00`, 400],
    ] as const) {
      const r = await query(`INSERT INTO vendas (status, total, faturada_em, data) VALUES ('faturada', $1, $2::timestamptz, $2::timestamptz) RETURNING id`, [
        total,
        quando,
      ]);
      ids.push(Number(r.rows[0].id));
    }

    const depois = await getStore().dashboard();
    const deltaMes = (mes: string) => (depois.vendasPorMes.find((m) => m.mes === mes)?.total ?? 0) - (antes.vendasPorMes.find((m) => m.mes === mes)?.total ?? 0);
    assert.ok(depois.vendasPorMes.some((m) => m.mes === mesAnterior), `o mês ${mesAnterior} precisa existir na série`);
    assert.equal(deltaMes(mesAnterior), 600, '20:59, 21:00 e 23:59 BR do último dia ficam no mês civil anterior');
    assert.equal(deltaMes(isoMes.slice(0, 7)), 400, '00:00 BR do dia 1 já é o mês civil corrente');
    assert.equal(depois.vendasMes - antes.vendasMes, 400, 'vendasMes só conta o mês civil corrente');
  } finally {
    if (ids.length) await query(`DELETE FROM vendas WHERE id = ANY($1::int[])`, [ids]);
  }
});

test('dashboard (PG): produção de domingo 23:59 BR entra na semana civil da segunda anterior', { skip }, async () => {
  const { query, migrate } = await import('../src/db');
  await migrate();
  const { getStore } = await import('../src/services');
  const { partesCivil, inicioSemanaCivil, chaveSemanaCivil } = await import('../src/fuso');

  const antes = await getStore().dashboard();
  const inicioSemana = inicioSemanaCivil(new Date());
  const domingoAnterior = new Date(inicioSemana.getTime() - 1);
  const pDom = partesCivil(domingoAnterior);
  const isoDom = `${pDom.ano}-${String(pDom.mes).padStart(2, '0')}-${String(pDom.dia).padStart(2, '0')}`;
  const pSeg = partesCivil(inicioSemana);
  const isoSeg = `${pSeg.ano}-${String(pSeg.mes).padStart(2, '0')}-${String(pSeg.dia).padStart(2, '0')}`;

  const ids: number[] = [];
  try {
    for (const [quando, qtd] of [[`${isoDom}T23:59:59-03:00`, 7], [`${isoSeg}T00:00:00-03:00`, 3]] as const) {
      const r = await query(`INSERT INTO ordens_fabricacao (status, quantidade, tipo, concluida_em) VALUES ('concluida', $1, 'tamanho', $2::timestamptz) RETURNING id`, [
        qtd,
        quando,
      ]);
      ids.push(Number(r.rows[0].id));
    }

    const depois = await getStore().dashboard();
    const deltaSemana = (semana: string) =>
      (depois.producaoPorSemana.find((w) => w.semana === semana)?.pecas ?? 0) - (antes.producaoPorSemana.find((w) => w.semana === semana)?.pecas ?? 0);
    const semanaDoDomingo = chaveSemanaCivil(domingoAnterior);
    assert.ok(depois.producaoPorSemana.some((w) => w.semana === semanaDoDomingo), 'a semana do domingo precisa existir na série');
    assert.equal(deltaSemana(semanaDoDomingo), 7, 'OP de domingo 23:59 BR entra na semana civil da segunda anterior');
    assert.equal(deltaSemana(isoSeg), 3, 'OP de segunda 00:00 BR abre a semana corrente');
  } finally {
    if (ids.length) await query(`DELETE FROM ordens_fabricacao WHERE id = ANY($1::int[])`, [ids]);
  }
});
