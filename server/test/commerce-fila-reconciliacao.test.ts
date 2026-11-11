// ============================================================================
// FASE 6 — SAÚDE REAL DO OMNICHANNEL (PR #129).
//
// Prova, com o store real (memdb em test), que a fila do commerce DISTINGUE:
//   • FALHA TÉCNICA definitiva (ERRO)                → precisa de correção;
//   • PENDÊNCIA DE CONFIGURAÇÃO (BLOQUEADO)          → repetir não resolve;
//   • AVISO SEM EFEITO (OBSOLETO)                    → encerrado com trilha;
// e que a reconciliação:
//   • NÃO encerra evento com efeito financeiro/estoque pendente;
//   • NÃO duplica pedido/venda/pagamento/estoque;
//   • exige gerente/admin (RBAC) e isola por tenant;
//   • é idempotente (rodar duas vezes não muda nada) e concorrente-segura.
//
// Sem rede, sem SMTP/Meta: SMTP/WhatsApp NÃO configurados.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
delete process.env.WHATSAPP_CLOUD_API_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_TEMPLATE_TRANSACIONAL;

const { getStore } = await import('../src/services');
const { RESOURCES, getResource } = await import('../src/resources');
const { enfileirarOutbox, processarOutbox, reconciliarFilaCommerce, reconciliarFilaEndpoint, reprocessarOutbox } = await import('../src/commerce/outbox');
const { registrarEventoPedido } = await import('../src/commerce/notificacoes');
const { notificacaoSuperseded } = await import('../src/commerce/regras');
const { painelOmnichannel, reconciliarOmnichannel } = await import('../src/commerce/omnichannel');
const { criarAtor, reqDe, resFake } = await import('./_p1util');

const s = getStore();
let seq = 0;

async function novaEmpresa(sufixo: string): Promise<number> {
  seq += 1;
  const emp = await s.insert(RESOURCES.empresas, { nome: `Empresa Fila ${sufixo} ${Date.now()} ${seq}` } as any);
  return Number(emp.id);
}

async function novoPedido(empresaId: number, estado = 'AGUARDANDO_PAGAMENTO', pagamento_estado: string | null = null): Promise<number> {
  seq += 1;
  const p = await s.insert(getResource('commerce_pedidos')!, {
    empresa_id: empresaId,
    canal: 'BROBOND',
    pedido_externo: `FILA-${Date.now()}-${seq}`,
    estado,
    pagamento_estado,
    total: 100,
  } as any);
  return Number(p.id);
}

const contato = { nome: 'Cliente Fila', email: 'cliente.fila@example.invalid', whatsapp: '(62) 98888-0000' };

async function limparEmpresa(empresaId: number) {
  for (const r of [RESOURCES.commerce_notificacoes, RESOURCES.commerce_outbox]) {
    const lista = await s.list(r, { page: 1, pageSize: 500, filter: { empresa_id: empresaId } });
    for (const row of lista.rows) await s.remove(r, Number(row.id));
  }
}

async function estadoDoEvento(id: number) {
  return s.get(RESOURCES.commerce_outbox, id);
}

describe('F6 — fila: falha técnica × configuração pendente × aviso obsoleto', () => {
  test('notificação sem provedor vira BLOQUEADO (não ERRO): a fila não mente sobre sincronização', async () => {
    const emp = await novaEmpresa('bloq');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp);
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });

    await processarOutbox(10, ['sincronizacao']);
    const lista = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } });
    assert.equal(lista.total, 1);
    assert.equal(String(lista.rows[0].estado), 'BLOQUEADO', 'falta de configuração não é falha técnica');
    assert.equal(Number(lista.rows[0].tentativas), 1, 'bloqueado não consome retry (para na primeira evidência)');
    assert.equal(lista.rows[0].proxima_tentativa_em, null);
  });

  test('aviso sem efeito (pedido CANCELADO/EXPIRADO) é encerrado como OBSOLETO com motivo, data e responsável', async () => {
    const emp = await novaEmpresa('obs');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'EXPIRADO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    const antes = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } })).rows[0];
    assert.equal(String(antes.estado), 'BLOQUEADO');

    const r = await reconciliarFilaCommerce(emp, { id: null, name: 'Teste' });
    assert.equal(r.obsoletos, 1);
    assert.equal(r.reenfileirados, 0);
    const depois = await estadoDoEvento(Number(antes.id));
    assert.equal(String(depois?.estado), 'OBSOLETO');
    assert.ok(String(depois?.motivo_encerramento || '').length > 0, 'o encerramento precisa de motivo');
    assert.ok(depois?.encerrado_em, 'o encerramento precisa de data');
    assert.equal(String(depois?.encerrado_por), 'Teste', 'o encerramento precisa de responsável técnico');
    assert.equal(depois?.ultimo_erro, null, 'não é mais um erro');

    // Idempotente: rodar de novo não reescreve nada nem empilha.
    const r2 = await reconciliarFilaCommerce(emp, { id: null, name: 'Teste' });
    assert.equal(r2.obsoletos, 0);
    assert.equal(r2.examinados, 0, 'OBSOLETO não é reexaminado');
  });

  test('aviso obsoleto NÃO é apresentado como divergência aberta no painel', async () => {
    const emp = await novaEmpresa('painel-obs');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'CANCELADO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    await reconciliarOmnichannel(emp);
    const painelBloq = await painelOmnichannel(emp);
    assert.ok(painelBloq.divergencias.some((d) => d.tipo === 'outbox_bloqueado'), 'enquanto pendente, aparece como configuração');
    await reconciliarFilaCommerce(emp, { name: 'Teste' });
    await reconciliarOmnichannel(emp);
    const painel = await painelOmnichannel(emp);
    assert.equal(painel.totais.abertas, 0, 'obsoleto encerrado não é pendência');
    const brobond = painel.saude_conectores.find((c) => c.canal === 'BROBOND')!;
    assert.equal(brobond.outbox_obsoleto, 1);
    assert.equal(brobond.outbox_erro, 0);
    assert.equal(brobond.outbox_bloqueado, 0);
  });

  test('pedido vivo e sem provedor: BLOQUEADO aparece como configuração pendente (severidade média), não como falha alta', async () => {
    const emp = await novaEmpresa('painel-bloq');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp);
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    await reconciliarOmnichannel(emp);
    const painel = await painelOmnichannel(emp);
    const div = painel.divergencias.find((d) => d.tipo === 'outbox_bloqueado');
    assert.ok(div, 'a configuração pendente precisa aparecer — nunca escondida');
    assert.equal(String(div?.severidade), 'media');
    assert.equal(String(div?.categoria), 'CONECTOR');
  });

  test('aviso de pedido VIVO não é encerrado: só o sem efeito vira OBSOLETO', async () => {
    const emp = await novaEmpresa('vivo');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'AGUARDANDO_PAGAMENTO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    const r = await reconciliarFilaCommerce(emp, { name: 'Teste' });
    assert.equal(r.obsoletos, 0);
    assert.equal(r.mantidos, 1);
    const linha = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } })).rows[0];
    assert.equal(String(linha.estado), 'BLOQUEADO', 'segue pendência de configuração, não obsoleto');
  });
});

describe('F6 — reconciliação: integridade, RBAC, tenant e concorrência', () => {
  test('evento financeiro/estoque pendente NUNCA é encerrado pela reconciliação', async () => {
    const emp = await novaEmpresa('fin');
    await limparEmpresa(emp);
    // Evento de publicação em ERRO: tem efeito comercial real (catálogo/canal).
    const pub = await enfileirarOutbox(emp, 'publicacao', `pub-${Date.now()}`, { publicacao_id: 999999 });
    await processarOutbox(10, ['publicacao']);
    assert.equal(String((await estadoDoEvento(Number(pub.id)))?.estado), 'ERRO');
    const r = await reconciliarFilaCommerce(emp, { name: 'Teste' });
    assert.equal(r.examinados, 0, 'só eventos de NOTIFICAÇÃO entram na reconciliação');
    assert.equal(String((await estadoDoEvento(Number(pub.id)))?.estado), 'ERRO', 'efeito comercial permanece para correção');
  });

  test('reconciliação não duplica pedido/venda/pagamento nem toca o estoque', async () => {
    const emp = await novaEmpresa('integ');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'EXPIRADO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);

    const antes = {
      pedidos: (await s.list(getResource('commerce_pedidos')!, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
      vendas: (await s.list(getResource('vendas')!, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
      notif: (await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
    };
    await reconciliarFilaCommerce(emp, { name: 'Teste' });
    const depois = {
      pedidos: (await s.list(getResource('commerce_pedidos')!, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
      vendas: (await s.list(getResource('vendas')!, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
      notif: (await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 500, filter: { empresa_id: emp } })).total,
    };
    assert.deepEqual(depois, antes, 'reconciliar não cria nem apaga registro canônico');
  });

  test('RBAC: operador não reconcilia; gerente reconcilia; evento de outro tenant não é alcançado', async () => {
    const empA = await novaEmpresa('rbacA');
    const empB = await novaEmpresa('rbacB');
    await limparEmpresa(empA);
    await limparEmpresa(empB);
    const pedidoA = await novoPedido(empA, 'EXPIRADO');
    await registrarEventoPedido(contato, { empresaId: empA, pedidoId: pedidoA, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    const linhaA = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: empA, tipo: 'sincronizacao' } })).rows[0];

    const operador = await criarAtor(empA, 'operador');
    await assert.rejects(
      () => reconciliarFilaEndpoint(reqDe({}, { user: operador }), resFake().res),
      (e: any) => e.status === 403,
      'operador não pode executar reconciliação'
    );

    // Gerente da empresa B roda a SUA reconciliação: não alcança o evento de A.
    const gerenteB = await criarAtor(empB, 'gerente');
    const saida = resFake();
    await reconciliarFilaEndpoint(reqDe({}, { user: gerenteB }), saida.res);
    assert.equal(saida.saida.json.examinados, 0, 'tenant B não processa eventos do tenant A');
    assert.equal(String((await estadoDoEvento(Number(linhaA.id)))?.estado), 'BLOQUEADO', 'o evento de A fica intacto');

    // Gerente da empresa A reconcilia e encerra o seu próprio evento.
    const gerenteA = await criarAtor(empA, 'gerente');
    const saidaA = resFake();
    await reconciliarFilaEndpoint(reqDe({}, { user: gerenteA }), saidaA.res);
    assert.equal(saidaA.saida.json.obsoletos, 1);
    assert.equal(String((await estadoDoEvento(Number(linhaA.id)))?.estado), 'OBSOLETO');
  });

  test('reprocessamento concorrente não duplica a operação (claim CAS)', async () => {
    const emp = await novaEmpresa('conc');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp);
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    // Duas varreduras simultâneas: o CAS garante um único processamento por linha.
    await Promise.all([processarOutbox(10, ['sincronizacao']), processarOutbox(10, ['sincronizacao'])]);
    const lista = await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } });
    assert.equal(lista.total, 1, 'a chave única não cria segunda entrada');
    // A linha foi processada uma vez: claim_versao avançou exatamente 1.
    assert.equal(Number(lista.rows[0].claim_versao), 1);
  });

  test('reenfileirar um OBSOLETO é recusado (terminal): não se reenvia aviso sem efeito', async () => {
    const emp = await novaEmpresa('term');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'CANCELADO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    await processarOutbox(10, ['sincronizacao']);
    await reconciliarFilaCommerce(emp, { name: 'Teste' });
    const linha = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } })).rows[0];
    const gerente = await criarAtor(emp, 'gerente');
    await assert.rejects(
      () => reprocessarOutbox(reqDe({}, { params: { id: String(linha.id) }, user: gerente }), resFake().res),
      (e: any) => e.status === 409,
      'obsolescência é terminal'
    );
  });
});

describe('F6 — reclassificação do ERRO histórico por falta de configuração', () => {
  test('ERRO causado só por configuração ausente vira BLOQUEADO (não é falha técnica)', async () => {
    const emp = await novaEmpresa('recl');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'AGUARDANDO_PAGAMENTO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    // Simula o histórico REAL do incidente: a linha nasceu ERRO após esgotar as
    // 10 tentativas por SMTP/Meta ausente (provider_status NAO_CONFIGURADO).
    const linha = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } })).rows[0];
    await s.tryUpdateIf(RESOURCES.commerce_outbox, Number(linha.id), { empresa_id: emp, estado: 'PENDENTE' },
      { estado: 'ERRO', tentativas: 10, ultimo_erro: 'Tentativas esgotadas (10): NÃO CONFIGURADO: SMTP incompleto.' });
    for (const n of (await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: emp, pedido_id: pedidoId } })).rows) {
      await s.tryUpdateIf(RESOURCES.commerce_notificacoes, Number(n.id), { empresa_id: emp },
        { estado: 'PENDENTE', tentativas: 10, provider_status: 'NAO_CONFIGURADO' });
    }

    const r = await reconciliarFilaCommerce(emp, { name: 'Teste' });
    assert.equal(r.reclassificados, 1, 'o ERRO de configuração é reclassificado');
    const depois = await estadoDoEvento(Number(linha.id));
    assert.equal(String(depois?.estado), 'BLOQUEADO');
    assert.match(String(depois?.ultimo_erro), /configuração/i);
  });

  test('ERRO com falha transitória real (provedor respondeu) NÃO é reclassificado', async () => {
    const emp = await novaEmpresa('recl2');
    await limparEmpresa(emp);
    const pedidoId = await novoPedido(emp, 'AGUARDANDO_PAGAMENTO');
    await registrarEventoPedido(contato, { empresaId: emp, pedidoId, evento: 'ORDER_CREATED' });
    const linha = (await s.list(RESOURCES.commerce_outbox, { page: 1, pageSize: 50, filter: { empresa_id: emp, tipo: 'sincronizacao' } })).rows[0];
    await s.tryUpdateIf(RESOURCES.commerce_outbox, Number(linha.id), { empresa_id: emp, estado: 'PENDENTE' },
      { estado: 'ERRO', tentativas: 10, ultimo_erro: 'Tentativas esgotadas (10): provedor respondeu 502.' });
    for (const n of (await s.list(RESOURCES.commerce_notificacoes, { page: 1, pageSize: 50, filter: { empresa_id: emp, pedido_id: pedidoId } })).rows) {
      await s.tryUpdateIf(RESOURCES.commerce_notificacoes, Number(n.id), { empresa_id: emp },
        { estado: 'ERRO', tentativas: 10, provider_status: 'REQUEST_REJECTED' });
    }
    const r = await reconciliarFilaCommerce(emp, { name: 'Teste' });
    assert.equal(r.reclassificados, 0, 'falha técnica real permanece ERRO');
    assert.equal(String((await estadoDoEvento(Number(linha.id)))?.estado), 'ERRO');
  });
});

describe('F6 — regra pura de supersessão (oráculo independente)', () => {
  test('estados terminais do pedido supersedem avisos não-terminais', () => {
    for (const estado of ['CANCELADO', 'EXPIRADO', 'ESTORNADO']) {
      assert.equal(notificacaoSuperseded('PIX_GENERATED', { estado }).superseded, true, estado);
      assert.equal(notificacaoSuperseded('ORDER_CREATED', { estado }).superseded, true, estado);
      // O aviso que ESPELHA o estado terminal permanece válido.
      assert.equal(notificacaoSuperseded('ORDER_EXPIRED', { estado }).superseded, false, estado);
      assert.equal(notificacaoSuperseded('ORDER_CANCELLED', { estado }).superseded, false, estado);
    }
  });

  test('pedido pago/convertido supersede avisos de cobrança, mas não o próprio "pago"', () => {
    for (const estado of ['PAGO', 'CONVERTIDO']) {
      assert.equal(notificacaoSuperseded('PAYMENT_PENDING', { estado }).superseded, true, estado);
      assert.equal(notificacaoSuperseded('PIX_GENERATED', { estado }).superseded, true, estado);
      assert.equal(notificacaoSuperseded('PAYMENT_APPROVED', { estado }).superseded, false, estado);
      assert.equal(notificacaoSuperseded('ORDER_SHIPPED', { estado }).superseded, false, estado);
    }
  });

  test('pagamento resolvido (recusado/estornado/expirado) encerra a espera por cobrança', () => {
    assert.equal(notificacaoSuperseded('PAYMENT_PENDING', { estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'REJECTED' }).superseded, true);
    assert.equal(notificacaoSuperseded('PAYMENT_PENDING', { estado: 'AGUARDANDO_PAGAMENTO', pagamento_estado: 'PENDING' }).superseded, false);
  });

  test('conservador: sem pedido ou em estado vivo, nada é supersedido', () => {
    assert.equal(notificacaoSuperseded('ORDER_CREATED', null).superseded, false);
    assert.equal(notificacaoSuperseded('ORDER_CREATED', { estado: 'AGUARDANDO_PAGAMENTO' }).superseded, false);
    assert.equal(notificacaoSuperseded('ORDER_SHIPPED', { estado: 'PAGO' }).superseded, false);
  });
});
