// ============================================================
// P2-08 (auditoria independente, 2026-10-11): a projeção do ERP com ZERO
// usuários ativos.
//
// `sales.usuario_id` é NOT NULL, então o passo das VENDAS exige um responsável
// ativo. O passo dos ITENS não repetia essa condição: a venda não entrava em
// `sales`, os itens tentavam entrar e a instrução violava a FK
// `sale_items_sale_id_fkey` (23503) — a projeção INTEIRA abortava (a via
// `POST /api/negocios/margens/recalcular` devolvia 400 "Referência inválida").
//
// O teste desativa todos os usuários, exige que a projeção NÃO lance e que
// NENHUMA linha parcial seja escrita; em seguida devolve o usuário e prova que a
// mesma venda projeta normalmente. Sem a correção, a primeira metade falha.
//
// `test:pg` roda com `--test-concurrency=1` (arquivos em série): desativar os
// usuários por alguns instantes não atropela outro arquivo — o `finally`
// restaura quem estava ativo.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

test('P2-08: projeção sem nenhum usuário ativo não lança e não escreve linha parcial (PG)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { projetarVendasErp } = await import('../../src/negocios');

  const s = String(Date.now() % 1e7);
  const linha = async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows;
  const contar = async (sql: string, params: unknown[] = []) => Number((await linha(sql, params))[0].n);

  const [prod] = await linha(
    `INSERT INTO produtos (sku, nome, preco_venda, custo, empresa_id) VALUES ($1,$2,100,40,1) RETURNING id`,
    [`P208-${s}`, `Auditoria P2-08 ${s}`]
  );
  const [venda] = await linha(
    `INSERT INTO vendas (status, canal_venda, total, data, faturada_em, empresa_id)
     VALUES ('faturada','site_varejo',100,now(),now(),1) RETURNING id`
  );
  const [item] = await linha(
    `INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, subtotal)
     VALUES ($1,$2,2,50,100) RETURNING id`,
    [venda.id, prod.id]
  );
  // O responsável de teste nasce INATIVO: ele não conta como "usuário ativo" no
  // cenário A, mas é o que devolve a projetabilidade no cenário B.
  const [usuario] = await linha(
    `INSERT INTO usuarios (nome, email, perfil, ativo, empresa_id)
     VALUES ($1,$2,'admin',false,1) RETURNING id`,
    [`Auditoria P2-08 ${s}`, `p208-${s}@brobond.test`]
  );
  const ativos = (await linha(`SELECT id FROM usuarios WHERE ativo`)).map((r: any) => Number(r.id));
  const salesId = `erp:venda:${venda.id}`;

  try {
    await query(`UPDATE usuarios SET ativo = false WHERE ativo`);

    // Cenário A: ZERO usuários ativos. Antes da correção isto lançava 23503.
    const semNinguem = await projetarVendasErp();
    assert.equal(semNinguem.vendas, 0, 'nenhuma venda projetada sem responsável');
    assert.equal(
      await contar(`SELECT count(*)::int AS n FROM sales WHERE id = $1`, [salesId]),
      0,
      'a venda não entra em sales'
    );
    assert.equal(
      await contar(`SELECT count(*)::int AS n FROM sale_items WHERE sale_id = $1`, [salesId]),
      0,
      'nenhum item órfão é escrito'
    );
    assert.equal(
      await contar(
        `SELECT count(*)::int AS n FROM sale_items si WHERE si.sale_id LIKE 'erp:venda:%'
           AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = si.sale_id)`
      ),
      0,
      'nenhum item erp: fica sem a venda pai'
    );

    // Cenário B: o responsável volta e a MESMA venda projeta ponta a ponta.
    await query(`UPDATE usuarios SET ativo = true WHERE id = $1`, [usuario.id]);
    const comUsuario = await projetarVendasErp();
    assert.ok(comUsuario.vendas >= 1);
    assert.equal(await contar(`SELECT count(*)::int AS n FROM sales WHERE id = $1`, [salesId]), 1);
    assert.equal(await contar(`SELECT count(*)::int AS n FROM sale_items WHERE sale_id = $1`, [salesId]), 1);
  } finally {
    // Restaura o estado de `ativo` de quem já estava ativo e limpa o cenário.
    if (ativos.length) {
      await query(`UPDATE usuarios SET ativo = true WHERE id = ANY($1::int[])`, [ativos]);
    }
    await query(`UPDATE usuarios SET ativo = true WHERE id = $1`, [usuario.id]);
    // No cenário B o usuário do teste é o ÚNICO ativo: a projeção assina com ele
    // TODA venda faturada que sobrou no banco (o responsável é global). A FK
    // `sales_usuario_id_fkey` é RESTRICT — devolvemos a assinatura para outro
    // usuário antes de remover o do teste (a projeção é re-derivável).
    const outro = (await linha(`SELECT id FROM usuarios WHERE id <> $1 ORDER BY ativo DESC, id LIMIT 1`, [usuario.id]))[0];
    if (outro) await query(`UPDATE sales SET usuario_id = $2 WHERE usuario_id = $1`, [usuario.id, outro.id]);
    await query(`DELETE FROM sales WHERE id = $1`, [salesId]);
    await query(`DELETE FROM itens_venda WHERE id = $1`, [item.id]);
    await query(`DELETE FROM vendas WHERE id = $1`, [venda.id]);
    await query(`DELETE FROM produtos WHERE id = $1`, [prod.id]);
    // Sem outro usuário no banco, a linha do usuário fica (não há para quem
    // transferir a assinatura) — mas isso só ocorre num banco vazio.
    await query(`DELETE FROM usuarios u WHERE u.id = $1 AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.usuario_id = u.id)`, [usuario.id]);
  }
});
