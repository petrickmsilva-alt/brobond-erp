import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EscPosRenderer } from '../src/renderer/escposRenderer.ts';
import { ZplRenderer } from '../src/renderer/zplRenderer.ts';
import { Epl2Renderer } from '../src/renderer/epl2Renderer.ts';
import { PrintError, PRINT_IR_VERSION, type PrintIR } from '../src/renderer/renderer.ts';
import { criarRegistryPadrao } from '../src/core/agent.ts';
import { safeOutboxPath, sanitizePrinterTarget } from '../src/printer/printer.ts';
import { criarLocalServer, ouvirLoopback } from '../src/transport/localServer.ts';

function makeIr(partial: Partial<PrintIR>): PrintIR {
  return {
    version: PRINT_IR_VERSION,
    jobId: 'job-test-0001',
    tenantId: '1',
    companyId: '1',
    requestedBy: { userId: 1, userName: 'Admin' },
    source: 'pdv',
    docType: 'recibo_pdv',
    copies: 1,
    priority: 0,
    content: [{ kind: 'text', text: 'Teste' }],
    metadata: {},
    idempotencyKey: 'idem-test-0001',
    createdAt: '2026-10-23T12:00:00.000Z',
    ...partial,
  };
}

test('ESC/POS renderer: inicializa impressora, formata tabela/KV/QR/barcode/corte e neutraliza injeção ESC/GS', async () => {
  const r = new EscPosRenderer();
  const bytes = await r.render(
    makeIr({
      metadata: { protocol: 'escpos', widthCols: 48 },
      content: [
        { kind: 'text', text: 'BROBOND LOJA\x1b@\x1dV\x00INJECAO', align: 'center', emphasis: 'title' },
        { kind: 'separator' },
        {
          kind: 'table',
          columns: [
            { header: 'Item', align: 'left', width: 28 },
            { header: 'Qtd', align: 'right', width: 8 },
            { header: 'Total', align: 'right', width: 12 },
          ],
          rows: [['Camiseta Basica P', '2', 'R$ 159,80']],
        },
        { kind: 'separator' },
        { kind: 'kv', label: 'TOTAL', value: 'R$ 159,80' },
        { kind: 'qrcode', value: 'https://sefaz.exemplo/nfce?p=123' },
        { kind: 'barcode', value: 'VENDA-101', symbology: 'code128' },
        { kind: 'spacer', lines: 3 },
        { kind: 'cut' },
      ],
    })
  );

  // Header de inicialização ESC @ (1B 40) + CP850 ESC t 2 (1B 74 02)
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  assert.equal(bytes[2], 0x1b);
  assert.equal(bytes[3], 0x74);
  assert.equal(bytes[4], 0x02);

  // QR Code GS ( k presente
  const hex = bytes.toString('hex');
  assert.ok(hex.includes('1d286b'), 'deve emitir comando nativo GS ( k de QR Code');
  // Corte parcial GS V 66 0 (1d 56 42 00) no final
  assert.ok(hex.endsWith('1d564200'), 'deve encerrar com corte parcial GS V 66 0');

  // Injeção de full cut GS V 0 (1d 56 00) contida no nome da loja foi removida
  assert.ok(!hex.includes('1d5600'), 'sequência maliciosa GS V 0 deve ser neutralizada');
});

test('ZPL II renderer: gera ^XA..^XZ com EAN-13 válido, aplica ^PQ em lote e escapa ^/~ contra injeção ZPL', async () => {
  const r = new ZplRenderer();
  const bytes = await r.render(
    makeIr({
      source: 'etiquetas',
      docType: 'etiqueta_produto',
      metadata: { protocol: 'zpl', labelWidthMm: 50, labelHeightMm: 30, dpi: 203 },
      content: [
        { kind: 'text', text: 'Produto ^XZ^XA^FDINJETADO~HS', emphasis: 'bold' },
        { kind: 'text', text: 'SKU-01 · Tam: M · Azul' },
        { kind: 'barcode', value: '7891000100103', symbology: 'ean13' },
        { kind: 'text', text: 'R$ 89,90', emphasis: 'bold' },
        { kind: 'cut', repeat: 15 },
      ],
    })
  );

  const zpl = bytes.toString('utf8');
  assert.ok(zpl.startsWith('^XA'), 'deve abrir com ^XA');
  assert.ok(zpl.trimEnd().endsWith('^XZ'), 'deve fechar com ^XZ');
  assert.ok(zpl.includes('^PQ15,0,1,Y'), 'deve emitir ^PQ15 para lote de 15 etiquetas');
  assert.ok(zpl.includes('^BEN,'), 'deve emitir instrução ^BE para EAN-13');
  assert.ok(!zpl.includes('^FDINJETADO'), 'nunca deve permitir ^XZ^XA^FD literal vindo de campo de texto');
  assert.ok(
    zpl.toUpperCase().includes('_5EXZ_5EXA_5EFDINJETADO_7EHS') ||
      zpl.toUpperCase().includes('\\5EXZ\\5EXA\\5EFDINJETADO\\7EHS'),
    'deve escapar ^ e ~ com ^FH'
  );
});

test('ZPL II e EPL2 renderers: rejeitam EAN/GTIN com dígito verificador inválido como erro permanente', async () => {
  const zpl = new ZplRenderer();
  const epl = new Epl2Renderer();

  await assert.rejects(
    () =>
      zpl.render(
        makeIr({
          docType: 'etiqueta_produto',
          metadata: { protocol: 'zpl' },
          content: [{ kind: 'barcode', value: '7891000100109', symbology: 'ean13' }],
        })
      ),
    (err: unknown) => err instanceof PrintError && err.code === 'INVALID_EAN' && err.retryable === false
  );

  await assert.rejects(
    () =>
      epl.render(
        makeIr({
          docType: 'etiqueta_produto',
          metadata: { protocol: 'epl2' },
          content: [{ kind: 'barcode', value: '036000291459', symbology: 'upca' }],
        })
      ),
    (err: unknown) => err instanceof PrintError && err.code === 'INVALID_EAN' && err.retryable === false
  );
});

test('EPL2 renderer: suporta EAN-8, UPC-A, EAN-13, GTIN-14 e Code128, emite P<n> e neutraliza aspas/quebras', async () => {
  const epl = new Epl2Renderer();
  const bytes = await epl.render(
    makeIr({
      docType: 'etiqueta_produto',
      metadata: { protocol: 'epl2', labelWidthMm: 50, labelHeightMm: 30, dpi: 203 },
      content: [
        { kind: 'text', text: 'Calca "Jeans"\nP9999\r\n' },
        { kind: 'barcode', value: 'SKU-INT-99', symbology: 'code128' },
        { kind: 'cut', repeat: 7 },
      ],
    })
  );

  const txt = bytes.toString('latin1');
  assert.ok(txt.includes('\nN\n') || txt.startsWith('N\n'), 'deve limpar buffer de imagem com comando N');
  assert.ok(txt.includes('P7\n'), 'deve imprimir exatamente 7 etiquetas via P7');
  assert.ok(!txt.includes('P9999\n'), 'quebra de linha em texto não pode injetar comando P9999');
});

test('criarRegistryPadrao(): despacha text/escpos/zpl/epl2 e rejeita protocolo desconhecido sem fallback silencioso', () => {
  const reg = criarRegistryPadrao();
  assert.equal(reg.forJob('recibo_pdv', {}).id, 'escpos');
  assert.equal(reg.forJob('etiqueta_produto', {}).id, 'zpl');
  assert.equal(reg.forJob('etiqueta_produto', { protocol: 'epl2' }).id, 'epl2');
  assert.equal(reg.forJob('pedido', {}).id, 'text');

  assert.throws(
    () => reg.forJob('etiqueta_produto', { protocol: 'pcl5_desconhecido' }),
    (err: unknown) => err instanceof PrintError && err.code === 'UNSUPPORTED_PROTOCOL' && err.retryable === false
  );
});

test('Hardening P6 printer/outbox: bloqueia command injection em printerName e path traversal no outbox', () => {
  assert.equal(sanitizePrinterTarget('Zebra_ZD220').kind, 'spooler');
  assert.deepEqual(sanitizePrinterTarget('tcp://192.168.0.50:9100'), {
    kind: 'tcp',
    host: '192.168.0.50',
    port: 9100,
  });

  for (const malicioso of [
    'Zebra; rm -rf /',
    '$(whoami)',
    '`id`',
    '-oProxyCommand=evil',
    '../../etc/passwd',
    'tcp://192.168.0.50:99999',
  ]) {
    assert.throws(
      () => sanitizePrinterTarget(malicioso),
      (err: unknown) => err instanceof PrintError && err.retryable === false,
      `deveria bloquear printerName malicioso: ${malicioso}`
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'brobond-outbox-test-'));
  try {
    const p = safeOutboxPath(tmp, '../../../etc/shadow', 'zpl');
    assert.ok(p.startsWith(tmp), 'arquivo de outbox jamais pode escapar do diretório base');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Hardening P6 localServer: vincula a 127.0.0.1, bloqueia DNS rebinding (Host) e Origin externo (CSRF)', async () => {
  const srv = criarLocalServer({
    version: '0.2.0',
    erpOrigin: 'https://erp.brobond.com.br',
    status: async () => ({
      pareado: true,
      machineId: 'm-1',
      terminal: 'CX-1',
      printers: ['Zebra_ZD220'],
    }),
    pair: async () => ({ machine_id: 'm-1', nome: 'Agente CX-1' }),
  });
  await ouvirLoopback(srv, 0);

  try {
    const addr = srv.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1', 'deve escutar estritamente em 127.0.0.1');

    const reqLocal = (headers: Record<string, string>, method = 'GET', path = '/health', body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: addr.port, method, path, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });

    // 1. Chamada legítima do ERP autorizado
    const okRes = await reqLocal({ Host: `127.0.0.1:${addr.port}`, Origin: 'https://erp.brobond.com.br' });
    assert.equal(okRes.status, 200);

    // 2. Ataque DNS Rebinding (Host externo apontando para 127.0.0.1)
    const rebindRes = await reqLocal({ Host: 'attacker-rebind.com' });
    assert.equal(rebindRes.status, 403);

    // 3. Ataque CSRF de site malicioso no navegador do caixa
    const csrfRes = await reqLocal(
      { Host: `127.0.0.1:${addr.port}`, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      'POST',
      '/pair',
      JSON.stringify({ codigo: 'ABCD-EFGH' })
    );
    assert.equal(csrfRes.status, 403);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
