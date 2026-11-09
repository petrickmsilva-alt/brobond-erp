// ============================================================================
// FASE 7 — CRM, MARKETING & LOYALTY: RFM, expiração/estorno de pontos,
// limite de frequência e opt-out.
//
// Prova, com o store real (memdb em test), que:
//   • a análise RFM usa quintis REAIS e não inventa nota para quem não comprou;
//   • a expiração de pontos é idempotente por crédito e nunca deixa saldo
//     negativo;
//   • o estorno de pontos de uma venda é idempotente por origem e limitado ao
//     saldo remanescente;
//   • o limite de frequência bloqueia a segunda execução dentro da janela;
//   • o opt-out (concedido=false) bloqueia o envio e o silêncio NÃO é consentimento;
//   • o isolamento por empresa bloqueia acesso cruzado (Empresa A × B).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { analiseRfm } = await import('../src/service');
const {
  creditarPontosVenda,
  saldoFidelidade,
  expirarPontosFidelidade,
  estornarPontosVenda,
  dispararAutomacao,
} = await import('../src/enterprise45');
const { exportarDadosTitular } = await import('../src/lgpd');

const s = getStore();
const uGerenteA = await s.insert(RESOURCES.usuarios, { empresa_id: 1, nome: 'Gerente A7', email: 'ga7@x.invalid', perfil: 'gerente', senha_hash: 'x' });
const uGerenteB = await s.insert(RESOURCES.usuarios, { empresa_id: 2, nome: 'Gerente B7', email: 'gb7@x.invalid', perfil: 'gerente', senha_hash: 'x' });

const GERENTE_A = { id: Number(uGerenteA.id), name: 'Gerente A7', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
const GERENTE_B = { id: Number(uGerenteB.id), name: 'Gerente B7', perfil: 'gerente' as const, empresa_id: 2, empresas: [2] };

function req(body: object = {}, params: object = {}, user: any = GERENTE_A, query: object = {}, key = 'idem-key-0001') {
  return { body, params, user, query, get: (h: string) => (h === 'Idempotency-Key' ? key : undefined) } as any;
}
function res() {
  let body: any; let status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}
async function call(handler: any, body: object = {}, params: object = {}, user: any = GERENTE_A, query: object = {}, key = 'idem-key-0001') {
  const r = res();
  await handler(req(body, params, user, query, key), r.out);
  return r.get().body;
}

/** Cria cliente + venda faturada para a empresa indicada. */
async function semear(empresaId: number, opts: { nome: string; total: number; faturadaEm: string }) {
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: empresaId, nome: opts.nome });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: empresaId, cliente_id: Number(cliente.id), status: 'faturada', total: opts.total,
    canal: 'BROBOND', faturada_em: opts.faturadaEm,
  });
  return { clienteId: Number(cliente.id), vendaId: Number(venda.id) };
}

test('RFM: classifica clientes reais por quintis e conta quem não comprou à parte', async () => {
  const perfil = [
    { nome: 'Campeão', vendas: 5, valor: 500, diasAtras: 5 },
    { nome: 'Leal', vendas: 3, valor: 300, diasAtras: 20 },
    { nome: 'Risco', vendas: 4, valor: 400, diasAtras: 200 },
    { nome: 'Novo', vendas: 1, valor: 50, diasAtras: 2 },
    { nome: 'Hibernando', vendas: 1, valor: 30, diasAtras: 300 },
  ];
  for (const p of perfil) {
    const c = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: `RFM ${p.nome}` });
    for (let i = 0; i < p.vendas; i++) {
      const d = new Date(Date.now() - p.diasAtras * 86_400_000).toISOString();
      await s.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: Number(c.id), status: 'faturada', total: p.valor / p.vendas, canal: 'BROBOND', faturada_em: d });
    }
  }
  await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'RFM Sem Compra' });

  const r = await call(analiseRfm);
  assert.ok(r.base >= 5, 'base RFM conta só quem comprou');
  assert.ok(r.sem_compra >= 1, 'clientes sem compra são contados à parte');
  assert.ok(r.cortes && r.cortes.recencia.length === 5 && r.cortes.frequencia.length === 5 && r.cortes.valor.length === 5);
  for (const linha of r.clientes) {
    assert.ok(linha.r >= 1 && linha.r <= 5 && linha.f >= 1 && linha.f <= 5 && linha.m >= 1 && linha.m <= 5);
    assert.ok(typeof linha.segmento === 'string' && linha.segmento.length > 0);
  }
  const soma = r.resumo.reduce((acc: number, x: any) => acc + x.clientes, 0);
  assert.equal(soma, r.base);
});

test('RFM: base vazia devolve zeros honestos (sem cortes inventados)', async () => {
  const r = await call(analiseRfm, {}, {}, GERENTE_B);
  assert.equal(r.base, 0);
  assert.equal(r.cortes, null);
  assert.deepEqual(r.clientes, []);
});

test('Loyalty: expiração é idempotente por crédito e nunca deixa saldo negativo', async () => {
  const programa = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: 'Prog Exp', pontos_por_real: 1, validade_dias: 1 });
  const { clienteId } = await semear(1, { nome: 'Cliente Exp', total: 100, faturadaEm: new Date().toISOString() });
  const credit = await s.insert(RESOURCES.loyalty_movements, {
    empresa_id: 1, programa_id: Number(programa.id), cliente_id: clienteId, tipo: 'credito', pontos: 100,
    expira_em: new Date(Date.now() - 86_400_000).toISOString(), chave_idempotencia: 'cred-expirado-1', descricao: 'x',
  });
  assert.ok(credit.id);

  const r1 = await call(expirarPontosFidelidade, { cliente_id: clienteId, programa_id: Number(programa.id) });
  assert.equal(r1.expirados, 1);
  const r2 = await call(expirarPontosFidelidade, { cliente_id: clienteId, programa_id: Number(programa.id) });
  assert.equal(r2.expirados, 0);

  const saldo = await call(saldoFidelidade, {}, { clienteId });
  const doPrograma = saldo.programas.find((p: any) => p.programa_id === Number(programa.id));
  assert.equal(doPrograma.saldo, 0, '100 crédito - 100 expiração = 0');
});

test('Loyalty: estorno de venda é idempotente por origem e limitado ao saldo', async () => {
  const programa = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: 'Prog Est', pontos_por_real: 1, validade_dias: null });
  const { clienteId, vendaId } = await semear(1, { nome: 'Cliente Est', total: 200, faturadaEm: new Date().toISOString() });
  await call(creditarPontosVenda, { programa_id: Number(programa.id), cliente_id: clienteId, venda_id: vendaId });

  const e1 = await call(estornarPontosVenda, { programa_id: Number(programa.id), cliente_id: clienteId, venda_id: vendaId });
  assert.equal(e1.estornado, 200);
  const e2 = await call(estornarPontosVenda, { programa_id: Number(programa.id), cliente_id: clienteId, venda_id: vendaId });
  assert.equal(e2.idempotente, true, 'segundo estorno da mesma origem não gera movimento');

  const saldo = await call(saldoFidelidade, {}, { clienteId });
  const doPrograma = saldo.programas.find((p: any) => p.programa_id === Number(programa.id));
  assert.equal(doPrograma.saldo, 0);
});

test('Loyalty: estorno sem crédito de origem é recusado (nada a estornar)', async () => {
  const programa = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: 'Prog Sem Cred', pontos_por_real: 1 });
  const { clienteId, vendaId } = await semear(1, { nome: 'Cliente Sem Cred', total: 10, faturadaEm: new Date().toISOString() });
  await assert.rejects(
    () => call(estornarPontosVenda, { programa_id: Number(programa.id), cliente_id: clienteId, venda_id: vendaId }),
    (e: any) => e.status === 409,
  );
});

test('Marketing: limite de frequência bloqueia a 2ª execução na janela', async () => {
  const auto = await s.insert(RESOURCES.marketing_automations, {
    empresa_id: 1, nome: 'Auto Freq', trigger_tipo: 'pedido_criado', acao_tipo: 'notificar_equipe',
    canal: 'interno', ativo: true, limite_frequencia_dias: 7,
  });
  const { clienteId } = await semear(1, { nome: 'Cliente Freq', total: 10, faturadaEm: new Date().toISOString() });

  const ok = await call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'freq-key-1');
  assert.ok(ok.run);
  await assert.rejects(
    () => call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'freq-key-2'),
    (e: any) => e.status === 429,
  );
});

test('Marketing: opt-out bloqueia envio e o silêncio não é consentimento', async () => {
  const auto = await s.insert(RESOURCES.marketing_automations, {
    empresa_id: 1, nome: 'Auto Envio', trigger_tipo: 'pedido_criado', acao_tipo: 'enviar_mensagem',
    canal: 'email', ativo: true,
  });
  const { clienteId } = await semear(1, { nome: 'Cliente OptOut', total: 10, faturadaEm: new Date().toISOString() });

  await assert.rejects(
    () => call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'opt-key-1'),
    (e: any) => e.status === 409,
  );
  await s.insert(RESOURCES.customer_consents, { empresa_id: 1, cliente_id: clienteId, finalidade: 'marketing', concedido: false });
  await assert.rejects(
    () => call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'opt-key-2'),
    (e: any) => e.status === 409,
  );
  const consent = await s.findOneWhere(RESOURCES.customer_consents, { empresa_id: 1, cliente_id: clienteId, finalidade: 'marketing' });
  await s.update(RESOURCES.customer_consents, Number(consent!.id), { concedido: true });
  const ok = await call(dispararAutomacao, { cliente_id: clienteId }, { id: Number(auto.id) }, GERENTE_A, {}, 'opt-key-3');
  assert.ok(ok.run);
});

test('Isolamento: empresa B não enxerga nem expira pontos da empresa A', async () => {
  const progB = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 2, nome: 'Prog B7', pontos_por_real: 1, validade_dias: 1 });
  const { clienteId: clienteA } = await semear(1, { nome: 'Cliente Isol A', total: 100, faturadaEm: new Date().toISOString() });
  await s.insert(RESOURCES.loyalty_movements, {
    empresa_id: 1, programa_id: Number(progB.id), cliente_id: clienteA, tipo: 'credito', pontos: 100,
    expira_em: new Date(Date.now() - 86_400_000).toISOString(), chave_idempotencia: 'isol-cred-a', descricao: 'x',
  });
  const rB = await call(expirarPontosFidelidade, {}, {}, GERENTE_B);
  assert.equal(rB.expirados, 0, 'a empresa B não processa movimentos da empresa A');
  const progA = await s.insert(RESOURCES.loyalty_programs, { empresa_id: 1, nome: 'Prog Isol A', pontos_por_real: 1 });
  await assert.rejects(
    () => call(estornarPontosVenda, { programa_id: Number(progA.id), cliente_id: clienteA, venda_id: 1 }, {}, GERENTE_B),
    (e: any) => e.status === 404,
  );
});

test('LGPD: exportação do titular reúne os dados da empresa e é auditada', async () => {
  const { clienteId } = await semear(1, { nome: 'Titular LGPD', total: 120, faturadaEm: new Date().toISOString() });
  await s.insert(RESOURCES.customer_consents, { empresa_id: 1, cliente_id: clienteId, finalidade: 'marketing', concedido: true });
  await s.insert(RESOURCES.customer_preferences, { empresa_id: 1, cliente_id: clienteId, canal_preferido: 'email', idioma: 'pt-BR' });

  const r = await call(exportarDadosTitular, {}, { id: clienteId }, GERENTE_A);
  assert.equal(r.titular.id, clienteId);
  assert.equal(r.titular.nome, 'Titular LGPD');
  assert.ok(r.compras.length >= 1, 'as compras reais do titular são exportadas');
  assert.ok(r.consentimentos.some((c: any) => c.finalidade === 'marketing' && c.concedido === true));
  assert.ok(r.preferencias.some((p: any) => p.canal_preferido === 'email'));
  assert.ok(Array.isArray(r.limitacoes) && r.limitacoes.length >= 1, 'as limitações são declaradas, não omitidas');

  const aud = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 50, filter: { empresa_id: 1, recurso: 'clientes', acao: 'exportar' } });
  assert.ok(aud.rows.some((a: any) => Number(a.registro_id) === clienteId), 'a exportação é auditada');
});

test('LGPD: titular de outra empresa devolve 404 (não confirma existência)', async () => {
  const { clienteId } = await semear(1, { nome: 'Titular Isolado', total: 10, faturadaEm: new Date().toISOString() });
  await assert.rejects(
    () => call(exportarDadosTitular, {}, { id: clienteId }, GERENTE_B),
    (e: any) => e.status === 404,
  );
});

test('LGPD: representante só exporta cliente da própria carteira', async () => {
  const rep = await s.insert(RESOURCES.representantes, { empresa_id: 1, nome: 'Rep Carteira 42' });
  const outro = await s.insert(RESOURCES.representantes, { empresa_id: 1, nome: 'Rep Outra Carteira' });
  const repId = Number(rep.id);
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Cliente Carteira Alheia', representante_id: Number(outro.id) });
  const representante = { id: repId, name: 'Rep Carteira', perfil: 'representante' as const, empresa_id: 1, empresas: [1], carteira: repId };
  await assert.rejects(
    () => call(exportarDadosTitular, {}, { id: Number(cliente.id) }, representante),
    (e: any) => e.status === 404,
  );
  const proprio = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Cliente Próprio', representante_id: repId });
  const ok = await call(exportarDadosTitular, {}, { id: Number(proprio.id) }, representante);
  assert.equal(ok.titular.id, Number(proprio.id), 'a própria carteira é exportável');
});
