// ============================================================================
// E4.2.3 — expedição completa contra PostgreSQL REAL (sem mock, sem skip).
//
// Prova definitiva de AUD-01, AUD-02 e AUD-05 — o MemStore não tem CHECK,
// JSONB, transação nem corrida de verdade:
//
//   • AUD-01 — a migração 0032 substitui o CHECK de `expedicao_eventos` pelo
//     vocabulário canônico (pendente → separacao → conferida → embalada →
//     expedida) e `embalar`/`expedir` persistem SEM o SQLSTATE 23514;
//   • AUD-02 — a conferência reprovada persiste a divergência em JSONB válido
//     (`divergencias_conferencia`) e responde HTTP 422 — antes o array JS virava
//     literal `{...}` do Postgres (22P02), respondia 400 e nada era gravado;
//   • AUD-05 — E2E completo: empresa → cliente → produto → estoque → venda →
//     itens → separar → conferir → embalar → expedir (faturamento pelo fluxo
//     válido da máquina logística), com estoque baixado UMA única vez,
//     `venda_id` correto e eventos canônicos na ordem;
//   • upgrade: banco anterior à 0032 (CHECK antigo + linhas legadas) migra
//     sem perder dados e sem backfill heurístico;
//   • rollback: expedição que falha no faturamento não deixa estado parcial;
//   • multiempresa: B não opera a expedição de A (404);
//   • concorrência: duas expedições simultâneas → uma baixa, um evento final.
//
// Roda no job `testes-postgres` do CI (npm run test:pg). Sem DATABASE_URL FALHA.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

if (!process.env.DATABASE_URL) {
  throw new Error('pg-e423-expedicao-postgresql.test.ts exige DATABASE_URL e PostgreSQL real; não é permitido pular esta prova.');
}

process.env.NODE_ENV = 'test';

const { migrate, query } = await import('../../src/db');
await migrate();
const { RESOURCES } = await import('../../src/resources');
const { getStore } = await import('../../src/services');
const exp = await import('../../src/expedicao');
const { chamar, esperarErro, novoCliente, novoLocal, novoProduto, reqDe, resFake, saldoInicial } = await import('../_p1util');

type Ator = { id: number; name: string; perfil: 'admin'; empresa_id: number; empresas: number[] };
type Tenant = { empresaId: number; ator: Ator };

const RODADA = `e423${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let contador = 0;

function unico(prefixo: string): string {
  contador++;
  return `${prefixo}-${RODADA}-${contador}`;
}

const MIGRATION_0032 = '0032_e423_expedicao_vocabulario.sql';
const CANONICO = ['pendente', 'separacao', 'conferida', 'embalada', 'expedida'];

/** Empresa nova + usuário real + Local padrão próprio. Isola cada cenário. */
async function novoTenant(): Promise<Tenant> {
  const cnpj = String(Math.floor(10_000_000_000_000 + Math.random() * 89_999_999_999_999));
  const emp = await query(`INSERT INTO empresas (nome, cnpj, ativo) VALUES ($1, $2, true) RETURNING id`, [unico('Empresa E423'), cnpj]);
  const empresaId = Number(emp.rows[0].id);
  const usr = await query(
    `INSERT INTO usuarios (nome, email, perfil, empresa_id, ativo) VALUES ($1, $2, 'admin', $3, true) RETURNING id, nome`,
    [unico('Usuário E423'), `${unico('e423')}@brobond.test`, empresaId]
  );
  await novoLocal('loja', empresaId, true);
  return {
    empresaId,
    ator: { id: Number(usr.rows[0].id), name: String(usr.rows[0].nome), perfil: 'admin', empresa_id: empresaId, empresas: [empresaId] },
  };
}

type Pedido = {
  vendaId: number;
  produtoId: number;
  tamanhoId: number;
  codigos: string[];
  quantidade: number;
};

/**
 * Venda ABERTA (não faturada) com itens que TÊM código de barras — a máquina de
 * expedição trabalha antes do faturamento (separar recusa pedido faturado), e
 * o faturamento acontece dentro de `expedir` pelo mesmo caminho de sempre
 * (`aplicarRegrasPedido` → `faturarVenda`).
 */
async function pedidoParaExpedir(t: Tenant, quantidade: number, opts: { saldo?: number } = {}): Promise<Pedido> {
  const s = getStore();
  const cliente = await novoCliente({ empresa_id: t.empresaId });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: t.empresaId,
    cliente_id: Number(cliente.id),
    data: new Date().toISOString().slice(0, 10),
    status: 'aberta',
    total: 0,
  });
  const codigo = `789${String(Date.now()).slice(-8)}${contador}`;
  const p = await novoProduto({ sku: unico('SKU-E423'), preco_venda: 100, codigo_barras: codigo, empresa_id: t.empresaId });
  await saldoInicial(p, opts.saldo ?? Math.max(quantidade + 3, 5));
  const est = await s.findOneWhere(RESOURCES.estoques, { empresa_id: t.empresaId, produto_id: Number(p.id) });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: t.empresaId,
    venda_id: Number(venda.id),
    produto_id: Number(p.id),
    tamanho_id: Number(est.tamanho_id),
    quantidade,
    preco_unitario: 100,
    subtotal: quantidade * 100,
  });
  await s.update(RESOURCES.vendas, Number(venda.id), { total: quantidade * 100 });
  return {
    vendaId: Number(venda.id),
    produtoId: Number(p.id),
    tamanhoId: Number(est.tamanho_id),
    codigos: Array.from({ length: quantidade }, () => codigo),
    quantidade,
  };
}

async function etapaDaVenda(vendaId: number): Promise<string | null> {
  const r = await query(`SELECT expedicao_etapa FROM vendas WHERE id = $1`, [vendaId]);
  return r.rows[0] ? (r.rows[0].expedicao_etapa ?? null) : null;
}

async function eventosDe(vendaId: number): Promise<{ etapa: string; de_etapa: string | null; resultado: string }[]> {
  const r = await query(`SELECT etapa, de_etapa, resultado FROM expedicao_eventos WHERE venda_id = $1 ORDER BY id`, [vendaId]);
  return r.rows;
}

async function saldoDe(t: Tenant, produtoId: number, tamanhoId: number): Promise<number> {
  const r = await query(
    `SELECT quantidade FROM estoques WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3`,
    [t.empresaId, produtoId, tamanhoId]
  );
  return Number(r.rows[0]?.quantidade ?? 0);
}

async function movimentosDe(vendaId: number): Promise<{ tipo: string; quantidade: number; venda_id: number | null; empresa_id: number }[]> {
  const r = await query(`SELECT tipo, quantidade, venda_id, empresa_id FROM movimentacoes WHERE venda_id = $1 ORDER BY id`, [vendaId]);
  return r.rows.map((m: any) => ({ tipo: m.tipo, quantidade: Number(m.quantidade), venda_id: m.venda_id === null ? null : Number(m.venda_id), empresa_id: Number(m.empresa_id) }));
}

function caminhoMigration(): string {
  const candidatos = [
    path.resolve(process.cwd(), '../db/migrations', MIGRATION_0032),
    path.resolve(process.cwd(), 'db/migrations', MIGRATION_0032),
  ];
  const achou = candidatos.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(achou, `migration ${MIGRATION_0032} não encontrada`);
  return achou!;
}

// ---------------------------------------------------------------------------
// 1) UPGRADE — banco anterior à 0032 (CHECK antigo + linhas legadas)
// ---------------------------------------------------------------------------

test('E4.2.3 upgrade: 0032 substitui o CHECK antigo, preserva linhas legadas sem backfill e valida quando pode', async () => {
  const t = await novoTenant();
  const pedido = await pedidoParaExpedir(t, 1);
  // Dado real que o upgrade não pode perder.
  const saldoAntes = await saldoDe(t, pedido.produtoId, pedido.tamanhoId);

  // ---- fixture de banco ANTERIOR à 0032: CHECK de 0024 + linhas legadas ----
  await query(`ALTER TABLE expedicao_eventos DROP CONSTRAINT IF EXISTS expedicao_eventos_etapa_valida`);
  // NOT VALID só para a fixture não ser bloqueada por linhas de execuções
  // anteriores do próprio teste; em banco vazio a instalação do 0024 é equivalente.
  await query(`ALTER TABLE expedicao_eventos ADD CONSTRAINT expedicao_eventos_etapa_valida CHECK (etapa IN ('separacao', 'conferencia', 'embalagem', 'expedicao')) NOT VALID`);
  const legadas: Array<[string, string, string]> = [
    ['conferencia', 'separacao', 'ok'],
    ['embalagem', 'conferencia', 'ok'],
    ['expedicao', 'embalagem', 'ok'],
  ];
  for (const [etapa, de, resultado] of legadas) {
    await query(
      `INSERT INTO expedicao_eventos (empresa_id, venda_id, etapa, de_etapa, resultado, mensagem) VALUES ($1, $2, $3, $4, $5, 'linha legada da fixture de upgrade')`,
      [t.empresaId, pedido.vendaId, etapa, de, resultado]
    );
  }
  await query(`DELETE FROM schema_migrations WHERE id = $1`, [MIGRATION_0032]);

  // ---- A) a migration versionada sozinha já substitui o CHECK ----
  await query(readFileSync(caminhoMigration(), 'utf8'));
  // Escritas novas: vocabulário canônico aceito, vocabulário antigo recusado.
  await query(
    `INSERT INTO expedicao_eventos (empresa_id, venda_id, etapa, de_etapa, resultado, mensagem) VALUES ($1, $2, 'embalada', 'conferida', 'ok', 'escrita nova pós-upgrade')`,
    [t.empresaId, pedido.vendaId]
  );
  await assert.rejects(
    query(
      `INSERT INTO expedicao_eventos (empresa_id, venda_id, etapa, de_etapa, resultado, mensagem) VALUES ($1, $2, 'embalagem', 'conferida', 'ok', 'vocabulário antigo')`,
      [t.empresaId, pedido.vendaId]
    ),
    (e: any) => e.code === '23514',
    'o CHECK novo deve recusar o vocabulário antigo em escrita nova'
  );

  // ---- B) o runner de produção (migrate) completa o upgrade e registra ----
  await query(`DELETE FROM schema_migrations WHERE id = $1`, [MIGRATION_0032]);
  await migrate();
  const reg = await query(`SELECT id FROM schema_migrations WHERE id = $1`, [MIGRATION_0032]);
  assert.equal(reg.rows.length, 1, 'a migração 0032 deve ficar registrada em schema_migrations');

  // ---- C) dados preservados, SEM backfill: as legadas continuam com o valor antigo ----
  const etapas = await query(`SELECT etapa FROM expedicao_eventos WHERE venda_id = $1 ORDER BY id`, [pedido.vendaId]);
  const valores = etapas.rows.map((r: any) => r.etapa);
  for (const [etapa] of legadas) {
    assert.ok(valores.includes(etapa), `a linha legada "${etapa}" deve ser preservada como está (sem conversão)`);
  }
  assert.ok(valores.includes('embalada'), 'a escrita nova pós-upgrade deve permanecer');
  assert.equal(valores.filter((v: string) => v === 'conferencia').length, 1, 'sem backfill: nenhuma linha legada foi reescrita');
  // Venda e estoque intactos (etapa NULL = pendente; a máquina não foi tocada).
  assert.equal(await etapaDaVenda(pedido.vendaId), null, 'o upgrade não mexe na venda');
  assert.equal(await saldoDe(t, pedido.produtoId, pedido.tamanhoId), saldoAntes, 'o upgrade não mexe no estoque');
  // Tabelas e índices da expedição existem.
  for (const tabela of ['expedicao_eventos', 'divergencias_conferencia']) {
    const tb = await query(`SELECT to_regclass($1) AS tb`, [`public.${tabela}`]);
    assert.ok(tb.rows[0].tb, `a tabela ${tabela} deve existir`);
  }
  const idx = await query(`SELECT to_regclass('public.expedicao_eventos_idx') AS i`);
  assert.ok(idx.rows[0].i, 'o índice da trilha de eventos deve existir');

  // ---- D) sem linhas incompatíveis o CHECK volta a ser validado ----
  // A limpeza abaixo remove SOMENTE as linhas de fixture criadas neste teste
  // (nunca dado de terceiros); é o que uma migração futura de tratamento faria
  // de forma explícita. Nada é convertido no caminho.
  await query(`DELETE FROM expedicao_eventos WHERE mensagem = 'linha legada da fixture de upgrade'`);
  await query(`DELETE FROM schema_migrations WHERE id = $1`, [MIGRATION_0032]);
  await migrate();
  const chk = await query(`SELECT convalidated FROM pg_constraint WHERE conname = 'expedicao_eventos_etapa_valida'`);
  assert.equal(chk.rows[0].convalidated, true, 'sem linhas incompatíveis o CHECK deve estar validado');
  // E a trilha usável continua íntegra depois do ciclo completo da fixture.
  const finais = await eventosDe(pedido.vendaId);
  assert.ok(finais.some((e) => e.etapa === 'embalada'));
  assert.ok(finais.every((e) => CANONICO.includes(e.etapa)), 'após o tratamento explícito, só resta vocabulário canônico');
});

// ---------------------------------------------------------------------------
// 2) AUD-01 — embalar e expedir persistem no vocabulário canônico
// ---------------------------------------------------------------------------

test('E4.2.3 AUD-01: separar → conferir → embalar → expedir persiste embalada e expedida (antes: 23514 ao embalar)', async () => {
  const t = await novoTenant();
  const p = await pedidoParaExpedir(t, 2);
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });

  const sep = await chamar(exp.separarPedido, req());
  assert.equal(sep.etapa, 'separacao');
  assert.equal(await etapaDaVenda(p.vendaId), 'separacao');

  const conf = await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  assert.equal(conf.etapa, 'conferida');

  // O passo que falhava com 23514 (`expedicao_eventos_etapa_valida`) agora persiste.
  const emb = await chamar(exp.embalarPedido, req());
  assert.equal(emb.etapa, 'embalada');
  assert.equal(await etapaDaVenda(p.vendaId), 'embalada');

  const expd = await chamar(exp.expedirPedido, req());
  assert.equal(expd.etapa, 'expedida');
  assert.equal(expd.status, 'faturada');
  assert.equal(await etapaDaVenda(p.vendaId), 'expedida');

  const eventos = await eventosDe(p.vendaId);
  assert.deepEqual(eventos.map((e) => e.etapa), ['separacao', 'conferida', 'embalada', 'expedida'], 'eventos no vocabulário canônico e na ordem');
  assert.deepEqual(eventos.map((e) => e.de_etapa), ['pendente', 'separacao', 'conferida', 'embalada']);
  assert.ok(eventos.every((e) => e.resultado === 'ok'));
});

test('E4.2.3 AUD-01: o CHECK do banco recusa embalagem/expedicao/conferencia — uma única linguagem de domínio', async () => {
  const t = await novoTenant();
  const p = await pedidoParaExpedir(t, 1);
  for (const etapa of ['embalagem', 'expedicao', 'conferencia']) {
    await assert.rejects(
      query(
        `INSERT INTO expedicao_eventos (empresa_id, venda_id, etapa, resultado, mensagem) VALUES ($1, $2, $3, 'ok', 'tentativa de vocabulário antigo')`,
        [t.empresaId, p.vendaId, etapa]
      ),
      (e: any) => e.code === '23514',
      `expedicao_eventos.etapa deve recusar "${etapa}"`
    );
  }
  // E a venda também só aceita o vocabulário canônico (CHECK de 0024, mantido).
  for (const etapa of ['embalagem', 'expedicao', 'conferencia']) {
    await assert.rejects(
      query(`UPDATE vendas SET expedicao_etapa = $1 WHERE id = $2`, [etapa, p.vendaId]),
      (e: any) => e.code === '23514',
      `vendas.expedicao_etapa deve recusar "${etapa}"`
    );
  }
  assert.deepEqual(CANONICO, ['pendente', 'separacao', 'conferida', 'embalada', 'expedida']);
});

// ---------------------------------------------------------------------------
// 3) AUD-02 — conferência aprovada (A) e reprovada (B)
// ---------------------------------------------------------------------------

test('E4.2.3 AUD-02 caso A: conferência aprovada avança para conferida sem divergência e sem baixa', async () => {
  const t = await novoTenant();
  const p = await pedidoParaExpedir(t, 2);
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });
  await chamar(exp.separarPedido, req());

  const saldoAntes = await saldoDe(t, p.produtoId, p.tamanhoId);
  const out = await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  assert.equal(out.etapa, 'conferida');
  assert.equal(await etapaDaVenda(p.vendaId), 'conferida');

  const divs = await query(`SELECT id FROM divergencias_conferencia WHERE venda_id = $1`, [p.vendaId]);
  assert.equal(divs.rows.length, 0, 'caso A não tem divergência');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), saldoAntes, 'conferência não baixa estoque');
  assert.equal((await movimentosDe(p.vendaId)).length, 0);

  const eventos = await eventosDe(p.vendaId);
  assert.deepEqual(eventos.map((e) => [e.etapa, e.resultado]), [['separacao', 'ok'], ['conferida', 'ok']]);
});

test('E4.2.3 AUD-02 caso B: conferência reprovada responde 422 e persiste divergência JSONB válida (antes: 400/22P02 sem gravar)', async () => {
  const t = await novoTenant();
  const p = await pedidoParaExpedir(t, 2);
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });
  await chamar(exp.separarPedido, req());
  const saldoAntes = await saldoDe(t, p.produtoId, p.tamanhoId);

  // Lê 1 dos 2 códigos: faltou 1 unidade.
  const erro = await esperarErro(() => exp.conferirPedido(req({ codigos: [p.codigos[0]] }), resFake().res), 422, /não coincide com o pedido/);
  assert.ok(Number(erro.fields.divergencia_id) > 0, 'a divergência foi gravada');
  assert.equal(erro.fields.esperado_total, 2);
  assert.equal(erro.fields.lido_total, 1);

  // Registro em divergencias_conferencia com JSONB VÁLIDO e conteúdo correto.
  const bruto = await query(
    `SELECT id, esperado, lido, faltando, sobrando,
            jsonb_typeof(esperado) t_esp, jsonb_typeof(lido) t_lido,
            jsonb_typeof(faltando) t_falta, jsonb_typeof(sobrando) t_sobra
       FROM divergencias_conferencia WHERE id = $1`,
    [Number(erro.fields.divergencia_id)]
  );
  assert.equal(bruto.rows.length, 1, 'a divergência deve existir no banco');
  const d = bruto.rows[0];
  assert.equal(d.t_esp, 'array', 'esperado deve ser JSONB array válido');
  assert.equal(d.t_lido, 'array', 'lido deve ser JSONB array válido');
  assert.equal(d.t_falta, 'array', 'faltando deve ser JSONB array válido');
  assert.equal(d.t_sobra, 'array', 'sobrando deve ser JSONB array válido');
  assert.equal(d.lido.length, 1, 'o que foi lido ficou gravado');
  assert.deepEqual(d.lido, [p.codigos[0]]);
  assert.equal(d.esperado.length, 1);
  assert.equal(Number(d.esperado[0].quantidade), 2);
  assert.equal(d.faltando.length, 1);
  assert.equal(Number(d.faltando[0].quantidade), 1);
  assert.equal(d.sobrando.length, 0);

  // Etapa correta da venda: a reprovação NÃO avança.
  assert.equal(await etapaDaVenda(p.vendaId), 'separacao');
  // Nenhum efeito indevido em estoque.
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), saldoAntes, 'conferência reprovada não mexe no estoque');
  assert.equal((await movimentosDe(p.vendaId)).length, 0, 'nenhuma movimentação de estoque');

  // Evento auditado no vocabulário canônico — a divergência e o evento são
  // gravados na MESMA transação (não fica divergência órfã sem trilha).
  const eventos = await eventosDe(p.vendaId);
  assert.deepEqual(eventos.map((e) => [e.etapa, e.resultado]), [['separacao', 'ok'], ['conferida', 'divergencia']]);
  const ev = await query(`SELECT dados FROM expedicao_eventos WHERE venda_id = $1 ORDER BY id DESC LIMIT 1`, [p.vendaId]);
  assert.equal(Number(ev.rows[0].dados.divergencia_id), Number(erro.fields.divergencia_id), 'o evento aponta para a divergência gravada');

  // E o caminho continua: corrigida a leitura, a conferência passa.
  const out = await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  assert.equal(out.etapa, 'conferida');
});

// ---------------------------------------------------------------------------
// 4) AUD-05 — E2E completo em PostgreSQL: estoque, venda_id, eventos
// ---------------------------------------------------------------------------

test('E4.2.3 E2E PG: empresa → cliente → produto → estoque → venda → itens → separar → conferir → embalar → expedir', async () => {
  const t = await novoTenant();
  const s = getStore();

  // Criação em cada nível do fluxo pedido pela especificação.
  assert.ok(t.empresaId > 0, 'empresa criada');
  const cliente = await novoCliente({ empresa_id: t.empresaId });
  assert.ok(Number(cliente.id) > 0, 'cliente criado');
  const X = 5;
  const quantidade = 2;
  const p = await pedidoParaExpedir(t, quantidade, { saldo: X });
  assert.ok(p.produtoId > 0, 'produto criado');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X, 'estoque inicial = X');

  // Venda e itens já criados pela fábrica (status aberta — a máquina logística
  // fatura dentro de `expedir`; separar recusa pedido já faturado).
  const venda = await s.get(RESOURCES.vendas, p.vendaId);
  assert.equal(String(venda!.status), 'aberta');
  const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10, filter: { empresa_id: t.empresaId, venda_id: p.vendaId } });
  assert.equal(itens.rows.length, 1);

  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });

  // separar
  await chamar(exp.separarPedido, req());
  assert.equal(await etapaDaVenda(p.vendaId), 'separacao');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X, 'separação não baixa estoque');

  // conferir (sem divergência)
  await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  assert.equal(await etapaDaVenda(p.vendaId), 'conferida');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X, 'conferência não baixa estoque');

  // embalar
  await chamar(exp.embalarPedido, req());
  assert.equal(await etapaDaVenda(p.vendaId), 'embalada');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X, 'embalagem não baixa estoque');

  // expedir (faturamento pelo fluxo válido: baixa + comissão + financeiro)
  const expedida = await chamar(exp.expedirPedido, req());
  assert.equal(expedida.status, 'faturada');
  assert.equal(await etapaDaVenda(p.vendaId), 'expedida');

  // ---- estoque: UMA baixa, venda_id e empresa corretos ----
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X - quantidade, 'estoque = X − quantidade vendida');
  const movs = await movimentosDe(p.vendaId);
  assert.equal(movs.length, 1, 'exatamente uma movimentação — sem baixa duplicada nem fantasma');
  assert.equal(movs[0].tipo, 'saida');
  assert.equal(movs[0].quantidade, quantidade);
  assert.equal(movs[0].venda_id, p.vendaId, 'movimentação vinculada à venda (venda_id)');
  assert.equal(movs[0].empresa_id, t.empresaId, 'movimentação da empresa correta');

  // ---- eventos na ordem canônica ----
  const eventos = await eventosDe(p.vendaId);
  assert.deepEqual(eventos.map((e) => e.etapa), ['separacao', 'conferida', 'embalada', 'expedida']);
  assert.ok(!eventos.some((e) => ['embalagem', 'expedicao', 'conferencia'].includes(e.etapa)), 'vocabulário antigo não aparece');

  // ---- financeiro do faturamento ----
  const lanc = await query(`SELECT id FROM lancamentos_financeiros WHERE referencia_tipo = 'venda' AND referencia_id = $1`, [p.vendaId]);
  assert.ok(lanc.rows.length >= 1, 'o financeiro foi lançado no faturamento');

  // ---- sem segunda baixa: repetir as operações é recusado ----
  await esperarErro(() => exp.expedirPedido(req(), resFake().res), 409, /já está faturado/);
  await esperarErro(() => exp.embalarPedido(req(), resFake().res), 409, /Só se embala/);
  await esperarErro(() => exp.conferirPedido(req({ codigos: p.codigos }), resFake().res), 409, /já foi faturado/);
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), X - quantidade, 'nenhuma segunda baixa');
  assert.equal((await movimentosDe(p.vendaId)).length, 1, 'nenhuma movimentação repetida');
  assert.equal((await eventosDe(p.vendaId)).filter((e) => e.etapa === 'expedida').length, 1, 'um único evento final');
});

// ---------------------------------------------------------------------------
// 5) ROLLBACK — etapa que falha não deixa estado parcial
// ---------------------------------------------------------------------------

test('E4.2.3 rollback: expedição que falha no faturamento reverte tudo (venda, estoque, evento e financeiro)', async () => {
  const t = await novoTenant();
  const s = getStore();
  // Pedido maior do que o saldo: separação/conferência/embalagem passam (não
  // olham saldo); `expedir` falha em faturarVenda ("Não há saldo suficiente").
  const p = await pedidoParaExpedir(t, 10, { saldo: 4 });
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });

  await chamar(exp.separarPedido, req());
  await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  await chamar(exp.embalarPedido, req());
  const eventosAntes = await eventosDe(p.vendaId);
  assert.equal(eventosAntes.length, 3);

  await esperarErro(() => exp.expedirPedido(req(), resFake().res), 409, /Não há saldo suficiente/);

  // Nada parcial: venda, etapa, estoque, movimento, evento e financeiro.
  const venda = await s.get(RESOURCES.vendas, p.vendaId);
  assert.equal(String(venda!.status), 'aberta', 'a venda não fica faturada pela metade');
  assert.equal(await etapaDaVenda(p.vendaId), 'embalada', 'a etapa não avança para expedida');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), 4, 'o estoque não sofre alteração parcial');
  assert.equal((await movimentosDe(p.vendaId)).length, 0, 'nenhuma movimentação fantasma');
  const lanc = await query(`SELECT id FROM lancamentos_financeiros WHERE referencia_tipo = 'venda' AND referencia_id = $1`, [p.vendaId]);
  assert.equal(lanc.rows.length, 0, 'nenhum lançamento financeiro parcial');
  const eventosDepois = await eventosDe(p.vendaId);
  assert.deepEqual(eventosDepois.map((e) => e.etapa), ['separacao', 'conferida', 'embalada'], 'nenhum evento parcial da expedição que falhou');

  // E o mesmo pedido segue expedível quando o saldo aparece.
  await query(`UPDATE estoques SET quantidade = 12 WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3`, [t.empresaId, p.produtoId, p.tamanhoId]);
  const ok = await chamar(exp.expedirPedido, req());
  assert.equal(ok.etapa, 'expedida');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), 2, 'a baixa acontece uma única vez, na expedição que deu certo');
});

// ---------------------------------------------------------------------------
// 6) MULTIEMPRESA — B não opera a expedição de A
// ---------------------------------------------------------------------------

test('E4.2.3 multiempresa: empresa B não separa, confere, embala, expede, lê eventos nem resolve divergência de A (404)', async () => {
  const a = await novoTenant();
  const b = await novoTenant();
  const p = await pedidoParaExpedir(a, 2);
  const reqA = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: a.ator });
  const reqB = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: b.ator });

  await chamar(exp.separarPedido, reqA());
  const reprova = await esperarErro(() => exp.conferirPedido(reqDe({ codigos: [p.codigos[0]] }, { params: { id: p.vendaId }, user: a.ator }), resFake().res), 422);
  const divId = Number(reprova.fields.divergencia_id);
  await chamar(exp.conferirPedido, reqA({ codigos: p.codigos }));
  await chamar(exp.embalarPedido, reqA());
  const eventosAntes = await eventosDe(p.vendaId);

  // Empresa B: 404 em toda a máquina de expedição de A (não 403 — não vaza existência).
  await esperarErro(() => exp.separarPedido(reqB(), resFake().res), 404);
  await esperarErro(() => exp.conferirPedido(reqB({ codigos: p.codigos }), resFake().res), 404);
  await esperarErro(() => exp.embalarPedido(reqB(), resFake().res), 404);
  await esperarErro(() => exp.expedirPedido(reqB(), resFake().res), 404);
  await esperarErro(() => exp.situacaoExpedicao(reqB(), resFake().res), 404);
  await esperarErro(() => exp.resolverDivergencia(reqDe({ resolucao: 'Tentativa de B alterar divergência de A' }, { params: { id: divId }, user: b.ator }), resFake().res), 404);

  // A permanece íntegra e conclui o próprio fluxo.
  assert.equal(await etapaDaVenda(p.vendaId), 'embalada');
  const eventosDepois = await eventosDe(p.vendaId);
  assert.deepEqual(eventosDepois, eventosAntes, 'nenhum evento foi criado pelas tentativas de B');
  const div = await query(`SELECT resolvido_em FROM divergencias_conferencia WHERE id = $1 AND empresa_id = $2`, [divId, a.empresaId]);
  assert.equal(div.rows[0].resolvido_em, null, 'a divergência de A não foi alterada por B');
  const ok = await chamar(exp.expedirPedido, reqA());
  assert.equal(ok.etapa, 'expedida');
  // E B continua com a própria operação isolada: a venda de A não vaza na listagem de B.
  const situacaoB = await getStore().list(RESOURCES.vendas, { page: 1, pageSize: 50, filter: { empresa_id: b.empresaId } });
  assert.ok(!situacaoB.rows.some((v) => Number(v.id) === p.vendaId), 'a venda de A não aparece para B');
});

// ---------------------------------------------------------------------------
// 7) CONCORRÊNCIA — duas expedições simultâneas: uma baixa, um evento final
// ---------------------------------------------------------------------------

test('E4.2.3 concorrência: duas expedições simultâneas geram UMA baixa, UM evento final e saldo coerente', async () => {
  const t = await novoTenant();
  const p = await pedidoParaExpedir(t, 2, { saldo: 5 });
  const req = (body: Record<string, unknown> = {}) => reqDe(body, { params: { id: p.vendaId }, user: t.ator });
  await chamar(exp.separarPedido, req());
  await chamar(exp.conferirPedido, req({ codigos: p.codigos }));
  await chamar(exp.embalarPedido, req());

  const [r1, r2] = await Promise.allSettled([
    exp.expedirPedido(req(), resFake().res),
    exp.expedirPedido(req(), resFake().res),
  ]);
  const sucessos = [r1, r2].filter((r) => r.status === 'fulfilled').length;
  assert.equal(sucessos, 1, 'exatamente uma expedição vence a corrida');
  const perdedor = [r1, r2].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (perdedor) {
    const status = Number((perdedor.reason as any)?.status ?? (perdedor.reason as any)?.statusCode ?? 0);
    assert.equal(status, 409, `a tentativa perdedora deve ser recusada com 409 (veio ${status}: ${(perdedor.reason as any)?.message})`);
  }

  assert.equal(await etapaDaVenda(p.vendaId), 'expedida');
  assert.equal(await saldoDe(t, p.produtoId, p.tamanhoId), 3, 'saldo coerente: 5 − 2, nunca 5 − 4');
  assert.equal((await movimentosDe(p.vendaId)).length, 1, 'uma única baixa de estoque');
  const eventos = await eventosDe(p.vendaId);
  assert.equal(eventos.filter((e) => e.etapa === 'expedida').length, 1, 'um único evento final de expedição');
  const venda = await getStore().get(RESOURCES.vendas, p.vendaId);
  assert.equal(String(venda!.status), 'faturada', 'a venda fatura uma única vez');
});
