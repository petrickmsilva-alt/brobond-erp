// ============================================================================
// PRODUÇÃO — FASE E2
//
// Cobre os gaps fechados nesta fase (docs/ERP-GAPS.md):
//   GAP-PROD-ESTADOS          máquina de estados (liberada/parcial + transições)
//   GAP-PROD-PERDAS           peça refugada consome insumo e não entra no estoque
//   GAP-PROD-CUSTO-OP         custo previsto (liberação) × custo real (execução)
//   GAP-PROD-CONSUMO-VINCULO  consumo ligado à OP pela FK ordem_id
//   GAP-PROD-APONTAMENTOS     apontamento de produção com idempotência
//   GAP-PROD-EVENTOS          trilha de transições
//   GAP-ESTQ-ORDEM-ID         entrada de produto acabado ligada à OP pela FK
//
// Regra que não pode quebrar: SEM apontamento, a OP se comporta EXATAMENTE como
// antes da E2 (entra a quantidade planejada e a ficha é baixada por inteiro).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { getStore, updateRecord } = await import('../src/services');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoLocal, novoProduto, novoTamanho, reqDe } = await import('./_p1util');
const producao = await import('../src/producao');

await garantirAdmin();
await novoLocal('loja');
const GERENTE = await criarAtor(1, 'gerente');
const OPERADOR = await criarAtor(1, 'operador');

const s = () => getStore();

// ---------------------------------------------------------------------------
// Fábricas
// ---------------------------------------------------------------------------

async function novoInsumo(nome: string, custoMedio: number, unidade = 'm') {
  return s().insert(RESOURCES.insumos, { nome, unidade, custo_medio: custoMedio, ativo: true });
}

async function saldoInsumo(insumoId: number, quantidade: number) {
  await s().adjustInsumoStock(insumoId, quantidade);
  return s().insumoStock(insumoId);
}

/** Ficha técnica: 2 m de tecido (custo 10) + 10% de perda de insumo + mão de obra e indiretos. */
async function novaFicha(produtoId: number, opts: { consumo?: number; perdaPct?: number; maoObra?: number; indiretos?: number } = {}) {
  const tecido = await novoInsumo(`Tecido ${produtoId}`, 10);
  const ficha = await s().insert(RESOURCES.fichas, {
    produto_id: produtoId,
    mao_obra: opts.maoObra ?? 5,
    custos_indiretos: opts.indiretos ?? 3,
    margem_pct: 100,
  });
  await s().insert(RESOURCES.itens_ficha_tecnica, {
    ficha_id: Number(ficha.id),
    insumo_id: Number(tecido.id),
    consumo: opts.consumo ?? 2,
    perda_pct: opts.perdaPct ?? 10,
  });
  await producao.recalcularFichaValores(Number(ficha.id));
  return { ficha: (await s().get(RESOURCES.fichas, Number(ficha.id)))!, tecido };
}

async function novaOp(produtoId: number, quantidade: number, tamanhoCodigo = 'M', opts: Record<string, unknown> = {}) {
  const tam = await novoTamanho(tamanhoCodigo);
  return s().insert(RESOURCES.ordens, {
    empresa_id: 1,
    produto_id: produtoId,
    tipo: 'tamanho',
    tamanho_id: Number(tam.id),
    quantidade,
    status: 'planejada',
    ...opts,
  });
}

async function saldoProduto(produtoId: number, tamanhoId: number, local = 'loja'): Promise<number> {
  const row = await s().findOneWhere(RESOURCES.estoques, { produto_id: produtoId, tamanho_id: tamanhoId, local });
  return Number(row?.quantidade ?? 0);
}

async function consumoDaOrdem(ordemId: number) {
  const out = await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 500, filter: { ordem_id: ordemId } });
  return out.rows;
}

async function entradasDaOrdem(ordemId: number) {
  const out = await s().list(RESOURCES.movimentacoes, { page: 1, pageSize: 500, filter: { ordem_id: ordemId } });
  return out.rows.filter((m) => String(m.tipo) === 'entrada');
}

async function eventosDaOrdem(ordemId: number) {
  const out = await s().list(RESOURCES.ordens_eventos, { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { ordem_id: ordemId } });
  return out.rows;
}

// ---------------------------------------------------------------------------
// 1) MÁQUINA DE ESTADOS  (GAP-PROD-ESTADOS)
// ---------------------------------------------------------------------------

test('E2: o vocabulário de estados da OP é o da especificação', () => {
  assert.deepEqual([...producao.STATUS_OP], ['planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada']);
  const opcoes = RESOURCES.ordens.fields.find((f) => f.name === 'status')!.options!.map((o) => o.value);
  assert.deepEqual(opcoes, [...producao.STATUS_OP]);
});

test('E2: transições legais são aceitas e ilegais são recusadas com 409', () => {
  // caminho canônico
  assert.equal(producao.transicaoPermitida('planejada', 'liberada'), true);
  assert.equal(producao.transicaoPermitida('liberada', 'em_producao'), true);
  assert.equal(producao.transicaoPermitida('em_producao', 'parcial'), true);
  assert.equal(producao.transicaoPermitida('parcial', 'concluida'), true);
  // atalho documentado (comportamento anterior à E2)
  assert.equal(producao.transicaoPermitida('planejada', 'concluida'), true);
  // reabrir
  assert.equal(producao.transicaoPermitida('concluida', 'planejada'), true);
  assert.equal(producao.transicaoPermitida('concluida', 'em_producao'), true);
  // ilegais
  assert.equal(producao.transicaoPermitida('planejada', 'parcial'), false);
  assert.equal(producao.transicaoPermitida('concluida', 'cancelada'), false);
  assert.equal(producao.transicaoPermitida('cancelada', 'em_producao'), false);
  assert.equal(producao.transicaoPermitida('cancelada', 'planejada'), false);
  // criação aceita qualquer estado inicial (importação de histórico)
  assert.equal(producao.transicaoPermitida(null, 'concluida'), true);
  assert.equal(producao.transicaoPermitida(null, 'inexistente'), false);
});

test('E2: status fora do vocabulário é recusado com 400', async () => {
  const p = await novoProduto();
  const op = await novaOp(Number(p.id), 5);
  await esperarErro(
    () => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'voando' }, GERENTE, { escopo: GERENTE }),
    400,
    // O `select` do recurso responde primeiro ("Opção inválida"); a mensagem
    // própria de aplicarRegrasOrdem só aparece quando o valor passa por lá.
    /inválid/i
  );
});

test('E2: OP cancelada é terminal — não ressuscita', async () => {
  const p = await novoProduto();
  const op = await novaOp(Number(p.id), 5);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'cancelada' }, GERENTE, { escopo: GERENTE });
  await esperarErro(
    () => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'em_producao' }, GERENTE, { escopo: GERENTE }),
    409,
    /não pode ir para/
  );
});

test('E2: planejada não pula para parcial', async () => {
  const p = await novoProduto();
  const op = await novaOp(Number(p.id), 5);
  await esperarErro(
    () => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'parcial' }, GERENTE, { escopo: GERENTE }),
    409,
    /não pode ir para "parcial"/
  );
});

// ---------------------------------------------------------------------------
// 2) LIBERAÇÃO — custo previsto  (GAP-PROD-CUSTO-OP)
// ---------------------------------------------------------------------------

test('E2: liberar grava o custo previsto e exige gerente', async () => {
  const p = await novoProduto();
  const { ficha, tecido } = await novaFicha(Number(p.id), { consumo: 2, perdaPct: 10, maoObra: 5, indiretos: 3 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10);

  await esperarErro(() => chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: OPERADOR })), 403, /gerentes e administradores/);

  const out = await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  assert.equal(out.status, 'liberada');
  assert.ok(out.liberada_em, 'liberada_em gravado');
  assert.equal(Number(out.liberada_por), GERENTE.id);
  // 10 peças × (2 m × 1,10 × R$10 + mão de obra 5 + indiretos 3) = 10 × 30 = 300
  assert.equal(Number(ficha.custo_calculado), 30);
  assert.equal(Number(out.custo_previsto), 300);

  const eventos = await eventosDaOrdem(Number(op.id));
  assert.ok(eventos.some((e) => e.evento === 'liberada'), 'evento de liberação registrado');

  // liberar duas vezes não passa
  await esperarErro(() => chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE })), 409, /está "liberada"/);
});

test('E2: liberar sem ficha técnica avisa na trilha em vez de inventar custo', async () => {
  const p = await novoProduto();
  const op = await novaOp(Number(p.id), 4);
  const out = await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  assert.equal(Number(out.custo_previsto), 0);
  const eventos = await eventosDaOrdem(Number(op.id));
  assert.ok(eventos.some((e) => e.evento === 'edicao' && /não tem ficha técnica/.test(String(e.mensagem))));
});

// ---------------------------------------------------------------------------
// 3) APONTAMENTO — consumo, perda, idempotência  (GAP-PROD-APONTAMENTOS / PERDAS)
// ---------------------------------------------------------------------------

test('E2: apontar consome insumo pela FK, acumula produção e move a OP para parcial', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 2, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 20);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const antes = await s().insumoStock(Number(tecido.id));
  const out = await chamar(
    producao.criarApontamento,
    reqDe({ quantidade_produzida: 5 }, { params: { id: op.id }, user: OPERADOR }),
    201
  );
  assert.equal(Number(out.quantidade_produzida), 5);
  assert.equal(out.idempotente, false);

  // 5 peças × 2 m = 10 m baixados, e o vínculo é a FK ordem_id
  const consumo = await consumoDaOrdem(Number(op.id));
  assert.equal(consumo.length, 1);
  assert.equal(Number(consumo[0].quantidade), 10);
  assert.equal(Number(consumo[0].ordem_id), Number(op.id));
  assert.equal(await s().insumoStock(Number(tecido.id)), antes - 10);

  const depois = await s().get(RESOURCES.ordens, Number(op.id));
  assert.equal(depois!.status, 'parcial');
  assert.equal(Number(depois!.quantidade_produzida), 5);
  assert.equal(Number(depois!.quantidade_perdida), 0);
  // custo real = 10 m × R$10 = R$100 (ficha sem mão de obra nem indiretos)
  assert.equal(Number(depois!.custo_real), 100);

  // nada entrou no estoque ainda: produto acabado entra na CONCLUSÃO
  assert.equal(await saldoProduto(Number(p.id), Number(depois!.tamanho_id)), 0);
});

test('E2: peça refugada consome insumo e NÃO entra no estoque — a perda custa', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 2, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 6, quantidade_perdida: 2 }, { params: { id: op.id }, user: OPERADOR }), 201);

  const ordem = await s().get(RESOURCES.ordens, Number(op.id));
  assert.equal(Number(ordem!.quantidade_produzida), 6);
  assert.equal(Number(ordem!.quantidade_perdida), 2);
  // base de consumo = 6 boas + 2 refugadas = 8 peças × 2 m = 16 m
  const consumo = await consumoDaOrdem(Number(op.id));
  assert.equal(Number(consumo[0].quantidade), 16);

  // concluir: só as 6 boas entram no estoque
  await chamar(producao.concluirOrdemHandler, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  assert.equal(await saldoProduto(Number(p.id), Number(ordem!.tamanho_id)), 6);

  // e a conclusão não consome de novo: a necessidade (8 peças) já foi baixada
  const consumoFinal = await consumoDaOrdem(Number(op.id));
  assert.equal(consumoFinal.filter((m) => String(m.tipo) === 'saida').length, 1);
  assert.equal(Number(consumoFinal.filter((m) => String(m.tipo) === 'saida')[0].quantidade), 16);

  const eventos = await eventosDaOrdem(Number(op.id));
  assert.ok(eventos.some((e) => e.evento === 'perda'), 'evento de perda registrado');
});

test('E2: apontamento com a mesma chave de idempotência não consome duas vezes', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 1, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 30);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const corpo = { quantidade_produzida: 4, idempotency_key: 'turno-1-mesa-3' };
  const a = await chamar(producao.criarApontamento, reqDe(corpo, { params: { id: op.id }, user: OPERADOR }), 201);
  const b = await chamar(producao.criarApontamento, reqDe(corpo, { params: { id: op.id }, user: OPERADOR }), 200);

  assert.equal(a.idempotente, false);
  assert.equal(b.idempotente, true);
  assert.equal(Number(b.id), Number(a.id));

  const ordem = await s().get(RESOURCES.ordens, Number(op.id));
  assert.equal(Number(ordem!.quantidade_produzida), 4, 'a repetição não acumulou');
  const consumo = await consumoDaOrdem(Number(op.id));
  assert.equal(consumo.length, 1);
  assert.equal(Number(consumo[0].quantidade), 4);
});

test('E2: apontamento vazio, negativo ou de tamanho fora do plano é recusado', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10, 'M');
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  await esperarErro(() => chamar(producao.criarApontamento, reqDe({}, { params: { id: op.id }, user: OPERADOR })), 400, /apontamento vazio/);
  await esperarErro(() => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: -3 }, { params: { id: op.id }, user: OPERADOR })), 400, /inteiros/);
  await esperarErro(() => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1.5 }, { params: { id: op.id }, user: OPERADOR })), 400, /inteiros/);

  const foraDoPlano = await novoTamanho('GG');
  await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1, tamanho_id: Number(foraDoPlano.id) }, { params: { id: op.id }, user: OPERADOR })),
    400,
    /não faz parte do plano/
  );
});

test('E2: não dá para apontar em OP planejada nem concluída', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 5);
  await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, user: OPERADOR })),
    409,
    /está "planejada"/
  );
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });
  await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, user: OPERADOR })),
    409,
    /está "concluída"/
  );
});

test('E2: sem saldo de insumo o apontamento bloqueia com 409 e ?forcar libera para gerente', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 5, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 4); // só 4 m; cada peça pede 5 m
  const op = await novaOp(Number(p.id), 10);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const err = await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, user: OPERADOR })),
    409,
    /Sem saldo de insumos/
  );
  assert.match(err.message, /forcar=true/);

  // operador não força
  await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, query: { forcar: 'true' }, user: OPERADOR })),
    409,
    /Sem saldo de insumos/
  );
  // gerente força, e o saldo fica negativo de propósito (auditado)
  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, query: { forcar: 'true' }, user: GERENTE }), 201);
  assert.equal(await s().insumoStock(Number(tecido.id)), -1);
});

// ---------------------------------------------------------------------------
// 4) CONCLUSÃO — não regressão e vínculo formal  (GAP-ESTQ-ORDEM-ID)
// ---------------------------------------------------------------------------

test('E2: SEM apontamento a conclusão se comporta como antes (planejado entra, ficha baixa inteira)', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 2, perdaPct: 10, maoObra: 5, indiretos: 3 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10);

  const antes = await s().insumoStock(Number(tecido.id));
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });

  // 10 peças × 2 m × 1,10 = 22 m
  assert.equal(await s().insumoStock(Number(tecido.id)), antes - 22);
  const ordem = await s().get(RESOURCES.ordens, Number(op.id));
  assert.equal(await saldoProduto(Number(p.id), Number(ordem!.tamanho_id)), 10);
  assert.equal(Number(ordem!.quantidade_produzida), 10);
  // custo real = 22 m × R$10 + (5 + 3) reconhecidos 100% = 228
  assert.equal(Number(ordem!.custo_real), 228);

  const entradas = await entradasDaOrdem(Number(op.id));
  assert.equal(entradas.length, 1);
  assert.equal(Number(entradas[0].ordem_id), Number(op.id), 'entrada ligada à OP pela FK');
});

test('E2: reabrir estorna estoque e insumos PELA FK e é idempotente', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 2, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });

  const saldoAposConcluir = await saldoProduto(Number(p.id), Number((await s().get(RESOURCES.ordens, Number(op.id)))!.tamanho_id));
  const insumoAposConcluir = await s().insumoStock(Number(tecido.id));
  assert.equal(saldoAposConcluir, 10);

  // reabrir exige gerente (operação retroativa)
  await esperarErro(() => chamar(producao.reabrirOrdem, reqDe({}, { params: { id: op.id }, user: OPERADOR })), 403, /gerentes e administradores/);
  await chamar(producao.reabrirOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const ordem = await s().get(RESOURCES.ordens, Number(op.id));
  assert.equal(ordem!.status, 'planejada');
  assert.equal(await saldoProduto(Number(p.id), Number(ordem!.tamanho_id)), 0, 'estoque estornado');
  assert.equal(await s().insumoStock(Number(tecido.id)), insumoAposConcluir + 20, 'insumos devolvidos');
  assert.equal(Number(ordem!.quantidade_produzida), 0);
  assert.equal(Number(ordem!.custo_real), 0);

  // Dois ciclos concluir/reabrir seguidos: o líquido tem que voltar exatamente
  // ao inicial. `movimentacoes_insumos` não tem coluna `estornado`, então o
  // estorno é feito por SALDO LÍQUIDO (Σsaída − Σentrada) — se fosse linha a
  // linha, o segundo reabrir devolveria o mesmo tecido outra vez.
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });
  await chamar(producao.reabrirOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });
  await chamar(producao.reabrirOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  assert.equal(await s().insumoStock(Number(tecido.id)), 1000, 'devolução duplicada: o saldo passou do inicial');
  const mov = await consumoDaOrdem(Number(op.id));
  const liquido = mov.reduce((a, m) => a + (String(m.tipo) === 'saida' ? -Number(m.quantidade) : Number(m.quantidade)), 0);
  assert.equal(liquido, 0, `o consumo líquido da OP deveria ser zero, é ${liquido}`);
});

test('E2: reabrir descarta os apontamentos para a próxima conclusão não ler produção estornada', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 1, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 10);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 4 }, { params: { id: op.id }, user: OPERADOR }), 201);
  await chamar(producao.concluirOrdemHandler, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await chamar(producao.reabrirOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const apontamentos = await s().list(RESOURCES.ordens_apontamentos, { page: 1, pageSize: 100, filter: { ordem_id: Number(op.id) } });
  assert.equal(apontamentos.rows.length, 0);

  // a trilha guarda o que foi anulado
  const eventos = await eventosDaOrdem(Number(op.id));
  const reaberta = eventos.find((e) => e.evento === 'reaberta');
  assert.ok(reaberta, 'evento de reabertura registrado');
  // `dados` é gravado no banco mas memdb.decorate() o apaga em toda leitura da
  // API (regra geral de segredo, linha 147) — então o que o operador vê precisa
  // estar na mensagem, e é nela que o teste confere.
  assert.match(String(reaberta!.mensagem), /1 apontamento/);
  assert.match(String(reaberta!.mensagem), /4 boa\(s\)\/0 refugada\(s\) no tamanho #/);
});

test('E2: concluir sem plano é recusado', async () => {
  const p = await novoProduto();
  const tam = await novoTamanho('M');
  const op = await s().insert(RESOURCES.ordens, { empresa_id: 1, produto_id: Number(p.id), tipo: 'grade', tamanho_id: Number(tam.id), quantidade: 0, status: 'planejada' });
  await esperarErro(
    () => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE }),
    409,
    /ao menos um tamanho/
  );
});

test('E2: OP por grade conclui tamanho a tamanho e espelha produzido/perdido nos itens', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 1, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 1000);
  const m = await novoTamanho('M');
  const g = await novoTamanho('G');
  const op = await s().insert(RESOURCES.ordens, { empresa_id: 1, produto_id: Number(p.id), tipo: 'grade', status: 'planejada' });
  await s().insert(RESOURCES.itens_ordem, { ordem_id: Number(op.id), tamanho_id: Number(m.id), quantidade: 5, produzido: 0, perdido: 0 });
  await s().insert(RESOURCES.itens_ordem, { ordem_id: Number(op.id), tamanho_id: Number(g.id), quantidade: 3, produzido: 0, perdido: 0 });

  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await chamar(producao.criarApontamento, reqDe({ tamanho_id: Number(m.id), quantidade_produzida: 5, quantidade_perdida: 1 }, { params: { id: op.id }, user: OPERADOR }), 201);
  await chamar(producao.criarApontamento, reqDe({ tamanho_id: Number(g.id), quantidade_produzida: 2 }, { params: { id: op.id }, user: OPERADOR }), 201);
  await chamar(producao.concluirOrdemHandler, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  assert.equal(await saldoProduto(Number(p.id), Number(m.id)), 5);
  assert.equal(await saldoProduto(Number(p.id), Number(g.id)), 2);
  const itens = await s().list(RESOURCES.itens_ordem, { page: 1, pageSize: 10, filter: { ordem_id: Number(op.id) } });
  const itemM = itens.rows.find((i) => Number(i.tamanho_id) === Number(m.id))!;
  assert.equal(Number(itemM.produzido), 5);
  assert.equal(Number(itemM.perdido), 1);
  // consumo = (5+1) + 2 = 8 peças × 1 m
  const consumo = await consumoDaOrdem(Number(op.id));
  const totalSaida = consumo.filter((x) => String(x.tipo) === 'saida').reduce((a, x) => a + Number(x.quantidade), 0);
  assert.equal(totalSaida, 8);
});

// ---------------------------------------------------------------------------
// 5) CANCELAMENTO E RBAC
// ---------------------------------------------------------------------------

test('E2: cancelar exige gerente e guarda o motivo', async () => {
  const p = await novoProduto();
  const op = await novaOp(Number(p.id), 5);
  await esperarErro(() => chamar(producao.cancelarOrdem, reqDe({ motivo: 'x' }, { params: { id: op.id }, user: OPERADOR })), 403, /gerentes e administradores/);
  const out = await chamar(producao.cancelarOrdem, reqDe({ motivo: 'Cliente desistiu da cor' }, { params: { id: op.id }, user: GERENTE }));
  assert.equal(out.status, 'cancelada');
  assert.equal(out.motivo_cancelamento, 'Cliente desistiu da cor');
  const eventos = await eventosDaOrdem(Number(op.id));
  assert.ok(eventos.some((e) => e.evento === 'cancelada'));
});

test('E2: concluir uma OP sem insumo bloqueia (409) e o forçar fica auditado', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id), { consumo: 3, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await saldoInsumo(Number(tecido.id), 2);
  const op = await novaOp(Number(p.id), 4);
  await esperarErro(() => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE }), 409, /Sem saldo de insumos/);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { forcar: true, escopo: GERENTE });
  assert.equal(await s().insumoStock(Number(tecido.id)), 2 - 12);
});

// ---------------------------------------------------------------------------
// 6) TRILHA DE EVENTOS  (GAP-PROD-EVENTOS)
// ---------------------------------------------------------------------------

test('E2: a trilha registra o ciclo completo na ordem', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 6);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await chamar(producao.iniciarOrdem, reqDe({}, { params: { id: op.id }, user: OPERADOR }));
  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 6 }, { params: { id: op.id }, user: OPERADOR }), 201);
  await chamar(producao.concluirOrdemHandler, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const eventos = (await eventosDaOrdem(Number(op.id))).map((e) => e.evento);
  assert.deepEqual(eventos, ['liberada', 'iniciada', 'apontamento', 'concluida']);

  const lista = await chamar(producao.listEventosOrdem, reqDe({}, { params: { id: op.id }, user: OPERADOR }));
  assert.equal(lista.length, 4);
  const aps = await chamar(producao.listApontamentos, reqDe({}, { params: { id: op.id }, user: OPERADOR }));
  assert.equal(aps.length, 1);
});

test('E2: a conclusão direta da planejada fica marcada como atalho', async () => {
  const p = await novoProduto();
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 2);
  await updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, GERENTE, { escopo: GERENTE });
  const eventos = await eventosDaOrdem(Number(op.id));
  assert.ok(eventos.some((e) => e.evento === 'atalho'), 'atalho registrado');
});

// ---------------------------------------------------------------------------
// 7) MULTIEMPRESA — A não enxerga B
// ---------------------------------------------------------------------------

test('E2: OP, apontamento e evento não atravessam empresa', async () => {
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B Producao', cnpj: '11222333000181', ativo: true });
  const gerenteB = await criarAtor(Number(empresaB.id), 'gerente');

  const pA = await novoProduto({ sku: 'E2-A-MULTIEMPRESA' });
  const { tecido } = await novaFicha(Number(pA.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const opA = await novaOp(Number(pA.id), 8);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: opA.id }, user: GERENTE }));
  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 3 }, { params: { id: opA.id }, user: GERENTE }), 201);

  // a lista da empresa B não traz a OP da A
  const { listRecords } = await import('../src/services');
  const listaB = await listRecords(RESOURCES.ordens, { page: 1, pageSize: 500 }, gerenteB);
  assert.ok(!listaB.rows.some((o) => Number(o.id) === Number(opA.id)), 'OP da A vazou para B');

  // o gerente de B não conclui a OP da A: 404, não 403 (não confirma que existe)
  await esperarErro(
    () => updateRecord(RESOURCES.ordens, Number(opA.id), { status: 'concluida' }, gerenteB, { escopo: gerenteB }),
    404
  );

  // e os eventos/apontamentos herdam a empresa da OP por trigger/regra de serviço
  const eventos = await eventosDaOrdem(Number(opA.id));
  assert.ok(eventos.length > 0);
  assert.ok(eventos.every((e) => Number(e.empresa_id) === 1), 'evento com empresa errada');
  const aps = await s().list(RESOURCES.ordens_apontamentos, { page: 1, pageSize: 100, filter: { ordem_id: Number(opA.id) } });
  assert.ok(aps.rows.every((a) => Number(a.empresa_id) === 1), 'apontamento com empresa errada');
});

test('E2: os endpoints de detalhe da OP não vazam entre empresas (A → B → A)', async () => {
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B Detalhe', cnpj: '22333444000192', ativo: true });
  const gerenteB = await criarAtor(Number(empresaB.id), 'gerente');

  const p = await novoProduto({ sku: 'E2-DETALHE-MULTIEMPRESA' });
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 8);
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  await chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 3 }, { params: { id: op.id }, user: GERENTE }), 201);

  // A empresa A lê normalmente.
  assert.ok((await chamar(producao.listEventosOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }))).length > 0);
  assert.ok((await chamar(producao.listApontamentos, reqDe({}, { params: { id: op.id }, user: GERENTE }))).length > 0);
  await chamar(producao.listItensOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  // `getOrdem` buscava só por id, então a B lia a trilha, os apontamentos e a
  // grade da A — e ainda podia liberar/apontar/concluir/reabrir a OP da A.
  // 404, não 403: 403 confirmaria que o registro existe.
  for (const [nome, fn, corpo] of [
    ['eventos', producao.listEventosOrdem, {}],
    ['apontamentos (GET)', producao.listApontamentos, {}],
    ['itens', producao.listItensOrdem, {}],
    ['liberar', producao.liberarOrdem, {}],
    ['iniciar', producao.iniciarOrdem, {}],
    ['concluir', producao.concluirOrdemHandler, {}],
    ['cancelar', producao.cancelarOrdem, { motivo: 'da empresa B' }],
    ['reabrir', producao.reabrirOrdem, {}],
  ] as const) {
    await esperarErro(() => chamar(fn as any, reqDe(corpo as any, { params: { id: op.id }, user: gerenteB })), 404, undefined);
    void nome;
  }
  await esperarErro(
    () => chamar(producao.criarApontamento, reqDe({ quantidade_produzida: 1 }, { params: { id: op.id }, user: gerenteB })),
    404
  );

  // E a A continua operando depois da tentativa.
  const concluida = await chamar(producao.concluirOrdemHandler, reqDe({}, { params: { id: op.id }, user: GERENTE }));
  assert.equal(concluida.status, 'concluida');
});

// ---------------------------------------------------------------------------
// 8) PLANEJAMENTO
// ---------------------------------------------------------------------------

test('E2: o planejamento agrega o que está planejado e aponta insumo em falta', async () => {
  const p = await novoProduto({ sku: 'E2-PLANEJAMENTO' });
  const { tecido } = await novaFicha(Number(p.id), { consumo: 3, perdaPct: 0, maoObra: 0, indiretos: 0 });
  await s().update(RESOURCES.insumos, Number(tecido.id), { nome: 'Tecido E2 Planejamento' });
  await saldoInsumo(Number(tecido.id), 7); // insumo novo, saldo inicial zero → 7 m

  const hoje = new Date().toISOString().slice(0, 10);
  const op = await novaOp(Number(p.id), 10, 'M', { previsao: hoje });

  const out = await chamar(producao.planejamentoProducao, reqDe({}, { query: { de: hoje, ate: hoje }, user: GERENTE }));
  assert.equal(out.de, hoje);
  assert.ok(out.resumo.ops >= 1);
  assert.ok(out.resumo.planejadas >= 10);
  assert.ok(out.ordens.some((o: any) => o.id === Number(op.id)));

  const linha = out.insumos.find((i: any) => i.nome === 'Tecido E2 Planejamento');
  assert.ok(linha, 'insumo da ficha aparece na necessidade');
  assert.equal(linha.disponivel, 7);
  assert.ok(linha.necessaria >= 30, `necessidade deveria cobrir as 10 peças, veio ${linha.necessaria}`);
  assert.equal(linha.faltando, linha.necessaria - 7);
});

test('E2: planejamento de período sem OP vem vazio (não inventa número)', async () => {
  const out = await chamar(producao.planejamentoProducao, reqDe({}, { query: { de: '2031-01-05', ate: '2031-01-11' }, user: GERENTE }));
  assert.equal(out.resumo.ops, 0);
  assert.deepEqual(out.ordens, []);
  assert.deepEqual(out.insumos, []);
  assert.deepEqual(out.porSemana, []);
});

test('E2: o painel de produção conta liberada e parcial', async () => {
  const p = await novoProduto({ sku: 'E2-PAINEL' });
  const { tecido } = await novaFicha(Number(p.id));
  await saldoInsumo(Number(tecido.id), 1000);
  const op = await novaOp(Number(p.id), 12, 'M');
  await chamar(producao.liberarOrdem, reqDe({}, { params: { id: op.id }, user: GERENTE }));

  const painel = await chamar(producao.producaoPainel, reqDe({}, { user: GERENTE }));
  assert.ok(typeof painel.liberadas === 'number' && painel.liberadas >= 1);
  assert.ok(typeof painel.parciais === 'number');
  assert.equal(typeof painel.emProducao, 'number');
  assert.ok(getResource('ordens_apontamentos')!.internal, 'apontamentos não viram CRUD genérico');
});
