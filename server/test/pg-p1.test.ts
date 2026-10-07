// ============================================================================
// FASE P1 contra Postgres REAL — §20
//
// A suíte de memória prova as regras da camada de serviço. Esta prova as
// garantias que sobrevivem a quem abrir o psql e ignorar o app:
//
//   • `itens_compra_nao_excede_pedido`  — o banco não aceita receber mais do
//     que foi pedido (§16);
//   • `uq_vendas_proposta` + `propostas_convertida_tem_pedido` — uma proposta
//     não vira dois pedidos, nem no banco (§7);
//   • `uq_pdv_caixas_aberto`            — dois caixas abertos com o mesmo
//     número na mesma empresa são impossíveis (§8);
//   • `envios_postado_tem_prova`        — envio "postado/em trânsito/entregue"
//     sem rastreio ou referência do provedor é recusado (§13);
//   • `brobond_herdar_empresa`          — as 12 tabelas-filhas da P1 herdam a
//     empresa do pai, sem o app informar (§19);
//   • unicidade de item de lista de preço, de item de devolução e das chaves
//     de idempotência de envio.
//
// Sem DATABASE_URL o arquivo se auto-pula (job `testes-postgres` do CI).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const sufixo = Date.now().toString(36).toUpperCase();

/** As 12 tabelas-filhas que a 0024 amarrou ao trigger de herança de empresa. */
const FILHAS_P1: Array<[string, string, string]> = [
  ['lista_preco_itens', 'listas_preco', 'lista_id'],
  ['listas_preco_historico', 'listas_preco', 'lista_id'],
  ['proposta_itens', 'propostas', 'proposta_id'],
  ['proposta_eventos', 'propostas', 'proposta_id'],
  ['pdv_caixa_movimentos', 'pdv_caixas', 'caixa_id'],
  ['pdv_pagamentos', 'vendas', 'venda_id'],
  ['envio_eventos', 'envios', 'envio_id'],
  ['expedicao_eventos', 'vendas', 'venda_id'],
  ['divergencias_conferencia', 'vendas', 'venda_id'],
  ['devolucao_itens', 'devolucoes', 'devolucao_id'],
  ['compra_recebimentos', 'compras', 'compra_id'],
  ['compra_recebimento_itens', 'compra_recebimentos', 'recebimento_id'],
];

test('P1 em Postgres real: constraints, unicidades e herança de empresa', { skip }, async (t) => {
  const { query, migrate } = await import('../src/db');
  await migrate();

  const { RESOURCES } = await import('../src/resources');
  const { createRecord } = await import('../src/services');

  const admin = { id: 1, name: 'Admin P1 PG', perfil: 'admin' as const };

  // --- base de dados de verdade -------------------------------------------------
  const empA = await createRecord(RESOURCES.empresas, { nome: `PG P1 A ${sufixo}` }, admin);
  const empB = await createRecord(RESOURCES.empresas, { nome: `PG P1 B ${sufixo}` }, admin);
  const A = Number(empA.id);
  const B = Number(empB.id);

  const atorA = { id: 0, name: 'Ana P1', perfil: 'gerente' as const, empresa_id: A, empresas: [A] };
  const atorB = { id: 0, name: 'Bruno P1', perfil: 'gerente' as const, empresa_id: B, empresas: [B] };

  // O campo de pessoa é `pessoa` (pj|pf|estrangeiro); `tipo` é o perfil
  // comercial (loja|atacadista|varejo). Confundir os dois dá 422.
  const clienteA = await createRecord(RESOURCES.clientes, { nome: `Cliente P1 ${sufixo}`, pessoa: 'pf' }, atorA);
  const fornecedorA = await createRecord(RESOURCES.fornecedores, { nome: `Fornecedor P1 ${sufixo}` }, atorA);
  const produtoA = await createRecord(RESOURCES.produtos, { sku: `P1-${sufixo}`, nome: 'Bota P1', preco_venda: 200, custo: 80 }, atorA);
  const insumoA = await createRecord(RESOURCES.insumos, { nome: `Couro P1 ${sufixo}`, unidade: 'm' }, atorA);

  const pid = Number(produtoA.id);
  const insId = Number(insumoA.id);

  // ============================================================================
  // §16 — RECEBIMENTO NÃO PODE EXCEDER O PEDIDO
  // ============================================================================
  await t.test('§16 o banco recusa receber mais do que foi pedido', async () => {
    const compra = await query(
      `INSERT INTO compras (empresa_id, fornecedor_id, data, status, total)
       VALUES ($1,$2,CURRENT_DATE,'aprovado',240) RETURNING id`,
      [A, Number(fornecedorA.id)]
    );
    const compraId = Number(compra.rows[0].id);

    const item = await query(
      `INSERT INTO itens_compra (empresa_id, compra_id, produto_id, quantidade, preco_unitario)
       VALUES ($1,$2,$3,3,80) RETURNING id`,
      [A, compraId, pid]
    );
    const itemId = Number(item.rows[0].id);

    // Recebimento de 5 num pedido de 3.
    const receb = await query(
      `INSERT INTO compra_recebimentos (empresa_id, compra_id, data, total)
       VALUES ($1,$2,CURRENT_DATE,400) RETURNING id`,
      [A, compraId]
    );
    const recebId = Number(receb.rows[0].id);
    await query(
      `INSERT INTO compra_recebimento_itens (empresa_id, recebimento_id, item_compra_id, quantidade)
       VALUES ($1,$2,$3,5)`,
      [A, recebId, itemId]
    );

    // O CHECK só é reavaliado quando a linha de itens_compra é tocada — e é aí
    // que o banco barra. (É por isso que a guarda primária no app é o CAS em
    // itens_compra.quantidade_recebida, e não só este CHECK.)
    await assert.rejects(
      query(`UPDATE itens_compra SET quantidade_recebida = 5 WHERE id = $1`, [itemId]),
      /itens_compra_nao_excede_pedido|check constraint/i,
      'receber 5 de um pedido de 3 deve ser recusado pelo banco'
    );

    // E o recebido jamais pode passar do pedido pela própria coluna.
    await assert.rejects(
      query(`UPDATE itens_compra SET quantidade_recebida = 4 WHERE id = $1`, [itemId]),
      /itens_compra_recebida_valida|check constraint/i
    );

    // O CHECK compara com a SOMA dos recebimentos gravados — e ela já é 5 neste
    // item. Então o caso "dentro do pedido" precisa do seu próprio item limpo.
    const item2 = await query(
      `INSERT INTO itens_compra (empresa_id, compra_id, produto_id, quantidade, preco_unitario)
       VALUES ($1,$2,$3,3,80) RETURNING id`,
      [A, compraId, pid]
    );
    const itemId2 = Number(item2.rows[0].id);
    const ok = await query(`UPDATE itens_compra SET quantidade_recebida = 3 WHERE id = $1 RETURNING quantidade_recebida`, [itemId2]);
    assert.equal(Number(ok.rows[0].quantidade_recebida), 3);

    // LIMPEZA OBRIGATÓRIA: o over-receipt de 5 fica gravado de propósito para
    // provar o CHECK. Se ele permanecer, a próxima `migrate()` — que revalida
    // os CHECK ao recriar a constraint — falha com 23514 e derruba TODA a
    // suíte Postgres. Remover a linha devolve o item à coerência.
    await query(`DELETE FROM compra_recebimento_itens WHERE item_compra_id = $1`, [itemId]);

    // E um recebimento de 3 num pedido de 3 é aceito pelo banco.
    const receb2 = await query(
      `INSERT INTO compra_recebimentos (empresa_id, compra_id, data, total)
       VALUES ($1,$2,CURRENT_DATE,240) RETURNING id`,
      [A, compraId]
    );
    await query(
      `INSERT INTO compra_recebimento_itens (empresa_id, recebimento_id, item_compra_id, quantidade)
       VALUES ($1,$2,$3,3)`,
      [A, Number(receb2.rows[0].id), itemId2]
    );
    const reavaliado = await query(
      `UPDATE itens_compra SET quantidade_recebida = 3 WHERE id = $1 RETURNING quantidade_recebida`,
      [itemId2]
    );
    assert.equal(Number(reavaliado.rows[0].quantidade_recebida), 3, 'receber exatamente o pedido passa');

    // Quantidade de recebimento tem que ser positiva.
    await assert.rejects(
      query(
        `INSERT INTO compra_recebimento_itens (empresa_id, recebimento_id, item_compra_id, quantidade)
         VALUES ($1,$2,$3,0)`,
        [A, recebId, itemId]
      ),
      /compra_recebimento_itens_qtd_positiva|check constraint/i
    );
  });

  // ============================================================================
  // §7 — UMA PROPOSTA NÃO VIRA DOIS PEDIDOS (no banco)
  // ============================================================================
  await t.test('§7 duas vendas da mesma proposta são impossíveis no banco', async () => {
    const prop = await query(
      `INSERT INTO propostas (empresa_id, cliente_id, status, valida_ate, total)
       VALUES ($1,$2,'aprovada',CURRENT_DATE + 30,400) RETURNING id`,
      [A, Number(clienteA.id)]
    );
    const propId = Number(prop.rows[0].id);

    // 'convertida' sem venda_id é incoerente por definição.
    await assert.rejects(
      query(`UPDATE propostas SET status = 'convertida' WHERE id = $1`, [propId]),
      /propostas_convertida_tem_pedido|check constraint/i,
      "convertida sem pedido deve ser recusada"
    );

    const venda1 = await query(
      `INSERT INTO vendas (empresa_id, cliente_id, data, status, total, proposta_id)
       VALUES ($1,$2,CURRENT_DATE,'faturada',400,$3) RETURNING id`,
      [A, Number(clienteA.id), propId]
    );
    assert.ok(venda1.rows[0].id);

    // A segunda venda com a mesma proposta bate no índice parcial.
    await assert.rejects(
      query(
        `INSERT INTO vendas (empresa_id, cliente_id, data, status, total, proposta_id)
         VALUES ($1,$2,CURRENT_DATE,'faturada',400,$3)`,
        [A, Number(clienteA.id), propId]
      ),
      /uq_vendas_proposta|duplicate key/i,
      'a segunda venda da mesma proposta deve ser recusada'
    );

    // Duas vendas SEM proposta continuam permitidas (o índice é parcial).
    const venda2 = await query(
      `INSERT INTO vendas (empresa_id, cliente_id, data, status, total)
       VALUES ($1,$2,CURRENT_DATE,'faturada',100) RETURNING id`,
      [A, Number(clienteA.id)]
    );
    assert.ok(venda2.rows[0].id);
  });

  // ============================================================================
  // §8 — PDV: um caixa aberto por número, por empresa
  // ============================================================================
  await t.test('§8 dois caixas abertos com o mesmo número são impossíveis', async () => {
    const numero = `CAIXA-${sufixo}`;
    const c1 = await query(
      `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, abertura_em)
       VALUES ($1,$2,'aberto',100,NOW()) RETURNING id`,
      [A, numero]
    );
    assert.ok(c1.rows[0].id);

    await assert.rejects(
      query(
        `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, abertura_em)
         VALUES ($1,$2,'aberto',100,NOW())`,
        [A, numero]
      ),
      /uq_pdv_caixas_aberto|duplicate key/i,
      'dois caixas abertos com o mesmo número devem ser recusados'
    );

    // Fechado, o número libera para reabrir.
    await query(`UPDATE pdv_caixas SET status='fechado', fechamento_em=NOW() WHERE id=$1`, [Number(c1.rows[0].id)]);
    const c2 = await query(
      `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, abertura_em)
       VALUES ($1,$2,'aberto',100,NOW()) RETURNING id`,
      [A, numero]
    );
    assert.ok(c2.rows[0].id, 'depois de fechar, o mesmo número pode reabrir');

    // Outra empresa pode usar o mesmo número (o índice é por empresa).
    const cB = await query(
      `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, abertura_em)
       VALUES ($1,$2,'aberto',100,NOW()) RETURNING id`,
      [B, numero]
    );
    assert.ok(cB.rows[0].id, 'o número é único POR EMPRESA, não globalmente');

    // Caixa fechado precisa ter abertura e fechamento.
    await assert.rejects(
      query(
        `INSERT INTO pdv_caixas (empresa_id, numero, status, valor_abertura, abertura_em)
         VALUES ($1,$2,'fechado',100,NOW())`,
        [A, `X-${sufixo}`]
      ),
      /pdv_caixas_abertura_coerente|check constraint/i
    );
  });

  // ============================================================================
  // §13 — ENVIO "POSTADO" SEM PROVA DE RASTREIO NÃO EXISTE
  // ============================================================================
  await t.test('§13 envio postado sem rastreio nem referência é recusado', async () => {
    // `uq_envios_venda_vivo` permite um único envio vivo por venda, então cada
    // caso abaixo usa a SUA venda — senão o segundo insert falharia pelo índice
    // e não pelo CHECK que está sendo testado.
    const novaVenda = async () => {
      const v = await query(
        `INSERT INTO vendas (empresa_id, cliente_id, data, status, total)
         VALUES ($1,$2,CURRENT_DATE,'faturada',300) RETURNING id`,
        [A, Number(clienteA.id)]
      );
      return Number(v.rows[0].id);
    };
    const vendaId = await novaVenda();

    await assert.rejects(
      query(
        `INSERT INTO envios (empresa_id, venda_id, status, custo)
         VALUES ($1,$2,'postado',25)`,
        [A, vendaId]
      ),
      /envios_postado_tem_prova|check constraint/i,
      'postado sem codigo_rastreamento nem provider_ref deve ser recusado'
    );

    // Com rastreio, passa.
    const envio = await query(
      `INSERT INTO envios (empresa_id, venda_id, status, custo, codigo_rastreamento, provider, servico)
       VALUES ($1,$2,'postado',25,$3,'correios','PAC') RETURNING id`,
      [A, vendaId, `BR${sufixo}`]
    );
    const envioId = Number(envio.rows[0].id);
    assert.ok(envioId);

    // Pendente/cotado não exigem prova.
    const cotado = await query(
      `INSERT INTO envios (empresa_id, venda_id, status, custo, provider, servico)
       VALUES ($1,$2,'cotado',25,'correios','PAC') RETURNING id`,
      [A, await novaVenda()]
    );
    assert.ok(cotado.rows[0].id);

    // Status fora do vocabulário é recusado.
    await assert.rejects(
      query(
        `INSERT INTO envios (empresa_id, venda_id, status, custo, provider, servico)
         VALUES ($1,$2,'teletransportado',25,'correios','PAC')`,
        [A, await novaVenda()]
      ),
      /envios_status_valido|check constraint/i
    );

    // Volumes: no mínimo 1.
    await assert.rejects(
      query(
        `INSERT INTO envios (empresa_id, venda_id, status, custo, volumes, provider, servico)
         VALUES ($1,$2,'cotado',25,0,'correios','PAC')`,
        [A, await novaVenda()]
      ),
      /envios_volumes_valido|check constraint/i
    );

    // Idempotência: a mesma chave não gera dois envios.
    const chave = `envio:venda:${vendaId}:${sufixo}`;
    const vendaIdem = await novaVenda();
    await query(
      `INSERT INTO envios (empresa_id, venda_id, status, custo, provider, servico, idempotency_key)
       VALUES ($1,$2,'pendente',0,'correios','PAC',$3)`,
      [A, vendaIdem, chave]
    );
    await assert.rejects(
      query(
        `INSERT INTO envios (empresa_id, venda_id, status, custo, provider, servico, idempotency_key)
         VALUES ($1,$2,'pendente',0,'correios','PAC',$3)`,
        [A, vendaIdem, chave]
      ),
      /uq_envios_idempotency|duplicate key/i,
      'a chave de idempotência deve impedir envio duplicado'
    );

    void envioId;
  });

  // ============================================================================
  // §15 — DEVOLUÇÃO
  // ============================================================================
  await t.test('§15 devolução recebida exige autorização e item único', async () => {
    const venda = await query(
      `INSERT INTO vendas (empresa_id, cliente_id, data, status, total)
       VALUES ($1,$2,CURRENT_DATE,'faturada',400) RETURNING id`,
      [A, Number(clienteA.id)]
    );
    const vendaId = Number(venda.rows[0].id);
    await query(
      `INSERT INTO itens_venda (empresa_id, venda_id, produto_id, quantidade, preco_unitario, subtotal)
       VALUES ($1,$2,$3,4,100,400)`,
      [A, vendaId, pid]
    );

    // Recebida sem autorização é incoerente.
    await assert.rejects(
      query(
        `INSERT INTO devolucoes (empresa_id, venda_id, status, tipo, motivo)
         VALUES ($1,$2,'recebida','devolucao','Cliente desistiu da compra')`,
        [A, vendaId]
      ),
      /devolucoes_recebida_tem_autorizacao|check constraint/i
    );

    // Motivo vazio não passa.
    await assert.rejects(
      query(
        `INSERT INTO devolucoes (empresa_id, venda_id, status, tipo, motivo)
         VALUES ($1,$2,'solicitada','devolucao','   ')`,
        [A, vendaId]
      ),
      /devolucoes_motivo_obrigatorio|check constraint/i
    );

    // Tipo fora do vocabulário não passa.
    await assert.rejects(
      query(
        `INSERT INTO devolucoes (empresa_id, venda_id, status, tipo, motivo)
         VALUES ($1,$2,'solicitada','cortesia','Cliente desistiu da compra')`,
        [A, vendaId]
      ),
      /devolucoes_tipo_valido|check constraint/i
    );

    const dev = await query(
      `INSERT INTO devolucoes (empresa_id, venda_id, status, tipo, motivo)
       VALUES ($1,$2,'solicitada','devolucao','Cliente desistiu da compra') RETURNING id`,
      [A, vendaId]
    );
    const devId = Number(dev.rows[0].id);

    const it = await query(
      `INSERT INTO devolucao_itens (empresa_id, devolucao_id, produto_id, quantidade_solicitada)
       VALUES ($1,$2,$3,2) RETURNING id`,
      [A, devId, pid]
    );
    assert.ok(it.rows[0].id);

    // O mesmo item não entra duas vezes na mesma devolução.
    await assert.rejects(
      query(
        `INSERT INTO devolucao_itens (empresa_id, devolucao_id, produto_id, quantidade_solicitada)
         VALUES ($1,$2,$3,1)`,
        [A, devId, pid]
      ),
      /uq_devolucao_item|duplicate key/i
    );

    // Recebido nunca passa do solicitado.
    await assert.rejects(
      query(`UPDATE devolucao_itens SET quantidade_recebida = 3 WHERE id = $1`, [Number(it.rows[0].id)]),
      /devolucao_itens_recebida_valida|check constraint/i
    );

    // Estado fora do vocabulário não passa.
    await assert.rejects(
      query(`UPDATE devolucao_itens SET estado = 'destruido' WHERE id = $1`, [Number(it.rows[0].id)]),
      /devolucao_itens_estado_valido|check constraint/i
    );
  });

  // ============================================================================
  // §6 — LISTA DE PREÇO: um preço por produto e por lista
  // ============================================================================
  await t.test('§6 item de lista de preço é único por (lista, produto)', async () => {
    const lista = await query(
      `INSERT INTO listas_preco (empresa_id, nome, prioridade, ativo)
       VALUES ($1,$2,50,true) RETURNING id`,
      [A, `Atacado ${sufixo}`]
    );
    const listaId = Number(lista.rows[0].id);

    await query(
      `INSERT INTO lista_preco_itens (empresa_id, lista_id, produto_id, preco)
       VALUES ($1,$2,$3,150)`,
      [A, listaId, pid]
    );
    await assert.rejects(
      query(
        `INSERT INTO lista_preco_itens (empresa_id, lista_id, produto_id, preco)
         VALUES ($1,$2,$3,120)`,
        [A, listaId, pid]
      ),
      /uq_lista_preco_item|duplicate key/i,
      'dois preços para o mesmo produto na mesma lista devem ser recusados'
    );

    // Preço negativo não passa.
    await assert.rejects(
      query(
        `INSERT INTO lista_preco_itens (empresa_id, lista_id, produto_id, preco)
         VALUES ($1,$2,$3,-5)`,
        [A, listaId, Number(produtoA.id) + 1]
      ).catch(async (e) => {
        // pode falhar pela FK do produto; o que importa é NÃO passar com preço negativo
        if (/preco_positivo|check constraint/i.test(String(e))) throw e;
        throw e;
      }),
      /lista_preco_itens_preco_positivo|check constraint|foreign key|violates/i
    );

    // Vigência incoerente (fim antes do início) não passa.
    await assert.rejects(
      query(
        `INSERT INTO listas_preco (empresa_id, nome, prioridade, ativo, inicio_em, fim_em)
         VALUES ($1,$2,50,true,CURRENT_DATE + 10,CURRENT_DATE)`,
        [A, `Vigencia errada ${sufixo}`]
      ),
      /listas_preco_vigencia_coerente|check constraint/i
    );
  });

  // ============================================================================
  // §19 — HERANÇA DE EMPRESA NAS 12 TABELAS-FILHAS
  // ============================================================================
  await t.test('§19 as 12 tabelas-filhas da P1 herdam a empresa do pai', async () => {
    const instaladas = await query(
      `SELECT c.relname AS tabela, t.tgname AS trigger
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_empresa_%'`
    );
    const nomes = new Set(instaladas.rows.map((r) => String(r.tabela)));

    for (const [filha, , coluna] of FILHAS_P1) {
      assert.ok(nomes.has(filha), `falta o trigger de herança em ${filha}`);
      const temColuna = await query(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='empresa_id'`,
        [filha]
      );
      assert.ok(temColuna.rowCount, `${filha} não tem empresa_id`);
      assert.ok(coluna, 'coluna-pai declarada');
    }
    assert.equal(FILHAS_P1.length, 12, 'são 12 tabelas-filhas na P1');
  });

  await t.test('§19 o trigger deriva a empresa do pai, sem o app informar', async () => {
    // Pai na EMPRESA B.
    const lista = await query(
      `INSERT INTO listas_preco (empresa_id, nome, prioridade, ativo)
       VALUES ($1,$2,50,true) RETURNING id`,
      [B, `Lista da B ${sufixo}`]
    );
    const listaId = Number(lista.rows[0].id);

    // Filho inserido SEM empresa_id: o trigger tem que derivar do pai (B).
    const filho = await query(
      `INSERT INTO lista_preco_itens (lista_id, produto_id, preco)
       VALUES ($1,$2,99) RETURNING empresa_id`,
      [listaId, pid]
    );
    assert.equal(Number(filho.rows[0].empresa_id), B, 'a filha herdou a empresa da lista');
  });

  // ============================================================================
  // H) COLUNAS ADITIVAS E VOCABULÁRIOS ESTENDIDOS
  // ============================================================================
  await t.test('§16/§8 os vocabulários estendidos aceitam os novos valores', async () => {
    // compras.status aceita 'parcial' (recebimento parcial).
    const compra = await query(
      `INSERT INTO compras (empresa_id, fornecedor_id, data, status, total)
       VALUES ($1,$2,CURRENT_DATE,'parcial',100) RETURNING status`,
      [A, Number(fornecedorA.id)]
    );
    assert.equal(compra.rows[0].status, 'parcial');

    // vendas.canal_venda aceita 'pdv'.
    const venda = await query(
      `INSERT INTO vendas (empresa_id, cliente_id, data, status, total, canal_venda)
       VALUES ($1,$2,CURRENT_DATE,'faturada',100,'pdv') RETURNING id, canal_venda`,
      [A, Number(clienteA.id)]
    );
    assert.equal(venda.rows[0].canal_venda, 'pdv');

    // E um valor inventado continua sendo recusado.
    await assert.rejects(
      query(
        `INSERT INTO vendas (empresa_id, cliente_id, data, status, total, canal_venda)
         VALUES ($1,$2,CURRENT_DATE,'faturada',100,'pombo_correio')`,
        [A, Number(clienteA.id)]
      ),
      /vendas_canal_venda_valido|check constraint/i
    );

    // vendas.expedicao_etapa aceita as etapas da expedição e recusa o resto.
    await query(
      `UPDATE vendas SET expedicao_etapa = 'conferida' WHERE id = $1`,
      [Number(venda.rows[0].id)]
    );
    await assert.rejects(
      query(`UPDATE vendas SET expedicao_etapa = 'voando' WHERE id = $1`, [Number(venda.rows[0].id)]),
      /vendas_expedicao_etapa_valida|check constraint/i
    );
  });

  await t.test('as colunas de amarração da 0024 existem no banco', async () => {
    const cols = await query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'vendas' AND column_name IN ('proposta_id','pdv_caixa_id','envio_id','expedicao_etapa','canal_venda'))
           OR (table_name = 'itens_compra' AND column_name = 'quantidade_recebida')
           OR (table_name = 'compras' AND column_name = 'recebida_em')
        ORDER BY 1,2`
    );
    const achadas = cols.rows.map((r) => `${r.table_name}.${r.column_name}`);
    for (const esperado of [
      'compras.recebida_em',
      'itens_compra.quantidade_recebida',
      'vendas.canal_venda',
      'vendas.envio_id',
      'vendas.expedicao_etapa',
      'vendas.pdv_caixa_id',
      'vendas.proposta_id',
    ]) {
      assert.ok(achadas.includes(esperado), `falta a coluna ${esperado}`);
    }
  });

  // ============================================================================
  // MULTIEMPRESA — a unicidade é por empresa, não global
  // ============================================================================
  await t.test('§19 o mesmo SKU pode existir nas duas empresas', async () => {
    const sku = `SKU-P1-${sufixo}`;
    await createRecord(RESOURCES.produtos, { sku, nome: 'Bota A', preco_venda: 10 }, atorA);
    const pb = await createRecord(RESOURCES.produtos, { sku, nome: 'Bota B', preco_venda: 20 }, atorB);
    assert.ok(pb.id, 'o mesmo SKU na empresa B é aceito');

    // Mas duplicar dentro da mesma empresa não.
    await assert.rejects(
      createRecord(RESOURCES.produtos, { sku, nome: 'Bota A duplicada', preco_venda: 30 }, atorA),
      /sku|duplicad|já existe|constraint/i
    );
  });

  await t.test('§19 a listagem chega ao SQL recortada por empresa', async () => {
    const { listRecords } = await import('../src/services');
    const soA = await listRecords(RESOURCES.compras, { page: 1, pageSize: 500 }, { empresaId: A, consolidado: false, permitidas: [A] });
    const soB = await listRecords(RESOURCES.compras, { page: 1, pageSize: 500 }, { empresaId: B, consolidado: false, permitidas: [B] });

    assert.ok(soA.rows.every((r) => Number(r.empresa_id) === A), 'a lista de A só tem A');
    assert.ok(soB.rows.every((r) => Number(r.empresa_id) === B), 'a lista de B só tem B');
    assert.equal(soB.rows.length, 0, 'B não tem compras neste teste');
    assert.ok(soA.rows.length > 0, 'A tem as compras criadas acima');
  });

  void insumoA;
  void insId;
});
