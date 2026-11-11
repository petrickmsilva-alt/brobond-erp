// ============================================================================
// OPS — guarda estática do plano de saneamento pré-go-live.
//
// Roda sem banco. Trava as invariantes que a ordem executiva exige e que não
// podem regredir silenciosamente:
//   • o plano NUNCA toca estoque físico, cadastros ou estrutura financeira;
//   • todo desvínculo ou aponta para uma tabela do plano, ou é GUARDADO por um
//     predicado que só alcança linhas ligadas a dado de teste (tabela do plano);
//   • a classificação de cobertura marca como BLOQUEIO toda FK NO ACTION não
//     coberta (grafo sintético);
//   • as confirmações/escopo obrigatórios existem.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRMACAO_EXECUCAO, DESVINCULOS, PLANO, TABELAS_PROTEGIDAS, compararEstoque, type LinhaEstoque } from '../src/ops/saneamento';
import { classificar, type FkInfo } from '../src/ops/saneamento-cobertura';

test('OPS guard: o plano nunca toca estoque físico, cadastros ou estrutura financeira', () => {
  const alvos = new Set(PLANO.map((p) => p.tabela));
  for (const protegida of TABELAS_PROTEGIDAS) {
    assert.equal(alvos.has(protegida), false, `o plano não pode tocar a tabela protegida "${protegida}"`);
  }
  // Guarda explícita: `estoques` é a única posição operacional preservada.
  assert.equal(alvos.has('estoques'), false);
});

test('OPS guard: todo desvínculo é em tabela do plano OU guardado por dado de teste', () => {
  const alvos = new Set(PLANO.map((p) => p.tabela));
  for (const d of DESVINCULOS) {
    if (alvos.has(d.tabela)) continue; // a própria tabela é limpa
    // Tabela PRESERVADA: o predicado precisa referenciar uma tabela do plano,
    // senão o UPDATE zeraria coluna de dado real.
    const guardado = [...alvos].some((t) => new RegExp(`\\b${t}\\b`).test(d.where));
    assert.ok(guardado, `desvínculo em tabela preservada "${d.tabela}" sem guarda por dado de teste: ${d.where}`);
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

// ---------------------------------------------------------------------------
// COBERTURA DE FK — a classificação é a rede que impede apagar um pai com filho
// dependente. Testada com grafos SINTÉTICOS (sem banco).
// ---------------------------------------------------------------------------
function fk(filho: string, pai: string, deltype: string, colunas: string[] = ['id']): FkInfo {
  return { nome: `fk_${filho}_${pai}`, filho, pai, colunas, deltype };
}

test('COBERTURA: FK NO ACTION não coberta é BLOQUEIO', () => {
  const grafo = [fk('filho_x', 'pai_a', 'a')];
  const c = classificar(grafo, [{ tabela: 'pai_a' }], []);
  assert.equal(c.bloqueios.length, 1, 'uma FK NO ACTION sem cobertura deve bloquear');
  assert.equal(c.bloqueios[0].filho, 'filho_x');
});

test('COBERTURA: filho no plano antes do pai é LIMPA; depois é BLOQUEIO', () => {
  const ok = classificar([fk('filho_x', 'pai_a', 'a')], [{ tabela: 'filho_x' }, { tabela: 'pai_a' }], []);
  assert.equal(ok.bloqueios.length, 0);
  assert.equal(ok.classificacoes[0].classe, 'LIMPA');
  const invertido = classificar([fk('filho_x', 'pai_a', 'a')], [{ tabela: 'pai_a' }, { tabela: 'filho_x' }], []);
  assert.equal(invertido.bloqueios.length, 1, 'ordem invertida deve bloquear');
});

test('COBERTURA: desvínculo da coluna da FK resolve o bloqueio (inclusive composta)', () => {
  const simples = classificar([fk('filho_x', 'pai_a', 'a', ['pai_a_id'])], [{ tabela: 'pai_a' }], [{ tabela: 'filho_x', sets: ['pai_a_id = NULL'] }]);
  assert.equal(simples.bloqueios.length, 0);
  assert.equal(simples.classificacoes[0].classe, 'DESVINCULA');
  // FK composta: zerar QUALQUER coluna anula a referência.
  const composta = classificar(
    [fk('filho_x', 'pai_a', 'a', ['empresa_id', 'pai_a_id'])],
    [{ tabela: 'pai_a' }],
    [{ tabela: 'filho_x', sets: ['pai_a_id = NULL'] }]
  );
  assert.equal(composta.bloqueios.length, 0, 'FK composta desvinculada não pode bloquear');
});

test('COBERTURA: CASCADE e SET NULL não bloqueiam (o banco resolve)', () => {
  const c = classificar([fk('filho_x', 'pai_a', 'c'), fk('filho_y', 'pai_a', 'n')], [{ tabela: 'pai_a' }], []);
  assert.equal(c.bloqueios.length, 0);
  assert.deepEqual(c.classificacoes.map((x) => x.classe).sort(), ['CASCATA', 'SET_NULL']);
});

test('COBERTURA: RESTRICT não coberto bloqueia', () => {
  const c = classificar([fk('filho_x', 'pai_a', 'r')], [{ tabela: 'pai_a' }], []);
  assert.equal(c.bloqueios.length, 1);
  assert.match(c.bloqueios[0].motivo ?? '', /RESTRICT/);
});

// ---------------------------------------------------------------------------
// COMPARAÇÃO DE ESTOQUE — a chave é o ID da linha de `estoques`, então duas
// linhas com o mesmo SKU/variante/local NÃO podem se anular na comparação.
// ---------------------------------------------------------------------------
function linha(estoque_id: number, quantidade: number, custo: number, local = 'Loja'): LinhaEstoque {
  return {
    estoque_id,
    empresa_id: 1,
    produto_id: 1,
    sku: 'SKU-1',
    tamanho_id: 1,
    tamanho: 'M',
    local,
    local_id: 1,
    quantidade_fisica: quantidade,
    reservado: 0,
    disponivel: quantidade,
    custo_unitario: custo,
    valor_total: quantidade * custo,
  };
}

test('ESTOQUE: linhas duplicadas (mesmo SKU/variante/local) são comparadas por ID', () => {
  const antes = [linha(1, 100, 10), linha(2, 5, 10)];
  // Se a comparação agregasse por SKU, mover 5 peças da linha 2 para a 1 passaria
  // batido. Por ID, é detectado.
  const movido = [linha(1, 105, 10), linha(2, 0, 10)];
  assert.equal(compararEstoque(antes, antes).length, 0);
  assert.ok(compararEstoque(antes, movido).length > 0, 'mover peças entre linhas homônimas deve divergir');
  // Perda real de uma linha inteira é detectada.
  assert.ok(compararEstoque(antes, [linha(1, 100, 10)]).some((d) => d.campo === 'ausente_depois'));
});

test('ESTOQUE: mudança de custo e valorização é detectada (não só a quantidade)', () => {
  const antes = [linha(1, 100, 10)];
  const custoMudou = [linha(1, 100, 12)];
  const d = compararEstoque(antes, custoMudou);
  assert.ok(d.some((x) => x.campo === 'custo_unitario'), 'mudança de custo deve divergir');
  assert.ok(d.some((x) => x.campo === 'valor_total'), 'mudança de valorização deve divergir');
});


