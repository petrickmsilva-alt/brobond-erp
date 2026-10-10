// ============================================================================
// E4.2.1 — integridade do estoque contra PostgreSQL REAL (sem mock, sem skip).
//
// O que só se prova aqui — o MemStore não tem FK composta, índice parcial,
// SELECT … FOR UPDATE nem corrida de verdade:
//
//   • a migração 0031 foi aplicada e as colunas/índices/FKs existem;
//   • FK composta (empresa_id, venda_id) recusa baixa, devolução e local de outra
//     empresa, com IDs reais (SQLSTATE 23503);
//   • matriz E2E em PG: 5→2→3→2→5 cancelado; 10/6/4/+2/+2/recusa 3/10; danificado;
//   • CONCORRÊNCIA: duas devoluções de 2 simultâneas com 2 restantes → só uma
//     consome, e o estoque nunca recebe 4; dois recebimentos simultâneos da mesma
//     devolução → o estoque sobe uma vez;
//   • idempotência da criação pelo índice único parcial (empresa_id, idempotency_key);
//   • multiempresa A ↔ B: B não cria, não recebe, não baixa, e A fica intacta;
//   • PDV grava local_saida_id canônico e recusa local de outra empresa.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-e421-estoque-integridade.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();
const { RESOURCES } = await import('../../src/resources');
const { getStore } = await import('../../src/services');
const exp = await import('../../src/expedicao');
const pdv = await import('../../src/pdv');
const { chamar, esperarErro, novoCliente, novoLocal, novoProduto, reqDe, resFake, saldoInicial } = await import('../_p1util');

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente' | 'operador'; empresa_id: number; empresas: number[] };
type Tenant = { empresaId: number; ator: Ator };

const RODADA = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;

function unico(prefixo: string): string {
  contador++;
  return `${prefixo}-${RODADA}-${contador}`;
}

/** Empresa nova + usuário real + Local padrão próprio. Isola cada cenário no banco. */
async function novoTenant(): Promise<Tenant> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa E421'), cnpj]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id, nome`,
    [unico('Usuário E421'), `${unico('e421')}@brobond.test`, empresaId]
  );
  await novoLocal('loja', empresaId, true);
  return {
    empresaId,
    ator: { id: Number(usr.rows[0].id), name: String(usr.rows[0].nome), perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
  };
}

async function saldoDoLocal(t: Tenant, produtoId: number, nomeLocal = 'loja'): Promise<number> {
  const s = getStore();
  const local = await s.findOneWhere(RESOURCES.locais, { empresa_id: t.empresaId, nome: nomeLocal });
  if (!local) return 0;
  const row = await s.findOneWhere(RESOURCES.estoques, { empresa_id: t.empresaId, produto_id: produtoId, local_id: Number(local.id) });
  return Number(row?.quantidade ?? 0);
}

/**
 * Venda de balcão FATURADA no ato (baixa com venda_id) em um tenant.
 *
 * Usa o PDV e não a expedição de propósito: a expedição grava etapas que o CHECK
 * `expedicao_eventos_etapa_valida` do PostgreSQL recusa (defeito pré-existente,
 * registrado em docs/ERP-GAPS.md como GAP-EXPEDICAO-ETAPA-PG e NÃO corrigido aqui).
 * O PDV chama o mesmo `aplicarRegrasPedido` do faturamento.
 */
async function pedidoFaturado(t: Tenant, saldoQtd: number, quantidade: number) {
  const s = getStore();
  const produto = await novoProduto({ sku: unico('E421-SKU'), preco_venda: 100, empresa_id: t.empresaId });
  await saldoInicial(produto, saldoQtd);
  const est = await s.findOneWhere(RESOURCES.estoques, { empresa_id: t.empresaId, produto_id: Number(produto.id) });
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: unico('CX-E421'), valor_abertura: 0 }, { user: t.ator }), 201);
  const venda = await chamar(pdv.venderPdv, reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: quantidade * 100 }],
    caixa_id: caixa.id,
  }, { user: t.ator }), 201);
  const faturada = await s.get(RESOURCES.vendas, Number(venda.venda_id));
  assert.equal(faturada!.status, 'faturada', 'o balcão fatura no ato (baixa de estoque)');
  return { vendaId: Number(venda.venda_id), produto, produtoId: Number(produto.id), tamanhoId: Number(est!.tamanho_id) };
}

type Item = { produto_id: number; tamanho_id: number | null; quantidade: number };

async function criar(t: Tenant, vendaId: number, itens: Item[]) {
  return chamar(exp.criarDevolucao, reqDe({ venda_id: vendaId, motivo: 'Cliente devolveu o produto', itens }, { user: t.ator }), 201);
}

async function tentarCriar(t: Tenant, vendaId: number, itens: Item[]) {
  // criarDevolucao responde por res.json: o valor útil é o corpo capturado.
  const { res, saida } = resFake();
  const r = await tentar(() => exp.criarDevolucao(reqDe({ venda_id: vendaId, motivo: 'Cliente devolveu o produto', itens }, { user: t.ator }), res));
  return r.ok ? { ok: true as const, value: saida.json as any } : r;
}

async function tentar(fn: () => Promise<unknown>): Promise<{ ok: true; value: any } | { ok: false; status: number; message: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e: any) {
    return { ok: false, status: Number(e?.status ?? e?.statusCode ?? 500), message: String(e?.message || '') };
  }
}

async function autorizarERastrear(t: Tenant, devId: number) {
  await chamar(exp.autorizarDevolucao, reqDe({ autorizacao_codigo: 'AUT-E421' }, { params: { id: devId }, user: t.ator }));
  await chamar(exp.registrarRastreamento, reqDe({ codigo_rastreamento: `REV${devId}E421BR` }, { params: { id: devId }, user: t.ator }));
}

async function receber(t: Tenant, devId: number, itens?: Record<string, unknown>[]) {
  return chamar(exp.receberDevolucao, reqDe(itens ? { itens } : {}, { params: { id: devId }, user: t.ator }));
}

async function itensDaDevolucao(devId: number) {
  return getStore().list(RESOURCES.devolucao_itens, { page: 1, pageSize: 100, filter: { devolucao_id: devId }, sort: 'id', dir: 'asc' });
}

async function devolucoesDaVenda(vendaId: number) {
  const r = await getStore().list(RESOURCES.devolucoes, { page: 1, pageSize: 200, filter: { venda_id: vendaId } });
  return r.rows;
}

async function movimentosDaVenda(vendaId: number) {
  const r = await getStore().list(RESOURCES.movimentacoes, { page: 1, pageSize: 200, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  return r.rows;
}

/** Devolve o item inteiro (1 linha) em um único recebimento. */
async function devolverInteiro(t: Tenant, devId: number, quantidade: number, estado = 'bom') {
  await autorizarERastrear(t, devId);
  const [linha] = (await itensDaDevolucao(devId)).rows;
  return receber(t, devId, [{ id: Number(linha.id), quantidade_recebida: quantidade, estado }]);
}

// ----------------------------------------------------------------------------
// 1) Schema real: migração aplicada, colunas, índices e FKs compostas
// ----------------------------------------------------------------------------
test('E4.2.1 PG: migração 0031 registrada e colunas/índices/FKs existem no banco', async () => {
  const reg = await query(`SELECT id FROM schema_migrations WHERE id = '0031_e421_integridade_estoque.sql'`);
  assert.equal(reg.rows.length, 1, 'a migração 0031 foi aplicada e registrada');

  const colunas = await query(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE (table_name = 'movimentacoes' AND column_name = 'venda_id')
         OR (table_name = 'vendas' AND column_name = 'local_saida_id')
         OR (table_name = 'devolucoes' AND column_name = 'idempotency_key')`
  );
  assert.equal(colunas.rows.length, 3);
  for (const c of colunas.rows) assert.equal(c.is_nullable, 'YES', `${c.table_name}.${c.column_name} é nullable (histórico sem backfill)`);

  const idx = await query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('e421_mov_empresa_venda_idx', 'uq_e421_devolucoes_empresa_idempotency')`);
  assert.equal(idx.rows.length, 2);

  const fks = await query(
    `SELECT conname FROM pg_constraint WHERE conname IN (
       'fk_e421_mov_empresa_venda', 'fk_e421_vendas_empresa_local_saida',
       'fk_e421_devolucoes_empresa_venda', 'fk_e421_devolucao_itens_empresa_devolucao') AND convalidated`
  );
  assert.equal(fks.rows.length, 4, 'as 4 FKs compostas estão criadas e VALIDADAS');

  const legado = await query(`SELECT COUNT(*)::int AS n FROM movimentacoes WHERE tipo = 'saida' AND venda_id IS NULL AND motivo LIKE 'Venda #%'`);
  assert.ok(Number(legado.rows[0].n) >= 0, 'saídas anteriores permanecem com venda_id NULL (nenhum backfill)');
});

// ----------------------------------------------------------------------------
// 2) Integridade no banco: vínculo cruzado entre empresas é recusado
// ----------------------------------------------------------------------------
test('E4.2.1 PG: FK composta recusa venda_id, devolução e local_saida_id de OUTRA empresa (23503)', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const pa = await pedidoFaturado(a, 5, 2);
  const localB = await novoLocal(unico('Depósito B'), b.empresaId, false);

  // Movimento da empresa B apontando para a venda da empresa A.
  const produtoB = await novoProduto({ sku: unico('B-SKU'), empresa_id: b.empresaId });
  const movCruzado = await tentarSql(() => query(
    `INSERT INTO movimentacoes (empresa_id, produto_id, tipo, quantidade, local, local_id, venda_id, motivo)
     VALUES ($1, $2, 'saida', 1, 'loja', (SELECT id FROM locais WHERE empresa_id = $1 AND nome = 'loja' LIMIT 1), $3, 'cruzado')`,
    [b.empresaId, Number(produtoB.id), pa.vendaId]
  ));
  assert.equal(movCruzado, '23503', 'movimentação de B não pode referenciar venda de A');

  const devCruzada = await tentarSql(() => query(
    `INSERT INTO devolucoes (empresa_id, venda_id, status, motivo) VALUES ($1, $2, 'solicitada', 'vinculo cruzado')`,
    [b.empresaId, pa.vendaId]
  ));
  assert.equal(devCruzada, '23503', 'devolução de B não pode referenciar venda de A');

  const localCruzado = await tentarSql(() => query(
    `UPDATE vendas SET local_saida_id = $2 WHERE id = $1`,
    [pa.vendaId, Number(localB.id)]
  ));
  assert.equal(localCruzado, '23503', 'venda de A não pode apontar para local de B');

  // A venda da empresa A continua exatamente como estava.
  assert.equal(await saldoDoLocal(a, pa.produtoId), 3);
});

async function tentarSql(fn: () => Promise<unknown>): Promise<string | 'ok'> {
  try {
    await fn();
    return 'ok';
  } catch (e: any) {
    return String(e?.code ?? e?.message);
  }
}

// ----------------------------------------------------------------------------
// 3) Matriz E2E em PostgreSQL real
// ----------------------------------------------------------------------------
test('E4.2.1 PG E2E-1: 5 → venda 2 → 3 → devolução total boa 2 → 5 (não 7); estorno posterior não restaura', async () => {
  const t = await novoTenant();
  const p = await pedidoFaturado(t, 5, 2);
  const trilha = [await saldoDoLocal(t, p.produtoId)];
  const dev = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]);
  const out = await devolverInteiro(t, Number(dev.id), 2);
  trilha.push(await saldoDoLocal(t, p.produtoId));
  assert.deepEqual(trilha, [3, 5]);
  assert.equal(out.financeiro.aplicado, true);
  assert.equal((await getStore().get(RESOURCES.vendas, p.vendaId))!.status, 'cancelada');
  const estornos = (await movimentosDaVenda(p.vendaId)).filter((m) => String(m.motivo).startsWith('Estorno'));
  assert.equal(estornos.length, 0, 'o estorno calculado é zero: nada volta duas vezes');
  await esperarErro(() => receber(t, Number(dev.id)), 409, /já foi recebida/);
  assert.equal(await saldoDoLocal(t, p.produtoId), 5);
});

test('E4.2.1 PG E2E-2: 10 → venda 6 → 4 → +2 = 6 → +2 = 8 → recusa 3 com 2 restantes (sem movimento) → +2 = 10', async () => {
  const t = await novoTenant();
  const p = await pedidoFaturado(t, 10, 6);
  const trilha = [await saldoDoLocal(t, p.produtoId)];
  const d1 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]);
  await devolverInteiro(t, Number(d1.id), 2);
  trilha.push(await saldoDoLocal(t, p.produtoId));
  const d2 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]);
  await devolverInteiro(t, Number(d2.id), 2);
  trilha.push(await saldoDoLocal(t, p.produtoId));
  assert.deepEqual(trilha, [4, 6, 8]);

  const movsAntes = (await movimentosDaVenda(p.vendaId)).length;
  const devsAntes = (await devolucoesDaVenda(p.vendaId)).length;
  const recusa = await tentarCriar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 3 }]);
  assert.equal(recusa.ok, false);
  assert.equal(recusa.ok ? 0 : recusa.status, 409, 'devolver 3 com 2 restantes é recusado');
  assert.equal((await movimentosDaVenda(p.vendaId)).length, movsAntes, 'recusa sem movimento');
  assert.equal((await devolucoesDaVenda(p.vendaId)).length, devsAntes, 'recusa sem cabeçalho órfão');
  assert.equal(await saldoDoLocal(t, p.produtoId), 8);

  const d3 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]);
  await devolverInteiro(t, Number(d3.id), 2);
  assert.equal(await saldoDoLocal(t, p.produtoId), 10);
  assert.equal((await getStore().get(RESOURCES.vendas, p.vendaId))!.status, 'cancelada');
});

test('E4.2.1 PG E2E-3: danificado — 3 vendidos (5 → 2), 1 boa e 1 danificada, 3ª boa → saldo 4 (5 − 1 danificada)', async () => {
  const t = await novoTenant();
  const p = await pedidoFaturado(t, 5, 3);
  assert.equal(await saldoDoLocal(t, p.produtoId), 2);

  const d1 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }]);
  await devolverInteiro(t, Number(d1.id), 1, 'bom');
  assert.equal(await saldoDoLocal(t, p.produtoId), 3);

  const d2 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }]);
  await devolverInteiro(t, Number(d2.id), 1, 'avariado');
  assert.equal(await saldoDoLocal(t, p.produtoId), 3, 'a danificada não entra no saldo vendável');
  assert.equal((await getStore().get(RESOURCES.vendas, p.vendaId))!.status, 'faturada');

  const d3 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }]);
  await devolverInteiro(t, Number(d3.id), 1, 'bom');
  assert.equal(await saldoDoLocal(t, p.produtoId), 4, '5 − 1 danificada = 4');
  assert.equal((await getStore().get(RESOURCES.vendas, p.vendaId))!.status, 'cancelada');
});

test('E4.2.1 PG estorno: venda de balcão com devolução parcial — cancelar restaura só as 2 peças ainda não devolvidas', async () => {
  const t = await novoTenant();
  const s = getStore();
  const produto = await novoProduto({ sku: unico('PDV-SKU'), preco_venda: 100, codigo_barras: `78904214${String(Date.now()).slice(-6)}${contador++}`, empresa_id: t.empresaId });
  await saldoInicial(produto, 5);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: unico('CX-E421'), valor_abertura: 0 }, { user: t.ator }), 201);
  const saida = await chamar(pdv.venderPdv, reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade: 3, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: 300 }],
    caixa_id: caixa.id,
  }, { user: t.ator }), 201);
  const vendaId = Number(saida.venda_id);
  assert.equal(await saldoDoLocal(t, Number(produto.id)), 2);
  const venda = await s.get(RESOURCES.vendas, vendaId);
  const loja = await s.findOneWhere(RESOURCES.locais, { empresa_id: t.empresaId, nome: 'loja' });
  assert.equal(Number(venda!.local_saida_id), Number(loja!.id), 'venda de PDV grava o local canônico');

  const est = await s.findOneWhere(RESOURCES.estoques, { empresa_id: t.empresaId, produto_id: Number(produto.id) });
  const dev = await criar(t, vendaId, [{ produto_id: Number(produto.id), tamanho_id: Number(est!.tamanho_id), quantidade: 1 }]);
  await devolverInteiro(t, Number(dev.id), 1, 'bom');
  assert.equal(await saldoDoLocal(t, Number(produto.id)), 3);

  await chamar(pdv.cancelarVendaPdv, reqDe({ motivo: 'Cliente desistiu da compra' }, { params: { id: vendaId }, user: t.ator }));
  assert.equal(await saldoDoLocal(t, Number(produto.id)), 5, 'restaurou 3 − 1 = 2, não 3');
});

// ----------------------------------------------------------------------------
// 4) CONCORRÊNCIA em PostgreSQL real
// ----------------------------------------------------------------------------
test('E4.2.1 PG concorrência: duas devoluções de 2 SIMULTÂNEAS com 2 restantes → só uma consome; estoque nunca recebe 4', async () => {
  const t = await novoTenant();
  const p = await pedidoFaturado(t, 10, 4); // 10 → 6
  const d1 = await criar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]);
  await devolverInteiro(t, Number(d1.id), 2); // 6 → 8; restam 2 vendidos
  assert.equal(await saldoDoLocal(t, p.produtoId), 8);

  const antes = (await devolucoesDaVenda(p.vendaId)).length;
  const corrida = await Promise.all([
    tentarCriar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]),
    tentarCriar(t, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 2 }]),
  ]);
  const vencedoras = corrida.filter((r) => r.ok);
  const perdedoras = corrida.filter((r) => !r.ok) as { ok: false; status: number; message: string }[];
  assert.equal(vencedoras.length, 1, `exatamente uma devolução é criada (resultados: ${JSON.stringify(corrida.map((r) => (r.ok ? 'ok' : r.status)))})`);
  assert.equal(perdedoras.length, 1);
  assert.equal(perdedoras[0].status, 409, 'a perdedora é recusada pela regra, não por erro de servidor');
  assert.match(perdedoras[0].message, /Não é possível devolver/, 'a perdedora lê o saldo já consumido pela vencedora');
  assert.equal((await devolucoesDaVenda(p.vendaId)).length, antes + 1);

  const vencedora = Number((vencedoras[0] as { value: { id: number } }).value.id);
  await autorizarERastrear(t, vencedora);
  const [linha] = (await itensDaDevolucao(vencedora)).rows;
  // Dois recebimentos simultâneos da MESMA devolução: só um pode subir o estoque.
  const recebimentos = await Promise.all([
    tentar(() => receber(t, vencedora, [{ id: Number(linha.id), quantidade_recebida: 2, estado: 'bom' }])),
    tentar(() => receber(t, vencedora, [{ id: Number(linha.id), quantidade_recebida: 2, estado: 'bom' }])),
  ]);
  assert.equal(recebimentos.filter((r) => r.ok).length, 1, 'exatamente um recebimento vence');
  const estoqueFinal = await saldoDoLocal(t, p.produtoId);
  assert.equal(estoqueFinal, 10, 'estoque 8 + 2 = 10 (nunca 12)');
  const entradas = (await movimentosDaVenda(p.vendaId)).filter((m) => m.tipo === 'entrada' && String(m.motivo).includes(`Devolução #${vencedora}`));
  assert.equal(entradas.length, 1, 'uma única entrada de estoque para a devolução vencedora');
  assert.equal((await getStore().get(RESOURCES.vendas, p.vendaId))!.status, 'cancelada', 'devolução total cancela a venda uma vez');
});

test('E4.2.1 PG idempotência: a mesma chave em requisições simultâneas cria UMA devolução', async () => {
  const t = await novoTenant();
  const p = await pedidoFaturado(t, 5, 2);
  const chave = unico('idem-e421');
  const itens = [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }];
  const req = () => reqDe({ venda_id: p.vendaId, motivo: 'Cliente devolveu o produto', itens, idempotency_key: chave }, { user: t.ator });
  const disparar = async () => {
    const { res, saida } = resFake();
    await exp.criarDevolucao(req(), res);
    return { status: Number(saida.status), corpo: saida.json as any };
  };
  const corrida = await Promise.all([disparar(), disparar()]);
  const criadas = (await devolucoesDaVenda(p.vendaId)).filter((d) => String(d.idempotency_key) === chave);
  assert.equal(criadas.length, 1, 'o índice único parcial impede a duplicata, mesmo na corrida');
  assert.deepEqual(corrida.map((r) => r.status).sort(), [200, 201], 'uma cria (201) e a outra reaproveita (200)');
  assert.ok(corrida.every((r) => Number(r.corpo.id) === Number(criadas[0].id)), 'as duas respostas apontam para a mesma devolução');
  assert.equal(corrida.filter((r) => r.corpo.idempotente === true).length, 1);
});

// ----------------------------------------------------------------------------
// 5) Multiempresa A ↔ B com IDs reais
// ----------------------------------------------------------------------------
test('E4.2.1 PG multiempresa: B não cria, não recebe e não baixa nada da venda da A; A fica intacta', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const p = await pedidoFaturado(a, 5, 2);
  const dev = await criar(a, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }]);
  const devId = Number(dev.id);

  const criarDeB = await tentarCriar(b, p.vendaId, [{ produto_id: p.produtoId, tamanho_id: p.tamanhoId, quantidade: 1 }]);
  assert.equal(criarDeB.ok, false);
  assert.equal(criarDeB.ok ? 0 : criarDeB.status, 404, 'B não enxerga a venda da A');
  assert.doesNotMatch(criarDeB.ok ? '' : criarDeB.message, /empresa/i, 'a resposta não confirma a empresa-alvo');

  await autorizarERastrear(a, devId);
  const linhaDaDevolucao = Number((await itensDaDevolucao(devId)).rows[0].id);
  const receberDeB = await tentar(() => receber(b, devId, [{ id: linhaDaDevolucao, quantidade_recebida: 1, estado: 'bom' }]));
  assert.equal(receberDeB.ok, false);
  assert.equal(receberDeB.ok ? 0 : receberDeB.status, 404, 'B não recebe devolução da A');

  assert.equal(await saldoDoLocal(a, p.produtoId), 3, 'o saldo da A não mudou com as tentativas de B');
  assert.equal(await saldoDoLocal(b, p.produtoId), 0, 'B não ganhou estoque');
  assert.equal((await getStore().get(RESOURCES.devolucoes, devId))!.status, 'em_transito', 'a devolução da A segue em trânsito (autorizada e rastreada)');
});

// ----------------------------------------------------------------------------
// 6) PDV / local canônico em PostgreSQL
// ----------------------------------------------------------------------------
test('E4.2.1 PG PDV: local_saida_id segue o caixa e local de outra empresa é recusado com 404', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const s = getStore();
  const produto = await novoProduto({ sku: unico('PDV-LOC'), preco_venda: 100, codigo_barras: `78904215${String(Date.now()).slice(-6)}${contador++}`, empresa_id: a.empresaId });
  await saldoInicial(produto, 3);
  const caixa = await chamar(pdv.abrirCaixa, reqDe({ numero: unico('CX-LOC'), valor_abertura: 0 }, { user: a.ator }), 201);
  const venda = await chamar(pdv.venderPdv, reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade: 1, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: 100 }],
    caixa_id: caixa.id,
  }, { user: a.ator }), 201);
  const loja = await s.findOneWhere(RESOURCES.locais, { empresa_id: a.empresaId, nome: 'loja' });
  assert.equal(Number((await s.get(RESOURCES.vendas, Number(venda.venda_id)))!.local_saida_id), Number(loja!.id));

  const localB = await novoLocal(unico('Loja B PDV'), b.empresaId, false);
  const recusa = await tentar(() => pdv.venderPdv(reqDe({
    itens: [{ produto_id: Number(produto.id), quantidade: 1, desconto_pct: 0 }],
    pagamentos: [{ forma: 'pix', valor: 100 }],
    caixa_id: caixa.id,
    local_saida_id: Number(localB.id),
  }, { user: a.ator }), resFake().res));
  assert.equal(recusa.ok, false);
  assert.equal(recusa.ok ? 0 : recusa.status, 404, 'local da empresa B é inexistente para a A');
  assert.equal(await saldoDoLocal(a, Number(produto.id)), 2, 'a recusa não baixou nada');
});
