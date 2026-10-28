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
const { createRecord, listRecords, getStore, lancarMovimentacaoInsumoDaOrdem } = await import('../src/services');
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

// ============================================================================
// CORREÇÃO FINAL — MRP SEM DUPLA CONTAGEM E COM ESCOPO DECLARADO
//
// Cada caso aqui existe para impedir um jeito concreto de contar a mesma
// quantidade duas vezes. Se alguém "otimizar" a fórmula, estes testes caem.
// ============================================================================

test('I) reserva ATIVA não é contada como oferta (físico − comprometido)', async () => {
  const produto = await novoProduto(`Camisa Reserva ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `R-${unico()}`, codigo: `R${unico()}` }, admin);
  // 10 peças físicas, das quais 10 estão reservadas para outro documento.
  await createRecord(RESOURCES.estoques, { produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 10 }, admin);
  await createRecord(
    RESOURCES.estoque_reservas,
    { produto_id: produto, tamanho_id: Number(tamanho.id), tipo: 'reserva', quantidade: 10, status: 'ativa', motivo: `Reserva ${unico()}` },
    admin
  );
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-09-01', total: 60 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 6, preco_unitario: 10 }, admin);

  const out = await chamar(mrpProducao, { actor: gerente });
  const linha = out.produtos.find((p: any) => p.produto_id === produto && p.tamanho_id === Number(tamanho.id));
  assert.ok(linha, 'a falta aparece porque o físico está comprometido');
  assert.equal(linha.estoque_fisico, 10, 'físico continua visível para auditoria');
  assert.equal(linha.reservado, 10, 'o comprometido é explicitado');
  assert.equal(linha.estoque_disponivel, 0, 'disponível = físico − reservado (nada livre)');
  assert.equal(linha.falta, 6, 'a mesma peça não cobre a venda: falta tudo');
  assert.equal(out.produtos.filter((p: any) => p.produto_id === produto).length, 1, 'uma linha por produto/tamanho');
});

test('J) OP aberta entra pelo que FALTA produzir (não pelo total) e não duplica a demanda', async () => {
  const produto = await novoProduto(`Camisa OP ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `O-${unico()}`, codigo: `O${unico()}` }, admin);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-09-02', total: 100 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 10, preco_unitario: 10 }, admin);
  // OP de 40 peças com 30 já produzidas → 10 restantes cobrem a demanda inteira.
  const op = await createRecord(
    RESOURCES.ordens,
    { produto_id: produto, tipo: 'tamanho', quantidade: 40, status: 'em_producao', tamanho_id: Number(tamanho.id) },
    admin
  );
  // `quantidade_produzida` é readonly na API (quem escreve é o apontamento).
  // No teste gravamos direto no store para simular as 30 peças já apontadas.
  await getStore().update(RESOURCES.ordens, Number(op.id), { quantidade_produzida: 30 });

  const out = await chamar(mrpProducao, { actor: gerente });
  const linha = out.produtos.find((p: any) => p.produto_id === produto);
  assert.equal(linha, undefined, 'demanda 10 = OP 10 restantes → não há falta (nada contado duas vezes)');
  const resumo = out.resumo;
  assert.equal(typeof resumo.pecas_em_falta, 'number');
});

test('K) estoque mínimo entra apenas como DÉFICIT (nunca em cima da demanda)', async () => {
  const produto = await novoProduto(`Camisa Mínimo ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `N-${unico()}`, codigo: `N${unico()}` }, admin);
  await createRecord(RESOURCES.estoques, { produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 2, estoque_min: 8 }, admin);

  const out = await chamar(mrpProducao, { actor: gerente });
  const linha = out.produtos.find((p: any) => p.produto_id === produto);
  assert.ok(linha, 'abaixo do mínimo há necessidade de reposição');
  assert.equal(linha.demanda_vendas, 0);
  assert.equal(linha.demanda_estoque_minimo, 6, 'deficit = 8 (mínimo) − 2 (disponível)');
  assert.equal(linha.demanda, 6);
  assert.equal(linha.falta, 6);
});

test('L) compra aberta entra por (pedido − recebido): recebido já está no saldo', async () => {
  const produto = await novoProduto(`Camisa Compra Parcial ${unico()}`);
  const tamanho = await createRecord(RESOURCES.tamanhos, { nome: `P-${unico()}`, codigo: `P${unico()}` }, admin);
  const insumo = await createRecord(RESOURCES.insumos, { nome: `Tecido Parcial ${unico()}`, unidade: 'm' }, admin);
  const ficha = await createRecord(RESOURCES.fichas, { produto_id: produto, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(ficha.id), insumo_id: Number(insumo.id), consumo: 1, perda_pct: 0 }, admin);
  const venda = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: '2026-09-03', total: 100 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(venda.id), produto_id: produto, tamanho_id: Number(tamanho.id), quantidade: 10, preco_unitario: 10 }, admin);
  const compra = await createRecord(RESOURCES.compras, { fornecedor_id: 1, status: 'parcial', data: '2026-09-01' }, admin);
  // 10 pedidas, 4 já recebidas (e já refletidas no saldo) → só 6 estão a caminho.
  await createRecord(RESOURCES.itens_compra, { compra_id: Number(compra.id), insumo_id: Number(insumo.id), quantidade: 10, preco_unitario: 2 }, admin);
  const itemCompra = (await listRecords(RESOURCES.itens_compra, { page: 1, pageSize: 5, filter: { compra_id: Number(compra.id) } }, { kind: 'empresa', empresaId: 1 } as any)).rows[0];
  // 4 já recebidas (readonly na API; o recebimento é quem escreve).
  await getStore().update(RESOURCES.itens_compra, Number(itemCompra.id), { quantidade_recebida: 4 });

  const out = await chamar(mrpProducao, { actor: gerente });
  const ins = out.insumos.find((i: any) => i.insumo_id === Number(insumo.id));
  assert.equal(ins.em_compra, 6, 'só o saldo pendente da compra é oferta futura');
  assert.equal(ins.faltando, 4, '10 de necessidade − 6 a caminho');
});

test('M) MRP declara o que é, o que cobre e o que NÃO cobre — e não cria compra', async () => {
  const antes = await listRecords(RESOURCES.compras, { page: 1, pageSize: 1, filter: {} }, { kind: 'empresa', empresaId: 1 } as any);
  const out = await chamar(mrpProducao, { actor: gerente });
  const depois = await listRecords(RESOURCES.compras, { page: 1, pageSize: 1, filter: {} }, { kind: 'empresa', empresaId: 1 } as any);

  assert.equal(depois.total, antes.total, 'MRP NUNCA cria pedido de compra');
  assert.equal(out.calculo.tipo, 'mrp_planejamento_necessidade');
  assert.equal(out.calculo.cria_pedido_de_compra, false);
  assert.ok(String(out.calculo.titulo).includes('planejamento/necessidade'));
  // A declaração de escopo é o contrato do MRP: se a implementação passa a
  // cobrir algo, o texto muda JUNTO — e o teste exige a lista NOVA, mais
  // específica. Nada aqui foi afrouxado: os itens que continuam fora do escopo
  // seguem declarados (e são justamente os que exigiriam APS/lote econômico).
  assert.ok(out.calculo.nao_coberto.some((x: string) => x.includes('lote mínimo')), 'lote econômico segue declarado como fora do escopo');
  assert.ok(out.calculo.nao_coberto.some((x: string) => x.includes('sequenciamento')), 'APS/sequenciamento segue declarado como fora do escopo');
  // P2-15: o calendário de feriados passou a ser COBERTO (migration 0062) — o
  // que sai do escopo agora é o feriado MÓVEL derivado (Carnaval etc.), que a
  // empresa cadastra por ano.
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('feriados')), 'calendário de feriados passou a ser COBERTO');
  assert.ok(out.calculo.calendario, 'o MRP devolve o calendário que usou');
  assert.equal(typeof out.calculo.calendario.dias_uteis, 'number');
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('compras abertas')));
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('lead time')), 'lead time passou a ser COBERTO (fornecedores.prazo_entrega_dias)');
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('consumo REAL')), 'consumo real da OP passou a ser COBERTO');
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('multinível')), 'BOM multinível passou a ser COBERTO');
  assert.ok(out.calculo.coberto.some((x: string) => x.includes('capacidade produtiva')), 'capacidade passou a ser sinalizada no MRP');
  assert.equal(out.calculo.cria_pedido_de_compra, false);
  assert.ok(out.calculo.bom_multinivel, 'a resposta declara a explosão multinível');
  assert.ok(out.calculo.bom_multinivel.limite_de_profundidade > 0);
  assert.deepEqual(out.calculo.bom_multinivel.ciclos, [], 'sem BOM circular na base de teste');
});

test('N) MRP não vaza dados de outra empresa', async () => {
  const empresaB = { kind: 'empresa', empresaId: 2 } as any;
  const produtoB = await createRecord(RESOURCES.produtos, { sku: `MRPB-${unico()}`, nome: `Produto B ${unico()}`, custo: 1, preco_venda: 2 }, { id: 999, name: 'Admin B', perfil: 'admin' } as any, { escopo: empresaB });
  const clienteB = await createRecord(
    RESOURCES.clientes,
    { nome: `Cliente B ${unico()}`, pessoa: 'pf', documento: '52998224725' },
    { id: 999, name: 'Admin B', perfil: 'admin' } as any,
    { escopo: empresaB }
  );
  const vendaB = await createRecord(RESOURCES.vendas, { cliente_id: Number(clienteB.id), status: 'aberta', data: '2026-09-04', total: 50 }, { id: 999, name: 'Admin B', perfil: 'admin' } as any, { escopo: empresaB });
  const tamanhoB = await createRecord(
    RESOURCES.tamanhos,
    { nome: `B-${unico()}`, codigo: `B${unico()}` },
    { id: 999, name: 'Admin B', perfil: 'admin' } as any,
    { escopo: empresaB }
  );
  await createRecord(
    RESOURCES.itens_venda,
    { venda_id: Number(vendaB.id), produto_id: Number(produtoB.id), tamanho_id: Number(tamanhoB.id), quantidade: 9, preco_unitario: 5 },
    { id: 999, name: 'Admin B', perfil: 'admin' } as any,
    { escopo: empresaB }
  );

  const outA = await chamar(mrpProducao, { actor: gerente });
  assert.ok(!outA.produtos.some((p: any) => p.produto_id === Number(produtoB.id)), 'demanda da empresa B não aparece no MRP de A');
});


test('O) MRP agregado: reconcilia demanda, reserva, OP, consumo, compra no horizonte, BOM, lead time, calendário e ciclo', async () => {
  const de = '2030-01-07'; // segunda-feira
  const ate = '2030-01-11'; // sexta-feira: cinco dias úteis
  const root = await novoProduto(`Agregado raiz ${unico()}`);
  const child = await novoProduto(`Agregado componente ${unico()}`);
  const cycleA = await novoProduto(`Agregado ciclo A ${unico()}`);
  const cycleB = await novoProduto(`Agregado ciclo B ${unico()}`);
  const size = await createRecord(RESOURCES.tamanhos, { nome: `AG-${unico()}`, codigo: `AG${unico()}` }, admin);
  const raw = await createRecord(RESOURCES.insumos, { nome: `Agregado insumo ${unico()}`, unidade: 'm', custo_medio: 2 }, admin);

  // Demanda 30; saldo físico 7, dos quais 3 reservados; uma OP de 10, já
  // produzida em 4. Disponível 4 + restante da OP 6 = 10; falta produzir 20.
  await createRecord(RESOURCES.estoques, { produto_id: root, tamanho_id: Number(size.id), quantidade: 7 }, admin);
  await createRecord(RESOURCES.estoque_reservas, { produto_id: root, tamanho_id: Number(size.id), tipo: 'reserva', quantidade: 3, status: 'ativa', motivo: `Agregado ${unico()}` }, admin);
  const sale = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, status: 'aberta', data: de, total: 300 }, admin);
  await createRecord(RESOURCES.itens_venda, { venda_id: Number(sale.id), produto_id: root, tamanho_id: Number(size.id), quantidade: 30, preco_unitario: 10 }, admin);
  const op = await createRecord(RESOURCES.ordens, { produto_id: root, tipo: 'tamanho', tamanho_id: Number(size.id), quantidade: 10, status: 'em_producao', previsao: '2030-01-10' }, admin);
  await getStore().update(RESOURCES.ordens, Number(op.id), { quantidade_produzida: 4 });

  // BOM raiz: 0.5 m × 1.10 perda por peça. Componente: 2 por raiz; sua
  // ficha usa 0.25 m × 1.20. Para 26 peças de necessidade: 14.3 + 15.6 = 29.9m.
  const rootRecipe = await createRecord(RESOURCES.fichas, { produto_id: root, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(rootRecipe.id), insumo_id: Number(raw.id), consumo: 0.5, perda_pct: 10 }, admin);
  const childRecipe = await createRecord(RESOURCES.fichas, { produto_id: child, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(childRecipe.id), insumo_id: Number(raw.id), consumo: 0.25, perda_pct: 20 }, admin);
  await createRecord(RESOURCES.produto_composicao, { produto_id: root, componente_id: child, quantidade: 2 }, admin);
  // Ciclo separado anexado à BOM para verificar corte determinístico do ramo.
  await createRecord(RESOURCES.produto_composicao, { produto_id: root, componente_id: cycleA, quantidade: 1 }, admin);
  await createRecord(RESOURCES.produto_composicao, { produto_id: cycleA, componente_id: cycleB, quantidade: 1 }, admin);
  await createRecord(RESOURCES.produto_composicao, { produto_id: cycleB, componente_id: cycleA, quantidade: 1 }, admin);

  // Estoque de insumo 5; a saída canônica associada à OP consome 3, deixando 2.
  await createRecord(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(raw.id), quantidade: 5, custo_unitario: 2, motivo: 'Abertura do cenário agregado' }, admin);
  await getStore().transaction((tx: any) => lancarMovimentacaoInsumoDaOrdem(
    { tipo: 'saida', insumo_id: Number(raw.id), quantidade: 3, custo_unitario: 2, ordem_id: Number(op.id), motivo: 'Consumo real agregado' },
    admin as any,
    tx,
    { kind: 'empresa', empresaId: 1 } as any,
  ));

  const supplier = await createRecord(RESOURCES.fornecedores, { nome: `Fornecedor lead ${unico()}`, pessoa: 'pj', indicador_ie: '1', prazo_entrega_dias: 2 }, admin);
  const inHorizon = await createRecord(RESOURCES.compras, { fornecedor_id: Number(supplier.id), data: de, status: 'aprovado', total: 10 }, admin);
  await createRecord(RESOURCES.itens_compra, { compra_id: Number(inHorizon.id), insumo_id: Number(raw.id), quantidade: 5, preco_unitario: 2 }, admin);
  const late = await createRecord(RESOURCES.compras, { fornecedor_id: Number(supplier.id), data: ate, status: 'aprovado', total: 40 }, admin);
  await createRecord(RESOURCES.itens_compra, { compra_id: Number(late.id), insumo_id: Number(raw.id), quantidade: 20, preco_unitario: 2 }, admin);

  // OP fora do horizonte deve continuar listada, mas sua BOM não entra neste plano.
  const outsideProduct = await novoProduto(`Agregado fora horizonte ${unico()}`);
  const outsideRaw = await createRecord(RESOURCES.insumos, { nome: `Insumo fora horizonte ${unico()}`, unidade: 'm' }, admin);
  const outsideRecipe = await createRecord(RESOURCES.fichas, { produto_id: outsideProduct, mao_obra: 0, custos_indiretos: 0, margem_pct: 0 }, admin);
  await createRecord(RESOURCES.itens_ficha_tecnica, { ficha_id: Number(outsideRecipe.id), insumo_id: Number(outsideRaw.id), consumo: 1, perda_pct: 0 }, admin);
  const outsideOrder = await createRecord(RESOURCES.ordens, { produto_id: outsideProduct, tipo: 'tamanho', tamanho_id: Number(size.id), quantidade: 100, status: 'planejada', previsao: '2030-01-12' }, admin);

  const out = await chamar(mrpProducao, { actor: gerente, query: { de, ate } });
  const productLine = out.produtos.find((p: any) => p.produto_id === root && p.tamanho_id === Number(size.id));
  assert.ok(productLine);
  assert.equal(productLine.demanda_vendas, 30);
  assert.equal(productLine.estoque_fisico, 7);
  assert.equal(productLine.reservado, 3);
  assert.equal(productLine.estoque_disponivel, 4);
  assert.equal(productLine.em_producao, 6);
  assert.equal(productLine.falta, 20);
  assert.equal(out.ordens.find((row: any) => row.ordem_id === Number(op.id)).restante, 6);
  assert.equal(out.ordens.find((row: any) => row.ordem_id === Number(outsideOrder.id)).dentro_do_horizonte, false);
  assert.ok(!out.insumos.some((row: any) => row.insumo_id === Number(outsideRaw.id)), 'a BOM da OP fora do horizonte não entra nas necessidades atuais');

  const material = out.insumos.find((row: any) => row.insumo_id === Number(raw.id));
  assert.ok(material);
  assert.equal(material.necessaria, 29.9, '26 × (0.5×1.10 + 2×0.25×1.20) = 29.9');
  assert.equal(material.consumo_real, 3);
  assert.equal(material.necessario_comprar, 26.9);
  assert.equal(material.disponivel, 2, 'entrada 5 − saída real 3');
  assert.equal(material.em_compra, 5, 'somente a compra com recebimento esperado até 11/01 cobre');
  assert.equal(material.em_compra_fora_do_horizonte, 20);
  assert.equal(material.lead_time_dias, 2);
  assert.equal(material.lead_time_fornecedor, supplier.nome);
  assert.equal(material.cobertura, 7);
  assert.equal(material.faltando, 19.9, '26.9 líquidos − 2 em saldo − 5 em compra');
  assert.equal(out.calculo.horizonte.de, de);
  assert.equal(out.calculo.horizonte.ate, ate);
  assert.equal(out.calculo.calendario.dias_uteis, 5);
  assert.equal(out.resumo.ciclos_bom, 1);
  assert.equal(out.calculo.bom_multinivel.ciclos[0].produto_id, cycleA);
  assert.equal(out.calculo.bom_multinivel.componentes.find((c: any) => c.produto_id === child).quantidade, 52);
});
