// ============================================================================
// MRP EVOLUÍDO / REPOSIÇÃO (migração 0107) contra Postgres REAL.
//
// O que só se prova aqui (o memdb não tem coluna NOT NULL nem CHECK de faixa):
//
//   • As colunas de reposição EXISTEM de verdade em `produtos`
//     (`estoque_seguranca`, `lote_minimo_compra`, `multiplo_compra`, `lead_time_dias`)
//     e nascem com o default NEUTRO (0/1/1/NULL) — a sugestão de hoje não muda.
//   • Os CHECKs recusam valor inválido (segurança negativa, múltiplo < 1).
//   • A sugestão (`sugerirQuantidade` + endpoint) respeita o PISO de reposição,
//     a CAIXA FECHADA (lote mínimo/múltiplo) e desconta empenho/bloqueio da
//     reserva CANÔNICA — sem duplicar a reserva de venda.
//   • Multiempresa: o cálculo é por empresa.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// O pool é singleton de módulo — não fechar aqui.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const SUFIXO = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function q<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import('../../src/db');
  return (await query(sql, params)).rows as T[];
}

async function cenario(tag: string) {
  const { migrate } = await import('../../src/db');
  await migrate();
  const { RESOURCES } = await import('../../src/resources');
  const { getStore } = await import('../../src/services');
  const compras = await import('../../src/compras');
  const s = getStore();
  seq++;
  const empresa = await s.insert(RESOURCES.empresas, { nome: `Empresa MRP ${tag} ${seq} ${SUFIXO}`, ativo: true });
  const empresaId = Number(empresa.id);
  const usuario = await s.insert(RESOURCES.usuarios, {
    nome: `Admin MRP ${tag} ${seq}`,
    email: `admin-mrp-${tag}-${seq}-${SUFIXO}@brobond.test`,
    perfil: 'admin',
    empresa_id: empresaId,
    ativo: true,
  });
  const local = await s.insert(RESOURCES.locais, { empresa_id: empresaId, nome: `Depósito ${tag} ${seq}`, ativo: true, padrao: true });
  const actor = { id: Number(usuario.id), name: String(usuario.nome), perfil: 'admin' as const, empresa_id: empresaId };
  return { s, compras, empresaId, actor, localId: Number(local.id), localNome: String(local.nome) };
}

test('PG 0107: as colunas de reposição existem com default NEUTRO', { skip }, async () => {
  const { migrate } = await import('../../src/db');
  await migrate();
  const cols = await q<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT table_name, column_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'produtos'
        AND column_name IN ('estoque_seguranca','lote_minimo_compra','multiplo_compra','lead_time_dias')
      ORDER BY column_name`
  );
  const mapa = new Map(cols.map((c) => [c.column_name, c]));
  for (const c of ['estoque_seguranca', 'lote_minimo_compra', 'multiplo_compra', 'lead_time_dias']) {
    assert.ok(mapa.has(c), `produtos.${c} existe`);
  }
  assert.equal(mapa.get('estoque_seguranca')!.column_default, '0', 'produtos.estoque_seguranca default 0');
  assert.equal(mapa.get('lote_minimo_compra')!.column_default, '1', 'produtos.lote_minimo_compra default 1');
  assert.equal(mapa.get('multiplo_compra')!.column_default, '1', 'produtos.multiplo_compra default 1');
  assert.equal(mapa.get('lead_time_dias')!.is_nullable, 'YES', 'produtos.lead_time_dias é nullable');
});

test('PG 0107: os CHECKs recusam segurança negativa e múltiplo < 1', { skip }, async () => {
  const ctx = await cenario('check');
  const { RESOURCES } = await import('../../src/resources');
  await assert.rejects(
    () => ctx.s.insert(RESOURCES.produtos, {
      empresa_id: ctx.empresaId, sku: `MRP-CHK-${SUFIXO}`, nome: 'Segurança negativa', preco_venda: 1, ativo: true, estoque_seguranca: -1,
    }),
    /estoque_seguranca|check|viola/i
  );
  await assert.rejects(
    () => ctx.s.insert(RESOURCES.produtos, {
      empresa_id: ctx.empresaId, sku: `MRP-CHK2-${SUFIXO}`, nome: 'Múltiplo zero', preco_venda: 1, ativo: true, multiplo_compra: 0,
    }),
    /multiplo|check|viola/i
  );
});

test('PG 0107: a sugestão aplica piso, caixa fechada e desconta empenho (multiempresa)', { skip }, async () => {
  const ctx = await cenario('sug');
  const { RESOURCES } = await import('../../src/resources');
  const { reqDe, resFake } = await import('../_p1util');

  const produto = await ctx.s.insert(RESOURCES.produtos, {
    empresa_id: ctx.empresaId,
    sku: `MRP-SUG-${SUFIXO}`,
    nome: 'Produto MRP',
    preco_venda: 100,
    custo: 40,
    ativo: true,
    estoque_min: 10,
    estoque_seguranca: 30,
    lote_minimo_compra: 6,
    multiplo_compra: 6,
    lead_time_dias: 7,
  });
  await ctx.s.insert(RESOURCES.estoques, {
    empresa_id: ctx.empresaId, produto_id: Number(produto.id), tamanho_id: null, local_id: ctx.localId, local: ctx.localNome, quantidade: 8, custo_medio: 40,
  });
  // Empenho (OP) de 10 peças — não é reserva de venda, então é descontado.
  await ctx.s.insert(RESOURCES.estoque_reservas, {
    empresa_id: ctx.empresaId, produto_id: Number(produto.id), tamanho_id: null, local_id: null, tipo: 'empenho', quantidade: 10, status: 'ativa',
  });

  const { res, saida } = resFake();
  await ctx.compras.sugestaoCompra(reqDe({}, { query: { dias: 90 }, user: ctx.actor as any }), res);
  const linha = (saida.json as any).itens.find((l: any) => Number(l.produto_id) === Number(produto.id));
  assert.ok(linha, 'o produto aparece na sugestão');
  assert.equal(linha.estoque_seguranca, 30);
  assert.equal(linha.multiplo_compra, 6);
  assert.equal(linha.lead_time_dias, 7);
  assert.equal(linha.em_comprometido, 10);
  // disponível projetado = 8 − 10 = −2 → piso 30 → bruto 32 → ceil(32/6)*6 = 36.
  assert.equal(linha.disponivel_projetado, -2);
  assert.equal(linha.sugerido_bruto, 32);
  assert.equal(linha.sugerido, 36);

  // OUTRA empresa não enxerga o produto de A.
  const outro = await cenario('sug-b');
  const { res: res2, saida: saida2 } = resFake();
  await outro.compras.sugestaoCompra(reqDe({}, { query: { dias: 90 }, user: outro.actor as any }), res2);
  assert.ok(!(saida2.json as any).itens.some((l: any) => Number(l.produto_id) === Number(produto.id)), 'empresa B não vê o produto de A');
});
