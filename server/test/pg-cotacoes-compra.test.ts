// ============================================================================
// COTAÇÃO DE COMPRA (E3) contra Postgres REAL.
//
// O que só se prova aqui — o memdb não tem constraint, não tem índice único
// parcial e não tem corrida real:
//
//   • os CHECKs de vocabulário (status, criterio) existem e recusam valor
//     fora da lista (SQLSTATE 23514);
//   • o ÍNDICE ÚNICO PARCIAL cotacoes_compra_compra_uniq bloqueia, NO BANCO,
//     uma segunda cotação apontando para o mesmo pedido — é a trava de
//     idempotência que continua valendo mesmo se a checagem de aplicação for
//     contornada por corrida (SQLSTATE 23505);
//   • UNIQUE (cotacao_id, fornecedor_id) impede convite duplicado;
//   • UNIQUE (convite_id, item_id) impede dois preços do mesmo fornecedor para
//     o mesmo item;
//   • itens_compra ganhou custo_frete_rateado e custo_impostos com default 0 e
//     CHECK >= 0 (o lugar onde o rateio da GAP-COMP-CUSTOS vai ser gravado);
//   • duas decisões CONCORRENTES da mesma cotação: exatamente uma vence e um
//     único pedido de compra sobrevive;
//   • a empresa B não enxerga nem move a cotação da A.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// O pool do Postgres é singleton de módulo — não fechar aqui, igual aos demais
// testes pg-*.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Actor = { id: number; name: string; perfil: string; empresa_id?: number; empresas?: number[] };

const SUFIXO = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function base() {
  const { migrate, query } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const cc = await import('../src/cotacoesCompra');
  return { query, RESOURCES, s: getStore(), cc };
}

async function q(sql: string, params: unknown[] = []) {
  const { query } = await import('../src/db');
  return query(sql, params);
}

async function novaEmpresa(nome: string, cnpj: string) {
  const r = await q(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [nome, cnpj]);
  return Number(r.rows[0].id);
}

async function usuarioDa(empresaId: number, perfil: string, sufixo: string): Promise<Actor> {
  const r = await q(`INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id, nome`, [
    `Usuário ${sufixo}`,
    `${sufixo}@brobond.test`,
    perfil,
    empresaId,
  ]);
  return { id: Number(r.rows[0].id), name: String(r.rows[0].nome), perfil, empresa_id: empresaId, empresas: [empresaId] };
}

/** Cria a base de uma cotação direto no banco (fornecedor, insumo, item, convite). */
async function cenario(empresaId: number, tag: string) {
  const forn = await q(`INSERT INTO fornecedores (empresa_id, nome, ativo) VALUES ($1, $2, true) RETURNING id`, [empresaId, `Fornecedor ${tag}`]);
  const insumo = await q(`INSERT INTO insumos (empresa_id, nome, unidade, custo_medio, ativo) VALUES ($1, $2, 'un', 10, true) RETURNING id`, [empresaId, `Insumo ${tag}`]);
  const cotacao = await q(`INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio) VALUES ($1, $2, 'cotando', 'menor_preco') RETURNING id`, [empresaId, `Cotação ${tag}`]);
  const item = await q(`INSERT INTO cotacao_compra_itens (empresa_id, cotacao_id, insumo_id, quantidade, unidade) VALUES ($1, $2, $3, 10, 'un') RETURNING id`, [
    empresaId,
    Number(cotacao.rows[0].id),
    Number(insumo.rows[0].id),
  ]);
  const convite = await q(`INSERT INTO cotacao_compra_fornecedores (empresa_id, cotacao_id, fornecedor_id, status) VALUES ($1, $2, $3, 'convidado') RETURNING id`, [
    empresaId,
    Number(cotacao.rows[0].id),
    Number(forn.rows[0].id),
  ]);
  return {
    fornecedorId: Number(forn.rows[0].id),
    insumoId: Number(insumo.rows[0].id),
    cotacaoId: Number(cotacao.rows[0].id),
    itemId: Number(item.rows[0].id),
    conviteId: Number(convite.rows[0].id),
  };
}

/** Executa um handler com req/res falsos e devolve o corpo. */
async function chamar(handler: (req: any, res: any) => Promise<void>, body: unknown, params: Record<string, unknown>, user: Actor, esperado = 200) {
  const saida: { json?: any; status?: number } = {};
  const res: any = {
    json: (d: any) => ((saida.json = d), res),
    status: (s: number) => ((saida.status = s), res),
    setHeader: () => res,
    end: () => res,
  };
  const req: any = { headers: {}, header: () => undefined, get: () => undefined, params, query: {}, body, user, socket: { remoteAddress: '203.0.113.10' } };
  await handler(req, res);
  if (saida.status !== undefined && saida.status !== esperado) {
    throw new Error(`esperava HTTP ${esperado}, veio ${saida.status}: ${JSON.stringify(saida.json)}`);
  }
  return saida.json;
}

/** Devolve o SQLSTATE de uma instrução que deveria falhar ('' se passou). */
async function sqlstateDe(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await q(sql, params);
  } catch (e: any) {
    return String(e?.code ?? '');
  }
  return '';
}

async function statusDe(cotacaoId: number): Promise<{ status: string; compra_id: number | null }> {
  const r = await q(`SELECT status, compra_id FROM cotacoes_compra WHERE id = $1`, [cotacaoId]);
  return { status: String(r.rows[0].status), compra_id: r.rows[0].compra_id === null ? null : Number(r.rows[0].compra_id) };
}

// ---------------------------------------------------------------------------
// 1) ESTRUTURA: CHECKs e índices existem no banco de verdade
// ---------------------------------------------------------------------------
test('E3-PG: os CHECKs de status e critério recusam valor fora da lista', { skip }, async () => {
  await base();
  const emp = await novaEmpresa(`Empresa Check ${SUFIXO}`, `11${SUFIXO.slice(0, 12)}`);

  const stRuim = await sqlstateDe(
    `INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio) VALUES ($1, 'x', 'voando', 'menor_preco')`,
    [emp]
  );
  assert.equal(stRuim, '23514', 'o CHECK de status não está aplicado no banco');

  const crRuim = await sqlstateDe(
    `INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio) VALUES ($1, 'x', 'rascunho', 'no_olho')`,
    [emp]
  );
  assert.equal(crRuim, '23514', 'o CHECK de critério não está aplicado no banco');

  // Quantidade <= 0 também é recusada pelo banco, não só pela aplicação.
  const { cotacaoId, insumoId } = await cenario(emp, `qtd-${SUFIXO}`);
  const qtdRuim = await sqlstateDe(
    `INSERT INTO cotacao_compra_itens (empresa_id, cotacao_id, insumo_id, quantidade) VALUES ($1, $2, $3, 0)`,
    [emp, cotacaoId, insumoId]
  );
  assert.ok(['23514', '23503'].includes(qtdRuim), `quantidade 0 foi aceita (SQLSTATE "${qtdRuim || 'nenhuma'}")`);
});

test('E3-PG: o índice único parcial de compra_id é a trava final de idempotência', { skip }, async () => {
  await base();
  const emp = await novaEmpresa(`Empresa Uniq ${SUFIXO}`, `22${SUFIXO.slice(0, 12)}`);
  const { fornecedorId } = await cenario(emp, `uniq-${SUFIXO}`);

  // Um pedido de compra real para duas cotações disputarem.
  const compra = await q(
    `INSERT INTO compras (empresa_id, fornecedor_id, data, status, total) VALUES ($1, $2, CURRENT_DATE, 'pendente', 100) RETURNING id`,
    [emp, fornecedorId]
  );
  const compraId = Number(compra.rows[0].id);

  const a = await q(
    `INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio, compra_id) VALUES ($1, 'A', 'decidida', 'menor_preco', $2) RETURNING id`,
    [emp, compraId]
  );
  assert.ok(a.rows[0].id, 'a primeira cotação deveria conseguir apontar para o pedido');

  const duplicado = await sqlstateDe(
    `INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio, compra_id) VALUES ($1, 'B', 'decidida', 'menor_preco', $2)`,
    [emp, compraId]
  );
  assert.equal(duplicado, '23505', 'duas cotações apontaram para o MESMO pedido — a trava de idempotência não existe no banco');

  // Múltiplas cotações SEM pedido continuam permitidas: a cláusula WHERE do
  // índice parcial é o que torna isso possível (NULL não colide).
  const semPedido = await q(
    `INSERT INTO cotacoes_compra (empresa_id, titulo, status, criterio, compra_id) VALUES ($1, 'sem pedido 1', 'rascunho', 'menor_preco', NULL), ($1, 'sem pedido 2', 'rascunho', 'menor_preco', NULL) RETURNING id`,
    [emp]
  );
  assert.equal(semPedido.rows.length, 2, 'o índice parcial não deveria bloquear cotações sem pedido');

  const idx = await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'cotacoes_compra_compra_uniq'`);
  assert.equal(idx.rows.length, 1, 'o índice cotacoes_compra_compra_uniq não existe');
  assert.match(String(idx.rows[0].indexdef), /UNIQUE/i);
  assert.match(String(idx.rows[0].indexdef), /WHERE.*compra_id IS NOT NULL/i, 'o índice precisa ser PARCIAL, senão NULL colidiria');
});

test('E3-PG: UNIQUE de convite por fornecedor e de preço por item', { skip }, async () => {
  await base();
  const emp = await novaEmpresa(`Empresa Par ${SUFIXO}`, `33${SUFIXO.slice(0, 12)}`);
  const c = await cenario(emp, `par-${SUFIXO}`);

  const conviteDup = await sqlstateDe(
    `INSERT INTO cotacao_compra_fornecedores (empresa_id, cotacao_id, fornecedor_id, status) VALUES ($1, $2, $3, 'convidado')`,
    [emp, c.cotacaoId, c.fornecedorId]
  );
  assert.equal(conviteDup, '23505', 'o mesmo fornecedor foi convidado duas vezes para a mesma cotação');

  await q(`INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, $3, 5)`, [emp, c.conviteId, c.itemId]);
  const precoDup = await sqlstateDe(
    `INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, $3, 7)`,
    [emp, c.conviteId, c.itemId]
  );
  assert.equal(precoDup, '23505', 'dois preços do mesmo fornecedor para o mesmo item foram gravados');

  // Preço negativo seria crédito ao fornecedor.
  const precoNeg = await sqlstateDe(
    `INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, 999999, -1)`,
    [emp, c.conviteId]
  );
  assert.ok(['23514', '23503'].includes(precoNeg), `preço negativo foi aceito (SQLSTATE "${precoNeg || 'nenhuma'}")`);
});

test('E3-PG: itens_compra tem as colunas de rateio de custo, com default 0 e CHECK >= 0', { skip }, async () => {
  await base();
  const cols = await q(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'itens_compra' AND column_name IN ('custo_frete_rateado','custo_impostos') ORDER BY column_name`
  );
  assert.deepEqual(
    cols.rows.map((r: any) => r.column_name),
    ['custo_frete_rateado', 'custo_impostos'],
    'as colunas de rateio criadas pela 0027 não existem em itens_compra'
  );
  assert.ok(cols.rows.every((r: any) => String(r.column_default ?? '').includes('0')), 'o default deveria ser 0');

  const emp = await novaEmpresa(`Empresa Custo ${SUFIXO}`, `44${SUFIXO.slice(0, 12)}`);
  const { fornecedorId } = await cenario(emp, `custo-${SUFIXO}`);
  const compra = await q(
    `INSERT INTO compras (empresa_id, fornecedor_id, data, status, total) VALUES ($1, $2, CURRENT_DATE, 'pendente', 100) RETURNING id`,
    [emp, fornecedorId]
  );
  const linha = await q(
    `INSERT INTO itens_compra (empresa_id, compra_id, insumo_id, quantidade, preco_unitario) VALUES ($1, $2, 1, 2, 10) RETURNING custo_frete_rateado, custo_impostos`,
    [emp, Number(compra.rows[0].id)]
  );
  assert.equal(Number(linha.rows[0].custo_frete_rateado), 0, 'custo_frete_rateado deveria nascer zerado');
  assert.equal(Number(linha.rows[0].custo_impostos), 0, 'custo_impostos deveria nascer zerado');

  const freteNeg = await sqlstateDe(
    `INSERT INTO itens_compra (empresa_id, compra_id, insumo_id, quantidade, preco_unitario, custo_frete_rateado) VALUES ($1, $2, 1, 2, 10, -5)`,
    [emp, Number(compra.rows[0].id)]
  );
  assert.equal(freteNeg, '23514', 'custo_frete_rateado negativo foi aceito');
});

// ---------------------------------------------------------------------------
// 2) FLUXO COMPLETO contra Postgres real
// ---------------------------------------------------------------------------
test('E3-PG: decidir gera um pedido real com itens, e repetir não duplica', { skip }, async () => {
  const { cc } = await base();
  const emp = await novaEmpresa(`Empresa Fluxo ${SUFIXO}`, `55${SUFIXO.slice(0, 12)}`);
  const gerente = await usuarioDa(emp, 'gerente', `fluxo-${SUFIXO}`);
  const c = await cenario(emp, `fluxo-${SUFIXO}`);
  await q(`INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, $3, 12.34)`, [emp, c.conviteId, c.itemId]);

  const antes = await q(`SELECT COUNT(*)::int AS n FROM compras WHERE empresa_id = $1`, [emp]);
  const decidido = await chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerente, 201);
  const depois = await q(`SELECT COUNT(*)::int AS n FROM compras WHERE empresa_id = $1`, [emp]);
  assert.equal(depois.rows[0].n, antes.rows[0].n + 1, 'decidir deveria criar exatamente um pedido');

  const compra = await q(`SELECT id, status, total, fornecedor_id, empresa_id FROM compras WHERE id = $1`, [decidido.compra_id]);
  assert.equal(Number(compra.rows[0].total), 123.4, 'total = 12.34 × 10');
  assert.equal(String(compra.rows[0].status), 'pendente');
  assert.equal(Number(compra.rows[0].empresa_id), emp, 'o pedido deve herdar a empresa da cotação');

  const linhas = await q(`SELECT quantidade, preco_unitario FROM itens_compra WHERE compra_id = $1`, [decidido.compra_id]);
  assert.equal(linhas.rows.length, 1);
  assert.equal(Number(linhas.rows[0].preco_unitario), 12.34, 'o NUMERIC do banco deve devolver o preço exato');

  const st = await statusDe(c.cotacaoId);
  assert.equal(st.status, 'decidida');
  assert.equal(st.compra_id, decidido.compra_id);

  // Repetir: mesmo pedido, nenhuma linha nova.
  const deNovo = await chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerente, 200);
  assert.equal(deNovo.compra_id, decidido.compra_id);
  assert.equal(deNovo.idempotente, true);
  const fim = await q(`SELECT COUNT(*)::int AS n FROM compras WHERE empresa_id = $1`, [emp]);
  assert.equal(fim.rows[0].n, antes.rows[0].n + 1, 'a repetição criou um segundo pedido');
  const linhasFim = await q(`SELECT COUNT(*)::int AS n FROM itens_compra WHERE compra_id = $1`, [decidido.compra_id]);
  assert.equal(linhasFim.rows[0].n, 1, 'as linhas foram duplicadas');
});

// ---------------------------------------------------------------------------
// 3) CONCORRÊNCIA REAL — o que o memdb não consegue provar
// ---------------------------------------------------------------------------
test('E3-PG: decisões simultâneas da mesma cotação geram UM único pedido', { skip }, async () => {
  const { cc } = await base();
  const emp = await novaEmpresa(`Empresa Race ${SUFIXO}`, `66${SUFIXO.slice(0, 12)}`);
  const gerente = await usuarioDa(emp, 'gerente', `race-${SUFIXO}`);
  const c = await cenario(emp, `race-${SUFIXO}`);
  await q(`INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, $3, 5)`, [emp, c.conviteId, c.itemId]);

  const antes = await q(`SELECT COUNT(*)::int AS n FROM compras WHERE empresa_id = $1`, [emp]);
  const resultados = await Promise.allSettled([
    chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerente, 201),
    chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerente, 201),
    chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerente, 201),
  ]);
  const depois = await q(`SELECT COUNT(*)::int AS n FROM compras WHERE empresa_id = $1`, [emp]);
  assert.equal(
    depois.rows[0].n,
    antes.rows[0].n + 1,
    `corrida criou ${depois.rows[0].n - antes.rows[0].n} pedidos em vez de 1 (resultados: ${resultados.map((r) => r.status).join(', ')})`
  );

  const st = await statusDe(c.cotacaoId);
  assert.equal(st.status, 'decidida');
  const vinculos = await q(`SELECT COUNT(*)::int AS n FROM cotacoes_compra WHERE compra_id = $1`, [st.compra_id]);
  assert.equal(vinculos.rows[0].n, 1, 'mais de uma cotação ficou apontando para o mesmo pedido');
});

// ---------------------------------------------------------------------------
// 4) MULTIEMPRESA
// ---------------------------------------------------------------------------
test('E3-PG: a empresa B não lê nem decide a cotação da A', { skip }, async () => {
  const { cc } = await base();
  const empA = await novaEmpresa(`Empresa A Iso ${SUFIXO}`, `77${SUFIXO.slice(0, 12)}`);
  const empB = await novaEmpresa(`Empresa B Iso ${SUFIXO}`, `88${SUFIXO.slice(0, 12)}`);
  const gerenteA = await usuarioDa(empA, 'gerente', `isoA-${SUFIXO}`);
  const gerenteB = await usuarioDa(empB, 'gerente', `isoB-${SUFIXO}`);
  const c = await cenario(empA, `iso-${SUFIXO}`);
  await q(`INSERT INTO cotacao_compra_precos (empresa_id, convite_id, item_id, preco_unitario) VALUES ($1, $2, $3, 5)`, [empA, c.conviteId, c.itemId]);

  // 404, nunca 403: a existência de um id alheio não é informação a vazar.
  for (const [nome, fn, esperado] of [
    ['comparativo', cc.comparativoCotacao, 200],
    ['decidir', cc.decidirCotacaoCompra, 201],
    ['cancelar', cc.cancelarCotacao, 200],
  ] as const) {
    let lancado: any = null;
    try {
      await chamar(fn as any, {}, { id: c.cotacaoId }, gerenteB, esperado as any);
    } catch (e: any) {
      lancado = e;
    }
    assert.ok(lancado, `${nome}: a empresa B conseguiu operar na cotação da A`);
    assert.equal(lancado.status, 404, `${nome}: esperava 404, veio ${lancado.status}`);
  }

  // E nada mudou do lado da A.
  const st = await statusDe(c.cotacaoId);
  assert.equal(st.status, 'cotando');
  assert.equal(st.compra_id, null);

  // A A continua operando normalmente.
  const decidido = await chamar(cc.decidirCotacaoCompra, {}, { id: c.cotacaoId }, gerenteA, 201);
  const compra = await q(`SELECT empresa_id FROM compras WHERE id = $1`, [decidido.compra_id]);
  assert.equal(Number(compra.rows[0].empresa_id), empA);
});
