// ============================================================================
// BROBOND COMMERCE OS — E2E EM POSTGRESQL REAL (fecha o 4d de commerce).
//
// O oráculo (unitário), a concorrência (12 cenários) e o golive-03
// (marketplace → venda) já provam as peças isoladas. Aqui a cadeia inteira
// roda contra o SERVIDOR DE VERDADE, em HTTP, com o banco real:
//
//   1. catálogo: produto ERP → projeção na vitrine (idempotente) → preço por
//      canal → publicação enfileirada → processador real → BROBOND PUBLISHED
//      e Mercado Livre ERROR honesto (sem credencial = erro, nunca sucesso);
//   2. vitrine pública: /loja/produtos e /loja/produtos/:slug sem autenticação;
//   3. cupom de uso único: preview aplica → checkout reserva → PAGAMENTO
//      consome (uso_atual=1) → novo preview recusa (fail-closed);
//   4. checkout público (/loja/checkout): pedido AGUARDANDO_PAGAMENTO, sale
//      com empresa_id, reserva ATIVA, cobrança criada pelo BACKEND (o front
//      nunca confirma nada);
//   5. pagamento: webhook MOCK ASSINADO do provedor → processado → o ouvinte
//      do Commerce OS confirma o pedido (PAGO) — só depois do webhook;
//   6. conversão: /commerce/pedidos/:saleId/converter cria UMA venda pela
//      ponte sales → vendas e a repetição é idempotente;
//   7. frete fail-closed: sem provedor, /loja/preview responde "Frete não
//      configurado" e o checkout recusa com 409;
//   8. RBAC/tenancy no backend: sem token 401, operador sem permissão de
//      escrita 403, outro tenant 404 (nunca vaza cross-tenant).
//
// Roda no job `testes-postgres` (npm run test:pg). Sem DATABASE_URL FALHA.
// Usa o banco da SUÍTE (já migrado) + servidor filho em porta efêmera; as
// linhas criadas levam sufixo de rodada e são removidas no final.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import type { Readable } from 'node:stream';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('commerce-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query, pool } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');
const { cifrarSegredo } = await import('../../src/segredos');
const { processarFilaPublicacoes } = await import('../../src/commerce/catalogo');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `ce2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 24);
const SKUP = `C-${RODADA}`.toUpperCase().slice(0, 30);

// ----------------------------------------------------------------- harness HTTP
async function reservePort(): Promise<number> {
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

async function startRealServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port), JWT_SECRET: randomUUID() };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch { /* migrações/health em andamento */ }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(metodo: string, rota: string, corpo?: unknown, token?: string, baseUrlOverride?: string, headers?: Record<string, string>): Promise<Resposta> {
  const base = baseUrlOverride || (globalThis as { __CE2E_BASE__?: string }).__CE2E_BASE__!;
  const h: Record<string, string> = { accept: 'application/json', ...(headers || {}) };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${base}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

const msg = (r: Resposta) => `${r.status} ${r.texto.slice(0, 200)}`;

// ----------------------------------------------------------------- atores
async function criarUsuario(cliente: Client, nome: string, email: string, perfil: string, empresaId: number): Promise<string> {
  const senha = `Ce2e-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, $4, true, $5, false, false, false, now())`,
    [nome, email, await hashPassword(senha), perfil, empresaId],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email, empresaId]);
  return senha;
}

test('COMMERCE E2E: catálogo → fila → vitrine → checkout → webhook paga → conversão, com RBAC/tenancy e frete fail-closed', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta);
  (globalThis as { __CE2E_BASE__?: string }).__CE2E_BASE__ = baseUrl;

  const cliente = new Client({ connectionString: String(process.env.DATABASE_URL) });
  await cliente.connect();

  const configsCriadas: number[] = [];

  t.after(async () => {
    try {
      // limpeza das linhas desta rodada (ordem respeita FKs).
      // Cada statement é isolado: uma falha nunca aborta o restante do cleanup
      // (na prática as colunas antigas `vendas.numero/codigo` não existem — o
      // vínculo real é sales.operational_venda_id).
      const limpar = async (sql: string, params: unknown[] = []): Promise<void> => {
        try {
          await cliente.query(sql, params as never[]);
        } catch (e) {
          console.error('cleanup:', sql.slice(0, 80), String(e));
        }
      };
      // Payment Engine adds durable intent/attempt history; fixture cleanup must respect its FKs.
      for(const table of ['payment_refunds','payment_disputes','payment_settlements','payment_operations','payment_attempts']){
        await limpar(`DELETE FROM ${table} WHERE payment_intent_id IN (SELECT pi.id FROM payment_intents pi JOIN commerce_pedidos p ON p.empresa_id=pi.empresa_id AND p.id=pi.order_id WHERE p.chave_checkout LIKE $1)`,[`%${RODADA}%`]);
      }
      await limpar(`DELETE FROM payment_intents WHERE order_id IN (SELECT id FROM commerce_pedidos WHERE chave_checkout LIKE $1)`,[`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_webhook_events WHERE cobranca_id IN (SELECT cobranca_id FROM commerce_pedidos WHERE chave_checkout LIKE $1 AND cobranca_id IS NOT NULL)`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_webhook_events WHERE payload->>'event_id' LIKE $1`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM gateway_cobrancas WHERE id IN (SELECT cobranca_id FROM commerce_pedidos WHERE chave_checkout LIKE $1 AND cobranca_id IS NOT NULL)`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM commerce_outbox WHERE chave LIKE $1`, [`%${RODADA}%`]);
      // Identificadores REAIS da rodada: chave_checkout contém o RODADA; a sale
      // carrega buyer_email do cliente desta suíte; pedido_externo e reference
      // são aleatórios por natureza e NÃO casam com o RODADA.
      const salesAlvo = await cliente
        .query(`SELECT id, operational_venda_id FROM sales WHERE buyer_email ILIKE $1`, [`%@ce2e.example.test`])
        .catch(() => ({ rows: [] as { id: string; operational_venda_id: number | null }[] }));
      const idsSales = salesAlvo.rows.map((r) => r.id);
      const idsVendas: number[] = salesAlvo.rows
        .map((r) => Number(r.operational_venda_id ?? 0))
        .filter((n) => n > 0);
      // A reserva do checkout usa origem_recurso = 'commerce_checkout'.
      await limpar(
        `DELETE FROM estoque_reservas WHERE origem_recurso = 'commerce_checkout' AND origem_id IN (SELECT id FROM commerce_pedidos WHERE chave_checkout LIKE $1)`,
        [`%${RODADA}%`],
      );
      await limpar(`DELETE FROM creator_attributions WHERE order_id IN (SELECT id FROM commerce_pedidos WHERE chave_checkout LIKE $1)`, [`%${RODADA}%`]);
      await limpar(`DELETE FROM creator_commands WHERE idempotency_key LIKE $1`, [`ce2e-${RODADA}-%`]);
      await limpar(`DELETE FROM creator_partnerships WHERE created_by IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [`%@ce2e.example.test`]);
      await limpar(`DELETE FROM creator_campaigns WHERE created_by IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [`%@ce2e.example.test`]);
      await limpar(`DELETE FROM creator_profiles WHERE created_by IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [`%@ce2e.example.test`]);
      await limpar(`DELETE FROM commerce_pedidos WHERE chave_checkout LIKE $1`, [`%${RODADA}%`]);
      if (idsVendas.length > 0) {
        await limpar(`DELETE FROM itens_venda WHERE venda_id = ANY($1::int[])`, [idsVendas]);
        await limpar(`DELETE FROM commerce_rastreio WHERE venda_id = ANY($1::int[])`, [idsVendas]);
        // movimentações geradas pela conversão (ponte) ainda referenciam a venda
        await limpar(`DELETE FROM movimentacoes WHERE venda_id = ANY($1::int[])`, [idsVendas]);
      }
      if (idsSales.length > 0) await limpar(`DELETE FROM sales WHERE id = ANY($1::text[])`, [idsSales]);
      if (idsVendas.length > 0) await limpar(`DELETE FROM vendas WHERE id = ANY($1::int[])`, [idsVendas]);
      await limpar(`DELETE FROM commerce_publicacoes WHERE produto_id IN (SELECT id FROM commerce_produtos WHERE produto_id IN (SELECT id FROM produtos WHERE sku = $1))`, [SKUP]);
      await limpar(`DELETE FROM commerce_precos WHERE produto_id IN (SELECT id FROM commerce_produtos WHERE produto_id IN (SELECT id FROM produtos WHERE sku = $1))`, [SKUP]);
      await limpar(`DELETE FROM commerce_produtos WHERE produto_id IN (SELECT id FROM produtos WHERE sku = $1)`, [SKUP]);
      await limpar(`DELETE FROM commerce_cupons WHERE codigo LIKE $1`, [`CE2E${RODADA.toUpperCase()}%`]);
      await limpar(`DELETE FROM movimentacoes WHERE produto_id IN (SELECT id FROM produtos WHERE sku = $1)`, [SKUP]);
      await limpar(`DELETE FROM estoques WHERE produto_id IN (SELECT id FROM produtos WHERE sku = $1)`, [SKUP]);
      await limpar(`DELETE FROM produtos WHERE sku = $1`, [SKUP]);
      await limpar(`DELETE FROM commerce_configuracoes WHERE loja_nome LIKE $1`, [`%${RODADA}%`]);
      for (const id of configsCriadas.splice(0)) await limpar(`DELETE FROM gateway_configs WHERE id = $1`, [id]);
      await limpar(`DELETE FROM clientes WHERE email ILIKE $1`, [`%@ce2e.example.test`]);
      await limpar(`DELETE FROM usuarios WHERE email LIKE $1`, [`%@ce2e.example.test`]);
    } finally {
      await cliente.end().catch(() => undefined);
      await stopServer(child);
      await pool?.end().catch(() => undefined);
    }
  });

  // ---- atores: gerente A (empresa 1), operador (empresa 1), gerente B (empresa 2)
  const emailGer = `ger-${RODADA}@ce2e.example.test`;
  const senhaGer = await criarUsuario(cliente, `Gerente ${RODADA}`, emailGer, 'gerente', 1);
  const emailOp = `op-${RODADA}@ce2e.example.test`;
  const senhaOp = await criarUsuario(cliente, `Operador ${RODADA}`, emailOp, 'operador', 1);

  const empB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial CE2E ${RODADA}`]);
  const empresaB = Number(empB.rows[0].id);
  const emailB = `b-${RODADA}@ce2e.example.test`;
  const senhaB = await criarUsuario(cliente, `Gerente B ${RODADA}`, emailB, 'gerente', empresaB);

  const loginGer = await req('POST', '/auth/login', { email: emailGer, password: senhaGer }, null, baseUrl);
  assert.equal(loginGer.status, 200, `login gerente A: ${loginGer.texto}`);
  const tokenA = String(loginGer.body?.token || '');
  const loginOp = await req('POST', '/auth/login', { email: emailOp, password: senhaOp }, null, baseUrl);
  assert.equal(loginOp.status, 200, `login operador: ${loginOp.texto}`);
  const tokenOp = String(loginOp.body?.token || '');
  const loginB = await req('POST', '/auth/login', { email: emailB, password: senhaB }, null, baseUrl);
  assert.equal(loginB.status, 200, `login gerente B: ${loginB.texto}`);
  const tokenB = String(loginB.body?.token || '');

  // ---- gateway mock ativo na empresa 1 (fora de produção → provider mock) ----
  // Seed idempotente (ON CONFLICT): reexecuções no mesmo banco não podem quebrar
  // com 23505 — a config mock é artefato desta suíte e o cleanup remove a linha.
  const cfgRow = await cliente.query(
    `INSERT INTO gateway_configs (empresa_id, provider, ambiente, ativo, credenciais_cifradas)
     VALUES (1, 'mock', 'teste', true, $1)
     ON CONFLICT (empresa_id, lower(provider))
     DO UPDATE SET ambiente = 'teste', ativo = true,
                   credenciais_cifradas = EXCLUDED.credenciais_cifradas,
                   atualizado_em = now()
     RETURNING id`,
    [cifrarSegredo(JSON.stringify({ fake: 'ce2e' }))],
  );
  configsCriadas.push(Number(cfgRow.rows[0].id));

  // ---- 1) catálogo: produto + estoque + projeção + preço por canal -----------
  const prod = await req('POST', '/produtos', { sku: SKUP, nome: `Camiseta ${RODADA}`, preco_venda: 100, custo: 40 }, tokenA, baseUrl);
  assert.ok([200, 201].includes(prod.status), `produto ERP: ${msg(prod)}`);
  const produtoId = Number(prod.body.id);

  const entrada = await req('POST', '/movimentacoes', { tipo: 'entrada', produto_id: produtoId, quantidade: 3, motivo: `Saldo CE2E ${RODADA}` }, tokenA, baseUrl);
  assert.ok([200, 201].includes(entrada.status), `entrada de estoque: ${msg(entrada)}`);

  const projetado = await req('POST', '/commerce/produtos', { produto_id: produtoId }, tokenA, baseUrl);
  assert.ok([200, 201].includes(projetado.status), `projeção: ${msg(projetado)}`);
  const pcId = Number(projetado.body?.produto_commerce?.id ?? projetado.body?.id);
  const slug = String(projetado.body?.produto_commerce?.slug ?? projetado.body?.slug ?? '');
  assert.ok(pcId > 0 && slug.length > 3, `projeção devolve id e slug: ${msg(projetado)}`);

  // idempotência: repetir a projeção não duplica (409 com diagnóstico)
  const projetado2 = await req('POST', '/commerce/produtos', { produto_id: produtoId }, tokenA, baseUrl);
  assert.equal(projetado2.status, 409, `segunda projeção é recusada sem duplicar: ${msg(projetado2)}`);

  const preco = await req('PUT', `/commerce/produtos/${produtoId}/precos`, { canal: 'MERCADOLIVRE', preco: 120, preco_promo: null }, tokenA, baseUrl);
  assert.ok([200, 201].includes(preco.status), `preço por canal: ${msg(preco)}`);

  const detalhe = await req('GET', `/commerce/produtos/${produtoId}`, undefined, tokenA, baseUrl);
  assert.equal(detalhe.status, 200, `detalhe: ${msg(detalhe)}`);
  const precoML = (detalhe.body?.precos || []).find((p: any) => p.canal === 'MERCADOLIVRE');
  assert.equal(Number(precoML?.preco), 120, 'preço do canal Mercado Livre persistido');

  // ---- 2) fila de publicação: enfileira e o PROCESSADOR REAL decide ----------
  const publicadas = await req('POST', '/commerce/publicacoes', { produto_id: produtoId, canais: ['BROBOND', 'MERCADOLIVRE'] }, tokenA, baseUrl);
  assert.ok([200, 201].includes(publicadas.status), `enfileirar: ${msg(publicadas)}`);
  const filaAntes = await req('GET', '/commerce/publicacoes', undefined, tokenA, baseUrl);
  const minhasAntes = (filaAntes.body?.publicacoes || []).filter((p: any) => Number(p.produto_id) === produtoId);
  assert.ok(minhasAntes.length >= 2, `duas publicações na fila: ${minhasAntes.length}`);

  // O POST dispara o processador em background (void): aceleramos e aguardamos
  // os estados FINAIS — que só o processador real alcança (claim → publicador).
  let terminal = false;
  for (let i = 0; i < 60 && !terminal; i += 1) {
    await processarFilaPublicacoes(50);
    const agora = await req('GET', '/commerce/publicacoes', undefined, tokenA, baseUrl);
    const minhas = (agora.body?.publicacoes || []).filter((p: any) => Number(p.produto_id) === produtoId);
    terminal =
      minhas.length >= 2 &&
      minhas.every((p: any) => ['PUBLISHED', 'ERROR', 'REJECTED'].includes(String(p.estado)));
    if (!terminal) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(terminal, 'processador real levou as publicações aos estados finais');

  const filaDepois = await req('GET', '/commerce/publicacoes', undefined, tokenA, baseUrl);
  const brobond = (filaDepois.body?.publicacoes || []).find((p: any) => Number(p.produto_id) === produtoId && p.canal === 'BROBOND');
  const ml = (filaDepois.body?.publicacoes || []).find((p: any) => Number(p.produto_id) === produtoId && p.canal === 'MERCADOLIVRE');
  assert.equal(brobond?.estado, 'PUBLISHED', `BROBOND publicado de verdade: ${JSON.stringify(brobond)}`);
  assert.equal(brobond?.external_id, slug, 'external_id do canal próprio = slug da vitrine');
  assert.equal(ml?.estado, 'ERROR', 'ML sem credencial → ERROR honesto (nunca sucesso falso)');
  assert.ok(String(ml?.ultimo_erro || '').length > 3, 'o erro do canal fica registrado');

  // ---- 3) config da loja (exigida pela vitrine, fail-closed) -----------------
  const gerRow = await cliente.query(`SELECT id FROM usuarios WHERE email = $1`, [emailGer]);
  const checkoutUserId = Number(gerRow.rows[0]?.id || 0);
  assert.ok(checkoutUserId > 0, 'gerente criado serve de responsável pelo checkout');
  const cfg = await req('POST', '/commerce_configuracoes', {
    loja_nome: `Loja ${RODADA}`,
    loja_descricao: 'E2E',
    frete_provedor: 'manual',
    frete_valor: 20,
    frete_gratis_acima: 300,
    frete_prazo_dias: 5,
    checkout_usuario_id: checkoutUserId,
    checkout_expira_minutos: 60,
  }, tokenA, baseUrl);
  assert.ok([200, 201].includes(cfg.status), `config da loja: ${msg(cfg)}`);

  // ---- 3b) vitrine pública (sem token) --------------------------------------
  const vitrine = await req('GET', '/loja/produtos?page=1&pageSize=48', undefined, null, baseUrl);
  assert.equal(vitrine.status, 200, `vitrine: ${msg(vitrine)}`);
  const naVitrine = (vitrine.body?.produtos || []).find((p: any) => p.slug === slug);
  assert.ok(naVitrine, 'produto projetado aparece na vitrine pública');
  const vitrineDetalhe = await req('GET', `/loja/produtos/${slug}`, undefined, null, baseUrl);
  assert.equal(vitrineDetalhe.status, 200, `detalhe público: ${msg(vitrineDetalhe)}`);
  assert.equal(vitrineDetalhe.body?.produto?.nome, `Camiseta ${RODADA}`);

  // ---- 4) cupom de uso único -------------------------------------------------
  const codigoCupom = `CE2E${RODADA}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  const cupom = await req('POST', '/commerce/cupons', { codigo: codigoCupom, tipo: 'percentual', valor: 10, minimo_pedido: 0, uso_maximo: 1, validade: null, ativo: true }, tokenA, baseUrl);
  assert.ok([200, 201].includes(cupom.status), `cupom: ${msg(cupom)}`);

  // Parceria manual conectada ao mesmo cupom/checkout, sem simular comissão.
  const creatorReq = (method: string, route: string, body: object, suffix: string, token = tokenA) =>
    req(method, route, body, token, baseUrl, { 'Idempotency-Key': `ce2e-${RODADA}-${suffix}` });
  const creator = await creatorReq('POST', '/creators/perfis', { name: `Creator ${RODADA}`, platform: 'INSTAGRAM', handle: RODADA }, 'creator');
  assert.equal(creator.status, 201, `creator: ${msg(creator)}`);
  const campaignData = { name: `Campanha ${RODADA}`, objective: 'Divulgação por parceiro real', starts_on: '2020-01-01', ends_on: '2099-12-31' };
  const campaign = await creatorReq('POST', '/creators/campanhas', campaignData, 'campaign');
  assert.equal(campaign.status, 201, `campanha: ${msg(campaign)}`);
  const campaignActive = await creatorReq('PUT', `/creators/campanhas/${campaign.body.row.id}`, { ...campaignData, status: 'ACTIVE', expected_version: 0 }, 'campaign-active');
  assert.equal(campaignActive.status, 200, `ativação da campanha: ${msg(campaignActive)}`);
  const partnership = await creatorReq('POST', '/creators/parcerias', { creator_id: Number(creator.body.row.id), campaign_id: Number(campaign.body.row.id), coupon_id: Number(cupom.body.cupom.id) }, 'partner');
  assert.equal(partnership.status, 201, `parceria: ${msg(partnership)}`);
  const partnerActive = await creatorReq('PUT', `/creators/parcerias/${partnership.body.row.id}`, { status: 'ACTIVE', expected_version: 0 }, 'partner-active');
  assert.equal(partnerActive.status, 200, `ativação da parceria: ${msg(partnerActive)}`);
  const opWrite = await creatorReq('POST', '/creators/perfis', { name: 'Operador proibido', platform: 'OTHER', handle: 'operador' }, 'op-denied', tokenOp);
  assert.equal(opWrite.status, 403, 'operador não cria creator');
  const foreignCreator = await req('GET', `/creators/perfis/${creator.body.row.id}`, undefined, tokenB, baseUrl);
  assert.equal(foreignCreator.status, 404, 'outro tenant não acessa creator');

  // ---- 5) config pública da loja espelha o frete manual ---------------------
  const configPublica = await req('GET', '/loja/config', undefined, null, baseUrl);
  assert.equal(configPublica.status, 200, `config pública: ${msg(configPublica)}`);
  assert.equal(configPublica.body?.frete?.provedor, 'manual', 'a vitrine enxerga o frete configurado');

  // ---- 6) preview com cupom --------------------------------------------------
  const itens = [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }];
  const preview = await req('POST', '/loja/preview', { itens, cupom: codigoCupom }, null, baseUrl);
  assert.equal(preview.status, 200, `preview: ${msg(preview)}`);
  assert.equal(preview.body?.cupom?.valido, true, 'cupom válido no preview');
  assert.ok(Number(preview.body?.cupom?.desconto) > 0, 'cupom desconta no preview');
  assert.equal(preview.body?.frete?.disponivel, true, 'frete manual disponível');
  assert.equal(preview.body?.frete?.valor, 20, 'frete cobra a tabela');

  // ---- 7) checkout público: pedido + sale + reserva + cobrança --------------
  const chave = `chave-${RODADA}-${randomUUID().slice(0, 8)}`.slice(0, 64);
  const checkout = await req('POST', '/loja/checkout', {
    chave,
    comprador: { nome: 'Cliente CE2E', email: 'cliente@ce2e.example.test' },
    itens,
    cupom: codigoCupom,
    endereco: { nome: 'Cliente CE2E', rua: 'Rua das Flores', numero: '10', bairro: 'Centro', cidade: 'Goiânia', uf: 'GO', cep: '74000-000', complemento: null },
  }, null, baseUrl);
  assert.equal(checkout.status, 201, `checkout: ${msg(checkout)}`);
  const saleId = String(checkout.body?.sale_id || '');
  const tokenPedido = String(checkout.body?.pedido?.checkout_token || checkout.body?.checkout_token || '');
  assert.ok(saleId.length > 5, `checkout devolve sale_id: ${msg(checkout)}`);
  assert.match(tokenPedido, /^[a-f0-9]{64}$/, 'checkout_token público tem 64 hex');
  assert.equal(checkout.body?.ok, true);

  // reenvio do MESMO carrinho → idempotente (mesmo pedido)
  const checkout2 = await req('POST', '/loja/checkout', {
    chave,
    comprador: { nome: 'Cliente CE2E', email: 'cliente@ce2e.example.test' },
    itens,
  }, null, baseUrl);
  assert.equal(checkout2.status, 200, `reenvio idempotente: ${msg(checkout2)}`);
  assert.equal(checkout2.body?.idempotente, true, 'mesma chave devolve o MESMO pedido');
  const attributed = await req('GET', `/creators/parcerias/${partnership.body.row.id}/atribuicoes`, undefined, tokenA, baseUrl);
  assert.equal(attributed.status, 200, `atribuição: ${msg(attributed)}`);
  assert.equal(attributed.body.total, 1, 'replay não duplica atribuição do mesmo checkout');
  assert.equal(attributed.body.rows[0].estado, 'AGUARDANDO_PAGAMENTO');
  assert.ok(!attributed.texto.includes('cliente@ce2e.example.test'), 'atribuição não expõe dados de comprador');

  const linhaSale = await cliente.query(`SELECT empresa_id, status FROM sales WHERE id = $1`, [saleId]);
  assert.equal(Number(linhaSale.rows[0].empresa_id), 1, 'sale nasce na empresa do ator (empresa_id explícito)');
  assert.equal(linhaSale.rows[0].status, 'PENDING', 'sale PENDING até o BACKEND confirmar o pagamento');

  const linhaPedido = await cliente.query(`SELECT id, estado, cobranca_id, empresa_id FROM commerce_pedidos WHERE sale_id = $1`, [saleId]);
  assert.equal(linhaPedido.rows[0].estado, 'AGUARDANDO_PAGAMENTO', 'pedido aguardando o backend');
  assert.ok(Number(linhaPedido.rows[0].cobranca_id) > 0, 'cobrança criada pelo backend (gateway)');

  const reservas = await cliente.query(`SELECT status FROM estoque_reservas WHERE origem_recurso = 'commerce_checkout' AND origem_id = (SELECT id FROM commerce_pedidos WHERE sale_id = $1)`, [saleId]);
  assert.equal(reservas.rows.length, 1, 'UMA reserva de checkout ativa');
  assert.equal(reservas.rows[0].status, 'ativa', 'reserva ativa segura a última peça');

  const acompanhamento = await req('GET', `/loja/pedidos/${tokenPedido}`, undefined, null, baseUrl);
  assert.equal(acompanhamento.status, 200, `acompanhamento público: ${msg(acompanhamento)}`);
  assert.equal(acompanhamento.body?.pedido?.estado, 'AGUARDANDO_PAGAMENTO');

  // ---- 8) pagamento: SÓ o webhook do provedor confirma -----------------------
  const cobranca = await cliente.query(`SELECT provider_ref, provider FROM gateway_cobrancas WHERE idempotency_key = $1`, [`checkout:${linhaPedido.rows[0].id}`]);
  assert.equal(cobranca.rows.length, 1, 'exatamente UMA cobrança para o checkout');
  assert.equal(cobranca.rows[0].provider, 'mock', 'em test o provedor é o mock determinístico');
  const refCobranca = String(cobranca.rows[0].provider_ref);

  // prova de contrato: sem webhook, NADA muda o pedido (frontend nunca confirma)
  const antesDoWebhook = await req('GET', `/commerce/pedidos/${saleId}`, undefined, tokenA, baseUrl);
  assert.equal(antesDoWebhook.body?.pedido?.estado, 'AGUARDANDO_PAGAMENTO', 'estado intacto enquanto o webhook não chega');

  const eventoId = `evt-${RODADA}`;
  const corpoEvento = JSON.stringify({ event: 'payment.paid', event_id: eventoId, data: { id: refCobranca }, status: 'pago' });
  const wh = await fetch(`${baseUrl}/api/gateway/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: corpoEvento,
  });
  const whTexto = await wh.text();
  assert.equal(wh.status, 200, `webhook: ${wh.status} ${whTexto}`);
  const whBody = JSON.parse(whTexto);
  assert.equal(whBody.processado, true, `evento processado: ${whTexto}`);
  assert.equal(whBody.resultado, 'paga', `cobrança resolvida como paga: ${whTexto}`);

  const depois = await req('GET', `/commerce/pedidos/${saleId}`, undefined, tokenA, baseUrl);
  assert.equal(depois.status, 200, `detalhe pós-webhook: ${msg(depois)}`);
  // O ouvinte confirma PAGO e já CONVERTE pela ponte (conversão automática) —
  // qualquer um dos dois estados prova que só o webhook moveu o pedido.
  const estadoWebhook = String(depois.body?.pedido?.estado ?? '');
  assert.ok(['PAGO', 'CONVERTIDO'].includes(estadoWebhook), `ouvinte do Commerce OS confirmou o pedido APÓS o webhook: ${estadoWebhook}`);
  const linhaCupom = await cliente.query(`SELECT uso_atual FROM commerce_cupons WHERE codigo = $1`, [codigoCupom]);
  assert.equal(Number(linhaCupom.rows[0].uso_atual), 1, 'pagamento consumiu a ÚNICA uso do cupom');

  const cupomEsgotado = await req('POST', '/loja/preview', { itens, cupom: codigoCupom }, null, baseUrl);
  assert.equal(cupomEsgotado.status, 200, 'preview segue respondendo');
  assert.equal(cupomEsgotado.body?.cupom?.valido, false, 'cupom de uso único agora é inválido (fail-closed)');

  // ---- 9) conversão sales → vendas (ponte), idempotente ----------------------
  const converter = await req('POST', `/commerce/pedidos/${saleId}/converter`, {}, tokenA, baseUrl);
  assert.ok(converter.status === 200 || converter.status === 201, `conversão: ${msg(converter)}`);
  assert.equal(converter.body?.ok, true, `conversão devolve ok: ${msg(converter)}`);
  const vendaId = Number(converter.body?.venda_id);
  assert.ok(vendaId > 0, 'venda operacional criada pela ponte');

  const converter2 = await req('POST', `/commerce/pedidos/${saleId}/converter`, {}, tokenA, baseUrl);
  assert.equal(converter2.status, 200, `reconversão responde: ${msg(converter2)}`);
  assert.equal(Number(converter2.body?.venda_id), vendaId, 'reconversão é idempotente (mesma venda)');

  const vendas = await cliente.query(`SELECT id FROM vendas WHERE id = $1`, [vendaId]);
  assert.equal(vendas.rows.length, 1, 'UMA venda para a sale convertida');
  const itensVenda = await cliente.query(`SELECT count(*)::int AS n FROM itens_venda WHERE venda_id = $1`, [vendaId]);
  assert.equal(Number(itensVenda.rows[0].n), 1, 'UM item na venda convertida');

  const pedidoFinal = await req('GET', `/commerce/pedidos/${saleId}`, undefined, tokenA, baseUrl);
  assert.equal(pedidoFinal.body?.pedido?.estado, 'CONVERTIDO', 'pedido no estado CONVERTIDO');

  // ---- 10) frete fail-closed -------------------------------------------------
  const cfgUpdate = await cliente.query(`UPDATE commerce_configuracoes SET frete_provedor = 'nenhum' WHERE loja_nome LIKE $1`, [`Loja ${RODADA}%`]);
  assert.ok((cfgUpdate.rowCount ?? 0) >= 1, 'configuracao de frete atualizada');
  const semFrete = await req('POST', '/loja/preview', { itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }] }, null, baseUrl);
  assert.equal(semFrete.status, 200, 'preview continua respondendo sem frete');
  assert.equal(semFrete.body?.frete?.disponivel, false, 'frete indisponível quando não configurado');
  const motivo = String(semFrete.body?.frete?.motivo ?? semFrete.body?.frete_motivo ?? '');
  assert.match(motivo, /frete não configurado/i, `mensagem exata de frete não configurado: "${motivo}"`);
  const checkoutSemFrete = await req('POST', '/loja/checkout', {
    chave: `chave2-${RODADA}-${randomUUID().slice(0, 8)}`.slice(0, 64),
    comprador: { nome: 'Sem Frete', email: 'semfrete@ce2e.example.test' },
    itens: [{ produto_id: produtoId, tamanho_id: null, quantidade: 1 }],
  }, null, baseUrl);
  assert.equal(checkoutSemFrete.status, 409, `checkout sem frete recusa com 409: ${msg(checkoutSemFrete)}`);
  assert.match(String(checkoutSemFrete.body?.erro ?? checkoutSemFrete.body?.error ?? ''), /frete/i, `409 explica o frete: ${msg(checkoutSemFrete)}`);

  // ---- 11) RBAC e tenancy no BACKEND ----------------------------------------
  const semToken = await req('GET', '/commerce/pedidos', undefined, null, baseUrl);
  assert.equal(semToken.status, 401, `sem token → 401: ${msg(semToken)}`);

  const escritaOperador = await req('POST', '/commerce/produtos', { produto_id: produtoId }, tokenOp, baseUrl);
  assert.equal(escritaOperador.status, 403, `operador não escreve commerce → 403: ${msg(escritaOperador)}`);

  const leituraB = await req('GET', `/commerce/produtos/${produtoId}`, undefined, tokenB, baseUrl);
  assert.equal(leituraB.status, 404, `outro tenant no detalhe → 404 (nunca vaza): ${msg(leituraB)}`);
  const pedidoB = await req('GET', `/commerce/pedidos/${saleId}`, undefined, tokenB, baseUrl);
  assert.equal(pedidoB.status, 404, `outro tenant no pedido → 404: ${msg(pedidoB)}`);
  const detalheB = await cliente.query(`SELECT id FROM commerce_produtos WHERE id = $1 AND empresa_id = $2`, [pcId, empresaB]);
  assert.equal(detalheB.rows.length, 0, 'nenhuma linha do tenant A aparece para o tenant B');

  // ---- 12) observabilidade responde com dado real ----------------------------
  const trends = await req('GET', '/commerce/trends?dias=30', undefined, tokenA, baseUrl);
  assert.equal(trends.status, 200, `trends: ${msg(trends)}`);
  assert.ok(trends.body?.totais && typeof trends.body.totais.pedidos === 'number', 'trends devolve totais numéricos reais');
  const eventos = await req('GET', '/commerce/eventos', undefined, tokenA, baseUrl);
  assert.equal(eventos.status, 200, `fila/observabilidade: ${msg(eventos)}`);
  assert.ok(Array.isArray(eventos.body?.outbox) && Array.isArray(eventos.body?.publicacoes), 'eventos expõem outbox e publicações');

  void logs;
});
