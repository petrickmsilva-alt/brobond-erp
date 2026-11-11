// ============================================================================
// REGRESSÃO CANÔNICA DO ESTOQUE NO CHECKOUT — EM POSTGRESQL REAL
// ----------------------------------------------------------------------------
// Prova, contra o SERVIDOR DE VERDADE (HTTP) e o banco real, a regra:
//
//     disponível = físico − reservado − empenhado − bloqueado
//
// e que a BAIXA FÍSICA só acontece na conversão de pagamento aprovado.
//
//   C1. pedido pendente: reserva ativa, físico intacto (8/1/7), 0 vendas, 0 saídas;
//   C2. pagamento aprovado (webhook assinado): reserva consumida, 1 venda,
//       1 saída, físico 7/0/7;
//   C3. cancelado (operador), recusado (webhook) e expirado (varredura real):
//       reserva liberada, 0 venda, 0 saída, físico 8/0/8; repetição idempotente;
//   C4. webhook duplicado (mesmo event_id) e webhook novo do mesmo pagamento:
//       1 conversão, 1 venda, 1 saída;
//   C5. dois pagamentos aprovados e duas conversões em PARALELO: 1 pagamento
//       confirmado, 1 venda, 1 saída, sem 5xx;
//   C6. tenant cruzado: outra empresa não lê, cancela nem converte o pedido,
//       e o estoque/reserva da dona não muda.
//
// Os números impressos (linhas ESTOQUE_REGRESSAO) são os valores OBSERVADOS
// no banco, não os esperados. Nenhum mock de estoque, transação ou conversão:
// o pedido nasce por POST /commerce/checkout (motor interno, autenticado), a cobrança é do provedor de teste
// (mock determinístico só com NODE_ENV=test), o pagamento chega por webhook
// HTTP e a venda/saída são criadas pela ponte canônica.
//
// Sem DATABASE_URL FALHA (não é permitido pular esta prova).
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('estoque-reserva-baixa-regressao.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query, pool } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');
const { cifrarSegredo } = await import('../../src/segredos');
const { processarFilaPublicacoes } = await import('../../src/commerce/catalogo');
const { expirarCheckoutsPendentes } = await import('../../src/commerce/pedidos');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `reg${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 20);
const SUFIXO_EMAIL = `@${RODADA}.estoque-regressao.example.test`;

// ----------------------------------------------------------------- estado da suíte
let child: Child | null = null;
let baseUrl = '';
let logsServidor = () => '';
let empresaA = 0;
let empresaB = 0;
let tokenA = '';
let tokenB = '';
let gerenteAId = 0;
const configsGateway: number[] = [];
const clienteDb = new Client({ connectionString: String(process.env.DATABASE_URL) });

// ----------------------------------------------------------------- harness HTTP
async function reservarPorta(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP para o harness.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function subirServidor(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port), JWT_SECRET: randomUUID() };
  const processo = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  processo.stdout.on('data', append);
  processo.stderr.on('data', append);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (processo.exitCode !== null || processo.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child: processo, baseUrl: base, logs: () => output };
      }
    } catch { /* migrações/health em andamento */ }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

async function pararServidor(processo: Child): Promise<void> {
  if (processo.exitCode !== null || processo.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { processo.kill('SIGKILL'); resolve(); }, 5_000);
    processo.once('exit', () => { clearTimeout(t); resolve(); });
    processo.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(metodo: string, rota: string, corpo?: unknown, token?: string, headers?: Record<string, string>): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json', ...(headers || {}) };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

const msg = (r: Resposta) => `${r.status} ${r.texto.slice(0, 200)}`;

async function criarUsuario(nome: string, email: string, perfil: string, empresaId: number): Promise<string> {
  const senha = `Reg-${randomUUID()}!`;
  await clienteDb.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, $4, true, $5, false, false, false, now())`,
    [nome, email, await hashPassword(senha), perfil, empresaId],
  );
  await clienteDb.query(
    `INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`,
    [email, empresaId],
  );
  return senha;
}

// ----------------------------------------------------------------- fixtures
type Pedido = { produtoId: number; saleId: string; pedidoId: number; cobrancaId: number; providerRef: string; tokenPedido: string };

async function produtoComEstoque(rotulo: string, quantidade = 8): Promise<number> {
  const sku = `ER-${RODADA}-${rotulo}`.toUpperCase().slice(0, 40);
  const prod = await req('POST', '/produtos', { sku, nome: `Peça ${rotulo} ${RODADA}`, preco_venda: 100, custo: 40 }, tokenA);
  assert.ok([200, 201].includes(prod.status), `produto ${rotulo}: ${msg(prod)}`);
  const produtoId = Number(prod.body.id);
  const entrada = await req('POST', '/movimentacoes', { tipo: 'entrada', produto_id: produtoId, quantidade, motivo: `Saldo regressão ${rotulo}` }, tokenA);
  assert.ok([200, 201].includes(entrada.status), `entrada de ${quantidade} peças (${rotulo}): ${msg(entrada)}`);

  const projetado = await req('POST', '/commerce/produtos', { produto_id: produtoId }, tokenA);
  assert.ok([200, 201].includes(projetado.status), `projeção ${rotulo}: ${msg(projetado)}`);

  const publicar = await req('POST', '/commerce/publicacoes', { produto_id: produtoId, canais: ['BROBOND'] }, tokenA);
  assert.ok([200, 201].includes(publicar.status), `publicação ${rotulo}: ${msg(publicar)}`);
  let publicado = false;
  for (let i = 0; i < 60 && !publicado; i += 1) {
    await processarFilaPublicacoes(50);
    const fila = await req('GET', '/commerce/publicacoes', undefined, tokenA);
    publicado = (fila.body?.publicacoes || []).some((p: any) => Number(p.produto_id) === produtoId && p.canal === 'BROBOND' && p.estado === 'PUBLISHED');
    if (!publicado) await delay(100);
  }
  assert.ok(publicado, `produto ${rotulo} publicado na vitrine BROBOND`);
  return produtoId;
}

async function checkoutInterno(produtoId: number, rotulo: string): Promise<Pedido> {
  const chave = `chave-${RODADA}-${rotulo}-${randomUUID().slice(0, 8)}`.slice(0, 64);
  const checkout = await req('POST', '/commerce/checkout', {
    chave,
    comprador: { nome: `Comprador ${rotulo}`, email: `comprador-${rotulo}${SUFIXO_EMAIL}`, whatsapp: '62999990000', documento: '529.982.247-25' },
    itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }],
    endereco: { nome: `Comprador ${rotulo}`, rua: 'Rua das Flores', numero: '10', bairro: 'Centro', cidade: 'Goiânia', uf: 'GO', cep: '74000-000', complemento: null },
  }, tokenA);
  assert.equal(checkout.status, 201, `checkout ${rotulo}: ${msg(checkout)}`);
  const saleId = String(checkout.body?.sale_id || '');
  const tokenPedido = String(checkout.body?.pedido?.checkout_token || checkout.body?.checkout_token || '');
  assert.ok(saleId.length > 5, `checkout devolve sale_id (${rotulo})`);
  const linha = await clienteDb.query(`SELECT id, cobranca_id FROM commerce_pedidos WHERE sale_id = $1`, [saleId]);
  const pedidoId = Number(linha.rows[0].id);
  const cobrancaId = Number(linha.rows[0].cobranca_id);
  assert.ok(cobrancaId > 0, `cobrança criada pelo backend (${rotulo})`);
  const cobranca = await clienteDb.query(`SELECT provider_ref FROM gateway_cobrancas WHERE id = $1`, [cobrancaId]);
  return { produtoId, saleId, pedidoId, cobrancaId, providerRef: String(cobranca.rows[0].provider_ref), tokenPedido };
}

/** Webhook HTTP do provedor de teste (assinatura de teste, mesmo caminho do E2E). */
async function webhook(eventId: string, status: 'pago' | 'cancelado' | 'expirado', providerRef: string): Promise<Resposta> {
  const evento = { pago: 'payment.paid', cancelado: 'payment.canceled', expirado: 'payment.expired' }[status];
  const r = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: evento, event_id: eventId, data: { id: providerRef }, status }),
  });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

// ----------------------------------------------------------------- observação do banco
type Snapshot = {
  fisico: number;
  reservado: number;
  disponivel: number;
  vendas: number;
  saidas: number;
  saidas_quantidade: number;
  reservas_por_status: Record<string, number>;
};

/** Valores OBSERVADOS no PostgreSQL para um produto da empresa. */
async function observar(empresaId: number, produtoId: number): Promise<Snapshot> {
  const fis = await clienteDb.query(
    `SELECT COALESCE(SUM(quantidade), 0)::int AS q FROM estoques WHERE empresa_id = $1 AND produto_id = $2`,
    [empresaId, produtoId],
  );
  const res = await clienteDb.query(
    `SELECT COALESCE(SUM(quantidade), 0)::int AS q FROM estoque_reservas
      WHERE empresa_id = $1 AND produto_id = $2 AND status = 'ativa' AND tipo IN ('reserva', 'empenho', 'bloqueio')`,
    [empresaId, produtoId],
  );
  const vendas = await clienteDb.query(
    `SELECT COUNT(DISTINCT venda_id)::int AS n FROM itens_venda WHERE empresa_id = $1 AND produto_id = $2`,
    [empresaId, produtoId],
  );
  const saidas = await clienteDb.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantidade), 0)::int AS q FROM movimentacoes
      WHERE empresa_id = $1 AND produto_id = $2 AND tipo = 'saida' AND venda_id IS NOT NULL`,
    [empresaId, produtoId],
  );
  const porStatus = await clienteDb.query(
    `SELECT status, COUNT(*)::int AS n FROM estoque_reservas WHERE empresa_id = $1 AND produto_id = $2 GROUP BY status ORDER BY status`,
    [empresaId, produtoId],
  );
  const fisico = Number(fis.rows[0].q);
  const reservado = Number(res.rows[0].q);
  return {
    fisico,
    reservado,
    disponivel: fisico - reservado,
    vendas: Number(vendas.rows[0].n),
    saidas: Number(saidas.rows[0].n),
    saidas_quantidade: Number(saidas.rows[0].q),
    reservas_por_status: Object.fromEntries(porStatus.rows.map((r) => [String(r.status), Number(r.n)])),
  };
}

function registrar(cenario: string, snap: Snapshot, extra: Record<string, unknown> = {}): void {
  // Sem CPF, e-mail, token ou segredo: só contagens e estados do estoque.
  console.log(`ESTOQUE_REGRESSAO ${JSON.stringify({ cenario, ...snap, ...extra })}`);
}

async function estadoPedido(pedidoId: number): Promise<{ estado: string; venda_id: number | null; sale_status: string; sale_venda: number | null }> {
  const r = await clienteDb.query(
    `SELECT p.estado, p.venda_id, s.status AS sale_status, s.operational_venda_id AS sale_venda
       FROM commerce_pedidos p JOIN sales s ON s.id = p.sale_id WHERE p.id = $1`,
    [pedidoId],
  );
  return {
    estado: String(r.rows[0].estado),
    venda_id: r.rows[0].venda_id === null ? null : Number(r.rows[0].venda_id),
    sale_status: String(r.rows[0].sale_status),
    sale_venda: r.rows[0].sale_venda === null ? null : Number(r.rows[0].sale_venda),
  };
}

async function reservasDoPedido(pedidoId: number): Promise<{ status: string; tipo: string; quantidade: number; liberada_em: string | null }[]> {
  const r = await clienteDb.query(
    `SELECT status, tipo, quantidade, liberada_em FROM estoque_reservas WHERE origem_recurso = 'commerce_checkout' AND origem_id = $1 ORDER BY id`,
    [pedidoId],
  );
  return r.rows.map((x) => ({ status: String(x.status), tipo: String(x.tipo), quantidade: Number(x.quantidade), liberada_em: x.liberada_em ? new Date(x.liberada_em).toISOString() : null }));
}

// ----------------------------------------------------------------- ciclo de vida
before(async () => {
  await clienteDb.connect();
  const a = await clienteDb.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Regressão A ${RODADA}`]);
  empresaA = Number(a.rows[0].id);
  const b = await clienteDb.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Regressão B ${RODADA}`]);
  empresaB = Number(b.rows[0].id);

  const emailA = `ger-a${SUFIXO_EMAIL}`;
  const senhaA = await criarUsuario(`Gerente A ${RODADA}`, emailA, 'gerente', empresaA);
  gerenteAId = Number((await clienteDb.query(`SELECT id FROM usuarios WHERE email = $1`, [emailA])).rows[0].id);
  const emailB = `ger-b${SUFIXO_EMAIL}`;
  const senhaB = await criarUsuario(`Gerente B ${RODADA}`, emailB, 'gerente', empresaB);

  const cfgRow = await clienteDb.query(
    `INSERT INTO gateway_configs (empresa_id, provider, ambiente, ativo, credenciais_cifradas)
     VALUES ($1, 'mock', 'teste', true, $2)
     ON CONFLICT (empresa_id, lower(provider))
     DO UPDATE SET ambiente = 'teste', ativo = true, credenciais_cifradas = EXCLUDED.credenciais_cifradas, atualizado_em = now()
     RETURNING id`,
    [empresaA, cifrarSegredo(JSON.stringify({ fake: 'regressao-estoque' }))],
  );
  configsGateway.push(Number(cfgRow.rows[0].id));

  const porta = await reservarPorta();
  const servidor = await subirServidor(porta);
  child = servidor.child;
  baseUrl = servidor.baseUrl;
  logsServidor = servidor.logs;

  const loginA = await req('POST', '/auth/login', { email: emailA, password: senhaA });
  assert.equal(loginA.status, 200, `login gerente A: ${loginA.texto}`);
  tokenA = String(loginA.body?.token || '');
  const loginB = await req('POST', '/auth/login', { email: emailB, password: senhaB });
  assert.equal(loginB.status, 200, `login gerente B: ${loginB.texto}`);
  tokenB = String(loginB.body?.token || '');

  const cfg = await req('POST', '/commerce_configuracoes', {
    loja_nome: `Loja Regressão ${RODADA}`,
    loja_descricao: 'Regressão de estoque',
    frete_provedor: 'manual',
    frete_valor: 20,
    frete_gratis_acima: 300,
    frete_prazo_dias: 5,
    checkout_usuario_id: gerenteAId,
    checkout_expira_minutos: 60,
  }, tokenA);
  assert.ok([200, 201].includes(cfg.status), `config da loja: ${msg(cfg)}`);
});

after(async () => {
  try {
    const limpar = async (sql: string, params: unknown[] = []) => {
      try { await clienteDb.query(sql, params as never[]); } catch (e) { console.error('cleanup:', sql.slice(0, 80), String(e)); }
    };
    const emp = [empresaA, empresaB];
    await limpar(`DELETE FROM payment_operations WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE empresa_id = ANY($1::int[]))`, [emp]);
    await limpar(`DELETE FROM payment_attempts WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE empresa_id = ANY($1::int[]))`, [emp]);
    await limpar(`DELETE FROM payment_intents WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM gateway_webhook_events WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM commerce_outbox WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM commerce_publicacoes WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM commerce_precos WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM commerce_pedidos WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM estoque_reservas WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM gateway_cobrancas WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM movimentacoes WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM itens_venda WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM sale_items WHERE sale_id IN (SELECT s.id FROM sales s JOIN usuarios u ON u.id = s.usuario_id WHERE u.empresa_id = ANY($1::int[]))`, [emp]);
    await limpar(`DELETE FROM sales WHERE usuario_id IN (SELECT id FROM usuarios WHERE empresa_id = ANY($1::int[]))`, [emp]);
    await limpar(`DELETE FROM vendas WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM estoques WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM commerce_configuracoes WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM produtos WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM gateway_configs WHERE id = ANY($1::int[])`, [configsGateway]);
    await limpar(`DELETE FROM usuario_empresas WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM usuarios WHERE empresa_id = ANY($1::int[])`, [emp]);
    await limpar(`DELETE FROM empresas WHERE id = ANY($1::int[])`, [emp]);
  } finally {
    await clienteDb.end().catch(() => undefined);
    if (child) await pararServidor(child);
    await pool?.end().catch(() => undefined);
  }
});

// ============================================================================
// C1 — pedido pendente: reserva sim, baixa física NÃO
// ============================================================================
test('C1 pedido pendente: reserva ativa, físico intacto (8/1/7), 0 venda, 0 saída', async () => {
  const produtoId = await produtoComEstoque('pendente');
  const antes = await observar(empresaA, produtoId);
  assert.equal(antes.fisico, 8, 'estoque inicial físico = 8');
  assert.equal(antes.disponivel, 8);

  const pedido = await checkoutInterno(produtoId, 'pendente');
  const depois = await observar(empresaA, produtoId);
  registrar('C1_pendente', depois, { pedido_estado: (await estadoPedido(pedido.pedidoId)).estado });

  assert.equal(depois.fisico, 8, 'pedido pendente NÃO baixa o físico');
  assert.equal(depois.reservado, 1, 'pedido pendente reserva 1 peça');
  assert.equal(depois.disponivel, 7, 'disponível = 8 − 1');
  assert.equal(depois.vendas, 0, 'nenhuma venda operacional');
  assert.equal(depois.saidas, 0, 'nenhuma saída de estoque');
  assert.equal((await estadoPedido(pedido.pedidoId)).estado, 'AGUARDANDO_PAGAMENTO');
  const reservas = await reservasDoPedido(pedido.pedidoId);
  assert.deepEqual(reservas.map((r) => [r.status, r.tipo, r.quantidade]), [['ativa', 'reserva', 1]]);
});

// ============================================================================
// C2 — pagamento aprovado: reserva consumida, 1 venda, 1 saída (7/0/7)
// ============================================================================
test('C2 pagamento aprovado: reserva consumida, 1 venda, 1 saída, físico 7/0/7', async () => {
  const produtoId = await produtoComEstoque('aprovado');
  const pedido = await checkoutInterno(produtoId, 'aprovado');

  const wh = await webhook(`evt-${RODADA}-aprovado`, 'pago', pedido.providerRef);
  assert.equal(wh.status, 200, `webhook pago: ${wh.texto}`);
  assert.equal(wh.body?.processado, true, `webhook processado: ${wh.texto}`);
  assert.equal(wh.body?.resultado, 'paga', 'cobrança resolvida como paga pelo provedor');

  const estado = await estadoPedido(pedido.pedidoId);
  const snap = await observar(empresaA, produtoId);
  registrar('C2_aprovado', snap, { pedido_estado: estado.estado, sale_status: estado.sale_status });

  assert.equal(estado.estado, 'CONVERTIDO', 'webhook aprovado converte o pedido pela ponte');
  assert.equal(estado.sale_status, 'PAID');
  assert.ok(estado.sale_venda && estado.venda_id === estado.sale_venda, 'pedido e sale apontam para a MESMA venda');
  assert.equal(snap.fisico, 7, 'baixa física de 1 peça na conversão');
  assert.equal(snap.reservado, 0, 'reserva não segura mais a peça');
  assert.equal(snap.disponivel, 7);
  assert.equal(snap.vendas, 1, 'UMA venda operacional');
  assert.equal(snap.saidas, 1, 'UMA saída de estoque ligada à venda');
  assert.equal(snap.saidas_quantidade, 1);
  const reservas = await reservasDoPedido(pedido.pedidoId);
  assert.deepEqual(reservas.map((r) => r.status), ['consumida'], 'reserva consumida, não liberada');
});

// ============================================================================
// C3 — cancelado, recusado e expirado: reserva liberada, sem venda, sem saída
// ============================================================================
test('C3a cancelado pelo operador: reserva liberada, 0 venda, 0 saída, físico 8/0/8; repetição idempotente', async () => {
  const produtoId = await produtoComEstoque('cancelado');
  const pedido = await checkoutInterno(produtoId, 'cancelado');
  assert.equal((await observar(empresaA, produtoId)).reservado, 1, 'reserva ativa antes do cancelamento');

  const cancel = await req('POST', `/commerce/pedidos/${pedido.saleId}/cancelar`, {}, tokenA);
  assert.equal(cancel.status, 200, `cancelamento: ${msg(cancel)}`);
  const snap = await observar(empresaA, produtoId);
  registrar('C3a_cancelado', snap, { pedido_estado: (await estadoPedido(pedido.pedidoId)).estado });
  assert.equal((await estadoPedido(pedido.pedidoId)).estado, 'CANCELADO');
  assert.equal(snap.fisico, 8, 'físico intacto após cancelamento');
  assert.equal(snap.reservado, 0, 'reserva liberada');
  assert.equal(snap.disponivel, 8);
  assert.equal(snap.vendas, 0);
  assert.equal(snap.saidas, 0);
  assert.deepEqual((await reservasDoPedido(pedido.pedidoId)).map((r) => r.status), ['liberada']);

  const repeticao = await req('POST', `/commerce/pedidos/${pedido.saleId}/cancelar`, {}, tokenA);
  assert.equal(repeticao.status, 200, `repetição: ${msg(repeticao)}`);
  assert.equal(repeticao.body?.idempotente, true, 'segundo cancelamento é idempotente');
  assert.deepEqual(await observar(empresaA, produtoId), snap, 'repetição não altera o estoque');
});

test('C3b recusado pelo provedor (webhook): reserva liberada, 0 venda, 0 saída, físico 8/0/8', async () => {
  const produtoId = await produtoComEstoque('recusado');
  const pedido = await checkoutInterno(produtoId, 'recusado');

  const wh = await webhook(`evt-${RODADA}-recusado`, 'cancelado', pedido.providerRef);
  assert.equal(wh.status, 200, `webhook cancelado: ${wh.texto}`);
  assert.equal(wh.body?.resultado, 'cancelada', 'provedor reportou cancelamento/recusa');

  const snap = await observar(empresaA, produtoId);
  registrar('C3b_recusado', snap, { pedido_estado: (await estadoPedido(pedido.pedidoId)).estado });
  assert.equal((await estadoPedido(pedido.pedidoId)).estado, 'CANCELADO');
  assert.equal(snap.fisico, 8);
  assert.equal(snap.reservado, 0, 'reserva liberada pelo webhook');
  assert.equal(snap.disponivel, 8);
  assert.equal(snap.vendas, 0);
  assert.equal(snap.saidas, 0);

  const wh2 = await webhook(`evt-${RODADA}-recusado-2`, 'cancelado', pedido.providerRef);
  assert.equal(wh2.status, 200, `segundo webhook de recusa: ${wh2.texto}`);
  assert.deepEqual(await observar(empresaA, produtoId), snap, 'webhook de recusa repetido não altera o estoque');
});

test('C3c expirado pela varredura real: reserva liberada, 0 venda, 0 saída, físico 8/0/8; segunda varredura idempotente', async () => {
  const produtoId = await produtoComEstoque('expirado');
  const pedido = await checkoutInterno(produtoId, 'expirado');
  assert.equal((await observar(empresaA, produtoId)).reservado, 1);

  // Força o prazo vencido no banco (o relógio da varredura é o do servidor de teste).
  await clienteDb.query(`UPDATE commerce_pedidos SET expira_em = now() - interval '1 minute' WHERE id = $1`, [pedido.pedidoId]);
  const varredura1 = await expirarCheckoutsPendentes(new Date());
  assert.ok(varredura1 >= 1, `varredura expirou ao menos o pedido vencido (${varredura1})`);

  const snap = await observar(empresaA, produtoId);
  const estado = await estadoPedido(pedido.pedidoId);
  registrar('C3c_expirado', snap, { pedido_estado: estado.estado });
  assert.equal(estado.estado, 'EXPIRADO');
  assert.equal(estado.sale_status, 'CANCELLED', 'sale analítica cancelada, nunca apagada');
  assert.equal(snap.fisico, 8);
  assert.equal(snap.reservado, 0, 'reserva liberada pela expiração');
  assert.equal(snap.disponivel, 8);
  assert.equal(snap.vendas, 0);
  assert.equal(snap.saidas, 0);
  const liberadaEm = (await reservasDoPedido(pedido.pedidoId)).map((r) => r.liberada_em);

  await expirarCheckoutsPendentes(new Date());
  assert.deepEqual(await observar(empresaA, produtoId), snap, 'segunda varredura não altera o estoque');
  assert.equal((await estadoPedido(pedido.pedidoId)).estado, 'EXPIRADO');
  assert.deepEqual((await reservasDoPedido(pedido.pedidoId)).map((r) => r.liberada_em), liberadaEm, 'liberação não é repetida');
});

// ============================================================================
// C4 — webhook duplicado: uma conversão, uma venda, uma saída
// ============================================================================
test('C4 webhook duplicado (mesmo event_id e novo event_id do mesmo pagamento): 1 conversão, 1 venda, 1 saída', async () => {
  const produtoId = await produtoComEstoque('duplicado');
  const pedido = await checkoutInterno(produtoId, 'duplicado');
  const eventoId = `evt-${RODADA}-dup`;

  const primeiro = await webhook(eventoId, 'pago', pedido.providerRef);
  assert.equal(primeiro.status, 200, `webhook 1: ${primeiro.texto}`);
  const replay = await webhook(eventoId, 'pago', pedido.providerRef);
  assert.equal(replay.status, 200, `replay do mesmo event_id responde sem erro: ${replay.texto}`);
  const outroEvento = await webhook(`${eventoId}-b`, 'pago', pedido.providerRef);
  assert.equal(outroEvento.status, 200, `novo event_id do mesmo pagamento: ${outroEvento.texto}`);

  const snap = await observar(empresaA, produtoId);
  const estado = await estadoPedido(pedido.pedidoId);
  const eventos = await clienteDb.query(`SELECT count(*)::int AS n FROM gateway_webhook_events WHERE cobranca_id = $1 AND status = 'processado'`, [pedido.cobrancaId]);
  const intencoesPagas = await clienteDb.query(
    `SELECT count(*)::int AS n FROM payment_intents WHERE empresa_id = $1 AND order_id = $2 AND status = 'PAID'`,
    [empresaA, pedido.pedidoId],
  );
  registrar('C4_duplicado', snap, {
    pedido_estado: estado.estado,
    eventos_processados: Number(eventos.rows[0].n),
    pagamentos_confirmados: Number(intencoesPagas.rows[0].n),
  });
  assert.equal(estado.estado, 'CONVERTIDO');
  assert.equal(snap.vendas, 1, 'webhook repetido não cria segunda venda');
  assert.equal(snap.saidas, 1, 'webhook repetido não cria segunda saída');
  assert.equal(snap.saidas_quantidade, 1);
  assert.equal(snap.fisico, 7, 'físico baixado UMA vez');
  assert.equal(snap.reservado, 0);
  assert.equal(Number(intencoesPagas.rows[0].n), 1, 'UM pagamento confirmado');
  const itens = await clienteDb.query(`SELECT count(*)::int AS n FROM itens_venda WHERE venda_id = $1 AND produto_id = $2`, [estado.venda_id, produtoId]);
  assert.equal(Number(itens.rows[0].n), 1, 'UM item de venda');
});

// ============================================================================
// C5 — concorrência: 2 aprovações e 2 conversões simultâneas
// ============================================================================
test('C5 concorrência: 2 webhooks aprovados + 2 conversões em paralelo → 1 pagamento, 1 venda, 1 saída, sem 5xx', async () => {
  const produtoId = await produtoComEstoque('concorrencia');
  const pedido = await checkoutInterno(produtoId, 'concorrencia');

  const respostas = await Promise.all([
    webhook(`evt-${RODADA}-cc-1`, 'pago', pedido.providerRef),
    webhook(`evt-${RODADA}-cc-2`, 'pago', pedido.providerRef),
    req('POST', `/commerce/pedidos/${pedido.saleId}/converter`, {}, tokenA),
    req('POST', `/commerce/pedidos/${pedido.saleId}/converter`, {}, tokenA),
  ]);
  const codigos = respostas.map((r) => r.status);
  registrar('C5_concorrencia', await observar(empresaA, produtoId), { codigos_http: codigos });
  for (const r of respostas) assert.ok(r.status < 500, `nenhuma resposta 5xx na corrida: ${r.status} ${r.texto.slice(0, 160)}`);

  // Se algum conversor perdeu a corrida, a conversão ainda deve convergir.
  const estado = await estadoPedido(pedido.pedidoId);
  const snap = await observar(empresaA, produtoId);
  assert.equal(estado.estado, 'CONVERTIDO', `pedido convergiu para CONVERTIDO (estado=${estado.estado})`);
  assert.equal(snap.vendas, 1, 'corrida produz UMA venda');
  assert.equal(snap.saidas, 1, 'corrida produz UMA saída');
  assert.equal(snap.saidas_quantidade, 1);
  assert.equal(snap.fisico, 7);
  assert.equal(snap.reservado, 0);
  const intencoesPagas = await clienteDb.query(
    `SELECT count(*)::int AS n FROM payment_intents WHERE empresa_id = $1 AND order_id = $2 AND status = 'PAID'`,
    [empresaA, pedido.pedidoId],
  );
  assert.equal(Number(intencoesPagas.rows[0].n), 1, 'corrida produz UM pagamento confirmado');
  const cobrancasPagas = await clienteDb.query(`SELECT count(*)::int AS n FROM gateway_cobrancas WHERE id = $1 AND status = 'paga'`, [pedido.cobrancaId]);
  assert.equal(Number(cobrancasPagas.rows[0].n), 1, 'a cobrança está paga exatamente uma vez');
});

// ============================================================================
// C6 — tenant cruzado: a empresa B não enxerga, não altera e não converte
// ============================================================================
test('C6 tenant cruzado: empresa B não lê, cancela nem converte o pedido de A; estoque de A intacto', async () => {
  const produtoId = await produtoComEstoque('tenant');
  const pedido = await checkoutInterno(produtoId, 'tenant');
  const antes = await observar(empresaA, produtoId);
  assert.equal(antes.reservado, 1);

  const lido = await req('GET', `/commerce/pedidos/${pedido.saleId}`, undefined, tokenB);
  assert.equal(lido.status, 404, `B não lê pedido de A: ${msg(lido)}`);
  const cancelado = await req('POST', `/commerce/pedidos/${pedido.saleId}/cancelar`, {}, tokenB);
  assert.equal(cancelado.status, 404, `B não cancela pedido de A: ${msg(cancelado)}`);
  const convertido = await req('POST', `/commerce/pedidos/${pedido.saleId}/converter`, {}, tokenB);
  assert.equal(convertido.status, 404, `B não converte pedido de A: ${msg(convertido)}`);
  const lista = await req('GET', '/commerce/pedidos', undefined, tokenB);
  assert.equal(lista.status, 200);
  assert.ok(!lista.texto.includes(pedido.saleId), 'lista de B não contém o pedido de A');

  const depois = await observar(empresaA, produtoId);
  registrar('C6_tenant_cruzado', depois, { pedido_estado: (await estadoPedido(pedido.pedidoId)).estado });
  assert.deepEqual(depois, antes, 'estoque e reserva de A não mudam com tentativas de B');
  assert.equal((await estadoPedido(pedido.pedidoId)).estado, 'AGUARDANDO_PAGAMENTO');
});
