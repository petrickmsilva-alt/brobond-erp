// ============================================================================
// OPS — SANEAMENTO PRÉ-GO-LIVE (Fase 2/3 da ordem executiva).
//
// Prova, em PostgreSQL REAL e banco DESCARTÁVEL:
//   (a) o DRY-RUN executa o plano inteiro e faz ROLLBACK: nada muda;
//   (b) a EXECUÇÃO limpa os dados de teste (venda, pedido, financeiro, outbox,
//       reservas) e PRESERVA o estoque físico célula a célula;
//   (c) o saneamento NUNCA toca cadastros nem a estrutura financeira;
//   (d) a fotografia de estoque bate antes/depois (nenhuma peça perdida);
//   (e) a execução deixa trilha em `auditoria`;
//   (f) confirmação/escopo obrigatórios (não executa por acidente nem global).
//
// Exige DATABASE_URL e PostgreSQL real; não é permitido pular.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, Pool } from 'pg';
import { BOOTSTRAP_FILE, aplicarCadeia } from './_boot-harness';
import {
  CONFIRMACAO_EXECUCAO,
  compararEstoque,
  executarSaneamento,
  fotografiaEstoque,
  totalFisico,
} from '../../src/ops/saneamento';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/ops-saneamento-go-live.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

const base = process.env.DATABASE_URL;
const BOOTSTRAP = readFileSync(BOOTSTRAP_FILE, 'utf8');

async function comAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: base });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Cria um banco descartável, aplica a estrutura e devolve URL + cliente. */
async function criarBanco(prefixo: string): Promise<{ url: string; cliente: Client }> {
  const nome = `sane_${prefixo}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await comAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).then(() => c.query(`CREATE DATABASE ${nome}`)));
  const u = new URL(base);
  u.pathname = `/${nome}`;
  const url = u.toString();
  const cliente = new Client({ connectionString: url });
  await cliente.connect();
  await cliente.query(BOOTSTRAP);
  await aplicarCadeia(cliente);
  return { url, cliente };
}

async function destruirBanco(url: string) {
  const nome = new URL(url).pathname.replace(/^\//, '');
  await comAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`).catch(() => undefined));
}

async function seed(cliente: Client) {
  // Cadastros (NUNCA removidos pelo saneamento). Ids altos para não colidir
  // com o seed do bootstrap; ON CONFLICT mantém o teste reexecutável.
  await cliente.query(`INSERT INTO empresas (id, nome) VALUES (9001, 'BROBOND TESTE') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO usuarios (id, nome, email, empresa_id) VALUES (9001, 'Diretor', 'dir@brobond.test', 9001) ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO clientes (id, nome) VALUES (9001, 'Cliente Teste') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO produtos (id, sku, nome, custo, preco_venda, preco_atacado, empresa_id) VALUES (9001, 'SKU-1', 'Camiseta', 10, 99, 59, 9001) ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO tamanhos (id, codigo) VALUES (9001, 'M') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO locais (id, nome, empresa_id) VALUES (9001, 'Loja', 9001) ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO contas_financeiras (id, nome, tipo, saldo_inicial, empresa_id) VALUES (9001, 'Caixa', 'caixa', 0, 9001) ON CONFLICT DO NOTHING`);

  // ESTOQUE FÍSICO REAL — a única posição a preservar.
  await cliente.query(`INSERT INTO estoques (id, produto_id, tamanho_id, local, local_id, quantidade, empresa_id)
                       VALUES (9001, 9001, 9001, 'Loja', 9001, 845, 9001) ON CONFLICT DO NOTHING`);

  // Dados de TESTE transacionais.
  await cliente.query(`INSERT INTO vendas (id, empresa_id, total, status) VALUES (9010, 9001, 100, 'faturada') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO itens_venda (id, venda_id, empresa_id, produto_id, tamanho_id, quantidade, preco_unitario)
                       VALUES (9011, 9010, 9001, 9001, 9001, 2, 50) ON CONFLICT DO NOTHING`);
  // Saída de estoque ORIGINADA por venda de teste (não deve mexer na linha de `estoques`).
  await cliente.query(`INSERT INTO movimentacoes (id, empresa_id, tipo, produto_id, tamanho_id, local, local_id, quantidade, venda_id)
                       VALUES (9012, 9001, 'saida', 9001, 9001, 'Loja', 9001, 2, 9010) ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO estoque_reservas (id, empresa_id, produto_id, tamanho_id, local_id, quantidade, status)
                       VALUES (9013, 9001, 9001, 9001, 9001, 2, 'ativa') ON CONFLICT DO NOTHING`);

  await cliente.query(`INSERT INTO sales (id, reference, usuario_id, empresa_id, quantity, amount_cents)
                       VALUES ('sale-9001', 'ref-9001', 9001, 9001, 1, 10000) ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO sale_items (id, sale_id, product_id, size_id, quantity) VALUES ('si-9001', 'sale-9001', 9001, 9001, 1) ON CONFLICT DO NOTHING`);

  await cliente.query(`INSERT INTO commerce_pedidos (id, empresa_id, canal, pedido_externo, venda_id, estado)
                       VALUES (9020, 9001, 'BROBOND', 'PED-1', 9010, 'CONVERTIDO') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO commerce_outbox (id, empresa_id, tipo, chave, estado) VALUES (9021, 9001, 'conversao', 'c-1', 'ERRO') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO gateway_cobrancas (id, empresa_id, provider, metodo, valor, venda_id, status)
                       VALUES (9022, 9001, 'mercadopago', 'pix', 100, 9010, 'paga') ON CONFLICT DO NOTHING`);
  await cliente.query(`INSERT INTO lancamentos_financeiros (id, empresa_id, descricao, valor, tipo, conta_id)
                       VALUES (9023, 9001, 'Recebimento teste', 100, 'entrada', 9001) ON CONFLICT DO NOTHING`);

  // Movimentação REAL de entrada (não deve ser removida: não tem venda/transferência/inventário).
  await cliente.query(`INSERT INTO movimentacoes (id, empresa_id, tipo, produto_id, tamanho_id, local, local_id, quantidade, motivo)
                       VALUES (9030, 9001, 'entrada', 9001, 9001, 'Loja', 9001, 845, 'saldo inicial real') ON CONFLICT DO NOTHING`);
}

test('OPS: dry-run executa o plano e faz ROLLBACK — nada muda', async () => {
  const { url, cliente } = await criarBanco('dry');
  const pool = new Pool({ connectionString: url });
  try {
    await seed(cliente);
    const antes = await fotografiaEstoque(pool, [9001]);
    const r = await executarSaneamento(pool, { empresaIds: [9001], modo: 'dry-run', ator: 'teste' });
    assert.ok(r.totalRemovido > 0, 'o dry-run deve contabilizar linhas de teste');
    assert.equal(r.estoquePreservado, true);
    assert.equal(Number((await cliente.query(`SELECT count(*)::int n FROM vendas`)).rows[0].n), 1, 'dry-run não pode remover vendas');
    assert.equal(Number((await cliente.query(`SELECT count(*)::int n FROM commerce_outbox`)).rows[0].n), 1, 'dry-run não pode remover outbox');
    assert.equal(compararEstoque(antes, await fotografiaEstoque(pool, [9001])).length, 0);
  } finally {
    await pool.end().catch(() => undefined);
    await cliente.end().catch(() => undefined);
    await destruirBanco(url);
  }
});

test('OPS: execução limpa dados de teste e PRESERVA o estoque físico', async () => {
  const { url, cliente } = await criarBanco('exec');
  const pool = new Pool({ connectionString: url });
  try {
    await seed(cliente);
    const antes = await fotografiaEstoque(pool, [9001]);
    assert.equal(totalFisico(antes), 845, 'a posição física de partida é 845 peças');

    const r = await executarSaneamento(pool, { empresaIds: [9001], modo: 'executar', confirmacao: CONFIRMACAO_EXECUCAO, ator: 'Diretor' });
    assert.equal(r.estoquePreservado, true, 'o estoque físico não pode mudar');
    assert.ok(r.auditoriaId, 'a execução deve deixar trilha em auditoria');

    for (const t of ['vendas', 'itens_venda', 'sales', 'sale_items', 'commerce_pedidos', 'commerce_outbox', 'gateway_cobrancas', 'lancamentos_financeiros', 'estoque_reservas']) {
      const n = Number((await cliente.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
      assert.equal(n, 0, `${t} deveria estar zerada`);
    }
    for (const t of ['produtos', 'clientes', 'usuarios', 'empresas', 'contas_financeiras']) {
      const n = Number((await cliente.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
      assert.ok(n >= 1, `${t} não pode ser removida`);
    }

    const depois = await fotografiaEstoque(pool, [9001]);
    assert.equal(totalFisico(depois), 845, 'o total físico deve continuar 845');
    assert.equal(compararEstoque(antes, depois).length, 0, 'nenhuma célula pode divergir');
    assert.equal(depois[0].custo_unitario, 10, 'o custo unitário é preservado');
    assert.equal(depois[0].valor_total, 8450, 'a valorização é preservada');
    assert.equal(depois[0].reservado, 0, 'as reservas de teste foram removidas');
    assert.equal(depois[0].disponivel, 845, 'a disponibilidade volta a ser o físico (sem reservas artificiais)');

    const movs = (await cliente.query(`SELECT id FROM movimentacoes ORDER BY id`)).rows.map((x: any) => Number(x.id));
    assert.deepEqual(movs, [9030], 'só a movimentação real de entrada permanece');

    const aud = (await cliente.query(`SELECT descricao FROM auditoria WHERE acao = 'saneamento-homologacao'`)).rows;
    assert.equal(aud.length, 1, 'a intervenção deve ser auditada');
    assert.match(aud[0].descricao, /estoque físico preservado/i);
  } finally {
    await pool.end().catch(() => undefined);
    await cliente.end().catch(() => undefined);
    await destruirBanco(url);
  }
});

test('OPS: confirmação e escopo são obrigatórios (nunca executa por acidente nem global)', async () => {
  const { url, cliente } = await criarBanco('guard');
  const pool = new Pool({ connectionString: url });
  try {
    await seed(cliente);
    await assert.rejects(
      () => executarSaneamento(pool, { empresaIds: [9001], modo: 'executar', confirmacao: 'sim', ator: 'x' }),
      /Confirmação inválida/,
      'execução sem a confirmação exata deve ser recusada'
    );
    await assert.rejects(
      () => executarSaneamento(pool, { empresaIds: [], modo: 'executar', confirmacao: CONFIRMACAO_EXECUCAO, ator: 'x' }),
      /ao menos uma empresa/,
      'execução global (sem escopo) deve ser recusada'
    );
    assert.equal(Number((await cliente.query(`SELECT count(*)::int n FROM vendas`)).rows[0].n), 1, 'nada foi removido');
  } finally {
    await pool.end().catch(() => undefined);
    await cliente.end().catch(() => undefined);
    await destruirBanco(url);
  }
});
