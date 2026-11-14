// ============================================================================
// TESTES AUTOMATIZADOS — CORREÇÃO CIRÚRGICA Nº 2
// (`scripts/perf/diagnostico.mjs` e `scripts/perf/_auth.mjs`)
//
// Cobre todos os cenários exigidos:
//   1. Preservação integral de autenticação + MFA/TOTP (sem bypass)
//   2. Recusa de segundo fator quando MFA já está ativo e PERF_TOTP_SECRET falta
//   3. Privacidade absoluta: senha, e-mail, token JWT, segredo TOTP e cookies
//      NUNCA aparecem em stdout/stderr, JSON ou Markdown
//   4. Todas as rotas comerciais/operacionais medidas são estritamente GET
//      (rotas POST/PUT/PATCH/DELETE ou com corpo são recusadas antes de chamar)
//   5. Transparência explícita no JSON e no Markdown sobre leitura GET vs
//      efeitos operacionais da autenticação (sessão, auditoria, estado MFA)
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — módulo ESM operacional em scripts/perf/
import { autenticar, gerarTotp } from '../../scripts/perf/_auth.mjs';
// @ts-expect-error — módulo ESM operacional em scripts/perf/
import {
  AVISO_ESCOPO_AUTENTICACAO,
  ROTAS_PADRAO,
  executarDiagnostico,
  tabelaMarkdown,
  validarRotasSomenteLeitura,
} from '../../scripts/perf/diagnostico.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = path.resolve(__dirname, '../..');
const SCRIPT_DIAG = path.join(RAIZ_REPO, 'scripts/perf/diagnostico.mjs');

const EMAIL_TECNICO = 'diag-tecnico-secreto@brobond.internal';
const SENHA_TECNICA = 'S3nhaUltraS3creta!9988';
const SEGREDO_TOTP = 'JBSWY3DPEHPK3PXP'; // RFC test base32 secret
const TOKEN_JWT_FICTICIO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OSJ9.assinaturaSecretaXYZ';
const COOKIE_SECRETO = 'brobond_sid=cookieSuperSecretoNaoPersistir';

async function iniciarServidorSimulado() {
  const chamadas: Array<{
    metodo: string;
    url: string;
    cookieRecebido: string | undefined;
    authHeader: string | undefined;
    corpoBytes: number;
  }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url || '/';
      chamadas.push({
        metodo: req.method || 'GET',
        url,
        cookieRecebido: req.headers.cookie,
        authHeader: req.headers.authorization,
        corpoBytes: raw.byteLength,
      });

      res.setHeader('Set-Cookie', `${COOKIE_SECRETO}; HttpOnly; Path=/`);
      res.setHeader('Server-Timing', 'app;dur=4.2, db;dur=1.8, pool;dur=0.2, externo;dur=0');
      res.setHeader('X-Request-Id', 'req-teste-diag-001');

      if (req.method === 'POST' && url === '/api/auth/login') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (body.email !== EMAIL_TECNICO || body.password !== SENHA_TECNICA) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'credenciais inválidas' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mfa_required: true, mfa_ticket: 'ticket-mfa-temporario-123' }));
        return;
      }

      if (req.method === 'POST' && url === '/api/auth/mfa/desafio') {
        // Simula produção onde o MFA já está ativo: não entrega o segredo novamente!
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MFA já ativo' }));
        return;
      }

      if (req.method === 'POST' && url === '/api/auth/login/mfa') {
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const esperado = gerarTotp(SEGREDO_TOTP);
        if (body.mfa_ticket !== 'ticket-mfa-temporario-123' || body.codigo !== esperado) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'TOTP inválido' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: TOKEN_JWT_FICTICIO }));
        return;
      }

      if (url === '/api/health' || url === '/api/health/db') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.headers.authorization !== `Bearer ${TOKEN_JWT_FICTICIO}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'não autenticado' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rows: [], total: 0 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Endereço inválido');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    chamadas,
    fechar: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('validarRotasSomenteLeitura aceita ROTAS_PADRAO e rejeita qualquer método != GET ou corpo', () => {
  const padrao = validarRotasSomenteLeitura(ROTAS_PADRAO);
  assert.equal(padrao.length, ROTAS_PADRAO.length);

  for (const metodoProibido of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => validarRotasSomenteLeitura([{ nome: 'escrita indevida', caminho: '/api/vendas', metodo: metodoProibido }]),
      /exclusivamente método GET/
    );
  }

  assert.throws(
    () => validarRotasSomenteLeitura([{ nome: 'com payload', caminho: '/api/produtos', corpo: { nome: 'X' } }]),
    /não permite corpo/
  );
});

test('CLI diagnostico.mjs recusa arquivo --rotas com método POST antes de abrir conexão', () => {
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brobond-diag-test-'));
  const arqRotas = path.join(dirTmp, 'rotas-invalidas.json');
  fs.writeFileSync(
    arqRotas,
    JSON.stringify([{ nome: 'criar pedido', caminho: '/api/vendas', metodo: 'POST' }])
  );
  try {
    const proc = spawnSync(
      process.execPath,
      [SCRIPT_DIAG, '--base', 'http://127.0.0.1:9', '--rotas', arqRotas],
      { cwd: RAIZ_REPO, encoding: 'utf8' }
    );
    assert.notEqual(proc.status, 0);
    assert.match(`${proc.stdout}\n${proc.stderr}`, /exclusivamente método GET/);
  } finally {
    fs.rmSync(dirTmp, { recursive: true, force: true });
  }
});

test('MFA preservado sem bypass: conta com MFA ativo falha sem PERF_TOTP_SECRET e autentica com TOTP válido', async (t) => {
  const srv = await iniciarServidorSimulado();
  t.after(() => srv.fechar());

  await assert.rejects(
    () => autenticar(srv.base, { email: EMAIL_TECNICO, senha: SENHA_TECNICA, totpSegredo: '' }),
    /MFA já está ativo e PERF_TOTP_SECRET não foi informado/
  );

  const authOk = await autenticar(srv.base, {
    email: EMAIL_TECNICO,
    senha: SENHA_TECNICA,
    totpSegredo: SEGREDO_TOTP,
  });
  assert.equal(authOk.token, TOKEN_JWT_FICTICIO);
  assert.equal(authOk.mfa, true);
  assert.ok(authOk.efeitosOperacionais.includes('sessao_criada'));
  assert.ok(authOk.efeitosOperacionais.includes('auditoria_login_mfa'));
});

test('Diagnóstico autenticado com MFA: somente GET nas rotas comerciais, zero vazamento e transparência no JSON/Markdown', async (t) => {
  const srv = await iniciarServidorSimulado();
  t.after(() => srv.fechar());

  const logs: string[] = [];
  const erros: string[] = [];
  const logger = {
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => erros.push(a.map(String).join(' ')),
  };

  const relatorio = await executarDiagnostico({
    base: srv.base,
    iteracoes: 2,
    concorrencia: 1,
    credenciais: {
      email: EMAIL_TECNICO,
      senha: SENHA_TECNICA,
      totpSegredo: SEGREDO_TOTP,
    },
    logger,
  });

  const jsonTexto = JSON.stringify(relatorio, null, 2);
  const mdTexto = tabelaMarkdown(relatorio.rotas, relatorio);
  const consoleTexto = [...logs, ...erros].join('\n');
  const artefatosCombinados = `${consoleTexto}\n${jsonTexto}\n${mdTexto}`;

  // 1. Privacidade absoluta: NADA sensível em console, JSON ou Markdown
  for (const segredo of [
    EMAIL_TECNICO,
    SENHA_TECNICA,
    SEGREDO_TOTP,
    TOKEN_JWT_FICTICIO,
    'eyJhbGci',
    COOKIE_SECRETO,
    'cookieSuperSecreto',
  ]) {
    assert.ok(
      !artefatosCombinados.includes(segredo),
      `Vazamento proibido detectado nos artefatos/logs: "${segredo}"`
    );
  }

  // 2. Todas as chamadas fora de /api/auth/login(/mfa) foram estritamente GET e sem corpo
  const chamadasNegocio = srv.chamadas.filter(
    (c) => c.url !== '/api/auth/login' && c.url !== '/api/auth/login/mfa'
  );
  assert.ok(chamadasNegocio.length >= ROTAS_PADRAO.length * 3);
  for (const ch of chamadasNegocio) {
    assert.equal(ch.metodo, 'GET', `rota comercial deve ser GET, recebido ${ch.metodo} em ${ch.url}`);
    assert.equal(ch.corpoBytes, 0, `rota GET não pode enviar corpo em ${ch.url}`);
    assert.equal(ch.cookieRecebido, undefined, 'diagnóstico não deve armazenar nem reenviar cookies');
  }

  // 3. Relatórios JSON e Markdown documentam explicitamente leitura GET vs efeitos de autenticação
  assert.equal(relatorio.escopo.rotas_comerciais_somente_leitura, true);
  assert.equal(relatorio.escopo.metodo_exclusivo_rotas, 'GET');
  assert.equal(relatorio.escopo.autenticado, true);
  assert.equal(relatorio.escopo.mfa_utilizado, true);
  assert.equal(relatorio.escopo.aviso, AVISO_ESCOPO_AUTENTICACAO);
  assert.match(mdTexto, /exclusivamente requisições GET/);
  assert.match(mdTexto, /efeitos operacionais de sessão, auditoria de acesso/);
});

test('Diagnóstico sem credenciais: mede apenas rotas públicas, não cria sessão e lista rotas não medidas', async (t) => {
  const srv = await iniciarServidorSimulado();
  t.after(() => srv.fechar());

  const logs: string[] = [];
  const erros: string[] = [];
  const relatorio = await executarDiagnostico({
    base: srv.base,
    iteracoes: 2,
    credenciais: {},
    logger: {
      log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => erros.push(a.map(String).join(' ')),
    },
  });

  assert.equal(relatorio.escopo.autenticado, false);
  assert.equal(relatorio.escopo.modo_autenticacao, 'somente_rotas_publicas');
  assert.deepEqual(relatorio.escopo.efeitos_operacionais_autenticacao, []);
  assert.equal(relatorio.rotas_nao_medidas.length, ROTAS_PADRAO.filter((r: { auth?: boolean }) => r.auth !== false).length);
  assert.ok(srv.chamadas.every((c) => c.metodo === 'GET'));

  const md = tabelaMarkdown(relatorio.rotas, relatorio);
  assert.match(md, /Rotas autenticadas não medidas nesta execução/);
});
