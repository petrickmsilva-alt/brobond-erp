// ============================================================================
// ERP-02 — MATRIZ COMPLETA DA REABERTURA/ESTORNO DE OP EM POSTGRESQL REAL.
//
// Este arquivo fecha os gates do ciclo que o arquivo `e02-ordem-reabrir-postgresql`
// cobre apenas no caso feliz: o estorno precisa continuar correto quando a OP é
// CONCLUÍDA DE NOVO depois da reabertura, quando duas operações disputam a mesma
// OP, quando o estorno não cabe no saldo, quando a empresa é outra e quando há
// perda de peças e custo real em jogo.
//
// Caminho exercitado: HTTP real (Express de verdade, JWT de verdade, PgStore,
// PostgreSQL real) — o fluxo da OP inteiro pela API, como o operador faz.
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
//
// Cenários:
//   A) ciclo completo: concluir → reabrir → concluir → reabrir (idempotência do
//      estorno e RE-CONSUMO de insumos na segunda conclusão, custo real líquido);
//   B) concorrência: dois estornos simultâneos (com e sem saldo sobrando) e duas
//      conclusões simultâneas — uma única transição válida, nenhum efeito duplicado;
//   C) rollback: OP por grade em que o estorno falha na 2ª linha — nada muda;
//   D) multiempresa: B não lê/estorna/aponta na OP de A; o estorno de A não toca B;
//   E) perdas e custo: o estorno devolve o insumo, zera o custo real da OP em
//      aberto e PRESERVA o histórico (evento `reaberta` + auditoria + movimentos);
//   F) causa-raiz (SQL): `INSERT ... ON CONFLICT DO UPDATE` avalia o CHECK no
//      tuple PROPOSTO — o delta negativo direto é 23514 mesmo com saldo — e o
//      UPDATE condicional é o primitivo correto do estorno.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('e02-reabertura-estorno-postgresql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e02m${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (prefixo: string) => `${prefixo}-${RODADA}-${++contador}`;

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e02m-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E02M-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`O servidor encerrou antes do health check.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch {
      // bootstrap/migrations em andamento
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 90 s.\n${output}`);
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Contexto = { empresaId: number; usuarioId: number; token: string; baseUrl: string; localId: number };

async function novoContexto(baseUrl: string): Promise<Contexto> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query<{ id: number }>(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa E02M'), cnpj]);
  const empresaId = Number(emp.rows[0].id);
  const email = `${unico('e02m')}@example.test`;
  const senha = `E02M-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const usr = await query<{ id: number }>(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [unico('Gerente E02M'), email, senhaHash, empresaId],
  );
  const usuarioId = Number(usr.rows[0].id);
  await query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [usuarioId, empresaId]);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login precisa funcionar: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login precisa emitir JWT');

  const local = await req(baseUrl, 'POST', '/locais', { nome: unico('Loja E02M'), tipo: 'loja', ativo: true, padrao: true, empresa_id: empresaId }, token);
  assert.equal(local.status, 201, `local padrao precisa ser criado: ${local.texto}`);
  return { empresaId, usuarioId, token, baseUrl, localId: Number(local.body?.id) };
}

type Kit = { produtoId: number; insumoId: number; tamanhoId: number; fichaId: number; localId: number };

/** Insumo → produto → tamanho → ficha com UMA linha de consumo. */
async function kit(
  c: Contexto,
  opts: { saldoInsumo?: number; consumo?: number; custoInsumo?: number; maoObra?: number; indiretos?: number } = {},
): Promise<Kit> {
  // O custo que a ficha usa é o `custo_medio` do insumo (é o valor que o
  // recebimento de compra mantém e o que a OP consome no custo real).
  const insumo = await req(c.baseUrl, 'POST', '/insumos', { nome: unico('Insumo E02M'), unidade: 'm', custo_medio: opts.custoInsumo ?? 10, empresa_id: c.empresaId }, c.token);
  assert.equal(insumo.status, 201, `insumo: ${insumo.texto}`);
  const insumoId = Number(insumo.body.id);

  const produto = await req(c.baseUrl, 'POST', '/produtos', { sku: unico('SKU-E02M'), nome: unico('Produto E02M'), preco_venda: 100, custo: 30, empresa_id: c.empresaId }, c.token);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const produtoId = Number(produto.body.id);

  const tamanho = await req(c.baseUrl, 'POST', '/tamanhos', { codigo: unico('T').slice(-6).toUpperCase(), descricao: 'E02M', ordem: 900 }, c.token);
  assert.equal(tamanho.status, 201, `tamanho: ${tamanho.texto}`);
  const tamanhoId = Number(tamanho.body.id);

  const entrada = await req(c.baseUrl, 'POST', '/movimentacoes_insumos', { tipo: 'entrada', insumo_id: insumoId, quantidade: opts.saldoInsumo ?? 1000, custo_unitario: opts.custoInsumo ?? 10, motivo: 'Saldo inicial E02M' }, c.token);
  assert.ok([200, 201].includes(entrada.status), `saldo do insumo: ${entrada.texto}`);

  const ficha = await req(c.baseUrl, 'POST', '/fichas', { produto_id: produtoId, mao_obra: opts.maoObra ?? 0, custos_indiretos: opts.indiretos ?? 0, margem_pct: 100 }, c.token);
  assert.equal(ficha.status, 201, `ficha: ${ficha.texto}`);
  const fichaId = Number(ficha.body.id);
  const item = await req(c.baseUrl, 'POST', `/fichas/${fichaId}/insumos`, { insumo_id: insumoId, consumo: opts.consumo ?? 2, perda_pct: 0 }, c.token);
  assert.ok([200, 201].includes(item.status), `item da ficha: ${item.texto}`);

  return { produtoId, insumoId, tamanhoId, fichaId, localId: c.localId };
}

/** Cria a OP por tamanho, libera, aponta e conclui — pela API, como o operador. */
async function cicloConclusao(c: Contexto, k: Kit, quantidade: number, opts: { perdida?: number } = {}): Promise<number> {
  const ordem = await req(c.baseUrl, 'POST', '/ordens', { produto_id: k.produtoId, tipo: 'tamanho', tamanho_id: k.tamanhoId, quantidade, status: 'planejada', previsao: new Date().toISOString().slice(0, 10) }, c.token);
  assert.equal(ordem.status, 201, `ordem: ${ordem.texto}`);
  const ordemId = Number(ordem.body.id);

  const liberada = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada.status, 200, `liberar: ${liberada.texto}`);

  const apontamento = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/apontamentos`, { quantidade_produzida: quantidade, quantidade_perdida: opts.perdida ?? 0, idempotency_key: unico('e02m') }, c.token);
  assert.equal(apontamento.status, 201, `apontamento: ${apontamento.texto}`);

  const concluida = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token);
  assert.equal(concluida.status, 200, `concluir: ${concluida.texto}`);
  assert.equal(concluida.body.status, 'concluida');
  return ordemId;
}

async function saldoProduto(c: Contexto, produtoId: number, tamanhoId: number | null): Promise<number> {
  const r = await query<{ quantidade: string }>(
    `SELECT quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id IS NOT DISTINCT FROM $3 AND local_id = $4`,
    [c.empresaId, produtoId, tamanhoId, c.localId],
  );
  return r.rows[0] ? Number(r.rows[0].quantidade) : 0;
}

async function saldoInsumo(insumoId: number): Promise<number> {
  const r = await query<{ quantidade: string }>(`SELECT quantidade FROM estoque_insumos WHERE insumo_id = $1`, [insumoId]);
  return r.rows[0] ? Number(r.rows[0].quantidade) : 0;
}

type EstadoOp = { status: string; quantidade_produzida: number; quantidade_perdida: number; custo_real: number; custo_previsto: number | null; concluida_em: string | null };

async function estadoOp(ordemId: number): Promise<EstadoOp> {
  const r = await query<any>(`SELECT status, quantidade_produzida, quantidade_perdida, custo_real, custo_previsto, concluida_em FROM ordens_fabricacao WHERE id = $1`, [ordemId]);
  const row = r.rows[0];
  return {
    status: String(row.status),
    quantidade_produzida: Number(row.quantidade_produzida || 0),
    quantidade_perdida: Number(row.quantidade_perdida || 0),
    custo_real: Number(row.custo_real || 0),
    custo_previsto: row.custo_previsto === null ? null : Number(row.custo_previsto),
    concluida_em: row.concluida_em === null ? null : String(row.concluida_em),
  };
}

async function movsOp(ordemId: number) {
  const r = await query<any>(`SELECT tipo, quantidade, estornado, local FROM movimentacoes WHERE ordem_id = $1 ORDER BY id`, [ordemId]);
  return r.rows.map((x) => ({ tipo: String(x.tipo), quantidade: Number(x.quantidade), estornado: x.estornado === true, local: String(x.local) }));
}

async function movsInsumoOp(ordemId: number) {
  const r = await query<any>(`SELECT tipo, quantidade, insumo_id, custo_unitario FROM movimentacoes_insumos WHERE ordem_id = $1 ORDER BY id`, [ordemId]);
  return r.rows.map((x) => ({ tipo: String(x.tipo), quantidade: Number(x.quantidade), insumo_id: Number(x.insumo_id), custo: Number(x.custo_unitario || 0) }));
}

async function eventosOp(ordemId: number) {
  const r = await query<any>(`SELECT evento, de_status, para_status, mensagem, dados FROM ordens_eventos WHERE ordem_id = $1 ORDER BY id`, [ordemId]);
  return r.rows;
}

async function saldosNegativos(empresaId: number): Promise<number> {
  const a = await query<{ total: string }>(`SELECT count(*)::text AS total FROM estoques WHERE empresa_id = $1 AND quantidade < 0`, [empresaId]);
  const b = await query<{ total: string }>(`SELECT count(*)::text AS total FROM estoque_insumos ei JOIN insumos i ON i.id = ei.insumo_id WHERE i.empresa_id = $1 AND ei.quantidade < 0`, [empresaId]);
  return Number(a.rows[0].total) + Number(b.rows[0].total);
}

// ---------------------------------------------------------------------------

let baseUrl = '';
let servidor: Child | null = null;

before(async () => {
  const porta = await reservePort();
  const started = await startRealServer(porta);
  servidor = started.child;
  baseUrl = started.baseUrl;
});

after(async () => {
  if (servidor) await stopServer(servidor);
});

// ---------------------------------------------------------------------------
// A) Ciclo completo: concluir → reabrir → concluir → reabrir
// ---------------------------------------------------------------------------

test('ERP-02/A: o segundo ciclo conclui e estorna de novo — insumo re-consumido e custo líquido', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c, { saldoInsumo: 1000, consumo: 2, custoInsumo: 10 });
  const ordemId = await cicloConclusao(c, k, 10);

  // Estado da 1ª conclusão: 10 peças na loja, 20 m de insumo consumidos, custo real = 20 × 10.
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 10, 'a 1ª conclusão entra 10 peças');
  assert.equal(await saldoInsumo(k.insumoId), 980, 'a 1ª conclusão consome 20 m');
  const primeira = await estadoOp(ordemId);
  assert.equal(primeira.status, 'concluida');
  assert.equal(primeira.custo_real, 200, 'custo real da 1ª conclusão = 20 m × R$ 10');

  // Retry idêntico da conclusão: 200, mas sem reentrada, novo consumo, custo ou evento.
  const fotoConclusao = {
    op: await estadoOp(ordemId),
    produto: await saldoProduto(c, k.produtoId, k.tamanhoId),
    insumo: await saldoInsumo(k.insumoId),
    movimentos: await movsOp(ordemId),
    consumos: await movsInsumoOp(ordemId),
    eventos: await eventosOp(ordemId),
  };
  const concluirRepetido = await req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token);
  assert.equal(concluirRepetido.status, 200, `retry da conclusão: ${concluirRepetido.texto}`);
  assert.deepEqual(await estadoOp(ordemId), fotoConclusao.op);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), fotoConclusao.produto);
  assert.equal(await saldoInsumo(k.insumoId), fotoConclusao.insumo);
  assert.deepEqual(await movsOp(ordemId), fotoConclusao.movimentos);
  assert.deepEqual(await movsInsumoOp(ordemId), fotoConclusao.consumos);
  assert.deepEqual(await eventosOp(ordemId), fotoConclusao.eventos);

  // 1º estorno.
  const reabrir1 = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabrir1.status, 200, `1º reabrir: ${reabrir1.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0, 'o estorno devolve as peças');
  assert.equal(await saldoInsumo(k.insumoId), 1000, 'o estorno devolve os 20 m de insumo');
  const apos1 = await estadoOp(ordemId);
  assert.equal(apos1.status, 'planejada');
  assert.equal(apos1.custo_real, 0, 'a OP reaberta está em aberto: custo real 0 (o histórico fica na trilha)');
  assert.equal(apos1.quantidade_produzida, 0);

  // Estorno repetido (mesma OP, já reaberta): 409 e nada muda.
  const fotoAntes = { saldo: await saldoProduto(c, k.produtoId, k.tamanhoId), insumo: await saldoInsumo(k.insumoId), movs: await movsOp(ordemId), insumos: await movsInsumoOp(ordemId) };
  const reabrirRepetido = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabrirRepetido.status, 409, `2º reabrir da mesma OP precisa ser 409: ${reabrirRepetido.texto}`);
  assert.deepEqual(await movsOp(ordemId), fotoAntes.movs, 'o estorno repetido não cria movimentação nova');
  assert.deepEqual(await movsInsumoOp(ordemId), fotoAntes.insumos, 'o estorno repetido não cria consumo/entrada nova');
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), fotoAntes.saldo);
  assert.equal(await saldoInsumo(k.insumoId), fotoAntes.insumo);

  // 2ª conclusão: liberar → apontar → concluir. A OP produz de novo e PRECISA
  // consumir o insumo de novo — o estorno devolveu o saldo físico, então a peça
  // não pode sair sem consumo (era o defeito: `jaConsumido` contava a saída
  // estornada como se ainda estivesse baixada).
  const liberada2 = await req(baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada2.status, 200, `liberar de novo: ${liberada2.texto}`);
  const apontamento2 = await req(baseUrl, 'POST', `/ordens/${ordemId}/apontamentos`, { quantidade_produzida: 10, quantidade_perdida: 0, idempotency_key: unico('e02m') }, c.token);
  assert.equal(apontamento2.status, 201, `apontamento de novo: ${apontamento2.texto}`);
  assert.equal(await saldoInsumo(k.insumoId), 980, 'a 2ª conclusão PRECISA consumir os 20 m de novo');
  const concluida2 = await req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token);
  assert.equal(concluida2.status, 200, `concluir de novo: ${concluida2.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 10, 'a 2ª conclusão entra 10 peças');
  assert.equal(await saldoInsumo(k.insumoId), 980, 'o insumo da 2ª conclusão fica consumido');
  const segunda = await estadoOp(ordemId);
  assert.equal(segunda.custo_real, 200, 'o custo real da 2ª conclusão é o consumo vigente (saídas − estornos), não a soma bruta');
  assert.equal(segunda.quantidade_produzida, 10);

  // 2º estorno: devolve tudo de novo e preserva os dois estornos na trilha.
  const reabrir2 = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabrir2.status, 200, `2º estorno do ciclo: ${reabrir2.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0);
  assert.equal(await saldoInsumo(k.insumoId), 1000, 'o 2º estorno devolve o insumo consumido pela 2ª conclusão');

  const movs = await movsOp(ordemId);
  assert.deepEqual(
    movs.map((m) => `${m.tipo}:${m.quantidade}${m.estornado ? ':estornado' : ''}`),
    ['entrada:10:estornado', 'saida:10', 'entrada:10:estornado', 'saida:10'],
    'duas entradas (ambas estornadas) e duas saídas de estorno — sem movimentação duplicada',
  );
  const insumos = await movsInsumoOp(ordemId);
  assert.deepEqual(
    insumos.map((m) => `${m.tipo}:${m.quantidade}`),
    ['saida:20', 'entrada:20', 'saida:20', 'entrada:20'],
    'dois consumos e dois estornos de insumo, na ordem',
  );
  assert.equal(await saldosNegativos(c.empresaId), 0, 'nenhum saldo negativo em nenhum momento');

  const nomes = (await eventosOp(ordemId)).map((e) => String(e.evento));
  assert.equal(nomes.filter((n) => n === 'reaberta').length, 2, 'a trilha registra OS DOIS estornos');
});

// ---------------------------------------------------------------------------
// B) Concorrência
// ---------------------------------------------------------------------------

test('ERP-02/B1: dois estornos simultâneos com saldo sobrando — um só vale', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordemId = await cicloConclusao(c, k, 10);
  // Estoque extra para que o segundo estorno "coubesse" no saldo: sem a garantia
  // transacional, as duas operações passariam e 20 peças sairiam por uma OP de 10.
  const extra = await req(baseUrl, 'POST', '/movimentacoes', { tipo: 'entrada', produto_id: k.produtoId, tamanho_id: k.tamanhoId, quantidade: 30, motivo: 'Estoque extra E02M' }, c.token);
  assert.ok([200, 201].includes(extra.status), `entrada extra: ${extra.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 40);

  const [a, b] = await Promise.all([
    req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token),
    req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token),
  ]);
  const status = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(status, [200, 409], `exatamente uma transição válida e um 409: ${a.texto} | ${b.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 30, 'saiu UMA vez o estorno (40 − 10)');
  assert.equal(await saldoInsumo(k.insumoId), 1000, 'o insumo voltou uma única vez');
  const movs = await movsOp(ordemId);
  assert.equal(movs.filter((m) => m.tipo === 'saida').length, 1, 'uma única movimentação de estorno');
  assert.equal(movs.filter((m) => m.tipo === 'entrada' && m.estornado).length, 1, 'a entrada da OP foi estornada uma única vez');
  const insumos = await movsInsumoOp(ordemId);
  assert.equal(insumos.filter((m) => m.tipo === 'entrada').length, 1, 'uma única devolução de insumo');
  assert.equal(await saldosNegativos(c.empresaId), 0, 'nenhum saldo negativo');
  assert.equal((await estadoOp(ordemId)).status, 'planejada');
});

test('ERP-02/B2: dois estornos simultâneos com saldo exato — um só vale, nenhum negativo', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordemId = await cicloConclusao(c, k, 7);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 7, 'só as 7 peças da OP');

  const [a, b] = await Promise.all([
    req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token),
    req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token),
  ]);
  assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409], `um 200 e um 409: ${a.texto} | ${b.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0, 'o saldo fica em zero, nunca negativo');
  assert.equal(await saldoInsumo(k.insumoId), 1000);
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

test('ERP-02/B3: duas conclusões simultâneas — uma só entrada de peças', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordem = await req(baseUrl, 'POST', '/ordens', { produto_id: k.produtoId, tipo: 'tamanho', tamanho_id: k.tamanhoId, quantidade: 9, status: 'planejada', previsao: new Date().toISOString().slice(0, 10) }, c.token);
  const ordemId = Number(ordem.body.id);
  const liberada = await req(baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada.status, 200, `liberar: ${liberada.texto}`);

  const [a, b] = await Promise.all([
    req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token),
    req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token),
  ]);
  assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409], `uma conclusão vale: ${a.texto} | ${b.texto}`);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 9, 'entraram 9 peças, não 18');
  const movs = await movsOp(ordemId);
  assert.equal(movs.filter((m) => m.tipo === 'entrada').length, 1, 'uma única movimentação de entrada');
  assert.equal(Number(((await movsInsumoOp(ordemId)).filter((m) => m.tipo === 'saida')).reduce((acc, m) => acc + m.quantidade, 0)), 18, 'o insumo consumiu uma única vez (9 × 2 m)');
  assert.equal(await saldoInsumo(k.insumoId), 982);
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

test('ERP-02/G5: estorno lê e reverte todas as 1001 entradas de produto da OP', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordemId = await cicloConclusao(c, k, 10);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 10);

  // A conclusão pela API gerou a entrada mais antiga. Acrescentamos 1000 linhas
  // históricas equivalentes depois dela: com a consulta antiga (só a página mais
  // recente de 1000), a entrada original ficaria fora do estorno e sobrariam 10
  // peças no saldo. O livro e o saldo físico do fixture continuam conciliados.
  const saldoAtualizado = await query<{ quantidade: string }>(
    `UPDATE estoques
        SET quantidade = quantidade + 1000
      WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3 AND local_id = $4
      RETURNING quantidade`,
    [c.empresaId, k.produtoId, k.tamanhoId, k.localId],
  );
  assert.equal(saldoAtualizado.rowCount, 1, 'o saldo da OP deve existir antes de inserir histórico adicional');
  assert.equal(Number(saldoAtualizado.rows[0].quantidade), 1010);
  const historico = await query(
    `INSERT INTO movimentacoes
       (empresa_id, tipo, produto_id, tamanho_id, local, local_id, quantidade, motivo, ordem_id)
     SELECT $1, 'entrada', $2, $3, l.nome, $4, 1, $5, $6
       FROM generate_series(1, 1000) AS gs
       JOIN locais l ON l.id = $4 AND l.empresa_id = $1`,
    [c.empresaId, k.produtoId, k.tamanhoId, k.localId, `Histórico E02/G5 ${RODADA}`, ordemId],
  );
  assert.equal(historico.rowCount, 1000, 'o fixture precisa criar 1000 entradas posteriores à conclusão');

  const movimentosAntes = await movsOp(ordemId);
  const entradasAntes = movimentosAntes.filter((m) => m.tipo === 'entrada' && !m.estornado);
  assert.equal(entradasAntes.length, 1001);
  assert.equal(entradasAntes.reduce((total, m) => total + m.quantidade, 0), 1010, 'o saldo corresponde às 1001 entradas ligadas à OP');

  const reabertura = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabertura.status, 200, `reabrir OP: ${reabertura.texto}`);
  const movimentosDepois = await movsOp(ordemId);
  const entradasEstornadas = movimentosDepois.filter((m) => m.tipo === 'entrada' && m.estornado);
  const saidasEstorno = movimentosDepois.filter((m) => m.tipo === 'saida');
  assert.equal(entradasEstornadas.length, 1001, 'todas as entradas, inclusive a mais antiga, ficam marcadas como estornadas');
  assert.equal(saidasEstorno.length, 1001, 'cada entrada recebe exatamente uma saída compensatória');
  assert.equal(entradasEstornadas.reduce((total, m) => total + m.quantidade, 0), 1010);
  assert.equal(saidasEstorno.reduce((total, m) => total + m.quantidade, 0), 1010);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0, 'nenhuma entrada fica fora do estorno');
  assert.equal(await saldoInsumo(k.insumoId), 1000, 'o insumo é devolvido uma única vez');
  const opFinal = await estadoOp(ordemId);
  assert.equal(opFinal.status, 'planejada');
  assert.equal(opFinal.custo_real, 0);
  const evento = (await eventosOp(ordemId)).find((e) => String(e.evento) === 'reaberta');
  assert.ok(evento, 'a trilha append-only registra a reabertura');
  assert.equal(Number(evento!.dados?.pecas), 1010, 'o evento concilia todas as peças revertidas');
  assert.equal(Number(evento!.dados?.revertido?.custo_real), 200, 'o custo original permanece na trilha');
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

test('ERP-02/B4: reabertura e nova conclusão simultâneas terminam em uma ordem serial válida', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordemId = await cicloConclusao(c, k, 10);

  const [reabertura, conclusao] = await Promise.all([
    req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token),
    req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token),
  ]);
  for (const resposta of [reabertura, conclusao]) {
    assert.ok([200, 409].includes(resposta.status), `somente sucesso ou conflito seguro, nunca erro interno: ${resposta.texto}`);
  }
  assert.ok([reabertura.status, conclusao.status].includes(200), 'pelo menos uma operação deve ser serializada com sucesso');

  const ordemFinal = await estadoOp(ordemId);
  const eventos = (await eventosOp(ordemId)).map((e) => String(e.evento));
  const movimentos = await movsOp(ordemId);
  const consumos = await movsInsumoOp(ordemId);
  if (ordemFinal.status === 'planejada') {
    // A conclusão repetida leu o estado concluído antes do estorno e foi no-op;
    // a reabertura venceu e deixou todos os efeitos revertidos.
    assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0);
    assert.equal(await saldoInsumo(k.insumoId), 1000);
    assert.equal(ordemFinal.custo_real, 0);
    assert.deepEqual(movimentos.map((m) => `${m.tipo}:${m.quantidade}${m.estornado ? ':estornado' : ''}`), ['entrada:10:estornado', 'saida:10']);
    assert.deepEqual(consumos.map((m) => `${m.tipo}:${m.quantidade}`), ['saida:20', 'entrada:20']);
    assert.equal(eventos.filter((e) => e === 'concluida').length, 1);
    assert.equal(eventos.filter((e) => e === 'reaberta').length, 1);
  } else {
    // A reabertura foi serializada primeiro e a conclusão seguinte produziu um
    // novo ciclo completo, sem duplicar nem deixar fantasma.
    assert.equal(ordemFinal.status, 'concluida');
    assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 10);
    assert.equal(await saldoInsumo(k.insumoId), 980);
    assert.equal(ordemFinal.custo_real, 200);
    assert.deepEqual(movimentos.map((m) => `${m.tipo}:${m.quantidade}${m.estornado ? ':estornado' : ''}`), ['entrada:10:estornado', 'saida:10', 'entrada:10']);
    assert.deepEqual(consumos.map((m) => `${m.tipo}:${m.quantidade}`), ['saida:20', 'entrada:20', 'saida:20']);
    assert.equal(eventos.filter((e) => e === 'concluida').length, 2);
    assert.equal(eventos.filter((e) => e === 'reaberta').length, 1);
  }
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

// ---------------------------------------------------------------------------
// C) Rollback
// ---------------------------------------------------------------------------

test('ERP-02/C: estorno que falha na 2ª linha da grade não deixa efeito parcial', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const segundo = await req(baseUrl, 'POST', '/tamanhos', { codigo: unico('M').slice(-6).toUpperCase(), descricao: 'E02M-2', ordem: 901 }, c.token);
  const tamanho2 = Number(segundo.body.id);

  const ordem = await req(baseUrl, 'POST', '/ordens', { produto_id: k.produtoId, tipo: 'grade', status: 'planejada', previsao: new Date().toISOString().slice(0, 10) }, c.token);
  const ordemId = Number(ordem.body.id);
  const i1 = await req(baseUrl, 'POST', `/ordens/${ordemId}/itens`, { tamanho_id: k.tamanhoId, quantidade: 5 }, c.token);
  const i2 = await req(baseUrl, 'POST', `/ordens/${ordemId}/itens`, { tamanho_id: tamanho2, quantidade: 5 }, c.token);
  assert.ok([200, 201].includes(i1.status) && [200, 201].includes(i2.status), `itens da grade: ${i1.texto} | ${i2.texto}`);
  assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token)).status, 200);
  assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token)).status, 200);
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 5);
  assert.equal(await saldoProduto(c, k.produtoId, tamanho2), 5);

  // O saldo do SEGUNDO tamanho sai por fora → o estorno vai falhar na 2ª linha,
  // DEPOIS de já ter devolvido a 1ª. O rollback precisa desfazer tudo.
  const saida = await req(baseUrl, 'POST', '/movimentacoes', { tipo: 'saida', produto_id: k.produtoId, tamanho_id: tamanho2, quantidade: 5, motivo: 'Consumo externo E02M' }, c.token);
  assert.ok([200, 201].includes(saida.status), `saída externa: ${saida.texto}`);

  const antes = {
    op: await estadoOp(ordemId),
    movs: await movsOp(ordemId),
    insumos: await movsInsumoOp(ordemId),
    saldo1: await saldoProduto(c, k.produtoId, k.tamanhoId),
    saldo2: await saldoProduto(c, k.produtoId, tamanho2),
    insumo: await saldoInsumo(k.insumoId),
    eventos: (await eventosOp(ordemId)).length,
  };
  const apontamentoAntes = await req(baseUrl, 'GET', `/ordens/${ordemId}/apontamentos`, undefined, c.token);

  const reabrir = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabrir.status, 409, `estorno sem saldo é 409 de negócio: ${reabrir.texto}`);
  assert.match(String(reabrir.body?.error || ''), /saldo/i, 'a mensagem precisa falar de saldo');

  assert.deepEqual(await estadoOp(ordemId), antes.op, 'a OP não pode ficar meio reaberta (status, custo, produzido, perdido, concluida_em)');
  assert.deepEqual(await movsOp(ordemId), antes.movs, 'nenhuma movimentação de estorno pode sobrar da transação que falhou');
  assert.deepEqual(await movsInsumoOp(ordemId), antes.insumos, 'nenhuma devolução de insumo pode sobrar');
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), antes.saldo1, 'a 1ª linha (que já tinha sido estornada na transação) voltou');
  assert.equal(await saldoProduto(c, k.produtoId, tamanho2), antes.saldo2, 'a 2ª linha continua como estava');
  assert.equal(await saldoInsumo(k.insumoId), antes.insumo, 'o insumo não voltou pela metade');
  assert.equal((await eventosOp(ordemId)).length, antes.eventos, 'nenhum evento de estorno pode ficar gravado');
  const apontamentoDepois = await req(baseUrl, 'GET', `/ordens/${ordemId}/apontamentos`, undefined, c.token);
  assert.deepEqual(apontamentoDepois.body, apontamentoAntes.body, 'os apontamentos continuam vivos');
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

// ---------------------------------------------------------------------------
// D) Multiempresa
// ---------------------------------------------------------------------------

test('ERP-02/D: o estorno de A não toca B e B não alcança a OP de A', async () => {
  const a = await novoContexto(baseUrl);
  const b = await novoContexto(baseUrl);
  const ka = await kit(a);
  const kb = await kit(b);

  const ordemA = await cicloConclusao(a, ka, 10);
  const ordemB = await cicloConclusao(b, kb, 4);

  // B não vê nem opera a OP de A, por nenhuma porta.
  assert.equal((await req(baseUrl, 'GET', `/ordens/${ordemA}`, undefined, b.token)).status, 404, 'B não lê a OP de A');
  assert.equal((await req(baseUrl, 'GET', `/ordens/${ordemA}/eventos`, undefined, b.token)).status, 404, 'B não lê a trilha de A');
  assert.equal((await req(baseUrl, 'GET', `/ordens/${ordemA}/apontamentos`, undefined, b.token)).status, 404, 'B não lê os apontamentos de A');
  assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemA}/reabrir`, {}, b.token)).status, 404, 'B não estorna a OP de A');
  assert.equal((await req(baseUrl, 'POST', `/ordens/${ordemA}/apontamentos`, { quantidade_produzida: 1, idempotency_key: unico('x') }, b.token)).status, 404, 'B não aponta na OP de A');

  const bAntes = { op: await estadoOp(ordemB), insumo: await saldoInsumo(kb.insumoId), saldo: await saldoProduto(b, kb.produtoId, kb.tamanhoId), movs: await movsOp(ordemB) };
  const aAntes = { op: await estadoOp(ordemA), insumo: await saldoInsumo(ka.insumoId), saldo: await saldoProduto(a, ka.produtoId, ka.tamanhoId) };

  const estornoA = await req(baseUrl, 'POST', `/ordens/${ordemA}/reabrir`, {}, a.token);
  assert.equal(estornoA.status, 200, `estorno de A: ${estornoA.texto}`);

  assert.equal(await saldoProduto(a, ka.produtoId, ka.tamanhoId), 0, 'A foi estornada');
  assert.equal(await saldoInsumo(ka.insumoId), 1000, 'o insumo de A voltou');
  assert.equal((await estadoOp(ordemA)).status, 'planejada');
  assert.deepEqual(await estadoOp(ordemB), bAntes.op, 'a OP de B fica EXATAMENTE como estava');
  assert.equal(await saldoInsumo(kb.insumoId), bAntes.insumo, 'o insumo de B fica intacto');
  assert.equal(await saldoProduto(b, kb.produtoId, kb.tamanhoId), bAntes.saldo, 'o saldo de B fica intacto');
  assert.deepEqual(await movsOp(ordemB), bAntes.movs, 'nenhuma movimentação de B mudou');
  assert.equal(bAntes.saldo, 4, 'sanidade: a OP de B tinha 4 peças antes');
  assert.equal(aAntes.saldo, 10, 'sanidade: a OP de A tinha 10 peças antes');

  // Vínculo por empresa no banco: nenhuma movimentação de A aponta para dado de B.
  const cruzado = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM movimentacoes m JOIN ordens_fabricacao o ON o.id = m.ordem_id WHERE m.empresa_id <> o.empresa_id`,
  );
  assert.equal(cruzado.rows[0].total, '0', 'nenhuma movimentação cruza empresas');
  const cruzadoInsumo = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM movimentacoes_insumos mi JOIN ordens_fabricacao o ON o.id = mi.ordem_id WHERE mi.empresa_id <> o.empresa_id`,
  );
  assert.equal(cruzadoInsumo.rows[0].total, '0', 'nenhum consumo de insumo cruza empresas');
});

// ---------------------------------------------------------------------------
// E) Perdas, custo real e histórico
// ---------------------------------------------------------------------------

test('ERP-02/E: o estorno reverte custo e perdas da OP em aberto e preserva o histórico', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c, { saldoInsumo: 1000, consumo: 2, custoInsumo: 10, maoObra: 100, indiretos: 50 });
  const ordemId = await cicloConclusao(c, k, 10, { perdida: 2 });

  // Peças processadas = 10 boas + 2 refugadas = 12 → 24 m de insumo + indiretos
  // integrais (proporção 1) = R$ 240 + R$ 150 = R$ 390.
  const concluida = await estadoOp(ordemId);
  assert.equal(concluida.quantidade_produzida, 10, 'a OP registra as peças boas');
  assert.equal(concluida.quantidade_perdida, 2, 'a OP registra as peças refugadas');
  assert.equal(concluida.custo_real, 390, 'custo real = insumos processados + mão de obra + indiretos');
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 10, 'a perda NÃO entra no estoque');
  assert.equal(await saldoInsumo(k.insumoId), 976, 'a perda consome insumo');

  const eventosAntes = await eventosOp(ordemId);
  const conclusaoEvento = eventosAntes.find((e) => String(e.evento) === 'concluida');
  assert.ok(conclusaoEvento, 'a conclusão registra o evento');
  assert.equal(Number(conclusaoEvento!.dados?.custo_real ?? NaN), 390, 'o evento de conclusão guarda o custo real');

  const reabrir = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(reabrir.status, 200, `estorno: ${reabrir.texto}`);

  const reaberta = await estadoOp(ordemId);
  assert.equal(reaberta.status, 'planejada');
  assert.equal(reaberta.custo_real, 0, 'a OP em aberto não carrega custo real');
  assert.equal(reaberta.quantidade_produzida, 0);
  assert.equal(reaberta.quantidade_perdida, 0);
  assert.equal(reaberta.concluida_em, null);
  assert.equal(reaberta.custo_previsto, concluida.custo_previsto, 'o custo PREVISTO congelado na liberação permanece');
  assert.equal(await saldoInsumo(k.insumoId), 1000, 'o estorno devolve também o insumo da peça refugada');

  // O histórico do que foi revertido fica na trilha (perícia): o evento `reaberta`
  // carrega o custo real, as peças e a perda que saíram da OP, e cada apontamento.
  const eventosDepois = await eventosOp(ordemId);
  const reabertaEvento = eventosDepois.filter((e) => String(e.evento) === 'reaberta').pop();
  assert.ok(reabertaEvento, 'o evento `reaberta` precisa existir');
  const dados = reabertaEvento!.dados || {};
  assert.equal(Number(dados.custo_real ?? NaN), 390, 'o evento de estorno guarda o custo real revertido');
  assert.equal(Number(dados.pecas ?? NaN), 10, 'o evento de estorno guarda as peças boas revertidas');
  assert.equal(Number(dados.perdidas ?? NaN), 2, 'o evento de estorno guarda as peças perdidas revertidas');
  assert.deepEqual(
    dados.apontamentos,
    [{ id: dados.apontamentos?.[0]?.id, tamanho_id: k.tamanhoId, produzida: 10, perdida: 2 }],
    'o evento de estorno guarda o resumo de cada apontamento anulado',
  );

  // A auditoria registra a operação com os mesmos números.
  const audit = await query<any>(
    `SELECT descricao, dados FROM auditoria WHERE recurso = 'ordens' AND registro_id = $1 AND acao = 'estornar' ORDER BY id DESC LIMIT 1`,
    [ordemId],
  );
  assert.equal(audit.rowCount, 1, 'a auditoria registra o estorno');
  assert.equal(Number(audit.rows[0].dados?.custo_real ?? NaN), 390, 'a auditoria guarda o custo real revertido');

  // Os movimentos originais continuam no banco (histórico não é apagado).
  const movs = await movsOp(ordemId);
  assert.equal(movs.length, 2, 'entrada da conclusão + saída do estorno — nada é apagado');
  assert.equal(movs[0].estornado, true, 'a entrada original fica marcada como estornada, não excluída');
  const insumosMov = await movsInsumoOp(ordemId);
  assert.deepEqual(insumosMov.map((m) => `${m.tipo}:${m.quantidade}`), ['saida:24', 'entrada:24'], 'o consumo original fica no histórico e o estorno é o lançamento inverso');
  assert.equal(await saldosNegativos(c.empresaId), 0);
});

// ---------------------------------------------------------------------------
// F) Causa-raiz em SQL (prova executável do P0-01)
// ---------------------------------------------------------------------------

test('ERP-02/F: `INSERT ... ON CONFLICT DO UPDATE` avalia o CHECK no tuple proposto (causa-raiz do 23514)', async () => {
  const tabela = `probe_check_${RODADA.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  await query(`CREATE TABLE ${tabela} (id int PRIMARY KEY, quantidade int NOT NULL CHECK (quantidade >= 0))`);
  try {
    // Saldo de sobra (50): o CHECK reprova mesmo quando o resultado final seria válido.
    await query(`INSERT INTO ${tabela} (id, quantidade) VALUES (1, 50)`);

    // O padrão do `adjustStock` com delta negativo: o CHECK reprova o TUPLE
    // PROPOSTO (−10) antes de resolver o conflito, mesmo que o resultado final
    // fosse válido (5 − 10 = −5; e mesmo com saldo de sobra, 50 − 10 = 40).
    let erro: any = null;
    try {
      await query(`INSERT INTO ${tabela} (id, quantidade) VALUES (1, -10) ON CONFLICT (id) DO UPDATE SET quantidade = ${tabela}.quantidade - 10`);
    } catch (e) {
      erro = e;
    }
    assert.equal(erro?.code, '23514', `o delta negativo direto precisa violar o CHECK: ${erro?.message}`);
    const apos = await query<{ quantidade: number }>(`SELECT quantidade FROM ${tabela} WHERE id = 1`);
    assert.equal(Number(apos.rows[0].quantidade), 50, 'o UPDATE nem chegou a rodar: o CHECK barra o tuple proposto (50 − 10 = 40 seria válido)');

    // O padrão do `tryAdjustStock`: UPDATE condicional com row lock — o saldo só
    // muda quando o resultado é válido, e o delta negativo é permitido quando há
    // saldo (o que a reabertura precisa).
    await query(`UPDATE ${tabela} SET quantidade = quantidade + (-50) WHERE id = 1 AND quantidade + (-50) >= 0`);
    const depois = await query<{ quantidade: number }>(`SELECT quantidade FROM ${tabela} WHERE id = 1`);
    assert.equal(Number(depois.rows[0].quantidade), 0, 'o UPDATE condicional aplica a saída quando cabe');

    const semSaldo = await query(`UPDATE ${tabela} SET quantidade = quantidade + (-10) WHERE id = 1 AND quantidade + (-10) >= 0`);
    assert.equal(semSaldo.rowCount, 0, 'sem saldo, o UPDATE condicional não altera nada (é o 409 de negócio, não 500)');
    const final = await query<{ quantidade: number }>(`SELECT quantidade FROM ${tabela} WHERE id = 1`);
    assert.equal(Number(final.rows[0].quantidade), 0, 'o saldo não fica negativo');
  } finally {
    await query(`DROP TABLE IF EXISTS ${tabela}`);
  }
});

async function bloquearEventoOrdem(ordemId: number, evento: 'concluida' | 'reaberta'): Promise<() => Promise<void>> {
  const sufixo = `${RODADA.replace(/[^a-z0-9]/gi, '').slice(0, 14)}_${++contador}`;
  const funcao = `e02_fail_event_${sufixo}`;
  const trigger = `e02_fail_trigger_${sufixo}`;
  await query(`
    CREATE FUNCTION ${funcao}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.ordem_id = ${ordemId} AND NEW.evento = '${evento}' THEN
        RAISE EXCEPTION 'falha injetada ao persistir evento ERP-02' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ordens_eventos FOR EACH ROW EXECUTE FUNCTION ${funcao}()`);
  return async () => {
    await query(`DROP TRIGGER IF EXISTS ${trigger} ON ordens_eventos`);
    await query(`DROP FUNCTION IF EXISTS ${funcao}()`);
  };
}

test('ERP-02/G1: falha ao gravar evento de conclusão faz rollback dos efeitos e da auditoria', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const criada = await req(baseUrl, 'POST', '/ordens', {
    produto_id: k.produtoId,
    tipo: 'tamanho',
    tamanho_id: k.tamanhoId,
    quantidade: 10,
    status: 'planejada',
    previsao: new Date().toISOString().slice(0, 10),
  }, c.token);
  assert.equal(criada.status, 201, `criar OP: ${criada.texto}`);
  const ordemId = Number(criada.body.id);
  const liberada = await req(baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada.status, 200, `liberar OP: ${liberada.texto}`);

  const antes = {
    op: await estadoOp(ordemId),
    produto: await saldoProduto(c, k.produtoId, k.tamanhoId),
    insumo: await saldoInsumo(k.insumoId),
    movimentos: await movsOp(ordemId),
    consumos: await movsInsumoOp(ordemId),
    eventos: await eventosOp(ordemId),
    auditoriasConclusao: Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM auditoria WHERE recurso = 'ordens' AND registro_id = $1 AND descricao LIKE '%concluída%'`,
      [ordemId],
    )).rows[0].total),
  };
  const desbloquear = await bloquearEventoOrdem(ordemId, 'concluida');
  try {
    const resultado = await req(baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token);
    assert.deepEqual(await estadoOp(ordemId), antes.op, 'o status/custo da OP volta ao estado anterior');
    assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), antes.produto, 'nenhum produto acabado fica no estoque');
    assert.equal(await saldoInsumo(k.insumoId), antes.insumo, 'nenhum insumo fica consumido parcialmente');
    assert.deepEqual(await movsOp(ordemId), antes.movimentos, 'nenhuma movimentação de produto fica gravada');
    assert.deepEqual(await movsInsumoOp(ordemId), antes.consumos, 'nenhuma movimentação de insumo fica gravada');
    assert.deepEqual(await eventosOp(ordemId), antes.eventos, 'nenhum evento órfão é gravado');
    const auditoriasDepois = Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM auditoria WHERE recurso = 'ordens' AND registro_id = $1 AND descricao LIKE '%concluída%'`,
      [ordemId],
    )).rows[0].total);
    assert.equal(auditoriasDepois, antes.auditoriasConclusao, 'a auditoria da conclusão também faz rollback');
    assert.equal(resultado.status, 409, `a falha da trilha deve abortar a conclusão sem mascarar o erro do PostgreSQL: ${resultado.texto}`);
  } finally {
    await desbloquear();
  }
});

test('ERP-02/G2: falha ao gravar evento de reabertura faz rollback integral do estorno', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c);
  const ordemId = await cicloConclusao(c, k, 10);
  const antes = {
    op: await estadoOp(ordemId),
    produto: await saldoProduto(c, k.produtoId, k.tamanhoId),
    insumo: await saldoInsumo(k.insumoId),
    movimentos: await movsOp(ordemId),
    consumos: await movsInsumoOp(ordemId),
    eventos: await eventosOp(ordemId),
    apontamentos: Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ordens_apontamentos WHERE empresa_id = $1 AND ordem_id = $2`,
      [c.empresaId, ordemId],
    )).rows[0].total),
    auditoriasEstorno: Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM auditoria WHERE recurso = 'ordens' AND registro_id = $1 AND acao = 'estornar'`,
      [ordemId],
    )).rows[0].total),
  };
  const desbloquear = await bloquearEventoOrdem(ordemId, 'reaberta');
  try {
    const resultado = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
    assert.deepEqual(await estadoOp(ordemId), antes.op, 'a OP continua concluída, com custo e perdas históricos');
    assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), antes.produto, 'a entrada de produto não é estornada parcialmente');
    assert.equal(await saldoInsumo(k.insumoId), antes.insumo, 'o consumo não é devolvido parcialmente');
    assert.deepEqual(await movsOp(ordemId), antes.movimentos, 'nenhuma reversão de produto fica gravada');
    assert.deepEqual(await movsInsumoOp(ordemId), antes.consumos, 'nenhuma reversão de insumo fica gravada');
    assert.deepEqual(await eventosOp(ordemId), antes.eventos, 'a trilha permanece igual');
    const apontamentosDepois = Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ordens_apontamentos WHERE empresa_id = $1 AND ordem_id = $2`,
      [c.empresaId, ordemId],
    )).rows[0].total);
    assert.equal(apontamentosDepois, antes.apontamentos, 'os apontamentos não são removidos');
    const auditoriasDepois = Number((await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM auditoria WHERE recurso = 'ordens' AND registro_id = $1 AND acao = 'estornar'`,
      [ordemId],
    )).rows[0].total);
    assert.equal(auditoriasDepois, antes.auditoriasEstorno, 'a auditoria do estorno também faz rollback');
    assert.equal(resultado.status, 409, `a falha da trilha deve abortar o estorno sem mascarar o erro do PostgreSQL: ${resultado.texto}`);
  } finally {
    await desbloquear();
  }
});

test('ERP-02/G3: estorno processa todos os 1001 apontamentos sem deixar órfãos ativos', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c, { saldoInsumo: 5000, consumo: 2, custoInsumo: 10 });
  const ordemId = await cicloConclusao(c, k, 1001);
  const primeiro = await query<{ id: number }>(
    `SELECT id FROM ordens_apontamentos WHERE empresa_id = $1 AND ordem_id = $2 ORDER BY id LIMIT 1`,
    [c.empresaId, ordemId],
  );
  assert.equal(primeiro.rowCount, 1);
  // Divide o mesmo apontamento agregado em 1001 registros equivalentes. O total
  // apontado, o consumo de insumo e a conclusão continuam iguais; só exercitamos
  // uma cardinalidade superior ao limite de página que existia no estorno.
  await query(`UPDATE ordens_apontamentos SET quantidade_produzida = 1 WHERE id = $1`, [Number(primeiro.rows[0].id)]);
  await query(
    `INSERT INTO ordens_apontamentos (empresa_id, ordem_id, tamanho_id, quantidade_produzida, quantidade_perdida, idempotency_key)
     SELECT $1, $2, $3, 1, 0, $4 || gs::text FROM generate_series(1, 1000) AS gs`,
    [c.empresaId, ordemId, k.tamanhoId, `e02-pages-${RODADA}-`],
  );
  assert.equal(Number((await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ordens_apontamentos WHERE empresa_id = $1 AND ordem_id = $2`,
    [c.empresaId, ordemId],
  )).rows[0].total), 1001, 'o fixture preserva a quantidade total de produção em 1001 apontamentos');

  const apontamentosApi = await req(baseUrl, 'GET', `/ordens/${ordemId}/apontamentos`, undefined, c.token);
  assert.equal(apontamentosApi.status, 200, `listar apontamentos: ${apontamentosApi.texto}`);
  assert.ok(Array.isArray(apontamentosApi.body));
  assert.equal(apontamentosApi.body.length, 1001, 'a API não trunca a lista de apontamentos em 500 linhas');

  const eventosExtra = await query(
    `INSERT INTO ordens_eventos (empresa_id, ordem_id, evento, mensagem)
     SELECT $1, $2, 'edicao', $3 FROM generate_series(1, 501) AS gs`,
    [c.empresaId, ordemId, `Histórico E02/G3 ${RODADA}`],
  );
  assert.equal(eventosExtra.rowCount, 501);
  const eventosApi = await req(baseUrl, 'GET', `/ordens/${ordemId}/eventos`, undefined, c.token);
  assert.equal(eventosApi.status, 200, `listar eventos: ${eventosApi.texto}`);
  assert.ok(Array.isArray(eventosApi.body));
  const totalEventosBanco = Number((await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ordens_eventos WHERE empresa_id = $1 AND ordem_id = $2`,
    [c.empresaId, ordemId],
  )).rows[0].total);
  assert.equal(eventosApi.body.length, totalEventosBanco, 'a API lista o histórico completo acima de 500 eventos');

  const resultado = await req(baseUrl, 'POST', `/ordens/${ordemId}/reabrir`, {}, c.token);
  assert.equal(resultado.status, 200, `reabrir OP: ${resultado.texto}`);
  const restantes = Number((await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ordens_apontamentos WHERE empresa_id = $1 AND ordem_id = $2`,
    [c.empresaId, ordemId],
  )).rows[0].total);
  assert.equal(restantes, 0, 'nenhum apontamento da conclusão estornada pode continuar ativo');
  const evento = (await eventosOp(ordemId)).filter((e) => String(e.evento) === 'reaberta').at(-1);
  assert.ok(evento, 'o estorno gera evento histórico');
  assert.equal(evento!.dados?.apontamentos?.length, 1001, 'o evento preserva o resumo de todos os apontamentos estornados');
  assert.equal(await saldoProduto(c, k.produtoId, k.tamanhoId), 0);
  assert.equal(await saldoInsumo(k.insumoId), 5000);
});

test('ERP-02/G4: custo e consumo consideram todo o livro de insumos acima de 5000 movimentos', async () => {
  const c = await novoContexto(baseUrl);
  const k = await kit(c, { saldoInsumo: 10000, consumo: 2, custoInsumo: 10 });
  const criada = await req(baseUrl, 'POST', '/ordens', {
    produto_id: k.produtoId,
    tipo: 'tamanho',
    tamanho_id: k.tamanhoId,
    quantidade: 1,
    status: 'planejada',
    previsao: new Date().toISOString().slice(0, 10),
  }, c.token);
  assert.equal(criada.status, 201, `criar OP: ${criada.texto}`);
  const ordemId = Number(criada.body.id);
  const liberada = await req(baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada.status, 200, `liberar OP: ${liberada.texto}`);

  // Histórico antigo da mesma OP em 2500 pares compensatórios (líquido zero).
  // A nova saída real ficará após essas linhas e precisa continuar sendo vista
  // pelo cálculo, mesmo quando a OP ultrapassa o limite de uma única página.
  await query(
    `INSERT INTO movimentacoes_insumos (empresa_id, tipo, insumo_id, quantidade, custo_unitario, motivo, ordem_id)
     SELECT $1, CASE WHEN gs % 2 = 1 THEN 'saida' ELSE 'entrada' END, $2, 1, 10, $3, $4
       FROM generate_series(1, 5000) AS gs`,
    [c.empresaId, k.insumoId, `Histórico compensatório E02 ${RODADA}`, ordemId],
  );
  const apontamento = await req(baseUrl, 'POST', `/ordens/${ordemId}/apontamentos`, {
    quantidade_produzida: 1,
    quantidade_perdida: 0,
    idempotency_key: unico('e02-pages'),
  }, c.token);
  assert.equal(apontamento.status, 201, `apontar produção: ${apontamento.texto}`);
  assert.equal(await saldoInsumo(k.insumoId), 9998, 'uma saída de 2 m de insumo é lançada');
  assert.equal((await estadoOp(ordemId)).custo_real, 20, 'custo real = 2 m × R$ 10, sem truncar a última movimentação');
  const movimentos = await movsInsumoOp(ordemId);
  assert.equal(movimentos.length, 5001, 'o livro da OP contém as 5000 linhas antigas e a saída atual');
});
