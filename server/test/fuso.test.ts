// ============================================================================
// FUSO DO NEGÓCIO (America/Sao_Paulo) — testes OBRIGATÓRIOS da Etapa 2.1.
//
// Cobre os limites de dia civil que o antigo agrupamento em UTC quebrava:
//   1. início do dia        5. 23:59 Brasília
//   2. final do dia         6. virada de mês (31/01 21:00 BR continua janeiro)
//   3. 20:59 Brasília       7. virada de ano
//   4. 21:00 Brasília       8. virada de semana (semana civil = segunda)
//
// Além dos helpers JS (usados pelo memdb), há:
//   • teste de integração do dashboard em memória (vendasPorMes /
//     producaoPorSemana no limite do mês/semana civil);
//   • prova das expressões SQL geradas (a prova contra Postgres real está em
//     pg-fuso.test.ts, que roda no job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const {
  FUSO_NEGOCIO,
  sqlCivil,
  sqlInicioDiaCivil,
  sqlFimDiaCivil,
  partesCivil,
  diaCivil,
  mesCivil,
  inicioDiaCivil,
  fimDiaCivil,
  inicioSemanaCivil,
  chaveSemanaCivil,
  inicioMesCivil,
  deslocarMesCivil,
} = await import('../src/fuso');
const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');

// ---------------------------------------------------------------------------
// 1) Início e final do dia civil (horário de Brasília)
// ---------------------------------------------------------------------------

test('fuso: início do dia civil é 00:00:00 em Brasília (03:00 UTC, sem horário de verão)', () => {
  // 2026-06-15 12:34:56 BR
  const inicio = inicioDiaCivil('2026-06-15T12:34:56-03:00');
  assert.equal(inicio.toISOString(), '2026-06-15T03:00:00.000Z', '00:00 BR = 03:00 UTC (offset -03:00)');
  const p = partesCivil(inicio);
  assert.deepEqual([p.ano, p.mes, p.dia, p.hora, p.minuto, p.segundo], [2026, 6, 15, 0, 0, 0]);
});

test('fuso: final do dia civil é 23:59:59.999 em Brasília', () => {
  const fim = fimDiaCivil('2026-06-15T12:34:56-03:00');
  assert.equal(fim.toISOString(), '2026-06-16T02:59:59.999Z');
  const p = partesCivil(fim);
  assert.deepEqual([p.ano, p.mes, p.dia, p.hora, p.minuto, p.segundo], [2026, 6, 15, 23, 59, 59]);
});

// ---------------------------------------------------------------------------
// 2) 20:59 / 21:00 / 23:59 de Brasília no último dia do mês
// ---------------------------------------------------------------------------

test('fuso: 20:59 e 21:00 de Brasília no último dia do mês continuam no MESMO mês civil', () => {
  // 31/01/2026 21:00 BR = 01/02/2026 00:00 UTC — em UTC cairía em fevereiro.
  assert.equal(diaCivil('2026-01-31T20:59:00-03:00'), '2026-01-31');
  assert.equal(diaCivil('2026-01-31T21:00:00-03:00'), '2026-01-31', '21:00 BR de 31/01 é 31/01 (não 01/02)');
  assert.equal(mesCivil('2026-01-31T21:00:00-03:00'), '2026-01', 'virada de mês em UTC não pode mudar o mês civil');
  assert.equal(mesCivil('2026-01-31T23:59:59-03:00'), '2026-01');
});

test('fuso: 21:00 de Brasília no último dia do mês vira o dia SEGUINTE só à meia-noite', () => {
  assert.equal(diaCivil('2026-01-31T23:59:59-03:00'), '2026-01-31');
  assert.equal(diaCivil('2026-02-01T00:00:00-03:00'), '2026-02-01', '00:00 BR de 01/02 já é fevereiro');
  assert.equal(mesCivil('2026-02-01T00:00:00-03:00'), '2026-02');
});

test('fuso: 23:59 de Brasília pertence ao dia civil corrente', () => {
  const p = partesCivil('2026-03-10T23:59:59-03:00');
  assert.deepEqual([p.ano, p.mes, p.dia, p.hora, p.minuto], [2026, 3, 10, 23, 59]);
  assert.equal(diaCivil('2026-03-10T23:59:59-03:00'), '2026-03-10');
});

// ---------------------------------------------------------------------------
// 3) Virada de ano
// ---------------------------------------------------------------------------

test('fuso: virada de ano — 31/12 23:59 BR é dezembro; 01/01 00:00 BR é janeiro do ano seguinte', () => {
  assert.equal(mesCivil('2025-12-31T23:59:59-03:00'), '2025-12');
  assert.equal(diaCivil('2025-12-31T23:59:59-03:00'), '2025-12-31');
  assert.equal(mesCivil('2026-01-01T00:00:00-03:00'), '2026-01');
  assert.equal(diaCivil('2026-01-01T00:00:00-03:00'), '2026-01-01');
  // O mesmo instante visto em UTC (03:00 de 01/01) continua sendo 31/12 em Brasília.
  assert.equal(diaCivil('2026-01-01T02:59:59.999Z'), '2025-12-31');
  assert.equal(mesCivil('2026-01-01T02:59:59.999Z'), '2025-12');
});

test('fuso: deslocarMesCivil cruza a virada de ano nos dois sentidos', () => {
  assert.deepEqual(deslocarMesCivil('2026-01-15T12:00:00-03:00', -1), { ano: 2025, mes: 12 });
  assert.deepEqual(deslocarMesCivil('2025-12-15T12:00:00-03:00', 1), { ano: 2026, mes: 1 });
  assert.deepEqual(deslocarMesCivil('2026-10-08T12:00:00-03:00', -11), { ano: 2025, mes: 11 });
});

// ---------------------------------------------------------------------------
// 4) Virada de semana (semana civil começa na segunda, horário de Brasília)
// ---------------------------------------------------------------------------

test('fuso: virada de semana — domingo 23:59 BR pertence à semana que começou na segunda anterior', () => {
  // 2026-10-04 é domingo; a semana civil dele começou em 2026-09-28 (segunda).
  assert.equal(chaveSemanaCivil('2026-10-04T23:59:59-03:00'), '2026-09-28');
  // 2026-10-05 00:00 BR (segunda) já abre a semana seguinte.
  assert.equal(chaveSemanaCivil('2026-10-05T00:00:00-03:00'), '2026-10-05');
});

test('fuso: início da semana civil é segunda 00:00 BR; sábado e domingo ficam no mesmo bucket', () => {
  const inicio = inicioSemanaCivil('2026-10-08T15:00:00-03:00'); // quinta-feira
  assert.equal(inicio.toISOString(), '2026-10-05T03:00:00.000Z', 'segunda 00:00 BR = 03:00 UTC');
  assert.equal(chaveSemanaCivil('2026-10-10T12:00:00-03:00'), '2026-10-05', 'sábado pertence à semana da segunda');
  assert.equal(chaveSemanaCivil('2026-10-11T12:00:00-03:00'), '2026-10-05', 'domingo pertence à semana da segunda');
  assert.equal(chaveSemanaCivil('2026-10-12T00:00:00-03:00'), '2026-10-12', 'segunda-feira abre semana nova');
});

test('fuso: virada de semana no limite do ano — domingo 28/12/2025 pertence à semana de 22/12', () => {
  assert.equal(chaveSemanaCivil('2025-12-28T23:00:00-03:00'), '2025-12-22');
  assert.equal(chaveSemanaCivil('2025-12-29T00:00:00-03:00'), '2025-12-29');
});

// ---------------------------------------------------------------------------
// 5) Integration: dashboard em memória agrupa por mês/semana CIVIL
// ---------------------------------------------------------------------------

test('dashboard (memória): faturamento de 21:00–23:59 BR do último dia do mês entra no mês civil correto', async () => {
  const s = getStore();
  const hoje = new Date();
  // Linha de base: o store em memória vem com dados de demonstração — o que
  // interessa é o DELTA causado pelos faturamentos de fronteira abaixo.
  const antes = await s.dashboard();

  // Último dia do mês civil anterior, em três horários de Brasília.
  const ultimoDiaMesAnterior = new Date(inicioMesCivil(hoje).getTime() - 1);
  const pUlt = partesCivil(ultimoDiaMesAnterior);
  const isoUlt = `${pUlt.ano}-${String(pUlt.mes).padStart(2, '0')}-${String(pUlt.dia).padStart(2, '0')}`;
  const mesAnterior = isoUlt.slice(0, 7);

  await s.insert(RESOURCES.vendas, { status: 'faturada', faturada_em: `${isoUlt}T20:59:00-03:00`, total: 100, data: isoUlt });
  await s.insert(RESOURCES.vendas, { status: 'faturada', faturada_em: `${isoUlt}T21:00:00-03:00`, total: 200, data: isoUlt });
  await s.insert(RESOURCES.vendas, { status: 'faturada', faturada_em: `${isoUlt}T23:59:59-03:00`, total: 300, data: isoUlt });

  // Primeiro dia do mês civil corrente, 00:00 BR.
  const pMes = partesCivil(inicioMesCivil(hoje));
  const isoMes = `${pMes.ano}-${String(pMes.mes).padStart(2, '0')}-01`;
  await s.insert(RESOURCES.vendas, { status: 'faturada', faturada_em: `${isoMes}T00:00:00-03:00`, total: 400, data: isoMes });

  const depois = await s.dashboard();
  const deltaMes = (mes: string) => (depois.vendasPorMes.find((m) => m.mes === mes)?.total ?? 0) - (antes.vendasPorMes.find((m) => m.mes === mes)?.total ?? 0);
  assert.ok(depois.vendasPorMes.some((m) => m.mes === mesAnterior), `o mês ${mesAnterior} precisa existir na série`);
  assert.ok(depois.vendasPorMes.some((m) => m.mes === isoMes.slice(0, 7)), `o mês ${isoMes.slice(0, 7)} precisa existir na série`);
  assert.equal(deltaMes(mesAnterior), 600, '20:59, 21:00 e 23:59 BR do último dia ficam no mês civil anterior');
  assert.equal(deltaMes(isoMes.slice(0, 7)), 400, '00:00 BR do dia 1 já é o mês civil corrente');

  // "Vendas do mês" (KPI) usa o mesmo mês civil.
  assert.equal(depois.vendasMes - antes.vendasMes, 400, 'vendasMes só conta o mês civil corrente');
});

test('dashboard (memória): produção concluída no domingo à noite entra na semana civil da segunda anterior', async () => {
  const s = getStore();
  const antes = await s.dashboard();
  const inicioSemana = inicioSemanaCivil(new Date());
  const domingoAnterior = new Date(inicioSemana.getTime() - 1);
  const pDom = partesCivil(domingoAnterior);
  const isoDom = `${pDom.ano}-${String(pDom.mes).padStart(2, '0')}-${String(pDom.dia).padStart(2, '0')}`;
  const pSeg = partesCivil(inicioSemana);
  const isoSeg = `${pSeg.ano}-${String(pSeg.mes).padStart(2, '0')}-${String(pSeg.dia).padStart(2, '0')}`;

  await s.insert(RESOURCES.ordens, { status: 'concluida', concluida_em: `${isoDom}T23:59:59-03:00`, quantidade: 7, tipo: 'tamanho' });
  await s.insert(RESOURCES.ordens, { status: 'concluida', concluida_em: `${isoSeg}T00:00:00-03:00`, quantidade: 3, tipo: 'tamanho' });

  const depois = await s.dashboard();
  const deltaSemana = (semana: string) => (depois.producaoPorSemana.find((w) => w.semana === semana)?.pecas ?? 0) - (antes.producaoPorSemana.find((w) => w.semana === semana)?.pecas ?? 0);
  const semanaDoDomingo = chaveSemanaCivil(domingoAnterior);
  assert.ok(depois.producaoPorSemana.some((w) => w.semana === semanaDoDomingo), 'a semana que contém o domingo precisa existir na série');
  assert.ok(depois.producaoPorSemana.some((w) => w.semana === isoSeg), 'a semana corrente precisa existir na série');
  assert.equal(deltaSemana(semanaDoDomingo), 7, 'OP concluída domingo 23:59 BR entra na semana civil da segunda anterior');
  assert.equal(deltaSemana(isoSeg), 3, 'OP concluída segunda 00:00 BR abre a semana corrente');
});

// ---------------------------------------------------------------------------
// 6) Expressões SQL (a prova contra Postgres real está em pg-fuso.test.ts)
// ---------------------------------------------------------------------------

test('fuso: expressões SQL usam America/Sao_Paulo nas frontières e nos agrupamentos', () => {
  assert.equal(FUSO_NEGOCIO, 'America/Sao_Paulo');
  assert.equal(sqlCivil('now()'), "(now() AT TIME ZONE 'America/Sao_Paulo')");
  assert.equal(sqlCivil('COALESCE(v.faturada_em, v.data)'), "(COALESCE(v.faturada_em, v.data) AT TIME ZONE 'America/Sao_Paulo')");
  // Fronteiras De/Até em parâmetros ($n), como o motor de BI exige.
  assert.equal(sqlInicioDiaCivil('$1'), "timezone('America/Sao_Paulo', $1::date::timestamp)");
  assert.equal(sqlFimDiaCivil('$2'), "timezone('America/Sao_Paulo', ($2::date + 1)::timestamp)");
  // A fronteira do dia é 03:00 UTC (00:00 BR): o teste de comportamento está no pg-fuso.
  assert.ok(!sqlInicioDiaCivil('$1').includes('UTC'), 'nenhuma fronteira pode depender do fuso do servidor');
  assert.ok(!sqlCivil('now()').includes('UTC'));
});
