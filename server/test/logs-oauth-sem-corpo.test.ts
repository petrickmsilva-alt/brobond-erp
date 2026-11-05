// Item 13 (Fase 4.3) — logs de falha OAuth não carregam corpo de resposta nem credenciais.
// Verificação estática dos conectores: nenhum console.* recebe rawBody/access_token/client_secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ler = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const ARQUIVOS = [
  'modules/connectors/nuvemshop/nuvemshop.service.ts',
  'modules/connectors/mercadolivre/mercadolivre.service.ts',
];

for (const arq of ARQUIVOS) {
  test(`${arq}: console.error de OAuth não inclui corpo bruto nem segredos`, () => {
    const fonte = ler(arq);
    const blocos = [...fonte.matchAll(/console\.(error|warn|info|log)\(([\s\S]*?)\);/g)].map((m) => m[2]);
    for (const b of blocos) {
      assert.ok(!/rawBody\s*:/.test(b), `log com corpo bruto em ${arq}: ${b.slice(0, 120)}`);
      assert.ok(!/\b(access_token|client_secret|refresh_token)\b\s*[:,}]/.test(b), `log com segredo em ${arq}`);
    }
  });
}

test('Mercado Livre: helper de rejeição não recebe nem copia o corpo OAuth para o console', () => {
  const fonte = ler('modules/connectors/mercadolivre/mercadolivre.service.ts');
  assert.match(fonte, /function logMeliTokenRejection\(status: number, statusText: string, errorCode\?: string, redirectUri\?: string\)/);
  assert.doesNotMatch(fonte, /rawBody\s*,\s*redirectUri/);
  assert.match(fonte, /erro: errorCode\.slice\(0, 60\)/);
});

test('Nuvemshop: erro OAuth registra apenas o código curto', () => {
  const fonte = ler('modules/connectors/nuvemshop/nuvemshop.service.ts');
  assert.match(fonte, /erro: typeof payload\?\.error === 'string'/);
});
