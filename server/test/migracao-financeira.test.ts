// ============================================================
// MIGRAÇÃO FINANCEIRA — os títulos a pagar nascem da NF-e importada (§12)
//
// O que fica travado:
//   • cada duplicata (`dup`) do XML vira UM título a pagar com número do
//     documento, vencimento, parcela e valor — nada é agregado numa bola só;
//   • nenhum título entra "pago": `fin_status` é `a_pagar` e o lançamento nasce
//     `pendente` — sem informação explícita de pagamento, o ERP não dá baixa;
//   • as datas e valores da nota são preservados (não "hoje" nem "total da nota");
//   • a empresa do título é a empresa ativa de quem importou;
//   • reimportar a MESMA chave de acesso para antes de duplicar compra e financeiro.
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, storeDoAtor, getDefaultLocal } = await import('../src/services');
const { garantirAdmin, criarAtor, reqDe, resFake, esperarErro, novoProduto, novoTamanho, novoFornecedor } = await import('./_p1util');
const { importarXmlCompra } = await import('../src/suprimentos');

/** NF-e mínima, mas com a estrutura real: ide, emit, det, ICMSTot e cobr/dup. */
function xmlNfe(opts: { numero: string; cnpj: string; nome: string; item: { codigo: string; descricao: string; quantidade: number; unitario: number }; duplicatas: { numero: string; vencimento: string; valor: number }[] }): string {
  const total = opts.item.quantidade * opts.item.unitario;
  const chave = createHash('sha256').update(`${opts.numero}${opts.cnpj}`).digest('hex').slice(0, 44);
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}">
      <ide><nNF>${opts.numero}</nNF><serie>1</serie><dhEmi>2026-10-02T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>${opts.cnpj}</CNPJ><xNome>${opts.nome}</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>${opts.item.codigo}</cProd><xProd>${opts.item.descricao}</xProd>
          <uCom>UN</uCom><qCom>${opts.item.quantidade}</qCom><vUnCom>${opts.item.unitario.toFixed(2)}</vUnCom>
          <vProd>${total.toFixed(2)}</vProd><CFOP>5102</CFOP>
        </prod>
      </det>
      <total><ICMSTot><vNF>${total.toFixed(2)}</vNF></ICMSTot></total>
      <cob>${opts.duplicatas.map((d) => `<dup><nDup>${d.numero}</nDup><dVenc>${d.vencimento}</dVenc><vDup>${d.valor.toFixed(2)}</vDup></dup>`).join('')}</cob>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function importar(xml: string, extra: Record<string, unknown> = {}, user?: any) {
  const req = reqDe({ xml, ...extra }, user ? { user } : {});
  const { res, saida } = resFake();
  await importarXmlCompra(req, res);
  return saida.json as any;
}

describe('migração financeira por NF-e (contas a pagar)', () => {
  test('cada duplicata vira um título a pagar, com documento/vencimento/parcela e SEM marcação de pago', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const fornecedor = await novoFornecedor({ nome: 'Fornecedor Financeiro P3', cnpj: '11222333000181', ativo: true });
    const produto = await novoProduto({ sku: 'MIG-FIN-1', nome: 'Produto financeiro' });
    await novoTamanho('U');

    const xml = xmlNfe({
      numero: '7788',
      cnpj: '11222333000181',
      nome: 'Fornecedor Financeiro P3',
      item: { codigo: 'MIG-FIN-1', descricao: 'Produto financeiro', quantidade: 2, unitario: 150 },
      duplicatas: [
        { numero: '001', vencimento: '2026-11-10', valor: 150 },
        { numero: '002', vencimento: '2026-12-10', valor: 150 },
      ],
    });

    const resposta = await importar(xml, { fornecedor_id: Number(fornecedor.id), sku: 'MIG-FIN-1', tamanho: 'U' }, autor);
    assert.ok(resposta, 'a importação precisa responder');
    const compraId = Number(resposta.compra_id ?? resposta.compra?.id ?? 0);
    assert.ok(compraId > 0, `compra não criada: ${JSON.stringify(resposta)}`);
    const compra = await getStore().get(RESOURCES.compras, compraId);
    assert.equal(String(compra?.nota_fiscal), '7788', 'o número da NF-e precisa ficar na compra');

    const lançamentos = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { referencia_tipo: 'compra', referencia_id: compraId } });
    assert.equal(lançamentos.rows.length, 2, 'uma duplicata = um título');
    for (const titulo of lançamentos.rows) {
      assert.equal(String(titulo.status), 'pendente', 'nada entra pago sem informação explícita');
      assert.equal(String(titulo.tipo), 'despesa');
      assert.equal(Number(titulo.empresa_id), 1);
      assert.equal(String(titulo.pessoa_tipo), 'fornecedor', 'o título precisa apontar a pessoa (§12)');
      assert.equal(Number(titulo.pessoa_id), Number(fornecedor.id));
      assert.match(String(titulo.documento ?? ''), /^00[12]$/, 'o nº da duplicata precisa virar documento (§12)');
      assert.ok(['2026-11-10', '2026-12-10'].includes(String(titulo.vencimento)), `vencimento perdido: ${titulo.vencimento}`);
      assert.equal(Number(titulo.valor), 150);
      assert.equal(String(titulo.referencia_tipo), 'compra');
      assert.equal(Number(titulo.referencia_id), compraId);
      assert.ok(String(titulo.descricao ?? '').length > 0, 'título sem descrição não é rastreável');
      assert.ok(String(titulo.descricao ?? '').includes(`Compra #${compraId}`), 'a descrição precisa apontar o pedido de origem');
    }
    // Nenhum título com data de pagamento preenchida.
    assert.ok(lançamentos.rows.every((t: any) => !t.pago_em && !t.data_pagamento));

    // Reimportar a MESMA nota não duplica nem a compra nem o financeiro.
    await esperarErro(() => importar(xml, { fornecedor_id: Number(fornecedor.id), sku: 'MIG-FIN-1', tamanho: 'U' }, autor), 409, /já foi importada/);
    const depois = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 100, filter: { referencia_tipo: 'compra', referencia_id: compraId } });
    assert.equal(depois.rows.length, 2);
  });

  test('o título a pagar nasce na empresa de quem importou (nunca na empresa padrão)', async () => {
    await garantirAdmin();
    const empresaB = await getStore().insert(RESOURCES.empresas, { nome: 'Empresa B NF-e', ativo: true });
    const empresaBId = Number(empresaB.id);
    const autorB = await criarAtor(empresaBId, 'gerente');
    const fornecedorB = await getStore().insert(RESOURCES.fornecedores, { empresa_id: empresaBId, nome: 'Fornecedor B', cnpj: '99888777000166', ativo: true });
    await getStore().insert(RESOURCES.produtos, { empresa_id: empresaBId, sku: 'MIG-B-NFE', nome: 'Produto B', preco_venda: 80, ativo: true });
    await novoTamanho('U');

    const xml = xmlNfe({
      numero: '9001',
      cnpj: '99888777000166',
      nome: 'Fornecedor B',
      item: { codigo: 'MIG-B-NFE', descricao: 'Produto B', quantidade: 1, unitario: 80 },
      duplicatas: [{ numero: 'A', vencimento: '2026-11-20', valor: 80 }],
    });
    const resposta = await importar(xml, { fornecedor_id: Number(fornecedorB.id), sku: 'MIG-B-NFE', tamanho: 'U' }, autorB);
    const compraId = Number(resposta.compra_id ?? resposta.compra?.id ?? 0);
    assert.ok(compraId > 0);

    const titulos = await getStore().list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 50, filter: { referencia_tipo: 'compra', referencia_id: compraId } });
    assert.equal(titulos.rows.length, 1);
    assert.equal(Number(titulos.rows[0].empresa_id), empresaBId);

    // A empresa A não enxerga esse título nem essa compra.
    const sA = storeDoAtor(await criarAtor(1, 'gerente'));
    const vistosPorA = await sA.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 200 });
    assert.equal(vistosPorA.rows.filter((t: any) => Number(t.referencia_id) === compraId && String(t.referencia_tipo) === 'compra').length, 0);
  });

  test('a entrada de estoque da NF-e é rastreável: movimentação com compra, usuário e motivo', async () => {
    await garantirAdmin();
    const autor = await criarAtor(1, 'gerente');
    const fornecedor = await novoFornecedor({ nome: 'Fornecedor Trilha P3', cnpj: '44555666000177', ativo: true });
    const produto = await novoProduto({ sku: 'MIG-TRILHA-1', nome: 'Produto trilha', custo: 10 });
    await novoTamanho('U');

    const xml = xmlNfe({
      numero: '5555',
      cnpj: '44555666000177',
      nome: 'Fornecedor Trilha P3',
      item: { codigo: 'MIG-TRILHA-1', descricao: 'Produto trilha', quantidade: 3, unitario: 42 },
      duplicatas: [{ numero: 'X', vencimento: '2026-11-30', valor: 126 }],
    });
    const resposta = await importar(xml, { fornecedor_id: Number(fornecedor.id), sku: 'MIG-TRILHA-1', tamanho: 'U' }, autor);
    const compraId = Number(resposta.compra_id ?? resposta.compra?.id ?? 0);
    assert.ok(compraId > 0);

    const movimentos = await getStore().list(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { compra_id: compraId } });
    assert.equal(movimentos.rows.length, 1, 'a entrada precisa de UMA movimentação (nada de mexer no saldo em silêncio)');
    const movimento = movimentos.rows[0];
    assert.equal(String(movimento.tipo), 'entrada');
    assert.equal(Number(movimento.quantidade), 3);
    assert.equal(Number(movimento.produto_id), Number(produto.id));
    assert.equal(Number(movimento.usuario_id), Number(autor.id));
    assert.match(String(movimento.motivo), /5555|Compra/);
    assert.equal(Number(movimento.empresa_id), 1);

    const local = await getDefaultLocal();
    const saldo = await getStore().findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), local: String(local) });
    assert.equal(Number(saldo?.quantidade ?? 0), 3);
  });
});
