import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requestObservability } from '../src/observability';
import { log } from '../src/log';

test('HTTP real: logs usam rota declarada, correlation ID e não capturam token, body ou query', async () => {
  const logs: unknown[] = []; const previous = log.info;
  log.info = (message, detail) => { logs.push({ message, detail }); };
  const app = express(); app.use(requestObservability); app.use(express.json());
  app.post('/api/pedido/:token', (_req, res) => res.status(201).json({ ok: true }));
  const server = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/pedido/SEGREDO-DA-URL?cpf=SECRET-CPF`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET-TOKEN', 'x-request-id': '82f8ac10-0728-44be-8991-c5eaa0f92e11' },
      body: JSON.stringify({ senha: 'SECRET-BODY' }),
    });
    assert.equal(response.status, 201); assert.equal(response.headers.get('x-request-id'), '82f8ac10-0728-44be-8991-c5eaa0f92e11');
    const captured = JSON.stringify(logs);
    assert.match(captured, /\/api\/pedido\/:token/); assert.match(captured, /82f8ac10-0728-44be-8991-c5eaa0f92e11/);
    for (const secret of ['SEGREDO-DA-URL', 'SECRET-CPF', 'SECRET-TOKEN', 'SECRET-BODY']) assert.equal(captured.includes(secret), false);
  } finally { log.info = previous; await new Promise<void>((resolve) => server.close(() => resolve())); }
});
