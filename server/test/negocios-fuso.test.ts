// ============================================================================
// FUSO DO NEGÓCIO — o dia civil do BI é o de America/Sao_Paulo (UTC−03:00).
//
// Antes desta correção, De/Até e `data` usavam o dia UTC de `occurred_at`:
// uma venda às 22h de Brasília (01h UTC do dia seguinte) caía no dia e no
// mês errados. Estes testes fixam as fronteiras:
//
//   • início do dia  (00:00 BRT = 03:00 UTC);
//   • fim do dia     (23:59:59,999 BRT = 02:59:59,999 UTC do dia seguinte);
//   • virada UTC/Brasília (21h–24h de Brasília);
//   • virada de mês e de ano;
//   • a curva ABC usa a mesma janela.
//
// Os testes de fronteira rodam em modo memória com a MESMA função de
// intervalo que o SQL (`timestamptz`). A prova contra Postgres real está em
// pg-negocios.test.ts (job de integração).
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord } = await import('../src/services');
const neg = await import('../src/negocios');
const {
  __reiniciarMemoriaNegocios,
  diaDoNegocio,
  fimExclusivoDiaNegocio,
  inicioDiaNegocio,
  negociosResumo,
  negociosVendaManual,
  repoNegocios,
  DESLOCAMENTO_NEGOCIO_HORAS,
} = neg;

const admin = { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil: 'admin' as const };
const gerente = { id: 2, name: 'Gerente', email: 'gerente@brobond.com.br', perfil: 'gerente' as const };

function mockReq(user: any, query: Record<string, string> = {}, body: any = {}): any {
  return { user, query, body, params: {} };
}
function mockRes(): { res: any; payload: () => any; code: () => number } {
  let _payload: any;
  let _status = 0;
  const res: any = {
    json: (d: any) => {
      _payload = d;
      if (!_status) _status = 200;
      return res;
    },
    status: (s: number) => {
      _status = s;
      return res;
    },
    setHeader: () => res,
  };
  return { res, payload: () => _payload, code: () => _status };
}
async function chamar(handler: (req: any, res: any) => Promise<unknown>, req: any) {
  const r = mockRes();
  await handler(req, r.res);
  return { code: r.code(), payload: r.payload() };
}

let produto = 0;
before(async () => {
  produto = Number((await createRecord(RESOURCES.produtos, { sku: 'FUSO-1', nome: 'Peça Fuso', ncm: '6109.10.00', custo: 10, preco_venda: 50 }, admin)).id);
});

/** Registra uma venda PAID de R$ 1,00 com `occurred_at` em ISO (com fuso explícito). */
async function vendaEm(iso: string, valorCents = 100) {
  const r = await chamar(negociosVendaManual, mockReq(gerente, {}, {
    canal: 'LOJA_FISICA',
    status: 'PAID',
    occurred_at: iso,
    itens: [{ product_id: produto, quantity: 1, unit_price_cents: valorCents }],
  }));
  assert.equal(r.code, 201, `venda em ${iso} precisa ser registrada`);
  return r.payload.venda;
}

async function faturamentoNoDia(de: string, ate: string = de): Promise<{ faturamentoCents: number; pedidos: number }> {
  const r = await chamar(negociosResumo, mockReq(gerente, { de, ate }));
  return { faturamentoCents: r.payload.kpis.faturamentoCents, pedidos: r.payload.kpis.pedidos };
}

// ----------------------------------------------------------------------------
// 1) Funções puras: o intervalo do dia civil de Brasília
// ----------------------------------------------------------------------------

test('fuso: Brasília é UTC−03:00 fixo (sem horário de verão desde 2019)', () => {
  assert.equal(DESLOCAMENTO_NEGOCIO_HORAS, 3);
});

test('início do dia: 08/10/2026 em Brasília começa às 03:00 UTC', () => {
  assert.equal(inicioDiaNegocio('2026-10-08').toISOString(), '2026-10-08T03:00:00.000Z');
});

test('fim do dia (exclusivo): 08/10/2026 termina às 03:00 UTC de 09/10', () => {
  assert.equal(fimExclusivoDiaNegocio('2026-10-08').toISOString(), '2026-10-09T03:00:00.000Z');
});

test('dia de um instante: fronteiras exatas da meia-noite de Brasília', () => {
  // 00:00:00,000 BRT do dia 08 = 03:00 UTC → dia 08
  assert.equal(diaDoNegocio(new Date('2026-10-08T03:00:00.000Z')), '2026-10-08');
  // um milissegundo antes: 23:59:59,999 BRT do dia 07 → dia 07
  assert.equal(diaDoNegocio(new Date('2026-10-08T02:59:59.999Z')), '2026-10-07');
});

test('dia de um instante: fim do dia 08 às 23:59:59,999 BRT ainda é 08', () => {
  // 23:59:59,999 BRT = 02:59:59,999 UTC do dia 09
  assert.equal(diaDoNegocio(new Date('2026-10-09T02:59:59.999Z')), '2026-10-08');
  // 00:00 BRT do dia 09 → dia 09
  assert.equal(diaDoNegocio(new Date('2026-10-09T03:00:00.000Z')), '2026-10-09');
});

test('virada UTC/Brasília: 22h BRT (01h UTC do dia seguinte) pertence ao dia civil de Brasília', () => {
  // 22:30 BRT de 08/10 = 01:30 UTC de 09/10. Com o filtro UTC, este pedido
  // sairia do dia 08 e iria para o dia 09 — o bug que esta correção fecha.
  assert.equal(diaDoNegocio(new Date('2026-10-09T01:30:00.000Z')), '2026-10-08');
});

test('virada de mês: 31/10 às 22h BRT = 01/11 UTC pertence a outubro', () => {
  assert.equal(diaDoNegocio(new Date('2026-11-01T01:00:00.000Z')), '2026-10-31');
  assert.equal(inicioDiaNegocio('2026-11-01').toISOString(), '2026-11-01T03:00:00.000Z');
});

test('virada de ano: 31/12 às 21h30 BRT = 01/01 UTC pertence a dezembro', () => {
  assert.equal(diaDoNegocio(new Date('2027-01-01T00:30:00.000Z')), '2026-12-31');
  assert.equal(fimExclusivoDiaNegocio('2026-12-31').toISOString(), '2027-01-01T03:00:00.000Z');
});

// ----------------------------------------------------------------------------
// 2) Ponta a ponta no BI (memória): De/Até e `data` seguem o dia de Brasília
// ----------------------------------------------------------------------------

test('início do dia: venda às 00:00 BRT entra no dia 08 e não no dia 07', async () => {
  __reiniciarMemoriaNegocios();
  const v = await vendaEm('2026-10-08T03:00:00.000Z');
  assert.equal(v.data, '2026-10-08', 'campo data é o dia civil de Brasília');
  assert.equal(v.mes, '2026-10');
  assert.deepEqual(await faturamentoNoDia('2026-10-08'), { faturamentoCents: 100, pedidos: 1 });
  assert.deepEqual(await faturamentoNoDia('2026-10-07'), { faturamentoCents: 0, pedidos: 0 });
});

test('fim do dia: venda às 23:59:59,999 BRT entra no dia 08 e não no dia 09', async () => {
  __reiniciarMemoriaNegocios();
  const v = await vendaEm('2026-10-09T02:59:59.999Z');
  assert.equal(v.data, '2026-10-08');
  assert.deepEqual(await faturamentoNoDia('2026-10-08'), { faturamentoCents: 100, pedidos: 1 });
  assert.deepEqual(await faturamentoNoDia('2026-10-09'), { faturamentoCents: 0, pedidos: 0 });
});

test('fim do dia: venda às 00:00 BRT do dia 09 já é do dia 09', async () => {
  __reiniciarMemoriaNegocios();
  await vendaEm('2026-10-09T03:00:00.000Z');
  assert.deepEqual(await faturamentoNoDia('2026-10-08'), { faturamentoCents: 0, pedidos: 0 });
  assert.deepEqual(await faturamentoNoDia('2026-10-09'), { faturamentoCents: 100, pedidos: 1 });
});

test('virada UTC/Brasília: venda das 22h30 BRT do dia 08 aparece no dia 08 (não no 09)', async () => {
  __reiniciarMemoriaNegocios();
  const v = await vendaEm('2026-10-09T01:30:00.000Z');
  assert.equal(v.data, '2026-10-08', 'o dia civil é 08 mesmo com UTC já em 09');
  assert.deepEqual(await faturamentoNoDia('2026-10-08'), { faturamentoCents: 100, pedidos: 1 });
  assert.deepEqual(await faturamentoNoDia('2026-10-09'), { faturamentoCents: 0, pedidos: 0 });
});

test('intervalo de 21h–24h BRT: as três horas noturnas caem no mesmo dia civil', async () => {
  __reiniciarMemoriaNegocios();
  await vendaEm('2026-10-09T00:00:00.000Z'); // 21:00 BRT de 08
  await vendaEm('2026-10-09T01:59:00.000Z'); // 22:59 BRT de 08
  await vendaEm('2026-10-09T02:59:59.999Z'); // 23:59:59,999 BRT de 08
  assert.deepEqual(await faturamentoNoDia('2026-10-08'), { faturamentoCents: 300, pedidos: 3 });
  assert.deepEqual(await faturamentoNoDia('2026-10-09'), { faturamentoCents: 0, pedidos: 0 });
});

test('virada de mês: 31/10 às 22h BRT conta em outubro e não em novembro', async () => {
  __reiniciarMemoriaNegocios();
  const v = await vendaEm('2026-11-01T01:00:00.000Z');
  assert.equal(v.data, '2026-10-31');
  assert.equal(v.mes, '2026-10');
  assert.deepEqual(await faturamentoNoDia('2026-10-01', '2026-10-31'), { faturamentoCents: 100, pedidos: 1 });
  assert.deepEqual(await faturamentoNoDia('2026-11-01', '2026-11-30'), { faturamentoCents: 0, pedidos: 0 });
});

test('virada de mês: 01/11 à meia-noite BRT já conta em novembro', async () => {
  __reiniciarMemoriaNegocios();
  await vendaEm('2026-11-01T03:00:00.000Z');
  assert.deepEqual(await faturamentoNoDia('2026-10-01', '2026-10-31'), { faturamentoCents: 0, pedidos: 0 });
  assert.deepEqual(await faturamentoNoDia('2026-11-01', '2026-11-01'), { faturamentoCents: 100, pedidos: 1 });
});

test('virada de ano: 31/12 às 21h30 BRT conta em 2026, não em 2027', async () => {
  __reiniciarMemoriaNegocios();
  const v = await vendaEm('2027-01-01T00:30:00.000Z');
  assert.equal(v.data, '2026-12-31');
  assert.deepEqual(await faturamentoNoDia('2026-12-31'), { faturamentoCents: 100, pedidos: 1 });
  assert.deepEqual(await faturamentoNoDia('2027-01-01'), { faturamentoCents: 0, pedidos: 0 });
});

test('De/Até inclusivos no dia civil: período 07 a 08 inclui as duas pontas de Brasília', async () => {
  __reiniciarMemoriaNegocios();
  await vendaEm('2026-10-07T02:59:59.999Z'); // 23:59:59,999 BRT do dia 06 → fora
  await vendaEm('2026-10-07T03:00:00.000Z'); // 00:00 BRT do dia 07 → dentro
  await vendaEm('2026-10-09T02:59:59.999Z'); // 23:59:59,999 BRT do dia 08 → dentro
  await vendaEm('2026-10-09T03:00:00.000Z'); // 00:00 BRT do dia 09 → fora
  const r = await chamar(negociosResumo, mockReq(gerente, { de: '2026-10-07', ate: '2026-10-08' }));
  assert.equal(r.payload.kpis.pedidos, 2);
  assert.equal(r.payload.kpis.faturamentoCents, 200);
});

test('curva ABC: a janela De/Até usa o mesmo dia civil de Brasília', async () => {
  __reiniciarMemoriaNegocios();
  await vendaEm('2026-10-09T01:30:00.000Z'); // dia 08 às 22h30 BRT
  await vendaEm('2026-10-09T03:00:00.000Z'); // dia 09 à meia-noite BRT
  const repo = repoNegocios();
  await repo.recalcularCurvaABC({ de: '2026-10-08', ate: '2026-10-08' });
  const linhas = await repo.curvaABC(null, null);
  const total = linhas.reduce((s, l) => s + l.faturamentoCents, 0);
  assert.equal(total, 100, 'só a venda do dia 08 entra na janela');
});

test('filtro De/Até grava e lê o mesmo dia: nenhuma venda some na fronteira', async () => {
  __reiniciarMemoriaNegocios();
  // Uma venda em cada hora de um dia inteiro (em UTC, 03:00 do dia 08 até 02:59 do dia 09).
  const instantes = [0, 1, 6, 12, 18, 21, 23].map((h) => `2026-10-08T${String(h).padStart(2, '0')}:30:00.000Z`);
  for (const iso of instantes) await vendaEm(iso);
  const total = await faturamentoNoDia('2026-10-07', '2026-10-08');
  // 00:30Z do dia 08 = 21:30 BRT do dia 07 → dia 07; os demais são dia 07 ou 08
  // conforme a hora UTC. Todas as 7 vendas precisam estar em algum dos dois dias.
  const dia07 = await faturamentoNoDia('2026-10-07');
  const dia08 = await faturamentoNoDia('2026-10-08');
  assert.equal(total.pedidos, 7, 'nenhuma venda perdida entre os dois dias');
  assert.equal(dia07.pedidos + dia08.pedidos, 7);
});
