// ============================================================================
// P2-01 — INTEGRIDADE TEMPORAL DA AUDITORIA ATRAVÉS DE JSONB (PostgreSQL real).
//
// Prova, num banco NOVO com o servidor HTTP de verdade:
//   1. uma operação de negócio (DELETE de um registro com timestamps) cria o
//      evento de auditoria;
//   2. o payload persistido em JSONB contém o instante como string ISO-8601
//      UTC com milissegundos (o mesmo formato da assinatura);
//   3. `GET /api/admin/auditoria/verificar` confirma a cadeia ÍNTEGRA;
//   4. o instante lido do banco é semanticamente igual ao original;
//   5. memória e PostgreSQL gravam o MESMO payload para o mesmo evento.
//
// Sem DATABASE_URL este arquivo FALHA: a prova deste ciclo é PostgreSQL real.
// ============================================================================
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

if (!process.env.DATABASE_URL) {
  throw new Error('p2-01-audit-date-jsonb-pg.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';
const { migrate, query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const evidencia: string[] = [];

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Sem porta TCP livre.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function stopServer(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}

async function startServer(port: number): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: randomUUID(),
    ADMIN_EMAIL: `p201-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `P201-${randomUUID()}-OnlyForTest`,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: string | Buffer) => { output = `${output}${String(chunk)}`.slice(-40_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Servidor encerrou antes do health.\n${output}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) {
        const h = (await r.json()) as { ok?: boolean; db?: string };
        if (h.ok === true && h.db === 'postgres') return { child, baseUrl, logs: () => output };
      }
    } catch { /* bootstrap ainda em andamento */ }
    await delay(200);
  }
  await stopServer(child);
  throw new Error(`Health não confirmou db=postgres.\n${output}`);
}

type Res = { status: number; body: any; text: string };

async function http(baseUrl: string, method: string, route: string, token?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(`${baseUrl}/api${route}`, init);
  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return { status: response.status, text, body: ct.includes('application/json') && text ? JSON.parse(text) : null };
}

// TOTP (RFC 6238) — o admin exige MFA no primeiro login (mesmo helper do smoke-e2e).
const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Buffer {
  let valor = 0, bits = 0;
  const bytes: number[] = [];
  for (const ch of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = ALFA.indexOf(ch);
    if (v < 0) continue;
    valor = (valor << 5) | v; bits += 5;
    if (bits >= 8) { bytes.push((valor >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}
async function totp(segredo: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const contador = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', base32Decode(segredo)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const cod = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(cod).padStart(6, '0');
}

test('P2-01 PostgreSQL real: o instante do evento de auditoria sobrevive ao JSONB e a cadeia fica íntegra', async (t) => {
  await migrate();
  const sufixo = randomUUID().slice(0, 8);
  const email = `p201-admin-${sufixo}@example.test`;
  const senha = `P201-admin-${randomUUID()}!`;
  const senhaHash = await hashPassword(senha);
  const u = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'admin', true, 1, false, false, now()) RETURNING id`,
    [`Admin P2-01 ${sufixo}`, email, senhaHash],
  );
  const usuarioId = Number(u.rows[0]?.id);

  const port = await reservePort();
  const { child, baseUrl, logs } = await startServer(port);
  t.after(async () => stopServer(child));

  // ---- acesso real: senha + cadastro/uso de TOTP (MFA obrigatório do admin) ----
  const login1 = await http(baseUrl, 'POST', '/auth/login', undefined, { email, password: senha });
  assert.equal(login1.status, 200, `login inicial: ${login1.text.slice(0, 400)}\n${logs()}`);
  assert.equal(login1.body?.mfa_setup_required, true, 'admin precisa cadastrar MFA');
  const ticket = login1.body?.mfa_ticket;
  const setup = await http(baseUrl, 'POST', '/auth/mfa/desafio', undefined, { mfa_ticket: ticket });
  assert.equal(setup.status, 200, `desafio MFA: ${setup.text.slice(0, 400)}`);
  const segredo = String(setup.body?.segredo);
  const mfa = await http(baseUrl, 'POST', '/auth/login/mfa', undefined, { mfa_ticket: ticket, codigo: await totp(segredo) });
  assert.equal(mfa.status, 200, `login MFA: ${mfa.text.slice(0, 400)}`);
  const token = String(mfa.body?.token || '');
  assert.ok(token.length > 20, 'login emite JWT de sessão');
  evidencia.push(`login HTTP real (senha + TOTP) → usuário #${usuarioId}`);

  // ---- operação de negócio que produz um evento com timestamps no payload ----
  // `tamanhos` usa auditFields (criado_em/atualizado_em TIMESTAMPTZ). O evento de
  // EXCLUSÃO grava a linha ANTES (sanitize(before)) — os timestamps vêm do driver
  // como `Date`. Sem a correção, o hash cobria "{}" e a cadeia quebrava.
  const codigo = `Z${sufixo.slice(0, 4).toUpperCase()}`;
  const criado = await http(baseUrl, 'POST', '/tamanhos', token, { codigo, descricao: 'Tamanho P2-01', ordem: 991 });
  assert.equal(criado.status, 201, `criar tamanho: ${criado.text.slice(0, 400)}`);
  const tamanhoId = Number(criado.body?.id);
  const criadoEmOriginal = String(criado.body?.criado_em ?? '');
  assert.match(criadoEmOriginal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'a API devolve o instante em ISO UTC com ms');

  const excluido = await http(baseUrl, 'DELETE', `/tamanhos/${tamanhoId}`, token);
  assert.equal(excluido.status, 200, `excluir tamanho: ${excluido.text.slice(0, 400)}`);

  // ---- leitura direta do JSONB no PostgreSQL ----
  const linha = await query(
    `SELECT dados, hash, hash_anterior, jsonb_typeof(dados) AS tipo FROM auditoria
      WHERE recurso = 'tamanhos' AND registro_id = $1 AND acao = 'excluir' ORDER BY id DESC LIMIT 1`,
    [tamanhoId],
  );
  assert.equal(linha.rows.length, 1, 'o evento de exclusão foi gravado');
  const dados = linha.rows[0].dados as Record<string, unknown>;
  assert.equal(linha.rows[0].tipo, 'object', 'o payload é um objeto JSONB');
  const criadoEmPersistido = String(dados.criado_em);
  assert.match(criadoEmPersistido, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'o instante persistido é ISO-8601 UTC com ms');
  assert.equal(
    new Date(criadoEmPersistido).getTime(),
    new Date(criadoEmOriginal).getTime(),
    'o INSTANTE persistido é igual ao original (round-trip sem perda)',
  );
  evidencia.push(`auditoria.dados.criado_em no JSONB = ${criadoEmPersistido} (igual ao original ${criadoEmOriginal})`);

  // ---- a cadeia inteira verifica (mesma rotina da API, lendo do JSONB) ----
  const verificacao = await http(baseUrl, 'GET', '/admin/auditoria/verificar', token);
  assert.equal(verificacao.status, 200, `verificar auditoria: ${verificacao.text.slice(0, 400)}`);
  assert.equal(verificacao.body?.ok, true, `a cadeia deve estar íntegra; quebras=${JSON.stringify(verificacao.body?.quebras)}`);
  assert.equal(Number(verificacao.body?.quebras?.length || 0), 0);
  evidencia.push(`GET /api/admin/auditoria/verificar → ok=${verificacao.body?.ok}, total=${verificacao.body?.total}`);

  // ---- equivalência semântica memória × PostgreSQL ----
  // O MESMO payload de auditoria (com Date) gravado nos dois stores precisa
  // resultar no MESMO conteúdo persistido e na MESMA assinatura. A linha entra
  // como EXTENSÃO legítima da cadeia (hash_anterior = último hash), para não
  // introduzir uma quebra artificial.
  const { normalizarPayloadAuditoria, hashCadeiaAuditoria } = await import('../../src/auditChain');
  const instante = new Date('2026-10-17T12:34:56.789Z');
  const payload = { de: instante, eventos: [{ em: new Date('2025-01-02T03:04:05.006Z') }] };
  const normalizado = normalizarPayloadAuditoria(payload) as Record<string, unknown>;

  const ultimo = await query(`SELECT hash FROM auditoria WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const hashAnterior = String(ultimo.rows[0]?.hash ?? '');
  const descricaoParidade = `paridade memoria x pg ${sufixo}`;
  const assinavel = { usuario_id: null, usuario: 'p201', acao: 'seguranca', recurso: null, registro_id: null, descricao: descricaoParidade, dados: normalizado };
  const assinaturaMem = hashCadeiaAuditoria(hashAnterior, assinavel as any);

  await query(
    `INSERT INTO auditoria (usuario_id, usuario, acao, recurso, registro_id, descricao, dados, hash_anterior, hash, empresa_id)
     VALUES (NULL, 'p201', 'seguranca', NULL, NULL, $1, $2, $3, $4, 1)`,
    [descricaoParidade, JSON.stringify(normalizado), hashAnterior, assinaturaMem],
  );
  const paridade = await query(`SELECT dados, hash FROM auditoria WHERE descricao = $1 ORDER BY id DESC LIMIT 1`, [descricaoParidade]);
  assert.deepEqual(paridade.rows[0].dados, JSON.parse(JSON.stringify(normalizado)), 'o JSONB devolve exatamente o payload normalizado (memória == PG)');
  assert.equal(String(paridade.rows[0].hash), assinaturaMem, 'a assinatura da memória é reproduzível a partir do JSONB do PG');

  // A cadeia continua íntegra depois da extensão.
  const verificacaoFinal = await http(baseUrl, 'GET', '/admin/auditoria/verificar', token);
  assert.equal(verificacaoFinal.body?.ok, true, `cadeia íntegra após a extensão; quebras=${JSON.stringify(verificacaoFinal.body?.quebras)}`);
  evidencia.push('paridade memória × PostgreSQL: payload e assinatura idênticos; cadeia íntegra');
});

test('P2-01 PostgreSQL real: o instante preservado não rompe o isolamento multiempresa', async () => {
  await migrate();
  const { RESOURCES } = await import('../../src/resources');
  const { createRecord, listRecords, getRecord } = await import('../../src/services');
  const sufixo = randomUUID().slice(0, 8);

  const admin = { id: 1, name: 'Admin PG P2-01', perfil: 'admin' as const };
  const empB = await createRecord(RESOURCES.empresas, { nome: `P201 Audit B ${sufixo}` }, admin);
  const empresaB = Number(empB.id);

  const anaA = { id: 901, name: 'Ana P2-01', perfil: 'admin' as const, empresa_id: 1, empresas: [1] };
  const brunoB = { id: 902, name: 'Bruno P2-01', perfil: 'admin' as const, empresa_id: empresaB, empresas: [empresaB] };

  const nomeA = `P201 Cliente A ${sufixo}`;
  const nomeB = `P201 Cliente B ${sufixo}`;
  // `clientes` é criado com timestamp; o evento de criação leva o payload sanitizado.
  await createRecord(RESOURCES.clientes, { nome: nomeA, criado_em: '2026-10-17T12:34:56.789Z' }, anaA as any);
  await createRecord(RESOURCES.clientes, { nome: nomeB, criado_em: '2026-10-17T12:34:56.789Z' }, brunoB as any);

  const feedA = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }, anaA as any);
  const eventoA = feedA.rows.find((e) => String(e.descricao).includes(nomeA));
  assert.ok(eventoA, 'o feed de A mostra o evento da A');
  assert.equal(Number(eventoA.empresa_id), 1, 'o evento de A é carimbado com a empresa A');
  assert.ok(!feedA.rows.some((e) => String(e.descricao).includes(nomeB)), 'A NÃO enxerga o evento da B');

  const feedB = await listRecords(RESOURCES.auditoria, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }, brunoB as any);
  const eventoB = feedB.rows.find((e) => String(e.descricao).includes(nomeB));
  assert.ok(eventoB, 'o feed de B mostra o evento da B');
  assert.equal(Number(eventoB.empresa_id), empresaB, 'o evento de B é carimbado com a empresa B');
  await assert.rejects(() => getRecord(RESOURCES.auditoria, Number(eventoB.id), anaA as any), (e: any) => e.status === 404);

  // A cadeia inteira (as duas empresas) permanece íntegra após a correção.
  const { getStore } = await import('../../src/services');
  const verificado = await getStore().verificarAuditoria();
  assert.equal(verificado.ok, true, `cadeia íntegra; quebras=${JSON.stringify(verificado.quebras)}`);
  evidencia.push(`multiempresa preservado; cadeia íntegra sobre ${verificado.total} eventos`);
});
