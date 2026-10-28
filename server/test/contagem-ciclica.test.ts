import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularClassificacaoAbc } from '../src/contagemCiclica';

test('ABC usa saídas, limiares explícitos, ordem determinística e inclui itens sem giro como C', () => {
  const consumo = new Map([[8, 80], [2, 15], [3, 5], [4, 0]]);
  const resultado = calcularClassificacaoAbc(consumo, [4, 9]);
  assert.deepEqual(resultado.map(({ produto_id, classe, prioridade }) => [produto_id, classe, prioridade]), [
    [8, 'A', 1], [2, 'B', 2], [3, 'C', 3], [4, 'C', 4], [9, 'C', 5],
  ]);
  assert.equal(resultado[0].percentual_acumulado, 80);
  assert.equal(resultado[1].percentual_acumulado, 95);
  assert.deepEqual(calcularClassificacaoAbc(consumo, [9]), resultado);
});

test('ABC totalmente sem saída classifica os produtos de forma estável como C', () => {
  assert.deepEqual(calcularClassificacaoAbc(new Map(), [7, 1, 5]).map(({ produto_id, classe }) => [produto_id, classe]), [
    [1, 'C'], [5, 'C'], [7, 'C'],
  ]);
});

test('ABC recusa faixas não monotônicas ou fora de 0–100', () => {
  assert.throws(() => calcularClassificacaoAbc(new Map(), [], 95, 80), /Faixas ABC inválidas/);
  assert.throws(() => calcularClassificacaoAbc(new Map(), [], 0, 95), /Faixas ABC inválidas/);
});

test('snapshots JSON da classificação ABC não são editáveis pelo formulário genérico', async () => {
  const { RESOURCES } = await import('../src/resources');
  const fields = new Map(RESOURCES.inventarios.fields.map((field) => [field.name, field]));
  for (const name of ['abc_faixas', 'abc_resultado']) {
    assert.equal(fields.get(name)?.type, 'json');
    assert.equal(fields.get(name)?.readonly, true);
    assert.equal(fields.get(name)?.form, false);
  }
});

test('fluxo cíclico usa snapshot canônico, tenant, conferência, aprovação e ajuste idempotente', async () => {
  process.env.NODE_ENV = 'test';
  delete process.env.DATABASE_URL;
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore, listRecords } = await import('../src/services');
  const { updateItensInventario, conferirContagemCiclica, aprovarContagemCiclica, fecharInventario } = await import('../src/estoque');
  const { criarContagemCiclica } = await import('../src/contagemCiclica');
  const store = getStore();
  const usuario = await store.insert(RESOURCES.usuarios, { nome: `ABC usuário ${Date.now()}`, email: `abc-${Date.now()}@example.test`, perfil: 'admin', empresa_id: 1, ativo: true });
  const admin = { id: Number(usuario.id), name: 'Admin ciclo', perfil: 'admin' as const, empresa_id: 1 };
  const gerente = { ...admin, perfil: 'gerente' as const };
  const operador = { ...admin, perfil: 'operador' as const };
  const request = (user: typeof admin | typeof gerente | typeof operador, params: Record<string, unknown> = {}, body: unknown = {}) => ({ user, params, query: {}, body, headers: {}, ip: '127.0.0.1' }) as any;
  const response = () => {
    const out: any = { statusCode: 200, body: null };
    out.status = (code: number) => { out.statusCode = code; return out; };
    out.json = (body: unknown) => { out.body = body; return out; };
    return out;
  };
  const suffix = `abc-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const categorias = (await store.list(RESOURCES.categorias, { page: 1, pageSize: 100 })).rows;
  assert.ok(categorias.length, 'fixture precisa de categoria');
  const local = await createRecord(RESOURCES.locais, { nome: suffix }, admin);
  const products = await Promise.all([8, 2, 0].map((_, index) => createRecord(RESOURCES.produtos, {
    sku: `${suffix}-${index}`, nome: `${suffix} produto ${index}`, categoria_id: Number(categorias[0].id), custo: 10, preco_venda: 20,
  }, admin)));
  for (let index = 0; index < products.length; index++) {
    const stock = index === 2 ? 3 : index === 0 ? 10 : 5;
    await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: Number(products[index].id), quantidade: stock, local_id: Number(local.id), motivo: 'fixture ABC' }, admin);
    if (index < 2) await createRecord(RESOURCES.movimentacoes, { tipo: 'saida', produto_id: Number(products[index].id), quantidade: index === 0 ? 8 : 2, local_id: Number(local.id), motivo: 'saída histórica ABC' }, admin);
  }
  const createRes = response();
  const planInput = { local_id: Number(local.id), periodo_inicio: '2000-01-01', periodo_fim: '2099-12-31', data_planejada: '2099-01-01', faixa_a: 80, faixa_b: 95, idempotency_key: `${suffix}-idem-001` };
  await criarContagemCiclica(request(gerente, {}, planInput), createRes);
  assert.equal(createRes.statusCode, 201);
  const plan = createRes.body as any;
  assert.equal(plan.modalidade, 'ciclica_abc');
  assert.equal(plan.contagem_status, 'PLANEJADA');
  assert.deepEqual(plan.abc_faixas, { A: 80, B: 95, C: 100, unidade: 'percentual cumulativo' });
  const repeated = response();
  await criarContagemCiclica(request(gerente, {}, planInput), repeated);
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.body.id, plan.id, 'mesma chave e mesmos parâmetros retornam o plano existente');

  const lines = await listRecords(RESOURCES.itens_inventario, { page: 1, pageSize: 100, filter: { inventario_id: Number(plan.id), empresa_id: 1 } });
  assert.equal(lines.rows.length, 3);
  const itemFor = (id: number) => lines.rows.find((line) => Number(line.produto_id) === id)!;
  assert.equal(itemFor(Number(products[0].id)).classificacao_abc, 'A');
  assert.equal(itemFor(Number(products[1].id)).classificacao_abc, 'B');
  assert.equal(itemFor(Number(products[2].id)).classificacao_abc, 'C');
  assert.deepEqual(lines.rows.map((line) => Number(line.saldo_sistema)).sort((a, b) => a - b), [2, 3, 3]);

  const foreign = { ...gerente, empresa_id: 999999 };
  await assert.rejects(() => import('../src/estoque').then(({ getInventarioDetalhe }) => getInventarioDetalhe(request(foreign, { id: String(plan.id) }), response())), (error: any) => error.status === 404);
  const allCounts = lines.rows.map((line) => ({ id: Number(line.id), contado: Number(line.saldo_sistema) - (Number(line.produto_id) === Number(products[0].id) ? 1 : 0) }));
  await updateItensInventario(request(operador, { id: String(plan.id) }, { itens: allCounts }), response());
  const beforeApproval = await fecharInventario(request(gerente, { id: String(plan.id) }), response()).catch((error: any) => error);
  assert.equal(beforeApproval.status, 409, 'fechar sem aprovação explícita deve ser recusado');
  await conferirContagemCiclica(request(gerente, { id: String(plan.id) }), response());
  await assert.rejects(() => aprovarContagemCiclica(request(operador, { id: String(plan.id) }), response()), (error: any) => error.status === 403);
  await aprovarContagemCiclica(request(gerente, { id: String(plan.id) }), response());
  const saldoCongeladoAntes = Number(itemFor(Number(products[0].id)).saldo_sistema);
  const result = response();
  await fecharInventario(request(gerente, { id: String(plan.id) }), result);
  assert.equal(result.body.ajustes, 1);
  const moved = await store.list(RESOURCES.movimentacoes, { page: 1, pageSize: 20, filter: { empresa_id: 1, inventario_id: Number(plan.id) } });
  assert.equal(moved.total, 1);
  assert.equal(Number(moved.rows[0].quantidade), -1);
  const closedItem = await store.findOneWhere(RESOURCES.itens_inventario, { id: itemFor(Number(products[0].id)).id, empresa_id: 1 });
  assert.equal(Number(closedItem?.saldo_sistema), saldoCongeladoAntes, 'snapshot fica imutável após ajuste');
  assert.equal(Number(closedItem?.diferenca), -1);
  assert.equal(Number(closedItem?.movimentacao_id), Number(moved.rows[0].id));
  const repeatClose = response();
  await fecharInventario(request(gerente, { id: String(plan.id) }), repeatClose);
  assert.equal(repeatClose.body.idempotente, true);
  assert.equal((await store.list(RESOURCES.movimentacoes, { page: 1, pageSize: 20, filter: { empresa_id: 1, inventario_id: Number(plan.id) } })).total, 1);
});

test('faccionamento registra proprietário/custódia e reusa movimentações/consumo e apontamento da OP', async () => {
  process.env.NODE_ENV = 'test';
  delete process.env.DATABASE_URL;
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore, listRecords } = await import('../src/services');
  const { registrarEventoTerceirizacao, listarEventosTerceirizacao } = await import('../src/terceirizacao');
  const { consumoLiquidoDaOrdem, criarApontamento, concluirOrdemHandler } = await import('../src/producao');
  const store = getStore();
  const userRow = await store.insert(RESOURCES.usuarios, { nome: `Faccao usuário ${Date.now()}`, email: `faccao-${Date.now()}@example.test`, perfil: 'admin', empresa_id: 1, ativo: true });
  const admin = { id: Number(userRow.id), name: 'Admin facção', perfil: 'admin' as const, empresa_id: 1 };
  const request = (params: Record<string, unknown> = {}, body: unknown = {}) => ({ user: admin, params, query: {}, body, headers: {}, ip: '127.0.0.1' }) as any;
  const response = () => { const out: any = { statusCode: 200, body: null }; out.status = (code: number) => { out.statusCode = code; return out; }; out.json = (body: unknown) => { out.body = body; return out; }; return out; };
  const suffix = `fac-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const category = (await store.list(RESOURCES.categorias, { page: 1, pageSize: 100 })).rows.find((row) => !Number(row.grade_id))!;
  const size = (await store.list(RESOURCES.tamanhos, { page: 1, pageSize: 20 })).rows[0];
  const third = await createRecord(RESOURCES.terceiros_operacionais!, { nome: `${suffix} oficina`, ativo: true }, admin);
  const product = await createRecord(RESOURCES.produtos, { sku: `${suffix}-PA`, nome: `${suffix} produto`, categoria_id: Number(category.id), custo: 10, preco_venda: 20 }, admin);
  const order = await createRecord(RESOURCES.ordens, { produto_id: Number(product.id), tipo: 'tamanho', tamanho_id: Number(size.id), quantidade: 1, terceiro_id: Number(third.id) }, admin);
  await store.update(RESOURCES.ordens, Number(order.id), { status: 'liberada' });
  const insumo = await createRecord(RESOURCES.insumos, { nome: `${suffix} tecido`, unidade: 'm', custo_medio: 4 }, admin);
  await createRecord(RESOURCES.movimentacoes_insumos, { tipo: 'entrada', insumo_id: Number(insumo.id), quantidade: 10, custo_unitario: 4, motivo: 'fixture', }, admin);
  const shipmentBody = {
    terceiro_id: Number(third.id), evento: 'ENVIO_INSUMO', tipo_material: 'insumo', insumo_id: Number(insumo.id), quantidade: 3,
    proprietario_tipo: 'empresa', custodiante_anterior_tipo: 'empresa', custodiante_novo_tipo: 'terceiro', custodiante_novo_terceiro_id: Number(third.id),
    idempotency_key: `${suffix}-ship-001`,
  };
  const sent = response();
  await registrarEventoTerceirizacao(request({ id: String(order.id) }, shipmentBody), sent);
  assert.equal(sent.statusCode, 201);
  assert.equal(Number(sent.body.movimentacao_insumo_id) > 0, true);
  assert.equal(Number(await store.insumoStock(Number(insumo.id), undefined, 1)), 7);
  const retry = response();
  await registrarEventoTerceirizacao(request({ id: String(order.id) }, shipmentBody), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotente, true);
  assert.equal(Number(await store.insumoStock(Number(insumo.id), undefined, 1)), 7, 'replay não duplica baixa');
  const returnBody = {
    terceiro_id: Number(third.id), evento: 'RETORNO_INSUMO', tipo_material: 'insumo', insumo_id: Number(insumo.id), quantidade: 1,
    proprietario_tipo: 'empresa', custodiante_anterior_tipo: 'terceiro', custodiante_anterior_terceiro_id: Number(third.id), custodiante_novo_tipo: 'empresa',
    referencia_evento_id: Number(sent.body.id), idempotency_key: `${suffix}-return-001`,
  };
  const returned = response();
  await registrarEventoTerceirizacao(request({ id: String(order.id) }, returnBody), returned);
  assert.equal(Number(await store.insumoStock(Number(insumo.id), undefined, 1)), 8);
  assert.equal((await consumoLiquidoDaOrdem(Number(order.id), { empresaId: 1, consolidado: false, permitidas: [1] })).get(Number(insumo.id))?.qtd, 2, 'retorno compensa a saída na mesma trilha de movimentos da OP');

  const outputEvent = response();
  await registrarEventoTerceirizacao(request({ id: String(order.id) }, {
    terceiro_id: Number(third.id), evento: 'RETORNO_PRODUTO', tipo_material: 'produto', produto_id: Number(product.id), quantidade: 1,
    proprietario_tipo: 'empresa', custodiante_anterior_tipo: 'terceiro', custodiante_anterior_terceiro_id: Number(third.id), custodiante_novo_tipo: 'empresa',
    idempotency_key: `${suffix}-output-001`,
  }), outputEvent);
  const apontado = response();
  await criarApontamento({ ...request({ id: String(order.id) }, { tamanho_id: Number(size.id), quantidade_produzida: 1, quantidade_perdida: 0, eventos_custodia_ids: [Number(outputEvent.body.id)], idempotency_key: `${suffix}-point-001` }), query: {} } as any, apontado);
  assert.equal(apontado.statusCode, 201);
  const linked = await store.findOneWhere(RESOURCES.terceirizacao_eventos!, { id: Number(outputEvent.body.id), empresa_id: 1 });
  assert.equal(Number(linked?.apontamento_id), Number(apontado.body.id));
  const eventsResponse = response();
  await listarEventosTerceirizacao(request({ id: String(order.id) }), eventsResponse);
  assert.equal(eventsResponse.body.length, 3);
  await concluirOrdemHandler(request({ id: String(order.id) }, {}), response());
  const outputMovements = await store.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { empresa_id: 1, produto_id: Number(product.id), ordem_id: Number(order.id), tipo: 'entrada' } });
  assert.equal(outputMovements.total, 1, 'produto acabado entra uma única vez pelo fechamento canônico da OP');

  // Isolamento nominal empresa A × empresa B para terceiros_operacionais e
  // terceirizacao_eventos: empresa B não lista o terceiro da empresa A, nem lê
  // ou acrescenta evento à OP da empresa A.
  const escopoB = { kind: 'empresa', empresaId: 2 } as any;
  const terceirosB = await listRecords(RESOURCES.terceiros_operacionais!, { page: 1, pageSize: 100 }, escopoB);
  assert.ok(!terceirosB.rows.some((row) => Number(row.id) === Number(third.id)));
  const actorB = { ...admin, empresa_id: 2 };
  await assert.rejects(
    () => listarEventosTerceirizacao({ ...request({ id: String(order.id) }), user: actorB } as any, response()),
    (error: any) => error.status === 404,
  );
  await assert.rejects(
    () => registrarEventoTerceirizacao({ ...request({ id: String(order.id) }, shipmentBody), user: actorB } as any, response()),
    (error: any) => error.status === 404,
  );
});
