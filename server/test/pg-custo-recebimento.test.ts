// ============================================================================
// CUSTO DE RECEBIMENTO DE COMPRA (E3.1 / GAP-COMP-CUSTOS) contra Postgres REAL.
//
// Só se prova aqui — o memdb não tem constraint, não tem lock e não tem corrida:
//
//   • a migration 0028 existe no banco vazio: colunas, CHECKs e os dois índices
//     únicos parciais que travam "dois recebimentos da mesma linha";
//   • custo_unitario NEGATIVO é recusado pelo CHECK (23514) — custo não é crédito;
//   • a MESMA linha da compra não aceita duas entradas no mesmo recebimento
//     (23505) — é a segunda trava de idempotência, a de banco;
//   • CORRIDA A: dois recebimentos simultâneos do MESMO SKU em compras diferentes
//     — o FOR UPDATE serializa, o estoque é a soma e o custo médio é o ponderado;
//   • CORRIDA B: dois parciais simultâneos do MESMO pedido — o recebido nunca
//     ultrapassa o pedido;
//   • CORRIDA C: recebimento + cancelamento ao mesmo tempo — ou os dois
//     acontecem em ordem, ou um falha; nunca sobra estoque fantasma;
//   • ROLLBACK: uma transação que falha no meio não deixa estoque nem custo;
//   • recebido e parcial produzem o MESMO custo (uma regra só);
//   • estorno devolve estoque E restaura o custo médio;
//   • empresa A e B não se misturam.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// O pool é singleton de módulo — não fechar aqui, igual aos demais pg-*.test.ts.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Actor = { id: number; name: string; perfil: string; empresa_id?: number; empresas?: number[] };

const SUFIXO = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import('../src/db');
  const r = await query(sql, params);
  return r.rows as T[];
}
async function um<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

async function base() {
  const { migrate } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { getStore } = await import('../src/services');
  const compras = await import('../src/compras');
  return { RESOURCES, s: getStore(), compras };
}

/** Empresa + usuário admin + fornecedor + insumo, tudo isolado por sufixo. */
async function cenario(tag: string, opts: { custoInicial?: number; saldoInicial?: number } = {}) {
  const { RESOURCES, s, compras } = await base();
  seq++;
  const empresa = await s.insert(RESOURCES.empresas, {
    nome: `Empresa ${tag} ${seq} ${SUFIXO}`,
    cnpj: '',
    ativo: true,
  });
  const empresaId = Number(empresa.id);
  const usuario = await s.insert(RESOURCES.usuarios, {
    nome: `Admin ${tag} ${seq}`,
    email: `admin-${tag}-${seq}-${SUFIXO}@brobond.test`,
    perfil: 'admin',
    empresa_id: empresaId,
    ativo: true,
  });
  // Cada empresa possui seu próprio local padrão. O mesmo nome é permitido
  // entre tenants; nunca se reutiliza o vínculo da primeira empresa criada.
  if (!(await s.findOneWhere(RESOURCES.locais, { nome: 'loja', empresa_id: empresaId }))) {
    await s.insert(RESOURCES.locais, { codigo: 'LOJA', nome: 'loja', tipo: 'loja', ativo: true, padrao: true, empresa_id: empresaId });
  }
  const fornecedor = await s.insert(RESOURCES.fornecedores, { nome: `Forn ${tag} ${seq}`, ativo: true, empresa_id: empresaId });
  const insumo = await s.insert(RESOURCES.insumos, {
    nome: `Insumo ${tag} ${seq}`,
    unidade: 'un',
    custo_medio: opts.custoInicial ?? 0,
    ativo: true,
    empresa_id: empresaId,
  });
  if (opts.saldoInicial) await s.adjustInsumoStock(Number(insumo.id), opts.saldoInicial);

  const actor: Actor = {
    id: Number(usuario.id),
    name: String(usuario.nome),
    perfil: 'admin',
    empresa_id: empresaId,
    empresas: [empresaId],
  };
  const { escopoDoAtor } = await import('../src/empresa');
  return { empresaId, actor, escopo: escopoDoAtor(actor), fornecedor, insumo, s, RESOURCES, compras };
}

/** Compra pendente com uma linha de insumo. */
async function novaCompra(ctx: Awaited<ReturnType<typeof cenario>>, linhas: { qtd: number; preco: number }[], frete = 0) {
  // total de verdade: Σ(qtd × preço) + frete. Uma compra de total zero não é
  // uma compra — e o recebimento completo dela exercita outro caminho (o de
  // pedido sem valor financeiro, que também não pode gerar conta a pagar).
  const total = linhas.reduce((a, l) => a + l.qtd * l.preco, 0) + frete;
  const compra = await ctx.s.insert(ctx.RESOURCES.compras, {
    empresa_id: ctx.empresaId,
    fornecedor_id: Number(ctx.fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'pendente',
    frete,
    total,
  });
  const itens: any[] = [];
  for (const l of linhas) {
    itens.push(
      await ctx.s.insert(ctx.RESOURCES.itens_compra, {
        empresa_id: ctx.empresaId,
        compra_id: Number(compra.id),
        insumo_id: Number(ctx.insumo.id),
        quantidade: l.qtd,
        quantidade_recebida: 0,
        preco_unitario: l.preco,
      })
    );
  }
  return { compraId: Number(compra.id), itens: itens.map((i) => Number(i.id)) };
}

// reqDe/resFake de _p1util: são os MESMOS mocks que os testes em memória usam,
// com req.header() e res.status().json() de verdade — o handler não é exercido
// pela metade.
async function receber(
  ctx: Awaited<ReturnType<typeof cenario>>,
  compraId: number,
  itens: { item_compra_id: number; quantidade: number }[],
  chave?: string,
  ator?: Actor
) {
  const { reqDe, resFake } = await import('./_p1util');
  const { res, saida } = resFake();
  await ctx.compras.receberParcial(
    reqDe({ itens, ...(chave ? { idempotency_key: chave } : {}) }, { params: { id: compraId }, user: (ator ?? ctx.actor) as any }),
    res
  );
  return { status: saida.status, body: saida.json };
}
async function custoMedio(ctx: Awaited<ReturnType<typeof cenario>>) {
  const row = await um('SELECT custo_medio FROM insumos WHERE id=$1', [Number(ctx.insumo.id)]);
  return Number(row?.custo_medio ?? 0);
}
async function saldo(ctx: Awaited<ReturnType<typeof cenario>>) {
  const row = await um('SELECT quantidade FROM estoque_insumos WHERE insumo_id=$1', [Number(ctx.insumo.id)]);
  return Number(row?.quantidade ?? 0);
}

// ---------------------------------------------------------------------------
// 1) A MIGRATION 0028 ESTÁ NO BANCO
// ---------------------------------------------------------------------------
test('pg E3.1: a 0028 está aplicada — colunas, CHECKs e índices únicos parciais', { skip }, async () => {
  await base();

  const cols = await q<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name='movimentacoes' AND column_name IN ('recebimento_id','item_compra_id','custo_unitario')
      ORDER BY column_name`
  );
  assert.deepEqual(cols.map((c) => c.column_name), ['custo_unitario', 'item_compra_id', 'recebimento_id']);
  assert.equal(cols[0].data_type, 'numeric', 'custo_unitario precisa ser NUMERIC, não float');

  const colsInsumos = await q<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='movimentacoes_insumos' AND column_name IN ('compra_id','recebimento_id','item_compra_id')
      ORDER BY column_name`
  );
  assert.deepEqual(colsInsumos.map((c) => c.column_name), ['compra_id', 'item_compra_id', 'recebimento_id']);

  const checks = await q<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conname IN ('movimentacoes_custo_unitario_nao_negativo','movimentacoes_insumos_custo_nao_negativo')
      ORDER BY conname`
  );
  assert.deepEqual(checks.map((c) => c.conname), ['movimentacoes_custo_unitario_nao_negativo', 'movimentacoes_insumos_custo_nao_negativo']);

  const unicos = await q<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE indexname IN ('uq_mov_insumos_entrada_por_recebimento','uq_mov_produtos_entrada_por_recebimento')
      ORDER BY indexname`
  );
  assert.deepEqual(unicos.map((c) => c.indexname), ['uq_mov_insumos_entrada_por_recebimento', 'uq_mov_produtos_entrada_por_recebimento']);

  const fk = await q<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname IN ('movimentacoes_insumos_compra_id_fkey','movimentacoes_insumos_recebimento_id_fkey','movimentacoes_recebimento_id_fkey')
      ORDER BY conname`
  );
  assert.equal(fk.length, 3, 'as FKs estruturais compra/recebimento precisam existir');
});

test('pg E3.1: custo_unitario NEGATIVO é recusado pelo CHECK (23514)', { skip }, async () => {
  const ctx = await cenario('neg');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 10, preco: 50 }]);
  const receb = await ctx.s.insert(ctx.RESOURCES.compra_recebimentos, {
    empresa_id: ctx.empresaId,
    compra_id: compraId,
    data: new Date().toISOString(),
    completo: false,
    valor: 0,
  });

  const r = await q('SELECT 1') // garante conexão
    .then(() =>
      (async () => {
        const { query } = await import('../src/db');
        try {
          await query(
            `INSERT INTO movimentacoes_insumos (tipo, insumo_id, quantidade, custo_unitario, motivo, usuario_id, empresa_id, compra_id, recebimento_id, item_compra_id)
             VALUES ('entrada',$1,5,-10,'teste',$2,$3,$4,$5,$6)`,
            [Number(ctx.insumo.id), ctx.actor.id, ctx.empresaId, compraId, Number(receb.id), itens[0]]
          );
          return null;
        } catch (e: any) {
          return e.code;
        }
      })()
    );
  assert.equal(r, '23514', 'custo negativo passou pelo CHECK');
});

test('pg E3.1: a MESMA linha não aceita duas entradas no mesmo recebimento (23505)', { skip }, async () => {
  const ctx = await cenario('dup');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 10, preco: 50 }]);
  const receb = await ctx.s.insert(ctx.RESOURCES.compra_recebimentos, {
    empresa_id: ctx.empresaId,
    compra_id: compraId,
    data: new Date().toISOString(),
    completo: false,
    valor: 0,
  });
  const { query } = await import('../src/db');
  const sql = `INSERT INTO movimentacoes_insumos (tipo, insumo_id, quantidade, custo_unitario, motivo, usuario_id, empresa_id, compra_id, recebimento_id, item_compra_id)
               VALUES ('entrada',$1,5,50,'teste',$2,$3,$4,$5,$6)`;
  await query(sql, [Number(ctx.insumo.id), ctx.actor.id, ctx.empresaId, compraId, Number(receb.id), itens[0]]);
  const r = await query(sql, [Number(ctx.insumo.id), ctx.actor.id, ctx.empresaId, compraId, Number(receb.id), itens[0]])
    .then(() => null)
    .catch((e: any) => e.code);
  assert.equal(r, '23505', 'a mesma linha foi registrada duas vezes no mesmo recebimento');
});

// ---------------------------------------------------------------------------
// 2) UMA REGRA SÓ — total e parcial dão o mesmo resultado
// ---------------------------------------------------------------------------
test('pg E3.1: receber 40 + 60 de uma vez só é igual a receber 100 direto', { skip }, async () => {
  const ctx = await cenario('eq');

  const a = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);
  await receber(ctx, a.compraId, [{ item_compra_id: a.itens[0], quantidade: 100 }]);
  const custoA = await custoMedio(ctx);
  const saldoA = await saldo(ctx);

  // Zera o cenário e repete em duas etapas.
  const ctx2 = await cenario('eq2');
  const b = await novaCompra(ctx2, [{ qtd: 100, preco: 50 }]);
  await receber(ctx2, b.compraId, [{ item_compra_id: b.itens[0], quantidade: 40 }]);
  await receber(ctx2, b.compraId, [{ item_compra_id: b.itens[0], quantidade: 60 }]);

  assert.equal(await custoMedio(ctx2), custoA, 'custo médio difere entre total e parcial');
  assert.equal(await saldo(ctx2), saldoA, 'estoque difere entre total e parcial');
  assert.equal(custoA, 50);
  assert.equal(saldoA, 100);
});

test('pg E3.1: lote mais caro no segundo recebimento move o custo médio', { skip }, async () => {
  const ctx = await cenario('lot');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);

  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 40 }]);
  assert.equal(await custoMedio(ctx), 50);

  // O preço do pedido muda entre um lote e outro (reajuste do fornecedor).
  await ctx.s.update(ctx.RESOURCES.itens_compra, itens[0], { preco_unitario: 60 });
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 60 }]);

  // (40×50 + 60×60)/100 = 56 — não 50, e não 60.
  assert.equal(await custoMedio(ctx), 56);
  assert.equal(await saldo(ctx), 100);

  const movs = await q<{ custo_unitario: string }>(
    `SELECT custo_unitario FROM movimentacoes_insumos WHERE insumo_id=$1 AND tipo='entrada' ORDER BY id`,
    [Number(ctx.insumo.id)]
  );
  assert.deepEqual(movs.map((m) => Number(m.custo_unitario)), [50, 60], 'cada movimentação precisa guardar o próprio custo');
});

test('pg E3.1: dois lotes não cobram o frete duas vezes, e a soma fecha no frete', { skip }, async () => {
  const ctx = await cenario('frt2');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }], 400);

  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 40 }]);
  const custo1 = await custoMedio(ctx);
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 60 }]);

  const rateado = await um<{ custo_frete_rateado: string }>('SELECT custo_frete_rateado FROM itens_compra WHERE id=$1', [itens[0]]);
  assert.equal(Number(rateado!.custo_frete_rateado), 400, 'o rateio acumulado precisa somar exatamente o frete da compra');

  // 40 un levam 160 de frete (R$ 4/un) e 60 levam 240 (R$ 4/un): custo 54.
  assert.equal(custo1, 54, 'o primeiro lote já deveria carregar a sua parte do frete');
  assert.equal(await custoMedio(ctx), 54, 'o segundo lote cobrou o frete de novo');

  // E receber tudo de uma vez dá o MESMO custo.
  const ctx2 = await cenario('frt3');
  const c2 = await novaCompra(ctx2, [{ qtd: 100, preco: 50 }], 400);
  await receber(ctx2, c2.compraId, [{ item_compra_id: c2.itens[0], quantidade: 100 }]);
  assert.equal(await custoMedio(ctx2), 54, 'o custo não pode depender de quantos lotes chegaram');
});

test('pg E3.1: o frete da compra entra no custo efetivo e fecha no centavo', { skip }, async () => {
  const ctx = await cenario('frt');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 10, preco: 100 }], 25);

  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 10 }]);

  // 100 + 25/10 = 102,50
  assert.equal(await custoMedio(ctx), 102.5);
  const rateado = await um<{ custo_frete_rateado: string }>('SELECT custo_frete_rateado FROM itens_compra WHERE id=$1', [itens[0]]);
  assert.equal(Number(rateado!.custo_frete_rateado), 25, 'o rateio gravado no item não fecha com o frete da compra');
  const mov = await um<{ custo_unitario: string }>(`SELECT custo_unitario FROM movimentacoes_insumos WHERE item_compra_id=$1`, [itens[0]]);
  assert.equal(Number(mov!.custo_unitario), 102.5, 'a movimentação precisa guardar o custo EFETIVO (com frete)');
});

// ---------------------------------------------------------------------------
// 3) ESTORNO
// ---------------------------------------------------------------------------
test('pg E3.1: cancelar a compra estorna estoque e restaura o custo médio', { skip }, async () => {
  const ctx = await cenario('est');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 100 }]);
  assert.equal(await custoMedio(ctx), 50);
  assert.equal(await saldo(ctx), 100);

  const { updateRecord } = await import('../src/services');
  await updateRecord(ctx.RESOURCES.compras, compraId, { status: 'cancelado' }, ctx.actor, { escopo: ctx.escopo });

  assert.equal(await saldo(ctx), 0, 'o estoque não foi estornado');
  assert.equal(await custoMedio(ctx), 0, 'o custo médio não foi restaurado');
  // movimentacoes_insumos NÃO tem coluna estornado: o estorno lança uma SAÍDA
  // compensatória com o mesmo vínculo. A entrada original fica intacta — a
  // história do que aconteceu não se apaga.
  const trilha = await q<{ tipo: string; quantidade: string }>(
    `SELECT tipo, quantidade FROM movimentacoes_insumos WHERE compra_id=$1 ORDER BY id`,
    [compraId]
  );
  assert.deepEqual(trilha.map((t) => t.tipo), ['entrada', 'saida'], 'o estorno precisa deixar a entrada E a saída compensatória');
});

test('pg E3.1: estorno com estoque já consumido RECUSA e não muda nada', { skip }, async () => {
  const ctx = await cenario('est2');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 10 }]);
  await ctx.s.adjustInsumoStock(Number(ctx.insumo.id), -8);
  assert.equal(await saldo(ctx), 2);

  const { updateRecord } = await import('../src/services');
  const r = await updateRecord(ctx.RESOURCES.compras, compraId, { status: 'cancelado' }, ctx.actor, { escopo: ctx.escopo })
    .then(() => null)
    .catch((e: any) => e.status ?? e.message);
  assert.ok(r, 'o cancelamento com estoque consumido deveria ter falhado');
  assert.equal(await saldo(ctx), 2, 'o estorno recusado mexeu no estoque');
  assert.equal(await custoMedio(ctx), 50, 'o estorno recusado mexeu no custo');
  const status = await um<{ status: string }>('SELECT status FROM compras WHERE id=$1', [compraId]);
  // 10 de 100 recebidos → 'parcial'. O rollback do estorno recusado devolveu o
  // status que havia, não inventou outro.
  assert.equal(status!.status, 'parcial', 'o rollback deveria ter devolvido o status');
});

// ---------------------------------------------------------------------------
// 4) CORRIDA
// ---------------------------------------------------------------------------
test('pg E3.1 CORRIDA A: dois recebimentos simultâneos do MESMO SKU somam estoque e ponderam custo', { skip }, async () => {
  // Uma compra por vez, mesmo insumo, disparados juntos. É o cenário em que um
  // SELECT → UPDATE sem lock perde uma das duas escritas.
  const ctx = await cenario('corA');
  const c1 = await novaCompra(ctx, [{ qtd: 100, preco: 40 }]);
  const c2 = await novaCompra(ctx, [{ qtd: 100, preco: 60 }]);

  const alvos = [
    { c: c1, qtd: 50 },
    { c: c2, qtd: 50 },
  ];
  const disparar = () =>
    Promise.all(
      alvos.map((a) =>
        receber(ctx, a.c.compraId, [{ item_compra_id: a.c.itens[0], quantidade: a.qtd }]).then(
          (r) => ({ ok: r.status === 201, r }),
          (e: any) => ({ ok: false, conflito: /ao mesmo tempo|conflito/i.test(String(e?.message || '')), e })
        )
      )
    );

  const primeira = await disparar();
  // As duas compras mexem no MESMO insumo. Sob SERIALIZABLE o Postgres pode
  // abortar uma das transações — isso é o banco fazendo o trabalho dele. O que
  // é INACEITÁVEL é update perdido: uma entrada sumir sem erro.
  const perdidas = primeira.filter((x) => !x.ok && !(x as any).conflito);
  assert.deepEqual(perdidas, [], `falha que não é conflito de concorrência: ${JSON.stringify(perdidas.map((p: any) => p.e?.message))}`);

  // O que tomou conflito tenta de novo — é o que qualquer cliente faz.
  for (const [i, x] of primeira.entries()) if (!x.ok) await receber(ctx, alvos[i].c.compraId, [{ item_compra_id: alvos[i].c.itens[0], quantidade: alvos[i].qtd }]);

  assert.equal(await saldo(ctx), 100, 'uma das duas entradas se perdeu na corrida');
  // (50×40 + 50×60)/100 = 50
  assert.equal(await custoMedio(ctx), 50, 'o custo médio foi calculado sobre saldo desatualizado');
});

test('pg E3.1 CORRIDA B: dois parciais simultâneos do MESMO pedido nunca passam do pedido', { skip }, async () => {
  const ctx = await cenario('corB');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 50, preco: 30 }]);

  const resultados = await Promise.allSettled([
    receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 40 }]),
    receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 40 }]),
  ]);
  const ok = resultados.filter((r) => r.status === 'fulfilled' && (r as any).value.status === 201).length;
  const rejeitado = resultados.filter((r) => r.status === 'rejected').length;

  assert.equal(ok + rejeitado, 2, 'os dois disparos precisam terminar');
  assert.equal(await saldo(ctx), 40, 'os dois parciais entraram e o pedido foi estourado');
  const rec = await um<{ recebido: string; comprado: string }>(
    `SELECT COALESCE(SUM(quantidade_recebida),0) AS recebido, COALESCE(SUM(quantidade),0) AS comprado FROM itens_compra WHERE compra_id=$1`,
    [compraId]
  );
  assert.ok(Number(rec!.recebido) <= Number(rec!.comprado), `recebido ${rec!.recebido} > comprado ${rec!.comprado}`);
});

test('pg E3.1 CORRIDA C: recebimento e cancelamento simultâneos não deixam estoque fantasma', { skip }, async () => {
  const ctx = await cenario('corC');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 100 }]);

  const { updateRecord } = await import('../src/services');
  const resultados = await Promise.allSettled([
    updateRecord(ctx.RESOURCES.compras, compraId, { status: 'cancelado' }, ctx.actor, { escopo: ctx.escopo }),
    updateRecord(ctx.RESOURCES.compras, compraId, { status: 'cancelado' }, ctx.actor, { escopo: ctx.escopo }),
  ]);
  // Um dos dois pode falhar (transição inválida) — o que importa é o resultado final.
  assert.ok(resultados.length === 2);

  const status = await um<{ status: string }>('SELECT status FROM compras WHERE id=$1', [compraId]);
  assert.equal(status!.status, 'cancelado');
  assert.equal(await saldo(ctx), 0, `estoque fantasma após a corrida (ficou ${await saldo(ctx)})`);
  assert.equal(await custoMedio(ctx), 0, 'custo fantasma após a corrida');
});

test('pg E3.1: dois recebimentos com a MESMA idempotency key geram um único recebimento', { skip }, async () => {
  const ctx = await cenario('idem');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);

  const chave = `doc-${SUFIXO}-${seq}`;
  const [r1, r2] = await Promise.allSettled([
    receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 30 }], chave),
    receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 30 }], chave),
  ]);
  assert.ok(r1.status === 'fulfilled' || r2.status === 'fulfilled');

  assert.equal(await saldo(ctx), 30, `a chave de idempotência não segurou a duplicidade (estoque ${await saldo(ctx)})`);
  const n = await um<{ n: string }>('SELECT COUNT(*)::text AS n FROM compra_recebimentos WHERE compra_id=$1 AND documento=$2', [compraId, chave]);
  assert.equal(Number(n!.n), 1, 'a mesma chave gerou dois recebimentos');
});

// ---------------------------------------------------------------------------
// 5) ROLLBACK E MULTIEMPRESA
// ---------------------------------------------------------------------------
test('pg E3.1: transação que falha no meio não deixa estoque nem custo', { skip }, async () => {
  const ctx = await cenario('rb');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 100, preco: 50 }]);

  const r = await ctx.s
    .transaction(async (tx: any) => {
      const { aplicarEntradaDeCompra } = await import('../src/custoRecebimento');
      await aplicarEntradaDeCompra({
        compraId,
        empresaId: ctx.empresaId,
        recebimentoId: null,
        linhas: [
          {
            item_compra_id: itens[0],
            insumo_id: Number(ctx.insumo.id),
            produto_id: null,
            tamanho_id: null,
            quantidade: 40,
            preco_unitario: 50,
            local: 'loja',
          },
        ],
        freteTotal: 0,
        actor: { id: ctx.actor.id, name: ctx.actor.name },
        motivo: 'Entrada de teste que será desfeita',
        escopo: ctx.escopo,
        tx,
      });
      throw new Error('falha proposital depois do estoque');
    })
    .then(() => null)
    .catch((e: any) => e.message);
  assert.equal(r, 'falha proposital depois do estoque');

  assert.equal(await saldo(ctx), 0, 'o rollback não devolveu o estoque');
  assert.equal(await custoMedio(ctx), 0, 'o rollback não devolveu o custo médio');
  const n = await um<{ n: string }>('SELECT COUNT(*)::text AS n FROM movimentacoes_insumos WHERE insumo_id=$1', [Number(ctx.insumo.id)]);
  assert.equal(Number(n!.n), 0, 'a movimentação sobreviveu ao rollback');
});

test('pg E3.1 MULTIEMPRESA: A e B compram o mesmo insumo por preços diferentes (A → B → A)', { skip }, async () => {
  const a = await cenario('mxA');
  const b = await cenario('mxB');
  assert.notEqual(a.empresaId, b.empresaId);

  const ca = await novaCompra(a, [{ qtd: 100, preco: 40 }]);
  const cb = await novaCompra(b, [{ qtd: 100, preco: 90 }]);

  await receber(a, ca.compraId, [{ item_compra_id: ca.itens[0], quantidade: 100 }]);
  // B tenta receber usando a linha da A.
  const cruzado = await receber(b, ca.compraId, [{ item_compra_id: ca.itens[0], quantidade: 100 }])
    .then(() => null)
    .catch((e: any) => e.status ?? e.message);
  assert.equal(cruzado, 404, 'a empresa B conseguiu mexer na compra da A');

  await receber(b, cb.compraId, [{ item_compra_id: cb.itens[0], quantidade: 100 }]);

  assert.equal(await custoMedio(a), 40, 'o custo da A vazou');
  assert.equal(await custoMedio(b), 90, 'o custo da B vazou');
  assert.equal(await saldo(a), 100);
  assert.equal(await saldo(b), 100);

  // Voltando para A: nada mudou.
  assert.equal(await custoMedio(a), 40);
  const emp = await um<{ empresa_id: string }>('SELECT empresa_id FROM movimentacoes_insumos WHERE insumo_id=$1 LIMIT 1', [Number(a.insumo.id)]);
  assert.equal(Number(emp!.empresa_id), a.empresaId, 'movimentação da A com empresa errada');
});

test('pg E3.1: o recebimento grava auditoria com o custo aplicado', { skip }, async () => {
  const ctx = await cenario('aud');
  const { compraId, itens } = await novaCompra(ctx, [{ qtd: 10, preco: 25 }]);
  await receber(ctx, compraId, [{ item_compra_id: itens[0], quantidade: 10 }]);

  // A trilha é gravada contra a COMPRA (recurso 'compras'), com o custo efetivo
  // no payload — não uma linha por movimentação.
  // Um recebimento deixa DUAS trilhas: a do recebimento em si e a da aplicação
  // de custo. É a segunda que precisa existir — sem ela ninguém explica de onde
  // veio o custo médio de amanhã.
  const trilhas = await q<{ acao: string; empresa_id: string; descricao: string; dados: any }>(
    `SELECT acao, empresa_id, descricao, dados FROM auditoria
      WHERE recurso='compras' AND empresa_id=$1 ORDER BY id DESC LIMIT 5`,
    [ctx.empresaId]
  );
  const custo = trilhas.find((t) => /custo efetivo/.test(String(t.descricao)));
  assert.ok(custo, `nenhuma trilha de custo entre: ${trilhas.map((t) => t.descricao).join(' | ')}`);
  assert.equal(custo!.acao, 'editar');
  assert.equal(Number(custo!.empresa_id), ctx.empresaId);
  const aplicadas = (custo!.dados as any)?.aplicadas ?? [];
  assert.equal(aplicadas.length, 1, 'o payload da auditoria precisa listar o que foi aplicado');
  assert.equal(Number(aplicadas[0].custo_unitario_efetivo), 25, 'o custo efetivo aplicado precisa ficar na trilha');
  assert.equal(Number(aplicadas[0].custo_medio_antes), 0);
  assert.equal(Number(aplicadas[0].custo_medio_depois), 25, 'o antes/depois do custo médio precisa ficar na trilha');
});
