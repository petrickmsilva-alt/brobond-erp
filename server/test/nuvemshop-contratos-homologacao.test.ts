// Fase 4.1 — contratos Nuvemshop (v1 e 2025-03) separados. LOCAL: lê o código, sem rede.
// Garante, para a homologação: (1) o contrato v1 não tem escrita além da troca de token OAuth;
// (2) a divergência de cabeçalho do 2025-03 (R-15) continua registrada e não foi "corrigida" em silêncio;
// (3) o plano de homologação mantém os dois contratos em seções separadas, com o gate de leitura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ler = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const v1 = ler('modules/connectors/nuvemshop/nuvemshop.service.ts');
const pub = ler('server/src/commerce/publicacaoNuvemshop.ts');
const plano = ler('docs/auditoria/plano-homologacao-conectores.md');

test('v1: a única chamada POST/PUT/PATCH/DELETE é a troca de token OAuth (sem escrita na loja)', () => {
  const metodos = [...v1.matchAll(/method:\s*['"`](\w+)['"`]/g)].map((m) => m[1]);
  const escrita = metodos.filter((m) => m !== 'GET');
  assert.deepEqual(escrita, ['POST'], 'só o POST do OAuth é permitido');
  const postPos = v1.indexOf("method: 'POST'");
  const trecho = v1.slice(Math.max(0, postPos - 400), postPos + 40);
  assert.match(trecho, /authorize\/token|token/i, 'o POST deve ser a troca de token');
});

test('v1: cabeçalho de autenticação é Authentication (contrato documentado)', () => {
  assert.match(v1, /authentication:\s*`bearer \$\{accessToken\}`/);
  assert.match(v1, /'user-agent':\s*config\.userAgent/);
});

test('2025-03 (R-15): cabeçalho Authorization ainda presente e divergente do v1 — não verificado', () => {
  assert.match(pub, /Authorization: `Bearer \$\{ctx\.accessToken\}`/, 'CARACTERIZAÇÃO: se mudar, exigir homologação de leitura antes');
  assert.match(pub, /'User-Agent': ctx\.userAgent/);
});

test('2025-03: escrita restrita a POST /products e PATCH /products/stock-price', () => {
  const chamadas = [...pub.matchAll(/chamar\(ctx,\s*`\$\{base\(ctx\)\}([^`]+)`,\s*\{\s*method:\s*'(\w+)'/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(chamadas.sort(), ['GET /products/sku/${encodeURIComponent(sku)}', 'PATCH /products/stock-price', 'POST /products'].sort());
  assert.ok(!/method:\s*'(PUT|DELETE)'/.test(pub), 'sem PUT/DELETE na publicação 2025-03');
});

test('plano: v1 e 2025-03 têm seções separadas e o gate de leitura do cabeçalho está descrito', () => {
  assert.ok(plano.includes('### 2.1 Contrato v1'));
  assert.ok(plano.includes('### 2.2 Contrato 2025-03'));
  assert.ok(plano.includes('GATE OBRIGATÓRIO'));
  assert.ok(plano.includes('Authentication: bearer'));
  assert.ok(plano.includes('`Authorization: Bearer`'));
});
