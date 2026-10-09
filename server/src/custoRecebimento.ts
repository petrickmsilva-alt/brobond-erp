// ============================================================================
// REGRA CANÔNICA DE CUSTO DE RECEBIMENTO DE COMPRA — GAP-COMP-CUSTOS
//
// ESTE É O ÚNICO LUGAR ONDE O CUSTO DE UMA ENTRADA DE COMPRA É CALCULADO.
//
// Por que este arquivo existe
// ---------------------------
// Antes dele, a mesma regra estava copiada em três lugares e cada uma fazia uma
// coisa diferente:
//
//   • itens.ts (receberCompra) ....... atualizava custo_medio ✔ e gravava
//                                      custo_unitario ✔
//   • compras.ts (receberParcial) .... NÃO atualizava custo_medio ✘ e gravava a
//                                      movimentação SEM custo_unitario ✘
//   • suprimentos.ts (importarXml) ... terceira cópia da média ponderada, só
//                                      para produto
//
// O dano era concreto, não teórico: o CMV do "Meu Negócio" sai de
// `insumos.custo_medio` (negocios.ts:511 — Σ consumo × (1+perda) × custo_medio).
// Compra recebida pelo caminho parcial subia o estoque sem mover o custo médio,
// então a margem de todo produto cuja ficha usa aquele insumo saía errada — e
// saía errada sem nenhum erro na tela.
//
// A REGRA (não foi inventada aqui)
// --------------------------------
// É a que o ERP já adota e que está documentada em
// docs/AUDITORIA-COMPLETA-2026.md ("Custo médio ponderado ao receber compra +
// reversão ao cancelar") e docs/AUDITORIA-2026-09-04.md ("Compra recebida →
// entrada de insumo → custo médio ponderado → lançamento financeiro"):
//
//     CUSTO MÉDIO PONDERADO
//     C_novo = (S_ant × C_ant + q × C_efetivo) / (S_ant + q)
//
// Este módulo apenas a implementa uma vez, com o custo efetivo completo.
//
// FRETE — critério e por que é este
// ---------------------------------
// Rateio PROPORCIONAL AO VALOR DA LINHA. Não é preferência estética: é o único
// critério que os dados existentes sustentam.
//   • `compras.frete` existe (NUMERIC(12,2));
//   • `itens_compra.quantidade` e `preco_unitario` existem;
//   • PESO NÃO EXISTE para insumo — `peso_*` só existe em `produtos` e na seção
//     Logística (resources.ts:1007-1009), ou seja, é dado de transporte, não de
//     custo, e não cobre insumo de jeito nenhum.
// Ratear por peso exigiria inventar dado. Ratear por valor é determinístico e
// auditável. O resíduo de arredondamento vai inteiro para a última linha (por
// item_compra_id), então Σ rateio == frete EXATAMENTE, sem centavo perdido.
//
// IMPOSTOS — o que este módulo NÃO faz
// ------------------------------------
// Não calcula imposto nenhum. Não existe no ERP regra de imposto recuperável vs
// não recuperável em compra (auditoria: `grep -rni recuperavel server/src`
// → nenhuma ocorrência de domínio fiscal). `dados_fiscais` é JSONB livre.
// Então `custo_impostos` só é preenchido com o que o chamador INFORMAR
// explicitamente como imposto que compõe custo. Nada é derivado de NCM, CFOP ou
// alíquota — isso seria fabricar contabilidade.
//
// ESTORNO — por que não é "voltar ao custo anterior"
// --------------------------------------------------
// A reversão usa a álgebra inversa da mesma fórmula e o custo gravado NA
// PRÓPRIA MOVIMENTAÇÃO (não o preço atual do item, que pode ter sido editado).
// E se o estoque já foi consumido a ponto de a reversão ficar impossível, ela
// RECUSA com 409 em vez de zerar o custo ou negativar o estoque.
// ============================================================================
import { HttpError } from './errors';
import { assertRegistroDaEmpresa, empresaDoRegistroAudit, type EscopoEmpresa } from './empresa';
import { getResource } from './resources';
import { getStore, resolveLocal, validarTamanhoNaGrade } from './services';
import { isDbConnected } from './db';
import type { Tx } from './store';
import { round2, round3 } from './utils';

const R_COMPRAS = () => getResource('compras')!;
const R_ITENS = () => getResource('itens_compra')!;
const R_INSUMOS = () => getResource('insumos')!;
const R_PRODUTOS = () => getResource('produtos')!;
const R_MOV = () => getResource('movimentacoes')!;
const R_MOV_INSUMO = () => getResource('movimentacoes_insumos')!;
const R_RECEBIMENTO = () => getResource('compra_recebimentos')!;

export type Actor = { id: number | null; name: string };

/** Uma linha a receber: o que entra no estoque e por qual preço. */
export type LinhaRecebimento = {
  item_compra_id: number;
  insumo_id: number | null;
  produto_id: number | null;
  tamanho_id: number | null;
  /** Quantidade DESTE recebimento — não a quantidade pedida. */
  quantidade: number;
  preco_unitario: number;
  local: string;
  local_id?: number | null;
};

export type CustoDaLinha = {
  item_compra_id: number;
  custo_frete_rateado: number;
  custo_impostos: number;
  custo_unitario_efetivo: number;
};

export type EntradaAplicada = CustoDaLinha & {
  insumo_id: number | null;
  produto_id: number | null;
  tamanho_id: number | null;
  quantidade: number;
  local: string;
  custo_medio_antes: number;
  custo_medio_depois: number;
};

// ---------------------------------------------------------------------------
// ARREDONDAMENTO — o ERP inteiro trabalha em reais com 2 casas
// ---------------------------------------------------------------------------

/**
 * Rateio do frete por valor de linha.
 *
 * Determinístico por construção: as linhas são percorridas em ordem de
 * `item_compra_id`, cada uma recebe sua parte arredondada, e a ÚLTIMA absorve o
 * resíduo. Assim `Σ rateio === freteTotal` ao centavo — sem o ajuste, ratear
 * R$ 10,00 entre 3 linhas iguais devolveria 9,99 ou 10,02.
 *
 * Frete zero, ou pedido sem valor, devolve tudo zerado (nunca divide por zero).
 */
export function ratearFretePorValor(
  freteTotal: number,
  linhas: { item_compra_id: number; quantidade: number; preco_unitario: number }[]
): Map<number, number> {
  const out = new Map<number, number>();
  const ordenadas = [...linhas].sort((a, b) => a.item_compra_id - b.item_compra_id);
  for (const l of ordenadas) out.set(l.item_compra_id, 0);

  const frete = round2(Number(freteTotal) || 0);
  if (!(frete > 0) || !ordenadas.length) return out;

  const valores = ordenadas.map((l) => Math.max(0, round3(Number(l.quantidade) || 0) * round2(Number(l.preco_unitario) || 0)));
  const base = round2(valores.reduce((a, b) => a + b, 0));
  if (!(base > 0)) return out; // pedido de valor zero: nada a ratear

  let acumulado = 0;
  ordenadas.forEach((l, i) => {
    if (i === ordenadas.length - 1) {
      // Última linha leva o resíduo — é o que fecha a conta no centavo.
      out.set(l.item_compra_id, round2(frete - acumulado));
      return;
    }
    const parte = round2((frete * valores[i]) / base);
    acumulado = round2(acumulado + parte);
    out.set(l.item_compra_id, parte);
  });
  return out;
}

/**
 * Custo unitário efetivo = preço + frete rateado + imposto que compõe custo,
 * tudo por unidade.
 *
 * `freteRateado` e `impostos` são TOTAIS DA LINHA (é assim que
 * `itens_compra.custo_frete_rateado` e `custo_impostos` são gravados), por isso
 * entram divididos pela quantidade.
 */
export function custoUnitarioEfetivo(
  precoUnitario: number,
  quantidade: number,
  freteRateado = 0,
  impostos = 0
): number {
  const preco = round2(Number(precoUnitario) || 0);
  const qtd = round3(Number(quantidade) || 0);
  if (preco < 0) throw new HttpError(422, `Preço unitário negativo (${preco}) — custo de compra não pode ser crédito.`);
  if (freteRateado < 0) throw new HttpError(422, `Frete rateado negativo (${freteRateado}).`);
  if (impostos < 0) throw new HttpError(422, `Impostos negativos (${impostos}).`);
  if (!(qtd > 0)) throw new HttpError(422, `Quantidade inválida (${qtd}) para calcular o custo unitário.`);
  const acessorios = round2((Number(freteRateado) || 0) + (Number(impostos) || 0));
  return round2(preco + acessorios / qtd);
}

/**
 * Média ponderada — a fórmula canônica do ERP.
 *
 * Saldo anterior zero (ou negativo, se algum ajuste deixou assim) → o custo
 * passa a ser o da entrada. Nunca divide por zero.
 */
export function mediaPonderada(saldoAnterior: number, custoAnterior: number, qtdEntrada: number, custoEntrada: number): number {
  const s = round3(Number(saldoAnterior) || 0);
  const q = round3(Number(qtdEntrada) || 0);
  if (s + q <= 0) return round2(Number(custoEntrada) || 0);
  return round2((s * (Number(custoAnterior) || 0) + q * (Number(custoEntrada) || 0)) / (s + q));
}

/**
 * Trava a linha do insumo/produto antes do read-modify-write do custo médio.
 *
 * Sem isto, dois recebimentos do mesmo insumo em transações "read committed"
 * leem o mesmo `custo_medio` e o segundo sobrescreve o primeiro — o clássico
 * lost update. `SELECT … FOR UPDATE` serializa os dois.
 *
 * Só existe no Postgres; no store em memória a transação já é exclusiva por
 * processo, então a chamada é um não-operação (e nunca quebra os testes).
 */
async function travarParaCusto(tabela: 'insumos' | 'produtos', id: number, tx: Tx): Promise<void> {
  if (!isDbConnected() || !tx) return;
  // Tx aqui é sempre o PoolClient do Postgres (a guarda acima já descartou null).
  await (tx as unknown as { query: (sql: string, p: unknown[]) => Promise<unknown> }).query(
    `SELECT id FROM ${tabela} WHERE id = $1 FOR UPDATE`,
    [id]
  );
}

/** Saldo da empresa do produto somando TODOS os locais (semântica já adotada). */
async function saldoProduto(produtoId: number, empresaId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const r = await s.list(getResource('estoques')!, { page: 1, pageSize: 10000, filter: { empresa_id: empresaId, produto_id: produtoId } }, tx);
  return round3(r.rows.reduce((acc, row) => acc + Number(row.quantidade || 0), 0));
}

// ---------------------------------------------------------------------------
// ENTRADA — o coração da regra
//
// Ordem exigida (qualquer falha → ROLLBACK da transação do chamador):
//   1. valida empresa  2. valida SKU/variação  3. valida quantidade
//   4. valida recebimento  5. calcula custo  6. grava movimentação
//   7. atualiza custo médio  8. grava auditoria  9. chamador conclui
// ---------------------------------------------------------------------------
export type AplicarEntradaArgs = {
  compraId: number;
  empresaId: number;
  /** NULL quando a entrada não vem de um recebimento registrado (ex.: XML). */
  recebimentoId: number | null;
  linhas: LinhaRecebimento[];
  /** `compras.frete` — rateado por valor de linha. */
  freteTotal: number;
  /** Imposto que compõe custo, por item. Só o que foi informado. */
  impostosPorItem?: Map<number, number>;
  actor: Actor;
  /** Ex.: `Compra #12` ou `Recebimento parcial — Compra #12`. */
  motivo: string;
  tx: Tx;
  escopo: EscopoEmpresa;
};

export async function aplicarEntradaDeCompra(args: AplicarEntradaArgs): Promise<EntradaAplicada[]> {
  const s = getStore();
  const { compraId, empresaId, recebimentoId, linhas, freteTotal, impostosPorItem, actor, motivo, tx, escopo } = args;

  // 1) EMPRESA — a compra é desta empresa? 404, nunca 403.
  const compra = assertRegistroDaEmpresa(R_COMPRAS(), await s.get(R_COMPRAS(), compraId, tx), escopo);
  if (Number(empresaId) !== escopo.empresaId || Number(compra.empresa_id) !== escopo.empresaId) throw new HttpError(404, 'Compra não encontrada.');
  if (String(compra.status) === 'cancelado') {
    throw new HttpError(409, `A compra #${compraId} está cancelada — não pode receber estoque.`);
  }

  // 4) RECEBIMENTO — se informado, precisa existir e ser desta compra.
  if (recebimentoId !== null) {
    const rec = await s.findOneWhere(R_RECEBIMENTO(), { id: recebimentoId, compra_id: compraId, empresa_id: escopo.empresaId }, tx);
    if (!rec) throw new HttpError(404, 'Recebimento não encontrado.');
  }

  const uteis = linhas.filter((l) => round3(l.quantidade) > 0);
  if (!uteis.length) return [];

  // 5a) FRETE — o frete é da COMPRA, não do lote. Ele precisa ser rateado UMA
  // única vez ao longo de TODOS os recebimentos, proporcional ao valor recebido.
  //
  // Antes cada recebimento parcial rateava o frete INTEIRO de novo: uma compra
  // de R$ 400 de frete recebida em dois lotes cobrava R$ 800 e o custo médio
  // ficava inflado sem nenhum erro na tela (58/un em vez de 54/un).
  //
  // Regra: freteDesteLote = frete × (valor deste lote / valor do pedido).
  // A soma sobre todos os lotes dá exatamente o frete. O ÚLTIMO lote absorve o
  // resíduo de arredondamento, e nunca se rateia mais do que falta.
  const itensDaCompra = (await s.list(R_ITENS(), { page: 1, pageSize: 1000, filter: { empresa_id: escopo.empresaId, compra_id: compraId } }, tx)).rows;
  const n2 = (v: unknown) => Number(v || 0);
  const valorDoPedido = round2(itensDaCompra.reduce((a, i) => a + round3(n2(i.quantidade)) * round2(n2(i.preco_unitario)), 0));
  const freteJaRateado = round2(itensDaCompra.reduce((a, i) => a + round2(n2(i.custo_frete_rateado)), 0));
  const valorDesteLote = round2(uteis.reduce((a, l) => a + round3(l.quantidade) * round2(l.preco_unitario), 0));
  const freteDaCompra = round2(n2(freteTotal));
  const freteRestante = round2(freteDaCompra - freteJaRateado);
  // `quantidade_recebida` já foi atualizada pelo chamador (receberParcial faz o
  // CAS ANTES de chamar aqui), então "nada falta" significa que este é o último.
  const algoFaltaReceber = itensDaCompra.some((i) => round3(n2(i.quantidade_recebida)) < round3(n2(i.quantidade)) - 1e-6);

  let freteDesteLote = 0;
  if (freteRestante > 0) {
    freteDesteLote =
      !algoFaltaReceber || valorDoPedido <= 0
        ? freteRestante
        : Math.min(freteRestante, round2((freteDaCompra * valorDesteLote) / valorDoPedido));
  }
  const rateio = ratearFretePorValor(freteDesteLote, uteis);

  const aplicadas: EntradaAplicada[] = [];

  for (const linha of uteis) {
    const itemCompra = await s.findOneWhere(R_ITENS(), {
      id: linha.item_compra_id,
      compra_id: compraId,
      empresa_id: escopo.empresaId,
    }, tx);
    if (!itemCompra) throw new HttpError(404, 'Item não encontrado nesta compra.');
    const idRef = (v: unknown) => v === null || v === undefined || v === '' ? null : Number(v);
    if (
      idRef(linha.produto_id) !== idRef(itemCompra.produto_id) ||
      idRef(linha.insumo_id) !== idRef(itemCompra.insumo_id) ||
      idRef(linha.tamanho_id) !== idRef(itemCompra.tamanho_id)
    ) throw new HttpError(404, 'Item não encontrado nesta compra.');
    const qtd = round3(linha.quantidade);

    // 3) QUANTIDADE
    if (!(qtd > 0)) throw new HttpError(422, `Quantidade inválida (${qtd}) no item #${linha.item_compra_id}.`);

    const custoFrete = round2(rateio.get(linha.item_compra_id) ?? 0);
    const custoImpostos = round2(
      impostosPorItem?.get(linha.item_compra_id) ?? Number(itemCompra.custo_impostos ?? 0)
    );

    // 2) SKU / VARIAÇÃO — e empresa do item também.
    const ehProduto = linha.produto_id !== null && linha.produto_id !== undefined;
    if (ehProduto) {
      const produtoId = Number(linha.produto_id);
      // 1/2) EMPRESA + existência do produto. 404, nunca 403.
      assertRegistroDaEmpresa(R_PRODUTOS(), await s.get(R_PRODUTOS(), produtoId, tx), escopo);
      // Tamanho é OPCIONAL: `estoques.tamanho_id` é nullable e o ERP mantém
      // saldo de produto sem variação. Exigir aqui seria mais rígido que o
      // modelo de dados (e que o recebimento parcial, que sempre aceitou).
      const tamanhoId = linha.tamanho_id === null || linha.tamanho_id === undefined ? null : Number(linha.tamanho_id);
      if (tamanhoId !== null) await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);
      const custoEfetivo = custoUnitarioEfetivo(linha.preco_unitario, qtd, custoFrete, custoImpostos);

      // Trava ANTES de ler o custo: sem isto dois recebimentos do mesmo produto
      // leem o mesmo custo_medio e o segundo sobrescreve o primeiro.
      await travarParaCusto('produtos', produtoId, tx);
      const produtoTravado = await s.get(R_PRODUTOS(), produtoId, tx);
      const saldoAntes = await saldoProduto(produtoId, escopo.empresaId, tx);
      const custoAntes = round2(Number(produtoTravado?.custo || 0));
      const custoDepois = mediaPonderada(saldoAntes, custoAntes, qtd, custoEfetivo);

      const localData: Record<string, unknown> = {};
      if (linha.local_id !== undefined && linha.local_id !== null) localData.local_id = linha.local_id;
      else if (linha.local) localData.local = linha.local;
      else if (compra.local_entrada) localData.local = compra.local_entrada;
      await resolveLocal(localData, tx, escopo);
      const local = String(localData.local);
      const localId = Number(localData.local_id);
      await s.adjustStock(produtoId, tamanhoId, local, Math.trunc(qtd), tx, localId, escopo.empresaId);
      // 7) CUSTO MÉDIO
      await s.update(R_PRODUTOS(), produtoId, { custo: custoDepois }, tx);
      // 6) MOVIMENTAÇÃO COM CUSTO
      await s.insert(
        R_MOV(),
        {
          empresa_id: empresaId,
          tipo: 'entrada',
          produto_id: produtoId,
          tamanho_id: tamanhoId,
          local,
          local_id: localId,
          quantidade: Math.trunc(qtd),
          motivo,
          compra_id: compraId,
          recebimento_id: recebimentoId,
          item_compra_id: linha.item_compra_id,
          custo_unitario: custoEfetivo,
          usuario_id: actor.id || null,
        },
        tx
      );
      // O rateio fica gravado no item da compra: é a trilha do "de onde veio".
      // ACUMULA, porque o mesmo item pode chegar em vários lotes — sobrescrever
      // apagaria a parcela do lote anterior e o frete total não fecharia mais.
      const itemAtual = itemCompra;
      const freteAcumulado = round2(round2(Number(itemAtual?.custo_frete_rateado || 0)) + custoFrete);
      const impostosAcumulados = round2(round2(Number(itemAtual?.custo_impostos || 0)) + custoImpostos);
      await s.update(R_ITENS(), linha.item_compra_id, { custo_frete_rateado: freteAcumulado, custo_impostos: impostosAcumulados }, tx);

      aplicadas.push({
        item_compra_id: linha.item_compra_id,
        custo_frete_rateado: custoFrete,
        custo_impostos: custoImpostos,
        custo_unitario_efetivo: custoEfetivo,
        insumo_id: null,
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        quantidade: Math.trunc(qtd),
        local,
        custo_medio_antes: custoAntes,
        custo_medio_depois: custoDepois,
      });
      continue;
    }

    const insumoId = Number(linha.insumo_id);
    if (!insumoId) throw new HttpError(422, `O item #${linha.item_compra_id} não tem insumo nem produto.`);
    assertRegistroDaEmpresa(R_INSUMOS(), await s.get(R_INSUMOS(), insumoId, tx), escopo);
    const custoEfetivo = custoUnitarioEfetivo(linha.preco_unitario, qtd, custoFrete, custoImpostos);

    await travarParaCusto('insumos', insumoId, tx);
    const insumoTravado = await s.get(R_INSUMOS(), insumoId, tx);
    const saldoAntes = round3(await s.insumoStock(insumoId, tx, escopo.empresaId));
    const custoAntes = round2(Number(insumoTravado?.custo_medio || 0));
    const custoDepois = mediaPonderada(saldoAntes, custoAntes, qtd, custoEfetivo);

    await s.adjustInsumoStock(insumoId, qtd, tx, escopo.empresaId);
    await s.update(R_INSUMOS(), insumoId, { custo_medio: custoDepois }, tx);
    await s.insert(
      R_MOV_INSUMO(),
      {
        empresa_id: empresaId,
        tipo: 'entrada',
        insumo_id: insumoId,
        quantidade: qtd,
        custo_unitario: custoEfetivo,
        motivo,
        compra_id: compraId,
        recebimento_id: recebimentoId,
        item_compra_id: linha.item_compra_id,
        usuario_id: actor.id || null,
      },
      tx
    );
    // Mesma regra do ramo de produtos: ACUMULA, não sobrescreve.
    const itemInsumoAtual = itemCompra;
    await s.update(
      R_ITENS(),
      linha.item_compra_id,
      {
        custo_frete_rateado: round2(round2(Number(itemInsumoAtual?.custo_frete_rateado || 0)) + custoFrete),
        custo_impostos: round2(round2(Number(itemInsumoAtual?.custo_impostos || 0)) + custoImpostos),
      },
      tx
    );

    aplicadas.push({
      item_compra_id: linha.item_compra_id,
      custo_frete_rateado: custoFrete,
      custo_impostos: custoImpostos,
      custo_unitario_efetivo: custoEfetivo,
      insumo_id: insumoId,
      produto_id: null,
      tamanho_id: null,
      quantidade: qtd,
      local: String(compra.local_entrada || ''),
      custo_medio_antes: custoAntes,
      custo_medio_depois: custoDepois,
    });
  }

  // 8) AUDITORIA
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'compras',
      registro_id: compraId,
      descricao: `Compra #${compraId}: entrada de ${aplicadas.length} item(ns) com custo efetivo (frete rateado ${round2(aplicadas.reduce((a, x) => a + x.custo_frete_rateado, 0)).toFixed(2)})`,
      dados: { recebimento_id: recebimentoId, motivo, aplicadas },
      empresa_id: empresaDoRegistroAudit(R_COMPRAS(), compra, actor),
    },
    tx
  );

  return aplicadas;
}

// ---------------------------------------------------------------------------
// ESTORNO — o caminho inverso
//
// Localiza as entradas POR VÍNCULO ESTRUTURAL (compra_id), nunca pelo texto do
// motivo. Foi exatamente a busca por texto que deixou as entradas de
// recebimento PARCIAL sem estorno: o parcial grava "Recebimento parcial —
// Compra #N" e o estorno procurava "Compra #N".
//
// O custo desfeito é o que está NA MOVIMENTAÇÃO, não o preço atual do item.
// Receber 40 un a R$ 50 e depois 60 un a R$ 55 não pode ser desfeito usando o
// preço de hoje.
// ---------------------------------------------------------------------------
export type EstornarResultado = {
  insumos: number;
  produtos: number;
  custoRestaurado: { tipo: 'insumo' | 'produto'; id: number; antes: number; depois: number }[];
};

export async function estornarEntradasDeCompra(args: {
  compraId: number;
  actor: Actor;
  motivo: string;
  tx: Tx;
  escopo: EscopoEmpresa;
}): Promise<EstornarResultado> {
  const s = getStore();
  const { compraId, actor, motivo, tx, escopo } = args;
  const compra = assertRegistroDaEmpresa(R_COMPRAS(), await s.get(R_COMPRAS(), compraId, tx), escopo);
  const out: EstornarResultado = { insumos: 0, produtos: 0, custoRestaurado: [] };

  // ---- produtos acabados ---------------------------------------------------
  const movProdutos = (
    await s.list(R_MOV(), { page: 1, pageSize: 2000, sort: 'id', dir: 'desc', filter: { empresa_id: escopo.empresaId, tipo: 'entrada', compra_id: compraId } }, tx)
  ).rows.filter((m) => String(m.tipo) === 'entrada' && Number(m.compra_id) === compraId && !m.estornado);

  for (const m of movProdutos) {
    const produtoId = Number(m.produto_id);
    const tamanhoId = m.tamanho_id === null || m.tamanho_id === undefined ? null : Number(m.tamanho_id);
    const qtd = Math.trunc(Number(m.quantidade));
    if (!(qtd > 0)) continue;
    assertRegistroDaEmpresa(R_PRODUTOS(), await s.get(R_PRODUTOS(), produtoId, tx), escopo);
    if (tamanhoId !== null) await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);
    if (m.recebimento_id !== null && m.recebimento_id !== undefined && !await s.findOneWhere(R_RECEBIMENTO(), { id: Number(m.recebimento_id), compra_id: compraId, empresa_id: escopo.empresaId }, tx)) {
      throw new HttpError(404, 'Recebimento não encontrado.');
    }
    const itemCompra = m.item_compra_id === null || m.item_compra_id === undefined ? null : await s.findOneWhere(R_ITENS(), { id: Number(m.item_compra_id), compra_id: compraId, empresa_id: escopo.empresaId }, tx);
    if (m.item_compra_id !== null && m.item_compra_id !== undefined && !itemCompra) throw new HttpError(404, 'Item não encontrado nesta compra.');
    if (m.local_id === null || m.local_id === undefined || Number(m.local_id) <= 0) {
      if (!String(m.local || '').trim()) throw new HttpError(409, 'Não é possível estornar uma entrada histórica sem local de estoque válido. Nenhum saldo foi alterado.');
    }
    const localData: Record<string, unknown> = {};
    if (m.local_id !== null && m.local_id !== undefined && Number(m.local_id) > 0) localData.local_id = Number(m.local_id);
    else localData.local = String(m.local || '').trim();
    await resolveLocal(localData, tx, escopo);
    const local = String(localData.local);
    const localId = Number(localData.local_id);

    // Baixa condicional: nunca transformar estoque consumido em negativo.
    const aplicado = await s.tryAdjustStock(produtoId, tamanhoId, local, -qtd, tx, 0, localId, escopo.empresaId);
    if (!aplicado) {
      throw new HttpError(
        409,
        `Não é possível estornar a compra #${compraId}: o produto ${produtoId} já foi consumido no local "${local}".`
      );
    }

    await travarParaCusto('produtos', produtoId, tx);
    const produto = await s.get(R_PRODUTOS(), produtoId, tx);
    const saldoDepois = await saldoProduto(produtoId, escopo.empresaId, tx);
    const saldoAntes = round3(saldoDepois + qtd);
    // Preço que REALMENTOU entrou. Movimentações antigas (anteriores à 0028) não
    // têm custo gravado — nesse caso cai no preço do item da compra.
    const custoEntrada = m.custo_unitario === null || m.custo_unitario === undefined
      ? round2(Number(itemCompra?.preco_unitario ?? 0))
      : round2(Number(m.custo_unitario));
    const custoAtual = round2(Number(produto?.custo || 0));
    if (saldoAntes <= 0) {
      throw new HttpError(409, `Não é possível estornar a compra #${compraId}: saldo inconsistente do produto ${produtoId}.`);
    }
    const custoRestaurado = saldoDepois > 0 ? round2((custoAtual * saldoAntes - qtd * custoEntrada) / saldoDepois) : 0;
    if (custoRestaurado < 0) {
      throw new HttpError(
        409,
        `Não é possível estornar a compra #${compraId}: o custo do produto ${produtoId} ficaria negativo. Houve movimentação posterior — ajuste o custo manualmente.`
      );
    }
    await s.update(R_PRODUTOS(), produtoId, { custo: custoRestaurado }, tx);
    out.custoRestaurado.push({ tipo: 'produto', id: produtoId, antes: custoAtual, depois: custoRestaurado });

    await s.insert(
      R_MOV(),
      {
        empresa_id: escopo.empresaId,
        tipo: 'saida',
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        local,
        local_id: localId,
        quantidade: qtd,
        compra_id: compraId,
        recebimento_id: m.recebimento_id ?? null,
        item_compra_id: m.item_compra_id ?? null,
        custo_unitario: custoEntrada,
        motivo,
        usuario_id: actor.id || null,
      },
      tx
    );
    out.produtos++;
  }

  // ---- insumos -------------------------------------------------------------
  // Agora por VÍNCULO (compra_id), não por texto de motivo.
  const movInsumos = (
    await s.list(R_MOV_INSUMO(), { page: 1, pageSize: 2000, sort: 'id', dir: 'desc', filter: { empresa_id: escopo.empresaId, tipo: 'entrada', compra_id: compraId } }, tx)
  ).rows.filter((m) => String(m.tipo) === 'entrada' && Number(m.compra_id) === compraId);

  for (const m of movInsumos) {
    const insumoId = Number(m.insumo_id);
    const qtd = round3(Number(m.quantidade));
    if (!(qtd > 0)) continue;
    assertRegistroDaEmpresa(R_INSUMOS(), await s.get(R_INSUMOS(), insumoId, tx), escopo);
    if (m.recebimento_id !== null && m.recebimento_id !== undefined && !await s.findOneWhere(R_RECEBIMENTO(), { id: Number(m.recebimento_id), compra_id: compraId, empresa_id: escopo.empresaId }, tx)) {
      throw new HttpError(404, 'Recebimento não encontrado.');
    }
    if (m.item_compra_id !== null && m.item_compra_id !== undefined && !await s.findOneWhere(R_ITENS(), { id: Number(m.item_compra_id), compra_id: compraId, empresa_id: escopo.empresaId }, tx)) {
      throw new HttpError(404, 'Item não encontrado nesta compra.');
    }

    await travarParaCusto('insumos', insumoId, tx);
    const saldoDepois = round3(await s.insumoStock(insumoId, tx, escopo.empresaId));
    const saldoAntes = round3(saldoDepois - qtd);
    if (saldoAntes < 0) {
      throw new HttpError(
        409,
        `Não é possível estornar a compra #${compraId}: o insumo ${insumoId} já foi consumido (restam ${saldoDepois}, o estorno precisa de ${qtd}).`
      );
    }

    const insumo = await s.get(R_INSUMOS(), insumoId, tx);
    const custoEntrada = round2(Number(m.custo_unitario || 0));
    const custoAtual = round2(Number(insumo?.custo_medio || 0));
    const custoRestaurado = saldoAntes > 0 ? round2((custoAtual * saldoDepois - qtd * custoEntrada) / saldoAntes) : 0;
    if (custoRestaurado < 0) {
      throw new HttpError(
        409,
        `Não é possível estornar a compra #${compraId}: o custo médio do insumo ${insumoId} ficaria negativo. Houve movimentação posterior — ajuste o custo manualmente.`
      );
    }

    await s.adjustInsumoStock(insumoId, -qtd, tx, escopo.empresaId);
    await s.update(R_INSUMOS(), insumoId, { custo_medio: custoRestaurado }, tx);
    out.custoRestaurado.push({ tipo: 'insumo', id: insumoId, antes: custoAtual, depois: custoRestaurado });

    await s.insert(
      R_MOV_INSUMO(),
      {
        empresa_id: Number(compra.empresa_id),
        tipo: 'saida',
        insumo_id: insumoId,
        quantidade: qtd,
        custo_unitario: custoEntrada,
        compra_id: compraId,
        recebimento_id: m.recebimento_id ?? null,
        item_compra_id: m.item_compra_id ?? null,
        motivo,
        usuario_id: actor.id || null,
      },
      tx
    );
    out.insumos++;
  }

  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'estornar',
      recurso: 'compras',
      registro_id: compraId,
      descricao: `Compra #${compraId}: estorno de ${out.insumos} entrada(s) de insumo e ${out.produtos} de produto, com custo médio restaurado`,
      dados: out,
      empresa_id: empresaDoRegistroAudit(R_COMPRAS(), compra, actor),
    },
    tx
  );

  return out;
}
