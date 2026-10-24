// ============================================================================
// DIAGNÓSTICO DE VÍNCULOS — PostgreSQL REAL.
//
// Prova o que só o banco pode provar:
//   • as relações descobertas vêm do CATÁLOGO (pg_constraint) — nada inventado,
//     nada esquecido (o teste compara o catálogo com o mapa declarativo);
//   • a FK continua impedindo o DELETE: chamando a store direto (sem passar
//     pela camada de serviço), o banco responde 23503;
//   • o 409 traz o diagnóstico com módulo, quantidade e ids;
//   • multiempresa: a contagem e os ids de outra empresa não aparecem.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

type Ator = { id: number; name: string; perfil: 'admin' | 'gerente'; empresa_id?: number; empresas?: number[] };

test('dependências em PostgreSQL real: catálogo, FK 23503, 409 com diagnóstico e multiempresa', { skip }, async (t) => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { createRecord, updateRecord, deleteRecord, getRecord, getStore, diagnosticarDependencias, listRecords } =
    await import('../src/services');
  const { RELACOES_FK, acaoDeCodigo } = await import('../src/dependencias');

  const admin: Ator = { id: 1, name: 'Admin PG', perfil: 'admin' };

  const empA = await createRecord(RESOURCES.empresas, { nome: `DEPS A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `DEPS B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);
  const ana: Ator = { id: 0, name: 'Ana PG', perfil: 'gerente', empresa_id: A, empresas: [A] };
  const bruno: Ator = { id: 0, name: 'Bruno PG', perfil: 'gerente', empresa_id: B, empresas: [B] };

  // Banco de teste vazio não tem seed: o tamanho usado nas movimentações é criado aqui.
  const tam = await createRecord(RESOURCES.tamanhos, { codigo: `T${sufixo}`.slice(0, 10), ordem: 1 }, admin);
  const TAM = Number(tam.id);

  /** Cria uma venda com item, fatura e cancela — o cenário real de histórico. */
  const localDaEmpresa = new Map<number, { id: number; nome: string }>();
  async function localDa(ator: Ator, marca: string) {
    const chave = Number(ator.empresa_id);
    const existente = localDaEmpresa.get(chave);
    if (existente) return existente;
    const loc = await createRecord(RESOURCES.locais, { nome: `Loja ${marca} ${sufixo}` }, ator);
    const info = { id: Number(loc.id), nome: String(loc.nome) };
    localDaEmpresa.set(chave, info);
    return info;
  }

  async function vendaCancelada(ator: Ator, marca: string) {
    const p = await createRecord(RESOURCES.produtos, { sku: `${marca}-${sufixo}`.slice(0, 30), nome: `Produto ${marca}`, preco_venda: 100 }, ator);
    const c = await createRecord(RESOURCES.clientes, { nome: `Cliente ${marca} ${sufixo}` }, ator);
    // Banco de teste vazio: cada empresa precisa do seu local para movimentar.
    const loc = await localDa(ator, marca);
    await createRecord(
      RESOURCES.movimentacoes,
      { tipo: 'entrada', produto_id: Number(p.id), tamanho_id: TAM, local_id: loc.id, quantidade: 10 },
      ator
    );
    const v = await createRecord(
      RESOURCES.vendas,
      { cliente_id: Number(c.id), data: '2026-09-20', local_saida: loc.nome },
      ator
    );
    const vendaId = Number(v.id);
    const s = getStore();
    await s.transaction(async (tx) => {
      const { validatePayload } = await import('../src/validate');
      const data = await validatePayload(RESOURCES.itens_venda, { produto_id: Number(p.id), tamanho_id: TAM, quantidade: 2, preco_unitario: 100 }, 'create');
      await s.insert(RESOURCES.itens_venda, { ...data, venda_id: vendaId, subtotal: 200 } as any, tx);
      const { recalcularTotal } = await import('../src/itens');
      await recalcularTotal('venda', vendaId, tx);
    });
    await updateRecord(RESOURCES.vendas, vendaId, { status: 'faturada' }, ator);
    await updateRecord(RESOURCES.vendas, vendaId, { status: 'cancelada' }, ator);
    return { vendaId, produtoId: Number(p.id), clienteId: Number(c.id) };
  }

  await t.test('o mapa declarativo cobre EXATAMENTE as FKs reais de vendas/compras', async () => {
    for (const alvo of ['vendas', 'compras'] as const) {
      const catalogo = await query(
        `SELECT src.relname AS tabela,
                con.confdeltype AS acao,
                ARRAY(SELECT a.attname::text
                        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                       ORDER BY k.ord) AS colunas
           FROM pg_constraint con
           JOIN pg_class src ON src.oid = con.conrelid
          WHERE con.contype = 'f' AND con.confrelid = $1::regclass`,
        [alvo]
      );
      // A ORDEM das colunas é detalhe da definição da FK; o que importa é o
      // conjunto (tabela + colunas) e a ação referencial.
      const chaveDe = (tabela: string, colunas: string[]) => `${tabela}(${[...colunas].sort().join(',')})`;
      const doBanco = new Set(catalogo.rows.map((r: any) => chaveDe(r.tabela, r.colunas)));
      const declaradas = new Set(RELACOES_FK.filter((r) => r.alvo === alvo).map((r) => chaveDe(r.tabela, r.colunas)));
      assert.deepEqual(
        [...declaradas].sort(),
        [...doBanco].sort(),
        `o mapa de ${alvo} divergiu do catálogo: uma relação nova no banco precisa entrar em RELACOES_FK`
      );
      // A ação referencial declarada também precisa bater com o banco.
      for (const row of catalogo.rows as any[]) {
        const chave = chaveDe(row.tabela, row.colunas);
        const declarada = RELACOES_FK.find((r) => r.alvo === alvo && chaveDe(r.tabela, r.colunas) === chave);
        if (declarada) assert.equal(declarada.acao, acaoDeCodigo(row.acao), `ação divergente em ${alvo} ← ${chave}`);
      }
    }
  });

  await t.test('venda cancelada: diagnóstico do catálogo, 409 e FK 23503 preservada', async () => {
    const { vendaId, clienteId } = await vendaCancelada(ana, 'CANC');

    const diag = await diagnosticarDependencias(RESOURCES.vendas, vendaId, ana);
    assert.equal(diag.origem, 'postgresql');
    assert.equal(diag.bloqueado, true);
    assert.equal(diag.empresaId, A);

    const mov = diag.vinculos.find((v) => v.tabela === 'movimentacoes');
    assert.ok(mov, 'movimentações reais aparecem');
    assert.ok(mov!.quantidade >= 2, 'saída + estorno');
    assert.equal(mov!.acao, 'NO_ACTION');
    assert.equal(mov!.bloqueia, true);
    assert.ok(mov!.ids.length > 0);

    const financeiro = diag.vinculos.find((v) => v.tabela === 'lancamentos_financeiros');
    assert.ok(financeiro, 'o lançamento financeiro aparece');
    assert.equal(financeiro!.acao, 'LOGICO');
    assert.equal(financeiro!.bloqueia, true);

    const itens = diag.vinculos.find((v) => v.tabela === 'itens_venda');
    assert.equal(itens?.acao, 'CASCADE');
    assert.equal(itens?.bloqueia, false);

    const err = await (async () => {
      try {
        await deleteRecord(RESOURCES.vendas, vendaId, ana);
      } catch (e: any) {
        return e;
      }
      assert.fail('a venda cancelada não pode ser excluída');
    })();
    assert.equal(err.status, 409);
    assert.equal(err.code, 'dependencias_vinculadas');
    assert.match(err.message, /Venda cancelada com histórico\. A exclusão física não é permitida/);
    assert.ok((err.details?.dependencias?.vinculos ?? []).some((v: any) => v.tabela === 'movimentacoes' && v.bloqueia));

    const continua = await getRecord(RESOURCES.vendas, vendaId, ana);
    assert.equal(String(continua.status), 'cancelada');
    const itensAinda = await listRecords(RESOURCES.itens_venda, { page: 1, pageSize: 20, filter: { venda_id: vendaId } }, ana);
    assert.equal(itensAinda.rows.length, 1, 'o item não foi apagado pela tentativa');

    // A ÚLTIMA PALAVRA É DO BANCO: store direta, sem serviço, recebe 23503.
    await assert.rejects(
      () => getStore().remove(RESOURCES.vendas, vendaId),
      (e: any) => e.code === '23503',
      'a FK de movimentacoes(empresa_id, venda_id) recusa o DELETE mesmo sem a guarda do serviço'
    );
    assert.ok(await getRecord(RESOURCES.clientes, clienteId, ana), 'o cliente continua');
  });

  await t.test('multiempresa: contagem e ids de outra empresa nunca aparecem', async () => {
    const a = await vendaCancelada(ana, 'MTA');
    const b = await vendaCancelada(bruno, 'MTB');

    const diagA = await diagnosticarDependencias(RESOURCES.vendas, a.vendaId, ana);
    const diagB = await diagnosticarDependencias(RESOURCES.vendas, b.vendaId, bruno);
    assert.equal(diagA.empresaId, A);
    assert.equal(diagB.empresaId, B);

    const idsA = new Set(diagA.vinculos.flatMap((v) => v.ids));
    const idsB = new Set(diagB.vinculos.flatMap((v) => v.ids));
    for (const id of idsB) assert.equal(idsA.has(id), false, `id ${id} da empresa B vazou para a A`);

    // O cliente da B não é acessível pela empresa A — 404, não 403.
    await assert.rejects(
      () => diagnosticarDependencias(RESOURCES.vendas, b.vendaId, ana),
      (e: any) => e.status === 404,
      'diagnóstico de outra empresa responde 404'
    );
    await assert.rejects(
      () => deleteRecord(RESOURCES.vendas, b.vendaId, ana),
      (e: any) => e.status === 404,
      'exclusão de outra empresa responde 404'
    );

    // Nem a empresa "consolidada" apaga: o recorte é a empresa ativa.
    assert.ok(await getRecord(RESOURCES.vendas, b.vendaId, bruno), 'a venda da B continua');
  });

  await t.test('23503 de uma tabela sem política de proteção vira o MESMO diagnóstico', async () => {
    // Produtos não têm guarda própria de histórico: o DELETE chega ao banco,
    // recebe 23503 e a camada de serviço converte em 409 com diagnóstico.
    const p = await createRecord(RESOURCES.produtos, { sku: `PGDEP-${sufixo}`.slice(0, 30), nome: 'Produto com saldo PG', preco_venda: 10 }, ana);
    const loc = await localDa(ana, 'NA');
    await createRecord(
      RESOURCES.movimentacoes,
      { tipo: 'entrada', produto_id: Number(p.id), tamanho_id: TAM, local_id: loc.id, quantidade: 4 },
      ana
    );

    const err = await (async () => {
      try {
        await deleteRecord(RESOURCES.produtos, Number(p.id), ana);
      } catch (e: any) {
        return e;
      }
      assert.fail('produto com saldo não pode ser excluído');
    })();
    assert.equal(err.status, 409);
    assert.equal(err.code, 'dependencias_vinculadas');
    const vinculos = err.details?.dependencias?.vinculos ?? [];
    assert.ok(
      vinculos.some((v: any) => v.tabela === 'estoques' && v.bloqueia && v.ids.length > 0),
      'o 23503 é traduzido em diagnóstico com a tabela e os ids'
    );
    assert.ok(await getRecord(RESOURCES.produtos, Number(p.id), ana), 'o produto continua no banco');
  });

  await t.test('cliente com venda: 409 explica o módulo Vendas e não apaga nada', async () => {
    const c = await createRecord(RESOURCES.clientes, { nome: `Cliente simples ${sufixo}` }, ana);
    const v = await createRecord(RESOURCES.vendas, { cliente_id: Number(c.id), data: '2026-09-25' }, ana);
    void v;

    const diag = await diagnosticarDependencias(RESOURCES.clientes, Number(c.id), ana);
    const vendas = diag.vinculos.find((x) => x.tabela === 'vendas');
    assert.equal(vendas?.quantidade, 1);
    assert.deepEqual(vendas?.ids, [Number(v.id)]);
    assert.equal(vendas?.modulo, 'Vendas');

    await assert.rejects(
      () => deleteRecord(RESOURCES.clientes, Number(c.id), ana),
      (e: any) => e.status === 409 && e.code === 'dependencias_vinculadas'
    );
    assert.ok(await getRecord(RESOURCES.clientes, Number(c.id), ana));
    assert.ok(await getRecord(RESOURCES.vendas, Number(v.id), ana));
  });
});
