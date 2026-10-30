// ============================================================================
// ONDA 4 / D1 — CUSTOMER PLATFORM (atendimento, Customer 360 e segmentação).
//
// Prova, com o store real (memdb em test), que:
//   • o ticket resolve o SLA da prioridade e gera número por empresa;
//   • a trilha de interações é append-only e registra as transições;
//   • o Customer 360 deriva receita/ticket médio/LTV de vendas REAIS;
//   • o isolamento por empresa bloqueia acesso cruzado;
//   • a segmentação avalia regras contra dados reais e respeita consentimento.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { getStore } = await import('../src/services');
const { RESOURCES } = await import('../src/resources');
const { abrirTicket, transicionarTicket, interagirTicket, painelAtendimento, customer360, avaliarSegmento } = await import('../src/service');

// Atores com IDs reais de usuário (o ticket grava `criado_por`/`responsavel_id`
// com FK real para `usuarios` — não se inventa um id).
const s = getStore();
const uGerenteA = await s.insert(RESOURCES.usuarios, { empresa_id: 1, nome: 'Gerente A', email: 'ga@x.invalid', perfil: 'gerente', senha_hash: 'x' });
const uOperadorA = await s.insert(RESOURCES.usuarios, { empresa_id: 1, nome: 'Operador A', email: 'oa@x.invalid', perfil: 'operador', senha_hash: 'x' });
const uGerenteB = await s.insert(RESOURCES.usuarios, { empresa_id: 2, nome: 'Gerente B', email: 'gb@x.invalid', perfil: 'gerente', senha_hash: 'x' });

const GERENTE_A = { id: Number(uGerenteA.id), name: 'Gerente A', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
const OPERADOR_A = { id: Number(uOperadorA.id), name: 'Operador A', perfil: 'operador' as const, empresa_id: 1, empresas: [1] };
const GERENTE_B = { id: Number(uGerenteB.id), name: 'Gerente B', perfil: 'gerente' as const, empresa_id: 2, empresas: [2] };

function req(body: object = {}, params: object = {}, user: any = GERENTE_A) {
  return { body, params, user, query: {}, get: () => 'key' } as any;
}
function res() {
  let body: any; let status = 200;
  const out: any = { json(v: any) { body = v; return out; }, status(v: number) { status = v; return out; }, setHeader() {} };
  return { out, get: () => ({ body, status }) };
}
async function call(handler: any, body: object = {}, params: object = {}, user: any = GERENTE_A) {
  const r = res();
  await handler(req(body, params, user), r.out);
  return r.get().body;
}

/** Semeia SLA, cliente e venda faturada para a empresa 1. */
async function semear() {
  const s = getStore();
  await s.insert(RESOURCES.service_sla_politicas, { empresa_id: 1, nome: 'SLA Alta', prioridade: 'alta', resposta_horas: 4, resolucao_horas: 24, ativo: true });
  const cliente = await s.insert(RESOURCES.clientes, { empresa_id: 1, nome: 'Cliente Real', email: 'c@x.invalid' });
  const produto = await s.insert(RESOURCES.produtos, { empresa_id: 1, nome: 'Camisa Teste' });
  const venda = await s.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: Number(cliente.id), status: 'faturada', total: 300, faturada_em: '2026-01-10T00:00:00.000Z' });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(produto.id), quantidade: 3, preco_unitario: 100, subtotal: 300 });
  return { clienteId: Number(cliente.id), produtoId: Number(produto.id) };
}

test('D1: abertura de ticket resolve SLA, gera número por empresa e grava a abertura', async () => {
  const s = getStore();
  const { clienteId } = await semear();
  const criado = await call(abrirTicket, { cliente_id: clienteId, assunto: 'Peça com defeito', prioridade: 'alta', canal: 'whatsapp' });
  assert.equal(criado.numero, 'TKT-000001');
  assert.equal(criado.status, 'aberto');
  assert.ok(criado.prazo_resposta_em && criado.prazo_resolucao_em, 'SLA deve ser derivado da política');
  const inter = await s.list(RESOURCES.service_ticket_interacoes, { page: 1, pageSize: 10, filter: { empresa_id: 1, ticket_id: Number(criado.id) } });
  assert.equal(inter.total, 1);
  assert.equal(inter.rows[0].status_novo, 'aberto');
});

test('D1: abertura exige cliente da própria empresa e assunto', async () => {
  await assert.rejects(() => call(abrirTicket, { cliente_id: 1 }, {}, GERENTE_A), (e: any) => e.status === 400);
  await assert.rejects(() => call(abrirTicket, { cliente_id: 1, assunto: 'x' }, {}, GERENTE_B), (e: any) => e.status === 404);
});

test('D1: transição é idempotente, marca marcos de SLA e registra trilha', async () => {
  const s = getStore();
  const { clienteId } = await semear();
  const criado = await call(abrirTicket, { cliente_id: clienteId, assunto: 'Troca', prioridade: 'alta' });
  const id = Number(criado.id);
  const emAtendimento = await call(transicionarTicket, { status: 'em_atendimento' }, { id });
  assert.equal(emAtendimento.status, 'em_atendimento');
  assert.ok(emAtendimento.primeira_resposta_em, 'primeira resposta deve ser carimbada');
  // Repetir a mesma transição não cria nova interação (idempotente).
  const antes = (await s.list(RESOURCES.service_ticket_interacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, ticket_id: id } })).total;
  await call(transicionarTicket, { status: 'em_atendimento' }, { id });
  const depois = (await s.list(RESOURCES.service_ticket_interacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, ticket_id: id } })).total;
  assert.equal(antes, depois);
  const resolvido = await call(transicionarTicket, { status: 'resolvido', resolucao: 'Peça substituída' }, { id });
  assert.equal(resolvido.status, 'resolvido');
  assert.ok(resolvido.resolvido_em, 'resolver carimba a data de resolução');
});

test('D1: interação grava nota/resposta e respeita escopo de empresa', async () => {
  const { clienteId } = await semear();
  const criado = await call(abrirTicket, { cliente_id: clienteId, assunto: 'Dúvida', prioridade: 'alta' });
  const id = Number(criado.id);
  const resposta = await call(interagirTicket, { tipo: 'resposta', mensagem: 'Estamos verificando.' }, { id });
  assert.equal(resposta.tipo, 'resposta');
  assert.equal(resposta.publico, true);
  // Empresa B não enxerga nem interage com o ticket da empresa A.
  await assert.rejects(() => call(interagirTicket, { tipo: 'nota', mensagem: 'x' }, { id }, GERENTE_B), (e: any) => e.status === 404);
});

test('D1: painel agrega situações reais e RBAC de escrita', async () => {
  const { clienteId } = await semear();
  await call(abrirTicket, { cliente_id: clienteId, assunto: 'A', prioridade: 'alta' });
  await call(abrirTicket, { cliente_id: clienteId, assunto: 'B', prioridade: 'alta' });
  const painel = await call(painelAtendimento);
  assert.equal(painel.total >= 2, true);
  assert.equal(painel.abertos >= 2, true);
  // Operador não tem alçada de atendimento (minPerfil gerente).
  await assert.rejects(() => call(abrirTicket, { cliente_id: clienteId, assunto: 'C', prioridade: 'alta' }, {}, OPERADOR_A), (e: any) => e.status === 403);
});

test('D1: Customer 360 deriva receita, ticket médio e LTV de vendas reais', async () => {
  const s = getStore();
  const { clienteId, produtoId } = await semear();
  const venda2 = await s.insert(RESOURCES.vendas, { empresa_id: 1, cliente_id: clienteId, status: 'entregue', total: 200, faturada_em: '2026-02-01T00:00:00.000Z' });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda2.id), produto_id: produtoId, quantidade: 2, preco_unitario: 100, subtotal: 200 });
  const c360 = await call(customer360, {}, { id: clienteId });
  assert.equal(c360.metricas.receita_total, 500);
  assert.equal(c360.metricas.pedidos, 2);
  assert.equal(c360.metricas.ticket_medio, 250);
  assert.equal(c360.metricas.ltv, 500);
  assert.ok(c360.produtos.length >= 1);
  assert.ok(!JSON.stringify(c360).includes('undefined'));
});

test('D1: Customer 360 bloqueia cliente de outra empresa', async () => {
  const s = getStore();
  const clienteB = await s.insert(RESOURCES.clientes, { empresa_id: 2, nome: 'Cliente B' });
  await assert.rejects(() => call(customer360, {}, { id: Number(clienteB.id) }, GERENTE_A), (e: any) => e.status === 404);
});

test('D1: segmentação avalia regra RFV e consentimento contra dados reais', async () => {
  const s = getStore();
  const { clienteId } = await semear();
  const seg = await s.insert(RESOURCES.customer_segments, { empresa_id: 1, nome: 'Compradores', regra: { frequencia_min: 1, valor_min: 100 } });
  const avaliacao = await call(avaliarSegmento, {}, { id: Number(seg.id) });
  assert.equal(avaliacao.total >= 1, true);
  assert.ok(avaliacao.clientes.some((c: any) => c.id === clienteId));
  // Segmento que exige consentimento de marketing não alcança quem não consentiu.
  const segConsent = await s.insert(RESOURCES.customer_segments, { empresa_id: 1, nome: 'Com consentimento', regra: { frequencia_min: 1, consentimento_marketing: true } });
  const semConsent = await call(avaliarSegmento, {}, { id: Number(segConsent.id) });
  assert.equal(semConsent.clientes.some((c: any) => c.id === clienteId), false);
  await s.insert(RESOURCES.customer_consents, { empresa_id: 1, cliente_id: clienteId, finalidade: 'marketing', concedido: true });
  const comConsent = await call(avaliarSegmento, {}, { id: Number(segConsent.id) });
  assert.equal(comConsent.clientes.some((c: any) => c.id === clienteId), true);
});
