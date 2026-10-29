// Fechamento da ESCRITURAÇÃO importada; o caixa e o fiscal seguem seus próprios
// processos. Não cria partidas, contas, nem saldo contábil paralelo.
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import type { Row, Tx } from './store';

const R = () => getResource('fin_periodos_contabeis')!;
const queues = new Map<number, Promise<unknown>>();
export function competenciaValida(value: unknown): string {
  const s = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s) || s.startsWith('0000')) throw new HttpError(400, 'Competência deve estar no formato AAAA-MM válido.');
  return s;
}

// A mesma trava protege confirmação de lotes e mudança de período. READ
// COMMITTED é intencional: após esperar o advisory lock, o SELECT deve observar
// o commit do worker anterior. Em memória, a fila serializa transações locais.
export async function comTravaContabil<T>(empresaId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const executar = () => getStore().transaction(async (tx) => {
    if (tx) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`contabil:${empresaId}`]);
    return fn(tx);
  }, { isolation: 'read committed' });
  const anterior = queues.get(empresaId) ?? Promise.resolve();
  const proximo = anterior.catch(() => undefined).then(executar);
  queues.set(empresaId, proximo);
  try { return await proximo; } finally { if (queues.get(empresaId) === proximo) queues.delete(empresaId); }
}

export async function assertPeriodosAbertos(empresaId: number, competencias: string[], tx?: Tx): Promise<void> {
  const desejados = new Set(competencias.map(competenciaValida));
  const result = await getStore().list(R(), { page: 1, pageSize: 10000, filter: { empresa_id: empresaId, estado: 'fechado' } }, tx);
  // Não presumir que períodos omitidos por paginação estão abertos.
  if (result.total > result.rows.length) throw new HttpError(409, 'Muitos períodos fechados para validar a escrituração.');
  const fechado = result.rows.find((p) => desejados.has(String(p.competencia).slice(0, 7)));
  if (fechado) throw new HttpError(409, `A competência ${String(fechado.competencia).slice(0, 7)} está fechada para escrituração importada.`);
}

function ator(req: Request) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  return { actor, empresaId: escopoDoAtor(actor).empresaId };
}
function pagina(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, 'Paginação inválida.');
  return n;
}

export async function listarPeriodos(req: Request, res: Response) {
  const { empresaId } = ator(req);
  const page = pagina(req.query.page, 1, 100000);
  const pageSize = pagina(req.query.pageSize, 30, 100);
  const result = await getStore().list(R(), { page, pageSize, filter: { empresa_id: empresaId }, sort: 'competencia', dir: 'desc' });
  res.json(result);
}
export async function obterPeriodo(req: Request, res: Response) {
  const { empresaId } = ator(req);
  const competencia = competenciaValida(req.params.competencia);
  const periodo = await getStore().findOneWhere(R(), { empresa_id: empresaId, competencia: `${competencia}-01` });
  // Período sem registro é aberto por compatibilidade com o legado.
  res.json({ competencia, estado: periodo?.estado ?? 'aberto', registrado: !!periodo, periodo });
}
export async function alterarPeriodo(req: Request, res: Response) {
  const { actor, empresaId } = ator(req);
  const competencia = competenciaValida(req.params.competencia);
  const estado = req.params.acao === 'fechar' ? 'fechado' : req.params.acao === 'reabrir' ? 'aberto' : null;
  if (!estado) throw new HttpError(404, 'Ação não encontrada.');
  if (estado === 'aberto' && actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores reabrem períodos.');
  const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim() : '';
  if (motivo.length < 8 || motivo.length > 500) throw new HttpError(400, 'Informe um motivo entre 8 e 500 caracteres.');
  const s = getStore();
  const result = await comTravaContabil(empresaId, async (tx) => {
    const antes = await s.findOneWhere(R(), { empresa_id: empresaId, competencia: `${competencia}-01` }, tx);
    if ((antes?.estado ?? 'aberto') === estado) return { periodo: antes, idempotente: true };
    const data = { estado, motivo, alterado_por: actor.id || null };
    const depois: Row = antes
      ? (await s.update(R(), Number(antes.id), data, tx))!
      : await s.insert(R(), { empresa_id: empresaId, competencia: `${competencia}-01`, ...data }, tx);
    await s.audit({ empresa_id: empresaId, usuario_id: actor.id || null, usuario: actor.name,
      acao: 'ajuste', recurso: 'fin_periodos_contabeis', registro_id: Number(depois.id),
      descricao: `Escrituração ${estado}: ${competencia}`,
      dados: { antes: antes ? { estado: antes.estado, motivo: antes.motivo } : { estado: 'aberto' }, depois: { estado, motivo } } }, tx);
    return { periodo: depois, idempotente: false };
  });
  res.json(result);
}
