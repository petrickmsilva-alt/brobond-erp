// ============================================================================
// COMMERCE ENTERPRISE — ONDA 3 (PostgreSQL real).
//
// A vitrine nativa `/loja` foi RETIRADA (ADR-0007): os testes de catálogo
// público e de despublicação da vitrine deixaram de existir. O que resta é o
// contrato do conector externo: token cifrado resolvido pelo conector e corpo
// de erro externo NUNCA persistido.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL) throw new Error('Wave 3 requires PostgreSQL');
process.env.NODE_ENV = 'test';
const { migrate, pool } = await import('../../src/db'); await migrate();
const { getStore } = await import('../../src/services'); const { RESOURCES } = await import('../../src/resources');
const { enfileirarPublicacao, processarPublicacao } = await import('../../src/commerce/catalogo');
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

test('PG marketplace: token cifrado é resolvido pelo conector e corpo de erro externo não é persistido', async (t) => {
  const c = await company('wave3-token'); const previous = process.env.CONNECTOR_ENCRYPTION_KEY; process.env.CONNECTOR_ENCRYPTION_KEY = '1'.repeat(64); initConnectors();
  // Canal ML suspenso por padrão (P0-01). Este teste mocka o fetch (nenhuma chamada real): libera SÓ aqui, e restaura.
  const previousCanais = process.env.PUBLICACAO_CANAIS_LIBERADOS; process.env.PUBLICACAO_CANAIS_LIBERADOS = 'MERCADOLIVRE';
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
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY; else process.env.CONNECTOR_ENCRYPTION_KEY = previous;
    if (previousCanais === undefined) delete process.env.PUBLICACAO_CANAIS_LIBERADOS; else process.env.PUBLICACAO_CANAIS_LIBERADOS = previousCanais;
  }
});
