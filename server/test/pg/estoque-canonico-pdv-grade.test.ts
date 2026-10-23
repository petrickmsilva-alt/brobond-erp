// ============================================================================
// ESTOQUE CANÔNICO — Grade/Estoque Físico × PDV × Faturamento × Cancelamento
//
// Prova em PostgreSQL REAL de que a identidade canônica do saldo
//
//     empresa_id + produto_id + tamanho_id + local_id
//
// é a ÚNICA regra usada pela Grade, pelo PDV (busca e venda), pelo faturamento
// e pelo estorno do cancelamento. Cobre os 8 casos do relatório de divergência
// "Grade M = 10 × PDV M = 1" e a paridade entre as duas telas.
//
// Sem DATABASE_URL o arquivo se auto-pula (como os demais de test/pg).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';
process.env.NODE_ENV = 'test';
const sufixo = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

type Ator = { id: number; name: string; perfil: 'gerente'; empresa_id: number; empresas: number[] };

/** Resposta falsa mínima: os handlers só usam `json`/`status`. */
function resFake() {
  const out: any = { corpo: null, statusCode: 200 };
  out.json = (corpo: unknown) => { out.corpo = corpo; return out; };
  out.status = (codigo: number) => { out.statusCode = codigo; return out; };
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

test('estoque canônico: Grade, PDV, faturamento e cancelamento usam a mesma identidade', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { createRecord, escopoDe, getStore } = await import('../../src/services');
  const { searchProducts } = await import('../../src/productSearch');
  const pdv = await import('../../src/pdv');
  const { estoqueGrade, estoqueDisponivel } = await import('../../src/estoque');

  const admin = { id: 1, name: `Admin canônico ${sufixo}`, perfil: 'admin' as const };
  const store = getStore();

  // ---------------------------------------------------------------------
  // Cenário base: 1 empresa, 2 locais, produto pai com grade P..EG e variações
  // ---------------------------------------------------------------------
  const empresa = await createRecord(R.empresas, { nome: `CANON ${sufixo}` }, admin);
  const empresaId = Number(empresa.id);
  const ator: Ator = { id: 0, name: 'Gerente canônico', perfil: 'gerente', empresa_id: empresaId, empresas: [empresaId] };
  const escopo = escopoDe(ator as never);

  const empresaB = await createRecord(R.empresas, { nome: `CANON B ${sufixo}` }, admin);
  const empresaBId = Number(empresaB.id);
  const atorB: Ator = { id: 0, name: 'Gerente B', perfil: 'gerente', empresa_id: empresaBId, empresas: [empresaBId] };
  const escopoB = escopoDe(atorB as never);

  const categoria = await createRecord(R.categorias, { nome: `Cat ${sufixo}`, ativo: true }, admin);
  const tamanhos = {} as Record<'P' | 'M' | 'G' | 'GG' | 'EG', any>;
  for (const [ordem, codigo] of ['P', 'M', 'G', 'GG', 'EG'].entries()) {
    tamanhos[codigo as 'P'] = await createRecord(
      R.tamanhos,
      { codigo: `${codigo}${sufixo.slice(-3)}`, nome: codigo, ordem: ordem + 1, ativo: true },
      admin
    );
  }
  const gradeRow = await createRecord(R.grades, {
    nome: `Grade ${sufixo}`,
    tamanhos: Object.values(tamanhos).map((t: any) => Number(t.id)),
    ativo: true,
  }, admin);

  const loja = await createRecord(R.locais, { nome: `loja-${sufixo}`, tipo: 'loja', padrao: true, ativo: true }, ator as never);
  const deposito = await createRecord(R.locais, { nome: `dep-${sufixo}`, tipo: 'expedicao', padrao: false, ativo: true }, ator as never);
  const lojaB = await createRecord(R.locais, { nome: `loja-${sufixo}`, tipo: 'loja', padrao: true, ativo: true }, atorB as never);

  const skuPai = `CAM-BAS-PREM-PRET-${sufixo}`;
  const pai = await createRecord(R.produtos, {
    sku: skuPai,
    nome: `Cotton ${sufixo}`,
    categoria_id: Number(categoria.id),
    grade_id: Number(gradeRow.id),
    formato: 'variacao',
    preco_venda: 100,
    ativo: true,
  }, ator as never);

  async function variacao(codigo: keyof typeof tamanhos) {
    const filho = await createRecord(R.produtos, {
      sku: `${skuPai}-${codigo}`,
      nome: `Cotton ${sufixo} ${codigo}`,
      categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id),
      formato: 'variacao',
      preco_venda: 100,
      ativo: true,
    }, ator as never);
    return store.update(R.produtos, Number(filho.id), {
      produto_pai_id: Number(pai.id),
      variacao_chave: `TAM:${codigo}`,
      variacao_tamanho_id: Number(tamanhos[codigo].id),
    });
  }
  const variacoes = {} as Record<keyof typeof tamanhos, any>;
  for (const codigo of Object.keys(tamanhos) as (keyof typeof tamanhos)[]) variacoes[codigo] = await variacao(codigo);

  // Saldo canônico do PAI: M tem 1 na loja + 9 no depósito (físico 10).
  // `adjustStock` só escreve delta positivo (o Postgres valida o CHECK antes de
  // resolver o ON CONFLICT); baixas usam `tryAdjustStock`, como no faturamento.
  const estoqueInicial: Record<string, number> = { P: 7, M: 1, G: 10, GG: 10, EG: 10 };
  for (const codigo of Object.keys(estoqueInicial) as (keyof typeof tamanhos)[]) {
    await store.adjustStock(Number(pai.id), Number(tamanhos[codigo].id), String(loja.nome), estoqueInicial[codigo], undefined, Number(loja.id), empresaId);
  }
  await store.adjustStock(Number(pai.id), Number(tamanhos.M.id), String(deposito.nome), 9, undefined, Number(deposito.id), empresaId);

  // ---------------------------------------------------------------------
  // Helpers de leitura — sempre pelos handlers reais (nenhum atalho de teste)
  // ---------------------------------------------------------------------
  const gradeDe = async (localId?: number) => {
    const req: any = {
      user: ator,
      query: { categoria_id: String(categoria.id), ...(localId ? { local_id: String(localId) } : {}) },
      params: {},
      body: {},
    };
    return chamar(estoqueGrade, req);
  };
  const celulaGrade = (corpo: any, sku: string, tamanhoId: number) => {
    const linha = corpo.linhas.find((l: any) => l.produto.sku === sku);
    return linha?.celulas.find((c: any) => Number(c.tamanho_id) === Number(tamanhoId))?.quantidade;
  };
  const buscarPdv = async (codigo: string, tamanhoId?: number, localId?: number) => {
    const q: Record<string, string> = { codigo };
    if (tamanhoId) q.tamanho_id = String(tamanhoId);
    if (localId) q.local_id = String(localId);
    return chamar(pdv.buscarProduto, { user: ator, query: q, params: {}, body: {} });
  };
  const abrirCaixa = async (terminal: string, localId: number) => chamar(pdv.abrirCaixa, {
    user: ator,
    body: { numero: `${terminal}-${sufixo}`, valor_abertura: 0, local_id: localId },
    params: {},
    query: {},
  });
  const vender = async (caixaId: number, produtoId: number, tamanhoId: number, quantidade: number, localSaidaId?: number) => chamar(pdv.venderPdv, {
    user: ator,
    params: {},
    query: {},
    body: {
      caixa_id: caixaId,
      itens: [{ produto_id: produtoId, tamanho_id: tamanhoId, quantidade, desconto_pct: 0 }],
      pagamentos: [{ forma: 'pix', valor: quantidade * 100 }],
      ...(localSaidaId ? { local_saida_id: localSaidaId } : {}),
    },
  });
  const saldoCelula = async (produtoId: number, tamanhoId: number, localId: number) => {
    const r = await query(
      `SELECT COALESCE(SUM(quantidade), 0)::int AS q FROM estoques
        WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3 AND local_id = $4`,
      [empresaId, produtoId, tamanhoId, localId]
    );
    return Number(r.rows[0].q);
  };

  // =====================================================================
  // CASO 1 + PARIDADE — Grade e PDV leem a mesma célula
  // =====================================================================
  await t.test('CASO 1/paridade: Grade "todos os locais" soma os locais; PDV mostra a célula do local de saída', async () => {
    const gradeTodos = await gradeDe();
    assert.equal(celulaGrade(gradeTodos, skuPai, Number(tamanhos.M.id)), 10, 'grade (físico, todos os locais) M = 10');
    assert.equal(gradeTodos.escopo_saldo.tipo, 'todos');
    assert.equal(gradeTodos.escopo_saldo.semantica, 'estoque_fisico_total_da_empresa');
    assert.equal(gradeTodos.linhas.find((l: any) => l.produto.sku === skuPai).total, 47, 'TOTAL da grade = 47');

    const gradeLoja = await gradeDe(Number(loja.id));
    assert.equal(celulaGrade(gradeLoja, skuPai, Number(tamanhos.M.id)), 1, 'grade do local "loja" = 1');
    assert.equal(gradeLoja.escopo_saldo.tipo, 'local');
    assert.equal(gradeLoja.escopo_saldo.local_id, Number(loja.id));
    assert.equal(gradeLoja.escopo_saldo.semantica, 'estoque_fisico_do_local');

    const gradeDeposito = await gradeDe(Number(deposito.id));
    assert.equal(celulaGrade(gradeDeposito, skuPai, Number(tamanhos.M.id)), 9, 'grade do local "depósito" = 9');

    // PDV: o número vendável é o da célula do local de saída — o MESMO que a
    // grade mostra quando filtrada por aquele local. O físico continua exposto.
    const pdvLoja = await buscarPdv(String(variacoes.M.sku), undefined, Number(loja.id));
    assert.equal(pdvLoja.tamanho_id, Number(tamanhos.M.id));
    assert.equal(pdvLoja.local_id, Number(loja.id));
    assert.equal(pdvLoja.disponivel_no_tamanho, 1, 'PDV no local de saída "loja" = 1 (= grade loja)');
    assert.equal(pdvLoja.disponivel_no_local, 1);
    assert.equal(pdvLoja.estoque_fisico_no_tamanho, 10, 'físico do M = 10 (= grade "todos os locais")');

    const pdvDeposito = await buscarPdv(String(variacoes.M.sku), undefined, Number(deposito.id));
    assert.equal(pdvDeposito.disponivel_no_tamanho, 9, 'PDV no depósito = 9 (= grade depósito)');
    assert.equal(pdvDeposito.estoque_fisico_no_tamanho, 10);

    // A disponibilidade canônica dedicada devolve exatamente os mesmos números.
    const disponivel = await chamar(estoqueDisponivel, {
      user: ator,
      query: { produto_id: String(pai.id), tamanho_id: String(tamanhos.M.id), local_id: String(loja.id) },
      params: {},
      body: {},
    });
    assert.equal(disponivel.quantidade, 1);
    assert.equal(disponivel.estoque_fisico, 10);
    assert.equal(disponivel.local_id, Number(loja.id));
  });

  await t.test('CASO 1: com o produto inteiro no local de saída, o PDV devolve 10 (não 1)', async () => {
    // Um produto separado, 10 unidades do M no MESMO local do caixa.
    const produto = await createRecord(R.produtos, {
      sku: `SIMPLES-${sufixo}`, nome: `Simples ${sufixo}`, categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id), preco_venda: 100, ativo: true,
    }, ator as never);
    await store.adjustStock(Number(produto.id), Number(tamanhos.M.id), String(loja.nome), 10, undefined, Number(loja.id), empresaId);
    const busca = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(busca.disponivel_no_tamanho, 10);
    assert.equal(busca.disponivel_no_local, 10);
    assert.equal(busca.estoque_fisico_no_tamanho, 10);
    const grade = await gradeDe(Number(loja.id));
    assert.equal(celulaGrade(grade, String(produto.sku), Number(tamanhos.M.id)), 10);
  });

  // =====================================================================
  // CASO 2/3 — venda baixa a célula e o cancelamento devolve
  // =====================================================================
  await t.test('CASO 2/3: venda de 1 unidade do M reduz para 9 (movimentação de saída) e o cancelamento volta para 10 (entrada de reversão)', async () => {
    const produto = await createRecord(R.produtos, {
      sku: `VENDA-${sufixo}`, nome: `Venda ${sufixo}`, categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id), preco_venda: 100, ativo: true,
    }, ator as never);
    await store.adjustStock(Number(produto.id), Number(tamanhos.M.id), String(loja.nome), 10, undefined, Number(loja.id), empresaId);
    const caixa = await abrirCaixa('CX2', Number(loja.id));

    const antes = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(antes.disponivel_no_tamanho, 10);

    const venda = await vender(Number(caixa.id), Number(produto.id), Number(tamanhos.M.id), 1);
    assert.equal(Number(venda.itens[0].disponivel_antes), 10, 'disponivel_antes é o vendável do local de saída');
    assert.equal(await saldoCelula(Number(produto.id), Number(tamanhos.M.id), Number(loja.id)), 9, 'M = 9 após faturar');
    const depois = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(depois.disponivel_no_tamanho, 9, 'PDV enxerga o mesmo 9 da célula (sem cache de tela)');
    const gradeDepois = await gradeDe(Number(loja.id));
    assert.equal(celulaGrade(gradeDepois, String(produto.sku), Number(tamanhos.M.id)), 9, 'grade do local também 9');

    const saidas = await query(
      `SELECT tipo, quantidade, local_id, tamanho_id, venda_id FROM movimentacoes
        WHERE empresa_id = $1 AND venda_id = $2 ORDER BY id`,
      [empresaId, Number(venda.venda_id)]
    );
    assert.equal(saidas.rows.length, 1, 'uma saída por item faturado');
    assert.equal(saidas.rows[0].tipo, 'saida');
    assert.equal(Number(saidas.rows[0].quantidade), 1);
    assert.equal(Number(saidas.rows[0].local_id), Number(loja.id));
    assert.equal(Number(saidas.rows[0].tamanho_id), Number(tamanhos.M.id));

    await chamar(pdv.cancelarVendaPdv, {
      user: ator,
      params: { id: String(venda.venda_id) },
      query: {},
      body: { motivo: 'Cancelamento de teste canônico' },
    });
    assert.equal(await saldoCelula(Number(produto.id), Number(tamanhos.M.id), Number(loja.id)), 10, 'M volta para 10');
    const gradeVolta = await gradeDe(Number(loja.id));
    assert.equal(celulaGrade(gradeVolta, String(produto.sku), Number(tamanhos.M.id)), 10);
    const todas = await query(
      `SELECT tipo, quantidade FROM movimentacoes WHERE empresa_id = $1 AND venda_id = $2 ORDER BY id`,
      [empresaId, Number(venda.venda_id)]
    );
    assert.deepEqual(
      todas.rows.map((r: any) => [r.tipo, Number(r.quantidade)]),
      [['saida', 1], ['entrada', 1]],
      'cancelamento grava a reversão (entrada) da MESMA célula'
    );
  });

  // =====================================================================
  // CASO 4 — múltiplas linhas da mesma empresa+produto+tamanho
  // =====================================================================
  await t.test('CASO 4: linhas por local são somadas UMA vez por tamanho; identidade duplicada é impossível e linha órfã nunca vira saldo vendável', async () => {
    const produto = await createRecord(R.produtos, {
      sku: `DUP-${sufixo}`, nome: `Duplicado ${sufixo}`, categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id), preco_venda: 100, ativo: true,
    }, ator as never);
    // Duas linhas para o MESMO empresa+produto+tamanho, em locais diferentes.
    await store.adjustStock(Number(produto.id), Number(tamanhos.M.id), String(loja.nome), 1, undefined, Number(loja.id), empresaId);
    await store.adjustStock(Number(produto.id), Number(tamanhos.M.id), String(deposito.nome), 9, undefined, Number(deposito.id), empresaId);

    const gradeTodos = await gradeDe();
    assert.equal(celulaGrade(gradeTodos, String(produto.sku), Number(tamanhos.M.id)), 10, 'soma única: 1 + 9 = 10');
    assert.equal(celulaGrade(await gradeDe(Number(loja.id)), String(produto.sku), Number(tamanhos.M.id)), 1);
    assert.equal(celulaGrade(await gradeDe(Number(deposito.id)), String(produto.sku), Number(tamanhos.M.id)), 9);
    const busca = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(busca.estoque_fisico_no_tamanho, 10, 'o físico não conta a mesma peça duas vezes');
    assert.equal(busca.disponivel_no_tamanho, 1, 'vendável é a célula do local de saída');

    // A identidade é protegida pelo banco: uma segunda linha para o mesmo
    // empresa+produto+tamanho+local é recusada (nada de saldo duplicado).
    const duplicada = await query(
      `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade)
       VALUES ($1, $2, $3, $4, $5, 100)`,
      [empresaId, Number(produto.id), Number(tamanhos.M.id), String(loja.nome), Number(loja.id)]
    ).then(() => null, (e: any) => e);
    assert.ok(duplicada, 'o banco recusa saldo duplicado para a mesma identidade');
    assert.equal(duplicada.code, '23505');

    // Linha histórica sem local canônico (nome não cadastrado) é ESTOQUE FÍSICO
    // sem local: aparece em "todos os locais", nunca numa célula de venda.
    const orfa = await query(
      `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade)
       VALUES ($1, $2, $3, $4, NULL, 5) RETURNING id`,
      [empresaId, Number(produto.id), Number(tamanhos.M.id), `fantasma-${sufixo}`]
    );
    const comOrfa = await gradeDe();
    assert.equal(celulaGrade(comOrfa, String(produto.sku), Number(tamanhos.M.id)), 15, 'físico inclui a linha órfã');
    assert.equal(celulaGrade(await gradeDe(Number(loja.id)), String(produto.sku), Number(tamanhos.M.id)), 1, 'a linha órfã não é atribuída a local nenhum');
    const buscaComOrfa = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(buscaComOrfa.estoque_fisico_no_tamanho, 15);
    assert.equal(buscaComOrfa.disponivel_no_tamanho, 1, 'estoque sem local não é vendável');
    await query('DELETE FROM estoques WHERE id = $1', [Number(orfa.rows[0].id)]);
  });

  // =====================================================================
  // CASO 5 — pai × variação
  // =====================================================================
  await t.test('CASO 5: variação não tem saldo próprio; o pai não soma o saldo da variação', async () => {
    // Saldo "avulso" na variação M (dado não canônico, não é vendável).
    await query(
      `INSERT INTO estoques (empresa_id, produto_id, tamanho_id, local, local_id, quantidade)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (empresa_id, produto_id, tamanho_id, local_id) WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL
       DO UPDATE SET quantidade = 1`,
      [empresaId, Number(variacoes.M.id), Number(tamanhos.M.id), String(loja.nome), Number(loja.id)]
    );

    const grade = await gradeDe();
    const linhaPai = grade.linhas.find((l: any) => l.produto.sku === skuPai);
    assert.equal(linhaPai.total, 47, 'o total do PAI não absorve o saldo avulso da variação');
    assert.equal(celulaGrade(grade, skuPai, Number(tamanhos.M.id)), 10);

    const busca = await searchProducts(escopo, { q: skuPai, pageSize: 50 });
    const familia = busca.rows.find((row) => row.sku === skuPai)!;
    assert.equal(familia.estoque_disponivel, 47);
    const varM = familia.variacoes.find((v) => v.id === Number(variacoes.M.id))!;
    assert.equal(varM.tamanhos.length, 1);
    assert.equal(varM.tamanhos[0].tamanho_id, Number(tamanhos.M.id));
    assert.equal(varM.tamanhos[0].quantidade, 10, 'variação mostra a célula do PAI (10), não a linha avulsa (1)');
    assert.equal(varM.estoque_disponivel, 10);

    const pdvVariacao = await buscarPdv(String(variacoes.M.sku), undefined, Number(loja.id));
    assert.equal(pdvVariacao.produto_id, Number(pai.id), 'a venda é sempre no produto pai');
    assert.equal(pdvVariacao.disponivel_no_tamanho, 1, 'na loja há 1 — e o saldo avulso da variação não é somado');
    assert.equal(pdvVariacao.estoque_fisico_no_tamanho, 10, 'físico do PAI = 10, sem contar a linha avulsa da variação');

    await query('DELETE FROM estoques WHERE produto_id = $1 AND empresa_id = $2', [Number(variacoes.M.id), empresaId]);
  });

  // =====================================================================
  // CASO 6 — isolamento por empresa
  // =====================================================================
  await t.test('CASO 6: outra empresa com o MESMO SKU não vaza saldo para a empresa ativa', async () => {
    const categoriaB = await createRecord(R.categorias, { nome: `Cat B ${sufixo}`, ativo: true }, admin);
    const outro = await createRecord(R.produtos, {
      sku: skuPai, nome: `Cotton B ${sufixo}`, categoria_id: Number(categoriaB.id), preco_venda: 100, ativo: true,
    }, atorB as never);
    await store.adjustStock(Number(outro.id), Number(tamanhos.M.id), String(lojaB.nome), 99, undefined, Number(lojaB.id), empresaBId);

    const buscaB = await chamar(pdv.buscarProduto, {
      user: atorB, params: {}, body: {},
      query: { codigo: skuPai, tamanho_id: String(tamanhos.M.id) },
    });
    assert.equal(Number(buscaB.produto_id), Number(outro.id));
    assert.equal(buscaB.disponivel_no_tamanho, 99);

    // Empresa A procura o próprio SKU: nada do 99 de B aparece.
    const buscaA = await buscarPdv(skuPai, Number(tamanhos.M.id), Number(loja.id));
    assert.equal(Number(buscaA.produto_id), Number(pai.id));
    assert.equal(buscaA.disponivel_no_tamanho, 1);
    assert.equal(buscaA.estoque_fisico_no_tamanho, 10);

    const gradeB = await chamar(estoqueGrade, {
      user: atorB, params: {}, body: {}, query: { categoria_id: String(categoriaB.id) },
    });
    assert.ok(gradeB.linhas.every((l: any) => l.produto.sku !== skuPai || l.produto.id === Number(outro.id)));
    assert.equal(celulaGrade(gradeB, skuPai, Number(tamanhos.M.id)), 99);

    const gradeA = await gradeDe();
    assert.ok(gradeA.linhas.every((l: any) => l.produto.id !== Number(outro.id)), 'a grade de A não inclui produto de B');
    assert.equal(celulaGrade(gradeA, skuPai, Number(tamanhos.M.id)), 10);

    // Local de outra empresa é recusado — não vira filtro silencioso.
    const localDeOutraEmpresa = await erroDe(pdv.buscarProduto, {
      user: ator, params: {}, body: {},
      query: { codigo: String(variacoes.M.sku), local_id: String(lojaB.id) },
    });
    assert.equal(localDeOutraEmpresa.status, 404);
  });

  // =====================================================================
  // CASO 7 — tamanhos não se misturam
  // =====================================================================
  await t.test('CASO 7: baixar o M não altera P, G, GG nem EG', async () => {
    const produto = await createRecord(R.produtos, {
      sku: `SIZES-${sufixo}`, nome: `Sizes ${sufixo}`, categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id), preco_venda: 100, ativo: true,
    }, ator as never);
    const porTamanho: Record<string, number> = { P: 7, M: 10, G: 10, GG: 10, EG: 10 };
    for (const codigo of Object.keys(porTamanho) as (keyof typeof tamanhos)[]) {
      await store.adjustStock(Number(produto.id), Number(tamanhos[codigo].id), String(loja.nome), porTamanho[codigo], undefined, Number(loja.id), empresaId);
    }
    const caixa = await abrirCaixa('CX7', Number(loja.id));
    await vender(Number(caixa.id), Number(produto.id), Number(tamanhos.M.id), 3);
    assert.equal(await saldoCelula(Number(produto.id), Number(tamanhos.M.id), Number(loja.id)), 7);
    for (const codigo of ['P', 'G', 'GG', 'EG'] as (keyof typeof tamanhos)[]) {
      assert.equal(
        await saldoCelula(Number(produto.id), Number(tamanhos[codigo].id), Number(loja.id)),
        porTamanho[codigo],
        `tamanho ${codigo} intacto`
      );
    }
    const busca = await buscarPdv(String(produto.sku), Number(tamanhos.M.id), Number(loja.id));
    assert.equal(busca.disponivel_no_tamanho, 7);
    assert.equal(busca.estoque_fisico_no_tamanho, 7, 'o físico do tamanho M desconta o que já saiu');
  });

  // =====================================================================
  // CASO 8 — concorrência: duas vendas simultâneas não baixam em dobro
  // =====================================================================
  await t.test('CASO 8: duas vendas simultâneas da última unidade — uma vence, a outra recebe 409 e o saldo nunca fica negativo', async () => {
    const produto = await createRecord(R.produtos, {
      sku: `CONC-${sufixo}`, nome: `Concorrência ${sufixo}`, categoria_id: Number(categoria.id),
      grade_id: Number(gradeRow.id), preco_venda: 100, ativo: true,
    }, ator as never);
    await store.adjustStock(Number(produto.id), Number(tamanhos.M.id), String(loja.nome), 1, undefined, Number(loja.id), empresaId);
    const caixaA = await abrirCaixa('CX8A', Number(loja.id));
    const caixaB = await abrirCaixa('CX8B', Number(loja.id));

    const resultados = await Promise.allSettled([
      vender(Number(caixaA.id), Number(produto.id), Number(tamanhos.M.id), 1),
      vender(Number(caixaB.id), Number(produto.id), Number(tamanhos.M.id), 1),
    ]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const falhas = resultados.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1, 'exatamente uma venda fatura');
    assert.equal(falhas.length, 1, 'a concorrente perde a corrida');
    assert.equal(Number(falhas[0].reason?.status), 409, 'conflito de estoque/concorrência é 409, não 500');
    assert.equal(await saldoCelula(Number(produto.id), Number(tamanhos.M.id), Number(loja.id)), 0, 'saldo final = 0, nunca negativo');
    const saidas = await query(
      `SELECT id, quantidade FROM movimentacoes
        WHERE empresa_id = $1 AND produto_id = $2 AND tamanho_id = $3 AND tipo = 'saida'`,
      [empresaId, Number(produto.id), Number(tamanhos.M.id)]
    );
    assert.equal(saidas.rows.length, 1, 'uma única baixa registrada');
    const negativos = await query(
      `SELECT count(*)::int AS n FROM estoques WHERE empresa_id = $1 AND quantidade < 0`,
      [empresaId]
    );
    assert.equal(Number(negativos.rows[0].n), 0);
  });

  const { pool } = await import('../../src/db');
  await pool.end();
});
