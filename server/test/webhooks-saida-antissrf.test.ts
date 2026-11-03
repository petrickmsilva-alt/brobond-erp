// P2-01 — anti-SSRF em webhooks de saída. LOCAL: DNS e HTTP substituídos por dublês.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { enderecoInterno, hostnameInterno, destinoInterno, validarUrlWebhook, postar } = await import(
  '../src/webhooks'
);

test('endereços internos são classificados (IPv4, IPv6 e IPv4 mapeado)', () => {
  const internos = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.0.8', '198.18.0.1', '::1', '[::1]', '::', 'fd00::1',
    'fe80::1', 'ff02::1', '::ffff:10.0.0.5', '::ffff:127.0.0.1',
  ];
  for (const ip of internos) assert.equal(enderecoInterno(ip), true, `${ip} deveria ser interno`);
  const publicos = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of publicos) assert.equal(enderecoInterno(ip), false, `${ip} deveria ser público`);
});

test('nomes de host internos por convenção são bloqueados sem DNS', () => {
  for (const h of ['localhost', 'api.localhost', 'impressora.local', 'svc.internal', 'metadata.google.internal']) {
    assert.equal(hostnameInterno(h), true, h);
  }
  assert.equal(hostnameInterno('hooks.exemplo.com.br'), false);
});

test('em produção, validarUrlWebhook recusa metadados de nuvem e faixas internas; aceita host público', () => {
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.ok(validarUrlWebhook('https://169.254.169.254/latest/meta-data'));
    assert.ok(validarUrlWebhook('https://100.64.1.1/hook'));
    assert.ok(validarUrlWebhook('https://[fd00::5]/hook'));
    assert.ok(validarUrlWebhook('https://[::ffff:10.0.0.5]/hook'));
    assert.ok(validarUrlWebhook('https://servico.internal/hook'));
    assert.equal(validarUrlWebhook('https://hooks.exemplo.com.br/brobond'), null);
  } finally {
    process.env.NODE_ENV = anterior;
  }
});

test('destinoInterno: qualquer endereço interno resolvido bloqueia; falha de resolução também', async () => {
  assert.ok(await destinoInterno('exemplo.com', async () => ['10.0.0.5']));
  assert.ok(await destinoInterno('exemplo.com', async () => ['93.184.216.34', '127.0.0.1']), 'um interno basta');
  assert.ok(await destinoInterno('exemplo.com', async () => { throw new Error('ENOTFOUND'); }), 'falha fechada');
  assert.ok(await destinoInterno('exemplo.com', async () => []), 'sem endereço = falha fechada');
  assert.equal(await destinoInterno('hooks.exemplo.com', async () => ['93.184.216.34']), null);
  assert.ok(await destinoInterno('10.0.0.1'), 'IP literal interno');
});

test('produção: destino que resolve para rede interna não recebe nenhuma requisição', async () => {
  let chamadas = 0;
  const r = await postar(
    'https://hooks.exemplo.com/x', '{}', 'user.created', null,
    { producao: true, resolver: async () => ['10.9.8.7'], fetch: (async () => { chamadas++; return new Response('ok'); }) as any }
  );
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'erro');
  assert.ok(!String(r.erro).includes('10.9.8.7'), 'mensagem não revela o endereço');
});

test('produção: destino público é enviado com redirect manual', async () => {
  let init: any = null;
  const r = await postar(
    'https://hooks.exemplo.com/x', '{"a":1}', 'user.created', 'segredo-teste',
    {
      producao: true,
      resolver: async () => ['93.184.216.34'],
      fetch: (async (_u: string, i: RequestInit) => { init = i; return new Response('ok', { status: 200 }); }) as any,
    }
  );
  assert.equal(r.estado, 'ok');
  assert.equal(init.redirect, 'manual');
});

test('redirecionamento 3xx não é seguido e vira erro registrado', async () => {
  const r = await postar(
    'https://hooks.exemplo.com/x', '{}', 'user.created', null,
    { producao: false, fetch: (async () => new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } })) as any }
  );
  assert.equal(r.estado, 'erro');
  assert.match(String(r.erro), /Redirecionamento não seguido/);
});

test('fora de produção não há verificação de DNS (ambientes de desenvolvimento seguem funcionando)', async () => {
  let dns = 0;
  const r = await postar(
    'http://localhost:9999/x', '{}', 'user.created', null,
    {
      producao: false,
      resolver: async () => { dns++; return ['127.0.0.1']; },
      fetch: (async () => new Response('', { status: 200 })) as any,
    }
  );
  assert.equal(dns, 0);
  assert.equal(r.estado, 'ok');
});
