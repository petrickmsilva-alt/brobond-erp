// Testes da Onda C (modo memória — sem banco):
//   • Baixa parcial: recebe/paga parte do título; o saldo restante segue
//     pendente no título e o caixa/DRE fecham no centavo. Desconto só na quitação.
//   • Conciliação OFX: extrato de Internet Banking (SGML) casa pelos pendentes.
//   • Comparativo mensal (série de 6 meses) e anexos em lançamentos.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { createRecord, getStore } = await import('../src/services');
const { baixarLancamento, conciliarExtrato, resumoFinanceiro } = await import('../src/financeiro');
const { HttpError } = await import('../src/errors');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const, email: 'a@a' } as any;
const mockReq = (body: Record<string, unknown> = {}, params: Record<string, string> = {}) => ({ user: { id: 1, name: 'Admin', perfil: 'admin', email: 'a@a' }, body, params }) as any;
const mockRes = () => {
  const r: any = {};
  r.json = (d: any) => {
    r.data = d;
    return r;
  };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  return r;
};

async function expectHttp(fn: () => Promise<unknown>, status: number, re?: RegExp) {
  try {
    await fn();
  } catch (e: any) {
    assert.ok(e instanceof HttpError, `esperava HttpError, veio ${e?.constructor?.name}: ${e?.message}`);
    assert.equal(e.status, status, `status ${e.status} ≠ ${status}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail(`esperava erro ${status}`);
}

const hoje = new Date().toISOString().slice(0, 10);

before(async () => {
  getStore();
});

test('baixa parcial: recebe 400 de 1.000 — restante 600 segue pendente no título', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'receita', conta_id: 2, descricao: 'Título parcial C', valor: 1000, status: 'pendente', vencimento: hoje },
    admin
  );
  const id = Number(lanc.id);

  const antes = mockRes();
  await resumoFinanceiro(mockReq(), antes);
  const saldoAntes = antes.data.saldoContas.find((c: any) => c.conta_id === 2).saldo;

  const res = mockRes();
  await baixarLancamento(mockReq({ valor: 400, conta_id: 2 }, { id: String(id) }), res);
  assert.equal(res.data.parcial, true);
  assert.equal(res.data.restante, 600);

  const s = getStore();
  const principal = await s.get(getResource('lancamentos_financeiros')!, id);
  assert.equal(principal!.status, 'pendente', 'título segue em aberto');
  assert.equal(Number(principal!.valor), 600);
  assert.match(String(principal!.observacoes), /Baixa parcial/);

  const parciais = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 10, filter: { referencia_tipo: 'baixa', referencia_id: id } });
  assert.equal(parciais.rows.length, 1);
  assert.equal(parciais.rows[0].tipo, 'receita');
  assert.equal(parciais.rows[0].status, 'confirmado');
  assert.equal(Number(parciais.rows[0].valor), 400);
  assert.match(String(parciais.rows[0].descricao), /restante R\$ 600,00/);

  const depois = mockRes();
  await resumoFinanceiro(mockReq(), depois);
  const saldoDepois = depois.data.saldoContas.find((c: any) => c.conta_id === 2).saldo;
  assert.equal(Math.round((saldoDepois - saldoAntes) * 100) / 100, 400, 'caixa sobe só o recebido');
  const aReceberDepois = depois.data.aReceber;
  const aReceberAntes = antes.data.aReceber;
  assert.equal(Math.round((aReceberAntes - aReceberDepois) * 100) / 100, 400, 'a receber cai 400 (restam 600)');
});

test('baixa parcial: desconto só cabe na quitação total', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'receita', conta_id: 2, descricao: 'Título desconto C', valor: 500, status: 'pendente', vencimento: hoje },
    admin
  );
  await expectHttp(() => baixarLancamento(mockReq({ valor: 300, desconto: 50 }, { id: String(lanc.id) }), mockRes()), 400, /não cabe desconto/);

  // quitar o saldo com desconto funciona
  const res = mockRes();
  await baixarLancamento(mockReq({ desconto: 50 }, { id: String(lanc.id) }), res);
  assert.equal(res.data.parcial, false);
  const s = getStore();
  const principal = await s.get(getResource('lancamentos_financeiros')!, Number(lanc.id));
  assert.equal(principal!.status, 'confirmado');
});

test('baixa do saldo restante quita o título', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'despesa', conta_id: 2, descricao: 'Fornecedor parcial C', valor: 800, status: 'pendente', vencimento: hoje },
    admin
  );
  await baixarLancamento(mockReq({ valor: 500 }, { id: String(lanc.id) }), mockRes());
  const res = mockRes();
  await baixarLancamento(mockReq({}, { id: String(lanc.id) }), res); // quita os 300 restantes
  assert.equal(res.data.parcial, false);
  const s = getStore();
  const principal = await s.get(getResource('lancamentos_financeiros')!, Number(lanc.id));
  assert.equal(principal!.status, 'confirmado');
  assert.equal(Number(principal!.valor), 300, 'a quitação ocorreu sobre o saldo restante');
});

test('conciliação OFX: extrato de Internet Banking casa com pendente', async () => {
  const lanc = await createRecord(
    RESOURCES.lancamentos_financeiros,
    { data: hoje, tipo: 'receita', conta_id: 2, descricao: 'Cliente OFX', valor: 777.13, status: 'pendente', vencimento: '2026-09-10' },
    admin
  );
  const ofx = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260910120000
<TRNAMT>777.13
<FITID>PIX123
<NAME>PIX RECEBIDO CLIENTE OFX
<MEMO>PIX RECEBIDO
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260910120000
<TRNAMT>-45.90
<FITID>TARIFA
<MEMO>TARIFA PACOTE
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
  const res = mockRes();
  await conciliarExtrato(mockReq({ texto: ofx }), res);
  assert.equal(res.data.confirmados.length, 1, 'uma linha casou pelo valor líquido abaixo');

  const s = getStore();
  const principal = await s.get(getResource('lancamentos_financeiros')!, Number(lanc.id));
  assert.equal(principal!.status, 'confirmado');
  assert.match(String(principal!.observacoes), /extrato OFX/);

  // a tarifa (única no extrato, sem pendente) volta como não confirmada
  assert.equal(res.data.naoConfirmados.length, 1);
  assert.equal(res.data.naoConfirmados[0].valor, 45.9);
});

test('comparativo mensal: série de 6 meses reflete receita/despesa confirmadas', async () => {
  const passado = new Date();
  passado.setUTCMonth(passado.getUTCMonth() - 1);
  const mesPassado = passado.toISOString().slice(0, 7);
  const dataPassada = `${mesPassado}-15`;

  await createRecord(RESOURCES.lancamentos_financeiros, { data: dataPassada, tipo: 'receita', conta_id: 2, descricao: 'Receita mês passado C', valor: 1234, status: 'confirmado' }, admin);
  await createRecord(RESOURCES.lancamentos_financeiros, { data: dataPassada, tipo: 'despesa', conta_id: 2, descricao: 'Despesa mês passado C', valor: 500, status: 'confirmado' }, admin);

  const res = mockRes();
  await resumoFinanceiro(mockReq(), res);
  const serie = res.data.serieMensal as any[];
  assert.equal(serie.length, 6);
  assert.equal(serie[5].mes, hoje.slice(0, 7), 'último ponto é o mês corrente');
  const alvo = serie.find((m) => m.mes === mesPassado)!;
  assert.ok(alvo.receita >= 1234);
  assert.ok(alvo.despesa >= 500);
  assert.equal(Math.round((alvo.receita - alvo.despesa - alvo.resultado) * 100) / 100, 0);
});

test('anexos: lançamentos aceitam fotos de comprovante (galeria genérica)', async () => {
  const r = RESOURCES.lancamentos_financeiros as any;
  assert.equal(r.images?.max, 4);
  assert.ok(r.fields.some((f: any) => f.name === 'comprovantes' && f.type === 'images'));
});
