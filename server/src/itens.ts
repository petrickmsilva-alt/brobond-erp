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
import { checkAccess, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, escopoDeSistema, validarReferenciasDaEmpresa, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
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
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
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
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
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
      await validarReferenciasDaEmpresa(cfg.itens, payload, escopo, (r, rid, t) => s.get(r, rid, t), tx);
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
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
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
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
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

/** Saldo do produto/tamanho no local; null se não existe linha de estoque. */
async function saldo(produtoId: number, tamanhoId: number, local: string, tx?: Tx): Promise<number | null> {
  const row = await getStore().findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx);
  return row ? Number(row.quantidade || 0) : null;
}

async function faturarVenda(pedido: Row, actor: { id: number | null; name: string }, tx: Tx) {
  const s = getStore();
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: Number(pedido.id) } }, tx);
  if (!itens.rows.length) throw new HttpError(409, 'Adicione ao menos um item antes de faturar o pedido.');

  const localSaida = (String(pedido.local_saida || '').trim() || (await getDefaultLocal(tx)));
  // Escolhe, por item, o local com saldo: local de saída configurado → Local padrão.
  const faltas: string[] = [];
  const plano: { item: Row; local: string; qtd: number }[] = [];
  const localPadraoFallback = await getDefaultLocal(tx);
  for (const it of itens.rows) {
    const produtoId = Number(it.produto_id);
    const tamanhoId = Number(it.tamanho_id);
    const qtd = Number(it.quantidade);
    let local = localSaida;
    let disp = await saldo(produtoId, tamanhoId, localSaida, tx);
    if ((disp === null || disp < qtd) && localSaida !== localPadraoFallback) {
      const alt = await saldo(produtoId, tamanhoId, localPadraoFallback, tx);
      if (alt !== null && alt >= qtd && (disp === null || alt >= disp)) {
        local = localPadraoFallback;
        disp = alt;
      }
    }
    const prod = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
    const tam = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
    const nome = prod ? labelOf(getResource('produtos')!, prod) : `#${produtoId}`;
    if (disp === null || disp < qtd) {
      faltas.push(`${nome} tam. ${tam?.codigo || '?'}: precisa de ${qtd}, há ${Math.max(0, disp ?? 0)} em "${local}"`);
      continue;
    }
    plano.push({ item: it, local, qtd });
  }
  if (faltas.length) {
    throw new HttpError(
      409,
      `Não há saldo suficiente para faturar:\n• ${faltas.join('\n• ')}\nBaixe o necessário via Movimentações ou ajuste o pedido antes de faturar.`
    );
  }

  for (const p of plano) {
    // Checar a disponibilidade e abater depois não basta: entre o `disp < qtd`
    // acima e este loop outro pedido pode ter levado as peças. O abatimento é
    // condicional na própria escrita.
    const aplicado = await s.tryAdjustStock(Number(p.item.produto_id), Number(p.item.tamanho_id), p.local, -p.qtd, tx);
    if (!aplicado) {
      const saldo = await s.findOneWhere(getResource('estoques')!, { produto_id: Number(p.item.produto_id), tamanho_id: Number(p.item.tamanho_id), local: p.local }, tx);
      const atual = Number(saldo?.quantidade ?? 0);
      throw new HttpError(
        409,
        `O saldo mudou durante o faturamento: só há ${atual} peça(s) do produto ${p.item.produto_id} tam. ${p.item.tamanho_id} em "${p.local}", e o pedido precisa de ${p.qtd}. Confirme o estoque e fature de novo.`
      );
    }
    await s.insert(
      getResource('movimentacoes')!,
      {
        tipo: 'saida',
        produto_id: p.item.produto_id,
        tamanho_id: p.item.tamanho_id,
        local: p.local,
        quantidade: p.qtd,
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
    const rep = await s.findOneWhere(getResource('representantes')!, { id: Number(pedido.representante_id) }, tx);
    comissaoPct = rep ? round2(Number(rep.comissao_pct || 0)) : 0;
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

async function estornarVenda(pedido: Row, actor: { id: number | null; name: string }, tx: Tx) {
  const s = getStore();
  const movs = await s.list(
    getResource('movimentacoes')!,
    { page: 1, pageSize: 1000, sort: 'id', dir: 'desc', filter: { tipo: 'saida', motivo: `Venda #${pedido.id}` } },
    tx
  );
  // Estorna cada saída correspondente (entrada de volta ao mesmo local).
  const saidas = movs.rows.filter((m) => String(m.motivo) === `Venda #${pedido.id}`);
  for (const m of saidas) {
    await s.adjustStock(Number(m.produto_id), Number(m.tamanho_id), String(m.local), Number(m.quantidade), tx);
    await s.insert(
      getResource('movimentacoes')!,
      {
        tipo: 'entrada',
        produto_id: m.produto_id,
        tamanho_id: m.tamanho_id,
        local: m.local,
        quantidade: Number(m.quantidade),
        motivo: `Estorno — Venda #${pedido.id} cancelada`,
        usuario_id: actor.id || null,
      },
      tx
    );
  }
  await s.update(
    getResource('vendas')!,
    Number(pedido.id),
    { faturada_em: null, comissao_pct: null, comissao_valor: null },
    tx
  );
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'vendas',
      registro_id: Number(pedido.id),
      descricao: `Venda #${pedido.id} cancelada — estorno de ${saidas.length} saída(s) de estoque`,
      empresa_id: empresaDoRegistroAudit(getResource('vendas')!, pedido, actor),
      dados: { estornadas: saidas.length },
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
  escopo?: EscopoEmpresa
): Promise<void> {
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
      await faturarVenda(after, actor, tx);
      return;
    }
    if (!eraFaturado && ehFaturado) {
      await faturarVenda(after, actor, tx);
    } else if (eraFaturado && statusNovo === 'cancelada') {
      await estornarVenda(before!, actor, tx);
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
  // Sem escopo do ator (chamada interna antiga), cai no escopo da linha. Só é
  // aceitável porque services.ts — o único caminho de compra — valida o pedido
  // contra o escopo do ator ANTES de chegar aqui (assertRegistroDaEmpresa).
  const escopoCompra = escopo ?? escopoDeSistema(Number(after.empresa_id));
  if ((!before || !eraRecebido) && ehRecebido) {
    await receberCompra(after, actor, tx, escopoCompra);
  } else if (tinhaEntrada && statusNovo === 'cancelado') {
    await estornarCompra(before!, actor, tx, escopoCompra);
  }
}
