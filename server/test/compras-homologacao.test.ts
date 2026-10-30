// ============================================================================
// COMPRAS 3.0 — HOMOLOGAÇÃO DE FORNECEDOR (migration 0053)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) fornecedor nasce PENDENTE — homologação não é presumida;
//   B) PENDENTE não "pula" para HOMOLOGADO (422) e não cria evento;
//   C) PENDENTE → EM_ANALISE grava o evento na trilha;
//   D) homologar exige categoria + documento e recusa certidão vencida;
//   E) HOMOLOGADO carimba data e limpa o motivo;
//   F) suspender/bloquear exige MOTIVO (400) e suspender grava trilha;
//   G) só ADMIN tira de BLOQUEADO (gerente 403);
//   H) fornecedor suspenso não recebe pedido NOVO (409) — pedido anterior fica;
//   I) desempenho é CALCULADO (fatores explicáveis), nunca gravado;
//   J) painel de compras agrega homologação sem inventar dado.
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const {
  alterarHomologacao,
  homologacaoDoFornecedor,
  desempenhoDoFornecedor,
  painelDeCompras,
} = await import('../src/comprasFornecedor');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

let gerente: any;
let operador: any;

async function chamar(handler: any, opts: { id?: number; body?: any; actor: any }) {
  let payload: any;
  const req: any = { params: opts.id ? { id: String(opts.id) } : {}, body: opts.body ?? {}, user: opts.actor, query: {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

const erro = async (fn: () => Promise<unknown>): Promise<{ status: number; message: string }> => {
  try {
    await fn();
  } catch (e: any) {
    return { status: Number(e.status ?? e.statusCode ?? 0), message: String(e.message ?? '') };
  }
  throw new Error('esperava erro, mas a operação passou');
};

let seq = 0;
async function novoFornecedor(extra: Record<string, unknown> = {}) {
  seq++;
  const f = await createRecord(RESOURCES.fornecedores, { nome: `Fornecedor Homolog ${seq}-${Date.now() % 100000}`, pessoa: 'pj', indicador_ie: '1', ...extra }, admin);
  return Number(f.id);
}

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  operador = await criarAtor(1, 'operador');
});

test('A) fornecedor nasce PENDENTE', async () => {
  const id = await novoFornecedor();
  const vista = await chamar(homologacaoDoFornecedor, { id, actor: gerente });
  assert.equal(vista.status, 'pendente');
  assert.equal(vista.fornecedor.status, 'pendente');
  assert.deepEqual(vista.proximos, ['em_analise', 'bloqueado']);
  assert.equal(vista.eventos.length, 0, 'cadastro não é homologação: nenhum evento sem processo');
});

test('B) PENDENTE não pula para HOMOLOGADO', async () => {
  const id = await novoFornecedor({ homologacao_categoria: 'materia_prima' });
  const e = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'homologado' }, actor: gerente }));
  assert.equal(e.status, 422);
  assert.match(e.message, /Não é possível ir de Pendente para Homologado/);
  const vista = await chamar(homologacaoDoFornecedor, { id, actor: gerente });
  assert.equal(vista.eventos.length, 0);
});

test('C) EM_ANALISE grava evento na trilha', async () => {
  const id = await novoFornecedor();
  const r = await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente });
  assert.equal(r.status, 'em_analise');
  assert.equal(r.alterado, true);
  const vista = await chamar(homologacaoDoFornecedor, { id, actor: gerente });
  assert.equal(vista.eventos.length, 1);
  assert.equal(vista.eventos[0].status_anterior, 'pendente');
  assert.equal(vista.eventos[0].status_novo, 'em_analise');
});

test('D) homologar exige categoria, documento e certidão válida', async () => {
  const id = await novoFornecedor();
  await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente });

  // sem categoria nem documento
  const semNada = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'homologado' }, actor: gerente }));
  assert.equal(semNada.status, 422);
  assert.match(semNada.message, /categoria de fornecimento/);

  // categoria, mas nenhum documento
  const semDoc = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'homologado', categoria: 'embalagem' }, actor: gerente }));
  assert.equal(semDoc.status, 422);
  assert.match(semDoc.message, /ao menos um documento/);

  // documento APROVADO e VENCIDO
  await createRecord(RESOURCES.fornecedor_documentos, { fornecedor_id: id, tipo: 'certidao_federal', numero: 'X1', validade: '2020-01-01', situacao: 'aprovado' }, admin);
  const vencido = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'homologado', categoria: 'embalagem' }, actor: gerente }));
  assert.equal(vencido.status, 422);
  assert.match(vencido.message, /vencido/);
});

test('E) HOMOLOGADO carimba data, limpa motivo e grava evento', async () => {
  const id = await novoFornecedor();
  await createRecord(RESOURCES.fornecedor_documentos, { fornecedor_id: id, tipo: 'cartao_cnpj', numero: 'Y2', validade: '2099-12-31', situacao: 'aprovado' }, admin);
  await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente });
  const r = await chamar(alterarHomologacao, { id, body: { status: 'homologado', categoria: 'materia_prima' }, actor: gerente });
  assert.equal(r.status, 'homologado');
  const forn = await getStore().get(RESOURCES.fornecedores, id);
  assert.equal(forn?.homologacao_status, 'homologado');
  assert.ok(forn?.homologado_em, 'homologado_em é obrigatório (o CHECK do banco também exige)');
  assert.equal(forn?.homologacao_motivo, null);
  const vista = await chamar(homologacaoDoFornecedor, { id, actor: gerente });
  assert.equal(vista.pendencias.length, 0);
  assert.equal(vista.eventos.length, 2);
});

test('F) suspender/bloquear exige motivo', async () => {
  const id = await novoFornecedor();
  await createRecord(RESOURCES.fornecedor_documentos, { fornecedor_id: id, tipo: 'cartao_cnpj', validade: '2099-12-31', situacao: 'aprovado' }, admin);
  await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente });
  await chamar(alterarHomologacao, { id, body: { status: 'homologado', categoria: 'servico' }, actor: gerente });

  const semMotivo = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'suspenso' }, actor: gerente }));
  assert.equal(semMotivo.status, 400);
  assert.match(semMotivo.message, /motivo/);

  const ok = await chamar(alterarHomologacao, { id, body: { status: 'suspenso', motivo: 'Atraso recorrente na entrega' }, actor: gerente });
  assert.equal(ok.status, 'suspenso');
  const forn = await getStore().get(RESOURCES.fornecedores, id);
  assert.equal(forn?.homologacao_motivo, 'Atraso recorrente na entrega');
  const vista = await chamar(homologacaoDoFornecedor, { id, actor: gerente });
  assert.equal(vista.eventos[0].motivo, 'Atraso recorrente na entrega');
});

test('G) só ADMIN tira de BLOQUEADO', async () => {
  const id = await novoFornecedor();
  await chamar(alterarHomologacao, { id, body: { status: 'bloqueado', motivo: 'Irregularidade fiscal' }, actor: gerente });
  const negado = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente }));
  assert.equal(negado.status, 403);
  assert.match(negado.message, /administrador/i);
  const ok = await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: admin });
  assert.equal(ok.status, 'em_analise');
});

test('H) fornecedor suspenso não recebe pedido NOVO', async () => {
  const id = await novoFornecedor();
  await createRecord(RESOURCES.fornecedor_documentos, { fornecedor_id: id, tipo: 'cartao_cnpj', validade: '2099-12-31', situacao: 'aprovado' }, admin);
  await chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: gerente });
  await chamar(alterarHomologacao, { id, body: { status: 'homologado', categoria: 'logistica' }, actor: gerente });

  // pedido enquanto homologado: passa
  const pedidoOk = await createRecord(RESOURCES.compras, { fornecedor_id: id, data: '2026-01-10', status: 'pendente', total: 100 }, admin);
  assert.ok(pedidoOk.id);

  // suspende e tenta comprar de novo
  await chamar(alterarHomologacao, { id, body: { status: 'suspenso', motivo: 'Qualidade' }, actor: gerente });
  const e = await erro(() => createRecord(RESOURCES.compras, { fornecedor_id: id, data: '2026-02-10', status: 'pendente', total: 50 }, admin));
  assert.equal(e.status, 409);
  assert.match(e.message, /não pode receber pedido novo/);

  // o pedido ANTERIOR continua existindo (história não é reescrita)
  const lista = await listRecords(RESOURCES.compras, { page: 1, pageSize: 50, filter: { fornecedor_id: id } });
  assert.equal(lista.rows.length, 1);

  // e um fornecedor PENDENTE (sem processo concluído) continua comprando:
  // a regra bloqueia suspenso/bloqueado, não inventa bloqueio para pendente.
  const pendente = await novoFornecedor();
  const pedidoPendente = await createRecord(RESOURCES.compras, { fornecedor_id: pendente, data: '2026-02-11', status: 'pendente', total: 10 }, admin);
  assert.ok(pedidoPendente.id);
});

test('I) desempenho é calculado a partir de dados existentes', async () => {
  const id = await novoFornecedor();
  const insumo = await createRecord(RESOURCES.insumos, { nome: `Tecido Desemp ${Date.now() % 100000}`, unidade: 'm' }, admin);
  const compra = await createRecord(
    RESOURCES.compras,
    { fornecedor_id: id, data: '2026-01-05', status: 'pendente', total: 100, previsao_entrega: '2026-01-10' },
    admin
  );
  await createRecord(RESOURCES.itens_compra, { compra_id: Number(compra.id), insumo_id: Number(insumo.id), quantidade: 10, preco_unitario: 10 }, admin);
  await chamar((await import('../src/compras')).aprovarCompra, { id: Number(compra.id), actor: admin });
  await getStore().update(RESOURCES.compras, Number(compra.id), { status: 'recebido', recebida_em: '2026-01-12' });

  const d = await chamar(desempenhoDoFornecedor, { id, actor: gerente });
  assert.equal(d.historico.pedidos, 1);
  assert.equal(d.historico.recebidos, 1);
  assert.equal(d.prazo.no_prazo, 0, 'recebido 2 dias depois da previsão não é "no prazo"');
  assert.equal(d.prazo.atraso_medio_dias, 2);
  assert.ok(Array.isArray(d.fatores) && d.fatores.length >= 4, 'cada parcela do score é explicável');
  assert.ok(d.score >= 0 && d.score <= 100);
  // nada foi gravado no cadastro do fornecedor
  const forn = await getStore().get(RESOURCES.fornecedores, id);
  assert.equal(forn?.avaliacao_manual ?? null, null);
});

test('J) painel de compras agrega sem inventar dado', async () => {
  const p = await chamar(painelDeCompras, { actor: gerente });
  assert.ok(p.pedidos.total >= 0);
  assert.ok(Array.isArray(p.proximas_entregas));
  assert.ok(Array.isArray(p.documentos_vencendo));
  assert.ok(Array.isArray(p.homologacao.bloqueados));
  assert.ok(String(p.regra).includes('derivados'));
});

test('K) operador não altera homologação', async () => {
  const id = await novoFornecedor();
  const e = await erro(() => chamar(alterarHomologacao, { id, body: { status: 'em_analise' }, actor: operador }));
  assert.equal(e.status, 403);
});
