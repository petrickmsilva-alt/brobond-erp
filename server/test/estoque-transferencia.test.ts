// ============================================================================
// ESTOQUE 3.0 — TRANSFERÊNCIA FORMAL, RESERVA E DISPONIBILIDADE (migration 0052)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) o documento nasce SOLICITADA e NÃO mexe no saldo;
//   B) aprovar exige disponível (físico − comprometido) e não duplica saldo;
//   C) expedir lança SAÍDA na origem (via movimentação oficial);
//   D) receber lança ENTRADA no destino e aceita recebimento parcial;
//   E) cancelar só antes da expedição;
//   F) transições inválidas são 409 (sem "meia transferência");
//   G) reserva comprometida reduz o disponível e liberar devolve — sem
//      movimentar estoque;
//   H) isolamento multiempresa: documento de A não existe para B.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const {
  calcularDisponibilidade,
  criarTransferencia,
  aprovarTransferencia,
  expedirTransferencia,
  receberTransferencia,
  cancelarTransferencia,
  criarReserva,
  liberarReserva,
  detalharTransferencia,
} = await import('../src/estoqueTransferencia');
const { escopoDeSistema } = await import('../src/empresa');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const empresaA = escopoDeSistema(1);
const empresaB = escopoDeSistema(2);

let atorGerente: any;
let atorOperador: any;
let atorB: any;
let produtoId: number;
let origemId: number;
let destinoId: number;

/** Executa um handler Express de teste e devolve o JSON. */
async function chamar(handler: any, opts: { id?: number; body?: any; actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: opts.id ? { id: String(opts.id) } : {}, body: opts.body ?? {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

async function saldo(produto: number, localId: number): Promise<number> {
  const lista = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 50, filter: { produto_id: produto, local_id: localId } });
  return lista.rows.reduce((t, r) => t + Number(r.quantidade ?? 0), 0);
}

before(async () => {
  getStore();
  atorGerente = await criarAtor(1, 'gerente');
  atorOperador = await criarAtor(1, 'operador');
  atorB = await criarAtor(2, 'gerente');
  const p = await createRecord(RESOURCES.produtos, { sku: `TRF-${Date.now() % 100000}`, nome: 'Camisa Transferência', custo: 10, preco_venda: 30 }, admin);
  produtoId = Number(p.id);
  const o = await createRecord(RESOURCES.locais, { nome: `origem-trf-${Date.now() % 100000}`, tipo: 'expedicao' }, admin);
  origemId = Number(o.id);
  const d = await createRecord(RESOURCES.locais, { nome: `destino-trf-${Date.now() % 100000}`, tipo: 'loja' }, admin);
  destinoId = Number(d.id);
  // 10 peças na origem (entrada oficial).
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, quantidade: 10, local_id: origemId }, admin);
});

test('A) documento nasce SOLICITADA e NÃO altera o saldo', async () => {
  const antes = await saldo(produtoId, origemId);
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 4 }] },
  });
  assert.equal(doc.status, 'solicitada');
  assert.equal(doc.itens.length, 1);
  assert.equal(Number(doc.itens[0].quantidade), 4);
  assert.equal(await saldo(produtoId, origemId), antes, 'solicitar não movimenta estoque');
  assert.equal(await saldo(produtoId, destinoId), 0);
});

test('F) transições inválidas são 409 (expedir sem aprovar, receber antes de expedir)', async () => {
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 2 }] },
  });
  await assert.rejects(() => chamar(expedirTransferencia, { id: Number(doc.id), actor: atorGerente }), /não pode ser expedida/);
  await assert.rejects(() => chamar(receberTransferencia, { id: Number(doc.id), actor: atorGerente }), /não pode ser recebida/);
});

test('C+D) aprovar → expedir (saída na origem) → receber (entrada no destino)', async () => {
  const origemAntes = await saldo(produtoId, origemId);
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 3 }] },
  });
  await chamar(aprovarTransferencia, { id: Number(doc.id), actor: atorGerente });
  await chamar(expedirTransferencia, { id: Number(doc.id), actor: atorGerente });

  assert.equal(await saldo(produtoId, origemId), origemAntes - 3, 'expedição retira da origem');
  const emTransito = await listRecords(RESOURCES.estoque_transferencias, { page: 1, pageSize: 10, filter: { id: Number(doc.id) } });
  assert.equal(emTransito.rows[0].status, 'em_transito');

  await chamar(receberTransferencia, { id: Number(doc.id), actor: atorGerente });
  assert.equal(await saldo(produtoId, destinoId), 3, 'recebimento entra no destino');
  const final = await listRecords(RESOURCES.estoque_transferencias, { page: 1, pageSize: 10, filter: { id: Number(doc.id) } });
  assert.equal(final.rows[0].status, 'recebida');
  assert.ok(final.rows[0].recebida_em);

  // Eventos: solicitada → aprovada → em_transito → recebida
  const eventos = await listRecords(RESOURCES.estoque_transferencia_eventos, { page: 1, pageSize: 50, filter: { transferencia_id: Number(doc.id) } });
  const ordem = eventos.rows
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((e) => e.status_novo);
  assert.deepEqual(ordem, ['solicitada', 'aprovada', 'em_transito', 'recebida']);
});

test('B) aprovar recusa quando o disponível não cobre o pedido', async () => {
  const disponivelAtual = await saldo(produtoId, origemId);
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: disponivelAtual + 5 }] },
  });
  await assert.rejects(() => chamar(aprovarTransferencia, { id: Number(doc.id), actor: atorGerente }), /Disponível|insuficiente/i);
});

test('RBAC: operador não aprova, nem expede nem recebe', async () => {
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 1 }] },
  });
  await assert.rejects(() => chamar(aprovarTransferencia, { id: Number(doc.id), actor: atorOperador }), /gerentes e administradores|gerente ou administrador/i);
});

test('E) cancelar só antes da expedição e exige motivo', async () => {
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 1 }] },
  });
  await assert.rejects(() => chamar(cancelarTransferencia, { id: Number(doc.id), actor: atorGerente, body: {} }), /motivo/i);
  const cancelada = await chamar(cancelarTransferencia, { id: Number(doc.id), actor: atorGerente, body: { motivo: 'Solicitação duplicada' } });
  assert.equal(cancelada.status, 'cancelada');
  assert.equal(cancelada.motivo_cancelamento, 'Solicitação duplicada');

  // Depois de expedida, cancelar é 409.
  const outra = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 1 }] },
  });
  await chamar(aprovarTransferencia, { id: Number(outra.id), actor: atorGerente });
  await chamar(expedirTransferencia, { id: Number(outra.id), actor: atorGerente });
  await assert.rejects(
    () => chamar(cancelarTransferencia, { id: Number(outra.id), actor: atorGerente, body: { motivo: 'tarde demais' } }),
    /não pode ser cancelada/
  );
});

test('D) recebimento parcial aceita quantidade menor e mantém a diferença fora do destino', async () => {
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 2 }] },
  });
  await chamar(aprovarTransferencia, { id: Number(doc.id), actor: atorGerente });
  await chamar(expedirTransferencia, { id: Number(doc.id), actor: atorGerente });
  const detalhe = await chamar(receberTransferencia, {
    id: Number(doc.id),
    actor: atorGerente,
    body: { itens: [{ item_id: Number(doc.itens[0].id), quantidade_recebida: 1 }] },
  });
  assert.equal(detalhe.status, 'recebida');
  assert.equal(Number(detalhe.itens[0].quantidade_recebida), 1);
});

test('G) reserva reduz o disponível, liberar devolve — sem movimentar estoque', async () => {
  const fisicoAntes = await saldo(produtoId, origemId);
  const dispAntes = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  const disponivelAntes = dispAntes.reduce((t, l) => t + l.disponivel, 0);

  const reserva = await chamar(criarReserva, {
    actor: atorGerente,
    body: { produto_id: produtoId, local_id: origemId, tipo: 'reserva', quantidade: 2, motivo: 'Separação de venda' },
  });
  assert.equal(reserva.status, 'ativa');

  const dispComReserva = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  const reservado = dispComReserva.reduce((t, l) => t + l.reservado, 0);
  assert.equal(reservado, 2);
  assert.equal(dispComReserva.reduce((t, l) => t + l.disponivel, 0), disponivelAntes - 2);
  assert.equal(await saldo(produtoId, origemId), fisicoAntes, 'reserva não movimenta estoque');

  await chamar(liberarReserva, { id: Number(reserva.id), actor: atorGerente });
  const dispLiberada = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  assert.equal(dispLiberada.reduce((t, l) => t + l.reservado, 0), 0);
  assert.equal(dispLiberada.reduce((t, l) => t + l.disponivel, 0), disponivelAntes);
});

test('G) reserva recusa quantidade acima do disponível', async () => {
  const disp = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  const disponivel = disp.reduce((t, l) => t + l.disponivel, 0);
  await assert.rejects(
    () => chamar(criarReserva, { actor: atorGerente, body: { produto_id: produtoId, local_id: origemId, quantidade: disponivel + 1 } }),
    /Disponível insuficiente/
  );
});

test('bloqueio e empenho entram na conta do disponível, cada um no seu tipo', async () => {
  const dispAntes = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  const disponivelAntes = dispAntes.reduce((t, l) => t + l.disponivel, 0);
  await chamar(criarReserva, { actor: atorGerente, body: { produto_id: produtoId, local_id: origemId, tipo: 'bloqueio', quantidade: 1, motivo: 'Qualidade' } });
  await chamar(criarReserva, { actor: atorGerente, body: { produto_id: produtoId, local_id: origemId, tipo: 'empenho', quantidade: 1, motivo: 'OP programada' } });
  const disp = await calcularDisponibilidade(getStore(), empresaA, { produto_id: produtoId, local_id: origemId });
  assert.equal(disp.reduce((t, l) => t + l.bloqueado, 0), 1);
  assert.equal(disp.reduce((t, l) => t + l.empenhado, 0), 1);
  assert.equal(disp.reduce((t, l) => t + l.disponivel, 0), disponivelAntes - 2);
});

test('H) isolamento multiempresa: B não enxerga a transferência de A', async () => {
  const doc = await chamar(criarTransferencia, {
    actor: atorGerente,
    body: { origem_local_id: origemId, destino_local_id: destinoId, itens: [{ produto_id: produtoId, quantidade: 1 }] },
  });
  await assert.rejects(() => chamar(detalharTransferencia, { id: Number(doc.id), actor: atorB }), /não encontrad/i);
  const listaB = await listRecords(RESOURCES.estoque_transferencias, { page: 1, pageSize: 50 }, empresaB);
  assert.equal(listaB.rows.some((r) => Number(r.id) === Number(doc.id)), false);
});
