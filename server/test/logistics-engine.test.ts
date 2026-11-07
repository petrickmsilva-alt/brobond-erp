// ============================================================================
// MOTOR DE FRETE E LOGÍSTICA MULTICANAL — TESTES
//
// Cobre as garantias que definem o módulo:
//   • DOMÍNIO: regras comerciais, não regressão de status, validação de CEP e
//     volumes, normalização de status (puro, determinístico);
//   • COTAÇÃO: estado explícito quando o operador falha; NUNCA valor inventado;
//     persistência com operador/modalidade/validade/referência;
//   • REMESSA: idempotência por chave; operador sem capacidade → PENDENTE com
//     motivo (nunca "postado" sem prova);
//   • RASTREAMENTO: idempotência (evento repetido não duplica) e NÃO REGRESSÃO
//     (entregue não volta para em trânsito);
//   • WEBHOOK: assinatura HMAC, replay, rate limit, SSRF, minimização de PII;
//   • RECONCILIAÇÃO: classificação LEGITIMA/AUTOMATICA/HUMANA;
//   • API: RBAC e isolamento entre empresas.
//
// Os adaptadores reais (Melhor Envio / Correios) falam com APIs externas; aqui
// são exercitados TEST DOUBLES registrados no MESMO contrato (`CarrierAdapter`)
// que a produção usa — testar contra o contrato, não contra um mock ad-hoc.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.LOGISTICS_ENABLED = 'true';
process.env.LOGISTICS_DEFAULT_PROVIDER = 'double';

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { ADMIN, chamar, criarAtor, esperarErro, reqDe, resFake } = await import('./_p1util');

const contract = await import('../../modules/logistics/providers/contract');
const { registrarCarrier, carrier, CARRIER_NULO } = contract;
const statusDomain = await import('../../modules/logistics/domain/status');
const { normalizarStatus } = statusDomain;
const domain = await import('../../modules/logistics/domain/contract');
const { podeAvancar, cepValido, cepNormalizado, validarVolumes, pesoDoStatus } = domain;
const rules = await import('../../modules/logistics/domain/rules');
const { aplicarRegras, ordenarRegras, regraAplicavel } = rules;
const quotes = await import('../../modules/logistics/application/quotes');
const { cotarFrete, selecionarOpcao, logisticsHabilitado } = quotes;
const shipments = await import('../../modules/logistics/application/shipments');
const { criarRemessa, avancarStatusEnvio, gerarEtiqueta } = shipments;
const tracking = await import('../../modules/logistics/application/tracking');
const { aplicarEventosRastreio, chaveDedupeEvento } = tracking;
const reconciliation = await import('../../modules/logistics/application/reconciliation');
const { reconciliarRemessa } = reconciliation;
const httpMod = await import('../../modules/logistics/providers/http');
const { httpExterno, HttpExternaError, validarDestinoExterno } = httpMod;
const seg = await import('../../modules/logistics/infrastructure/webhookSeguranca');
const inbox = await import('../../modules/logistics/infrastructure/webhookInbox');
const resources = await import('../../modules/logistics/infrastructure/resources');
const routes = await import('../../modules/logistics/api/routes');
const recebimento = await import('../../modules/logistics/infrastructure/webhookRecebimento');

await import('./_p1util').then((m) => m.garantirAdmin());

// ---------------------------------------------------------------------------
// TEST DOUBLE — operador de mentira no contrato real.
// ---------------------------------------------------------------------------
let comportamento: 'ok' | 'falha' | 'vazio' | 'sem_prova' = 'ok';
let chamadasCotar = 0;
let chamadasRastrear = 0;
let rastreioEventos: { codigo: string; status: string; mensagem: string; em: string | null }[] = [];

registrarCarrier({
  slug: 'double',
  nome: 'Transportadora de Teste',
  capacidades: { cotacao: true, remessa: true, etiqueta: false, rastreio: true, cancelamento: false, webhook: false },
  credenciais: [],
  disponivel: async () => ({ configurado: true, habilitado: true, motivo: null }),
  async cotar() {
    chamadasCotar += 1;
    if (comportamento === 'falha') return { ok: false, motivo: 'falha', mensagem: 'Operador indisponível.' };
    if (comportamento === 'vazio') return { ok: false, motivo: 'recusado', mensagem: 'Sem serviço para o trecho.' };
    return {
      ok: true,
      data: [
        { servico: 'expresso', nome: 'Expresso', codigo: 'EXP', valor: 39.9, prazo_dias: 2, empresa: 'Teste' },
        { servico: 'economico', nome: 'Econômico', codigo: 'ECO', valor: 19.9, prazo_dias: 8, empresa: 'Teste' },
      ],
    };
  },
  async criarRemessa() {
    if (comportamento === 'falha') return { ok: false, motivo: 'falha', mensagem: 'Recusou a remessa.' };
    if (comportamento === 'sem_prova') return { ok: true, data: { provider_ref: null, codigo_rastreamento: null, etiqueta_url: null, custo: 25, servico: 'expresso' } };
    return { ok: true, data: { provider_ref: 'REF-1', codigo_rastreamento: 'BR123456789', etiqueta_url: 'https://exemplo.test/etq.pdf', custo: 39.9, servico: 'expresso', mensagem: 'Criada.' } };
  },
  async rastrear() {
    chamadasRastrear += 1;
    if (comportamento === 'falha') return { ok: false, motivo: 'falha', mensagem: 'Indisponível.' };
    return { ok: true, data: rastreioEventos };
  },
});

// Operador sem capacidade de remessa (só cotação) — para provar o caminho PENDENTE.
registrarCarrier({
  slug: 'so_cotacao',
  nome: 'Operador Só Cotação',
  capacidades: { cotacao: true, remessa: false, etiqueta: false, rastreio: false, cancelamento: false, webhook: false },
  credenciais: [],
  disponivel: async () => ({ configurado: true, habilitado: true, motivo: null }),
  async cotar() {
    return { ok: true, data: [{ servico: 'x', nome: 'X', codigo: 'X', valor: 10, prazo_dias: 5 }] };
  },
  async rastrear() {
    return { ok: false, motivo: 'nao_configurado', mensagem: 'Sem rastreio.' };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function novaVenda(empresaId = 1, opts: { cliente?: boolean; total?: number } = {}): Promise<any> {
  const s = getStore();
  const cliente = await s.insert(RESOURCES.clientes, { nome: 'Cliente Teste', empresa_id: empresaId, cep: '30130110', uf: 'MG', cidade: 'Belo Horizonte' });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: empresaId,
    cliente_id: opts.cliente === false ? null : Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'confirmada',
    total: opts.total ?? 500,
  });
  return { venda, cliente };
}

function contexto(over: Record<string, unknown> = {}) {
  return {
    empresaId: 1,
    storeKey: null,
    vendaId: null,
    origem: { cep: '01310100', uf: 'SP', cidade: 'São Paulo' },
    destino: { cep: '30130110', uf: 'MG', cidade: 'Belo Horizonte' },
    volumes: [{ peso_g: 1000, altura_cm: 10, largura_cm: 15, comprimento_cm: 20, quantidade: 1 }],
    pesoTotalG: 1000,
    valorDeclarado: 500,
    valorPedido: 500,
    modalidade: 'CIF' as const,
    ...over,
  } as Parameters<typeof cotarFrete>[0];
}

// ============================================================================
// 1. DOMÍNIO — CEP, VOLUMES
// ============================================================================
test('domínio: CEP válido exige 8 dígitos e rejeita 00000000', () => {
  assert.equal(cepValido('01310-100'), true);
  assert.equal(cepValido('01310100'), true);
  assert.equal(cepValido('0131010'), false);
  assert.equal(cepValido('00000000'), false);
  assert.equal(cepNormalizado('01310-100'), '01310100');
});

test('domínio: validarVolumes normaliza dimensões e sinaliza peso inválido', () => {
  const ok = validarVolumes([{ peso_g: 1000, altura_cm: 10, largura_cm: 15, comprimento_cm: 20 }]);
  assert.equal(ok.erros.length, 0);
  assert.equal(ok.volumes[0].peso_g, 1000);
  const ruim = validarVolumes([{ peso_g: 0 }]);
  assert.ok(ruim.erros.length > 0);
  const vazio = validarVolumes([]);
  assert.ok(vazio.erros.length > 0);
});

// ============================================================================
// 2. DOMÍNIO — NÃO REGRESSÃO DE STATUS
// ============================================================================
test('status: um evento atrasado NÃO faz um pedido entregue voltar para em trânsito', () => {
  assert.equal(podeAvancar('entregue', 'em_transito'), false);
  assert.equal(podeAvancar('entregue', 'entregue'), true);
  assert.equal(podeAvancar('em_transito', 'entregue'), true);
  assert.equal(podeAvancar('postado', 'em_transito'), true);
  assert.equal(podeAvancar('em_transito', 'postado'), false);
  assert.equal(pesoDoStatus('entregue') > pesoDoStatus('em_transito'), true);
});

test('status: normalização traduz o vocabulário do operador e não inventa progresso', () => {
  assert.equal(normalizarStatus('Objeto entregue ao destinatário', 'em_transito'), 'entregue');
  assert.equal(normalizarStatus('DELIVERED', 'postado'), 'entregue');
  assert.equal(normalizarStatus('Saiu para entrega ao destinatário', 'em_transito'), 'em_rota');
  assert.equal(normalizarStatus('Em trânsito para a unidade', 'postado'), 'em_transito');
  assert.equal(normalizarStatus('texto ambíguo sem sentido', 'postado'), 'postado');
});

// ============================================================================
// 3. REGRAS COMERCIAIS
// ============================================================================
const regraBase = { empresa_id: 1, store_key: null, prioridade: 10, ativo: true, inicio_em: null, fim_em: null, condicoes: {}, acoes: {} };

test('regras: frete grátis por valor mínimo zera o valor e marca a opção', () => {
  const r = aplicarRegras(
    [{ ...regraBase, id: 1, nome: 'Frete grátis > 300', tipo: 'FRETE_GRATIS_VALOR', condicoes: { valor_minimo: 300 }, acoes: {} }],
    [{ servico: 'eco', nome: 'Econômico', codigo: 'ECO', valor: 19.9, valor_final: 19.9, prazo_dias: 8, frete_gratis: false, subsidio: 0 }],
    { empresaId: 1, storeKey: null, valorPedido: 500, valorDeclarado: 500, pesoTotalG: 1000, volumes: [], destino: { cep: '30130110', uf: 'MG' }, modalidade: 'CIF' }
  );
  assert.equal(r.freteGratis, true);
  assert.equal(r.opcoes[0].valor_final, 0);
});

test('regras: frete grátis não se aplica abaixo do valor mínimo', () => {
  const r = aplicarRegras(
    [{ ...regraBase, id: 1, nome: 'Frete grátis > 300', tipo: 'FRETE_GRATIS_VALOR', condicoes: { valor_minimo: 300 }, acoes: {} }],
    [{ servico: 'eco', nome: 'Econômico', codigo: 'ECO', valor: 19.9, valor_final: 19.9, prazo_dias: 8, frete_gratis: false, subsidio: 0 }],
    { empresaId: 1, storeKey: null, valorPedido: 100, valorDeclarado: 100, pesoTotalG: 1000, volumes: [], destino: { cep: '30130110', uf: 'MG' }, modalidade: 'CIF' }
  );
  assert.equal(r.freteGratis, false);
  assert.equal(r.opcoes[0].valor_final, 19.9);
});

test('regras: subsídio percentual reduz o valor final', () => {
  const r = aplicarRegras(
    [{ ...regraBase, id: 2, nome: 'Subsídio 50%', tipo: 'FRETE_SUBSIDIADO', acoes: { percentual: 50 } }],
    [{ servico: 'eco', nome: 'Econômico', codigo: 'ECO', valor: 20, valor_final: 20, prazo_dias: 8, frete_gratis: false, subsidio: 0 }],
    { empresaId: 1, storeKey: null, valorPedido: 100, valorDeclarado: 100, pesoTotalG: 1000, volumes: [], destino: { cep: '30130110', uf: 'MG' }, modalidade: 'CIF' }
  );
  assert.equal(r.opcoes[0].valor_final, 10);
  assert.equal(r.subsidio, 10);
});

test('regras: regra de loja não se aplica a outra loja; prioridade ordena', () => {
  const regras = [
    { ...regraBase, id: 1, nome: 'RETAIL', tipo: 'FRETE_GRATIS_VALOR', store_key: 'RETAIL', prioridade: 1, condicoes: { valor_minimo: 0 }, acoes: {} },
    { ...regraBase, id: 2, nome: 'WHOLESALE', tipo: 'FRETE_GRATIS_VALOR', store_key: 'WHOLESALE', prioridade: 5, condicoes: { valor_minimo: 0 }, acoes: {} },
  ] as never[];
  const ctx = { empresaId: 1, storeKey: 'WHOLESALE' as const, valorPedido: 100, valorDeclarado: 100, pesoTotalG: 1, volumes: [], destino: { cep: '30130110', uf: 'MG' }, modalidade: 'CIF' as const };
  const ativas = regras.filter((r) => regraAplicavel(r, ctx, new Date()));
  assert.equal(ativas.length, 1);
  assert.equal(ativas[0].nome, 'WHOLESALE');
  const ordenadas = ordenarRegras(regras as never[]);
  assert.equal(ordenadas[0].id, 2);
});

// ============================================================================
// 4. COTAÇÃO — ESTADO EXPLÍCITO, NUNCA VALOR INVENTADO
// ============================================================================
test('cotação: CEP de destino inválido devolve INVALID_DESTINATION e não chama o operador', async () => {
  comportamento = 'ok';
  const antes = chamadasCotar;
  const r = await cotarFrete(contexto({ destino: { cep: '123', uf: 'MG' } }));
  assert.equal(r.estado, 'INVALID_DESTINATION');
  assert.equal(r.opcoes.length, 0);
  assert.equal(chamadasCotar, antes);
  assert.ok(r.quote_id);
});

test('cotação: operador indisponível devolve PROVIDER_UNAVAILABLE sem opções', async () => {
  comportamento = 'falha';
  const r = await cotarFrete(contexto());
  assert.equal(r.estado, 'PROVIDER_UNAVAILABLE');
  assert.equal(r.opcoes.length, 0);
  comportamento = 'ok';
});

test('cotação: nenhum serviço devolve NO_SERVICE_AVAILABLE', async () => {
  comportamento = 'vazio';
  const r = await cotarFrete(contexto());
  assert.equal(r.estado, 'NO_SERVICE_AVAILABLE');
  comportamento = 'ok';
});

test('cotação: sucesso persiste operador, modalidade, validade e devolve opções ordenáveis', async () => {
  comportamento = 'ok';
  const r = await cotarFrete(contexto());
  assert.equal(r.estado, 'OK');
  assert.equal(r.provedor, 'double');
  assert.equal(r.modalidade, 'CIF');
  assert.ok(r.validaAte);
  assert.equal(r.opcoes.length, 2);
  const melhor = selecionarOpcao(r.opcoes, 'custo');
  assert.equal(melhor?.servico, 'economico');
  const maisRapido = selecionarOpcao(r.opcoes, 'prazo');
  assert.equal(maisRapido?.servico, 'expresso');
  // Persistida com a empresa correta.
  const s = getStore();
  const linha = await s.findOneWhere(resources.R_QUOTES(), { id: r.quote_id, empresa_id: 1 });
  assert.ok(linha);
  assert.equal(String(linha.estado), 'OK');
});

test('cotação: módulo desabilitado não chama operador (modo seguro)', async () => {
  process.env.LOGISTICS_ENABLED = 'false';
  assert.equal(logisticsHabilitado(), false);
  const antes = chamadasCotar;
  const r = await cotarFrete(contexto());
  assert.equal(r.estado, 'CREDENTIALS_MISSING');
  assert.equal(chamadasCotar, antes);
  process.env.LOGISTICS_ENABLED = 'true';
});

// ============================================================================
// 5. REMESSA — IDEMPOTÊNCIA E "SEM PROVA → PENDENTE"
// ============================================================================
function entradaRemessa(vendaId: number, over: Record<string, unknown> = {}) {
  return {
    empresaId: 1,
    vendaId,
    storeKey: null,
    quoteId: null,
    provider: 'double',
    servico: 'expresso',
    servicoNome: 'Expresso',
    modalidade: 'CIF',
    volumes: [{ peso_g: 1000, altura_cm: 10, largura_cm: 15, comprimento_cm: 20, quantidade: 1 }],
    pesoTotalG: 1000,
    cepDestino: '30130110',
    valorDeclarado: 500,
    valorPedido: 500,
    custoPrevisto: 39.9,
    prazoDias: 2,
    idempotencyKey: `envio:venda:${vendaId}`,
    usuarioId: null,
    origemCep: '01310100',
    ...over,
  } as Parameters<typeof criarRemessa>[0];
}

test('remessa: criação idempotente pela chave devolve o MESMO envio', async () => {
  const { venda } = await novaVenda();
  const a = await criarRemessa(entradaRemessa(Number(venda.id)));
  assert.equal(a.idempotente, false);
  assert.equal(String(a.envio.status), 'postado');
  assert.equal(String(a.envio.codigo_rastreamento), 'BR123456789');
  const b = await criarRemessa(entradaRemessa(Number(venda.id)));
  assert.equal(b.idempotente, true);
  assert.equal(Number(b.envio.id), Number(a.envio.id));
});

test('remessa: operador sem capacidade de remessa NÃO cria remessa postada — fica PENDENTE com motivo', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { provider: 'so_cotacao', idempotencyKey: `envio:venda:${venda.id}:so` }));
  assert.equal(r.pendente, true);
  assert.equal(String(r.envio.status), 'pendente');
  assert.match(String(r.envio.erro), /não gera remessa por API/i);
});

test('remessa: operador que responde sem código nem ref NÃO vira "postado"', async () => {
  comportamento = 'sem_prova';
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:sp` }));
  assert.notEqual(String(r.envio.status), 'postado');
  assert.equal(String(r.envio.status), 'etiqueta_gerada');
  comportamento = 'ok';
});

test('remessa: operador indisponível grava PENDENTE com o motivo (nada postado)', async () => {
  comportamento = 'falha';
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:fail` }));
  assert.equal(r.pendente, true);
  assert.equal(String(r.envio.status), 'pendente');
  assert.match(String(r.envio.erro), /Recusou a remessa/);
  comportamento = 'ok';
});

test('remessa: "postado" sem prova é recusado por avancarStatusEnvio', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { provider: 'so_cotacao', idempotencyKey: `envio:venda:${venda.id}:np` }));
  const envioId = Number(r.envio.id);
  const tentativa = await avancarStatusEnvio(1, envioId, 'postado');
  assert.equal(tentativa.ok, false);
  assert.match(String(tentativa.motivo), /sem código de rastreamento/i);
});

test('remessa: avanço de status respeita a ordem (não regride)', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:ord` }));
  const envioId = Number(r.envio.id);
  // Já está em 'postado' (tem prova); 'em_transito' avança.
  const avanca = await avancarStatusEnvio(1, envioId, 'em_transito');
  assert.equal(avanca.ok, true);
  // Voltar para 'postado' é regressão → recusado.
  const regride = await avancarStatusEnvio(1, envioId, 'postado');
  assert.equal(regride.ok, false);
});

// ============================================================================
// 6. ETIQUETA — SEM CAPACIDADE → PENDENTE, NUNCA FALSA
// ============================================================================
test('etiqueta: operador sem capacidade gera registro PENDENTE com procedimento (nunca finge geração)', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:etq` }));
  const envioId = Number(r.envio.id);
  const e = await gerarEtiqueta(1, envioId, `label:${envioId}`, null);
  assert.equal(e.ok, false);
  assert.equal(String(e.etiqueta.estado), 'PENDENTE');
  // Idempotente pela chave.
  const e2 = await gerarEtiqueta(1, envioId, `label:${envioId}`, null);
  assert.equal(e2.idempotente, true);
});

// ============================================================================
// 7. RASTREAMENTO — IDEMPOTÊNCIA E NÃO REGRESSÃO
// ============================================================================
test('rastreamento: evento repetido não duplica e entregue não regride', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:trk` }));
  const envioId = Number(r.envio.id);
  const eventos = [
    { codigo: 'BR1', status: 'Em trânsito', mensagem: 'Saiu do CD', em: '2026-01-01T10:00:00Z' },
    { codigo: 'BR1', status: 'Em trânsito', mensagem: 'Saiu do CD', em: '2026-01-01T10:00:00Z' },
  ];
  const p1 = await aplicarEventosRastreio(1, envioId, eventos, 'webhook');
  assert.equal(p1.gravados, 1);
  assert.equal(p1.ignorados, 1);
  // Entregue.
  const p2 = await aplicarEventosRastreio(1, envioId, [{ codigo: 'BR1', status: 'Objeto entregue ao destinatário', mensagem: 'Entregue', em: '2026-01-02T10:00:00Z' }], 'webhook');
  assert.equal(p2.statusFinal, 'entregue');
  // Evento atrasado (em trânsito) depois de entregue: grava o histórico, mas NÃO regride.
  const p3 = await aplicarEventosRastreio(1, envioId, [{ codigo: 'BR1', status: 'Em trânsito', mensagem: 'Evento atrasado', em: '2026-01-01T09:00:00Z' }], 'webhook');
  assert.equal(p3.statusFinal, 'entregue');
  assert.equal(p3.regrediu, true);
  // O histórico bruto preservou o evento atrasado.
  const s = getStore();
  const evs = await s.list(RESOURCES.envio_eventos, { page: 1, pageSize: 100, filter: { empresa_id: 1, envio_id: envioId } });
  assert.ok(evs.rows.some((e) => String(e.external_code) === 'Em trânsito'));
});

test('rastreamento: chave de dedupe é estável para o mesmo evento', () => {
  const ev = { codigo: 'X', status: 'Y', mensagem: 'Z', em: '2026-01-01' };
  assert.equal(chaveDedupeEvento(ev as never, 1), chaveDedupeEvento(ev as never, 1));
  assert.notEqual(chaveDedupeEvento(ev as never, 1), chaveDedupeEvento(ev as never, 2));
});

// ============================================================================
// 8. RECONCILIAÇÃO — CLASSIFICAÇÃO
// ============================================================================
test('reconciliação: status do ERP atrás do operador é AUTOMATICA', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:rec` }));
  const envioId = Number(r.envio.id);
  // ERP fica em postado; operador diz em trânsito.
  rastreioEventos = [{ codigo: 'BR123456789', status: 'Em trânsito', mensagem: 'A caminho', em: null }];
  const ds = await reconciliarRemessa(1, envioId);
  const d = ds.find((x) => x.tipo === 'STATUS_ATRASADO_ERP');
  assert.ok(d);
  assert.equal(d!.classificacao, 'AUTOMATICA');
  assert.equal(d!.corrigivel, true);
  rastreioEventos = [];
});

test('reconciliação: ERP à frente do operador é HUMANA (ambíguo)', async () => {
  const { venda } = await novaVenda();
  const r = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:rec2` }));
  const envioId = Number(r.envio.id);
  await avancarStatusEnvio(1, envioId, 'em_transito');
  // Operador só conhece "postado" → ERP à frente → HUMANA.
  rastreioEventos = [{ codigo: 'BR123456789', status: 'Objeto postado', mensagem: 'Postado', em: null }];
  const ds = await reconciliarRemessa(1, envioId);
  const d = ds.find((x) => x.tipo === 'STATUS_ADIANTADO_ERP');
  assert.ok(d);
  assert.equal(d!.classificacao, 'HUMANA');
  assert.equal(d!.corrigivel, false);
  rastreioEventos = [];
});

// ============================================================================
// 9. SEGURANÇA DE WEBHOOK
// ============================================================================
test('webhook: assinatura HMAC é validada sobre os bytes crus', () => {
  process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET = 'segredo-de-teste';
  const corpo = Buffer.from(JSON.stringify({ id: 'evt-1', status: 'Em trânsito' }), 'utf8');
  const assinatura = createHmac('sha256', 'segredo-de-teste').update(corpo).digest('base64');
  assert.equal(seg.validarAssinatura(corpo, assinatura, 'double').ok, true);
  assert.equal(seg.validarAssinatura(corpo, 'assinatura-errada', 'double').ok, false);
  assert.equal(seg.validarAssinatura(corpo, undefined, 'double').ok, false);
  delete process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET;
});

test('webhook: sem segredo configurado o endpoint falha fechado', () => {
  delete process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET;
  assert.equal(seg.webhookHabilitado('double'), false);
  const r = seg.validarAssinatura(Buffer.from('{}'), 'x', 'double');
  assert.equal(r.ok, false);
});

test('webhook: timestamp fora da janela é recusado (replay)', () => {
  process.env.LOGISTICS_WEBHOOK_TOLERANCE_S = '60';
  const agora = Date.now();
  assert.equal(seg.validarTimestamp(String(Math.floor(agora / 1000)), agora).ok, true);
  assert.equal(seg.validarTimestamp(String(Math.floor((agora - 3600_000) / 1000)), agora).ok, false);
  delete process.env.LOGISTICS_WEBHOOK_TOLERANCE_S;
});

test('webhook: rate limit por IP bloqueia excesso', () => {
  seg.limparRateLimit();
  process.env.LOGISTICS_WEBHOOK_RATE_MAX = '3';
  process.env.LOGISTICS_WEBHOOK_RATE_WINDOW_MS = '60000';
  const ip = '198.51.100.7';
  assert.equal(seg.consumirRateLimit(ip).ok, true);
  assert.equal(seg.consumirRateLimit(ip).ok, true);
  assert.equal(seg.consumirRateLimit(ip).ok, true);
  const quarto = seg.consumirRateLimit(ip);
  assert.equal(quarto.ok, false);
  seg.limparRateLimit();
  delete process.env.LOGISTICS_WEBHOOK_RATE_MAX;
  delete process.env.LOGISTICS_WEBHOOK_RATE_WINDOW_MS;
});

test('webhook: minimização remove PII recursivamente', () => {
  const minimizado = seg.minimizarPayload({ id: 'x', destinatario: { nome: 'Fulano', cpf: '123' }, events: [{ status: 'ok', endereco: 'Rua X' }] }) as Record<string, unknown>;
  assert.equal(minimizado.id, 'x');
  assert.equal((minimizado.destinatario as Record<string, unknown> | undefined)?.nome, undefined);
  const ev = (minimizado.events as Record<string, unknown>[])[0];
  assert.equal(ev.status, 'ok');
  assert.equal(ev.endereco, undefined);
});

// ============================================================================
// 10. HTTP SEGURO — SSRF
// ============================================================================
test('http: destino interno é recusado (SSRF)', () => {
  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data', 'ftp://example.com/x']) {
    assert.throws(() => validarDestinoExterno(url), HttpExternaError, `deveria recusar ${url}`);
  }
  assert.doesNotThrow(() => validarDestinoExterno('https://api.exemplo.com.br/quote'));
});

test('http: 4xx é recusa definitiva (sem retry, devolve ok=false); 5xx faz retry e esgota', async () => {
  let chamadas = 0;
  const fetchFake = (async () => {
    chamadas += 1;
    return { status: 404, ok: false, body: null, text: async () => 'not found' } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await httpExterno('https://api.exemplo.com.br/x', { fetchImpl: fetchFake, retries: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(chamadas, 1); // 4xx não faz retry

  chamadas = 0;
  const fetch500 = (async () => {
    chamadas += 1;
    return { status: 503, ok: false, body: null, text: async () => 'down' } as unknown as Response;
  }) as unknown as typeof fetch;
  await assert.rejects(() => httpExterno('https://api.exemplo.com.br/x', { fetchImpl: fetch500, retries: 2 }), (e: unknown) => e instanceof HttpExternaError && e.transitorio === true);
  assert.equal(chamadas, 3); // 1 + 2 retries
});

test('http: timeout (abort) é tratado como transitório', async () => {
  const fetchAbort = (async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as unknown as typeof fetch;
  await assert.rejects(() => httpExterno('https://api.exemplo.com.br/x', { fetchImpl: fetchAbort, retries: 1 }), HttpExternaError);
});

// ============================================================================
// 11. INBOX DE WEBHOOK — IDEMPOTÊNCIA
// ============================================================================
test('inbox: entrega repetida (mesmo delivery id) não cria segunda linha nem segunda fila', async () => {
  const dados = {
    provider: 'double',
    event_type: 'tracking',
    external_delivery_id: 'DELIV-1',
    payload: { status: 'Em trânsito' },
    payload_hash: inbox.hashCorpo(Buffer.from('{"status":"Em trânsito"}')),
    assinatura_ok: true,
    correlation_id: null,
  };
  const a = await inbox.registrarEntrega(1, dados);
  assert.equal(a.duplicado, false);
  const b = await inbox.registrarEntrega(1, dados);
  assert.equal(b.duplicado, true);
  assert.equal(b.id, a.id);
});

test('inbox: assinatura inválida grava como rejeitado e NÃO enfileira', async () => {
  const r = await inbox.registrarEntrega(1, {
    provider: 'double',
    event_type: 'tracking',
    external_delivery_id: 'DELIV-BAD',
    payload: {},
    payload_hash: inbox.hashCorpo(Buffer.from('{}')),
    assinatura_ok: false,
    correlation_id: null,
  });
  assert.equal(r.status, 'rejeitado');
  assert.equal(r.outbox_id, null);
});

// ============================================================================
// 12. RECEPÇÃO DE WEBHOOK (rota pública) — END-TO-END
// ============================================================================
function reqWebhook(over: { params?: any; headers?: any; body?: Buffer; method?: string } = {}): any {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(over.headers || {})) headers[k.toLowerCase()] = v;
  return {
    method: over.method || 'POST',
    params: over.params || { provider: 'double' },
    headers,
    header: (n: string) => headers[String(n).toLowerCase()],
    body: over.body ?? Buffer.from('{}'),
    socket: { remoteAddress: '203.0.113.9' },
  };
}

test('recepção: assinatura válida responde 202 e enfileira; repetida responde duplicado', async () => {
  process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET = 'segredo-webhook';
  seg.limparRateLimit();
  const corpo = Buffer.from(JSON.stringify({ id: 'evt-99', status: 'Em trânsito' }), 'utf8');
  const assinatura = createHmac('sha256', 'segredo-webhook').update(corpo).digest('base64');
  const { res, saida } = resFake();
  await recebimento.webhookReceber(reqWebhook({ headers: { 'x-logistics-signature': assinatura, 'x-logistics-delivery-id': 'evt-99' }, body: corpo }), res);
  assert.equal(saida.status, 202);
  assert.equal(saida.json.ok, true);

  const { res: res2, saida: saida2 } = resFake();
  await recebimento.webhookReceber(reqWebhook({ headers: { 'x-logistics-signature': assinatura, 'x-logistics-delivery-id': 'evt-99' }, body: corpo }), res2);
  assert.equal(saida2.status, 202);
  assert.equal(saida2.json.duplicado, true);
  delete process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET;
});

test('recepção: assinatura inválida responde 401 e não enfileira', async () => {
  process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET = 'segredo-webhook';
  seg.limparRateLimit();
  const corpo = Buffer.from(JSON.stringify({ id: 'evt-100' }), 'utf8');
  const { res, saida } = resFake();
  await recebimento.webhookReceber(reqWebhook({ headers: { 'x-logistics-signature': 'errada', 'x-logistics-delivery-id': 'evt-100' }, body: corpo }), res);
  assert.equal(saida.status, 401);
  delete process.env.LOGISTICS_DOUBLE_WEBHOOK_SECRET;
});

test('recepção: operador desconhecido responde 404', async () => {
  const { res, saida } = resFake();
  await recebimento.webhookReceber(reqWebhook({ params: { provider: 'inexistente' } }), res);
  assert.equal(saida.status, 404);
});

// ============================================================================
// 13. API — RBAC E ISOLAMENTO ENTRE EMPRESAS
// ============================================================================
test('api: operador (não gestor) não acessa o painel logístico', async () => {
  const ator = await criarAtor(1, 'operador');
  await esperarErro(() => routes.painelLogistica(reqDe({}, { user: ator }), resFake().res), 403);
});

test('api: gerente da empresa 2 não vê remessas da empresa 1', async () => {
  const { venda } = await novaVenda(1);
  await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:iso` }));
  const ator2 = await criarAtor(2, 'gerente');
  const r = await chamar(routes.listarRemessas, reqDe({}, { user: ator2 }));
  assert.equal(r.rows.length, 0);
  const ator1 = await criarAtor(1, 'gerente');
  const r1 = await chamar(routes.listarRemessas, reqDe({}, { user: ator1 }));
  assert.ok(r1.rows.length >= 1);
});

test('api: gerente de outra empresa não detalha remessa alheia (404/403)', async () => {
  const { venda } = await novaVenda(1);
  const criado = await criarRemessa(entradaRemessa(Number(venda.id), { idempotencyKey: `envio:venda:${venda.id}:det` }));
  const ator2 = await criarAtor(2, 'gerente');
  let erro: any = null;
  try {
    await routes.detalharRemessa(reqDe({}, { params: { id: String(criado.envio.id) }, user: ator2 }), resFake().res);
  } catch (e) {
    erro = e;
  }
  assert.ok(erro && (erro.status === 403 || erro.status === 404));
});

test('api: providers não vaza credencial em claro', async () => {
  const ator = await criarAtor(1, 'admin');
  const r = await chamar(routes.listarProviders, reqDe({}, { user: ator }));
  assert.ok(Array.isArray(r.providers));
  const serializado = JSON.stringify(r);
  assert.doesNotMatch(serializado, /me_token"\s*:\s*"[^*]/); // nunca valor real
  for (const p of r.providers) {
    for (const v of Object.values((p.config?.credenciais ?? {}) as Record<string, unknown>)) {
      if (v !== null) assert.equal(v, '••••••••');
    }
  }
});

test('api: só admin altera configuração de operador', async () => {
  const gerente = await criarAtor(1, 'gerente');
  await esperarErro(() => routes.salvarProvider(reqDe({ habilitado: false }, { params: { slug: 'double' }, user: gerente }), resFake().res), 403);
});

test('api: habilitar operador externo sem credencial obrigatória é recusado', async () => {
  const admin = await criarAtor(1, 'admin');
  // 'jadlog' exige jadlog_token; sem ele, habilitar deve dar 409.
  await esperarErro(() => routes.salvarProvider(reqDe({ habilitado: true }, { params: { slug: 'jadlog' }, user: admin }), resFake().res), 409);
});

// ============================================================================
// 14. PAINEL
// ============================================================================
test('painel: devolve contadores e custos sem quebrar sem dados', async () => {
  const ator = await criarAtor(1, 'gerente');
  const r = await chamar(routes.painelLogistica, reqDe({}, { user: ator }));
  assert.equal(typeof r.contadores, 'object');
  assert.equal(typeof r.custo_previsto, 'number');
  assert.ok(Array.isArray(r.providers));
});

// ============================================================================
// 15. CONTRATO DE TRANSPORTADORA
// ============================================================================
test('carrier: registro e resolução por slug; slug desconhecido cai no nulo', () => {
  assert.ok(carrier('double'));
  assert.equal(carrier('nao_existe_zzz'), null);
  assert.equal(CARRIER_NULO.slug, 'nenhum');
});

test('carrier: operador com contrato (Jadlog) nasce DESABILITADO e diz o que falta — sem endpoint inventado', async () => {
  const { registrarCarriers } = await import('../../modules/logistics/providers/registry');
  registrarCarriers();
  const jadlog = carrier('jadlog');
  assert.ok(jadlog);
  // Sem configuração: não configurado, motivo explícito, e nenhuma chamada de rede.
  const disp = await jadlog!.disponivel(1);
  assert.equal(disp.configurado, false);
  assert.equal(disp.habilitado, false);
  assert.match(String(disp.motivo), /Sem contrato\/credencial/);
  // A cotação devolve nao_configurado, nunca uma opção inventada.
  const r = await jadlog!.cotar({
    empresaId: 1,
    origem: { cep: '01310100', uf: 'SP', cidade: 'São Paulo' },
    destino: { cep: '30130110', uf: 'MG', cidade: 'BH' },
    volumes: [{ peso_g: 1000 }],
    pesoTotalG: 1000,
    valorDeclarado: 100,
    servico: null,
  });
  assert.equal(r.ok, false);
  assert.equal((r as { motivo: string }).motivo, 'nao_configurado');
});
