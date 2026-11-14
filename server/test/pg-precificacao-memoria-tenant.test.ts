// ============================================================================
// ETAPA 02 — precificacao_memoria × PostgreSQL REAL.
//
// Bug real corrigido: `registrarMemoriaPrecificacao` não informava empresa_id.
// No memdb a linha caía na empresa DEFAULT 1 (escrita cross-tenant quando o
// produto era de outra empresa); no PG a coluna é NOT NULL sem default nem
// trigger — a trilha era recusada. A correção deriva a empresa do PRODUTO no
// servidor. Este teste prova em PG real:
//   A — a memória de um produto da empresa B nasce com empresa_id = B;
//   B — a leitura recortada por empresa não devolve a linha para A;
//   C — produto inexistente não gera trilha órfã.
//
// Sem DATABASE_URL o arquivo se auto-pula (job testes-postgres do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

test('precificacao_memoria: empresa derivada do produto no PG real (regressão cross-tenant)', { skip }, async () => {
  const { migrate } = await import('../src/db');
  await migrate();
  const { getStore, createRecord, getRecord, listRecords } = await import('../src/services');
  const { RESOURCES } = await import('../src/resources');
  const { escopoDeSistema } = await import('../src/empresa');
  const { registrarMemoriaPrecificacao } = await import('../src/commerce/motorPrecos');
  const s = getStore();
  const admin = { id: 1, name: 'Admin PG', perfil: 'admin' as const };

  const empA = await createRecord(RESOURCES.empresas, { nome: `MEM A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `MEM B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const escopoA = escopoDeSistema(A);
  const escopoB = escopoDeSistema(B);
  const ana = { id: 0, name: 'Ana', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const bruno = { id: 0, name: 'Bruno', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  const prodB = await createRecord(RESOURCES.produtos, { sku: `MEM-${sufixo}`, nome: 'Produto memória B', preco_venda: 100 }, bruno, { escopo: escopoB });
  const entrada = { canal: 'varejo' as const, produto_id: Number(prodB.id), quantidade: 1, preco_lista: 100, preco_aplicado: 90, desconto_pct: 10, custo: 50, margem_valor: 40, margem_pct: 44, origem_preco: 'produto' };
  const id = await registrarMemoriaPrecificacao(entrada);
  assert.ok(id, 'a trilha precisa ser gravada (antes da correção o PG recusava por NOT NULL)');

  const linha = await s.findOneWhere(RESOURCES.precificacao_memoria, { id });
  assert.equal(Number(linha!.empresa_id), B, 'empresa da memória = empresa do PRODUTO');

  await assert.rejects(() => getRecord(RESOURCES.precificacao_memoria, Number(id), escopoA), (e: any) => e.status === 404);
  const listaA = await listRecords(RESOURCES.precificacao_memoria, { page: 1, pageSize: 100, filter: { produto_id: Number(prodB.id) } }, escopoA);
  assert.equal(listaA.rows.length, 0);
  const listaB = await listRecords(RESOURCES.precificacao_memoria, { page: 1, pageSize: 100, filter: { produto_id: Number(prodB.id) } }, escopoB);
  assert.equal(listaB.rows.length, 1);

  assert.equal(await registrarMemoriaPrecificacao({ ...entrada, produto_id: 99999999 }), null, 'produto inexistente não gera trilha órfã');
  void ana;
});
