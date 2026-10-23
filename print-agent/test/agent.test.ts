// Testes do agente local (P1): backoff, renderer, journal anti-duplicação,
// runner ponta-a-ponta com ERP falso, API local só-loopback com Origin,
// segredo fora do log e conformidade de versão do PrintIR com o domínio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Backoff } from '../src/core/backoff.ts';
import { Logger, redact } from '../src/logging/logger.ts';
import { TextRenderer, RendererRegistry, PrintError, PRINT_IR_VERSION, type PrintIR } from '../src/renderer/renderer.ts';
import { DryRunPrinter, journalEm } from '../src/printer/printer.ts';
import { JobRunner } from '../src/queue/jobRunner.ts';
import { criarLocalServer, origemPermitida, ouvirLoopback } from '../src/transport/localServer.ts';
import { loadConfig, loadToken, saveConfig, saveToken } from '../src/config/config.ts';
import { PRINT_IR_VERSION as VERSAO_DOMINIO } from '../../packages/domain/src/print/print-ir.ts';

const ir = (jobId: string): PrintIR => ({
  version: PRINT_IR_VERSION,
  jobId,
  tenantId: '1',
  companyId: '1',
  requestedBy: { userId: 1, userName: 'Admin' },
  source: 'pdv',
  docType: 'recibo_pdv',
  copies: 1,
  priority: 0,
  content: [
    { kind: 'text', text: 'BROBOND', align: 'center', emphasis: 'title' },
    { kind: 'kv', label: 'Total', value: 'R$ 10,00' },
    { kind: 'barcode', value: '7891234567895' },
    { kind: 'cut' },
  ],
  metadata: {},
  idempotencyKey: 'k',
  createdAt: new Date().toISOString(),
});

test('agente: versão do PrintIR bate com o contrato canônico do domínio', () => {
  assert.equal(PRINT_IR_VERSION, VERSAO_DOMINIO);
});

test('agente: backoff cresce com teto e zera no sucesso', () => {
  const b = new Backoff(1000, 10_000, () => 0.5);
  assert.equal(b.proximaEspera(false), 1000);
  const e1 = b.proximaEspera(true);
  const e2 = b.proximaEspera(true);
  assert.ok(e2 > e1);
  for (let i = 0; i < 10; i++) b.proximaEspera(true);
  assert.ok(b.proximaEspera(true) <= 12_000, 'respeita o teto (+jitter)');
  assert.equal(b.proximaEspera(false), 1000);
});

test('agente: log nunca vaza token', () => {
  const linhas: string[] = [];
  const log = new Logger('debug', (l) => linhas.push(l));
  log.info('pareado', { token: 'bpa_' + 'a'.repeat(64) });
  assert.ok(!linhas.join(' ').includes('aaaa'));
  assert.match(redact('bpa_' + 'f'.repeat(64)), /\*\*\*/);
});

test('agente: config separa token do arquivo de configuração', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brobond-agent-'));
  const env = { BROBOND_PRINT_DIR: dir, BROBOND_ERP_URL: 'https://erp.exemplo.com.br/' } as NodeJS.ProcessEnv;
  const cfg = loadConfig(env);
  cfg.machineId = 'm-1';
  saveConfig(cfg);
  saveToken(cfg, 'bpa_segredo');
  assert.equal(loadToken(loadConfig(env), env), 'bpa_segredo');
  assert.equal(loadConfig(env).erpUrl, 'https://erp.exemplo.com.br');
  assert.equal(loadConfig(env).erpOrigin, 'https://erp.exemplo.com.br');
});

test('agente: text renderer traduz blocos sem conhecer impressora; registry recusa família ausente', async () => {
  const out = await new TextRenderer().render(ir('j1'));
  const txt = out.toString('utf8');
  assert.ok(txt.includes('BROBOND'));
  assert.ok(txt.includes('R$ 10,00'));
  assert.ok(txt.includes('[BARCODE 7891234567895]'));
  const reg = new RendererRegistry();
  assert.throws(() => reg.get('zpl'), (e: unknown) => e instanceof PrintError && e.code === 'RENDER_UNSUPPORTED' && !e.retryable);
});

test('agente: runner imprime uma vez, grava o journal antes do ack e deduplica no re-claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brobond-runner-'));
  const journal = journalEm(dir);
  const impressoes: string[] = [];
  const printer = new DryRunPrinter(join(dir, 'outbox'));
  const printerEspiao = {
    id: 'spy',
    print: async (jobId: string, payload: Buffer, copies: number) => {
      impressoes.push(jobId);
      await printer.print(jobId, payload, copies);
    },
    printers: async () => ['dry-run (arquivo)'],
  };
  const acks: { tipo: string; dedup?: boolean }[] = [];
  let disponivel = true;
  const clientFalso: any = {
    claim: async () => (disponivel ? { job: { public_id: 'pub-1', status: 'CLAIMED', copies: 2, printer_name: null, print_ir: ir('job-uuid-1') }, leaseToken: 'lease' } : null),
    printing: async () => acks.push({ tipo: 'printing' }),
    printed: async (_id: string, _lease: string, dedup: boolean) => acks.push({ tipo: 'printed', dedup }),
    fail: async () => acks.push({ tipo: 'fail' }),
  };
  const registry = new RendererRegistry();
  registry.register('text', new TextRenderer());
  const runner = new JobRunner(clientFalso, registry, printerEspiao as never, journal, new Logger('error'));

  assert.equal(await runner.processarProximo(), true);
  assert.deepEqual(impressoes, ['job-uuid-1']);
  assert.ok(journal.jaImprimiu('job-uuid-1'));
  assert.deepEqual(acks.at(-1), { tipo: 'printed', dedup: false });

  // Lease expirou antes do ack num cenário de crash: o mesmo job volta.
  assert.equal(await runner.processarProximo(), true);
  assert.deepEqual(impressoes, ['job-uuid-1'], 'journal impede a segunda impressão física');
  assert.deepEqual(acks.at(-1), { tipo: 'printed', dedup: true });

  disponivel = false;
  assert.equal(await runner.processarProximo(), false);
});

test('agente: runner reporta versão de PrintIR desconhecida como erro permanente', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brobond-runner-v-'));
  const falhas: any[] = [];
  const clientFalso: any = {
    claim: async () => ({ job: { public_id: 'pub-2', status: 'CLAIMED', copies: 1, printer_name: null, print_ir: { ...ir('job-v99'), version: 99 } }, leaseToken: 'l' }),
    printing: async () => {},
    printed: async () => {},
    fail: async (_id: string, _l: string, erro: unknown) => falhas.push(erro),
  };
  const registry = new RendererRegistry();
  registry.register('text', new TextRenderer());
  const runner = new JobRunner(clientFalso, registry, new DryRunPrinter(join(dir, 'out')) as never, journalEm(dir), new Logger('error'));
  await runner.processarProximo();
  assert.equal(falhas[0].code, 'IR_VERSION');
  assert.equal(falhas[0].retryable, false);
});

test('agente: API local escuta só em 127.0.0.1 e recusa Origin estranha', async () => {
  const server = criarLocalServer({
    version: '0.1.0',
    erpOrigin: 'https://erp.exemplo.com.br',
    status: () => ({ pareado: false, machineId: null, printers: [] }),
    pair: async () => ({ machine_id: 'm', nome: 'n' }),
  });
  await ouvirLoopback(server, 0);
  const addr = server.address() as { address: string; port: number };
  assert.equal(addr.address, '127.0.0.1');
  try {
    const ok = await fetch(`http://127.0.0.1:${addr.port}/health`, { headers: { origin: 'https://erp.exemplo.com.br' } });
    assert.equal(ok.status, 200);
    const estranha = await fetch(`http://127.0.0.1:${addr.port}/pair`, {
      method: 'POST',
      headers: { origin: 'https://site-qualquer.exemplo', 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: 'XXXX' }),
    });
    assert.equal(estranha.status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.equal(origemPermitida(undefined, 'https://erp.exemplo.com.br'), true);
  assert.equal(origemPermitida('https://outro.exemplo', 'https://erp.exemplo.com.br'), false);
});
