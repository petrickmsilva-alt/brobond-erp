// Camada de serviço: CRUD genérico + regras de negócio por módulo
// (estoque, movimentações, ordens, usuários) + auditoria.
import { HttpError } from './errors';
import { MemStore } from './memdb';
import { PgStore, isPgAvailable, translatePgError } from './pgstore';
import { getResource, type Resource } from './resources';
import { labelOf, type ListParams, type Payload, type Row, type Store, type Tx } from './store';
import { validatePayload } from './validate';
import type { AuthUser } from './auth';
import { attachImages, removeAllFiles } from './uploads';

let store: Store | null = null;

export function getStore(): Store {
  if (!store) store = isPgAvailable() ? new PgStore() : new MemStore();
  return store;
}

/** Converte qualquer erro em HttpError legível para o cliente. */
export function toHttpError(e: any, r?: Resource): HttpError {
  if (e instanceof HttpError) return e;
  const pg = translatePgError(e, r);
  if (pg) return pg;
  if (e?.message === 'NO_DB') return new HttpError(503, 'Banco de dados indisponível.');
  console.error('Erro inesperado:', e);
  return new HttpError(500, 'Erro interno do servidor');
}

type Actor = Pick<AuthUser, 'id' | 'name' | 'perfil'>;

function audit(tx: Tx, actor: Actor, acao: 'criar' | 'editar' | 'excluir', r: Resource, id: number | null, descricao: string, dados?: unknown) {
  return getStore().audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao, recurso: r.key, registro_id: id, descricao, dados },
    tx
  );
}

/** Campos que mudaram entre o registro anterior e o payload (para a auditoria). */
function diff(before: Row, data: Payload): Record<string, { de: unknown; para: unknown }> {
  const out: Record<string, { de: unknown; para: unknown }> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'senha_hash') {
      out.senha = { de: '••••', para: '••••' };
      continue;
    }
    const prev = before[k];
    const same =
      prev === v ||
      (prev !== null && v !== null && prev !== undefined && v !== undefined && String(prev) === String(v)) ||
      (typeof prev === 'string' && typeof v === 'string' && prev.slice(0, 10) === v.slice(0, 10) && /^\d{4}-\d{2}-\d{2}/.test(v));
    if (!same) out[k] = { de: prev ?? null, para: v ?? null };
  }
  return out;
}

export function checkAccess(r: Resource, actor: Actor, op: 'read' | 'create' | 'update' | 'delete') {
  if (r.adminOnly && actor.perfil !== 'admin') {
    throw new HttpError(403, 'Apenas administradores acessam este módulo.');
  }
  if (op !== 'read' && !r.ops[op]) {
    const verbo = op === 'create' ? 'incluir' : op === 'update' ? 'alterar' : 'excluir';
    throw new HttpError(405, `Não é possível ${verbo} registros em ${r.label}.`);
  }
  if (op === 'delete' && actor.perfil === 'operador') {
    throw new HttpError(403, 'Operadores não podem excluir registros. Peça a um gerente ou administrador.');
  }
}

// ----------------------------------------------------------------------------
// Leitura
// ----------------------------------------------------------------------------
export async function listRecords(r: Resource, p: ListParams) {
  const out = await getStore().list(r, p);
  await attachImages(r, out.rows);
  return out;
}

export async function getRecord(r: Resource, id: number) {
  const row = await getStore().get(r, id);
  if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);
  await attachImages(r, [row]);
  return row;
}

export async function optionsFor(r: Resource) {
  return getStore().options(r);
}

// ----------------------------------------------------------------------------
// Escrita (com regras por módulo)
// ----------------------------------------------------------------------------
export async function createRecord(r: Resource, body: unknown, actor: Actor): Promise<Row> {
  const data = validatePayload(r, body, 'create');
  const s = getStore();
  try {
    return await s.transaction(async (tx) => {
      // Regras específicas
      if (r.key === 'usuarios') await prepareUserPayload(data, null, actor);
      if (r.key === 'movimentacoes') return createMovimentacao(data, actor, tx);
      if (r.key === 'estoques') await ensureUniqueStock(data, null, tx);

      const row = await s.insert(r, data, tx);

      if (r.key === 'estoques' && Number(row.quantidade) !== 0) {
        await s.insert(
          getResource('movimentacoes')!,
          { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, quantidade: Number(row.quantidade), motivo: 'Saldo inicial (cadastro de estoque)', usuario_id: actor.id || null },
          tx
        );
      }
      if (r.key === 'ordens' && row.status === 'concluida') {
        await s.adjustStock(Number(row.produto_id), Number(row.tamanho_id), 'almoxarifado', Number(row.quantidade), tx);
        await s.insert(getResource('movimentacoes')!, { tipo: 'entrada', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: 'almoxarifado', quantidade: Number(row.quantidade), motivo: `Produção concluída — OP #${row.id}`, usuario_id: actor.id || null }, tx);
      }

      await audit(tx, actor, 'criar', r, row.id, `${r.singular} ${labelOf(r, row)} incluído(a)`, sanitize(data));
      return (await s.get(r, row.id, tx)) ?? row;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function updateRecord(r: Resource, id: number, body: unknown, actor: Actor): Promise<Row> {
  const data = validatePayload(r, body, 'update');
  const s = getStore();
  try {
    return await s.transaction(async (tx) => {
      const before = await s.findOneWhere(r, { id }, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      if (r.key === 'usuarios') await prepareUserPayload(data, before, actor);
      if (r.key === 'estoques') await ensureUniqueStock(data, before, tx);

      const changes = diff(before, data);
      if (!Object.keys(changes).length) return (await s.get(r, id, tx))!;

      const row = await s.update(r, id, data, tx);
      if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      // Estoque: alteração manual de quantidade vira movimentação de ajuste
      if (r.key === 'estoques' && changes.quantidade) {
        const delta = Number(row.quantidade) - Number(before.quantidade);
        if (delta !== 0) {
          await s.insert(getResource('movimentacoes')!, { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, quantidade: delta, motivo: 'Ajuste manual pelo Estoque Físico', usuario_id: actor.id || null }, tx);
        }
      }
      // Ordem concluída: entrada automática no estoque
      if (r.key === 'ordens' && changes.status && row.status === 'concluida' && before.status !== 'concluida') {
        await s.adjustStock(Number(row.produto_id), Number(row.tamanho_id), 'almoxarifado', Number(row.quantidade), tx);
        await s.insert(getResource('movimentacoes')!, { tipo: 'entrada', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: 'almoxarifado', quantidade: Number(row.quantidade), motivo: `Produção concluída — OP #${row.id}`, usuario_id: actor.id || null }, tx);
      }
      // Ordem que era concluída e voltou: estorna
      if (r.key === 'ordens' && changes.status && before.status === 'concluida' && row.status !== 'concluida') {
        await s.adjustStock(Number(before.produto_id), Number(before.tamanho_id), 'almoxarifado', -Number(before.quantidade), tx);
        await s.insert(getResource('movimentacoes')!, { tipo: 'saida', produto_id: before.produto_id, tamanho_id: before.tamanho_id, local: 'almoxarifado', quantidade: Number(before.quantidade), motivo: `Estorno — OP #${row.id} reaberta`, usuario_id: actor.id || null }, tx);
      }

      const campos = Object.keys(changes).join(', ');
      await audit(tx, actor, 'editar', r, id, `${r.singular} ${labelOf(r, row)} alterado(a) (${campos})`, changes);
      return (await s.get(r, id, tx)) ?? row;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export async function deleteRecord(r: Resource, id: number, actor: Actor): Promise<void> {
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const before = await s.findOneWhere(r, { id }, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      if (r.key === 'usuarios') {
        if (Number(before.id) === Number(actor.id)) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');
        await ensureNotLastAdmin(before, { ativo: false, perfil: 'x' }, tx);
      }
      if (r.key === 'ordens' && before.status === 'concluida') {
        throw new HttpError(409, 'Ordem concluída já deu entrada no estoque. Reabra ou cancele em vez de excluir.');
      }
      if (r.key === 'estoques' && Number(before.quantidade) !== 0) {
        throw new HttpError(409, 'Só é possível excluir saldos zerados. Lance uma saída/ajuste antes.');
      }

      await removeAllFiles(r, id, tx);
      const ok = await s.remove(r, id, tx);
      if (!ok) throw new HttpError(404, `${r.singular} não encontrado(a).`);
      await audit(tx, actor, 'excluir', r, id, `${r.singular} ${labelOf(r, before)} excluído(a)`, sanitize(before));
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

// ----------------------------------------------------------------------------
// Regras específicas
// ----------------------------------------------------------------------------
function sanitize(row: Row | Payload): Row {
  const out: Row = { ...row };
  delete out.senha;
  delete out.senha_hash;
  return out;
}

async function prepareUserPayload(data: Payload, before: Row | null, actor: Actor) {
  const { hashPassword, invalidateUserCache } = await import('./auth');
  if (typeof data.senha === 'string' && data.senha) {
    data.senha_hash = await hashPassword(data.senha);
  }
  delete data.senha;

  if (before) {
    if (Number(before.id) === Number(actor.id)) {
      if (data.ativo === false) throw new HttpError(400, 'Você não pode desativar o seu próprio usuário.');
      if (data.perfil && data.perfil !== 'admin') throw new HttpError(400, 'Você não pode remover o seu próprio perfil de administrador.');
    }
    await ensureNotLastAdmin(before, data, null);
    invalidateUserCache(Number(before.id));
  }
}

async function ensureNotLastAdmin(before: Row, data: Payload, tx: Tx) {
  const losingAdmin = before.perfil === 'admin' && before.ativo !== false && ((data.perfil !== undefined && data.perfil !== 'admin') || data.ativo === false);
  if (!losingAdmin) return;
  const s = getStore();
  const usuarios = getResource('usuarios')!;
  const admins = await s.list(usuarios, { page: 1, pageSize: 1000 }, tx ?? undefined);
  const others = admins.rows.filter((u) => u.perfil === 'admin' && u.ativo !== false && Number(u.id) !== Number(before.id));
  if (!others.length) throw new HttpError(400, 'Este é o único administrador ativo. Cadastre outro administrador antes.');
}

async function ensureUniqueStock(data: Payload, before: Row | null, tx: Tx) {
  const merged = { ...(before || {}), ...data };
  if (!merged.produto_id || !merged.tamanho_id) return;
  const s = getStore();
  const existing = await s.findOneWhere(getResource('estoques')!, { produto_id: merged.produto_id, tamanho_id: merged.tamanho_id, local: merged.local ?? 'almoxarifado' }, tx ?? undefined);
  if (existing && (!before || Number(existing.id) !== Number(before.id))) {
    throw new HttpError(409, 'Já existe saldo para este produto, tamanho e local. Edite o registro existente ou lance uma movimentação.');
  }
}

async function createMovimentacao(data: Payload, actor: Actor, tx: Tx): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes')!;
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);
  if (tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });

  const delta = tipo === 'saida' ? -qtd : qtd;
  const local = String(data.local || 'almoxarifado');
  const produtoId = Number(data.produto_id);
  const tamanhoId = Number(data.tamanho_id);

  const saldo = await s.findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
  const atual = Number(saldo?.quantidade ?? 0);
  if (atual + delta < 0) {
    throw new HttpError(409, `Saldo insuficiente: há ${atual} peça(s) em "${local}" e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
  }

  const row = await s.insert(mov, { ...data, local, usuario_id: actor.id || null }, tx);
  await s.adjustStock(produtoId, tamanhoId, local, delta, tx);
  const full = (await s.get(mov, row.id, tx)) ?? row;
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} un. — ${full.produto_id__label ?? '#' + produtoId} ${full.tamanho_id__label ?? ''} (${local})`, sanitize(data));
  return full;
}
