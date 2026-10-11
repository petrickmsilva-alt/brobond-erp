// ============================================================================
// ERP-04 — FONTE ÚNICA DO FATURAMENTO (fecha o P0-03 e o P1-07).
//
// A evidência que abriu o ciclo: venda faturada pela API do ERP →
// `GET /api/negocios/resumo` devolvia `faturamentoCents: 0, pedidos: 0`,
// enquanto `GET /api/relatorios/vendas` mostrava a venda. O motor analítico
// lia só `sales` (a tabela da fusão do Commerce), e a venda do ERP vive em
// `vendas`/`itens_venda`.
//
// A decisão está registrada em docs/ADR-001-FONTE-UNICA-FATURAMENTO.md:
// `sales` passa a ser o MODELO DE LEITURA derivado, alimentado por uma
// projeção idempotente no namespace `erp:` — nenhuma linha de conector é
// tocada. Este arquivo prova, num BANCO NOVO com servidor real:
//
//   1. vender e faturar pelo fluxo do ERP;
//   2. o BI reflete faturamento, pedidos, ticket médio, CMV, impostos e ABC;
//   3. o faturamento do BI é IGUAL ao do relatório do ERP (tolerância zero);
//   4. a ingestão de canal externo continua intacta e continua somando.
//
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
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
  throw new Error('bi-faturamento-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e04${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_e04_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
}

function urlDoBanco(nome: string): string {
  const url = new URL(String(process.env.DATABASE_URL));
  url.pathname = `/${nome}`;
  return url.toString();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP para o harness.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e04-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E04-${randomUUID()}-OnlyForTest`,
  };
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
        const h = await r.json() as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // schema/migrations do banco novo em andamento
    }
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

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (corpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto };
}

test('ERP-04: venda faturada pelo ERP aparece no BI com os mesmos números do relatório (e canal externo intacto)', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();
  const escalar = async (sql: string, params: unknown[] = []) => (await cliente.query(sql, params)).rows[0];

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  // Usuário por SQL (fixture do teste): o login de `perfil: 'admin'` exige MFA
  // cadastrado; o gerente tem as permissões deste fluxo.
  const email = `${RODADA}@example.test`;
  const senha = `E04-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Admin ${RODADA}`, email, await hashPassword(senha)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email]);
  const usuarioId = Number((await escalar(`SELECT id FROM usuarios WHERE email = $1`, [email]))?.id);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login precisa funcionar num banco novo: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login precisa emitir JWT');

  // ---- Cadastros mínimos (o mesmo caminho do operador) --------------------
  const cnpjValido = '11222333000181';
  const clienteRes = await req(baseUrl, 'POST', '/clientes', { nome: `Cliente ${RODADA}`, cnpj_cpf: cnpjValido }, token);
  assert.equal(clienteRes.status, 201, `cliente: ${clienteRes.texto}`);

  const produto = await req(baseUrl, 'POST', '/produtos', {
    sku: `E04-${RODADA}`.toUpperCase().slice(0, 30),
    nome: `Produto ${RODADA}`,
    preco_venda: 100,
    custo: 40,
    ncm: '61091000',
  }, token);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const produtoId = Number(produto.body.id);

  const tamanho = await req(baseUrl, 'POST', '/tamanhos', { codigo: RODADA.slice(-5).toUpperCase(), descricao: 'E04', ordem: 950 }, token);
  assert.ok([200, 201].includes(tamanho.status), `tamanho: ${tamanho.texto}`);
  const tamanhoId = Number(tamanho.body.id);

  const imposto = await req(baseUrl, 'POST', '/impostos_ncm', { descricao: `Padrão ${RODADA}`, aliquota_pct: 10 }, token);
  assert.ok([200, 201].includes(imposto.status), `alíquota padrão: ${imposto.texto}`);

  // ---- Estoque: a primeira operação também provisiona o Local padrão (ERP-03)
  const entrada = await req(baseUrl, 'POST', '/movimentacoes', {
    tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 5, motivo: `Saldo inicial ${RODADA}`,
  }, token);
  assert.ok([200, 201].includes(entrada.status), `entrada de estoque: ${entrada.texto}`);

  // ---- VENDA ponta a ponta: pedido → item → faturamento -------------------
  const hoje = new Date().toISOString().slice(0, 10);
  const venda = await req(baseUrl, 'POST', '/vendas', {
    cliente_id: Number(clienteRes.body.id), data: hoje, canal_venda: 'site_varejo', status: 'aberta',
  }, token);
  assert.ok([200, 201].includes(venda.status), `venda: ${venda.texto}`);
  const vendaId = Number(venda.body.id);

  const item = await req(baseUrl, 'POST', `/vendas/${vendaId}/itens`, {
    produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2, preco_unitario: 100, desconto_pct: 0,
  }, token);
  assert.ok([200, 201].includes(item.status), `item da venda: ${item.texto}`);

  const faturada = await req(baseUrl, 'PUT', `/vendas/${vendaId}`, { status: 'faturada' }, token);
  assert.equal(faturada.status, 200, `faturamento: ${faturada.texto}\n--- log do servidor ---\n${logs().slice(-4000)}`);

  // ---- O BI precisa refletir a operação (gancho pós-faturamento) ----------
  // O gancho agenda a projeção com debounce; a espera documenta esse ciclo.
  let resumo: any = null;
  const limite = Date.now() + 45_000;
  while (Date.now() < limite) {
    const r = await req(baseUrl, 'GET', '/negocios/resumo', undefined, token);
    assert.equal(r.status, 200, `resumo precisa responder: ${r.texto}`);
    resumo = r.body;
    // Espera o número FECHAR (a venda aparece com margem materializada na
    // mesma transação da projeção — este laço documenta o ciclo do ADR).
    if (Number(resumo?.kpis?.pedidos || 0) >= 1 && Number(resumo?.kpis?.faturamentoCents || 0) === 20000) break;
    await delay(500);
  }

  assert.equal(Number(resumo?.kpis?.pedidos), 1, `o BI precisa enxergar a venda faturada pelo ERP (faturamento=${resumo?.kpis?.faturamentoCents})\n${logs().slice(-3000)}`);
  assert.equal(
    Number(resumo?.kpis?.faturamentoCents),
    20000,
    `faturamento = 2 × R$ 100,00 em centavos\n--- log do servidor ---\n${logs().slice(-4000)}`,
  );
  assert.equal(Number(resumo?.kpis?.ticketMedioCents), 20000, 'ticket médio da única venda faturada');
  assert.equal(Number(resumo?.kpis?.cmvCents), 8000, 'CMV = 2 × custo R$ 40,00 (ficha ausente → produtos.custo)');
  assert.equal(Number(resumo?.kpis?.impostosCents), 2000, 'impostos = 10% de R$ 200,00 (alíquota padrão)');
  assert.equal(Number(resumo?.kpis?.lucroBrutoCents), 10000, 'lucro bruto = 20000 − 8000 − 2000 − 0');
  assert.equal(Number(resumo?.kpis?.semMargemCalculada), 0, 'a margem da venda do ERP precisa estar materializada');

  const canalEcommerce = (resumo?.porCanal || []).find((c: any) => c.grupo === 'ecommerce');
  assert.equal(Number(canalEcommerce?.faturamentoCents), 20000, 'a venda do ERP entra no grupo de canal certo');

  // ---- Critério de igualdade: BI == relatório do ERP (tolerância zero) ----
  const linhaVenda = await escalar(`SELECT faturada_em FROM vendas WHERE id = $1`, [vendaId]);
  const diaFaturada = String(linhaVenda?.faturada_em?.toISOString?.() ?? '').slice(0, 10) || hoje;
  const relatorio = await req(baseUrl, 'GET', `/relatorios/faturamento?de=${diaFaturada}&ate=${diaFaturada}`, undefined, token);
  assert.equal(relatorio.status, 200, `relatório de faturamento: ${relatorio.texto}`);
  assert.equal(
    Math.round(Number(relatorio.body?.resumo?.faturamento || 0) * 100),
    Number(resumo?.kpis?.faturamentoCents),
    `BI (${resumo?.kpis?.faturamentoCents} cents) precisa bater com o relatório do ERP (${relatorio.body?.resumo?.faturamento})\n${logs().slice(-3000)}`,
  );

  // ---- Curva ABC classifica o produto vendido pelo ERP -------------------
  const abc = await req(baseUrl, 'GET', '/negocios/abc', undefined, token);
  assert.equal(abc.status, 200, `curva ABC: ${abc.texto}`);
  const linhaAbc = (abc.body?.linhas || []).find((l: any) => Number(l.produtoId) === produtoId);
  assert.ok(linhaAbc, `o produto vendido pelo ERP precisa aparecer na curva ABC: ${abc.texto}`);
  assert.equal(String(linhaAbc.classe), 'A', 'único produto faturado → classe A');
  assert.equal(Number(linhaAbc.faturamentoCents), 20000);

  // ---- A projeção vive no namespace `erp:` (e é re-derivável) ------------
  const projecao = await escalar(`SELECT status, amount_cents, channel, empresa_id, occurred_at FROM sales WHERE id = $1`, [`erp:venda:${vendaId}`]);
  assert.ok(projecao, 'existe a linha projetada `erp:venda:<id>`');
  assert.equal(String(projecao.status), 'PAID');
  assert.equal(Number(projecao.amount_cents), 20000);
  assert.equal(String(projecao.channel), 'BROBOND', 'canal do ERP (site_varejo) → canal próprio');
  assert.equal(Number(projecao.empresa_id), 1);
  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM sale_items WHERE id LIKE 'erp:item:%'`))?.n), 1);

  // ---- NÃO-REGRESSÃO: a ingestão de canal externo continua intacta -------
  // Mesma forma que `modules/connectors/ingestion/sales.service.ts` grava.
  await cliente.query(
    `INSERT INTO sales (id, reference, quantity, amount_cents, currency, status, occurred_at,
                        channel, external_order_id, usuario_id, empresa_id, freight_cents, created_at, updated_at)
     VALUES ('ext:e04', 'ext:e04', 1, 5000, 'BRL', 'PAID', now(), 'NUVEMSHOP', 'EXT-E04-1', $1, 1, 0, now(), now())`,
    [usuarioId],
  );
  await cliente.query(
    `INSERT INTO sale_items (id, sale_id, product_id, size_id, variacao_externa, quantity,
                             unit_price_cents, discount_cents, subtotal_cents, created_at)
     VALUES ('ext:e04:item', 'ext:e04', $1, $2, 'M', 1, 5000, 0, 5000, now())`,
    [produtoId, tamanhoId],
  );
  const antesExterno = await escalar(`SELECT * FROM sales WHERE id = 'ext:e04'`);

  // Recalcular sob demanda RODA a projeção (terceira via do ADR) — e não pode
  // encostar na linha do conector.
  const recalculo = await req(baseUrl, 'POST', '/negocios/margens/recalcular', {}, token);
  assert.equal(recalculo.status, 200, `recalcular: ${recalculo.texto}`);
  assert.equal(Number(recalculo.body?.vendasErp), 1, 'a sincronização reprojeta a venda do ERP (idempotente)');

  const depoisExterno = await escalar(`SELECT * FROM sales WHERE id = 'ext:e04'`);
  for (const campo of ['id', 'reference', 'quantity', 'amount_cents', 'currency', 'status', 'channel', 'external_order_id', 'usuario_id', 'empresa_id', 'freight_cents']) {
    assert.deepEqual(depoisExterno[campo], antesExterno[campo], `a projeção não pode alterar o campo ${campo} de uma venda de canal externo`);
  }
  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM sales WHERE id LIKE 'erp:%'`))?.n), 1, 'nenhuma linha erp: duplicada');
  assert.equal(Number((await escalar(`SELECT count(*)::int AS n FROM sales WHERE id LIKE 'ext:%'`))?.n), 1, 'nenhuma linha de conector duplicada');

  // O BI soma as duas origens: ERP (20000) + canal externo (5000).
  const resumoFinal = await req(baseUrl, 'GET', '/negocios/resumo', undefined, token);
  assert.equal(Number(resumoFinal.body?.kpis?.faturamentoCents), 25000, 'o BI soma ERP e canal externo');
  assert.equal(Number(resumoFinal.body?.kpis?.pedidos), 2);
});
