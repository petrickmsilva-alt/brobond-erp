// LISTAGEM DE PRODUTOS EM ESCALA — prova no PostgreSQL real (job testes-postgres).
// Sem DATABASE_URL este arquivo se auto-pula; nunca usa banco de produção.
//
// O modo memória já cobre o contrato (server/test/produtos-listagem.test.ts). Aqui
// a pergunta é outra: o SQL que o Postgres EXECUTA honra a mesma paginação, o
// mesmo recorte de tenant e a mesma whitelist de ordenação? São caminhos de
// código distintos (pgstore.ts monta LIMIT/OFFSET e ORDER BY em SQL).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';
const sufixo = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

type Ator = { id: number; name: string; perfil: 'admin'; empresa_id: number; empresas: number[] };

test('Listagem de produtos em escala: paginação, busca, filtros e ordenação no PostgreSQL', { skip }, async (t) => {
  const { migrate } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { createRecord, listRecords, escopoDe } = await import('../../src/services');

  const admin = { id: 1, name: 'Admin Listagem PG', perfil: 'admin' as const };
  const empA = await createRecord(R.empresas, { nome: `LISTAGEM PG A ${sufixo}` }, admin);
  const empB = await createRecord(R.empresas, { nome: `LISTAGEM PG B ${sufixo}` }, admin);
  const aId = Number(empA.id);
  const bId = Number(empB.id);
  const escopoA = escopoDe({ id: 0, name: 'A', perfil: 'gerente', empresa_id: aId, empresas: [aId] } as any);
  const escopoB = escopoDe({ id: 0, name: 'B', perfil: 'gerente', empresa_id: bId, empresas: [bId] } as any);

  // Os cadastros de referência pertencem à empresa A: o produto valida a
  // referência DENTRO do tenant, então criá-los na empresa 1 os tornaria
  // inválidos para um produto da empresa A.
  const atorA = { ...admin, empresa_id: aId, empresas: [aId] } as any;
  const categoria = await createRecord(R.categorias, { nome: `Cat ${sufixo}`, ativo: true }, atorA);
  const cor = await createRecord(R.cores, { nome: `Cor ${sufixo}`, hex: '#0A0B0C', ativo: true }, atorA);
  const tamanho = await createRecord(R.tamanhos, { codigo: `T${sufixo}`.slice(0, 10), nome: 'M', ordem: 1, ativo: true }, atorA);
  const grade = await createRecord(R.grades, { nome: `Grade ${sufixo}`, tamanhos: [Number(tamanho.id)], ativo: true }, atorA);
  const colecao = await createRecord(R.colecoes, { nome: `Colecao ${sufixo}`, temporada: 'Verão', ano: 2026 }, atorA);
  const fornecedor = await createRecord(R.fornecedores, { nome: `Forn ${sufixo}`, ativo: true }, atorA);

  // 120 produtos: 5 páginas de 25, 3 de 50, 2 de 100.
  const TOTAL = 120;
  for (let i = 1; i <= TOTAL; i++) {
    const n = String(i).padStart(3, '0');
    await createRecord(R.produtos, {
      sku: `LPG-${n}`,
      nome: `Produto Listagem ${n} ${sufixo}`,
      categoria_id: Number(categoria.id),
      colecao_id: Number(colecao.id),
      cor_id: Number(cor.id),
      grade_id: Number(grade.id),
      fornecedor_id: Number(fornecedor.id),
      formato: i % 3 === 0 ? 'variacao' : 'simples',
      ativo: i % 10 !== 0,
      preco_venda: i * 10,
      codigo_barras: i === 7 ? '7891234500077' : null,
    }, atorA);
  }
  // Mesmo padrão de nome na empresa B: não pode aparecer para A.
  await createRecord(R.produtos, { sku: 'LPG-B-001', nome: `Produto Listagem 001 ${sufixo}`, ativo: true },
    { ...admin, empresa_id: bId, empresas: [bId] } as any);

  const lista = (p: any) => listRecords(R.produtos, p, escopoA);

  await t.test('a página pedida é a página recebida, com total do conjunto', async () => {
    const p1 = await lista({ page: 1, pageSize: 25, q: sufixo });
    assert.equal(p1.total, TOTAL);
    assert.equal(p1.rows.length, 25);
    const p5 = await lista({ page: 5, pageSize: 25, q: sufixo });
    assert.equal(p5.rows.length, 20, 'última página traz o resto (120 = 4×25 + 20)');
    const p6 = await lista({ page: 6, pageSize: 25, q: sufixo });
    assert.equal(p6.rows.length, 0, 'além do fim vem vazio, sem erro');
    assert.equal(p6.total, TOTAL, 'o total não depende da página');
  });

  await t.test('25/50/100 por página respeitam o recorte pedido', async () => {
    for (const [pageSize, paginas] of [[25, 5], [50, 3], [100, 2]] as const) {
      const primeira = await lista({ page: 1, pageSize, q: sufixo });
      assert.equal(primeira.rows.length, pageSize, `${pageSize} na 1ª página`);
      assert.equal(primeira.total, TOTAL);
      const ultima = await lista({ page: paginas, pageSize, q: sufixo });
      assert.ok(ultima.rows.length > 0, `${pageSize}: a ${paginas}ª página existe`);
    }
  });

  await t.test('páginas consecutivas não repetem nem pulam registros', async () => {
    const vistos = new Set<number>();
    for (let page = 1; page <= 5; page++) {
      const r = await lista({ page, pageSize: 25, q: sufixo });
      for (const row of r.rows) {
        assert.ok(!vistos.has(Number(row.id)), `id ${row.id} repetido entre páginas`);
        vistos.add(Number(row.id));
      }
    }
    assert.equal(vistos.size, TOTAL, 'as 5 páginas cobrem exatamente os 120 registros');
  });

  await t.test('busca por nome, SKU, código de barras e parcial no SQL', async () => {
    assert.ok((await lista({ page: 1, pageSize: 5, q: 'Produto Listagem 007' })).total >= 1, 'nome');
    assert.equal((await lista({ page: 1, pageSize: 5, q: 'LPG-007' })).rows[0]?.sku, 'LPG-007', 'SKU');
    assert.equal((await lista({ page: 1, pageSize: 5, q: '7891234500077' })).total, 1, 'código de barras');
    assert.ok((await lista({ page: 1, pageSize: 5, q: 'LPG-01' })).total >= 10, 'SKU parcial');
  });

  await t.test('filtros e faixa de preço são aplicados no servidor', async () => {
    const inativos = await lista({ page: 1, pageSize: 200, q: sufixo, filter: { ativo: false } });
    assert.equal(inativos.total, TOTAL / 10, 'só os inativos do recorte');
    assert.ok(inativos.rows.every((r: any) => r.ativo === false));
    const faixa = await lista({ page: 1, pageSize: 200, q: sufixo, filter: { preco_venda_min: 500, preco_venda_max: 700 } });
    assert.ok(faixa.rows.every((r: any) => Number(r.preco_venda) >= 500 && Number(r.preco_venda) <= 700));
    assert.equal(faixa.total, 21, 'de 500 a 700 de 10 em 10');
  });

  await t.test('ordenação por whitelist e coluna arbitrária não vira SQL', async () => {
    const porSku = await lista({ page: 1, pageSize: 5, q: sufixo, sort: 'sku', dir: 'desc' });
    assert.deepEqual(porSku.rows.map((r: any) => r.sku), ['LPG-120', 'LPG-119', 'LPG-118', 'LPG-117', 'LPG-116']);
    // `sort` fora da whitelist não injeta: a lista volta na ordem padrão e íntegra.
    const injetado = await lista({ page: 1, pageSize: 5, q: sufixo, sort: 'id;DROP TABLE produtos--', dir: 'asc' });
    assert.equal(injetado.total, TOTAL);
    const aindaExiste = await lista({ page: 1, pageSize: 1, q: sufixo });
    assert.equal(aindaExiste.total, TOTAL, 'a tabela continua de pé');
  });

  await t.test('estado preservado: busca + filtro + ordenação sobrevivem à troca de página', async () => {
    const base = { q: sufixo, filter: { ativo: true }, sort: 'preco_venda', dir: 'asc' as const, pageSize: 25 };
    const p1 = await lista({ ...base, page: 1 });
    const p2 = await lista({ ...base, page: 2 });
    assert.equal(p1.total, p2.total, 'o total não muda ao paginar');
    const ultimoDeP1 = Number(p1.rows.at(-1)!.preco_venda);
    const primeiroDeP2 = Number(p2.rows[0].preco_venda);
    assert.ok(primeiroDeP2 >= ultimoDeP1, 'a ordem crescente atravessa a fronteira da página');
  });

  await t.test('multi-tenant: lista, busca e filtro não vazam produto de outra empresa', async () => {
    const deA = await lista({ page: 1, pageSize: 200, q: sufixo });
    assert.equal(deA.total, TOTAL);
    const deB = await listRecords(R.produtos, { page: 1, pageSize: 200, q: sufixo }, escopoB);
    assert.equal(deB.total, 1, 'a B vê só o produto dela');
    // `f.empresa_id` forjado pelo cliente é descartado pelo serviço.
    const forjado = await lista({ page: 1, pageSize: 200, q: sufixo, filter: { empresa_id: bId } });
    assert.equal(forjado.total, TOTAL, 'o filtro de empresa forjado não troca o recorte');
  });
});
