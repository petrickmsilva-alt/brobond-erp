// ============================================================
// Fase 4 — Estoque e inventário.
//
//   GET  /api/estoques/grade             matriz produto × tamanhos
//   GET  /api/inventarios/:id/itens      contagem do inventário
//   PUT  /api/inventarios/:id/itens      contagem em lote { itens: [...] }
//   POST /api/inventarios/:id/fechar     gera ajustes (gerente/admin)
//
// A abertura do inventário (POST /api/inventarios) passa pelo CRUD genérico,
// que congela o saldo (abrirInventarioSnapshot em services.ts).
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { RESOURCES, getResource } from './resources';
import { checkAccess, getDefaultLocal, getRecord, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import type { Row } from './store';
import { parseId } from './validate';
import { labelOf } from './store';

// ----------------------------------------------------------------------------
// GET /api/estoques/grade — matriz produto × tamanhos
// ----------------------------------------------------------------------------
export async function estoqueGrade(req: Request, res: Response) {
  const r = RESOURCES.estoques;
  checkAccess(r, currentUser(req), 'read');
  const s = getStore();
  const colecaoId = req.query.colecao_id ? Number(req.query.colecao_id) : undefined;
  const categoriaId = req.query.categoria_id ? Number(req.query.categoria_id) : undefined;
  const local = typeof req.query.local === 'string' && req.query.local ? String(req.query.local) : null;

  const [produtos, tamanhos, estoques] = await Promise.all([
    s.list(RESOURCES.produtos, { page: 1, pageSize: 2000, filter: colecaoId ? { colecao_id: colecaoId } : categoriaId ? { categoria_id: categoriaId } : {} }),
    s.list(RESOURCES.tamanhos, { page: 1, pageSize: 200, sort: 'ordem', dir: 'asc' }),
    s.list(RESOURCES.estoques, { page: 1, pageSize: 5000, filter: local ? { local } : {} }),
  ]);

  const colunas = tamanhos.rows.map((t) => ({ id: Number(t.id), codigo: String(t.codigo || '') }));
  const filtrados = produtos.rows.filter((p) => {
    if (colecaoId && Number(p.colecao_id) !== colecaoId) return false;
    if (categoriaId && Number(p.categoria_id) !== categoriaId) return false;
    return true;
  });

  const linhas = filtrados.map((p) => {
    const doProduto = estoques.rows.filter((e) => Number(e.produto_id) === Number(p.id));
    // Sem filtro de local: soma os locais. Com filtro: só aquele local.
    const celulas = colunas.map((c) => {
      const linhasLocal = local ? doProduto.filter((e) => String(e.local || 'loja') === local) : doProduto;
      const daTamanho = linhasLocal.filter((e) => Number(e.tamanho_id) === c.id);
      const quantidade = daTamanho.reduce((a, e) => a + Number(e.quantidade || 0), 0);
      const estoqueMin = daTamanho.reduce((a, e) => a + Number(e.estoque_min || 0), 0);
      return { tamanho_id: c.id, quantidade, estoque_min: estoqueMin };
    });
    return {
      produto: {
        id: Number(p.id),
        sku: p.sku,
        nome: p.nome,
        cor: p.cor_id__label ?? p.cor ?? null,
        cor_hex: p.cor_id__color ?? null,
        categoria_id__label: p.categoria_id__label ?? null,
        colecao_id__label: p.colecao_id__label ?? null,
        foto_url: p.foto_url ?? null,
        preco_venda: Number(p.preco_venda || 0),
        custo: Number(p.custo || 0),
      },
      celulas,
      total: celulas.reduce((a, c) => a + c.quantidade, 0),
    };
  });

  res.json({
    colunas,
    local: local ?? 'todos',
    locaisDisponiveis: Array.from(new Set(estoques.rows.map((e) => String(e.local || 'loja')))).sort(),
    totalPecas: linhas.reduce((a, l) => a + l.total, 0),
    linhas,
  });
}

// ----------------------------------------------------------------------------
// Inventário — itens e fechamento
// ----------------------------------------------------------------------------

async function getInventario(id: number): Promise<Row> {
  const row = await getStore().findOneWhere(RESOURCES.inventarios, { id });
  if (!row) throw new HttpError(404, 'Inventário não encontrado.');
  return row;
}

/** GET /api/inventarios/:id/itens */
export async function listItensInventario(req: Request, res: Response) {
  checkAccess(RESOURCES.inventarios, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getInventario(id);
  const s = getStore();
  const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { inventario_id: id }, sort: 'id', dir: 'asc' });
  // Anexa miniatura do produto para exibir na contagem.
  const produtos = await s.list(RESOURCES.produtos, { page: 1, pageSize: 2000 });
  const { attachImages } = await import('./uploads');
  await attachImages(RESOURCES.produtos, produtos.rows);
  const fotoPor = new Map(produtos.rows.map((p) => [Number(p.id), p.foto_url ?? null]));
  for (const it of itens.rows) {
    it.produto_id__foto = fotoPor.get(Number(it.produto_id)) ?? null;
    it.produto_id__label = it.produto_id__label ?? (produtos.rows.find((p) => Number(p.id) === Number(it.produto_id)) ? labelOf(RESOURCES.produtos, produtos.rows.find((p) => Number(p.id) === Number(it.produto_id))!) : null);
    it.tamanho_id__label = it.tamanho_id__label ?? null;
    it.diferenca = it.contado === null || it.contado === undefined ? 0 : Number(it.contado) - Number(it.saldo_sistema);
  }
  res.json(itens.rows);
}

/**
 * PUT /api/inventarios/:id/itens — contagem em lote.
 * Body: { itens: [{ id?, produto_id?, tamanho_id?, contado }] }
 * Para produtos/tamanhos sem linha prévia (saldo zero), cria com saldo 0.
 */
export async function updateItensInventario(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const inv = await s.findOneWhere(RESOURCES.inventarios, { id }, tx);
      if (!inv) throw new HttpError(404, 'Inventário não encontrado.');
      if (String(inv.status) !== 'aberto') throw new HttpError(409, 'Este inventário já foi fechado e a contagem não pode mais mudar.');

      const body = (req.body || {}) as { itens?: unknown };
      const lista = Array.isArray(body.itens) ? (body.itens as Record<string, unknown>[]) : [];
      if (!lista.length) throw new HttpError(400, 'Envie ao menos um item com a contagem (body: { itens: [...] }).');

      let alterados = 0;
      for (const raw of lista) {
        const itemId = raw.id === undefined || raw.id === null || raw.id === '' ? null : Number(raw.id);
        const contado = raw.contado === undefined || raw.contado === null || raw.contado === '' ? null : Number(raw.contado);
        if (contado !== null && (!Number.isInteger(contado) || contado < 0)) {
          throw new HttpError(400, 'A quantidade contada deve ser um número inteiro ≥ 0.', { contado: 'Valor inválido' });
        }
        if (itemId && Number.isInteger(itemId)) {
          const before = await s.findOneWhere(RESOURCES.itens_inventario, { id: itemId, inventario_id: id }, tx);
          if (!before) throw new HttpError(404, `Item #${itemId} não pertence a este inventário.`);
          const diferenca = contado === null ? 0 : contado - Number(before.saldo_sistema || 0);
          await s.update(RESOURCES.itens_inventario, itemId, { contado, diferenca }, tx);
          alterados++;
          continue;
        }
        // Linha nova: produto+tamanho que não tinha saldo (contagem de "achado")
        const produtoId = Number(raw.produto_id);
        const tamanhoId = Number(raw.tamanho_id);
        if (!produtoId || !tamanhoId) throw new HttpError(400, 'Cada item deve ter id OU produto_id + tamanho_id.');
        if (contado === null) continue;
        const existente = await s.findOneWhere(RESOURCES.itens_inventario, { inventario_id: id, produto_id: produtoId, tamanho_id: tamanhoId }, tx);
        if (existente) {
          await s.update(RESOURCES.itens_inventario, Number(existente.id), { contado, diferenca: contado - Number(existente.saldo_sistema || 0) }, tx);
        } else {
          await s.insert(RESOURCES.itens_inventario, { inventario_id: id, produto_id: produtoId, tamanho_id: tamanhoId, saldo_sistema: 0, contado, diferenca: contado }, tx);
        }
        alterados++;
      }
      if (alterados > 0) {
        await s.audit(
          { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'inventarios', registro_id: id, descricao: `Inventário #${id}: contagem atualizada (${alterados} linha(s))` },
          tx
        );
      }
      return { ok: true, alterados };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, RESOURCES.itens_inventario);
  }
}

/** POST /api/inventarios/:id/fechar — gera os ajustes de estoque (1ª e única vez). */
export async function fecharInventario(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Somente gerentes e administradores podem fechar inventários (os ajustes alteram o estoque).');
  }
  checkAccess(RESOURCES.inventarios, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const inv = await s.findOneWhere(RESOURCES.inventarios, { id }, tx);
      if (!inv) throw new HttpError(404, 'Inventário não encontrado.');
      if (String(inv.status) === 'fechado') {
        throw new HttpError(409, `O inventário #${id} já foi fechado em ${String(inv.fechado_em || '').slice(0, 16)}. Os ajustes só podem ser gerados uma vez.`);
      }
      const local = inv.local ? String(inv.local) : await getDefaultLocal(tx);
      const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { inventario_id: id } }, tx);
      let ajustes = 0;
      const detalhes: string[] = [];
      for (const it of itens.rows) {
        const saldoSistema = Number(it.saldo_sistema || 0);
        const contado = it.contado === null || it.contado === undefined ? saldoSistema : Number(it.contado);
        const delta = contado - saldoSistema;
        if (delta === 0) continue;
        const produtoId = Number(it.produto_id);
        const tamanhoId = Number(it.tamanho_id);
        await s.adjustStock(produtoId, tamanhoId, local, delta, tx);
        await s.insert(
          RESOURCES.movimentacoes,
          { tipo: 'ajuste', produto_id: produtoId, tamanho_id: tamanhoId, local, quantidade: delta, motivo: `Inventário #${id}`, usuario_id: actor.id || null },
          tx
        );
        const p = await s.findOneWhere(RESOURCES.produtos, { id: produtoId }, tx);
        const t = await s.findOneWhere(RESOURCES.tamanhos, { id: tamanhoId }, tx);
        const nome = p ? labelOf(RESOURCES.produtos, p) : `#${produtoId}`;
        detalhes.push(`${nome}${t ? ` ${t.codigo}` : ''}: ${saldoSistema} → ${contado}`);
        ajustes++;
      }
      await s.update(RESOURCES.inventarios, id, { status: 'fechado', fechado_por: actor.name, fechado_em: new Date().toISOString() }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'ajuste',
          recurso: 'inventarios',
          registro_id: id,
          descricao: `Inventário #${id} fechado no local "${local}" — ${ajustes} ajuste(s) gerado(s): ${detalhes.join('; ')}`,
          dados: { ajustes, local },
        },
        tx
      );
      return { ok: true, ajustes, fechado_em: new Date().toISOString() };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, RESOURCES.inventarios);
  }
}

/** GET /api/inventarios/:id — com resumo da contagem (diferenças). */
export async function getInventarioDetalhe(req: Request, res: Response) {
  checkAccess(RESOURCES.inventarios, currentUser(req), 'read');
  const id = parseId(req.params.id);
  const inv = await getRecord(RESOURCES.inventarios, id);
  const s = getStore();
  const itens = await s.list(RESOURCES.itens_inventario, { page: 1, pageSize: 5000, filter: { inventario_id: id } });
  let contados = 0;
  let divergencias = 0;
  let totalSistema = 0;
  let totalContado = 0;
  for (const it of itens.rows) {
    const saldo = Number(it.saldo_sistema || 0);
    const contado = it.contado === null || it.contado === undefined ? saldo : Number(it.contado);
    if (it.contado !== null && it.contado !== undefined) contados++;
    if (contado !== saldo) divergencias++;
    totalSistema += saldo;
    totalContado += contado;
  }
  res.json({
    ...inv,
    resumo: { itens: itens.rows.length, contados, divergencias, totalSistema, totalContado },
  });
}

// ----------------------------------------------------------------------------
// POST /api/movimentacoes/:id/estornar — estorna uma movimentação
// ----------------------------------------------------------------------------
export async function estornarMovimentacao(req: Request, res: Response) {
  const actor = currentUser(req);
  // Apenas gerente e admin podem estornar movimentações
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, 'Somente gerentes e administradores podem estornar movimentações.');
  }
  checkAccess(RESOURCES.movimentacoes, actor, 'create');
  const id = parseId(req.params.id);
  const s = getStore();

  try {
    const result = await s.transaction(async (tx) => {
      const mov = await s.findOneWhere(RESOURCES.movimentacoes, { id }, tx);
      if (!mov) throw new HttpError(404, 'Movimentação não encontrada.');

      // Verifica se já foi estornada
      if (mov.estornado === true || mov.estornado === 1) {
        throw new HttpError(409, 'Esta movimentação já foi estornada.');
      }

      const tipo = String(mov.tipo);
      const quantidade = Number(mov.quantidade);
      const produtoId = Number(mov.produto_id);
      const tamanhoId = Number(mov.tamanho_id);
      const local = mov.local ? String(mov.local) : await getDefaultLocal(tx);

      // Calcula a movimentação inversa
      let tipoInverso: string;
      let quantidadeInversa: number;

      if (tipo === 'entrada') {
        tipoInverso = 'saida';
        quantidadeInversa = quantidade;
      } else if (tipo === 'saida') {
        tipoInverso = 'entrada';
        quantidadeInversa = quantidade;
      } else if (tipo === 'ajuste') {
        tipoInverso = 'ajuste';
        quantidadeInversa = -quantidade;
      } else if (tipo === 'transferencia') {
        // Para transferência, precisamos inverter origem e destino
        tipoInverso = 'transferencia';
        quantidadeInversa = quantidade;
      } else {
        throw new HttpError(400, `Tipo de movimentação desconhecido: ${tipo}`);
      }

      // Ajusta o estoque (inverte o efeito original)
      if (tipo === 'transferencia') {
        const localDestino = String(mov.local_destino || '');
        if (!localDestino) throw new HttpError(400, 'Transferência sem local de destino.');
        // Inverte: volta do destino para a origem
        await s.adjustStock(produtoId, tamanhoId, localDestino, -quantidade, tx);
        await s.adjustStock(produtoId, tamanhoId, local, quantidade, tx);
      } else {
        // Para entrada/saida/ajuste, inverte o delta
        const deltaOriginal = tipo === 'entrada' ? quantidade : tipo === 'saida' ? -quantidade : quantidade;
        await s.adjustStock(produtoId, tamanhoId, local, -deltaOriginal, tx);
      }

      // Cria a movimentação de estorno
      const estornoData: Record<string, unknown> = {
        tipo: tipoInverso,
        produto_id: produtoId,
        tamanho_id: tamanhoId,
        local: tipo === 'transferencia' ? String(mov.local_destino) : local,
        local_id: tipo === 'transferencia' ? (mov.local_destino_id ?? null) : (mov.local_id ?? null),
        quantidade: quantidadeInversa,
        motivo: `Estorno da movimentação #${id}: ${mov.motivo || ''}`.trim(),
        usuario_id: actor.id || null,
      };

      if (tipo === 'transferencia') {
        estornoData.local_destino = local;
        estornoData.local_destino_id = mov.local_id ?? null;
      }

      const movEstorno = await s.insert(RESOURCES.movimentacoes, estornoData, tx);

      // Marca a movimentação original como estornada
      await s.update(
        RESOURCES.movimentacoes,
        id,
        {
          estornado: true,
          estornado_em: new Date().toISOString(),
          estornado_por: actor.name,
          movimentacao_estorno_id: movEstorno.id,
        },
        tx
      );

      // Registra na auditoria
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'estornar',
          recurso: 'movimentacoes',
          registro_id: id,
          descricao: `Movimentação #${id} estornada (${tipo} de ${quantidade} peça(s))`,
        },
        tx
      );

      return {
        ok: true,
        movimentacao_original_id: id,
        movimentacao_estorno_id: movEstorno.id,
        tipo_inverso: tipoInverso,
        quantidade_inversa: quantidadeInversa,
      };
    });
    res.json(result);
  } catch (e) {
    throw toHttpError(e, RESOURCES.movimentacoes);
  }
}
