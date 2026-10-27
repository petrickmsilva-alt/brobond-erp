// ============================================================================
// FISCAL 3.0 — OBRIGAÇÕES ACESSÓRIAS E CALENDÁRIO (migration 0055)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) o vencimento é CALCULADO (competência + dia, no mês seguinte), inclusive
//      com dia 31 em mês de 30 dias;
//   B) competência sem entrega vencida aparece como ATRASADA (derivada);
//   C) registrar entrega exige PROTOCOLO (400) e grava protocolo/arquivo;
//   D) a mesma competência não gera segunda entrega (idempotência por UPSERT);
//   E) dispensar exige motivo; entrega dispensada não aparece como atrasada;
//   F) isolamento multiempresa: obrigação de A não existe para B;
//   G) NADA de imposto: o retorno não traz alíquota/valor apurado.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const { calendarioFiscal, registrarEntregaFiscal, historicoObrigacaoFiscal, vencimentoDe } = await import('../src/fiscalObrigacoes');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;
let gerenteB: any;

async function chamar(handler: any, opts: { id?: number; body?: any; actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: opts.id ? { id: String(opts.id) } : {}, body: opts.body ?? {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

const erro = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e: any) {
    return { status: Number(e.status ?? e.statusCode ?? 0), message: String(e.message ?? '') };
  }
  throw new Error('esperava erro, mas passou');
};

let seq = 0;
async function novaObrigacao(extra: Record<string, unknown> = {}) {
  seq++;
  const o = await createRecord(
    RESOURCES.fiscal_obrigacoes,
    { codigo: `SPED_${seq}_${Date.now() % 100000}`, nome: `SPED Fiscal ${seq}`, tipo: 'sped_fiscal', periodicidade: 'mensal', dia_vencimento: 15, ...extra },
    admin
  );
  return Number(o.id);
}

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  gerenteB = await criarAtor(2, 'gerente');
});

test('A) vencimento calculado no mês seguinte, com clamp do último dia', () => {
  assert.equal(vencimentoDe('2026-03', 15), '2026-04-15');
  assert.equal(vencimentoDe('2026-12', 20), '2027-01-20');
  assert.equal(vencimentoDe('2026-04', 31), '2026-05-31');
  assert.equal(vencimentoDe('2026-01', 31), '2026-02-28', 'fevereiro de 2026 tem 28 dias');
});

test('B) competência vencida e não entregue aparece como ATRASADA', async () => {
  const id = await novaObrigacao({ dia_vencimento: 15 });
  const out = await chamar(calendarioFiscal, { actor: gerente, query: { de: '2026-01', ate: '2026-01' } });
  const linha = out.obrigacoes.find((o: any) => o.obrigacao_id === id);
  assert.ok(linha);
  assert.equal(linha.vencimento, '2026-02-15');
  assert.equal(linha.status, 'atrasada', 'vencimento no passado e sem entrega é atraso');
  assert.equal(linha.entrega_id, null);
  assert.ok(out.resumo.atrasadas >= 1);
});

test('C) registrar entrega exige protocolo', async () => {
  const id = await novaObrigacao();
  const semProtocolo = await erro(() => chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-01' }, actor: gerente }));
  assert.equal(semProtocolo.status, 400);
  assert.match(semProtocolo.message, /protocolo/i);

  const ok = await chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-01', protocolo: 'PRT-123', arquivo_ref: 'sped/2026-01.txt' }, actor: gerente });
  assert.equal(ok.status, 'entregue');
  assert.equal(ok.competencia, '2026-01');
  const historico = await chamar(historicoObrigacaoFiscal, { id, actor: gerente });
  assert.equal(historico.entregas.length, 1);
  assert.equal(historico.entregas[0].protocolo, 'PRT-123');
  assert.equal(historico.entregas[0].status_derivado, 'entregue');
});

test('D) mesma competência não cria segunda entrega', async () => {
  const id = await novaObrigacao();
  await chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-02', protocolo: 'P-1' }, actor: gerente });
  await chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-02', protocolo: 'P-2' }, actor: gerente });
  const entregas = await listRecords(RESOURCES.fiscal_obrigacao_entregas, { page: 1, pageSize: 50, filter: { obrigacao_id: id } });
  assert.equal(entregas.total, 1, 'uma entrega por competência (UPSERT), nunca duplicada');
  assert.equal(entregas.rows[0].protocolo, 'P-2', 'a última informação corrige a anterior');
});

test('E) dispensar exige motivo e não conta como atraso', async () => {
  const id = await novaObrigacao();
  const semMotivo = await erro(() => chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-01', status: 'dispensada' }, actor: gerente }));
  assert.equal(semMotivo.status, 400);
  await chamar(registrarEntregaFiscal, { id, body: { competencia: '2026-01', status: 'dispensada', motivo_dispensa: 'Sem movimento no período' }, actor: gerente });
  const out = await chamar(calendarioFiscal, { actor: gerente, query: { de: '2026-01', ate: '2026-01' } });
  const linha = out.obrigacoes.find((o: any) => o.obrigacao_id === id);
  assert.equal(linha.status, 'dispensada');
});

test('F) isolamento multiempresa', async () => {
  const id = await novaObrigacao();
  const e = await erro(() => chamar(historicoObrigacaoFiscal, { id, actor: gerenteB }));
  assert.equal(e.status, 404);
  const outB = await chamar(calendarioFiscal, { actor: gerenteB, query: { de: '2026-01', ate: '2026-01' } });
  assert.equal(outB.obrigacoes.some((o: any) => o.obrigacao_id === id), false, 'obrigação de A não aparece no calendário de B');
});

test('G) o calendário não calcula imposto', async () => {
  const out = await chamar(calendarioFiscal, { actor: gerente, query: { de: '2026-01', ate: '2026-01' } });
  // Nada de alíquota/valor apurado nas LINHAS: o controle é de prazo e prova.
  // (A palavra "alíquota" aparece só no texto `regra`, que documenta a ausência.)
  for (const linha of out.obrigacoes) {
    for (const chave of ['aliquota', 'aliquota_pct', 'imposto', 'imposto_apurado', 'valor_apurado', 'base_calculo', 'valor_imposto']) {
      assert.equal(Object.hasOwn(linha, chave), false, `linha não deve trazer ${chave}`);
    }
  }
  assert.match(String(out.regra), /não calcula imposto/i);
});

test('H) periodicidade anual só aparece em dezembro', async () => {
  const id = await novaObrigacao({ periodicidade: 'anual', tipo: 'defis', dia_vencimento: 31 });
  const janeiro = await chamar(calendarioFiscal, { actor: gerente, query: { de: '2026-01', ate: '2026-01' } });
  assert.equal(janeiro.obrigacoes.some((o: any) => o.obrigacao_id === id), false);
  const dezembro = await chamar(calendarioFiscal, { actor: gerente, query: { de: '2026-12', ate: '2026-12' } });
  assert.equal(dezembro.obrigacoes.some((o: any) => o.obrigacao_id === id), true);
});
