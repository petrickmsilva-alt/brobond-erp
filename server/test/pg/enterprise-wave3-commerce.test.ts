import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Wave 3 requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { getStore } = await import('../../src/services'); const { RESOURCES } = await import('../../src/resources');
const { enfileirarPublicacao, processarPublicacao, despublicarProduto } = await import('../../src/commerce/catalogo');
const { lojaProdutosPublicos, lojaPreview } = await import('../../src/commerce/vitrine');
const { initConnectors } = await import('../../src/connectors');
const { encryptConnectorSecret } = await import('../../../modules/connectors/core/crypto.service');
const s = getStore();
async function company(prefix: string) {
  assert.ok(pool); const suffix = randomUUID().slice(0, 8);
  const id = Number((await pool.query('INSERT INTO empresas(nome,ativo) VALUES($1,true) RETURNING id', [`${prefix} ${suffix}`])).rows[0].id);
  const user = Number((await pool.query("INSERT INTO usuarios(nome,email,perfil,ativo,empresa_id) VALUES('PG',$1,'admin',true,$2) RETURNING id", [`${prefix}-${suffix}@example.invalid`, id])).rows[0].id);
  return { id, user, suffix, actor: { id: user, name: 'PG', perfil: 'admin', empresa_id: id, empresas: [id] } };
}
const payload = (slug: string) => ({ sku: slug, titulo: slug, resumo: null, descricao: '', slug, preco: 20, preco_promo: null,
  condicao: 'novo', ativo: true, destaque: false, disponivel: 1, metadados: { ml_category_id: 'TESTE' } });
function res() { let result: any; return { out: { json(v: any) { result = v; return this; } } as any, body: () => result }; }

test('PG vitrine: catálogo com 1001 produtos não perde preço de canal após primeira página', async () => {
  const c = await company('wave3-list'); const old = process.env.COMMERCE_LOJA_EMPRESA_ID; process.env.COMMERCE_LOJA_EMPRESA_ID = String(c.id);
  try {
    await pool!.query("INSERT INTO commerce_configuracoes (empresa_id,loja_nome,frete_provedor) VALUES ($1,'Teste','retirada')", [c.id]);
    await pool!.query("INSERT INTO locais (empresa_id,nome,tipo,ativo,padrao) VALUES ($1,'Estoque PG','loja',true,true)", [c.id]);
    await pool!.query(`INSERT INTO produtos (empresa_id,sku,nome,ativo,preco_venda)
      SELECT $1, $2 || '-' || i, 'Produto ' || i, true, 10 FROM generate_series(1,1001) i`, [c.id, c.suffix]);
    await pool!.query(`INSERT INTO commerce_produtos (empresa_id,produto_id,slug)
      SELECT empresa_id,id,'item-' || id FROM produtos WHERE empresa_id=$1`, [c.id]);
    await pool!.query(`INSERT INTO commerce_publicacoes (empresa_id,produto_id,canal,versao,estado)
      SELECT empresa_id,id,'BROBOND',1,'PUBLISHED' FROM produtos WHERE empresa_id=$1`, [c.id]);
    await pool!.query(`INSERT INTO commerce_precos (empresa_id,produto_id,canal,preco)
      SELECT empresa_id,id,'BROBOND',CASE WHEN sku=$2 THEN 77 ELSE 20 END FROM produtos WHERE empresa_id=$1`, [c.id, `${c.suffix}-1001`]);
    const id = Number((await pool!.query('SELECT id FROM produtos WHERE empresa_id=$1 AND sku=$2', [c.id, `${c.suffix}-1001`])).rows[0].id);
    const list = res(); await lojaProdutosPublicos({ query: { q: 'Produto 1001' } } as any, list.out);
    assert.equal(list.body().total, 1); assert.equal(Number(list.body().produtos[0].preco), 77);
    const preview = res(); await lojaPreview({ body: { itens: [{ produto_id: id, quantidade: 1 }] } } as any, preview.out);
    assert.equal(preview.body().itens[0].preco_unitario, 77); assert.equal(preview.body().totais.total, 77);
  } finally { if (old === undefined) delete process.env.COMMERCE_LOJA_EMPRESA_ID; else process.env.COMMERCE_LOJA_EMPRESA_ID = old; }
});

test('PG marketplace: token cifrado é resolvido pelo conector e corpo de erro externo não é persistido', async (t) => {
  const c = await company('wave3-token'); const previous = process.env.CONNECTOR_ENCRYPTION_KEY; process.env.CONNECTOR_ENCRYPTION_KEY = '1'.repeat(64); initConnectors();
  try {
    const product = (await pool!.query("INSERT INTO produtos (empresa_id,sku,nome,ativo,preco_venda) VALUES ($1,$2,'Teste',true,20) RETURNING id", [c.id, `sku-${c.suffix}`])).rows[0];
    const cipher = encryptConnectorSecret('fixture-private-token');
    await pool!.query(`INSERT INTO connectors (id,empresa_id,usuario_id,provider,status,access_token)
      VALUES ($1,$2,$3,'MERCADOLIVRE','CONNECTED',$4)`, [`conn-${c.suffix}`, c.id, c.user, cipher]);
    let calls = 0; let authorization = '';
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++; authorization = String((init.headers as any).Authorization || '');
      return new Response(JSON.stringify({ token: 'fixture-private-token', email: 'private@example.invalid', message: 'erro' }), { status: 400 });
    });
    const row = await enfileirarPublicacao(c.id, Number(product.id), 'MERCADOLIVRE', payload('pg-item'), c.user);
    assert.equal(await processarPublicacao(row), 'falhou'); assert.equal(calls, 1);
    assert.equal(authorization, 'Bearer fixture-private-token'); assert.notEqual(authorization, `Bearer ${cipher}`);
    const saved = await s.get(RESOURCES.commerce_publicacoes, Number(row.id));
    assert.match(String(saved?.ultimo_erro), /HTTP 400/);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-private-token|private@example\.invalid/);
    assert.equal(saved?.estado, 'ERROR');
  } finally { if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY; else process.env.CONNECTOR_ENCRYPTION_KEY = previous; }
});

test('PG despublicação: versões históricas e worker em andamento são cercados', async () => {
  const c = await company('wave3-unpublish');
  const p = (await pool!.query("INSERT INTO produtos (empresa_id,sku,nome,ativo,preco_venda) VALUES ($1,$2,'PG',true,10) RETURNING id", [c.id, `sku-${c.suffix}`])).rows[0];
  await pool!.query("INSERT INTO commerce_publicacoes (empresa_id,produto_id,canal,versao,estado) VALUES ($1,$2,'BROBOND',1,'PUBLISHED'),($1,$2,'BROBOND',2,'PUBLISHED')", [c.id, p.id]);
  const row = await enfileirarPublicacao(c.id, Number(p.id), 'BROBOND', payload('pg-item'), c.user);
  const original = s.tryUpdateIf.bind(s); let claimed!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { claimed = r; }); const hold = new Promise<void>((r) => { release = r; });
  s.tryUpdateIf = async (resource, id, expected, data, tx) => {
    const result = await original(resource, id, expected, data, tx);
    if (resource.key === 'commerce_publicacoes' && Number(id) === Number(row.id) && data.estado === 'PUBLISHING' && result) { claimed(); await hold; }
    return result;
  };
  try {
    const worker = processarPublicacao(row); await started;
    await despublicarProduto({ user: c.actor, params: { id: p.id }, body: {} } as any, res().out);
    release(); assert.equal(await worker, 'ignorada');
    const states = await pool!.query('SELECT estado FROM commerce_publicacoes WHERE empresa_id=$1 AND produto_id=$2', [c.id, p.id]);
    assert.equal(states.rows.length, 3); assert.ok(states.rows.every((r: any) => r.estado === 'UNPUBLISHED'));
  } finally { release(); s.tryUpdateIf = original; }
});
