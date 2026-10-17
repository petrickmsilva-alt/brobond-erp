// ============================================================================
// P2-04 — constraints PostgreSQL NOT VALID contra PostgreSQL REAL (sem skip).
//
// O FULL FORENSIC SYSTEM AUDIT apontou constraints CHECK criadas NOT VALID e
// nunca validadas. Esta prova ataca as três dimensões do achado, contra o
// catálogo real (`pg_constraint.convalidated`), não contra grep:
//
//   A. INVENTÁRIO — as 8 constraints NOT VALID do achado existem, são CHECK e
//      cobrem exatamente as tabelas financeiras esperadas;
//   B. VALIDITY   — após as migrações, NENHUMA constraint do banco fica NOT
//      VALID (convalidated = true em todas);
//   C. VIOLAÇÃO   — cada regra recusa escrita inválida com SQLSTATE 23514
//      (o que prova que a constraint está ATIVA, não só presente);
//   D. HISTÓRICO  — dados legítimos (valor > 0, contas distintas, vocabulário
//      canônico) continuam aceitos e legíveis;
//   E. MIGRATION  — banco novo sobe com tudo validado; reexecutar a migração é
//      idempotente (não regride para NOT VALID nem falha);
//   F. ADVERSARIAL — tentativas de burlar cada regra (FK órfã, valor 0/negativo,
//      taxa >= 100, contas iguais, método/status fora do vocabulário);
//   G. PARITY     — MemStore e PostgreSQL concordam: o mesmo payload de valor 0
//      é recusado nos dois (sem DATABASE_URL divergente).
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  throw new Error('pg/p2-04-not-valid-constraints.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();

type Ck = { conname: string; tabela: string; contype: string; convalidated: boolean; definicao: string };

const ESPERADAS: { tabela: string; nome: string }[] = [
  { tabela: 'lancamentos_financeiros', nome: 'ck_lanc_fin_valor_positivo' },
  { tabela: 'lancamentos_financeiros', nome: 'ck_lanc_fin_taxa_pct' },
  { tabela: 'transferencias_financeiras', nome: 'ck_transf_fin_valor_positivo' },
  { tabela: 'transferencias_financeiras', nome: 'ck_transf_fin_contas_diferentes' },
  { tabela: 'gateway_cobrancas', nome: 'ck_gateway_cobrancas_valor' },
  { tabela: 'gateway_cobrancas', nome: 'ck_gateway_cobrancas_metodo' },
  { tabela: 'gateway_cobrancas', nome: 'ck_gateway_cobrancas_status' },
  { tabela: 'fin_extrato_transacoes', nome: 'ck_extrato_valor_positivo' },
];

const RODADA = `p204${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;
const unico = (p: string) => `${p}-${RODADA}-${++contador}`;

/** Empresa + usuário reais para satisfazer FKs das escritas adversariais. */
async function novoTenant(): Promise<number> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa P204'), cnpj]);
  return Number(emp.rows[0].id);
}

async function novaConta(empresaId: number): Promise<number> {
  const r = await query(
    `INSERT INTO contas_financeiras (nome, tipo, empresa_id) VALUES ($1, 'caixa', $2) RETURNING id`,
    [unico('Conta P204'), empresaId]
  );
  return Number(r.rows[0].id);
}

/** SQLSTATE de uma escrita que deve ser recusada pelo banco. */
async function sqlstate(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await query(sql, params);
    return null;
  } catch (e: any) {
    return String(e.code || e.sqlstate || '');
  }
}

// ----------------------------------------------------------------------------
// A. INVENTÁRIO — as constraints do achado existem, são CHECK e estão no lugar.
// ----------------------------------------------------------------------------
test('P2-04 inventário: as 8 constraints do achado existem como CHECK nas tabelas esperadas', async () => {
  const r = await query<Ck>(
    `SELECT c.conname, c.conrelid::regclass::text AS tabela, c.contype::text AS contype,
            c.convalidated, pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c
      WHERE c.conname = ANY($1::text[])
      ORDER BY c.conname`,
    [ESPERADAS.map((e) => e.nome)]
  );
  assert.equal(r.rows.length, ESPERADAS.length, 'alguma constraint do achado P2-04 desapareceu');
  for (const e of ESPERADAS) {
    const row = r.rows.find((x) => x.conname === e.nome);
    assert.ok(row, `${e.nome} não existe`);
    assert.equal(row!.tabela, e.tabela, `${e.nome} está em tabela inesperada`);
    assert.equal(row!.contype, 'c', `${e.nome} não é CHECK`);
  }
});

// ----------------------------------------------------------------------------
// B. VALIDITY — estado final: nenhuma constraint NOT VALID no banco.
// ----------------------------------------------------------------------------
test('P2-04 validity: nenhuma constraint do banco permanece NOT VALID', async () => {
  const r = await query<Ck>(
    `SELECT c.conname, c.conrelid::regclass::text AS tabela, c.contype::text AS contype,
            c.convalidated, pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE NOT c.convalidated AND n.nspname = 'public'
      ORDER BY c.conname`
  );
  assert.equal(
    r.rows.length,
    0,
    `há constraints NOT VALID no banco: ${r.rows.map((x) => `${x.tabela}.${x.conname}`).join(', ')}`
  );
});

test('P2-04 validity: cada constraint do achado tem convalidated = true', async () => {
  const r = await query<Ck>(
    `SELECT c.conname, c.conrelid::regclass::text AS tabela, c.contype::text AS contype,
            c.convalidated, pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c
      WHERE c.conname = ANY($1::text[])`,
    [ESPERADAS.map((e) => e.nome)]
  );
  for (const e of ESPERADAS) {
    const row = r.rows.find((x) => x.conname === e.nome)!;
    assert.equal(row.convalidated, true, `${e.tabela}.${e.nome} continua NOT VALID`);
  }
});

// ----------------------------------------------------------------------------
// C. VIOLAÇÃO — a constraint ATIVA recusa escrita inválida (23514).
// ----------------------------------------------------------------------------
test('P2-04 violação: cada regra recusa escrita inválida com 23514', async () => {
  const empresaId = await novoTenant();
  const c1 = await novaConta(empresaId);
  const c2 = await novaConta(empresaId);

  const casos: { nome: string; sql: string; params: unknown[] }[] = [
    {
      nome: 'lancamentos_financeiros.valor = 0',
      sql: `INSERT INTO lancamentos_financeiros (empresa_id, data, tipo, descricao, valor, status)
            VALUES ($1, CURRENT_DATE, 'despesa', $2, 0, 'confirmado')`,
      params: [empresaId, unico('lanc-zero')],
    },
    {
      nome: 'lancamentos_financeiros.valor < 0',
      sql: `INSERT INTO lancamentos_financeiros (empresa_id, data, tipo, descricao, valor, status)
            VALUES ($1, CURRENT_DATE, 'despesa', $2, -1, 'confirmado')`,
      params: [empresaId, unico('lanc-neg')],
    },
    {
      nome: 'lancamentos_financeiros.taxa_pct >= 100',
      sql: `INSERT INTO lancamentos_financeiros (empresa_id, data, tipo, descricao, valor, taxa_pct, status)
            VALUES ($1, CURRENT_DATE, 'despesa', $2, 10, 100, 'confirmado')`,
      params: [empresaId, unico('lanc-taxa')],
    },
    {
      nome: 'transferencias_financeiras.valor = 0',
      sql: `INSERT INTO transferencias_financeiras (empresa_id, data, conta_origem_id, conta_destino_id, valor, status)
            VALUES ($1, CURRENT_DATE, $2, $3, 0, 'confirmado')`,
      params: [empresaId, c1, c2],
    },
    {
      nome: 'transferencias_financeiras origem = destino',
      sql: `INSERT INTO transferencias_financeiras (empresa_id, data, conta_origem_id, conta_destino_id, valor, status)
            VALUES ($1, CURRENT_DATE, $2, $2, 10, 'confirmado')`,
      params: [empresaId, c1],
    },
    {
      nome: 'gateway_cobrancas.valor = 0',
      sql: `INSERT INTO gateway_cobrancas (empresa_id, provider, metodo, valor, status)
            VALUES ($1, 'mock', 'pix', 0, 'pendente')`,
      params: [empresaId],
    },
    {
      nome: 'gateway_cobrancas.metodo fora do vocabulário',
      sql: `INSERT INTO gateway_cobrancas (empresa_id, provider, metodo, valor, status)
            VALUES ($1, 'mock', 'cheque', 10, 'pendente')`,
      params: [empresaId],
    },
    {
      nome: 'gateway_cobrancas.status fora do vocabulário',
      sql: `INSERT INTO gateway_cobrancas (empresa_id, provider, metodo, valor, status)
            VALUES ($1, 'mock', 'pix', 10, 'inexistente')`,
      params: [empresaId],
    },
    {
      nome: 'fin_extrato_transacoes.valor = 0',
      sql: `INSERT INTO fin_extrato_transacoes (empresa_id, conta_id, linha_hash, valor, status)
            VALUES ($1, $2, $3, 0, 'importada')`,
      params: [empresaId, c1, unico('hash')],
    },
  ];

  for (const caso of casos) {
    const code = await sqlstate(caso.sql, caso.params);
    assert.equal(code, '23514', `${caso.nome} deveria ser recusado pelo CHECK (23514), veio ${code}`);
  }
});

// ----------------------------------------------------------------------------
// D. HISTÓRICO — dados legítimos continuam aceitos e legíveis.
// ----------------------------------------------------------------------------
test('P2-04 histórico: dados legítimos continuam aceitos e legíveis', async () => {
  const empresaId = await novoTenant();
  const c1 = await novaConta(empresaId);
  const c2 = await novaConta(empresaId);

  const lanc = await query<{ id: number }>(
    `INSERT INTO lancamentos_financeiros (empresa_id, data, tipo, descricao, valor, taxa_pct, status)
     VALUES ($1, CURRENT_DATE, 'receita', $2, 1234.56, 4.99, 'confirmado') RETURNING id`,
    [empresaId, unico('lanc-ok')]
  );
  const transf = await query<{ id: number }>(
    `INSERT INTO transferencias_financeiras (empresa_id, data, conta_origem_id, conta_destino_id, valor, status)
     VALUES ($1, CURRENT_DATE, $2, $3, 500, 'confirmado') RETURNING id`,
    [empresaId, c1, c2]
  );
  const cob = await query<{ id: number }>(
    `INSERT INTO gateway_cobrancas (empresa_id, provider, metodo, valor, status)
     VALUES ($1, 'mock', 'boleto', 99.9, 'paga') RETURNING id`,
    [empresaId]
  );
  const ext = await query<{ id: number }>(
    `INSERT INTO fin_extrato_transacoes (empresa_id, conta_id, linha_hash, valor, status)
     VALUES ($1, $2, $3, 42.42, 'importada') RETURNING id`,
    [empresaId, c1, unico('hash-ok')]
  );

  assert.ok(Number(lanc.rows[0].id) > 0, 'lançamento legítimo não gravou');
  assert.ok(Number(transf.rows[0].id) > 0, 'transferência legítima não gravou');
  assert.ok(Number(cob.rows[0].id) > 0, 'cobrança legítima não gravou');
  assert.ok(Number(ext.rows[0].id) > 0, 'linha de extrato legítima não gravou');

  const relido = await query<{ valor: string }>(`SELECT valor FROM lancamentos_financeiros WHERE id = $1`, [lanc.rows[0].id]);
  assert.equal(Number(relido.rows[0].valor), 1234.56, 'o histórico legítimo deve continuar acessível');
});

// ----------------------------------------------------------------------------
// E. MIGRATION — reexecutar a migração é idempotente e não regride.
// ----------------------------------------------------------------------------
test('P2-04 migration: reexecutar a migração 0035 não regride para NOT VALID', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const arquivo = path.resolve(process.cwd(), '../db/migrations/0035_p2_04_not_valid_constraints.sql');
  const sql = readFileSync(arquivo, 'utf8');
  // Reexecução direta do DDL (o runner já a registrou como aplicada; aqui
  // provamos que o SQL em si é reaplicável sem quebrar nem reverter estado).
  await query(sql);
  const r = await query<Ck>(
    `SELECT c.conname, c.conrelid::regclass::text AS tabela, c.contype::text AS contype,
            c.convalidated, pg_get_constraintdef(c.oid) AS definicao
       FROM pg_constraint c
      WHERE c.conname = ANY($1::text[])`,
    [ESPERADAS.map((e) => e.nome)]
  );
  for (const e of ESPERADAS) {
    const row = r.rows.find((x) => x.conname === e.nome)!;
    assert.equal(row.convalidated, true, `${e.tabela}.${e.nome} voltou a NOT VALID na reexecução`);
  }
});

// ----------------------------------------------------------------------------
// F. ADVERSARIAL — FK órfã continua recusada (integridade referencial real).
// ----------------------------------------------------------------------------
test('P2-04 adversarial: FK órfã continua recusada (23503)', async () => {
  const empresaId = await novoTenant();
  const code = await sqlstate(
    `INSERT INTO lancamentos_financeiros (empresa_id, data, tipo, descricao, valor, conta_id, status)
     VALUES ($1, CURRENT_DATE, 'despesa', $2, 10, 2147483000, 'confirmado')`,
    [empresaId, unico('lanc-fk')]
  );
  assert.equal(code, '23503', `FK órfã deveria ser recusada (23503), veio ${code}`);
});

// ----------------------------------------------------------------------------
// G. PARITY — MemStore e PostgreSQL concordam sobre "valor > 0".
//
// O modo memória não tem CHECK. A guarda de domínio (validatePayload pelo
// `min` do recurso + gancho em criarLancamento) é o que mantém os dois stores
// idênticos. Aqui provamos o lado PostgreSQL; o lado memória é provado em
// `test/p204-paridade.test.ts` (sem DATABASE_URL). Juntos: nenhum aceita o que
// o outro recusa.
// ----------------------------------------------------------------------------
test('P2-04 parity: o recurso exige valor > 0 (mesma regra de ck_lanc_fin_valor_positivo)', async () => {
  const { RESOURCES } = await import('../../src/resources');
  assert.equal(
    RESOURCES.lancamentos_financeiros.fields.find((f) => f.name === 'valor')!.min,
    0.01,
    'lancamentos_financeiros.valor deve exigir > 0 (paridade com ck_lanc_fin_valor_positivo)'
  );
  for (const chave of ['aportes', 'recorrencias_financeiras', 'transferencias_financeiras'] as const) {
    assert.equal(RESOURCES[chave].fields.find((x) => x.name === 'valor')!.min, 0.01, `${chave}.valor deve exigir > 0`);
  }
});
