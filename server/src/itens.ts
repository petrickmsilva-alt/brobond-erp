// ============================================================
// Pedidos de venda e compra — itens e regras de negócio (Fase 2).
//
// Rotas (sub-recursos genéricos, no mesmo padrão de uploads.ts):
//   GET    /api/vendas/:id/itens            lista os itens do pedido
//   POST   /api/vendas/:id/itens            adiciona item (recalcula total)
//   PUT    /api/vendas/:id/itens/:itemId    altera item
//   DELETE /api/vendas/:id/itens/:itemId    remove item
//   (idem /api/compras/:id/itens)
//
// Regras:
//   • total do pedido é SEMPRE calculado pelo servidor (o campo é readonly);
//   • venda → ao faturar, sai do estoque (local de saída, com fallback
//     para o Local padrão); cancelar pedido faturado/entregue estorna;
//   • compra → ao receber, entra insumo no estoque e atualiza o custo médio
//     ponderado; cancelar compra recebida estorna;
//   • pedidos faturados/recebidos ficam travados para edição de itens.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, escopoDe, getDefaultLocalInfo, getStore, resolveLocal, toHttpError, validarTamanhoNaGrade } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa, validarReferenciasDaEmpresa, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { aplicarEntradaDeCompra, estornarEntradasDeCompra } from './custoRecebimento';
import type { Row, Tx } from './store';
import { parseId, validatePayload } from './validate';
import { labelOf } from './store';
import { attachImages } from './uploads';
import { round2, round3 } from './utils';

type TipoPedido = 'venda' | 'compra';

function pedidoConfig(tipo: TipoPedido) {
  return tipo === 'venda'
    ? {
        parent: getResource('vendas')!,
        itens: getResource('itens_venda')!,
        parentCol: 'venda_id',
        itemRef: 'produto_id',
        itemRefLabel: 'Produto',
        statusFechado: ['faturada', 'entregue'],
        statusAtivo: ['aberta'],
      }
    : {
        parent: getResource('compras')!,
        itens: getResource('itens_compra')!,
        parentCol: 'compra_id',
        itemRef: 'insumo_id',
        itemRefLabel: 'Insumo',
        statusFechado: ['recebido'],
        statusAtivo: ['pendente'],
      };
}

// ----------------------------------------------------------------------------
// Itens do pedido
// ----------------------------------------------------------------------------

/**
 * Lê o pedido e garante que ele pertence à empresa do ator.
 *
 * MULTIEMPRESA: sem esta checagem, `/api/vendas/9/itens` devolvia os itens de
 * qualquer empresa — a rota genérica de vendas tem escopo, o sub-recurso de
 * itens não tinha. O 404 (e não 403) é de propósito: confirmar que o id existe
 * na outra empresa já seria vazamento.
 */
async function getPedido(tipo: TipoPedido, id: number, escopo?: EscopoEmpresa, tx?: Tx): Promise<Row> {
  const { parent } = pedidoConfig(tipo);
  const row = await getStore().findOneWhere(parent, { id }, tx);
  return assertRegistroDaEmpresa(parent, row, escopo);
}

function assertPedidoAberto(tipo: TipoPedido, pedido: Row) {
  const { statusFechado } = pedidoConfig(tipo);
  if (statusFechado.includes(String(pedido.status))) {
    if (tipo === 'venda') {
      throw new HttpError(409, 'Este pedido já foi faturado e os itens não podem mais ser alterados. Cancele o pedido para estornar ou cadastre um novo pedido.');
    }
    throw new HttpError(409, 'Esta compra já foi recebida e os itens não podem mais ser alterados. Cancele a compra para estornar ou cadastre uma nova compra.');
  }
}

/** Lista os itens do pedido (com rótulos de produto/insumo e tamanho). */
export async function listItens(req: Request, res: Response) {
  const tipo = tipoFromPath(req.path);
  const r = pedidoConfig(tipo).itens;
  const actor = currentUser(req);
  checkAccess(pedidoConfig(tipo).parent, actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  await getPedido(tipo, id, escopo);
  const out = await getStore().list(r, { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { [pedidoConfig(tipo).parentCol]: id, empresa_id: escopo.empresaId } });
  // Nas vendas, anexa a miniatura do produto em cada item para exibir na tabela.
  if (tipo === 'venda') {
    const produtos = await getStore().list(getResource('produtos')!, { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } }, null);
    await attachImages(getResource('produtos')!, produtos.rows, null);
    const fotoPorProduto = new Map<number, string | null>(produtos.rows.map((p) => [Number(p.id), p.foto_url ?? null]));
    for (const it of out.rows) it.produto_id__foto = fotoPorProduto.get(Number(it.produto_id)) ?? null;
  }
  res.json(out.rows);
}

export async function createItem(req: Request, res: Response) {
  const tipo = tipoFromPath(req.path);
  const cfg = pedidoConfig(tipo);
  const actor = currentUser(req);
  checkAccess(cfg.parent, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const full = await s.transaction(async (tx) => {
      const pedido = await getPedido(tipo, id, escopo, tx);
      assertPedidoAberto(tipo, pedido);
      const data = validatePayload(cfg.itens, req.body, 'create');
      // MULTIEMPRESA: a empresa é carimbada pelo servidor e as referências
      // (produto/insumo/tamanho) são conferidas contra a empresa ativa.
      const payload: Row = { ...data, [cfg.parentCol]: id, empresa_id: escopo.empresaId };
      await validarReferenciasDaEmpresa(cfg.itens, payload, escopo, (r, rid, empresaId, t) => s.findOneWhere(r, { id: rid, empresa_id: empresaId }, t), tx);
      if (tipo === 'venda') {
        const qtd = Number(payload.quantidade);
        const preco = Number(payload.preco_unitario);
        const pct = Number(payload.desconto_pct || 0);
        payload.subtotal = round2(qtd * preco * (1 - pct / 100));
      }
      const item = await s.insert(cfg.itens, payload, tx);
      await recalcularTotal(tipo, id, tx);
      const out = (await s.get(cfg.itens, Number(item.id), tx)) ?? item;
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: cfg.parent.key,
          registro_id: id,
          descricao: `Item incluído no ${cfg.parent.singular.toLowerCase()} #${id}: ${await itemLabel(tipo, out, tx)}`,
          empresa_id: empresaDoRegistroAudit(cfg.parent, pedido, actor),
          dados: { item_id: Number(item.id) },
        },
        tx
      );
      return out;
    });
    res.status(201).json(full);
  } catch (e) {
    throw toHttpError(e, cfg.itens);
  }
}

export async function updateItem(req: Request, res: Response) {
  const tipo = tipoFromPath(req.path);
  const cfg = pedidoConfig(tipo);
  const actor = currentUser(req);
  checkAccess(cfg.parent, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const full = await s.transaction(async (tx) => {
      const pedido = await getPedido(tipo, id, escopo, tx);
      assertPedidoAberto(tipo, pedido);
      const before = await s.findOneWhere(cfg.itens, { id: itemId, [cfg.parentCol]: id, empresa_id: escopo.empresaId }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado neste pedido.');
      const data = validatePayload(cfg.itens, req.body, 'update');
      delete data.empresa_id;
      if (tipo === 'venda') {
        const merged = { ...before, ...data };
        const qtd = Number(merged.quantidade);
        const preco = Number(merged.preco_unitario);
        const pct = Number(merged.desconto_pct || 0);
        data.subtotal = round2(qtd * preco * (1 - pct / 100));
      }
      const item = await s.update(cfg.itens, itemId, data, tx);
      await recalcularTotal(tipo, id, tx);
      const out = (item ? await s.get(cfg.itens, itemId, tx) : null) ?? item;
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: cfg.parent.key,
          registro_id: id,
          descricao: `Item alterado no ${cfg.parent.singular.toLowerCase()} #${id}: ${await itemLabel(tipo, out, tx)}`,
          empresa_id: empresaDoRegistroAudit(cfg.parent, pedido, actor),
          dados: { item_id: itemId },
        },
        tx
      );
      return out;
    });
    res.json(full);
  } catch (e) {
    throw toHttpError(e, cfg.itens);
  }
}

export async function deleteItem(req: Request, res: Response) {
  const tipo = tipoFromPath(req.path);
  const cfg = pedidoConfig(tipo);
  const actor = currentUser(req);
  checkAccess(cfg.parent, actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const pedido = await getPedido(tipo, id, escopo, tx);
      assertPedidoAberto(tipo, pedido);
      const before = await s.findOneWhere(cfg.itens, { id: itemId, [cfg.parentCol]: id, empresa_id: escopo.empresaId }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado neste pedido.');
      await s.remove(cfg.itens, itemId, tx);
      await recalcularTotal(tipo, id, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: cfg.parent.key,
          registro_id: id,
          descricao: `Item removido do ${cfg.parent.singular.toLowerCase()} #${id} (${await itemLabel(tipo, before, tx)})`,
          empresa_id: empresaDoRegistroAudit(cfg.parent, pedido, actor),
          dados: { item_id: itemId },
        },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, cfg.itens);
  }
}

/** "/api/vendas/12/itens" → 'venda'; "/api/compras/12/itens" → 'compra'. */
function tipoFromPath(pathname: string): TipoPedido {
  return pathname.split('/').includes('vendas') ? 'venda' : 'compra';
}

/** Rótulo legível de um item (produto/insumo + tamanho + quantidade). */
async function itemLabel(tipo: TipoPedido, item: Row | null, tx?: Tx): Promise<string> {
  if (!item) return 'item';
  const s = getStore();
  if (tipo === 'venda') {
    const prod = await s.findOneWhere(getResource('produtos')!, { id: Number(item.produto_id) }, tx);
    const tam = await s.findOneWhere(getResource('tamanhos')!, { id: Number(item.tamanho_id) }, tx);
    const nome = prod ? labelOf(getResource('produtos')!, prod) : `#${item.produto_id}`;
    return `${Number(item.quantidade)}× ${nome} ${tam?.codigo || ''}`.trim();
  }
  const ins = await s.findOneWhere(getResource('insumos')!, { id: Number(item.insumo_id) }, tx);
  const nome = ins ? labelOf(getResource('insumos')!, ins) : `#${item.insumo_id}`;
  return `${Number(item.quantidade)} ${ins?.unidade || 'un'} de ${nome}`;
}

// ----------------------------------------------------------------------------
// Total do pedido (sempre calculado pelo servidor)
// ----------------------------------------------------------------------------

export async function recalcularTotal(tipo: TipoPedido, pedidoId: number, tx?: Tx): Promise<number> {
  const cfg = pedidoConfig(tipo);
  const s = getStore();
  const itens = await s.list(cfg.itens, { page: 1, pageSize: 1000, filter: { [cfg.parentCol]: pedidoId } }, tx);
  let total = 0;
  for (const it of itens.rows) {
    if (tipo === 'venda') {
      total += Number(it.subtotal || 0);
    } else {
      total += Number(it.quantidade) * Number(it.preco_unitario);
    }
  }
  const pedido = await s.findOneWhere(cfg.parent, { id: pedidoId }, tx);
  total += Number(pedido?.frete || 0);
  if (tipo === 'venda') total -= Number(pedido?.desconto || 0);
  total = round2(Math.max(0, total));
  await s.update(cfg.parent, pedidoId, { total }, tx);
  return total;
}

// ----------------------------------------------------------------------------
// Venda → faturamento (baixa de estoque) e estorno
// ----------------------------------------------------------------------------

/** Local canônico da empresa: todas as novas escritas de saldo/movimento usam o ID. */
type LocalEstoque = { id: number; nome: string };

/** Saldo do produto/tamanho/local da empresa; null se ainda não há célula. */
async function saldo(produtoId: number, tamanhoId: number | null, local: LocalEstoque, escopo: EscopoEmpresa, tx?: Tx): Promise<number | null> {
  const rows = await getStore().list(getResource('estoques')!, {
    page: 1,
    pageSize: 20000,
    filter: { empresa_id: escopo.empresaId, produto_id: produtoId },
  }, tx);
  const mesmoTamanho = (v: unknown) => (v === null || v === undefined ? null : Number(v)) === tamanhoId;
  const row = rows.rows.find((e) =>
    mesmoTamanho(e.tamanho_id) &&
    (Number(e.local_id) === local.id || (e.local_id === null || e.local_id === undefined) && String(e.local || '') === local.nome)
  );
  return row ? Number(row.quantidade || 0) : null;
}

async function faturarVenda(pedido: Row, actor: { id: number | null; name: string }, tx: Tx, escopo: EscopoEmpresa) {
  const s = getStore();
  const empresaId = escopo.empresaId;
  const itens = await s.list(getResource('itens_venda')!, {
    page: 1,
    pageSize: 1000,
    filter: { empresa_id: empresaId, venda_id: Number(pedido.id) },
  }, tx);
  if (!itens.rows.length) throw new HttpError(409, 'Adicione ao menos um item antes de faturar o pedido.');

  const localPadraoInfo = await getDefaultLocalInfo(tx, escopo);
  if (!localPadraoInfo) throw new HttpError(409, 'A empresa ativa não possui um local de estoque ativo. Cadastre um local antes de faturar.');
  const localPadrao: LocalEstoque = { id: Number(localPadraoInfo.id), nome: String(localPadraoInfo.nome) };
  // E4.2.1 (GAP-ESTQ-PDV-LOCAL-TEXTO): o ID canônico manda. O texto só é usado em venda
  // legada (local_saida_id NULL), sem backfill; o Local padrão é o último recurso.
  const localSaidaData: Record<string, unknown> = pedido.local_saida_id !== null && pedido.local_saida_id !== undefined
    ? { local_id: Number(pedido.local_saida_id) }
    : pedido.local_saida ? { local: String(pedido.local_saida).trim() } : { local_id: localPadrao.id };
  await resolveLocal(localSaidaData, tx, escopo);
  const localSaida: LocalEstoque = { id: Number(localSaidaData.local_id), nome: String(localSaidaData.local) };

  // Escolhe, por item, o local com saldo: local de saída configurado → Local padrão.
  const faltas: string[] = [];
  const plano: { item: Row; local: LocalEstoque; qtd: number; tamanhoId: number | null }[] = [];
  for (const it of itens.rows) {
    const produtoId = Number(it.produto_id);
    const tamanhoId = it.tamanho_id === null || it.tamanho_id === undefined || it.tamanho_id === '' ? null : Number(it.tamanho_id);
    const qtd = Number(it.quantidade);
    const prod = await s.findOneWhere(getResource('produtos')!, { id: produtoId, empresa_id: empresaId }, tx);
    if (!prod) throw new HttpError(404, 'Produto não encontrado.');
    const tam = tamanhoId === null ? null : await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
    if (tamanhoId !== null && !tam) throw new HttpError(404, 'Tamanho não encontrado.');
    await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);

    let local = localSaida;
    let disp = await saldo(produtoId, tamanhoId, localSaida, escopo, tx);
    if ((disp === null || disp < qtd) && localSaida.id !== localPadrao.id) {
      const alt = await saldo(produtoId, tamanhoId, localPadrao, escopo, tx);
      if (alt !== null && alt >= qtd && (disp === null || alt >= disp)) {
        local = localPadrao;
        disp = alt;
      }
    }
    const nome = labelOf(getResource('produtos')!, prod);
    if (disp === null || disp < qtd) {
      faltas.push(`${nome}${tam ? ` tam. ${tam.codigo}` : ''}: precisa de ${qtd}, há ${Math.max(0, disp ?? 0)} em "${local.nome}"`);
      continue;
    }
    plano.push({ item: it, local, qtd, tamanhoId });
  }
  if (faltas.length) {
    throw new HttpError(
      409,
      `Não há saldo suficiente para faturar:\n• ${faltas.join('\n• ')}\nBaixe o necessário via Movimentações ou ajuste o pedido antes de faturar.`
    );
  }

  for (const p of plano) {
    const produtoId = Number(p.item.produto_id);
    const aplicado = await s.tryAdjustStock(produtoId, p.tamanhoId, p.local.nome, -p.qtd, tx, 0, p.local.id, empresaId);
    if (!aplicado) {
      const atual = await saldo(produtoId, p.tamanhoId, p.local, escopo, tx) ?? 0;
      throw new HttpError(
        409,
        `O saldo mudou durante o faturamento: só há ${atual} peça(s) do produto ${produtoId}${p.tamanhoId === null ? '' : ` tam. ${p.tamanhoId}`} em "${p.local.nome}", e o pedido precisa de ${p.qtd}. Confirme o estoque e fature de novo.`
      );
    }
    await s.insert(
      getResource('movimentacoes')!,
      {
        empresa_id: empresaId,
        tipo: 'saida',
        produto_id: produtoId,
        tamanho_id: p.tamanhoId,
        local: p.local.nome,
        local_id: p.local.id,
        quantidade: p.qtd,
        venda_id: Number(pedido.id),
        motivo: `Venda #${pedido.id}`,
        usuario_id: actor.id || null,
      },
      tx
    );
  }

  // Congela a comissão do representante (percentual atual → valor sobre os itens).
  let comissaoPct: number | null = null;
  let comissaoValor: number | null = 0;
  if (pedido.representante_id) {
    const rep = await s.findOneWhere(getResource('representantes')!, { id: Number(pedido.representante_id), empresa_id: empresaId }, tx);
    if (!rep) throw new HttpError(404, 'Representante não encontrado.');
    comissaoPct = round2(Number(rep.comissao_pct || 0));
    const totalItens = itens.rows.reduce((sum, it) => sum + Number(it.subtotal || 0), 0);
    comissaoValor = round2((totalItens * comissaoPct) / 100);
  }
  await s.update(
    getResource('vendas')!,
    Number(pedido.id),
    { faturada_em: new Date().toISOString(), comissao_pct: comissaoPct, comissao_valor: comissaoValor },
    tx
  );
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'vendas',
      registro_id: Number(pedido.id),
      descricao: `Venda #${pedido.id} faturada — ${plano.length} item(ns) baixado(s) do estoque${comissaoValor ? `; comissão ${comissaoValor.toFixed(2)}` : ''}`,
      empresa_id: empresaDoRegistroAudit(getResource('vendas')!, pedido, actor),
      dados: { faturada_em: new Date().toISOString(), comissao_pct: comissaoPct, comissao_valor: comissaoValor },
    },
    tx
  );
}

/**
 * Chave de saldo de um item de venda: produto + tamanho (0 = sem tamanho).
 * Mesma chave em faturamento, devolução e estorno — uma única definição.
 */
export function chaveItemVenda(produtoId: number, tamanhoId: number | null | undefined): string {
  return `${produtoId}:${tamanhoId === null || tamanhoId === undefined ? 0 : Number(tamanhoId)}`;
}

/**
 * Quantidade JÁ RECEBIDA de cada item da venda, em qualquer estado (bom, avariado,
 * usado…), somada das devoluções RECEBIDAS da venda. Fonte: devolucao_itens — não
 * depende do texto de movimentação, então vale também para vendas anteriores à E4.2.1.
 * Só devoluções com status 'recebida' contam; solicitada/autorizada ainda não moveram nada.
 */
export async function quantidadeRecebidaPorItem(vendaId: number, empresaId: number, tx: Tx): Promise<Map<string, number>> {
  const s = getStore();
  const devolucoes = await s.list(getResource('devolucoes')!, {
    page: 1,
    pageSize: 1000,
    filter: { empresa_id: empresaId, venda_id: vendaId, status: 'recebida' },
  }, tx);
  const porItem = new Map<string, number>();
  for (const dev of devolucoes.rows) {
    const itens = await s.list(getResource('devolucao_itens')!, {
      page: 1,
      pageSize: 1000,
      filter: { empresa_id: empresaId, devolucao_id: Number(dev.id) },
    }, tx);
    for (const it of itens.rows) {
      const chave = chaveItemVenda(Number(it.produto_id), it.tamanho_id === null || it.tamanho_id === undefined ? null : Number(it.tamanho_id));
      porItem.set(chave, (porItem.get(chave) ?? 0) + Number(it.quantidade_recebida || 0));
    }
  }
  return porItem;
}

/**
 * Estorno da venda cancelada. Restaura APENAS o que saiu e ainda não voltou:
 *   restaurar(item) = saídas(item) − já recebido(item) em devolução (qualquer estado).
 * Devolução boa já devolveu ao saldo; avariada não volta ao saldo vendável e ainda
 * assim conta como recebida, para não ser restaurada de novo.
 *
 * Saídas: pelo venda_id (fonte canônica). Venda anterior à E4.2.1 não tem venda_id;
 * só para ela a saída é localizada pelo texto exato 'Venda #id' da MESMA empresa,
 * em linhas com venda_id NULL. Nada é associado nem reescrito (sem backfill).
 */
async function estornarVenda(pedido: Row, actor: { id: number | null; name: string }, tx: Tx, escopo: EscopoEmpresa) {
  const s = getStore();
  const empresaId = escopo.empresaId;
  const vendaId = Number(pedido.id);
  const movimentacoes = getResource('movimentacoes')!;
  const canonicas = await s.list(movimentacoes, {
    page: 1,
    pageSize: 1000,
    sort: 'id',
    dir: 'asc',
    filter: { empresa_id: empresaId, tipo: 'saida', venda_id: vendaId },
  }, tx);
  let saidas = canonicas.rows;
  let origem: 'venda_id' | 'legado_texto' = 'venda_id';
  if (!saidas.length) {
    const legadas = await s.list(movimentacoes, {
      page: 1,
      pageSize: 1000,
      sort: 'id',
      dir: 'asc',
      filter: { empresa_id: empresaId, tipo: 'saida', motivo: `Venda #${vendaId}` },
    }, tx);
    saidas = legadas.rows.filter((m) => String(m.motivo) === `Venda #${vendaId}` && (m.venda_id === null || m.venda_id === undefined));
    origem = 'legado_texto';
  }

  const jaRecebido = await quantidadeRecebidaPorItem(vendaId, empresaId, tx);
  const aDescontar = new Map(jaRecebido);
  let restauradas = 0;
  for (const m of saidas) {
    const produtoId = Number(m.produto_id);
    const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId, empresa_id: empresaId }, tx);
    if (!produto) throw new HttpError(404, 'Produto não encontrado.');
    const tamanhoId = m.tamanho_id === null || m.tamanho_id === undefined ? null : Number(m.tamanho_id);
    await validarTamanhoNaGrade(produtoId, tamanhoId, tx, escopo);
    const quantidade = Number(m.quantidade);
    if (!Number.isInteger(quantidade) || quantidade <= 0) throw new HttpError(409, 'Não é possível estornar uma movimentação histórica com quantidade inválida. Nenhum saldo foi alterado.');
    if ((m.local_id === null || m.local_id === undefined || m.local_id === '') && !String(m.local || '').trim()) {
      throw new HttpError(409, 'Não é possível estornar uma movimentação histórica sem local de estoque válido. Nenhum saldo foi alterado.');
    }
    const chave = chaveItemVenda(produtoId, tamanhoId);
    const aindaDevolvido = Math.min(aDescontar.get(chave) ?? 0, quantidade);
    aDescontar.set(chave, (aDescontar.get(chave) ?? 0) - aindaDevolvido);
    const aRestaurar = quantidade - aindaDevolvido;
    if (aRestaurar === 0) continue;

    const localData: Record<string, unknown> = {};
    if (m.local_id !== null && m.local_id !== undefined && m.local_id !== '') localData.local_id = m.local_id;
    else localData.local = String(m.local).trim();
    await resolveLocal(localData, tx, escopo);
    const localId = Number(localData.local_id);
    const local = String(localData.local);
    await s.adjustStock(produtoId, tamanhoId, local, aRestaurar, tx, localId, empresaId);
    await s.insert(
      movimentacoes,
      {
        empresa_id: empresaId,
        tipo: 'entrada',
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        local,
        local_id: localId,
        quantidade: aRestaurar,
        venda_id: vendaId,
        motivo: `Estorno — Venda #${vendaId} cancelada`,
        usuario_id: actor.id || null,
      },
      tx
    );
    restauradas += aRestaurar;
  }
  // Devolvido além do que saiu seria estoque inventado: recusa, nada é gravado.
  const excedente = [...aDescontar.values()].reduce((acc, v) => acc + v, 0);
  if (excedente > 0) {
    throw new HttpError(409, `Há ${excedente} unidade(s) recebidas em devolução sem saída correspondente nesta venda. Nenhum saldo foi alterado.`);
  }
  await s.update(
    getResource('vendas')!,
    vendaId,
    { faturada_em: null, comissao_pct: null, comissao_valor: null },
    tx
  );
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'vendas',
      registro_id: vendaId,
      descricao: `Venda #${vendaId} cancelada — estorno de ${saidas.length} saída(s): ${restauradas} unidade(s) restaurada(s)`,
      empresa_id: empresaDoRegistroAudit(getResource('vendas')!, pedido, actor),
      dados: { estornadas: saidas.length, restauradas, origem_saidas: origem },
    },
    tx
  );
}

// ----------------------------------------------------------------------------
// Compra → recebimento (entrada de insumos + custo médio ponderado) e estorno
// ----------------------------------------------------------------------------

async function receberCompra(pedido: Row, actor: { id: number | null; name: string }, tx: Tx, escopo: EscopoEmpresa) {
  const s = getStore();
  const itens = await s.list(getResource('itens_compra')!, { page: 1, pageSize: 1000, filter: { compra_id: Number(pedido.id) } }, tx);
  if (!itens.rows.length) throw new HttpError(409, 'Adicione ao menos um item antes de marcar a compra como recebida.');

  // Só o que AINDA falta receber. Antes isto entrava com a quantidade CHEIA de
  // cada item: uma compra já recebida em parte que fosse marcada como "recebida"
  // recebia tudo de novo e estourava o pedido (40 já recebidos + 100 = 140).
  const pendentes = itens.rows.map((it) => {
    const qtd = round3(Number(it.quantidade));
    const recebida = round3(Number(it.quantidade_recebida || 0));
    return { it, falta: round3(qtd - recebida) };
  });
  if (!pendentes.some((p) => p.falta > 0)) {
    throw new HttpError(409, `A compra #${pedido.id} já foi totalmente recebida. Estorne um recebimento antes de receber de novo.`);
  }

  // REGRA CANÔNICA (server/src/custoRecebimento.ts). Esta função costumava ter
  // a sua própria cópia da média ponderada — agora delega, para que recebimento
  // total, parcial e importação de XML tratem custo exatamente igual.
  await aplicarEntradaDeCompra({
    compraId: Number(pedido.id),
    empresaId: Number(pedido.empresa_id),
    recebimentoId: null,
    linhas: pendentes
      .filter((p) => p.falta > 0)
      .map(({ it, falta }) => ({
        item_compra_id: Number(it.id),
        insumo_id: it.insumo_id === null || it.insumo_id === undefined || it.insumo_id === '' ? null : Number(it.insumo_id),
        produto_id: it.produto_id === null || it.produto_id === undefined || it.produto_id === '' ? null : Number(it.produto_id),
        tamanho_id: it.tamanho_id === null || it.tamanho_id === undefined || it.tamanho_id === '' ? null : Number(it.tamanho_id),
        quantidade: falta,
        preco_unitario: Number(it.preco_unitario),
        local: String(it.local || pedido.local_entrada || ''),
      })),
    freteTotal: Number(pedido.frete || 0),
    actor: { id: actor.id || null, name: actor.name },
    motivo: `Compra #${pedido.id}${pedido.nota_fiscal ? ` — NF ${pedido.nota_fiscal}` : ''}`,
    tx,
    escopo,
  });

  await s.update(getResource('compras')!, Number(pedido.id), { recebida_em: new Date().toISOString() }, tx);
}
async function estornarCompra(pedido: Row, actor: { id: number | null; name: string }, tx: Tx, escopo: EscopoEmpresa) {
  const s = getStore();

  // REGRA CANÔNICA INVERSA. Antes esta função procurava as entradas de insumo
  // pelo TEXTO do motivo ('Compra #N') e o recebimento parcial grava
  // 'Recebimento parcial — Compra #N' — então cancelar uma compra recebida
  // parcialmente devolvia o estoque de produtos e deixava o de insumos para
  // cima, com o custo médio alterado para sempre.
  await estornarEntradasDeCompra({
    compraId: Number(pedido.id),
    actor: { id: actor.id || null, name: actor.name },
    motivo: `Estorno — Compra #${pedido.id} cancelada`,
    tx,
    escopo,
  });

  await s.update(getResource('compras')!, Number(pedido.id), { recebida_em: null }, tx);
}

// ----------------------------------------------------------------------------
// Hook chamado por services.ts no create/update de vendas e compras
// ----------------------------------------------------------------------------

const FATURADOS = ['faturada', 'entregue'];

/**
 * Aplica os efeitos de transição de status de uma venda/compra.
 * Deve ser chamado DENTRO da transação do serviço, após o insert/update do
 * cabeçalho. `data` é o payload enviado pelo cliente.
 *
 * `escopo` é a empresa do ATOR (não a da linha). Ele desce até a regra canônica
 * de custo para que o recebimento revalide o pedido contra a empresa de quem
 * está operando — derivá-lo da própria linha tornaria a checagem tautológica.
 */
export async function aplicarRegrasPedido(
  tipo: TipoPedido,
  before: Row | null,
  after: Row,
  data: Record<string, unknown>,
  actor: { id: number | null; name: string },
  tx: Tx,
  escopo: EscopoEmpresa
): Promise<void> {
  const pai = pedidoConfig(tipo).parent;
  assertRegistroDaEmpresa(pai, after, escopo);
  if (before) assertRegistroDaEmpresa(pai, before, escopo);
  // Recalcula o total quando desconto/frete mudam (os itens recalcam sozinhos).
  if (tipo === 'venda' && (data.desconto !== undefined || data.frete !== undefined)) {
    await recalcularTotal('venda', Number(after.id), tx);
  }
  if (tipo === 'compra' && data.frete !== undefined) {
    await recalcularTotal('compra', Number(after.id), tx);
  }
  if (data.status === undefined) return;

  const statusAnterior = before ? String(before.status) : null;
  const statusNovo = String(after.status);

  if (tipo === 'venda') {
    const eraFaturado = statusAnterior !== null && FATURADOS.includes(statusAnterior);
    const ehFaturado = FATURADOS.includes(statusNovo);
    // Transições inválidas: pedido cancelado é terminal; faturado não "reabre".
    if (statusAnterior === 'cancelada' && statusNovo !== 'cancelada') {
      throw new HttpError(409, 'Pedido cancelado não pode ser reaberto. Duplique o pedido se precisar emitir uma nova venda.');
    }
    if (eraFaturado && !ehFaturado && statusNovo !== 'cancelada') {
      throw new HttpError(409, 'Pedido faturado não pode voltar para aberto. Para desfazer o faturamento, cancele o pedido (o estoque é estornado).');
    }
    if (!before && ehFaturado) {
      // Criado já como faturado: fatura na hora.
      await faturarVenda(after, actor, tx, escopo);
      return;
    }
    if (!eraFaturado && ehFaturado) {
      await faturarVenda(after, actor, tx, escopo);
    } else if (eraFaturado && statusNovo === 'cancelada') {
      await estornarVenda(before!, actor, tx, escopo);
    }
    return;
  }

  // Compra
  if (statusAnterior === 'cancelado' && statusNovo !== 'cancelado') {
    throw new HttpError(409, 'Compra cancelada não pode ser reaberta. Cadastre uma nova compra.');
  }
  const eraRecebido = statusAnterior === 'recebido';
  const ehRecebido = statusNovo === 'recebido';
  // Status em que JÁ entrou estoque. 'parcial' conta: recebeu uma parte, então
  // cancelar tem que devolver essa parte — antes só 'recebido' estornava e uma
  // compra recebida pela metade ficava com o estoque de insumo para cima.
  const tinhaEntrada = statusAnterior === 'recebido' || statusAnterior === 'parcial';
  if (tinhaEntrada && !ehRecebido && statusNovo !== 'cancelado') {
    throw new HttpError(409, 'Compra recebida não pode voltar para pendente. Para desfazer o recebimento, cancele a compra (o estoque de insumos é estornado).');
  }
  if ((!before || !eraRecebido) && ehRecebido) {
    await receberCompra(after, actor, tx, escopo);
  } else if (tinhaEntrada && statusNovo === 'cancelado') {
    await estornarCompra(before!, actor, tx, escopo);
  }
}
