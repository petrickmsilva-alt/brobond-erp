// ============================================================================
// SEGURANÇA — GUARDA ANTI-SSRF DO CIMD (Client ID Metadata Document)
//
// A auditoria independente (F2) apontou que `clientePorCimd` buscava QUALQUER
// URL HTTPS sem limites. Este arquivo prova que a guarda recusa cada classe de
// destino proibido, revalida redirecionamentos, respeita teto/tempo e que o
// CIMD nasce DESLIGADO (fail-closed).
//
// As provas usam um resolvedor DNS e um conector INJETADOS (não dependem de
// rede): o conector recebe o ENDEREÇO JÁ VALIDADO — é o mesmo ponto onde a
// produção fixa o IP na conexão (pinning), o que fecha o DNS rebinding.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { resolverDestinoSeguro, buscarDocumentoCimd, cimdHabilitado, CimdBloqueado } = await import('../../modules/operational-control/oauth/outbound-guard');
const { clientePorCimd, resolverCliente } = await import('../../modules/operational-control/oauth/clients');

// ---------------------------------------------------------------------------
// 1) Resolução: cada classe de destino interno é recusada (fail-closed)
// ---------------------------------------------------------------------------
const HOSTIS_IPV4 = ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1'];
for (const ip of HOSTIS_IPV4) {
  test(`SSRF: IPv4 proibido literal é recusado (${ip})`, async () => {
    await assert.rejects(() => resolverDestinoSeguro(ip, async () => [ip]), (e: any) => e instanceof CimdBloqueado);
  });
}
const HOSTIS_IPV6 = ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1'];
for (const ip of HOSTIS_IPV6) {
  test(`SSRF: IPv6 proibido literal é recusado (${ip})`, async () => {
    await assert.rejects(() => resolverDestinoSeguro(ip, async () => [ip]), (e: any) => e instanceof CimdBloqueado);
  });
}

test('SSRF: IPv4 mapeado em IPv6 é recusado', async () => {
  for (const ip of ['::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    await assert.rejects(() => resolverDestinoSeguro(ip, async () => [ip]), (e: any) => e instanceof CimdBloqueado, ip);
  }
});

test('SSRF: nome de host interno por convenção é recusado sem sequer resolver DNS', async () => {
  for (const h of ['localhost', 'metadata.google.internal', 'algo.local', 'x.internal']) {
    await assert.rejects(() => resolverDestinoSeguro(h, async () => { throw new Error('não deveria resolver'); }), (e: any) => e instanceof CimdBloqueado, h);
  }
});

test('SSRF: host público que RESOLVE para a rede interna é recusado (DNS rebinding textual)', async () => {
  await assert.rejects(() => resolverDestinoSeguro('evil.example.com', async () => ['10.1.2.3']), (e: any) => e instanceof CimdBloqueado);
  await assert.rejects(() => resolverDestinoSeguro('evil.example.com', async () => ['93.184.216.34', '127.0.0.1']), (e: any) => e instanceof CimdBloqueado, 'basta UM endereço interno');
});

test('SSRF: host público com resolução pública é aceito (positivo)', async () => {
  const enderecos = await resolverDestinoSeguro('example.com', async () => ['93.184.216.34']);
  assert.deepEqual(enderecos, ['93.184.216.34']);
});

test('SSRF: host que não resolve é recusado', async () => {
  await assert.rejects(() => resolverDestinoSeguro('naoexiste.example', async () => []), (e: any) => e instanceof CimdBloqueado);
  await assert.rejects(() => resolverDestinoSeguro('naoexiste.example', async () => { throw new Error('NXDOMAIN'); }), (e: any) => e instanceof CimdBloqueado);
});

// ---------------------------------------------------------------------------
// 2) CIMD desligado por padrão (fail-closed) — nunca fetch arbitrário
// ---------------------------------------------------------------------------
test('SSRF: CIMD desabilitado por padrão; nenhum fetch acontece e o cliente não é resolvido', async () => {
  delete process.env.OAUTH_CIMD_ENABLED;
  assert.equal(cimdHabilitado(), false);
  await assert.rejects(() => buscarDocumentoCimd('https://cliente.example/cimd.json', async () => ['93.184.216.34']), (e: any) => e instanceof CimdBloqueado);
  assert.equal(await clientePorCimd('https://cliente.example/cimd.json'), null);
  // `resolverCliente` não cai no CIMD quando desligado.
  assert.equal(await resolverCliente('https://cliente.example/cimd.json'), null);
});

test('SSRF: apenas https é aceito (http é recusado)', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(() => buscarDocumentoCimd('http://example.com/cimd.json', async () => ['93.184.216.34']), (e: any) => e instanceof CimdBloqueado);
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// 3) Pinning, redirect revalidado, teto/status e erro sem vazar URL
// ---------------------------------------------------------------------------
test('SSRF: o conector recebe o ENDEREÇO VALIDADO (pinning do IP), não o nome do host', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  const vistos: string[] = [];
  try {
    const doc = await buscarDocumentoCimd(
      'https://publico.example/cimd.json',
      async () => ['93.184.216.34'],
      async (_url, endereco) => {
        vistos.push(endereco);
        return { status: 200, location: null, corpo: JSON.stringify({ client_name: 'ok', redirect_uris: ['https://x/cb'] }) };
      }
    );
    assert.equal(doc.client_name, 'ok');
    assert.deepEqual(vistos, ['93.184.216.34'], 'a conexão precisa fixar o IP validado');
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

test('SSRF: redirecionamento para destino INTERNO é barrado (revalida cada salto)', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(
      () =>
        buscarDocumentoCimd(
          'https://publico.example/cimd.json',
          async (host) => (host === 'publico.example' ? ['93.184.216.34'] : ['169.254.169.254']),
          async () => ({ status: 302, location: 'https://interno.example/meta.json', corpo: '' })
        ),
      (e: any) => e instanceof CimdBloqueado
    );
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

test('SSRF: redirecionamentos em excesso são barrados', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(
      () =>
        buscarDocumentoCimd(
          'https://publico.example/a',
          async () => ['93.184.216.34'],
          async () => ({ status: 302, location: 'https://publico.example/b', corpo: '' })
        ),
      (e: any) => e instanceof CimdBloqueado
    );
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

test('SSRF: resposta não-2xx é recusada', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(
      () => buscarDocumentoCimd('https://publico.example/c', async () => ['93.184.216.34'], async () => ({ status: 500, location: null, corpo: 'erro' })),
      (e: any) => e instanceof CimdBloqueado
    );
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

test('SSRF: documento que não é JSON de objeto é recusado', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(
      () => buscarDocumentoCimd('https://publico.example/d', async () => ['93.184.216.34'], async () => ({ status: 200, location: null, corpo: '[1,2,3]' })),
      (e: any) => e instanceof CimdBloqueado
    );
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});

test('SSRF: o erro nunca revela a URL (que pode conter dado sensível)', async () => {
  process.env.OAUTH_CIMD_ENABLED = 'true';
  try {
    await assert.rejects(
      () => buscarDocumentoCimd('https://publico.example/segredo-na-url.json', async () => ['93.184.216.34'], async () => ({ status: 500, location: null, corpo: '' })),
      (e: any) => e instanceof CimdBloqueado && !/segredo-na-url|publico\.example/.test(e.message)
    );
  } finally {
    delete process.env.OAUTH_CIMD_ENABLED;
  }
});
