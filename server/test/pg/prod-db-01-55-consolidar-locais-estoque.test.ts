// ============================================================================
// PROD-CONSOLIDAR-LOCAIS-E1 — CONSOLIDAÇÃO DEFINITIVA DE LOCAIS DE ESTOQUE
// (ID 6 'loja' -> ID 3 'LOJA' em empresa_id = 1) + PARIDADE PDV / FATURAMENTO
//
// Exercita em PostgreSQL REAL + binário `psql` real o script administrativo
// `db/admin/007-consolidar-locais-estoque-empresa1.sql` e os handlers reais da
// aplicação (`pdv.buscarProduto`, `pdv.venderPdv`, `pdv.cancelarVendaPdv`,
// `estoqueGrade`, `estoqueDisponivel`, `searchProducts`, `createRecord`,
// `updateRecord`), cobrindo integralmente os 16 cenários obrigatórios + guardas
// de DRY-RUN, autorização tríplice, rollback fail-closed e idempotência:
//
//   1. Produto existente somente no local 6 -> transferido para local 3
//   2. Produto existente somente no local 3 -> preservado intacto no local 3
//   3. Produto existente nos dois locais -> somado em célula única no local 3
//   4. Mesma combinação produto+tamanho nos dois locais (grade completa)
//   5. Produto sem tamanho (tamanho_id IS NULL: só no 6 e colidindo em 3 + 6)
//   6. Variantes (produto pai + variações filhas P/M/G/GG/EG)
//   7. Estoque mínimo (GREATEST preservando o maior valor em min_3>min_6 e min_6>min_3)
//   8. Tenant isolation (empresa_id = 2 intacta em locais, linhas e somas)
//   9. Nenhuma perda de quantidade (cardinalidade exata de produção:
//      Local 3 = 59 linhas / 326 un. + Local 6 = 64 linhas / 525 un. = 851 un.)
//  10. Nenhuma duplicidade canônica nem de chave de texto
//  11. Histórico 100% preservado (movimentações, vendas faturadas, caixas fechados,
//      inventários fechados, OPs concluídas, compras recebidas, devoluções recebidas,
//      auditoria) + migração limpa das pendências operacionais abertas
//  12. ID 6 inativo após consolidação, ID 3 único ativo/padrão, bloqueio de recriação/reativação
//  13. Produto investigado CAM-BAS-PREM-PRET-"B" — COTTON "B" tamanho M:
//      antes Grade = 10 e PDV = 1 (Local 3 = 1, Local 6 = 9); depois célula única Local 3 = 10
//  14. PDV mostrando saldo consolidado 10 pela fonte canônica única
//  15. Venda no PDV baixando o saldo correto em Local 3 (10 -> 7)
//  16. Cancelamento restaurando o saldo correto em Local 3 (tanto venda nova quanto
//      venda histórica pré-consolidação cujo movimento imutável aponta para ID 6)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'pg/prod-db-01-55-consolidar-locais-estoque.test.ts exige DATABASE_URL e PostgreSQL real.'
  );
}

const SCRIPT_007 = fileURLToPath(
  new URL('../../../db/admin/007-consolidar-locais-estoque-empresa1.sql', import.meta.url)
);
const RUNNER_007 = fileURLToPath(
  new URL('../../../db/admin/run-007-e42.sh', import.meta.url)
);

function resolverPsql(): string | null {
  const candidatos = [process.env.PSQL_BIN, 'psql'].filter(Boolean) as string[];
  for (const bin of candidatos) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

const PSQL = resolverPsql();

const APPLY_FLAGS = [
  '-v',
  'apply=on',
  '-v',
  'confirmacao=PROD-CONSOLIDAR-LOCAIS-E1',
  '-v',
  'autorizacao=PROD-CONSOLIDAR-LOCAIS-E1',
];

function runConsolidacao(url: string, args: string[]) {
  const r = spawnSync(RUNNER_007, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: url,
      PSQL_BIN: PSQL!,
      PGPASSWORD: process.env.PGPASSWORD || 'brobond',
      ALLOW_WORKING_TREE: '1',
    },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? -1, stdout, stderr, out: `${stdout}\n${stderr}` };
}

function resFake() {
  const out: any = { corpo: null, statusCode: 200 };
  out.json = (corpo: unknown) => {
    out.corpo = corpo;
    return out;
  };
  out.status = (codigo: number) => {
    out.statusCode = codigo;
    return out;
  };
  return out;
}

async function chamar(handler: (req: any, res: any) => Promise<unknown>, req: any) {
  const res = resFake();
  await handler(req, res);
  return res.corpo;
}

async function erroDe(handler: (req: any, res: any) => Promise<unknown>, req: any): Promise<any> {
  try {
    await handler(req, resFake());
  } catch (e) {
    return e;
  }
  throw new Error('esperava erro, mas a operação passou');
}

test('PROD-CONSOLIDAR-LOCAIS-E1: consolidação definitiva ID 6 -> ID 3 (851 un.) + paridade canônica PDV/Venda/Cancelamento', async (t) => {
  if (!PSQL) {
    t.skip('binário psql indisponível; no CI ele é instalado (postgresql-client-16).');
    return;
  }

  // Cria banco isolado próprio para reproduzir EXATAMENTE empresa_id=1 com locais ID=3 ('LOJA') e ID=6 ('loja')
  // e os volumes reais de produção: Local 3 = 59 linhas / 326 un., Local 6 = 64 linhas / 525 un., Total = 851 un.
  const base = new URL(process.env.DATABASE_URL!);
  const scratch = `consolidar_e1_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const pgAdmin = new Client({ connectionString: process.env.DATABASE_URL });
  await pgAdmin.connect();
  await pgAdmin.query(`CREATE DATABASE ${scratch}`);

  const scratchUrlObj = new URL(base.toString());
  scratchUrlObj.pathname = `/${scratch}`;
  const scratchUrl = scratchUrlObj.toString();

  // Aponta o processo atual para o banco descartável isolado antes de carregar os módulos do servidor.
  process.env.DATABASE_URL = scratchUrl;
  process.env.NODE_ENV = 'test';

  let poolRef: { end: () => Promise<void> } | null = null;
  try {
    const { migrate, query, pool } = await import('../../src/db');
    poolRef = pool;
    await migrate();

    const { RESOURCES: R } = await import('../../src/resources');
    const { createRecord, updateRecord, escopoDe, getStore } = await import('../../src/services');
    const { searchProducts } = await import('../../src/productSearch');
    const pdv = await import('../../src/pdv');
    const { estoqueGrade, estoqueDisponivel } = await import('../../src/estoque');

    assert.ok(SCRIPT_007.endsWith('007-consolidar-locais-estoque-empresa1.sql'));
    const store = getStore();

    // Garante empresa_id = 1 e empresa_id = 2 (isolamento multi-tenant)
    await query(
      `INSERT INTO empresas (id, nome, razao_social, ativo)
       VALUES (1, 'BROBOND MATRIZ', 'BROBOND MATRIZ LTDA', true)
       ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, ativo = true`
    );
    await query(`SELECT setval('empresas_id_seq', GREATEST((SELECT max(id) FROM empresas), 2))`);
    const emp2Res = await query(
      `INSERT INTO empresas (nome, razao_social, ativo) VALUES ('FILIAL TENANT 2', 'FILIAL TENANT 2 LTDA', true) RETURNING id`
    );
    const empresa2Id = Number(emp2Res.rows[0].id);

    const admin = { id: 0, name: 'Admin Consolidação', perfil: 'admin' as const, empresa_id: 1, empresas: [1, empresa2Id] };
    const ator1 = { id: 0, name: 'Operador Loja 1', perfil: 'gerente' as const, empresa_id: 1, empresas: [1] };
    const escopo1 = escopoDe(ator1 as never);

    // Limpa eventuais locais iniciais em empresa_id = 1 e cria exatamente ID=3 ('LOJA') e ID=6 ('loja') ativos
    await query(`DELETE FROM estoques WHERE empresa_id = 1`);
    await query(`DELETE FROM locais WHERE empresa_id = 1`);
    await query(
      `INSERT INTO locais (id, empresa_id, nome, tipo, ativo, padrao)
       VALUES (3, 1, 'LOJA', 'loja', true, true),
              (6, 1, 'loja', 'loja', true, false)`
    );
    await query(`SELECT setval('locais_id_seq', GREATEST((SELECT max(id) FROM locais), 10))`);

    // Tenant 2 possui seus próprios locais (inclusive 'loja') e estoques que JAMAIS podem ser tocados
    const localTenant2 = Number(
      (
        await query(
          `INSERT INTO locais (empresa_id, nome, tipo, ativo, padrao)
           VALUES ($1, 'loja', 'loja', true, true) RETURNING id`,
          [empresa2Id]
        )
      ).rows[0].id
    );

    // Tamanhos P, M, G, GG, EG + Grade
    const tamanhos: Record<'P' | 'M' | 'G' | 'GG' | 'EG', number> = {} as any;
    for (const [idx, cod] of (['P', 'M', 'G', 'GG', 'EG'] as const).entries()) {
      const rTam = await createRecord(
        R.tamanhos,
        { codigo: `${cod}_CS`, nome: cod, ordem: idx + 1, ativo: true },
        admin as never
      );
      tamanhos[cod] = Number(rTam.id);
    }
    const categoriaId = Number(
      (await query(`INSERT INTO categorias (nome, ativo) VALUES ('Camisetas Premium', true) RETURNING id`)).rows[0].id
    );
    const grade = await createRecord(
      R.grades,
      { nome: 'Grade Adulto Consolidação', tamanhos: Object.values(tamanhos), ativo: true },
      admin as never
    );

    // =======================================================================
    // Montagem da massa EXATA de produção:
    //   Local 3 ('LOJA'): 59 linhas / sum(quantidade) = 326
    //   Local 6 ('loja'): 64 linhas / sum(quantidade) = 525
    //   Total físico    : 123 linhas antes -> 100 células únicas depois / 851 un.
    //   (36 exclusivas Local 3 + 23 em colisão nos dois locais + 41 exclusivas Local 6:
    //    36 + 23 = 59 linhas no Local 3; 23 + 41 = 64 linhas no Local 6!)
    // =======================================================================

    // 1) Produto real investigado: CAM-BAS-PREM-PRET-"B" — COTTON "B" (pai + 5 variações P..EG)
    const cottonPai = await createRecord(
      R.produtos,
      {
        sku: 'CAM-BAS-PREM-PRET-"B"',
        nome: 'COTTON "B"',
        categoria_id: categoriaId,
        grade_id: Number(grade.id),
        formato: 'variacao',
        preco_venda: 129.9,
        ativo: true,
      },
      ator1 as never
    );
    const cottonPaiId = Number(cottonPai.id);
    const cottonVariacoes: Record<'P' | 'M' | 'G' | 'GG' | 'EG', any> = {} as any;
    for (const cod of ['P', 'M', 'G', 'GG', 'EG'] as const) {
      const v = await createRecord(
        R.produtos,
        {
          sku: `CAM-BAS-PREM-PRET-"B"-${cod}`,
          nome: `COTTON "B" ${cod}`,
          categoria_id: categoriaId,
          grade_id: Number(grade.id),
          formato: 'variacao',
          preco_venda: 129.9,
          ativo: true,
        },
        ator1 as never
      );
      cottonVariacoes[cod] = await store.update(R.produtos, Number(v.id), {
        produto_pai_id: cottonPaiId,
        variacao_chave: `TAM:${cod}`,
        variacao_tamanho_id: tamanhos[cod],
      });
    }

    // Células especiais nomeadas para validar cada caso individualmente:
    // - Caso investigado (colisão #1): COTTON "B" tam M -> Local 3 = 1 (min 8), Local 6 = 9 (min 3) => final 10 (min 8)
    // - Colisão #2 (mesmo produto, outro tamanho P): Local 3 = 4 (min 2), Local 6 = 6 (min 15) => final 10 (min 15)
    // - Colisão #3 (produto SEM tamanho, tamanho_id = NULL): Local 3 = 3 (min 5), Local 6 = 7 (min 11) => final 10 (min 11)
    // - Exclusivo Local 3 #1: COTTON "B" tam G -> Local 3 = 5 (min 4)
    // - Exclusivo Local 6 #1: COTTON "B" tam GG -> Local 6 = 8 (min 6)
    // - Exclusivo Local 6 #2 (produto SEM tamanho): Local 6 = 12 (min 3)
    const prodSemTamColisao = await createRecord(
      R.produtos,
      { sku: 'ACESS-BON-UNICO-COL', nome: 'Boné Sem Tamanho Colisão', categoria_id: categoriaId, preco_venda: 79.9, ativo: true },
      ator1 as never
    );
    const prodSemTamSo6 = await createRecord(
      R.produtos,
      { sku: 'ACESS-BAG-UNICO-SO6', nome: 'Ecobag Sem Tamanho Só Local 6', categoria_id: categoriaId, preco_venda: 49.9, ativo: true },
      ator1 as never
    );
    const prodSo3 = await createRecord(
      R.produtos,
      { sku: 'CAM-SO-LOCAL-3', nome: 'Camiseta Exclusiva Local 3', categoria_id: categoriaId, grade_id: Number(grade.id), preco_venda: 89.9, ativo: true },
      ator1 as never
    );
    const prodSo6 = await createRecord(
      R.produtos,
      { sku: 'CAM-SO-LOCAL-6', nome: 'Camiseta Exclusiva Local 6', categoria_id: categoriaId, grade_id: Number(grade.id), preco_venda: 99.9, ativo: true },
      ator1 as never
    );

    const inserirEstoque = (
      empresaId: number,
      produtoId: number,
      tamanhoId: number | null,
      localId: number,
      localNome: string,
      quantidade: number,
      estoqueMin = 0
    ) =>
      query(
        `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local_id, local, quantidade, estoque_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [empresaId, produtoId, tamanhoId, localId, localNome, quantidade, estoqueMin]
      );

    // --- 23 pares em COLISÃO (existem em Local 3 E em Local 6) ---
    // Soma planejada das 23 linhas em Local 3 = 110; soma das 23 linhas em Local 6 = 195
    // Fixos (3 pares): Local 3 = 1 + 4 + 3 = 8 | Local 6 = 9 + 6 + 7 = 22
    await inserirEstoque(1, cottonPaiId, tamanhos.M, 3, 'LOJA', 1, 8);
    await inserirEstoque(1, cottonPaiId, tamanhos.M, 6, 'loja', 9, 3);

    await inserirEstoque(1, cottonPaiId, tamanhos.P, 3, 'LOJA', 4, 2);
    await inserirEstoque(1, cottonPaiId, tamanhos.P, 6, 'loja', 6, 15);

    await inserirEstoque(1, Number(prodSemTamColisao.id), null, 3, 'LOJA', 3, 5);
    await inserirEstoque(1, Number(prodSemTamColisao.id), null, 6, 'loja', 7, 11);

    // Mais 20 pares em colisão:
    // Local 3 precisa de 110 - 8 = 102 em 20 linhas (18 * 5 + 2 * 6 = 102)
    // Local 6 precisa de 195 - 22 = 173 em 20 linhas (7 * 9 + 11 * 8 + 2 * 11 = 63 + 88 + 22 = 173)
    for (let i = 0; i < 20; i++) {
      const p = await createRecord(
        R.produtos,
        { sku: `COL-PAR-${i + 1}`, nome: `Produto Colisão ${i + 1}`, categoria_id: categoriaId, grade_id: Number(grade.id), preco_venda: 100, ativo: true },
        ator1 as never
      );
      const q3 = i < 18 ? 5 : 6;
      const q6 = i < 7 ? 9 : i < 18 ? 8 : 11;
      await inserirEstoque(1, Number(p.id), tamanhos.M, 3, 'LOJA', q3, i % 2 === 0 ? 4 : 1);
      await inserirEstoque(1, Number(p.id), tamanhos.M, 6, 'loja', q6, i % 2 === 0 ? 2 : 7);
    }

    // --- 36 linhas EXCLUSIVAS do Local 3 (soma = 326 - 110 = 216) ---
    // Fixas (2 linhas): COTTON "B" G = 5 + prodSo3 M = 7 (12 un.) -> faltam 34 linhas somando 204 (34 * 6 = 204)
    await inserirEstoque(1, cottonPaiId, tamanhos.G, 3, 'LOJA', 5, 4);
    await inserirEstoque(1, Number(prodSo3.id), tamanhos.M, 3, 'LOJA', 7, 3);
    for (let i = 0; i < 34; i++) {
      const p = await createRecord(
        R.produtos,
        { sku: `EX3-PROD-${i + 1}`, nome: `Produto Só Local 3 ${i + 1}`, categoria_id: categoriaId, grade_id: Number(grade.id), preco_venda: 100, ativo: true },
        ator1 as never
      );
      await inserirEstoque(1, Number(p.id), tamanhos.G, 3, 'LOJA', 6, 2);
    }

    // --- 41 linhas EXCLUSIVAS do Local 6 (soma = 525 - 195 = 330) ---
    // Fixas (3 linhas): COTTON "B" GG = 8 + prodSemTamSo6 = 12 + prodSo6 M = 10 (30 un.)
    // Faltam 38 linhas somando 300 (34 * 8 + 4 * 7 = 272 + 28 = 300)
    await inserirEstoque(1, cottonPaiId, tamanhos.GG, 6, 'loja', 8, 6);
    await inserirEstoque(1, Number(prodSemTamSo6.id), null, 6, 'loja', 12, 3);
    await inserirEstoque(1, Number(prodSo6.id), tamanhos.M, 6, 'loja', 10, 5);
    for (let i = 0; i < 38; i++) {
      const p = await createRecord(
        R.produtos,
        { sku: `EX6-PROD-${i + 1}`, nome: `Produto Só Local 6 ${i + 1}`, categoria_id: categoriaId, grade_id: Number(grade.id), preco_venda: 100, ativo: true },
        ator1 as never
      );
      const q6 = i < 34 ? 8 : 7;
      await inserirEstoque(1, Number(p.id), tamanhos.EG, 6, 'loja', q6, 2);
    }

    // Estoque isolado em empresa_id = 2 (deve permanecer 100% intocado)
    const prodTenant2 = Number(
      (
        await query(
          `INSERT INTO produtos (empresa_id, sku, nome, preco_venda, ativo)
           VALUES ($1, 'SKU-TENANT-2', 'Produto Outra Empresa', 150, true) RETURNING id`,
          [empresa2Id]
        )
      ).rows[0].id
    );
    await inserirEstoque(empresa2Id, prodTenant2, tamanhos.M, localTenant2, 'loja', 77, 10);

    // =======================================================================
    // Montagem de referências HISTÓRICAS (imutáveis) vs OPERACIONAIS ABERTAS
    // =======================================================================
    const clienteId = Number(
      (await query(`INSERT INTO clientes (empresa_id, nome) VALUES (1, 'Cliente Teste') RETURNING id`)).rows[0].id
    );
    const fornecedorId = Number(
      (await query(`INSERT INTO fornecedores (empresa_id, nome) VALUES (1, 'Fornecedor Teste') RETURNING id`)).rows[0].id
    );

    // Venda histórica já faturada no local 6 + saída histórica imutável no local 6 (será cancelada no teste #16!)
    const vendaHistId = Number(
      (
        await query(
          `INSERT INTO vendas (empresa_id, cliente_id, status, data, total, local_saida_id, local_saida, faturada_em)
           VALUES (1, $1, 'faturada', CURRENT_DATE, 259.80, 6, 'loja', now()) RETURNING id`,
          [clienteId]
        )
      ).rows[0].id
    );
    await query(
      `INSERT INTO itens_venda (empresa_id, venda_id, produto_id, tamanho_id, quantidade, preco_unitario, subtotal)
       VALUES (1, $1, $2, $3, 2, 129.90, 259.80)`,
      [vendaHistId, cottonPaiId, tamanhos.M]
    );
    const movHistSaidaId = Number(
      (
        await query(
          `INSERT INTO movimentacoes (empresa_id, tipo, produto_id, tamanho_id, local_id, local, quantidade, venda_id, motivo)
           VALUES (1, 'saida', $1, $2, 6, 'loja', 2, $3, $4) RETURNING id`,
          [cottonPaiId, tamanhos.M, vendaHistId, `Venda #${vendaHistId}`]
        )
      ).rows[0].id
    );

    // Venda em ABERTO apontando para local 6 (deve migrar para ID 3 'LOJA')
    const vendaAbertaId = Number(
      (
        await query(
          `INSERT INTO vendas (empresa_id, cliente_id, status, data, total, local_saida_id, local_saida)
           VALUES (1, $1, 'aberta', CURRENT_DATE, 129.90, 6, 'loja') RETURNING id`,
          [clienteId]
        )
      ).rows[0].id
    );

    // Caixa FECHADO histórico no local 6 (imutável) vs Caixa ABERTO no local 6 (deve migrar para ID 3 'LOJA')
    const caixaFechadoHistId = Number(
      (
        await query(
          `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, local_id, local, abertura_em, fechamento_em)
           VALUES (1, 'CX-HIST-6', 'fechado', 0, 6, 'loja', now() - interval '2 days', now() - interval '1 day') RETURNING id`
        )
      ).rows[0].id
    );
    const caixaAbertoOpId = Number(
      (
        await query(
          `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, local_id, local, abertura_em)
           VALUES (1, 'CX-PRINCIPAL', 'aberto', 100, 3, 'LOJA', now()) RETURNING id`
        )
      ).rows[0].id
    );
    const caixaSecundarioOpId = Number(
      (
        await query(
          `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, local_id, local, abertura_em)
           VALUES (1, 'CX-BALCAO-2', 'aberto', 50, 6, 'loja', now()) RETURNING id`
        )
      ).rows[0].id
    );

    // Inventário FECHADO histórico no local 6 (imutável)
    const invFechadoHistId = Number(
      (
        await query(
          `INSERT INTO inventarios (empresa_id, status, local_id, local)
           VALUES (1, 'fechado', 6, 'loja') RETURNING id`
        )
      ).rows[0].id
    );

    // OP concluída histórica (imutável) vs OP aberta operacional (migra para ID 3)
    const opHistId = Number(
      (
        await query(
          `INSERT INTO ordens_fabricacao (empresa_id, produto_id, quantidade, status, local_producao_id)
           VALUES (1, $1, 10, 'concluida', 6) RETURNING id`,
          [cottonPaiId]
        )
      ).rows[0].id
    );
    const opAbertaId = Number(
      (
        await query(
          `INSERT INTO ordens_fabricacao (empresa_id, produto_id, quantidade, status, local_producao_id)
           VALUES (1, $1, 10, 'planejada', 6) RETURNING id`,
          [cottonPaiId]
        )
      ).rows[0].id
    );

    // Compra recebida histórica (imutável) vs Compra pendente operacional (migra 'loja' -> 'LOJA')
    const compraHistId = Number(
      (
        await query(
          `INSERT INTO compras (empresa_id, fornecedor_id, status, total, local_entrada)
           VALUES (1, $1, 'recebido', 500, 'loja') RETURNING id`,
          [fornecedorId]
        )
      ).rows[0].id
    );
    const compraAbertaId = Number(
      (
        await query(
          `INSERT INTO compras (empresa_id, fornecedor_id, status, total, local_entrada)
           VALUES (1, $1, 'pendente', 300, 'loja') RETURNING id`,
          [fornecedorId]
        )
      ).rows[0].id
    );

    // Devolução recebida histórica (imutável) vs Devolução autorizada operacional (migra 'loja' -> 'LOJA')
    const devHistId = Number(
      (
        await query(
          `INSERT INTO devolucoes (empresa_id, venda_id, tipo, status, motivo, local_entrada, autorizada_em)
           VALUES (1, $1, 'devolucao', 'recebida', 'Troca histórica concluída', 'loja', now()) RETURNING id`,
          [vendaHistId]
        )
      ).rows[0].id
    );
    const devAbertaId = Number(
      (
        await query(
          `INSERT INTO devolucoes (empresa_id, venda_id, tipo, status, motivo, local_entrada, autorizada_em)
           VALUES (1, $1, 'devolucao', 'autorizada', 'Devolução em aberto', 'loja', now()) RETURNING id`,
          [vendaHistId]
        )
      ).rows[0].id
    );

    // =======================================================================
    // PRÉ-PROVA DO DEFEITO REAL DE PRODUÇÃO ANTES DA CONSOLIDAÇÃO
    // =======================================================================
    await t.test('Pré-condição real de produção: Local 3 = 59 linhas / 326 un., Local 6 = 64 linhas / 525 un. (total 851); Grade M = 10 × PDV M = 1', async () => {
      const r3 = await query(`SELECT count(*)::int AS n, sum(quantidade)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 3`);
      const r6 = await query(`SELECT count(*)::int AS n, sum(quantidade)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 6`);
      assert.deepEqual({ n: r3.rows[0].n, q: r3.rows[0].q }, { n: 59, q: 326 });
      assert.deepEqual({ n: r6.rows[0].n, q: r6.rows[0].q }, { n: 64, q: 525 });
      assert.equal(r3.rows[0].q + r6.rows[0].q, 851);

      const gradeAntes = await chamar(estoqueGrade, { user: ator1, query: { categoria_id: String(categoriaId) }, params: {}, body: {} });
      const linhaCotton = gradeAntes.linhas.find((l: any) => l.produto.sku === 'CAM-BAS-PREM-PRET-"B"');
      const qtdGradeM = linhaCotton.celulas.find((c: any) => Number(c.tamanho_id) === tamanhos.M).quantidade;
      assert.equal(qtdGradeM, 10, 'Grade somava Local 3 (1) + Local 6 (9) = 10');

      const pdvAntes = await chamar(pdv.buscarProduto, {
        user: ator1,
        query: { codigo: cottonVariacoes.M.sku, local_id: '3' },
        params: {},
        body: {},
      });
      assert.equal(pdvAntes.disponivel_no_tamanho, 1, 'PDV enxergava apenas 1 unidade no Local 3 antes da consolidação');
      assert.equal(pdvAntes.estoque_fisico_no_tamanho, 10);
    });

    // =======================================================================
    // SEGURANÇA DO PROCEDIMENTO: DRY-RUN, FALTA DE CONFIRMAÇÃO E ROLLBACK EM ERRO
    // =======================================================================
    await t.test('Procedimento seguro: DRY-RUN simula tudo e faz ROLLBACK; APPLY sem confirmação recusa; inventário aberto faz ROLLBACK fail-closed', async () => {
      // 1) DRY-RUN padrão (sem flags): exit 0 e NENHUMA alteração persistida
      const dryRun = runConsolidacao(scratchUrl, []);
      assert.equal(dryRun.code, 0, `DRY-RUN falhou:\n${dryRun.out}`);
      assert.match(dryRun.out, /DRY-RUN: validação ANTES \+ simulação completa \+ validação DEPOIS aprovadas; transação revertida \(ROLLBACK\)/);
      assert.match(dryRun.out, /SOMA ANTES=851 SOMA DEPOIS=851 \(DIFERENÇA=0\)/);

      const aposDryRun3 = await query(`SELECT count(*)::int AS n, sum(quantidade)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 3`);
      const aposDryRun6 = await query(`SELECT count(*)::int AS n, sum(quantidade)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 6`);
      assert.deepEqual({ n: aposDryRun3.rows[0].n, q: aposDryRun3.rows[0].q }, { n: 59, q: 326 }, 'DRY-RUN não alterou Local 3');
      assert.deepEqual({ n: aposDryRun6.rows[0].n, q: aposDryRun6.rows[0].q }, { n: 64, q: 525 }, 'DRY-RUN não alterou Local 6');

      // 2) APPLY sem tríplice autorização -> aborta com exit != 0 e zero escrita
      const semConfirmacao = runConsolidacao(scratchUrl, ['-v', 'apply=on']);
      assert.notEqual(semConfirmacao.code, 0);
      assert.match(semConfirmacao.out, /APPLY RECUSADO/);

      // 3) Guarda fail-closed: inventário ABERTO em local 6 aborta APPLY com ROLLBACK integral
      const invAbertoId = Number(
        (await query(`INSERT INTO inventarios (empresa_id, status, local_id, local) VALUES (1, 'aberto', 6, 'loja') RETURNING id`)).rows[0].id
      );
      try {
        const bloqueado = runConsolidacao(scratchUrl, APPLY_FLAGS);
        assert.notEqual(bloqueado.code, 0, 'inventário aberto precisa abortar a consolidação');
        assert.match(bloqueado.out, /inventário\(s\) ABERTO\(S\)/);
        const check6 = await query(`SELECT sum(quantidade)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 6`);
        assert.equal(check6.rows[0].q, 525, 'ROLLBACK integral preservou 100% dos dados');
      } finally {
        await query(`DELETE FROM inventarios WHERE id = $1`, [invAbertoId]);
      }
    });

    // =======================================================================
    // EXECUÇÃO REAL DO APPLY + PROVA DOS 16 CENÁRIOS OBRIGATÓRIOS
    // =======================================================================
    const movsAntesCount = Number((await query(`SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id = 1`)).rows[0].n);
    const auditAntesCount = Number((await query(`SELECT count(*)::int AS n FROM auditoria`)).rows[0].n);

    const applyRes = runConsolidacao(scratchUrl, APPLY_FLAGS);
    assert.equal(applyRes.code, 0, `APPLY falhou:\n${applyRes.out}`);
    assert.match(applyRes.out, /APPLY: transação COMITADA com sucesso/);

    await t.test('Cenários 1 a 10: todos os casos de consolidação, sem tamanho, variantes, estoque_min, tenant isolation, soma exata 851 e zero duplicidade', async () => {
      // (1) Produto existente SOMENTE no local 6 -> transferido para local 3
      const rSo6 = await query(
        `SELECT local_id, local, quantidade, estoque_min FROM estoques WHERE empresa_id = 1 AND produto_id = $1`,
        [Number(prodSo6.id)]
      );
      assert.equal(rSo6.rows.length, 1);
      assert.deepEqual(rSo6.rows[0], { local_id: 3, local: 'LOJA', quantidade: 10, estoque_min: 5 });

      // (2) Produto existente SOMENTE no local 3 -> preservado intacto no local 3
      const rSo3 = await query(
        `SELECT local_id, local, quantidade, estoque_min FROM estoques WHERE empresa_id = 1 AND produto_id = $1`,
        [Number(prodSo3.id)]
      );
      assert.equal(rSo3.rows.length, 1);
      assert.deepEqual(rSo3.rows[0], { local_id: 3, local: 'LOJA', quantidade: 7, estoque_min: 3 });

      // (3) e (4) Produto existente nos dois locais / mesma combinação produto+tamanho + outros tamanhos distintos
      const rCotton = await query(
        `SELECT tamanho_id, local_id, local, quantidade, estoque_min
           FROM estoques
          WHERE empresa_id = 1 AND produto_id = $1
          ORDER BY tamanho_id ASC`,
        [cottonPaiId]
      );
      assert.deepEqual(rCotton.rows, [
        { tamanho_id: tamanhos.P, local_id: 3, local: 'LOJA', quantidade: 10, estoque_min: 15 }, // 4 + 6 = 10, max(2, 15) = 15
        { tamanho_id: tamanhos.M, local_id: 3, local: 'LOJA', quantidade: 10, estoque_min: 8 },  // 1 + 9 = 10, max(8, 3) = 8
        { tamanho_id: tamanhos.G, local_id: 3, local: 'LOJA', quantidade: 5, estoque_min: 4 },   // exclusivo local 3
        { tamanho_id: tamanhos.GG, local_id: 3, local: 'LOJA', quantidade: 8, estoque_min: 6 },  // migrado do local 6
      ]);

      // (5) Produto SEM tamanho (tamanho_id IS NULL): tanto exclusivo no local 6 quanto colidindo em 3 + 6
      const rSemTamCol = await query(
        `SELECT tamanho_id, local_id, local, quantidade, estoque_min FROM estoques WHERE empresa_id = 1 AND produto_id = $1`,
        [Number(prodSemTamColisao.id)]
      );
      assert.equal(rSemTamCol.rows.length, 1);
      assert.deepEqual(rSemTamCol.rows[0], { tamanho_id: null, local_id: 3, local: 'LOJA', quantidade: 10, estoque_min: 11 });

      const rSemTam6 = await query(
        `SELECT tamanho_id, local_id, local, quantidade, estoque_min FROM estoques WHERE empresa_id = 1 AND produto_id = $1`,
        [Number(prodSemTamSo6.id)]
      );
      assert.equal(rSemTam6.rows.length, 1);
      assert.deepEqual(rSemTam6.rows[0], { tamanho_id: null, local_id: 3, local: 'LOJA', quantidade: 12, estoque_min: 3 });

      // (6) Variantes preservadas e busca inteligente enxergando 100% do saldo consolidado do pai (33 un.: P=10, M=10, G=5, GG=8)
      const busca = await searchProducts(escopo1, { q: 'COTTON "B"', pageSize: 20 });
      const familia = busca.rows.find((row) => row.id === cottonPaiId)!;
      assert.equal(familia.estoque_disponivel, 33);
      assert.equal(familia.variacoes.find((v) => v.id === Number(cottonVariacoes.M.id))!.tamanhos[0].quantidade, 10);

      // (7) Estoque mínimo preservou sempre o maior valor (GREATEST)
      assert.equal(rCotton.rows[0].estoque_min, 15, 'min_6 (15) > min_3 (2) => 15');
      assert.equal(rCotton.rows[1].estoque_min, 8, 'min_3 (8) > min_6 (3) => 8');

      // (8) Tenant isolation: empresa_id = 2 intacta
      const rTenant2 = await query(
        `SELECT local_id, local, quantidade, estoque_min FROM estoques WHERE empresa_id = $1`,
        [empresa2Id]
      );
      assert.deepEqual(rTenant2.rows, [{ local_id: localTenant2, local: 'loja', quantidade: 77, estoque_min: 10 }]);

      // (9) Nenhuma perda de quantidade: 326 + 525 = 851 unidades exatas em 100 células no Local 3 e 0 no Local 6
      const pos3 = await query(`SELECT count(*)::int AS n, coalesce(sum(quantidade), 0)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 3`);
      const pos6 = await query(`SELECT count(*)::int AS n, coalesce(sum(quantidade), 0)::int AS q FROM estoques WHERE empresa_id = 1 AND local_id = 6`);
      assert.deepEqual({ n: pos3.rows[0].n, q: pos3.rows[0].q }, { n: 100, q: 851 });
      assert.deepEqual({ n: pos6.rows[0].n, q: pos6.rows[0].q }, { n: 0, q: 0 });

      // (10) Nenhuma duplicidade canônica nem por texto, nenhuma quantidade negativa
      const dupCanon = await query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM estoques GROUP BY empresa_id, produto_id, tamanho_id, local_id HAVING count(*) > 1
         ) d`
      );
      const dupTexto = await query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM estoques GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
         ) d`
      );
      const neg = await query(`SELECT count(*)::int AS n FROM estoques WHERE quantidade < 0 OR estoque_min < 0`);
      assert.equal(dupCanon.rows[0].n, 0);
      assert.equal(dupTexto.rows[0].n, 0);
      assert.equal(neg.rows[0].n, 0);
    });

    await t.test('Cenários 11 e 12: histórico 100% preservado, pendências abertas migradas, ID 6 inativo, ID 3 único ativo e idempotência', async () => {
      // (11) Histórico imutável intocado
      const movsDepoisCount = Number((await query(`SELECT count(*)::int AS n FROM movimentacoes WHERE empresa_id = 1`)).rows[0].n);
      const auditDepoisCount = Number((await query(`SELECT count(*)::int AS n FROM auditoria`)).rows[0].n);
      assert.equal(movsDepoisCount, movsAntesCount, 'nenhuma movimentação apagada nem criada');
      assert.equal(auditDepoisCount, auditAntesCount, 'nenhum registro de auditoria apagado');

      const movHist = (await query(`SELECT local_id, local, quantidade FROM movimentacoes WHERE id = $1`, [movHistSaidaId])).rows[0];
      assert.deepEqual(movHist, { local_id: 6, local: 'loja', quantidade: 2 });

      assert.equal((await query(`SELECT local_saida_id FROM vendas WHERE id = $1`, [vendaHistId])).rows[0].local_saida_id, 6, 'venda faturada histórica preservada');
      assert.equal((await query(`SELECT local_id FROM pdv_caixas WHERE id = $1`, [caixaFechadoHistId])).rows[0].local_id, 6, 'caixa fechado histórico preservado');
      assert.equal((await query(`SELECT local_id FROM inventarios WHERE id = $1`, [invFechadoHistId])).rows[0].local_id, 6, 'inventário fechado histórico preservado');
      assert.equal((await query(`SELECT local_producao_id FROM ordens_fabricacao WHERE id = $1`, [opHistId])).rows[0].local_producao_id, 6, 'OP concluída histórica preservada');
      assert.equal((await query(`SELECT local_entrada FROM compras WHERE id = $1`, [compraHistId])).rows[0].local_entrada, 'loja', 'compra recebida histórica preservada');
      assert.equal((await query(`SELECT local_entrada FROM devolucoes WHERE id = $1`, [devHistId])).rows[0].local_entrada, 'loja', 'devolução recebida histórica preservada');

      // Referências operacionais abertas migradas para ID 3 ('LOJA')
      assert.deepEqual(
        (await query(`SELECT local_saida_id, local_saida FROM vendas WHERE id = $1`, [vendaAbertaId])).rows[0],
        { local_saida_id: 3, local_saida: 'LOJA' }
      );
      assert.deepEqual(
        (await query(`SELECT local_id, local FROM pdv_caixas WHERE id = $1`, [caixaSecundarioOpId])).rows[0],
        { local_id: 3, local: 'LOJA' }
      );
      assert.equal((await query(`SELECT local_producao_id FROM ordens_fabricacao WHERE id = $1`, [opAbertaId])).rows[0].local_producao_id, 3);
      assert.equal((await query(`SELECT local_entrada FROM compras WHERE id = $1`, [compraAbertaId])).rows[0].local_entrada, 'LOJA');
      assert.equal((await query(`SELECT local_entrada FROM devolucoes WHERE id = $1`, [devAbertaId])).rows[0].local_entrada, 'LOJA');

      // (12) ID 3 único ativo e padrão; ID 6 preservado como inativo; bloqueia recriar/reativar homônimo
      const locaisEmp1 = (
        await query(`SELECT id, nome, ativo, padrao FROM locais WHERE empresa_id = 1 ORDER BY id ASC`)
      ).rows;
      assert.deepEqual(locaisEmp1, [
        { id: 3, nome: 'LOJA', ativo: true, padrao: true },
        { id: 6, nome: 'loja', ativo: false, padrao: false },
      ]);

      await assert.rejects(
        () => createRecord(R.locais, { nome: 'loja', tipo: 'loja', ativo: true }, admin as never),
        (err: any) => err?.status === 409
      );
      await assert.rejects(
        () => updateRecord(R.locais, 6, { ativo: true }, admin as never),
        (err: any) => err?.status === 409
      );

      // Reexecução de APPLY é 100% idempotente (0 linhas alteradas)
      const applyIdempotente = runConsolidacao(scratchUrl, APPLY_FLAGS);
      assert.equal(applyIdempotente.code, 0, applyIdempotente.out);
      assert.match(applyIdempotente.out, /IDEMPOTENTE: consolidação já aplicada anteriormente \(0 linhas a alterar\)/);
    });

    await t.test('Cenários 13, 14, 15 e 16: CAM-BAS-PREM-PRET-"B" tam M = 10 no PDV, venda baixa Local 3 (10->7), cancelamento restaura Local 3 (inclusive venda histórica do ID 6)', async () => {
      // (13) e (14) Paridade total Grade = Disponível = PDV = 10 em uma única célula no Local 3
      const disp = await chamar(estoqueDisponivel, {
        user: ator1,
        query: { produto_id: String(cottonPaiId), tamanho_id: String(tamanhos.M) },
        params: {},
        body: {},
      });
      assert.equal(disp.local_id, 3);
      assert.equal(disp.local, 'LOJA');
      assert.equal(disp.quantidade, 10);
      assert.equal(disp.estoque_fisico, 10);
      assert.equal(disp.outros_locais, 0);

      for (const localQuery of [undefined, '3', '6']) {
        const pdvDepois = await chamar(pdv.buscarProduto, {
          user: ator1,
          query: {
            codigo: cottonVariacoes.M.sku,
            ...(localQuery ? { local_id: localQuery } : {}),
          },
          params: {},
          body: {},
        });
        assert.equal(pdvDepois.disponivel_no_tamanho, 10, `PDV deve mostrar 10 (local_id=${localQuery ?? 'omitido'})`);
        assert.equal(pdvDepois.estoque_fisico_no_tamanho, 10);
        assert.equal(pdvDepois.local_id, 3);
        assert.equal(pdvDepois.local, 'LOJA');
      }

      // (15) Venda no PDV de 3 unidades baixa exatamente Local 3: 10 -> 7
      const vendaNova = await chamar(pdv.venderPdv, {
        user: ator1,
        params: {},
        query: {},
        body: {
          caixa_id: caixaAbertoOpId,
          itens: [{ produto_id: cottonPaiId, tamanho_id: tamanhos.M, quantidade: 3, desconto_pct: 0 }],
          pagamentos: [{ forma: 'pix', valor: 389.7 }],
        },
      });
      const saldoAposVenda = (
        await query(`SELECT quantidade::int AS q FROM estoques WHERE empresa_id = 1 AND produto_id = $1 AND tamanho_id = $2 AND local_id = 3`, [
          cottonPaiId,
          tamanhos.M,
        ])
      ).rows[0].q;
      assert.equal(saldoAposVenda, 7, 'venda de 3 un. baixou Local 3 de 10 para 7');

      // (16.a) Cancelar a venda pós-consolidação restaura Local 3: 7 -> 10
      await chamar(pdv.cancelarVendaPdv, {
        user: ator1,
        params: { id: String(vendaNova.venda_id) },
        query: {},
        body: { motivo: 'Teste de cancelamento pós-consolidação' },
      });
      const saldoAposCancelNova = (
        await query(`SELECT quantidade::int AS q FROM estoques WHERE empresa_id = 1 AND produto_id = $1 AND tamanho_id = $2 AND local_id = 3`, [
          cottonPaiId,
          tamanhos.M,
        ])
      ).rows[0].q;
      assert.equal(saldoAposCancelNova, 10, 'cancelamento restaurou Local 3 de 7 para 10');

      // (16.b) Cancelar venda HISTÓRICA pré-consolidação (cujo movimento imutável aponta para local_id = 6 inativo)
      //        restaura +2 un. diretamente no Local 3 ativo (10 -> 12) sem erro 409 e sem recriar linha no Local 6!
      await query(`DELETE FROM devolucoes WHERE venda_id = $1`, [vendaHistId]);
      await updateRecord(R.vendas, vendaHistId, { status: 'cancelada' }, ator1 as never);

      const saldoAposCancelHist = (
        await query(`SELECT quantidade::int AS q FROM estoques WHERE empresa_id = 1 AND produto_id = $1 AND tamanho_id = $2 AND local_id = 3`, [
          cottonPaiId,
          tamanhos.M,
        ])
      ).rows[0].q;
      const linhasLocal6 = Number(
        (await query(`SELECT count(*)::int AS n FROM estoques WHERE empresa_id = 1 AND local_id = 6`)).rows[0].n
      );
      assert.equal(saldoAposCancelHist, 12, 'estorno de venda histórica pré-consolidação entrou no Local 3 ativo');
      assert.equal(linhasLocal6, 0, 'Local 6 permaneceu com zero células de estoque');

      // Tentar vender no caixa informando local_saida_id = 999999 (inexistente) continua retornando 404
      const erroInexistente = await erroDe(pdv.venderPdv, {
        user: ator1,
        params: {},
        query: {},
        body: {
          caixa_id: caixaAbertoOpId,
          local_saida_id: 999999,
          itens: [{ produto_id: cottonPaiId, tamanho_id: tamanhos.M, quantidade: 1, desconto_pct: 0 }],
          pagamentos: [{ forma: 'pix', valor: 129.9 }],
        },
      });
      assert.equal(erroInexistente.status, 404);
    });
  } finally {
    await new Promise((r) => setTimeout(r, 80));
    await poolRef?.end().catch(() => undefined);
    process.env.DATABASE_URL = base.toString();
    await pgAdmin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await pgAdmin.end().catch(() => undefined);
  }
});
