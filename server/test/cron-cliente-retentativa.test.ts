// Cinco jobs (Ordem Final, 2.1): cliente de execução com timeout, retentativa e códigos de saída.
// LOCAL: servidor HTTP simulado em 127.0.0.1; nenhuma chamada externa.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const SCRIPT = fileURLToPath(new URL('../../scripts/cron-processo.mjs', import.meta.url));
const SEGREDO = 'segredo-de-teste-cron-000111222';

type Roteiro = (n: number) => { status: number; body: unknown; atrasoMs?: number };

async function servidor(roteiro: Roteiro) {
  const chamadas: Array<{ url: string; auth: string | undefined; metodo: string }> = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    chamadas.push({ url: req.url || '', auth: req.headers.authorization, metodo: req.method || '' });
    const r = roteiro(chamadas.length);
    const envia = () => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); };
    if (r.atrasoMs) setTimeout(envia, r.atrasoMs); else envia();
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const { port } = srv.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, chamadas, fechar: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

function executar(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string; err: string }>((ok) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH || '', ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => ok({ code: code ?? -1, out, err }));
  });
}

const base = (url: string) => ({ BROBOND_BASE_URL: url, CRON_SECRET: SEGREDO, CRON_BACKOFF_MS: '10', CRON_CLIENT_TIMEOUT_MS: '5000' });
const OK = { ok: true, processo: 'crm', itens: 0, detalhes: [], falhas: [] };

describe('cliente de cron — contrato de execução', () => {
  test('sucesso na primeira tentativa: exit 0, Bearer correto, uma chamada, POST no processo', async () => {
    const s = await servidor(() => ({ status: 200, body: OK }));
    try {
      const r = await executar(['crm'], base(s.base));
      assert.equal(r.code, 0);
      assert.equal(s.chamadas.length, 1);
      assert.equal(s.chamadas[0].metodo, 'POST');
      assert.equal(s.chamadas[0].url, '/api/admin/scheduled/cron/crm');
      assert.equal(s.chamadas[0].auth, `Bearer ${SEGREDO}`);
      assert.ok(!r.out.includes(SEGREDO) && !r.err.includes(SEGREDO), 'segredo nunca é impresso');
    } finally { await s.fechar(); }
  });

  test('timeout do servidor (503 motivo timeout) é retentado e o sucesso seguinte encerra com 0', async () => {
    const s = await servidor((n) => (n === 1 ? { status: 503, body: { ok: false, motivo: 'timeout', processo: 'crm' } } : { status: 200, body: OK }));
    try {
      const r = await executar(['crm'], base(s.base));
      assert.equal(r.code, 0);
      assert.equal(s.chamadas.length, 2);
    } finally { await s.fechar(); }
  });

  test('401 (token inválido) não é retentado: exit 1 com uma chamada', async () => {
    const s = await servidor(() => ({ status: 401, body: { ok: false, error: 'Token inválido.' } }));
    try {
      const r = await executar(['crm'], base(s.base));
      assert.equal(r.code, 1);
      assert.equal(s.chamadas.length, 1);
    } finally { await s.fechar(); }
  });

  test('409 (já em execução) não é falha: exit 0 registrado como ignorado, sem retentar', async () => {
    const s = await servidor(() => ({ status: 409, body: { ok: false, motivo: 'ja_em_execucao' } }));
    try {
      const r = await executar(['crm'], base(s.base));
      assert.equal(r.code, 0);
      assert.equal(s.chamadas.length, 1);
      assert.match(r.out, /ignorado_concorrente/);
    } finally { await s.fechar(); }
  });

  test('falha persistente: exatamente CRON_MAX_TENTATIVAS (3) chamadas e exit 1', async () => {
    const s = await servidor(() => ({ status: 503, body: { ok: false, motivo: 'erro', processo: 'pedidos' } }));
    try {
      const r = await executar(['pedidos'], base(s.base));
      assert.equal(r.code, 1);
      assert.equal(s.chamadas.length, 3);
    } finally { await s.fechar(); }
  });

  test('cron desativado no servidor (503 sem motivo) não é retentado', async () => {
    const s = await servidor(() => ({ status: 503, body: { ok: false, error: 'Cron desativado: CRON_SECRET não configurado.' } }));
    try {
      const r = await executar(['crm'], base(s.base));
      assert.equal(r.code, 1);
      assert.equal(s.chamadas.length, 1);
    } finally { await s.fechar(); }
  });

  test('configuração inválida: sem CRON_SECRET, processo desconhecido, recorrências ou URL remota em http → exit 2 sem chamada', async () => {
    const s = await servidor(() => ({ status: 200, body: OK }));
    try {
      assert.equal((await executar(['crm'], { BROBOND_BASE_URL: s.base })).code, 2);
      assert.equal((await executar(['recorrencias'], base(s.base))).code, 2, 'recorrências não é processo de cron');
      assert.equal((await executar([], base(s.base))).code, 2);
      assert.equal((await executar(['crm'], { ...base(s.base), BROBOND_BASE_URL: 'http://exemplo.com' })).code, 2, 'remoto exige https');
      assert.equal(s.chamadas.length, 0);
    } finally { await s.fechar(); }
  });
});
