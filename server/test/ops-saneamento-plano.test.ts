// ============================================================================
// OPS — guarda estática do plano de saneamento pré-go-live.
//
// Roda sem banco. Trava as invariantes que a ordem executiva exige e que não
// podem regredir silenciosamente:
//   • o plano NUNCA toca estoque físico, cadastros ou estrutura financeira;
//   • os desvínculos só apontam para tabelas do próprio plano (nada fora dele);
//   • as confirmações/escopo obrigatórios existem.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRMACAO_EXECUCAO, DESVINCULOS, PLANO, TABELAS_PROTEGIDAS } from '../src/ops/saneamento';

test('OPS guard: o plano nunca toca estoque físico, cadastros ou estrutura financeira', () => {
  const alvos = new Set(PLANO.map((p) => p.tabela));
  for (const protegida of TABELAS_PROTEGIDAS) {
    assert.equal(alvos.has(protegida), false, `o plano não pode tocar a tabela protegida "${protegida}"`);
  }
  // Guarda explícita: `estoques` é a única posição operacional preservada.
  assert.equal(alvos.has('estoques'), false);
});

test('OPS guard: os desvínculos só apontam para tabelas do próprio plano', () => {
  const alvos = new Set(PLANO.map((p) => p.tabela));
  for (const d of DESVINCULOS) {
    assert.equal(alvos.has(d.tabela), true, `desvínculo em "${d.tabela}" fora do plano`);
  }
});

test('OPS guard: cada passo tem tabela, descrição e predicado não vazio', () => {
  const ids = new Set<string>();
  for (const p of PLANO) {
    assert.match(p.tabela, /^[a-z_]+$/, `tabela inválida: ${p.tabela}`);
    assert.ok(p.descricao.length > 0, `passo ${p.id} sem descrição`);
    assert.ok(p.where.includes('$1::int[]'), `passo ${p.id} não recorta por empresa`);
    assert.equal(ids.has(p.id), false, `id duplicado: ${p.id}`);
    ids.add(p.id);
  }
});

test('OPS guard: a confirmação de execução é textual e não trivial', () => {
  assert.equal(typeof CONFIRMACAO_EXECUCAO, 'string');
  assert.ok(CONFIRMACAO_EXECUCAO.length >= 8, 'a confirmação precisa ser explícita');
});
