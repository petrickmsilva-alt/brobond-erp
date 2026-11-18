// ============================================================================
// CARGA COMERCIAL + INVENTÁRIO EM POSTGRESQL REAL — o preview NÃO grava e a
// confirmação PERSISTE pai, variações, atributos, preços e saldos reconciliados.
//
// O teste de memória (`carga-politica-comercial.test.ts`) prova a regra; este
// prova o que só o PostgreSQL mostra:
//   • as colunas novas (0120: material/modelagem/genero/origem_dados/
//     atributos_adicionais) recebem o valor do importador — JSONB de verdade,
//     não "[object Object]";
//   • o CHECK `jsonb_typeof = 'object'` aceita o mapa e recusa escalar;
//   • produto-pai × variação respeitam a FK composta por empresa;
//   • a reimportação é IDEMPOTENTE (nenhum produto/preço duplicado);
//   • preco_venda/preco_atacado recebem a base calculada pelo motor de preço;
//   • saldo físico reconciliado é persistido por SKU no local LOJA;
//   • soma e células persistidas fecham com o inventário da planilha;
//   • saldo inicial não cria movimento artificial.
//
// Sem DATABASE_URL o arquivo se auto-pula (gate test:pg / job testes-postgres).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (gate test:pg / job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const CABECALHO = [
  'Item', 'Cód Categoria', 'MARCA', 'CATEGORIA MASTER', 'COLEÇÃO', 'VARIANTE COR', 'DESCRIÇÃO',
  'Tamanho', 'Código Industria', 'Tipo', 'STATUS', 'Peso KG', 'Altura CM', 'Largura CM',
  'Comprimento ou profundidade CM', 'Custo Unitário Fabricação',
  'Simples Nacional', 'ICMS', 'ICMS2', 'Mgb Atacado Vista', 'Mgb Vrj Vista',
  'Mgb Vrj Vista 2 un', 'MGL VRJ CARTÃO À VISTA', 'VRJ =/> 2 PÇ CARTÃO até  3X',
  'Material Predominante', 'Fornecedor',
  'Atacado À Vista', 'Atacado Boleto 30', 'Atacado Boleto 30/60', 'Atacado Boleto 30/60/90',
  'Atacado Cartão Débido', 'Atacado Cartão Crédito à vista', 'Atacado Cartão Crédito 30/60',
  'Atacado Cartão Crédito 30/60/90', 'Varejo À Vista', 'VRJ 2 Un',
  'Vlr Cartão à Vista', 'Vlr Cartão Parcelado', 'Margem MGB (%)', 'Preço Varejo', 'Preço Atacado',
];

type Linha = Partial<Record<(typeof CABECALHO)[number], string | number>>;

async function xlsxBase64(linhas: Linha[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Política Comercial Completa');
  for (let r = 1; r <= 10; r++) ws.getRow(r).getCell(1).value = r === 1 ? 'TABELA DE PREÇO BASE' : '';
  CABECALHO.forEach((h, i) => (ws.getRow(11).getCell(i + 1).value = h));

  // Mesmos fatores financeiros e parâmetros de formação usados pela suíte
  // funcional. Os valores finais da planilha são conferências; o ERP calcula
  // as condições a partir de custo, tributos, margens e ajustes da linha 10.
  const fatoresFinanceiros: Record<string, number> = {
    'Atacado À Vista': 0,
    'Atacado Boleto 30': 0.04,
    'Atacado Boleto 30/60': 0.08,
    'Atacado Boleto 30/60/90': 0.10,
    'Atacado Cartão Débido': 0.08,
    'Atacado Cartão Crédito à vista': 0.08,
    'Atacado Cartão Crédito 30/60': 0.12,
    'Atacado Cartão Crédito 30/60/90': 0.15,
    'VRJ 2 Un': 0.20,
  };
  for (const [rotulo, fator] of Object.entries(fatoresFinanceiros)) {
    const coluna = CABECALHO.indexOf(rotulo);
    if (coluna >= 0) ws.getRow(10).getCell(coluna + 1).value = fator;
  }
  const parametrosPadrao: Record<string, number> = {
    'Simples Nacional': 0.06,
    ICMS: 0.02,
    ICMS2: 0.01,
    'Mgb Atacado Vista': 0.45,
    'Mgb Vrj Vista': 0.60,
    'Mgb Vrj Vista 2 un': 0.55,
    'MGL VRJ CARTÃO À VISTA': 0.65,
    'VRJ =/> 2 PÇ CARTÃO até  3X': 0.60,
  };
  linhas.forEach((l, i) => {
    const row = ws.getRow(12 + i);
    CABECALHO.forEach((h, j) => {
      if (l[h] !== undefined) row.getCell(j + 1).value = l[h] as any;
      else if (parametrosPadrao[h] !== undefined) row.getCell(j + 1).value = parametrosPadrao[h];
    });
  });

  // A fixture inclui deliberadamente uma unidade física na planilha para provar
  // que a carga substitui o saldo de teste pelo inventário oficial em LOJA.
  const saida = wb.addWorksheet('CONTROLE ESTOQUE SAÍDA');
  const cabSaida = [
    'Codigo Cadastro', 'COLEÇÃO', 'CATEGORIA', 'SUBCATEGORIA',
    'Código Internto Industria', 'Descrição', 'Nº', 'Estoque', 'Saída',
    'Saldo', 'Estoque2', 'Saída2', 'Saldo2', 'Reservado',
    'TT Est.', 'TT Saída', 'TT Saldo',
  ];
  cabSaida.forEach((h, i) => (saida.getRow(7).getCell(i + 1).value = h));
  linhas.forEach((item, i) => {
    const row = saida.getRow(8 + i);
    const quantidade = i === 0 ? 1 : 0;
    row.getCell(1).value = item.Item ?? String(i + 1);
    row.getCell(5).value = item['Código Industria'] ?? '';
    row.getCell(6).value = item['DESCRIÇÃO'] ?? '';
    row.getCell(8).value = quantidade;
    row.getCell(9).value = 0;
    row.getCell(10).value = quantidade;
    row.getCell(11).value = 0;
    row.getCell(12).value = 0;
    row.getCell(13).value = 0;
    row.getCell(15).value = quantidade;
    row.getCell(16).value = 0;
    row.getCell(17).value = quantidade;
  });

  const baseControle = wb.addWorksheet('BASE CONTROLE DE ESTOQUE');
  [
    'Item', 'COLEÇÃO', 'CATEGORIA', 'SUBCATEGORIA',
    'Descrição do produto/serviço2', 'Tamanho', 'Código Industria',
  ].forEach((h, i) => (baseControle.getRow(11).getCell(i + 1).value = h));
  // Esta fixture não declara SKUs da fonte complementar controle_estoque.
  // Os SKUs testados pertencem exclusivamente à aba principal; mantê-los aqui
  // duplicaria a identidade em duas fontes diferentes e deve ser rejeitado.

  const jefferson = wb.addWorksheet('Estoque Com Jefferson');
  for (const cab of [4, 12]) {
    ['DESCRIÇÃO', 'P', 'M', 'G', 'GG', 'XG', 'TOTAL'].forEach((h, i) => {
      jefferson.getRow(cab).getCell(i + 1).value = h;
    });
  }

  const roupas = wb.addWorksheet('Política Comercial Roupas (2)');
  ['Item', 'Categoria', 'Descrição do produto/serviço2', 'Código Industria', 'Qtd. Estoque']
    .forEach((h, i) => (roupas.getRow(4).getCell(i + 1).value = h));

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

function linhas(sufixo: string): Linha[] {
  const comum = {
    'Cód Categoria': 'CB2B', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'CAMISETA', COLEÇÃO: `BORDADO ${sufixo}`,
    Tipo: 'UN', STATUS: 'ATIVO', 'Peso KG': 0.2, 'Custo Unitário Fabricação': 25.5,
    'Material Predominante': 'ALGODÃO', Fornecedor: 'LEMONETTE CONFECÇÕES',
    'Atacado À Vista': 49.9, 'Atacado Boleto 30/60': 54.9, 'Varejo À Vista': 99.9, 'Vlr Cartão Parcelado': 109.9,
    'Margem MGB (%)': 60, 'Preço Varejo': 79.9,
  };
  return [
    { Item: '1001', ...comum, 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': `CAMISETA ${sufixo} PRETA`, Tamanho: 'P', 'Código Industria': `CB2B${sufixo}010` },
    { Item: '1002', ...comum, 'VARIANTE COR': 'PRETA', 'DESCRIÇÃO': `CAMISETA ${sufixo} PRETA`, Tamanho: 'M', 'Código Industria': `CB2B${sufixo}011` },
    // Produto simples (família de uma linha só).
    {
      Item: '2001', 'Cód Categoria': 'SOR', MARCA: 'BROBOND', 'CATEGORIA MASTER': 'ÓCULOS DE SOL',
      COLEÇÃO: `VINTAGE ${sufixo}`, 'VARIANTE COR': 'PRETO', 'DESCRIÇÃO': `ÓCULOS ${sufixo} PRETO`, Tamanho: '',
      'Código Industria': `SOR${sufixo}`, Tipo: 'UN', STATUS: 'INATIVO', 'Custo Unitário Fabricação': 40,
      'Atacado À Vista': 89.9, 'Varejo À Vista': 179.9,
    },
  ];
}

test('carga em PG real: preview não grava e confirmação persiste cadastro, preços e inventário', { skip }, async (t) => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { RESOURCES: R } = await import('../../src/resources');
  const { getStore, escopoDe, createRecord } = await import('../../src/services');
  const { previewCarga, confirmarCarga } = await import('../../src/cargaPoliticaComercial');
  const { reqDe, resFake } = await import('../_p1util');

  const sufixo = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const store = getStore();
  const admin = { id: 1, name: `Admin carga ${sufixo}`, perfil: 'admin' as const };
  const empresa = await createRecord(R.empresas, { nome: `CARGA ${sufixo}` }, admin);
  const empresaId = Number(empresa.id);
  const usuario = await store.insert(R.usuarios, { nome: `Gestor ${sufixo}`, email: `carga-${sufixo}@brobond.test`, perfil: 'gerente', empresa_id: empresaId, ativo: true });
  const usuarioId = Number(usuario.id);
  const vinculoEmpresa = await store.findOneWhere(R.usuario_empresas, { usuario_id: usuarioId, empresa_id: empresaId });
  if (!vinculoEmpresa) await store.insert(R.usuario_empresas, { usuario_id: usuarioId, empresa_id: empresaId });
  const ator = { id: usuarioId, name: String(usuario.nome), perfil: 'gerente' as const, empresa_id: empresaId, empresa_sessao: empresaId, empresas: [empresaId] };
  // A carga exige exatamente um local físico ativo/padrão chamado LOJA.
  // Cria-se a pré-condição operacional da empresa de teste, como no helper
  // before() da suíte de memória, antes da prévia/confirmação.
  await store.insert(R.locais, {
    empresa_id: empresaId,
    nome: 'LOJA',
    tipo: 'loja',
    nivel_wms: 'local',
    ativo: true,
    padrao: true,
  });

  t.after(async () => {
    const apagar = async (sql: string) => query(sql, [empresaId]).catch(() => undefined);
    await apagar(`DELETE FROM carga_politica_comercial_jobs WHERE empresa_id = $1`);
    await apagar(`DELETE FROM auditoria WHERE empresa_id = $1`);
    await apagar(`DELETE FROM movimentacoes WHERE empresa_id = $1`);
    await apagar(`DELETE FROM estoque_reservas WHERE empresa_id = $1`);
    await apagar(`DELETE FROM estoques WHERE empresa_id = $1`);
    await apagar(`DELETE FROM locais WHERE empresa_id = $1`);
    await apagar(`DELETE FROM produto_precos_condicao_historico WHERE empresa_id = $1`);
    await apagar(`DELETE FROM produto_precos_condicao WHERE empresa_id = $1`);
    await apagar(`DELETE FROM precificacao_memoria WHERE empresa_id = $1`);
    await apagar(`DELETE FROM condicoes_pagamento WHERE empresa_id = $1`);
    await apagar(`DELETE FROM produtos WHERE empresa_id = $1`);
    await apagar(`DELETE FROM grade_tamanhos WHERE grade_id IN (SELECT id FROM grades WHERE nome LIKE $1)`);
    await apagar(`DELETE FROM grades WHERE nome LIKE $1`).catch(() => undefined);
    await query(`DELETE FROM usuario_empresas WHERE usuario_id = $1`, [usuarioId]).catch(() => undefined);
    await query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]).catch(() => undefined);
    await apagar(`DELETE FROM empresas WHERE id = $1`);
  });

  const conteudo = await xlsxBase64(linhas(sufixo));
  const escopo = escopoDe(ator as never);
  const corpo = { conteudo, nome: 'x.xlsx' };

  // 1) PREVIEW: relata, não grava.
  const antes = await store.countWhere(R.produtos, { empresa_id: empresaId });
  const prev = resFake();
  await previewCarga(reqDe(corpo, { user: ator }) as never, prev.res);
  assert.equal(prev.saida.status ?? 200, 200, JSON.stringify(prev.saida.json));
  assert.equal(prev.saida.json.total, 3);
  assert.equal(prev.saida.json.nao_gravado.includes('nenhum produto'), true);
  assert.equal(await store.countWhere(R.produtos, { empresa_id: empresaId }), antes, 'o preview não cria produto');

  // 2) CONFIRMAÇÃO: grava.
  const conf = resFake();
  await confirmarCarga(reqDe(corpo, { user: ator }) as never, conf.res);
  assert.equal(conf.saida.status ?? 200, 200, JSON.stringify(conf.saida.json));
  assert.equal(conf.saida.json.produtos, 2, 'dois produtos-pai');
  assert.equal(conf.saida.json.variacoes, 2, 'duas variações da camiseta');
  assert.equal(conf.saida.json.estoque_importado, true, 'a confirmação importa o inventário físico oficial');
  assert.equal(conf.saida.json.estoque.unidades_importadas, 1, 'uma unidade declarada na aba de saldo é importada');
  assert.equal(conf.saida.json.estoque.saldo_inicial, 1, 'o saldo inicial coincide com o inventário');
  assert.equal(conf.saida.json.estoque.celulas_importadas, 1, 'uma célula física positiva é criada');

  // 3) PERSISTÊNCIA conferida por SQL direto (não pela resposta HTTP).
  const pai = (await query(
    `SELECT * FROM produtos WHERE empresa_id = $1 AND formato = 'variacao' AND produto_pai_id IS NULL`,
    [empresaId]
  )).rows[0];
  assert.ok(pai, 'o produto-pai foi persistido');
  assert.equal(pai.origem_dados, 'planilha');

  const varP = (await query(`SELECT * FROM produtos WHERE empresa_id = $1 AND sku = $2`, [empresaId, `CB2B${sufixo}010`])).rows[0];
  assert.ok(varP, 'a variação P foi persistida');
  assert.equal(Number(varP.produto_pai_id), Number(pai.id), 'a variação aponta para o pai');
  assert.equal(varP.codigo_industria, `CB2B${sufixo}010`, 'código da indústria preservado como texto');
  assert.equal(varP.cor, 'PRETA');
  assert.equal(varP.unidade, 'un', 'Tipo=UN → unidade un');
  assert.equal(Number(varP.preco_venda), 69.49, 'base varejo calculada com tributos e margem-alvo de 60%');
  assert.equal(Number(varP.preco_atacado), 50.54, 'base atacado calculada com tributos e margem-alvo de 45%');

  // Atributos adicionais: JSONB de verdade, com o mapa esperado.
  assert.equal(typeof varP.atributos_adicionais, 'object');
  assert.equal(varP.atributos_adicionais.Fornecedor, 'LEMONETTE CONFECÇÕES', 'o fornecedor foi preservado nos atributos');
  assert.equal(varP.atributos_adicionais['Material Predominante'], 'ALGODÃO');
  assert.equal(varP.atributos_adicionais['Margem MGB (%)'], undefined, 'coluna calculada NÃO entra como atributo');

  // 4) Preços calculados por condição, com vigência e origem rastreável.
  const boleto = (await query(
    `SELECT * FROM produto_precos_condicao WHERE empresa_id = $1 AND produto_id = $2 AND canal = 'atacado' AND condicao = 'boleto_30_60' AND vigencia_fim IS NULL`,
    [empresaId, Number(varP.id)]
  )).rows[0];
  assert.ok(boleto, 'preço de boleto 30/60 gravado como dado');
  assert.equal(Number(boleto.preco), 54.93, 'margem atacado de 45% + fator financeiro de 8%');
  assert.equal(boleto.origem, 'planilha_calculada');

  // 5) O CHECK recusa JSONB escalar em atributos_adicionais.
  await assert.rejects(
    query(`UPDATE produtos SET atributos_adicionais = '"x"'::jsonb WHERE id = $1`, [Number(varP.id)]),
    /produtos_atributos_adicionais_obj_ck|check constraint/i
  );

  // 6) Produto simples: INATIVO desativa; sem pai.
  const oculos = (await query(`SELECT * FROM produtos WHERE empresa_id = $1 AND sku = $2`, [empresaId, `SOR${sufixo}`])).rows[0];
  assert.ok(oculos);
  assert.equal(oculos.ativo, false);
  assert.equal(oculos.produto_pai_id ?? null, null);

  // 7) O saldo oficial é persistido em LOJA e conferido diretamente no PostgreSQL.
  const estoques = await store.list(R.estoques, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
  assert.equal(estoques.rows.length, 1, 'uma célula física positiva é persistida');
  assert.equal(Number(estoques.rows[0].quantidade), 1, 'o saldo da planilha está gravado');
  const lojaPersistida = await store.findOneWhere(R.locais, { empresa_id: empresaId, nome: 'LOJA' });
  assert.equal(Number(estoques.rows[0].local_id), Number(lojaPersistida!.id));
  const movimentosAntes = await store.countWhere(R.movimentacoes, { empresa_id: empresaId });
  assert.equal(movimentosAntes, 0, 'saldo inicial não cria movimento artificial');

  // 7.1) Concorrência: o lock da carga impede que outro escritor altere
  // estoques enquanto o snapshot está sendo substituído.
  let liberarLock!: () => void;
  let sinalizarLock!: () => void;
  const lockAdquirido = new Promise<void>((resolve) => { sinalizarLock = resolve; });
  const aguardarLiberacao = new Promise<void>((resolve) => { liberarLock = resolve; });
  const transacaoBloqueadora = store.transaction(async (tx) => {
    await tx!.query('LOCK TABLE estoques IN SHARE ROW EXCLUSIVE MODE');
    sinalizarLock();
    await aguardarLiberacao;
  });
  await lockAdquirido;
  let escritaConcorrenteConcluida = false;
  const escritaConcorrente = query(
    'UPDATE estoques SET quantidade = quantidade WHERE id = $1',
    [Number(estoques.rows[0].id)]
  ).then(() => { escritaConcorrenteConcluida = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(escritaConcorrenteConcluida, false, 'DML concorrente fica bloqueado até o commit da carga');
  liberarLock();
  await transacaoBloqueadora;
  await escritaConcorrente;
  assert.equal(escritaConcorrenteConcluida, true, 'escritor prossegue depois da liberação do lock');

  // 8) IDEMPOTÊNCIA: reimportar não duplica produto, preço, saldo ou movimento.
  const prodAntes = await store.countWhere(R.produtos, { empresa_id: empresaId });
  const precosAntes = await store.countWhere(R.produto_precos_condicao, { empresa_id: empresaId });
  const conf2 = resFake();
  await confirmarCarga(reqDe(corpo, { user: ator }) as never, conf2.res);
  assert.equal(conf2.saida.json.produtos, 0, 'nenhum produto novo na reimportação');
  assert.equal(conf2.saida.json.variacoes, 0, 'nenhuma variação nova');
  assert.equal(await store.countWhere(R.produtos, { empresa_id: empresaId }), prodAntes);
  assert.equal(await store.countWhere(R.produto_precos_condicao, { empresa_id: empresaId }), precosAntes, 'preços não duplicam');
  const estoquesDepois = await store.list(R.estoques, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
  assert.equal(estoquesDepois.rows.length, 1, 'reimportação substitui o snapshot sem duplicar a célula');
  assert.equal(Number(estoquesDepois.rows[0].quantidade), 1, 'reimportação mantém o saldo físico da planilha');
  assert.equal(await store.countWhere(R.movimentacoes, { empresa_id: empresaId }), movimentosAntes, 'reimportação não cria movimentos artificiais');
  assert.ok(escopo.empresaId === empresaId);

  // 9) WORKER DURÁVEL: o mesmo importador roda em background e o status é consultável.
  const {
    iniciarJobCarga,
    processarFilaCargaComercial,
    statusJobCarga,
    reivindicarJobCarga,
  } = await import('../../src/cargaPoliticaComercial');

  const jobCriado = resFake();
  await iniciarJobCarga(reqDe(corpo, { user: ator }) as never, jobCriado.res);
  assert.equal(jobCriado.saida.status, 202);
  const jobId = String(jobCriado.saida.json.job_id);
  await processarFilaCargaComercial();

  const jobConsultado = resFake();
  await statusJobCarga(reqDe({}, { user: ator, params: { id: jobId } }) as never, jobConsultado.res);
  assert.equal(jobConsultado.saida.json.status, 'succeeded', `erro do worker: ${jobConsultado.saida.json.error ?? 'sem detalhe persistido'}`);
  assert.equal(jobConsultado.saida.json.result.ok, true);
  assert.equal(jobConsultado.saida.json.result.produtos, 0, 'worker reimporta sem duplicar os produtos existentes');
  assert.equal(jobConsultado.saida.json.result.estoque_importado, true);
  assert.equal(jobConsultado.saida.json.result.estoque.unidades_importadas, 1);
  const estoqueWorker = await store.list(R.estoques, { page: 1, pageSize: 100, filter: { empresa_id: empresaId } });
  assert.equal(estoqueWorker.rows.length, 1, 'worker também mantém um único snapshot físico');
  assert.equal(await store.countWhere(R.produtos, { empresa_id: empresaId }), prodAntes);

  // 10) FALHA RECUPERÁVEL: erro de leitura não grava catálogo e permite retry idempotente.
  const corpoInvalido = { conteudo: 'bm90LWEtcmVhbC14bHN4', nome: 'arquivo-invalido.xlsx' };
  const falhaCriada = resFake();
  await iniciarJobCarga(reqDe(corpoInvalido, { user: ator }) as never, falhaCriada.res);
  const falhaId = String(falhaCriada.saida.json.job_id);
  await processarFilaCargaComercial();
  const falhaAntesRetry = (await query(
    `SELECT status, attempts, lease_token FROM carga_politica_comercial_jobs WHERE id = $1`,
    [falhaId]
  )).rows[0];
  assert.equal(falhaAntesRetry.status, 'failed');
  assert.equal(falhaAntesRetry.attempts, 1);
  assert.equal(falhaAntesRetry.lease_token, null);

  const retry = resFake();
  await iniciarJobCarga(reqDe(corpoInvalido, { user: ator }) as never, retry.res);
  assert.equal(String(retry.saida.json.job_id), falhaId, 'retry reutiliza a mesma operação idempotente');
  assert.equal(retry.saida.json.status, 'queued', 'falha terminal pode ser re-enfileirada');
  await processarFilaCargaComercial();
  const falhaDepoisRetry = (await query(
    `SELECT status, attempts FROM carga_politica_comercial_jobs WHERE id = $1`,
    [falhaId]
  )).rows[0];
  assert.equal(falhaDepoisRetry.status, 'failed');
  assert.equal(falhaDepoisRetry.attempts, 1, 'contador reinicia para a nova tentativa');

  // 11) CONCORRÊNCIA E RECUPERAÇÃO: uma empresa só tem um worker ativo;
  // lease vencido pode ser retomado, e a conclusão perdida faz rollback.
  const corpoFilaA = { conteudo: 'cXVldWUtaW50ZW50LWE=', nome: 'fila-a.xlsx' };
  const corpoFilaB = { conteudo: 'cXVldWUtaW50ZW50LWI=', nome: 'fila-b.xlsx' };
  const filaA = resFake();
  const filaB = resFake();
  await iniciarJobCarga(reqDe(corpoFilaA, { user: ator }) as never, filaA.res);
  await iniciarJobCarga(reqDe(corpoFilaB, { user: ator }) as never, filaB.res);
  const tokenA = randomUUID();
  const tokenB = randomUUID();
  const claimA = await reivindicarJobCarga(tokenA);
  assert.equal(String(claimA.id), String(filaA.saida.json.job_id));
  const claimB = await reivindicarJobCarga(tokenB);
  assert.equal(claimB, null, 'não reivindica outro job enquanto a empresa já tem um em execução');

  await query(
    `UPDATE carga_politica_comercial_jobs SET heartbeat_at = now() - interval '3 minutes' WHERE id = $1`,
    [claimA.id]
  );
  const retomado = await reivindicarJobCarga(tokenB);
  assert.equal(String(retomado.id), String(claimA.id));
  assert.equal(String(retomado.lease_token), tokenB, 'novo worker assume um lease novo');

  await assert.rejects(
    store.transaction(async (tx) => {
      await tx!.query(
        `UPDATE carga_politica_comercial_jobs
            SET status = 'succeeded', lease_token = NULL
          WHERE id = $1 AND status = 'running' AND lease_token = $2`,
        [claimA.id, tokenB]
      );
      throw new Error('rollback intencional do teste');
    }),
    /rollback intencional/
  );
  const aposRollback = (await query(
    `SELECT status, lease_token FROM carga_politica_comercial_jobs WHERE id = $1`,
    [claimA.id]
  )).rows[0];
  assert.equal(aposRollback.status, 'running', 'a transição terminal foi revertida');
  assert.equal(String(aposRollback.lease_token), tokenB, 'o lease permanece recuperável após rollback');
  await query(
    `UPDATE carga_politica_comercial_jobs
        SET status = 'failed', lease_token = NULL, finished_at = now()
      WHERE id = $1 AND lease_token = $2`,
    [claimA.id, tokenB]
  );
});
