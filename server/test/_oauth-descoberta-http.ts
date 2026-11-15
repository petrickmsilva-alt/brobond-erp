// ============================================================================
// OAUTH › DESCOBERTA POR HTTP REAL — harness compartilhado
//
// Sobe o SERVIDOR REAL (`server/src/index.ts`, o mesmo arquivo do
// `npm --workspace server start` da Render) num processo filho e confere os
// documentos de descoberta pela REDE, sem seguir redirecionamentos. Nada de
// Express montado à mão nem de handler chamado direto: o que se mede é a
// cadeia inteira de middlewares, na ordem em que o `index.ts` a registra.
//
// Usado por:
//   • test/oauth-well-known-http.test.ts            (memória — job `verificar`)
//   • test/pg/oauth-well-known-producao.test.ts     (NODE_ENV=production +
//     PostgreSQL real + fallback do SPA ativo — gate `test:pg`)
//
// Este arquivo NÃO é um *.test.ts: o runner não o coleta.
// ============================================================================
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));

export const CAMINHO_AS = '/.well-known/oauth-authorization-server';
export const CAMINHO_RS = '/.well-known/oauth-protected-resource';
export const CAMINHO_JWKS = '/.well-known/jwks.json';

export interface ServidorDeTeste {
  base: string;
  encerrar: () => Promise<void>;
  saida: () => string;
}

/** Porta TCP livre escolhida pelo sistema operacional. */
function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const endereco = s.address();
      const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;
      s.close(() => resolve(porta));
    });
  });
}

/** Credenciais EFÊMERAS geradas por execução; nunca são impressas. */
export function segredosEfemeros(): Record<string, string> {
  return {
    JWT_SECRET: randomBytes(32).toString('hex'),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: `A!${randomBytes(24).toString('hex')}`,
  };
}

/**
 * Sobe o servidor real e espera `/api/health` declarar `pronto: true`.
 * Chaves com valor `undefined` em `env` são REMOVIDAS do ambiente do filho.
 */
export async function subirServidor(env: Record<string, string | undefined>, limiteMs = 120_000): Promise<ServidorDeTeste> {
  const porta = await portaLivre();
  const ambiente: NodeJS.ProcessEnv = { ...process.env, ...segredosEfemeros(), ...env, PORT: String(porta) };
  for (const [chave, valor] of Object.entries(env)) if (valor === undefined) delete ambiente[chave];

  const filho: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: ambiente,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  filho.stdout?.on('data', (d) => { saida = (saida + String(d)).slice(-6000); });
  filho.stderr?.on('data', (d) => { saida = (saida + String(d)).slice(-6000); });

  const encerrar = () =>
    new Promise<void>((resolve) => {
      if (filho.exitCode !== null || filho.signalCode !== null) return resolve();
      filho.once('exit', () => resolve());
      filho.kill('SIGTERM');
      setTimeout(() => filho.kill('SIGKILL'), 5_000).unref();
    });

  const base = `http://127.0.0.1:${porta}`;
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (filho.exitCode !== null) throw new Error(`O servidor encerrou no boot (código ${filho.exitCode}):\n${saida}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
      const corpo = (await r.json()) as { pronto?: boolean };
      if (r.status === 200 && corpo.pronto === true) return { base, encerrar, saida: () => saida };
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await encerrar();
  throw new Error(`O servidor não ficou pronto em ${limiteMs} ms:\n${saida}`);
}

export interface RespostaCrua {
  status: number;
  contentType: string;
  location: string | null;
  texto: string;
}

/**
 * GET como um NAVEGADOR faria (Accept de navegação), SEM seguir
 * redirecionamentos: um 3xx aparece como 3xx, não como a página de destino.
 */
export async function obter(base: string, caminho: string, init: RequestInit = {}): Promise<RespostaCrua> {
  const r = await fetch(base + caminho, {
    redirect: 'manual',
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
  return {
    status: r.status,
    contentType: r.headers.get('content-type') ?? '',
    location: r.headers.get('location'),
    texto: await r.text(),
  };
}

/** A resposta é um documento JSON servido direto — nem SPA, nem redirecionamento. */
export function exigirJsonDireto(r: RespostaCrua, rotulo: string): Record<string, unknown> {
  assert.equal(r.status, 200, `${rotulo}: esperado HTTP 200, veio ${r.status}`);
  assert.match(r.contentType, /^application\/json\b/i, `${rotulo}: Content-Type deve ser application/json, veio "${r.contentType}"`);
  assert.equal(r.location, null, `${rotulo}: não pode haver cabeçalho Location (redirecionamento)`);
  assert.doesNotMatch(r.texto, /<!doctype html|<html[\s>]|<div id="root"/i, `${rotulo}: o corpo é o index.html do frontend`);
  let corpo: unknown;
  assert.doesNotThrow(() => { corpo = JSON.parse(r.texto); }, `${rotulo}: o corpo não é JSON válido`);
  assert.ok(corpo && typeof corpo === 'object' && !Array.isArray(corpo), `${rotulo}: o corpo deve ser um objeto JSON`);
  return corpo as Record<string, unknown>;
}

/**
 * Confere os dois documentos de descoberta contra a configuração REAL do
 * processo (`OAUTH_ISSUER` / `OAUTH_RESOURCE` com que o servidor foi iniciado).
 */
export async function conferirDescoberta(base: string, config: { issuer: string; resource: string }): Promise<void> {
  // ---- Authorization Server Metadata (RFC 8414) ---------------------------
  const as = exigirJsonDireto(await obter(base, CAMINHO_AS), 'Authorization Server Metadata');
  assert.equal(as.issuer, config.issuer, 'issuer deve ser o OAUTH_ISSUER configurado');
  assert.equal(as.authorization_endpoint, `${config.issuer}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${config.issuer}/oauth/token`);
  assert.equal(as.registration_endpoint, `${config.issuer}/oauth/register`, 'DCR continua anunciado');
  assert.equal(as.revocation_endpoint, `${config.issuer}/oauth/revoke`);
  assert.equal(as.jwks_uri, `${config.issuer}${CAMINHO_JWKS}`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'], 'PKCE S256 continua sendo o único método');
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none', 'client_secret_post']);

  // ---- Protected Resource Metadata (RFC 9728) -----------------------------
  const rs = exigirJsonDireto(await obter(base, CAMINHO_RS), 'Protected Resource Metadata');
  assert.equal(rs.resource, config.resource, 'resource deve ser o OAUTH_RESOURCE configurado');
  assert.deepEqual(rs.authorization_servers, [config.issuer], 'o Resource Server aponta para o issuer configurado');
  assert.deepEqual(rs.bearer_methods_supported, ['header']);
  assert.deepEqual(rs.scopes_supported, as.scopes_supported, 'os dois documentos anunciam os mesmos escopos');
  assert.ok(Array.isArray(rs.scopes_supported) && rs.scopes_supported.length > 0);

  // ---- JWKS: RS256, só a chave pública -------------------------------------
  const jwks = exigirJsonDireto(await obter(base, CAMINHO_JWKS), 'JWKS') as { keys?: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(jwks.keys) && jwks.keys.length >= 1, 'JWKS publica ao menos uma chave');
  for (const k of jwks.keys) {
    assert.equal(k.kty, 'RSA');
    assert.equal(k.alg, 'RS256');
    assert.ok(!('d' in k), 'o JWKS nunca inclui a chave privada');
  }

  // ---- Nenhum segredo nos documentos públicos ------------------------------
  for (const doc of [as, rs]) {
    assert.doesNotMatch(JSON.stringify(doc), /secret"|password|private|BEGIN [A-Z ]*KEY/i, 'documento de descoberta não carrega segredo');
  }
}
