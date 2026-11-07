// ============================================================================
// AGENTE 07 — A06-06: COMISSÃO DIVIDIDA (principal + secundário) E AJUSTE
// PÓS-RECEBIMENTO.
//
// O achado: com mais de um representante, só o PRINCIPAL entrava no livro de
// efetivação e nos relatórios; a reapuração DEPOIS de a venda já ter sido
// recebida não gerava evento de ajuste — o livro não fechava.
//
// Este arquivo prova, no modo memória, que:
//   • a apuração grava uma linha por representante (secundário incluído);
//   • a efetivação por recebimento cria evento para CADA representante;
//   • a reapuração pós-recebimento gera evento de AJUSTE (nunca sobrescreve);
//   • o resumo de comissões mostra a comissão secundária.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES, getResource } = await import('../src/resources');
const { apurarComissaoDaVenda, R_COMISSOES_APURADAS } = await import('../src/comercial');
const { registrarComissaoPorRecebimento, alvosComissaoDaVenda, R_COMISSOES_EVENTOS, resumoComissoes } = await import('../src/comissoes');
const { createRecord, getStore } = await import('../src/services');
const { escopoDoAtor } = await import('../src/empresa');
const { ADMIN, criarAtor, garantirAdmin, novoCliente, novoProduto, reqDe, resFake } = await import('./_p1util');

await garantirAdmin();

const s = getStore();
let seq = 0;
const sufixo = `${Date.now() % 1000000}`;

async function novoRepresentante(empresa: number, comissaoPct = 5) {
  seq++;
  return s.insert(RESOURCES.representantes, { empresa_id: empresa, nome: `Rep A06-06 ${sufixo} ${seq}`, comissao_pct: comissaoPct, ativo: true });
}

async function vendaComItens(empresa: number, repPrincipal: number, total: number, quantidade: number, preco: number) {
  const cliente = await novoCliente({ empresa_id: empresa });
  const produto = await novoProduto({ empresa_id: empresa, preco_venda: preco });
  const tamanho = await s.insert(RESOURCES.tamanhos, { codigo: `A07C${++seq}` });
  const venda = await s.insert(RESOURCES.vendas, {
    empresa_id: empresa,
    cliente_id: Number(cliente.id),
    representante_id: repPrincipal,
    data: '2026-10-01',
    status: 'aberta',
    total,
  });
  await s.insert(RESOURCES.itens_venda, {
    empresa_id: empresa,
    venda_id: Number(venda.id),
    produto_id: Number(produto.id),
    tamanho_id: Number(tamanho.id),
    quantidade,
    preco_unitario: preco,
    desconto_pct: 0,
    subtotal: quantidade * preco,
  });
  return venda;
}

async function planoComRegra(ator: any, valor: number) {
  const plano = await createRecord(getResource('planos_comissao')!, {
    nome: `Plano A07 ${sufixo} ${++seq}`,
    base_calculo: 'faturamento',
    momento_efetivacao: 'recebimento',
    vigencia_inicio: '2026-01-01',
    status: 'ativo',
    prioridade: 0,
  }, ator);
  const regra = await createRecord(getResource('regras_comissao')!, {
    plano_id: Number(plano.id),
    escopo: 'geral',
    tipo_valor: 'percentual',
    valor,
    base: 'bruto',
    status: 'ativa',
  }, ator);
  return { plano, regra };
}

test('A06-06: apuração grava linha para CADA representante (secundário incluído)', async () => {
  const ator = await criarAtor(1, 'gerente');
  const repPrincipal = await novoRepresentante(1);
  const repSecundario = await novoRepresentante(1);
  await planoComRegra(ator, 10);

  const venda = await vendaComItens(1, Number(repPrincipal.id), 1000, 10, 100);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repPrincipal.id), papel: 'principal', participacao_pct: 60 }, ator);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repSecundario.id), papel: 'secundario', participacao_pct: 40 }, ator);
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'faturada' });

  const apuracao = await apurarComissaoDaVenda(s, Number(venda.id), { id: ator.id, name: ator.name }, escopoDoAtor(ator));
  assert.equal(apuracao.representantes.length, 2, 'principal E secundário');
  assert.equal(apuracao.total, 100, '10% de 1.000');
  const porRep = new Map(apuracao.representantes.map((r) => [r.representante_id, r.valor]));
  assert.equal(porRep.get(Number(repPrincipal.id)), 60);
  assert.equal(porRep.get(Number(repSecundario.id)), 40, 'a comissão secundária NÃO é perdida');

  const linhas = await s.list(R_COMISSOES_APURADAS, { page: 1, pageSize: 50, filter: { venda_id: Number(venda.id) } });
  assert.equal(linhas.rows.filter((r: any) => r.status === 'apurada').length, 2, 'duas linhas ativas (uma por representante)');
});

test('A06-06: efetivação por recebimento cria evento para o principal E o secundário', async () => {
  const ator = await criarAtor(1, 'gerente');
  const repPrincipal = await novoRepresentante(1);
  const repSecundario = await novoRepresentante(1);
  await planoComRegra(ator, 10);

  const venda = await vendaComItens(1, Number(repPrincipal.id), 1000, 10, 100);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repPrincipal.id), papel: 'principal', participacao_pct: 50 }, ator);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repSecundario.id), papel: 'secundario', participacao_pct: 50 }, ator);
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'faturada' });
  await apurarComissaoDaVenda(s, Number(venda.id), { id: ator.id, name: ator.name }, escopoDoAtor(ator));

  const vendaAtual = (await s.get(RESOURCES.vendas, Number(venda.id)))!;
  const alvos = await alvosComissaoDaVenda(vendaAtual);
  assert.equal(alvos.length, 2, 'o livro enxerga os dois representantes');

  const eventos = await s.transaction((tx) =>
    registrarComissaoPorRecebimento(vendaAtual, null, 1000, 'teste', { id: ator.id, name: ator.name }, tx)
  );
  assert.equal(eventos.length, 2, 'um evento por representante');
  const reps = new Set(eventos.map((e: any) => Number(e.representante_id)));
  assert.ok(reps.has(Number(repPrincipal.id)) && reps.has(Number(repSecundario.id)));
});

test('A06-06: reapuração DEPOIS do recebimento gera evento de AJUSTE (livro fecha)', async () => {
  const ator = await criarAtor(1, 'gerente');
  const repPrincipal = await novoRepresentante(1);
  const repSecundario = await novoRepresentante(1);
  const { regra } = await planoComRegra(ator, 10);

  const venda = await vendaComItens(1, Number(repPrincipal.id), 1000, 10, 100);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repPrincipal.id), papel: 'principal', participacao_pct: 50 }, ator);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repSecundario.id), papel: 'secundario', participacao_pct: 50 }, ator);
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'faturada' });
  await apurarComissaoDaVenda(s, Number(venda.id), { id: ator.id, name: ator.name }, escopoDoAtor(ator));

  // Recebimento integral: cada um efetiva 50 (10% de 1.000, participação 50%).
  const vendaAtual = (await s.get(RESOURCES.vendas, Number(venda.id)))!;
  await s.transaction((tx) => registrarComissaoPorRecebimento(vendaAtual, null, 1000, 'recebimento', { id: ator.id, name: ator.name }, tx));

  // A regra muda para 20% e a comissão é REAPURADA após o recebimento.
  await s.update(RESOURCES.regras_comissao, Number(regra.id), { valor: 20 });
  const segunda = await apurarComissaoDaVenda(s, Number(venda.id), { id: ator.id, name: ator.name }, escopoDoAtor(ator));
  assert.equal(segunda.recalculada, true);
  assert.equal(segunda.total, 200, '20% de 1.000');

  // O livro tem eventos de AJUSTE fechando a diferença, sem apagar o histórico.
  const eventos = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 200, filter: { venda_id: Number(venda.id) } });
  const ajustes = eventos.rows.filter((e: any) => e.origem === 'ajuste');
  assert.equal(ajustes.length, 2, 'um ajuste por representante');
  // Saldo por representante fecha em 100 (20% de 1.000 × 50%).
  for (const repId of [Number(repPrincipal.id), Number(repSecundario.id)]) {
    const doRep = eventos.rows.filter((e: any) => Number(e.representante_id) === repId);
    const saldo = doRep.reduce((acc: number, e: any) => acc + (e.tipo === 'estornada' ? -Number(e.valor) : Number(e.valor)), 0);
    assert.ok(Math.abs(saldo - 100) < 0.01, `saldo do representante #${repId} fecha em 100 (veio ${saldo})`);
  }
  // Nenhuma apuração anterior foi apagada — só estornada.
  const apuracoes = await s.list(R_COMISSOES_APURADAS, { page: 1, pageSize: 50, filter: { venda_id: Number(venda.id) } });
  assert.equal(apuracoes.rows.filter((r: any) => r.status === 'estornada').length, 2, 'histórico preservado');
  assert.equal(apuracoes.rows.filter((r: any) => r.status === 'apurada').length, 2);
});

test('A06-06: resumo de comissões mostra a comissão SECUNDÁRIA', async () => {
  const ator = await criarAtor(1, 'gerente');
  const repPrincipal = await novoRepresentante(1);
  const repSecundario = await novoRepresentante(1);
  await planoComRegra(ator, 10);

  const venda = await vendaComItens(1, Number(repPrincipal.id), 1000, 10, 100);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repPrincipal.id), papel: 'principal', participacao_pct: 60 }, ator);
  await createRecord(getResource('venda_atribuicao')!, { venda_id: Number(venda.id), representante_id: Number(repSecundario.id), papel: 'secundario', participacao_pct: 40 }, ator);
  await s.update(RESOURCES.vendas, Number(venda.id), { status: 'faturada', faturada_em: '2026-10-02T10:00:00.000Z' });
  await apurarComissaoDaVenda(s, Number(venda.id), { id: ator.id, name: ator.name }, escopoDoAtor(ator));

  const { res, saida } = resFake();
  await resumoComissoes(reqDe({}, { query: { de: '2026-10-01', ate: '2026-10-31' }, user: ator }), res);
  const linhas = saida.json.linhas as any[];
  const doSecundario = linhas.find((l) => Number(l.representante_id) === Number(repSecundario.id));
  assert.ok(doSecundario, 'o representante secundário aparece no resumo');
  assert.equal(Number(doSecundario.apurada), 40, 'comissão secundária apurada (10% × 40%)');
  const doPrincipal = linhas.find((l) => Number(l.representante_id) === Number(repPrincipal.id));
  assert.equal(Number(doPrincipal.apurada), 60);
});

test('A06-07: operador sem vínculo é recusado em resumo E no livro da venda (403)', async () => {
  const ator = await criarAtor(1, 'gerente');
  const operador = await criarAtor(1, 'operador');
  const rep = await novoRepresentante(1);
  const venda = await vendaComItens(1, Number(rep.id), 100, 1, 100);

  // Chamada direta à API (não é ocultação de menu): 403.
  await assert.rejects(
    () => resumoComissoes(reqDe({}, { user: operador }), resFake().res),
    (e: any) => e.status === 403,
    'operador não lê o resumo de comissões'
  );
  await assert.rejects(
    () => import('../src/comissoes').then(({ comissoesDaVenda }) => comissoesDaVenda(reqDe({}, { params: { id: Number(venda.id) }, user: operador }), resFake().res)),
    (e: any) => e.status === 403,
    'operador não lê o livro de comissões da venda'
  );

  // Gerente lê normalmente.
  const { res } = resFake();
  await resumoComissoes(reqDe({}, { user: ator }), res);
});

void ADMIN;
