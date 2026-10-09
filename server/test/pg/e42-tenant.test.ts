// ============================================================================
// E4.2 — matriz A → B → A contra PostgreSQL REAL.
//
// Este teste é obrigatório (não tem skip): npm run test:pg/CI precisa fornecer
// DATABASE_URL apontando para PostgreSQL. Ele cobre ownership, links compostos,
// célula sem tamanho concorrente, inventário, estorno, importação, relatórios,
// CSV/XLSX, Woo explicitamente vinculado e locais homônimos/default por tenant.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-e42-tenant.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta matriz.');
}

process.env.NODE_ENV = 'test';

type Actor = {
  id: number;
  name: string;
  email: string;
  perfil: 'admin';
  empresa_id: number;
  empresas: number[];
};

type Captured = { json?: any; output?: Buffer | string; headers: Record<string, string>; status?: number };

function req(actor: Actor, options: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: Record<string, unknown> } = {}): any {
  return {
    user: actor,
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function response(): { res: any; out: Captured } {
  const out: Captured = { headers: {} };
  const res: any = {
    json: (body: unknown) => { out.json = body; return res; },
    status: (code: number) => { out.status = code; return res; },
    setHeader: (key: string, value: string) => { out.headers[key.toLowerCase()] = value; return res; },
    end: (chunk?: Buffer | string) => { out.output = chunk; return res; },
  };
  return { res, out };
}

async function call(handler: (req: any, res: any, ...args: any[]) => Promise<unknown>, request: any, ...args: any[]): Promise<Captured> {
  const { res, out } = response();
  await handler(request, res, ...args);
  return out;
}

async function expect404(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error: any) {
    assert.equal(error?.status, 404, `esperava 404, veio ${error?.status}: ${error?.message}`);
    const mensagem = String(error?.message || '').toLowerCase();
    assert.ok(!mensagem.includes('empresa'), 'a resposta não pode confirmar a empresa-alvo');
    return error;
  }
  assert.fail('esperava 404 e a operação foi aceita');
}

async function total(query: (sql: string, params?: unknown[]) => Promise<any>, sql: string, params: unknown[] = []): Promise<number> {
  const result = await query(sql, params);
  return Number(result.rows[0].n);
}

test('E4.2: referências cruzadas A → B → A não leem, escrevem, ajustam saldo nem exportam dados', async () => {
  const { migrate, query, pool } = await import('../../src/db');
  await migrate();
  assert.ok(pool, 'o teste deve estar conectado a um PostgreSQL real');

  // Simula upgrade a partir de uma instalação anterior à coluna de vínculo do
  // PDV: o preflight precisa rodar sem referenciar a coluna ainda inexistente,
  // recriá-la e preservar NULL em registros antigos (sem backfill por nome).
  const migration0030 = await readFile(new URL('../../../db/migrations/0030_e42_locais_estoque_multempresa.sql', import.meta.url), 'utf8');
  const caixaLegada = `E42-LEGACY-${Date.now()}-${process.pid}`;
  await query('ALTER TABLE pdv_caixas DROP COLUMN local_id CASCADE');
  await query(
    `INSERT INTO pdv_caixas (empresa_id, numero, local, valor_abertura, status) VALUES (1, $1, 'local legado sem vínculo', 0, 'aberto')`,
    [caixaLegada]
  );
  await query(migration0030);
  const caixaAtualizada = await query('SELECT local_id FROM pdv_caixas WHERE numero = $1', [caixaLegada]);
  assert.equal(caixaAtualizada.rows[0]?.local_id, null, 'a migration não pode inferir vínculo para uma caixa histórica');
  await query('DELETE FROM pdv_caixas WHERE numero = $1', [caixaLegada]);

  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, getRecord, getStore, listRecords, getDefaultLocalInfo, escopoDe } = await import('../../src/services');
  const { estoqueGrade, estornarMovimentacao, fecharInventario, getInventarioDetalhe, listItensInventario, updateItensInventario } = await import('../../src/estoque');
  const { produtoTamanhos, productDetail } = await import('../../src/detail');
  const { exportarRecurso } = await import('../../src/export');
  const { relatorio } = await import('../../src/relatorios');
  const { previewImportacao, confirmarImportacao, modeloImportacao } = await import('../../src/importacao');
  const { statusLoja, produtosLoja, importarPedidosLoja, sincronizarEstoqueLoja } = await import('../../src/loja');

  const sufixo = `${Date.now()}-${process.pid}`;
  const adminBase = { id: 0, name: 'Admin E4.2', perfil: 'admin' as const };
  const empresaA = Number((await createRecord(RESOURCES.empresas, { nome: `E42 A ${sufixo}` }, adminBase)).id);
  const empresaB = Number((await createRecord(RESOURCES.empresas, { nome: `E42 B ${sufixo}` }, adminBase)).id);
  const A: Actor = { id: 0, name: 'Ator A E4.2', email: 'e42-a@example.test', perfil: 'admin', empresa_id: empresaA, empresas: [empresaA] };
  const B: Actor = { id: 0, name: 'Ator B E4.2', email: 'e42-b@example.test', perfil: 'admin', empresa_id: empresaB, empresas: [empresaB] };
  const s = getStore();

  const nomeLocal = `E42 Homônimo ${sufixo}`;
  const localA = await createRecord(RESOURCES.locais, { nome: nomeLocal, ativo: true, padrao: true }, A);
  const localB = await createRecord(RESOURCES.locais, { nome: nomeLocal, ativo: true, padrao: true }, B);
  const localAId = Number(localA.id);
  const localBId = Number(localB.id);
  assert.notEqual(localAId, localBId);
  assert.equal(Number(localA.empresa_id), empresaA);
  assert.equal(Number(localB.empresa_id), empresaB);
  assert.equal((await getDefaultLocalInfo(undefined, escopoDe(A)))?.id, localAId);
  assert.equal((await getDefaultLocalInfo(undefined, escopoDe(B)))?.id, localBId);
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM locais WHERE nome = $1 AND empresa_id = ANY($2::int[])', [nomeLocal, [empresaA, empresaB]]), 2);

  const produtoA = await createRecord(RESOURCES.produtos, { sku: `E42-A-${sufixo}`, nome: `Produto confidencial A ${sufixo}`, custo: 10, preco_venda: 20 }, A);
  const produtoB = await createRecord(RESOURCES.produtos, { sku: `E42-B-${sufixo}`, nome: `Produto confidencial B ${sufixo}`, custo: 15, preco_venda: 30 }, B);
  const produtoAId = Number(produtoA.id);
  const produtoBId = Number(produtoB.id);

  // Tamanho ausente é NULL: as entradas concorrentes precisam convergir em uma
  // célula (empresa, produto, local_id), sem deixar duas linhas.
  const movA1 = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, local_id: localAId, quantidade: 5 }, A);
  const movA2 = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, local_id: localAId, quantidade: 2 }, A);
  const movB = await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoBId, tamanho_id: null, local_id: localBId, quantidade: 8 }, B);
  const [entradaConcorrente1, entradaConcorrente2] = await Promise.all([
    s.adjustStock(produtoAId, null, nomeLocal, 1, undefined, localAId, empresaA),
    s.adjustStock(produtoAId, null, nomeLocal, 2, undefined, localAId, empresaA),
  ]);
  assert.equal(Number(entradaConcorrente1.id), Number(entradaConcorrente2.id), 'upsert concorrente sem tamanho precisa atingir a mesma linha');

  const saldoA = async () => s.findOneWhere(RESOURCES.estoques, { empresa_id: empresaA, produto_id: produtoAId, tamanho_id: null, local_id: localAId });
  const saldoB = async () => s.findOneWhere(RESOURCES.estoques, { empresa_id: empresaB, produto_id: produtoBId, tamanho_id: null, local_id: localBId });
  const saldoInicialA = await saldoA();
  const saldoInicialB = await saldoB();
  assert.equal(Number(saldoInicialA?.quantidade), 10);
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM estoques WHERE empresa_id=$1 AND produto_id=$2 AND tamanho_id IS NULL AND local_id=$3', [empresaA, produtoAId, localAId]), 1);
  assert.equal(Number(saldoInicialB?.quantidade), 8);

  // Saídas concorrentes sem tamanho também disputam a mesma célula: só uma
  // retirada de quatro peças pode passar quando o saldo é cinco.
  const produtoCorrida = await createRecord(RESOURCES.produtos, { sku: `E42-RACE-${sufixo}`, nome: `Produto corrida E42 ${sufixo}` }, A);
  const produtoCorridaId = Number(produtoCorrida.id);
  await s.adjustStock(produtoCorridaId, null, nomeLocal, 5, undefined, localAId, empresaA);
  const [retiradaCorrida1, retiradaCorrida2] = await Promise.all([
    s.tryAdjustStock(produtoCorridaId, null, nomeLocal, -4, undefined, 0, localAId, empresaA),
    s.tryAdjustStock(produtoCorridaId, null, nomeLocal, -4, undefined, 0, localAId, empresaA),
  ]);
  assert.equal([retiradaCorrida1, retiradaCorrida2].filter(Boolean).length, 1, 'apenas uma saída concorrente deve consumir saldo disponível');
  assert.equal(Number((await s.findOneWhere(RESOURCES.estoques, { empresa_id: empresaA, produto_id: produtoCorridaId, tamanho_id: null, local_id: localAId }))?.quantidade), 1);
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM estoques WHERE empresa_id=$1 AND produto_id=$2 AND tamanho_id IS NULL AND local_id=$3', [empresaA, produtoCorridaId, localAId]), 1);

  // A vê sua própria linha e B ainda pode acessar a dele.
  assert.equal(Number((await getRecord(RESOURCES.estoques, Number(saldoInicialA!.id), A)).empresa_id), empresaA);
  assert.equal(Number((await getRecord(RESOURCES.movimentacoes, Number(movB.id), B)).empresa_id), empresaB);

  const movCountA = await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]);
  const saldoAntesAtaquesA = Number((await saldoA())?.quantidade);
  const saldoAntesAtaquesB = Number((await saldoB())?.quantidade);
  await expect404(() => getRecord(RESOURCES.produtos, produtoBId, A));
  await expect404(() => produtoTamanhos(req(A, { params: { id: String(produtoBId) } }), response().res));
  await expect404(() => productDetail(req(A, { params: { id: String(produtoBId) } }), response().res));
  const tamanhosA = await call(produtoTamanhos, req(A, { params: { id: String(produtoAId) } }));
  assert.ok(Array.isArray(tamanhosA.json.tamanhos));
  const detalheA = await call(productDetail, req(A, { params: { id: String(produtoAId) } }));
  assert.equal(Number(detalheA.json.produto.id), produtoAId);
  assert.ok(detalheA.json.movimentacoes.every((mov: any) => Number(mov.empresa_id) === empresaA));
  await expect404(() => getRecord(RESOURCES.locais, localBId, A));
  await expect404(() => getRecord(RESOURCES.estoques, Number(saldoInicialB!.id), A));
  await expect404(() => getRecord(RESOURCES.movimentacoes, Number(movB.id), A));

  // A não consegue lançar em local B, apontar para produto B nem combinar os
  // dois. O rollback deve preservar saldos, linhas de movimentação e auditoria.
  await expect404(() => createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoAId, tamanho_id: null, local_id: localBId, quantidade: 99 }, A));
  await expect404(() => createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoBId, tamanho_id: null, local_id: localAId, quantidade: 99 }, A));
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]), movCountA);
  assert.equal(Number((await saldoA())?.quantidade), saldoAntesAtaquesA);
  assert.equal(Number((await saldoB())?.quantidade), saldoAntesAtaquesB);

  // O banco também barra vínculos compostos cruzados, mesmo sem passar pela API.
  await assert.rejects(
    () => query('INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade) VALUES ($1,$2,NULL,$3,$4,99)', [empresaA, produtoAId, nomeLocal, localBId]),
    (error: any) => error.code === '23503'
  );
  await assert.rejects(
    () => query('INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, local, local_id, quantidade) VALUES ($1,\'entrada\',$2,NULL,$3,$4,1)', [empresaA, produtoAId, nomeLocal, localBId]),
    (error: any) => error.code === '23503'
  );
  assert.equal(Number((await saldoA())?.quantidade), saldoAntesAtaquesA, 'INSERT recusado não pode alterar saldo');

  // Estorno: B não pode estornar uma movimentação de A; A segue operando a sua.
  const movCountBeforeEstorno = await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1', [empresaA]);
  await expect404(() => estornarMovimentacao(req(B, { params: { id: String(movA2.id) } }), response().res));
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1', [empresaA]), movCountBeforeEstorno);
  assert.equal(Number((await saldoA())?.quantidade), saldoAntesAtaquesA);
  const estornoA = await call(estornarMovimentacao, req(A, { params: { id: String(movA2.id) } }));
  assert.equal(estornoA.json.ok, true);
  assert.equal(Number((await saldoA())?.quantidade), 8);

  // Grade: recorte de dados e filtro de local são tenantados. O B volta a ler o
  // próprio saldo; A não recebe SKU, nome nem totais de B.
  const gradeA = await call(estoqueGrade, req(A));
  assert.ok(gradeA.json.linhas.some((linha: any) => Number(linha.produto.id) === produtoAId));
  assert.ok(gradeA.json.linhas.every((linha: any) => Number(linha.produto.id) !== produtoBId));
  const linhaGradeA = gradeA.json.linhas.find((linha: any) => Number(linha.produto.id) === produtoAId);
  assert.equal(Number(linhaGradeA.total), 8);
  assert.ok(linhaGradeA.celulas.some((celula: any) => Number(celula.tamanho_id) === 0 && Number(celula.quantidade) === 8));
  assert.ok(!JSON.stringify(gradeA.json).includes(String(produtoB.sku)));
  assert.ok(!JSON.stringify(gradeA.json).includes(String(produtoB.nome)));
  await expect404(() => estoqueGrade(req(A, { query: { local_id: String(localBId) } }), response().res));
  const gradeB = await call(estoqueGrade, req(B));
  assert.ok(gradeB.json.linhas.some((linha: any) => Number(linha.produto.id) === produtoBId));
  assert.ok(gradeB.json.linhas.every((linha: any) => Number(linha.produto.id) !== produtoAId));

  // Inventário: snapshot, itens, contagem e fechamento são todos recortados por
  // empresa. O ID de produto B não pode ser incluído no inventário A.
  const inventarioA = await createRecord(RESOURCES.inventarios, { local: nomeLocal, local_id: localAId, observacoes: 'E4.2 A' }, A);
  const inventarioB = await createRecord(RESOURCES.inventarios, { local: nomeLocal, local_id: localBId, observacoes: 'E4.2 B' }, B);
  const inventarioAId = Number(inventarioA.id);
  const inventarioBId = Number(inventarioB.id);
  const itensA = await call(listItensInventario, req(A, { params: { id: String(inventarioAId) } }));
  const itemA = itensA.json.find((item: any) => Number(item.produto_id) === produtoAId);
  assert.ok(itemA, 'snapshot A contém o saldo A');
  assert.ok(itensA.json.every((item: any) => Number(item.empresa_id) === empresaA));
  const itensB = await call(listItensInventario, req(B, { params: { id: String(inventarioBId) } }));
  assert.ok(itensB.json.some((item: any) => Number(item.produto_id) === produtoBId));
  await expect404(() => getInventarioDetalhe(req(B, { params: { id: String(inventarioAId) } }), response().res));
  await expect404(() => listItensInventario(req(B, { params: { id: String(inventarioAId) } }), response().res));
  await expect404(() => updateItensInventario(req(B, { params: { id: String(inventarioAId) }, body: { itens: [{ id: itemA.id, contado: 0 }] } }), response().res));
  await expect404(() => fecharInventario(req(B, { params: { id: String(inventarioAId) } }), response().res));
  await expect404(() => updateItensInventario(req(A, { params: { id: String(inventarioAId) }, body: { itens: [{ produto_id: produtoBId, tamanho_id: null, contado: 123 }] } }), response().res));
  await expect404(() => updateItensInventario(req(A, { params: { id: String(inventarioBId) }, body: { itens: [{ id: itensB.json[0].id, contado: 0 }] } }), response().res));
  await expect404(() => fecharInventario(req(A, { params: { id: String(inventarioBId) } }), response().res));
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM itens_inventario WHERE inventario_id=$1', [inventarioAId]), itensA.json.length, 'contagem cruzada não cria linha');

  // FK composta inventário→local e item→produto também são aplicadas pelo banco.
  await assert.rejects(
    () => query('INSERT INTO inventarios (empresa_id, local, local_id, status) VALUES ($1,$2,$3,\'aberto\')', [empresaA, nomeLocal, localBId]),
    (error: any) => error.code === '23503'
  );
  await assert.rejects(
    () => query('INSERT INTO itens_inventario (empresa_id, inventario_id, produto_id, tamanho_id, saldo_sistema) VALUES ($1,$2,$3,NULL,0)', [empresaA, inventarioAId, produtoBId]),
    (error: any) => error.code === '23503'
  );
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM itens_inventario WHERE inventario_id=$1', [inventarioAId]), itensA.json.length);

  // O dono pode atualizar, fechar e consultar A; a tentativa anterior não
  // alterou a linha ou o estoque de B. O item de inventário é o produto A.
  await call(updateItensInventario, req(A, { params: { id: String(inventarioAId) }, body: { itens: [{ id: itemA.id, contado: 7 }] } }));
  const fechamento = await call(fecharInventario, req(A, { params: { id: String(inventarioAId) } }));
  assert.equal(fechamento.json.ok, true);
  assert.equal(Number((await saldoA())?.quantidade), 7);
  assert.equal(Number((await saldoB())?.quantidade), 8);
  const detalheInventarioA = await call(getInventarioDetalhe, req(A, { params: { id: String(inventarioAId) } }));
  assert.equal(Number(detalheInventarioA.json.id), inventarioAId);
  assert.equal(Number(detalheInventarioA.json.resumo.totalContado), 8, 'a linha não contada conserva o saldo congelado do produto de concorrência');
  await expect404(() => getInventarioDetalhe(req(A, { params: { id: String(inventarioBId) } }), response().res));
  assert.equal(String((await s.findOneWhere(RESOURCES.inventarios, { id: inventarioAId, empresa_id: empresaA }))?.status), 'fechado');
  assert.equal(String((await s.findOneWhere(RESOURCES.inventarios, { id: inventarioBId, empresa_id: empresaB }))?.status), 'aberto');

  // Movimentações manuais de insumos validam a referência do insumo no tenant.
  const insumoA = await createRecord(RESOURCES.insumos, { nome: `Insumo A ${sufixo}`, unidade: 'm' }, A);
  const insumoB = await createRecord(RESOURCES.insumos, { nome: `Insumo B ${sufixo}`, unidade: 'm' }, B);
  const movInsumoB = await createRecord(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(insumoB.id), quantidade: 3 }, B);
  const movInsumosBefore = await total(query, 'SELECT count(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1', [empresaA]);
  await expect404(() => createRecord(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(insumoB.id), quantidade: 999 }, A));
  await expect404(() => getRecord(RESOURCES.movimentacoes_insumos, Number(movInsumoB.id), A));
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM movimentacoes_insumos WHERE empresa_id=$1', [empresaA]), movInsumosBefore);
  const saldoInsumoB = await s.findOneWhere(RESOURCES.estoque_insumos, { empresa_id: empresaB, insumo_id: Number(insumoB.id) });
  assert.equal(Number(saldoInsumoB?.quantidade), 3);
  assert.equal(Number((await s.insumoStock(Number(insumoA.id), undefined, empresaA))), 0);

  // Importação: preview busca SKU/local apenas dentro da empresa. Confirmação
  // forjada com IDs de B recebe 404 e a transação não grava linhas/saldos.
  const preview = await call(previewImportacao, req(A, { body: { tipo: 'estoque', nome: 'e42.csv', conteudo: `produto;tamanho;local;quantidade\n${String(produtoB.sku)};;${nomeLocal};99` } }));
  assert.equal(preview.json.validas, 0);
  assert.ok(preview.json.erros.length > 0);
  const stockCountBeforeImport = await total(query, 'SELECT count(*)::int AS n FROM estoques WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]);
  const movCountBeforeImport = await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]);
  await expect404(() => confirmarImportacao(req(A, { body: { tipo: 'estoque', linhas: [{ produto_id: produtoBId, tamanho_id: null, local: nomeLocal, local_id: localBId, quantidade: 99 }] } }), response().res));
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM estoques WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]), stockCountBeforeImport);
  assert.equal(await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]), movCountBeforeImport);
  const modelo = await call(modeloImportacao, req(B, { query: { tipo: 'estoque' } }));
  assert.match(String(modelo.output), /produto;tamanho;local;quantidade/);

  // Relatórios e exports: JSON, CSV e XLSX da A não contêm SKU, produto, saldo,
  // local ou movimentos privados de B; a exportação de B continua íntegra.
  const estoqueJson = await call(relatorio, req(A, { query: { grupo: 'produto' } }), 'estoque-posicao');
  assert.ok(estoqueJson.json.linhas.some((linha: any) => linha.produto.includes(String(produtoA.sku))));
  assert.ok(!JSON.stringify(estoqueJson.json).includes(String(produtoB.sku)));
  const estoqueCsv = await call(relatorio, req(A, { query: { grupo: 'produto', format: 'csv' } }), 'estoque-posicao');
  const csvText = Buffer.isBuffer(estoqueCsv.output) ? estoqueCsv.output.toString('utf8') : String(estoqueCsv.output || '');
  assert.ok(csvText.includes(String(produtoA.sku)));
  assert.ok(!csvText.includes(String(produtoB.sku)));
  const estoqueXlsx = await call(relatorio, req(A, { query: { grupo: 'produto', format: 'xlsx' } }), 'estoque-posicao');
  assert.ok(Buffer.isBuffer(estoqueXlsx.output));
  const wbReport = new ExcelJS.Workbook();
  await wbReport.xlsx.load(estoqueXlsx.output as any);
  const reportText = JSON.stringify(wbReport.worksheets[0].getSheetValues());
  assert.ok(reportText.includes(String(produtoA.sku)));
  assert.ok(!reportText.includes(String(produtoB.sku)));

  const jsonRowsA = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 100, filter: { empresa_id: empresaB } }, A);
  assert.ok(jsonRowsA.rows.every((row) => Number(row.empresa_id) === empresaA));
  assert.ok(jsonRowsA.rows.every((row) => Number(row.produto_id) !== produtoBId));
  for (const format of ['csv', 'xlsx']) {
    const exported = await call(exportarRecurso, req(A, { query: { format, 'f.empresa_id': String(empresaB) } }), 'estoques');
    assert.ok(exported.output);
    let texto: string;
    if (format === 'csv') texto = Buffer.isBuffer(exported.output) ? exported.output.toString('utf8') : String(exported.output);
    else {
      assert.ok(Buffer.isBuffer(exported.output));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(exported.output as any);
      texto = JSON.stringify(wb.worksheets[0].getSheetValues());
    }
    assert.ok(texto.includes(String(produtoA.sku)));
    assert.ok(!texto.includes(String(produtoB.sku)));
  }
  await expect404(() => relatorio(req(A, { query: { local_id: String(localBId), format: 'csv' } }), response().res, 'estoque-posicao'));

  const reportMovA = await call(relatorio, req(A, { query: { format: 'json' } }), 'movimentacoes-periodo');
  assert.ok(!JSON.stringify(reportMovA.json).includes(String(produtoB.sku)));

  // WooCommerce não pode atuar sem tenant explícito; com vínculo A, B recebe
  // 404 (sem nome/ID de A) antes de qualquer chamada externa ou escrita.
  const envKeys = ['WOOCOMMERCE_EMPRESA_ID', 'WOOCOMMERCE_URL', 'WOOCOMMERCE_CK', 'WOOCOMMERCE_CS'] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.WOOCOMMERCE_EMPRESA_ID = String(empresaA);
    delete process.env.WOOCOMMERCE_URL;
    delete process.env.WOOCOMMERCE_CK;
    delete process.env.WOOCOMMERCE_CS;
    await expect404(() => statusLoja(req(B), response().res));
    await expect404(() => produtosLoja(req(B), response().res));
    await expect404(() => importarPedidosLoja(req(B), response().res));
    await expect404(() => sincronizarEstoqueLoja(req(B), response().res));
    assert.equal((await call(statusLoja, req(A))).json.configurado, false);
    const produtosWooA = await call(produtosLoja, req(A));
    assert.ok(produtosWooA.json.produtos.every((item: any) => item.sku !== String(produtoB.sku)));
    await assert.rejects(() => importarPedidosLoja(req(A), response().res), (error: any) => error.status === 409);
    await assert.rejects(() => sincronizarEstoqueLoja(req(A), response().res), (error: any) => error.status === 409);
    delete process.env.WOOCOMMERCE_EMPRESA_ID;
    await assert.rejects(() => statusLoja(req(A), response().res), (error: any) => error.status === 409);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // B continua enxergando seus próprios dados depois de todos os ataques; A
  // volta ao final e ainda enxerga os seus. Nenhuma resposta/arquivo acima
  // confirmou que o ID estrangeiro existia ou revelou empresa_id de destino.
  assert.equal(Number((await getRecord(RESOURCES.produtos, produtoBId, B)).id), produtoBId);
  assert.equal(Number((await getRecord(RESOURCES.movimentacoes, Number(movB.id), B)).empresa_id), empresaB);
  assert.equal(Number((await saldoB())?.quantidade), 8);
  assert.equal(Number((await getRecord(RESOURCES.produtos, produtoAId, A)).id), produtoAId);
  assert.equal(Number((await saldoA())?.quantidade), 7);
  const finalMovA = await total(query, 'SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id=$1 AND produto_id=$2', [empresaA, produtoAId]);
  assert.equal(finalMovA, movCountA + 2, 'estorno e fechamento próprios acrescentam uma linha cada; tentativas cruzadas não escrevem');
});
