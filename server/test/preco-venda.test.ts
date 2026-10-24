// ============================================================================
// FORMAÇÃO DO PREÇO DA VENDA — suíte canônica do servidor.
//
// REGRA COMERCIAL DESTE ERP: a BASE do desconto é SEMPRE o PREÇO DE VENDA.
// O preço de TABELA é referência comercial (snapshot) e NÃO participa do
// cálculo. O SUBTOTAL é `preço líquido × quantidade`.
//
// Prova, pelo CONTRATO DO BACKEND (não pela tela), que a linha da venda
// distingue: preço de tabela → preço de venda → desconto % → desconto R$ →
// subtotal, e que o resumo fecha em preço bruto → desconto → líquido → frete →
// total, sem o erro "Desconto − R$ 0,00" quando há desconto nas linhas.
//
// Cobre os casos obrigatórios da tarefa e a autorização (backend) para alterar
// o preço de tabela, com auditoria.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, getRecord, getStore, podeEditarPrecoTabela } = await import('../src/services');
const { createItem, updateItem, deleteItem } = await import('../src/itens');
const {
  descontoUnitarioDe,
  descontoUnitarioDePrecoLiquido,
  linhaDePreco,
  normalizarPct,
  normalizarPrecoVenda,
  pctDeDescontoUnitario,
  pctDePrecoLiquido,
  precoLiquidoDe,
  resumoVenda,
} = await import('../src/precoVenda');
const { garantirAdmin, novoCliente, novoProduto, novoTamanho, reqDe, criarAtor } = await import('./_p1util');

await garantirAdmin();
const admin = { id: 1, name: 'Admin Teste', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
// Perfil que NÃO tem autorização de tabela (nem por perfil, nem explícita).
const operador = await criarAtor(1, 'operador');

const cliente = await novoCliente({ nome: 'Cliente Preço Venda' });
const produto80 = await novoProduto({ sku: 'PV-80', nome: 'Produto Tabela 80', preco_venda: 80 });
const produto90 = await novoProduto({ sku: 'PV-90', nome: 'Produto Tabela 90', preco_venda: 90 });
const produtoSemTabela = await novoProduto({ sku: 'PV-0', nome: 'Produto Sem Preço', preco_venda: 0 });
const tamanho = await novoTamanho('PV-TAM');

function mockItem(vendaId: number, body: Record<string, unknown>, itemId?: number, user: any = admin): any {
  const req = reqDe(body, { params: itemId ? { id: String(vendaId), itemId: String(itemId) } : { id: String(vendaId) }, user });
  req.path = `/api/vendas/${vendaId}/itens${itemId ? `/${itemId}` : ''}`;
  return req;
}

async function novaVenda(extra: Record<string, unknown> = {}, user: any = admin) {
  return createRecord(
    RESOURCES.vendas,
    { cliente_id: cliente.id, data: '2026-10-23', status: 'aberta', canal_venda: 'balcao', ...extra },
    user
  );
}

async function addItem(vendaId: number, body: Record<string, unknown>, user: any = admin) {
  let saida: any;
  await createItem(mockItem(vendaId, body, undefined, user), { status: () => ({ json: (d: any) => (saida = d) }) } as any);
  return saida;
}

async function editarItem(vendaId: number, itemId: number, body: Record<string, unknown>, user: any = admin) {
  let saida: any;
  await updateItem(mockItem(vendaId, body, itemId, user), { json: (d: any) => (saida = d) } as any);
  return saida;
}

async function itensDaVenda(vendaId: number) {
  return (await getStore().list(RESOURCES.itens_venda, { page: 1, pageSize: 100, filter: { venda_id: vendaId } })).rows;
}

async function auditoriaDaVenda(vendaId: number) {
  return (await getStore().list(RESOURCES.auditoria, { page: 1, pageSize: 500, filter: { recurso: 'vendas', registro_id: vendaId } })).rows;
}

// ---------------------------------------------------------------------------
// Funções puras — os casos obrigatórios da tarefa
// ---------------------------------------------------------------------------

test('CASO 1 — venda 90 com 20%: desconto R$ 18 e líquido R$ 72', () => {
  const l = linhaDePreco(1, 90, 20);
  assert.equal(l.precoVenda, 90);
  assert.equal(l.descontoPct, 20);
  assert.equal(l.descontoUnitario, 18);
  assert.equal(l.subtotal, 72);
  assert.equal(l.desconto, 18);
});

test('CASO 2 — venda 90 com desconto R$ 18: desconto 20% e líquido R$ 72', () => {
  const pct = pctDeDescontoUnitario(90, 18);
  assert.equal(pct, 20);
  const l = linhaDePreco(1, 90, pct);
  assert.equal(l.descontoUnitario, 18);
  assert.equal(l.subtotal, 72);
});

test('CASO 3 — venda 90 com líquido desejado 72: desconto R$ 18 e 20%', () => {
  assert.equal(descontoUnitarioDePrecoLiquido(90, 72), 18);
  assert.equal(pctDePrecoLiquido(90, 72), 20);
  assert.equal(precoLiquidoDe(90, 18), 72);
});

test('CASO 4 — venda 90 menos R$ 15: líquido R$ 75 e 16,67%', () => {
  const pct = pctDeDescontoUnitario(90, 15);
  assert.equal(pct, 16.67);
  const l = linhaDePreco(1, 90, pct);
  assert.equal(l.subtotal, 75);
  assert.equal(l.descontoUnitario, 15);
});

test('CASO 5 — venda 90 com 20,5%: desconto R$ 18,45 e líquido R$ 71,55', () => {
  const l = linhaDePreco(1, 90, 20.5);
  assert.equal(l.descontoUnitario, 18.45);
  assert.equal(l.subtotal, 71.55);
});

test('sem desconto: desconto 0 e subtotal = venda × quantidade', () => {
  const l = linhaDePreco(3, 90, 0);
  assert.equal(l.precoVenda, 90);
  assert.equal(l.descontoPct, 0);
  assert.equal(l.descontoUnitario, 0);
  assert.equal(l.subtotal, 270);
});

test('quantidade maior que 1: subtotal = líquido × quantidade', () => {
  const l = linhaDePreco(2, 90, 20);
  assert.equal(l.subtotal, 144);
  assert.equal(l.bruto, 180);
  assert.equal(l.desconto, 36);
});

test('O PREÇO DE TABELA NÃO INTERFERE NO CÁLCULO (tabela 80, venda 90, 20%)', () => {
  const comTabela = linhaDePreco(1, 90, 20, 80);
  const semTabela = linhaDePreco(1, 90, 20);
  assert.equal(comTabela.tabela, 80);
  assert.equal(comTabela.descontoUnitario, 18);
  assert.equal(comTabela.subtotal, 72);
  assert.deepEqual({ ...comTabela, tabela: 0 }, { ...semTabela, tabela: 0 });
});

test('múltiplas linhas: o resumo soma e o percentual é ponderado pelo bruto', () => {
  const r = resumoVenda([linhaDePreco(1, 90, 20), linhaDePreco(1, 90, 0), linhaDePreco(2, 90, 20)], 0, 0);
  assert.equal(r.bruto, 360);
  assert.equal(r.descontoLinhas, 54);
  assert.equal(r.subtotalLiquido, 306);
  assert.equal(r.total, 306);
  // 50% em 100 e 0% em 300 → 50/400 = 12,5% (não a média simples 25%).
  const ponderado = resumoVenda([linhaDePreco(1, 100, 50), linhaDePreco(1, 300, 0)], 0, 0);
  assert.equal(ponderado.descontoPct, 12.5);
  assert.notEqual(ponderado.descontoPct, 25);
});

test('frete: subtotal líquido + frete = total', () => {
  const r = resumoVenda([linhaDePreco(1, 90, 20)], 0, 25);
  assert.equal(r.subtotalLiquido, 72);
  assert.equal(r.total, 97);
});

test('valores inválidos/negativos são normalizados para um intervalo seguro', () => {
  assert.equal(normalizarPct(-10), 0);
  assert.equal(normalizarPct(150), 100);
  assert.equal(normalizarPrecoVenda(-5), 0);
  assert.equal(linhaDePreco(1, 90, -5).descontoUnitario, 0);
  assert.equal(linhaDePreco(1, 90, 120).subtotal, 0);
  assert.equal(linhaDePreco(1, -50, 20).precoVenda, 0);
});

// ---------------------------------------------------------------------------
// Contrato de serviço — o backend é a autoridade
// ---------------------------------------------------------------------------

test('item: grava o snapshot da tabela e calcula o subtotal pelo preço de VENDA', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), {
    produto_id: Number(produto80.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 90,
    desconto_pct: 20,
  });
  assert.equal(Number(item.preco_tabela), 80, 'snapshot do preço de tabela do produto');
  assert.equal(Number(item.preco_unitario), 90, 'preço de venda é a base');
  assert.equal(Number(item.desconto_pct), 20);
  assert.equal(Number(item.subtotal), 72, 'tabela 80 NÃO entra na conta: 90 − 18 = 72');

  const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
  assert.equal(Number(venda.total), 72);
});

test('item: preço de venda acima da tabela mantém o desconto informado', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), {
    produto_id: Number(produto80.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 100,
    desconto_pct: 10,
  });
  assert.equal(Number(item.preco_tabela), 80, 'tabela continua sendo a referência');
  assert.equal(Number(item.preco_unitario), 100);
  assert.equal(Number(item.subtotal), 90, '10% sobre 100, não sobre 80');
});

test('item: alterar só o preço de venda MANTÉM o desconto atual', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), {
    produto_id: Number(produto90.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 90,
    desconto_pct: 20,
  });
  const editado = await editarItem(Number(v.id), Number(item.id), { preco_unitario: 100 });
  assert.equal(Number(editado.preco_unitario), 100);
  assert.equal(Number(editado.desconto_pct), 20, 'o desconto foi preservado');
  assert.equal(Number(editado.subtotal), 80, '100 − 20% = 80');
  assert.equal(Number(editado.preco_tabela), 90, 'a tabela não mudou');
});

test('item: desconto acima de 100% é recusado pela validação (não gera preço negativo)', async () => {
  const v = await novaVenda();
  await assert.rejects(
    () =>
      addItem(Number(v.id), {
        produto_id: Number(produto90.id),
        tamanho_id: Number(tamanho.id),
        quantidade: 1,
        preco_unitario: 90,
        desconto_pct: 150,
      }),
    (e: any) => e?.status === 400 && e?.fields?.desconto_pct === 'Máximo: 100'
  );
});

test('item: preço de venda negativo e quantidade inválida são recusados', async () => {
  const v = await novaVenda();
  await assert.rejects(
    () => addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: -5 }),
    (e: any) => e?.status === 400
  );
  await assert.rejects(
    () => addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 0, preco_unitario: 90 }),
    (e: any) => e?.status === 400
  );
});

test('item: produto sem preço de tabela aceita o preço informado como preço de venda', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), {
    produto_id: Number(produtoSemTabela.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 50,
  });
  assert.equal(Number(item.preco_tabela), 0);
  assert.equal(Number(item.preco_unitario), 50);
  assert.equal(Number(item.desconto_pct), 0);
  assert.equal(Number(item.subtotal), 50);
});

test('resumo: linha com tabela 80 e venda 90 a 20% mostra desconto R$ 18 (nunca − R$ 0,00)', async () => {
  const v = await novaVenda();
  await addItem(Number(v.id), {
    produto_id: Number(produto80.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 90,
    desconto_pct: 20,
  });
  const itens = await itensDaVenda(Number(v.id));
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_unitario), subtotal: Number(it.subtotal) })),
    0,
    0
  );
  assert.equal(r.bruto, 90, 'preço bruto = preço de venda');
  assert.equal(r.descontoLinhas, 18);
  assert.equal(r.descontoTotal, 18);
  assert.equal(r.subtotalLiquido, 72);
  const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
  assert.equal(Number(venda.total), 72);
});

test('resumo: desconto comercial do cabeçalho entra no desconto total e no total', async () => {
  const v = await novaVenda({ desconto: 10, frete: 5 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 90, desconto_pct: 20 });
  const itens = await itensDaVenda(Number(v.id));
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_unitario), subtotal: Number(it.subtotal) })),
    10,
    5
  );
  assert.equal(r.subtotalLiquido, 144);
  assert.equal(r.descontoLinhas, 36);
  assert.equal(r.descontoPedido, 10);
  assert.equal(r.descontoTotal, 46);
  assert.equal(r.total, 139);
  const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
  assert.equal(Number(venda.total), 139);
});

// ---------------------------------------------------------------------------
// EDIÇÃO BIDIRECIONAL — o servidor mantém os três campos coerentes
// ---------------------------------------------------------------------------

test('edição bidirecional: desconto % → R$ → líquido, sem acumular erro de arredondamento', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  // 20% → venda 68 → venda 75 → 10% → desconto R$ 15 → 20,5%.
  const roteiro: Array<Record<string, unknown>> = [
    { desconto_pct: 20 },
    { preco_unitario: 68 },
    { preco_unitario: 75 },
    { desconto_pct: 10 },
    { desconto_pct: pctDeDescontoUnitario(90, 15) },
    { desconto_pct: 20.5 },
  ];
  for (const passo of roteiro) {
    const r = await editarItem(Number(v.id), Number(item.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, ...passo });
    const venda = Number(r.preco_unitario);
    const pct = Number(r.desconto_pct);
    const descRs = descontoUnitarioDe(venda, pct);
    assert.equal(Number(r.subtotal), precoLiquidoDe(venda, descRs), `subtotal divergente em ${JSON.stringify(passo)}`);
    assert.equal(Number(r.preco_tabela), 90, 'a tabela é referência e não muda');
  }
  const final = await editarItem(Number(v.id), Number(item.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20.5 });
  assert.equal(Number(final.subtotal), 71.55);
});

// ---------------------------------------------------------------------------
// AUTORIZAÇÃO DO PREÇO DE TABELA — aplicada no BACKEND, com auditoria
// ---------------------------------------------------------------------------

test('autorização: operador SEM permissão não altera o preço de tabela (403 do servidor)', async () => {
  assert.equal(podeEditarPrecoTabela(operador), false, 'operador sem autorização explícita não edita');
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await assert.rejects(
    () => editarItem(Number(v.id), Number(item.id), { preco_tabela: 100 }, operador),
    (e: any) => e?.status === 403
  );
  // A linha permanece intacta.
  const relido = (await itensDaVenda(Number(v.id)))[0];
  assert.equal(Number(relido.preco_tabela), 90);
});

test('autorização: operador COM permissão explícita altera o preço de tabela e a mudança é auditada', async () => {
  const autorizado = await criarAtor(1, 'operador');
  await getStore().update(RESOURCES.usuarios, Number(autorizado.id), { perm_preco_tabela: 'permitir' });
  const ator = { ...autorizado, perm_preco_tabela: 'permitir' };
  assert.equal(podeEditarPrecoTabela(ator), true);

  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 }, ator);
  const editado = await editarItem(Number(v.id), Number(item.id), { preco_tabela: 120 }, ator);
  assert.equal(Number(editado.preco_tabela), 120, 'a tabela foi alterada');
  assert.equal(Number(editado.preco_unitario), 90, 'o preço de venda não mudou');
  assert.equal(Number(editado.subtotal), 72, 'o cálculo do desconto não usou a tabela');

  const auditoria = await auditoriaDaVenda(Number(v.id));
  const registro = auditoria.find((a) => /Preço de tabela/i.test(String(a.descricao || '')));
  assert.ok(registro, 'a alteração do preço de tabela foi registrada na auditoria');
  assert.match(String((registro as any).descricao), /de 90\.00 para 120\.00/);
  assert.equal(Number((registro as any).registro_id), Number(v.id));
  assert.equal(String((registro as any).usuario), ator.name, 'a trilha identifica quem alterou');
});

test('autorização: admin altera o preço de tabela sem precisar de concessão explícita', async () => {
  assert.equal(podeEditarPrecoTabela(admin), true);
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  const editado = await editarItem(Number(v.id), Number(item.id), { preco_tabela: 85 });
  assert.equal(Number(editado.preco_tabela), 85);
});

test('autorização: enviar a MESMA tabela vigente não exige permissão (não é alteração)', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  const editado = await editarItem(Number(v.id), Number(item.id), { preco_tabela: 90, quantidade: 2 }, operador);
  assert.equal(Number(editado.preco_tabela), 90);
  assert.equal(Number(editado.subtotal), 144);
});

// ---------------------------------------------------------------------------
// SNAPSHOT HISTÓRICO — a venda não pode ser reescrita pela tabela de hoje
// ---------------------------------------------------------------------------

test('snapshot: alterar a tabela do produto depois NÃO reescreve a venda existente', async () => {
  const v = await novaVenda();
  const item = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  assert.equal(Number(item.preco_tabela), 90);

  await getStore().update(RESOURCES.produtos, Number(produto90.id), { preco_venda: 120 });
  try {
    const relido = (await itensDaVenda(Number(v.id)))[0];
    assert.equal(Number(relido.preco_tabela), 90, 'o snapshot da venda continua 90');
    assert.equal(Number(relido.subtotal), 72, 'o valor praticado não muda');
    const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
    assert.equal(Number(venda.total), 72);
  } finally {
    await getStore().update(RESOURCES.produtos, Number(produto90.id), { preco_venda: 90 });
  }
});

test('snapshot: editar uma linha SEM snapshot (escritor secundário) preserva a referência histórica', async () => {
  // Espelha o que a loja, o catálogo público, o marketplace e a recompra do
  // portal gravam: preço PRATICADO em `preco_unitario`, sem `preco_tabela`.
  const v = await novaVenda();
  const item = await getStore().insert(RESOURCES.itens_venda, {
    empresa_id: 1,
    venda_id: Number(v.id),
    produto_id: Number(produto90.id),
    tamanho_id: Number(tamanho.id),
    quantidade: 1,
    preco_unitario: 90,
    desconto_pct: 0,
    subtotal: 90,
    preco_tabela: null,
  });

  await getStore().update(RESOURCES.produtos, Number(produto90.id), { preco_venda: 120 });
  try {
    const editado = await editarItem(Number(v.id), Number(item.id), { quantidade: 3 });
    assert.equal(Number(editado.preco_tabela), 90, 'a referência é o preço já praticado, não a tabela de hoje');
    assert.equal(Number(editado.preco_unitario), 90);
    assert.equal(Number(editado.desconto_pct), 0, 'não inventa desconto que nunca foi concedido');
    assert.equal(Number(editado.subtotal), 270, '3 × 90');
  } finally {
    await getStore().update(RESOURCES.produtos, Number(produto90.id), { preco_venda: 90 });
  }
});

// ---------------------------------------------------------------------------
// CONTRATO HTTP REAL — o servidor é a autoridade sobre o corpo enviado
// ---------------------------------------------------------------------------

async function appDeVendas() {
  const express = (await import('express')).default;
  const { createItem: criar, updateItem: atualizar } = await import('../src/itens');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = (req as any).headers['x-ator'] === 'operador' ? operador : admin;
    next();
  });
  const wrap = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res)).catch(next);
  app.post('/api/vendas/:id/itens', wrap(criar));
  app.put('/api/vendas/:id/itens/:itemId', wrap(atualizar));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).json({ error: err?.message, fields: err?.fields }));
  return app;
}

test('contrato HTTP: o cliente não forja lista_preco_id e o desconto é sobre o preço de venda', async () => {
  const request = (await import('supertest')).default;
  const app = await appDeVendas();
  const v = await novaVenda();
  const criado = await request(app)
    .post(`/api/vendas/${v.id}/itens`)
    .send({ produto_id: Number(produto80.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20, lista_preco_id: 4242 })
    .expect(201);
  assert.equal(Number(criado.body.preco_tabela), 80, 'a tabela vem da precificação do produto');
  assert.equal(Number(criado.body.lista_preco_id ?? 0) !== 4242, true, 'a lista de preço forjada é ignorada');
  assert.equal(Number(criado.body.subtotal), 72, '20% sobre 90, não sobre 80');
});

test('contrato HTTP: operador sem permissão recebe 403 ao tentar alterar o preço de tabela', async () => {
  const request = (await import('supertest')).default;
  const app = await appDeVendas();
  const v = await novaVenda();
  const criado = await request(app)
    .post(`/api/vendas/${v.id}/itens`)
    .send({ produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 })
    .expect(201);

  await request(app)
    .put(`/api/vendas/${v.id}/itens/${criado.body.id}`)
    .set('x-ator', 'operador')
    .send({ preco_tabela: 500 })
    .expect(403);

  // O operador PODE editar o preço de venda e o desconto normalmente.
  const ok = await request(app)
    .put(`/api/vendas/${v.id}/itens/${criado.body.id}`)
    .set('x-ator', 'operador')
    .send({ preco_unitario: 100, desconto_pct: 10 })
    .expect(200);
  assert.equal(Number(ok.body.subtotal), 90);
  assert.equal(Number(ok.body.preco_tabela), 90, 'a tabela continua a referência');
});

// ---------------------------------------------------------------------------
// CONSUMIDORES EXISTENTES — leem a mesma semântica, sem quebrar
// ---------------------------------------------------------------------------

test('consumidores: fiscal, PDF, NFe e financeiro reconciliam com o desconto das linhas', async () => {
  const v = await novaVenda();
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 90, desconto_pct: 20 });
  const itens = await itensDaVenda(Number(v.id));
  const it = itens[0];

  // O desconto é derivado de `preco_unitario × quantidade − subtotal`; o valor
  // unitário (PDF/NFe) é o PREÇO DE VENDA praticado.
  const unitarioCents = Math.round(Number(it.preco_unitario) * 100);
  const descontoCents = Math.max(Math.round((Number(it.preco_unitario) * Number(it.quantidade) - Number(it.subtotal)) * 100), 0);
  assert.equal(unitarioCents, 9000, 'valor unitário = preço de venda');
  assert.equal(descontoCents, 3600, 'desconto de R$ 36,00 em 2 peças (2 × R$ 18,00)');
  assert.equal(Number(it.subtotal), 144);

  const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
  assert.equal(Number(venda.total), 144);
  assert.equal(Number(venda.total) + descontoCents / 100, Number(it.preco_unitario) * Number(it.quantidade));
});

test('regressão do fluxo normal: venda com frete e desconto de cabeçalho fecha o total', async () => {
  const v = await novaVenda({ desconto: 10, frete: 25 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto80.id), tamanho_id: Number(tamanho.id), quantidade: 2, preco_unitario: 80, desconto_pct: 20 });
  // Líquido 72 + 128 = 200; − 10 do cabeçalho; + 25 de frete = 215.
  const venda = await getRecord(RESOURCES.vendas, Number(v.id), admin);
  assert.equal(Number(venda.total), 215);
});

test('remover item mantém o desconto das linhas restantes no resumo', async () => {
  const v = await novaVenda();
  const a = await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await addItem(Number(v.id), { produto_id: Number(produto90.id), tamanho_id: Number(tamanho.id), quantidade: 1, preco_unitario: 90, desconto_pct: 20 });
  await deleteItem(mockItem(Number(v.id), {}, Number(a.id)), { json: () => undefined } as any);
  const itens = await itensDaVenda(Number(v.id));
  assert.equal(itens.length, 1);
  const r = resumoVenda(
    itens.map((it) => ({ bruto: Number(it.quantidade) * Number(it.preco_unitario), subtotal: Number(it.subtotal) })),
    0,
    0
  );
  assert.equal(r.bruto, 90);
  assert.equal(r.descontoLinhas, 18);
  assert.equal(r.total, 72);
});
