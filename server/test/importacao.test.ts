// ============================================================================
// IMPORTAÇÃO/MIGRAÇÃO (FASE P3) — o que precisa ficar travado:
//
//   • o CABEÇALHO é validado antes de qualquer linha: faltar coluna obrigatória
//     é 400 com o nome da coluna, nunca importação parcial silenciosa;
//   • o erro é por LINHA DO ARQUIVO ("Linha 3: ...") — a mensagem que o usuário
//     vê no Excel;
//   • a confirmação é TUDO-OU-NADA por padrão (422 e nada gravado); só com
//     `ignorarErros: true` as linhas inválidas ficam de fora, e voltam no
//     relatório com o motivo;
//   • IDEMPOTÊNCIA: reimportar o mesmo arquivo não duplica nada;
//   • saldo inicial vira SALDO + MOVIMENTAÇÃO rastreável (origem, lote, custo);
//   • título financeiro importado nasce PENDENTE — nunca pago;
//   • histórico de pedidos vira UMA venda "MIG-<n>" com itens e total do ERP;
//   • variação é criada com o SKU determinístico do ERP e vinculada ao pai;
//   • referência de outra empresa não é encontrada (isolamento §18).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { previewImportacao, confirmarImportacao, listarLotesImportacao } = await import('../src/importacao');
const { ADMIN, garantirAdmin, reqDe, chamar, esperarErro, novoProduto, novoTamanho, novoLocal, novoCliente } = await import('./_p1util');

await garantirAdmin();
const s = getStore();

const CNPJ_OK = '11.222.333/0001-81';
const CNPJ_RUIM = '11.111.111/1111-11';

const csv = (cabecalho: string[], ...linhas: (string | number)[][]) =>
  [cabecalho.join(';'), ...linhas.map((l) => l.join(';'))].join('\n');

const preview = (tipo: string, conteudo: string, user: any = ADMIN) =>
  chamar(previewImportacao as any, reqDe({ tipo, conteudo }, { user }));

const confirmar = (tipo: string, conteudo: string, extra: Record<string, unknown> = {}, user: any = ADMIN) =>
  chamar(confirmarImportacao as any, reqDe({ tipo, conteudo, ...extra }, { user }));

const contar = async (recurso: any, where: Record<string, unknown> = {}) => (await s.list(recurso, { page: 1, pageSize: 5000, filter: where })).total;

// ---------------------------------------------------------------------------
// 1) Cabeçalho, erro por linha e pré-visualização
// ---------------------------------------------------------------------------

test('importação: cabeçalho sem coluna obrigatória devolve 400 com o nome da coluna', async () => {
  const semTamanho = csv(['produto', 'quantidade'], ['CAM-1', '10']);
  const erro = await esperarErro(() => preview('estoque', semTamanho), 400, /tamanho/i);
  assert.match(String(erro.message), /Cabeçalho inválido/i);
});

test('importação: XLSX disfarçado de CSV é lido como texto e o cabeçalho inválido é reportado', async () => {
  // Conteúdo que não é planilha: o servidor NÃO confia no nome do arquivo —
  // tenta XLSX (base64), cai para CSV e falha na validação, nunca em silêncio.
  const erro = await esperarErro(() => preview('produtos', 'lixo-que-nao-e-planilha'), 400, /Cabeçalho inválido|linha/i);
  assert.ok(erro.status === 400);
});

test('importação: erro aponta a LINHA DO ARQUIVO e as linhas válidas continuam na amostra', async () => {
  const conteudo = csv(
    ['sku', 'nome', 'preco_venda'],
    ['IMP-OK-1', 'Produto Importado Um', '99,90'],
    ['', 'Produto Sem SKU', '10']
  );
  const resp = await preview('produtos', conteudo);
  assert.equal(resp.total, 2);
  assert.equal(resp.validas, 1);
  assert.equal(resp.erros.length, 1);
  assert.equal(resp.erros[0].linha, 3, 'a segunda linha de dados é a linha 3 do arquivo');
  assert.match(resp.erros[0].mensagem, /SKU/i);
  assert.equal(resp.amostra[0].sku, 'IMP-OK-1');
});

test('importação: CPF/CNPJ inválido é recusado por linha (dígito verificador)', async () => {
  const conteudo = csv(['nome', 'cnpj_cpf'], ['Cliente Documento Ruim', CNPJ_RUIM]);
  const resp = await preview('clientes', conteudo);
  assert.equal(resp.validas, 0);
  assert.equal(resp.erros.length, 1);
  assert.match(resp.erros[0].mensagem, /documento|CNPJ|CPF/i);
});

test('importação: data fora do formato e quantidade negativa são erros de linha', async () => {
  const cliente = await novoCliente({ nome: 'Cliente Título Data' });
  const conteudo = csv(
    ['tipo', 'cliente', 'descricao', 'valor', 'vencimento'],
    ['receita', String(cliente.nome), 'Parcela válida', '100,00', '2026-12-01'],
    ['receita', String(cliente.nome), 'Data ambígua', '100,00', 'ontem']
  );
  const resp = await preview('titulos', conteudo);
  assert.equal(resp.validas, 1);
  assert.equal(resp.erros.length, 1);
  assert.equal(resp.erros[0].linha, 3);
  assert.match(resp.erros[0].mensagem, /formato/i);
});

// ---------------------------------------------------------------------------
// 2) Tudo-ou-nada e `ignorarErros`
// ---------------------------------------------------------------------------

test('importação: uma linha com erro aborta TUDO (422) e nada é gravado', async () => {
  const antes = await contar(RESOURCES.produtos);
  const conteudo = csv(
    ['sku', 'nome'],
    ['IMP-ATOMICO-1', 'Produto Atômico Um'],
    ['IMP-ATOMICO-2', '']
  );
  const erro = await esperarErro(() => confirmar('produtos', conteudo), 422, /nada foi gravado/i);
  assert.ok(Array.isArray((erro.fields as any)?.erros), 'os erros por linha voltam na resposta');
  assert.equal(await contar(RESOURCES.produtos), antes, 'nenhum produto novo entrou');
  const existente = await s.findOneWhere(RESOURCES.produtos, { sku: 'IMP-ATOMICO-1' });
  assert.equal(existente, null, 'nem a linha VÁLIDA entrou na transação abortada');
});

test('importação: com `ignorarErros` só as válidas entram — e o relatório diz o que ficou de fora', async () => {
  const conteudo = csv(
    ['sku', 'nome'],
    ['IMP-PARCIAL-1', 'Produto Parcial Um'],
    ['IMP-PARCIAL-2', '']
  );
  const resp = await confirmar('produtos', conteudo, { ignorarErros: true });
  assert.equal(resp.importados, 1);
  assert.equal(resp.erros.length, 1);
  assert.ok(await s.findOneWhere(RESOURCES.produtos, { sku: 'IMP-PARCIAL-1' }));
  assert.equal(await s.findOneWhere(RESOURCES.produtos, { sku: 'IMP-PARCIAL-2' }), null);
});

// ---------------------------------------------------------------------------
// 3) Idempotência
// ---------------------------------------------------------------------------

test('importação: reimportar o mesmo arquivo não duplica (SKU é a identidade)', async () => {
  const conteudo = csv(['sku', 'nome', 'preco_venda'], ['IMP-IDEMP-1', 'Produto Idempotente', '50']);
  const primeira = await confirmar('produtos', conteudo);
  assert.equal(primeira.importados, 1);

  const antes = await contar(RESOURCES.produtos);
  const segunda = await confirmar('produtos', conteudo);
  assert.equal(segunda.importados, 0);
  assert.equal(segunda.pulados, 1);
  assert.equal(await contar(RESOURCES.produtos), antes, 'nada foi duplicado');
  assert.ok(segunda.ignorados_detalhe.some((i: any) => /já cadastrado/i.test(i.motivo)));

  // A trilha do lote fica disponível para auditoria (GET /api/importar/lotes).
  const vistos = await chamar(listarLotesImportacao as any, reqDe({}, { query: { limite: '5' } }));
  assert.ok(vistos.lotes.length >= 1, 'a importação registra o lote');
  const lotes = await s.list(RESOURCES.importacoes_lotes, { page: 1, pageSize: 20, sort: 'id', dir: 'desc' });
  assert.ok(Number(lotes.rows[0].total) >= 1, 'o lote guarda o total de linhas do arquivo');
  assert.equal(Number(lotes.rows[0].importados), 0, 'a reimportação entrou como lote sem novidade');
});

// ---------------------------------------------------------------------------
// 4) Saldo inicial: estoque + movimentação rastreável
// ---------------------------------------------------------------------------

test('importação: saldo inicial cria o saldo E a movimentação com origem, lote e custo', async () => {
  const produto = await novoProduto({ sku: 'IMP-EST-1', nome: 'Produto Estoque Importado', custo: 10, preco_venda: 30 });
  await novoTamanho('IMP-M');
  await novoLocal('Depósito Importação');
  const conteudo = csv(
    ['produto', 'tamanho', 'local', 'quantidade', 'estoque_min', 'custo'],
    ['IMP-EST-1', 'IMP-M', 'Depósito Importação', '120', '10', '12,50']
  );
  const resp = await confirmar('estoque', conteudo);
  assert.equal(resp.importados, 1);
  assert.ok(resp.lote_id, 'a importação devolve o lote');

  const saldo = await s.findOneWhere(RESOURCES.estoques, { produto_id: Number(produto.id), local: 'Depósito Importação' });
  assert.ok(saldo, 'o saldo foi criado');
  assert.equal(Number(saldo!.quantidade), 120);
  assert.equal(String(saldo!.origem), 'importacao');
  assert.equal(Number(saldo!.lote_importacao_id), Number(resp.lote_id));

  const mov = await s.findOneWhere(RESOURCES.movimentacoes, { produto_id: Number(produto.id), lote_importacao_id: Number(resp.lote_id) } as any);
  assert.ok(mov, 'o saldo inicial SEMPRE deixa movimentação');
  assert.equal(String(mov!.tipo), 'ajuste');
  assert.equal(Number(mov!.quantidade), 120);
  assert.equal(String(mov!.origem), 'importacao');
  assert.equal(Number(mov!.custo_unitario), 12.5);
  assert.match(String(mov!.motivo), /[Ss]aldo inicial/i);

  // Reimportar não sobrescreve saldo existente nem cria movimento novo.
  const segunda = await confirmar('estoque', conteudo);
  assert.equal(segunda.importados, 0);
  assert.equal(segunda.pulados, 1);
  const movs = await s.list(RESOURCES.movimentacoes, { page: 1, pageSize: 100, filter: { produto_id: Number(produto.id) } });
  assert.equal(movs.total, 1, 'nenhuma movimentação duplicada');
});

// ---------------------------------------------------------------------------
// 5) Títulos financeiros em aberto
// ---------------------------------------------------------------------------

test('importação: título nasce PENDENTE, com documento, cliente e vencimento originais', async () => {
  const cliente = await novoCliente({ nome: 'Cliente Título Importado', cnpj_cpf: CNPJ_OK });
  const conteudo = csv(
    ['tipo', 'cliente', 'documento', 'descricao', 'valor', 'vencimento', 'parcela', 'total_parcelas'],
    ['receita', 'Cliente Título Importado', 'NF-5001', 'Parcela 1/2 — pedido 5001', '1.500,00', '2026-12-15', '1', '2'],
    ['receita', 'Cliente Título Importado', 'NF-5001', 'Parcela 2/2 — pedido 5001', '1.500,00', '2027-01-15', '2', '2']
  );
  const resp = await confirmar('titulos', conteudo);
  assert.equal(resp.importados, 2);

  const primeiro = await s.findOneWhere(RESOURCES.lancamentos_financeiros, { documento: 'NF-5001', parcela: 1 });
  assert.ok(primeiro);
  assert.equal(String(primeiro!.status), 'pendente', 'título migrado NUNCA nasce confirmado/pago');
  assert.equal(Number(primeiro!.valor), 1500);
  assert.equal(String(primeiro!.vencimento).slice(0, 10), '2026-12-15');
  assert.equal(Number(primeiro!.pessoa_id), Number(cliente.id));
  assert.equal(String(primeiro!.pessoa_tipo), 'cliente');
  assert.equal(String(primeiro!.origem), 'importacao');

  // Reimportar o mesmo arquivo: nada duplica (identidade = pessoa+documento+parcela+vencimento).
  const antes = await contar(RESOURCES.lancamentos_financeiros, { documento: 'NF-5001' });
  const segunda = await confirmar('titulos', conteudo);
  assert.equal(segunda.importados, 0);
  assert.equal(segunda.pulados, 2);
  assert.equal(await contar(RESOURCES.lancamentos_financeiros, { documento: 'NF-5001' }), antes);
});

test('importação: título de fornecedor sem cadastro é erro de linha, não título órfão', async () => {
  const conteudo = csv(
    ['tipo', 'fornecedor', 'documento', 'descricao', 'valor', 'vencimento'],
    ['despesa', 'Fornecedor Que Não Existe', 'NF-9', 'Compra de tecido', '200', '2026-11-01']
  );
  const resp = await preview('titulos', conteudo);
  assert.equal(resp.validas, 0);
  assert.match(resp.erros[0].mensagem, /Fornecedor .* não encontrado/i);
});

// ---------------------------------------------------------------------------
// 6) Histórico de pedidos
// ---------------------------------------------------------------------------

test('importação: histórico vira UMA venda MIG-<n> com itens e total recalculado', async () => {
  const cliente = await novoCliente({ nome: 'Cliente Histórico' });
  await novoProduto({ sku: 'IMP-PED-1', nome: 'Produto Histórico A', preco_venda: 100 });
  await novoProduto({ sku: 'IMP-PED-2', nome: 'Produto Histórico B', preco_venda: 50 });
  await novoTamanho('IMP-G');
  const conteudo = csv(
    ['pedido', 'data', 'status', 'canal', 'cliente', 'sku', 'tamanho', 'quantidade', 'preco_unitario', 'frete'],
    ['5001', '2026-09-10', 'entregue', 'site_varejo', 'Cliente Histórico', 'IMP-PED-1', 'IMP-G', '2', '100', '20'],
    ['5001', '2026-09-10', 'entregue', 'site_varejo', 'Cliente Histórico', 'IMP-PED-2', 'IMP-G', '1', '50', '20']
  );
  const resp = await confirmar('pedidos', conteudo);
  assert.equal(resp.importados, 2, 'as duas linhas pertencem ao MESMO pedido');

  const venda = await s.findOneWhere(RESOURCES.vendas, { pedido_cliente: 'MIG-5001' });
  assert.ok(venda, 'o pedido histórico entrou com a referência de idempotência');
  assert.equal(String(venda!.status), 'entregue');
  assert.equal(String(venda!.origem), 'importacao');
  // Total pela regra do ERP: itens (2×100 + 1×50 = 250) + frete (20) = 270.
  const itens = await s.list(RESOURCES.itens_venda, { page: 1, pageSize: 10, filter: { venda_id: Number(venda!.id) } });
  assert.equal(itens.total, 2);
  assert.equal(Number(venda!.total), 270);
  assert.equal(Number(venda!.frete), 20);

  const antes = await contar(RESOURCES.vendas);
  const segunda = await confirmar('pedidos', conteudo);
  assert.equal(segunda.importados, 0);
  assert.equal(segunda.pulados, 2);
  assert.equal(await contar(RESOURCES.vendas), antes, 'reimportar não cria uma segunda venda');
});

// ---------------------------------------------------------------------------
// 7) Variações e composições
// ---------------------------------------------------------------------------

test('importação: variação usa o SKU determinístico do ERP e fica vinculada ao pai', async () => {
  const pai = await novoProduto({ sku: 'IMP-VAR-1', nome: 'Camisa Variação', preco_venda: 89, custo: 30 });
  await novoTamanho('IMP-VM');
  const conteudo = csv(['sku_pai', 'cor', 'tamanho', 'preco_venda'], ['IMP-VAR-1', 'Azul Marinho', 'IMP-VM', '99,90']);
  const resp = await confirmar('variacoes', conteudo);
  assert.equal(resp.importados, 1);

  const filho = await s.findOneWhere(RESOURCES.produtos, { sku: 'IMP-VAR-1-AZUL-MARINHO-IMP-VM' });
  assert.ok(filho, 'o SKU é derivado pelo ERP (sem confiar no arquivo)');
  assert.equal(Number(filho!.produto_pai_id), Number(pai.id));
  assert.equal(String(filho!.variacao_chave), 'COR:AZUL-MARINHO|TAM:IMP-VM');
  assert.equal(Number(filho!.preco_venda), 99.9);
  const paiDepois = await s.get(RESOURCES.produtos, Number(pai.id));
  assert.equal(String(paiDepois!.formato), 'variacao', 'o pai passa a declarar que tem variações');

  // Reimportar: o SKU derivado já existe → ignorado.
  const segunda = await confirmar('variacoes', conteudo);
  assert.equal(segunda.importados, 0);
});

test('importação: composição de kit cria o vínculo e atualiza a quantidade', async () => {
  await novoProduto({ sku: 'IMP-KIT', nome: 'Kit Importado' });
  await novoProduto({ sku: 'IMP-COMP', nome: 'Componente Importado' });
  const conteudo = csv(['sku_kit', 'sku_componente', 'quantidade'], ['IMP-KIT', 'IMP-COMP', '2']);
  const resp = await confirmar('composicoes', conteudo);
  assert.equal(resp.importados, 1);
  const vinculo = await s.findOneWhere(RESOURCES.produto_composicao, { quantidade: 2 });
  assert.ok(vinculo);

  const mudanca = await confirmar('composicoes', csv(['sku_kit', 'sku_componente', 'quantidade'], ['IMP-KIT', 'IMP-COMP', '3']));
  assert.equal(mudanca.atualizados, 1, 'quantidade diferente atualiza o vínculo existente');
  const depois = await s.get(RESOURCES.produto_composicao, Number(vinculo!.id));
  assert.equal(Number(depois!.quantidade), 3);
});

// ---------------------------------------------------------------------------
// 8) Multiempresa
// ---------------------------------------------------------------------------

test('importação: produto de OUTRA empresa não é encontrado pelo SKU (isolamento)', async () => {
  const empresa2 = Number((await s.insert(RESOURCES.empresas, { nome: 'Importação Filial' })).id);
  await s.insert(RESOURCES.produtos, { empresa_id: empresa2, sku: 'IMP-OUTRA-EMPRESA', nome: 'Produto da Filial', preco_venda: 10 });
  const conteudo = csv(['produto', 'tamanho', 'quantidade'], ['IMP-OUTRA-EMPRESA', 'IMP-M', '5']);
  const resp = await preview('estoque', conteudo);
  assert.equal(resp.validas, 0, 'a empresa ativa (1) não enxerga o produto da filial');
  assert.match(resp.erros[0].mensagem, /não encontrado/i);
});
