// ============================================================================
// FASE 2 — NÚCLEO CANÔNICO DE DADOS (autoridade de preço e de disponibilidade).
//
// Prova, contra o código REAL (não por regex), as decisões consolidadas:
//
//   1. AUTORIDADE DE PREÇO (ADR-0006): RETAIL usa `produtos.preco_venda`;
//      WHOLESALE usa `produtos.preco_atacado`. Cada loja tem o SEU preço e o
//      preço recebido de fora NÃO sobrepõe a autoridade do ERP.
//   2. DISPONIBILIDADE CANÔNICA (ADR-0003): `disponível = físico − reservas
//      ativas`, respeitando EMPRESA + PRODUTO + TAMANHO + LOCAL. Reserva sem
//      local desconta de QUALQUER local candidato (conservador). Nunca negativo.
//   3. ISOLAMENTO: reserva/estoque da empresa A não altera a disponibilidade
//      da empresa B (mesmo produto, mesmo tamanho).
//
// Memória (sem PostgreSQL). A prova com IDs reais e concorrência fica em
// test/pg (npm run test:pg).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const { saldoDisponivelCelula, reservadoDaCelula, reservasAtivasPorCelula, saldoVendavel, reservadoDoProduto } = await import('../src/estoqueCanonico');
const { precoDaLoja, minimoAtacado, validarPrecoPublicavel } = await import('../src/commerce/woocommerce/precos');
const { novoProduto, novoLocal, novoTamanho } = await import('./_p1util');

const s = getStore();

async function celula(produtoId: number, tamanhoId: number, localId: number, empresaId: number, quantidade: number) {
  const local = await s.get(RESOURCES.locais, localId);
  return s.insert(RESOURCES.estoques, {
    empresa_id: empresaId,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local_id: localId,
    local: String(local?.nome ?? 'local'),
    quantidade,
    custo_medio: 40,
  });
}

async function reserva(empresaId: number, produtoId: number, tamanhoId: number | null, localId: number | null, quantidade: number, tipo = 'reserva') {
  return s.insert(RESOURCES.estoque_reservas, {
    empresa_id: empresaId,
    produto_id: produtoId,
    tamanho_id: tamanhoId,
    local_id: localId,
    tipo,
    quantidade,
    status: 'ativa',
  });
}

// --- 1. AUTORIDADE DE PREÇO ------------------------------------------------
test('preço: RETAIL usa preco_venda e WHOLESALE usa preco_atacado', () => {
  const produto = { preco_venda: 100, preco_atacado: 60 } as any;
  assert.equal(precoDaLoja(produto, 'RETAIL').preco, 100);
  assert.equal(precoDaLoja(produto, 'RETAIL').fonte, 'preco_venda');
  assert.equal(precoDaLoja(produto, 'WHOLESALE').preco, 60);
  assert.equal(precoDaLoja(produto, 'WHOLESALE').fonte, 'preco_atacado');
});

test('preço: overrides de loja respeitam a vigência do commerce_precos sobre a base', () => {
  const produto = { preco_venda: 100, preco_atacado: 60 } as any;
  const linha = { preco: 90, preco_promo: null, vigencia_inicio: null, vigencia_fim: null };
  // Linha de canal vigente vence a base; a FONTE continua sendo a da loja.
  assert.equal(precoDaLoja(produto, 'RETAIL', linha).preco, 90);
  assert.equal(precoDaLoja(produto, 'RETAIL', linha).fonte, 'preco_venda');
});

test('preço: preço de atacado ausente/zero NÃO é publicado (evidência, não autoridade)', () => {
  const produto = { preco_venda: 100, preco_atacado: 0, atacado_min_qtd: 0 } as any;
  const preco = precoDaLoja(produto, 'WHOLESALE');
  assert.ok(validarPrecoPublicavel(preco, produto, 'WHOLESALE'), 'atacado zero deve ser recusado');
  // O mínimo de atacado vem do cadastro (produtos), não do payload externo.
  assert.equal(minimoAtacado({ atacado_min_qtd: 12 } as any), 12);
});

// --- 2. DISPONIBILIDADE CANÔNICA -------------------------------------------
test('disponível = físico − reservas ativas, na célula (empresa, produto, tamanho, local)', async () => {
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('M');
  const local = await novoLocal('disp-loja', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 10);

  const escopo = escopoDeSistema(1);
  const antes = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(local.id));
  assert.deepEqual(antes, { fisico: 10, reservado: 0, disponivel: 10 });

  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 4, 'reserva');
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 2, 'empenho');
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 1, 'bloqueio');

  const depois = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(local.id));
  assert.equal(depois.fisico, 10);
  assert.equal(depois.reservado, 7);
  assert.equal(depois.disponivel, 3);
});

test('disponível nunca é negativo (bloqueio maior que o físico ⇒ 0)', async () => {
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('G');
  const local = await novoLocal('disp-neg', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 2);
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 5, 'bloqueio');

  const r = await saldoDisponivelCelula(escopoDeSistema(1), Number(produto.id), Number(tam.id), Number(local.id));
  assert.equal(r.disponivel, 0);
});

test('reserva SEM local desconta de qualquer local candidato (conservador)', async () => {
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('P');
  const localA = await novoLocal('disp-semlocal-a', 1, true);
  const localB = await novoLocal('disp-semlocal-b', 1, false);
  await celula(Number(produto.id), Number(tam.id), Number(localA.id), 1, 8);
  await celula(Number(produto.id), Number(tam.id), Number(localB.id), 1, 8);
  await reserva(1, Number(produto.id), Number(tam.id), null, 3, 'reserva'); // sem local

  const escopo = escopoDeSistema(1);
  const a = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(localA.id));
  const b = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(localB.id));
  assert.equal(a.disponivel, 5);
  assert.equal(b.disponivel, 5);

  const reservas = await reservasAtivasPorCelula(escopo, { produtoId: Number(produto.id) });
  assert.equal(reservadoDaCelula(reservas, Number(produto.id), Number(tam.id), Number(localA.id)), 3);
});

test('reserva LIBERADA não desconta (só status ativa conta)', async () => {
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('XG');
  const local = await novoLocal('disp-liberada', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 6);
  await s.insert(RESOURCES.estoque_reservas, {
    empresa_id: 1, produto_id: Number(produto.id), tamanho_id: Number(tam.id), local_id: Number(local.id),
    tipo: 'reserva', quantidade: 6, status: 'liberada',
  });

  const r = await saldoDisponivelCelula(escopoDeSistema(1), Number(produto.id), Number(tam.id), Number(local.id));
  assert.equal(r.disponivel, 6);
});

test('os QUATRO componentes entram uma única vez (sem dupla dedução)', async () => {
  // Físico 30 − reserva 5 − empenho 4 − bloqueio 3 = 18. Se qualquer componente
  // fosse descontado duas vezes (ex.: empenho contado como reserva também), o
  // resultado seria menor; se um fosse ignorado, seria maior. 18 é o único valor
  // correto — trava a regra `físico − reservas − compromissos − bloqueios`.
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('40');
  const local = await novoLocal('disp-quatro', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 30);
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 5, 'reserva');
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 4, 'empenho');
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 3, 'bloqueio');

  const r = await saldoDisponivelCelula(escopoDeSistema(1), Number(produto.id), Number(tam.id), Number(local.id));
  assert.deepEqual(r, { fisico: 30, reservado: 12, disponivel: 18 });
});

test('tipo desconhecido conta como reserva (fail-safe: nunca vira crédito)', async () => {
  // Um `tipo` fora de {reserva,empenho,bloqueio} não pode ser IGNORADO — ignorar
  // liberaria saldo comprometido. O motor soma como compromisso.
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('42');
  const local = await novoLocal('disp-tipo-extra', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 10);
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 6, 'separacao_manual');

  const r = await saldoDisponivelCelula(escopoDeSistema(1), Number(produto.id), Number(tam.id), Number(local.id));
  assert.equal(r.disponivel, 4, 'compromisso de tipo desconhecido precisa descontar');
});

test('reserva com quantidade ≤ 0 é ignorada (não gera crédito)', async () => {
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('44');
  const local = await novoLocal('disp-qtd-zero', 1, true);
  await celula(Number(produto.id), Number(tam.id), Number(local.id), 1, 5);
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), 0, 'reserva');
  await reserva(1, Number(produto.id), Number(tam.id), Number(local.id), -3, 'bloqueio');

  const r = await saldoDisponivelCelula(escopoDeSistema(1), Number(produto.id), Number(tam.id), Number(local.id));
  assert.equal(r.disponivel, 5, 'quantidade ≤ 0 não pode aumentar o disponível');
});

test('reserva/empenho/bloqueio descontam 1× na célula e 1× no total do produto', async () => {
  // Prova a ausência de dupla contagem: `reservadoDaCelula` (usado pela
  // disponibilidade) e `reservadoDoProduto` (exibido como "Reservado") leem o
  // MESMO agregado. Uma reserva sem local aparece uma vez em cada leitura,
  // nunca duas — e a célula exata e a sem-local somam uma única vez.
  const produto = await novoProduto({ preco_venda: 10 });
  const tam = await novoTamanho('46');
  const localA = await novoLocal('disp-dup-a', 1, false);
  const localB = await novoLocal('disp-dup-b', 1, false);
  await celula(Number(produto.id), Number(tam.id), Number(localA.id), 1, 10);
  await celula(Number(produto.id), Number(tam.id), Number(localB.id), 1, 10);
  await reserva(1, Number(produto.id), Number(tam.id), Number(localA.id), 2, 'reserva'); // célula A
  await reserva(1, Number(produto.id), Number(tam.id), null, 3, 'empenho');             // sem local

  const escopo = escopoDeSistema(1);
  const reservas = await reservasAtivasPorCelula(escopo, { produtoId: Number(produto.id) });
  assert.equal(reservadoDaCelula(reservas, Number(produto.id), Number(tam.id), Number(localA.id)), 5, '2 (célula) + 3 (sem local)');
  assert.equal(reservadoDaCelula(reservas, Number(produto.id), Number(tam.id), Number(localB.id)), 3, 'só o sem-local');
  assert.equal(reservadoDoProduto(reservas, Number(produto.id), Number(tam.id)), 5, 'total contado uma única vez');

  const a = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(localA.id));
  const b = await saldoDisponivelCelula(escopo, Number(produto.id), Number(tam.id), Number(localB.id));
  assert.equal(a.disponivel, 5, 'A: 10 − (2 + 3)');
  assert.equal(b.disponivel, 7, 'B: 10 − 3');
});

// --- 3. ISOLAMENTO ----------------------------------------------------------
test('saldoVendavel devolve a MAIOR célula disponível entre os locais de saída', async () => {
  // O faturamento debita o local de saída e, se não cobrir, o Local padrão. A
  // tela não pode prometer mais do que isso: a quantidade vendável é o MAIOR
  // disponível entre os candidatos — nunca a soma dos locais.
  // Empresa 3 isolada: o Local padrão é único nesta empresa.
  const produto = await novoProduto({ preco_venda: 10, empresa_id: 3 });
  const tam = await novoTamanho('48');
  const localA = await novoLocal('vend-pref', 3, false);
  const localB = await novoLocal('vend-padrao', 3, true); // Local padrão (2º candidato)
  await celula(Number(produto.id), Number(tam.id), Number(localA.id), 3, 3);
  await celula(Number(produto.id), Number(tam.id), Number(localB.id), 3, 9);
  await reserva(3, Number(produto.id), Number(tam.id), Number(localB.id), 2, 'reserva');

  const v = await saldoVendavel(escopoDeSistema(3), Number(produto.id), Number(tam.id), Number(localA.id));
  assert.equal(v.quantidade, 7, 'maior célula: B = 9 − 2');
  assert.equal(v.local_id, Number(localB.id), 'a quantidade sai do Local padrão, não da soma');
  assert.equal(v.fisico, 12, 'físico total é apenas informativo');
});

// --- 4. ISOLAMENTO ----------------------------------------------------------
test('isolamento: reserva da empresa A não afeta a disponibilidade da empresa B', async () => {
  const produtoA = await novoProduto({ preco_venda: 10, empresa_id: 1 });
  const produtoB = await novoProduto({ preco_venda: 10, empresa_id: 2 });
  const tam = await novoTamanho('U');
  const localA = await novoLocal('disp-iso-a', 1, true);
  const localB = await novoLocal('disp-iso-b', 2, true);
  await celula(Number(produtoA.id), Number(tam.id), Number(localA.id), 1, 10);
  await celula(Number(produtoB.id), Number(tam.id), Number(localB.id), 2, 10);

  await reserva(1, Number(produtoA.id), Number(tam.id), Number(localA.id), 7, 'reserva');

  const a = await saldoDisponivelCelula(escopoDeSistema(1), Number(produtoA.id), Number(tam.id), Number(localA.id));
  const b = await saldoDisponivelCelula(escopoDeSistema(2), Number(produtoB.id), Number(tam.id), Number(localB.id));
  assert.equal(a.disponivel, 3, 'empresa A: 10 − 7');
  assert.equal(b.disponivel, 10, 'empresa B intacta');

  // A reserva de A não aparece no agregado de B.
  const reservasB = await reservasAtivasPorCelula(escopoDeSistema(2), { produtoId: Number(produtoB.id) });
  assert.equal(reservadoDaCelula(reservasB, Number(produtoB.id), Number(tam.id), Number(localB.id)), 0);
});
