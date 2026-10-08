// ============================================================
// AUDITORIA MULTIEMPRESA DA FASE P3 (§16/§17)
//
// A proteção tem de ser de DADOS (store/serviço/banco), nunca de tela. Aqui a
// EMPRESA A tenta alcançar produção, ficha técnica, fiscal, financeiro, caixa,
// relatórios, importação/logs de integração e a fila de retentativas da
// EMPRESA B — direto pelos HANDLERS reais, como um cliente HTTP faria.
//
// O que cada teste prova:
//   • 404 (nunca 403, que confirmaria a existência) para registro de outra empresa;
//   • listagem nunca soma a outra empresa;
//   • fila/retry de integração é recortada pela empresa do escopo;
//   • a empresa B continua enxergando os próprios dados (o recorte não é "negar
//     tudo": é negar o que não é dela).
// ============================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore, storeDoAtor } = await import('../src/services');
const { escopoDoAtor } = await import('../src/empresa');
const { ADMIN, garantirAdmin, criarAtor, reqDe, resFake, chamar, esperarErro, novoProduto, novoTamanho, novoCliente } = await import('./_p1util');

const producao = await import('../src/producao');
const nfe = await import('../src/nfe');
const pdv = await import('../src/pdv');
const relatorios = await import('../src/relatorios');
const hub = await import('../src/commerce/hub');

async function empresaNova(nome: string) {
  const row = await getStore().insert(RESOURCES.empresas, { nome, ativo: true });
  return Number(row.id);
}

async function ordemDaEmpresa(empresaId: number, nome: string) {
  const tamanho = await novoTamanho('M');
  const ordem = await getStore().insert(RESOURCES.ordens, {
    empresa_id: empresaId,
    tipo: 'grade',
    produto: nome,
    quantidade: 10,
    status: 'em_producao',
    data: '2026-10-01',
  });
  await getStore().insert(RESOURCES.itens_ordem, {
    empresa_id: empresaId,
    ordem_id: Number(ordem.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 10,
  });
  return ordem;
}

describe('multiempresa P3 — produção / ficha técnica', () => {
  test('itens de OP de outra empresa: 404 no handler (não é filtro de tela)', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Produção');
    const ordemB = await ordemDaEmpresa(empresaB, 'Peça da B');
    const atorA = await criarAtor(1, 'gerente');

    await esperarErro(
      () => chamar(producao.listItensOrdem, reqDe({}, { params: { id: Number(ordemB.id) }, user: atorA }), 200),
      404,
      /Ordem de fabricação/
    );

    // A própria empresa B lista normalmente — o recorte não bloqueia o dono.
    const itensB = await chamar(producao.listItensOrdem, reqDe({}, { params: { id: Number(ordemB.id) }, user: await criarAtor(empresaB, 'gerente') }));
    assert.equal(itensB.length, 1);

    // E a OP da empresa B não aparece na listagem genérica da A.
    const daA = await storeDoAtor(atorA).list(RESOURCES.ordens, { page: 1, pageSize: 100 });
    assert.equal(daA.rows.filter((o: any) => Number(o.id) === Number(ordemB.id)).length, 0);
  });

  test('insumos de ficha técnica de outra empresa: 404 no handler', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Ficha');
    const produtoB = await novoProduto({ empresa_id: empresaB, sku: 'FICHA-B-1', nome: 'Produto ficha B' });
    const insumoB = await getStore().insert(RESOURCES.insumos, { empresa_id: empresaB, nome: 'Insumo B', unidade: 'un', custo_medio: 3 });
    const fichaB = await getStore().insert(RESOURCES.fichas, { empresa_id: empresaB, produto_id: Number(produtoB.id), nome: 'Ficha B', status: 'ativa' });
    await getStore().insert(RESOURCES.itens_ficha_tecnica, { empresa_id: empresaB, ficha_id: Number(fichaB.id), insumo_id: Number(insumoB.id), consumo: 2 });

    const atorA = await criarAtor(1, 'gerente');
    await esperarErro(
      () => chamar(producao.listInsumosFicha, reqDe({}, { params: { id: Number(fichaB.id) }, user: atorA })),
      404,
      /Ficha técnica/
    );

    // `aplicar-preco` (escrita!) também não alcança a ficha da B.
    await esperarErro(
      () => chamar(producao.aplicarPrecoFicha, reqDe({}, { params: { id: Number(fichaB.id) }, user: atorA })),
      404,
      /Ficha técnica/
    );
  });
});

describe('multiempresa P3 — fiscal', () => {
  test('dados fiscais de venda da outra empresa: 404 (nada de nota vazada)', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Fiscal');
    const clienteB = await getStore().insert(RESOURCES.clientes, { empresa_id: empresaB, nome: 'Cliente fiscal B', tipo: 'loja', ativo: true });
    const vendaB = await getStore().insert(RESOURCES.vendas, {
      empresa_id: empresaB,
      cliente_id: Number(clienteB.id),
      data: '2026-10-02',
      status: 'aberta',
      total: 100,
    });

    const atorA = await criarAtor(1, 'gerente');
    await esperarErro(
      () => chamar(nfe.nfeDados, reqDe({}, { params: { id: Number(vendaB.id) }, user: atorA })),
      404
    );

    const dadosB = await chamar(nfe.nfeDados, reqDe({}, { params: { id: Number(vendaB.id) }, user: await criarAtor(empresaB, 'gerente') }));
    assert.ok(dadosB);
  });
});

describe('multiempresa P3 — financeiro e caixa', () => {
  test('lançamentos da empresa B não entram na listagem nem no resumo da A', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Financeiro');
    await getStore().insert(RESOURCES.lancamentos_financeiros, {
      empresa_id: empresaB,
      tipo: 'receita',
      descricao: 'Título confidencial da B',
      valor: 4321.99,
      vencimento: '2026-11-01',
      status: 'pendente',
      data: '2026-10-02',
    });

    const atorA = await criarAtor(1, 'gerente');
    const sA = storeDoAtor(atorA);
    const daA = await sA.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 500 });
    assert.equal(daA.rows.filter((l: any) => String(l.descricao).includes('confidencial da B')).length, 0);

    // O handler real de resumo financeiro responde sem o título da B.
    const resumoA = await chamar((await import('../src/financeiro')).resumoFinanceiro, reqDe({}, { user: atorA }));
    assert.ok(!JSON.stringify(resumoA).includes('confidencial da B'));

    // E a B enxerga o próprio título (o recorte é por empresa, não "negar tudo").
    const sB = storeDoAtor(await criarAtor(empresaB, 'gerente'));
    const daB = await sB.list(RESOURCES.lancamentos_financeiros, { page: 1, pageSize: 500 });
    assert.equal(daB.rows.filter((l: any) => String(l.descricao).includes('confidencial da B')).length, 1);
  });

  test('caixa aberto de outra empresa: a consulta da A não devolve o caixa da B', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Caixa');
    await getStore().insert(RESOURCES.pdv_caixas, {
      empresa_id: empresaB,
      numero: 'CX-B-001',
      status: 'aberto',
      abertura_em: new Date().toISOString(),
      valor_abertura: 100,
      usuario_abertura_id: null,
    });

    const atorA = await criarAtor(1, 'gerente');
    const { res, saida } = resFake();
    await pdv.caixaAberto(reqDe({}, { query: { numero: 'CX-B-001' }, user: atorA }), res);
    const corpoA = saida.json as any;
    assert.equal(corpoA.caixa, null);
  });
});

describe('multiempresa P3 — relatórios, integrações e jobs', () => {
  test('relatório de estoque conta só o saldo da empresa ativa', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Relatório');
    const produtoA = await novoProduto({ sku: 'REL-A-1', nome: 'Produto relatório A' });
    await novoTamanho('M');
    const tamanho = await getStore().findOneWhere(RESOURCES.tamanhos, { codigo: 'M' });
    await getStore().insert(RESOURCES.estoques, { produto_id: Number(produtoA.id), tamanho_id: Number(tamanho!.id), local: 'loja', quantidade: 7 });

    const produtoB = await novoProduto({ empresa_id: empresaB, sku: 'REL-B-1', nome: 'Produto relatório B' });
    await getStore().insert(RESOURCES.estoques, { empresa_id: empresaB, produto_id: Number(produtoB.id), tamanho_id: Number(tamanho!.id), local: 'loja', quantidade: 999 });

    const atorA = await criarAtor(1, 'gerente');
    const { res, saida } = resFake();
    await relatorios.relatorio(reqDe({}, { params: { nome: 'estoque-posicao' }, user: atorA }), res, 'estoque-posicao');
    const textoA = JSON.stringify(saida.json);
    assert.ok(textoA.includes('REL-A-1'), 'a A precisa ver o próprio produto');
    assert.ok(!textoA.includes('REL-B-1'), 'a A não pode ver o produto da B');

    const atorB = await criarAtor(empresaB, 'gerente');
    const { res: resB, saida: saidaB } = resFake();
    await relatorios.relatorio(reqDe({}, { params: { nome: 'estoque-posicao' }, user: atorB }), resB, 'estoque-posicao');
    const textoB = JSON.stringify(saidaB.json);
    assert.ok(textoB.includes('REL-B-1'));
    assert.ok(!textoB.includes('REL-A-1'));
  });

  test('logs de integração e fila de retry são recortados pela empresa', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Hub');
    const atorA = await criarAtor(1, 'gerente');
    const atorB = await criarAtor(empresaB, 'gerente');

    const ctxA = hub.contextoDoAtor('WOOCOMMERCE', atorA, {});
    const ctxB = hub.contextoDoAtor('WOOCOMMERCE', atorB, {});
    const vencido = new Date(Date.now() - 3_600_000).toISOString();
    await hub.registrarLog({ ctx: ctxA, operacao: 'pedido.importar', status: 'erro', erro: 'A', externalId: 'SKU-A', proximaTentativaEm: vencido });
    await hub.registrarLog({ ctx: ctxB, operacao: 'pedido.importar', status: 'erro', erro: 'B', externalId: 'SKU-B', proximaTentativaEm: vencido });

    const pendentesA = await hub.pendentesDeRetry(ctxA.escopo, 50);
    assert.deepEqual(pendentesA.map((p: any) => String(p.external_id)), ['SKU-A']);
    const pendentesB = await hub.pendentesDeRetry(ctxB.escopo, 50);
    assert.deepEqual(pendentesB.map((p: any) => String(p.external_id)), ['SKU-B']);

    const logsA = await hub.listarLogsDeIntegracao(ctxA, {});
    assert.ok(logsA.every((l: any) => Number(l.empresa_id) === 1));
    const logsB = await hub.listarLogsDeIntegracao(ctxB, {});
    assert.ok(logsB.every((l: any) => Number(l.empresa_id) === empresaB));
  });

  test('alertas de estoque mínimo: com escopo conta só a empresa; sem escopo é o panorama do grupo', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Alertas');
    const { verificarAlertasEstoque } = await import('../src/notifications');
    const tamanho = await novoTamanho('G');
    const prodA = await novoProduto({ sku: 'ALERTA-A', nome: 'Produto alerta A' });
    const prodB = await novoProduto({ empresa_id: empresaB, sku: 'ALERTA-B', nome: 'Produto alerta B' });
    await getStore().insert(RESOURCES.estoques, { produto_id: Number(prodA.id), tamanho_id: Number(tamanho.id), local: 'loja', quantidade: 1, estoque_min: 5 });
    await getStore().insert(RESOURCES.estoques, { empresa_id: empresaB, produto_id: Number(prodB.id), tamanho_id: Number(tamanho.id), local: 'loja', quantidade: 1, estoque_min: 5 });

    const atorA = await criarAtor(1, 'gerente');
    const soA = await verificarAlertasEstoque(atorA);
    const soB = await verificarAlertasEstoque(await criarAtor(empresaB, 'gerente'));
    const grupo = await verificarAlertasEstoque();
    assert.equal(soA.produtos, 1);
    assert.equal(soB.produtos, 1);
    assert.equal(grupo.produtos, 2);
  });

  test('importação grava o lote na empresa do ator (trilha por empresa)', async () => {
    await garantirAdmin();
    const empresaB = await empresaNova('Empresa B Importação');
    const atorB = await criarAtor(empresaB, 'gerente');
    const escopo = escopoDoAtor(atorB as any);
    const lote = await getStore().insert(RESOURCES.importacoes_lotes, {
      empresa_id: escopo.empresaId,
      usuario_id: atorB.id,
      tipo: 'produtos',
      total: 1,
      importados: 1,
      status: 'concluido',
    });
    assert.equal(Number(lote.empresa_id), empresaB);
    const vistosPorA = await storeDoAtor(ADMIN).list(RESOURCES.importacoes_lotes, { page: 1, pageSize: 100 });
    assert.equal(vistosPorA.rows.filter((l: any) => Number(l.id) === Number(lote.id)).length, 0);
  });
});
