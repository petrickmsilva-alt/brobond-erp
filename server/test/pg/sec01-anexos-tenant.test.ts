// ============================================================================
// SEC-01 / P0-01 — ISOLAMENTO MULTIEMPRESA DE ARQUIVOS/ANEXOS (PostgreSQL real).
//
// A auditoria forense (PR #63) provou IDOR/BOLA cross-tenant no subsistema de
// fotos: `uploads.ts` buscava o REGISTRO-pai SÓ por id, sem recorte de empresa.
// Um ator da Empresa A listava, incluía e excluía fotos de um produto da
// Empresa B — enquanto `GET /produtos/{B}` respondia 404.
//
// Esta prova sobe o servidor de VERDADE contra um BANCO NOVO e percorre o
// caminho real `HTTP → requireAuth → rota → handler → escopo → PostgreSQL`,
// sem `req.user` injetado, sem memória e sem serviço externo:
//
//   1. A → GET  produto A/arquivos → 200 (legítimo)
//   2. A → GET  produto B/arquivos → 404 (cross-tenant negado, sem vazar nada)
//   3. A → POST produto A/arquivos → 201 (legítimo)
//   4. A → POST produto B/arquivos → 404 e NENHUM registro criado em B
//   5. A → PUT/DELETE arquivo A   → 200 (legítimo)
//   6. A → DELETE arquivo B       → 404 e o arquivo de B segue intacto
//   7. A → download arquivo A     → 200
//   8. A → download (id B + token de A) → 404 (o token de A não serve em B)
//   9. token de A → arquivo B     → 404
//  10. token de B → arquivo B     → 200 (capability legítima do dono)
//  11. anônimo → download com token válido → 200 (URL-capability PÚBLICA,
//      requisito do catálogo/portal públicos — decisão registrada, não regressão)
//   + spoofing: `empresa_id` da Empresa B no corpo é ignorado/rejeitado e a
//     posse final continua sendo a do registro-pai.
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
  throw new Error('sec01-anexos-tenant.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { query } = await import('../../src/db');
const { hashPassword } = await import('../../src/password');

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
type Child = ChildProcessByStdio<null, Readable, Readable>;

const RODADA = `sec01${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// PNG 1×1 válido (assinatura reconhecida por sniffMime).
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082',
  'hex',
);
const PNG_B64 = `data:image/png;base64,${PNG.toString('base64')}`;

function nomeDoBancoNovo(): string {
  return `brobond_sec01_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 60);
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
    ADMIN_EMAIL: `sec01-bootstrap-${randomUUID().slice(0, 8)}@example.test`,
    ADMIN_PASSWORD: `SEC01-${randomUUID()}-OnlyForTest`,
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
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

type Resposta = { status: number; body: any; texto: string; headers: Headers };

async function req(baseUrl: string, metodo: string, rota: string, corpo?: unknown, token?: string): Promise<Resposta> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  if (corpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${baseUrl}/api${rota}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  let body: any = null;
  try { body = JSON.parse(texto); } catch { body = null; }
  return { status: r.status, body, texto, headers: r.headers };
}

test('SEC-01/P0-01: fotos de produto são isoladas por empresa (listar/incluir/editar/excluir/download) e o token não cruza tenants', async (t) => {
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

  const evidencia: string[] = [];
  const registra = (texto: string) => evidencia.push(texto);

  // ---- Atores: A = empresa 1 (padrão), B = empresa nova --------------------
  const emailA = `sec01-a-${RODADA}@example.test`;
  const senhaA = `SEC01-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, 'gerente', true, 1, false, false, false, now())`,
    [`Gerente A ${RODADA}`, emailA, await hashPassword(senhaA)],
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, 1 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [emailA]);

  const empresaB = await cliente.query(`INSERT INTO empresas (nome, ativo) VALUES ($1, true) RETURNING id`, [`Filial SEC-01 ${RODADA}`]);
  const empresaBId = Number(empresaB.rows[0].id);
  const emailB = `sec01-b-${RODADA}@example.test`;
  const senhaB = `SEC01-${randomUUID()}!`;
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

  // ---- Produtos: um de cada empresa (o de B via SQL para não usar a sessão de A) ----
  const produtoA = await req(baseUrl, 'POST', '/produtos', { sku: `SEC01A${RODADA}`.toUpperCase().slice(0, 30), nome: `Produto A ${RODADA}`, preco_venda: 10, custo: 5 }, tokenA);
  assert.equal(produtoA.status, 201, `produto A: ${produtoA.texto}`);
  const produtoAId = Number(produtoA.body.id);

  const produtoB = await req(baseUrl, 'POST', '/produtos', { sku: `SEC01B${RODADA}`.toUpperCase().slice(0, 30), nome: `Produto B ${RODADA}`, preco_venda: 10, custo: 5 }, tokenB);
  assert.equal(produtoB.status, 201, `produto B: ${produtoB.texto}`);
  const produtoBId = Number(produtoB.body.id);
  assert.notEqual(produtoAId, produtoBId);

  // Controle: o produto de B realmente existe e é inacessível por A.
  assert.equal((await req(baseUrl, 'GET', `/produtos/${produtoBId}`, undefined, tokenA)).status, 404, 'A não pode ler o produto de B');
  assert.equal((await req(baseUrl, 'GET', `/produtos/${produtoBId}`, undefined, tokenB)).status, 200, 'B lê o próprio produto');

  // (1) A → GET produto A/arquivos → 200
  const listaA0 = await req(baseUrl, 'GET', `/produtos/${produtoAId}/arquivos`, undefined, tokenA);
  assert.equal(listaA0.status, 200, `A lista o próprio produto: ${listaA0.texto}`);
  assert.deepEqual(listaA0.body, []);
  registra(`A → GET /produtos/${produtoAId}/arquivos → 200 []`);

  // (2) A → GET produto B/arquivos → 404 (sem vazar existência/nome/contagem)
  const listaBporA = await req(baseUrl, 'GET', `/produtos/${produtoBId}/arquivos`, undefined, tokenA);
  assert.equal(listaBporA.status, 404, `A NÃO pode listar arquivos de B: ${listaBporA.texto}`);
  assert.equal(listaBporA.body?.error, 'Produto não encontrado(a).');
  registra(`A → GET /produtos/${produtoBId}/arquivos → 404 (cross-tenant negado)`);

  // (3) A → POST produto A/arquivos → 201
  const uploadA = await req(baseUrl, 'POST', `/produtos/${produtoAId}/arquivos`, { nome: 'a.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64 }, tokenA);
  assert.equal(uploadA.status, 201, `A inclui foto no próprio produto: ${uploadA.texto}`);
  const arquivoAId = Number(uploadA.body.id);
  const tokenArquivoA = String(uploadA.body.url).split('/').slice(-1)[0].replace(/\.[a-z0-9]+$/i, '');
  registra(`A → POST /produtos/${produtoAId}/arquivos → 201 (arquivo ${arquivoAId})`);

  // (4) A → POST produto B/arquivos → 404 e nenhum registro criado em B
  const antesB = Number((await cliente.query(`SELECT count(*)::int n FROM arquivos WHERE recurso = 'produtos' AND registro_id = $1`, [produtoBId])).rows[0].n);
  const uploadBporA = await req(baseUrl, 'POST', `/produtos/${produtoBId}/arquivos`, { nome: 'invasao.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64 }, tokenA);
  assert.equal(uploadBporA.status, 404, `A NÃO pode incluir foto em B: ${uploadBporA.texto}`);
  const depoisB = Number((await cliente.query(`SELECT count(*)::int n FROM arquivos WHERE recurso = 'produtos' AND registro_id = $1`, [produtoBId])).rows[0].n);
  assert.equal(depoisB, antesB, 'tentativa rejeitada não pode criar arquivo em B');
  registra(`A → POST /produtos/${produtoBId}/arquivos → 404; arquivos de B antes=${antesB}, depois=${depoisB}`);

  // (4b) spoofing: empresa_id de B no corpo continua sendo recusado/relevado
  const spoofBporA = await req(baseUrl, 'POST', `/produtos/${produtoBId}/arquivos`, { nome: 'spoof.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64, empresa_id: empresaBId }, tokenA);
  assert.equal(spoofBporA.status, 404, `spoof de empresa em B NÃO pode passar: ${spoofBporA.texto}`);
  const spoofA = await req(baseUrl, 'POST', `/produtos/${produtoAId}/arquivos`, { nome: 'spoof-ok.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64, empresa_id: empresaBId }, tokenA);
  assert.equal(spoofA.status, 201, `empresa_id forjado em A é ignorado e o anexo vai para o pai de A: ${spoofA.texto}`);
  const spoofAId = Number(spoofA.body.id);
  await cliente.query(`DELETE FROM arquivos WHERE id = $1`, [spoofAId]);
  registra('spoof empresa_id=B: POST em B → 404; POST em A com empresa_id=B → 201 (posse = pai de A)');

  // ---- Arquivo real de B, criado via HTTP por B (fonte legítima) ----
  const uploadB = await req(baseUrl, 'POST', `/produtos/${produtoBId}/arquivos`, { nome: 'b.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64 }, tokenB);
  assert.equal(uploadB.status, 201, `B inclui foto no próprio produto: ${uploadB.texto}`);
  const arquivoBId = Number(uploadB.body.id);
  const tokenArquivoB = String(uploadB.body.url).split('/').slice(-1)[0].replace(/\.[a-z0-9]+$/i, '');

  // (5) A → DELETE arquivo A → 200
  const delA = await req(baseUrl, 'DELETE', `/produtos/${produtoAId}/arquivos/${arquivoAId}`, undefined, tokenA);
  assert.equal(delA.status, 200, `A exclui a própria foto: ${delA.texto}`);

  // (6) A → DELETE arquivo B → 404 e o arquivo de B segue intacto
  const delBporA = await req(baseUrl, 'DELETE', `/produtos/${produtoBId}/arquivos/${arquivoBId}`, undefined, tokenA);
  assert.equal(delBporA.status, 404, `A NÃO pode excluir foto de B: ${delBporA.texto}`);
  const arquivoBExiste = Number((await cliente.query(`SELECT count(*)::int n FROM arquivos WHERE id = $1`, [arquivoBId])).rows[0].n);
  assert.equal(arquivoBExiste, 1, 'o arquivo de B precisa continuar existindo');
  registra(`A → DELETE /produtos/${produtoBId}/arquivos/${arquivoBId} → 404; arquivo de B intacto`);

  // (5b) A → PUT (reordenar/promover) em B → 404
  const putBporA = await req(baseUrl, 'PUT', `/produtos/${produtoBId}/arquivos/${arquivoBId}`, { principal: true }, tokenA);
  assert.equal(putBporA.status, 404, `A NÃO pode editar foto de B: ${putBporA.texto}`);

  // (7) A → download do arquivo A recém-enviado → 200
  const uploadA2 = await req(baseUrl, 'POST', `/produtos/${produtoAId}/arquivos`, { nome: 'a2.png', mime: 'image/png', dados: PNG_B64, thumb: PNG_B64 }, tokenA);
  assert.equal(uploadA2.status, 201, `A envia segunda foto: ${uploadA2.texto}`);
  const arquivoA2Id = Number(uploadA2.body.id);
  const tokenArquivoA2 = String(uploadA2.body.url).split('/').slice(-1)[0].replace(/\.[a-z0-9]+$/i, '');
  const downloadA = await fetch(`${baseUrl}/api/files/${arquivoA2Id}/${tokenArquivoA2}.png`);
  assert.equal(downloadA.status, 200, 'download legítimo do dono');
  assert.equal(downloadA.headers.get('content-type'), 'image/png');
  registra(`download /api/files/${arquivoA2Id}/<token A> → 200 image/png`);

  // (8)/(9) token de A NÃO serve no arquivo de B (id e token precisam casar)
  const crossToken = await fetch(`${baseUrl}/api/files/${arquivoBId}/${tokenArquivoA2}.png`);
  assert.equal(crossToken.status, 404, 'token de A não pode abrir o arquivo de B');
  const tokenCrossA = await fetch(`${baseUrl}/api/files/${arquivoA2Id}/${tokenArquivoB}.png`);
  assert.equal(tokenCrossA.status, 404, 'token de B não pode abrir o arquivo de A');
  registra('token A → arquivo B → 404; token B → arquivo A → 404 (id+token precisam casar)');

  // (10) token de B → arquivo de B → 200 (capability legítima)
  const downloadB = await fetch(`${baseUrl}/api/files/${arquivoBId}/${tokenArquivoB}.png`);
  assert.equal(downloadB.status, 200, 'download legítimo do dono B');

  // (11) anônimo com token válido → 200 (URL-capability pública do catálogo/portal)
  const anon = await fetch(`${baseUrl}/api/files/${arquivoBId}/${tokenArquivoB}.png`);
  assert.equal(anon.status, 200, 'a URL-capability pública continua servindo o dono');
  assert.match(String(anon.headers.get('cache-control')), /public/);
  registra('anônimo → /api/files/:id/:token (token válido) → 200 (capability pública: catálogo/portal)');

  // ---- Não-regressão: B opera normalmente nos próprios anexos ----
  const listaBporB = await req(baseUrl, 'GET', `/produtos/${produtoBId}/arquivos`, undefined, tokenB);
  assert.equal(listaBporB.status, 200, `B lista o próprio produto: ${listaBporB.texto}`);
  assert.equal(listaBporB.body.length, 1);
  assert.equal(Number(listaBporB.body[0].id), arquivoBId);
  registra(`B → GET /produtos/${produtoBId}/arquivos → 200 (1 arquivo: o de B)`);

  // ---- PostgreSQL: posse final dos arquivos, por empresa ----
  const dono = await cliente.query(
    `SELECT a.id, a.registro_id, p.empresa_id
       FROM arquivos a JOIN produtos p ON p.id = a.registro_id
      WHERE a.id = ANY($1::int[]) ORDER BY a.id`,
    [[arquivoA2Id, arquivoBId]],
  );
  assert.deepEqual(
    dono.rows.map((r: any) => ({ id: Number(r.id), empresa_id: Number(r.empresa_id) })),
    [{ id: arquivoBId, empresa_id: empresaBId }, { id: arquivoA2Id, empresa_id: 1 }],
    'cada arquivo pertence à empresa do seu registro-pai',
  );
  const totalB = Number((await cliente.query(`SELECT count(*)::int n FROM arquivos WHERE registro_id = $1`, [produtoBId])).rows[0].n);
  assert.equal(totalB, 1, 'nenhum arquivo cross-tenant foi criado em B');

  await t.test('evidência SEC-01', () => {
    for (const linha of evidencia) console.log(`  • ${linha}`);
    void logs;
  });
});
