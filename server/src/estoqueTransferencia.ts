// ============================================================================
// ESTOQUE — TRANSFERÊNCIA FORMAL, RESERVA E DISPONIBILIDADE (migration 0052)
// ----------------------------------------------------------------------------
// O QUE ESTE MÓDULO RESOLVE
//   1) TRANSFERÊNCIA ENTRE LOCAIS COMO DOCUMENTO. Antes existia apenas o
//      lançamento instantâneo `movimentacoes.tipo = 'transferencia'`. Agora
//      existe o documento com estados e rastro:
//
//          SOLICITADA ──aprovar──▶ APROVADA ──expedir──▶ EM_TRANSITO
//                                                        │
//                                                    receber
//                                                        ▼
//                                                    RECEBIDA
//          (CANCELADA só antes da expedição)
//
//      O SALDO NÃO É TOCADO PELO DOCUMENTO. Quem movimenta estoque é a
//      movimentação oficial (services.lancarMovimentacaoDentro), chamada em
//      DOIS eventos: expedição (saída na origem) e recebimento (entrada no
//      destino). Assim o "em trânsito" é o estado do documento, não um saldo
//      paralelo — não existe estoque duplicado.
//
//   2) RESERVA / EMPENHO / BLOQUEIO. Quantidade comprometida por um documento
//      com tipo explícito. Liberar devolve ao disponível; NUNCA movimenta.
//
//   3) DISPONIBILIDADE derivada, sem tabela nova:
//          disponível = físico − reservado − bloqueado − empenhado
//
// REGRAS INEGOCIÁVEIS
//   • empresa = tenant: todo predicado carrega `empresa_id`; referência de
//     outra empresa é 404, nunca 403 (não vaza existência);
//   • RBAC: solicitar = quem tem escrita em estoque; aprovar/expedir/receber/
//     cancelar = gerente ou admin (o mesmo critério de ajuste de saldo);
//   • estado inválido é 409 com a razão — nunca "meia transferência";
//   • nada é apagado: CANCELADA é um estado do documento.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, lancarMovimentacaoDentro, toHttpError, type Actor } from './services';
import { currentUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa } from './empresa';
import { parseId } from './validate';
import type { Row, Store, Tx } from './store';

const R_TRANSF = () => getResource('estoque_transferencias')!;
const R_ITEM = () => getResource('estoque_transferencia_itens')!;
const R_EVENTO = () => getResource('estoque_transferencia_eventos')!;
const R_RESERVA = () => getResource('estoque_reservas')!;
const R_ESTOQUE = () => getResource('estoques')!;
const R_LOCAL = () => getResource('locais')!;

export const STATUS_TRANSFERENCIA = ['solicitada', 'aprovada', 'em_transito', 'recebida', 'cancelada'] as const;
export type StatusTransferencia = (typeof STATUS_TRANSFERENCIA)[number];

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function exigirGestor(actor: Actor, recurso: string) {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, `Somente gerente ou administrador pode ${recurso}.`);
  }
}

// ----------------------------------------------------------------------------
// DISPONIBILIDADE — cálculo derivado (físico − reservado − bloqueado − empenho)
// ----------------------------------------------------------------------------
export type LinhaDisponibilidade = {
  produto_id: number;
  tamanho_id: number | null;
  local_id: number | null;
  local: string | null;
  fisico: number;
  reservado: number;
  empenhado: number;
  bloqueado: number;
  em_transito: number;
  disponivel: number;
};

/**
 * Disponibilidade por produto/tamanho/local, recortada pela empresa.
 *
 * `fisico` vem de `estoques` (a única fonte do saldo). Os comprometimentos vêm
 * de `estoque_reservas` com status ATIVA. `em_transito` vem dos documentos de
 * transferência expedidos e ainda não recebidos, na origem.
 */
export async function calcularDisponibilidade(
  s: Store,
  escopo: EscopoEmpresa,
  filtro: { produto_id?: number | null; tamanho_id?: number | null; local_id?: number | null } = {},
  tx?: Tx
): Promise<LinhaDisponibilidade[]> {
  const where: Record<string, unknown> = { empresa_id: escopo.empresaId };
  if (filtro.produto_id) where.produto_id = filtro.produto_id;
  if (filtro.tamanho_id) where.tamanho_id = filtro.tamanho_id;
  if (filtro.local_id) where.local_id = filtro.local_id;

  const saldos = await s.list(R_ESTOQUE(), { page: 1, pageSize: 50_000, filter: where }, tx);
  const reservas = await s.list(R_RESERVA(), { page: 1, pageSize: 50_000, filter: where }, tx);
  const transferencias = await s.list(
    R_TRANSF(),
    { page: 1, pageSize: 50_000, filter: { empresa_id: escopo.empresaId, status: 'em_transito' } },
    tx
  );
  const itensEmTransito = transferencias.rows.length
    ? await s.list(
        R_ITEM(),
        { page: 1, pageSize: 50_000, filter: { empresa_id: escopo.empresaId } },
        tx
      )
    : { rows: [] as Row[] };
  const idsEmTransito = new Set(transferencias.rows.map((t) => Number(t.id)));
  const localDe = new Map(transferencias.rows.map((t) => [Number(t.id), Number(t.origem_local_id)]));

  const chave = (produtoId: number, tamanhoId: number | null, localId: number | null) => `${produtoId}|${tamanhoId ?? ''}|${localId ?? ''}`;
  const mapa = new Map<string, LinhaDisponibilidade>();

  for (const row of saldos.rows) {
    const produtoId = Number(row.produto_id);
    const tamanhoId = n(row.tamanho_id);
    const localId = n(row.local_id);
    const k = chave(produtoId, tamanhoId, localId);
    mapa.set(k, {
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      local_id: localId,
      local: row.local ? String(row.local) : null,
      fisico: Number(row.quantidade ?? 0),
      reservado: 0,
      empenhado: 0,
      bloqueado: 0,
      em_transito: 0,
      disponivel: 0,
    });
  }

  for (const r of reservas.rows) {
    if (String(r.status ?? 'ativa') !== 'ativa') continue;
    const produtoId = Number(r.produto_id);
    const tamanhoId = n(r.tamanho_id);
    const localId = n(r.local_id);
    const k = chave(produtoId, tamanhoId, localId);
    let linha = mapa.get(k);
    if (!linha) {
      // Comprometimento sem saldo registrado: aparece com físico zero (é
      // exatamente o caso que precisa de atenção — reserva sem estoque).
      linha = { produto_id: produtoId, tamanho_id: tamanhoId, local_id: localId, local: null, fisico: 0, reservado: 0, empenhado: 0, bloqueado: 0, em_transito: 0, disponivel: 0 };
      mapa.set(k, linha);
    }
    const qtd = Number(r.quantidade ?? 0);
    const tipo = String(r.tipo ?? 'reserva');
    if (tipo === 'bloqueio') linha.bloqueado += qtd;
    else if (tipo === 'empenho') linha.empenhado += qtd;
    else linha.reservado += qtd;
  }

  for (const item of itensEmTransito.rows) {
    if (!idsEmTransito.has(Number(item.transferencia_id))) continue;
    const produtoId = Number(item.produto_id);
    const tamanhoId = n(item.tamanho_id);
    const localId = n(localDe.get(Number(item.transferencia_id)));
    const k = chave(produtoId, tamanhoId, localId);
    let linha = mapa.get(k);
    if (!linha) {
      linha = { produto_id: produtoId, tamanho_id: tamanhoId, local_id: localId, local: null, fisico: 0, reservado: 0, empenhado: 0, bloqueado: 0, em_transito: 0, disponivel: 0 };
      mapa.set(k, linha);
    }
    const jaRecebido = Number(item.quantidade_recebida ?? 0);
    linha.em_transito += Math.max(0, Number(item.quantidade ?? 0) - jaRecebido);
  }

  for (const linha of mapa.values()) {
    linha.disponivel = linha.fisico - linha.reservado - linha.bloqueado - linha.empenhado;
  }
  return [...mapa.values()].sort((a, b) => a.produto_id - b.produto_id || (a.tamanho_id ?? 0) - (b.tamanho_id ?? 0));
}

/** GET /api/estoque/disponibilidade?produto_id=&tamanho_id=&local_id= */
export async function disponibilidadeHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_ESTOQUE(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const s = getStore();
  const linhas = await calcularDisponibilidade(s, escopo, {
    produto_id: n(req.query.produto_id),
    tamanho_id: n(req.query.tamanho_id),
    local_id: n(req.query.local_id),
  });
  res.json({
    regra: 'disponivel = fisico - reservado - bloqueado - empenhado',
    linhas,
    totais: {
      fisico: linhas.reduce((t, l) => t + l.fisico, 0),
      reservado: linhas.reduce((t, l) => t + l.reservado, 0),
      bloqueado: linhas.reduce((t, l) => t + l.bloqueado, 0),
      empenhado: linhas.reduce((t, l) => t + l.empenhado, 0),
      em_transito: linhas.reduce((t, l) => t + l.em_transito, 0),
      disponivel: linhas.reduce((t, l) => t + l.disponivel, 0),
    },
  });
}

// ----------------------------------------------------------------------------
// RESERVAS
// ----------------------------------------------------------------------------
async function registrarEvento(s: Store, tx: Tx, empresaId: number, transferenciaId: number, anterior: string | null, novo: string, usuarioId: number | null, observacao?: string | null) {
  await s.insert(
    R_EVENTO(),
    { empresa_id: empresaId, transferencia_id: transferenciaId, status_anterior: anterior, status_novo: novo, usuario_id: usuarioId, observacao: observacao ?? null },
    tx
  );
}

async function lerTransferencia(s: Store, escopo: EscopoEmpresa, id: number, tx?: Tx): Promise<Row> {
  return assertRegistroDaEmpresa(R_TRANSF(), await s.findOneWhere(R_TRANSF(), { id, empresa_id: escopo.empresaId }, tx), escopo);
}

async function itensDa(s: Store, escopo: EscopoEmpresa, id: number, tx?: Tx): Promise<Row[]> {
  const lista = await s.list(R_ITEM(), { page: 1, pageSize: 5_000, filter: { empresa_id: escopo.empresaId, transferencia_id: id } }, tx);
  return lista.rows;
}

// ----------------------------------------------------------------------------
// POST /api/estoque/transferencias — SOLICITADA
// ----------------------------------------------------------------------------
export async function criarTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  checkAccess(R_ESTOQUE(), actor, 'create');
  const escopo = escopoDoAtor(actor);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const origemId = n(body.origem_local_id);
  const destinoId = n(body.destino_local_id);
  if (!origemId || !destinoId) throw new HttpError(400, 'Informe o local de origem e o de destino.', { origem_local_id: 'Obrigatório' });
  if (origemId === destinoId) throw new HttpError(400, 'Origem e destino precisam ser locais diferentes.', { destino_local_id: 'Escolha outro local' });
  const itens = Array.isArray(body.itens) ? body.itens : [];
  if (!itens.length) throw new HttpError(400, 'Inclua ao menos um item na transferência.', { itens: 'Obrigatório' });

  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      for (const localId of [origemId, destinoId]) {
        const local = await s.findOneWhere(R_LOCAL(), { id: localId, empresa_id: escopo.empresaId }, tx);
        if (!local) throw new HttpError(404, 'Local não encontrado.');
        if (local.ativo === false) throw new HttpError(409, `O local "${local.nome}" está inativo.`);
      }
      const doc = await s.insert(
        R_TRANSF(),
        {
          empresa_id: escopo.empresaId,
          origem_local_id: origemId,
          destino_local_id: destinoId,
          status: 'solicitada',
          solicitante_id: actor.id ?? null,
          solicitada_em: new Date().toISOString(),
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 1000) : null,
        },
        tx
      );
      for (const item of itens) {
        const produtoId = n(item.produto_id);
        const quantidade = n(item.quantidade);
        if (!produtoId) throw new HttpError(400, 'Item sem produto.', { itens: 'Produto obrigatório' });
        if (!quantidade || quantidade <= 0) throw new HttpError(400, 'Quantidade do item deve ser maior que zero.', { itens: 'Quantidade inválida' });
        await s.insert(
          R_ITEM(),
          {
            empresa_id: escopo.empresaId,
            transferencia_id: Number(doc.id),
            produto_id: produtoId,
            tamanho_id: n(item.tamanho_id),
            quantidade,
          },
          tx
        );
      }
      await registrarEvento(s, tx, escopo.empresaId, Number(doc.id), null, 'solicitada', actor.id ?? null, 'Solicitação criada');
      return { ...doc, itens: await itensDa(s, escopo, Number(doc.id), tx) };
    });
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

// ----------------------------------------------------------------------------
// Transições de estado
// ----------------------------------------------------------------------------
export async function aprovarTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  exigirGestor(actor, 'aprovar uma transferência');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      const doc = await lerTransferencia(s, escopo, id, tx);
      const status = String(doc.status);
      if (status === 'aprovada') return { ...doc, idempotente: true };
      if (status !== 'solicitada') throw new HttpError(409, `Transferência em "${status}" não pode ser aprovada.`);
      // Saldo disponível (físico − comprometido) precisa cobrir os itens.
      const itens = await itensDa(s, escopo, id, tx);
      const disponibilidade = await calcularDisponibilidade(s, escopo, { local_id: Number(doc.origem_local_id) }, tx);
      for (const item of itens) {
        const linha = disponibilidade.find((l) => l.produto_id === Number(item.produto_id) && (l.tamanho_id ?? null) === (n(item.tamanho_id) ?? null));
        const disponivel = linha?.disponivel ?? 0;
        if (disponivel < Number(item.quantidade)) {
          throw new HttpError(
            409,
            `Saldo disponível insuficiente para o produto #${item.produto_id}: disponível ${disponivel}, solicitado ${item.quantidade}.`,
            { itens: 'Disponível insuficiente' }
          );
        }
      }
      const atualizado = await s.update(
        R_TRANSF(),
        id,
        { status: 'aprovada', aprovador_id: actor.id ?? null, aprovada_em: new Date().toISOString() },
        tx
      );
      await registrarEvento(s, tx, escopo.empresaId, id, status, 'aprovada', actor.id ?? null, 'Transferência aprovada');
      return atualizado;
    });
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

export async function expedirTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  exigirGestor(actor, 'expedir uma transferência');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      const doc = await lerTransferencia(s, escopo, id, tx);
      const status = String(doc.status);
      if (status === 'em_transito') return { ...doc, idempotente: true };
      if (status !== 'aprovada') throw new HttpError(409, `Transferência em "${status}" não pode ser expedida.`);
      const origem = await s.findOneWhere(R_LOCAL(), { id: Number(doc.origem_local_id), empresa_id: escopo.empresaId }, tx);
      if (!origem) throw new HttpError(404, 'Local de origem não encontrado.');
      const itens = await itensDa(s, escopo, id, tx);
      if (!itens.length) throw new HttpError(409, 'Transferência sem itens não pode ser expedida.');
      // SAÍDA na origem — pelo lançamento oficial (valida grade e saldo).
      for (const item of itens) {
        await lancarMovimentacaoDentro(
          {
            empresa_id: escopo.empresaId,
            tipo: 'saida',
            produto_id: Number(item.produto_id),
            tamanho_id: n(item.tamanho_id),
            local: String(origem.nome),
            local_id: Number(origem.id),
            quantidade: Number(item.quantidade),
            motivo: `Expedição da transferência #${id}`,
            usuario_id: actor.id ?? null,
          },
          actor,
          tx,
          escopo
        );
      }
      const atualizado = await s.update(R_TRANSF(), id, { status: 'em_transito', expedida_em: new Date().toISOString() }, tx);
      await registrarEvento(s, tx, escopo.empresaId, id, status, 'em_transito', actor.id ?? null, 'Saída lançada no local de origem');
      return atualizado;
    });
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

export async function receberTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  exigirGestor(actor, 'receber uma transferência');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const recebidos = Array.isArray(body.itens) ? body.itens : [];
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      const doc = await lerTransferencia(s, escopo, id, tx);
      const status = String(doc.status);
      if (status === 'recebida') return { ...doc, idempotente: true };
      if (status !== 'em_transito') throw new HttpError(409, `Transferência em "${status}" não pode ser recebida.`);
      const destino = await s.findOneWhere(R_LOCAL(), { id: Number(doc.destino_local_id), empresa_id: escopo.empresaId }, tx);
      if (!destino) throw new HttpError(404, 'Local de destino não encontrado.');
      const itens = await itensDa(s, escopo, id, tx);
      for (const item of itens) {
        const informado = recebidos.find((r: any) => Number(r.item_id) === Number(item.id));
        const quantidadeRecebida = informado ? n(informado.quantidade_recebida) : Number(item.quantidade);
        if (quantidadeRecebida === null || quantidadeRecebida < 0 || quantidadeRecebida > Number(item.quantidade)) {
          throw new HttpError(400, `Quantidade recebida inválida no item #${item.id}.`, { itens: 'Quantidade deve ficar entre zero e a solicitada' });
        }
        await s.update(R_ITEM(), Number(item.id), { quantidade_recebida: quantidadeRecebida }, tx);
        if (quantidadeRecebida > 0) {
          // ENTRADA no destino — pelo lançamento oficial.
          await lancarMovimentacaoDentro(
            {
              empresa_id: escopo.empresaId,
              tipo: 'entrada',
              produto_id: Number(item.produto_id),
              tamanho_id: n(item.tamanho_id),
              local: String(destino.nome),
              local_id: Number(destino.id),
              quantidade: quantidadeRecebida,
              motivo: `Recebimento da transferência #${id}`,
              usuario_id: actor.id ?? null,
            },
            actor,
            tx,
            escopo
          );
        }
      }
      const atualizado = await s.update(R_TRANSF(), id, { status: 'recebida', recebida_em: new Date().toISOString() }, tx);
      await registrarEvento(s, tx, escopo.empresaId, id, status, 'recebida', actor.id ?? null, 'Entrada lançada no local de destino');
      return { ...atualizado, itens: await itensDa(s, escopo, id, tx) };
    });
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

export async function cancelarTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  exigirGestor(actor, 'cancelar uma transferência');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const motivo = String(body.motivo ?? '').replace(/\s+/g, ' ').trim();
  if (!motivo) throw new HttpError(400, 'Informe o motivo do cancelamento.', { motivo: 'Obrigatório' });
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      const doc = await lerTransferencia(s, escopo, id, tx);
      const status = String(doc.status);
      if (status === 'cancelada') return { ...doc, idempotente: true };
      if (status === 'em_transito' || status === 'recebida') {
        throw new HttpError(409, 'Depois da expedição a transferência não pode ser cancelada — receba (ou receba parcial) e corrija por movimentação.');
      }
      const atualizado = await s.update(
        R_TRANSF(),
        id,
        { status: 'cancelada', cancelada_em: new Date().toISOString(), motivo_cancelamento: motivo.slice(0, 500) },
        tx
      );
      await registrarEvento(s, tx, escopo.empresaId, id, status, 'cancelada', actor.id ?? null, motivo);
      return atualizado;
    });
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

/** GET /api/estoque/transferencias/:id — documento + itens + eventos */
export async function detalharTransferencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_TRANSF(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  const doc = await lerTransferencia(s, escopo, id);
  const [itens, eventos, locais] = await Promise.all([
    itensDa(s, escopo, id),
    s.list(R_EVENTO(), { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, transferencia_id: id } }),
    s.list(R_LOCAL(), { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId } }),
  ]);
  const nomeLocal = new Map(locais.rows.map((l) => [Number(l.id), String(l.nome)]));
  res.json({
    ...doc,
    origem: nomeLocal.get(Number(doc.origem_local_id)) ?? null,
    destino: nomeLocal.get(Number(doc.destino_local_id)) ?? null,
    itens,
    eventos: eventos.rows
      .slice()
      .sort((a, b) => String(a.criado_em ?? '').localeCompare(String(b.criado_em ?? ''))),
  });
}

// ----------------------------------------------------------------------------
// RESERVAS — endpoint (a reserva precisa validar disponibilidade)
// ----------------------------------------------------------------------------
export type ReservaInternaPayload = {
  produto_id: number;
  tamanho_id?: number | null;
  local_id?: number | null;
  quantidade: number;
  tipo?: string;
  origem_recurso?: string | null;
  origem_id?: number | null;
  motivo?: string | null;
  expira_em?: string | null;
  criado_por?: number | null;
};

/**
 * NÚCLEO de criação de reserva — compartilhado pelo endpoint de estoque e pelo
 * checkout /loja (UMA regra de disponibilidade: soma dos locais candidatos,
 * mesmas mensagens). Transação opcional: o chamador pode embutir no seu tx.
 */
export async function criarReservaInterna(escopo: EscopoEmpresa, payload: ReservaInternaPayload, tx?: Tx): Promise<Row> {
  const produtoId = n(payload.produto_id);
  const quantidade = n(payload.quantidade);
  const tipo = String(payload.tipo ?? 'reserva');
  if (!produtoId) throw new HttpError(400, 'Informe o produto.', { produto_id: 'Obrigatório' });
  if (!quantidade || quantidade <= 0) throw new HttpError(400, 'A quantidade deve ser maior que zero.', { quantidade: 'Maior que zero' });
  if (!['reserva', 'empenho', 'bloqueio'].includes(tipo)) throw new HttpError(400, 'Tipo de reserva inválido.', { tipo: 'reserva, empenho ou bloqueio' });
  const localId = n(payload.local_id ?? null);
  const tamanhoId = n(payload.tamanho_id ?? null);
  const s = getStore();
  const disponibilidade = await calcularDisponibilidade(s, escopo, { produto_id: produtoId, tamanho_id: tamanhoId, local_id: localId }, tx);
  const disponivel = disponibilidade.reduce((t, l) => t + l.disponivel, 0);
  if (disponivel < quantidade) {
    throw new HttpError(409, `Disponível insuficiente: ${disponivel} peça(s) para reservar ${quantidade}.`, { quantidade: `Disponível: ${disponivel}` });
  }
  return s.insert(
    R_RESERVA(),
    {
      empresa_id: escopo.empresaId,
      produto_id: produtoId,
      tamanho_id: tamanhoId,
      local_id: localId,
      tipo,
      quantidade,
      status: 'ativa',
      origem_recurso: payload.origem_recurso ? String(payload.origem_recurso).slice(0, 60) : null,
      origem_id: n(payload.origem_id ?? null),
      motivo: payload.motivo ? String(payload.motivo).slice(0, 300) : null,
      criado_por: payload.criado_por ?? null,
      expira_em: payload.expira_em ? String(payload.expira_em).slice(0, 10) : null,
    },
    tx
  );
}

export async function criarReserva(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_RESERVA(), actor, 'read');
  checkAccess(R_ESTOQUE(), actor, 'create');
  const escopo = escopoDoAtor(actor);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) =>
      criarReservaInterna(
        escopo,
        {
          produto_id: body.produto_id,
          tamanho_id: body.tamanho_id,
          local_id: body.local_id,
          quantidade: body.quantidade,
          tipo: body.tipo,
          origem_recurso: body.origem_recurso,
          origem_id: body.origem_id,
          motivo: body.motivo,
          expira_em: body.expira_em,
          criado_por: actor.id ?? null,
        },
        tx
      )
    );
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}

/** NÚCLEO de liberação — idempotente por estado, usado também pelo commerce. */
export async function liberarReservaInterna(escopo: EscopoEmpresa, id: number, tx?: Tx): Promise<Row | ({ idempotente: true } & Row)> {
  const s = getStore();
  const reserva = assertRegistroDaEmpresa(
    R_RESERVA(),
    await s.findOneWhere(R_RESERVA(), { id, empresa_id: escopo.empresaId }, tx),
    escopo
  );
  if (String(reserva.status) === 'liberada') return { ...reserva, idempotente: true } as Row;
  if (String(reserva.status) !== 'ativa') throw new HttpError(409, `Reserva em "${reserva.status}" não pode ser liberada.`);
  // CAS sobre `ativa`: liberação × liberação vira idempotente, e liberação ×
  // consumo da conversão NÃO sobrescreve `consumida` com um update cego.
  const mudou = await s.tryUpdateIf(
    R_RESERVA(),
    id,
    { status: 'ativa' },
    { status: 'liberada', liberada_em: new Date().toISOString() },
    tx
  );
  if (mudou) return mudou;
  const deNovo = await s.findOneWhere(R_RESERVA(), { id, empresa_id: escopo.empresaId }, tx);
  if (deNovo && String(deNovo.status) === 'liberada') return { ...deNovo, idempotente: true } as Row;
  if (!deNovo) throw new HttpError(409, 'Reserva não existe mais.');
  throw new HttpError(409, `Reserva em "${deNovo.status}" não pode ser liberada.`);
}

export async function liberarReserva(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_RESERVA(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => liberarReservaInterna(escopo, id, tx));
    return res.json(resultado);
  } catch (e) {
    throw toHttpError(e);
  }
}
