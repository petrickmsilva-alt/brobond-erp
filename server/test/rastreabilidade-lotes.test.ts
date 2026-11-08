// ============================================================================
// SUPPLY CHAIN — RASTREABILIDADE POR LOTE (migration 0106)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) o lote é de um PRODUTO ou de um INSUMO — nunca dos dois, nunca de nenhum;
//      validade anterior à fabricação é recusada;
//   B) o SALDO DO LOTE é DERIVADO das movimentações (entrada soma, saída
//      subtrai, ajuste aplica o delta) — nunca um saldo gravado;
//   C) receber compra com lote vincula a movimentação E o item do recebimento;
//      lote de outro produto/insumo é 409; lote de outra empresa é 404;
//   D) a devolução ao fornecedor propaga o lote até a movimentação de saída;
//   E) a ficha do lote (obterLote) traz origem, trilha e saldo derivado;
//   F) lotePorCodigo resolve por código e é 409 quando o código é ambíguo;
//   G) trilhaMovimentacao/trilhaProduto/trilhaDocumento respondem a cadeia;
//   H) o painel conta lotes, cobertura de lote e vencimentos;
//   I) isolamento multiempresa: lote de A não existe para B.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord, listRecords } = await import('../src/services');
const {
  obterLote,
  lotePorCodigo,
  trilhaMovimentacao,
  trilhaProduto,
  trilhaDocumento,
  painelRastreabilidade,
  saldoDoLoteMov,
  saldoDoLoteInsumo,
} = await import('../src/rastreabilidade');
const compras = await import('../src/compras');
const devolucao = await import('../src/devolucaoFornecedor');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin, reqDe, chamar } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

let seq = 0;
const tag = () => `${Date.now() % 100000}-${++seq}`;

async function novoProduto(empresaId = 1) {
  const s = getStore();
  const t = tag();
  return s.insert(RESOURCES.produtos, {
    empresa_id: empresaId,
    sku: `LOT-${t}`,
    nome: `Produto Lote ${t}`,
    preco_venda: 50,
    custo: 20,
    ativo: true,
  });
}
async function novoInsumo(empresaId = 1) {
  const s = getStore();
  const t = tag();
  return s.insert(RESOURCES.insumos, { empresa_id: empresaId, nome: `Insumo Lote ${t}`, unidade: 'un', custo_medio: 5, ativo: true });
}
async function novoLocal(empresaId = 1) {
  const s = getStore();
  const t = tag();
  return s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `local-lote-${t}`, tipo: 'loja', ativo: true, padrao: true });
}
async function novoFornecedor(empresaId = 1) {
  const s = getStore();
  const t = tag();
  return s.insert(RESOURCES.fornecedores, { empresa_id: empresaId, nome: `Forn Lote ${t}`, ativo: true });
}

async function criarLote(empresaId: number, dados: Record<string, unknown>, actor: any = admin) {
  return createRecord(RESOURCES.lotes, { ...dados }, actor, { escopo: escopoDeSistema(empresaId) });
}

async function lancarMov(empresaId: number, dados: Record<string, unknown>) {
  return createRecord(RESOURCES.movimentacoes, dados, admin, { escopo: escopoDeSistema(empresaId) });
}

// ---------------------------------------------------------------------------
// A) CADASTRO — produto XOR insumo e datas coerentes
// ---------------------------------------------------------------------------
test('A) lote é de um produto OU de um insumo — nunca dos dois, nunca de nenhum', async () => {
  const produto = await novoProduto(1);
  const insumo = await novoInsumo(1);

  await assert.rejects(
    () => criarLote(1, { codigo: 'X', produto_id: Number(produto.id), insumo_id: Number(insumo.id) }),
    /produto OU de um insumo/i
  );
  await assert.rejects(() => criarLote(1, { codigo: 'X' }), /produto ou o insumo/i);

  const ok = await criarLote(1, { codigo: 'L-OK', produto_id: Number(produto.id) });
  assert.equal(Number(ok.produto_id), Number(produto.id));
  assert.equal(Number(ok.criado_por), 1, 'o criador é carimbado pela identidade autenticada');
});

test('A) validade anterior à fabricação é recusada', async () => {
  const produto = await novoProduto(1);
  await assert.rejects(
    () => criarLote(1, { codigo: 'V', produto_id: Number(produto.id), fabricacao: '2026-05-01', validade: '2026-04-01' }),
    /não pode ser anterior/i
  );
  const ok = await criarLote(1, { codigo: 'V2', produto_id: Number(produto.id), fabricacao: '2026-04-01', validade: '2026-05-01' });
  assert.ok(ok.id);
});

// ---------------------------------------------------------------------------
// B) SALDO DERIVADO (funções puras)
// ---------------------------------------------------------------------------
test('B) saldo do lote de produto: entrada soma, saída subtrai, ajuste aplica o delta', () => {
  const movs = [
    { tipo: 'entrada', quantidade: 10 },
    { tipo: 'saida', quantidade: 3 },
    { tipo: 'ajuste', quantidade: -2 },
    { tipo: 'transferencia', quantidade: 5 }, // líquido zero: não conta
  ] as any[];
  assert.equal(saldoDoLoteMov(movs), 5, '10 - 3 - 2 = 5');
  assert.equal(
    saldoDoLoteInsumo([
      { tipo: 'entrada', quantidade: 8 },
      { tipo: 'saida', quantidade: 2 },
    ] as any[]),
    6
  );
});

// ---------------------------------------------------------------------------
// C) RECEBIMENTO COM LOTE
// ---------------------------------------------------------------------------
async function compraAprovadaProduto(empresaId = 1, qtd = 10, preco = 20) {
  const s = getStore();
  const fornecedor = await novoFornecedor(empresaId);
  const produto = await novoProduto(empresaId);
  const local = await novoLocal(empresaId);
  const compra = await s.insert(RESOURCES.compras, {
    empresa_id: empresaId,
    fornecedor_id: Number(fornecedor.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'pendente',
    frete: 0,
    total: qtd * preco,
  });
  const item = await s.insert(RESOURCES.itens_compra, {
    empresa_id: empresaId,
    compra_id: Number(compra.id),
    produto_id: Number(produto.id),
    insumo_id: null,
    quantidade: qtd,
    quantidade_recebida: 0,
    preco_unitario: preco,
  });
  const ator = await criarAtor(empresaId, 'gerente');
  await chamar(compras.aprovarCompra, reqDe({}, { params: { id: compra.id } })); // admin (alçada ilimitada)
  return { fornecedor, produto, local, compra, item, ator };
}

test('C) receber com lote vincula a movimentação e o item do recebimento', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const lote = await criarLote(1, {
    codigo: `R-${tag()}`,
    produto_id: Number(fx.produto.id),
    fornecedor_id: Number(fx.fornecedor.id),
    validade: '2027-01-01',
  });

  await chamar(
    compras.receberParcial,
    reqDe(
      { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 4, lote_id: Number(lote.id) }], local_id: Number(fx.local.id) },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );

  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { produto_id: Number(fx.produto.id) } });
  assert.equal(movs.rows.length, 1, 'a entrada oficial foi lançada');
  assert.equal(Number(movs.rows[0].lote_id), Number(lote.id), 'a movimentação carrega o lote');

  const itens = await listRecords(RESOURCES.compra_recebimento_itens, { page: 1, pageSize: 50 });
  assert.equal(Number(itens.rows[0].lote_id), Number(lote.id), 'o item do recebimento carrega o lote');

  const ficha = await chamar(obterLote, reqDe({}, { params: { id: lote.id } }));
  assert.equal(ficha.saldo, 4, 'o saldo do lote é derivado da movimentação');
});

test('C) lote de outro produto é 409 e lote de outra empresa é 404', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const outroProduto = await novoProduto(1);
  const loteErrado = await criarLote(1, { codigo: `E-${tag()}`, produto_id: Number(outroProduto.id) });
  const loteOutraEmpresa = await criarLote(2, { codigo: `O-${tag()}`, produto_id: null, insumo_id: Number((await novoInsumo(2)).id) });

  await assert.rejects(
    () =>
      chamar(
        compras.receberParcial,
        reqDe(
          { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 1, lote_id: Number(loteErrado.id) }], local_id: Number(fx.local.id) },
          { params: { id: fx.compra.id }, user: fx.ator }
        ),
        201
      ),
    /não corresponde ao produto\/insumo/i
  );
  await assert.rejects(
    () =>
      chamar(
        compras.receberParcial,
        reqDe(
          {
            itens: [{ item_compra_id: Number(fx.item.id), quantidade: 1, lote_id: Number(loteOutraEmpresa.id) }],
            local_id: Number(fx.local.id),
          },
          { params: { id: fx.compra.id }, user: fx.ator }
        ),
        201
      ),
    /não pertence a esta empresa/i
  );
});

// ---------------------------------------------------------------------------
// D) DEVOLUÇÃO AO FORNECEDOR propaga o lote
// ---------------------------------------------------------------------------
test('D) devolução ao fornecedor leva o lote até a movimentação de saída', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const lote = await criarLote(1, { codigo: `D-${tag()}`, produto_id: Number(fx.produto.id) });
  // Recebe 5 com o lote (cria saldo e o vínculo de recebimento).
  await chamar(
    compras.receberParcial,
    reqDe(
      { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 5, lote_id: Number(lote.id) }], local_id: Number(fx.local.id) },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );
  const s = getStore();
  const itemCompra = await s.get(RESOURCES.itens_compra, Number(fx.item.id));
  assert.equal(Number(itemCompra!.quantidade_recebida), 5);

  const criada = await chamar(
    devolucao.criarDevolucaoFornecedor,
    reqDe(
      {
        motivo: 'Avaria',
        local_origem_id: Number(fx.local.id),
        itens: [{ item_compra_id: Number(fx.item.id), quantidade: 2, lote_id: Number(lote.id) }],
      },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );
  const devId = Number(criada.devolucao.id);
  assert.equal(Number(criada.itens[0].lote_id), Number(lote.id), 'o item da devolução guarda o lote');

  await chamar(devolucao.autorizarDevolucaoFornecedor, reqDe({}, { params: { id: devId }, user: fx.ator }));
  await chamar(devolucao.expedirDevolucaoFornecedor, reqDe({}, { params: { id: devId }, user: fx.ator }));

  const saidas = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { devolucao_fornecedor_id: devId } });
  assert.equal(saidas.rows.length, 1);
  assert.equal(Number(saidas.rows[0].lote_id), Number(lote.id), 'a saída da devolução carrega o lote');

  const ficha = await chamar(obterLote, reqDe({}, { params: { id: lote.id } }));
  assert.equal(ficha.saldo, 3, '5 recebidos − 2 devolvidos = 3');
});

test('D) devolução com lote de outro produto é 409', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const outro = await novoProduto(1);
  const loteErrado = await criarLote(1, { codigo: `DE-${tag()}`, produto_id: Number(outro.id) });
  await chamar(
    compras.receberParcial,
    reqDe(
      { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 5 }], local_id: Number(fx.local.id) },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );
  await assert.rejects(
    () =>
      chamar(
        devolucao.criarDevolucaoFornecedor,
        reqDe(
          { motivo: 'x', itens: [{ item_compra_id: Number(fx.item.id), quantidade: 1, lote_id: Number(loteErrado.id) }] },
          { params: { id: fx.compra.id }, user: fx.ator }
        )
      ),
    /não corresponde ao produto\/insumo/i
  );
});

// ---------------------------------------------------------------------------
// E) FICHA DO LOTE
// ---------------------------------------------------------------------------
test('E) obterLote devolve origem, trilha e saldo derivado', async () => {
  const produto = await novoProduto(1);
  const fornecedor = await novoFornecedor(1);
  const local = await novoLocal(1);
  const lote = await criarLote(1, {
    codigo: `F-${tag()}`,
    produto_id: Number(produto.id),
    fornecedor_id: Number(fornecedor.id),
    validade: '2027-06-30',
  });

  await lancarMov(1, {
    tipo: 'entrada',
    produto_id: Number(produto.id),
    quantidade: 12,
    local_id: Number(local.id),
    lote_id: Number(lote.id),
  });
  await lancarMov(1, {
    tipo: 'saida',
    produto_id: Number(produto.id),
    quantidade: 2,
    local_id: Number(local.id),
    lote_id: Number(lote.id),
  });

  const ficha = await chamar(obterLote, reqDe({}, { params: { id: lote.id } }));
  assert.equal(ficha.saldo, 10);
  assert.equal(ficha.fornecedor.nome, fornecedor.nome);
  assert.equal(ficha.total_movimentacoes, 2);
  assert.equal(ficha.semantica, 'saldo_derivado_das_movimentacoes');
  assert.ok(ficha.movimentacoes[0].local, 'a trilha traz o local');
});

// ---------------------------------------------------------------------------
// F) LOTE POR CÓDIGO
// ---------------------------------------------------------------------------
test('F) lotePorCodigo resolve por código e é 409 quando é ambíguo', async () => {
  const p1 = await novoProduto(1);
  const p2 = await novoProduto(1);
  const codigo = `AMB-${tag()}`;
  await criarLote(1, { codigo, produto_id: Number(p1.id) });
  await criarLote(1, { codigo, produto_id: Number(p2.id) });

  const porProduto = await chamar(lotePorCodigo, reqDe({}, { query: { codigo, produto_id: String(p1.id) } }));
  assert.equal(Number(porProduto.lote.produto_id), Number(p1.id));

  await assert.rejects(() => chamar(lotePorCodigo, reqDe({}, { query: { codigo } })), /mais de um lote/i);
  await assert.rejects(() => chamar(lotePorCodigo, reqDe({}, { query: { codigo: `NAO-EXISTE-${tag()}` } })), /Nenhum lote/i);
});

// ---------------------------------------------------------------------------
// G) TRILHAS
// ---------------------------------------------------------------------------
test('G) trilhaMovimentacao expõe a origem (compra/recebimento) e o lote', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const lote = await criarLote(1, { codigo: `T-${tag()}`, produto_id: Number(fx.produto.id) });
  await chamar(
    compras.receberParcial,
    reqDe(
      { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 3, lote_id: Number(lote.id) }], local_id: Number(fx.local.id) },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );
  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 10, filter: { produto_id: Number(fx.produto.id) } });
  const movId = Number(movs.rows[0].id);

  const trilha = await chamar(trilhaMovimentacao, reqDe({}, { params: { id: movId } }));
  assert.equal(Number(trilha.lote.id), Number(lote.id));
  assert.equal(Number(trilha.origem.compra.id), Number(fx.compra.id));
  assert.ok(trilha.origem.recebimento, 'o recebimento de origem é resolvido');
  assert.ok(trilha.origem.local, 'o local é resolvido');
});

test('G) trilhaProduto consolida movimentações, lotes e fornecedores de origem', async () => {
  const produto = await novoProduto(1);
  const fornecedor = await novoFornecedor(1);
  const local = await novoLocal(1);
  const lote = await criarLote(1, { codigo: `TP-${tag()}`, produto_id: Number(produto.id), fornecedor_id: Number(fornecedor.id) });
  await lancarMov(1, {
    tipo: 'entrada',
    produto_id: Number(produto.id),
    quantidade: 7,
    local_id: Number(local.id),
    lote_id: Number(lote.id),
  });

  const trilha = await chamar(trilhaProduto, reqDe({}, { params: { id: produto.id } }));
  assert.equal(trilha.produto.id, Number(produto.id));
  assert.equal(trilha.lotes.length, 1);
  assert.equal(trilha.fornecedores[0].id, Number(fornecedor.id));
  assert.equal(trilha.resumo.entradas, 7);
});

test('G) trilhaDocumento monta a cadeia por compra e por lote', async () => {
  const fx = await compraAprovadaProduto(1, 10, 20);
  const lote = await criarLote(1, { codigo: `TD-${tag()}`, produto_id: Number(fx.produto.id) });
  await chamar(
    compras.receberParcial,
    reqDe(
      { itens: [{ item_compra_id: Number(fx.item.id), quantidade: 6, lote_id: Number(lote.id) }], local_id: Number(fx.local.id) },
      { params: { id: fx.compra.id }, user: fx.ator }
    ),
    201
  );

  const porCompra = await chamar(trilhaDocumento, reqDe({}, { query: { tipo: 'compra', id: String(fx.compra.id) } }));
  assert.equal(porCompra.tipo, 'compra');
  assert.equal(porCompra.movimentacoes.length, 1);

  const porLote = await chamar(trilhaDocumento, reqDe({}, { query: { tipo: 'lote', id: String(lote.id) } }));
  assert.equal(porLote.movimentacoes.length, 1);
  assert.equal(Number(porLote.movimentacoes[0].lote_id), Number(lote.id));

  await assert.rejects(
    () => chamar(trilhaDocumento, reqDe({}, { query: { tipo: 'inexistente', id: '1' } })),
    /Tipo de documento inválido/i
  );
});

// ---------------------------------------------------------------------------
// H) PAINEL
// ---------------------------------------------------------------------------
test('H) o painel conta lotes, cobertura de lote e vencimentos', async () => {
  const produto = await novoProduto(1);
  const local = await novoLocal(1);
  const hoje = new Date();
  const passado = new Date(hoje.getTime() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const em15 = new Date(hoje.getTime() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const loteVencido = await criarLote(1, { codigo: `PV-${tag()}`, produto_id: Number(produto.id), validade: passado });
  const loteVencendo = await criarLote(1, { codigo: `PN-${tag()}`, produto_id: Number(produto.id), validade: em15 });

  await lancarMov(1, {
    tipo: 'entrada',
    produto_id: Number(produto.id),
    quantidade: 4,
    local_id: Number(local.id),
    lote_id: Number(loteVencido.id),
  });
  await lancarMov(1, {
    tipo: 'entrada',
    produto_id: Number(produto.id),
    quantidade: 2,
    local_id: Number(local.id),
    lote_id: Number(loteVencendo.id),
  });
  await lancarMov(1, { tipo: 'entrada', produto_id: Number(produto.id), quantidade: 1, local_id: Number(local.id) }); // sem lote

  const painel = await chamar(painelRastreabilidade, reqDe({}));
  assert.ok(painel.lotes.total >= 2);
  assert.ok(painel.lotes.com_saldo >= 2);
  assert.ok(painel.alertas.vencidos.some((l: any) => Number(l.id) === Number(loteVencido.id)));
  assert.ok(painel.alertas.vencendo_30d.some((l: any) => Number(l.id) === Number(loteVencendo.id)));
  assert.ok(painel.movimentacoes.sem_lote >= 1, 'a movimentação sem lote é contabilizada');
  assert.ok(painel.movimentacoes.cobertura_lote_pct > 0 && painel.movimentacoes.cobertura_lote_pct < 100);
});

// ---------------------------------------------------------------------------
// I) ISOLAMENTO MULTIEMPRESA
// ---------------------------------------------------------------------------
test('I) lote de A não existe para B (ficha, código e trilha)', async () => {
  const produto = await novoProduto(1);
  const lote = await criarLote(1, { codigo: `ISO-${tag()}`, produto_id: Number(produto.id) });
  const gerenteB = await criarAtor(2, 'gerente');

  await assert.rejects(() => chamar(obterLote, reqDe({}, { params: { id: lote.id }, user: gerenteB })), /não encontrado|404/i);
  await assert.rejects(() => chamar(lotePorCodigo, reqDe({}, { query: { codigo: lote.codigo }, user: gerenteB })), /Nenhum lote/i);
  await assert.rejects(() => chamar(trilhaProduto, reqDe({}, { params: { id: produto.id }, user: gerenteB })), /não encontrado|404/i);
});

// ---------------------------------------------------------------------------
// RBAC / integridade do recurso
// ---------------------------------------------------------------------------
test('lotes: o CRUD genérico não exclui o lote (histórico aponta para ele)', async () => {
  const { RESOURCES: R } = await import('../src/resources');
  const { checkAccess } = await import('../src/services');
  assert.equal(R.lotes.ops?.delete, false, 'lote em uso não é excluído pelo CRUD genérico');
  const operador = await criarAtor(1, 'operador');
  const produto = await novoProduto(1);
  const lote = await criarLote(1, { codigo: `OP-${tag()}`, produto_id: Number(produto.id) }, operador);
  assert.ok(lote.id);
  // A barreira é a mesma do endpoint DELETE: `checkAccess` recusa (405) porque
  // `ops.delete` está fechado — o lote tem de ser desativado, não apagado.
  assert.throws(() => checkAccess(R.lotes, operador, 'delete'), /Não é possível excluir/i);
});
