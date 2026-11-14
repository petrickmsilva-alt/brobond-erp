// ============================================================================
// AI PLATFORM — contratos compartilhados dos domínios 06/07/08 (ADR-0016).
//
// A base D4/D5/Fase 8 continua sendo a autoridade: `ai_executions` (append-only,
// idempotente, custo auditado), `ai_prompts`, `ai_providers` e
// `ai_recommendations` (decisão humana). Este módulo NÃO cria plataforma
// paralela: padroniza evidência, score versionado, orçamento e execução
// idempotente para os novos domínios determinísticos.
//
// Camada generativa externa permanece BLOQUEADA: não há adapter LLM aqui.
// ============================================================================
import { createHash } from 'node:crypto';
import type { AuthUser } from './auth';
import { domainLock } from './domainLock';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import type { Row, Tx } from './store';
import { round2 } from './utils';

export const EVIDENCIA_FORMATO_VERSAO = '1.0.0';
export const MODELO_DETERMINISTICO = 'heuristica-interna';

export type FatorScore = { valor: number; peso: number; contribuicao: number; origem: string };
export type EvidenciaExecutiva = {
  formato_versao: string;
  versao: string;
  formula: string;
  pesos: Record<string, number>;
  fatores: Record<string, FatorScore>;
  fonte: string;
  data_referencia: string;
  justificativa: string;
  dados_ausentes: string[];
  limitacoes: string[];
  estimativa?: { valor: number; unidade: string; metodo: string; realizada: false };
  [chave: string]: unknown;
};

export type RecomendacaoDeterministica = {
  dominio: 'sales' | 'customer' | 'marketing' | 'inventory' | 'demand' | 'commerce';
  score: number;
  evidencia: EvidenciaExecutiva;
  recomendacao: string;
};

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
export function round3(v: number): number { return Number(v.toFixed(3)); }
export function round4(v: number): number { return Number(v.toFixed(4)); }

export function fator(valor: number, peso: number, origem: string): FatorScore {
  const v = clamp01(valor);
  return { valor: round3(v), peso, contribuicao: round3(v * peso), origem };
}

/** Soma ponderada determinística; pesos precisam somar 1. */
export function scorePonderado(fatores: Record<string, FatorScore>): number {
  const somaPesos = Object.values(fatores).reduce((a, f) => a + f.peso, 0);
  if (Math.abs(somaPesos - 1) > 1e-9) throw new HttpError(500, 'Pesos do scoring não somam 1 — fórmula inválida.');
  return round3(clamp01(Object.values(fatores).reduce((a, f) => a + f.contribuicao, 0)));
}

export function assertEvidenciaMinima(ev: EvidenciaExecutiva): void {
  for (const campo of ['versao', 'formula', 'fonte', 'data_referencia', 'justificativa'] as const) {
    if (!ev[campo] || typeof ev[campo] !== 'string') throw new HttpError(500, `Evidência sem ${campo} — recomendação sem lastro não é gravada.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.data_referencia) || Number.isNaN(Date.parse(`${ev.data_referencia}T00:00:00Z`))) {
    throw new HttpError(500, 'data_referencia inválida na evidência.');
  }
  if (ev.estimativa && ev.estimativa.realizada !== false) throw new HttpError(500, 'Estimativa nunca pode ser marcada como realizada.');
  scorePonderado(ev.fatores);
}

export function chaveIdempotenteIA(valor: unknown): string {
  const k = String(valor ?? '');
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(k)) throw new HttpError(400, 'Informe Idempotency-Key com 8 a 160 caracteres seguros.');
  return k;
}

/** JSON canônico (chaves ordenadas) para hash de payload — independe da ordem de envio. */
export function jsonCanonicoIA(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonCanonicoIA).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${jsonCanonicoIA(obj[k])}`).join(',')}}`;
}
export function hashPayloadIA(v: unknown): string {
  return createHash('sha256').update(jsonCanonicoIA(v)).digest('hex');
}

/** Lê TODAS as linhas do filtro com paginação estável (sem teto silencioso). */
export async function listarTodosIA(key: string, empresaId: number, filtro: Record<string, unknown> = {}, tx?: Tx): Promise<Row[]> {
  const r = getResource(key)!;
  const s = getStore();
  const out: Row[] = [];
  for (let page = 1; ; page += 1) {
    const lote = await s.list(r, { page, pageSize: 1000, filter: { ...filtro, empresa_id: empresaId }, sort: 'id', dir: 'asc' }, tx);
    out.push(...lote.rows);
    if (lote.rows.length < 1000) break;
  }
  return out;
}

function isoDe(v: unknown): string | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Custo REAL acumulado no mês UTC da referência; `ai_executions` é a autoridade. */
export async function custoMesIA(empresaId: number, providerId: number | null, referencia: string, tx?: Tx): Promise<number> {
  const periodo = referencia.slice(0, 7);
  const filtro: Record<string, unknown> = {};
  if (providerId !== null) filtro.provider_id = providerId;
  const rows = await listarTodosIA('ai_executions', empresaId, filtro, tx);
  const total = rows.reduce((a, r) => {
    const iso = isoDe(r.criado_em);
    return iso && iso.slice(0, 7) === periodo ? a + Number(r.custo || 0) : a;
  }, 0);
  return round4(total);
}

/**
 * Enforcement do limite mensal de custo do provider para os novos executores.
 * Sem provider ou sem limite cadastrado, não se inventa limite. Com limite, o
 * acumulado do mês + custo estimado não pode excedê-lo. Provider externo é
 * recusado pelo executor determinístico (adapter generativo ainda bloqueado).
 */
export async function assertOrcamentoIA(empresaId: number, providerId: number | null, custoEstimado: number, referencia: string, tx?: Tx): Promise<void> {
  if (providerId === null) return;
  const s = getStore();
  const provider = await s.findOneWhere(getResource('ai_providers')!, { id: providerId, empresa_id: empresaId }, tx);
  if (!provider) throw new HttpError(404, 'Provedor de IA não encontrado nesta empresa.');
  if (provider.ativo === false) throw new HttpError(409, 'Provedor de IA inativo.');
  const limite = provider.limite_mensal_custo == null ? null : Number(provider.limite_mensal_custo);
  if (limite === null || !Number.isFinite(limite)) return;
  const acumulado = await custoMesIA(empresaId, providerId, referencia, tx);
  if (round4(acumulado + Math.max(0, custoEstimado)) > limite + 1e-9) {
    throw new HttpError(409, `Limite mensal de custo de IA atingido para o provedor (acumulado R$ ${acumulado.toFixed(2)}, limite R$ ${limite.toFixed(2)}).`, { acumulado, limite });
  }
}

export type ResultadoAnaliseIA = {
  execucao_id: number;
  idempotente: boolean;
  total: number;
  recomendacoes: Row[];
  resultado: Row;
};

/**
 * Executor compartilhado: lock por empresa + chave única em ai_executions +
 * orçamento + recomendações pendentes + auditoria, tudo na mesma transação.
 * Replay da mesma chave/payload devolve o resultado original; payload diferente
 * responde 409. Nenhuma recomendação aplica operação comercial/financeira.
 */
export async function executarAnaliseIA(opts: {
  actor: AuthUser;
  empresaId: number;
  finalidade: string;
  chave: string;
  parametros: Row;
  modelo: string;
  versao: string;
  dataReferencia: string;
  providerId?: number | null;
  calcular: (tx: Tx) => Promise<{ resultado: Row; recomendacoes: RecomendacaoDeterministica[] }>;
}): Promise<ResultadoAnaliseIA> {
  checkAccess(getResource('ai_recommendations')!, opts.actor, 'create');
  checkAccess(getResource('ai_executions')!, opts.actor, 'read');
  const chave = chaveIdempotenteIA(opts.chave);
  const requestHash = hashPayloadIA({ finalidade: opts.finalidade, parametros: opts.parametros, modelo: opts.modelo, versao: opts.versao, provider_id: opts.providerId ?? null });
  const s = getStore();
  return domainLock(opts.empresaId, 'ai-platform', async (tx) => {
    const anterior = await s.findOneWhere(getResource('ai_executions')!, { empresa_id: opts.empresaId, chave_idempotencia: chave }, tx);
    if (anterior) {
      const entrada = (anterior.entrada ?? {}) as Row;
      if (anterior.finalidade !== opts.finalidade || entrada.request_hash !== requestHash) {
        throw new HttpError(409, 'Chave de idempotência de IA usada com outros dados.');
      }
      const recomendacoes = await listarTodosIA('ai_recommendations', opts.empresaId, { execucao_id: Number(anterior.id) }, tx);
      return { execucao_id: Number(anterior.id), idempotente: true, total: recomendacoes.length, recomendacoes, resultado: (anterior.resultado ?? {}) as Row };
    }

    const providerId = opts.providerId ?? null;
    if (providerId !== null) {
      const provider = await s.findOneWhere(getResource('ai_providers')!, { id: providerId, empresa_id: opts.empresaId }, tx);
      if (!provider) throw new HttpError(404, 'Provedor de IA não encontrado nesta empresa.');
      if (String(provider.tipo) === 'externo') throw new HttpError(409, 'Adapter generativo externo bloqueado até homologação (ADR-0016).');
    }
    await assertOrcamentoIA(opts.empresaId, providerId, 0, opts.dataReferencia, tx);

    const calculo = await opts.calcular(tx);
    for (const r of calculo.recomendacoes) {
      if (!Number.isFinite(r.score) || r.score < 0 || r.score > 1) throw new HttpError(500, 'Score determinístico fora de 0..1.');
      if (!r.recomendacao.trim() || r.recomendacao.length > 2000) throw new HttpError(500, 'Recomendação sem texto válido.');
      assertEvidenciaMinima(r.evidencia);
    }
    const exec = await s.insert(getResource('ai_executions')!, {
      empresa_id: opts.empresaId, provider_id: providerId, finalidade: opts.finalidade,
      entrada: { parametros: opts.parametros, request_hash: requestHash, modelo: opts.modelo, versao: opts.versao },
      resultado: calculo.resultado, custo: 0, estado: 'sucesso', chave_idempotencia: chave,
    }, tx);
    const recomendacoes: Row[] = [];
    for (const r of calculo.recomendacoes) {
      recomendacoes.push(await s.insert(getResource('ai_recommendations')!, {
        empresa_id: opts.empresaId, execucao_id: Number(exec.id), dominio: r.dominio, modelo: opts.modelo,
        score: round3(r.score), evidencia: r.evidencia, recomendacao: r.recomendacao, status: 'pendente',
      }, tx));
    }
    await s.audit({
      empresa_id: opts.empresaId, usuario_id: opts.actor.id || null, usuario: opts.actor.name || null,
      acao: 'ajuste', recurso: 'ai_recommendations', registro_id: null,
      descricao: `Análise de IA determinística gerada (${opts.finalidade})`,
      dados: { execucao_id: Number(exec.id), total: recomendacoes.length, modelo: opts.modelo, versao: opts.versao, custo: 0 },
    }, tx);
    return { execucao_id: Number(exec.id), idempotente: false, total: recomendacoes.length, recomendacoes, resultado: calculo.resultado };
  });
}

/** Data civil UTC válida; default hoje. Entrada do cliente nunca muda o tenant. */
export function dataReferenciaIA(valor: unknown): string {
  if (valor == null || valor === '') return new Date().toISOString().slice(0, 10);
  const v = String(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, 'data_referencia inválida; use AAAA-MM-DD.');
  }
  return v;
}

export function moeda(v: number): string { return round2(v).toFixed(2); }
