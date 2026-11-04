// ============================================================================
// RECONCILIAÇÃO DE WEBHOOKS LEGADOS (Fase 4.3, item 5)
//
// Eventos de pagamento gravados antes da coluna `empresa_id` (ou com ela nula)
// ficam invisíveis para a empresa dona. Este procedimento associa cada um SOMENTE
// quando há evidência inequívoca no banco:
//
//   1. identificar o provedor (registro conhecido, com parser próprio);
//   2. identificar o evento (`evento_id`) e a referência de negócio do payload
//      (usada APENAS para localizar candidatas, nunca como fonte de empresa);
//   3. buscar as cobranças do mesmo provedor com a mesma referência
//      (`gateway_cobrancas`, que tem empresa_id);
//   4. associar somente se TODAS as cobranças candidatas pertencem a UMA empresa;
//   5. ambiguidade, ausência de correspondência ou referência ausente: preservar
//      o evento sem empresa.
//
// Regras:
//   • Dry-run por padrão. Aplicar exige confirmação explícita.
//   • Nunca apaga evento; nunca altera status, assinatura ou conteúdo do evento.
//   • Só associa linhas com empresa_id nulo (claim CAS): uma associação nunca
//     é reatribuída, e reexecutar não altera nada.
//   • Cada associação grava auditoria com a origem (ORIGEM_RECONCILIACAO).
//   • A associação NÃO autentica o evento: `assinatura_ok` permanece como estava.
//   • A resposta não inclui payload, tokens nem referências de cobrança.
//
// Webhooks de SAÍDA legados (tabela `webhooks`, empresa_id NULL) NÃO são
// associados aqui: não há evidência de provedor a seguir. São apenas contados e
// dependem de decisão operacional (ver docs/operacao/procedimento-reconciliacao-webhooks.md).
// ============================================================================
import type { Request, Response } from 'express';
import { getStore } from './services';
import type { Resource } from './resources';
import { currentUser } from './auth';
import { HttpError } from './errors';
import { getProvider, extrairRefDoPayload, lerPayloadWebhook, R_GATEWAY_COBRANCAS, R_GATEWAY_WEBHOOK_EVENTS } from './gateway';
import type { Row } from './store';
import { R_WEBHOOKS } from './webhooks';

export const ORIGEM_RECONCILIACAO = 'reconciliacao-webhooks-v1';
export const CONFIRMACAO_RECONCILIACAO = 'RECONCILIAR_WEBHOOKS';
const PAGINA = 500;
const LIMITE_LEITURA = 200_000;

export type DecisaoReconciliacao =
  | 'associar'
  | 'ambiguo'
  | 'sem_correspondencia'
  | 'sem_referencia'
  | 'provedor_desconhecido';

export type LinhaReconciliacao = {
  id: number;
  provider: string;
  evento_id: string;
  decisao: DecisaoReconciliacao;
  empresa_id: number | null;
  cobranca_id: number | null;
};

export type PlanoReconciliacao = {
  linhas: LinhaReconciliacao[];
  resumo: Record<DecisaoReconciliacao, number> & { total: number };
};

/** Lê todas as linhas de um recurso em páginas (limite de segurança). */
async function listarTodos(r: Resource, filtro?: Record<string, unknown>): Promise<Row[]> {
  const s = getStore();
  const out: Row[] = [];
  for (let page = 1; out.length < LIMITE_LEITURA; page++) {
    const lote = await s.list(r, { page, pageSize: PAGINA, ...(filtro ? { filter: filtro } : {}) } as never);
    out.push(...lote.rows);
    if (lote.rows.length < PAGINA) break;
  }
  return out;
}

/** Monta o plano sem gravar nada (dry-run). */
export async function planejarReconciliacaoEventos(): Promise<PlanoReconciliacao> {
  const s = getStore();
  const eventos = (await listarTodos(R_GATEWAY_WEBHOOK_EVENTS))
    .filter((e) => e.empresa_id === null || e.empresa_id === undefined);
  const linhas: LinhaReconciliacao[] = [];
  for (const e of eventos) {
    const provider = String(e.provider || '').toLowerCase();
    const base = { id: Number(e.id), provider, evento_id: String(e.evento_id || ''), cobranca_id: null as number | null };
    if (!getProvider(provider)) {
      linhas.push({ ...base, decisao: 'provedor_desconhecido', empresa_id: null });
      continue;
    }
    const ref = extrairRefDoPayload(getProvider(provider)!, lerPayloadWebhook(e.payload));
    if (!ref) {
      linhas.push({ ...base, decisao: 'sem_referencia', empresa_id: null });
      continue;
    }
    const cobrancas = await s.list(R_GATEWAY_COBRANCAS, { page: 1, pageSize: 50, filter: { provider, provider_ref: ref } });
    const empresas = new Set(cobrancas.rows.map((c) => (c.empresa_id === null || c.empresa_id === undefined ? null : Number(c.empresa_id))));
    if (cobrancas.rows.length === 0 || empresas.has(null)) {
      linhas.push({ ...base, decisao: 'sem_correspondencia', empresa_id: null });
    } else if (empresas.size > 1) {
      linhas.push({ ...base, decisao: 'ambiguo', empresa_id: null });
    } else {
      const empresa = [...empresas][0] as number;
      linhas.push({ ...base, decisao: 'associar', empresa_id: empresa, cobranca_id: Number(cobrancas.rows[0].id) });
    }
  }
  const resumo = { associar: 0, ambiguo: 0, sem_correspondencia: 0, sem_referencia: 0, provedor_desconhecido: 0, total: linhas.length };
  for (const l of linhas) resumo[l.decisao] += 1;
  return { linhas, resumo };
}

export type ResultadoAplicacao = { associados: number; ignorados_por_concorrencia: number };

/**
 * Aplica as associações do plano. Cada uma é um claim CAS (só se ainda não tiver
 * empresa) seguido de auditoria com a origem.
 */
export async function aplicarReconciliacaoEventos(
  plano: PlanoReconciliacao,
  ator: { id?: number | null; name?: string | null }
): Promise<ResultadoAplicacao> {
  const s = getStore();
  const r = R_GATEWAY_WEBHOOK_EVENTS;
  let associados = 0;
  let ignorados = 0;
  for (const l of plano.linhas) {
    if (l.decisao !== 'associar' || l.empresa_id === null) continue;
    const ok = await s.tryUpdateIf(r, l.id, { empresa_id: null }, { empresa_id: l.empresa_id });
    if (!ok) {
      ignorados += 1;
      continue;
    }
    associados += 1;
    await s.audit({
      usuario_id: ator.id ?? null,
      usuario: ator.name ?? 'sistema',
      acao: 'editar',
      recurso: 'gateway_webhook_events',
      registro_id: l.id,
      descricao: `Webhook legado associado à empresa ${l.empresa_id} (evento ${l.evento_id}, provedor ${l.provider}, cobrança ${l.cobranca_id}). Origem: ${ORIGEM_RECONCILIACAO}.`,
      empresa_id: l.empresa_id,
      dados: { origem: ORIGEM_RECONCILIACAO, evento_id: l.evento_id, provider: l.provider, cobranca_id: l.cobranca_id },
    } as never);
  }
  return { associados, ignorados_por_concorrencia: ignorados };
}

/** Quantidade de webhooks de SAÍDA legados sem empresa (apenas contagem). */
async function contarWebhooksSaidaLegados(): Promise<number> {
  const linhas = await listarTodos(R_WEBHOOKS);
  return linhas.filter((w) => w.empresa_id === null || w.empresa_id === undefined).length;
}

/**
 * POST /api/admin/webhooks/reconciliacao  { aplicar?: boolean, confirmar?: "RECONCILIAR_WEBHOOKS" }
 * Administrador (imposto por requireRole('admin') em /api/admin). Padrão: dry-run.
 */
export async function reconciliarWebhooksLegados(req: Request, res: Response) {
  const actor = currentUser(req);
  const aplicar = req.body?.aplicar === true;
  if (aplicar && req.body?.confirmar !== CONFIRMACAO_RECONCILIACAO) {
    throw new HttpError(400, `Confirmação explícita ausente: envie {"aplicar":true,"confirmar":"${CONFIRMACAO_RECONCILIACAO}"}.`);
  }
  const plano = await planejarReconciliacaoEventos();
  const saidaLegados = await contarWebhooksSaidaLegados();
  const aplicacao = aplicar ? await aplicarReconciliacaoEventos(plano, actor) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    modo: aplicar ? 'aplicado' : 'dry-run',
    origem: ORIGEM_RECONCILIACAO,
    eventos_pagamento: {
      ...plano.resumo,
      // Somente identificadores: nenhum payload, referência de cobrança ou token.
      associar_ids: plano.linhas.filter((l) => l.decisao === 'associar').map((l) => l.id),
      pendentes_ids: plano.linhas.filter((l) => l.decisao !== 'associar').map((l) => l.id),
    },
    aplicacao,
    webhooks_saida_sem_empresa: { total: saidaLegados, acao: 'nenhuma: exige decisão operacional' },
  });
}
