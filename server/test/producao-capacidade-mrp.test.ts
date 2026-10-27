// ============================================================================
// PRODUÇÃO 3.0 — CAPACIDADE, CARGA, GARGALO E MRP (migration 0054)
//
// O que este arquivo prova (modo demonstração, mesmo contrato do PostgreSQL):
//   A) recurso sem OP tem ocupação 0 e nenhum gargalo inventado;
//   B) carga = o que ainda falta produzir; capacidade = diária × dias úteis ×
//      eficiência (números explícitos, não "achismo");
//   C) o gargalo é o recurso de maior ocupação — e OP concluída sai da conta;
//   D) OP sem recurso NÃO desaparece: aparece em `sem_recurso`;
//   E) MRP: venda em aberto gera falta de produto; falta de produto explode em
//      insumo pela ficha técnica com perda;
//   F) compra em aberto cobre necessidade de insumo sem dar entrada;
//   G) MRP NÃO cria pedido de compra (contagem invariante);
//   H) produto sem ficha técnica aparece em `sem_ficha` (nada é inventado).
// ============================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, listRecords, getStore } = await import('../src/services');
const { capacidadeProducao, mrpProducao } = await import('../src/producaoCapacidade');
const { criarAtor, garantirAdmin } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
let gerente: any;

async function chamar(handler: any, opts: { actor: any; query?: any }) {
  let payload: any;
  const req: any = { params: {}, body: {}, user: opts.actor, query: opts.query ?? {} };
  await handler(req, { json: (v: any) => (payload = v) });
  return payload;
}

let seq = 0;
const unico = () => `${Date.now() % 100000}-${++seq}`;

let clienteId = 0;

before(async () => {
  getStore();
  gerente = await criarAtor(1, 'gerente');
  // Venda exige cliente: sem ele o teste provaria menos do que a produção exige.
  const c = await createRecord(RESOURCES.clientes, { nome: `Cliente MRP ${unico()}`, pessoa: 'pf', documento: '52998224725' }, admin);
  clienteId = Number(c.id);
});

async function novoProduto(nome: string) {
  const p = await createRecord(RESOURCES.produtos, { sku: `MRP-${unico()}`, nome, custo: 10, preco_venda: 30 }, admin);
  return Number(p.id);
}

test('A) recurso sem OP: ocupação 0, sem gargalo', async () => {
  const rec = await createRecord(RESOURCES.producao_recursos, { nome: `Costura Vazia ${unico()}`, tipo: 'costura', capacidade_diaria: 10, eficiencia_pct: 100 }, admin);
  const out = await chamar(capacidadeProducao, { actor: gerente, query: { de: '2026-03-02', ate: '2026-03-06' } });
  const linha = out.recursos.find((r: any) => r.recurso_id === Number(rec.id));
  assert.ok(linha, 'o recurso ativo aparece na capacidade mesmo sem carga');
  assert.equal(linha.carga, 0);
  assert.equal(linha.ocupacao_pct, 0);
  assert.equal(out.dias_uteis, 5, 'seg a sex de 02/03/2026 a 06/03/2026');
});

test('B) carga = falta produzir; capacidade = diária × dias úteis × eficiência', async () => {
  const rec = await createRecord(RESOURCES.producao_recursos, { nome: `Costura Carga ${unico()}`, tipo: 'costura', capacidade_diaria: 10, eficiencia_pct: 100 }, admin);
  const produto = await novoProduto(`Camisa Carga ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `T-${unico()}`, codigo: `C${unico()}` }, admin);
  await createRecord(
    RESOURCES.ordens,
    { produto_id: produto, tipo: 'tamanho', tamanho_id: Number(tamanho.id), quantidade: 30, status: 'planejada', previsao: '2026-04-06', recurso_id: Number(rec.id) },
    admin
  );
  const out = await chamar(capacidadeProducao, { actor: gerente, query: { de: '2026-04-06', ate: '2026-04-10' } });
  const linha = out.recursos.find((r: any) => r.recurso_id === Number(rec.id));
  assert.equal(linha.carga, 30);
  assert.equal(linha.capacidade_periodo, 50, '10 peças/dia × 5 dias úteis');
  assert.equal(linha.ocupacao_pct, 60);
});

test('C) gargalo é o recurso mais ocupado e OP concluída sai da carga', async () => {
  const folgado = await createRecord(RESOURCES.producao_recursos, { nome: `Folgado ${unico()}`, tipo: 'bordado', capacidade_diaria: 100 }, admin);
  const apertado = await createRecord(RESOURCES.producao_recursos, { nome: `Apertado ${unico()}`, tipo: 'costura', capacidade_diaria: 10 }, admin);
  const produto = await novoProduto(`Camisa Gargalo ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `G-${unico()}`, codigo: `G${unico()}` }, admin);

  await createRecord(RESOURCES.ordens, { produto_id: produto, tipo: 'tamanho', tamanho_id: Number(tamanho.id), quantidade: 10, status: 'planejada', previsao: '2026-05-04', recurso_id: Number(folgado.id) }, admin);
  await createRecord(RESOURCES.ordens, { produto_id: produto, tipo: 'tamanho', tamanho_id: Number(tamanho.id), quantidade: 45, status: 'em_producao', previsao: '2026-05-04', recurso_id: Number(apertado.id) }, admin);
  // OP concluída no mesmo período: NÃO é carga
  const concluida = await createRecord(RESOURCES.ordens, { produto_id: produto, tipo: 'tamanho', tamanho_id: Number(tamanho.id), quantidade: 99, status: 'planejada', previsao: '2026-05-04', recurso_id: Number(apertado.id) }, admin);
  await getStore().update(RESOURCES.ordens, Number(concluida.id), { status: 'concluida' });

  const out = await chamar(capacidadeProducao, { actor: gerente, query: { de: '2026-05-04', ate: '2026-05-08' } });
  const a = out.recursos.find((r: any) => r.recurso_id === Number(apertado.id));
  const f = out.recursos.find((r: any) => r.recurso_id === Number(folgado.id));
  assert.equal(a.carga, 45, 'a OP concluída não entra na carga');
  assert.equal(f.carga, 10);
  assert.equal(a.gargalo, true);
  assert.equal(f.gargalo, false);
  assert.equal(out.resumo.gargalo.recurso_id, Number(apertado.id));
});

test('D) OP sem recurso aparece em sem_recurso (não desaparece)', async () => {
  const produto = await novoProduto(`Camisa Sem Recurso ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `S-${unico()}`, codigo: `S${unico()}` }, admin);
  await createRecord(RESOURCES.ordens, { produto_id: produto, tipo: 'tamanho', tamanho_id: Number(tamanho.id), quantidade: 7, status: 'planejada', previsao: '2026-06-01' }, admin);
  const out = await chamar(capacidadeProducao, { actor: gerente, query: { de: '2026-06-01', ate: '2026-06-05' } });
  assert.ok(out.sem_recurso.some((o: any) => o.faltam === 7));
  assert.ok(out.resumo.ordens_sem_recurso >= 1);
});

test('E) MRP: venda em aberto → falta de produto → necessidade de insumo', async () => {
  const produto = await novoProduto(`Camisa MRP ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `M-${unico()}`, codigo: `M${unico()}` }, admin);
  const insumo = await createRecord(RESOURCES.insumos, { nome: `Tecido MRP ${unico()}`, unidade: 'm', custo_medio: 5 }, admin);
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: produto, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 2, perda_pct: 10 }, admin);
  // estoque físico 5 peças
  await createRecord(RESOURCES.estoques, { produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 5 }, admin);
  // venda em aberto de 25 peças
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-07-01', total: 100 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 25, preco_unitario: 10 }, admin);

  const out = await chamar(mrpProducao, { actor: gerente });
  const linha = out.produtos.find((p: any) => p.produto_id === produto && p.tamanho_id === Number(tamanho.id));
  assert.ok(linha, 'a falta do produto aparece no MRP');
  assert.equal(linha.demanda, 25);
  assert.equal(linha.estoque, 5);
  assert.equal(linha.falta, 20);

  const ins = out.insumos.find((i: any) => i.insumo_id === Number(insumo.id));
  assert.ok(ins, 'o insumo da ficha entra na necessidade');
  // 20 peças × 2 m × 1,10 (perda) = 44 m
  assert.equal(ins.necessaria, 44);
  assert.equal(ins.disponivel, 0);
  assert.equal(ins.faltando, 44);
});

test('F) compra em aberto cobre a necessidade sem dar entrada no estoque', async () => {
  const produto = await novoProduto(`Camisa Cobertura ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `C-${unico()}`, codigo: `K${unico()}` }, admin);
  const insumo = await createRecord(RESOURCES.insumos, { nome: `Tecido Cobertura ${unico()}`, unidade: 'm' }, admin);
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: produto, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 1, perda_pct: 0 }, admin);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-08-01', total: 10 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 10, preco_unitario: 1 }, admin);

  // sem compra: falta 10
  const antes = await chamar(mrpProducao, { actor: gerente });
  assert.equal(antes.insumos.find((i: any) => i.insumo_id === Number(insumo.id)).faltando, 10);

  // compra aprovada de 6 m (não recebida) reduz a falta para 4
  const fornecedor = await createRecord(RESOURCES.fornecedores, { nome: `Forn Cobertura ${unico()}`, pessoa: 'pj', indicador_ie: '1' }, admin);
  const compra = await createRecord(RESOURCES.compras, { fornecedor_id: Number(fornecedor.id), data: '2026-08-01', status: 'aprovado', total: 30 }, admin);
  await createRecord(RESOURCES.itens_compra, { compra_id: Number(compra.id), insumo_id: Number(insumo.id), quantidade: 6, preco_unitario: 5 }, admin);

  const depois = await chamar(mrpProducao, { actor: gerente });
  const ins = depois.insumos.find((i: any) => i.insumo_id === Number(insumo.id));
  assert.equal(ins.em_compra, 6);
  assert.equal(ins.faltando, 4);
  // e o saldo do insumo NÃO subiu: compra em aberto não é entrada
  assert.equal(ins.disponivel, 0);
});

test('G) MRP não cria pedido de compra', async () => {
  const antes = await listRecords(RESOURCES.compras, { page: 1, pageSize: 1 });
  await chamar(mrpProducao, { actor: gerente });
  await chamar(mrpProducao, { actor: gerente });
  const depois = await listRecords(RESOURCES.compras, { page: 1, pageSize: 1 });
  assert.equal(depois.total, antes.total, 'MRP é leitura: nenhum pedido é criado automaticamente');
});

test('H) produto sem ficha aparece em sem_ficha', async () => {
  const produto = await novoProduto(`Sem BOM ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `X-${unico()}`, codigo: `X${unico()}` }, admin);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-09-01', total: 10 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 3, preco_unitario: 1 }, admin);
  const out = await chamar(mrpProducao, { actor: gerente });
  assert.ok(out.sem_ficha.some((p: any) => p.produto_id === produto));
});
