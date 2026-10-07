// ============================================================================
// LOGÍSTICA — P1 §13
//
// Três coisas não podem acontecer e este arquivo existe para provar isso:
//   1. o ERP NUNCA inventa cotação, rastreamento ou status;
//   2. "postado" só existe com prova (código de rastreamento ou ref do provedor)
//      — a regra está no banco E adiantada no handler;
//   3. credencial nunca aparece em claro na API, e um provedor externo não pode
//      ser ativado sem ela.
//
// Os adaptadores reais (Melhor Envio / Correios) falam com APIs externas; aqui
// eles são exercitados por TEST DOUBLES registrados no mesmo contrato
// (ShippingProvider), que é exatamente a interface que a produção usa.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { inferirStatus, provedorDaEmpresa, shippingProvider, shippingProviders, registrarShippingProvider, PROVEDOR_NULO, mascararConfig, obterConfigLogistica, R_CONFIGURACOES } = await import('../src/logistica');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoCliente, novoProduto, reqDe, resFake, saldoInicial } = await import('./_p1util');
const log = await import('../src/logistica');

await garantirAdmin();

const CEP_ORIGEM = '01310100';
const CEP_DESTINO = '30130110';

// ---------------------------------------------------------------------------
// Test double: um provedor de mentira, registrado no contrato real.
// Ele NÃO está na produção — existe só para exercitar o adaptador.
// ---------------------------------------------------------------------------
type ChamadaProvedor = { metodo: string; ctx?: any; codigo?: string; ref?: string };
const chamadas: ChamadaProvedor[] = [];
let doubleComportamento: 'ok' | 'falha' | 'recusa_cancelamento' = 'ok';
let proximoCodigo = 0;

registrarShippingProvider({
  slug: 'double',
  nome: 'Transportadora de Teste',
  disponivel: () => true,
  async cotar(ctx) {
    chamadas.push({ metodo: 'cotar', ctx });
    return {
      ok: true,
      data: [
        { servico: 'expresso', nome: 'Expresso', codigo: 'EXP', valor: 39.9, prazo_dias: 2 },
        { servico: 'economico', nome: 'Econômico', codigo: 'ECO', valor: 19.9, prazo_dias: 8 },
      ],
    };
  },
  async gerarEnvio(ctx) {
    chamadas.push({ metodo: 'gerarEnvio', ctx });
    if (doubleComportamento === 'falha') return { ok: false, motivo: 'falha', mensagem: 'O provedor recusou a etiqueta (peso acima do contrato).' };
    proximoCodigo++;
    return {
      ok: true,
      data: {
        provider_ref: `REF-${proximoCodigo}`,
        codigo_rastreamento: `DBL${String(proximoCodigo).padStart(9, '0')}BR`,
        etiqueta_url: `https://etiquetas.test/${proximoCodigo}.pdf`,
        servico: ctx.servico || 'expresso',
        custo: 39.9,
        mensagem: 'Etiqueta emitida pela transportadora de teste.',
      },
    };
  },
  async rastrear(codigo) {
    chamadas.push({ metodo: 'rastrear', codigo });
    return {
      ok: true,
      data: [
        { codigo: 'POST', status: 'postado', mensagem: 'Objeto postado', em: new Date().toISOString(), local: 'São Paulo/SP' },
        { codigo: 'TRAN', status: 'em trânsito', mensagem: 'Objeto em trânsito', em: new Date().toISOString(), local: 'Curitiba/PR' },
      ],
    };
  },
  async cancelar(ref) {
    chamadas.push({ metodo: 'cancelar', ref });
    if (doubleComportamento === 'recusa_cancelamento') return { ok: false, motivo: 'recusado', mensagem: 'A remessa já foi coletada.' };
    return { ok: true, data: { mensagem: `Remessa ${ref} cancelada na transportadora de teste.` } };
  },
});

/** Configura a empresa 1 com o provedor de teste. */
async function usarDouble(opts: { freteGratis?: number } = {}) {
  return chamar(
    log.salvarConfigHandler,
    reqDe({ provider: 'double', ambiente: 'homologacao', cep_origem: CEP_ORIGEM, frete_gratis_acima: opts.freteGratis ?? 0, me_token: null })
  );
}

async function vendaComCliente(opts: { total?: number; frete?: number; status?: string; cep?: string | null; cliente?: any } = {}) {
  const s = getStore();
  const cliente = opts.cliente ?? (await novoCliente({ cep: opts.cep === undefined ? CEP_DESTINO : opts.cep, cidade: 'Belo Horizonte', uf: 'MG' }));
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: 1,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: opts.status ?? 'faturada',
    total: opts.total ?? 200,
    frete: opts.frete ?? 0,
  });
  return { venda, cliente };
}

// ---------------------------------------------------------------------------
// 1) Tradução de status (pura)
// ---------------------------------------------------------------------------

test('logística: o status do provedor é traduzido para o vocabulário do ERP', () => {
  assert.equal(inferirStatus('Objeto entregue ao destinatário', 'em_transito'), 'entregue');
  assert.equal(inferirStatus('delivered', 'em_transito'), 'entregue');
  assert.equal(inferirStatus('Objeto devolvido ao remetente', 'em_transito'), 'devolvido');
  assert.equal(inferirStatus('objeto extraviado', 'em_transito'), 'extraviado');
  assert.equal(inferirStatus('Objeto em trânsito', 'postado'), 'em_transito');
  assert.equal(inferirStatus('Objeto encaminhado', 'postado'), 'em_transito');
  assert.equal(inferirStatus('Objeto postado', 'gerado'), 'postado');
});

test('logística: status desconhecido NÃO inventa progresso — mantém o atual', () => {
  assert.equal(inferirStatus('Evento interno do parceiro XYZ', 'postado'), 'postado');
  assert.equal(inferirStatus('', 'em_transito'), 'em_transito');
  assert.equal(inferirStatus('aguardando coleta', 'cotado'), 'cotado');
});

// ---------------------------------------------------------------------------
// 2) Registro de adaptadores
// ---------------------------------------------------------------------------

test('logística: provedor desconhecido cai no NULO, nunca no manual', () => {
  assert.equal(shippingProvider('nao_existe'), null);
  const p = provedorDaEmpresa({ provider: 'nao_existe', ambiente: 'homologacao' } as any);
  assert.equal(p.slug, PROVEDOR_NULO.slug);
  assert.equal(p.nome, PROVEDOR_NULO.nome, 'é o adaptador NULO, não o manual');
  assert.equal(p.disponivel(), false, 'o nulo nunca está disponível');
});

test('logística: o adaptador nulo nunca devolve dado inventado', async () => {
  const ctx: any = { venda_id: 1, origem: { cep: CEP_ORIGEM }, destino: { cep: CEP_DESTINO }, volumes: [{ peso_g: 300, quantidade: 1 }] };
  for (const r of [await PROVEDOR_NULO.cotar(ctx), await PROVEDOR_NULO.gerarEnvio(ctx), await PROVEDOR_NULO.rastrear('X'), await PROVEDOR_NULO.cancelar('X')]) {
    assert.equal(r.ok, false);
    assert.equal((r as any).motivo, 'nao_configurado');
  }
});

test('logística: os três adaptadores previstos estão registrados', () => {
  const slugs = shippingProviders().map((p) => p.slug).sort();
  for (const esperado of ['manual', 'melhor_envio', 'correios', 'double']) {
    assert.ok(slugs.includes(esperado), `o adaptador "${esperado}" deveria estar registrado (${slugs.join(', ')})`);
  }
});

test('logística: Melhor Envio e Correios sem credencial dizem "não configurado"', async () => {
  const ctx: any = { venda_id: 1, origem: { cep: CEP_ORIGEM }, destino: { cep: CEP_DESTINO }, volumes: [{ peso_g: 300, quantidade: 1 }] };
  const me = shippingProvider('melhor_envio')!;
  const corr = shippingProvider('correios')!;
  const rMe = await me.cotar(ctx);
  assert.equal(rMe.ok, false);
  assert.equal((rMe as any).motivo, 'nao_configurado', 'sem token não há cotação de verdade');
  const rCorr = await corr.gerarEnvio(ctx);
  assert.equal(rCorr.ok, false);
  assert.equal((rCorr as any).motivo, 'nao_configurado', 'SIGEP Web exige contrato e certificado');
});

// ---------------------------------------------------------------------------
// 3) Configuração e credenciais
// ---------------------------------------------------------------------------

test('logística: só admin vê e altera a configuração', async () => {
  const gerente = await criarAtor(1, 'gerente');
  await esperarErro(() => log.obterConfigHandler(reqDe({}, { user: gerente }), resFake().res), 403, /Somente administradores/);
  await esperarErro(() => log.salvarConfigHandler(reqDe({ provider: 'manual' }, { user: gerente }), resFake().res), 403, /Somente administradores/);
});

test('logística: não se ativa provedor externo sem credencial', async () => {
  await esperarErro(() => log.salvarConfigHandler(reqDe({ provider: 'melhor_envio', me_token: null }), resFake().res), 409, /Configure a credencial/);
  await esperarErro(() => log.salvarConfigHandler(reqDe({ provider: 'correios', correios_senha: null }), resFake().res), 409, /Configure a credencial/);
  await esperarErro(() => log.salvarConfigHandler(reqDe({ provider: 'provedor_fantasma' }), resFake().res), 400, /não está registrado/);
  // O slug é normalizado para minúsculas antes de validar: 'Manual' é aceito
  // (e gravado como 'manual') em vez de recusado por caixa errada.
  const normalizado = await chamar(log.salvarConfigHandler, reqDe({ provider: 'Manual' }));
  assert.equal(normalizado.config.provider, 'manual');
  await esperarErro(() => log.salvarConfigHandler(reqDe({ ambiente: 'producao_real' }), resFake().res), 400, /ambiente/);
  await esperarErro(() => log.salvarConfigHandler(reqDe({ cep_origem: '12345' }), resFake().res), 400, /CEP de origem/);
  await esperarErro(() => log.salvarConfigHandler(reqDe({ frete_gratis_acima: -10 }), resFake().res), 400, /negativo/);
});

test('logística: a credencial é guardada cifrada e nunca devolvida em claro', async () => {
  const segredo = 'me_token_super_secreto_1234567890';
  const salvo = await chamar(log.salvarConfigHandler, reqDe({ provider: 'melhor_envio', ambiente: 'homologacao', me_token: segredo, me_sandbox: true }));
  assert.equal(salvo.config.provider, 'melhor_envio');
  assert.equal(salvo.config.me_token_configurado, true, 'a tela sabe que existe credencial');
  assert.notEqual(String(salvo.config.me_token), segredo, 'o token não volta em claro');
  assert.ok(!String(salvo.config.me_token).includes('super_secreto'), 'nem fragmento do token aparece');

  // E no armazenamento também não fica em claro.
  const s = getStore();
  const bruto = await s.findOneWhere(R_CONFIGURACOES, { chave: 'logistica_config:1' });
  assert.ok(bruto, 'a configuração foi gravada');
  assert.ok(!String(bruto.valor).includes(segredo), 'o valor guardado está cifrado');

  // Mas o servidor consegue decifrar para usar.
  const cfg = await obterConfigLogistica(1);
  assert.equal(cfg.me_token, segredo, 'o servidor decifra para chamar o provedor');
  assert.equal(mascararConfig(cfg).me_token_configurado, true);

  // Volta para o manual para não contaminar os próximos testes.
  await chamar(log.salvarConfigHandler, reqDe({ provider: 'manual', me_token: null }));
});

// ---------------------------------------------------------------------------
// 4) Cotação de frete
// ---------------------------------------------------------------------------

test('logística: cotação exige endereço de destino e CEP de origem', async () => {
  await usarDouble();
  const semCliente = await vendaComCliente();
  await getStore().update(RESOURCES.vendas, Number(semCliente.venda.id), { cliente_id: null });
  await esperarErro(() => log.cotarFrete(reqDe({}, { query: { venda_id: semCliente.venda.id } }), resFake().res), 400, /não tem cliente/);

  const semCep = await vendaComCliente({ cep: null });
  await esperarErro(() => log.cotarFrete(reqDe({}, { query: { venda_id: semCep.venda.id } }), resFake().res), 400, /não tem CEP/);

  const cepCurto = await vendaComCliente({ cep: '30130' });
  await esperarErro(() => log.cotarFrete(reqDe({}, { query: { venda_id: cepCurto.venda.id } }), resFake().res), 400, /incompleto/);

  // Sem CEP de origem configurado e sem CEP na empresa → não há como cotar.
  await chamar(log.salvarConfigHandler, reqDe({ cep_origem: null }));
  const ok = await vendaComCliente();
  await esperarErro(() => log.cotarFrete(reqDe({}, { query: { venda_id: ok.venda.id } }), resFake().res), 409, /não tem CEP de origem/);
  await chamar(log.salvarConfigHandler, reqDe({ cep_origem: CEP_ORIGEM }));
});

test('logística: a cotação usa os volumes da venda (mm→cm) e ordena pelo valor final', async () => {
  await usarDouble();
  const s = getStore();
  const { venda } = await vendaComCliente({ total: 200 });
  const p = await novoProduto({ preco_venda: 200, peso_bruto_g: 750, altura_mm: 100, largura_mm: 200, profundidade_mm: 300 });
  await saldoInicial(p, 10);
  const tam = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(p.id) });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: 1,
    venda_id: Number(venda.id),
    produto_id: Number(p.id),
    tamanho_id: Number(tam.tamanho_id),
    quantidade: 2,
    preco_unitario: 100,
    subtotal: 200,
  });

  const cot = await chamar(log.cotarFrete, reqDe({}, { query: { venda_id: venda.id } }));
  assert.equal(cot.origem.cep, CEP_ORIGEM);
  assert.equal(cot.destino.cep, CEP_DESTINO);
  assert.equal(cot.peso_g, 1500, '2 × 750 g');
  assert.equal(cot.valor_declarado, 200);
  assert.equal(cot.provedor.slug, 'double');
  assert.deepEqual(
    cot.opcoes.map((o: any) => o.servico),
    ['economico', 'expresso'],
    'ordenado do mais barato para o mais caro'
  );
  assert.equal(cot.opcoes[0].valor_final, 19.9);
  assert.equal(cot.opcoes[0].frete_gratis_aplicado, false);

  // O provedor recebeu os volumes em CENTÍMETROS, não em milímetros.
  const ctx = chamadas.filter((c) => c.metodo === 'cotar').pop()!.ctx;
  assert.equal(ctx.volumes[0].altura_cm, 10);
  assert.equal(ctx.volumes[0].largura_cm, 20);
  assert.equal(ctx.volumes[0].comprimento_cm, 30);
  assert.equal(ctx.volumes[0].peso_g, 750);
  assert.equal(ctx.volumes[0].quantidade, 2);
  assert.equal(ctx.valor_declarado, 200);
});

test('logística: frete grátis é regra do ERP e aparece explícito na cotação', async () => {
  await usarDouble({ freteGratis: 150 });
  const { venda } = await vendaComCliente({ total: 200 });
  const s = getStore();
  const p = await novoProduto({ preco_venda: 200 });
  await saldoInicial(p, 10);
  const tam = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(p.id) });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(p.id), tamanho_id: Number(tam.tamanho_id), quantidade: 1, preco_unitario: 200, subtotal: 200 });

  const cot = await chamar(log.cotarFrete, reqDe({}, { query: { venda_id: venda.id } }));
  assert.equal(cot.opcoes[0].valor_final, 0, 'acima do mínimo o frete zera');
  assert.equal(cot.opcoes[0].frete_gratis_aplicado, true);
  assert.equal(cot.opcoes[1].valor_final, 0);
  await usarDouble();
});

// ---------------------------------------------------------------------------
// 5) Geração do envio
// ---------------------------------------------------------------------------

test('logística: sem provedor configurado nada é postado — e a tentativa fica registrada', async () => {
  await chamar(log.salvarConfigHandler, reqDe({ provider: 'manual', cep_origem: CEP_ORIGEM }));
  const s = getStore();
  const { venda } = await vendaComCliente({ frete: 0 });

  const erro = await esperarErro(() => log.gerarEnvio(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /PENDENTE/);
  const envioId = Number(erro.fields.envio_id);
  assert.ok(envioId > 0, 'o erro devolve o envio registrado');

  // O registro existe DE VERDADE (não foi engolido pelo rollback da transação).
  const envio = await s.get(RESOURCES.envios, envioId);
  assert.ok(envio, 'o envio PENDENTE foi persistido');
  assert.equal(envio.status, 'pendente');
  assert.equal(envio.codigo_rastreamento, null, 'sem código: nada foi postado');
  assert.equal(envio.provider_ref, null);
  assert.match(String(envio.erro), /registre o código de rastreamento/);

  const eventos = await s.list(RESOURCES.envio_eventos, { page: 1, pageSize: 50, filter: { envio_id: envioId }, sort: 'id', dir: 'asc' });
  assert.equal(eventos.rows.length, 1);
  assert.match(String(eventos.rows[0].mensagem), /^NÃO POSTADO/);

  // E a venda não foi tocada: sem envio, sem frete inventado.
  const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(vendaDepois.envio_id, null);
  assert.equal(Number(vendaDepois.frete), 0);
});

test('logística: geração de envio — 201 na primeira, MESMO envio na segunda', async () => {
  await usarDouble();
  const s = getStore();
  const { venda } = await vendaComCliente({ total: 200, frete: 0 });
  const p = await novoProduto({ preco_venda: 200 });
  await saldoInicial(p, 10);
  const tam = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(p.id) });
  await s.insert(RESOURCES.itens_venda, { empresa_id: 1, venda_id: Number(venda.id), produto_id: Number(p.id), tamanho_id: Number(tam.tamanho_id), quantidade: 1, preco_unitario: 200, subtotal: 200 });

  const primeira = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);
  assert.equal(primeira.idempotente, false);
  assert.equal(primeira.envio.status, 'postado', 'com código do provedor, é postado');
  assert.ok(primeira.envio.codigo_rastreamento);
  assert.ok(primeira.envio.provider_ref);
  assert.ok(primeira.envio.etiqueta_url);
  assert.equal(Number(primeira.envio.custo), 39.9);
  assert.equal(Number(primeira.envio.peso_g), 300, 'peso padrão da ficha quando o produto não informa');

  // A venda passa a apontar para o envio e o custo entra no total.
  const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(Number(vendaDepois.envio_id), Number(primeira.envio.id));
  assert.equal(Number(vendaDepois.frete), 39.9);
  assert.equal(Number(vendaDepois.total), 239.9);

  const segunda = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }));
  assert.equal(segunda.idempotente, true);
  assert.equal(Number(segunda.envio.id), Number(primeira.envio.id), 'mesmo envio');

  const terceira = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }));
  assert.equal(Number(terceira.envio.id), Number(primeira.envio.id));

  const todos = await s.list(RESOURCES.envios, { page: 1, pageSize: 100, filter: { venda_id: Number(venda.id) } });
  assert.equal(todos.rows.length, 1, 'UMA remessa por venda — nunca duas');
  const totalDepois = await s.get(RESOURCES.vendas, Number(venda.id));
  assert.equal(Number(totalDepois.total), 239.9, 'o frete não foi somado duas vezes');
});

test('logística: a chave de idempotência explícita também vale', async () => {
  await usarDouble();
  const { venda } = await vendaComCliente();
  const chave = `envio:custom:${Date.now()}`;
  const primeira = await chamar(log.gerarEnvio, reqDe({ idempotency_key: chave }, { params: { id: venda.id } }), 201);
  const segunda = await chamar(log.gerarEnvio, reqDe({ idempotency_key: chave }, { params: { id: venda.id } }));
  assert.equal(segunda.idempotente, true);
  assert.equal(Number(segunda.envio.id), Number(primeira.envio.id));
});

test('logística: falha do provedor não vira envio postado', async () => {
  await usarDouble();
  const s = getStore();
  const { venda } = await vendaComCliente();
  doubleComportamento = 'falha';
  try {
    const erro = await esperarErro(() => log.gerarEnvio(reqDe({}, { params: { id: venda.id } }), resFake().res), 502, /PENDENTE/);
    const envio = await s.get(RESOURCES.envios, Number(erro.fields.envio_id));
    assert.equal(envio.status, 'pendente');
    assert.equal(envio.codigo_rastreamento, null);
    assert.match(String(envio.erro), /recusou a etiqueta/);
    const vendaDepois = await s.get(RESOURCES.vendas, Number(venda.id));
    assert.equal(vendaDepois.envio_id, null, 'a venda não aponta para uma remessa inexistente');
  } finally {
    doubleComportamento = 'ok';
  }
});

test('logística: venda cancelada não gera envio', async () => {
  await usarDouble();
  const { venda } = await vendaComCliente({ status: 'cancelada' });
  await esperarErro(() => log.gerarEnvio(reqDe({}, { params: { id: venda.id } }), resFake().res), 409, /cancelada/);
});

// ---------------------------------------------------------------------------
// 6) Leitura, rastreio e status
// ---------------------------------------------------------------------------

test('logística: o envio da venda vem com a trilha de eventos em ordem', async () => {
  await usarDouble();
  const { venda } = await vendaComCliente();
  const criado = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);

  const daVenda = await chamar(log.envioDaVenda, reqDe({}, { params: { id: venda.id } }));
  assert.equal(Number(daVenda.envio.id), Number(criado.envio.id));
  assert.equal(daVenda.eventos.length, 1);
  assert.equal(daVenda.eventos[0].para_status, 'postado');

  const eventos = await chamar(log.eventosEnvio, reqDe({}, { params: { id: criado.envio.id } }));
  assert.equal(eventos.length, 1);
  assert.equal(Number(eventos[0].empresa_id), 1);

  const porCodigo = await chamar(log.buscarPorCodigo, reqDe({}, { params: { codigo: criado.envio.codigo_rastreamento } }));
  assert.equal(Number(porCodigo.envio.id), Number(criado.envio.id));
  await esperarErro(() => log.buscarPorCodigo(reqDe({}, { params: { codigo: 'NAOEXISTE' } }), resFake().res), 404, /Nenhum envio/);
  await esperarErro(() => log.buscarPorCodigo(reqDe({}, { params: { codigo: '' } }), resFake().res), 400, /Informe o código/);
});

test('logística: rastrear grava só o que o provedor devolveu, e não duplica', async () => {
  await usarDouble();
  const { venda } = await vendaComCliente();
  const criado = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);
  const s = getStore();

  const primeira = await chamar(log.rastrearEnvio, reqDe({}, { params: { id: criado.envio.id } }));
  assert.equal(primeira.provedor, 'double');
  assert.equal(primeira.eventos_novos, 2, 'os dois eventos do provedor foram gravados');
  assert.equal(primeira.codigo_rastreamento, criado.envio.codigo_rastreamento);

  const depois = await s.get(RESOURCES.envios, Number(criado.envio.id));
  assert.equal(depois.status, 'em_transito', 'o último evento conhecido define o status');

  const segunda = await chamar(log.rastrearEnvio, reqDe({}, { params: { id: criado.envio.id } }));
  assert.equal(segunda.eventos_novos, 0, 'repetir não duplica evento');
  const todos = await s.list(RESOURCES.envio_eventos, { page: 1, pageSize: 100, filter: { envio_id: Number(criado.envio.id) } });
  assert.equal(todos.rows.length, 3, '1 da geração + 2 do rastreio');
});

test('logística: sem código de rastreamento não há o que rastrear', async () => {
  const s = getStore();
  const { venda } = await vendaComCliente();
  const pendente = await s.insert(RESOURCES.envios, { empresa_id: 1, venda_id: Number(venda.id), provider: 'manual', status: 'pendente', custo: 0, idempotency_key: `sem-codigo:${Date.now()}` });
  await esperarErro(() => log.rastrearEnvio(reqDe({}, { params: { id: pendente.id } }), resFake().res), 409, /não tem código/);
});

test('logística: atualização manual de status exige prova para "postado"', async () => {
  const s = getStore();
  const { venda } = await vendaComCliente();
  const envio = await s.insert(RESOURCES.envios, { empresa_id: 1, venda_id: Number(venda.id), provider: 'manual', status: 'pendente', custo: 0, idempotency_key: `manual:${Date.now()}` });

  await esperarErro(() => log.atualizarStatusEnvio(reqDe({ status: 'entregue_no_destino' }, { params: { id: envio.id } }), resFake().res), 400, /Status inválido/);
  await esperarErro(() => log.atualizarStatusEnvio(reqDe({ status: 'postado' }, { params: { id: envio.id } }), resFake().res), 409, /sem código de rastreamento/);
  await esperarErro(() => log.atualizarStatusEnvio(reqDe({ status: 'em_transito' }, { params: { id: envio.id } }), resFake().res), 409, /sem código de rastreamento/);

  const postado = await chamar(log.atualizarStatusEnvio, reqDe({ status: 'postado', codigo_rastreamento: 'MANUAL123BR', custo: 25, mensagem: 'Coletado pela transportadora própria' }, { params: { id: envio.id } }));
  assert.equal(postado.status, 'postado');
  assert.equal(postado.codigo_rastreamento, 'MANUAL123BR');
  assert.equal(Number(postado.custo), 25);

  const eventos = await s.list(RESOURCES.envio_eventos, { page: 1, pageSize: 20, filter: { envio_id: Number(envio.id) }, sort: 'id', dir: 'asc' });
  assert.equal(eventos.rows.length, 1);
  assert.equal(eventos.rows[0].de_status, 'pendente');
  assert.equal(eventos.rows[0].para_status, 'postado');

  // Agora que há prova, os demais estados passam.
  const entregue = await chamar(log.atualizarStatusEnvio, reqDe({ status: 'entregue' }, { params: { id: envio.id } }));
  assert.equal(entregue.status, 'entregue');
});

test('logística: cancelamento exige motivo, chama o provedor e é irreversível', async () => {
  await usarDouble();
  const s = getStore();
  const { venda } = await vendaComCliente();
  const criado = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);

  await esperarErro(() => log.cancelarEnvio(reqDe({}, { params: { id: criado.envio.id } }), resFake().res), 400, /motivo/);
  await esperarErro(() => log.cancelarEnvio(reqDe({ motivo: 'x' }, { params: { id: criado.envio.id } }), resFake().res), 400, /mínimo 5/);

  const antes = chamadas.filter((c) => c.metodo === 'cancelar').length;
  const cancelado = await chamar(log.cancelarEnvio, reqDe({ motivo: 'Cliente pediu para trocar o endereço' }, { params: { id: criado.envio.id } }));
  assert.equal(cancelado.status, 'cancelado');
  assert.equal(chamadas.filter((c) => c.metodo === 'cancelar').length, antes + 1, 'o provedor foi avisado');
  assert.match(String(cancelado.provider_ref), /^REF-/);

  await esperarErro(() => log.cancelarEnvio(reqDe({ motivo: 'De novo' }, { params: { id: criado.envio.id } }), resFake().res), 409, /já está cancelado/);
  const envio = await s.get(RESOURCES.envios, Number(criado.envio.id));
  assert.equal(envio.status, 'cancelado');
});

test('logística: se o provedor recusa o cancelamento, o envio continua ativo', async () => {
  await usarDouble();
  const s = getStore();
  const { venda } = await vendaComCliente();
  const criado = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);
  doubleComportamento = 'recusa_cancelamento';
  try {
    await esperarErro(() => log.cancelarEnvio(reqDe({ motivo: 'Quero cancelar de qualquer jeito' }, { params: { id: criado.envio.id } }), resFake().res), 502, /recusou o cancelamento/);
    const envio = await s.get(RESOURCES.envios, Number(criado.envio.id));
    assert.equal(envio.status, 'postado', 'o ERP não cancela sozinho o que o provedor não cancelou');
  } finally {
    doubleComportamento = 'ok';
  }
});

test('logística: entrega não se cancela — o caminho é a devolução', async () => {
  const s = getStore();
  const { venda } = await vendaComCliente();
  const envio = await s.insert(RESOURCES.envios, { empresa_id: 1, venda_id: Number(venda.id), provider: 'double', status: 'entregue', codigo_rastreamento: 'DBL_ENTREGUE', custo: 10, idempotency_key: `entregue:${Date.now()}` });
  await esperarErro(() => log.cancelarEnvio(reqDe({ motivo: 'Quero cancelar a entrega' }, { params: { id: envio.id } }), resFake().res), 409, /abra uma devolução/);
});

// ---------------------------------------------------------------------------
// 7) Multiempresa
// ---------------------------------------------------------------------------

test('logística: a configuração de cada empresa é independente', async () => {
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const adminB = await criarAtor(2, 'admin');

  await usarDouble(); // empresa 1 → double
  const cfgA = await obterConfigLogistica(1);
  assert.equal(cfgA.provider, 'double');

  // A empresa 2 nunca recebeu configuração: cai no padrão manual.
  const cfgB = await obterConfigLogistica(2);
  assert.equal(cfgB.provider, 'manual');
  assert.notEqual(cfgB.provider, cfgA.provider);

  // E o admin de B só enxerga/altera a configuração de B.
  const vistaPorB = await chamar(log.obterConfigHandler, reqDe({}, { user: adminB }));
  assert.equal(vistaPorB.provider, 'manual');
  await chamar(log.salvarConfigHandler, reqDe({ provider: 'double', cep_origem: '20040020' }, { user: adminB }));
  assert.equal((await obterConfigLogistica(2)).cep_origem, '20040020');
  assert.equal((await obterConfigLogistica(1)).cep_origem, CEP_ORIGEM, 'a origem de A não mudou');
});

test('logística: envio da EMPRESA A é invisível para a EMPRESA B', async () => {
  await usarDouble();
  const s = getStore();
  await s.insert(RESOURCES.empresas, { id: 2, nome: 'FILIAL P1', razao_social: 'FILIAL P1 LTDA', ativo: true }).catch(() => undefined);
  const b = await criarAtor(2, 'gerente');

  const { venda } = await vendaComCliente();
  const criado = await chamar(log.gerarEnvio, reqDe({}, { params: { id: venda.id } }), 201);

  await esperarErro(() => log.eventosEnvio(reqDe({}, { user: b, params: { id: criado.envio.id } }), resFake().res), 404);
  await esperarErro(() => log.atualizarStatusEnvio(reqDe({ status: 'cancelado' }, { user: b, params: { id: criado.envio.id } }), resFake().res), 404);
  await esperarErro(() => log.cancelarEnvio(reqDe({ motivo: 'Cancelando o envio alheio' }, { user: b, params: { id: criado.envio.id } }), resFake().res), 404);
  await esperarErro(() => log.buscarPorCodigo(reqDe({}, { user: b, params: { codigo: criado.envio.codigo_rastreamento } }), resFake().res), 404, /nesta empresa/);

  // E a venda de A também não é alcançável por B.
  await esperarErro(() => log.envioDaVenda(reqDe({}, { user: b, params: { id: venda.id } }), resFake().res), 404);
  await esperarErro(() => log.cotarFrete(reqDe({}, { user: b, query: { venda_id: venda.id } }), resFake().res), 404);
  await esperarErro(() => log.gerarEnvio(reqDe({}, { user: b, params: { id: venda.id } }), resFake().res), 404);

  // Nada mudou na remessa de A.
  const intacto = await s.get(RESOURCES.envios, Number(criado.envio.id));
  assert.equal(intacto.status, 'postado');
});

void ADMIN;
