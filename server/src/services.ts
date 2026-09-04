// Camada de serviço: CRUD genérico + regras de negócio por módulo
// (estoque, movimentações, ordens, usuários) + auditoria.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './errors';
import { MemStore } from './memdb';
import { PgStore, isPgAvailable, translatePgError } from './pgstore';
import { getResource, type Resource } from './resources';
import { labelOf, type ListParams, type Payload, type Row, type Store, type Tx } from './store';
import { validatePayload } from './validate';
import type { AuthUser } from './auth';
import { attachImages, removeAllFiles } from './uploads';
import { aplicarRegrasPedido } from './itens';
import { aplicarRegrasOrdem, recalcularFichaValores, validarOrdemPayload } from './producao';

const PERFIL_RANK: Record<string, number> = { operador: 1, gerente: 2, admin: 3 };

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
  const perfil = actor.perfil || 'operador';
  if (r.minPerfil && (PERFIL_RANK[perfil] ?? 0) < PERFIL_RANK[r.minPerfil]) {
    throw new HttpError(403, r.minPerfil === 'admin' ? 'Apenas administradores acessam este módulo.' : 'Apenas gerentes e administradores acessam este módulo.');
  }
  if (r.adminOnly && perfil !== 'admin') {
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
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, null, actor);
      if (r.key === 'movimentacoes') return createMovimentacao(data, actor, tx);
      if (r.key === 'movimentacoes_insumos') return createMovimentacaoInsumo(data, actor, tx);
      if (r.key === 'estoques') {
        await resolveLocal(data, tx);
        await ensureUniqueStock(data, null, tx);
      }
      if (r.key === 'inventarios') await resolveLocal(data, tx);
      if (r.key === 'ordens') await validarOrdemPayload(data, null);

      const row = await s.insert(r, data, tx);

      if (r.key === 'estoques' && Number(row.quantidade) !== 0) {
        await s.insert(
          getResource('movimentacoes')!,
          { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: Number(row.quantidade), motivo: 'Saldo inicial (cadastro de estoque)', usuario_id: actor.id || null },
          tx
        );
      }
      if (r.key === 'ordens') {
        const full = (await s.get(r, row.id, tx)) ?? row;
        await aplicarRegrasOrdem(null, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, { forcar: false });
      }
      if (r.key === 'fichas') {
        await recalcularFichaValores(Number(row.id), tx);
      }
      if (r.key === 'inventarios' && row.status === 'aberto') {
        await abrirInventarioSnapshot(row, actor, tx);
      }
      if (r.key === 'vendas' || r.key === 'compras') {
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', null, row, data, { id: actor.id || null, name: actor.name }, tx);
      }

      await audit(tx, actor, 'criar', r, row.id, `${r.singular} ${labelOf(r, row)} incluído(a)`, sanitize(data));
      return (await s.get(r, row.id, tx)) ?? row;
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

export type UpdateOpts = { forcar?: boolean };

export async function updateRecord(r: Resource, id: number, body: unknown, actor: Actor, opts: UpdateOpts = {}): Promise<Row> {
  const data = validatePayload(r, body, 'update');
  const s = getStore();
  try {
    return await s.transaction(async (tx) => {
      const before = await s.findOneWhere(r, { id }, tx);
      if (!before) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      if (r.key === 'usuarios') await prepareUserPayload(data, before, actor);
      if (r.key === 'catalogos') await prepareCatalogosPayload(data, before, actor);
      if (r.key === 'estoques') {
        await resolveLocal(data, tx);
        await ensureUniqueStock(data, before, tx);
      }
      if (r.key === 'movimentacoes') throw new HttpError(405, 'Movimentações são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'movimentacoes_insumos') throw new HttpError(405, 'Movimentações de insumos são imutáveis. Faça o lançamento inverso.');
      if (r.key === 'inventarios') await validarUpdateInventario(data, before);
      if (r.key === 'estoque_insumos') {
        // Único campo editável diretamente: estoque mínimo.
        const extra = Object.keys(data).filter((k) => k !== 'estoque_min' && k !== 'atualizado_em');
        if (extra.length) {
          throw new HttpError(400, 'O saldo do insumo só muda por movimentações (compra, ajuste ou consumo de OP). Apenas o estoque mínimo pode ser editado aqui.', { quantidade: 'Use uma movimentação de insumo' });
        }
      }
      if (r.key === 'ordens') await validarOrdemPayload(data, before);

      const changes = diff(before, data);
      if (!Object.keys(changes).length) return (await s.get(r, id, tx))!;

      const row = await s.update(r, id, data, tx);
      if (!row) throw new HttpError(404, `${r.singular} não encontrado(a).`);

      // Estoque: alteração manual de quantidade vira movimentação de ajuste
      if (r.key === 'estoques' && changes.quantidade) {
        const delta = Number(row.quantidade) - Number(before.quantidade);
        if (delta !== 0) {
          await s.insert(getResource('movimentacoes')!, { tipo: 'ajuste', produto_id: row.produto_id, tamanho_id: row.tamanho_id, local: row.local, local_id: row.local_id ?? null, quantidade: delta, motivo: 'Ajuste manual pelo Estoque Físico', usuario_id: actor.id || null }, tx);
        }
      }
      // Ordem concluída/reaberta: entrada/estorno no estoque + consumo de insumos
      if (r.key === 'ordens' && changes.status) {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasOrdem(before, full, data, { id: actor.id || null, name: actor.name, perfil: actor.perfil }, tx, opts);
      }
      // Ficha técnica: recalcula custo/preço sugerido (mão de obra, indiretos, margem)
      if (r.key === 'fichas' && (changes.mao_obra || changes.custos_indiretos || changes.margem_pct || changes.produto_id)) {
        await recalcularFichaValores(id, tx);
      }
      // Vendas/Compras: faturamento/baixa de estoque, recebimento/custo médio e estornos
      if (r.key === 'vendas' || r.key === 'compras') {
        const full = (await s.get(r, id, tx)) ?? row;
        await aplicarRegrasPedido(r.key === 'vendas' ? 'venda' : 'compra', before, full, data, { id: actor.id || null, name: actor.name }, tx);
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
      if (r.key === 'vendas' && ['faturada', 'entregue'].includes(String(before.status))) {
        throw new HttpError(409, 'Pedido faturado já baixou o estoque. Cancele o pedido (estorna automaticamente) em vez de excluí-lo.');
      }
      if (r.key === 'compras' && before.status === 'recebido') {
        throw new HttpError(409, 'Compra recebida já deu entrada nos insumos. Cancele a compra (estorna automaticamente) em vez de excluí-la.');
      }
      // Remove os itens do pedido junto (no Postgres o ON DELETE CASCADE faz;
      // aqui garantimos o mesmo comportamento no modo demonstração).
      const filhos: { r: Resource; col: string }[] = [];
      if (r.key === 'vendas' || r.key === 'compras') {
        filhos.push({ r: getResource(r.key === 'vendas' ? 'itens_venda' : 'itens_compra')!, col: r.key === 'vendas' ? 'venda_id' : 'compra_id' });
      }
      if (r.key === 'ordens') filhos.push({ r: getResource('itens_ordem')!, col: 'ordem_id' });
      if (r.key === 'fichas') filhos.push({ r: getResource('itens_ficha_tecnica')!, col: 'ficha_id' });
      for (const filho of filhos) {
        const itens = await s.list(filho.r, { page: 1, pageSize: 1000, filter: { [filho.col]: id } }, tx);
        for (const it of itens.rows) await s.remove(filho.r, Number(it.id), tx);
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

/** Fraquezas de senha conhecidas (política da Fase 6). */
const SENHAS_FRACAS = ['123456', '12345678', '123456789', '1234567890', 'senha', 'senha123', 'password', 'password123', 'qwerty', 'abc123', 'brobond', 'brobond123', 'admin', 'administrador', 'lojinha', 'brasil', 'batata'];

/** Política de senha: mínimo 8, ≠ e-mail, fora da lista de senhas óbvias. */
export function validarPoliticaSenha(senha: string, email?: string): string | null {
  if (!senha) return 'Informe uma senha.';
  if (senha.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  const lower = senha.toLowerCase();
  if (email && lower === String(email || '').trim().toLowerCase()) return 'A senha não pode ser igual ao e-mail.';
  const parteEmail = String(email || '').split('@')[0].toLowerCase();
  if (parteEmail.length >= 4 && lower.includes(parteEmail)) return 'A senha não pode conter o e-mail.';
  if (SENHAS_FRACAS.includes(lower) || /^(.)\1{6,}$/.test(lower)) return 'Escolha uma senha menos óbvia.';
  return null;
}

async function prepareUserPayload(data: Payload, before: Row | null, actor: Actor) {
  const { hashPassword, invalidateUserCache } = await import('./auth');
  const temSenha = typeof data.senha === 'string' && data.senha.length > 0;
  if (temSenha) {
    const erro = validarPoliticaSenha(String(data.senha ?? ''), String(data.email ?? before?.email ?? ''));
    if (erro) throw new HttpError(400, erro, { senha: erro });
    data.senha_hash = await hashPassword(String(data.senha));
  }
  delete data.senha;

  if (before) {
    if (Number(before.id) === Number(actor.id)) {
      if (data.ativo === false) throw new HttpError(400, 'Você não pode desativar o seu próprio usuário.');
      if (data.perfil && data.perfil !== 'admin') throw new HttpError(400, 'Você não pode remover o seu próprio perfil de administrador.');
      // Quem troca a própria senha conclui a obrigação de troca.
      if (temSenha) data.trocar_senha = false;
    } else if (temSenha) {
      // Admin redefiniu a senha de outro usuário → troca obrigatória no 1º acesso.
      data.trocar_senha = true;
    }
    await ensureNotLastAdmin(before, data, null);
    invalidateUserCache(Number(before.id));
  } else if (temSenha) {
    // Criação de usuário: senha provisória do admin → troca obrigatória no 1º acesso.
    data.trocar_senha = true;
  }
}

async function prepareCatalogosPayload(data: Payload, before: Row | null, _actor: Actor) {
  const { hashPassword } = await import('./auth');
  const senha = typeof data.senha === 'string' ? data.senha : '';
  if (senha) {
    const erro = validarPoliticaSenha(senha, '');
    if (erro) throw new HttpError(400, `Senha do catálogo: ${erro}`, { senha: erro });
    data.senha_hash = await hashPassword(senha);
  }
  delete data.senha;
  if (!before) {
    data.token = randomBytes(12).toString('hex');
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
/** Preenche `local` (e `local_id`) a partir do cadastro de Locais. */
async function resolveLocal(data: Payload, tx: Tx): Promise<void> {
  const s = getStore();
  let local = data.local === undefined || data.local === null ? '' : String(data.local).trim();
  const rawId = data.local_id;
  const localId = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);

  if (localId && Number.isInteger(localId) && localId > 0) {
    const l = await s.findOneWhere(getResource('locais')!, { id: localId }, tx ?? undefined);
    if (!l) throw new HttpError(400, 'Local inválido: o registro selecionado não existe.', { local_id: 'Registro não encontrado' });
    if (!local) local = String(l.nome);
    data.local_id = localId;
  }
  if (!local) local = 'almoxarifado';
  if (local.length > 60) throw new HttpError(400, 'O nome do local é muito longo.', { local: 'Máximo de 60 caracteres' });
  data.local = local;
}

/** Movimentação de produtos acabados (entrada/saída/ajuste/transferência). */
async function createMovimentacao(data: Payload, actor: Actor, tx: Tx): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes')!;
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);

  if (tipo !== 'transferencia' && tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });

  await resolveLocal(data, tx);
  const local = String(data.local);
  const produtoId = Number(data.produto_id);
  const tamanhoId = Number(data.tamanho_id);
  const usuarioId = actor.id || null;

  // Transferência entre locais: em UMA transação, saída na origem + entrada no
  // destino — duas linhas ligadas por transferencia_id.
  if (tipo === 'transferencia') {
    if (qtd <= 0) throw new HttpError(400, 'Informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
    const rawDest = data.local_destino_id;
    const destId = rawDest === undefined || rawDest === null || rawDest === '' ? null : Number(rawDest);
    if (!destId || !Number.isInteger(destId)) {
      throw new HttpError(400, 'Escolha o local de destino da transferência.', { local_destino_id: 'Campo obrigatório' });
    }
    const destino = await s.findOneWhere(getResource('locais')!, { id: destId }, tx ?? undefined);
    if (!destino) throw new HttpError(400, 'Local de destino inválido: o registro selecionado não existe.', { local_destino_id: 'Registro não encontrado' });
    const localDestino = String(destino.nome);
    if (localDestino === local) throw new HttpError(400, 'A origem e o destino da transferência devem ser locais diferentes.', { local_destino_id: 'Escolha outro local' });

    const saldoOrigem = await s.findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
    const atual = Number(saldoOrigem?.quantidade ?? 0);
    if (atual < qtd) {
      throw new HttpError(409, `Saldo insuficiente para transferir: há ${atual} peça(s) em "${local}" e você quer transferir ${qtd}.`, { quantidade: `Saldo atual: ${atual}` });
    }
    const motivo = data.motivo ? String(data.motivo) : `Transferência para ${localDestino}`;
    const saida = await s.insert(mov, { tipo: 'saida', produto_id: produtoId, tamanho_id: tamanhoId, local, local_id: data.local_id ?? null, local_destino: localDestino, local_destino_id: destId, quantidade: qtd, motivo, usuario_id: usuarioId }, tx);
    await s.adjustStock(produtoId, tamanhoId, local, -qtd, tx);
    await s.insert(mov, { tipo: 'entrada', produto_id: produtoId, tamanho_id: tamanhoId, local: localDestino, local_id: destId, transferencia_id: Number(saida.id), quantidade: qtd, motivo: `Transferência de ${local}`, usuario_id: usuarioId }, tx);
    await s.adjustStock(produtoId, tamanhoId, localDestino, qtd, tx);
    await s.update(mov, Number(saida.id), { transferencia_id: Number(saida.id) }, tx);
    await audit(tx, actor, 'criar', mov, Number(saida.id), `Transferência de ${qtd} un. de "${local}" para "${localDestino}" — ${await produtoTamanhoLabel(produtoId, tamanhoId, tx)}`, sanitize({ ...data, local, local_destino: localDestino }));
    return (await s.get(mov, Number(saida.id), tx)) ?? saida;
  }

  const delta = tipo === 'saida' ? -qtd : qtd;
  const saldo = await s.findOneWhere(getResource('estoques')!, { produto_id: produtoId, tamanho_id: tamanhoId, local }, tx ?? undefined);
  const atual = Number(saldo?.quantidade ?? 0);
  if (atual + delta < 0) {
    throw new HttpError(409, `Saldo insuficiente: há ${atual} peça(s) em "${local}" e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
  }

  const row = await s.insert(mov, { ...data, local, local_id: data.local_id ?? null, local_destino: data.local_destino ?? null, local_destino_id: data.local_destino_id ?? null, usuario_id: usuarioId }, tx);
  await s.adjustStock(produtoId, tamanhoId, local, delta, tx);
  const full = (await s.get(mov, row.id, tx)) ?? row;
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} un. — ${full.produto_id__label ?? '#' + produtoId} ${full.tamanho_id__label ?? ''} (${local})`, sanitize(data));
  return full;
}

/** Rótulo "Produto tam. X" para auditoria. */
async function produtoTamanhoLabel(produtoId: number, tamanhoId: number, tx?: Tx): Promise<string> {
  const s = getStore();
  const p = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
  const t = await s.findOneWhere(getResource('tamanhos')!, { id: tamanhoId }, tx);
  const nome = p ? labelOf(getResource('produtos')!, p) : `#${produtoId}`;
  return `${nome}${t ? ` tam. ${t.codigo}` : ''}`.trim();
}

/** Movimentação manual de insumo (módulo Estoque de Insumos). */
async function createMovimentacaoInsumo(data: Payload, actor: Actor, tx: Tx): Promise<Row> {
  const s = getStore();
  const mov = getResource('movimentacoes_insumos')!;
  const qtd = Number(data.quantidade);
  const tipo = String(data.tipo);
  if (qtd === 0) throw new HttpError(400, 'A quantidade não pode ser zero.', { quantidade: 'Não pode ser zero' });
  if (tipo !== 'ajuste' && qtd <= 0) {
    throw new HttpError(400, 'Para entrada e saída informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
  }
  const insumoId = Number(data.insumo_id);
  const delta = tipo === 'saida' ? -qtd : qtd;
  const atual = await s.insumoStock(insumoId, tx);
  if (atual + delta < 0) {
    const ins = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
    const nome = ins ? labelOf(getResource('insumos')!, ins) : `#${insumoId}`;
    throw new HttpError(409, `Saldo insuficiente do insumo: há ${atual} de ${nome} e a movimentação retiraria ${Math.abs(delta)}.`, { quantidade: `Saldo atual: ${atual}` });
  }
  const row = await s.insert(mov, { ...data, usuario_id: actor.id || null }, tx);
  await s.adjustInsumoStock(insumoId, delta, tx);
  const ins = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
  const nome = ins ? labelOf(getResource('insumos')!, ins) : `#${insumoId}`;
  const un = ins?.unidade || 'un';
  await audit(tx, actor, 'criar', mov, row.id, `${tipo === 'entrada' ? 'Entrada' : tipo === 'saida' ? 'Saída' : 'Ajuste'} de ${qtd} ${un} de ${nome}${data.motivo ? ` — ${data.motivo}` : ''}`, sanitize(data));
  return row;
}

/** Abrir inventário: congela o saldo do local em itens_inventario. */
async function abrirInventarioSnapshot(row: Row, actor: Actor, tx: Tx) {
  const s = getStore();
  const local = String(row.local || 'almoxarifado');
  const aberto = await s.findOneWhere(getResource('inventarios')!, { local, status: 'aberto' }, tx);
  if (aberto && Number(aberto.id) !== Number(row.id)) {
    throw new HttpError(409, `Já existe um inventário aberto para o local "${local}" (inventário #${aberto.id}). Feche-o antes de abrir outro.`);
  }
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 2000, filter: { local } }, tx);
  const itensR = getResource('itens_inventario')!;
  let n = 0;
  for (const e of estoques.rows) {
    if (Number(e.quantidade) === 0 && Number(e.estoque_min || 0) === 0) continue;
    await s.insert(itensR, { inventario_id: Number(row.id), produto_id: e.produto_id, tamanho_id: e.tamanho_id, saldo_sistema: Number(e.quantidade), contado: null, diferenca: 0 }, tx);
    n++;
  }
  await s.update(getResource('inventarios')!, Number(row.id), { aberto_por: actor.name }, tx);
  await s.audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'inventarios', registro_id: Number(row.id), descricao: `Inventário #${row.id} aberto no local "${local}" — ${n} itens com saldo congelado`, dados: { itens: n } },
    tx
  );
}

/** Inventários: em edição, apenas observações, e somente enquanto estiver aberto. */
async function validarUpdateInventario(data: Payload, before: Row) {
  const permitidos = new Set(['observacoes', 'local', 'local_id']);
  const invalidos = Object.keys(data).filter((k) => !permitidos.has(k) && k !== 'atualizado_em' && k !== 'criado_em');
  if (invalidos.length) {
    throw new HttpError(400, 'Um inventário não pode ser alterado diretamente: use o fechamento (gera os ajustes) ou abra um novo.', { status: 'Use a ação "Fechar inventário"' });
  }
  if (before.status === 'fechado') {
    throw new HttpError(409, 'Este inventário já foi fechado e não pode mais ser alterado.');
  }
}
