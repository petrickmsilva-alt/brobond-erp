// ============================================================================
// ETAPA 08 — AI STUDIO / AI CEO (catálogo fechado + briefing determinístico).
//
// O Studio NÃO é um executor arbitrário de ferramentas: expõe o catálogo dos
// agentes determinísticos homologados internamente (06/07/08) e seus limites.
// O AI CEO consolida a Control Tower em um briefing executivo rastreável,
// gravado como recomendação pendente na plataforma existente. Nenhuma escrita
// operacional, chamada LLM externa ou envio automático é executada aqui.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess } from './services';
import type { Row } from './store';
import { painelControlTower } from './controlTower';
import { capacidadesTrendHunter } from './trendHunter';
import { capacidadesCreatorIntelligence } from './creatorIntelligence';
import {
  EVIDENCIA_FORMATO_VERSAO, clamp01, fator, round3, scorePonderado,
  executarAnaliseIA, dataReferenciaIA, type EvidenciaExecutiva,
} from './aiPlatform';

export const AI_CEO_VERSAO = '1.0.0';
export const AI_CEO_MODELO = 'ai-ceo-briefing-deterministico';
export const AI_CEO_PESOS = Object.freeze({ alertas: 0.3, fila: 0.2, pedidos: 0.2, sla: 0.15, financeiro: 0.15 });

export function catalogoAIStudio() {
  return {
    versao: '1.0.0',
    camada: 'deterministica',
    generativo_externo: false,
    motivo_bloqueio_generativo: 'ADAPTER_LLM_EVALS_HOMOLOGACAO_PENDENTES',
    agentes: [
      {
        ...capacidadesTrendHunter(),
        id: 'trend-hunter', nome: 'Trend Hunter',
        endpoint: '/api/ai/trend-hunter/gerar', rbac: 'gerente',
      },
      {
        ...capacidadesCreatorIntelligence(),
        id: 'creator-intelligence', nome: 'Creator Intelligence',
        endpoint: '/api/creators/intelligence/gerar', rbac: 'gerente',
      },
      {
        id: 'ai-ceo', nome: 'AI CEO', estado: 'ATIVO_DETERMINISTICO',
        modelo: AI_CEO_MODELO, versao: AI_CEO_VERSAO,
        endpoint: '/api/ai/ceo/briefing/gerar', rbac: 'gerente',
        fonte: 'Control Tower (documentos canônicos + alertas + recomendações)',
        aplicacao_automatica: false, aprovacao_humana: true,
      },
    ],
    ferramentas: [
      { id: 'control-tower.ler', tipo: 'leitura', endpoint: '/api/control-tower/painel', rbac: 'gerente', aprovacao_humana: false },
      { id: 'ai-recommendations.decidir', tipo: 'decisao_humana', endpoint: '/api/ai/recomendacoes/:id/decidir', rbac: 'gerente', aprovacao_humana: true },
    ],
    limites: [
      'Nenhuma ferramenta genérica de shell/SQL/HTTP/deploy existe neste catálogo.',
      'Recomendação não altera preço, estoque, pedido, pagamento, financeiro ou campanha.',
      'Provider externo cadastrado não habilita chamada generativa sem adapter homologado.',
    ],
  };
}

/** GET /api/ai/studio/capabilities — catálogo fechado, sem dados de tenant. */
export function capacidadesAIStudio(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_executions')!, actor, 'read');
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(catalogoAIStudio());
}

export function prioridadeCEO(saude: { alertas_criticos: number; outbox_erro: number; pedidos_parados: number; tickets_sla_estourado: number }, valorVencido: number | null) {
  const fatores = {
    alertas: fator(saude.alertas_criticos / 5, AI_CEO_PESOS.alertas, 'Control Tower: alertas críticos/altos abertos; referência 5'),
    fila: fator(saude.outbox_erro / 10, AI_CEO_PESOS.fila, 'Control Tower: eventos commerce_outbox em erro; referência 10'),
    pedidos: fator(saude.pedidos_parados / 10, AI_CEO_PESOS.pedidos, 'Control Tower: pedidos parados/erro; referência 10'),
    sla: fator(saude.tickets_sla_estourado / 10, AI_CEO_PESOS.sla, 'Control Tower: tickets com SLA estourado; referência 10'),
    financeiro: fator(valorVencido === null ? 0 : clamp01(valorVencido / 10_000), AI_CEO_PESOS.financeiro, 'Control Tower: receber vencido; referência R$ 10.000 (null = sem dado, não zero realizado)'),
  };
  return { score: scorePonderado(fatores), fatores };
}

/** POST /api/ai/ceo/briefing/gerar — briefing executivo determinístico. */
export async function gerarBriefingCEO(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_recommendations')!, actor, 'create');
  const escopo = escopoDoAtor(actor);
  const body = (req.body ?? {}) as Row;
  const dataReferencia = dataReferenciaIA(body.data_referencia);
  const providerId = body.provider_id == null || body.provider_id === '' ? null : Number(body.provider_id);
  if (providerId !== null && (!Number.isSafeInteger(providerId) || providerId < 1)) throw new HttpError(400, 'provider_id inválido.');
  const parametros = { data_referencia: dataReferencia };
  const out = await executarAnaliseIA({
    actor, empresaId: escopo.empresaId, finalidade: 'ai_ceo_briefing', chave: req.get('Idempotency-Key') ?? '',
    parametros, modelo: AI_CEO_MODELO, versao: AI_CEO_VERSAO, dataReferencia, providerId,
    calcular: async () => {
      const tower = await painelControlTower(escopo.empresaId, new Date(`${dataReferencia}T00:00:00Z`));
      const indicadorVencido = tower.indicadores.find((i) => i.chave === 'receber_vencido');
      const valorVencido = indicadorVencido?.valor == null ? null : Number(indicadorVencido.valor);
      const { score, fatores } = prioridadeCEO(tower.saude_operacional, valorVencido);
      const prioridades = tower.pendencias_criticas.slice(0, 5).map((p) => `${p.origem}: ${p.descricao}`);
      const texto = prioridades.length
        ? `Briefing executivo (${dataReferencia}): prioridades — ${prioridades.join(' | ')}. Recomenda-se revisão humana e plano de ação; nenhuma operação foi executada.`
        : `Briefing executivo (${dataReferencia}): nenhuma pendência crítica detectada nos documentos canônicos. Manter monitoramento e revisar indicadores com o gestor.`;
      const evidencia: EvidenciaExecutiva = {
        formato_versao: EVIDENCIA_FORMATO_VERSAO,
        versao: AI_CEO_VERSAO,
        formula: 'prioridade = 0,30×min(alertas_criticos/5,1) + 0,20×min(outbox_erro/10,1) + 0,20×min(pedidos_parados/10,1) + 0,15×min(sla_estourado/10,1) + 0,15×min(receber_vencido/10000,1)',
        pesos: { ...AI_CEO_PESOS },
        fatores,
        fonte: 'Control Tower: vendas, itens_venda, produtos, lancamentos_financeiros, commerce_outbox, commerce_pedidos, service_tickets, alert_events, ai_recommendations',
        data_referencia: dataReferencia,
        justificativa: texto,
        dados_ausentes: valorVencido === null ? ['receber_vencido'] : [],
        limitacoes: [
          'Briefing é leitura executiva derivada; não substitui decisão humana nem auditoria contábil.',
          'Indicadores carregam definição/fórmula/origem/limitações na Control Tower.',
          'Não há geração generativa externa nem aplicação automática de recomendação.',
        ],
        periodo: tower.periodo,
        indicadores: tower.indicadores,
        saude_operacional: tower.saude_operacional,
        pendencias_criticas: tower.pendencias_criticas,
        recomendacoes_pendentes: tower.recomendacoes.total_pendentes,
        aplicacao_automatica: false,
      };
      return {
        resultado: { data_referencia: dataReferencia, score_prioridade: round3(score), pendencias: tower.pendencias_criticas.length, aplicacao_automatica: false },
        recomendacoes: [{ dominio: 'commerce', score, evidencia, recomendacao: texto.slice(0, 2000) }],
      };
    },
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(out.idempotente ? 200 : 201).json(out);
}
