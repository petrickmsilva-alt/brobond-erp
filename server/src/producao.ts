// ============================================================
// Fase 3 — Produção e custo real.
//
// Rotas (sub-recursos genéricos, mesmo padrão de itens.ts):
//   GET    /api/ordens/:id/itens            itens da OP por grade
//   POST   /api/ordens/:id/itens            adiciona tamanho à OP
//   PUT    /api/ordens/:id/itens/:itemId    altera quantidade
//   DELETE /api/ordens/:id/itens/:itemId    remove tamanho da OP
//   GET    /api/fichas/:id/insumos          insumos da ficha técnica
//   POST   /api/fichas/:id/insumos          adiciona insumo (consumo/perda)
//   PUT    /api/fichas/:id/insumos/:itemId
//   DELETE /api/fichas/:id/insumos/:itemId
//   POST   /api/fichas/:id/aplicar-preco    custo/preço sugerido → produto
//
// Regras:
//   • OP por tamanho usa ordens_fabricacao.tamanho_id/quantidade;
//     OP por grade usa itens_ordem (uma linha por tamanho);
//   • concluir OP → entrada no estoque por tamanho (1 adjustStock +
//     movimentação por item) + baixa de insumos da ficha técnica com perda;
//     reabrir estorna tudo;
//   • consumo sem saldo bloqueia com 409 listando os insumos em falta;
//     ?forcar=true (gerente/admin) executa mesmo assim e registra na auditoria;
//   • custo calculado = Σ(consumo × (1+perda) × custo_médio) + mão de obra
//     + custos indiretos; preço sugerido = custo × (1 + margem/100).
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import type { Payload, Row, Tx } from './store';
import { parseId, validatePayload } from './validate';
import { labelOf } from './store';
import { round2, round3 } from './utils';

type Actor = { id: number | null; name: string; perfil?: string };
type OrdemOpts = { forcar?: boolean };

function recursoOrdem() {
  return { op: getResource('ordens')!, itens: getResource('itens_ordem')! };
}

function recursoFicha() {
  return { ficha: getResource('fichas')!, itens: getResource('itens_ficha_tecnica')! };
}

// ----------------------------------------------------------------------------
// Validação do payload da OP (tipo tamanho × grade)
// ----------------------------------------------------------------------------

/** Exigências por tipo: por tamanho precisa tamanho+quantidade; por grade não. */
export async function validarOrdemPayload(data: Payload, before: Row | null): Promise<void> {
  const merged = { ...(before || {}), ...data };
  const tipo = String(data.tipo ?? merged.tipo ?? 'tamanho');
  if (tipo !== 'tamanho' && tipo !== 'grade') {
    throw new HttpError(400, 'Tipo de OP inválido. Use "tamanho" ou "grade".', { tipo: 'Opção inválida' });
  }
  if (tipo === 'grade') {
    data.tamanho_id = null;
    data.quantidade = null;
    return;
  }
  // Por tamanho: tamanho_id e quantidade são obrigatórios.
  const tam = merged.tamanho_id ?? data.tamanho_id;
  const qtd = merged.quantidade ?? data.quantidade;
  if (!tam || !Number.isInteger(Number(tam))) {
    throw new HttpError(400, 'OP "por tamanho" exige um tamanho.', { tamanho_id: 'Campo obrigatório em OP por tamanho' });
  }
  if (qtd === null || qtd === undefined || Number(qtd) <= 0) {
    throw new HttpError(400, 'OP "por tamanho" exige uma quantidade maior que zero.', { quantidade: 'Campo obrigatório em OP por tamanho' });
  }
}

/** Itens efetivos de produção (grade → itens_ordem; tamanho → linha única). */
async function itensProducao(op: Row, tx?: Tx): Promise<{ tamanho_id: number; quantidade: number }[]> {
  const s = getStore();
  const tipo = String(op.tipo || 'tamanho');
  if (tipo === 'grade') {
    const itens = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, filter: { ordem_id: Number(op.id) } }, tx);
    return itens.rows.map((it) => ({ tamanho_id: Number(it.tamanho_id), quantidade: Number(it.quantidade || 0) }));
  }
  if (!op.tamanho_id) return [];
  return [{ tamanho_id: Number(op.tamanho_id), quantidade: Number(op.quantidade || 0) }];
}

/** Encontra a ficha técnica do produto (única por produto). */
async function fichaDoProduto(produtoId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(recursoFicha().ficha, { produto_id: produtoId }, tx);
}

// ----------------------------------------------------------------------------
// Concluir OP: entrada por tamanho + baixa de insumos. Reabrir: estorna tudo.
// ----------------------------------------------------------------------------

async function concluirOrdem(op: Row, actor: Actor, tx: Tx, opts: OrdemOpts) {
  const s = getStore();
  const id = Number(op.id);
  const itens = await itensProducao(op, tx);
  const totalPecas = itens.reduce((a, i) => a + i.quantidade, 0);
  if (!itens.length || totalPecas <= 0) {
    throw new HttpError(409, 'Adicione ao menos um tamanho com quantidade antes de concluir a OP.');
  }
  const forcar = opts.forcar === true && (actor.perfil === 'admin' || actor.perfil === 'gerente');

  // --- 1) consumo de insumos da ficha técnica ---------------------------------
  const ficha = await fichaDoProduto(Number(op.produto_id), tx);
  const consumos: { insumo_id: number; necessidade: number; motivo: string; custo_unitario: number; nome: string; unidade: string; faltando: number }[] = [];
  if (ficha) {
    const linhas = await s.list(recursoFicha().itens, { page: 1, pageSize: 500, filter: { ficha_id: Number(ficha.id) } }, tx);
    for (const linha of linhas.rows) {
      const insumoId = Number(linha.insumo_id);
      const consumo = Number(linha.consumo || 0);
      const perda = Number(linha.perda_pct || 0);
      if (!insumoId || consumo <= 0) continue;
      const necessidade = round3(totalPecas * consumo * (1 + perda / 100));
      const insumo = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
      const nome = insumo ? labelOf(getResource('insumos')!, insumo) : `#${insumoId}`;
      const unidade = insumo?.unidade || 'un';
      const custo = Number(insumo?.custo_medio || 0);
      const saldo = round3(await s.insumoStock(insumoId, tx));
      consumos.push({
        insumo_id: insumoId,
        necessidade,
        motivo: `Consumo — OP #${id}${forcar && saldo < necessidade ? ' (forçado)' : ''}`,
        custo_unitario: custo,
        nome,
        unidade,
        faltando: saldo < necessidade ? round3(necessidade - saldo) : 0,
      });
    }
  }

  const emFalta = consumos.filter((c) => c.faltando > 0);
  if (emFalta.length && !forcar) {
    const linhas = emFalta.map((c) => `• ${c.nome}: precisa ${c.necessidade} ${c.unidade}, há ${round3(c.necessidade - c.faltando)}`).join('\n');
    throw new HttpError(
      409,
      `Sem saldo de insumos para concluir a OP #${id}:\n${linhas}\nCompre os insumos ou, se for gerente/administrador, conclua com ?forcar=true (o saldo ficará negativo e o fato será auditado).`
    );
  }

  // Efetiva a baixa (mesmo no forçar, deixando saldo negativo).
  for (const c of consumos) {
    await s.adjustInsumoStock(c.insumo_id, -c.necessidade, tx);
    await s.insert(
      getResource('movimentacoes_insumos')!,
      { tipo: 'saida', insumo_id: c.insumo_id, quantidade: c.necessidade, custo_unitario: c.custo_unitario, motivo: c.motivo, usuario_id: actor.id || null },
      tx
    );
  }

  // --- 2) entrada no estoque por tamanho ---------------------------------------
  const localPadrao = await getDefaultLocal(tx);
  for (const it of itens) {
    await s.adjustStock(Number(op.produto_id), it.tamanho_id, localPadrao, it.quantidade, tx);
    await s.insert(
      getResource('movimentacoes')!,
      { tipo: 'entrada', produto_id: op.produto_id, tamanho_id: it.tamanho_id, local: localPadrao, quantidade: it.quantidade, motivo: `Produção concluída — OP #${id}`, usuario_id: actor.id || null },
      tx
    );
  }

  // produzido = quantidade da grade (histórico)
  if (String(op.tipo || 'tamanho') === 'grade') {
    for (const it of itens) {
      await s.update(recursoOrdem().itens, await itemIdPorTamanho(id, it.tamanho_id, tx), { produzido: it.quantidade }, tx);
    }
  }

  await s.update(recursoOrdem().op, id, { concluida_em: new Date().toISOString() }, tx);
  const forcarNota = emFalta.length ? ` — CONSUMO FORÇADO por ${actor.name}: ${emFalta.map((c) => `${c.nome} (−${c.faltando} ${c.unidade})`).join(', ')}` : '';
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'ordens',
      registro_id: id,
      descricao: `OP #${id} concluída — entrada de ${totalPecas} peça(s) em ${localPadrao} e baixa de ${consumos.length} insumo(s) da ficha técnica${forcarNota}`,
      dados: { pecas: totalPecas, insumos: consumos.length, forcar: emFalta.length > 0 },
    },
    tx
  );
}

/** Busca o id do item de grade por tamanho (para atualizar produzido). */
async function itemIdPorTamanho(ordemId: number, tamanhoId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const itens = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, filter: { ordem_id: ordemId, tamanho_id: tamanhoId } }, tx);
  if (!itens.rows.length) throw new HttpError(404, 'Item da OP não encontrado.');
  return Number(itens.rows[0].id);
}

async function estornarOrdem(op: Row, actor: Actor, tx: Tx) {
  const s = getStore();
  const id = Number(op.id);

  // Estorna as entradas de estoque da conclusão.
  const entradas = await s.list(
    getResource('movimentacoes')!,
    { page: 1, pageSize: 200, sort: 'id', dir: 'desc', filter: { tipo: 'entrada', motivo: `Produção concluída — OP #${id}` } },
    tx
  );
  let pecas = 0;
  for (const m of entradas.rows) {
    const qtd = Number(m.quantidade);
    if (qtd <= 0) continue;
    pecas += qtd;
    // Reabrir a OP retira as peças que ela entrou no estoque. Se parte delas já
    // foi vendida, o abatimento não cabe — e aí a abertura de uma OP não pode
    // deixar saldo negativo atrás de si.
    const localPeca = String(m.local || 'loja');
    const aplicado = await s.tryAdjustStock(Number(m.produto_id), Number(m.tamanho_id), localPeca, -qtd, tx);
    if (!aplicado) {
      const saldo = await s.findOneWhere(getResource('estoques')!, { produto_id: Number(m.produto_id), tamanho_id: Number(m.tamanho_id), local: localPeca }, tx);
      const atual = Number(saldo?.quantidade ?? 0);
      throw new HttpError(
        409,
        `Não é possível reabrir a OP: ela entrou com ${qtd} peça(s) e só há ${atual} em "${localPeca}" (o resto já foi vendido/movimentado). Estorne as saídas correspondentes antes de reabrir.`
      );
    }
    await s.insert(
      getResource('movimentacoes')!,
      { tipo: 'saida', produto_id: m.produto_id, tamanho_id: m.tamanho_id, local: m.local, quantidade: qtd, motivo: `Estorno — OP #${id} reaberta`, usuario_id: actor.id || null },
      tx
    );
  }

  // Devolve os insumos consumidos.
  const consumos = await s.list(
    getResource('movimentacoes_insumos')!,
    { page: 1, pageSize: 500, sort: 'id', dir: 'desc', filter: { tipo: 'saida' } },
    tx
  );
  let insumos = 0;
  for (const m of consumos.rows) {
    if (!String(m.motivo || '').startsWith(`Consumo — OP #${id}`)) continue;
    const qtd = round3(Number(m.quantidade));
    if (qtd <= 0) continue;
    insumos++;
    await s.adjustInsumoStock(Number(m.insumo_id), qtd, tx);
    await s.insert(
      getResource('movimentacoes_insumos')!,
      { tipo: 'entrada', insumo_id: m.insumo_id, quantidade: qtd, custo_unitario: Number(m.custo_unitario || 0), motivo: `Estorno — OP #${id} reaberta`, usuario_id: actor.id || null },
      tx
    );
  }

  if (String(op.tipo || 'tamanho') === 'grade') {
    const itens = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, filter: { ordem_id: id } }, tx);
    for (const it of itens.rows) {
      await s.update(recursoOrdem().itens, Number(it.id), { produzido: 0 }, tx);
    }
  }

  await s.update(recursoOrdem().op, id, { concluida_em: null }, tx);
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'ordens',
      registro_id: id,
      descricao: `OP #${id} reaberta/cancelada — estorno de ${pecas} peça(s) e de ${insumos} consumo(s) de insumos`,
      dados: { pecas, insumos },
    },
    tx
  );
}

/**
 * Hook chamado por services.ts no create/update de OP quando o status muda
 * (ou ao criar já concluída). Executa DENTRO da transação do serviço.
 */
export async function aplicarRegrasOrdem(
  before: Row | null,
  after: Row,
  data: Payload,
  actor: Actor,
  tx: Tx,
  opts: OrdemOpts = {}
): Promise<void> {
  if (data.status === undefined) return;
  const statusAnterior = before ? String(before.status) : null;
  const statusNovo = String(after.status);

  if (statusNovo === 'cancelada' && statusAnterior && statusAnterior !== 'cancelada' && statusAnterior !== 'concluida') {
    // Cancelar uma OP que nunca foi concluída não tem efeito de estoque.
    return;
  }
  const concluindo = statusNovo === 'concluida' && statusAnterior !== 'concluida';
  const estornando = statusAnterior === 'concluida' && statusNovo !== 'concluida';
  if (concluindo) await concluirOrdem(after, actor, tx, opts);
  else if (estornando) await estornarOrdem(before!, actor, tx);
}

// ----------------------------------------------------------------------------
// Itens da OP (grade) — sub-recurso /api/ordens/:id/itens
// ----------------------------------------------------------------------------

async function getOrdem(id: number, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(recursoOrdem().op, { id }, tx);
  if (!row) throw new HttpError(404, 'Ordem de fabricação não encontrada.');
  return row;
}

function assertOrdemEditavel(op: Row) {
  const status = String(op.status);
  if (status === 'concluida' || status === 'cancelada') {
    throw new HttpError(409, `A OP #${op.id} está "${status === 'concluida' ? 'concluída' : 'cancelada'}" e os tamanhos não podem mais ser alterados. Reabra a OP para editar.`);
  }
}

export async function listItensOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  checkAccess(op, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getOrdem(id);
  const out = await getStore().list(itens, { page: 1, pageSize: 200, sort: 'tamanho_id', dir: 'asc', filter: { ordem_id: id } });
  res.json(out.rows);
}

export async function createItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      if (String(ordem.tipo || 'tamanho') !== 'grade') {
        throw new HttpError(409, 'Esta OP é "por tamanho". Use os campos tamanho/quantidade da própria OP. Converta para "por grade" para usar a grade PP–GG.');
      }
      assertOrdemEditavel(ordem);
      const data = validatePayload(itens, req.body, 'create');
      const qtd = Number(data.quantidade || 0);
      if (qtd <= 0) throw new HttpError(400, 'Informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
      const duplicado = await s.findOneWhere(itens, { ordem_id: id, tamanho_id: Number(data.tamanho_id) }, tx);
      if (duplicado) {
        throw new HttpError(409, 'Este tamanho já está na OP. Edite a quantidade existente.', { tamanho_id: 'Tamanho já incluído' });
      }
      const item = await s.insert(itens, { ...data, ordem_id: id, produzido: 0 }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: tamanho adicionado à grade (${qtd} un.)` },
        tx
      );
      return (await s.get(itens, Number(item.id), tx)) ?? item;
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function updateItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      assertOrdemEditavel(ordem);
      const before = await s.findOneWhere(itens, { id: itemId, ordem_id: id }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado nesta OP.');
      const data = validatePayload(itens, req.body, 'update');
      const item = await s.update(itens, itemId, data, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: item ${itemId} alterado` },
        tx
      );
      return (await s.get(itens, itemId, tx)) ?? item;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function deleteItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      assertOrdemEditavel(ordem);
      const before = await s.findOneWhere(itens, { id: itemId, ordem_id: id }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado nesta OP.');
      await s.remove(itens, itemId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: tamanho removido da grade` },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

// ----------------------------------------------------------------------------
// Custo de fabricação
// ----------------------------------------------------------------------------

/** Recalcula custo_calculado e preco_sugerido de uma ficha. */
export async function recalcularFichaValores(fichaId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const { ficha, itens } = recursoFicha();
  const f = await s.findOneWhere(ficha, { id: fichaId }, tx);
  if (!f) return null;

  const linhas = await s.list(itens, { page: 1, pageSize: 500, filter: { ficha_id: fichaId } }, tx);
  let insumosTotal = 0;
  for (const linha of linhas.rows) {
    const insumo = await s.findOneWhere(getResource('insumos')!, { id: Number(linha.insumo_id) }, tx);
    const custo = Number(insumo?.custo_medio || 0);
    const consumo = Number(linha.consumo || 0);
    const perda = Number(linha.perda_pct || 0);
    insumosTotal += consumo * (1 + perda / 100) * custo;
  }
  const custo = round2(insumosTotal + Number(f.mao_obra || 0) + Number(f.custos_indiretos || 0));
  const margem = Number(f.margem_pct || 0);
  const preco = round2(custo * (1 + margem / 100));
  const updated = await s.update(ficha, fichaId, { custo_calculado: custo, preco_sugerido: preco, calculado_em: new Date().toISOString() }, tx);
  return updated;
}

async function getFicha(id: number, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(recursoFicha().ficha, { id }, tx);
  if (!row) throw new HttpError(404, 'Ficha técnica não encontrada.');
  return row;
}

export async function listInsumosFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  checkAccess(ficha, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getFicha(id);
  const out = await getStore().list(itens, { page: 1, pageSize: 200, filter: { ficha_id: id } });
  res.json(out.rows);
}

export async function createInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const data = validatePayload(itens, req.body, 'create');
      const item = await s.insert(itens, { ...data, ficha_id: id }, tx);
      const f = await recalcularFichaValores(id, tx);
      const ins = await s.findOneWhere(getResource('insumos')!, { id: Number(data.insumo_id) }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${ins ? labelOf(getResource('insumos')!, ins) : `#${data.insumo_id}`} incluído (consumo ${Number(data.consumo)}${data.perda_pct ? `, perda ${data.perda_pct}%` : ''}) — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
        },
        tx
      );
      return (await s.get(itens, Number(item.id), tx)) ?? item;
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function updateInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const before = await s.findOneWhere(itens, { id: itemId, ficha_id: id }, tx);
      if (!before) throw new HttpError(404, 'Insumo não encontrado nesta ficha.');
      const data = validatePayload(itens, req.body, 'update');
      const item = await s.update(itens, itemId, data, tx);
      const f = await recalcularFichaValores(id, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${itemId} alterado — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
        },
        tx
      );
      return (await s.get(itens, itemId, tx)) ?? item;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function deleteInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const before = await s.findOneWhere(itens, { id: itemId, ficha_id: id }, tx);
      if (!before) throw new HttpError(404, 'Insumo não encontrado nesta ficha.');
      await s.remove(itens, itemId, tx);
      const f = await recalcularFichaValores(id, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${itemId} removido — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
        },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

/** POST /api/fichas/:id/aplicar-preco — copia custo/preço calculados ao produto. */
export async function aplicarPrecoFicha(req: Request, res: Response) {
  const { ficha } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const f = await getFicha(id, tx);
      const produtoId = Number(f.produto_id);
      if (!produtoId) throw new HttpError(400, 'A ficha não está vinculada a um produto.');
      const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
      if (!produto) throw new HttpError(404, 'Produto da ficha não encontrado.');
      const custo = Number(f.custo_calculado ?? 0);
      const preco = Number(f.preco_sugerido ?? 0);
      await s.update(getResource('produtos')!, produtoId, { custo, preco_venda: preco }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'produtos',
          registro_id: produtoId,
          descricao: `Custo e preço aplicados da ficha #${id} ao produto ${labelOf(getResource('produtos')!, produto)} — custo R$ ${custo}, preço sugerido R$ ${preco}`,
          dados: { ficha_id: id, custo, preco_venda: preco },
        },
        tx
      );
      return { custo, preco_venda: preco, produto_id: produtoId };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, ficha);
  }
}

// ----------------------------------------------------------------------------
// GET /api/producao/painel — cockpit da Produção (KPIs para o topo da lista de OPs)
// ----------------------------------------------------------------------------
export async function producaoPainel(req: Request, res: Response) {
  const actor = currentUser(req);
  const { op } = recursoOrdem();
  checkAccess(op, actor, 'read');
  const s = getStore();
  const [ordens, itensOrdem] = await Promise.all([
    s.list(op, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }),
    s.list(getResource('itens_ordem')!, { page: 1, pageSize: 10000 }),
  ]);
  const pecasDa = (o: Row): number => {
    if (String(o.tipo) === 'grade') {
      return itensOrdem.rows.filter((i) => Number(i.ordem_id) === Number(o.id)).reduce((a, i) => a + Number(i.quantidade || 0), 0);
    }
    return Number(o.quantidade || 0);
  };

  const hoje = new Date().toISOString().slice(0, 10);
  const mes = hoje.slice(0, 7);
  const abertas = ordens.rows.filter((o) => ['planejada', 'em_producao'].includes(String(o.status)));
  const atrasadas = abertas.filter((o) => o.previsao && String(o.previsao).slice(0, 10) < hoje);
  const concluidasMes = ordens.rows.filter((o) => {
    if (String(o.status) !== 'concluida') return false;
    const d = String(o.concluida_em || o.atualizado_em || o.criado_em || '').slice(0, 7);
    return d === mes;
  });
  const pecasMes = concluidasMes.reduce((a, o) => a + pecasDa(o), 0);
  const pecasAbertas = abertas.reduce((a, o) => a + pecasDa(o), 0);

  // Produção por semana (últimas 8 semanas, OPs concluídas)
  const semanas: { semana: string; label: string; pecas: number }[] = [];
  const agora = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - i * 7 - agora.getDay() + 1);
    const chave = d.toISOString().slice(0, 10);
    semanas.push({ semana: chave, label: `${chave.slice(8, 10)}/${chave.slice(5, 7)}`, pecas: 0 });
  }
  for (const o of ordens.rows) {
    if (String(o.status) !== 'concluida') continue;
    const dia = String(o.concluida_em || o.atualizado_em || o.criado_em || '').slice(0, 10);
    for (let i = semanas.length - 1; i >= 0; i--) {
      const ini = semanas[i].semana;
      const fim = i + 1 < semanas.length ? semanas[i + 1].semana : '9999-12-31';
      if (dia >= ini && dia < fim) {
        semanas[i].pecas += pecasDa(o);
        break;
      }
    }
  }

  res.json({
    planejadas: ordens.rows.filter((o) => String(o.status) === 'planejada').length,
    emProducao: ordens.rows.filter((o) => String(o.status) === 'em_producao').length,
    atrasadas: atrasadas.length,
    pecasAbertas,
    concluidasMes: concluidasMes.length,
    pecasMes,
    porSemana: semanas,
    alertas: atrasadas.slice(0, 6).map((o) => ({
      id: Number(o.id),
      produto: o.produto_id__label || `#${o.produto_id}`,
      previsao: o.previsao ? String(o.previsao).slice(0, 10) : null,
      quantidade: pecasDa(o),
      status: String(o.status),
    })),
  });
}
