// ============================================================================
// IMPORTAÇÃO DE NF-e DE ENTRADA + DE-PARA DE SKU — E3.2
//
// Por que este arquivo existe
// ---------------------------
// `importarXmlCompra` era um handler COMPLETO no backend (parser, hash,
// idempotência por chave de acesso, de-para, compra já recebida) com **zero**
// cobertura — `grep -rn "importarXmlCompra\|importar-xml" server/test/` não
// achava nada. Um parser de nota fiscal sem teste é exatamente o tipo de código
// que quebra em silêncio quando o layout do XML muda.
//
// Sobre o XML abaixo: é uma FIXTURE de teste, com a estrutura real do leiaute da
// SEFAZ (nfeProc/NFe/infNFe/ide/emit/det/prod/imposto/total/dup). Não é uma nota
// de verdade e não é usada em lugar nenhum fora dos testes — a tela só trabalha
// com o arquivo que o usuário escolher. Sem isto, o parser não teria cobertura.
//
// O que se prova aqui:
//   • pré-validação (`aplicar: false`) NÃO grava nada e lista TODAS as
//     pendências de uma vez, em vez de parar no primeiro item;
//   • importação cria a compra já recebida, sobe estoque e aplica a REGRA
//     CANÔNICA de custo (não uma cópia);
//   • o frete do XML vai para `compras.frete` e entra no custo efetivo;
//   • a mesma chave de acesso não gera duas compras (409);
//   • a prévia de recebimento (`previsao: true`) não grava nada;
//   • de-para: criar, editar, inativar, unicidade por fornecedor e isolamento
//     entre empresas.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { chamar, esperarErro, garantirAdmin, novoLocal, reqDe, saldoDe } = await import('./_p1util');
const suprimentos = await import('../src/suprimentos');

await garantirAdmin();
await novoLocal('loja');

const s = () => getStore();
let seq = 0;

/** NF-e mínima com a estrutura real do leiaute SEFAZ. */
function nfe(opts: {
  chave: string;
  numero: string;
  cnpj: string;
  razao: string;
  itens: { codigo: string; descricao: string; qtd: number; unit: number; unidade?: string }[];
  frete?: number;
  duplicatas?: { n: number; venc: string; valor: number }[];
}) {
  const vProd = opts.itens.reduce((a, i) => a + i.qtd * i.unit, 0);
  const frete = opts.frete ?? 0;
  const total = vProd + frete;
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${opts.chave}" versao="4.00">
      <ide>
        <cUF>52</cUF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie>
        <nNF>${opts.numero}</nNF><dhEmi>2026-10-01T10:00:00-03:00</dhEmi><tpNF>1</tpNF>
      </ide>
      <emit>
        <CNPJ>${opts.cnpj}</CNPJ><xNome>${opts.razao}</xNome>
        <enderEmit><xLgr>Rua Teste</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>5208707</cMun><xMun>GOIANIA</xMun><UF>GO</UF><CEP>74000000</CEP></enderEmit>
      </emit>
${opts.itens
  .map(
    (i, idx) => `      <det nItem="${idx + 1}">
        <prod>
          <cProd>${i.codigo}</cProd><cEAN>SEM GTIN</cEAN><xProd>${i.descricao}</xProd>
          <NCM>60062100</NCM><CFOP>6102</CFOP><uCom>${i.unidade ?? 'UN'}</uCom>
          <qCom>${i.qtd.toFixed(4)}</qCom><vUnCom>${i.unit.toFixed(4)}</vUnCom><vProd>${(i.qtd * i.unit).toFixed(2)}</vProd>
        </prod>
        <imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${(i.qtd * i.unit).toFixed(2)}</vBC><pICMS>18.00</pICMS><vICMS>${(i.qtd * i.unit * 0.18).toFixed(2)}</vICMS></ICMS00></ICMS></imposto>
      </det>`
  )
  .join('\n')}
      <total><ICMSTot><vNF>${total.toFixed(2)}</vNF><vProd>${vProd.toFixed(2)}</vProd><vFrete>${frete.toFixed(2)}</vFrete></ICMSTot></total>
${
  opts.duplicatas?.length
    ? `      <cobr><fat><nFat>${opts.numero}</nFat><vOrig>${total.toFixed(2)}</vOrig></fat>
${opts.duplicatas.map((d) => `        <dup><nDup>${String(d.n).padStart(3, '0')}</nDup><dVenc>${d.venc}</dVenc><vDup>${d.valor.toFixed(2)}</vDup></dup>`).join('\n')}
      </cobr>`
    : ''
}
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function novoProduto(codigo: string, empresaId = 1) {
  seq++;
  return s().insert(RESOURCES.produtos, { nome: `Produto ${codigo} ${seq}`, sku: codigo, empresa_id: empresaId, ativo: true, custo: 0 });
}
async function novoTamanho(codigo = 'U') {
  const existente = await s().findOneWhere(RESOURCES.tamanhos, { codigo });
  if (existente) return existente;
  return s().insert(RESOURCES.tamanhos, { codigo, nome: codigo, ativo: true });
}
async function novoFornecedor(cnpj: string, nome = 'Fornecedor XML') {
  seq++;
  return s().insert(RESOURCES.fornecedores, { nome: `${nome} ${seq}`, cnpj, ativo: true, empresa_id: 1 });
}

function reqImportar(xml: string, extra: Record<string, unknown> = {}) {
  return reqDe({ xml, ...extra });
}

// ---------------------------------------------------------------------------
// 1) PRÉ-VALIDAÇÃO
// ---------------------------------------------------------------------------
test('E3.2: pré-validação do XML NÃO grava nada e devolve fornecedor, nota e itens', async () => {
  const tam = await novoTamanho();
  const prod = await novoProduto('SKU-XML-1');
  const forn = await novoFornecedor('11222333000181');
  await s().insert(RESOURCES.produto_fornecedor_skus, {
    empresa_id: 1,
    fornecedor_id: Number(forn.id),
    codigo_fornecedor: 'COD-FORN-1',
    produto_id: Number(prod.id),
    tamanho_id: Number(tam.id),
    descricao: 'Tecido sarja 100% algodão',
    unidade: 'M',
    ativo: true,
  });

  const comprasAntes = (await s().list(RESOURCES.compras, { page: 1, pageSize: 500 })).total;
  const xml = nfe({
    chave: '52261011222333000181550010000000011000000017',
    numero: '100000001',
    cnpj: '11.222.333/0001-81',
    razao: 'Fornecedor XML 1',
    itens: [{ codigo: 'COD-FORN-1', descricao: 'Tecido sarja', qtd: 10, unit: 12.5 }],
    duplicatas: [{ n: 1, venc: '2026-11-01', valor: 125 }],
  });

  const r = await chamar(suprimentos.importarXmlCompra, reqImportar(xml, { aplicar: false }), 200);

  assert.equal(r.aplicado, false, 'a pré-validação não pode se apresentar como importação');
  assert.equal(r.fornecedor.cnpj.replace(/\D/g, ''), '11222333000181');
  assert.equal(r.nota.numero, '100000001');
  assert.equal(r.itens.length, 1);
  assert.equal(r.itens[0].sku, 'SKU-XML-1', 'o de-para precisa apontar para o produto certo');
  assert.equal(r.itens[0].tamanho, tam.codigo);
  assert.equal(r.pendencias.length, 0);
  assert.equal(r.pode_importar, true);

  assert.equal((await s().list(RESOURCES.compras, { page: 1, pageSize: 500 })).total, comprasAntes, 'a pré-validação criou uma compra');
  const movs = (await s().list(RESOURCES.movimentacoes, { page: 1, pageSize: 500, filter: { produto_id: Number(prod.id) } })).rows;
  assert.equal(movs.length, 0, 'a pré-validação movimentou estoque');
});

test('E3.2: pré-validação lista TODAS as pendências de de-para, não só a primeira', async () => {
  const xml = nfe({
    chave: '52261011222333000181550010000000021000000026',
    numero: '100000002',
    cnpj: '11.222.333/0001-81',
    razao: 'Fornecedor XML 1',
    itens: [
      { codigo: 'SEM-DEPARA-A', descricao: 'Item A sem de-para', qtd: 5, unit: 10 },
      { codigo: 'SEM-DEPARA-B', descricao: 'Item B sem de-para', qtd: 7, unit: 20 },
    ],
  });

  const r = await chamar(suprimentos.importarXmlCompra, reqImportar(xml, { aplicar: false }), 200);
  assert.equal(r.pode_importar, false);
  assert.equal(r.pendencias.length, 2, 'deveria listar as duas pendências de uma vez');
  assert.deepEqual(
    r.pendencias.map((p: any) => p.codigo_fornecedor).sort(),
    ['SEM-DEPARA-A', 'SEM-DEPARA-B']
  );
  assert.ok(r.pendencias.every((p: any) => /de-para/i.test(p.motivo)), 'o motivo precisa dizer o que falta');
});

test('E3.2: importar XML com item sem de-para é recusado com 422 (não inventa produto)', async () => {
  const xml = nfe({
    chave: '52261011222333000181550010000000031000000035',
    numero: '100000003',
    cnpj: '11.222.333/0001-81',
    razao: 'Fornecedor XML 1',
    itens: [{ codigo: 'NAO-EXISTE', descricao: 'Item sem cadastro', qtd: 3, unit: 15 }],
  });
  await esperarErro(() => chamar(suprimentos.importarXmlCompra, reqImportar(xml), 201), 422, /de-para/i);
});

test('E3.2: arquivo que não é NF-e é recusado', async () => {
  await esperarErro(() => chamar(suprimentos.importarXmlCompra, reqImportar('<html><body>não é nfe</body></html>'), 201), 422, /NF-e/i);
});

// ---------------------------------------------------------------------------
// 2) IMPORTAÇÃO REAL
// ---------------------------------------------------------------------------
test('E3.2: importar XML cria a compra recebida, sobe estoque e aplica o custo canônico', async () => {
  const tam = await novoTamanho();
  const prod = await novoProduto('SKU-XML-2');
  const forn = await novoFornecedor('22333444000190');
  await s().insert(RESOURCES.produto_fornecedor_skus, {
    empresa_id: 1,
    fornecedor_id: Number(forn.id),
    codigo_fornecedor: 'COD-FORN-2',
    produto_id: Number(prod.id),
    tamanho_id: Number(tam.id),
    descricao: 'Linha de costura',
    unidade: 'CX',
    ativo: true,
  });

  // 20 un a R$ 30 = 600, frete 100 → frete por unidade 5 → custo efetivo 35.
  const xml = nfe({
    chave: '52261022333444000190550010000000041000000044',
    numero: '100000004',
    cnpj: '22.333.444/0001-90',
    razao: 'Fornecedor XML 2',
    itens: [{ codigo: 'COD-FORN-2', descricao: 'Linha de costura', qtd: 20, unit: 30, unidade: 'CX' }],
    frete: 100,
  });

  const r = await chamar(suprimentos.importarXmlCompra, reqImportar(xml), 201);
  assert.equal(r.ok, true);
  assert.ok(r.compra_id, 'a compra precisa ser criada');

  const compra = await s().get(RESOURCES.compras, Number(r.compra_id));
  assert.equal(String(compra!.status), 'recebido', 'a compra vinda da NF-e já entra recebida');
  assert.equal(Number(compra!.frete), 100, 'o frete do XML precisa ir para compras.frete — sem isso o rateio não tem de onde sair');

  const saldo = await saldoDe(Number(prod.id), Number(tam.id), 'loja');
  assert.equal(saldo, 20, 'o estoque deveria subir 20');

  const produtoDepois = await s().get(RESOURCES.produtos, Number(prod.id));
  assert.equal(Number(produtoDepois!.custo), 35, `o custo efetivo deveria ser 30 + 100/20 = 35, veio ${produtoDepois!.custo}`);

  const mov = (await s().list(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { produto_id: Number(prod.id), tipo: 'entrada' } })).rows;
  assert.equal(mov.length, 1);
  assert.equal(Number(mov[0].custo_unitario), 35, 'a movimentação precisa carregar o custo EFETIVO, não o preço');
  assert.equal(Number(mov[0].compra_id), Number(r.compra_id), 'a movimentação precisa ter vínculo estrutural com a compra');
});

test('E3.2: a mesma chave de acesso não gera duas compras (idempotência real)', async () => {
  const tam = await novoTamanho();
  const prod = await novoProduto('SKU-XML-3');
  const forn = await novoFornecedor('33444555000101');
  await s().insert(RESOURCES.produto_fornecedor_skus, {
    empresa_id: 1,
    fornecedor_id: Number(forn.id),
    codigo_fornecedor: 'COD-FORN-3',
    produto_id: Number(prod.id),
    tamanho_id: Number(tam.id),
    ativo: true,
  });
  const xml = nfe({
    chave: '52261033444555000101550010000000051000000053',
    numero: '100000005',
    cnpj: '33.444.555/0001-01',
    razao: 'Fornecedor XML 3',
    itens: [{ codigo: 'COD-FORN-3', descricao: 'Botão', qtd: 10, unit: 2 }],
  });

  const primeiro = await chamar(suprimentos.importarXmlCompra, reqImportar(xml), 201);
  await esperarErro(() => chamar(suprimentos.importarXmlCompra, reqImportar(xml), 201), 409, /já foi importada/i);

  const saldo = await saldoDe(Number(prod.id), Number(tam.id), 'loja');
  assert.equal(saldo, 10, 'a repetição dobrou o estoque');
  void primeiro;
});

test('E3.2: XML sem itens é recusado', async () => {
  const xml = `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe52261000000000000000550010000000061000000062"><ide><nNF>6</nNF></ide><emit><CNPJ>11222333000181</CNPJ><xNome>X</xNome></emit></infNFe></NFe></nfeProc>`;
  await esperarErro(() => chamar(suprimentos.importarXmlCompra, reqImportar(xml), 201), 422, /itens/i);
});

// ---------------------------------------------------------------------------
// 3) PRÉVIA DE RECEBIMENTO
// ---------------------------------------------------------------------------
test('E3.2: a prévia de recebimento calcula o custo e NÃO grava nada', async () => {
  const forn = await novoFornecedor('44555666000110');
  const insumo = await s().insert(RESOURCES.insumos, { nome: 'Insumo prévia', unidade: 'un', custo_medio: 10, ativo: true, empresa_id: 1 });
  const compra = await s().insert(RESOURCES.compras, { empresa_id: 1, fornecedor_id: Number(forn.id), data: '2026-10-09', status: 'pendente', total: 5000, frete: 400 });
  const item = await s().insert(RESOURCES.itens_compra, { empresa_id: 1, compra_id: Number(compra.id), insumo_id: Number(insumo.id), quantidade: 100, quantidade_recebida: 0, preco_unitario: 50 });
  const compras = await import('../src/compras');

  const antes = {
    saldo: await s().insumoStock(Number(insumo.id)),
    custo: (await s().get(RESOURCES.insumos, Number(insumo.id)))!.custo_medio,
    movs: (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 200, filter: { insumo_id: Number(insumo.id) } })).rows.length,
  };

  const r = await chamar(compras.receberParcial, reqDe({ previsao: true, itens: [{ item_compra_id: Number(item.id), quantidade: 40 }] }, { params: { id: compra.id } }), 200);

  assert.equal(r.aplicado, false);
  assert.equal(r.previsao, true);
  assert.equal(r.custos.length, 1);
  // 50 + 160/40 = 54; média ponderada (0×10 + 40×54)/40 = 54
  assert.equal(r.custos[0].custo_unitario_efetivo, 54);
  assert.equal(Number(r.custos[0].custo_medio_antes), 10);
  assert.equal(r.custos[0].custo_medio_depois, 54);
  assert.equal(r.custos[0].custo_frete_rateado, 160, 'a prévia precisa mostrar a parte do frete que este lote leva');
  assert.equal(r.completo, false, 'receber 40 de 100 não completa o pedido');

  const depois = {
    saldo: await s().insumoStock(Number(insumo.id)),
    custo: (await s().get(RESOURCES.insumos, Number(insumo.id)))!.custo_medio,
    movs: (await s().list(RESOURCES.movimentacoes_insumos, { page: 1, pageSize: 200, filter: { insumo_id: Number(insumo.id) } })).rows.length,
  };
  assert.deepEqual(depois, antes, 'a prévia gravou algo');
});

test('E3.2: a prévia não aceita quantidade acima do que falta', async () => {
  const forn = await novoFornecedor('55666777000120');
  const insumo = await s().insert(RESOURCES.insumos, { nome: 'Insumo prévia 2', unidade: 'un', custo_medio: 0, ativo: true, empresa_id: 1 });
  const compra = await s().insert(RESOURCES.compras, { empresa_id: 1, fornecedor_id: Number(forn.id), data: '2026-10-09', status: 'pendente', total: 5000 });
  const item = await s().insert(RESOURCES.itens_compra, { empresa_id: 1, compra_id: Number(compra.id), insumo_id: Number(insumo.id), quantidade: 100, quantidade_recebida: 0, preco_unitario: 50 });
  const compras = await import('../src/compras');

  await esperarErro(
    () => chamar(compras.receberParcial, reqDe({ previsao: true, itens: [{ item_compra_id: Number(item.id), quantidade: 150 }] }, { params: { id: compra.id } }), 200),
    409
  );
});

// ---------------------------------------------------------------------------
// 4) DE-PARA
// ---------------------------------------------------------------------------
test('E3.2: de-para é único por fornecedor e pode ser editado e inativado', async () => {
  const { createRecord, updateRecord, listRecords } = await import('../src/services');
  const { ADMIN } = await import('./_p1util');
  const prod = await novoProduto('SKU-DEPARA-1');
  const tam = await novoTamanho();
  const forn = await novoFornecedor('66777888000130');

  const criado = await createRecord(
    RESOURCES.produto_fornecedor_skus,
    { fornecedor_id: Number(forn.id), codigo_fornecedor: 'ABC-123', produto_id: Number(prod.id), tamanho_id: Number(tam.id), descricao: 'Tecido xadrez', unidade: 'M', ativo: true },
    ADMIN
  );
  assert.equal(criado.codigo_fornecedor, 'ABC-123');
  assert.equal(criado.descricao, 'Tecido xadrez');
  assert.equal(criado.unidade, 'M');
  assert.equal(criado.ativo, true);

  // A unicidade (fornecedor_id, codigo_fornecedor) é CONSTRAINT do banco, e o
  // memdb não tem constraint — esse caso está provado em pg-compras-xml-depara.

  // Editar e inativar.
  const editado = await updateRecord(RESOURCES.produto_fornecedor_skus, Number(criado.id), { descricao: 'Tecido xadrez azul', ativo: false }, ADMIN);
  assert.equal(editado.descricao, 'Tecido xadrez azul');
  assert.equal(editado.ativo, false);

  const lista = await listRecords(RESOURCES.produto_fornecedor_skus, { page: 1, pageSize: 100, filter: { fornecedor_id: Number(forn.id) } });
  assert.ok(lista.rows.length >= 1);
});

test('E3.2 MULTIEMPRESA: o de-para da empresa A não aparece nem é editável pela B (A → B → A)', async () => {
  const { createRecord, getRecord } = await import('../src/services');
  const empresaB = await s().insert(RESOURCES.empresas, { nome: 'Empresa B DePara', cnpj: '77888999000140', ativo: true });
  const bid = Number(empresaB.id);
  const usuarioB = await s().insert(RESOURCES.usuarios, { nome: 'Gerente B DePara', email: `gb-depara-${bid}@brobond.test`, perfil: 'gerente', empresa_id: bid, ativo: true });
  const atorB = { id: Number(usuarioB.id), name: 'Gerente B DePara', perfil: 'gerente' as const, empresa_id: bid, empresas: [bid] };

  const prodA = await novoProduto('SKU-A-ISOLADO');
  const tam = await novoTamanho();
  const fornA = await novoFornecedor('88999000000150');
  const depara = await createRecord(
    RESOURCES.produto_fornecedor_skus,
    { fornecedor_id: Number(fornA.id), codigo_fornecedor: 'ISO-1', produto_id: Number(prodA.id), tamanho_id: Number(tam.id) },
    { id: 1, name: 'Admin Teste', perfil: 'admin' }
  );

  // B não pode ler o de-para da A: 404, nunca 403 (não vaza existência).
  await esperarErro(() => getRecord(RESOURCES.produto_fornecedor_skus, Number(depara.id), atorB), 404);

  // B cria o seu próprio, com o MESMO código — não colide, porque o escopo é outro.
  const prodB = await novoProduto('SKU-B-ISOLADO', bid);
  const fornB = await s().insert(RESOURCES.fornecedores, { nome: 'Fornecedor B', cnpj: '88999000000150', ativo: true, empresa_id: bid });
  const deparaB = await createRecord(
    RESOURCES.produto_fornecedor_skus,
    { fornecedor_id: Number(fornB.id), codigo_fornecedor: 'ISO-1', produto_id: Number(prodB.id), tamanho_id: Number(tam.id) },
    atorB
  );
  assert.notEqual(Number(deparaB.id), Number(depara.id));

  // Voltando para A: o de-para original segue intacto e apontando para o produto da A.
  const deParaA = await getRecord(RESOURCES.produto_fornecedor_skus, Number(depara.id), { id: 1, name: 'Admin Teste', perfil: 'admin' });
  assert.equal(Number(deParaA.produto_id), Number(prodA.id), 'o de-para da A vazou para a B');
});
