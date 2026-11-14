// ============================================================================
// ETAPA 06 — TREND HUNTER (determinístico, interno, auditável).
//
// Descoberta de tendências de VENDAS REAIS do ERP: compara duas janelas civis
// UTC iguais e consecutivas por produto e gera recomendações pendentes na
// plataforma existente (ai_executions + ai_recommendations). Não consulta
// rede social/marketplace externo, não cria pedido, não altera preço/estoque e
// não transforma ausência de base em crescimento fabricado.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess } from './services';
import type { Row, Tx } from './store';
import { round2 } from './utils';
import {
  EVIDENCIA_FORMATO_VERSAO, fator, listarTodosIA, scorePonderado,
  executarAnaliseIA, dataReferenciaIA, type EvidenciaExecutiva, type RecomendacaoDeterministica,
} from './aiPlatform';

export const TREND_HUNTER_VERSAO = '1.0.0';
export const TREND_HUNTER_MODELO = 'trend-hunter-deterministico';
export const TREND_HUNTER_PESOS = Object.freeze({ crescimento: 0.45, volume: 0.3, consistencia: 0.25 });
export const TREND_HUNTER_MIN_UNIDADES = 3;
export const TREND_HUNTER_MIN_PEDIDOS = 2;
export const TREND_HUNTER_MIN_DIAS = 2;
export const TREND_HUNTER_VOLUME_REFERENCIA = 20;
export const TREND_HUNTER_MAX_RECOMENDACOES = 20;

export type JanelaTrend = { inicio: string; fim: string; dias: number };
export type AgregadoProdutoTrend = {
  produto_id: number;
  quantidade: number;
  receita: number;
  pedidos: Set<number>;
  dias: Set<string>;
};

export function janelaTrend(dataReferencia: string, dias: number): { atual: JanelaTrend; anterior: JanelaTrend } {
  if (!Number.isInteger(dias) || dias < 7 || dias > 90) throw new HttpError(400, 'janela_dias deve ser inteiro entre 7 e 90.');
  const fim = new Date(`${dataReferencia}T00:00:00Z`);
  const inicioAtual = new Date(fim.getTime() - (dias - 1) * 86_400_000);
  const fimAnterior = new Date(inicioAtual.getTime() - 86_400_000);
  const inicioAnterior = new Date(fimAnterior.getTime() - (dias - 1) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    atual: { inicio: iso(inicioAtual), fim: iso(fim), dias },
    anterior: { inicio: iso(inicioAnterior), fim: iso(fimAnterior), dias },
  };
}

function diaDe(v: unknown): string | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function emJanela(dia: string | null, j: JanelaTrend): boolean {
  return dia !== null && dia >= j.inicio && dia <= j.fim;
}
function novoAgregado(produto_id: number): AgregadoProdutoTrend {
  return { produto_id, quantidade: 0, receita: 0, pedidos: new Set(), dias: new Set() };
}

/** Agregação pura por produto — oráculo independente nos testes. */
export function agregarTrends(vendas: Row[], itens: Row[], janelas: { atual: JanelaTrend; anterior: JanelaTrend }) {
  const atual = new Map<number, AgregadoProdutoTrend>();
  const anterior = new Map<number, AgregadoProdutoTrend>();
  const vendaPorId = new Map<number, { dia: string; janela: 'atual' | 'anterior' }>();
  for (const v of vendas) {
    if (!['faturada', 'entregue'].includes(String(v.status))) continue;
    const dia = diaDe(v.faturada_em ?? v.data ?? v.criado_em);
    const janela = emJanela(dia, janelas.atual) ? 'atual' : emJanela(dia, janelas.anterior) ? 'anterior' : null;
    if (!janela || !dia) continue;
    vendaPorId.set(Number(v.id), { dia, janela });
  }
  for (const it of itens) {
    const venda = vendaPorId.get(Number(it.venda_id));
    const pid = Number(it.produto_id);
    if (!venda || !Number.isSafeInteger(pid) || pid < 1) continue;
    const mapa = venda.janela === 'atual' ? atual : anterior;
    const agg = mapa.get(pid) ?? novoAgregado(pid);
    agg.quantidade += Number(it.quantidade || 0);
    agg.receita = round2(agg.receita + Number(it.subtotal ?? Number(it.quantidade || 0) * Number(it.preco_unitario || 0)));
    agg.pedidos.add(Number(it.venda_id));
    agg.dias.add(venda.dia);
    mapa.set(pid, agg);
  }
  return { atual, anterior };
}

export function variacaoTrend(atual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return round2(((atual - anterior) / anterior) * 100);
}

export async function calcularTrendHunter(empresaId: number, dataReferencia: string, dias: number, tx?: Tx): Promise<{ resultado: Row; recomendacoes: RecomendacaoDeterministica[] }> {
  const janelas = janelaTrend(dataReferencia, dias);
  const [vendas, itens, produtos] = await Promise.all([
    listarTodosIA('vendas', empresaId, {}, tx),
    listarTodosIA('itens_venda', empresaId, {}, tx),
    listarTodosIA('produtos', empresaId, {}, tx),
  ]);
  const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
  const { atual, anterior } = agregarTrends(vendas, itens, janelas);
  const candidatos: Array<{ score: number; produto_id: number; agg: AgregadoProdutoTrend; base: AgregadoProdutoTrend | undefined; variacao: number | null }> = [];
  let semBase = 0;
  for (const [pid, agg] of atual) {
    const produto = produtoPorId.get(pid);
    if (!produto || produto.ativo === false) continue;
    const base = anterior.get(pid);
    const variacao = variacaoTrend(agg.quantidade, base?.quantidade ?? 0);
    if (variacao === null) { semBase += 1; continue; }
    if (variacao <= 0 || agg.quantidade < TREND_HUNTER_MIN_UNIDADES || agg.pedidos.size < TREND_HUNTER_MIN_PEDIDOS || agg.dias.size < TREND_HUNTER_MIN_DIAS) continue;
    const fatores = {
      crescimento: fator(variacao / 100, TREND_HUNTER_PESOS.crescimento, 'itens_venda.quantidade: janela atual × anterior'),
      volume: fator(agg.quantidade / TREND_HUNTER_VOLUME_REFERENCIA, TREND_HUNTER_PESOS.volume, `itens_venda.quantidade na janela atual; referência ${TREND_HUNTER_VOLUME_REFERENCIA} unidades`),
      consistencia: fator(agg.dias.size / dias, TREND_HUNTER_PESOS.consistencia, 'dias distintos com venda faturada/entregue na janela atual'),
    };
    candidatos.push({ score: scorePonderado(fatores), produto_id: pid, agg, base, variacao });
  }
  candidatos.sort((a, b) => b.score - a.score || a.produto_id - b.produto_id);
  const selecionados = candidatos.slice(0, TREND_HUNTER_MAX_RECOMENDACOES);
  const recomendacoes: RecomendacaoDeterministica[] = selecionados.map((c) => {
    const produto = produtoPorId.get(c.produto_id)!;
    const fatores = {
      crescimento: fator(c.variacao! / 100, TREND_HUNTER_PESOS.crescimento, 'itens_venda.quantidade: janela atual × anterior'),
      volume: fator(c.agg.quantidade / TREND_HUNTER_VOLUME_REFERENCIA, TREND_HUNTER_PESOS.volume, `itens_venda.quantidade na janela atual; referência ${TREND_HUNTER_VOLUME_REFERENCIA} unidades`),
      consistencia: fator(c.agg.dias.size / dias, TREND_HUNTER_PESOS.consistencia, 'dias distintos com venda faturada/entregue na janela atual'),
    };
    const evidencia: EvidenciaExecutiva = {
      formato_versao: EVIDENCIA_FORMATO_VERSAO,
      versao: TREND_HUNTER_VERSAO,
      formula: 'score = 0,45×min(max(variacao_pct/100,0),1) + 0,30×min(quantidade_atual/20,1) + 0,25×(dias_com_venda/janela_dias)',
      pesos: { ...TREND_HUNTER_PESOS },
      fatores,
      fonte: 'vendas + itens_venda + produtos (documentos canônicos do ERP)',
      data_referencia: dataReferencia,
      justificativa: `${produto.nome} (${produto.sku}): quantidade ${c.base?.quantidade ?? 0} → ${c.agg.quantidade} (${c.variacao}%), ${c.agg.pedidos.size} pedido(s) em ${c.agg.dias.size} dia(s) distintos.`,
      dados_ausentes: [],
      limitacoes: [
        'Tendência interna observada; não é descoberta externa nem previsão garantida.',
        'Não considera ruptura de estoque, margem, causalidade de campanha ou sazonalidade externa.',
        'Crescimento sem base anterior é null e não gera recomendação.',
      ],
      produto_id: c.produto_id,
      sku: produto.sku,
      produto: produto.nome,
      janelas,
      atual: { quantidade: c.agg.quantidade, receita: round2(c.agg.receita), pedidos: c.agg.pedidos.size, dias_com_venda: c.agg.dias.size },
      anterior: { quantidade: c.base?.quantidade ?? 0, receita: round2(c.base?.receita ?? 0), pedidos: c.base?.pedidos.size ?? 0, dias_com_venda: c.base?.dias.size ?? 0 },
      variacao_pct: c.variacao,
      descoberta_externa: false,
    };
    return {
      dominio: 'sales', score: c.score, evidencia,
      recomendacao: `Avaliar oportunidade interna de ${produto.nome} (${produto.sku}): vendas cresceram ${c.variacao}% em quantidade na janela de ${dias} dias; validar estoque e margem antes de qualquer ação comercial.`,
    };
  });
  return {
    resultado: {
      data_referencia: dataReferencia, janelas,
      produtos_com_venda_atual: atual.size,
      produtos_sem_base_anterior: semBase,
      candidatos_elegiveis: candidatos.length,
      recomendacoes_geradas: recomendacoes.length,
      descoberta_externa: false,
      criterios: { min_unidades: TREND_HUNTER_MIN_UNIDADES, min_pedidos: TREND_HUNTER_MIN_PEDIDOS, min_dias: TREND_HUNTER_MIN_DIAS, volume_referencia: TREND_HUNTER_VOLUME_REFERENCIA },
    },
    recomendacoes,
  };
}

export function capacidadesTrendHunter() {
  return {
    estado: 'ATIVO_DETERMINISTICO',
    versao: TREND_HUNTER_VERSAO,
    modelo: TREND_HUNTER_MODELO,
    fonte: 'vendas + itens_venda + produtos',
    descoberta_externa: false,
    motivo_bloqueio_externo: 'FONTE_EXTERNA_NAO_AUTORIZADA_SEM_CREDENCIAL_E_EGRESS',
    aplicacao_automatica: false,
    aprovacao_humana: true,
  };
}

/** POST /api/ai/trend-hunter/gerar — gerente+, idempotente por empresa. */
export async function gerarTrendHunter(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_recommendations')!, actor, 'create');
  const escopo = escopoDoAtor(actor);
  const body = (req.body ?? {}) as Row;
  const dataReferencia = dataReferenciaIA(body.data_referencia);
  const dias = body.janela_dias == null || body.janela_dias === '' ? 28 : Number(body.janela_dias);
  if (!Number.isInteger(dias) || dias < 7 || dias > 90) throw new HttpError(400, 'janela_dias deve ser inteiro entre 7 e 90.');
  const providerId = body.provider_id == null || body.provider_id === '' ? null : Number(body.provider_id);
  if (providerId !== null && (!Number.isSafeInteger(providerId) || providerId < 1)) throw new HttpError(400, 'provider_id inválido.');
  const parametros = { data_referencia: dataReferencia, janela_dias: dias };
  const out = await executarAnaliseIA({
    actor, empresaId: escopo.empresaId, finalidade: 'trend_hunter', chave: req.get('Idempotency-Key') ?? '',
    parametros, modelo: TREND_HUNTER_MODELO, versao: TREND_HUNTER_VERSAO, dataReferencia, providerId,
    calcular: (tx) => calcularTrendHunter(escopo.empresaId, dataReferencia, dias, tx),
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(out.idempotente ? 200 : 201).json(out);
}
