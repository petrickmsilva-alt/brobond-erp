// ============================================================================
// PERF-01 / PERF-02 — OBSERVABILIDADE HTTP E COMPRESSÃO, COM EXPRESS REAL.
//
// Os testes de unidade das métricas provam o registro; este prova o WIRING:
// que o middleware realmente injeta os identificadores de correlação, publica
// as fases no cabeçalho `Server-Timing`, que a rota vira série temporal, e que
// a resposta volumosa sai comprimida (o `/api/meta` e as listagens com fotos
// são o grosso do tráfego de dados do ERP).
//
// Nada de corpo, query string ou header sensível é registrado — o último teste
// garante que o nome da rota na métrica é o PADRÃO declarado, não a URL real.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import compression from 'compression';
import request from 'supertest';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const metrics = await import('../src/metrics');
const { requestObservability } = await import('../src/observability');

function montarApp() {
  const app = express();
  app.use(requestObservability);
  app.use(compression({ threshold: 1024 }));
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  // Registrada ANTES de `/api/:recurso` (senão a rota parametrizada a captura).
  app.get('/api/grande', (_req, res) => {
    res.json({ itens: Array.from({ length: 400 }, (_, i) => ({ id: i, nome: `Produto de teste ${i}` })) });
  });
  // Emula o `resourceParam` de produção: valida o slug e o publica em
  // res.locals — é isso que transforma `/api/:resource` em série por módulo.
  const CONHECIDOS = new Set(['produtos', 'vendas']);
  app.get(
    '/api/:recurso',
    (req, res, next) => {
      if (!CONHECIDOS.has(req.params.recurso)) return next();
      res.locals.recurso = req.params.recurso;
      next();
    },
    async (_req, res) => {
      // Simula consulta ao banco: o tempo precisa aparecer em `db` no Server-Timing.
      await new Promise((r) => setTimeout(r, 12));
      res.json({ ok: true });
    }
  );
  return app;
}

test('toda resposta carrega X-Request-ID e Server-Timing com as fases', async () => {
  const app = montarApp();
  const res = await request(app).get('/api/ping');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['x-request-id']), /^[0-9a-f-]{36}$/i);
  assert.match(String(res.headers['x-correlation-id']), /^[0-9a-f-]{36}$/i);
  const timing = String(res.headers['server-timing'] || '');
  assert.match(timing, /app;dur=\d+/, 'fase app presente');
  assert.match(timing, /db;dur=\d+/, 'fase de banco presente');
});

test('X-Request-ID inválido é substituído (nunca ecoado para o log)', async () => {
  const app = montarApp();
  const res = await request(app).get('/api/ping').set('X-Request-ID', 'cpf-12345678900');
  assert.notEqual(res.headers['x-request-id'], 'cpf-12345678900');
  assert.match(String(res.headers['x-request-id']), /^[0-9a-f-]{36}$/i);
});

test('a rota entra na série temporal pelo PADRÃO, não pela URL real', async () => {
  const app = montarApp();
  const antes = metrics.snapshot().http;
  await request(app).get('/api/produtos?f.preco_min=99&q=segredo-de-cliente');
  // Espera o evento `finish` publicar a métrica.
  await new Promise((r) => setTimeout(r, 30));
  const depois = metrics.snapshot().http;
  const chave = 'GET /api/produtos';
  assert.ok(depois[chave], `esperava a chave "${chave}"; obtidas: ${Object.keys(depois).join(', ')}`);
  assert.ok(!Object.keys(depois).some((k) => k.includes('segredo-de-cliente')), 'a URL/query nunca vira rótulo');
  const total = depois[chave].total;
  assert.ok(total >= 1);
  assert.ok(total >= (antes[chave]?.total ?? 0));
});

test('resposta volumosa sai comprimida (gzip) e pequena sai intacta', async () => {
  const app = montarApp();
  const grande = await request(app).get('/api/grande').set('Accept-Encoding', 'gzip');
  assert.equal(grande.status, 200);
  assert.equal(grande.headers['content-encoding'], 'gzip', 'payload grande deve ser comprimido');

  const pequena = await request(app).get('/api/ping').set('Accept-Encoding', 'gzip');
  assert.equal(pequena.headers['content-encoding'], undefined, 'abaixo do limiar não compensa comprimir');
});
