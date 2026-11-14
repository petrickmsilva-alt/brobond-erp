// ============================================================================
// ETAPA 07 — CREATOR INTELLIGENCE (matching determinístico e auditável).
//
// Cruza creators ATIVOS com campanhas ATIVAS/vigentes usando SOMENTE dados
// cadastrados e atribuições reais de checkout. Gera recomendações pendentes na
// plataforma de IA (ai_executions + ai_recommendations); NÃO cria parceria,
// não registra match manual automaticamente, não gera mensagem e não envia
// contato. Descoberta externa/audiência/engajamento permanecem bloqueados.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import type { Row, Tx } from './store';
import { round2 } from './utils';
import {
  EVIDENCIA_FORMATO_VERSAO, fator, listarTodosIA, scorePonderado,
  executarAnaliseIA, dataReferenciaIA, type EvidenciaExecutiva, type RecomendacaoDeterministica,
} from './aiPlatform';

export const CREATOR_INTELLIGENCE_VERSAO = '1.0.0';
export const CREATOR_INTELLIGENCE_MODELO = 'creator-intelligence-deterministico';
export const CREATOR_INTELLIGENCE_PESOS = Object.freeze({ afinidade: 0.5, historico: 0.3, vigencia: 0.2 });
export const CREATOR_INTELLIGENCE_PEDIDOS_REFERENCIA = 5;
export const CREATOR_INTELLIGENCE_MAX_RECOMENDACOES = 20;
export const CREATOR_INTELLIGENCE_SCORE_MINIMO = 0.2;

const STOPWORDS = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'para', 'por', 'com', 'um', 'uma', 'na', 'no', 'nas', 'nos', 'que', 'the', 'of', 'and']);

export function tokensAfidade(texto: unknown): string[] {
  return [...new Set(String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t)))].sort();
}

export function afinidadeNicho(niche: unknown, objetivo: unknown): { valor: number; tokens_nicho: string[]; tokens_campanha: string[]; comuns: string[] } {
  const tokensNicho = tokensAfidade(niche);
  const tokensCampanha = tokensAfidade(objetivo);
  const comuns = tokensNicho.filter((t) => tokensCampanha.includes(t));
  const valor = tokensNicho.length && tokensCampanha.length ? comuns.length / Math.min(tokensNicho.length, tokensCampanha.length) : 0;
  return { valor, tokens_nicho: tokensNicho, tokens_campanha: tokensCampanha, comuns };
}

export function campanhaVigente(campaign: Row, dataReferencia: string): boolean {
  return String(campaign.status) === 'ACTIVE' && String(campaign.starts_on) <= dataReferencia && String(campaign.ends_on) >= dataReferencia;
}

export function pedidoPagoCreator(pedido: Row): boolean {
  return ['PAGO', 'CONVERTIDO'].includes(String(pedido.estado)) && String(pedido.pagamento_estado ?? 'APPROVED') === 'APPROVED';
}

export async function calcularCreatorIntelligence(empresaId: number, dataReferencia: string, campaignId: number | null, tx?: Tx): Promise<{ resultado: Row; recomendacoes: RecomendacaoDeterministica[] }> {
  const [creators, campaigns, partnerships, attributions, pedidos] = await Promise.all([
    listarTodosIA('creator_profiles', empresaId, { status: 'ACTIVE' }, tx),
    listarTodosIA('creator_campaigns', empresaId, { status: 'ACTIVE' }, tx),
    listarTodosIA('creator_partnerships', empresaId, {}, tx),
    listarTodosIA('creator_attributions', empresaId, {}, tx),
    listarTodosIA('commerce_pedidos', empresaId, {}, tx),
  ]);
  const pedidoPorId = new Map(pedidos.map((p) => [Number(p.id), p]));
  const parceriaPorId = new Map(partnerships.map((p) => [Number(p.id), p]));
  const historicoPorCreator = new Map<number, { pedidos_pagos: number; receita_atribuida: number }>();
  for (const a of attributions) {
    const parceria = parceriaPorId.get(Number(a.partnership_id));
    const pedido = pedidoPorId.get(Number(a.order_id));
    if (!parceria || !pedido || !pedidoPagoCreator(pedido)) continue;
    const cid = Number(parceria.creator_id);
    const h = historicoPorCreator.get(cid) ?? { pedidos_pagos: 0, receita_atribuida: 0 };
    h.pedidos_pagos += 1;
    h.receita_atribuida = round2(h.receita_atribuida + Number(pedido.total || 0));
    historicoPorCreator.set(cid, h);
  }
  const campanhasAlvo = campaigns.filter((c) => campanhaVigente(c, dataReferencia) && (campaignId === null || Number(c.id) === campaignId));
  if (campaignId !== null && !campanhasAlvo.length) throw new HttpError(409, 'Campanha não está ACTIVE e vigente nesta empresa para a data de referência.');
  const candidatos: Array<{ score: number; creator: Row; campaign: Row; afinidade: ReturnType<typeof afinidadeNicho>; historico: { pedidos_pagos: number; receita_atribuida: number } }> = [];
  for (const creator of creators) {
    const historico = historicoPorCreator.get(Number(creator.id)) ?? { pedidos_pagos: 0, receita_atribuida: 0 };
    for (const campaign of campanhasAlvo) {
      const afinidade = afinidadeNicho(creator.niche, `${campaign.name} ${campaign.objective}`);
      const fatores = {
        afinidade: fator(afinidade.valor, CREATOR_INTELLIGENCE_PESOS.afinidade, 'creator_profiles.niche × creator_campaigns.name/objective (tokens normalizados)'),
        historico: fator(historico.pedidos_pagos / CREATOR_INTELLIGENCE_PEDIDOS_REFERENCIA, CREATOR_INTELLIGENCE_PESOS.historico, `creator_attributions × commerce_pedidos pagos; referência ${CREATOR_INTELLIGENCE_PEDIDOS_REFERENCIA} pedidos`),
        vigencia: fator(1, CREATOR_INTELLIGENCE_PESOS.vigencia, 'creator_campaigns.status=ACTIVE e data_referencia dentro de starts_on/ends_on'),
      };
      const score = scorePonderado(fatores);
      if (score < CREATOR_INTELLIGENCE_SCORE_MINIMO) continue;
      candidatos.push({ score, creator, campaign, afinidade, historico });
    }
  }
  candidatos.sort((a, b) => b.score - a.score || Number(a.creator.id) - Number(b.creator.id) || Number(a.campaign.id) - Number(b.campaign.id));
  const selecionados = candidatos.slice(0, CREATOR_INTELLIGENCE_MAX_RECOMENDACOES);
  const recomendacoes: RecomendacaoDeterministica[] = selecionados.map((c) => {
    const fatores = {
      afinidade: fator(c.afinidade.valor, CREATOR_INTELLIGENCE_PESOS.afinidade, 'creator_profiles.niche × creator_campaigns.name/objective (tokens normalizados)'),
      historico: fator(c.historico.pedidos_pagos / CREATOR_INTELLIGENCE_PEDIDOS_REFERENCIA, CREATOR_INTELLIGENCE_PESOS.historico, `creator_attributions × commerce_pedidos pagos; referência ${CREATOR_INTELLIGENCE_PEDIDOS_REFERENCIA} pedidos`),
      vigencia: fator(1, CREATOR_INTELLIGENCE_PESOS.vigencia, 'creator_campaigns.status=ACTIVE e data_referencia dentro de starts_on/ends_on'),
    };
    const dadosAusentes: string[] = [];
    if (!c.creator.niche) dadosAusentes.push('creator_profiles.niche');
    if (!c.historico.pedidos_pagos) dadosAusentes.push('histórico de pedidos pagos atribuídos ao creator');
    const evidencia: EvidenciaExecutiva = {
      formato_versao: EVIDENCIA_FORMATO_VERSAO,
      versao: CREATOR_INTELLIGENCE_VERSAO,
      formula: 'score = 0,50×afinidade_tokens + 0,30×min(pedidos_pagos_atribuidos/5,1) + 0,20×vigencia_campanha',
      pesos: { ...CREATOR_INTELLIGENCE_PESOS },
      fatores,
      fonte: 'creator_profiles + creator_campaigns + creator_partnerships + creator_attributions + commerce_pedidos',
      data_referencia: dataReferencia,
      justificativa: `${c.creator.name} (@${c.creator.handle}) × ${c.campaign.name}: tokens comuns [${c.afinidade.comuns.join(', ') || 'nenhum'}]; ${c.historico.pedidos_pagos} pedido(s) pago(s) atribuído(s).`,
      dados_ausentes: dadosAusentes,
      limitacoes: [
        'Não mede audiência, engajamento, brand safety ou alcance externo.',
        'Receita atribuída por cupom não é ROI nem comissão; não prova causalidade da campanha.',
        'A sugestão não cria parceria nem envia mensagem; exige decisão humana.',
      ],
      creator_id: Number(c.creator.id),
      campaign_id: Number(c.campaign.id),
      creator: { name: c.creator.name, handle: c.creator.handle, platform: c.creator.platform, niche: c.creator.niche ?? null },
      campanha: { name: c.campaign.name, objective: c.campaign.objective, starts_on: c.campaign.starts_on, ends_on: c.campaign.ends_on },
      afinidade: c.afinidade,
      historico: c.historico,
      descoberta_externa: false,
      geracao_mensagem: false,
      envio_automatico: false,
    };
    return {
      dominio: 'marketing', score: c.score, evidencia,
      recomendacao: `Avaliar parceria entre ${c.creator.name} (@${c.creator.handle}) e a campanha ${c.campaign.name}: afinidade editorial determinística e histórico real de atribuições; validar audiência e termos manualmente antes de contato.`,
    };
  });
  return {
    resultado: {
      data_referencia: dataReferencia,
      creators_ativos: creators.length,
      campanhas_vigentes: campanhasAlvo.length,
      candidatos_elegiveis: candidatos.length,
      recomendacoes_geradas: recomendacoes.length,
      score_minimo: CREATOR_INTELLIGENCE_SCORE_MINIMO,
      descoberta_externa: false,
      geracao_mensagem: false,
      envio_automatico: false,
    },
    recomendacoes,
  };
}

export function capacidadesCreatorIntelligence() {
  return {
    estado: 'ATIVO_DETERMINISTICO',
    versao: CREATOR_INTELLIGENCE_VERSAO,
    modelo: CREATOR_INTELLIGENCE_MODELO,
    fonte: 'creator_profiles + creator_campaigns + creator_attributions + commerce_pedidos',
    descoberta_externa: false,
    geracao: false,
    envio: false,
    motivo_bloqueio: 'DESCOBERTA_GERACAO_ENVIO_DEPENDEM_FONTE_AUTORIZADA_E_PROVEDOR_HOMOLOGADO',
    aplicacao_automatica: false,
    aprovacao_humana: true,
  };
}

/** POST /api/creators/intelligence/gerar — gerente+, idempotente por empresa. */
export async function gerarCreatorIntelligence(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_recommendations')!, actor, 'create');
  const escopo = escopoDoAtor(actor);
  const body = (req.body ?? {}) as Row;
  const dataReferencia = dataReferenciaIA(body.data_referencia);
  const campaignId = body.campaign_id == null || body.campaign_id === '' ? null : Number(body.campaign_id);
  if (campaignId !== null && (!Number.isSafeInteger(campaignId) || campaignId < 1)) throw new HttpError(400, 'campaign_id inválido.');
  const providerId = body.provider_id == null || body.provider_id === '' ? null : Number(body.provider_id);
  if (providerId !== null && (!Number.isSafeInteger(providerId) || providerId < 1)) throw new HttpError(400, 'provider_id inválido.');
  if (campaignId !== null) {
    const campaign = await getStore().findOneWhere(getResource('creator_campaigns')!, { id: campaignId, empresa_id: escopo.empresaId });
    if (!campaign) throw new HttpError(404, 'Campanha não encontrada nesta empresa.');
  }
  const parametros = { data_referencia: dataReferencia, campaign_id: campaignId };
  const out = await executarAnaliseIA({
    actor, empresaId: escopo.empresaId, finalidade: 'creator_intelligence', chave: req.get('Idempotency-Key') ?? '',
    parametros, modelo: CREATOR_INTELLIGENCE_MODELO, versao: CREATOR_INTELLIGENCE_VERSAO, dataReferencia, providerId,
    calcular: (tx) => calcularCreatorIntelligence(escopo.empresaId, dataReferencia, campaignId, tx),
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(out.idempotente ? 200 : 201).json(out);
}
