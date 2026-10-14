// ============================================================================
// P1-03 — FISCAL → EXPEDIÇÃO
//
// DEFEITO REPRODUZIDO (auditoria ERP-COMMERCE-01-GO-LIVE):
//
//   AUTORIZAÇÃO FISCAL → EXPEDIÇÃO → HTTP 409
//
// A nota autorizada confere à venda o status `faturada` (estoque baixado e
// financeiro lançado — `aplicarEfeitosDaAutorizacao`, server/src/fiscal.ts).
// Só que a máquina logística recusava QUALQUER venda faturada:
//
//   separarPedido → 409 "Este pedido já foi faturado — a separação acontece antes do faturamento."
//
// Ou seja: a operação que DEVE ser expedida (a nota existe, a mercadoria ainda
// não saiu) era a única que não conseguia entrar no fluxo.
//
// O que este arquivo protege:
//   • NF AUTORIZADA segue: AUTORIZADA → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM →
//     EXPEDIÇÃO, com UM único fato econômico (uma baixa de estoque, um
//     lançamento) — a expedição NÃO refatura o que a autorização já faturou;
//   • documento pendente / rejeitado / cancelado continua BLOQUEANDO a
//     expedição (a proteção fiscal não é afrouxada);
//   • venda faturada SEM documento fiscal continua fora do fluxo logístico
//     (comportamento preservado);
//   • expedição repetida e expedições concorrentes não duplicam estoque;
//   • falha no meio do fluxo não deixa estado parcial;
//   • empresa B não opera a expedição de A.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-de-teste-fiscal-expedicao';

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { registrarFiscalProvider } = await import('../src/fiscalProvider');
const { cifrarSegredo } = await import('../src/segredos');
const fiscal = await import('../src/fiscal');
const exp = await import('../src/expedicao');
const { ADMIN, chamar, criarAtor, esperarErro, garantirAdmin, novoLocal, reqDe, resFake } = await import('./_p1util');

await garantirAdmin();
await novoLocal('loja', 1, true);

const CHAVE_44 = '35260111222333000181550010000001231234567890';

type Cenario = {
  empresaId: number;
  ator: typeof ADMIN;
  vendaId: number;
  produtoId: number;
  tamanhoId: number;
  clienteId: number;
  codigos: string[];
  quantidade: number;
  local: string;
};

let seq = 0;

/** Empresa com dados fiscais completos (emitente) — o mesmo contrato do fiscal.test.ts. */
async function prepararEmpresa(empresaId: number) {
  const s = getStore();
  const existente = await s.get(RESOURCES.empresas, empresaId);
  if (!existente) {
    await s.insert(RESOURCES.empresas, { id: empresaId, nome: `Empresa P1-03 ${empresaId}`, ativo: true });
  }
  await s.update(RESOURCES.empresas, empresaId, {
    razao_social: `EMPRESA P1-03 ${empresaId} LTDA`,
    cnpj: empresaId === 1 ? '11222333000181' : '11222333000262',
    ie: '1234567890',
    crt: '3',
    cep: '01001000',
    logradouro: 'Praça da Sé',
    numero: '1',
    bairro: 'Sé',
    cidade: 'São Paulo',
    codigo_municipio: '3550308',
    uf: 'SP',
  });
}

/**
 * Venda ABERTA com item que TEM código de barras e produto com tributação
 * resolvida: exatamente o cenário em que a nota é emitida ANTES da expedição
 * (faturamento pela SEFAZ, mercadoria ainda no galpão).
 */
async function cenario(empresaId = 1, quantidade = 2, ator: typeof ADMIN = ADMIN): Promise<Cenario> {
  const s = getStore();
  seq++;
  await prepararEmpresa(empresaId);
  // Local único e padrão por empresa: é o local que o faturamento usa.
  const local = 'loja';
  const localRow = await novoLocal(local, empresaId, true);

  const cliente = await s.insert(RESOURCES.clientes, {
    empresa_id: empresaId,
    nome: `Cliente P1-03 ${seq}`,
    pessoa: 'pj',
    cnpj_cpf: '19131243000197',
    indicador_ie: '1',
    rg_ie: '111222333',
    cep: '20040002',
    logradouro: 'Av. Rio Branco',
    numero: '100',
    bairro: 'Centro',
    cidade: 'Rio de Janeiro',
    codigo_municipio: '3304557',
    uf: 'RJ',
    ativo: true,
  });

  const codigo = `7891${String(Date.now()).slice(-7)}${String(seq).padStart(2, '0')}`;
  const produto = await s.insert(RESOURCES.produtos, {
    empresa_id: empresaId,
    sku: `P103-${empresaId}-${seq}`,
    nome: `Camiseta P1-03 ${seq}`,
    codigo_barras: codigo,
    ncm: '61091000',
    origem: '0',
    cfop_saida: '6102',
    icms_cst: '00',
    icms_aliquota: 12,
    pis_cst: '01',
    pis_aliquota: 1.65,
    cofins_cst: '01',
    cofins_aliquota: 7.6,
    preco_venda: 100,
    custo: 40,
    unidade: 'un',
    ativo: true,
  });

  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `T${seq}`, nome: `T${seq}`, ativo: true });
  // Vínculo canônico do local: sem `local_id` o faturamento recusa baixar
  // ("saldo possui vínculo canônico de local ausente ou inconsistente").
  await s.insert(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: Number(produto.id),
    tamanho_id: Number(tam.id),
    local,
    local_id: Number(localRow.id),
    quantidade: 50,
    custo_medio: 40,
  });

  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: empresaId,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'aberta',
    canal_venda: 'balcao',
    local_saida: local,
    total: quantidade * 100,
  });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: empresaId,
    venda_id: Number(venda.id),
    produto_id: Number(produto.id),
    tamanho_id: Number(tam.id),
    quantidade,
    preco_unitario: 100,
    subtotal: quantidade * 100,
  });

  return {
    empresaId,
    ator,
    vendaId: Number(venda.id),
    produtoId: Number(produto.id),
    tamanhoId: Number(tam.id),
    clienteId: Number(cliente.id),
    codigos: Array.from({ length: quantidade }, () => codigo),
    quantidade,
    local,
  };
}

async function saldo(c: Cenario): Promise<number> {
  const row = await getStore().findOneWhere(RESOURCES.estoques, {
    empresa_id: c.empresaId,
    produto_id: c.produtoId,
    tamanho_id: c.tamanhoId,
    local: c.local,
  });
  return Number(row?.quantidade ?? 0);
}

function provedorFalso(nome: string, resposta: Record<string, unknown> | (() => Record<string, unknown>)) {
  const responder = () => (typeof resposta === 'function' ? resposta() : resposta);
  registrarFiscalProvider({
    nome,
    configurado: () => true,
    emitir: async () => responder() as any,
    consultar: async () => responder() as any,
    cancelar: async () => responder() as any,
    inutilizar: async () => responder() as any,
  } as any);
}

async function habilitar(empresaId: number, nome: string) {
  const s = getStore();
  const atual = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: empresaId });
  const dados = {
    empresa_id: empresaId,
    provider: nome,
    provider_token_cifrado: cifrarSegredo('token-de-teste-p103'),
    ambiente: 'homologacao',
    habilitado: true,
    serie_nfe: 1,
    proximo_numero_nfe: 1,
    serie_nfce: 1,
    proximo_numero_nfce: 1,
    natureza_operacao_padrao: 'VENDA DE MERCADORIA',
    cfop_padrao_dentro_uf: '5102',
    cfop_padrao_fora_uf: '6102',
  };
  if (atual) return s.update(RESOURCES.empresa_fiscal_config, Number(atual.id), dados);
  return s.insert(RESOURCES.empresa_fiscal_config, dados);
}

const AUTORIZADOR = 'p103-autorizador';
const PENDENTE = 'p103-sem-credencial';
const REJEITADOR = 'p103-rejeitador';

function registrarProvedores() {
  registrarFiscalProvider({
    nome: AUTORIZADOR,
    configurado: () => true,
    emitir: async () => ({
      status: 'autorizado',
      mensagem: 'Autorizado o uso da NF-e',
      chave_acesso: CHAVE_44,
      protocolo: '135260000123456',
      numero: 1,
      serie: 1,
      xml: '<nfeProc/>',
    }),
    consultar: async () => ({ status: 'autorizado', mensagem: 'Autorizado o uso da NF-e', chave_acesso: CHAVE_44, protocolo: '135260000123456' }),
    // O MESMO provedor cancela: o cancelamento responde sobre o documento dele.
    cancelar: async () => ({ status: 'cancelado', mensagem: 'Cancelamento homologado', protocolo: '135260000999999' }),
    inutilizar: async () => ({ status: 'inutilizado', mensagem: 'ok' }),
  } as any);
  // Sem credencial: o documento existe e fica PENDENTE — nunca autorizado.
  registrarFiscalProvider({
    nome: PENDENTE,
    configurado: () => false,
    emitir: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
    consultar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
    cancelar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
    inutilizar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
  } as any);
  provedorFalso(REJEITADOR, () => ({ status: 'rejeitado', mensagem: 'Rejeicao: CFOP incompativel com a operacao' }));
}

registrarProvedores();

/** Emite a nota da venda pelo endpoint REAL (fiscal.ts) — nada de gravar documento à mão. */
async function emitir(c: Cenario, modelo: '55' | '65' = '55', user?: any, esperado = 200) {
  return chamar(
    fiscal.emitirDocumento,
    reqDe({ modelo }, { user: user ?? c.ator, params: { id: c.vendaId }, headers: { 'idempotency-key': `p103-${c.vendaId}-${modelo}` } }),
    esperado
  );
}

/** Estado logístico da venda (o default do recurso é `pendente`). */
async function etapaDe(vendaId: number): Promise<string> {
  return String((await getStore().get(RESOURCES.vendas, vendaId))!.expedicao_etapa ?? 'pendente');
}

async function autorizar(c: Cenario, user?: any) {
  await habilitar(c.empresaId, AUTORIZADOR);
  return emitir(c, '55', user);
}

async function separar(c: Cenario, user?: any) {
  return chamar(exp.separarPedido, reqDe({}, { user: user ?? c.ator, params: { id: c.vendaId } }));
}
async function conferir(c: Cenario, codigos?: string[], user?: any) {
  return chamar(exp.conferirPedido, reqDe({ codigos: codigos ?? c.codigos }, { user: user ?? c.ator, params: { id: c.vendaId } }));
}
async function embalar(c: Cenario, user?: any) {
  return chamar(exp.embalarPedido, reqDe({}, { user: user ?? c.ator, params: { id: c.vendaId } }));
}
async function expedir(c: Cenario, user?: any) {
  return chamar(exp.expedirPedido, reqDe({}, { user: user ?? c.ator, params: { id: c.vendaId } }));
}

/** Últimos estados do documento fiscal da venda. */
async function documentoDaVenda(vendaId: number) {
  const s = getStore();
  const docs = await s.list(RESOURCES.documentos_fiscais, { page: 1, pageSize: 10, filter: { venda_id: vendaId }, sort: 'id', dir: 'desc' });
  return docs.rows[0] ?? null;
}

async function vendaDe(vendaId: number) {
  return getStore().get(RESOURCES.vendas, vendaId);
}

async function movimentosDeEstoque(vendaId: number) {
  const s = getStore();
  return s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
}

async function eventosDeExpedicao(vendaId: number) {
  const s = getStore();
  return s.list(RESOURCES.expedicao_eventos, { page: 1, pageSize: 50, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
}

// ---------------------------------------------------------------------------
// M + A) CENÁRIO EXATO: autorização fiscal → expedição (o 409)
// ---------------------------------------------------------------------------

test('P1-03 (M/A): NF autorizada entra em separação, confere, embala e expede — sem duplicar baixa', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);

  // ---- AUTORIZAÇÃO FISCAL (endpoint real, provedor de teste) ----------------
  const nota = await autorizar(c);
  assert.equal(nota.status, 'autorizado');
  assert.equal(nota.emitido, true);

  const vendaFaturada = await vendaDe(c.vendaId);
  assert.equal(String(vendaFaturada!.status), 'faturada', 'a autorização fatura a venda');
  assert.equal(await saldo(c), antes - 2, 'a autorização baixa o estoque UMA vez');
  assert.equal((await movimentosDeEstoque(c.vendaId)).rows.length, 1);

  // ---- EXPEDIÇÃO: antes do conserto, o passo 1 respondia 409 ----------------
  const separada = await separar(c);
  assert.equal(separada.etapa, 'separacao');

  const conferida = await conferir(c);
  assert.equal(conferida.etapa, 'conferida');

  const embalada = await embalar(c);
  assert.equal(embalada.etapa, 'embalada');

  const expedida = await expedir(c);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(String(expedida.status), 'faturada');

  // ---- UM único fato econômico ---------------------------------------------
  assert.equal(await saldo(c), antes - 2, 'a expedição NÃO baixa o estoque de novo');
  assert.equal((await movimentosDeEstoque(c.vendaId)).rows.length, 1, 'uma saída, um vínculo com a venda');

  const lancamentos = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'venda', referencia_id: c.vendaId } });
  assert.ok(lancamentos.rows.length >= 1, 'o financeiro foi lançado pela autorização');
  assert.equal(new Set(lancamentos.rows.map((r: any) => String(r.id))).size, lancamentos.rows.length, 'sem lançamento duplicado');

  // A trilha logística registra a sequência canônica.
  const eventos = await eventosDeExpedicao(c.vendaId);
  assert.deepEqual(
    eventos.rows.map((e: any) => String(e.etapa)),
    ['separacao', 'conferida', 'embalada', 'expedida']
  );
  assert.ok(eventos.rows.every((e: any) => String(e.resultado) === 'ok'));

  // O documento fiscal continua íntegro e vinculado à venda.
  const doc = await documentoDaVenda(c.vendaId);
  assert.equal(String(doc!.status), 'autorizado');
  assert.equal(Number(vendaFaturada!.documento_fiscal_id), Number(doc!.id));
  assert.equal((await vendaDe(c.vendaId))!.nfe_status, 'emitida');
});

// ---------------------------------------------------------------------------
// B) C) D) Documento que NÃO está autorizado bloqueia a expedição
// ---------------------------------------------------------------------------

test('P1-03 (B): documento fiscal PENDENTE bloqueia a expedição', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await habilitar(1, PENDENTE);

  await esperarErro(() => emitir(c), 409, /NÃO emitido/);
  const doc = await documentoDaVenda(c.vendaId);
  assert.equal(String(doc!.status), 'pendente');

  // A separação física acontece; o que não acontece é a mercadoria sair.
  await separar(c);
  await conferir(c);
  await embalar(c);
  const erro = await esperarErro(() => expedir(c), 409, /documento fiscal/i);
  assert.match(String(erro.message), /pendente/i, 'a mensagem diz o estado real do documento');
  assert.equal(await saldo(c), antes, 'nenhuma baixa de estoque');
  assert.equal((await vendaDe(c.vendaId))!.status, 'aberta', 'a venda não foi faturada');
});

test('P1-03 (C): documento REJEITADO bloqueia a expedição', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await habilitar(1, REJEITADOR);

  await emitir(c, '55', undefined, 202);
  assert.equal(String((await documentoDaVenda(c.vendaId))!.status), 'rejeitado');

  await separar(c);
  await conferir(c);
  await embalar(c);
  await esperarErro(() => expedir(c), 409, /documento fiscal/i);
  assert.equal(await saldo(c), antes);
  assert.equal((await vendaDe(c.vendaId))!.status, 'aberta');
});

test('P1-03 (D): documento CANCELADO bloqueia a expedição', async () => {
  const c = await cenario(1, 2);
  await autorizar(c);

  // Autorizada e depois cancelada na SEFAZ (provedor real de cancelamento).
  const doc = await documentoDaVenda(c.vendaId);
  await chamar(fiscal.cancelarDocumento, reqDe({ justificativa: 'Erro na emissão da nota fiscal' }, { params: { id: Number(doc!.id) } }));
  assert.equal(String((await documentoDaVenda(c.vendaId))!.status), 'cancelado');
  assert.equal((await vendaDe(c.vendaId))!.nfe_status, 'cancelada');

  const erro = await esperarErro(() => separar(c), 409);
  assert.match(String(erro.message), /faturado|fiscal/i, 'a venda continua bloqueada para expedição');
  await esperarErro(() => expedir(c), 409);
});

// ---------------------------------------------------------------------------
// Proteção preservada: faturada SEM documento fiscal continua fora do fluxo
// ---------------------------------------------------------------------------

test('P1-03: venda faturada SEM documento fiscal continua bloqueada (proteção preservada)', async () => {
  const c = await cenario(1, 2);
  await getStore().update(RESOURCES.vendas, c.vendaId, { status: 'faturada' });
  await esperarErro(() => separar(c), 409, /já foi faturado/);
  await esperarErro(() => expedir(c), 409);
});

test('P1-03 (A/B): status da venda revertido à mão NÃO refatura — o carimbo do documento manda', async () => {
  // `vendas.status` é editável pelo CRUD genérico; o carimbo do documento
  // autorizado (`estoque_baixado_em`, gravado na MESMA transação do efeito) não
  // é. Se alguém reverter o status para "aberta" depois da autorização, a
  // expedição NÃO pode baixar o estoque de novo: o fato econômico já aconteceu.
  // Ela apenas restaura o status e avança a etapa logística.
  const c = await cenario(1, 1);
  const antes = await saldo(c);
  await autorizar(c);
  const movimentosAposNota = (await movimentosDeEstoque(c.vendaId)).rows.length;
  assert.equal(await saldo(c), antes - 1, 'a autorização baixou uma vez');

  await getStore().update(RESOURCES.vendas, c.vendaId, { status: 'aberta' });
  assert.equal(await etapaDe(c.vendaId), 'pendente', 'a autorização não mexe na etapa logística');

  await separar(c);
  await conferir(c);
  await embalar(c);
  const expedida = await expedir(c);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldo(c), antes - 1, 'UMA baixa — a expedição não refaturou');
  assert.equal((await movimentosDeEstoque(c.vendaId)).rows.length, movimentosAposNota, 'nenhuma movimentação nova');
  assert.equal(String((await vendaDe(c.vendaId))!.status), 'faturada', 'o status volta ao que o efeito aplicado exige');
});

// ---------------------------------------------------------------------------
// I) Expedição repetida
// ---------------------------------------------------------------------------

test('P1-03 (N): venda ENTREGUE — com documento autorizado expede; sem documento continua bloqueada', async () => {
  // `entregue` é o outro status terminal do faturamento. A proteção tem que
  // valer IGUAL: com documento autorizado a mercadoria sai (uma única baixa);
  // sem documento autorizado o galpão continua fechado.
  // (1) COM documento autorizado
  const comNota = await cenario(1, 1);
  const saldoAntes = await saldo(comNota);
  await autorizar(comNota);
  assert.equal(await saldo(comNota), saldoAntes - 1, 'a autorização baixou uma vez');
  await getStore().update(RESOURCES.vendas, comNota.vendaId, { status: 'entregue' });

  await separar(comNota);
  await conferir(comNota);
  await embalar(comNota);
  const expedida = await expedir(comNota);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldo(comNota), saldoAntes - 1, 'UMA baixa: entregue com nota não refatura');
  assert.equal((await movimentosDeEstoque(comNota.vendaId)).rows.length, 1);

  // (2) SEM documento autorizado — o mesmo status NÃO abre o galpão
  const semNota = await cenario(1, 1);
  const saldoIntacto = await saldo(semNota);
  await getStore().update(RESOURCES.vendas, semNota.vendaId, { status: 'entregue' });
  await esperarErro(() => separar(semNota), 409, /já foi faturado/);
  assert.equal(await saldo(semNota), saldoIntacto, 'nada saiu do estoque');
  assert.equal(await etapaDe(semNota.vendaId), 'pendente', 'a etapa não avançou');
});

test('P1-03 (I): expedição repetida não duplica estoque nem evento', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await autorizar(c);
  await separar(c);
  await conferir(c);
  await embalar(c);
  await expedir(c);

  const eventosAntes = (await eventosDeExpedicao(c.vendaId)).rows.length;
  await esperarErro(() => expedir(c), 409, /Só se expede|já está faturado|expedida/);
  assert.equal(await saldo(c), antes - 2, 'nenhuma segunda baixa');
  assert.equal((await eventosDeExpedicao(c.vendaId)).rows.length, eventosAntes, 'nenhum evento novo');
});

test('P1-03 (I): autorização repetida devolve o MESMO documento e não refatura', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  const primeira = await autorizar(c);
  const segunda = await emitir(c);
  assert.equal(Number(segunda.documento_id), Number(primeira.documento_id));
  assert.equal(await saldo(c), antes - 2, 'a repetição não baixa estoque de novo');

  const lancamentos = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'venda', referencia_id: c.vendaId } });
  assert.ok(lancamentos.rows.length >= 1);
});

// ---------------------------------------------------------------------------
// J) Duas expedições concorrentes
// ---------------------------------------------------------------------------

test('P1-03 (J): duas expedições simultâneas — nunca duas baixas (memória)', async () => {
  // O banco em memória NÃO tem isolamento de transação (o rollback restaura o
  // snapshot inteiro — ver server/test/pg-concorrencia.test.ts). Aqui se prova
  // o que não pode acontecer: efeito dobrado. A corrida com vencedor único é
  // provada em PostgreSQL, em pg/e424-golive-02-postgresql.test.ts.
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await autorizar(c);
  await separar(c);
  await conferir(c);
  await embalar(c);

  const tentar = () => expedir(c).then((r: any) => ({ ok: true, etapa: r.etapa }), (e: any) => ({ ok: false, status: e?.status }));
  const resultados = await Promise.all([tentar(), tentar()]);
  const vencedoras = resultados.filter((r: any) => r.ok);
  assert.ok(vencedoras.length <= 1, `no máximo uma expedição vence: ${JSON.stringify(resultados)}`);

  const depois = await saldo(c);
  assert.ok(
    [antes - 2, antes].includes(depois),
    `a baixa nunca acontece duas vezes: ${antes} → ${depois}`
  );
  assert.equal((await movimentosDeEstoque(c.vendaId)).rows.length <= 1, true, 'no máximo uma saída');
  assert.ok(
    (await eventosDeExpedicao(c.vendaId)).rows.filter((e: any) => String(e.etapa) === 'expedida').length <= 1,
    'no máximo um evento final'
  );
  for (const perdedora of resultados.filter((r: any) => !r.ok)) {
    assert.ok([409, 422].includes(Number(perdedora.status)), `perdedora com conflito controlado: ${JSON.stringify(perdedora)}`);
  }
});

// ---------------------------------------------------------------------------
// K) Falha no meio da transição não deixa estado parcial
// ---------------------------------------------------------------------------

test('P1-03 (K): conferência divergente aborta sem baixa e sem mudar a etapa', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await autorizar(c);
  await separar(c);

  // Falta uma peça na leitura → 422 e a divergência fica registrada.
  const erro = await esperarErro(() => conferir(c, [c.codigos[0]]), 422, /conferência física/i);
  assert.ok(erro.fields?.divergencia_id, 'a divergência é auditável mesmo abortando a transação');
  assert.equal((await vendaDe(c.vendaId))!.expedicao_etapa, 'separacao', 'a etapa NÃO avançou');
  assert.equal(await saldo(c), antes - 2, 'a baixa que veio da autorização continua sendo a única');

  // Corrigida a leitura, o fluxo segue normalmente.
  await conferir(c);
  assert.equal((await vendaDe(c.vendaId))!.expedicao_etapa, 'conferida');
});

test('P1-03 (K): expedir sem embalar e embalar sem conferir são recusados sem efeito', async () => {
  const c = await cenario(1, 2);
  const antes = await saldo(c);
  await autorizar(c);

  await esperarErro(() => embalar(c), 409, /Só se embala/);
  await separar(c);
  await esperarErro(() => expedir(c), 409, /Só se expede um pedido embalado/);
  assert.equal(await saldo(c), antes - 2, 'nada mudou no estoque');
  assert.equal((await vendaDe(c.vendaId))!.expedicao_etapa, 'separacao');
});

// ---------------------------------------------------------------------------
// L) Multiempresa
// ---------------------------------------------------------------------------

test('P1-03 (L): empresa B não opera a expedição de A (e a dela funciona)', async () => {
  const s = getStore();
  const atorB = await criarAtor(2, 'gerente');
  await prepararEmpresa(2);
  await novoLocal('loja', 2, true);

  const a = await cenario(1, 2);
  const b = await cenario(2, 2, atorB as any);

  await autorizar(a);
  await autorizar(b, atorB);

  // B não vê nem opera a venda de A — mesmo com a nota de A autorizada.
  await esperarErro(() => separar(a, atorB), 404);
  await esperarErro(() => conferir(a, a.codigos, atorB), 404);
  await esperarErro(() => expedir(a, atorB), 404);
  assert.equal(await etapaDe(a.vendaId), 'pendente', 'A não foi tocada por B');

  // O documento de A não aparece para B.
  const docsDeA = await s.list(RESOURCES.documentos_fiscais, { page: 1, pageSize: 10, filter: { venda_id: a.vendaId } });
  for (const doc of docsDeA.rows) {
    assert.equal(Number(doc.empresa_id), 1);
  }

  // O fluxo de B, com os dados de B, funciona.
  await separar(b, atorB);
  await conferir(b, b.codigos, atorB);
  await embalar(b, atorB);
  const expedidaB = await expedir(b, atorB);
  assert.equal(expedidaB.etapa, 'expedida');
  assert.equal(await etapaDe(b.vendaId), 'expedida');
  assert.equal(await etapaDe(a.vendaId), 'pendente', 'a expedição de B não tocou A');
});
