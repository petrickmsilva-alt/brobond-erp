// ============================================================================
// FASE 9.4 — IDENTIDADE COMERCIAL CANÔNICA (visão unificada dos canais).
//
// LOCAL: store em memória; NENHUMA chamada de rede real (o fetch global é
// dublê). O que se prova aqui:
//   • os TRÊS canais oficiais aparecem (RETAIL, WHOLESALE, REPRESENTATIVES);
//   • RETAIL e WHOLESALE reusam o registry multi-loja (`store_key`) e NÃO
//     aparecem como "conectado" sem teste real (?testar=1);
//   • REPRESENTATIVES nunca aparece como conectado (não há conector);
//   • isolamento por empresa: a loja de outro tenant não é apresentada;
//   • RBAC: operador recebe 403 (é visão de gestão);
//   • nenhuma resposta carrega credencial (CK/CS).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];

const { listarCanaisComerciais } = await import('../src/commerce/canaisComerciais');

const ENV_KEYS = ['WOOCOMMERCE_MULTI_STORE_ENABLED', 'WOOCOMMERCE_RETAIL_ENABLED', 'WOOCOMMERCE_RETAIL_URL', 'WOOCOMMERCE_RETAIL_CK', 'WOOCOMMERCE_RETAIL_CS', 'WOOCOMMERCE_RETAIL_EMPRESA_ID', 'WOOCOMMERCE_WHOLESALE_ENABLED', 'WOOCOMMERCE_WHOLESALE_URL', 'WOOCOMMERCE_WHOLESALE_CK', 'WOOCOMMERCE_WHOLESALE_CS', 'WOOCOMMERCE_WHOLESALE_EMPRESA_ID'];
const envAnterior: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
test.after(() => {
  for (const k of ENV_KEYS) {
    if (envAnterior[k] === undefined) delete process.env[k];
    else process.env[k] = envAnterior[k];
  }
});

function resDe() {
  const r: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}
const usuario = (perfil: string, empresa = 1) => ({ id: 10, name: `u-${perfil}`, perfil, empresa_id: empresa, email: `${perfil}@x.test` });

async function chamar(user: any, extra: Record<string, unknown> = {}) {
  const res = resDe();
  try {
    await listarCanaisComerciais({ user, query: {}, body: {}, headers: {}, params: {}, ...extra }, res);
    return { res, erro: null as any };
  } catch (e: any) {
    return { res, erro: e };
  }
}
const statusDe = (r: { res: any; erro: any }) => r.erro?.status ?? r.res.statusCode;

function configurarLojas(empresaId = 1) {
  process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
  process.env.WOOCOMMERCE_RETAIL_URL = 'https://brobond.com.br';
  process.env.WOOCOMMERCE_RETAIL_CK = 'ck_retail_segredo';
  process.env.WOOCOMMERCE_RETAIL_CS = 'cs_retail_segredo';
  process.env.WOOCOMMERCE_RETAIL_EMPRESA_ID = String(empresaId);
  process.env.WOOCOMMERCE_WHOLESALE_ENABLED = 'true';
  process.env.WOOCOMMERCE_WHOLESALE_URL = 'https://atacado.brobond.com.br';
  process.env.WOOCOMMERCE_WHOLESALE_CK = 'ck_wholesale_segredo';
  process.env.WOOCOMMERCE_WHOLESALE_CS = 'cs_wholesale_segredo';
  process.env.WOOCOMMERCE_WHOLESALE_EMPRESA_ID = String(empresaId);
}
function limparLojas() {
  for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];
}

describe('Fase 9.4 — canais comerciais (visão unificada)', () => {
  test('os três canais oficiais aparecem, sem conector presumido', async () => {
    configurarLojas(1);
    try {
      const r = await chamar(usuario('gerente', 1));
      assert.equal(statusDe(r), 200);
      assert.deepEqual((r.res.body.canais as any[]).map((c) => c.canal), ['RETAIL', 'WHOLESALE', 'REPRESENTATIVES']);
      // Sem ?testar=1 o teto é "configurado" — nunca "conectado" sem teste real.
      const retail = r.res.body.canais.find((c: any) => c.canal === 'RETAIL');
      assert.equal(retail.estado, 'configurado');
      assert.equal(retail.conexao, null);
      assert.equal(retail.preco_fonte, 'preco_venda');
      const wholesale = r.res.body.canais.find((c: any) => c.canal === 'WHOLESALE');
      assert.equal(wholesale.preco_fonte, 'preco_atacado');
      // REPRESENTATIVES não tem conector no repositório.
      const rep = r.res.body.canais.find((c: any) => c.canal === 'REPRESENTATIVES');
      assert.equal(rep.estado, 'nao_homologado');
      assert.equal(rep.loja, null);
      assert.equal(rep.conexao, null);
    } finally {
      limparLojas();
    }
  });

  test('?testar=1 faz o teste autenticado: sucesso vira "conectado" (dublê de fetch)', async () => {
    configurarLojas(1);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const r = await chamar(usuario('admin', 1), { query: { testar: '1' } });
      assert.equal(statusDe(r), 200);
      const retail = r.res.body.canais.find((c: any) => c.canal === 'RETAIL');
      assert.equal(retail.estado, 'conectado');
      assert.equal(retail.conexao.ok, true);
    } finally {
      globalThis.fetch = original;
      limparLojas();
    }
  });

  test('?testar=1 com falha da loja vira "erro" com motivo (não derruba o painel)', async () => {
    configurarLojas(1);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('rede fora'); }) as typeof fetch;
    try {
      const r = await chamar(usuario('gerente', 1), { query: { testar: '1' } });
      assert.equal(statusDe(r), 200);
      const retail = r.res.body.canais.find((c: any) => c.canal === 'RETAIL');
      assert.equal(retail.estado, 'erro');
      assert.equal(retail.conexao.ok, false);
      assert.ok(retail.pendencia, 'a pendência é acionável');
    } finally {
      globalThis.fetch = original;
      limparLojas();
    }
  });

  test('loja desabilitada vira "nao_configurado" com motivo (nunca conectada)', async () => {
    // Só a RETAIL habilitada; a WHOLESALE não.
    process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_URL = 'https://brobond.com.br';
    process.env.WOOCOMMERCE_RETAIL_CK = 'ck';
    process.env.WOOCOMMERCE_RETAIL_CS = 'cs';
    process.env.WOOCOMMERCE_RETAIL_EMPRESA_ID = '1';
    try {
      const r = await chamar(usuario('gerente', 1));
      const wholesale = r.res.body.canais.find((c: any) => c.canal === 'WHOLESALE');
      assert.equal(wholesale.estado, 'nao_configurado');
      assert.ok(wholesale.pendencia);
    } finally {
      limparLojas();
    }
  });

  test('isolamento por empresa: loja de OUTRO tenant não é apresentada', async () => {
    configurarLojas(2); // as duas lojas pertencem à empresa 2
    try {
      const r = await chamar(usuario('admin', 1));
      assert.equal(statusDe(r), 200);
      for (const c of r.res.body.canais as any[]) {
        if (c.canal === 'REPRESENTATIVES') continue;
        assert.equal(c.estado, 'nao_configurado', `${c.canal}: loja de outro tenant não é acessível`);
      }
    } finally {
      limparLojas();
    }
  });

  test('RBAC: operador recebe 403 (é visão de gestão)', async () => {
    configurarLojas(1);
    try {
      const r = await chamar(usuario('operador', 1));
      assert.equal(statusDe(r), 403);
    } finally {
      limparLojas();
    }
  });

  test('nenhuma resposta carrega credencial (CK/CS)', async () => {
    configurarLojas(1);
    try {
      const r = await chamar(usuario('admin', 1));
      const texto = JSON.stringify(r.res.body);
      assert.ok(!texto.includes('ck_retail_segredo'), 'CK da RETAIL não vaza');
      assert.ok(!texto.includes('cs_retail_segredo'), 'CS da RETAIL não vaza');
      assert.ok(!texto.includes('ck_wholesale_segredo'), 'CK da WHOLESALE não vaza');
      assert.equal(r.res.headers['Cache-Control'], 'private, no-store');
    } finally {
      limparLojas();
    }
  });
});
