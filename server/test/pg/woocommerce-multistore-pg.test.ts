// ============================================================================
// WOOCOMMERCE MULTI-STORE EM POSTGRESQL REAL (migration 0100).
//
// O MemStore não tem índice único parcial, CHECK constraint nem corrida de
// verdade — aqui se prova o que só o PostgreSQL prova:
//
//   01. a migration 0100 existe: tabelas, colunas `store_key` e índices;
//   02. a unicidade dos VÍNCULOS é NULL-safe e POR LOJA: o mesmo produto tem um
//       vínculo na RETAIL e outro na WHOLESALE, e a variação tem o dela;
//   03. o MESMO ID externo não pode pertencer a duas lojas nem a dois produtos;
//   04. o vínculo recusa loja fora de RETAIL/WHOLESALE (CHECK);
//   05. o vínculo recusa empresa inexistente (FK) — sem vínculo órfão;
//   06. reimportação CONCORRENTE do mesmo pedido por loja → UMA venda
//       (uq_vendas_pedido_externo com canal por loja);
//   07. o mesmo id de pedido nas DUAS lojas gera DUAS vendas;
//   08. `woocommerce_sync_state` é uma linha por (empresa, loja) e o estado de
//       uma loja não toca o da outra;
//   09. as publicações passam a ser únicas por (empresa, produto, canal, LOJA).
//
// Sem DATABASE_URL o arquivo se auto-pula (o gate test:pg exige 0 skips —
// quando o gate roda, DATABASE_URL existe).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (gate test:pg / job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Tenant = { empresaId: number; sufixo: string };

const RODADA = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (p: string) => `${p}-${RODADA}-${++contador}`;

async function novoTenant(): Promise<Tenant> {
  const { query } = await import('../../src/db');
  const sufixo = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const emp = await query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Woo ${sufixo}`]);
  return { empresaId: Number(emp.rows[0].id), sufixo };
}

async function novoProdutoPg(empresaId: number, dados: { sku: string; preco_venda?: number; preco_atacado?: number } ) {
  const { query } = await import('../../src/db');
  const r = await query(
    `INSERT INTO produtos (empresa_id, sku, nome, preco_venda, preco_atacado, ativo, exibir_site)
     VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id`,
    [empresaId, dados.sku, `Produto ${dados.sku}`, dados.preco_venda ?? 100, dados.preco_atacado ?? 60]
  );
  return Number(r.rows[0].id);
}

/** Remove TUDO que a fixture criou (ordem por FK; melhor esforço). */
async function limpar(t: Tenant): Promise<void> {
  const { query } = await import('../../src/db');
  const apagar = async (sql: string) => query(sql, [t.empresaId]).catch(() => undefined);
  await apagar(`DELETE FROM woocommerce_product_links WHERE empresa_id = $1`);
  await apagar(`DELETE FROM woocommerce_sync_state WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_publicacoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_outbox WHERE empresa_id = $1`);
  await apagar(`DELETE FROM itens_venda WHERE venda_id IN (SELECT id FROM vendas WHERE empresa_id = $1)`);
  await apagar(`DELETE FROM vendas WHERE empresa_id = $1`);
  await apagar(`DELETE FROM clientes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM estoques WHERE empresa_id = $1`);
  await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM locais WHERE empresa_id = $1`);
  await apagar(`DELETE FROM empresas WHERE id = $1`);
}

test('01. migration 0100 — tabelas, colunas e índices existem', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const tabelas = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('woocommerce_product_links','woocommerce_sync_state')`
  );
  assert.equal(tabelas.rows.length, 2, 'as duas tabelas do multi-loja existem');

  const colunas = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name = 'store_key' AND table_name IN ('commerce_publicacoes','commerce_outbox')`
  );
  assert.equal(colunas.rows.length, 2, 'store_key adicionado à publicação e à fila');

  const indices = await query(
    `SELECT indexname FROM pg_indexes WHERE indexname IN
      ('uq_woo_links_produto_simples','uq_woo_links_produto_variacao','uq_woo_links_external_produto',
       'uq_woo_links_external_variacao','uq_woocommerce_sync_state','uq_commerce_publicacoes_versao_loja')`
  );
  assert.equal(indices.rows.length, 6, 'os índices de unicidade do multi-loja existem');
});

test('02. vínculos são NULL-safe e POR LOJA (produto simples × variação)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const produtoId = await novoProdutoPg(t.empresaId, { sku: unico('LINK') });

    // Produto simples: UM vínculo por loja (external_variation_id NULL).
    await query(
      `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id, sku)
       VALUES ($1,'RETAIL',$2,'9001',$3), ($1,'WHOLESALE',$2,'7001',$3)`,
      [t.empresaId, produtoId, 'SKU-LINK']
    );

    // Repetir o vínculo do produto na MESMA loja é recusado.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id)
           VALUES ($1,'RETAIL',$2,'9002')`,
          [t.empresaId, produtoId]
        ),
      (e: any) => e.code === '23505',
      'um produto tem UM vínculo de produto por loja'
    );

    // Duas variações do mesmo produto na mesma loja convivem (variation não nulo).
    await query(
      `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id, external_variation_id, sku)
       VALUES ($1,'RETAIL',$2,'9001','5001',$3), ($1,'RETAIL',$2,'9001','5002',$4)`,
      [t.empresaId, produtoId, 'SKU-LINK-P', 'SKU-LINK-G']
    );

    const linhas = await query(
      `SELECT store_key, external_product_id, external_variation_id FROM woocommerce_product_links WHERE empresa_id=$1 ORDER BY id`,
      [t.empresaId]
    );
    assert.equal(linhas.rows.length, 4, '2 vínculos de produto (RETAIL/WHOLESALE) + 2 variações');
    const retail = linhas.rows.filter((r) => r.store_key === 'RETAIL');
    const wholesale = linhas.rows.filter((r) => r.store_key === 'WHOLESALE');
    assert.equal(retail.length, 3);
    assert.equal(wholesale.length, 1);
    assert.equal(retail[0].external_product_id, '9001');
    assert.equal(wholesale[0].external_product_id, '7001', 'o ID externo da RETAIL nunca vira o da WHOLESALE');
  } finally {
    await limpar(t);
  }
});

test('03. o MESMO ID externo não pode pertencer a duas lojas nem a dois produtos', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const produtoA = await novoProdutoPg(t.empresaId, { sku: unico('EXT-A') });
    const produtoB = await novoProdutoPg(t.empresaId, { sku: unico('EXT-B') });
    await query(
      `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id) VALUES ($1,'RETAIL',$2,'8000')`,
      [t.empresaId, produtoA]
    );
    // Mesmo ID externo, MESMA loja, OUTRO produto → recusado.
    await assert.rejects(
      () =>
        query(
          `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id) VALUES ($1,'RETAIL',$2,'8000')`,
          [t.empresaId, produtoB]
        ),
      (e: any) => e.code === '23505',
      'um ID externo pertence a um único produto da loja'
    );
    // Mesmo ID externo na OUTRA loja → permitido (lojas independentes).
    await query(
      `INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id) VALUES ($1,'WHOLESALE',$2,'8000')`,
      [t.empresaId, produtoB]
    );
  } finally {
    await limpar(t);
  }
});

test('04. vínculo recusa loja fora de RETAIL/WHOLESALE e empresa inexistente', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const produtoId = await novoProdutoPg(t.empresaId, { sku: unico('CHECK') });
    await assert.rejects(
      () =>
        query(`INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id) VALUES ($1,'LOJA1',$2,'1')`, [
          t.empresaId,
          produtoId,
        ]),
      (e: any) => e.code === '23514',
      'a loja é um identificador fechado (CHECK)'
    );
    await assert.rejects(
      () =>
        query(`INSERT INTO woocommerce_product_links (empresa_id, store_key, produto_id, external_product_id) VALUES (999999999,'RETAIL',$1,'1')`, [
          produtoId,
        ]),
      (e: any) => e.code === '23503',
      'não existe vínculo para empresa inexistente'
    );
  } finally {
    await limpar(t);
  }
});

test('05. reimportação CONCORRENTE do mesmo pedido por loja → UMA venda', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const cliente = await query(`INSERT INTO clientes (empresa_id, nome, ativo) VALUES ($1, 'Cliente Conc', true) RETURNING id`, [t.empresaId]);
    const clienteId = Number(cliente.rows[0].id);
    const pedidoId = Math.floor(Math.random() * 1e9);
    const referencia = `WOO-RETAIL-${pedidoId}`;

    const inserir = () =>
      query(
        `INSERT INTO vendas (empresa_id, cliente_id, data, status, canal_venda, pedido_cliente, pedido_externo_canal, pedido_externo_id)
         VALUES ($1, $2, CURRENT_DATE, 'cotacao', 'site_varejo', $3, 'WOOCOMMERCE_RETAIL', $4) RETURNING id`,
        [t.empresaId, clienteId, referencia, String(pedidoId)]
      );

    // 6 tentativas simultâneas do MESMO pedido da MESMA loja.
    const tentativas = await Promise.allSettled(Array.from({ length: 6 }, inserir));
    const vencedoras = tentativas.filter((r) => r.status === 'fulfilled');
    assert.equal(vencedoras.length, 1, 'exatamente uma gravação venceu');
    const perdedoras = tentativas.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.ok(perdedoras.every((r) => r.reason?.code === '23505'), 'as demais recebem 23505 (idempotência, nunca erro genérico)');

    const n = await query(`SELECT COUNT(*)::int AS n FROM vendas WHERE empresa_id=$1 AND pedido_cliente=$2`, [t.empresaId, referencia]);
    assert.equal(Number(n.rows[0].n), 1, 'uma única venda para o pedido');
  } finally {
    await limpar(t);
  }
});

test('06. o MESMO id de pedido nas DUAS lojas gera DUAS vendas', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const cliente = await query(`INSERT INTO clientes (empresa_id, nome, ativo) VALUES ($1, 'Cliente Dual', true) RETURNING id`, [t.empresaId]);
    const clienteId = Number(cliente.rows[0].id);
    const pedidoId = Math.floor(Math.random() * 1e9);
    const inserir = (store: string, canal: string) =>
      query(
        `INSERT INTO vendas (empresa_id, cliente_id, data, status, canal_venda, pedido_cliente, pedido_externo_canal, pedido_externo_id)
         VALUES ($1, $2, CURRENT_DATE, 'cotacao', $3, $4, $5, $6) RETURNING id`,
        [t.empresaId, clienteId, canal, `WOO-${store}-${pedidoId}`, `WOOCOMMERCE_${store}`, String(pedidoId)]
      );
    const retail = await inserir('RETAIL', 'site_varejo');
    const wholesale = await inserir('WHOLESALE', 'site_atacado');
    assert.notEqual(Number(retail.rows[0].id), Number(wholesale.rows[0].id), 'duas vendas legítimas');

    const n = await query(`SELECT COUNT(*)::int AS n FROM vendas WHERE empresa_id=$1 AND pedido_externo_id=$2`, [t.empresaId, String(pedidoId)]);
    assert.equal(Number(n.rows[0].n), 2, 'o mesmo pedido nas duas lojas convive no banco');
  } finally {
    await limpar(t);
  }
});

test('07. woocommerce_sync_state — uma linha por (empresa, loja), estados independentes', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    await query(
      `INSERT INTO woocommerce_sync_state (empresa_id, store_key, ultimo_pedido_em, ultimo_erro, tentativas)
       VALUES ($1,'RETAIL', now(), NULL, 0), ($1,'WHOLESALE', NULL, 'Falha de autenticação', 2)`,
      [t.empresaId]
    );
    await assert.rejects(
      () => query(`INSERT INTO woocommerce_sync_state (empresa_id, store_key) VALUES ($1,'RETAIL')`, [t.empresaId]),
      (e: any) => e.code === '23505',
      'uma linha por loja'
    );
    const linhas = await query(`SELECT store_key, ultimo_erro, tentativas FROM woocommerce_sync_state WHERE empresa_id=$1 ORDER BY store_key`, [
      t.empresaId,
    ]);
    assert.equal(linhas.rows.length, 2);
    const retail = linhas.rows.find((r) => r.store_key === 'RETAIL')!;
    const wholesale = linhas.rows.find((r) => r.store_key === 'WHOLESALE')!;
    assert.equal(retail.ultimo_erro, null, 'a RETAIL não recebe o erro da WHOLESALE');
    assert.equal(wholesale.ultimo_erro, 'Falha de autenticação');
    assert.equal(Number(wholesale.tentativas), 2);
  } finally {
    await limpar(t);
  }
});

test('08. publicações são únicas por (empresa, produto, canal, LOJA)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const t = await novoTenant();
  try {
    const produtoId = await novoProdutoPg(t.empresaId, { sku: unico('PUB') });
    const inserir = (store: string, versao: number) =>
      query(
        `INSERT INTO commerce_publicacoes (empresa_id, produto_id, canal, versao, estado, payload, payload_hash, store_key)
         VALUES ($1,$2,'WOOCOMMERCE',$3,'QUEUED','{}'::jsonb,'h',$4) RETURNING id`,
        [t.empresaId, produtoId, versao, store]
      );
    // Mesma versão em lojas diferentes: permitido (a loja faz parte da identidade).
    const r1 = await inserir('RETAIL', 1);
    const r2 = await inserir('WHOLESALE', 1);
    assert.notEqual(Number(r1.rows[0].id), Number(r2.rows[0].id));
    // Mesma versão na MESMA loja: recusado.
    await assert.rejects(
      () => inserir('RETAIL', 1),
      (e: any) => e.code === '23505',
      'a versão é única por loja'
    );
    // Uma SEGUNDA linha ativa na MESMA loja: recusado (o pipeline é único por loja).
    await assert.rejects(
      () => inserir('WHOLESALE', 2),
      (e: any) => e.code === '23505',
      'uma linha ativa por (produto, canal, loja)'
    );
    // Duas ativas no mesmo (produto, canal) em LOJAS diferentes: permitido —
    // é exatamente o que a missão exige (publicação independente por loja).
    const ativas = await query(
      `SELECT store_key FROM commerce_publicacoes
        WHERE empresa_id=$1 AND produto_id=$2 AND canal='WOOCOMMERCE'
          AND estado IN ('DRAFT','READY','QUEUED','PUBLISHING','UPDATE_QUEUED')`,
      [t.empresaId, produtoId]
    );
    assert.deepEqual(ativas.rows.map((r) => r.store_key).sort(), ['RETAIL', 'WHOLESALE'], 'as duas lojas têm a própria publicação ativa');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 10. O cron RECORRENTE re-arma o evento terminal — em PostgreSQL real, com o
//     CAS por `claim_versao` que só o banco garante.
// ---------------------------------------------------------------------------
test('10. cron recorrente re-arma o evento PROCESSADO sem duplicar a linha', { skip }, async () => {
  const { enfileirarEstoqueDaLoja } = await import('../../src/commerce/woocommerce/outboxStore');
  const { query } = await import('../../src/db');
  const t = await novoTenant();
  try {
    const primeiro = await enfileirarEstoqueDaLoja(t.empresaId, 'RETAIL');
    assert.equal(String(primeiro.estado), 'PENDENTE');
    // O worker conclui o evento (claim_versao avança como no fluxo real).
    await query(`UPDATE commerce_outbox SET estado='PROCESSADO', claim_versao=claim_versao+1 WHERE id=$1`, [Number(primeiro.id)]);

    const segundo = await enfileirarEstoqueDaLoja(t.empresaId, 'RETAIL');
    assert.equal(Number(segundo.id), Number(primeiro.id), 'reusa a mesma linha');
    assert.equal(String(segundo.estado), 'PENDENTE', 'o cron volta a sincronizar o que já terminou');

    const linhas = await query(`SELECT estado FROM commerce_outbox WHERE empresa_id=$1 AND store_key='RETAIL'`, [t.empresaId]);
    assert.equal(linhas.rows.length, 1, 'nunca duas linhas para o mesmo lote recorrente');
    assert.equal(linhas.rows[0].estado, 'PENDENTE');
  } finally {
    await limpar(t);
  }
});
