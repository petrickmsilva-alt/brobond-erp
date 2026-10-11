// ============================================================
// ERP-04 — PROJEÇÃO `vendas → sales` NO MODO DEMONSTRAÇÃO (paridade).
//
// O e2e do ciclo roda em PostgreSQL (server/test/pg/bi-faturamento-e2e.test.ts).
// Este arquivo prova as MESMAS regras no modo memória, onde o risco de
// divergência é maior (memdb x PgStore) e onde o painel de demonstração vive:
//
//   • mapeamento de canal/status (tabela explícita do ADR-001);
//   • venda faturada → PAID, com margem materializada e valores em centavos;
//   • cancelada → CANCELLED (histórico fica, faturamento sai);
//   • aberta → NÃO projetada (pedido não é venda);
//   • idempotência (rodar duas vezes não duplica);
//   • o gancho pós-faturamento do fluxo real do ERP dispara a projeção
//     (initNegociosEngine + debounce) — não é preciso chamar nada à mão.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getStore } = await import('../src/services');
const {
  __reiniciarMemoriaNegocios,
  __desligarMotorNegocios,
  agregarResumo,
  canalErpParaSales,
  ERP_ID_PREFIXO_VENDA,
  initNegociosEngine,
  projetarVendasErp,
  repoNegocios,
  statusErpParaSales,
} = await import('../src/negocios');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };

type FiltrosVazios = Parameters<ReturnType<typeof repoNegocios>['listarVendas']>[0];
const SEM_FILTRO = { de: null, ate: null, empresaId: null, canal: null, canais: null, status: null, ids: null } as FiltrosVazios;

/** Tamanho da grade de demonstração (mesmo id usado pelos testes de pedidos). */
const TAMANHO_ID = 3;

let sequencia = 0;
async function criarVendaFaturavel(canal: string, quantidade: number) {
  sequencia += 1;
  const sku = `E04M-${Date.now().toString(36)}-${sequencia}`;
  const produto = await createRecord(RESOURCES.produtos, { sku, nome: `Produto ${sku}`, preco_venda: 100, custo: 40 }, admin);
  const cliente = await createRecord(RESOURCES.clientes, { nome: `Cliente ${sku}` }, admin);
  await createRecord(RESOURCES.movimentacoes, {
    tipo: 'entrada', produto_id: Number(produto.id), tamanho_id: TAMANHO_ID, local: 'loja', quantidade: 10, motivo: `Carga ${sku}`,
  }, admin);
  const venda = await createRecord(RESOURCES.vendas, {
    cliente_id: Number(cliente.id), data: '2026-10-01', canal_venda: canal, status: 'aberta',
  }, admin);
  await getStore().transaction(async (tx) => {
    const { validatePayload } = await import('../src/validate');
    const { recalcularTotal } = await import('../src/itens');
    const data = await validatePayload(RESOURCES.itens_venda, {
      produto_id: Number(produto.id), tamanho_id: TAMANHO_ID, quantidade, preco_unitario: 100, desconto_pct: 0,
    }, 'create');
    await getStore().insert(RESOURCES.itens_venda, {
      ...data, venda_id: Number(venda.id), subtotal: Math.round(quantidade * 100 * 100) / 100,
    }, tx);
    await recalcularTotal('venda', Number(venda.id), tx);
  });
  return { vendaId: Number(venda.id), produtoId: Number(produto.id) };
}

test('ERP-04: mapeamento canal/status é a tabela explícita do ADR (sem inventar marketplace)', () => {
  assert.equal(canalErpParaSales('pdv'), 'LOJA_FISICA');
  assert.equal(canalErpParaSales('balcao'), 'LOJA_FISICA');
  assert.equal(canalErpParaSales('site_varejo'), 'BROBOND');
  assert.equal(canalErpParaSales('site_atacado'), 'BROBOND');
  assert.equal(canalErpParaSales('representante'), 'BROBOND');
  assert.equal(canalErpParaSales('whatsapp'), 'BROBOND');
  // O ERP registra QUE a venda veio de marketplace, não QUAL: identidade de
  // marketplace não é inventada (ADR-001 §4).
  assert.equal(canalErpParaSales('marketplace'), 'BROBOND');
  assert.equal(canalErpParaSales(undefined), 'BROBOND');

  assert.equal(statusErpParaSales('faturada'), 'PAID');
  assert.equal(statusErpParaSales('entregue'), 'PAID');
  assert.equal(statusErpParaSales('cancelada'), 'CANCELLED');
  assert.equal(statusErpParaSales('aberta'), null);
  assert.equal(statusErpParaSales('cotacao'), null);
});

test('ERP-04 (modo demonstração): venda faturada vira PAID no BI, com margem em centavos', async () => {
  __reiniciarMemoriaNegocios();
  const { vendaId, produtoId } = await criarVendaFaturavel('pdv', 2);
  const salesId = `${ERP_ID_PREFIXO_VENDA}${vendaId}`;

  // Antes do faturamento: nada projetado (pedido não é venda).
  await projetarVendasErp();
  const antes = await repoNegocios().listarVendas(SEM_FILTRO, null);
  assert.equal(antes.filter((v) => v.id === salesId).length, 0, 'venda aberta não entra no BI');

  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, admin);
  const projecao = await projetarVendasErp();
  assert.equal(projecao.vendas, 1);
  assert.equal(projecao.itens, 1);

  const linhas = await repoNegocios().listarVendas(SEM_FILTRO, null);
  const linha = linhas.find((v) => v.id === salesId);
  assert.ok(linha, 'a venda faturada precisa aparecer no BI');
  assert.equal(linha!.status, 'PAID');
  assert.equal(linha!.canal, 'LOJA_FISICA', 'canal pdv → loja física');
  assert.equal(linha!.canalGrupo, 'loja_fisica');
  assert.equal(linha!.amountCents, 20000, '2 × R$ 100,00 em centavos');
  assert.equal(linha!.quantidade, 2);
  assert.equal(linha!.empresaId, 1);
  assert.equal(linha!.netCents, 20000, 'margem materializada já na projeção');
  assert.equal(linha!.cmvCents, 8000, 'CMV = 2 × custo R$ 40,00');
  assert.equal(linha!.taxCents, 0, 'sem alíquota cadastrada, imposto é 0 (nunca inventado)');

  // O agregador do BI enxerga o faturamento.
  const itens = await repoNegocios().listarItensVenda(SEM_FILTRO);
  const abc = await repoNegocios().curvaABC(null, null);
  const resumo = agregarResumo(linhas, itens, abc);
  assert.equal(resumo.kpis.pedidos, 1);
  assert.equal(resumo.kpis.faturamentoCents, 20000);
  assert.equal(resumo.kpis.ticketMedioCents, 20000);
  assert.equal(resumo.kpis.semMargemCalculada, 0);
  assert.equal(resumo.topProdutos[0]?.productId, produtoId);

  // Idempotência: projetar de novo não duplica nem muda valores.
  await projetarVendasErp();
  const depois = await repoNegocios().listarVendas(SEM_FILTRO, null);
  assert.equal(depois.filter((v) => v.id === salesId).length, 1, 'a projeção é idempotente');
  assert.equal(depois.find((v) => v.id === salesId)!.amountCents, 20000);

  // Estorno: a linha vira CANCELLED (histórico preservado) e sai dos totais.
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'cancelada' }, admin);
  await projetarVendasErp();
  const cancelada = (await repoNegocios().listarVendas(SEM_FILTRO, null)).find((v) => v.id === salesId);
  assert.equal(cancelada?.status, 'CANCELLED', 'venda cancelada depois de faturada vira CANCELLED');
  const resumoCancelado = agregarResumo(await repoNegocios().listarVendas(SEM_FILTRO, null), await repoNegocios().listarItensVenda(SEM_FILTRO), await repoNegocios().curvaABC(null, null));
  assert.equal(resumoCancelado.kpis.faturamentoCents, 0, 'venda cancelada não conta como faturamento');
});

test('ERP-04 (modo demonstração): faturar pelo fluxo do ERP dispara a projeção sozinho (gancho)', async () => {
  __reiniciarMemoriaNegocios();
  initNegociosEngine(); // registra o listener do gancho (sem Postgres, nada de ciclo automático)
  try {
    const { vendaId } = await criarVendaFaturavel('site_varejo', 1);
    const salesId = `${ERP_ID_PREFIXO_VENDA}${vendaId}`;
    await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, admin);

    // O gancho agenda com debounce (3 s): o teste espera o ciclo documentado.
    const limite = Date.now() + 12_000;
    let linha = null as Awaited<ReturnType<ReturnType<typeof repoNegocios>['listarVendas']>>[number] | null;
    while (Date.now() < limite) {
      linha = (await repoNegocios().listarVendas(SEM_FILTRO, null)).find((v) => v.id === salesId) ?? null;
      if (linha && linha.netCents !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(linha, 'a venda faturada aparece no BI sem chamada manual ao motor');
    assert.equal(linha!.canal, 'BROBOND', 'site_varejo → canal próprio');
    assert.equal(linha!.amountCents, 10000);
    assert.equal(linha!.netCents, 10000, 'margem materializada junto da projeção');
  } finally {
    __desligarMotorNegocios();
  }
});
