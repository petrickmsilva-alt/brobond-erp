// ============================================================================
// FINANCEIRO 3.0 — ESTRUTURA CONTÁBIL (migration 0056)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) lançamento SEM conta contábil não é jogado em conta inventada: aparece
//      em `sem_classificacao` e o balancete avisa;
//   B) lançamento classificado soma débito/crédito por conta;
//   C) competência separada da data vale no recorte do período;
//   D) documento de origem é rastreado (`por_origem`);
//   E) nada é recriado: o balancete lê `lancamentos_financeiros`, não existe
//      segundo livro (a contagem de lançamentos não muda ao consultar);
//   F) plano de contas independente por empresa (isolamento);
//   G) resumo do plano de contas não sugere mapeamento automático.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const { balanceteFinanceiro, resumoPlanoContas } = await import('../src/financeiroContabil');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;
let gerenteB: any;
let receitaId: number;
let despesaId: number;

async function chamar(handler: any, opts: { actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: {}, body: {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

let seq = 0;

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  gerenteB = await criarAtor(2, 'gerente');
  const r = await createRecord(RESOURCES.plano_contas, { codigo: '4.01.001', nome: 'Receita de vendas', natureza: 'receita', tipo: 'analitica' }, admin);
  receitaId = Number(r.id);
  const d = await createRecord(RESOURCES.plano_contas, { codigo: '5.02.003', nome: 'Despesa administrativa', natureza: 'despesa', tipo: 'analitica' }, admin);
  despesaId = Number(d.id);
});

test('A) lançamento sem classificação não vira conta inventada', async () => {
  seq++;
  const l = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: '2026-02-10', tipo: 'despesa', descricao: `Sem conta ${seq}-${Date.now() % 100000}`, valor: 100 },
    admin
  );
  const out = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-02', ate: '2026-02' } });
  const achou = out.sem_classificacao.find((x: any) => x.lancamento_id === Number(l.id));
  assert.ok(achou, 'o lançamento sem conta aparece na lista de pendências');
  assert.equal(achou.motivo, 'Sem conta contábil');
  assert.ok(out.resumo.sem_classificacao >= 1);
});

test('B) balancete soma débito e crédito por conta', async () => {
  seq++;
  await createRecord(
    RESOURCES.lancamentos_financeiros,
    {
      data: '2026-03-05',
      competencia: '2026-03-31',
      tipo: 'receita',
      descricao: `Receita classificada ${seq}-${Date.now() % 100000}`,
      valor: 250.5,
      conta_contabil_id: receitaId,
      natureza_lancamento: 'credito',
      documento_origem_recurso: 'vendas',
      documento_origem_id: 99,
    },
    admin
  );
  seq++;
  await createRecord(
    RESOURCES.lancamentos_financeiros,
    {
      data: '2026-03-20',
      competencia: '2026-03-31',
      tipo: 'despesa',
      descricao: `Despesa classificada ${seq}-${Date.now() % 100000}`,
      valor: 100.5,
      conta_contabil_id: despesaId,
      natureza_lancamento: 'debito',
    },
    admin
  );
  const out = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-03', ate: '2026-03' } });
  const rec = out.contas.find((c: any) => c.conta_contabil_id === receitaId);
  const desp = out.contas.find((c: any) => c.conta_contabil_id === despesaId);
  assert.equal(rec.creditos, 250.5);
  assert.equal(rec.saldo, -250.5, 'saldo = débitos − créditos (conta de receita credora)');
  assert.equal(desp.debitos, 100.5);
  assert.equal(desp.saldo, 100.5);
  assert.equal(out.resumo.total_debitos, 100.5);
  assert.equal(out.resumo.total_creditos, 250.5);
});

test('C) competência (e não a data) define o período', async () => {
  seq++;
  const l = await createRecord(
    RESOURCES.lancamentos_financeiros,
    {
      data: '2026-03-30',
      competencia: '2026-04-30',
      tipo: 'receita',
      descricao: `Competência abril ${seq}-${Date.now() % 100000}`,
      valor: 77,
      conta_contabil_id: receitaId,
      natureza_lancamento: 'credito',
    },
    admin
  );
  const abril = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-04', ate: '2026-04' } });
  const marco = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-03', ate: '2026-03' } });
  assert.ok(abril.contas.some((c: any) => c.conta_contabil_id === receitaId));
  const saldoMarco = marco.contas.find((c: any) => c.conta_contabil_id === receitaId)?.creditos ?? 0;
  const saldoAbril = abril.contas.find((c: any) => c.conta_contabil_id === receitaId)?.creditos ?? 0;
  assert.equal(saldoAbril, 77, 'o lançamento entra em abril, pela competência');
  assert.ok(saldoMarco >= 250.5);
  assert.equal(marco.sem_classificacao.some((x: any) => x.lancamento_id === Number(l.id)), false);
});

test('D) documento de origem é rastreado', async () => {
  const out = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-03', ate: '2026-04' } });
  const origem = out.por_origem.find((o: any) => o.recurso === 'vendas');
  assert.ok(origem, 'a origem "vendas" aparece no balancete');
  assert.ok(origem.registros >= 1);
});

test('E) o balancete não cria nem duplica lançamento', async () => {
  const antes = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 1 });
  await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-03', ate: '2026-04' } });
  const depois = await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 1 });
  assert.equal(depois.total, antes.total, 'balancete é leitura do MESMO livro-caixa');
});

test('F) plano de contas é isolado por empresa', async () => {
  const outB = await chamar(resumoPlanoContas, { actor: gerenteB });
  assert.equal(outB.contas.some((c: any) => c.id === receitaId), false, 'conta de A não aparece para B');
  const outA = await chamar(resumoPlanoContas, { actor: gerente });
  assert.ok(outA.contas.some((c: any) => c.id === receitaId));
});

test('G) resumo do plano de contas não inventa mapeamento', async () => {
  const out = await chamar(resumoPlanoContas, { actor: gerente });
  const texto = JSON.stringify(out);
  assert.equal(/sugestao|sugestão|mapeamento_automatico/i.test(texto), false, 'o ERP não sugere mapeamento automático');
  assert.ok(out.total >= 2);
  assert.ok(out.analiticas >= 2);
  assert.equal(typeof out.por_natureza, 'object');
});
