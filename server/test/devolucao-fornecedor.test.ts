// ============================================================================
// SUPPLY CHAIN — DEVOLUÇÃO AO FORNECEDOR (migration 0105)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) o documento nasce SOLICITADA e NÃO mexe no saldo;
//   B) só se devolve o que foi RECEBIDO da compra (nunca o pedido);
//   C) autorizar/expedir/encerrar são de gerente/admin (operador é 403);
//   D) expedir lança SAÍDA de estoque pela movimentação oficial — UMA vez;
//   E) cancelar só antes de expedir; depois é 409 (exige estorno);
//   F) idempotência da criação pela chave;
//   G) isolamento multiempresa: documento de A não existe para B.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, createRecord, listRecords } = await import('../src/services');
const {
  criarDevolucaoFornecedor,
  autorizarDevolucaoFornecedor,
  expedirDevolucaoFornecedor,
  encerrarDevolucaoFornecedor,
  cancelarDevolucaoFornecedor,
  obterDevolucaoFornecedor,
} = await import('../src/devolucaoFornecedor');
const { criarAtor, garantirAdmin } = await import('./_p1util');
const { escopoDeSistema } = await import('../src/empresa');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

async function chamar(handler: any, opts: { id?: number; body?: any; actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: opts.id ? { id: String(opts.id) } : {}, body: opts.body ?? {}, user: opts.actor, query: opts.query ?? {} };
  const res: any = { status: () => res, json: (v: any) => (payload = v) };
  await handler(req, res);
  return payload;
}

async function saldo(produtoId: number, localId: number): Promise<number> {
  const lista = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 50, filter: { produto_id: produtoId, local_id: localId } });
  return lista.rows.reduce((t, r) => t + Number(r.quantidade ?? 0), 0);
}

type Fixture = { compraId: number; fornecedorId: number; itemId: number; produtoId: number; localId: number };

/**
 * Monta uma compra recebida: produto com saldo no local, fornecedor, compra
 * aprovada e item com `quantidade_recebida` — é sobre o RECEBIDO que a devolução
 * é limitada.
 */
async function compraRecebida(empresaId: number, recebido = 5, entrada = 10): Promise<Fixture> {
  const s = getStore();
  const tag = `${empresaId}-${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`;
  const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: `Forn ${tag}`, ativo: true }, admin, { escopo: escopoDeSistema(empresaId) });
  const produto = await createRecord(RESOURCES.produtos, { sku: `DEV-${tag}`, nome: 'Camisa Devolução', custo: 10, preco_venda: 30 }, admin, { escopo: escopoDeSistema(empresaId) });
  const local = await createRecord(RESOURCES.locais, { nome: `local-dev-${tag}`, tipo: 'loja', ativo: true, padrao: true }, admin, { escopo: escopoDeSistema(empresaId) });
  const compra = await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: new Date().toISOString().slice(0, 10), total: 0 }, admin, { escopo: escopoDeSistema(empresaId) });
  await s.update(RESOURCES.compras, Number(compra.id), { status: 'aprovado' });
  const item = await s.insert(RESOURCES.itens_compra, {
    empresa_id: empresaId,
    compra_id: Number(compra.id),
    produto_id: Number(produto.id),
    insumo_id: null,
    quantidade: entrada,
    quantidade_recebida: recebido,
    preco_unitario: 10,
  });
  // Saldo disponível para a baixa da expedição (entrada oficial).
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(produto.id), quantidade: entrada, local_id: Number(local.id) }, admin, { escopo: escopoDeSistema(empresaId) });
  return { compraId: Number(compra.id), fornecedorId: Number(fornecedor.id), itemId: Number(item.id), produtoId: Number(produto.id), localId: Number(local.id) };
}

test('A) criar devolução nasce SOLICITADA e NÃO altera o saldo', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const antes = await saldo(fx.produtoId, fx.localId);
  const out = await chamar(criarDevolucaoFornecedor, {
    id: fx.compraId,
    actor: await criarAtor(1, 'gerente'),
    body: { motivo: 'Peças avariadas', itens: [{ item_compra_id: fx.itemId, quantidade: 2 }] },
  });
  assert.equal(out.devolucao.status, 'solicitada');
  assert.equal(out.itens.length, 1);
  assert.equal(Number(out.itens[0].quantidade), 2);
  assert.equal(await saldo(fx.produtoId, fx.localId), antes, 'solicitar não movimenta estoque');
});

test('B) não devolve mais do que foi recebido', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  await assert.rejects(
    () => chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 6 }] } }),
    /recebido|Disponível para devolução|já devolvido/i
  );
  // Devolução de 3 passa; uma segunda de 3 estoura o recebido (5).
  await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 3 }] } });
  await assert.rejects(
    () => chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 3 }] } }),
    /Disponível para devolução|já devolvido/i
  );
});

test('C) transições inválidas são 409 e operador não opera', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const operador = await criarAtor(1, 'operador');
  const out = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 1 }] } });
  const id = Number(out.devolucao.id);
  // Expedir sem autorizar é 409.
  await assert.rejects(() => chamar(expedirDevolucaoFornecedor, { id, actor: gerente }), /autorizada/i);
  // Operador não autoriza.
  await assert.rejects(() => chamar(autorizarDevolucaoFornecedor, { id, actor: operador }), /gerente ou administrador/i);
  // Autorizar duas vezes é 409.
  await chamar(autorizarDevolucaoFornecedor, { id, actor: gerente });
  await assert.rejects(() => chamar(autorizarDevolucaoFornecedor, { id, actor: gerente }), /solicitada/i);
});

test('D) expedir lança SAÍDA uma única vez; encerrar conclui', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const out = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'divergência', itens: [{ item_compra_id: fx.itemId, quantidade: 3 }] } });
  const id = Number(out.devolucao.id);
  const antes = await saldo(fx.produtoId, fx.localId);

  await chamar(autorizarDevolucaoFornecedor, { id, actor: gerente });
  await chamar(expedirDevolucaoFornecedor, { id, actor: gerente });
  assert.equal(await saldo(fx.produtoId, fx.localId), antes - 3, 'expedição retira do estoque');

  // A movimentação carrega o vínculo com a devolução (rastreabilidade).
  const movs = await listRecords(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { devolucao_fornecedor_id: id } });
  assert.equal(movs.rows.length, 1);
  assert.equal(movs.rows[0].tipo, 'saida');

  // Expedir de novo é 409 — o saldo não baixa duas vezes.
  await assert.rejects(() => chamar(expedirDevolucaoFornecedor, { id, actor: gerente }), /autorizada/i);
  assert.equal(await saldo(fx.produtoId, fx.localId), antes - 3, 'sem baixa duplicada');

  const encerrada = await chamar(encerrarDevolucaoFornecedor, { id, actor: gerente });
  assert.equal(encerrada.status, 'encerrada');
});

test('E) cancelar só antes de expedir', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const out = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 2 }] } });
  const id = Number(out.devolucao.id);
  const cancelada = await chamar(cancelarDevolucaoFornecedor, { id, actor: gerente, body: { motivo: 'solicitação duplicada' } });
  assert.equal(cancelada.status, 'cancelada');
  assert.equal(cancelada.motivo_cancelamento, 'solicitação duplicada');

  // Cancelada não consome o recebido: dá para devolver os mesmos 2 de novo.
  const outra = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 2 }] } });
  const outraId = Number(outra.devolucao.id);
  await chamar(autorizarDevolucaoFornecedor, { id: outraId, actor: gerente });
  await chamar(expedirDevolucaoFornecedor, { id: outraId, actor: gerente });
  // Depois de expedida, cancelar é 409.
  await assert.rejects(() => chamar(cancelarDevolucaoFornecedor, { id: outraId, actor: gerente, body: { motivo: 'tarde demais' } }), /não pode ser cancelada/i);
});

test('F) idempotência da criação pela chave', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const chave = `dev-idem-${Date.now()}`;
  const primeira = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', idempotency_key: chave, itens: [{ item_compra_id: fx.itemId, quantidade: 1 }] } });
  assert.equal(primeira.replay, false);
  const segunda = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', idempotency_key: chave, itens: [{ item_compra_id: fx.itemId, quantidade: 1 }] } });
  assert.equal(segunda.replay, true);
  assert.equal(Number(segunda.devolucao.id), Number(primeira.devolucao.id), 'não cria dois documentos');
});

test('G) isolamento multiempresa: devolução de A não existe para B', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const out = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 1 }] } });
  const id = Number(out.devolucao.id);
  const gerenteB = await criarAtor(2, 'gerente');
  await assert.rejects(() => chamar(obterDevolucaoFornecedor, { id, actor: gerenteB }), /não encontrad|404|não pertence/i);
});

test('obter devolução devolve itens e resumo', async () => {
  const fx = await compraRecebida(1, 5, 10);
  const gerente = await criarAtor(1, 'gerente');
  const out = await chamar(criarDevolucaoFornecedor, { id: fx.compraId, actor: gerente, body: { motivo: 'x', itens: [{ item_compra_id: fx.itemId, quantidade: 2 }] } });
  const detalhe = await chamar(obterDevolucaoFornecedor, { id: Number(out.devolucao.id), actor: gerente });
  assert.equal(detalhe.itens.length, 1);
  assert.equal(detalhe.resumo.itens, 1);
  assert.equal(detalhe.resumo.total, 20, '2 × 10');
  assert.ok(detalhe.eventos.length >= 1, 'trilha de eventos registrada');
});
