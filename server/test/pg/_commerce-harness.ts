// Harness compartilhado das provas PG de Commerce: servidor REAL filho em porta
// efêmera + cliente HTTP + criação de usuários. (Prefixo `_`: não é suíte.)
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from 'pg';
import type { Readable } from 'node:stream';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
export type Child = ChildProcessByStdio<null, Readable, Readable>;

export async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível reservar porta TCP.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

export async function startRealServer(port: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ child: Child; baseUrl: string; logs: () => string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(port), JWT_SECRET: randomUUID(), ...extraEnv };
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
      /* migrações/health em andamento */
    }
    await delay(200);
  }
  throw new Error(`Health check não confirmou db=postgres em 120 s.\n${output}`);
}

export async function stopServer(child: Child): Promise<void> {
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

export type Resposta = { status: number; body: any; texto: string; headers: Headers };

export function criarCliente(baseUrl: string) {
  return async function req(metodo: string, rota: string, corpo?: unknown, token?: string | null, headers?: Record<string, string>): Promise<Resposta> {
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
    return { status: r.status, body, texto, headers: r.headers };
  };
}

/** GET de página HTML do storefront (fora de /api). */
export async function paginaHtml(baseUrl: string, caminho: string): Promise<{ status: number; html: string; headers: Headers }> {
  const r = await fetch(`${baseUrl}${caminho}`, { headers: { accept: 'text/html' } });
  return { status: r.status, html: await r.text(), headers: r.headers };
}

export async function criarUsuario(cliente: Client, hashPassword: (s: string) => Promise<string>, nome: string, email: string, perfil: string, empresaId: number): Promise<string> {
  const senha = `Ce2e-${randomUUID()}!`;
  await cliente.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo, empresa_id, pode_consolidar, trocar_senha, senha_provisoria, senha_definida_em)
     VALUES ($1, $2, $3, $4, true, $5, false, false, false, now())`,
    [nome, email, await hashPassword(senha), perfil, empresaId]
  );
  await cliente.query(`INSERT INTO usuario_empresas (usuario_id, empresa_id) SELECT id, $2 FROM usuarios WHERE email = $1 ON CONFLICT DO NOTHING`, [email, empresaId]);
  return senha;
}

export const msg = (r: Resposta) => `${r.status} ${r.texto.slice(0, 300)}`;
