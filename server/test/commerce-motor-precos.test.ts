// ============================================================================
// COMMERCE ENGINE › MOTOR DE PREÇOS E RENTABILIDADE (testes em memória).
//
// O que precisa ser verdade:
//   • o preço por CONDIÇÃO de pagamento é dado de ENTRADA (oficial), não fórmula;
//   • a ordem de resolução é fixa: condição (FINAL) → lista → base, com o
//     desconto da política só incidindo onde é autorizado;
//   • desconto sobre preço de condição exige AUTORIZAÇÃO EXPLÍCITA (política com
//     `autoriza_cumulativo` ou regra de desconto cumulativo);
//   • canal sem preço NÃO cai para outro canal: `null`, nunca chute;
//   • a margem é INFORMAÇÃO até o bloqueio ser ligado (nunca um limite inventado);
//   • a memória de precificação é gravada e auditável.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;

const { RESOURCES } = await import('../src/resources');
const { getStore } = await import('../src/services');
const { escopoDeSistema } = await import('../src/empresa');
const {
  precoBaseDoCanal,
  precoCondicao,
  precoCondicaoDetalhe,
  resolverPrecoComercial,
  avaliarRentabilidade,
  avaliarPrecoMinimo,
  registrarMemoriaPrecificacao,
} = await import('../src/commerce/motorPrecos');

const escopo = escopoDeSistema(1);
let seq = 0;

async function produtoNovo(over: Record<string, unknown> = {}) {
  const s = getStore();
  seq += 1;
  return s.insert(RESOURCES.produtos, {
    empresa_id: 1,
    sku: `SKU-MP-${Date.now().toString(36)}-${seq}`,
    nome: 'Camiseta Motor de Preços',
    preco_venda: 100,
    preco_atacado: 60,
    ativo: true,
    ...over,
  });
}

describe('motor de preços — base do canal (nunca cruza canal)', () => {
  test('o preço-base do canal vem da ficha (varejo/atacado)', () => {
    assert.equal(precoBaseDoCanal({ preco_venda: 100, preco_atacado: 60 }, 'varejo'), 100);
    assert.equal(precoBaseDoCanal({ preco_venda: 100, preco_atacado: 60 }, 'atacado'), 60);
  });

  test('canal ATACADO sem preço próprio NÃO cai para o varejo: fica null', () => {
    assert.equal(precoBaseDoCanal({ preco_venda: 100 }, 'atacado'), null, 'cobrar o varejo no atacado seria inventar preço');
    assert.equal(precoBaseDoCanal({ preco_venda: 0, preco_atacado: 0 }, 'varejo'), null);
    assert.equal(precoBaseDoCanal({ preco_venda: 100 }, 'varejo'), 100);
  });
});

describe('motor de preços — condição de pagamento (dado de entrada)', () => {
  test('preço por condição é lido do cadastro; ausente → null (nunca chute)', async () => {
    const s = getStore();
    const p = await produtoNovo();
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30_60', preco: 54.9 });
    assert.equal(await precoCondicao(Number(p.id), 'atacado', 'boleto_30_60', escopo), 54.9);
    assert.equal(await precoCondicao(Number(p.id), 'atacado', 'inexistente', escopo), null);
    assert.equal(await precoCondicao(Number(p.id), 'atacado', null, escopo), null);
  });

  test('a vigência responde "quanto valia nesta data" sem apagar o preço anterior', async () => {
    const s = getStore();
    const p = await produtoNovo();
    // Preço antigo (vigência fechada em 2025-06-30) + preço atual (vigente).
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30', preco: 40, vigencia_inicio: '2025-01-01', vigencia_fim: '2025-06-30' });
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30', preco: 45, vigencia_inicio: '2025-07-01', vigencia_fim: null });
    assert.equal(await precoCondicao(Number(p.id), 'atacado', 'boleto_30', escopo), 45, 'vigente = a linha sem fim');
    assert.equal(await precoCondicao(Number(p.id), 'atacado', 'boleto_30', escopo, undefined, '2025-03-15'), 40, 'histórico');
    const det = await precoCondicaoDetalhe(Number(p.id), 'atacado', 'boleto_30', escopo);
    assert.equal(det?.preco, 45);
    assert.equal(det?.vigencia_inicio, '2025-07-01');
  });

  test('resolverPrecoComercial: condição é FINAL — desconto só com autorização', async () => {
    const s = getStore();
    const p = await produtoNovo({ preco_venda: 100, preco_atacado: 60 });
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30_60', preco: 54.9 });
    // Política geral de 10% no atacado, SEM autorizar cumulatividade.
    await s.insert(RESOURCES.politicas_comerciais, { empresa_id: 1, nome: 'Geral atacado 10%', escopo: 'geral', canal: 'atacado', desconto_pct: 10, ativo: true, prioridade: 0, autoriza_cumulativo: false });

    // Sem condição: a política desconta sobre a base do canal.
    const semCond = await resolverPrecoComercial({ produto: p, canal: 'atacado', escopo });
    assert.equal(semCond.preco_lista, 60, 'sem lista, o preço de lista é a base do canal');
    assert.equal(semCond.preco_aplicado, 54, '60 − 10% = 54');
    assert.equal(semCond.origem_preco, 'produto');

    // Com condição: o preço oficial é FINAL (nenhum desconto sobreposto).
    const comCond = await resolverPrecoComercial({ produto: p, canal: 'atacado', condicao: 'boleto_30_60', escopo });
    assert.equal(comCond.preco_condicao, 54.9);
    assert.equal(comCond.origem_preco, 'condicao');
    assert.equal(comCond.preco_aplicado, 54.9, 'sem autorização, a condição é final');
    assert.equal(comCond.desconto_pct, 0);
    assert.equal(comCond.regras.autoriza_cumulativo, false);
  });

  test('a cumulatividade SÓ incide com autorização explícita (política ou regra)', async () => {
    const s = getStore();
    const p = await produtoNovo({ preco_venda: 100, preco_atacado: 60 });
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30_60', preco: 50 });
    await s.insert(RESOURCES.politicas_comerciais, { empresa_id: 1, nome: 'Cumulativa 5%', escopo: 'geral', canal: 'atacado', desconto_pct: 5, ativo: true, prioridade: 0, autoriza_cumulativo: true });
    const r = await resolverPrecoComercial({ produto: p, canal: 'atacado', condicao: 'boleto_30_60', escopo });
    assert.equal(r.preco_aplicado, 47.5, '50 − 5% (autorizado) = 47,50');
    assert.equal(r.desconto_pct, 5);
  });

  test('uma regra de desconto cumulativo soma com a política autorizada', async () => {
    const s = getStore();
    const p = await produtoNovo({ preco_venda: 100, preco_atacado: 60 });
    await s.insert(RESOURCES.produto_precos_condicao, { empresa_id: 1, produto_id: Number(p.id), canal: 'atacado', condicao: 'boleto_30_60', preco: 50 });
    await s.insert(RESOURCES.politicas_comerciais, { empresa_id: 1, nome: 'Cumulativa 5%', escopo: 'geral', canal: 'atacado', desconto_pct: 5, ativo: true, prioridade: 0, autoriza_cumulativo: true });
    await s.insert(RESOURCES.politica_comercial_descontos_cumulativos, { empresa_id: 1, nome: 'Acordo 10% boleto', escopo: 'condicao', condicao: 'boleto_30_60', desconto_pct: 10, ativo: true, prioridade: 0 });
    const r = await resolverPrecoComercial({ produto: p, canal: 'atacado', condicao: 'boleto_30_60', escopo });
    assert.equal(r.desconto_pct, 15, '5% (política) + 10% (regra) = 15%');
    assert.equal(r.preco_aplicado, 42.5, '50 − 15% = 42,50');
    assert.ok(r.regras.desconto_cumulativo_id);
  });

  test('canal atacado sem base e sem condição → preco_aplicado null (nunca inventa)', async () => {
    const p = await produtoNovo({ preco_venda: 100, preco_atacado: null });
    const r = await resolverPrecoComercial({ produto: p, canal: 'atacado', escopo });
    assert.equal(r.preco_aplicado, null);
    assert.equal(r.preco_base, null);
    assert.equal(r.regras.preco_ausente, true);
  });

  test('a lista de preço vigente vence a base da ficha', async () => {
    const s = getStore();
    const p = await produtoNovo({ preco_venda: 100 });
    const lista = await s.insert(RESOURCES.listas_preco, { empresa_id: 1, nome: 'Atacado Especial', ativo: true, prioridade: 5 });
    await s.insert(RESOURCES.lista_preco_itens, { empresa_id: 1, lista_id: Number(lista.id), produto_id: Number(p.id), preco: 80 });
    const r = await resolverPrecoComercial({ produto: p, canal: 'varejo', escopo });
    assert.equal(r.preco_lista, 80);
    assert.equal(r.origem_preco, 'lista');
  });
});

describe('motor de preços — rentabilidade (função pura)', () => {
  test('margem de contribuição = receita − custo − impostos − frete − taxas', () => {
    const r = avaliarRentabilidade({ preco_aplicado: 100, quantidade: 2, custo: 30, impostos: 12, frete: 8, taxas: 5 });
    assert.equal(r.receita_liquida, 200);
    assert.equal(r.custo, 60);
    assert.equal(r.margem_valor, 200 - 60 - 12 - 8 - 5);
    assert.equal(r.margem_pct, 57.5);
  });

  test('receita zero → margem_pct null (nunca 0% enganoso)', () => {
    const r = avaliarRentabilidade({ preco_aplicado: 0, quantidade: 1, custo: 10 });
    assert.equal(r.margem_pct, null);
    assert.equal(r.margem_valor, -10);
  });
});

describe('motor de preços — preço mínimo / alçada', () => {
  const rent = (margem_pct: number) => ({ receita_liquida: 100, custo: 0, impostos: 0, frete: 0, taxas: 0, margem_valor: margem_pct, margem_pct });

  test('sem política ou com bloqueio DESLIGADO, apenas informa (nunca bloqueia)', () => {
    const semPolitica = avaliarPrecoMinimo({ rentabilidade: rent(5), desconto_pct: 30, politica: null });
    assert.equal(semPolitica.bloqueado, false);

    const desligada = avaliarPrecoMinimo({
      rentabilidade: rent(5), desconto_pct: 30,
      politica: { margem_minima_pct: 20, desconto_max_pct: 10, bloqueio_ativo: false, exige_justificativa: true },
    });
    assert.equal(desligada.bloqueado, false, 'o limite só vale com o bloqueio ligado');
  });

  test('com bloqueio LIGADO, margem/desconto fora do limite bloqueiam com motivo', () => {
    const r = avaliarPrecoMinimo({
      rentabilidade: rent(5), desconto_pct: 30,
      politica: { margem_minima_pct: 20, desconto_max_pct: 10, bloqueio_ativo: true, exige_justificativa: true },
    });
    assert.equal(r.bloqueado, true);
    assert.equal(r.exige_justificativa, true);
    assert.equal(r.motivos.length, 2);
  });
});

describe('motor de preços — memória de precificação', () => {
  test('grava a origem do cálculo (append-only) e devolve o id', async () => {
    const s = getStore();
    const p = await produtoNovo();
    const usuario = await s.insert(RESOURCES.usuarios, { nome: 'Auditor', email: `aud-${Math.random().toString(36).slice(2, 8)}@x.com`, perfil: 'admin', ativo: true });
    const id = await registrarMemoriaPrecificacao({
      canal: 'atacado', produto_id: Number(p.id), quantidade: 2, condicao: 'boleto_30_60',
      preco_lista: 60, preco_aplicado: 54, desconto_pct: 10, custo: 30, impostos: 6, frete: 4, taxas: 2,
      margem_valor: 54 - 30 - 6 - 4 - 2, margem_pct: 22.22, origem_preco: 'condicao',
      regras: { politica_id: 7 }, criado_por: Number(usuario.id),
    });
    assert.ok(id && id > 0);
    const linha = await s.get(RESOURCES.precificacao_memoria, id!);
    assert.ok(linha);
    assert.equal(Number(linha!.preco_aplicado), 54);
    assert.equal(Number(linha!.margem_valor), 12);
    assert.equal(linha!.origem_preco, 'condicao');
    assert.equal((linha!.regras as any).politica_id, 7);
  });
});
