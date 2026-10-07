// ============================================================================
// P2 no POSTGRES REAL — o que o modo memória não prova:
//
//   • concorrência: duas baixas simultâneas no MESMO título → só uma vence;
//   • idempotência por ÍNDICE ÚNICO: evento de webhook repetido, linha de
//     extrato repetida e efetivação de comissão repetida batem na trava;
//   • migration 0025 aplicada: as tabelas novas existem com as constraints.
//
// Roda no job `testes-postgres` do CI; sem DATABASE_URL o arquivo se auto-pula.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const admin = { id: 0, name: 'Teste PG P2', perfil: 'admin' };

async function boot() {
  const { migrate, query } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const fin = await import('../src/financeiro');
  return { query, RESOURCES, s: getStore(), fin };
}

test('P2 pg: migration 0025 cria tabelas de gateway/webhook/comissões/extrato', { skip }, async () => {
  const { query } = await boot();
  for (const tabela of ['gateway_configs', 'gateway_cobrancas', 'gateway_webhook_events', 'comissoes_eventos', 'fin_extrato_transacoes']) {
    const r = await query<{ reg: string | null }>(`SELECT to_regclass('${tabela}') AS reg`);
    assert.ok(r.rows[0].reg, `tabela ${tabela} deveria existir`);
  }
  // Índices únicos de idempotência presentes.
  const idx = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_gateway_webhook_evento','uq_extrato_linha','uq_gateway_cobrancas_idempotencia','uq_gateway_configs_empresa_provider')`
  );
  assert.equal(idx.rows.length, 4, `faltam índices: ${JSON.stringify(idx.rows)}`);
});

test('P2 pg: duas baixas simultâneas no mesmo título — exatamente uma vence', { skip }, async () => {
  const { RESOURCES, s, fin } = await boot();
  const sufixo = `${Date.now()}-${process.pid}`;
  const lanc = await s.insert(RESOURCES.lancamentos_financeiros, {
    empresa_id: 1,
    data: new Date().toISOString().slice(0, 10),
    tipo: 'receita',
    descricao: `PG P2 corrida ${sufixo}`,
    valor: 777.77,
    status: 'pendente',
    referencia_tipo: 'outro',
  });
  const id = Number(lanc.id);

  const tentar = () =>
    fin.efetuarBaixa({ id: admin.id, name: admin.name }, id, { origem: 'manual' }).then(
      () => 'ok',
      (e: any) => String(e?.status || e?.code || 'erro')
    );
  const resultados = (await Promise.all([tentar(), tentar()])).sort();
  assert.deepEqual(resultados, ['409', 'ok'], `uma baixa deve vencer e a outra recusar: ${resultados.join(',')}`);

  const depois = await s.get(RESOURCES.lancamentos_financeiros, id);
  assert.equal(depois!.status, 'confirmado');
  // E o título segue intocado por nova tentativa (idempotência permanente).
  await assert.rejects(() => fin.efetuarBaixa({ id: admin.id, name: admin.name }, id, { origem: 'manual' }), (e: any) => e.status === 409);
});

test('P2 pg: o mesmo evento de webhook não entra duas vezes (índice único)', { skip }, async () => {
  const { s } = await boot();
  const gw = await import('../src/gateway');
  const eventoId = `pg-dup-${Date.now()}-${process.pid}`;
  const inserir = () =>
    s.insert(gw.R_GATEWAY_WEBHOOK_EVENTS, { provider: 'pgtest', evento_id: eventoId, evento: 'payment.paid', status: 'recebido' }).then(
      () => 'ok',
      (e: any) => String(e?.code || e?.status || 'erro')
    );
  const resultados = (await Promise.all([inserir(), inserir()])).sort();
  assert.ok(resultados.includes('ok'), 'a primeira entrada é aceita');
  assert.ok(resultados.some((r) => r !== 'ok'), `a duplicata deve bater na trava: ${resultados.join(',')}`);
});

test('P2 pg: linha de extrato repetida na mesma conta bate na trava (FITID)', { skip }, async () => {
  const { RESOURCES, s } = await boot();
  const ex = await import('../src/extrato');
  const conta = await s.insert(RESOURCES.contas_financeiras, { empresa_id: 1, nome: `PG Extrato ${Date.now()}-${process.pid}`, tipo: 'banco' });
  const hash = ex.hashLinhaExtrato({ fitid: `FITID-PG-${Date.now()}-${process.pid}` });
  const inserir = () =>
    s.insert(ex.R_EXTRATO, { empresa_id: 1, conta_id: conta.id, origem: 'ofx', linha_hash: hash, fitid: 'FITID-PG', data: new Date().toISOString().slice(0, 10), valor: 10, direcao: 'entrada', status: 'importada' }).then(
      () => 'ok',
      (e: any) => String(e?.code || e?.status || 'erro')
    );
  const resultados = (await Promise.all([inserir(), inserir()])).sort();
  assert.ok(resultados.includes('ok'));
  assert.ok(resultados.some((r) => r !== 'ok'), `importação duplicada deve ser recusada: ${resultados.join(',')}`);
});

test('P2 pg: comissão não se efetiva duas vezes pelo mesmo lançamento', { skip }, async () => {
  const { RESOURCES, s } = await boot();
  const com = await import('../src/comissoes');
  const sufixo = `${Date.now()}-${process.pid}`;
  const venda = await s.insert(RESOURCES.vendas, { empresa_id: 1, status: 'faturada', data: new Date().toISOString().slice(0, 10), total: 100, fin_parcelas: 1, comissao_pct: 10, comissao_valor: 10 });
  const lanc = await s.insert(RESOURCES.lancamentos_financeiros, { empresa_id: 1, data: new Date().toISOString().slice(0, 10), tipo: 'receita', descricao: `PG comissão ${sufixo}`, valor: 100, status: 'pendente', referencia_tipo: 'venda', referencia_id: venda.id });

  const primeira = await s.transaction(async (tx) => com.registrarComissaoPorRecebimento(venda!, Number(lanc.id), 100, 'baixa', { id: null, name: 'PG' }, tx));
  assert.ok(primeira && Number(primeira.valor) === 10);

  // Segunda tentativa pela MESMA via: o saldo do livro (realizada − estornada
  // ≤ apuração) recusa — a apuração já foi integralmente efetivada.
  const segunda = await s.transaction(async (tx) => com.registrarComissaoPorRecebimento(venda!, Number(lanc.id), 100, 'baixa', { id: null, name: 'PG' }, tx));
  assert.equal(segunda, null, 'saldo do livro bloqueia nova efetivação');
  const eventos = await s.list(com.R_COMISSOES_EVENTOS, { page: 1, pageSize: 20, filter: { venda_id: venda.id } });
  const realizadas = eventos.rows.filter((e) => e.tipo === 'realizada');
  assert.equal(realizadas.length, 1, 'uma única efetivação por lançamento');
});

test('P2 pg: concorrência em duas operações de caixa (abrir o mesmo terminal)', { skip }, async () => {
  const { RESOURCES, s } = await boot();
  const numero = `PGCX-${Date.now()}-${process.pid}`;
  const abrir = () =>
    s.transaction(async (tx) => {
      const aberto = await s.findOneWhere(RESOURCES.pdv_caixas, { empresa_id: 1, numero, status: 'aberto' }, tx);
      if (aberto) throw new Error('409');
      return s.insert(RESOURCES.pdv_caixas, { empresa_id: 1, numero, status: 'aberto', valor_abertura: 0, abertura_em: new Date().toISOString() }, tx);
    }, { isolation: 'serializable' }).then(
      () => 'ok',
      (e: any) => (String(e?.message).includes('409') ? '409' : String(e?.status || e?.code || 'erro'))
    );
  const resultados = (await Promise.all([abrir(), abrir()])).sort();
  const aberturas = await s.list(RESOURCES.pdv_caixas, { page: 1, pageSize: 10, filter: { empresa_id: 1, numero, status: 'aberto' } });
  assert.equal(aberturas.rows.length, 1, `um único caixa aberto por terminal: ${resultados.join(',')}`);
});
