// ============================================================================
// FINANCEIRO — ORÁCULO INDEPENDENTE (ERP 3.0, homologação final)
// ----------------------------------------------------------------------------
// O BROBOND **não tem partida dobrada**: cada lançamento é UM fato do livro-
// caixa (`tipo` + `valor`, opcionalmente classificado em `plano_contas` com
// `natureza_lancamento`). Portanto a identidade Σdébitos = Σcréditos NÃO é uma
// regra do produto — ela não existe sem o par contábil, e inventá-la aqui seria
// fabricar contabilidade. Este arquivo prova as identidades que o produto
// REALMENTE sustenta, com valores esperados calculados FORA do código:
//
//   1) Caixa (resumo):  saldo = saldo_inicial
//                              + Σ (líquido de receitas e investimentos)
//                              − Σ (despesas)
//      Prova por DELTA: o resumo é lido antes e depois de um conjunto de
//      lançamentos cujo efeito é calculado à mão, então dado semeado de
//      demonstração não interfere na expectativa.
//
//   2) Balancete:       saldo_da_conta = débitos − créditos
//                       Σ saldos das contas = total_débitos − total_créditos
//      (identidade de fechamento do balancete: nenhum valor pode aparecer em
//      duas contas nem desaparecer entre as duas somas.)
//
//   3) Nenhum lançamento evapora: cada lançamento do período está OU numa conta
//      do balancete OU em `sem_classificacao`, exatamente uma vez.
//
//   4) Líquido nunca excede o bruto e taxa nunca move o valor no sentido
//      contrário ao caixa (entrada com taxa entra MENOS, nunca mais).
//
//   5) Arredondamento em centavos: a soma de 3 lançamentos de 33,33 é 99,99
//      (nada de 99.99000000000001 no caixa).
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const { resumoFinanceiro, calcularLiquido } = await import('../src/financeiro');
const { balanceteFinanceiro } = await import('../src/financeiroContabil');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;
let contaId: number;
let contaReceitaId: number;
let contaDespesaId: number;
let seq = 0;

/** Executa um handler Express e devolve o JSON. */
async function chamar(handler: any, opts: { actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: {}, body: {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

/** Dinheiro em centavos: comparar float de moeda exige arredondar a diferença. */
const centavos = (v: number) => Math.round(v * 100) / 100;

/** Saldo da conta no resumo financeiro (independe de dado semeado). */
async function saldoDaConta(): Promise<number> {
  const r = await chamar(resumoFinanceiro, { actor: gerente });
  const conta = (r.saldoContas || []).find((c: any) => Number(c.conta_id) === contaId);
  assert.ok(conta, 'a conta de teste precisa aparecer no resumo');
  return Number(conta.saldo);
}

async function lancar(dados: Record<string, unknown>) {
  seq++;
  return createRecord(
    RESOURCES.lancamentos_financeiros,
    {
      data: '2026-05-10',
      competencia: '2026-05-31',
      status: 'confirmado',
      conta_id: contaId,
      descricao: `Oráculo financeiro ${seq}-${Date.now() % 100000}`,
      ...dados,
    },
    admin
  );
}

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  const conta = await createRecord(
    RESOURCES.contas_financeiras,
    { nome: `Caixa oráculo ${Date.now() % 100000}`, tipo: 'caixa', saldo_inicial: 1000 },
    admin
  );
  contaId = Number(conta.id);
  const rec = await createRecord(
    RESOURCES.plano_contas,
    { codigo: `4.90.${Date.now() % 900 + 100}`, nome: 'Receita oráculo', natureza: 'receita', tipo: 'analitica' },
    admin
  );
  contaReceitaId = Number(rec.id);
  const desp = await createRecord(
    RESOURCES.plano_contas,
    { codigo: `5.90.${Date.now() % 900 + 100}`, nome: 'Despesa oráculo', natureza: 'despesa', tipo: 'analitica' },
    admin
  );
  contaDespesaId = Number(desp.id);
});

test('1) caixa: o saldo parte do saldo_inicial (nada inventado no primeiro acesso)', async () => {
  assert.equal(await saldoDaConta(), 1000);
});

test('2) caixa: delta do saldo = Σ entradas líquidas − Σ saídas (valores calculados à mão)', async () => {
  const antes = await saldoDaConta();

  // 500,00 de receita com 10% de taxa → entra 450,00
  await lancar({ tipo: 'receita', valor: 500, taxa_pct: 10 });
  // 200,00 de despesa → sai 200,00
  await lancar({ tipo: 'despesa', valor: 200 });
  // 300,00 de investimento sem taxa → entra 300,00
  await lancar({ tipo: 'investimento', valor: 300, taxa_pct: 0 });
  // receita PENDENTE não move caixa confirmado (mas entra no previsto)
  await lancar({ tipo: 'receita', valor: 999, taxa_pct: 0, status: 'pendente' });

  const esperado = 450 + 300 - 200; // 550,00
  assert.equal(centavos((await saldoDaConta()) - antes), esperado, 'o delta do caixa precisa fechar no centavo');
});

test('3) caixa: arredondamento em centavos (3 × 33,33 = 99,99)', async () => {
  const antes = await saldoDaConta();
  for (let i = 0; i < 3; i++) await lancar({ tipo: 'receita', valor: 33.33, taxa_pct: 0 });
  const saldo = await saldoDaConta();
  assert.equal(centavos(saldo - antes), 99.99);
  // O saldo PUBLICADO já vem em centavos: nada de 1.099,9900000001 na API.
  assert.match(String(saldo), /^-?\d+(\.\d{1,2})?$/, 'o caixa não pode publicar fração de centavo');
});

test('4) caixa: entrada com taxa entra MENOS (nunca mais) e o líquido nunca excede o bruto', async () => {
  const antes = await saldoDaConta();
  await lancar({ tipo: 'receita', valor: 1234.56, taxa_pct: 3.99 });
  const liquidoEsperado = Math.round((1234.56 - (1234.56 * 3.99) / 100) * 100) / 100;
  assert.equal(calcularLiquido(1234.56, 3.99), liquidoEsperado);
  assert.ok(liquidoEsperado < 1234.56);
  assert.equal(centavos((await saldoDaConta()) - antes), liquidoEsperado);
});

test('5) balancete: saldo por conta = débitos − créditos e o fechamento soma zero de sobra', async () => {
  await lancar({ tipo: 'despesa', valor: 100.5, conta_contabil_id: contaDespesaId, natureza_lancamento: 'debito' });
  await lancar({ tipo: 'receita', valor: 250.5, conta_contabil_id: contaReceitaId, natureza_lancamento: 'credito' });

  const out = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-05', ate: '2026-05' } });
  const desp = out.contas.find((c: any) => c.conta_contabil_id === contaDespesaId);
  const rec = out.contas.find((c: any) => c.conta_contabil_id === contaReceitaId);
  assert.ok(desp && rec, 'as duas contas do teste precisam aparecer no balancete');

  // Identidade por conta (aritmética independente do agrupamento).
  for (const conta of out.contas) {
    const esperado = Math.round((conta.debitos - conta.creditos) * 100) / 100;
    assert.equal(conta.saldo, esperado, `conta ${conta.codigo}: saldo ≠ débitos − créditos`);
  }
  assert.equal(desp.debitos, 100.5);
  assert.equal(desp.saldo, 100.5);
  assert.equal(rec.creditos, 250.5);
  assert.equal(rec.saldo, -250.5);

  // Fechamento: a soma dos saldos é EXATAMENTE a diferença das duas colunas.
  const somatorio = out.contas.reduce((s: number, c: any) => s + c.saldo, 0);
  const fechamento = centavos(out.resumo.total_debitos - out.resumo.total_creditos);
  assert.equal(centavos(somatorio), fechamento, 'Σ saldos precisa fechar com Σ débitos − Σ créditos');
});

test('6) balancete: nenhum lançamento evapora — cada um está numa conta OU em sem_classificacao', async () => {
  await lancar({ tipo: 'despesa', valor: 77.77 }); // sem conta contábil de propósito

  const out = await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-05', ate: '2026-05' } });
  const contados = out.contas.reduce((s: number, c: any) => s + c.lancamentos, 0);
  assert.ok(out.resumo.lancamentos_no_periodo > 0, 'o período precisa ter lançamentos para a prova valer');
  assert.equal(contados, out.resumo.classificados, 'as contas precisam contabilizar exatamente os classificados');
  assert.equal(
    out.resumo.classificados + out.resumo.sem_classificacao,
    out.resumo.lancamentos_no_periodo,
    'classificados + sem classificação precisa ser o total do período (sem dupla contagem)'
  );
  const pendente = out.sem_classificacao.find((x: any) => x.valor === 77.77);
  assert.ok(pendente, 'o lançamento sem conta precisa aparecer como pendência, não como conta inventada');
  assert.equal(pendente.motivo, 'Sem conta contábil');
});

test('7) balancete: consultar não cria nem altera lançamento (leitura pura)', async () => {
  const antes = (await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 1 }, admin)).total;
  await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-05', ate: '2026-05' } });
  await chamar(balanceteFinanceiro, { actor: gerente, query: { de: '2026-05', ate: '2026-05' } });
  const depois = (await listRecords(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 1 }, admin)).total;
  assert.equal(depois, antes, 'o balancete é leitura: não pode gerar partida nem lançamento novo');
});
