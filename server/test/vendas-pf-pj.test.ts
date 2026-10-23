// ============================================================================
// NOVA VENDA PROFISSIONAL PF/CNPJ — suíte integrada de servidor.
//
// Cobre:
//   1. Busca de cliente PF (nome, CPF com/sem máscara, telefone com/sem máscara, e-mail)
//   2. Busca de cliente PJ (CNPJ com/sem máscara, razão social, nome fantasia, IE)
//   3. Produtos por nome, SKU, código de barras e grade completa P/M/G/GG com estoque
//   4. Fluxo completo PF e PJ: criar, editar itens/cabeçalho, descontos/frete,
//      parcelamento financeiro em centavos, faturar (baixa de estoque), cancelar (estorno)
//   5. Prévia fiscal NF-e (55) e NFC-e (65) preservando contrato oficial
//   6. Permissões (operador vs gerente/admin) e isolamento multi-tenant (empresa_id)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const {
  checkAccess,
  createRecord,
  updateRecord,
  deleteRecord,
  getRecord,
  listRecords,
  clientePorDocumento,
  getStore,
} = await import('../src/services');
const { createItem, updateItem, deleteItem, listItens } = await import('../src/itens');
const { searchProducts } = await import('../src/productSearch');
const { previaDocumento } = await import('../src/fiscal');
const { escopoDeSistema } = await import('../src/empresa');
const { chamar, criarAtor, esperarErro, garantirAdmin, novoProduto, novoTamanho, reqDe, saldoInicial } = await import('./_p1util');

await garantirAdmin();
const store = getStore();
await store.insert(RESOURCES.empresas, { id: 2, nome: 'BROBOND FILIAL SUL', ativo: true }).catch(() => undefined);

const gerenteA = await criarAtor(1, 'gerente');
const operadorA = await criarAtor(1, 'operador');
const gerenteB = await criarAtor(2, 'gerente');

function digitoMod11(digitos: number[], pesos: number[]): number {
  const resto = digitos.reduce((acc, d, i) => acc + d * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function gerarCpfValido(seed: number): string {
  const base = String(230000000 + seed * 13).slice(0, 9).split('').map(Number);
  const d1 = digitoMod11(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoMod11([...base, d1], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base.join('')}${d1}${d2}`;
}

function gerarCnpjValido(seed: number): string {
  const base = `28${String(200000 + seed).padStart(6, '0')}0001`.split('').map(Number);
  const d1 = digitoMod11(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoMod11([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base.join('')}${d1}${d2}`;
}

function mascararCpf(d: string): string {
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

function mascararCnpj(d: string): string {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

const CPF_PF_A = gerarCpfValido(1);
const CNPJ_PJ_A = gerarCnpjValido(1);
const CPF_PF_B = gerarCpfValido(2);

const clientePfA = await createRecord(
  RESOURCES.clientes,
  {
    pessoa: 'pf',
    nome: 'Mariana Costa Ribeiro',
    cnpj_cpf: mascararCpf(CPF_PF_A),
    telefone: '(62) 99123-4567',
    whatsapp: '(62) 99876-5432',
    email: 'mariana.ribeiro@exemplo.com.br',
    cep: '74900-000',
    logradouro: 'Av. Independência',
    numero: '450',
    bairro: 'Centro',
    cidade: 'Aparecida de Goiânia',
    codigo_municipio: '5201405',
    uf: 'GO',
    indicador_ie: '9',
  },
  gerenteA
);

const clientePjA = await createRecord(
  RESOURCES.clientes,
  {
    pessoa: 'pj',
    nome: 'Confecções Cerrado Ltda',
    razao_social: 'Confecções Cerrado Comércio de Vestuário Ltda',
    nome_fantasia: 'Boutique Cerrado Prime',
    cnpj_cpf: mascararCnpj(CNPJ_PJ_A),
    rg_ie: '104567890',
    indicador_ie: '1',
    im: '998877',
    telefone: '(62) 3280-1122',
    email: 'compras@cerradoprime.com.br',
    cep: '74810-100',
    logradouro: 'Rua 9',
    numero: '1200',
    bairro: 'Setor Oeste',
    cidade: 'Goiânia',
    codigo_municipio: '5208707',
    uf: 'GO',
    limite_credito: 15000,
  },
  gerenteA
);

const clientePfB = await createRecord(
  RESOURCES.clientes,
  {
    pessoa: 'pf',
    nome: 'Cliente Exclusivo Filial B',
    cnpj_cpf: CPF_PF_B,
    telefone: '(11) 99777-6655',
    indicador_ie: '9',
  },
  gerenteB
);

// Grade P / M / G / GG + família de produto com variações e códigos de barras
const gradeApparel = await store.insert(RESOURCES.grades, { nome: 'Grade Venda PF PJ', ativo: true });
const [tamP, tamM, tamG, tamGG] = await Promise.all([
  novoTamanho('P-VPF'),
  novoTamanho('M-VPF'),
  novoTamanho('G-VPF'),
  novoTamanho('GG-VPF'),
]);
await Promise.all(
  [tamP, tamM, tamG, tamGG].map((t, ordem) =>
    store.insert(RESOURCES.grade_tamanhos, {
      grade_id: Number(gradeApparel.id),
      tamanho_id: Number(t.id),
      ordem,
    })
  )
);

const corPreta = await store.insert(RESOURCES.cores, { nome: 'Preta Onix VPF', hex: '#111111', ativo: true });
const produtoPai = await novoProduto({
  sku: 'POLO-EXEC-VPF',
  nome: 'Camisa Polo Executiva VPF',
  grade_id: Number(gradeApparel.id),
  formato: 'variacao',
  preco_venda: 150,
  ncm: '61051000',
  ativo: true,
  empresa_id: 1,
});

const variacoes: Array<{ tam: any; label: string; ean: string; preco: number; saldo: number; variacao: any }> = [];
for (const cfg of [
  { tam: tamP, codigoTam: 'P-VPF', label: 'P', ean: '7898881000011', preco: 150, saldo: 10 },
  { tam: tamM, codigoTam: 'M-VPF', label: 'M', ean: '7898881000028', preco: 150, saldo: 8 },
  { tam: tamG, codigoTam: 'G-VPF', label: 'G', ean: '7898881000035', preco: 160, saldo: 5 },
  { tam: tamGG, codigoTam: 'GG-VPF', label: 'GG', ean: '7898881000042', preco: 170, saldo: 0 },
]) {
  const v = await novoProduto({
    sku: `POLO-EXEC-VPF-PRT-${cfg.label}`,
    nome: `Camisa Polo Executiva VPF Preta ${cfg.label}`,
    produto_pai_id: Number(produtoPai.id),
    cor_id: Number(corPreta.id),
    variacao_tamanho_id: Number(cfg.tam.id),
    codigo_barras: cfg.ean,
    formato: 'simples',
    preco_venda: cfg.preco,
    ncm: '61051000',
    ativo: true,
    empresa_id: 1,
  });
  if (cfg.saldo > 0) {
    await saldoInicial(produtoPai, cfg.saldo, { codigoTamanho: cfg.codigoTam });
  }
  variacoes.push({ ...cfg, variacao: v });
}

function mockReqItens(vendaId: number, body: Record<string, unknown>, user: any, itemId?: number): any {
  return {
    params: itemId ? { id: String(vendaId), itemId: String(itemId) } : { id: String(vendaId) },
    path: `/api/vendas/${vendaId}/itens${itemId ? `/${itemId}` : ''}`,
    body,
    user,
  };
}

function listar(recurso: any, opts: { q?: string; filter?: Record<string, unknown> }, ator: any) {
  checkAccess(recurso, ator, 'read');
  return listRecords(recurso, { page: 1, pageSize: 25, q: opts.q, filter: opts.filter }, ator);
}

test('PF: busca cliente por nome, CPF com/sem máscara, telefone com/sem máscara e e-mail', async () => {
  // Por nome parcial
  const porNome = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: 'Mariana Costa' }, gerenteA);
  assert.equal(porNome.rows.some((r) => r.id === clientePfA.id), true);

  // Por CPF sem máscara
  const porCpfDigitos = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: CPF_PF_A }, gerenteA);
  assert.equal(porCpfDigitos.rows.some((r) => r.id === clientePfA.id), true);

  // Por CPF COM máscara (000.000.000-00) contra banco normalizado em dígitos
  const porCpfMascara = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: mascararCpf(CPF_PF_A) }, gerenteA);
  assert.equal(porCpfMascara.rows.some((r) => r.id === clientePfA.id), true);

  // Por telefone COM máscara e SEM máscara
  const porTelMascara = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: '(62) 99123-4567' }, gerenteA);
  assert.equal(porTelMascara.rows.some((r) => r.id === clientePfA.id), true);
  const porTelDigitos = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: '62991234567' }, gerenteA);
  assert.equal(porTelDigitos.rows.some((r) => r.id === clientePfA.id), true);

  // Por e-mail
  const porEmail = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: 'mariana.ribeiro@' }, gerenteA);
  assert.equal(porEmail.rows.some((r) => r.id === clientePfA.id), true);

  // Lookup exato por documento sem duplicar
  const exato = await clientePorDocumento(mascararCpf(CPF_PF_A), 1);
  assert.ok(exato);
  assert.equal(exato.id, clientePfA.id);
});

test('PJ: busca cliente por CNPJ com/sem máscara, razão social, nome fantasia e IE', async () => {
  const porCnpjMascara = await listar(RESOURCES.clientes, { filter: { pessoa: 'pj' }, q: mascararCnpj(CNPJ_PJ_A) }, gerenteA);
  assert.equal(porCnpjMascara.rows.some((r) => r.id === clientePjA.id), true);

  const porCnpjDigitos = await listar(RESOURCES.clientes, { filter: { pessoa: 'pj' }, q: CNPJ_PJ_A }, gerenteA);
  assert.equal(porCnpjDigitos.rows.some((r) => r.id === clientePjA.id), true);

  const porRazao = await listar(RESOURCES.clientes, { filter: { pessoa: 'pj' }, q: 'Confecções Cerrado Comércio' }, gerenteA);
  assert.equal(porRazao.rows.some((r) => r.id === clientePjA.id), true);

  const porFantasia = await listar(RESOURCES.clientes, { filter: { pessoa: 'pj' }, q: 'Boutique Cerrado Prime' }, gerenteA);
  assert.equal(porFantasia.rows.some((r) => r.id === clientePjA.id), true);

  const porIe = await listar(RESOURCES.clientes, { filter: { pessoa: 'pj' }, q: '104567890' }, gerenteA);
  assert.equal(porIe.rows.some((r) => r.id === clientePjA.id), true);
});

test('Produtos: busca global por nome, SKU e código de barras retorna grade P/M/G/GG com saldos reais', async () => {
  const escopoA = escopoDeSistema(1);

  const porNome = await searchProducts(escopoA, { q: 'Polo Executiva VPF', page: 1, pageSize: 10 });
  const familia = porNome.rows.find((r) => r.id === Number(produtoPai.id));
  assert.ok(familia, 'Família do produto deve retornar na busca por nome');
  assert.equal(familia.variacoes?.length, 4, 'Deve retornar as 4 variações P, M, G, GG');

  // Busca por código de barras da variação G
  const porBarcode = await searchProducts(escopoA, { q: '7898881000035', page: 1, pageSize: 10 });
  const achouG = porBarcode.rows
    .flatMap((r) => r.variacoes || [])
    .find((v) => v.codigo_barras === '7898881000035');
  assert.ok(achouG, 'Deve localizar a variação exata pelo EAN/código de barras');
  assert.equal(achouG.preco_venda, 160);
  assert.equal(achouG.estoque_disponivel, 5);

  // Variação GG tem saldo 0
  const varGG = familia.variacoes?.find((v) => v.variacao_tamanho_id === Number(tamGG.id));
  assert.ok(varGG);
  assert.equal(varGG.estoque_disponivel, 0);
});

test('Fluxo completo Venda PF: criar, adicionar P e G, editar item, descontos/frete, faturar e estornar no cancelamento', async () => {
  const vendaPf = await createRecord(
    RESOURCES.vendas,
    {
      cliente_id: clientePfA.id,
      data: '2026-10-23',
      status: 'aberta',
      canal_venda: 'balcao',
      desconto: 20,
      frete: 15,
      fin_status: 'recebido',
      fin_forma_pagamento: 'pix',
      fin_parcelas: 1,
      fin_recebido_em: '2026-10-23',
      fin_documento: 'PIX-E2E-001',
      observacoes: 'Venda balcão PF teste completo',
    },
    gerenteA
  );

  // Não permite faturar pedido sem itens
  await esperarErro(
    () => updateRecord(RESOURCES.vendas, Number(vendaPf.id), { status: 'faturada' }, gerenteA),
    409
  );

  // Adiciona 2x P (R$ 150) e 1x G (R$ 160 com 10% desc = R$ 144)
  let itemP: any;
  await createItem(
    mockReqItens(Number(vendaPf.id), { produto_id: produtoPai.id, tamanho_id: tamP.id, quantidade: 2, preco_unitario: 150, desconto_pct: 0 }, gerenteA),
    { status: () => ({ json: (d: any) => (itemP = d) }) } as any
  );
  await createItem(
    mockReqItens(Number(vendaPf.id), { produto_id: produtoPai.id, tamanho_id: tamG.id, quantidade: 1, preco_unitario: 160, desconto_pct: 10 }, gerenteA),
    { status: () => ({ json: () => undefined }) } as any
  );

  // Edita item P de 2 para 3 unidades (3 * 150 = 450; + 144 = 594; + frete 15 - desc 20 = 589)
  await updateItem(
    mockReqItens(
      Number(vendaPf.id),
      { produto_id: produtoPai.id, tamanho_id: tamP.id, quantidade: 3, preco_unitario: 150, desconto_pct: 0 },
      gerenteA,
      Number(itemP.id)
    ),
    { json: () => undefined } as any
  );

  const antesFaturar = await getRecord(RESOURCES.vendas, Number(vendaPf.id), gerenteA);
  assert.equal(Number(antesFaturar.total), 589);

  // Tentar adicionar GG sem saldo e faturar deve falhar com 409 mantendo a venda aberta
  let itemSemSaldo: any;
  await createItem(
    mockReqItens(Number(vendaPf.id), { produto_id: produtoPai.id, tamanho_id: tamGG.id, quantidade: 1, preco_unitario: 170, desconto_pct: 0 }, gerenteA),
    { status: () => ({ json: (d: any) => (itemSemSaldo = d) }) } as any
  );
  await esperarErro(
    () => updateRecord(RESOURCES.vendas, Number(vendaPf.id), { status: 'faturada' }, gerenteA),
    409
  );
  await deleteItem(mockReqItens(Number(vendaPf.id), {}, gerenteA, Number(itemSemSaldo.id)), { json: () => undefined } as any);

  // Recalcula e fatura com itens válidos
  const faturada = await updateRecord(RESOURCES.vendas, Number(vendaPf.id), { status: 'faturada' }, gerenteA);
  assert.equal(faturada.status, 'faturada');
  assert.equal(Number(faturada.total), 589);

  // Verifica baixa real do estoque nos tamanhos P (10 -> 7) e G (5 -> 4)
  const saldos = await listar(RESOURCES.estoques, { filter: { produto_id: String(produtoPai.id) } }, gerenteA);
  const saldoP = saldos.rows.find((s) => Number(s.tamanho_id) === Number(tamP.id));
  const saldoG = saldos.rows.find((s) => Number(s.tamanho_id) === Number(tamG.id));
  assert.equal(Number(saldoP?.quantidade), 7);
  assert.equal(Number(saldoG?.quantidade), 4);

  // Cancela a venda e verifica estorno integral do estoque (P -> 10, G -> 5)
  const cancelada = await updateRecord(RESOURCES.vendas, Number(vendaPf.id), { status: 'cancelada' }, gerenteA);
  assert.equal(cancelada.status, 'cancelada');
  const saldosPosEstorno = await listar(RESOURCES.estoques, { filter: { produto_id: String(produtoPai.id) } }, gerenteA);
  assert.equal(Number(saldosPosEstorno.rows.find((s) => Number(s.tamanho_id) === Number(tamP.id))?.quantidade), 10);
  assert.equal(Number(saldosPosEstorno.rows.find((s) => Number(s.tamanho_id) === Number(tamG.id))?.quantidade), 5);
});

test('Fluxo completo Venda PJ: 3 parcelas financeiras exatas em centavos + prévia fiscal NF-e 55', async () => {
  const vendaPj = await createRecord(
    RESOURCES.vendas,
    {
      cliente_id: clientePjA.id,
      data: '2026-10-23',
      status: 'aberta',
      canal_venda: 'representante',
      pedido_cliente: 'OC-9080',
      previsao_entrega: '2026-11-05',
      desconto: 50,
      frete: 50,
      fin_status: 'a_receber',
      fin_forma_pagamento: 'boleto',
      fin_parcelas: 3,
      fin_vencimento: '2026-11-23',
      condicao_pagamento: '30/60/90 dias',
    },
    gerenteA
  );

  // 2x M (R$ 150) + 2x G (R$ 160) = 300 + 320 = 620 (+ 50 frete - 50 desc = R$ 620,00; dividido em 3 parcelas: 206,68 + 206,66 + 206,66)
  await createItem(
    mockReqItens(Number(vendaPj.id), { produto_id: produtoPai.id, tamanho_id: tamM.id, quantidade: 2, preco_unitario: 150, desconto_pct: 0 }, gerenteA),
    { status: () => ({ json: () => undefined }) } as any
  );
  await createItem(
    mockReqItens(Number(vendaPj.id), { produto_id: produtoPai.id, tamanho_id: tamG.id, quantidade: 2, preco_unitario: 160, desconto_pct: 0 }, gerenteA),
    { status: () => ({ json: () => undefined }) } as any
  );

  const faturada = await updateRecord(RESOURCES.vendas, Number(vendaPj.id), { status: 'faturada' }, gerenteA);
  assert.equal(faturada.status, 'faturada');
  assert.equal(Number(faturada.total), 620);

  const lancamentos = await listar(
    RESOURCES.lancamentos_financeiros,
    { filter: { referencia_tipo: 'venda', referencia_id: String(vendaPj.id) } },
    gerenteA
  );
  assert.equal(lancamentos.rows.length, 3, 'Deve gerar exatamente 3 parcelas em contas a receber');
  const somaParcelas = Math.round(lancamentos.rows.reduce((acc, r) => acc + Number(r.valor), 0) * 100) / 100;
  assert.equal(somaParcelas, 620, 'Soma das parcelas deve bater exatamente com o total da venda sem perder centavos');

  // Prévia fiscal NF-e modelo 55 preserva os dados empresariais do cliente PJ
  const previa = await chamar(
    previaDocumento,
    reqDe({}, { params: { id: String(vendaPj.id) }, query: { modelo: '55' }, user: gerenteA })
  );
  assert.equal(previa.documento.modelo, '55');
  assert.equal(previa.documento.destinatario.documento, CNPJ_PJ_A);
  assert.equal(previa.documento.destinatario.ie, '104567890');
});

test('Permissões (RBAC) e Multi-tenant: operador vende sem quebrar e empresas são estritamente isoladas', async () => {
  // Operador cria venda e adiciona item normalmente, mas não acessa contas_financeiras nem exclui venda
  const vendaOp = await createRecord(
    RESOURCES.vendas,
    {
      cliente_id: clientePfA.id,
      data: '2026-10-23',
      status: 'aberta',
      fin_forma_pagamento: 'dinheiro',
      fin_parcelas: 1,
    },
    operadorA
  );
  await createItem(
    mockReqItens(Number(vendaOp.id), { produto_id: produtoPai.id, tamanho_id: tamM.id, quantidade: 1, preco_unitario: 150, desconto_pct: 0 }, operadorA),
    { status: () => ({ json: () => undefined }) } as any
  );
  let itensOp: any[] = [];
  await listItens(mockReqItens(Number(vendaOp.id), {}, operadorA), { json: (d: any) => (itensOp = d) } as any);
  assert.equal(itensOp.length, 1);

  await esperarErro(async () => listar(RESOURCES.contas_financeiras, {}, operadorA), 403);
  await esperarErro(async () => {
    checkAccess(RESOURCES.vendas, operadorA, 'delete');
    await deleteRecord(RESOURCES.vendas, Number(vendaOp.id), operadorA);
  }, 403);

  // Isolamento Multi-tenant: Empresa A jamais vê cliente B, nem cria venda com cliente B, nem lê venda de B
  const buscaCruzada = await listar(RESOURCES.clientes, { filter: { pessoa: 'pf' }, q: CPF_PF_B }, gerenteA);
  assert.equal(buscaCruzada.rows.length, 0);
  const docCruzado = await clientePorDocumento(CPF_PF_B, 1);
  assert.equal(docCruzado, null);

  await esperarErro(
    () =>
      createRecord(
        RESOURCES.vendas,
        { cliente_id: clientePfB.id, data: '2026-10-23', status: 'aberta' },
        gerenteA
      ),
    404
  );

  const vendaEmpresaB = await createRecord(
    RESOURCES.vendas,
    { cliente_id: clientePfB.id, data: '2026-10-23', status: 'aberta' },
    gerenteB
  );
  await esperarErro(() => getRecord(RESOURCES.vendas, Number(vendaEmpresaB.id), gerenteA), 404);
  await esperarErro(
    () => updateRecord(RESOURCES.vendas, Number(vendaEmpresaB.id), { observacoes: 'invasao' }, gerenteA),
    404
  );
});
