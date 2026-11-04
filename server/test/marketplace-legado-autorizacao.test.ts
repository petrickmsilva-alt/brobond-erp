// R-1 (Fase 4.2) — rota legada /api/marketplace/sincronizar: autorização por papel e empresa.
// LOCAL. A chamada externa ao Mercado Livre é interceptada (fetch mockado): nada sai da máquina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.MERCADOLIVRE_TOKEN = 'fixture-token-legado-000';
// Ordem Final 2.4: contrato declarado para a empresa 1 (cenário legítimo).
process.env.MERCADOLIVRE_TOKEN_ESTATICO_CONTRATO = '1:contrato-teste-000';

const { sincronizarPedidos } = await import('../src/marketplace');

function reqDe(user: any, body: any = { provider: 'mercadolivre' }) {
  return { user, body, headers: {}, query: {} } as any;
}
function resDe() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
async function executar(user: any, t: any) {
  let chamadasExternas = 0;
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    chamadasExternas++;
    const url = String(typeof input === 'string' ? input : input.url);
    const corpo = url.includes('/users/me') ? { id: 555000111 } : { results: [] };
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = resDe();
  let erro: any = null;
  try { await sincronizarPedidos(reqDe(user), res); } catch (e: any) { erro = e; }
  return { erro, res, chamadasExternas };
}

test('operador autenticado é negado (403) e não chama o marketplace', async (t) => {
  const { erro, chamadasExternas } = await executar({ id: 10, name: 'Op', perfil: 'operador', empresa_id: 1 }, t);
  assert.equal(erro?.status, 403, `esperado 403; obtido ${erro?.status ?? 'sem erro'}`);
  assert.equal(chamadasExternas, 0, 'nenhuma chamada externa para usuário sem permissão');
});

test('gerente é negado (403): a rota usa token estático da instalação, restrita a administrador', async (t) => {
  const { erro, chamadasExternas } = await executar({ id: 11, name: 'Ger', perfil: 'gerente', empresa_id: 1 }, t);
  assert.equal(erro?.status, 403);
  assert.equal(chamadasExternas, 0);
});

test('administrador com empresa definida é autorizado e a chamada ocorre', async (t) => {
  const { erro, res, chamadasExternas } = await executar({ id: 1, name: 'Admin', perfil: 'admin', empresa_id: 1 }, t);
  assert.equal(erro, null, erro?.message);
  // Fase 4.3 (item 13): identidade (/users/me) + busca de pedidos (orders/search?seller=<id>).
  assert.equal(chamadasExternas, 2);
  assert.equal(res.body?.provider, 'mercadolivre');
});

test('administrador sem empresa válida no contexto é negado (403) antes de qualquer chamada', async (t) => {
  const { erro, chamadasExternas } = await executar({ id: 1, name: 'Admin', perfil: 'admin', empresa_id: null }, t);
  // empresa_id nulo cai no padrão de escopo; a regra exige empresa explícita no contexto do ator.
  assert.equal(erro?.status, 403);
  assert.equal(chamadasExternas, 0);
});

test('a rota continua exigindo sessão no roteamento (requireAuth) e não é pública', () => {
  const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  const guarda = index.indexOf("app.use('/api', wrap(requireAuth))");
  const rota = index.indexOf("app.post('/api/marketplace/sincronizar'");
  assert.ok(guarda > 0 && rota > guarda, 'rota deve estar após requireAuth');
});
