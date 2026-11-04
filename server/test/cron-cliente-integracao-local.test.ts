// Ordem Final 2.1 — integração LOCAL: o runner scripts/cron-processo.mjs contra o handler REAL
// (cronProcesso de server/src/scheduled.ts) montado numa aplicação Express em 127.0.0.1.
// Efeitos externos substituídos por executores de teste; nenhuma chamada de rede externa, nenhum banco.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const SCRIPT = fileURLToPath(new URL('../../scripts/cron-processo.mjs', import.meta.url));
const SEGREDO = 'segredo-de-teste-integracao-cron-333';
const express = (await import('express')).default;
const S: any = await import('../src/scheduled');

const chamadasExecutor: string[] = [];
const originais: Record<string, unknown> = { ...S.processosCron };
let servidor: Server;
let base = '';
let envAnterior: string | undefined;

before(async () => {
  envAnterior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SEGREDO;
  S.processosCron.crm = async () => { chamadasExecutor.push('crm'); return { itens: 2, detalhes: [], falhas: [] }; };
  S.processosCron.pedidos = async () => { chamadasExecutor.push('pedidos'); throw new Error('falha simulada do provedor'); };
  S.processosCron.pagamentos = async () => { chamadasExecutor.push('pagamentos'); await new Promise((r) => setTimeout(r, 700)); return { itens: 0, detalhes: [], falhas: [] }; };
  const app = express();
  app.post('/api/admin/scheduled/cron/:processo', S.cronProcesso);
  await new Promise<void>((ok) => { servidor = app.listen(0, '127.0.0.1', () => ok()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

after(() => {
  Object.assign(S.processosCron, originais);
  if (envAnterior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = envAnterior;
  return new Promise<void>((ok) => servidor.close(() => ok()));
});

function executar(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string; err: string }>((ok) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH || '', BROBOND_BASE_URL: base, CRON_BACKOFF_MS: '10', ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => ok({ code: code ?? -1, out, err }));
  });
}

describe('cron — runner × handler real (local)', () => {
  test('sucesso ponta a ponta: exit 0 e executor chamado uma vez', async () => {
    chamadasExecutor.length = 0;
    const r = await executar(['crm'], { CRON_SECRET: SEGREDO });
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(chamadasExecutor, ['crm']);
    assert.match(r.out, /cron_cliente_sucesso/);
    assert.ok(!r.out.includes(SEGREDO) && !r.err.includes(SEGREDO));
  });

  test('token errado: 401 real, exit 1, executor não é chamado', async () => {
    chamadasExecutor.length = 0;
    const r = await executar(['crm'], { CRON_SECRET: 'token-errado-000' });
    assert.equal(r.code, 1);
    assert.equal(chamadasExecutor.length, 0);
    assert.match(r.out, /"status":401/);
  });

  test('falha do executor: 503 motivo erro, 3 tentativas reais, exit 1', async () => {
    chamadasExecutor.length = 0;
    const r = await executar(['pedidos'], { CRON_SECRET: SEGREDO });
    assert.equal(r.code, 1);
    assert.equal(chamadasExecutor.length, 3);
    assert.match(r.out, /"motivo":"erro"/);
    assert.ok(!r.out.includes('falha simulada') && !r.err.includes('falha simulada'), 'mensagem bruta do erro não vai para o log');
  });

  test('concorrência real: duas chamadas simultâneas → uma executa, a outra recebe 409 e sai com 0 (ignorado)', async () => {
    chamadasExecutor.length = 0;
    const [a, b] = await Promise.all([
      executar(['pagamentos'], { CRON_SECRET: SEGREDO }),
      executar(['pagamentos'], { CRON_SECRET: SEGREDO }),
    ]);
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(b.code, 0, b.out + b.err);
    assert.equal(chamadasExecutor.length, 1, 'executor roda uma única vez');
    const saidas = [a.out, b.out];
    assert.equal(saidas.filter((o) => /ignorado_concorrente/.test(o)).length, 1, 'exatamente uma chamada é ignorada');
    assert.equal(saidas.filter((o) => /cron_cliente_sucesso/.test(o)).length, 1, 'exatamente uma chamada executa');
  });

  test('CRON_SECRET ausente no servidor: 503 sem motivo, exit 1 sem retentativa', async () => {
    chamadasExecutor.length = 0;
    const anterior = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const r = await executar(['crm'], { CRON_SECRET: SEGREDO });
      assert.equal(r.code, 1);
      assert.equal(chamadasExecutor.length, 0);
      assert.match(r.out, /"status":503/);
      assert.doesNotMatch(r.out, /"tentativa":2/);
    } finally { process.env.CRON_SECRET = anterior; }
  });
});
