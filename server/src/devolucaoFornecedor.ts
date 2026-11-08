// ============================================================================
// SUPPLY CHAIN — DEVOLUÇÃO AO FORNECEDOR (migration 0105)
//
// Operação inversa do recebimento de compra. Devolve ao fornecedor mercadoria
// RECEBIDA por avaria, divergência de qualidade, compra errada ou recall.
//
//   SOLICITADA ──autorizar──▶ AUTORIZADA ──expedir──▶ EXPEDIDA ──encerrar──▶ ENCERRADA
//        │                        │
//        └──────cancelar──────────┘   (cancelar só antes de expedir)
//
// REGRAS INEGOCIÁVEIS
//   • Só se devolve o que foi EFETIVAMENTE RECEBIDO da compra: a quantidade de
//     cada item nunca passa do recebido do item_compra — validado no serviço
//     (sob lock de domínio) e reforçado pelo trigger de banco (0105).
//   • O SALDO SÓ MUDA NA EXPEDIÇÃO, pela movimentação OFICIAL de saída
//     (services.lancarMovimentacaoDentro / lancarMovimentacaoInsumoDaOrdem).
//     Nenhum caminho escreve em estoques por conta própria.
//   • Idempotência: a criação é travada por idempotency_key (índice único por
//     empresa); a expedição carimba estoque_baixado uma única vez.
//   • empresa = tenant: todo predicado carrega empresa_id; o documento, a
//     compra e o fornecedor têm de ser da MESMA empresa do ator.
//   • Nada é apagado: CANCELADA é estado, não DELETE.
//   • RBAC: criar = escrita em compras; autorizar/expedir/encerrar/cancelar =
//     gerente ou administrador (mesmo critério do recebimento).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import {
  checkAccess,
  escopoDe,
  getStore,
  lancarMovimentacaoInterna,
  lancarMovimentacaoInsumoDaOrdem,
  resolveLocal,
  toHttpError,
  type Actor,
} from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa, empresaDoRegistroAudit, type EscopoEmpresa } from './empresa';
import { parseId } from './validate';
import { round2, round3 } from './utils';
import { domainLock } from './domainLock';
import { listarTodos } from './paginacaoCompleta';
import type { Row, Store, Tx } from './store';

const R_DEV = () => getResource('devolucoes_fornecedor')!;
const R_ITEM = () => getResource('devolucao_fornecedor_itens')!;
const R_EVENTO = () => getResource('devolucao_fornecedor_eventos')!;
const R_COMPRA = () => getResource('compras')!;
const R_ITENS_COMPRA = () => getResource('itens_compra')!;
const R_LOCAL = () => getResource('locais')!;

export const STATUS_DEVOLUCAO_FORNECEDOR = ['solicitada', 'autorizada', 'expedida', 'encerrada', 'cancelada'] as const;
export type StatusDevolucaoFornecedor = (typeof STATUS_DEVOLUCAO_FORNECEDOR)[number];

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function exigirGestor(actor: Actor, acao: string) {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, `Somente gerente ou administrador pode ${acao}.`);
  }
}

async function registrarEvento(
  s: Store,
  tx: Tx,
  empresaId: number,
  devolucaoId: number,
  anterior: string | null,
  novo: string,
  usuarioId: number | null,
  observacao?: string | null,
  dados?: unknown
): Promise<void> {
  await s.insert(
    R_EVENTO(),
    {
      empresa_id: empresaId,
      devolucao_id: devolucaoId,
      status_anterior: anterior,
      status_novo: novo,
      usuario_id: usuarioId,
      observacao: observacao ?? null,
      dados: dados === undefined ? null : dados,
    },
    tx
  );
}

async function devolucaoDaEmpresa(s: Store, id: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Row> {
  return assertRegistroDaEmpresa(R_DEV(), await s.findOneWhere(R_DEV(), { id, empresa_id: escopo.empresaId }, tx), escopo);
}

/** Itens do documento, completos (sem truncamento silencioso). */
async function itensCompletos(s: Store, empresaId: number, devolucaoId: number, tx?: Tx): Promise<Row[]> {
  return listarTodos(R_ITEM(), { empresa_id: empresaId, devolucao_id: devolucaoId }, tx);
}

/** Avança um estado específico por compare-and-swap (concorrência segura). */
async function transicionar(s: Store, tx: Tx, devolucao: Row, de: string, para: string, patch: Record<string, unknown>): Promise<Row> {
  const atualizada = await s.tryUpdateIf(R_DEV(), Number(devolucao.id), { empresa_id: devolucao.empresa_id, status: de }, { status: para, ...patch }, tx);
  if (!atualizada) throw new HttpError(409, 'O documento mudou durante a operação. Recarregue e tente de novo.');
  return atualizada;
}

// ----------------------------------------------------------------------------
// CRIAÇÃO — SOLICITADA
// ----------------------------------------------------------------------------

type ItemEntrada = { item_compra_id: number; quantidade: number };

function normalizarItens(bruto: unknown): ItemEntrada[] {
  if (!Array.isArray(bruto) || !bruto.length) {
    throw new HttpError(400, 'Envie `itens` com item_compra_id e quantidade.', { itens: 'Informe ao menos um item' });
  }
  const vistos = new Set<number>();
  return bruto.map((raw, index) => {
    const linha = (raw || {}) as Record<string, unknown>;
    const itemId = Number(linha.item_compra_id ?? linha.id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new HttpError(400, `Linha ${index + 1}: item_compra_id inválido.`, { [`itens[${index}].item_compra_id`]: 'Inválido' });
    }
    if (vistos.has(itemId)) throw new HttpError(400, `O item #${itemId} está repetido na devolução.`);
    vistos.add(itemId);
    const quantidade = round3(n(linha.quantidade ?? linha.qtd) ?? 0);
    if (!(quantidade > 0)) {
      throw new HttpError(400, `Linha ${index + 1}: a quantidade deve ser maior que zero.`, { [`itens[${index}].quantidade`]: 'Deve ser > 0' });
    }
    return { item_compra_id: itemId, quantidade };
  });
}

/**
 * Valida que a soma do que se quer devolver (por item) não ultrapasse o que foi
 * recebido, considerando devoluções ATIVAS (não canceladas) já existentes.
 */
async function validarItensContraRecebido(s: Store, empresaId: number, itens: ItemEntrada[], tx: Tx): Promise<void> {
  for (const linha of itens) {
    const itemCompra = await s.findOneWhere(R_ITENS_COMPRA(), { id: linha.item_compra_id, empresa_id: empresaId }, tx);
    if (!itemCompra) throw new HttpError(404, `Item de compra #${linha.item_compra_id} não encontrado nesta empresa.`);
    const recebido = Number(itemCompra.quantidade_recebida || 0);
    const existentes = await listarTodos(R_ITEM(), { empresa_id: empresaId, item_compra_id: linha.item_compra_id }, tx);
    let jaDevolvido = 0;
    for (const existente of existentes) {
      const pai = await s.get(R_DEV(), Number(existente.devolucao_id), tx);
      if (pai && String(pai.status) !== 'cancelada') jaDevolvido += Number(existente.quantidade || 0);
    }
    if (jaDevolvido + linha.quantidade > recebido + 1e-9) {
      const disponivel = round3(Math.max(0, recebido - jaDevolvido));
      throw new HttpError(409, `O item #${linha.item_compra_id} tem ${recebido} recebido(s) e ${jaDevolvido} já devolvido(s); só é possível devolver mais ${disponivel}.`, {
        itens: `Disponível para devolução: ${disponivel}`,
      });
    }
  }
}

/** POST /api/compras/:id/devolucoes — cria a devolução (status solicitada). */
export async function criarDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = R_DEV();
  checkAccess(R_COMPRA(), actor, 'update');
  const escopo = escopoDe(actor);
  const compraId = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const itens = normalizarItens(body.itens);
  const motivo = String(body.motivo ?? '').trim();
  if (!motivo) throw new HttpError(400, 'Informe o motivo da devolução.', { motivo: 'Campo obrigatório' });
  const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
    ? body.idempotency_key.trim().slice(0, 160)
    : null;
  const documentoOrigem = typeof body.documento_origem === 'string' ? body.documento_origem.trim().slice(0, 120) : null;
  const observacoes = typeof body.observacoes === 'string' ? body.observacoes : null;
  const localOrigemId = n(body.local_origem_id);

  try {
    const out = await domainLock(escopo.empresaId, 'devolucao_fornecedor', async (tx) => {
      const s = getStore();
      const compra = assertRegistroDaEmpresa(R_COMPRA(), await s.findOneWhere(R_COMPRA(), { id: compraId, empresa_id: escopo.empresaId }, tx), escopo);
      const fornecedorId = Number(compra.fornecedor_id);
      if (!Number.isInteger(fornecedorId) || fornecedorId <= 0) {
        throw new HttpError(409, 'A compra não tem fornecedor definido; não há a quem devolver.');
      }
      if (String(compra.status) === 'cancelado') {
        throw new HttpError(409, 'Não se devolve mercadoria de uma compra cancelada.');
      }
      if (localOrigemId !== null) {
        const local = await s.findOneWhere(R_LOCAL(), { id: localOrigemId, empresa_id: escopo.empresaId }, tx);
        if (!local) throw new HttpError(404, 'Local de origem não encontrado.');
      }

      if (idempotencyKey) {
        const existente = await s.findOneWhere(R_DEV(), { empresa_id: escopo.empresaId, idempotency_key: idempotencyKey }, tx);
        if (existente) {
          return { devolucao: existente, itens: await itensCompletos(s, escopo.empresaId, Number(existente.id), tx), replay: true };
        }
      }

      const devolucao = await s.insert(
        R_DEV(),
        {
          empresa_id: escopo.empresaId,
          compra_id: compraId,
          fornecedor_id: fornecedorId,
          status: 'solicitada',
          motivo,
          observacoes,
          local_origem_id: localOrigemId,
          documento_origem: documentoOrigem,
          solicitante_id: actor.id || null,
          idempotency_key: idempotencyKey,
          criado_por: actor.id || null,
        },
        tx
      );
      const devolucaoId = Number(devolucao.id);

      await validarItensContraRecebido(s, escopo.empresaId, itens, tx);

      const criados: Row[] = [];
      for (const linha of itens) {
        const itemCompra = await s.get(R_ITENS_COMPRA(), linha.item_compra_id, tx);
        criados.push(await s.insert(
          R_ITEM(),
          {
            empresa_id: escopo.empresaId,
            devolucao_id: devolucaoId,
            item_compra_id: linha.item_compra_id,
            produto_id: itemCompra?.produto_id ? Number(itemCompra.produto_id) : null,
            tamanho_id: itemCompra?.tamanho_id ? Number(itemCompra.tamanho_id) : null,
            insumo_id: itemCompra?.insumo_id ? Number(itemCompra.insumo_id) : null,
            quantidade: linha.quantidade,
            custo_unitario: round2(Number(itemCompra?.preco_unitario || 0)),
            // Explícito: o compare-and-swap da expedição depende deste valor
            // existir como FALSE (o banco tem DEFAULT, o store em memória não).
            estoque_baixado: false,
          },
          tx
        ));
      }

      await registrarEvento(s, tx, escopo.empresaId, devolucaoId, null, 'solicitada', actor.id || null, 'Devolução solicitada', { itens: itens.length });
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'criar',
          recurso: r.table,
          registro_id: devolucaoId,
          descricao: `Devolução ao fornecedor #${devolucaoId} da compra #${compraId} (${itens.length} item(ns))`,
          dados: { compra_id: compraId, itens },
          empresa_id: empresaDoRegistroAudit(R_COMPRA(), compra, actor),
        },
        tx
      );
      return { devolucao, itens: criados, replay: false };
    }, { isolation: 'serializable' });
    res.status(out.replay ? 200 : 201).json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

// ----------------------------------------------------------------------------
// TRANSIÇÕES
// ----------------------------------------------------------------------------

/** POST /api/devolucoes-fornecedor/:id/autorizar */
export async function autorizarDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor, 'autorizar a devolução ao fornecedor');
  checkAccess(R_COMPRA(), actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const r = R_DEV();
  try {
    const out = await domainLock(escopo.empresaId, 'devolucao_fornecedor', async (tx) => {
      const s = getStore();
      const dev = await devolucaoDaEmpresa(s, id, escopo, tx);
      if (String(dev.status) !== 'solicitada') throw new HttpError(409, `Só se autoriza uma devolução solicitada (status atual: ${dev.status}).`);
      const itens = await itensCompletos(s, escopo.empresaId, id, tx);
      if (!itens.length) throw new HttpError(409, 'A devolução não tem itens.');
      const atualizada = await transicionar(s, tx, dev, 'solicitada', 'autorizada', { autorizada_em: new Date().toISOString(), autorizador_id: actor.id || null });
      await registrarEvento(s, tx, escopo.empresaId, id, 'solicitada', 'autorizada', actor.id || null, 'Devolução autorizada');
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/**
 * POST /api/devolucoes-fornecedor/:id/expedir
 *
 * A SAÍDA de estoque acontece aqui, uma única vez, pela movimentação OFICIAL.
 * O compare-and-swap em estoque_baixado de cada item garante que a baixa não se
 * repita (idempotência sob concorrência).
 */
export async function expedirDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor, 'expedir a devolução ao fornecedor');
  checkAccess(R_COMPRA(), actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const r = R_DEV();
  try {
    const out = await domainLock(escopo.empresaId, 'devolucao_fornecedor', async (tx) => {
      const s = getStore();
      const dev = await devolucaoDaEmpresa(s, id, escopo, tx);
      if (String(dev.status) !== 'autorizada') throw new HttpError(409, `Só se expede uma devolução autorizada (status atual: ${dev.status}).`);
      const itens = await itensCompletos(s, escopo.empresaId, id, tx);
      if (!itens.length) throw new HttpError(409, 'A devolução não tem itens.');

      // Local de origem (obrigatório para a baixa física).
      const localData: Record<string, unknown> = {};
      if (dev.local_origem_id !== null && dev.local_origem_id !== undefined) localData.local_id = Number(dev.local_origem_id);
      else if (dev.local) localData.local = String(dev.local);
      await resolveLocal(localData, tx, escopo);

      const baixados: Array<{ item: number; movimentacao_id: number | null; tipo: 'produto' | 'insumo' }> = [];
      for (const item of itens) {
        if (item.estoque_baixado === true || item.estoque_baixado === 1) continue;
        const quantidade = Number(item.quantidade);
        const produtoId = item.produto_id !== null && item.produto_id !== undefined ? Number(item.produto_id) : null;
        const insumoId = item.insumo_id !== null && item.insumo_id !== undefined ? Number(item.insumo_id) : null;
        const motivo = `Devolução ao fornecedor #${id} — ${dev.motivo}`;

        let movimentacaoId: number | null = null;
        let tipo: 'produto' | 'insumo' = 'produto';
        if (produtoId) {
          const mov = await lancarMovimentacaoInterna(
            {
              tipo: 'saida',
              produto_id: produtoId,
              tamanho_id: item.tamanho_id ?? null,
              ...localData,
              quantidade,
              motivo,
              compra_id: Number(dev.compra_id),
              item_compra_id: Number(item.item_compra_id),
              custo_unitario: Number(item.custo_unitario || 0),
              devolucao_fornecedor_id: id,
            },
            actor,
            tx,
            escopo
          );
          movimentacaoId = Number(mov.id);
        } else if (insumoId) {
          tipo = 'insumo';
          const mov = await lancarMovimentacaoInsumoDaOrdem(
            {
              tipo: 'saida',
              insumo_id: insumoId,
              quantidade,
              motivo,
              compra_id: Number(dev.compra_id),
              item_compra_id: Number(item.item_compra_id),
              custo_unitario: Number(item.custo_unitario || 0),
              devolucao_fornecedor_id: id,
            },
            actor,
            tx,
            escopo
          );
          movimentacaoId = Number(mov.id);
        } else {
          throw new HttpError(422, `O item #${item.id} não tem produto nem insumo; não há o que baixar.`);
        }

        // Compare-and-swap: marca a baixa uma única vez.
        const patch = tipo === 'produto'
          ? { estoque_baixado: true, movimentacao_id: movimentacaoId }
          : { estoque_baixado: true, movimentacao_insumo_id: movimentacaoId };
        const gravado = await s.tryUpdateIf(R_ITEM(), Number(item.id), { empresa_id: escopo.empresaId, estoque_baixado: false }, patch, tx);
        if (!gravado) {
          // Outra requisição já baixou este item: a movimentação recém-criada
          // é desfeita pelo rollback da transação.
          throw new HttpError(409, 'A baixa de estoque da devolução já foi aplicada. Recarregue e confira.');
        }
        baixados.push({ item: Number(item.id), movimentacao_id: movimentacaoId, tipo });
      }

      const atualizada = await transicionar(s, tx, dev, 'autorizada', 'expedida', { expedida_em: new Date().toISOString() });
      await registrarEvento(s, tx, escopo.empresaId, id, 'autorizada', 'expedida', actor.id || null, 'Mercadoria expedida (baixa de estoque aplicada)', { baixados });
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: r.table,
          registro_id: id,
          descricao: `Devolução ao fornecedor #${id} expedida — ${baixados.length} item(ns) baixado(s)`,
          dados: { baixados },
          empresa_id: empresaDoRegistroAudit(R_DEV(), dev, actor),
        },
        tx
      );
      return { devolucao: atualizada, baixados };
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/** POST /api/devolucoes-fornecedor/:id/encerrar */
export async function encerrarDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor, 'encerrar a devolução ao fornecedor');
  checkAccess(R_COMPRA(), actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const r = R_DEV();
  try {
    const out = await domainLock(escopo.empresaId, 'devolucao_fornecedor', async (tx) => {
      const s = getStore();
      const dev = await devolucaoDaEmpresa(s, id, escopo, tx);
      if (String(dev.status) !== 'expedida') throw new HttpError(409, `Só se encerra uma devolução expedida (status atual: ${dev.status}).`);
      const atualizada = await transicionar(s, tx, dev, 'expedida', 'encerrada', { encerrada_em: new Date().toISOString() });
      await registrarEvento(s, tx, escopo.empresaId, id, 'expedida', 'encerrada', actor.id || null, 'Devolução encerrada');
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/** POST /api/devolucoes-fornecedor/:id/cancelar — só antes de expedir. */
export async function cancelarDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGestor(actor, 'cancelar a devolução ao fornecedor');
  checkAccess(R_COMPRA(), actor, 'update');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const motivo = String((req.body || {}).motivo ?? '').trim().slice(0, 500);
  const r = R_DEV();
  try {
    const out = await domainLock(escopo.empresaId, 'devolucao_fornecedor', async (tx) => {
      const s = getStore();
      const dev = await devolucaoDaEmpresa(s, id, escopo, tx);
      // Cancelar depois da expedição reabriria estoque de mercadoria que já saiu:
      // exige estorno explícito da movimentação, não um "cancelar" silencioso.
      if (String(dev.status) === 'expedida' || String(dev.status) === 'encerrada') {
        throw new HttpError(409, 'Devolução já expedida não pode ser cancelada — estorne a movimentação de saída se necessário.');
      }
      if (String(dev.status) === 'cancelada') return dev;
      const atualizada = await transicionar(s, tx, dev, String(dev.status), 'cancelada', { cancelada_em: new Date().toISOString(), motivo_cancelamento: motivo || null });
      await registrarEvento(s, tx, escopo.empresaId, id, String(dev.status), 'cancelada', actor.id || null, motivo || 'Devolução cancelada');
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/** GET /api/devolucoes-fornecedor/:id — documento + itens + eventos. */
export async function obterDevolucaoFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_DEV(), actor, 'read');
  const escopo = escopoDe(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  const dev = await devolucaoDaEmpresa(s, id, escopo);
  const [itens, eventos] = await Promise.all([
    itensCompletos(s, escopo.empresaId, id),
    listarTodos(R_EVENTO(), { empresa_id: escopo.empresaId, devolucao_id: id }),
  ]);
  const total = round2(itens.reduce((acc, it) => acc + Number(it.quantidade) * Number(it.custo_unitario || 0), 0));
  res.json({ ...dev, itens, eventos: eventos.sort((a, b) => Number(b.id) - Number(a.id)), resumo: { itens: itens.length, total } });
}
