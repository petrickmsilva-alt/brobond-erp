// ============================================================================
// PERF-01 — INSTRUMENTAÇÃO E PRIVACIDADE DAS MÉTRICAS.
//
// O valor do diagnóstico depende de duas coisas que este arquivo trava:
//
//   1. CORRETUDE — percentis e contadores batem com os dados observados;
//   2. PRIVACIDADE — nada de valor de parâmetro, documento, e-mail, token ou
//      dado financeiro pode chegar ao registro. Um "diagnóstico de latência"
//      que vaza CPF para o log é um incidente, não uma melhoria.
//
// Também cobre o gancho único do pool (`instrumentarPool`): é ele que garante
// que TODA consulta do processo — CRUD, transação, cron, commerce — aparece no
// tempo de banco da requisição.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const metrics = await import('../src/metrics');

test('impressaoSql NUNCA preserva literal, documento, e-mail ou token', () => {
  const sql = `SELECT * FROM usuarios WHERE cpf = '123.456.789-00' AND email = 'diretor@brobond.com.br'
                 AND senha_hash = '$argon2id$v=19$m=65536,t=3,p=1$abcdef' OR id = 42`;
  const impressao = metrics.impressaoSql(sql);
  assert.ok(impressao.startsWith('select'), `verbo preservado: ${impressao}`);
  for (const segredo of ['123.456', '789-00', 'diretor', 'brobond.com.br', 'argon2', 'abcdef', '42']) {
    assert.ok(!impressao.includes(segredo), `impressão vazou "${segredo}": ${impressao}`);
  }
  // A TABELA continua visível: é o que permite atribuir latência a um domínio.
  assert.ok(impressao.includes('usuarios'), `tabela preservada: ${impressao}`);
});

test('impressaoSql agrupa consultas iguais com parâmetros diferentes', () => {
  const a = metrics.impressaoSql('SELECT t.id FROM produtos t WHERE t.empresa_id = $1 LIMIT 25 OFFSET 0');
  const b = metrics.impressaoSql('SELECT t.id FROM produtos t WHERE t.empresa_id = $1 LIMIT 50 OFFSET 100');
  assert.equal(a, b, 'mesma forma de consulta deve gerar a mesma impressão');
});

test('percentis de Amostra são monotônicos e coerentes', () => {
  const amostra = new metrics.Amostra(1000);
  for (let i = 1; i <= 100; i++) amostra.registrar(i);
  const r = amostra.resumo();
  assert.equal(r.total, 100);
  assert.equal(r.p50_ms, 50);
  assert.equal(r.p95_ms, 95);
  assert.equal(r.p99_ms, 99);
  assert.equal(r.max_ms, 100);
  assert.ok(r.p50_ms <= r.p95_ms && r.p95_ms <= r.p99_ms, 'percentis devem ser não-decrescentes');
});

test('erros são contados separadamente do total', () => {
  const amostra = new metrics.Amostra(10);
  amostra.registrar(10, false);
  amostra.registrar(20, true);
  const r = amostra.resumo();
  assert.equal(r.total, 2);
  assert.equal(r.erros, 1);
});

test('instrumentarPool mede consulta e atribui o tempo à requisição', async () => {
  // Stub mínimo com a mesma superfície usada pela instrumentação.
  const pool = new EventEmitter() as any;
  pool.totalCount = 1;
  pool.idleCount = 0;
  pool.waitingCount = 0;
  const cliente: any = new EventEmitter();
  cliente.query = async () => ({ rows: [{ ok: 1 }], rowCount: 1 });
  cliente.release = () => undefined;
  pool.connect = async () => cliente;
  pool.query = async () => ({ rows: [], rowCount: 0 });

  metrics.instrumentarPool(pool);
  // Novos clientes são instrumentados no evento 'connect'.
  pool.emit('connect', cliente);

  const contexto: any = {
    requestId: '00000000-0000-4000-8000-000000000000',
    metodo: 'GET',
    rota: 'GET /api/produtos',
    inicio: metrics.agoraMs(),
    dbMs: 0,
    dbConsultas: 0,
    esperaMs: 0,
    externoMs: 0,
    externoChamadas: 0,
  };

  const antes = metrics.snapshot().banco.global.total;
  await metrics.comContexto(contexto, () => cliente.query('SELECT 1 FROM produtos WHERE id = 7'));
  const depois = metrics.snapshot().banco.global.total;

  assert.ok(depois > antes, 'a consulta deve aparecer no contador global');
  assert.equal(contexto.dbConsultas, 1, 'a consulta deve ser atribuída à requisição');
  assert.ok(contexto.dbMs >= 0, 'o tempo de banco é registrado na requisição');

  // A impressão digital registrada NÃO contém o id consultado.
  const impressoes = metrics.snapshot().banco.consultas.map((c) => c.impressao);
  assert.ok(impressoes.some((i) => i.includes('produtos')), `impressões: ${impressoes.join(' | ')}`);
  assert.ok(!impressoes.some((i) => i.includes('7')), 'nenhum valor de parâmetro pode aparecer');
});

test('snapshot expõe processo, banco e pool sem dados sensíveis', () => {
  const s = metrics.snapshot();
  assert.ok(typeof s.gerado_em === 'string');
  assert.ok('rss_mb' in s.processo);
  assert.ok('event_loop_lag_p99_ms' in s.processo);
  assert.ok('global' in s.banco);
  assert.ok(Array.isArray(s.gargalos));
  // O texto Prometheus é gerado e é texto puro.
  const texto = metrics.prometheus();
  assert.match(texto, /brobond_processo_rss_mb/);
  assert.doesNotMatch(texto, /password|senha|token/i);
});

test('registrarHttp agrega por rota e limita o rótulo ao padrão declarado', () => {
  metrics.registrarHttp('/api/:resource', 'GET', 200, 123);
  const s = metrics.snapshot();
  assert.ok(s.http['GET /api/:resource'], 'rota agregada pelo padrão, não pela URL');
  assert.equal(s.http['GET /api/:resource'].total >= 1, true);
});

test('registrarFrontend mascara CPF, e-mail, UUID e query no servidor (defesa em profundidade)', () => {
  metrics.registrarFrontend({
    tela: '/clientes/123.456.789-00?email=diretor@brobond.com.br&token=segredo999',
    ms: 120,
  });
  metrics.registrarFrontend({
    tela: '/usuarios/diretor@brobond.com.br',
    ms: 85,
  });
  const chaves = Object.keys(metrics.snapshot().frontend).join(' | ');
  for (const proibido of ['123.456', '789-00', 'diretor', 'brobond.com.br', 'segredo999']) {
    assert.ok(!chaves.includes(proibido), `RUM do servidor vazou "${proibido}": ${chaves}`);
  }
  assert.ok(metrics.snapshot().frontend['/clientes/:id'], `esperava /clientes/:id em: ${chaves}`);
});
