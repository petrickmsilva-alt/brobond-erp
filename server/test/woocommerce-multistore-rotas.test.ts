// ============================================================================
// WOOCOMMERCE MULTI-STORE — autorização, isolamento por empresa e inventário.
//
// LOCAL: store em memória; nenhuma chamada de rede (o fetch global é dublê).
//
// O que se prova aqui:
//   • só gerente/admin operam as lojas (o operador recebe 403);
//   • a loja vem do PATH e é validada contra o registry (nunca "loja padrão");
//   • o recorte é a EMPRESA do ator: gerente de outra empresa não opera a loja;
//   • loja desabilitada/incompleta responde 409 com motivo acionável, sem
//     derrubar a outra;
//   • nenhuma resposta carrega a credencial (CK/CS);
//   • toda rota /api/commerce/woocommerce está registrada DEPOIS da guarda de
//     sessão (nenhuma rota administrativa nasce pública).
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) if (k.startsWith('WOOCOMMERCE_')) delete process.env[k];

const R: any = await import('../src/commerce/woocommerce/rotas');
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

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
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: unknown) => {
    r.body = b;
    return r;
  };
  r.setHeader = (k: string, v: string) => {
    r.headers[k] = v;
    return r;
  };
  return r;
}
const usuario = (perfil: string, empresa = 1) => ({ id: 10, name: `u-${perfil}`, perfil, empresa_id: empresa, email: `${perfil}@x.test` });

async function chamar(fn: (req: any, res: any) => unknown, user: any, extra: Record<string, unknown> = {}) {
  const res = resDe();
  try {
    await fn({ user, query: {}, body: {}, headers: {}, params: {}, ...extra }, res);
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

describe('Multi-store — autorização das rotas', () => {
  test('GET /lojas — operador recebe 403; gerente e admin consultam', async () => {
    configurarLojas(1);
    try {
      const op = await chamar(R.painelLojas, usuario('operador', 1));
      assert.equal(statusDe(op), 403, 'operador não opera as lojas');
      for (const perfil of ['gerente', 'admin']) {
        const r = await chamar(R.painelLojas, usuario(perfil, 1));
        assert.equal(statusDe(r), 200, `${perfil} consulta`);
        assert.ok(Array.isArray(r.res.body.lojas));
        assert.equal(r.res.body.lojas.length, 2, 'uma entrada por loja');
      }
    } finally {
      limparLojas();
    }
  });

  test('loja vem do PATH e é validada (nunca uma "loja padrão" implícita)', async () => {
    configurarLojas(1);
    try {
      const invalida = await chamar(R.painelLoja, usuario('admin', 1), { params: { store: 'loja-1' } });
      assert.equal(statusDe(invalida), 400, 'loja fora de RETAIL/WHOLESALE é 400');
      const valida = await chamar(R.painelLoja, usuario('admin', 1), { params: { store: 'WHOLESALE' } });
      assert.equal(statusDe(valida), 200);
      assert.equal(valida.res.body.store_key, 'WHOLESALE');
    } finally {
      limparLojas();
    }
  });

  test('isolamento por empresa: gerente de OUTRA empresa não opera a loja (404)', async () => {
    configurarLojas(1);
    try {
      const outra = await chamar(R.painelLoja, usuario('gerente', 2), { params: { store: 'RETAIL' } });
      assert.equal(statusDe(outra), 404, 'a loja pertence a outra empresa');
    } finally {
      limparLojas();
    }
  });

  test('A06-09: statusLojas devolve só as lojas da empresa e nunca a credencial', async () => {
    configurarLojas(1);
    try {
      const r = await chamar(R.statusLojas, usuario('gerente', 1));
      assert.equal(statusDe(r), 200);
      assert.equal(r.res.body.empresa_id, 1);
      assert.equal(r.res.body.lojas.length, 2, 'apenas as lojas do tenant');
      // A empresa 2 NÃO tem loja configurada: o status é vazio (não vaza a 1).
      const outra = await chamar(R.statusLojas, usuario('gerente', 2));
      assert.equal(statusDe(outra), 200);
      assert.equal(outra.res.body.lojas.length, 0, 'nenhuma loja de outro tenant');
      assert.ok(!JSON.stringify(r.res.body).includes('ck_retail_segredo'), 'CK não vaza');
      assert.ok(!JSON.stringify(r.res.body).includes('cs_retail_segredo'), 'CS não vaza');
    } finally {
      limparLojas();
    }
  });

  test('A06-09: painelLojas com ?testar=1 não testa a conexão de loja de outro tenant', async () => {
    // As DUAS lojas pertencem à empresa 2; quem consulta é a empresa 1.
    process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_URL = 'https://brobond.com.br';
    process.env.WOOCOMMERCE_RETAIL_CK = 'ck_retail_segredo';
    process.env.WOOCOMMERCE_RETAIL_CS = 'cs_retail_segredo';
    process.env.WOOCOMMERCE_RETAIL_EMPRESA_ID = '2';
    process.env.WOOCOMMERCE_WHOLESALE_ENABLED = 'true';
    process.env.WOOCOMMERCE_WHOLESALE_URL = 'https://atacado.brobond.com.br';
    process.env.WOOCOMMERCE_WHOLESALE_CK = 'ck_wholesale_segredo';
    process.env.WOOCOMMERCE_WHOLESALE_CS = 'cs_wholesale_segredo';
    process.env.WOOCOMMERCE_WHOLESALE_EMPRESA_ID = '2';
    const original = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = (async () => {
      chamadas += 1;
      throw new Error('a rede não pode ser chamada');
    }) as typeof fetch;
    try {
      const r = await chamar(R.painelLojas, usuario('admin', 1), { query: { testar: '1' } });
      assert.equal(statusDe(r), 200);
      assert.deepEqual((r.res.body.lojas as any[]).map((l) => l.store_key), [], 'nenhuma loja de outro tenant');
      assert.equal(chamadas, 0, 'nenhuma chamada de rede: a conexão de loja alheia não é testada');
    } finally {
      globalThis.fetch = original;
      limparLojas();
    }
  });

  test('loja incompleta responde 409 com motivo acionável (sem derrubar a outra)', async () => {
    process.env.WOOCOMMERCE_MULTI_STORE_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_ENABLED = 'true';
    process.env.WOOCOMMERCE_RETAIL_URL = 'https://brobond.com.br';
    process.env.WOOCOMMERCE_RETAIL_CK = 'ck_retail_segredo';
    // CS ausente → RETAIL incompleta.
    try {
      const r = await chamar(R.sincronizarEstoqueDaLojaRota, usuario('admin', 1), { params: { store: 'RETAIL' } });
      assert.equal(statusDe(r), 409);
      assert.match(String(r.erro.message), /WOOCOMMERCE_RETAIL/);

      // O painel continua respondendo e mostra a WHOLESALE desabilitada.
      const painel = await chamar(R.painelLojas, usuario('admin', 1));
      assert.equal(statusDe(painel), 200);
      const retail = painel.res.body.lojas.find((l: any) => l.store_key === 'RETAIL');
      const wholesale = painel.res.body.lojas.find((l: any) => l.store_key === 'WHOLESALE');
      assert.equal(retail.status.configurada, false);
      assert.equal(wholesale.status.habilitada, false);
    } finally {
      limparLojas();
    }
  });

  test('nenhuma resposta carrega credencial (CK/CS)', async () => {
    configurarLojas(1);
    try {
      const rotas = [
        () => chamar(R.painelLojas, usuario('admin', 1)),
        () => chamar(R.painelLoja, usuario('admin', 1), { params: { store: 'RETAIL' } }),
        () => chamar(R.statusLojas, usuario('admin', 1)),
        () => chamar(R.reconciliarLojaRota, usuario('admin', 1), { params: { store: 'WHOLESALE' } }),
      ];
      for (const executar of rotas) {
        const r = await executar();
        const texto = JSON.stringify(r.res.body ?? {});
        assert.ok(!texto.includes('ck_retail_segredo'), 'nenhuma CK na resposta');
        assert.ok(!texto.includes('cs_retail_segredo'), 'nenhum CS na resposta');
        assert.ok(!texto.includes('ck_wholesale_segredo'), 'nenhuma CK da WHOLESALE na resposta');
      }
    } finally {
      limparLojas();
    }
  });

  test('a rota de publicação exige produto válido e loja habilitada', async () => {
    configurarLojas(1);
    try {
      const semProduto = await chamar(R.publicarProdutoNaLojaRota, usuario('admin', 1), { params: { store: 'RETAIL', id: 'abc' } });
      assert.equal(statusDe(semProduto), 400, 'produto inválido é 400');
    } finally {
      limparLojas();
    }
  });

  test('webhooks e divergências: operador recebe 403; gerente/admin passam a guarda', async () => {
    configurarLojas(1);
    try {
      const rotas = [R.painelWebhooks, R.reprocessarWebhooksRota, R.executarReconciliacaoRota, R.listarDivergenciasRota];
      for (const fn of rotas) {
        const op = await chamar(fn, usuario('operador', 1), { params: { store: 'RETAIL' } });
        assert.equal(statusDe(op), 403, `operador não opera ${fn.name}`);
        // O admin passa a guarda: o desfecho pode ser 200 ou uma falha de
        // dependência (a loja não existe no teste), mas NUNCA 403/401.
        const adm = await chamar(fn, usuario('admin', 1), { params: { store: 'RETAIL' } });
        assert.notEqual(statusDe(adm), 403, `admin não é barrado em ${fn.name}`);
        assert.notEqual(statusDe(adm), 401, `admin autenticado em ${fn.name}`);
      }
      // As rotas de LEITURA respondem 200 (não dependem de rede).
      for (const fn of [R.painelWebhooks, R.listarDivergenciasRota]) {
        const adm = await chamar(fn, usuario('admin', 1), { params: { store: 'RETAIL' } });
        assert.equal(statusDe(adm), 200, `${fn.name} responde 200 ao admin`);
      }
    } finally {
      limparLojas();
    }
  });

  test('webhooks e divergências: gerente de OUTRA empresa não opera a loja (404)', async () => {
    configurarLojas(1);
    try {
      for (const fn of [R.painelWebhooks, R.listarDivergenciasRota, R.reprocessarWebhooksRota]) {
        const outra = await chamar(fn, usuario('gerente', 2), { params: { store: 'RETAIL' } });
        assert.equal(statusDe(outra), 404, `${fn.name}: a loja pertence a outra empresa`);
      }
    } finally {
      limparLojas();
    }
  });

  test('webhooks e divergências: loja inválida é 400 e a loja vem do PATH', async () => {
    configurarLojas(1);
    try {
      const invalida = await chamar(R.painelWebhooks, usuario('admin', 1), { params: { store: 'loja-x' } });
      assert.equal(statusDe(invalida), 400, 'loja fora de RETAIL/WHOLESALE é 400');
      const valida = await chamar(R.listarDivergenciasRota, usuario('admin', 1), { params: { store: 'WHOLESALE' } });
      assert.equal(statusDe(valida), 200);
      assert.equal(valida.res.body.store_key, 'WHOLESALE');
    } finally {
      limparLojas();
    }
  });

  test('webhooks e divergências: nenhuma resposta carrega credencial nem segredo do webhook', async () => {
    configurarLojas(1);
    process.env.WOOCOMMERCE_RETAIL_WEBHOOK_SECRET = 'whsec_retail_nao_real';
    process.env.WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET = 'whsec_wholesale_nao_real';
    try {
      const rotas = [
        () => chamar(R.painelWebhooks, usuario('admin', 1), { params: { store: 'RETAIL' } }),
        () => chamar(R.listarDivergenciasRota, usuario('admin', 1), { params: { store: 'RETAIL' } }),
      ];
      for (const executar of rotas) {
        const r = await executar();
        const texto = JSON.stringify(r.res.body ?? {});
        assert.ok(!texto.includes('ck_retail_segredo'), 'nenhuma CK na resposta');
        assert.ok(!texto.includes('cs_retail_segredo'), 'nenhum CS na resposta');
        assert.ok(!texto.includes('whsec_retail_nao_real'), 'nenhum segredo de webhook na resposta');
      }
    } finally {
      limparLojas();
    }
  });

  test('inventário: toda rota /api/commerce/woocommerce está depois da guarda de sessão', () => {
    const src = ler('../src/index.ts');
    const guarda = src.indexOf("app.use('/api', wrap(requireAuth));");
    assert.ok(guarda > 0, 'guarda de sessão localizada');
    const posGuarda = src.slice(0, guarda).split('\n').length;
    const linhas = src.split('\n');
    const rotas = linhas
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /app\.(get|post|put|patch|delete)\('\/api\/commerce\/woocommerce/.test(l));
    assert.ok(rotas.length >= 6, `inventário encontrou as rotas multi-loja (achou ${rotas.length})`);
    for (const r of rotas) {
      assert.ok(r.i > posGuarda, `rota multi-loja antes da guarda de sessão: linha ${r.i}`);
    }
  });
});
