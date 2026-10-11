// ============================================================================
// ERP-08 — DEVOLUÇÃO PONTA A PONTA EM POSTGRESQL (P1-09).
//
// A cadeia de reversa existia inteira no código (rotas, tela, testes de
// componente) e NUNCA havia sido executada como prova contra o banco real: era
// o último fluxo do §13 do relatório sem arquivo PostgreSQL dedicado. Esta é a
// prova, num BANCO NOVO com o servidor de verdade, percorrendo o caminho da
// tela (`/devolucoes`) pela API:
//
//   1. VENDA faturada → estoque baixado (saída canônica com `venda_id`);
//   2. devolução PARCIAL (2 de 3 unidades): receber as duas em BOM sobe o
//      saldo, e a venda NÃO é cancelada — o financeiro fica intocado;
//   3. a segunda devolução (1 unidade) volta AVARIADA: registra o estado,
//      NÃO entra no estoque e NÃO gera movimentação de entrada;
//   4. com o pedido inteiro "devolvido" (recebido = vendido), o recebimento
//      cancela a venda e reverte o financeiro — e o estorno da venda não pode
//      ser uma porta de volta para a unidade avariada: `restaurar = saídas −
//      já recebido (qualquer estado)` ⇒ saldo fica igual;
//   5. estados inválidos são recusados com 409/400 explicativos: receber sem
//      autorizar, sem rastreamento, duas vezes (estoque não sobe duas vezes),
//      devolver mais do que foi vendido, receber devolução recusada;
//   6. idempotência por `idempotency-key`: a repetição devolve a MESMA
//      devolução (`idempotente: true`) em vez de criar uma segunda;
//   7. MULTIEMPRESA: a empresa B não lê, não cria devolução da venda de A e não
//      recebe a devolução de A (404) — e nada disso muda o estoque de A.
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
  throw new Error('devolucao-e2e.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e08${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

function nomeDoBancoNovo(): string {
  return `brobond_e08_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startRealServer(port: number, databaseUrl: string): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e08-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E08-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => {
    output = `${output}${String(chunk)}`.slice(-40_000);
  };
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
    } catch {
      // migrações do banco novo em andamento
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string, headers?: Record<string, string>): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json', ...(headers || {}) };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(texto);
  } catch {
    body = null;
  }
  return { status: r.status, body, texto };
}

test('ERP-08/P1-09: devolução parcial devolve só o BOM estado, o avariado não volta nem pelo estorno, e o total cancela a venda', async (t) => {
  const nome = nomeDoBancoNovo();
  await query(`CREATE DATABASE ${nome}`);
  const databaseUrl = urlDoBanco(nome);

  const porta = await reservePort();
  const { child, baseUrl, logs } = await startRealServer(porta, databaseUrl);

  const cliente = new Client({ connectionString: databaseUrl });
  await cliente.connect();

  t.after(async () => {
    await cliente.end().catch(() => undefined);
    await stopServer(child);
    await query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined);
  });

  // ---- Atores: gerente da empresa 1 (padrão) e gerente da empresa B --------
  const emailA = `e08-a-${RODADA}@example.test`;
  const senhaA = `E08-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Gerente A ${RODADA}`, emailA, await hashPassword(senhaA)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [emailA]);

  const empresaB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial Devolução ${RODADA}`]);
  const empresaBId = Number(empresaB.rows[0].id);
  const emailB = `e08-b-${RODADA}@example.test`;
  const senhaB = `E08-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now())`,
    [`Gerente B ${RODADA}`, emailB, await hashPassword(senhaB), empresaBId],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [emailB, empresaBId]);

  const loginA = await req(baseUrl, 'POST', '/auth/login', { email: emailA, password: senhaA });
  assert.equal(loginA.status, 200, `login A: ${loginA.texto}`);
  const tokenA = String(loginA.body?.token || '');
  const loginB = await req(baseUrl, 'POST', '/auth/login', { email: emailB, password: senhaB });
  assert.equal(loginB.status, 200, `login B: ${loginB.texto}`);
  const tokenB = String(loginB.body?.token || '');
  assert.ok(tokenA.length > 20 && tokenB.length > 20, 'os dois logins precisam emitir JWT');

  // ---- Cadastros, saldo e venda faturada -----------------------------------
  const clienteRes = await req(baseUrl, 'POST', '/clientes', { nome: `Cliente ${RODADA}`, cnpj_cpf: '11222333000181' }, tokenA);
  assert.equal(clienteRes.status, 201, `cliente: ${clienteRes.texto}`);

  const produto = await req(baseUrl, 'POST', '/produtos', { sku: `E08-${RODADA}`.toUpperCase().slice(0, 30), nome: `Produto ${RODADA}`, preco_venda: 1000, custo: 400 }, tokenA);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const produtoId = Number(produto.body.id);

  const tamanho = await req(baseUrl, 'POST', '/tamanhos', { codigo: RODADA.slice(-5).toUpperCase(), descricao: 'E08', ordem: 952 }, tokenA);
  assert.ok([200, 201].includes(tamanho.status), `tamanho: ${tamanho.texto}`);
  const tamanhoId = Number(tamanho.body.id);

  const entrada = await req(baseUrl, 'POST', '/movimentacoes', { tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 5, motivo: `Saldo ${RODADA}` }, tokenA);
  assert.ok([200, 201].includes(entrada.status), `entrada: ${entrada.texto}`);

  /** Saldo do produto/tamanho nas linhas de estoque da empresa 1 (soma, se houver mais de um local). */
  async function saldo(): Promise<number> {
    const r = await cliente.query(`SELECT COALESCE(sum(quantidade), 0)::int AS n FROM estoques WHERE empresa_id = 1 AND produto_id = $1 AND tamanho_id = $2`, [produtoId, tamanhoId]);
    return Number(r.rows[0].n);
  }
  assert.equal(await saldo(), 5, 'o saldo inicial entrou no estoque');

  const hoje = new Date().toISOString().slice(0, 10);
  const venda = await req(baseUrl, 'POST', '/vendas', { cliente_id: Number(clienteRes.body.id), data: hoje, status: 'aberta' }, tokenA);
  assert.ok([200, 201].includes(venda.status), `venda: ${venda.texto}`);
  const vendaId = Number(venda.body.id);
  const itemVenda = await req(baseUrl, 'POST', `/vendas/${vendaId}/itens`, { produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 3, preco_unitario: 1000, desconto_pct: 0 }, tokenA);
  assert.ok([200, 201].includes(itemVenda.status), `item da venda: ${itemVenda.texto}`);

  const faturada = await req(baseUrl, 'PUT', `/vendas/${vendaId}`, { status: 'faturada' }, tokenA);
  assert.equal(faturada.status, 200, `faturamento: ${faturada.texto}\n${logs().slice(-3000)}`);
  assert.equal(await saldo(), 2, 'faturar baixou as 3 unidades vendidas');

  const saidas = await cliente.query(`SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id = 1 AND venda_id = $1 AND tipo = 'saida'`, [vendaId]);
  assert.ok(Number(saidas.rows[0].n) >= 1, 'a baixa do faturamento é uma saída canônica com venda_id');

  const lancamentosAntes = await req(baseUrl, 'GET', `/lancamentos_financeiros?page=1&pageSize=50&f.referencia_id=${vendaId}&f.referencia_tipo=venda`, undefined, tokenA);
  assert.equal(lancamentosAntes.status, 200, `lançamentos da venda: ${lancamentosAntes.texto}`);
  const parcela = (lancamentosAntes.body?.rows || [])[0];
  assert.ok(parcela, 'a venda faturada gera conta a receber (financeiro do ciclo)');
  assert.notEqual(String(parcela.status), 'cancelado', 'antes da devolução total a parcela está ativa');

  // ---- 1) DEVOLUÇÃO PARCIAL: 2 das 3 unidades ------------------------------
  const dev1 = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaId, motivo: `Defeito em 2 peças ${RODADA}`, tipo: 'devolucao', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2 }] }, tokenA);
  assert.equal(dev1.status, 201, `criar devolução: ${dev1.texto}`);
  const dev1Id = Number(dev1.body?.id);
  assert.equal(String(dev1.body?.status), 'solicitada');
  const dev1ItemId = Number(dev1.body?.itens?.[0]?.id);
  assert.ok(dev1Id > 0 && dev1ItemId > 0, 'a devolução nasce com item identificado');
  assert.deepEqual(dev1.body?.proximas_acoes, ['autorizar', 'recusar', 'cancelar'], 'o servidor diz o que a tela pode oferecer');

  // Sem autorização não há recebimento; sem rastreamento não há estoque.
  const receberCedo = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/receber`, {}, tokenA);
  assert.equal(receberCedo.status, 409, `receber antes de autorizar: ${receberCedo.texto}`);
  assert.match(String(receberCedo.body?.error || ''), /Autorize/i);

  const autorizada = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/autorizar`, { autorizacao_codigo: `AUT-${RODADA}`.slice(0, 60) }, tokenA);
  assert.equal(autorizada.status, 200, `autorizar: ${autorizada.texto}`);
  assert.equal(String(autorizada.body?.status), 'autorizada');

  const semRastreio = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/receber`, { itens: [{ id: dev1ItemId, quantidade_recebida: 2, estado: 'bom' }] }, tokenA);
  assert.equal(semRastreio.status, 409, `receber sem rastreamento: ${semRastreio.texto}`);
  assert.match(String(semRastreio.body?.error || ''), /rastreabilidade|rastreamento/i);
  assert.equal(await saldo(), 2, 'a recusa não mexeu no estoque');

  const rastreio = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/rastreamento`, { codigo_rastreamento: `BR${RODADA}`.slice(0, 30), transportadora: 'Correios' }, tokenA);
  assert.equal(rastreio.status, 200, `rastreamento: ${rastreio.texto}`);
  assert.equal(String(rastreio.body?.status), 'em_transito');

  // O saldo devolvível é vendido − (recebido + em devolução): já há 2 reservadas,
  // então uma nova devolução de 2 (que somaria 4 de 3 vendidas) é recusada.
  const excedente = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaId, motivo: `Tentativa excedente ${RODADA}`, itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2 }] }, tokenA);
  assert.equal(excedente.status, 409, `devolver mais do que o vendido: ${excedente.texto}`);
  assert.match(String(excedente.body?.error || ''), /em devolução/i);

  const recebida1 = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/receber`, { itens: [{ id: dev1ItemId, quantidade_recebida: 2, estado: 'bom' }] }, tokenA);
  assert.equal(recebida1.status, 200, `receber parcial: ${recebida1.texto}\n${logs().slice(-2000)}`);
  assert.equal(Number(recebida1.body?.total_recebido), 2);
  assert.equal((recebida1.body?.entradas_estoque || []).length, 1, 'uma entrada de estoque para o item bom');
  assert.equal(await saldo(), 4, 'as 2 peças boas voltaram ao saldo vendável');
  assert.equal(String(recebida1.body?.devolucao?.status), 'recebida');
  assert.equal(recebida1.body?.financeiro?.aplicado, false, 'devolução PARCIAL não reverte o financeiro da venda');
  assert.match(String(recebida1.body?.financeiro?.motivo || ''), /parcial/i);

  const vendaAposParcial = await req(baseUrl, 'GET', `/vendas/${vendaId}`, undefined, tokenA);
  assert.equal(String(vendaAposParcial.body?.status), 'faturada', 'a venda segue faturada depois da devolução parcial');
  const parcelaAposParcial = await req(baseUrl, 'GET', `/lancamentos_financeiros?page=1&pageSize=50&f.referencia_id=${vendaId}&f.referencia_tipo=venda`, undefined, tokenA);
  assert.equal(String(parcelaAposParcial.body?.rows?.[0]?.status), String(parcela.status), 'a conta a receber não foi mexida na devolução parcial');

  const receberDeNovo = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/receber`, { itens: [{ id: dev1ItemId, quantidade_recebida: 2, estado: 'bom' }] }, tokenA);
  assert.equal(receberDeNovo.status, 409, 'receber duas vezes a mesma devolução é recusado');
  assert.match(String(receberDeNovo.body?.error || ''), /já foi recebida/i);
  assert.equal(await saldo(), 4, 'o estoque não subiu duas vezes');

  const movimentos1 = await cliente.query(`SELECT count(*)::int AS n, COALESCE(sum(quantidade), 0)::int AS q FROM movimentacoes WHERE empresa_id = 1 AND venda_id = $1 AND tipo = 'entrada' AND motivo LIKE 'Devolução #%'`, [vendaId]);
  assert.equal(Number(movimentos1.rows[0].n), 1, 'uma única movimentação de devolução até aqui');
  assert.equal(Number(movimentos1.rows[0].q), 2, 'a movimentação de devolução tem a quantidade recebida em bom estado');

  // ---- 2) A ÚLTIMA UNIDADE VOLTA AVARIADA ----------------------------------
  const dev2 = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaId, motivo: `Peça avariada no transporte ${RODADA}`, tipo: 'devolucao', itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }, tokenA);
  assert.equal(dev2.status, 201, `segunda devolução: ${dev2.texto}`);
  const dev2Id = Number(dev2.body?.id);
  const dev2ItemId = Number(dev2.body?.itens?.[0]?.id);
  await req(baseUrl, 'POST', `/devolucoes/${dev2Id}/autorizar`, {}, tokenA);
  await req(baseUrl, 'POST', `/devolucoes/${dev2Id}/rastreamento`, { codigo_rastreamento: `BR2${RODADA}`.slice(0, 30) }, tokenA);

  const recebida2 = await req(baseUrl, 'POST', `/devolucoes/${dev2Id}/receber`, { itens: [{ id: dev2ItemId, quantidade_recebida: 1, estado: 'avariado' }] }, tokenA);
  assert.equal(recebida2.status, 200, `receber avariado: ${recebida2.texto}\n${logs().slice(-2000)}`);
  assert.equal(Number(recebida2.body?.total_recebido), 1, 'a unidade foi recebida (registrada)');
  assert.equal((recebida2.body?.entradas_estoque || []).length, 0, 'mas NENHUMA entrada de estoque para o item avariado');

  const itemAvariado = await cliente.query(`SELECT estado, quantidade_recebida, devolucao_estoque FROM devolucao_itens WHERE id = $1`, [dev2ItemId]);
  assert.equal(String(itemAvariado.rows[0].estado), 'avariado', 'o estado do item fica registrado');
  assert.equal(Number(itemAvariado.rows[0].quantidade_recebida), 1);
  assert.equal(itemAvariado.rows[0].devolucao_estoque, false, 'item avariado não entra no estoque vendável');

  const movimentos2 = await cliente.query(`SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id = 1 AND venda_id = $1 AND tipo = 'entrada' AND motivo LIKE 'Devolução #%'`, [vendaId]);
  assert.equal(Number(movimentos2.rows[0].n), 1, 'a unidade avariada NÃO gerou movimentação de entrada');

  // Com 3 recebidas de 3 vendidas, o pedido está inteiramente devolvido: a venda
  // é cancelada e o financeiro revertido — este é o elo que liga devolução e
  // financeiro, e ele só dispara no TODO.
  assert.equal(recebida2.body?.financeiro?.aplicado, true, 'devolução total cancela a venda e reverte o financeiro');
  const vendaFinal = await req(baseUrl, 'GET', `/vendas/${vendaId}`, undefined, tokenA);
  assert.equal(String(vendaFinal.body?.status), 'cancelada', 'a venda totalmente devolvida fica cancelada');
  const parcelaFinal = await req(baseUrl, 'GET', `/lancamentos_financeiros?page=1&pageSize=50&f.referencia_id=${vendaId}&f.referencia_tipo=venda`, undefined, tokenA);
  assert.equal(String(parcelaFinal.body?.rows?.[0]?.status), 'cancelado', 'a conta a receber da venda foi cancelada junto');

  // O estorno da venda cancelada NÃO pode ressuscitar a unidade avariada:
  // restaurar = saídas (3) − já recebido em devolução (2 bom + 1 avariado) = 0.
  assert.equal(await saldo(), 4, 'o estorno não devolve a unidade avariada ao saldo: 2 boas voltaram, a avariada não');

  // ---- 3) Idempotência por chave e recusas de estado -----------------------
  const chave = `idem-${RODADA}`;
  const vendaIdem = await req(baseUrl, 'POST', '/vendas', { cliente_id: Number(clienteRes.body.id), data: hoje, status: 'aberta' }, tokenA);
  const vendaIdemId = Number(vendaIdem.body.id);
  await req(baseUrl, 'POST', `/vendas/${vendaIdemId}/itens`, { produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1, preco_unitario: 1000 }, tokenA);
  await req(baseUrl, 'PUT', `/vendas/${vendaIdemId}`, { status: 'faturada' }, tokenA);
  assert.equal(await saldo(), 3, 'a segunda venda baixou a sua unidade');

  const idem1 = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaIdemId, motivo: `Idempotência ${RODADA}`, itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }, tokenA, { 'idempotency-key': chave });
  assert.equal(idem1.status, 201, `primeira solicitação: ${idem1.texto}`);
  const idem2 = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaIdemId, motivo: `Idempotência ${RODADA}`, itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1 }] }, tokenA, { 'idempotency-key': chave });
  assert.equal(idem2.status, 200, `repetição idempotente: ${idem2.texto}`);
  assert.equal(idem2.body?.idempotente, true, 'a repetição devolve a MESMA devolução');
  assert.equal(Number(idem2.body?.id), Number(idem1.body?.id), 'não nasceu uma segunda devolução');
  const totalDevolucoes = await cliente.query(`SELECT count(*)::int AS n FROM devolucoes WHERE venda_id = $1`, [vendaIdemId]);
  assert.equal(Number(totalDevolucoes.rows[0].n), 1, 'a chave de idempotência impediu a duplicata no banco');

  const recusada = await req(baseUrl, 'POST', `/devolucoes/${Number(idem1.body?.id)}/recusar`, { motivo: 'Recusada no teste' }, tokenA);
  assert.equal(recusada.status, 200, `recusar: ${recusada.texto}`);
  assert.equal(String(recusada.body?.status), 'recusada');
  const receberRecusada = await req(baseUrl, 'POST', `/devolucoes/${Number(idem1.body?.id)}/receber`, {}, tokenA);
  assert.equal(receberRecusada.status, 409, `receber recusada: ${receberRecusada.texto}`);
  assert.match(String(receberRecusada.body?.error || ''), /recusada|não pode ser recebida/i);

  // ---- 4) Multiempresa: B não alcança a devolução de A ---------------------
  const lerDeB = await req(baseUrl, 'GET', `/devolucoes/${dev1Id}`, undefined, tokenB);
  assert.equal(lerDeB.status, 404, `B lendo a devolução de A: ${lerDeB.texto}`);
  const criarDeB = await req(baseUrl, 'POST', '/devolucoes', { venda_id: vendaId, motivo: `Tentativa de B ${RODADA}` }, tokenB);
  assert.equal(criarDeB.status, 404, `B criando devolução para venda de A: ${criarDeB.texto}`);
  const receberDeB = await req(baseUrl, 'POST', `/devolucoes/${dev1Id}/receber`, {}, tokenB);
  assert.equal(receberDeB.status, 404, `B recebendo devolução de A: ${receberDeB.texto}`);
  const saldoFinal = await saldo();
  assert.equal(saldoFinal, 3, 'as tentativas da empresa B não moveram o estoque de A (3 = 4 − 1 vendida na venda idempotente)');

  // ---- 5) Auditoria: cada passo da cadeia deixou rastro --------------------
  const auditoria = await cliente.query(`SELECT acao, descricao FROM auditoria WHERE recurso = 'devolucoes' AND registro_id = $1 ORDER BY id`, [dev1Id]);
  assert.ok(auditoria.rows.length >= 3, `a devolução tem trilha de auditoria (criar, autorizar, receber) — veio ${auditoria.rows.length}`);
  const descricoes = auditoria.rows.map((r) => String(r.descricao)).join(' | ');
  assert.match(descricoes, /solicitada/i);
  assert.match(descricoes, /autorizada/i);
  assert.match(descricoes, /recebida/i);
  assert.doesNotMatch(logs(), /Erro interno do servidor/, 'nenhuma operação pode virar 500');
});
