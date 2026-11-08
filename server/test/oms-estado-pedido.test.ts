// ============================================================================
// FASE 5 — OMS: MÁQUINA DE ESTADOS EXPLÍCITA E AUDITÁVEL (migration 0109).
//
// Prova, no modo memória, que:
//   • o grafo de transições aceita o ciclo comercial real
//     (cotacao → aberta → faturada → entregue, e cancelamentos);
//   • transição PROIBIDA é recusada na ORIGEM (não só na tela): reabrir uma
//     venda cancelada e "desfaturar" uma venda faturada devolvem 409;
//   • estado inventado (fora do grafo) é recusado;
//   • CADA mudança de estado vira UMA linha na trilha imutável
//     `vendas_status_historico`, com de→para, autor e canal;
//   • a trilha não duplica a transição (idempotência: sem mudança não grava);
//   • a trilha é multiempresa: o pedido da empresa A não vaza para a B.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getStore } = await import('../src/services');
const { HttpError } = await import('../src/errors');
const { STATUS_PEDIDO, transicaoPermitida, validarTransicao, ehTerminal } = await import('../src/omsEstado');
const { historicoStatusVenda } = await import('../src/oms');
const { ADMIN, criarAtor, garantirAdmin, novoProduto, novoCliente, reqDe, chamar, esperarErro, saldoInicial } = await import('./_p1util');

await garantirAdmin();

const s = getStore();
let seq = 0;
const sufixo = `${Date.now() % 1000000}`;

/** Venda mínima com um item e saldo, pronta para transitar de estado. */
async function vendaFaturavel(empresaId = 1, ator = ADMIN) {
  seq++;
  const cliente = await novoCliente({ empresa_id: empresaId });
  const produto = await novoProduto({ empresa_id: empresaId, sku: `OMS-${sufixo}-${seq}`, preco_venda: 100 });
  const saldo = await saldoInicial(produto, 20, { codigoTamanho: `OMS${sufixo}${seq}`.slice(0, 6) });
  const venda = await createRecord(RESOURCES.vendas, {
    empresa_id: empresaId,
    cliente_id: Number(cliente.id),
    data: '2026-11-01',
    status: 'aberta',
    local_saida: saldo.local,
    total: 100,
  }, ator);
  await s.transaction(async (tx) => {
    await s.insert(RESOURCES.itens_venda, {
      empresa_id: empresaId,
      venda_id: Number(venda.id),
      produto_id: Number(produto.id),
      tamanho_id: Number(saldo.tamanho.id),
      quantidade: 1,
      preco_unitario: 100,
      desconto_pct: 0,
      subtotal: 100,
    }, tx);
    const { recalcularTotal } = await import('../src/itens');
    await recalcularTotal('venda', Number(venda.id), tx);
  });
  return { vendaId: Number(venda.id), empresaId, saldo, produto };
}

async function trilha(vendaId: number): Promise<any[]> {
  const out = await s.list(RESOURCES.vendas_status_historico, {
    page: 1,
    pageSize: 100,
    filter: { venda_id: vendaId },
    sort: 'criado_em',
    dir: 'asc',
  });
  return out.rows;
}

// ---------------------------------------------------------------------------
// 1. Grafo de transições (puro, sem banco).
// ---------------------------------------------------------------------------
test('OMS — o grafo aceita o ciclo comercial e recusa reabrir/desfaturar', () => {
  // Ciclo feliz.
  assert.equal(transicaoPermitida('cotacao', 'aberta'), true);
  assert.equal(transicaoPermitida('aberta', 'faturada'), true);
  assert.equal(transicaoPermitida('faturada', 'entregue'), true);
  assert.equal(transicaoPermitida('entregue', 'cancelada'), true);
  // Criação (sem estado anterior) é livre.
  assert.equal(transicaoPermitida(null, 'cotacao'), true);
  // Sem mudança é permitido (nada a gravar).
  assert.equal(transicaoPermitida('aberta', 'aberta'), true);
  // Proibidas: terminal não reabre; faturado não "desfatura".
  assert.equal(transicaoPermitida('cancelada', 'aberta'), false);
  assert.equal(transicaoPermitida('faturada', 'aberta'), false);
  assert.equal(transicaoPermitida('entregue', 'aberta'), false);
  // Estado inventado é recusado.
  assert.equal(transicaoPermitida('aberta', 'enviado'), false);
  // Terminalidade.
  assert.equal(ehTerminal('cancelada'), true);
  assert.equal(ehTerminal('aberta'), false);
  // Legado desconhecido não bloqueia.
  assert.equal(transicaoPermitida('status_legado_xyz', 'cancelada'), true);
  // Toda chave de STATUS_PEDIDO tem regra declarada.
  for (const st of STATUS_PEDIDO) assert.doesNotThrow(() => validarTransicao(st, st));
});

// ---------------------------------------------------------------------------
// 2. Cada transição real grava UMA linha na trilha.
// ---------------------------------------------------------------------------
test('OMS — cada mudança de estado vira uma linha na trilha, com autor e canal', async () => {
  const { vendaId } = await vendaFaturavel(1, ADMIN);
  const nascimento = await trilha(vendaId);
  assert.equal(nascimento.length, 1, 'o nascimento do pedido já é a primeira prova');
  assert.deepEqual([nascimento[0].status_anterior, nascimento[0].status_novo], [null, 'aberta']);

  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, ADMIN);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'entregue' }, ADMIN);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'cancelada' }, ADMIN);

  const linhas = await trilha(vendaId);
  assert.equal(linhas.length, 4, 'nascimento + três transições → quatro provas');
  assert.deepEqual(linhas.map((l) => [l.status_anterior, l.status_novo]), [
    [null, 'aberta'],
    ['aberta', 'faturada'],
    ['faturada', 'entregue'],
    ['entregue', 'cancelada'],
  ]);
  for (const l of linhas) {
    assert.equal(Number(l.empresa_id), 1, 'a trilha carrega a empresa');
    assert.equal(Number(l.venda_id), vendaId);
    assert.equal(String(l.origem), 'erp', 'mudança pela tela nasce com origem erp');
    assert.equal(Number(l.usuario_id), ADMIN.id, 'a prova guarda quem fez');
    assert.ok(l.criado_em, 'a prova é cronológica');
  }
});

// ---------------------------------------------------------------------------
// 3. Idempotência: editar sem mudar o estado não grava nada.
// ---------------------------------------------------------------------------
test('OMS — editar o pedido sem mudar o estado NÃO duplica a trilha', async () => {
  const { vendaId } = await vendaFaturavel(1, ADMIN);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, ADMIN);
  const antes = await trilha(vendaId);
  assert.equal(antes.length, 2, 'nascimento + faturamento');
  // Edição que NÃO toca o status (observações).
  await updateRecord(RESOURCES.vendas, vendaId, { observacoes: 'Cliente pediu embalagem para presente.' }, ADMIN);
  assert.equal((await trilha(vendaId)).length, 2, 'sem mudança de estado, sem nova prova');
});

// ---------------------------------------------------------------------------
// 4. Transição proibida é recusada na ORIGEM (não só na tela).
// ---------------------------------------------------------------------------
test('OMS — reabrir venda cancelada e "desfaturar" devolvem 409 na origem', async () => {
  const { vendaId } = await vendaFaturavel(1, ADMIN);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'cancelada' }, ADMIN);

  const err = await esperarErro(() => updateRecord(RESOURCES.vendas, vendaId, { status: 'aberta' }, ADMIN), 409, /não pode ser reaberto/i);
  assert.ok(err instanceof HttpError);
  assert.equal(String((await s.get(RESOURCES.vendas, vendaId))!.status), 'cancelada', 'o estado não mudou');

  // "Desfaturar": faturada → aberta é proibido.
  const { vendaId: v2 } = await vendaFaturavel(1, ADMIN);
  await updateRecord(RESOURCES.vendas, v2, { status: 'faturada' }, ADMIN);
  await esperarErro(() => updateRecord(RESOURCES.vendas, v2, { status: 'aberta' }, ADMIN), 409, /faturado não pode voltar|não pode ser reaberto/i);
  assert.equal(String((await s.get(RESOURCES.vendas, v2))!.status), 'faturada');
});

// ---------------------------------------------------------------------------
// 5. Estado inventado é recusado.
// ---------------------------------------------------------------------------
test('OMS — estado fora do grafo é recusado', async () => {
  const { vendaId } = await vendaFaturavel(1, ADMIN);
  // O valor precisa passar pelo schema do recurso (select). Um estado fora do
  // catálogo é recusado ANTES de chegar à máquina de estados.
  await esperarErro(() => updateRecord(RESOURCES.vendas, vendaId, { status: 'enviado' }, ADMIN), 400, /Opção inválida/i);
});

// ---------------------------------------------------------------------------
// 6. Isolamento multiempresa: a trilha não cruza empresa.
// ---------------------------------------------------------------------------
test('OMS — a trilha do pedido é isolada por empresa', async () => {
  const empresaB = 900 + (seq++);
  await s.insert(RESOURCES.empresas, { id: empresaB, nome: `Empresa OMS ${empresaB}` }).catch(() => undefined);
  const atorB = await criarAtor(empresaB, 'gerente');
  const { vendaId } = await vendaFaturavel(empresaB, atorB);
  await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, atorB);

  const linhas = await trilha(vendaId);
  assert.equal(linhas.length, 2, 'nascimento + faturamento');
  for (const l of linhas) assert.equal(Number(l.empresa_id), empresaB, 'a prova nasce na empresa do pedido');

  // A empresa A (ator admin da empresa 1) não enxerga a trilha do pedido da B:
  // a rota responde 404 antes de qualquer linha.
  const { resFake } = await import('./_p1util');
  const { res: fake } = resFake();
  await assert.rejects(
    () => historicoStatusVenda(reqDe({}, { params: { id: vendaId }, user: ADMIN }), fake),
    (e: any) => e?.status === 404
  );

  // O dono da trilha enxerga — e a resposta não devolve nada de outra empresa.
  const { res: fakeB, saida } = resFake();
  await historicoStatusVenda(reqDe({}, { params: { id: vendaId }, user: atorB }), fakeB);
  assert.ok(Array.isArray(saida.json), 'a rota devolve a trilha do dono');
  for (const l of saida.json) assert.equal(Number(l.empresa_id), empresaB);
});
