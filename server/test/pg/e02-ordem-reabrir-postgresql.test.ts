// ============================================================================
// ERP-02 — REABERTURA/ESTORNO DE OP CONTRA POSTGRESQL REAL (fecha o P0-01).
//
// O que o modo demonstração NÃO tinha como provar e este arquivo prova:
//
//   • `adjustStock` monta `INSERT ... ON CONFLICT DO UPDATE` e o CHECK
//     `estoques_quantidade_nao_negativo` avalia o tuple PROPOSTO (−qtd) ANTES
//     de o conflito resolver: com saldo suficiente na linha correta, o Postgres
//     devolvia SQLSTATE 23514 e a reabertura virava HTTP 500. Agora o estorno
//     usa `tryAdjustStock` (UPDATE condicional com row lock) e o erro de saldo é
//     409 de negócio;
//   • `translatePgError` traduz 23514 (check_violation) para 409 — nenhuma
//     violação de CHECK vira "Erro interno do servidor" nem vaza o constraint;
//   • o estorno é ATÔMICO: quando o saldo não cobre a devolução, nada muda
//     (status, apontamentos, insumos e movimentações continuam como estavam);
//   • o efeito colateral P1-10 (OP cancelada é terminal) responde 409 e não 500.
//
// Caminho exercitado: HTTP real (servidor Express de verdade, JWT de verdade,
// PgStore, PostgreSQL real) — o fluxo da OP inteiro pela API, como o operador faz.
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('e02-ordem-reabrir-postgresql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `e02${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRealServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `e02-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `E02-${randomUUID()}-OnlyForTest`,
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
        const h = await r.json() as { ok?: boolean; db?: string };
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
  const emp = await query<{ id: number }>(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa E02'), cnpj]);
  const empresaId = Number(emp.rows[0].id);
  const email = `${unico('e02')}@example.test`;
  const senha = `E02-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const usr = await query<{ id: number }>(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, $4, false, false, false, now()) RETURNING id`,
    [unico('Gerente E02'), email, senhaHash, empresaId],
  );
  const usuarioId = Number(usr.rows[0].id);
  await query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [usuarioId, empresaId]);

  const login = await req(baseUrl, 'POST', '/auth/login', { email, password: senha });
  assert.equal(login.status, 200, `login precisa funcionar: ${login.texto}`);
  const token = String(login.body?.token || '');
  assert.ok(token.length > 20, 'login precisa emitir JWT');

  const local = await req(baseUrl, 'POST', '/locais', { nome: unico('Loja E02'), tipo: 'loja', ativo: true, padrao: true, empresa_id: empresaId }, token);
  assert.equal(local.status, 201, `local padrao precisa ser criado: ${local.texto}`);
  const localId = Number(local.body?.id);

  return { empresaId, usuarioId, token, baseUrl, localId };
}

type FluxoOp = {
  ordemId: number;
  produtoId: number;
  insumoId: number;
  tamanhoId: number;
};

/** Fluxo real da OP pela API: insumo → produto → ficha → OP → liberar → apontar → concluir. */
async function ordemConcluida(c: Contexto, quantidade = 10): Promise<FluxoOp> {
  const insumo = await req(c.baseUrl, 'POST', '/insumos', { nome: unico('Insumo E02'), unidade: 'm', custo: 10, empresa_id: c.empresaId }, c.token);
  assert.equal(insumo.status, 201, `insumo: ${insumo.texto}`);
  const insumoId = Number(insumo.body.id);

  const produto = await req(c.baseUrl, 'POST', '/produtos', { sku: unico('SKU-E02'), nome: unico('Produto E02'), preco_venda: 100, custo: 30, empresa_id: c.empresaId }, c.token);
  assert.equal(produto.status, 201, `produto: ${produto.texto}`);
  const produtoId = Number(produto.body.id);

  const tamanho = await req(c.baseUrl, 'POST', '/tamanhos', { codigo: unico('T').slice(-6).toUpperCase(), descricao: 'E02', ordem: 900 }, c.token);
  assert.equal(tamanho.status, 201, `tamanho: ${tamanho.texto}`);
  const tamanhoId = Number(tamanho.body.id);

  // Saldo do insumo por movimentação (nunca por edição direta do cadastro).
  const entrada = await req(c.baseUrl, 'POST', '/movimentacoes_insumos', { tipo: 'entrada', insumo_id: insumoId, quantidade: 1000, custo_unitario: 10, motivo: 'Saldo inicial E02' }, c.token);
  assert.ok([200, 201].includes(entrada.status), `saldo do insumo: ${entrada.texto}`);

  const ficha = await req(c.baseUrl, 'POST', '/fichas', { produto_id: produtoId, mao_obra: 0, custos_indiretos: 0, margem_pct: 100 }, c.token);
  assert.equal(ficha.status, 201, `ficha: ${ficha.texto}`);
  const itemFicha = await req(c.baseUrl, 'POST', `/fichas/${ficha.body.id}/insumos`, { insumo_id: insumoId, consumo: 2, perda_pct: 0 }, c.token);
  assert.ok([200, 201].includes(itemFicha.status), `item da ficha: ${itemFicha.texto}`);

  const ordem = await req(c.baseUrl, 'POST', '/ordens', { produto_id: produtoId, tipo: 'tamanho', tamanho_id: tamanhoId, quantidade, status: 'planejada', previsao: new Date().toISOString().slice(0, 10) }, c.token);
  assert.equal(ordem.status, 201, `ordem: ${ordem.texto}`);
  const ordemId = Number(ordem.body.id);

  const liberada = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/liberar`, {}, c.token);
  assert.equal(liberada.status, 200, `liberar: ${liberada.texto}`);

  const apontamento = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/apontamentos`, { quantidade_produzida: quantidade, quantidade_perdida: 0, idempotency_key: `e02-${ordemId}-${RODADA}` }, c.token);
  assert.equal(apontamento.status, 201, `apontamento: ${apontamento.texto}`);

  const concluida = await req(c.baseUrl, 'POST', `/ordens/${ordemId}/concluir`, {}, c.token);
  assert.equal(concluida.status, 200, `concluir: ${concluida.texto}`);
  assert.equal(concluida.body.status, 'concluida');

  return { ordemId, produtoId, insumoId, tamanhoId };
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

// ---------------------------------------------------------------------------

test('ERP-02: reabrir OP estorna em PostgreSQL (antes: 500 por SQLSTATE 23514)', async (t) => {
  const porta = await reservePort();
  const { child, baseUrl } = await startRealServer(porta);
  t.after(async () => stopServer(child));

  const c = await novoContexto(baseUrl);
  const op = await ordemConcluida(c, 10);

  // Estado depois de concluir: 10 peças no estoque, insumo consumido, apontamentos vivos.
  assert.equal(await saldoProduto(c, op.produtoId, op.tamanhoId), 10, 'a conclusão precisa dar entrada das peças boas');
  assert.equal(await saldoInsumo(op.insumoId), 980, 'a conclusão consome 10 peças × 2 m = 20 m do insumo');
  const apsAntes = await req(baseUrl, 'GET', `/ordens/${op.ordemId}/apontamentos`, undefined, c.token);
  assert.equal((apsAntes.body || []).length, 1, 'há um apontamento vivo antes do estorno');

  // ---- o passo que devolvia HTTP 500 (SQLSTATE 23514) -----------------------
  const reaberta = await req(baseUrl, 'POST', `/ordens/${op.ordemId}/reabrir`, {}, c.token);
  assert.equal(reaberta.status, 200, `reabrir precisa responder 200 — era o defeito P0-01: ${reaberta.texto}`);
  assert.equal(reaberta.body?.status, 'planejada', 'reabrir devolve a OP para planejada');

  // O estorno é completo: estoque, insumo, apontamentos e trilha.
  assert.equal(await saldoProduto(c, op.produtoId, op.tamanhoId), 0, 'as peças estornadas saem do estoque');
  assert.equal(await saldoInsumo(op.insumoId), 1000, 'os insumos consumidos voltam');
  const apsDepois = await req(baseUrl, 'GET', `/ordens/${op.ordemId}/apontamentos`, undefined, c.token);
  assert.equal((apsDepois.body || []).length, 0, 'os apontamentos são descartados no estorno');
  const eventos = await req(baseUrl, 'GET', `/ordens/${op.ordemId}/eventos`, undefined, c.token);
  const nomes = (eventos.body || []).map((e: any) => e.evento);
  assert.ok(nomes.includes('reaberta'), `a trilha precisa registrar o evento "reaberta": ${nomes.join(',')}`);
  const estornoMov = await query<{ tipo: string; quantidade: string }>(
    `SELECT tipo, quantidade FROM movimentacoes WHERE empresa_id = $1 AND ordem_id = $2 AND tipo = 'saida'`,
    [c.empresaId, op.ordemId],
  );
  assert.equal(estornoMov.rowCount, 1, 'o estorno gera UMA movimentação de saída ligada à OP');
  assert.equal(Number(estornoMov.rows[0].quantidade), 10);

  // ---- nada de saldo negativo nem de segunda reabertura ---------------------
  const negativos = await query<{ total: string }>(`SELECT count(*)::text AS total FROM estoques WHERE empresa_id = $1 AND quantidade < 0`, [c.empresaId]);
  assert.equal(negativos.rows[0].total, '0', 'nenhum saldo pode ficar negativo');

  const deNovo = await req(baseUrl, 'POST', `/ordens/${op.ordemId}/reabrir`, {}, c.token);
  assert.equal(deNovo.status, 409, `reabrir uma OP que não está concluída é 409: ${deNovo.texto}`);
  assert.match(String(deNovo.body?.error || ''), /concluída|não pode/i, 'a mensagem precisa dizer que só OP concluída reabre');

  // ---- saldo insuficiente → 409 de negócio e NADA alterado ------------------
  const op2 = await ordemConcluida(c, 6);
  assert.equal(await saldoProduto(c, op2.produtoId, op2.tamanhoId), 6);
  // Consome as peças por fora (saída manual) — a OP continua "concluida".
  const saida = await req(baseUrl, 'POST', '/movimentacoes', { tipo: 'saida', produto_id: op2.produtoId, tamanho_id: op2.tamanhoId, quantidade: 6, motivo: 'Consumo externo E02' }, c.token);
  assert.ok([200, 201].includes(saida.status), `saída manual: ${saida.texto}`);
  assert.equal(await saldoProduto(c, op2.produtoId, op2.tamanhoId), 0);

  // Fotografa o estado ANTES da tentativa que vai falhar (cada OP tem insumo próprio).
  const insumoAntes = await saldoInsumo(op2.insumoId);
  assert.equal(insumoAntes, 988, 'a conclusão da OP #2 consumiu 6 peças × 2 m = 12 m do insumo dela');

  const semSaldo = await req(baseUrl, 'POST', `/ordens/${op2.ordemId}/reabrir`, {}, c.token);
  assert.equal(semSaldo.status, 409, `saldo insuficiente precisa ser 409 de negócio, nunca 500: ${semSaldo.texto}`);
  assert.match(String(semSaldo.body?.error || ''), /saldo|Não há/i, 'a mensagem precisa explicar o saldo');
  assert.ok(!/constraint|SQLSTATE|erro interno/i.test(String(semSaldo.body?.error || '')), 'a resposta não pode vazar detalhe de banco nem dizer "erro interno"');

  const op2Depois = await req(baseUrl, 'GET', `/ordens/${op2.ordemId}`, undefined, c.token);
  assert.equal(op2Depois.body?.status, 'concluida', 'o estorno que não coube NÃO pode mudar o status (rollback)');
  const apsOp2 = await req(baseUrl, 'GET', `/ordens/${op2.ordemId}/apontamentos`, undefined, c.token);
  assert.equal((apsOp2.body || []).length, 1, 'o estorno que não coube NÃO pode descartar apontamentos (rollback)');
  assert.equal(await saldoInsumo(op2.insumoId), insumoAntes, 'o insumo da OP #2 não pode voltar num estorno que falhou');
  assert.equal(await saldoProduto(c, op2.produtoId, op2.tamanhoId), 0, 'o saldo do produto continua como estava');
  const saidasOp2 = await query<{ total: string }>(`SELECT count(*)::text AS total FROM movimentacoes WHERE empresa_id = $1 AND ordem_id = $2 AND tipo = 'saida'`, [c.empresaId, op2.ordemId]);
  assert.equal(saidasOp2.rows[0].total, '0', 'o estorno que não coube não pode registrar movimentação de estorno');

  // ---- P1-10 (efeito colateral): OP cancelada é terminal, com 409 -----------
  const op3 = await ordemConcluida(c, 3);
  const cancelada = await req(baseUrl, 'POST', `/ordens/${op3.ordemId}/cancelar`, { motivo: 'E02: cancelamento' }, c.token);
  const cancelarStatus = [200, 409].includes(cancelada.status) ? cancelada.status : -1;
  assert.ok(cancelarStatus === 200 || cancelarStatus === 409, `cancelar precisa responder 200/409, nunca 500: ${cancelada.texto}`);
  if (cancelarStatus === 200) {
    const ressuscitar = await req(baseUrl, 'PUT', `/ordens/${op3.ordemId}`, { status: 'em_producao' }, c.token);
    assert.equal(ressuscitar.status, 409, `OP cancelada é terminal: PUT precisa ser 409, nunca 500: ${ressuscitar.texto}`);
    const reabrirCancelada = await req(baseUrl, 'POST', `/ordens/${op3.ordemId}/reabrir`, {}, c.token);
    assert.equal(reabrirCancelada.status, 409, `reabrir OP cancelada é 409: ${reabrirCancelada.texto}`);
  }
});

test('ERP-02: 23514 (violação de CHECK) é erro de negócio 409 — nunca 500 nem vazamento', async () => {
  // Guarda de unidade da defesa em profundidade: qualquer CHECK violado em
  // qualquer recurso deixa de virar "Erro interno do servidor".
  const { translatePgError } = await import('../../src/pgstore');
  const { HttpError } = await import('../../src/errors');
  const erro = Object.assign(new Error('new row for relation "estoques" violates check constraint "estoques_quantidade_nao_negativo"'), {
    code: '23514',
    constraint: 'estoques_quantidade_nao_negativo',
    table: 'estoques',
  });

  const traduzido = translatePgError(erro);
  assert.ok(traduzido instanceof HttpError, '23514 precisa ser traduzido para erro HTTP');
  assert.equal(traduzido!.status, 409, 'violação de CHECK é conflito de negócio, não erro de servidor');
  assert.ok(!/estoques|constraint|23514|relation/i.test(traduzido!.message), `a mensagem não pode citar tabela/constraint: ${traduzido!.message}`);
});
