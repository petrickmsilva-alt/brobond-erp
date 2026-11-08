// Integração do CRUD de promoções ESCOPADAS (0108) — modo memória, sem banco.
// Cobre: persistência de escopo/canal/prioridade, alvos produto/categoria
// (transacionais), isolamento multiempresa e o simulador de impacto.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');
const { criarPromocao, atualizarPromocao, listarPromocoes, simularPromocao, excluirPromocao } = await import('../src/commerce/promocoes');

const admin = { id: 1, name: 'Admin', email: 'admin@brobond.com.br', perfil: 'admin', empresa_id: 1, empresas: [1] };
function fakeReq(body: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return { user: admin, params, query: {}, body, headers: {}, ip: '127.0.0.1' } as any;
}
function fakeRes() {
  const out: any = { code: 200, body: null as unknown };
  out.json = (b: unknown) => { out.body = b; return out; };
  out.status = (c: number) => { out.code = c; return out; };
  out.setHeader = () => out;
  return out;
}

const s = getStore();
let produtoA: number;
let produtoB: number;
let categoria: number;
let usuarioId: number;

before(async () => {
  const usuarios = await s.list(RESOURCES.usuarios, { page: 1, pageSize: 5 });
  usuarioId = usuarios.rows.length
    ? Number(usuarios.rows[0].id)
    : Number((await s.insert(RESOURCES.usuarios, { nome: 'Admin Promo', email: `admin-promo-${Date.now()}@brobond.com.br`, perfil: 'admin', ativo: true })).id);
  admin.id = usuarioId;
  const cat = (await s.list(RESOURCES.categorias, { page: 1, pageSize: 5 })).rows[0];
  categoria = Number(cat.id);
  const sufixo = Date.now() % 1000000;
  produtoA = Number((await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: `PE-A-${sufixo}`, nome: 'Promo Alvo A', categoria_id: categoria, custo: 10, preco_venda: 30 })).id);
  produtoB = Number((await s.insert(RESOURCES.produtos, { empresa_id: 1, sku: `PE-B-${sufixo}`, nome: 'Promo Alvo B', categoria_id: categoria, custo: 10, preco_venda: 30 })).id);
});

const base = { tipo: 'percentual', valor: 10, data_inicio: '2020-01-01', ativo: true };

test('0108: criar promoção escopada por produto persiste escopo, canal, prioridade e alvos', async () => {
  const res = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Só o produto A', escopo: 'produto', canal: 'varejo', prioridade: 3, produtos: [produtoA] }), res);
  assert.equal(res.code, 201);
  assert.equal(res.body.promocao.escopo, 'produto');
  assert.equal(res.body.promocao.canal, 'varejo');
  assert.equal(res.body.promocao.prioridade, 3);
  assert.deepEqual(res.body.promocao.produtos, [produtoA]);

  const alvos = await s.list(RESOURCES.commerce_promocao_alvos, { page: 1, pageSize: 50, filter: { empresa_id: 1, promocao_id: Number(res.body.promocao.id) } });
  assert.equal(alvos.rows.length, 1);
  assert.equal(Number(alvos.rows[0].produto_id), produtoA);
});

test('0108: escopo produto exige ao menos um alvo (400)', async () => {
  await assert.rejects(
    () => criarPromocao(fakeReq({ ...base, nome: 'Sem alvo', escopo: 'produto', produtos: [] }), fakeRes()),
    (e: unknown) => e instanceof HttpError && e.status === 400
  );
});

test('0108: escopo categoria exige ao menos um alvo (400)', async () => {
  await assert.rejects(
    () => criarPromocao(fakeReq({ ...base, nome: 'Sem categoria', escopo: 'categoria', categorias: [] }), fakeRes()),
    (e: unknown) => e instanceof HttpError && e.status === 400
  );
});

test('0108: canal inválido é recusado (400)', async () => {
  await assert.rejects(
    () => criarPromocao(fakeReq({ ...base, nome: 'Canal errado', canal: 'atacadoo' }), fakeRes()),
    (e: unknown) => e instanceof HttpError && e.status === 400
  );
});

test('0108: escopo pedido ignora alvos (comportamento legado preservado)', async () => {
  const res = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Pedido inteiro', escopo: 'pedido', produtos: [produtoA] }), res);
  assert.equal(res.body.promocao.escopo, 'pedido');
  assert.deepEqual(res.body.promocao.produtos, []);
});

test('0108: atualizar troca escopo produto→categoria e substitui os alvos', async () => {
  const criada = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Troca de escopo', escopo: 'produto', produtos: [produtoA, produtoB] }), criada);
  const id = Number(criada.body.promocao.id);

  const res = fakeRes();
  await atualizarPromocao(fakeReq({ nome: 'Troca de escopo', escopo: 'categoria', categorias: [categoria] }, { id }), res);
  assert.equal(res.body.promocao.escopo, 'categoria');
  assert.deepEqual(res.body.promocao.categorias, [categoria]);
  assert.deepEqual(res.body.promocao.produtos, []);

  const alvos = await s.list(RESOURCES.commerce_promocao_alvos, { page: 1, pageSize: 50, filter: { empresa_id: 1, promocao_id: id } });
  assert.equal(alvos.rows.length, 1, 'os alvos antigos de produto foram substituídos');
  assert.equal(Number(alvos.rows[0].categoria_id), categoria);
});

test('0108: atualizar só o canal PRESERVA os alvos atuais (patch parcial)', async () => {
  const criada = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Patch canal', escopo: 'produto', canal: 'todos', produtos: [produtoA, produtoB] }), criada);
  const id = Number(criada.body.promocao.id);

  const res = fakeRes();
  await atualizarPromocao(fakeReq({ canal: 'varejo' }, { id }), res);
  assert.equal(res.body.promocao.canal, 'varejo');
  assert.deepEqual(res.body.promocao.produtos.sort((a: number, b: number) => a - b), [produtoA, produtoB].sort((a, b) => a - b), 'os alvos atuais foram preservados');

  const alvos = await s.list(RESOURCES.commerce_promocao_alvos, { page: 1, pageSize: 50, filter: { empresa_id: 1, promocao_id: id } });
  assert.equal(alvos.rows.length, 2);
});

test('0108: listar devolve os alvos por promoção', async () => {
  const res = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Listagem alvos', escopo: 'produto', produtos: [produtoA] }), res);
  const lista = fakeRes();
  await listarPromocoes(fakeReq(), lista);
  const alvo = (lista.body.promocoes as any[]).find((p) => p.nome === 'Listagem alvos');
  assert.deepEqual(alvo.produtos, [produtoA]);
});

test('0108: isolamento multiempresa — a empresa 2 não vê a promoção da empresa 1', async () => {
  const criada = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Exclusiva da 1', escopo: 'produto', produtos: [produtoA] }), criada);

  const atorEmpresa2 = { ...admin, empresa_id: 2, empresas: [2] };
  const req2 = { user: atorEmpresa2, params: {}, query: {}, body: {}, headers: {}, ip: '127.0.0.1' } as any;
  const lista2 = fakeRes();
  await listarPromocoes(req2, lista2);
  assert.equal((lista2.body.promocoes as any[]).some((p) => p.nome === 'Exclusiva da 1'), false);

  // E não consegue editar o registro da empresa 1.
  await assert.rejects(
    () => atualizarPromocao({ ...req2, params: { id: Number(criada.body.promocao.id) }, body: { nome: 'x' } } as any, fakeRes()),
    (e: unknown) => e instanceof HttpError && e.status === 404
  );
});

test('0108: simulador ranqueia candidatas e aplica a de maior desconto', async () => {
  // Promoção de pedido 10% e promoção só do produto A com valor fixo alto.
  await criarPromocao(fakeReq({ ...base, nome: 'Sim geral 10%', escopo: 'pedido', valor: 10 }), fakeRes());
  await criarPromocao(fakeReq({ ...base, nome: 'Sim produto A', tipo: 'valor', valor: 5, escopo: 'produto', produtos: [produtoA] }), fakeRes());

  const res = fakeRes();
  await simularPromocao(fakeReq({ itens: [{ produto_id: produtoA, quantidade: 1, preco_unitario: 100, categoria_id: categoria }, { produto_id: produtoB, quantidade: 1, preco_unitario: 100, categoria_id: categoria }] }), res);
  assert.equal(res.body.subtotal, 200);
  // 10% do pedido = 20 vence o valor fixo 5 do produto A.
  assert.equal(res.body.desconto_aplicado, 20);
  assert.equal(res.body.melhor.nome, 'Sim geral 10%');
  assert.ok(Array.isArray(res.body.candidatas) && res.body.candidatas.length >= 2);
});

test('0108: simulador respeita a elegibilidade de canal', async () => {
  await criarPromocao(fakeReq({ ...base, nome: 'Só atacado', escopo: 'pedido', canal: 'atacado', valor: 50 }), fakeRes());
  const res = fakeRes();
  await simularPromocao(fakeReq({ canal: 'varejo', itens: [{ produto_id: produtoA, quantidade: 1, preco_unitario: 100 }] }), res);
  const nomes = (res.body.candidatas as any[]).map((c) => c.nome);
  assert.equal(nomes.includes('Só atacado'), false, 'a promoção de atacado não aparece no varejo');
});

test('0108: simulador exige ao menos um item (400)', async () => {
  await assert.rejects(
    () => simularPromocao(fakeReq({ itens: [] }), fakeRes()),
    (e: unknown) => e instanceof HttpError && e.status === 400
  );
});

test('0108: excluir a promoção remove os alvos junto (sem órfãos)', async () => {
  const criada = fakeRes();
  await criarPromocao(fakeReq({ ...base, nome: 'Para excluir', escopo: 'produto', produtos: [produtoA] }), criada);
  const id = Number(criada.body.promocao.id);
  await excluirPromocao(fakeReq({}, { id }), fakeRes());
  const alvos = await s.list(RESOURCES.commerce_promocao_alvos, { page: 1, pageSize: 50, filter: { empresa_id: 1, promocao_id: id } });
  assert.equal(alvos.rows.length, 0);
});
