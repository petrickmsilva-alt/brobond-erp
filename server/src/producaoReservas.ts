// Commitments live on the official OP; movements and stock remain canonical.
import { getStore } from './services';
import { getResource } from './resources';
import { HttpError } from './errors';
import { listarTodos } from './paginacaoCompleta';
import type { Tx } from './store';

export async function travarInsumos(empresaId: number, ids: number[], tx: Tx) {
  if (tx) for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    await tx.query('SELECT id FROM insumos WHERE empresa_id=$1 AND id=$2 FOR UPDATE', [empresaId, id]);
  }
}

/** Outstanding commitments of OTHER OPs. Call after locking the material. */
export async function reservadoEmOutrasOrdens(empresaId: number, insumoId: number, ordemId: number | null, tx: Tx): Promise<number> {
  const s = getStore();
  const orders = await listarTodos(getResource('ordens')!, { empresa_id: empresaId }, tx);
  let total = 0;
  for (const op of orders) {
    if (Number(op.id) === ordemId || !['liberada', 'em_producao', 'parcial'].includes(String(op.status))) continue;
    const planned = Number(op.reservas_componentes?.[String(insumoId)] || 0);
    if (!planned) continue;
    const moves = await listarTodos(getResource('movimentacoes_insumos')!, { empresa_id: empresaId, ordem_id: Number(op.id), insumo_id: insumoId }, tx);
    const consumed = moves.reduce((n, m) => n + (m.tipo === 'saida' ? Number(m.quantidade) : -Number(m.quantidade)), 0);
    total += Math.max(0, planned - consumed);
  }
  return total;
}

export async function validarDisponivelInsumo(empresaId: number, insumoId: number, quantidade: number, ordemId: number | null, tx: Tx) {
  await travarInsumos(empresaId, [insumoId], tx);
  const physical = await getStore().insumoStock(insumoId, tx, empresaId);
  const committed = await reservadoEmOutrasOrdens(empresaId, insumoId, ordemId, tx);
  if (physical - committed < quantidade - 0.0005)
    throw new HttpError(409, `Insumo #${insumoId}: disponível ${physical - committed}; solicitado ${quantidade}. Há reservas de outras OPs.`);
}
