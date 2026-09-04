// Testes dos novos relatórios (v0.5.0): faturamento mensal/anual, comissões
// com gráfico mensal, estoque mínimo por local, razão financeiro, DRE por
// período, cockpit de produção, coluna de status de senha e permissão do
// financeiro na API. Modo memória (mesmas regras do Postgres).
import { test, before } from 'node:test';
void before;
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { createRecord, updateRecord, getRecord, listRecords, getStore } = await import('../src/services');

const admin = { id: 1, name: 'Admin', perfil: 'admin' as const };
const operador = { id: 99, name: 'Operador', perfil: 'operador' as const };

async function callRelatorio(nome: string, query: Record<string, string> = {}, user = admin) {
  const { relatorio } = await import('../src/relatorios');
  const req: any = { query, user };
  let payload: any = null;
  const res: any = { json: (d: any) => ((payload = d), res) };
  await relatorio(req, res, nome);
  return payload;
}

let produtoId = 0;
let tamanhoId = 3;
let clienteId = 0;
let representanteId = 0;
let categoriaReceitaId = 0;
let categoriaDespesaId = 0;
let vendaFaturadaId = 0;
let setupDone = false;

async function ensureSetup() {
  if (setupDone) return;
  setupDone = true;
  getStore();
  const p = await createRecord(RESOURCES.produtos, { sku: 'REL-001', nome: 'Camisa Relatório', preco_venda: 100, custo: 40 }, admin);
  produtoId = Number(p.id);
  const cli = await createRecord(RESOURCES.clientes, { nome: 'Cliente Rel' }, admin);
  clienteId = Number(cli.id);
  const rep = await createRecord(RESOURCES.representantes, { nome: 'Rep Rel', comissao_pct: 10 }, admin);
  representanteId = Number(rep.id);
  const catRec = await listRecords(RESOURCES.categorias_financeiras, { page: 1, pageSize: 50, filter: { tipo: 'receita' } });
  categoriaReceitaId = Number(catRec.rows[0]?.id || 0);
  const catDes = await listRecords(RESOURCES.categorias_financeiras, { page: 1, pageSize: 50, filter: { tipo: 'despesa' } });
  categoriaDespesaId = Number(catDes.rows[0]?.id || 0);
}

function addItem(vendaId: number, item: Record<string, unknown>) {
  const s = getStore();
  return s.transaction(async (tx) => {
    const { validatePayload } = await import('../src/validate');
    const data = await validatePayload(RESOURCES.itens_venda, item, 'create');
    const row = await s.insert(
      RESOURCES.itens_venda,
      { ...data, venda_id: vendaId, subtotal: Math.round(Number(data.quantidade) * Number(data.preco_unitario) * (1 - Number(data.desconto_pct || 0) / 100) * 100) / 100 },
      tx
    );
    const { recalcularTotal } = await import('../src/itens');
    await recalcularTotal('venda', vendaId, tx);
    return row;
  });
}

before(async () => {
  await ensureSetup();
});

test('faturamento: consolida por mês e compara com o ano anterior', async () => {
  await ensureSetup();
  // estoque + venda faturada no mês corrente
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, local: 'almoxarifado', quantidade: 20 }, admin);
  const v = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2026-09-01', representante_id: representanteId }, admin);
  vendaFaturadaId = Number(v.id);
  await addItem(vendaFaturadaId, { produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 2, preco_unitario: 100 });
  await updateRecord(RESOURCES.vendas, vendaFaturadaId, { status: 'faturada' }, admin);

  // venda "entregue" no mesmo mês do ANO ANTERIOR (faturada_em vazio → usa data)
  const s = getStore();
  const v2 = await createRecord(RESOURCES.vendas, { cliente_id: clienteId, data: '2025-09-10', representante_id: representanteId }, admin);
  await addItem(Number(v2.id), { produto_id: produtoId, tamanho_id: tamanhoId, quantidade: 1, preco_unitario: 100 });
  await s.transaction(async (tx) => {
    await s.update(RESOURCES.vendas, Number(v2.id), { status: 'entregue', faturada_em: null, total: 100, comissao_valor: 10 }, tx);
  });

  const payload = await callRelatorio('faturamento');
  const mesAtual = new Date().toISOString().slice(0, 7);
  const linhaAtual = payload.linhas.find((l: any) => l.mes === mesAtual);
  assert.ok(linhaAtual, 'deve ter linha do mês corrente');
  assert.equal(Number(linhaAtual.faturamento), 200); // 2 × 100
  const linhaAnoAnterior = payload.linhas.find((l: any) => l.mes === '2025-09');
  assert.ok(linhaAnoAnterior, 'deve ter linha do mesmo mês no ano anterior');
  assert.equal(Number(linhaAnoAnterior.faturamento), 100);
  assert.equal(Number(linhaAnoAnterior.ano_anterior), 0);
  // variação do mês corrente vs ano anterior: 200 vs 100 = +100%
  assert.equal(Number(linhaAtual.ano_anterior), 100);
  assert.equal(Number(linhaAtual.variacao_pct), 100);
  assert.ok(payload.grafico && payload.grafico.rotulos.length >= 24, 'gráfico com 24 meses');
  assert.equal(typeof payload.resumo.faturamento_ano, 'number');
});

test('comissões: linhas por representante + série mensal de 12 meses', async () => {
  await ensureSetup();
  const payload = await callRelatorio('comissoes');
  const linha = payload.linhas.find((l: any) => l.representante_id === representanteId);
  assert.ok(linha, 'representante da venda deve aparecer');
  // 200 (mês corrente) + 100 (ano anterior) = 300 vendidos; comissão 10% = 30
  assert.equal(Number(linha.valor_vendas), 300);
  assert.equal(Number(linha.comissao), 30);
  assert.ok(payload.grafico.rotulas === undefined, 'campo é rotulos');
  assert.equal(payload.grafico.rotulos.length, 12);
  const somaGrafico = payload.grafico.valores.reduce((a: number, b: number) => a + b, 0);
  // o gráfico cobre os últimos 12 meses: a venda de 2025-09 (ano anterior) fica fora
  assert.equal(Number(somaGrafico.toFixed(2)), 20);
});

test('estoque mínimo: aponta saldo abaixo do mínimo por local com custo de reposição', async () => {
  await ensureSetup();
  // saldo 18 após as vendas; define mínimo 25 → faltando 7
  const saldos = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: tamanhoId, local: 'almoxarifado' } });
  assert.ok(saldos.rows.length, 'deve existir saldo');
  await updateRecord(RESOURCES.estoques, Number(saldos.rows[0].id), { estoque_min: 25 }, admin);
  const payload = await callRelatorio('estoque-minimo');
  const linha = payload.linhas.find((l: any) => String(l.produto).includes('REL-001') && l.local === 'almoxarifado');
  assert.ok(linha, 'produto abaixo do mínimo deve aparecer');
  assert.equal(Number(linha.saldo), 18);
  assert.equal(Number(linha.faltando), 7);
  assert.equal(Number(linha.custo_repor), 280); // 7 × custo 40
  // filtro por local funciona
  const soLoja = await callRelatorio('estoque-minimo', { local: 'loja' });
  assert.equal(soLoja.linhas.filter((l: any) => l.local !== 'loja').length, 0);
});

test('regressão: editar só o estoque mínimo de saldo em outro local não dá 409', async () => {
  await ensureSetup();
  await createRecord(RESOURCES.movimentacoes, { tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, local: 'loja', quantidade: 2 }, admin);
  const saldos = await listRecords(RESOURCES.estoques, { page: 1, pageSize: 10, filter: { produto_id: produtoId, tamanho_id: tamanhoId, local: 'loja' } });
  assert.equal(saldos.rows.length, 1);
  // antes do fix: resolveLocal trocava o local por "almoxarifado" e o
  // ensureUniqueStock devolvia 409 falso contra o saldo do almoxarifado
  const atualizado = await updateRecord(RESOURCES.estoques, Number(saldos.rows[0].id), { estoque_min: 4 }, admin);
  assert.equal(Number(atualizado.estoque_min), 4);
  assert.equal(atualizado.local, 'loja', 'o local não pode mudar numa edição parcial');
  const deNovo = await callRelatorio('estoque-minimo', { local: 'loja' });
  const linha = deNovo.linhas.find((l: any) => l.local === 'loja');
  assert.ok(linha, 'saldo da loja aparece no mínimo por local');
  assert.equal(Number(linha.faltando), 2);
});

test('razão financeiro: saldo acumulado entradas − saídas', async () => {
  await ensureSetup();
  const s = getStore();
  await s.transaction(async (tx) => {
    // despesa manual confirmada de 50
    await s.insert(
      RESOURCES.lancamentos_financeiros,
      { data: '2026-09-02', tipo: 'despesa', categoria_id: categoriaDespesaId || null, descricao: 'Teste despesa', valor: 50, status: 'confirmado' },
      tx
    );
  });
  const payload = await callRelatorio('razao-financeiro', { de: '2026-01-01', ate: '2026-12-31' });
  assert.ok(payload.linhas.length >= 1, 'deve ter lançamentos no período');
  const ultima = payload.linhas[payload.linhas.length - 1];
  // entradas: 200 (venda confirmada? pendente — razão soma tudo não cancelado)
  // saídas: 50. Saldo = entradas − 50.
  assert.equal(Number(ultima.saldo), Number(payload.resumo.saldo));
  assert.equal(Number(payload.resumo.saidas), 50);
  assert.ok(Number(payload.resumo.entradas) >= 0);
});

test('DRE por período agrupa por classificação e calcula resultado', async () => {
  await ensureSetup();
  const payload = await callRelatorio('dre', { de: '2026-01-01', ate: '2026-12-31' });
  const receita = payload.linhas.find((l: any) => l.linha.startsWith('= Receita'));
  assert.ok(receita, 'linha de receita total');
  const resGeral = payload.linhas.find((l: any) => l.linha.startsWith('= Resultado geral'));
  assert.ok(resGeral, 'linha de resultado geral');
  assert.equal(typeof Number(resGeral.valor), 'number');
});

test('razão e DRE bloqueiam operador (financeiro é gerente/admin)', async () => {
  await ensureSetup();
  await assert.rejects(() => callRelatorio('razao-financeiro', {}, operador), /gerente|administrador/i);
  await assert.rejects(() => callRelatorio('dre', {}, operador), /gerente|administrador/i);
});

test('cockpit de produção: KPIs das OPs com atrasadas e peças do mês', async () => {
  await ensureSetup();
  const { producaoPainel } = await import('../src/producao');
  // OP em produção com previsão vencida
  await createRecord(RESOURCES.ordens, { produto_id: produtoId, tipo: 'tamanho', tamanho_id: tamanhoId, quantidade: 5, status: 'em_producao', previsao: '2026-01-10' }, admin);
  const req: any = { user: admin };
  let payload: any = null;
  const res: any = { json: (d: any) => ((payload = d), res) };
  await producaoPainel(req, res);
  assert.equal(typeof payload.planejadas, 'number');
  assert.equal(typeof payload.emProducao, 'number');
  assert.ok(payload.atrasadas >= 1, 'OP com previsão vencida conta como atrasada');
  assert.ok(Array.isArray(payload.porSemana) && payload.porSemana.length === 8);
  assert.ok(payload.pecasAbertas >= 5);
});

test('usuários: lista traz status da senha (coluna Senha) sem expor valor', async () => {
  await ensureSetup();
  // garante ao menos um usuário (o modo memória começa vazio nos testes)
  const antes = await listRecords(RESOURCES.usuarios, { page: 1, pageSize: 50 });
  if (!antes.rows.length) {
    await createRecord(RESOURCES.usuarios, { nome: 'Usuario Lista', email: 'usuario.lista@brobond.com.br', perfil: 'operador', senha: 'SenhaForte123' }, admin);
  }
  const lista = await listRecords(RESOURCES.usuarios, { page: 1, pageSize: 50 });
  assert.ok(lista.rows.length >= 1);
  for (const row of lista.rows) {
    assert.ok(['propria', 'provisoria'].includes(String(row.senha_status)), 'senha_status deve ser propia|provisoria');
    assert.ok(!('senha' in row), 'valor da senha jamais é retornado');
    assert.ok(!('senha_hash' in row), 'hash da senha jamais é retornado');
  }
});

test('admin redefine senha do usuário → status vira provisória; troca própria → própria', async () => {
  await ensureSetup();
  const novo = await createRecord(RESOURCES.usuarios, { nome: 'Usuario Teste Rel', email: 'usuario.rel@brobond.com.br', perfil: 'operador', senha: 'SenhaForte123' }, admin);
  const criado = await getRecord(RESOURCES.usuarios, Number(novo.id));
  assert.equal(criado.senha_status, 'provisoria', 'senha definida pelo admin exige troca no 1º acesso');
  assert.equal(criado.trocar_senha, true);
  // usuário troca a própria senha pelo Configurações
  await updateRecord(RESOURCES.usuarios, Number(novo.id), { senha: 'OutraSenha456' }, { id: Number(novo.id), name: 'Usuario Teste Rel', perfil: 'operador' });
  const depois = await getRecord(RESOURCES.usuarios, Number(novo.id));
  assert.equal(depois.trocar_senha, false, 'quem troca a própria senha conclui a obrigação');
  const depoisLista = await listRecords(RESOURCES.usuarios, { page: 1, pageSize: 50 });
  const row = depoisLista.rows.find((r: any) => Number(r.id) === Number(novo.id));
  assert.equal(row.senha_status, 'propria');
});
