// ============================================================================
// ERP-03 — A/B DE MULTIEMPRESA em PostgreSQL real (fecha o risco R6).
//
// O R6 do relatório: "índice legado UNIQUE(produto_id, tamanho_id, local) sem
// empresa_id" com o teste A/B **NÃO TESTADO**. A pergunta é direta: duas
// empresas podem ter o MESMO SKU e o MESMO nome de local, e cada uma enxerga só
// o que é dela?
//
// A resposta agora é executável — e ela mudou neste ciclo. A declaração do
// recurso dizia `unique: true` em `produtos.sku`/`produtos.codigo_barras`
// enquanto o banco sempre teve índice POR EMPRESA (`uq_produtos_sku_empresa`,
// `uq_produtos_codigo_barras_empresa`): em PostgreSQL os dois SKUs coexistiam,
// mas o modo memória recusava o segundo. O contrato de tipos
// (`contrato-tipo-coluna.test.ts`) pegou a divergência; aqui está a prova de que
// memória e PostgreSQL passaram a responder a MESMA coisa.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente'; empresa_id: number; empresas: number[] };

test('ERP-03 A/B: mesmo SKU e mesmo nome de local em duas empresas (PostgreSQL)', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, listRecords, getStore, escopoDe } = await import('../../src/services');
  const { getDefaultLocalInfo } = await import('../../src/services');

  const admin = { id: 1, name: 'Admin A/B', perfil: 'admin' as const };
  const empA = await createRecord(RESOURCES.empresas, { nome: `AB A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `AB B ${sufixo}` }, admin);
  const aId = Number(empA.id);
  const bId = Number(empB.id);
  const atorA: Ator = { id: 0, name: 'Ana A/B', perfil: 'gerente', empresa_id: aId, empresas: [aId] };
  const atorB: Ator = { id: 0, name: 'Bruno A/B', perfil: 'gerente', empresa_id: bId, empresas: [bId] };

  await t.test('o MESMO nome de local existe nas duas empresas e o padrão não vaza', async () => {
    const nomeLocal = `loja-ab-${sufixo}`; // MESMO nome nas duas empresas
    const localA = await createRecord(RESOURCES.locais, { nome: nomeLocal, tipo: 'loja', ativo: true, padrao: true }, atorA);
    const localB = await createRecord(RESOURCES.locais, { nome: nomeLocal, tipo: 'loja', ativo: true, padrao: true }, atorB);
    assert.equal(String(localA.nome), String(localB.nome));
    assert.notEqual(Number(localA.id), Number(localB.id));
    assert.equal(Number(localA.empresa_id), aId);
    assert.equal(Number(localB.empresa_id), bId);

    // O local padrão é POR EMPRESA: cada escopo resolve o seu, nunca o do outro.
    const infoA = await getDefaultLocalInfo(undefined, escopoDe(atorA as any));
    const infoB = await getDefaultLocalInfo(undefined, escopoDe(atorB as any));
    assert.equal(infoA?.id, Number(localA.id), 'a empresa A resolve o local DELA');
    assert.equal(infoB?.id, Number(localB.id), 'a empresa B resolve o local DELA');

    // A listagem por nome dentro do escopo devolve um só — o da empresa.
    const listados = await listRecords(RESOURCES.locais, { page: 1, pageSize: 50, filter: { nome: nomeLocal } }, atorA);
    assert.equal(listados.total, 1, 'o nome igual não soma listagens entre empresas');
    assert.equal(Number(listados.rows[0].id), Number(localA.id));

    // Um segundo local marcado como padrão assume; a empresa A continua com UM padrão.
    const outroA = await createRecord(RESOURCES.locais, { nome: `expedicao-ab-${sufixo}`, tipo: 'expedicao', ativo: true, padrao: true }, atorA);
    const padroesA = await query<{ count: string }>(`SELECT count(*) FROM locais WHERE empresa_id = $1 AND padrao IS TRUE`, [aId]);
    assert.equal(Number(padroesA.rows[0].count), 1, 'só um padrão por empresa (índice parcial uq_e42_locais_padrao_empresa)');
    const agorA = await getDefaultLocalInfo(undefined, escopoDe(atorA as any));
    assert.equal(agorA?.id, Number(outroA.id));
    const agorB = await getDefaultLocalInfo(undefined, escopoDe(atorB as any));
    assert.equal(agorB?.id, Number(localB.id), 'trocar o padrão em A não mexe no padrão de B');
  });

  await t.test('o MESMO SKU existe nas duas empresas; repetir na MESMA empresa é 409', async () => {
    const sku = `AB-${sufixo}`;
    const pa = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta A', preco_venda: 10 }, atorA);
    const pb = await createRecord(RESOURCES.produtos, { sku, nome: 'Camiseta B', preco_venda: 20 }, atorB);
    assert.equal(Number(pa.empresa_id), aId);
    assert.equal(Number(pb.empresa_id), bId);

    await assert.rejects(
      () => createRecord(RESOURCES.produtos, { sku, nome: 'Duplicata A', preco_venda: 10 }, atorA),
      (e: any) => e.status === 409,
      'SKU repetido dentro da empresa continua proibido',
    );

    // Código de barras: o índice é PARCIAL e por empresa (WHERE codigo_barras <> '').
    const ean = '7891234567895';
    const ca = await createRecord(RESOURCES.produtos, { sku: `AB-EAN-A-${sufixo}`, nome: 'Com EAN A', preco_venda: 10, codigo_barras: ean }, atorA);
    const cb = await createRecord(RESOURCES.produtos, { sku: `AB-EAN-B-${sufixo}`, nome: 'Com EAN B', preco_venda: 10, codigo_barras: ean }, atorB);
    assert.equal(String(ca.codigo_barras), ean);
    assert.equal(String(cb.codigo_barras), ean);
    await assert.rejects(
      () => createRecord(RESOURCES.produtos, { sku: `AB-EAN-A2-${sufixo}`, nome: 'EAN repetido', preco_venda: 10, codigo_barras: ean }, atorA),
      (e: any) => e.status === 409,
    );
  });

  await t.test('o saldo de estoque do MESMO nome de local não atravessa a empresa', async () => {
    const { RESOURCES: R } = await import('../../src/resources');
    const nomeLocal = `loja-saldo-${sufixo}`;
    const localA = await createRecord(R.locais, { nome: nomeLocal, tipo: 'loja', ativo: true, padrao: true }, atorA);
    const localB = await createRecord(R.locais, { nome: nomeLocal, tipo: 'loja', ativo: true, padrao: true }, atorB);
    const sku = `AB-SALDO-${sufixo}`;
    const pa = await createRecord(R.produtos, { sku, nome: 'Saldo A', preco_venda: 10 }, atorA);
    const pb = await createRecord(R.produtos, { sku, nome: 'Saldo B', preco_venda: 10 }, atorB);

    const s = getStore();
    await s.adjustStock(Number(pa.id), null, nomeLocal, 7, undefined, Number(localA.id), aId);
    await s.adjustStock(Number(pb.id), null, nomeLocal, 3, undefined, Number(localB.id), bId);

    const saldos = await query<{ empresa_id: number; quantidade: string }>(
      `SELECT empresa_id, quantidade FROM estoques WHERE local_id IN ($1, $2) ORDER BY empresa_id`,
      [Number(localA.id), Number(localB.id)],
    );
    assert.deepEqual(
      saldos.rows.map((r) => [Number(r.empresa_id), Number(r.quantidade)]),
      [[aId, 7], [bId, 3]],
      'cada empresa ficou com o próprio saldo, no local de mesmo nome',
    );

    // A API do PDV/estoque lista por escopo: A não enxerga o saldo de B.
    const doA = await listRecords(R.estoques, { page: 1, pageSize: 200, filter: { local_id: Number(localA.id) } }, atorA);
    assert.ok(doA.rows.every((r: any) => Number(r.empresa_id) === aId));
    assert.ok(!doA.rows.some((r: any) => Number(r.produto_id) === Number(pb.id)), 'o produto da outra empresa nunca aparece');
  });
});
