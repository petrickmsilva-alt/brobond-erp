// ============================================================================
// ERP-GOLIVE-02 — INTEGRAÇÃO P1-01 ↔ P1-03
//
// A cadeia operacional completa, num único teste:
//
//   VENDA PRESENCIAL → PAGAMENTO → CAIXA → DOCUMENTO FISCAL → AUTORIZAÇÃO
//                  → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO
//
// A operação real não pode terminar com:
//   • caixa correto e fiscal quebrado;
//   • fiscal correto e expedição quebrada (o 409 da auditoria);
//   • estoque baixado duas vezes;
//   • pagamento duplicado;
//   • movimentação duplicada.
//
// Este teste amarra os dois P1 pela MESMA venda: o caixa confere pelo movimento
// líquido (troco não fica na gaveta) e a nota autorizada segue para a expedição
// sem refaturar nada.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-de-teste-golive-02';

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { registrarFiscalProvider } = await import('../src/fiscalProvider');
const { cifrarSegredo } = await import('../src/segredos');
const fiscal = await import('../src/fiscal');
const pdv = await import('../src/pdv');
const exp = await import('../src/expedicao');
const { ADMIN, chamar, esperarErro, garantirAdmin, novoLocal, reqDe, resFake } = await import('./_p1util');

await garantirAdmin();
await novoLocal('loja', 1, true);

const CHAVE = '35260111222333000181550010000001231234567890';

test('ERP-GOLIVE-02 E2E: venda presencial → pagamento → caixa → fiscal → autorização → expedição', async () => {
  const s = getStore();

  // ---- empresa emitente + cliente + produto tributado -----------------------
  await s.update(RESOURCES.empresas, 1, {
    razao_social: 'BROBOND CONFECCOES LTDA',
    cnpj: '11222333000181',
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
  const cliente = await s.insert(RESOURCES.clientes, {
    empresa_id: 1,
    nome: 'Cliente E2E Golive 02',
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
  const codigoBarras = `7894${String(Date.now()).slice(-9)}`;
  const produto = await s.insert(RESOURCES.produtos, {
    empresa_id: 1,
    sku: 'E2E-GOLIVE-02',
    nome: 'Camiseta E2E',
    codigo_barras: codigoBarras,
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
  const tam = await novoLocal('loja', 1, true).then(async () => {
    const existente = await s.findOneWhere(RESOURCES.tamanhos, { codigo: 'E2E' });
    return existente ?? s.insert(RESOURCES.tamanhos, { codigo: 'E2E', nome: 'E2E', ativo: true });
  });
  const localRow = await s.findOneWhere(RESOURCES.locais, { empresa_id: 1, nome: 'loja' });
  await s.insert(RESOURCES.estoques, {
    empresa_id: 1,
    produto_id: Number(produto.id),
    tamanho_id: Number(tam.id),
    local: 'loja',
    local_id: Number(localRow!.id),
    quantidade: 500,
    custo_medio: 40,
  });

  // ---- 1) VENDA PRESENCIAL + PAGAMENTO + CAIXA -----------------------------
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: 'CAIXA-E2E', valor_abertura: 100 }, {}), 201);
  const venda = await chamar(
    pdv.venderPdv,
    reqDe({
      itens: [{ produto_id: Number(produto.id), tamanho_id: Number(tam.id), quantidade: 2, desconto_pct: 0 }],
      pagamentos: [{ forma: 'dinheiro', valor: 250 }],
      cliente_id: Number(cliente.id),
    }),
    201
  );
  assert.equal(Number(venda.calculo.total), 200);
  assert.equal(Number(venda.calculo.troco), 50, '250 entregues para uma venda de 200');
  assert.equal(String(venda.venda.status), 'faturada', 'a venda do PDV nasce faturada (estoque baixado UMA vez)');

  const vendaId = Number(venda.venda_id);
  const saldoAposVenda = (await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tam.id), local: 'loja' }))!;
  assert.equal(Number(saldoAposVenda.quantidade), 498, 'a venda presencial baixou estoque uma única vez');

  const movimentos1 = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const lancamentos1 = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const pagamentos1 = await s.list(RESOURCES.pdv_pagamentos, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.equal(movimentos1.rows.length, 1, 'uma movimentação de estoque');
  assert.equal(pagamentos1.rows.length, 1, 'um pagamento registrado');
  assert.equal(Number(pagamentos1.rows[0].valor), 200, 'o movimento de caixa vale o líquido (250 − 50 de troco)');
  assert.ok(lancamentos1.rows.length >= 1, 'o financeiro foi lançado');

  const resumoCaixa = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }));
  assert.equal(Number(resumoCaixa.por_forma.dinheiro), 200, 'o troco NÃO fica na gaveta');
  assert.equal(Number(resumoCaixa.esperado_em_dinheiro), 300, '100 de abertura + 200');
  assert.equal(Number(resumoCaixa.total_vendido), Number(resumoCaixa.por_forma.dinheiro), 'Σ por_forma = total vendido');

  // ---- 2) DOCUMENTO FISCAL + AUTORIZAÇÃO -----------------------------------
  registrarFiscalProvider({
    nome: 'golive02-provider',
    configurado: () => true,
    emitir: async () => ({
      status: 'autorizado',
      mensagem: 'Autorizado o uso da NF-e',
      chave_acesso: CHAVE,
      protocolo: '135260000123456',
      numero: 10,
      serie: 1,
      xml: '<nfeProc/>',
    }),
    consultar: async () => ({ status: 'autorizado', mensagem: 'ok', chave_acesso: CHAVE, protocolo: '135260000123456' }),
    cancelar: async () => ({ status: 'cancelado', mensagem: 'ok', protocolo: '135260000999999' }),
    inutilizar: async () => ({ status: 'inutilizado', mensagem: 'ok' }),
  } as any);
  const cfg = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: 1 });
  const dadosCfg = {
    empresa_id: 1,
    provider: 'golive02-provider',
    provider_token_cifrado: cifrarSegredo('token-e2e'),
    ambiente: 'homologacao',
    habilitado: true,
    serie_nfe: 1,
    proximo_numero_nfe: 10,
    natureza_operacao_padrao: 'VENDA DE MERCADORIA',
    cfop_padrao_dentro_uf: '5102',
    cfop_padrao_fora_uf: '6102',
  };
  if (cfg) await s.update(RESOURCES.empresa_fiscal_config, Number(cfg.id), dadosCfg);
  else await s.insert(RESOURCES.empresa_fiscal_config, dadosCfg);

  const nota = await chamar(
    fiscal.emitirDocumento,
    reqDe({ modelo: '55' }, { params: { id: vendaId }, headers: { 'idempotency-key': `e2e-${vendaId}` } }),
    200
  );
  assert.equal(nota.status, 'autorizado');
  assert.equal(nota.emitido, true);

  // A autorização não pode duplicar NADA do que o PDV já fez.
  const movimentos2 = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const lancamentos2 = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const pagamentos2 = await s.list(RESOURCES.pdv_pagamentos, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  assert.equal(movimentos2.rows.length, movimentos1.rows.length, 'a nota autorizada não baixa estoque de novo');
  assert.equal(lancamentos2.rows.length, lancamentos1.rows.length, 'nem duplica o financeiro');
  assert.equal(pagamentos2.rows.length, pagamentos1.rows.length, 'nem o pagamento');
  const saldoAposNota = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tam.id), local: 'loja' });
  assert.equal(Number(saldoAposNota!.quantidade), 498);

  const vendaFiscal = await s.get(RESOURCES.vendas, vendaId);
  assert.equal(String(vendaFiscal!.status), 'faturada');
  assert.equal(String(vendaFiscal!.nfe_status), 'emitida');
  const doc = await s.findOneWhere(RESOURCES.documentos_fiscais, { venda_id: vendaId, status: 'autorizado' });
  assert.ok(doc, 'o documento fiscal autorizado existe');
  assert.ok(doc!.estoque_baixado_em && doc!.financeiro_lancado_em, 'os efeitos foram carimbados uma única vez');

  // ---- 3) EXPEDIÇÃO: SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO -------
  // Antes do P1-03 este primeiro passo respondia 409 "já foi faturado".
  const separada = await chamar(exp.separarPedido, reqDe({}, { params: { id: vendaId } }));
  assert.equal(separada.etapa, 'separacao');
  const conferida = await chamar(exp.conferirPedido, reqDe({ codigos: [codigoBarras, codigoBarras] }, { params: { id: vendaId } }));
  assert.equal(conferida.etapa, 'conferida');
  const embalada = await chamar(exp.embalarPedido, reqDe({}, { params: { id: vendaId } }));
  assert.equal(embalada.etapa, 'embalada');
  const expedida = await chamar(exp.expedirPedido, reqDe({}, { params: { id: vendaId } }));
  assert.equal(expedida.etapa, 'expedida');

  // ---- 4) INVARIANTES FINAIS ------------------------------------------------
  const movimentos3 = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const lancamentos3 = await s.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const pagamentos3 = await s.list(RESOURCES.pdv_pagamentos, { page: 1, pageSize: 50, filter: { venda_id: vendaId } });
  const saldoFinal = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), tamanho_id: Number(tam.id), local: 'loja' });

  assert.equal(saldoFinal!.quantidade, 498, 'estoque baixado UMA vez do começo ao fim');
  assert.equal(movimentos3.rows.length, 1, 'uma única movimentação de estoque');
  assert.equal(pagamentos3.rows.length, 1, 'um único pagamento');
  assert.equal(Number(pagamentos3.rows[0].valor), 200, 'o pagamento continua sendo o movimento líquido');
  assert.equal(lancamentos3.rows.length, lancamentos1.rows.length, 'nenhum lançamento financeiro duplicado');
  assert.equal((await s.get(RESOURCES.vendas, vendaId))!.expedicao_etapa, 'expedida');

  const eventos = await s.list(RESOURCES.expedicao_eventos, { page: 1, pageSize: 50, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  assert.deepEqual(
    eventos.rows.map((e: any) => String(e.etapa)),
    ['separacao', 'conferida', 'embalada', 'expedida'],
    'a trilha logística registra a sequência canônica'
  );


  // Troco maior que o dinheiro entregue: guarda-corpo da gaveta.
  await esperarErro(
    () =>
      pdv.venderPdv(
        reqDe({
          itens: [{ produto_id: Number(produto.id), tamanho_id: Number(tam.id), quantidade: 1, desconto_pct: 0 }],
          pagamentos: [
            { forma: 'dinheiro', valor: 20 },
            { forma: 'cartao_credito', valor: 120 },
          ],
        }),
        resFake().res
      ),
    400,
    /troco/i
  );

  // ---- 5) O CAIXA CONTINUA CONFERINDO (e fecha sem divergência) ------------
  const resumoFinal = await chamar(pdv.resumoCaixaHandler, reqDe({}, { params: { id: caixa.id } }));
  assert.equal(Number(resumoFinal.esperado_em_dinheiro), 300);
  assert.equal(Number(resumoFinal.quantidade_vendas), 1);
  const fechamento = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 300 }, { params: { id: caixa.id } }));
  assert.equal(Number(fechamento.diferenca), 0, 'a gaveta fecha com o esperado dos movimentos');
  assert.equal(Number(fechamento.caixa.valor_sistema), 300);

  // ---- 6) A trilha de auditoria cobre venda, caixa e fiscal ----------------
  const auditoria = await s.list(RESOURCES.auditoria, { page: 1, pageSize: 200 });
  const descricoes = auditoria.rows.map((a: any) => String(a.descricao ?? ''));
  assert.ok(descricoes.some((d: string) => d.includes(`Venda PDV #${vendaId}`)), 'a venda do PDV está auditada');
  assert.ok(descricoes.some((d: string) => d.includes('NFC-e') || d.includes('NF-e')), 'a autorização fiscal está auditada');

});
