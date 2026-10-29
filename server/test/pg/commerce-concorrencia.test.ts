// ============================================================================
// BROBOND COMMERCE OS — 12 CENÁRIOS DE CONCORRÊNCIA EM POSTGRESQL REAL
// ----------------------------------------------------------------------------
// O que só se prova aqui (o MemStore não tem índice único parcial, CAS com
// UPDATE … WHERE, isolamento SERIALIZABLE nem corrida de verdade):
//
//   01. enfileirarPublicacao ×8 simultâneas → 1 linha (idempotência por
//       empresa+produto+canal+versão; 23505 vira a linha vencedora, nunca 500);
//   02. claim da fila: 6 processarPublicacao na MESMA linha → exatamente 1
//       publica (tryUpdateIf QUEUED→PUBLISHING), tentativas = 1;
//   03. índice único de versão: dois INSERTs paralelos da mesma versão →
//       exatamente um 23505;
//   04. último cupom (uso_maximo=1) ×6 transações → exatamente 1 consome,
//       uso_atual = 1, os demais recebem 409/40001;
//   05. última peça ×6 checkouts SERIALIZABLE → exatamente 1 reserva ativa,
//       disponibilidade nunca negativa;
//   06. mesmo checkout ×6 → o índice parcial uq_estoque_reservas_checkout
//       barra a reserva duplicada (1 ativa no total);
//   07. liberarReservaInterna ×6 → CAS: 1 transição real + idempotentes;
//   08. garantirPedidoDaSale ×6 → 1 pedido (unique empresa+canal+externo);
//   09. expirarCheckoutsPendentes ×4 → cada candidato expira UMA vez
//       (Σ = nº de candidatos), reservas liberadas e sales CANCELLED;
//   10. processarOutbox ×4 → cada entrada processada UMA vez (tentativas = 1);
//   11. preço por canal ×6 INSERTs paralelos → 1 linha (unique empresa+produto+canal);
//   12. expiração × pagamento simultâneos → NUNCA estado misto
//       (PAGO+CANCELLED / EXPIRADO+PAID são proibidos; 40001 é o perdedor
//       legítimo do SSI).
//
// Sem DATABASE_URL o arquivo se auto-pula (o gate test:pg exige 0 skips —
// quando o gate roda, DATABASE_URL existe).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (gate test:pg / job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Ator = { id: number; name: string; perfil: 'admin'; empresa_id: number; empresas: number[] };
type Tenant = { empresaId: number; ator: Ator; sufixo: string };

const RODADA = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (p: string) => `${p}-${RODADA}-${++contador}`;

async function novoTenant(): Promise<Tenant> {
  const { query } = await import('../../src/db');
  const sufixo = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const emp = await query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Commerce ${sufixo}`]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id, nome`,
    [`Commerce ${sufixo}`, `commerce-${sufixo.toLowerCase()}@example.test`, empresaId]
  );
  return {
    empresaId,
    sufixo,
    ator: { id: Number(usr.rows[0].id), name: String(usr.rows[0].nome), perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
  };
}

/** Remove TUDO que a fixture criou (ordem por FK; melhor esforço). */
async function limpar(t: Tenant): Promise<void> {
  const { query } = await import('../../src/db');
  const apagar = async (sql: string) => query(sql, [t.empresaId]).catch(() => undefined);
  await apagar(`DELETE FROM commerce_outbox WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_publicacoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_precos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_cupons WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_promocoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_pedidos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM estoque_reservas WHERE empresa_id = $1`);
  await apagar(`DELETE FROM gateway_cobrancas WHERE empresa_id = $1`);
  await apagar(`DELETE FROM sale_items WHERE sale_id IN (SELECT s.id FROM sales s JOIN usuarios u ON u.id = s.usuario_id WHERE u.empresa_id = $1)`);
  await apagar(`DELETE FROM sales WHERE usuario_id IN (SELECT id FROM usuarios WHERE empresa_id = $1)`);
  await apagar(`DELETE FROM estoques WHERE empresa_id = $1`);
  await apagar(`DELETE FROM movimentacoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM commerce_configuracoes WHERE empresa_id = $1`);
  await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
  await apagar(`DELETE FROM locais WHERE empresa_id = $1`);
  await apagar(`DELETE FROM usuarios WHERE empresa_id = $1`);
  await apagar(`DELETE FROM empresas WHERE id = $1`);
}

const eh409 = (e: any) => Number(e?.status) === 409;
const ehSerial = (e: any) => e?.code === '40001' || e?.cause?.code === '40001' || /could not serialize/i.test(String(e?.message || ''));
const ehUnico = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';

function payloadBrobond(sufixo: string) {
  return {
    sku: `SKU-${sufixo}`,
    titulo: `Produto ${sufixo}`,
    resumo: null,
    descricao: 'Descrição real da corrida',
    slug: `produto-${sufixo.toLowerCase()}`,
    preco: 129.9,
    preco_promo: null,
    condicao: 'novo',
    ativo: true,
    destaque: false,
    disponivel: 3,
    metadados: {},
  } as const;
}

// ---------------------------------------------------------------------------
// 01. enfileirarPublicacao ×8 — idempotência por versão sob corrida
// ---------------------------------------------------------------------------
test('01. enfileirarPublicacao ×8 simultâneas → exatamente 1 linha na fila', { skip }, async () => {
  const { migrate } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto } = await import('../_p1util');
  const { enfileirarPublicacao } = await import('../../src/commerce/catalogo');
  const { query } = await import('../../src/db');
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C01-SKU'), empresa_id: t.empresaId });
    const payload = payloadBrobond(t.sufixo);
    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => enfileirarPublicacao(t.empresaId, Number(produto.id), 'BROBOND', payload as any, t.ator.id))
    );
    const ids = new Set(resultados.map((r) => Number(r.id)));
    assert.equal(ids.size, 1, 'todas as 8 chamadas devolvem a MESMA linha vencedora');
    const linhas = await query(
      `SELECT COUNT(*)::int AS n FROM commerce_publicacoes WHERE empresa_id = $1 AND produto_id = $2 AND canal = 'BROBOND'`,
      [t.empresaId, produto.id]
    );
    assert.equal(Number(linhas.rows[0].n), 1, 'uma única linha na fila');
    const estado = await query(`SELECT estado FROM commerce_publicacoes WHERE empresa_id = $1`, [t.empresaId]);
    assert.ok(['QUEUED', 'PUBLISHING', 'PUBLISHED'].includes(String(estado.rows[0].estado)), 'estado no pipeline');
    assert.ok(getStore(), 'store ativo');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 02. claim da fila — 6 varreduras na mesma linha publicam UMA vez
// ---------------------------------------------------------------------------
test('02. processarPublicacao ×6 na mesma linha → exatamente 1 processada, tentativas = 1', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { novoProduto } = await import('../_p1util');
  const { enfileirarPublicacao, processarPublicacao } = await import('../../src/commerce/catalogo');
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C02-SKU'), empresa_id: t.empresaId, ativo: true });
    const linha = await enfileirarPublicacao(t.empresaId, Number(produto.id), 'BROBOND', payloadBrobond(t.sufixo) as any, t.ator.id);
    const resultados = await Promise.all(Array.from({ length: 6 }, () => processarPublicacao({ ...linha })));
    const processadas = resultados.filter((r) => r === 'processada').length;
    assert.equal(processadas, 1, 'só UMA varredura reivindica e publica');
    assert.equal(resultados.filter((r) => r === 'ignorada').length, 5, 'as demais veem a linha tomada');
    const pos = await query(`SELECT estado, tentativas, external_id FROM commerce_publicacoes WHERE id = $1`, [linha.id]);
    assert.equal(String(pos.rows[0].estado), 'PUBLISHED', 'PUBLISHED só após confirmação (BROBOND é local)');
    assert.equal(Number(pos.rows[0].tentativas), 1, 'publicou exatamente uma vez');
    assert.equal(String(pos.rows[0].external_id), `produto-${t.sufixo.toLowerCase()}`, 'external_id = slug real');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 03. índice único de versão — dois INSERTs paralelos, um 23505
// ---------------------------------------------------------------------------
test('03. mesmo (empresa, produto, canal, versão) paralelo → exatamente 1 INSERT vence', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { novoProduto } = await import('../_p1util');
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C03-SKU'), empresa_id: t.empresaId });
    const insert = () =>
      query(
        `INSERT INTO commerce_publicacoes (empresa_id, produto_id, canal, versao, estado, payload, payload_hash, tentativas, proxima_tentativa_em, criado_por)
         VALUES ($1, $2, 'BROBOND', 1, 'QUEUED', '{}'::jsonb, 'hash-corrida', 0, now(), $3) RETURNING id`,
        [t.empresaId, produto.id, t.ator.id]
      );
    const resultados = await Promise.allSettled([insert(), insert()]);
    const sucessos = resultados.filter((r) => r.status === 'fulfilled').length;
    const falhas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(sucessos, 1, 'exatamente um INSERT entra');
    assert.equal(falhas.length, 1, 'exatamente um é recusado');
    assert.ok(ehUnico((falhas[0] as PromiseRejectedResult).reason), 'a recusa é unique_violation (23505)');
    const n = await query(`SELECT COUNT(*)::int AS n FROM commerce_publicacoes WHERE empresa_id = $1`, [t.empresaId]);
    assert.equal(Number(n.rows[0].n), 1);
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 04. último cupom — CAS de uso sob 6 transações paralelas
// ---------------------------------------------------------------------------
test('04. cupom uso_maximo=1 ×6 transações → exatamente 1 consome (uso_atual = 1)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { getResource } = await import('../../src/resources');
  const { consumirUsoCupom } = await import('../../src/commerce/promocoes');
  const t = await novoTenant();
  try {
    const s = getStore();
    const cupom = await s.insert(getResource('commerce_cupons')!, {
      empresa_id: t.empresaId,
      codigo: `CORRIDA${t.sufixo}`,
      tipo: 'percentual',
      valor: 10,
      minimo_pedido: 0,
      ativo: true,
      uso_maximo: 1,
      uso_atual: 0,
      criado_por: t.ator.id,
    } as any);
    const corridas = await Promise.allSettled(
      Array.from({ length: 6 }, () => s.transaction((tx) => consumirUsoCupom(t.empresaId, `CORRIDA${t.sufixo}`, 200, tx)))
    );
    const sucessos = corridas.filter((r) => r.status === 'fulfilled').length;
    assert.equal(sucessos, 1, 'só o primeiro checkout consome o último uso');
    for (const r of corridas) {
      if (r.status === 'rejected') {
        const e = (r as PromiseRejectedResult).reason;
        assert.ok(eh409(e) || ehSerial(e), `perdedor recebe 409 ou 40001, veio: ${e?.status ?? e?.code} ${e?.message}`);
      }
    }
    const pos = await query(`SELECT uso_atual FROM commerce_cupons WHERE id = $1`, [cupom.id]);
    assert.equal(Number(pos.rows[0].uso_atual), 1, 'uso_atual exatamente 1 — nunca 2 nem 0');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 05. última peça — 6 reservas SERIALIZABLE disputam o saldo 1
// ---------------------------------------------------------------------------
test('05. última peça ×6 reservas simultâneas → exatamente 1 ativa, disponibilidade ≥ 0', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const { escopoDeSistema } = await import('../../src/empresa');
  const { criarReservaInterna } = await import('../../src/estoqueTransferencia');
  const t = await novoTenant();
  try {
    const s = getStore();
    const produto = await novoProduto({ sku: unico('C05-SKU'), empresa_id: t.empresaId });
    await saldoInicial(produto, 1);
    const escopo = escopoDeSistema(t.empresaId);
    const corridas = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        s.transaction((tx) =>
          criarReservaInterna(
            escopo,
            { produto_id: Number(produto.id), quantidade: 1, tipo: 'reserva', origem_recurso: 'commerce_checkout', origem_id: 700000 + i, criado_por: t.ator.id },
            tx
          )
        )
      )
    );
    const sucessos = corridas.filter((r) => r.status === 'fulfilled').length;
    assert.equal(sucessos, 1, 'só uma reserva passa; as outras recusam por saldo ou SSI');
    for (const r of corridas) {
      if (r.status === 'rejected') {
        const e = (r as PromiseRejectedResult).reason;
        assert.ok(eh409(e) || ehSerial(e), `perdedor: 409 (saldo) ou 40001 (SSI); veio ${e?.status ?? e?.code}`);
      }
    }
    const ativas = await query(
      `SELECT COUNT(*)::int AS n FROM estoque_reservas WHERE empresa_id = $1 AND origem_recurso = 'commerce_checkout' AND status = 'ativa'`,
      [t.empresaId]
    );
    assert.equal(Number(ativas.rows[0].n), 1, 'exatamente 1 reserva ativa');
    const est = await query(`SELECT quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2`, [t.empresaId, produto.id]);
    const fisico = Number(est.rows[0]?.quantidade ?? 0);
    const reservado = 1;
    assert.ok(fisico - reservado >= 0, 'físico − reservado nunca negativo');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 06. mesmo checkout — índice parcial barra reserva duplicada
// ---------------------------------------------------------------------------
test('06. mesmo checkout ×6 → uq_estoque_reservas_checkout deixa 1 reserva ativa', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const { escopoDeSistema } = await import('../../src/empresa');
  const { criarReservaInterna } = await import('../../src/estoqueTransferencia');
  const t = await novoTenant();
  try {
    const s = getStore();
    const produto = await novoProduto({ sku: unico('C06-SKU'), empresa_id: t.empresaId });
    await saldoInicial(produto, 6);
    const escopo = escopoDeSistema(t.empresaId);
    const pedidoFake = 610000 + (contador % 1000);
    const corridas = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        s.transaction((tx) =>
          criarReservaInterna(
            escopo,
            { produto_id: Number(produto.id), quantidade: 1, tipo: 'reserva', origem_recurso: 'commerce_checkout', origem_id: pedidoFake, criado_por: t.ator.id },
            tx
          )
        )
      )
    );
    const sucessos = corridas.filter((r) => r.status === 'fulfilled').length;
    assert.equal(sucessos, 1, 'a segunda reserva do MESMO checkout morre no índice parcial (ou SSI)');
    for (const r of corridas) {
      if (r.status === 'rejected') {
        const e = (r as PromiseRejectedResult).reason;
        assert.ok(ehUnico(e) || ehSerial(e) || eh409(e), `perdedor: 23505/40001/409; veio ${e?.code ?? e?.status}`);
      }
    }
    const ativas = await query(
      `SELECT COUNT(*)::int AS n FROM estoque_reservas WHERE empresa_id = $1 AND origem_id = $2 AND status = 'ativa'`,
      [t.empresaId, pedidoFake]
    );
    assert.equal(Number(ativas.rows[0].n), 1, 'nunca duas reservas ativas para o mesmo checkout+produto');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 07. liberar ×6 — CAS: uma transição real, as outras idempotentes
// ---------------------------------------------------------------------------
test('07. liberarReservaInterna ×6 → 1 transição real, demais idempotentes, estoque intacto', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const { escopoDeSistema } = await import('../../src/empresa');
  const { criarReservaInterna, liberarReservaInterna } = await import('../../src/estoqueTransferencia');
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C07-SKU'), empresa_id: t.empresaId });
    await saldoInicial(produto, 3);
    const escopo = escopoDeSistema(t.empresaId);
    const reserva = await criarReservaInterna(escopo, {
      produto_id: Number(produto.id),
      quantidade: 2,
      tipo: 'reserva',
      origem_recurso: 'commerce_checkout',
      origem_id: 710000 + (contador % 1000),
      criado_por: t.ator.id,
    });
    const resultados = await Promise.all(
      Array.from({ length: 6 }, () => liberarReservaInterna(escopo, Number(reserva.id)))
    );
    assert.equal(resultados.length, 6, 'nenhuma liberação explode (CAS vira idempotente)');
    const idempotentes = resultados.filter((r: any) => r.idempotente === true).length;
    assert.ok(idempotentes >= 1, 'há perdedores marcados idempotentes');
    const pos = await query(`SELECT status FROM estoque_reservas WHERE id = $1`, [reserva.id]);
    assert.equal(String(pos.rows[0].status), 'liberada', 'estado final único: liberada');
    const est = await query(`SELECT quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2`, [t.empresaId, produto.id]);
    assert.equal(Number(est.rows[0].quantidade), 3, 'liberar NÃO mexe no físico (só o hold)');
    assert.ok(getStore());
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 08. garantirPedidoDaSale ×6 — projeção idempotente por pedido externo
// ---------------------------------------------------------------------------
test('08. garantirPedidoDaSale ×6 → exatamente 1 pedido para a sale', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { garantirPedidoDaSale } = await import('../../src/commerce/pedidos');
  const t = await novoTenant();
  try {
    const saleId = `sale-${t.sufixo}`;
    const externo = `ML-${t.sufixo}`;
    await query(
      `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, channel, external_order_id, usuario_id, empresa_id)
       VALUES ($1, $1, 1, 5000, 'BRL', 'PAID', 'MERCADOLIVRE', $2, $3, $4)`,
      [saleId, externo, t.ator.id, t.empresaId]
    );
    const sale = (await query(`SELECT * FROM sales WHERE id = $1`, [saleId])).rows[0];
    const resultados = await Promise.all(Array.from({ length: 6 }, () => garantirPedidoDaSale(t.empresaId, sale as any)));
    const ids = new Set(resultados.map((r) => Number(r.id)));
    assert.equal(ids.size, 1, 'todas as 6 rotas apontam para o MESMO pedido');
    const n = await query(`SELECT COUNT(*)::int AS n FROM commerce_pedidos WHERE empresa_id = $1`, [t.empresaId]);
    assert.equal(Number(n.rows[0].n), 1, 'uma projeção por pedido externo');
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 09. expiração ×4 — cada candidato expira UMA vez (CAS por linha)
// ---------------------------------------------------------------------------
test('09. expirarCheckoutsPendentes ×4 → Σ expirados = candidatos, reservas e sales liberados', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const { escopoDeSistema } = await import('../../src/empresa');
  const { criarReservaInterna } = await import('../../src/estoqueTransferencia');
  const { expirarCheckoutsPendentes, ORIGEM_CHECKOUT } = await import('../../src/commerce/pedidos');
  const t = await novoTenant();
  const CANDIDATOS = 5;
  try {
    const produto = await novoProduto({ sku: unico('C09-SKU'), empresa_id: t.empresaId });
    await saldoInicial(produto, CANDIDATOS);
    const escopo = escopoDeSistema(t.empresaId);
    for (let i = 0; i < CANDIDATOS; i += 1) {
      const saleId = `sale-exp-${t.sufixo}-${i}`;
      await query(
        `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, channel, external_order_id, usuario_id, empresa_id)
         VALUES ($1, $1, 1, 1000, 'BRL', 'PENDING', 'BROBOND', $2, $3, $4)`,
        [saleId, `EXP-${t.sufixo}-${i}`, t.ator.id, t.empresaId]
      );
      const pedido = await query(
        `INSERT INTO commerce_pedidos (empresa_id, canal, pedido_externo, sale_id, estado, expira_em, total)
         VALUES ($1, 'BROBOND', $2, $3, 'AGUARDANDO_PAGAMENTO', now() - interval '5 minutes', 10.00) RETURNING id`,
        [t.empresaId, `EXPX-${t.sufixo}-${i}`, saleId]
      );
      await criarReservaInterna(escopo, {
        produto_id: Number(produto.id),
        quantidade: 1,
        tipo: 'reserva',
        origem_recurso: ORIGEM_CHECKOUT,
        origem_id: Number(pedido.rows[0].id),
        criado_por: t.ator.id,
      });
    }
    const corridas = await Promise.all(Array.from({ length: 4 }, () => expirarCheckoutsPendentes()));
    const soma = corridas.reduce((a, b) => a + b, 0);
    assert.equal(soma, CANDIDATOS, `4 varreduras expiram cada candidato UMA vez (Σ=${soma})`);
    const estados = await query(`SELECT estado, COUNT(*)::int AS n FROM commerce_pedidos WHERE empresa_id = $1 GROUP BY estado`, [t.empresaId]);
    assert.equal(estados.rows.length, 1);
    assert.equal(String(estados.rows[0].estado), 'EXPIRADO');
    assert.equal(Number(estados.rows[0].n), CANDIDATOS);
    const ativas = await query(
      `SELECT COUNT(*)::int AS n FROM estoque_reservas WHERE empresa_id = $1 AND origem_recurso = $2 AND status = 'ativa'`,
      [t.empresaId, ORIGEM_CHECKOUT]
    );
    assert.equal(Number(ativas.rows[0].n), 0, 'expiração devolve TODAS as peças');
    const vendas = await query(
      `SELECT COUNT(*)::int AS n FROM sales s JOIN usuarios u ON u.id = s.usuario_id WHERE u.empresa_id = $1 AND s.status = 'CANCELLED'`,
      [t.empresaId]
    );
    assert.equal(Number(vendas.rows[0].n), CANDIDATOS, 'sale analítica nunca some — vira CANCELLED');
    assert.ok(getStore());
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 10. outbox ×4 — cada entrada processada UMA vez
// ---------------------------------------------------------------------------
test('10. processarOutbox ×4 → cada entrada com tentativas = 1 e PROCESSADO', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { processarOutbox } = await import('../../src/commerce/outbox');
  const t = await novoTenant();
  const N = 6;
  try {
    for (let i = 0; i < N; i += 1) {
      await query(
        `INSERT INTO commerce_outbox (empresa_id, tipo, chave, payload, estado, tentativas) VALUES ($1, 'alerta', $2, '{}'::jsonb, 'PENDENTE', 0)`,
        [t.empresaId, `alerta:${t.sufixo}:${i}`]
      );
    }
    const corridas = await Promise.all(Array.from({ length: 4 }, () => processarOutbox(20)));
    const processados = corridas.reduce((a, r) => a + r.processados, 0);
    assert.equal(processados, N, 'cada entrada contada como processada EXATAMENTE uma vez entre as 4 corridas');
    const linhas = await query(`SELECT estado, tentativas FROM commerce_outbox WHERE empresa_id = $1`, [t.empresaId]);
    assert.equal(linhas.rows.length, N);
    for (const r of linhas.rows) {
      assert.equal(String(r.estado), 'PROCESSADO', 'claim CAS → PROCESSADO');
      assert.equal(Number(r.tentativas), 1, 'nunca duplo-claim (tentativas = 1)');
    }
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 11. preço por canal ×6 — unique (empresa, produto, canal)
// ---------------------------------------------------------------------------
test('11. INSERT paralelo de preço do mesmo canal → exatamente 1 linha (23505 no resto)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { novoProduto } = await import('../_p1util');
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C11-SKU'), empresa_id: t.empresaId });
    const insert = (preco: number) =>
      query(`INSERT INTO commerce_precos (empresa_id, produto_id, canal, preco) VALUES ($1, $2, 'BROBOND', $3) RETURNING id`, [
        t.empresaId,
        produto.id,
        preco,
      ]);
    const corridas = await Promise.allSettled([insert(99.9), insert(109.9), insert(119.9), insert(129.9), insert(139.9), insert(149.9)]);
    const sucessos = corridas.filter((r) => r.status === 'fulfilled').length;
    assert.equal(sucessos, 1, 'exatamente 1 preço por canal');
    for (const r of corridas) {
      if (r.status === 'rejected') assert.ok(ehUnico((r as PromiseRejectedResult).reason), 'perdedor é 23505');
    }
    const n = await query(`SELECT COUNT(*)::int AS n FROM commerce_precos WHERE empresa_id = $1`, [t.empresaId]);
    assert.equal(Number(n.rows[0].n), 1);
  } finally {
    await limpar(t);
  }
});

// ---------------------------------------------------------------------------
// 12. expiração × pagamento — corrida crítica nunca deixa estado misto
// ---------------------------------------------------------------------------
test('12. expiração × pagamento simultâneos → nunca PAGO+CANCELLED nem EXPIRADO+PAID', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { getStore } = await import('../../src/services');
  const { novoProduto, saldoInicial } = await import('../_p1util');
  const { escopoDeSistema } = await import('../../src/empresa');
  const { criarReservaInterna } = await import('../../src/estoqueTransferencia');
  const { expirarCheckoutsPendentes, confirmarPagamentoCobranca, ORIGEM_CHECKOUT } = await import('../../src/commerce/pedidos');
  const RODADAS = 3;
  const t = await novoTenant();
  try {
    const produto = await novoProduto({ sku: unico('C12-SKU'), empresa_id: t.empresaId });
    await saldoInicial(produto, RODADAS);
    const escopo = escopoDeSistema(t.empresaId);
    for (let i = 0; i < RODADAS; i += 1) {
      const saleId = `sale-race-${t.sufixo}-${i}`;
      await query(
        `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, channel, external_order_id, usuario_id, empresa_id)
         VALUES ($1, $1, 1, 9990, 'BRL', 'PENDING', 'BROBOND', $2, $3, $4)`,
        [saleId, `RACE-${t.sufixo}-${i}`, t.ator.id, t.empresaId]
      );
      const cob = await query(
        `INSERT INTO gateway_cobrancas (empresa_id, provider, metodo, valor, status) VALUES ($1, 'mercadopago', 'pix', 99.90, 'paga') RETURNING id`,
        [t.empresaId]
      );
      const pedido = await query(
        `INSERT INTO commerce_pedidos (empresa_id, canal, pedido_externo, sale_id, cobranca_id, estado, expira_em, total)
         VALUES ($1, 'BROBOND', $2, $3, $4, 'AGUARDANDO_PAGAMENTO', now() - interval '5 minutes', 99.90) RETURNING id`,
        [t.empresaId, `RACEP-${t.sufixo}-${i}`, saleId, cob.rows[0].id]
      );
      await criarReservaInterna(escopo, {
        produto_id: Number(produto.id),
        quantidade: 1,
        tipo: 'reserva',
        origem_recurso: ORIGEM_CHECKOUT,
        origem_id: Number(pedido.rows[0].id),
        criado_por: t.ator.id,
      });

      // A CORRIDA: varredura de expiração × webhook de pagamento no MESMO pedido.
      const [exp, pag] = await Promise.allSettled([
        expirarCheckoutsPendentes(),
        confirmarPagamentoCobranca({ cobrancaId: Number(cob.rows[0].id), empresaId: t.empresaId, intencao: 'paga' }),
      ]);
      for (const r of [exp, pag]) {
        if (r.status === 'rejected') {
          const e = (r as PromiseRejectedResult).reason;
          assert.ok(ehSerial(e), `só 40001 (SSI perdedor) pode estourar; veio ${e?.code ?? e?.status}: ${e?.message}`);
        }
      }
      const estado = String((await query(`SELECT estado FROM commerce_pedidos WHERE id = $1`, [pedido.rows[0].id])).rows[0].estado);
      const venda = String(
        (await query(`SELECT s.status FROM sales s WHERE s.id = $1`, [saleId])).rows[0].status
      );
      // Invariantes — o estado misto é proibido em QUALQUER intercalação:
      if (estado === 'EXPIRADO') {
        assert.equal(venda, 'CANCELLED', 'EXPIRADO só com sale CANCELLED');
        const ativas = await query(
          `SELECT COUNT(*)::int AS n FROM estoque_reservas WHERE origem_recurso = $1 AND origem_id = $2 AND status = 'ativa'`,
          [ORIGEM_CHECKOUT, pedido.rows[0].id]
        );
        assert.equal(Number(ativas.rows[0].n), 0, 'expirado devolve a peça');
      } else {
        assert.ok(['PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO'].includes(estado), `ganhou o pagamento em estado válido, veio ${estado}`);
        assert.equal(venda, 'PAID', 'pedido pago com sale PAID — nunca CANCELLED');
      }
    }
  } finally {
    await limpar(t);
  }
});
