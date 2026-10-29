// ============================================================================
// P2-15 — CALENDÁRIO PRODUTIVO (migration 0062)
//
// O que este arquivo trava (banco de demonstração, mesmo contrato do PG):
//   A) semana sem feriado = seg–sex (nada muda em base sem feriado);
//   B) feriado pontual desconta UM dia útil;
//   C) feriado RECORRENTE vale em outro ano no mesmo dia/mês;
//   D) feriado inativo é ignorado;
//   E) feriado em fim de semana NÃO desconta dia útil (não conta duas vezes);
//   F) capacidade de produção usa o calendário e devolve quais feriados entraram;
//   G) ISOLAMENTO A × B: feriado da empresa 2 não afeta a capacidade da 1.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { calendarioDoPeriodo, diasUteis, feriadosDoPeriodo } = await import('../src/calendario');
const { capacidadeProducao } = await import('../src/producaoCapacidade');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;

let seq = 0;
const unico = () => `${Date.now() % 100000}-${++seq}`;

async function chamar(handler: any, opts: { actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: {}, body: {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

const criarFeriado = (empresaId: number, dados: Record<string, unknown>) =>
  createRecord(RESOURCES.feriados, dados, admin, { escopo: { kind: 'empresa', empresaId } } as any);

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  await criarAtor(2, 'gerente');
});

// Semana de referência: 2026-03-02 (segunda) a 2026-03-06 (sexta) = 5 dias úteis.
const DE = '2026-03-02';
const ATE = '2026-03-06';

test('A) semana sem feriado: 5 dias úteis e nenhum feriado considerado', async () => {
  const cal = await calendarioDoPeriodo(1, DE, ATE);
  assert.equal(cal.dias_corridos, 5);
  assert.equal(cal.fins_de_semana, 0);
  assert.equal(cal.feriados_considerados, 0);
  assert.equal(cal.dias_uteis, 5, 'seg–sex sem feriado');
  assert.equal(await diasUteis(1, DE, ATE), 5);
});

test('B) feriado pontual desconta um dia útil e aparece na lista', async () => {
  await criarFeriado(1, { data: '2026-03-04', nome: `Feriado pontual ${unico()}`, tipo: 'nacional' });
  const cal = await calendarioDoPeriodo(1, DE, ATE);
  assert.equal(cal.dias_uteis, 4, 'quarta-feira de feriado sai da conta');
  assert.equal(cal.feriados_considerados, 1);
  assert.equal(cal.feriados[0].data, '2026-03-04');
  assert.equal(cal.feriados[0].recorrente, false);
});

test('C) feriado recorrente vale em outro ano no mesmo dia/mês', async () => {
  // Cadastrado em 2026, mas recorrente: 25/12 vale em 2027 também.
  await criarFeriado(1, { data: '2026-12-25', nome: `Natal ${unico()}`, tipo: 'nacional', recorrente: true });
  const em2026 = await feriadosDoPeriodo(1, '2026-12-20', '2026-12-31');
  const em2027 = await feriadosDoPeriodo(1, '2027-12-20', '2027-12-31');
  assert.equal(em2026.some((f) => f.data === '2026-12-25'), true);
  assert.equal(em2027.some((f) => f.data === '2027-12-25'), true, 'recorrente vale no ano seguinte');
  assert.equal(em2027.find((f) => f.data === '2027-12-25')!.recorrente, true);
});

test('D) feriado inativo é ignorado', async () => {
  const criado = await criarFeriado(1, { data: '2026-03-05', nome: `Inativo ${unico()}`, tipo: 'empresa', ativo: false });
  assert.ok(criado.id);
  const cal = await calendarioDoPeriodo(1, DE, ATE);
  assert.equal(cal.feriados.some((f) => f.data === '2026-03-05'), false, 'inativo não entra');
});

test('E) feriado em fim de semana não desconta dia útil', async () => {
  // 2026-03-07 é sábado.
  await criarFeriado(1, { data: '2026-03-07', nome: `Sábado ${unico()}`, tipo: 'municipal' });
  const cal = await calendarioDoPeriodo(1, DE, '2026-03-08');
  assert.equal(cal.fins_de_semana, 2);
  assert.equal(cal.feriados_considerados, 2, 'o sábado de feriado é listado');
  // Só a quarta (03-04) reduz dia útil: 5 úteis − 1 = 4.
  assert.equal(cal.dias_uteis, 4, 'feriado no fim de semana não reduz duas vezes');
});

test('F) capacidade devolve o calendário usado (feriados auditáveis)', async () => {
  const out = await chamar(capacidadeProducao, { actor: gerente, query: { de: DE, ate: ATE } });
  assert.ok(out.calendario, 'capacidade declara o calendário');
  assert.equal(out.calendario.dias_uteis, out.dias_uteis);
  assert.equal(out.calendario.dias_uteis, 4);
  assert.ok(out.calendario.feriados.some((f: any) => f.data === '2026-03-04'));
  assert.match(String(out.regra), /feriados cadastrados/i);
  assert.match(String(out.regra), /nada é derivado/i);
});

test('G) ISOLAMENTO A × B: feriado da empresa 2 não muda a capacidade da 1', async () => {
  const empresaA = escopoDeSistema(1);
  const empresaB = escopoDeSistema(2);
  assert.equal(empresaA.empresaId, 1);
  assert.equal(empresaB.empresaId, 2);

  // Segunda-feira 2026-03-09: feriado só na empresa 2.
  await criarFeriado(2, { data: '2026-03-09', nome: `Feriado B ${unico()}`, tipo: 'empresa' });
  const calA = await calendarioDoPeriodo(1, '2026-03-09', '2026-03-09');
  const calB = await calendarioDoPeriodo(2, '2026-03-09', '2026-03-09');
  assert.equal(calA.dias_uteis, 1, 'empresa 1 trabalha na segunda');
  assert.equal(calB.dias_uteis, 0, 'empresa 2 parou na segunda');

  const listaA = await feriadosDoPeriodo(1, '2026-03-09', '2026-03-09');
  const listaB = await feriadosDoPeriodo(2, '2026-03-09', '2026-03-09');
  assert.equal(listaA.length, 0, 'empresa 1 não vê o feriado da 2');
  assert.equal(listaB.length, 1);
});

test('H) o MRP declara o calendário e a capacidade considera feriado', async () => {
  const { mrpProducao } = await import('../src/producaoCapacidade');
  const out = await chamar(mrpProducao, { actor: gerente, query: { de: DE, ate: ATE } });
  assert.ok(out.calculo.calendario, 'MRP devolve o calendário usado');
  assert.equal(out.calculo.calendario.dias_uteis, 4);
  assert.equal(out.calculo.calendario.feriados_considerados >= 1, true);
  assert.equal(
    out.calculo.coberto.some((x: string) => x.includes('feriados')),
    true,
    'feriados deixaram de ser lacuna declarada'
  );
});

test('metadados: feriado é cadastro da empresa, com RBAC de gerente', () => {
  const r = RESOURCES.feriados;
  assert.ok(r, 'recurso feriados deve existir');
  assert.equal(r.empresa, true);
  assert.equal(r.minPerfil, 'gerente');
  const nomes = r.fields.map((f) => f.name);
  for (const campo of ['data', 'nome', 'tipo', 'recorrente', 'ativo']) assert.ok(nomes.includes(campo), `campo ${campo}`);
  const recorrente = r.fields.find((f) => f.name === 'recorrente');
  assert.match(String(recorrente!.hint), /móve(is|l)/i, 'o campo explica que feriado móvel não é calculado');
});

test('feriados recorrentes aparecem em cada ano e leitura inclui páginas posteriores', async () => {
  const s = getStore(); const original = s.list.bind(s);
  s.list = async (r, opts, tx) => original(r, r.key === 'feriados' ? { ...opts, pageSize: 1 } : opts, tx);
  try {
    const lista = await feriadosDoPeriodo(1, '2026-12-20', '2028-12-31');
    for (const ano of ['2026', '2027', '2028']) assert.ok(lista.some((f) => f.data === `${ano}-12-25` && f.recorrente));
  } finally { s.list = original; }
});
