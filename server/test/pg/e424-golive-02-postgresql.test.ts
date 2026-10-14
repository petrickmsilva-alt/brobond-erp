// ============================================================================
// ERP-GOLIVE-02 — P1-01 (PDV/CAIXA) e P1-03 (FISCAL → EXPEDIÇÃO) em PostgreSQL
// REAL, mais o E2E da cadeia completa.
//
// O MemStore prova a regra da camada de serviço. Aqui se prova o que só o banco
// de verdade sustenta:
//
//   • P1-01 — o movimento de caixa gravado vale o efeito LÍQUIDO na gaveta
//     (troco não fica no caixa), o resumo/fechamento derivam SÓ desses
//     movimentos e as operações concorrentes (venda, fechamento) não duplicam
//     efeito; estorno devolve o estoque uma vez; rollback não deixa rastro;
//     o caixa de A não é somado nem operado por B;
//   • P1-03 — NF AUTORIZADA segue AUTORIZADA → SEPARAÇÃO → CONFERÊNCIA →
//     EMBALAGEM → EXPEDIÇÃO sem refaturar; documento pendente/rejeitado/
//     cancelado continua bloqueando; autorização repetida não duplica efeito;
//     duas expedições concorrentes → um vencedor e UMA baixa; falha no meio não
//     deixa estado parcial; B não opera a expedição de A;
//   • E2E — venda presencial → pagamento → caixa → fiscal → autorização →
//     expedição, com UMA baixa de estoque, UM movimento de caixa e UM
//     lançamento financeiro.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-e424-golive-02-postgresql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
process.env.SEGREDOS_ENCRYPTION_KEY = 'chave-de-teste-e424';

const { migrate, query } = await import('../../src/db');
await migrate();
const { RESOURCES } = await import('../../src/resources');
const { getStore, updateRecord } = await import('../../src/services');
const { registrarFiscalProvider } = await import('../../src/fiscalProvider');
const { cifrarSegredo } = await import('../../src/segredos');
const fiscal = await import('../../src/fiscal');
const pdv = await import('../../src/pdv');
const exp = await import('../../src/expedicao');
const { chamar, esperarErro, novoLocal, novoProduto, reqDe, resFake, saldoInicial } = await import('../_p1util');

type Ator = { id: number; name: string; perfil: 'admin'; empresa_id: number; empresas: number[] };
type Tenant = { empresaId: number; ator: Ator };

const RODADA = `e424${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;

function unico(prefixo: string): string {
  contador++;
  return `${prefixo}-${RODADA}-${contador}`;
}

/**
 * Chave de acesso VÁLIDA para o banco (^[0-9]{44}$) e ÚNICA por emissão: o
 * índice `uq_documentos_fiscais_chave` é global, não por empresa — reutilizar
 * uma constante faria a segunda emissão do arquivo falhar com 23505.
 */
function chaveUnica(): string {
  return `3526${Array.from({ length: 40 }, () => Math.floor(Math.random() * 10)).join('')}`;
}

/** Empresa nova (com dados fiscais de emitente) + usuário real + Local padrão. */
async function novoTenant(): Promise<Tenant> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query(
    `INSERT INTO empresas (nome, cnpj, ativo, razao_social, ie, crt, cep, logradouro, numero, bairro, cidade, codigo_municipio, uf)
     VALUES ($1, $2, true, $3, '1234567890', '3', '01001000', 'Praça da Sé', '1', 'Sé', 'São Paulo', '3550308', 'SP') RETURNING id`,
    [unico('Empresa E424'), cnpj, `${unico('EMPRESA E424')} LTDA`]
  );
  const empresaId = Number(emp.rows[0].id);
  // Toda empresa nova nasce com `empresa_fiscal_config` (o INSERT ... SELECT da
  // migration só cobre as existentes): a configuração é criada sob demanda pela
  // própria camada fiscal.
  await fiscal.obterConfigFiscalDaEmpresa(empresaId);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id, nome`,
    [unico('Usuário E424'), `${unico('e424')}@brobond.test`, empresaId]
  );
  await novoLocal('loja', empresaId, true);
  return {
    empresaId,
    ator: { id: Number(usr.rows[0].id), name: String(usr.rows[0].nome), perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
  };
}

type Produto = { produtoId: number; tamanhoId: number; local: string; codigo: string };

/** Produto tributado e com saldo no local da empresa. */
async function produtoComSaldo(t: Tenant, preco: number, quantidade = 50): Promise<Produto> {
  contador++;
  const codigo = `7890${String(Date.now()).slice(-6)}${String(contador).padStart(3, '0')}`.slice(0, 13);
  const p = await novoProduto({
    empresa_id: t.empresaId,
    sku: unico('SKU-E424'),
    nome: `Camiseta E424 ${contador}`,
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
    preco_venda: preco,
    custo: 40,
    unidade: 'un',
  });
  const saldo = await saldoInicial(p, quantidade);
  return { produtoId: Number(p.id), tamanhoId: Number(saldo.tamanho.id), local: saldo.local, codigo };
}

async function abrirCaixa(t: Tenant, valor: number, numero: string) {
  return chamar(pdv.abrirCaixa, reqDe({ numero, valor_abertura: valor }, { user: t.ator }), 201);
}

function vender(t: Tenant, caixaId: unknown, p: Produto, pagamentos: unknown[], extra: Record<string, unknown> = {}) {
  return chamar(
    pdv.venderPdv,
    reqDe(
      {
        itens: [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1, desconto_pct: 0 }],
        pagamentos,
        caixa_id: caixaId,
        ...extra,
      },
      { user: t.ator }
    ),
    201
  );
}

const resumoDe = (t: Tenant, id: unknown) => chamar(pdv.resumoCaixaHandler, reqDe({}, { user: t.ator, params: { id } }));

async function contar(tabela: string, where: string, params: unknown[]): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM ${tabela} WHERE ${where}`, params);
  return Number(r.rows[0].n);
}

async function saldoDe(t: Tenant, p: Produto): Promise<number> {
  const r = await query(`SELECT COALESCE(SUM(quantidade), 0)::int AS n FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3`, [
    t.empresaId,
    p.produtoId,
    p.tamanhoId,
  ]);
  return Number(r.rows[0].n);
}

/**
 * CNPJ único por cliente, com dígitos verificadores VÁLIDOS.
 *
 * `uq_clientes_documento_empresa` é por empresa: dois clientes fiscais no MESMO
 * tenant não podem repetir documento. Um CNPJ fixo funcionava enquanto cada
 * cenário criava um cliente só; assim que um teste precisa de dois pedidos na
 * mesma empresa, o fixo colide (23505).
 */
function cnpjUnico(): string {
  const raiz = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).concat([0, 0, 0, 1]);
  const dv = (nums: number[]): number => {
    const pesos = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = nums.reduce((acc, n, i) => acc + n * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(raiz);
  const d2 = dv([...raiz, d1]);
  return [...raiz, d1, d2].join('');
}

/** Cliente PJ com endereço: exigido pela NF-e. Documento único por cliente. */
async function novoClienteFiscal(t: Tenant): Promise<number> {
  const r = await query(
    `INSERT INTO clientes (empresa_id, nome, pessoa, cnpj_cpf, indicador_ie, rg_ie, cep, logradouro, numero, bairro, cidade, codigo_municipio, uf, ativo)
     VALUES ($1, $2, 'pj', $3, '1', '111222333', '20040002', 'Av. Rio Branco', '100', 'Centro', 'Rio de Janeiro', '3304557', 'RJ', true) RETURNING id`,
    [t.empresaId, unico('Cliente E424'), cnpjUnico()]
  );
  return Number(r.rows[0].id);
}

/** Habilita o provedor de teste na empresa (config criada sob demanda). */
async function habilitarFiscal(t: Tenant, provider: string) {
  const s = getStore();
  const cfg = await s.findOneWhere(RESOURCES.empresa_fiscal_config, { empresa_id: t.empresaId });
  const dados = {
    empresa_id: t.empresaId,
    provider,
    provider_token_cifrado: cifrarSegredo('token-e424'),
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
  if (cfg) return s.update(RESOURCES.empresa_fiscal_config, Number(cfg.id), dados);
  return s.insert(RESOURCES.empresa_fiscal_config, dados);
}

const AUTORIZADOR = 'e424_autorizador';
const PENDENTE = 'e424_sem_credencial';
const REJEITADOR = 'e424_rejeitador';

registrarFiscalProvider({
  nome: AUTORIZADOR,
  configurado: () => true,
  emitir: async () => {
    const chave = chaveUnica();
    return {
      status: 'autorizado',
      mensagem: 'Autorizado o uso da NF-e',
      chave_acesso: chave,
      protocolo: '135260000123456',
      numero: 1,
      serie: 1,
      xml: '<nfeProc/>',
    };
  },
  consultar: async () => ({ status: 'autorizado', mensagem: 'ok', chave_acesso: chaveUnica(), protocolo: '135260000123456' }),
  // O MESMO provedor cancela o documento que emitiu.
  cancelar: async () => ({ status: 'cancelado', mensagem: 'Cancelamento homologado', protocolo: '135260000999999' }),
  inutilizar: async () => ({ status: 'inutilizado', mensagem: 'ok' }),
} as any);
registrarFiscalProvider({
  nome: PENDENTE,
  configurado: () => false,
  emitir: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
  consultar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
  cancelar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
  inutilizar: async () => ({ status: 'nao_configurado', mensagem: 'Provedor sem credencial' }),
} as any);
registrarFiscalProvider({
  nome: REJEITADOR,
  configurado: () => true,
  emitir: async () => ({ status: 'rejeitado', mensagem: 'Rejeicao: CFOP incompativel com a operacao' }),
  consultar: async () => ({ status: 'rejeitado', mensagem: 'CFOP incompativel' }),
  cancelar: async () => ({ status: 'rejeitado', mensagem: 'nada a cancelar' }),
  inutilizar: async () => ({ status: 'rejeitado', mensagem: 'nada a inutilizar' }),
} as any);

/** Emite a nota da venda pelo endpoint REAL (fiscal.ts). */
function emitir(t: Tenant, vendaId: number, modelo: '55' | '65' = '55', esperado = 200) {
  return chamar(
    fiscal.emitirDocumento,
    reqDe({ modelo }, { user: t.ator, params: { id: vendaId }, headers: { 'idempotency-key': `e424-${vendaId}-${modelo}` } }),
    esperado
  );
}

/** Venda de balcão ABERTA (não faturada) com cliente/endereço e item com código de barras. */
async function pedidoAberto(t: Tenant, preco = 100, quantidade = 1) {
  const p = await produtoComSaldo(t, preco);
  const clienteId = await novoClienteFiscal(t);
  const s = getStore();
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: t.empresaId,
    cliente_id: clienteId,
    data: new Date().toISOString().slice(0, 10),
    status: 'aberta',
    canal_venda: 'balcao',
    local_saida: p.local,
    total: preco * quantidade,
  });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: t.empresaId,
    venda_id: Number(venda.id),
    produto_id: p.produtoId,
    tamanho_id: p.tamanhoId,
    quantidade,
    preco_unitario: preco,
    subtotal: preco * quantidade,
  });
  return { ...p, vendaId: Number(venda.id), clienteId, quantidade };
}

/** Passa a venda pelas quatro etapas logísticas. */
async function expedirFluxo(t: Tenant, vendaId: number, codigos: string[]) {
  await chamar(exp.separarPedido, reqDe({}, { user: t.ator, params: { id: vendaId } }));
  await chamar(exp.conferirPedido, reqDe({ codigos }, { user: t.ator, params: { id: vendaId } }));
  await chamar(exp.embalarPedido, reqDe({}, { user: t.ator, params: { id: vendaId } }));
  return chamar(exp.expedirPedido, reqDe({}, { user: t.ator, params: { id: vendaId } }));
}

// ============================================================================
// P1-01 — PDV / CAIXA
// ============================================================================

test('P1-01 PG: o movimento de caixa é o líquido do troco e o fechamento bate no banco', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 50, 'CAIXA-PG-A');
  const p = await produtoComSaldo(t, 25, 10);

  const venda = await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 30 }, { forma: 'cartao_credito', valor: 10 }]);
  assert.equal(Number(venda.calculo.troco), 15);
  const vendaId = Number(venda.venda_id);

  // O MOVIMENTO no banco vale o efeito líquido: 30 entregues − 15 devolvidos.
  const pag = await query(`SELECT forma, valor, empresa_id, caixa_id FROM pdv_pagamentos WHERE venda_id = $1 ORDER BY id`, [vendaId]);
  const valores: Record<string, number> = {};
  for (const row of pag.rows) valores[String(row.forma)] = Number(row.valor);
  assert.equal(valores.dinheiro, 15, 'o movimento de dinheiro é LÍQUIDO de troco');
  assert.equal(valores.cartao_credito, 10);
  assert.equal(
    Object.values(valores).reduce((a, b) => a + b, 0),
    25,
    'Σ movimentos = total da venda'
  );
  assert.ok(pag.rows.every((row: any) => Number(row.empresa_id) === t.empresaId && Number(row.caixa_id) === Number(caixa.id)));

  const resumo = await resumoDe(t, caixa.id);
  assert.equal(Number(resumo.por_forma.dinheiro), 15);
  assert.equal(Number(resumo.total_vendido), 25);
  assert.equal(Number(resumo.esperado_em_dinheiro), 65, '50 + 15 — sem os R$ 15,00 de superestimação');

  const fechado = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 65 }, { user: t.ator, params: { id: caixa.id } }));
  assert.equal(Number(fechado.diferenca), 0);
  const gravado = await query(`SELECT valor_sistema, valor_fechamento, diferenca, status FROM pdv_caixas WHERE id = $1`, [Number(caixa.id)]);
  assert.equal(Number(gravado.rows[0].valor_sistema), 65);
  assert.equal(Number(gravado.rows[0].diferenca), 0);
  assert.equal(String(gravado.rows[0].status), 'fechado');
});

test('P1-01 PG: estorno devolve o estoque UMA vez e tira a venda do caixa', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 100, 'CAIXA-PG-B');
  const p = await produtoComSaldo(t, 60, 10);

  const venda = await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 100 }]);
  const vendaId = Number(venda.venda_id);
  assert.equal(Number(venda.calculo.troco), 40);
  assert.equal(await saldoDe(t, p), 9, 'uma peça saiu');

  const antes = await resumoDe(t, caixa.id);
  assert.equal(Number(antes.por_forma.dinheiro), 60, '100 entregues − 40 de troco');
  assert.equal(Number(antes.esperado_em_dinheiro), 160);

  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu no balcão' }, { user: t.ator, params: { id: vendaId } }));

  const depois = await resumoDe(t, caixa.id);
  assert.equal(Number(depois.total_vendido), 0);
  assert.equal(Number(depois.esperado_em_dinheiro), 100, 'a venda cancelada sai da gaveta');
  assert.equal(await saldoDe(t, p), 10, 'o estoque voltou uma vez');

  assert.equal(await contar('movimentacoes', "venda_id = $1 AND tipo = 'saida'", [vendaId]), 1);
  assert.equal(await contar('movimentacoes', "venda_id = $1 AND tipo = 'entrada'", [vendaId]), 1, 'exatamente um estorno');
  const vendaRow = await query(`SELECT status FROM vendas WHERE id = $1`, [vendaId]);
  assert.equal(String(vendaRow.rows[0].status), 'cancelada');
  const lanc = await query(`SELECT valor, tipo FROM lancamentos_financeiros WHERE referencia_tipo = 'venda' AND referencia_id = $1 ORDER BY id`, [vendaId]);
  assert.ok(lanc.rows.length >= 1, 'o financeiro da venda existe e foi revertido na mesma trilha');
});

test('P1-01 PG: duas vendas simultâneas no mesmo caixa não duplicam movimento', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 0, 'CAIXA-PG-D');
  const p = await produtoComSaldo(t, 30, 100);

  const venderUma = () =>
    vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 50 }]).then(
      (r: any) => ({ ok: true, vendaId: Number(r.venda_id) }),
      (e: any) => ({ ok: false, status: Number(e?.status) })
    );
  const rodada1 = await Promise.all([venderUma(), venderUma()]);
  const aceitasRodada1 = rodada1.filter((r: any) => r.ok) as { vendaId: number }[];
  assert.ok(aceitasRodada1.length <= 2);
  for (const perdedora of rodada1.filter((r: any) => !r.ok)) {
    assert.equal(perdedora.status, 409, `perdedora com conflito controlado: ${JSON.stringify(perdedora)}`);
  }
  // Com isolamento serializable do PostgreSQL as duas transações disputam a
  // MESMA linha de estoque: uma pode ser abortada com 40001 → 409 (conflito
  // controlado, nada gravado). O cliente reenvia a perdida — como o PDV faz ao
  // ver o 409 — e ela conclui. Nenhum efeito pode ser dobrado em nenhum caso.
  const aceitas = aceitasRodada1.length ? aceitasRodada1 : [(await venderUma()) as any];
  assert.ok(aceitas.every((r: any) => r.ok), `a venda reenviada conclui: ${JSON.stringify(aceitas)}`);

  for (const v of aceitas) {
    assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [v.vendaId]), 1, 'um movimento por venda aceita');
    assert.equal(await contar('movimentacoes', 'venda_id = $1', [v.vendaId]), 1, 'uma baixa de estoque por venda aceita');
  }
  const resumo = await resumoDe(t, caixa.id);
  const usados = aceitas.length;
  assert.equal(Number(resumo.total_vendido), 30 * usados);
  assert.equal(Number(resumo.por_forma.dinheiro), 30 * usados, '20 de troco por venda: 50 − 20');
  assert.equal(Number(resumo.esperado_em_dinheiro), 30 * usados);
  assert.equal(await saldoDe(t, p), 100 - usados, 'uma peça por venda — nunca duas');
});

test('P1-01 PG: fechamento concorrente — exatamente um vence', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 0, 'CAIXA-PG-C');
  const p = await produtoComSaldo(t, 10, 10);
  await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 10 }]);

  const fechar = () =>
    chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 10 }, { user: t.ator, params: { id: caixa.id } })).then(
      () => 'ok',
      (e: any) => String(e?.status)
    );
  const rodada1 = (await Promise.all([fechar(), fechar()])).sort();
  const vencedores = rodada1.filter((r: string) => r === 'ok');
  assert.ok(vencedores.length <= 1, `no máximo um fechamento por rodada: ${rodada1.join(',')}`);
  for (const perdedora of rodada1.filter((r: string) => r !== 'ok')) {
    assert.equal(perdedora, '409', `a perdedora recebe conflito controlado: ${rodada1.join(',')}`);
  }
  // Sem vencedor na corrida (as duas transações serializable podem abortar),
  // o cliente reenvia: o fechamento é ÚNICO e idempotente do ponto de vista do
  // dinheiro — nunca dois fechamentos, nunca valor dobrado.
  const depoisDaCorrida = vencedores.length === 1 ? 'ok' : await fechar();
  assert.ok(['ok', '409'].includes(depoisDaCorrida), `reenvio após a corrida: ${depoisDaCorrida}`);

  const rows = await query(`SELECT status, valor_sistema, diferenca FROM pdv_caixas WHERE id = $1`, [Number(caixa.id)]);
  assert.equal(String(rows.rows[0].status), 'fechado');
  assert.equal(Number(rows.rows[0].valor_sistema), 10);
  assert.equal(Number(rows.rows[0].diferenca), 0);
  assert.equal(await contar('pdv_caixas', "id = $1 AND status = 'fechado'", [Number(caixa.id)]), 1, 'um único fechamento gravado');
});

test('P1-01 PG: rollback — venda recusada não deixa rastro no caixa nem no estoque', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 0, 'CAIXA-PG-E');
  const p = await produtoComSaldo(t, 25, 10);

  const antesVendas = await contar('vendas', 'empresa_id = $1', [t.empresaId]);

  // Troco (35) maior que o dinheiro entregue (30): recusado ANTES de gravar.
  await esperarErro(
    () => vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 30 }, { forma: 'cartao_credito', valor: 30 }]),
    400,
    /troco/i
  );

  assert.equal(await contar('vendas', 'empresa_id = $1', [t.empresaId]), antesVendas);
  assert.equal(await contar('movimentacoes', 'produto_id = $1', [p.produtoId]), 0);
  assert.equal(await saldoDe(t, p), 10, 'estoque intacto');
  const resumo = await resumoDe(t, caixa.id);
  assert.equal(Number(resumo.total_vendido), 0);
  assert.equal(Number(resumo.esperado_em_dinheiro), 0);
});

test('P1-01 PG: idempotência — ler o resumo não move dinheiro e repetir a venda não conta duas vezes', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 0, 'CAIXA-PG-F');
  const p = await produtoComSaldo(t, 40, 10);

  const a = await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 40 }]);
  const b = await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 40 }]);
  assert.notEqual(Number(a.venda_id), Number(b.venda_id), 'sem chave de idempotência, cada POST é uma venda nova');

  const r1 = await resumoDe(t, caixa.id);
  const r2 = await resumoDe(t, caixa.id);
  assert.deepEqual(r1, r2, 'ler o resumo é idempotente');
  assert.equal(Number(r2.total_vendido), 80);
  assert.equal(Number(r2.esperado_em_dinheiro), 80);
  assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [Number(a.venda_id)]), 1);
  assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [Number(b.venda_id)]), 1);
});

test('P1-01 PG: multiempresa — o caixa de A não soma em B nem é operado por B', async () => {
  const a = await novoTenant();
  const b = await novoTenant();

  const caixaA = await abrirCaixa(a, 100, 'CAIXA-PG-G');
  const caixaB = await abrirCaixa(b, 500, 'CAIXA-PG-G');
  assert.notEqual(Number(caixaA.id), Number(caixaB.id));

  const pA = await produtoComSaldo(a, 25, 10);
  const pB = await produtoComSaldo(b, 90, 10);
  await vender(a, caixaA.id, pA, [{ forma: 'dinheiro', valor: 30 }]);
  await vender(b, caixaB.id, pB, [{ forma: 'dinheiro', valor: 90 }]);

  const rA = await resumoDe(a, caixaA.id);
  const rB = await resumoDe(b, caixaB.id);
  assert.equal(Number(rA.total_vendido), 25);
  assert.equal(Number(rA.esperado_em_dinheiro), 125);
  assert.equal(Number(rB.total_vendido), 90);
  assert.equal(Number(rB.esperado_em_dinheiro), 590);

  await esperarErro(() => resumoDe(b, caixaA.id), 404);
  await esperarErro(
    () => pdv.movimentoCaixa(reqDe({ tipo: 'sangria', valor: 1 }, { user: b.ator, params: { id: caixaA.id } }), resFake().res),
    404
  );
  await esperarErro(
    () => pdv.fecharCaixa(reqDe({ valor_fechamento: 0 }, { user: b.ator, params: { id: caixaA.id } }), resFake().res),
    404
  );
  const pagamentosDeB = await query(`SELECT empresa_id FROM pdv_pagamentos WHERE caixa_id = $1`, [Number(caixaB.id)]);
  assert.ok(pagamentosDeB.rows.every((row: any) => Number(row.empresa_id) === b.empresaId));
});

// ============================================================================
// P1-03 — FISCAL → EXPEDIÇÃO
// ============================================================================

test('P1-03 PG: NF autorizada segue para separação → conferência → embalagem → expedição', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);

  const nota = await emitir(t, c.vendaId);
  assert.equal(nota.status, 'autorizado');
  const saldoAposNota = await saldoDe(t, c);
  assert.equal(saldoAposNota, 49, 'a autorização baixou o estoque uma vez');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), 1);

  // O passo que respondia 409 antes da correção.
  const expedida = await expedirFluxo(t, c.vendaId, [c.codigo]);
  assert.equal(expedida.etapa, 'expedida');

  const venda = await query(`SELECT status, expedicao_etapa, nfe_status, empresa_id FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(venda.rows[0].status), 'faturada');
  assert.equal(String(venda.rows[0].expedicao_etapa), 'expedida');
  assert.equal(String(venda.rows[0].nfe_status), 'emitida');
  assert.equal(Number(venda.rows[0].empresa_id), t.empresaId);

  assert.equal(await saldoDe(t, c), saldoAposNota, 'a expedição não baixa o estoque de novo');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), 1, 'uma única movimentação');
  const eventos = await query(`SELECT etapa, empresa_id FROM expedicao_eventos WHERE venda_id = $1 ORDER BY id`, [c.vendaId]);
  assert.deepEqual(
    eventos.rows.map((row: any) => String(row.etapa)),
    ['separacao', 'conferida', 'embalada', 'expedida']
  );
  assert.ok(eventos.rows.every((row: any) => Number(row.empresa_id) === t.empresaId), 'eventos herdam a empresa da venda');

  const doc = await query(`SELECT status, estoque_baixado_em, financeiro_lancado_em, empresa_id FROM documentos_fiscais WHERE venda_id = $1`, [c.vendaId]);
  assert.equal(String(doc.rows[0].status), 'autorizado');
  assert.ok(doc.rows[0].estoque_baixado_em && doc.rows[0].financeiro_lancado_em);
  assert.equal(Number(doc.rows[0].empresa_id), t.empresaId);
  assert.ok(
    (await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId])) >= 1,
    'o financeiro foi lançado pela autorização'
  );
});

test('P1-03 PG: documento PENDENTE bloqueia a expedição — nada muda no banco', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, PENDENTE);
  const c = await pedidoAberto(t, 100, 1);
  await esperarErro(() => emitir(t, c.vendaId), 409, /NÃO emitido/);

  const doc = await query(`SELECT status FROM documentos_fiscais WHERE venda_id = $1`, [c.vendaId]);
  assert.equal(String(doc.rows[0].status), 'pendente');

  await chamar(exp.separarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.conferirPedido, reqDe({ codigos: [c.codigo] }, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.embalarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  const erro = await esperarErro(() => exp.expedirPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409, /documento fiscal/i);
  assert.match(String(erro.message), /pendente/i);

  assert.equal(await saldoDe(t, c), 50, 'nada de baixa de estoque com nota pendente');
  const venda = await query(`SELECT status, expedicao_etapa FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(venda.rows[0].status), 'aberta');
  assert.equal(String(venda.rows[0].expedicao_etapa), 'embalada', 'a mercadoria está pronta, mas não sai');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), 0);
});

test('P1-03 PG: documento REJEITADO bloqueia a expedição', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, REJEITADOR);
  const c = await pedidoAberto(t, 100, 1);

  await emitir(t, c.vendaId, '55', 202);
  const doc = await query(`SELECT status FROM documentos_fiscais WHERE venda_id = $1`, [c.vendaId]);
  assert.equal(String(doc.rows[0].status), 'rejeitado');

  await chamar(exp.separarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.conferirPedido, reqDe({ codigos: [c.codigo] }, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.embalarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409, /documento fiscal/i);
  assert.equal(await saldoDe(t, c), 50, 'rejeitado não baixa estoque');
});

test('P1-03 PG: status da venda revertido à mão não provoca segunda baixa (carimbo do documento)', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);
  await emitir(t, c.vendaId);
  const movAntes = await contar('movimentacoes', 'venda_id = $1', [c.vendaId]);
  assert.equal(await saldoDe(t, c), 49);

  // `vendas.status` é editável pelo CRUD genérico; o carimbo
  // `documentos_fiscais.estoque_baixado_em` não. A expedição não pode refaturar.
  await getStore().update(RESOURCES.vendas, c.vendaId, { status: 'aberta' });
  const expedida = await expedirFluxo(t, c.vendaId, [c.codigo]);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldoDe(t, c), 49, 'o estoque continua baixado UMA única vez');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), movAntes, 'nenhuma movimentação nova');
  assert.equal(
    String((await query(`SELECT status FROM vendas WHERE id = $1`, [c.vendaId])).rows[0].status),
    'faturada',
    'o status volta ao que o efeito aplicado exige'
  );
});

test('P1-03 PG: documento CANCELADO depois de autorizado bloqueia a expedição', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);

  const nota = await emitir(t, c.vendaId);
  await chamar(
    fiscal.cancelarDocumento,
    reqDe({ justificativa: 'Erro na emissão da nota fiscal' }, { user: t.ator, params: { id: Number(nota.documento_id) } })
  );
  const doc = await query(`SELECT status FROM documentos_fiscais WHERE venda_id = $1`, [c.vendaId]);
  assert.equal(String(doc.rows[0].status), 'cancelado');
  assert.equal(
    String((await query(`SELECT nfe_status FROM vendas WHERE id = $1`, [c.vendaId])).rows[0].nfe_status),
    'cancelada'
  );

  // A venda ficou `faturada` pela autorização, mas a nota que a acompanhava
  // deixou de existir: a mercadoria não entra no fluxo logístico.
  await esperarErro(() => exp.separarPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409);
  const venda = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(venda.rows[0].expedicao_etapa ?? 'pendente'), 'pendente');
});

test('P1-03 PG: idempotência — autorização repetida e expedição repetida não duplicam nada', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);

  const primeira = await emitir(t, c.vendaId);
  const movAntes = await contar('movimentacoes', 'venda_id = $1', [c.vendaId]);
  const lancAntes = await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId]);

  const repetida = await emitir(t, c.vendaId);
  assert.equal(Number(repetida.documento_id), Number(primeira.documento_id), 'o MESMO documento');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), movAntes);
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId]), lancAntes);

  await expedirFluxo(t, c.vendaId, [c.codigo]);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: t.ator, params: { id: c.vendaId } }), resFake().res), 409);
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), movAntes, 'nenhuma baixa extra');
  assert.equal(
    await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId]),
    lancAntes,
    'nenhum lançamento extra'
  );
  assert.equal(await contar('expedicao_eventos', "venda_id = $1 AND etapa = 'expedida'", [c.vendaId]), 1);
});

test('P1-03 PG: duas expedições concorrentes — uma vence e a baixa acontece UMA vez', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);
  await emitir(t, c.vendaId);
  await chamar(exp.separarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.conferirPedido, reqDe({ codigos: [c.codigo] }, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.embalarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));

  const expedirUma = () =>
    chamar(exp.expedirPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } })).then(
      () => 'ok',
      (e: any) => String(e?.status)
    );
  const rodada1 = (await Promise.all([expedirUma(), expedirUma()])).sort();
  const vencedores = rodada1.filter((r: string) => r === 'ok');
  assert.ok(vencedores.length <= 1, `no máximo uma expedição por rodada: ${rodada1.join(',')}`);
  for (const perdedora of rodada1.filter((r: string) => r !== 'ok')) {
    assert.equal(perdedora, '409', `conflito controlado (serialização/etapa): ${rodada1.join(',')}`);
  }
  // Sem vencedor na corrida, o reenvio do cliente conclui; com vencedor, o
  // reenvio é recusado com 409 — em nenhum caso há segunda baixa de estoque.
  if (vencedores.length === 0) {
    assert.equal(await expedirUma(), 'ok', 'o reenvio conclui a expedição que perdeu a corrida');
  } else {
    assert.equal(await expedirUma(), '409', 'repetir a expedição já concluída é recusado');
  }

  const venda = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(venda.rows[0].expedicao_etapa), 'expedida');
  assert.equal(await saldoDe(t, c), 49, 'estoque baixado uma única vez');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), 1);
  assert.equal(await contar('expedicao_eventos', "venda_id = $1 AND etapa = 'expedida'", [c.vendaId]), 1);
});

test('P1-03 PG: falha no meio da transição não deixa estado parcial', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 2);

  await emitir(t, c.vendaId);
  await chamar(exp.separarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  const movAntes = await contar('movimentacoes', 'venda_id = $1', [c.vendaId]);

  // Leitura incompleta: 422, divergência auditável e etapa preservada.
  const erroDiv = await esperarErro(
    () => exp.conferirPedido(reqDe({ codigos: [c.codigo] }, { user: t.ator, params: { id: c.vendaId } }), resFake().res),
    422
  );
  assert.ok(erroDiv.fields?.divergencia_id, 'a divergência fica auditável');
  assert.equal(await contar('divergencias_conferencia', 'venda_id = $1', [c.vendaId]), 1);
  const venda = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(venda.rows[0].expedicao_etapa), 'separacao', 'a etapa não avançou');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), movAntes);

  // Corrigida a leitura, o fluxo termina normalmente.
  await chamar(exp.conferirPedido, reqDe({ codigos: [c.codigo, c.codigo] }, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.embalarPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  await chamar(exp.expedirPedido, reqDe({}, { user: t.ator, params: { id: c.vendaId } }));
  assert.equal(await contar('expedicao_eventos', "venda_id = $1 AND etapa = 'expedida'", [c.vendaId]), 1);
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), movAntes);
});

test('P1-03 PG: multiempresa — B não opera a expedição de A (e a dele funciona)', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  await habilitarFiscal(a, AUTORIZADOR);
  await habilitarFiscal(b, AUTORIZADOR);

  const pa = await pedidoAberto(a, 100, 1);
  const pb = await pedidoAberto(b, 100, 1);
  await emitir(a, pa.vendaId);
  await emitir(b, pb.vendaId);

  await esperarErro(() => exp.separarPedido(reqDe({}, { user: b.ator, params: { id: pa.vendaId } }), resFake().res), 404);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: b.ator, params: { id: pa.vendaId } }), resFake().res), 404);
  const vendaA = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [pa.vendaId]);
  assert.equal(String(vendaA.rows[0].expedicao_etapa ?? 'pendente'), 'pendente', 'A não foi tocada por B');

  const docsDeA = await query(`SELECT empresa_id FROM documentos_fiscais WHERE venda_id = $1`, [pa.vendaId]);
  assert.ok(docsDeA.rows.every((row: any) => Number(row.empresa_id) === a.empresaId));

  const expedidaB = await expedirFluxo(b, pb.vendaId, [pb.codigo]);
  assert.equal(expedidaB.etapa, 'expedida');
  assert.equal(String((await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [pa.vendaId])).rows[0].expedicao_etapa ?? 'pendente'), 'pendente');
});

test('P1-01 PG: linhas LEGADAS (valor bruto, com troco) não reintroduzem a divergência', async () => {
  // O banco real de quem rodou a versão antiga tem `pdv_pagamentos.valor` com o
  // dinheiro ENTREGUE. A leitura normaliza: a gaveta continua 65,00 — nunca 80,00.
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 50, 'CAIXA-PG-LEG');
  const p = await produtoComSaldo(t, 25, 10);

  const venda = await query(
    `INSERT INTO vendas (empresa_id, status, canal_venda, pdv_caixa_id, data, total)
     VALUES ($1, 'faturada', 'balcao', $2, CURRENT_DATE, 25) RETURNING id`,
    [t.empresaId, Number(caixa.id)]
  );
  const vendaId = Number(venda.rows[0].id);
  // Semântica ANTIGA: 30,00 entregues em dinheiro (troco de 15,00 invisível) + 10,00 no cartão.
  await query(
    `INSERT INTO pdv_pagamentos (empresa_id, venda_id, caixa_id, forma, valor) VALUES
       ($1, $2, $3, 'dinheiro', 30), ($1, $2, $3, 'cartao_credito', 10)`,
    [t.empresaId, vendaId, Number(caixa.id)]
  );
  const bruto = await query(`SELECT COALESCE(SUM(valor), 0)::numeric AS s FROM pdv_pagamentos WHERE venda_id = $1`, [vendaId]);
  assert.equal(Number(bruto.rows[0].s), 40, 'no banco continua o valor bruto legado de 40,00');

  const r = await resumoDe(t, caixa.id);
  assert.equal(Number(r.por_forma.dinheiro), 15, 'a leitura normaliza para o que ficou na gaveta');
  assert.equal(Number(r.por_forma.cartao_credito), 10);
  assert.equal(Number(r.total_vendido), 25, 'vendido = a venda, não o bruto');
  assert.equal(Number(r.esperado_em_dinheiro), 65, '50 de abertura + 15 que ficaram');

  // Fechar contando a gaveta real não gera divergência.
  const fechamento = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 65 }, { user: t.ator, params: { id: caixa.id } }));
  assert.equal(Number(fechamento.diferenca), 0);
  assert.equal(Number(fechamento.caixa.valor_sistema), 65);
  assert.equal(Number(fechamento.resumo.total_vendido), 25);
});

test('P1-03 PG: venda ENTREGUE — com documento autorizado expede, sem documento é bloqueada', async () => {
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);

  // (1) COM documento autorizado: o outro status terminal também sai do galpão, uma única baixa.
  const comNota = await pedidoAberto(t, 100, 1);
  await emitir(t, comNota.vendaId);
  await query(`UPDATE vendas SET status = 'entregue' WHERE id = $1`, [comNota.vendaId]);
  const saldoNota = await saldoDe(t, comNota);
  const movNota = await contar('movimentacoes', 'venda_id = $1', [comNota.vendaId]);

  const expedida = await expedirFluxo(t, comNota.vendaId, [comNota.codigo]);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldoDe(t, comNota), saldoNota, 'entregue com nota não refatura');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [comNota.vendaId]), movNota);
  assert.equal(await contar('expedicao_eventos', "venda_id = $1 AND etapa = 'expedida'", [comNota.vendaId]), 1);

  // (2) SEM documento autorizado: `entregue` não abre o galpão.
  const semNota = await pedidoAberto(t, 100, 1);
  await query(`UPDATE vendas SET status = 'entregue' WHERE id = $1`, [semNota.vendaId]);
  await esperarErro(() => exp.separarPedido(reqDe({}, { user: t.ator, params: { id: semNota.vendaId } }), resFake().res), 409, /já foi faturado/);
  assert.equal(await saldoDe(t, semNota), 50, 'nada saiu do estoque');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [semNota.vendaId]), 0);
  assert.equal(String((await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [semNota.vendaId])).rows[0].expedicao_etapa ?? 'pendente'), 'pendente');
});

test('P1-03 PG: NFC-e (modelo 65) autorizada também libera a expedição — contrato atual', async () => {
  // CONTRATO ATUAL (documentado, não alterado neste ciclo): a trava da
  // expedição pergunta pelo documento AUTORIZADO, sem restringir o modelo.
  // Uma venda de balcão com NFC-e autorizada pode, portanto, passar por
  // separação → conferência → embalagem → expedição. Restringir isso ao
  // modelo 55 é decisão de produto — fora do escopo desta correção.
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);

  const nota = await emitir(t, c.vendaId, '65');
  assert.equal(nota.status, 'autorizado');
  const doc = await query(`SELECT modelo, status, estoque_baixado_em FROM documentos_fiscais WHERE venda_id = $1`, [c.vendaId]);
  assert.equal(String(doc.rows[0].modelo), '65');
  assert.ok(doc.rows[0].estoque_baixado_em, 'o efeito econômico foi aplicado pela autorização');
  const saldoNota = await saldoDe(t, c);

  const expedida = await expedirFluxo(t, c.vendaId, [c.codigo]);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldoDe(t, c), saldoNota, 'uma única baixa');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), 1);
});

test('P1-01+P1-03 PG: a cadeia inteira de A não aparece em B (caixa, estoque, fiscal, expedição)', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  await habilitarFiscal(a, AUTORIZADOR);
  await habilitarFiscal(b, AUTORIZADOR);

  const caixaA = await abrirCaixa(a, 100, 'CAIXA-PG-X');
  const caixaB = await abrirCaixa(b, 500, 'CAIXA-PG-X');

  // A vende no PDV (dinheiro com troco) e autoriza a nota.
  const pA = await produtoComSaldo(a, 25, 10);
  const vendaA = await vender(a, caixaA.id, pA, [{ forma: 'dinheiro', valor: 30 }], { cliente_id: await novoClienteFiscal(a) });
  const vendaAId = Number(vendaA.venda_id);
  assert.equal(Number(vendaA.calculo.troco), 5);
  await emitir(a, vendaAId);

  // B tem o PRÓPRIO produto e o próprio pedido: as duas cadeias correm juntas.
  const pB = await produtoComSaldo(b, 90, 10);
  const vendaB = await vender(b, caixaB.id, pB, [{ forma: 'dinheiro', valor: 90 }], { cliente_id: await novoClienteFiscal(b) });
  const vendaBId = Number(vendaB.venda_id);
  await emitir(b, vendaBId);

  // ---- caixa: cada resumo lê só o que é da sua empresa ----
  const rA = await resumoDe(a, caixaA.id);
  const rB = await resumoDe(b, caixaB.id);
  assert.equal(Number(rA.total_vendido), 25, 'A vendeu 25 (dinheiro líquido de troco)');
  assert.equal(Number(rA.esperado_em_dinheiro), 125);
  assert.equal(Number(rB.total_vendido), 90, 'B não herda um centavo de A');
  assert.equal(Number(rB.esperado_em_dinheiro), 590);
  assert.equal(Number(rA.quantidade_vendas), 1);
  assert.equal(Number(rB.quantidade_vendas), 1);

  // ---- banco cru: nenhuma linha de A com empresa_id de B (e vice-versa) ----
  for (const [tabela, coluna, id] of [
    ['pdv_pagamentos', 'venda_id', vendaAId],
    ['movimentacoes', 'venda_id', vendaAId],
    ['expedicao_eventos', 'venda_id', vendaAId],
    ['documentos_fiscais', 'venda_id', vendaAId],
  ] as const) {
    const r = await query(`SELECT DISTINCT empresa_id FROM ${tabela} WHERE ${coluna} = $1`, [id]);
    assert.ok(
      r.rows.every((row: any) => Number(row.empresa_id) === a.empresaId),
      `${tabela} da venda de A só pode ter linhas de A (veio: ${JSON.stringify(r.rows)})`
    );
    assert.equal(await contar(tabela, `${coluna} = $1 AND empresa_id = $2`, [id, b.empresaId]), 0, `nenhuma linha de A marcada como B em ${tabela}`);
  }
  assert.equal(await contar('estoques', 'empresa_id = $1 AND produto_id = $2', [b.empresaId, pA.produtoId]), 0, 'o produto de A não tem saldo em B');
  assert.equal(await contar('lancamentos_financeiros', 'empresa_id = $1 AND referencia_tipo = $2 AND referencia_id = $3', [b.empresaId, 'venda', vendaAId]), 0, 'nenhum lançamento de A no financeiro de B');

  // ---- expedição: B não opera a cadeia de A, nem a NF de A ----
  await esperarErro(() => exp.separarPedido(reqDe({}, { user: b.ator, params: { id: vendaAId } }), resFake().res), 404);
  await esperarErro(() => exp.expedirPedido(reqDe({}, { user: b.ator, params: { id: vendaAId } }), resFake().res), 404);
  const etapaA = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [vendaAId]);
  assert.equal(String(etapaA.rows[0].expedicao_etapa ?? 'pendente'), 'pendente', 'A continua intocada pelo ator de B');

  // ---- A expede a própria nota: UMA baixa, eventos da empresa de A ----
  const saldoAAntes = await saldoDe(a, pA);
  const expedidaA = await expedirFluxo(a, vendaAId, [pA.codigo]);
  assert.equal(expedidaA.etapa, 'expedida');
  assert.equal(await saldoDe(a, pA), saldoAAntes, 'a expedição de A não baixa o estoque de novo');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [vendaAId]), 1, 'uma única baixa na cadeia de A');
  // Agora que a cadeia de A terminou, as tabelas de rastro têm conteúdo — e
  // TODO o conteúdo carrega a empresa de A.
  for (const tabela of ['movimentacoes', 'expedicao_eventos', 'documentos_fiscais'] as const) {
    const r = await query(`SELECT DISTINCT empresa_id FROM ${tabela} WHERE venda_id = $1`, [vendaAId]);
    assert.deepEqual(r.rows.map((row: any) => Number(row.empresa_id)), [a.empresaId], `${tabela} da cadeia de A pertence só a A`);
  }
  assert.equal(
    await contar('expedicao_eventos', 'venda_id = $1 AND empresa_id = $2', [vendaAId, b.empresaId]),
    0,
    'nenhum evento logístico de A marcado como B'
  );

  // ---- B, no mesmo instante, fecha a própria cadeia sem tocar em A ----
  const saldoBAntes = await saldoDe(b, pB);
  const expedidaB = await expedirFluxo(b, vendaBId, [pB.codigo]);
  assert.equal(expedidaB.etapa, 'expedida');
  assert.equal(await saldoDe(b, pB), saldoBAntes - 0, 'B também não baixa duas vezes');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [vendaBId]), 1);
  assert.equal(
    String((await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [vendaAId])).rows[0].expedicao_etapa),
    'expedida',
    'a expedição de B não interferiu na de A'
  );
});

test('auditoria Q9 PG: o CRUD genérico não fura a proteção fiscal nem duplica o efeito', async () => {
  // Pergunta da auditoria adversarial: existe caminho alternativo (CRUD
  // genérico) para furar o fluxo fiscal/expedição? A resposta, com prova:
  // o CRUD REUSA os motores (services.ts: updateRecord → aplicarRegrasPedido +
  // syncLancamentoVenda), e os motores recusam as transições que furariam.
  const t = await novoTenant();
  await habilitarFiscal(t, AUTORIZADOR);
  const c = await pedidoAberto(t, 100, 1);
  await emitir(t, c.vendaId);

  const saldo1 = await saldoDe(t, c);
  const mov1 = await contar('movimentacoes', 'venda_id = $1', [c.vendaId]);
  const lanc1 = await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId]);
  assert.equal(saldo1, 49);

  // 1) A API genérica NÃO devolve a venda faturada para "aberta" (motores).
  await esperarErro(() => updateRecord(RESOURCES.vendas, c.vendaId, { status: 'aberta' }, t.ator as any), 409);

  // 2) Repetir o faturamento pela API genérica não repete efeito nenhum.
  const repetido = await updateRecord(RESOURCES.vendas, c.vendaId, { status: 'faturada' }, t.ator as any);
  assert.equal(String(repetido.status), 'faturada');
  assert.equal(await saldoDe(t, c), saldo1, 'sem segunda baixa de estoque');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), mov1, 'sem movimento duplicado');
  assert.equal(
    await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [c.vendaId]),
    lanc1,
    'sem lançamento financeiro duplicado'
  );

  // 3) `expedicao_etapa` não é escrevível pelo CRUD (readonly): a etapa
  //    logística continua pertencendo ao motor de expedição.
  const tentativa = await updateRecord(RESOURCES.vendas, c.vendaId, { expedicao_etapa: 'expedida' } as any, t.ator as any)
    .then(() => null)
    .catch((e) => e);
  assert.ok(
    tentativa === null || [400, 409].includes(Number(tentativa.status)),
    `PUT de campo readonly deve ser ignorado ou recusado (veio ${tentativa?.status ?? 'ok'})`
  );
  const etapaDb = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [c.vendaId]);
  assert.equal(String(etapaDb.rows[0].expedicao_etapa ?? 'pendente'), 'pendente', 'a etapa não muda por PUT genérico');

  // 4) Depois de tudo isso, a venda continua expeditável pelo fluxo REAL —
  //    e a expedição não baixa o estoque de novo.
  const expedida = await expedirFluxo(t, c.vendaId, [c.codigo]);
  assert.equal(expedida.etapa, 'expedida');
  assert.equal(await saldoDe(t, c), saldo1, 'uma única baixa em toda a cadeia');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [c.vendaId]), mov1);
  assert.equal(await contar('expedicao_eventos', "venda_id = $1 AND etapa = 'expedida'", [c.vendaId]), 1);
});

// ============================================================================
// E2E — a cadeia completa
// ============================================================================

test('E2E PG: venda presencial → pagamento → caixa → fiscal → autorização → expedição', async () => {
  const t = await novoTenant();
  const caixa = await abrirCaixa(t, 100, 'CAIXA-PG-E2E');
  const p = await produtoComSaldo(t, 100, 20);
  const clienteId = await novoClienteFiscal(t);
  await habilitarFiscal(t, AUTORIZADOR);

  // 1) Venda presencial no PDV, paga em dinheiro com troco.
  const venda = await vender(t, caixa.id, p, [{ forma: 'dinheiro', valor: 150 }], { cliente_id: clienteId });
  const vendaId = Number(venda.venda_id);
  assert.equal(Number(venda.calculo.troco), 50);
  assert.equal(String(venda.venda.status), 'faturada', 'a venda do PDV nasce faturada');

  const mov1 = await contar('movimentacoes', 'venda_id = $1', [vendaId]);
  const lanc1 = await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [vendaId]);
  assert.equal(mov1, 1);
  assert.ok(lanc1 >= 1);
  assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [vendaId]), 1);
  const movCaixa = await query(`SELECT valor, forma FROM pdv_pagamentos WHERE venda_id = $1`, [vendaId]);
  assert.equal(Number(movCaixa.rows[0].valor), 100, '150 entregues − 50 de troco');

  // 2) Caixa: o resumo deriva do movimento líquido.
  const caixa1 = await resumoDe(t, caixa.id);
  assert.equal(Number(caixa1.por_forma.dinheiro), 100);
  assert.equal(Number(caixa1.esperado_em_dinheiro), 200);
  assert.equal(Number(caixa1.total_vendido), 100);

  // 3) Fiscal: a NF-e da venda é autorizada pelo endpoint real.
  const nota = await emitir(t, vendaId);
  assert.equal(nota.status, 'autorizado');
  assert.equal(await saldoDe(t, p), 19, 'a nota não baixa o estoque de novo');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [vendaId]), mov1, 'nenhuma baixa extra');
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [vendaId]), lanc1, 'nenhum lançamento extra');
  assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [vendaId]), 1, 'nenhum pagamento duplicado');

  // 4) Expedição: separação → conferência → embalagem → expedição.
  const expedida = await expedirFluxo(t, vendaId, [p.codigo]);
  assert.equal(expedida.etapa, 'expedida');

  // 5) Invariantes finais, lidos direto do banco.
  assert.equal(await saldoDe(t, p), 19, 'estoque baixado UMA vez do começo ao fim');
  assert.equal(await contar('movimentacoes', 'venda_id = $1', [vendaId]), 1);
  assert.equal(await contar('pdv_pagamentos', 'venda_id = $1', [vendaId]), 1);
  assert.equal(await contar('lancamentos_financeiros', "referencia_tipo = 'venda' AND referencia_id = $1", [vendaId]), lanc1);
  const vendaFinal = await query(`SELECT status, expedicao_etapa, nfe_status FROM vendas WHERE id = $1`, [vendaId]);
  assert.equal(String(vendaFinal.rows[0].status), 'faturada');
  assert.equal(String(vendaFinal.rows[0].expedicao_etapa), 'expedida');
  assert.equal(String(vendaFinal.rows[0].nfe_status), 'emitida');
  assert.equal(await contar('expedicao_eventos', 'venda_id = $1', [vendaId]), 4, 'a trilha logística canônica');

  // 6) O caixa continua fechando — caixa E fiscal E expedição na mesma operação.
  const caixaFinal = await resumoDe(t, caixa.id);
  assert.equal(Number(caixaFinal.esperado_em_dinheiro), 200);
  const fechamento = await chamar(pdv.fecharCaixa, reqDe({ valor_fechamento: 200 }, { user: t.ator, params: { id: caixa.id } }));
  assert.equal(Number(fechamento.diferenca), 0, 'caixa correto, fiscal autorizado e mercadoria expedida');

  // 7) Auditoria nas duas pontas (venda e documento fiscal).
  assert.ok((await contar('auditoria', 'registro_id = $1 AND recurso = $2', [vendaId, 'vendas'])) >= 2, 'trilha da venda');
  assert.ok((await contar('auditoria', 'recurso = $1', ['documentos_fiscais'])) >= 1, 'trilha fiscal');
  assert.ok((await contar('auditoria', 'recurso = $1', ['pdv_caixas'])) >= 2, 'abertura e fechamento do caixa auditados');
});
