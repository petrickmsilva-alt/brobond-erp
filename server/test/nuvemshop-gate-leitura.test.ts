// R-15 (Fase 4.2) — guarda do gate de leitura Nuvemshop 2025-03. LOCAL: sem rede, sem credencial.
// NÃO é homologação: não chama a Nuvemshop. Garante que o gate existe, é somente GET e que o
// cabeçalho/base de produção não mudam antes da decisão do Diretor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ler = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const gate = ler('../../docs/auditoria/gate-leitura-nuvemshop-2025-03.md');
const publicacao = ler('../src/commerce/publicacaoNuvemshop.ts');
const conectorV1 = ler('../../modules/connectors/nuvemshop/nuvemshop.service.ts');

test('gate: existe, declara somente GET e registra o bloqueio sem credencial', () => {
  assert.ok(/somente GET/i.test(gate), 'o gate declara somente GET');
  assert.ok(/BLOQUEADO/.test(gate), 'o bloqueio está registrado');
  assert.ok(/Nenhuma leitura real foi feita/.test(gate), 'não há leitura real registrada');
  assert.ok(/não está homologada/i.test(gate), 'a migração não é considerada homologada');
});

test('gate: nenhum comando de escrita (POST/PUT/PATCH/DELETE) na página do gate', () => {
  assert.equal(/-X\s*(POST|PUT|PATCH|DELETE)|method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(gate), false);
});

test('produção intocada: publicação 2025-03 continua com Authorization Bearer e base 2025-03', () => {
  assert.ok(publicacao.includes('Authorization: `Bearer ${ctx.accessToken}`'), 'cabeçalho de produção');
  assert.ok(publicacao.includes("BASE_NUVEMSHOP_2025 = 'https://api.tiendanube.com/2025-03'"), 'base 2025-03');
  assert.equal(/Authentication:/.test(publicacao), false, 'nenhum cabeçalho Authentication na publicação ainda');
});

test('conector v1 mantém o cabeçalho documentado Authentication: bearer', () => {
  assert.ok(conectorV1.includes('`Authentication: bearer <token>`'));
});

test('divergência registrada: a página cita as duas fontes e declara que não está resolvida', () => {
  assert.ok(gate.includes('Divergência não resolvida'));
  assert.ok(gate.includes('Authentication: bearer'));
  assert.ok(gate.includes('Authorization: Bearer'));
});
