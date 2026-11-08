// ============================================================================
// SUPPLY CHAIN — DEVOLUÇÃO AO FORNECEDOR contra Postgres REAL (migration 0105).
//
// Só se prova aqui — o memdb não tem constraint nem função agregada:
//
//   • a migration 0105 está aplicada: tabelas, colunas, funções de apoio e
//     índices únicos parciais;
//   • o TRIGGER de defesa em profundidade `devolucao_fornecedor_itens_limite`
//     recebido` recusa a linha que ultrapassa o recebido (23514) — backstop do
//     compare-and-swap do serviço;
//   • o CHECK de coerência de estado recusa AUTORIZADA sem carimbo e EXPEDIDA
//     sem autorização/expedição (23514);
//   • o índice único de idempotência recusa a segunda criação com a mesma chave
//     por empresa (23505);
//   • as colunas de rastreabilidade em movimentacoes/movimentacoes_insumos
//     existem;
//   • isolamento multiempresa: a mesma idempotency_key convive em empresas
//     distintas.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// O pool é singleton de módulo — não fechar aqui.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const SUFIXO = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import('../src/db');
  return (await query(sql, params)).rows as T[];
}
async function um<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

/** Erro de constraint do Postgres carrega o SQLSTATE em `code`. */
async function codigoDeErro(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e: any) {
    return e?.code;
  }
}

/** Empresa + fornecedor + produto + compra recebida + item, isolados por sufixo. */
async function cenario(tag: string, recebido = 5) {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const s = getStore();
  seq++;
  const empresa = await s.insert(RESOURCES.empresas, { nome: `Empresa ${tag} ${seq} ${SUFIXO}`, ativo: true });
  const empresaId = Number(empresa.id);
  const fornecedor = await s.insert(RESOURCES.fornecedores, { nome: `Forn ${tag} ${seq} ${SUFIXO}`, ativo: true, empresa_id: empresaId });
  const produto = await s.insert(RESOURCES.produtos, { sku: `DEV-${tag}-${seq}-${SUFIXO}`, nome: `Produto ${tag} ${seq}`, custo: 10, preco_venda: 30, ativo: true, empresa_id: empresaId });
  const compra = await s.insert(RESOURCES.compras, {
    empresa_id: empresaId,
    fornecedor_id: Number(fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'aprovado',
    total: recebido * 10,
  });
  const item = await s.insert(RESOURCES.itens_compra, {
    empresa_id: empresaId,
    compra_id: Number(compra.id),
    produto_id: Number(produto.id),
    insumo_id: null,
    quantidade: recebido,
    quantidade_recebida: recebido,
    preco_unitario: 10,
  });
  return { s, RESOURCES, empresaId, fornecedorId: Number(fornecedor.id), produtoId: Number(produto.id), compraId: Number(compra.id), itemId: Number(item.id) };
}

async function novaDevolucao(ctx: Awaited<ReturnType<typeof cenario>>, status = 'solicitada') {
  const dev = await ctx.s.insert(ctx.RESOURCES.devolucoes_fornecedor, {
    empresa_id: ctx.empresaId,
    compra_id: ctx.compraId,
    fornecedor_id: ctx.fornecedorId,
    status,
    motivo: 'teste',
  });
  return Number(dev.id);
}

// ---------------------------------------------------------------------------
// 1) A MIGRATION 0105 ESTÁ NO BANCO
// ---------------------------------------------------------------------------
test('pg 0105: tabelas, colunas, funções e índices da devolução ao fornecedor existem', { skip }, async () => {
  const ctx = await cenario('estrutura');

  const tabelas = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('devolucoes_fornecedor','devolucao_fornecedor_itens','devolucao_fornecedor_eventos')
      ORDER BY table_name`
  );
  assert.deepEqual(tabelas.map((t) => t.table_name), ['devolucao_fornecedor_eventos', 'devolucao_fornecedor_itens', 'devolucoes_fornecedor']);

  const colunas = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='devolucao_fornecedor_itens' AND column_name IN ('estoque_baixado','movimentacao_id','movimentacao_insumo_id','custo_unitario')
      ORDER BY column_name`
  );
  assert.deepEqual(colunas.map((c) => c.column_name), ['custo_unitario', 'estoque_baixado', 'movimentacao_id', 'movimentacao_insumo_id']);

  const funcoes = await q<{ proname: string }>(
    `SELECT proname FROM pg_proc WHERE proname IN ('brobond_qtd_devolvida_fornecedor_item','brobond_recebido_item_compra') ORDER BY proname`
  );
  assert.deepEqual(funcoes.map((f) => f.proname), ['brobond_qtd_devolvida_fornecedor_item', 'brobond_recebido_item_compra']);

  const indices = await q<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename='devolucoes_fornecedor' AND indexname IN ('uq_devolucoes_fornecedor_idempotency','uq_devolucoes_fornecedor_numero') ORDER BY indexname`
  );
  assert.equal(indices.length, 2);

  const rastreio = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('movimentacoes','movimentacoes_insumos') AND column_name='devolucao_fornecedor_id'`
  );
  assert.equal(rastreio.length, 2, 'as duas tabelas de movimentação ganham o vínculo da devolução');

  void ctx;
});

// ---------------------------------------------------------------------------
// 2) CHECK: nunca devolver mais do que o recebido
// ---------------------------------------------------------------------------
test('pg 0105: o trigger recusa item que ultrapassa o recebido (23514)', { skip }, async () => {
  const ctx = await cenario('limite', 5);
  const devId = await novaDevolucao(ctx);

  // Dentro do recebido: passa.
  await ctx.s.insert(ctx.RESOURCES.devolucao_fornecedor_itens, {
    empresa_id: ctx.empresaId,
    devolucao_id: devId,
    item_compra_id: ctx.itemId,
    produto_id: ctx.produtoId,
    insumo_id: null,
    quantidade: 3,
    custo_unitario: 10,
    estoque_baixado: false,
  });

  // 3 + 3 = 6 > 5 recebido: o backstop recusa.
  const codigo = await codigoDeErro(() =>
    q(
      `INSERT INTO devolucao_fornecedor_itens (empresa_id, devolucao_id, item_compra_id, produto_id, quantidade, custo_unitario, estoque_baixado)
       VALUES ($1,$2,$3,$4,$5,$6,false)`,
      [ctx.empresaId, devId, ctx.itemId, ctx.produtoId, 3, 10]
    )
  );
  assert.equal(codigo, '23514', 'CHECK de excesso deve disparar');
});

test('pg 0105: cancelar a devolução libera a cota do item', { skip }, async () => {
  const ctx = await cenario('cota', 5);
  const devA = await novaDevolucao(ctx);
  await q(
    `INSERT INTO devolucao_fornecedor_itens (empresa_id, devolucao_id, item_compra_id, produto_id, quantidade, custo_unitario, estoque_baixado)
     VALUES ($1,$2,$3,$4,$5,$6,false)`,
    [ctx.empresaId, devA, ctx.itemId, ctx.produtoId, 5, 10]
  );
  // Com a devolução ativa, outra de 1 estoura.
  const devB = await novaDevolucao(ctx);
  let codigo = await codigoDeErro(() =>
    q(
      `INSERT INTO devolucao_fornecedor_itens (empresa_id, devolucao_id, item_compra_id, produto_id, quantidade, custo_unitario, estoque_baixado)
       VALUES ($1,$2,$3,$4,$5,$6,false)`,
      [ctx.empresaId, devB, ctx.itemId, ctx.produtoId, 1, 10]
    )
  );
  assert.equal(codigo, '23514');
  // Cancelada, a cota volta: 5 + 1 passa a caber? Não — o cancelamento zera o já
  // devolvido, então uma nova devolução de 5 é aceita.
  await q(`UPDATE devolucoes_fornecedor SET status='cancelada', cancelada_em=now() WHERE id=$1`, [devA]);
  await ctx.s.insert(ctx.RESOURCES.devolucao_fornecedor_itens, {
    empresa_id: ctx.empresaId,
    devolucao_id: devB,
    item_compra_id: ctx.itemId,
    produto_id: ctx.produtoId,
    insumo_id: null,
    quantidade: 5,
    custo_unitario: 10,
    estoque_baixado: false,
  });
  const total = await um<{ total: string }>(`SELECT COALESCE(SUM(quantidade),0) AS total FROM devolucao_fornecedor_itens WHERE item_compra_id=$1`, [ctx.itemId]);
  assert.equal(Number(total?.total), 10, 'a linha cancelada continua registrada, mas não conta para a cota');
});

// ---------------------------------------------------------------------------
// 3) CHECK de coerência de estado
// ---------------------------------------------------------------------------
test('pg 0105: AUTORIZADA exige carimbo; EXPEDIDA exige autorização e expedição (23514)', { skip }, async () => {
  const ctx = await cenario('estado');
  const devId = await novaDevolucao(ctx);

  const semCarimbo = await codigoDeErro(() => q(`UPDATE devolucoes_fornecedor SET status='autorizada' WHERE id=$1`, [devId]));
  assert.equal(semCarimbo, '23514');

  const expedidaSemAutorizacao = await codigoDeErro(() => q(`UPDATE devolucoes_fornecedor SET status='expedida', expedida_em=now() WHERE id=$1`, [devId]));
  assert.equal(expedidaSemAutorizacao, '23514');

  // Com os carimbos na ordem certa, passa.
  await q(`UPDATE devolucoes_fornecedor SET status='autorizada', autorizada_em=now() WHERE id=$1`, [devId]);
  await q(`UPDATE devolucoes_fornecedor SET status='expedida', expedida_em=now() WHERE id=$1`, [devId]);
  const final = await um<{ status: string }>(`SELECT status FROM devolucoes_fornecedor WHERE id=$1`, [devId]);
  assert.equal(final?.status, 'expedida');

  const statusInvalido = await codigoDeErro(() => q(`UPDATE devolucoes_fornecedor SET status='qualquer' WHERE id=$1`, [devId]));
  assert.equal(statusInvalido, '23514');
});

// ---------------------------------------------------------------------------
// 4) Idempotência por empresa
// ---------------------------------------------------------------------------
test('pg 0105: a mesma idempotency_key não se repete na empresa, mas convive entre empresas', { skip }, async () => {
  const ctx = await cenario('idem');
  const chave = `idem-${SUFIXO}`;
  await q(
    `INSERT INTO devolucoes_fornecedor (empresa_id, compra_id, fornecedor_id, status, motivo, idempotency_key) VALUES ($1,$2,$3,'solicitada','x',$4)`,
    [ctx.empresaId, ctx.compraId, ctx.fornecedorId, chave]
  );
  const duplicada = await codigoDeErro(() =>
    q(
      `INSERT INTO devolucoes_fornecedor (empresa_id, compra_id, fornecedor_id, status, motivo, idempotency_key) VALUES ($1,$2,$3,'solicitada','x',$4)`,
      [ctx.empresaId, ctx.compraId, ctx.fornecedorId, chave]
    )
  );
  assert.equal(duplicada, '23505', 'índice único parcial por empresa');

  // Outra empresa com a MESMA chave: permitido (o índice é por empresa).
  const outro = await cenario('idem-b');
  await ctx.s.insert(ctx.RESOURCES.devolucoes_fornecedor, {
    empresa_id: outro.empresaId,
    compra_id: outro.compraId,
    fornecedor_id: outro.fornecedorId,
    status: 'solicitada',
    motivo: 'x',
    idempotency_key: chave,
  });
  const total = await um<{ n: string }>(`SELECT COUNT(*) AS n FROM devolucoes_fornecedor WHERE idempotency_key=$1`, [chave]);
  assert.equal(Number(total?.n), 2);
});
