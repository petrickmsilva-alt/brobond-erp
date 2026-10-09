// ============================================================================
// PRODUÇÃO E2 contra Postgres REAL.
//
// O que só se prova aqui (o memdb não tem constraint nem isolamento real):
//   • o CHECK de vocabulário de status existe e recusa valor fora da lista;
//   • as FKs ordem_id existem em movimentacoes e movimentacoes_insumos e são
//     ON DELETE SET NULL (apagar a OP não apaga a história contábil);
//   • o índice único parcial de idempotência bloqueia a chave duplicada NO BANCO,
//     mesmo se a checagem de aplicação for contornada por corrida;
//   • o backfill da 0026 liga movimentação antiga à OP pelo motivo "OP #N" e
//     deixa NULL o que é órfão (nunca inventa vínculo);
//   • duas conclusões concorrentes da mesma OP: exatamente uma vence;
//   • a trilha e os apontamentos herdam empresa_id da OP, e a empresa B não lê A.
//
// Rodam no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

type Actor = { id: number; name: string; perfil: string; empresa_id?: number; empresas?: number[] };

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRACAO_0026 = readFileSync(join(AQUI, '../../db/migrations/0026_producao_completa.sql'), 'utf8');

/** Os UPDATE de backfill da 0026, extraídos do arquivo — executa o SQL real. */
function updatesDeBackfill(): string[] {
  const achados: string[] = [];
  const re = /UPDATE (movimentacoes|movimentacoes_insumos) (?:m|mi)\s+SET ordem_id[\s\S]*?EXISTS \(SELECT 1 FROM ordens_fabricacao o WHERE o\.id = x\.oid::int\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(MIGRACAO_0026))) achados.push(m[0]);
  return achados;
}

async function base() {
  const { migrate, query, pool } = await import('../src/db');
  await migrate();
  const { RESOURCES } = await import('../src/resources');
  const { createRecord, getStore, updateRecord } = await import('../src/services');
  return { query, pool, RESOURCES, createRecord, s: getStore(), updateRecord };
}

async function novaEmpresa(nome: string, cnpj: string) {
  const { query } = await import('../src/db');
  const r = await query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [nome, cnpj]);
  return Number(r.rows[0].id);
}

async function usuarioDa(empresaId: number, perfil: string, sufixo: string): Promise<Actor> {
  const { query } = await import('../src/db');
  const r = await query(`INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id, nome`, [
    `Usuário ${sufixo}`,
    `${sufixo}@brobond.test`,
    perfil,
    empresaId,
  ]);
  return { id: Number(r.rows[0].id), name: String(r.rows[0].nome), perfil, empresa_id: empresaId, empresas: [empresaId] };
}

// ---------------------------------------------------------------------------
// 1) ESTRUTURA: CHECK, FKs e índices existem no banco de verdade
// ---------------------------------------------------------------------------

test('E2 (PG): a 0026 criou CHECK de vocabulário, FKs ordem_id e índice de idempotência', { skip }, async () => {
  const { query } = await base();

  const checks = await query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'ordens_fabricacao' AND c.contype = 'c'`);
  const vocab = checks.rows.find((r: any) => String(r.conname).includes('status_valido'));
  assert.ok(vocab, 'falta o CHECK de vocabulário de status da OP');
  for (const st of ['planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada']) {
    assert.ok(String(vocab.def).includes(st), `o CHECK não cobre "${st}": ${vocab.def}`);
  }

  for (const tabela of ['movimentacoes', 'movimentacoes_insumos']) {
    const fk = await query(`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class t ON t.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
       WHERE t.relname = $1 AND con.contype = 'f' AND a.attname = 'ordem_id'`, [tabela]);
    assert.equal(fk.rows.length, 1, `${tabela}.ordem_id precisa ter exatamente uma FK`);
    assert.match(String(fk.rows[0].def), /ON DELETE SET NULL/, `${tabela}.ordem_id deve ser ON DELETE SET NULL: ${fk.rows[0].def}`);
  }

  const idx = await query(`
    SELECT indexdef FROM pg_indexes
     WHERE tablename = 'ordens_apontamentos' AND indexdef ILIKE '%idempotency_key%'`);
  assert.equal(idx.rows.length, 1, 'falta o índice único de idempotência dos apontamentos');
  assert.match(String(idx.rows[0].indexdef), /UNIQUE/i);
  assert.match(String(idx.rows[0].indexdef), /WHERE.*idempotency_key IS NOT NULL/i, 'o índice tem que ser parcial (só onde a chave existe)');

  const colunas = await query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ordens_fabricacao'
       AND column_name IN ('liberada_em','liberada_por','iniciada_em','concluida_em','cancelada_em','cancelada_por','motivo_cancelamento','custo_previsto','custo_real','quantidade_perdida')`);
  assert.equal(colunas.rows.length, 10, `faltam colunas do fluxo da OP: ${colunas.rows.map((r: any) => r.column_name).join(',')}`);
});

// ---------------------------------------------------------------------------
// 2) O CHECK RECUSA de verdade
// ---------------------------------------------------------------------------

test('E2 (PG): status fora do vocabulário é recusado pelo banco, não só pela aplicação', { skip }, async () => {
  const { query, RESOURCES, s } = await base();
  const empresa = await novaEmpresa(`E2 Check ${Date.now()}`, `${10000000000000 + (Date.now() % 89999999999999)}`);
  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `CK${Date.now() % 100000}`, nome: 'M', ativo: true, empresa_id: empresa });
  const prod = await s.insert(RESOURCES.produtos, { sku: `E2CK-${Date.now()}`, nome: 'P check', preco_venda: 10, ativo: true, empresa_id: empresa });

  const erro = await query(
    `INSERT INTO ordens_fabricacao (empresa_id, produto_id, tipo, tamanho_id, quantidade, status)
     VALUES ($1, $2, 'tamanho', $3, 1, 'voando')`,
    [empresa, Number(prod.id), Number(tam.id)]
  ).then(() => null, (e: any) => e);
  assert.ok(erro, 'o banco aceitou um status fora do vocabulário');
  assert.equal(erro.code, '23514', `esperava violação de CHECK, veio ${erro.code}: ${erro.message}`);
  assert.match(String(erro.message), /status_valido/);
});

// ---------------------------------------------------------------------------
// 3) BACKFILL DA 0026 — executa o SQL do próprio arquivo de migração
// ---------------------------------------------------------------------------

test('E2 (PG): o backfill liga a movimentação antiga à OP pelo motivo e deixa o órfão NULL', { skip }, async () => {
  const { query, RESOURCES, s } = await base();
  const updates = updatesDeBackfill();
  assert.equal(updates.length, 2, `esperava 2 UPDATE de backfill na 0026, achei ${updates.length}`);

  const empresa = await novaEmpresa(`E2 Backfill ${Date.now()}`, `${20000000000000 + (Date.now() % 79999999999999)}`);
  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `BF${Date.now() % 100000}`, nome: 'M', ativo: true, empresa_id: empresa });
  const prod = await s.insert(RESOURCES.produtos, { sku: `E2BF-${Date.now()}`, nome: 'P backfill', preco_venda: 10, ativo: true, empresa_id: empresa });
  const op = await s.insert(RESOURCES.ordens, { empresa_id: empresa, produto_id: Number(prod.id), tipo: 'tamanho', tamanho_id: Number(tam.id), quantidade: 5, status: 'concluida' });
  const opId = Number(op.id);

  // Legado típico: o vínculo estava só no texto do motivo.
  const legado = await query(
    `INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, quantidade, motivo)
     VALUES ($1, 'entrada', $2, $3, 5, 'Entrada por OP #${opId}') RETURNING id`,
    [empresa, Number(prod.id), Number(tam.id)]
  );
  const semPadrao = await query(
    `INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, quantidade, motivo)
     VALUES ($1, 'entrada', $2, $3, 1, 'Entrada por compra') RETURNING id`,
    [empresa, Number(prod.id), Number(tam.id)]
  );
  const orfao = await query(
    `INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, quantidade, motivo)
     VALUES ($1, 'saida', $2, $3, 1, 'Baixa por OP #99999999') RETURNING id`,
    [empresa, Number(prod.id), Number(tam.id)]
  );
  const insumo = await s.insert(RESOURCES.insumos, { nome: `Insumo BF ${Date.now()}`, unidade: 'm', custo_medio: 1, ativo: true, empresa_id: empresa });
  const legadoInsumo = await query(
    `INSERT INTO movimentacoes_insumos (empresa_id, tipo, insumo_id, quantidade, custo_unitario, motivo)
     VALUES ($1, 'saida', $2, 10, 1, 'Consumo OP #${opId}') RETURNING id`,
    [empresa, Number(insumo.id)]
  );

  for (const u of updates) await query(u);

  const depois = await query(
    `SELECT id, ordem_id FROM movimentacoes WHERE id IN ($1, $2, $3) ORDER BY id`,
    [Number(legado.rows[0].id), Number(semPadrao.rows[0].id), Number(orfao.rows[0].id)]
  );
  const porId = new Map(depois.rows.map((r: any) => [Number(r.id), r.ordem_id]));
  assert.equal(porId.get(Number(legado.rows[0].id)), opId, 'a movimentação com "OP #N" no motivo não foi ligada');
  assert.equal(porId.get(Number(semPadrao.rows[0].id)), null, 'motivo sem padrão não pode ganhar vínculo');
  assert.equal(porId.get(Number(orfao.rows[0].id)), null, 'OP inexistente não pode gerar vínculo inventado');

  const depoisInsumo = await query(`SELECT ordem_id FROM movimentacoes_insumos WHERE id = $1`, [Number(legadoInsumo.rows[0].id)]);
  assert.equal(depoisInsumo.rows[0].ordem_id, opId, 'o consumo de insumo antigo não foi ligado à OP');
});

test('E2 (PG): apagar a OP preserva a movimentação e solta o vínculo (ON DELETE SET NULL)', { skip }, async () => {
  const { query, RESOURCES, s } = await base();
  const empresa = await novaEmpresa(`E2 OnDelete ${Date.now()}`, `${30000000000000 + (Date.now() % 69999999999999)}`);
  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `OD${Date.now() % 100000}`, nome: 'M', ativo: true, empresa_id: empresa });
  const prod = await s.insert(RESOURCES.produtos, { sku: `E2OD-${Date.now()}`, nome: 'P ondelete', preco_venda: 10, ativo: true, empresa_id: empresa });
  const op = await s.insert(RESOURCES.ordens, { empresa_id: empresa, produto_id: Number(prod.id), tipo: 'tamanho', tamanho_id: Number(tam.id), quantidade: 2, status: 'planejada' });
  const mov = await query(
    `INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, quantidade, motivo, ordem_id)
     VALUES ($1, 'entrada', $2, $3, 2, 'teste', $4) RETURNING id`,
    [empresa, Number(prod.id), Number(tam.id), Number(op.id)]
  );

  await query(`DELETE FROM ordens_fabricacao WHERE id = $1`, [Number(op.id)]);
  const depois = await query(`SELECT ordem_id FROM movimentacoes WHERE id = $1`, [Number(mov.rows[0].id)]);
  assert.equal(depois.rows.length, 1, 'a movimentação foi apagada junto com a OP — a história contábil sumiu');
  assert.equal(depois.rows[0].ordem_id, null, 'o vínculo deveria ter virado NULL');
});

// ---------------------------------------------------------------------------
// 4) IDEMPOTÊNCIA NO BANCO
// ---------------------------------------------------------------------------

test('E2 (PG): a mesma chave de idempotência na mesma empresa é recusada pelo índice único', { skip }, async () => {
  const { query, RESOURCES, s } = await base();
  const empresa = await novaEmpresa(`E2 Idem ${Date.now()}`, `${40000000000000 + (Date.now() % 59999999999999)}`);
  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `ID${Date.now() % 100000}`, nome: 'M', ativo: true, empresa_id: empresa });
  const prod = await s.insert(RESOURCES.produtos, { sku: `E2ID-${Date.now()}`, nome: 'P idem', preco_venda: 10, ativo: true, empresa_id: empresa });
  const op = await s.insert(RESOURCES.ordens, { empresa_id: empresa, produto_id: Number(prod.id), tipo: 'tamanho', tamanho_id: Number(tam.id), quantidade: 5, status: 'liberada' });
  const corpo = { empresa_id: empresa, ordem_id: Number(op.id), tamanho_id: Number(tam.id), quantidade_produzida: 1, quantidade_perdida: 0, idempotency_key: `chave-${Date.now()}` };

  await query(
    `INSERT INTO ordens_apontamentos (empresa_id, ordem_id, tamanho_id, quantidade_produzida, quantidade_perdida, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [corpo.empresa_id, corpo.ordem_id, corpo.tamanho_id, 1, 0, corpo.idempotency_key]
  );
  const erro = await query(
    `INSERT INTO ordens_apontamentos (empresa_id, ordem_id, tamanho_id, quantidade_produzida, quantidade_perdida, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [corpo.empresa_id, corpo.ordem_id, corpo.tamanho_id, 1, 0, corpo.idempotency_key]
  ).then(() => null, (e: any) => e);
  assert.ok(erro, 'o banco aceitou dois apontamentos com a mesma chave');
  assert.equal(erro.code, '23505', `esperava violação de unique, veio ${erro.code}: ${erro.message}`);

  // Chave NULL é repetível: apontamento sem chave nunca colide.
  await query(
    `INSERT INTO ordens_apontamentos (empresa_id, ordem_id, tamanho_id, quantidade_produzida, quantidade_perdida, idempotency_key)
     VALUES ($1,$2,$3,1,0,NULL)`,
    [empresa, Number(op.id), Number(tam.id)]
  );
  await query(
    `INSERT INTO ordens_apontamentos (empresa_id, ordem_id, tamanho_id, quantidade_produzida, quantidade_perdida, idempotency_key)
     VALUES ($1,$2,$3,1,0,NULL)`,
    [empresa, Number(op.id), Number(tam.id)]
  );
});

// ---------------------------------------------------------------------------
// 5) CONCORRÊNCIA REAL
// ---------------------------------------------------------------------------

test('E2 (PG): duas conclusões concorrentes da mesma OP — exatamente uma vence', { skip }, async () => {
  const { query, RESOURCES, s, updateRecord } = await base();
  const sufixo = Date.now();
  const empresa = await novaEmpresa(`E2 Conc ${sufixo}`, `${50000000000000 + (sufixo % 49999999999999)}`);
  const gerente = await usuarioDa(empresa, 'gerente', `e2conc${sufixo}`);
  const tam = await s.insert(RESOURCES.tamanhos, { codigo: `CC${sufixo % 100000}`, nome: 'M', ativo: true, empresa_id: empresa });
  const prod = await s.insert(RESOURCES.produtos, { sku: `E2CC-${sufixo}`, nome: 'P concorrência', preco_venda: 10, ativo: true, empresa_id: empresa });
  const op = await s.insert(RESOURCES.ordens, { empresa_id: empresa, produto_id: Number(prod.id), tipo: 'tamanho', tamanho_id: Number(tam.id), quantidade: 4, status: 'planejada' });

  const tentar = () => updateRecord(RESOURCES.ordens, Number(op.id), { status: 'concluida' }, gerente, { escopo: gerente }).then(
    () => 'ok',
    (e: any) => `erro:${e?.status ?? e?.code ?? 'desconhecido'}`
  );
  const resultados = (await Promise.all([tentar(), tentar()])).sort();
  const vitorias = resultados.filter((r) => r === 'ok').length;
  assert.equal(vitorias, 1, `as duas conclusões não podem passar: ${resultados.join(' , ')}`);

  // E o estoque recebeu a peça UMA vez.
  const entradas = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(quantidade),0)::int AS qtd FROM movimentacoes WHERE ordem_id = $1 AND tipo = 'entrada'`, [Number(op.id)]);
  assert.equal(entradas.rows[0].n, 1, `esperava 1 entrada de produto acabado, vieram ${entradas.rows[0].n}`);
  assert.equal(entradas.rows[0].qtd, 4);
});

// ---------------------------------------------------------------------------
// 6) MULTIEMPRESA NO BANCO: A → B → A
// ---------------------------------------------------------------------------

test('E2 (PG): OP, trilha e apontamento não atravessam empresa (A → B → A)', { skip }, async () => {
  const { query, RESOURCES, s, updateRecord } = await base();
  const sufixo = Date.now();
  const empA = await novaEmpresa(`E2 A ${sufixo}`, `${60000000000000 + (sufixo % 39999999999999)}`);
  const empB = await novaEmpresa(`E2 B ${sufixo}`, `${70000000000000 + (sufixo % 29999999999999)}`);
  const adminA = await usuarioDa(empA, 'admin', `e2a${sufixo}`);
  const adminB = await usuarioDa(empB, 'admin', `e2b${sufixo}`);

  const tamA = await s.insert(RESOURCES.tamanhos, { codigo: `A${sufixo % 100000}`, nome: 'M', ativo: true, empresa_id: empA });
  const prodA = await s.insert(RESOURCES.produtos, { sku: `E2A-${sufixo}`, nome: 'P da A', preco_venda: 10, ativo: true, empresa_id: empA });
  const opA = await s.insert(RESOURCES.ordens, { empresa_id: empA, produto_id: Number(prodA.id), tipo: 'tamanho', tamanho_id: Number(tamA.id), quantidade: 6, status: 'liberada' });

  await s.insert(RESOURCES.ordens_apontamentos, { empresa_id: empA, ordem_id: Number(opA.id), tamanho_id: Number(tamA.id), quantidade_produzida: 2, quantidade_perdida: 0 });
  await s.insert(RESOURCES.ordens_eventos, { empresa_id: empA, ordem_id: Number(opA.id), evento: 'apontamento', mensagem: 'teste', de_status: 'liberada', para_status: 'parcial' });

  // --- B não lê A ---------------------------------------------------------
  const listaB = await query(`SELECT COUNT(*)::int AS n FROM ordens_fabricacao WHERE empresa_id = $1`, [empB]);
  assert.equal(listaB.rows[0].n, 0, 'a empresa B enxerga OP que não é dela');
  const { listRecords } = await import('../src/services');
  const ordensDeB = await listRecords(RESOURCES.ordens, { page: 1, pageSize: 500 }, adminB);
  assert.ok(!ordensDeB.rows.some((o: any) => Number(o.id) === Number(opA.id)), 'a OP da A vazou na lista da B');

  // --- B não escreve em A: 404, não 403 (não confirma que o registro existe) --
  const tentativa = await updateRecord(RESOURCES.ordens, Number(opA.id), { status: 'concluida' }, adminB, { escopo: adminB }).then(
    () => 'conseguiu',
    (e: any) => String(e?.status)
  );
  assert.equal(tentativa, '404', `a B alterou a OP da A (status HTTP ${tentativa})`);

  // --- A continua operando normalmente --------------------------------------
  const concluida = await updateRecord(RESOURCES.ordens, Number(opA.id), { status: 'concluida' }, adminA, { escopo: adminA });
  assert.equal(concluida.status, 'concluida');

  const escopo = await query(
    `SELECT (SELECT COUNT(*)::int FROM ordens_eventos WHERE ordem_id = $1 AND empresa_id <> $2) AS ev_ruim,
            (SELECT COUNT(*)::int FROM ordens_apontamentos WHERE ordem_id = $1 AND empresa_id <> $2) AS ap_ruim,
            (SELECT COUNT(*)::int FROM movimentacoes WHERE ordem_id = $1 AND empresa_id <> $2) AS mv_ruim,
            (SELECT COUNT(*)::int FROM ordens_eventos WHERE ordem_id = $1) AS ev_total`,
    [Number(opA.id), empA]
  );
  assert.equal(escopo.rows[0].ev_ruim, 0, 'evento de OP com empresa_id errado');
  assert.equal(escopo.rows[0].ap_ruim, 0, 'apontamento com empresa_id errado');
  assert.equal(escopo.rows[0].mv_ruim, 0, 'movimentação de OP com empresa_id errado');
  assert.ok(escopo.rows[0].ev_total >= 1, 'a conclusão deveria ter deixado trilha');
});
