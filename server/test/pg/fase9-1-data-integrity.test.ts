// ============================================================================
// FASE 9.1 — DATA INTEGRITY & PERFORMANCE em PostgreSQL REAL (BL-016).
//
// A projeção `sale_items` não tem `empresa_id`: a empresa vem de `sales`. O
// risco histórico (BL-016) era ler itens com `filter: {}` e recortar por
// `sale_id` em MEMÓRIA — trazendo itens de outras empresas e truncando por um
// `pageSize` fixo. A correção recorta o tenant no SQL (`sale_id = ANY(...)`).
//
// Este arquivo prova, sobre constraints e planos reais:
//   1. o recorte por tenant no SQL devolve SOMENTE os itens da empresa;
//   2. um filtro de lista (`= ANY`) usa o ÍNDICE `sale_items_sale_id_idx`
//      (Index Scan, não Seq Scan) — a filtragem por empresa é indexável;
//   3. a integridade relacional se mantém: todo item aponta uma venda real
//      (sem órfão) e `sales.empresa_id` é a única fonte do tenant do item;
//   4. `/commerce/analytics` do tenant A nunca soma produto da empresa B;
//   5. `sale_items` continua SEM coluna `empresa_id` (nada de redundância).
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('Fase 9.1: projeção sale_items recortada por tenant no SQL (PostgreSQL real)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES } = await import('../../src/resources');
  const { getStore } = await import('../../src/services');
  const { itensDaEmpresa, itensDeVendas, idsDeVendasDaEmpresa } = await import('../../src/commerce/projecao');
  const { analyticsCommerce } = await import('../../src/commerce/analytics');

  const sufixo = Date.now().toString(36).toUpperCase();
  const linha = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await query(sql, params)).rows as T[];

  const [empA] = await linha<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`F91 A ${sufixo}`, `F91 A ${sufixo} LTDA`]);
  const [empB] = await linha<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`F91 B ${sufixo}`, `F91 B ${sufixo} LTDA`]);
  const aId = Number(empA.id);
  const bId = Number(empB.id);

  const [usrA] = await linha<{ id: number }>(`INSERT INTO usuarios (nome,email,perfil,ativo,empresa_id) VALUES ($1,$2,'admin',true,$3) RETURNING id`, [`F91 A ${sufixo}`, `f91a-${sufixo}@brobond.test`, aId]);
  const [usrB] = await linha<{ id: number }>(`INSERT INTO usuarios (nome,email,perfil,ativo,empresa_id) VALUES ($1,$2,'admin',true,$3) RETURNING id`, [`F91 B ${sufixo}`, `f91b-${sufixo}@brobond.test`, bId]);

  const [prodA] = await linha<{ id: number }>(`INSERT INTO produtos (sku,nome,preco_venda,empresa_id) VALUES ($1,$2,10,$3) RETURNING id`, [`F91-PA-${sufixo}`, `Produto A ${sufixo}`, aId]);
  const [prodB] = await linha<{ id: number }>(`INSERT INTO produtos (sku,nome,preco_venda,empresa_id) VALUES ($1,$2,10,$3) RETURNING id`, [`F91-PB-${sufixo}`, `Produto B ${sufixo}`, bId]);

  const saleA = `F91A-${sufixo}`;
  const saleB = `F91B-${sufixo}`;
  await linha(
    `INSERT INTO sales (id, reference, amount_cents, status, channel, usuario_id, empresa_id, occurred_at)
     VALUES ($1,$2,1000,'PAID','BROBOND',$3,$4,now())`,
    [saleA, `ref-a-${sufixo}`, usrA.id, aId]
  );
  await linha(
    `INSERT INTO sales (id, reference, amount_cents, status, channel, usuario_id, empresa_id, occurred_at)
     VALUES ($1,$2,900,'PAID','BROBOND',$3,$4,now())`,
    [saleB, `ref-b-${sufixo}`, usrB.id, bId]
  );
  await linha(
    `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_cents, discount_cents, subtotal_cents)
     VALUES ($1,$2,$3,7,100,0,700)`,
    [`F91-IA-${sufixo}`, saleA, prodA.id]
  );
  await linha(
    `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_cents, discount_cents, subtotal_cents)
     VALUES ($1,$2,$3,9,100,0,900)`,
    [`F91-IB-${sufixo}`, saleB, prodB.id]
  );

  try {
    const s = getStore();

    // (1) recorte por tenant no SQL — itensDaEmpresa(A) só devolve o item de A.
    const itensA = await itensDaEmpresa(aId);
    const itensB = await itensDaEmpresa(bId);
    assert.deepEqual(itensA.map((i) => String(i.id)), [`F91-IA-${sufixo}`], 'só o item da empresa A');
    assert.deepEqual(itensB.map((i) => String(i.id)), [`F91-IB-${sufixo}`], 'só o item da empresa B');
    assert.ok(itensA.every((i) => String(i.sale_id) === saleA), 'nenhum item de A aponta venda de B');

    // O Store monta `sale_id = ANY($1)` a partir do filtro de lista: a leitura
    // com o MESMO filtro (via `list`) devolve exatamente o conjunto pedido.
    const viaStore = await s.list(RESOURCES.sale_items, { page: 1, pageSize: 100, filter: { sale_id: [saleA] } });
    assert.ok(viaStore.rows.every((r) => String(r.sale_id) === saleA), 'filtro de lista restringe no banco');
    const idsA = await idsDeVendasDaEmpresa(aId);
    assert.ok(idsA.includes(saleA) && !idsA.includes(saleB), 'ids de vendas recortados pelo tenant');

    // (2) plano de execução: o filtro por tenant (`sale_id = ANY(...)`) é
    // INDEXÁVEL. Numa tabela minúscula o planner prefere Seq Scan, então
    // desligamos `enable_seqscan` LOCALMENTE (numa transação descartável) para
    // provar que o índice `sale_items_sale_id_idx` é o caminho disponível. O
    // node exato (Index Scan vs Bitmap Heap Scan) varia com o tamanho/estatística
    // da tabela; o que importa é que o ÍNDICE seja usado e não haja Seq Scan.
    const { withTransaction } = await import('../../src/db');
    const plano = await withTransaction(async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      const r = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM sale_items WHERE sale_id = ANY($1)`, [[saleA]]);
      return r.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
    }, 'read committed');
    const nodes: Record<string, unknown>[] = [];
    const coletar = (n: Record<string, unknown> | undefined) => {
      if (!n || typeof n !== 'object') return;
      nodes.push(n);
      const filhos = (n.Plans as Record<string, unknown>[] | undefined) ?? [];
      for (const f of filhos) coletar(f);
    };
    coletar(plano);
    assert.ok(nodes.some((n) => n['Index Name'] === 'sale_items_sale_id_idx'), 'usa o índice sale_items_sale_id_idx');
    assert.ok(!nodes.some((n) => n['Node Type'] === 'Seq Scan'), 'não faz Seq Scan na projeção');

    // (3) integridade: nenhum item órfão e o tenant do item é o da venda.
    const orfaos = await linha<{ n: number }>(
      `SELECT count(*)::int AS n FROM sale_items si LEFT JOIN sales s ON s.id = si.sale_id WHERE s.id IS NULL`
    );
    assert.equal(Number(orfaos[0].n), 0, 'nenhum sale_item órfão (FK sale_id)');
    const dono = await linha<{ empresa_id: number }>(`SELECT s.empresa_id FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.id = $1`, [`F91-IA-${sufixo}`]);
    assert.equal(Number(dono[0].empresa_id), aId, 'o tenant do item é o da venda');

    // (4) analytics do tenant A nunca soma o produto da empresa B.
    const saida: any = {};
    const res: any = { json: (d: any) => ((saida.json = d), res), status: () => res };
    const req: any = { query: {}, user: { id: usrA.id, name: 'A', perfil: 'admin', empresa_id: aId, empresas: [aId] } };
    await analyticsCommerce(req, res);
    const idsTop = (saida.json.top_produtos as Array<{ produto_id: number }>).map((p) => p.produto_id);
    assert.ok(idsTop.includes(Number(prodA.id)), 'o produto da empresa A aparece no top');
    assert.ok(!idsTop.includes(Number(prodB.id)), 'o produto da empresa B NUNCA aparece');

    // (5) `sale_items` continua sem `empresa_id` (projeção — sem redundância).
    const colunas = await linha<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sale_items'`
    );
    assert.ok(!colunas.some((c) => c.column_name === 'empresa_id'), 'sale_items não tem empresa_id redundante');
  } finally {
    await query(`DELETE FROM sale_items WHERE id IN ($1,$2)`, [`F91-IA-${sufixo}`, `F91-IB-${sufixo}`]);
    await query(`DELETE FROM sales WHERE id IN ($1,$2)`, [saleA, saleB]);
    await query(`DELETE FROM produtos WHERE id IN ($1,$2)`, [prodA.id, prodB.id]);
    await query(`DELETE FROM usuarios WHERE id IN ($1,$2)`, [usrA.id, usrB.id]);
    await query(`DELETE FROM empresas WHERE id IN ($1,$2)`, [aId, bId]);
  }
});

test('Fase 9.1: paginação da projeção não trunca acima de uma página (PostgreSQL real)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { itensDeVendas, idsDeVendasDaEmpresa, itensDaEmpresa } = await import('../../src/commerce/projecao');

  const sufixo = Date.now().toString(36).toUpperCase();
  const linha = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await query(sql, params)).rows as T[];

  const [emp] = await linha<{ id: number }>(`INSERT INTO empresas (nome, razao_social, ativo) VALUES ($1,$2,true) RETURNING id`, [`F91P ${sufixo}`, `F91P ${sufixo} LTDA`]);
  const empresaId = Number(emp.id);
  const [usr] = await linha<{ id: number }>(`INSERT INTO usuarios (nome,email,perfil,ativo,empresa_id) VALUES ($1,$2,'admin',true,$3) RETURNING id`, [`F91P ${sufixo}`, `f91p-${sufixo}@brobond.test`, empresaId]);

  // Duas vendas da MESMA empresa: uma com 2.500 itens (excede o passo de página
  // de 1.000) e 1.200 vendas com 1 item cada (excede página e o lote de 500 ids).
  const saleGrande = `F91PG-${sufixo}`;
  const prefixoVarias = `F91PV-${sufixo}`;
  const ITENS_GRANDE = 2_500;
  const VENDAS_VARIAS = 1_200;

  await linha(
    `INSERT INTO sales (id, reference, amount_cents, status, channel, usuario_id, empresa_id, occurred_at)
     VALUES ($1,$2,1,'PAID','BROBOND',$3,$4,now())`,
    [saleGrande, `ref-g-${sufixo}`, usr.id, empresaId]
  );
  // Itens da venda grande em um único INSERT (generate_series) — rápido.
  await linha(
    `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_cents, discount_cents, subtotal_cents)
     SELECT 'F91PGI-' || $1 || '-' || lpad(g::text, 6, '0'), $2, NULL, 1, 1, 0, 1
       FROM generate_series(1, $3) AS g`,
    [sufixo, saleGrande, ITENS_GRANDE]
  );
  // Várias vendas (1 item cada) da mesma empresa.
  await linha(
    `INSERT INTO sales (id, reference, amount_cents, status, channel, usuario_id, empresa_id, occurred_at)
     SELECT $1 || '-' || lpad(g::text, 6, '0'), 'ref-v-' || $1 || '-' || g, 1, 'PAID', 'BROBOND', $2, $3, now()
       FROM generate_series(1, $4) AS g`,
    [prefixoVarias, usr.id, empresaId, VENDAS_VARIAS]
  );
  await linha(
    `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price_cents, discount_cents, subtotal_cents)
     SELECT 'F91PVI-' || $1 || '-' || lpad(g::text, 6, '0'), $1 || '-' || lpad(g::text, 6, '0'), NULL, 1, 1, 0, 1
       FROM generate_series(1, $2) AS g`,
    [prefixoVarias, VENDAS_VARIAS]
  );

  try {
    // (1) itens de UMA venda acima do passo de página: todos, sem duplicata.
    const itensGrande = await itensDeVendas([saleGrande]);
    assert.equal(itensGrande.length, ITENS_GRANDE, 'todos os 2.500 itens da venda (nenhuma omissão)');
    assert.equal(new Set(itensGrande.map((i) => String(i.id))).size, ITENS_GRANDE, 'sem duplicata');

    // (2) ids de vendas do tenant acima do passo de página e do lote de ids.
    const ids = (await idsDeVendasDaEmpresa(empresaId)).filter((id) => id.startsWith(prefixoVarias));
    assert.equal(ids.length, VENDAS_VARIAS, 'todas as 1.200 vendas do tenant (nenhuma omissão)');
    assert.equal(new Set(ids).size, VENDAS_VARIAS, 'sem venda duplicada');

    // (3) itens de TODAS as vendas do tenant (cruza 3 lotes de ids) — soma certa.
    const itensEmpresa = await itensDaEmpresa(empresaId);
    const doGrande = itensEmpresa.filter((i) => String(i.sale_id) === saleGrande).length;
    const dasVarias = itensEmpresa.filter((i) => String(i.sale_id).startsWith(prefixoVarias)).length;
    assert.equal(doGrande, ITENS_GRANDE, 'venda grande inteira no recorte do tenant');
    assert.equal(dasVarias, VENDAS_VARIAS, 'todas as vendas pequenas inteiras');
    assert.equal(new Set(itensEmpresa.map((i) => String(i.id))).size, itensEmpresa.length, 'nenhum item duplicado');
  } finally {
    await query(`DELETE FROM sale_items WHERE sale_id = $1 OR sale_id LIKE $2`, [saleGrande, `${prefixoVarias}%`]);
    await query(`DELETE FROM sales WHERE id = $1 OR id LIKE $2`, [saleGrande, `${prefixoVarias}%`]);
    await query(`DELETE FROM usuarios WHERE id = $1`, [usr.id]);
    await query(`DELETE FROM empresas WHERE id = $1`, [empresaId]);
  }
});
