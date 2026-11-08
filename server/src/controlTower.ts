// ============================================================================
// FASE 8 — AI CONTROL TOWER (camada de LEITURA executiva).
//
// A Control Tower é uma camada de LEITURA, ANÁLISE e RECOMENDAÇÃO. Ela NÃO
// executa operação: consolida, em uma única resposta, o que o gestor precisa
// enxergar — indicadores, saúde operacional, alertas, previsões, recomendações
// e pendências críticas — sempre a partir dos documentos CANÔNICOS e dos
// resultados JÁ persistidos (projeções de BI, alertas, previsões, recomendações).
//
// Regras:
//   • Não cria uma segunda fonte de verdade: lê `vendas`, `itens_venda`,
//     `produtos`, `estoques` (canônico), `lancamentos_financeiros`,
//     `commerce_outbox`, `commerce_pedidos`, `service_tickets`, além de
//     `bi_read_models`, `demand_forecasts`, `ai_recommendations` e `alert_events`.
//   • Não inventa número: quando não há dado, devolve `null` com a limitação
//     declarada (`limitacoes`) em vez de zero enganoso.
//   • Cada indicador carrega definição, fórmula, origem e limitações conhecidas.
//   • Multiempresa: toda leitura recorta por `empresa_id`.
// ============================================================================
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { painelAlertas } from './alerts';
import { round2 } from './utils';
import type { Row, Tx } from './store';

type S = ReturnType<typeof getStore>;

const SEVERIDADES = ['baixa', 'media', 'alta', 'critica'] as const;
type Severidade = (typeof SEVERIDADES)[number];
const RANK: Record<Severidade, number> = { baixa: 0, media: 1, alta: 2, critica: 3 };

async function listarTudo(s: S, key: string, empresaId: number, filtro: Record<string, unknown> = {}, tx?: Tx): Promise<Row[]> {
  const r = getResource(key)!;
  const p = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } }, tx);
  return p.rows;
}

function periodoDe(iso: unknown): string {
  const d = iso ? new Date(String(iso)) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodos(agora: Date): { atual: string; anterior: string } {
  const atual = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}`;
  const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  return { atual, anterior: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` };
}

export type Indicador = {
  chave: string;
  label: string;
  valor: number | null;
  unidade: 'moeda' | 'quantidade' | 'percentual' | 'dias';
  definicao: string;
  formula: string;
  origem: string[];
  limitacoes: string[];
};

export type RecomendacaoTower = {
  id: number;
  dominio: string;
  score: number;
  recomendacao: string;
  evidencia: Record<string, unknown>;
  status: string;
  criado_em: string | null;
  /** Impacto estimado é derivado da evidência quando ela traz valor; senão null. */
  impacto_estimado: number | null;
  confianca: 'baixa' | 'media' | 'alta';
  requer_aprovacao: boolean;
};

export type ControlTower = {
  empresa_id: number;
  periodo: { atual: string; anterior: string };
  indicadores: Indicador[];
  saude_operacional: {
    outbox_pendente: number;
    outbox_erro: number;
    pedidos_parados: number;
    tickets_abertos: number;
    tickets_sla_estourado: number;
    alertas_abertos: number;
    alertas_criticos: number;
  };
  alertas: {
    totais: { abertos: number; cientes: number; resolvidos: number; silenciados: number; por_dominio: Record<string, number>; por_severidade: Record<string, number> };
    criticos: Array<{ id: number; dominio: string; severidade: string; titulo: string; detalhe: string; evidencia: Record<string, unknown> }>;
  };
  previsoes: {
    /** Última previsão de demanda materializada por produto (top por forecast). */
    demanda: Array<{ produto_id: number; produto: string | null; periodo: string; forecast: number; metodo: string }>;
    /** Necessidade de suprimento materializada (top por necessidade). */
    suprimento: Array<{ produto_id: number; produto: string | null; periodo: string; necessidade: number; status: string }>;
    /** Acurácia observada: compara previsão passada com o realizado. */
    acuracia: { periodos_avaliados: number; mae: number | null; mape_pct: number | null } | null;
    limitacoes: string[];
  };
  recomendacoes: { pendentes: RecomendacaoTower[]; total_pendentes: number };
  pendencias_criticas: Array<{ origem: string; descricao: string; severidade: Severidade; evidencia: Record<string, unknown> }>;
  limitacoes: string[];
  gerado_em: string;
};

const LIMITE_LISTAS = 25;

function confiancaDeScore(score: number): 'baixa' | 'media' | 'alta' {
  if (score >= 0.75) return 'alta';
  if (score >= 0.4) return 'media';
  return 'baixa';
}

/** Impacto estimado: só quando a evidência traz um valor monetário explícito. */
function impactoDaEvidencia(ev: Record<string, unknown>): number | null {
  for (const k of ['valor_vencido', 'receita_perdida', 'valor', 'necessidade_valor']) {
    if (ev[k] != null && Number.isFinite(Number(ev[k]))) return round2(Number(ev[k]));
  }
  return null;
}

/** Acurácia: compara previsões de períodos JÁ fechados com a receita realizada. */
async function acuraciaPrevisao(s: S, empresaId: number, agora: Date): Promise<ControlTower['previsoes']['acuracia']> {
  const previsoes = await listarTudo(s, 'demand_forecasts', empresaId);
  const atual = periodos(agora).atual;
  const passadas = previsoes.filter((p) => String(p.periodo) < atual);
  if (!passadas.length) return null;
  const vendas = (await listarTudo(s, 'vendas', empresaId)).filter((v) => ['faturada', 'entregue'].includes(String(v.status)));
  const receitaPorProdutoPeriodo = new Map<string, number>();
  for (const v of vendas) {
    const p = periodoDe(v.faturada_em || v.data);
    receitaPorProdutoPeriodo.set(p, (receitaPorProdutoPeriodo.get(p) || 0) + Number(v.total || 0));
  }
  // Sem granularidade de receita por produto/período confiável, avalia o erro de
  // PREVISÃO contra a receita do período (proxy declarado como limitação).
  let mae = 0;
  let mape = 0;
  let n = 0;
  for (const p of passadas) {
    const realizado = receitaPorProdutoPeriodo.get(String(p.periodo));
    if (realizado == null) continue;
    const previsto = Number(p.forecast || 0);
    mae += Math.abs(previsto - realizado);
    if (realizado > 0) mape += Math.abs((previsto - realizado) / realizado);
    n++;
  }
  if (!n) return null;
  return { periodos_avaliados: n, mae: round2(mae / n), mape_pct: round2((mape / n) * 100) };
}

export async function painelControlTower(empresaId: number): Promise<ControlTower> {
  const s = getStore();
  const agora = new Date();
  const { atual, anterior } = periodos(agora);
  const limitacoes: string[] = [];

  const [vendas, itens, produtos, lancamentos, outbox, pedidos, tickets, alertas, recomends, forecasts, planos] = await Promise.all([
    listarTudo(s, 'vendas', empresaId),
    listarTudo(s, 'itens_venda', empresaId),
    listarTudo(s, 'produtos', empresaId),
    listarTudo(s, 'lancamentos_financeiros', empresaId),
    listarTudo(s, 'commerce_outbox', empresaId),
    listarTudo(s, 'commerce_pedidos', empresaId),
    listarTudo(s, 'service_tickets', empresaId),
    painelAlertas(empresaId),
    listarTudo(s, 'ai_recommendations', empresaId, { status: 'pendente' }),
    listarTudo(s, 'demand_forecasts', empresaId),
    listarTudo(s, 'supply_plans', empresaId),
  ]);

  const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
  const faturadas = vendas.filter((v) => ['faturada', 'entregue'].includes(String(v.status)));
  const faturadasPeriodo = faturadas.filter((v) => periodoDe(v.faturada_em || v.data) === atual);
  const faturadasAnterior = faturadas.filter((v) => periodoDe(v.faturada_em || v.data) === anterior);

  const receitaAtual = round2(faturadasPeriodo.reduce((a, v) => a + Number(v.total || 0), 0));
  const receitaAnterior = round2(faturadasAnterior.reduce((a, v) => a + Number(v.total || 0), 0));
  const idsVendaPeriodo = new Set(faturadasPeriodo.map((v) => Number(v.id)));
  const cmv = round2(itens.filter((it) => idsVendaPeriodo.has(Number(it.venda_id)))
    .reduce((a, it) => a + Number(it.quantidade || 0) * Number(produtoPorId.get(Number(it.produto_id))?.custo || 0), 0));
  const margem = round2(receitaAtual - cmv);
  const ticketMedio = faturadasPeriodo.length ? round2(receitaAtual / faturadasPeriodo.length) : null;
  const crescimento = receitaAnterior > 0 ? round2(((receitaAtual - receitaAnterior) / receitaAnterior) * 100) : null;

  const vendasPorCanal = new Map<string, number>();
  for (const v of faturadasPeriodo) {
    const canal = String(v.canal_venda || 'BROBOND');
    vendasPorCanal.set(canal, round2((vendasPorCanal.get(canal) || 0) + Number(v.total || 0)));
  }

  // Contas a receber vencidas (indicador financeiro real).
  const hoje = agora.toISOString().slice(0, 10);
  const vencidos = lancamentos.filter((l) => String(l.tipo) === 'receita' && String(l.status) === 'pendente' && l.vencimento && String(l.vencimento) < hoje);
  const valorVencido = round2(vencidos.reduce((a, l) => a + Number(l.valor || 0), 0));

  const indicadores: Indicador[] = [
    {
      chave: 'receita', label: `Receita (${atual})`, valor: receitaAtual, unidade: 'moeda',
      definicao: 'Soma do total das vendas faturadas/entregues no período.',
      formula: 'Σ vendas.total onde status ∈ {faturada, entregue} e período = atual.',
      origem: ['vendas'],
      limitacoes: [],
    },
    {
      chave: 'pedidos', label: `Pedidos (${atual})`, valor: faturadasPeriodo.length, unidade: 'quantidade',
      definicao: 'Quantidade de vendas faturadas/entregues no período.',
      formula: 'count(vendas) com status ∈ {faturada, entregue} no período.',
      origem: ['vendas'],
      limitacoes: [],
    },
    {
      chave: 'ticket_medio', label: 'Ticket médio', valor: ticketMedio, unidade: 'moeda',
      definicao: 'Receita do período dividida pelo número de pedidos.',
      formula: 'receita / pedidos (null quando não há pedido no período).',
      origem: ['vendas'],
      limitacoes: ticketMedio == null ? ['Sem pedidos faturados no período: ticket médio não é definido.'] : [],
    },
    {
      chave: 'margem_pct', label: 'Margem bruta (%)', valor: receitaAtual > 0 ? round2((margem / receitaAtual) * 100) : null, unidade: 'percentual',
      definicao: 'Margem bruta sobre a receita, usando o custo unitário canônico do produto (CMV).',
      formula: '(receita − CMV) / receita × 100; CMV = Σ item.quantidade × produto.custo.',
      origem: ['vendas', 'itens_venda', 'produtos'],
      limitacoes: ['O custo é o unitário atual do cadastro do produto, não o custo histórico do lote da venda.'],
    },
    {
      chave: 'crescimento_pct', label: 'Crescimento MoM (%)', valor: crescimento, unidade: 'percentual',
      definicao: 'Variação da receita do período frente ao período anterior.',
      formula: '(receita_atual − receita_anterior) / receita_anterior × 100; null quando não há base.',
      origem: ['vendas'],
      limitacoes: crescimento == null ? [`Sem receita em ${anterior}: crescimento não é definido (não se presume base).`] : [],
    },
    {
      chave: 'receber_vencido', label: 'A receber vencido', valor: valorVencido, unidade: 'moeda',
      definicao: 'Soma dos lançamentos de receita pendentes com vencimento no passado.',
      formula: 'Σ lancamentos.valor onde tipo=receita, status=pendente e vencimento < hoje.',
      origem: ['lancamentos_financeiros'],
      limitacoes: ['Considera apenas lançamentos com vencimento preenchido.'],
    },
  ];
  for (const [canal, valor] of vendasPorCanal) {
    indicadores.push({
      chave: `receita_canal_${canal}`, label: `Receita canal ${canal}`, valor, unidade: 'moeda',
      definicao: `Receita faturada/entregue do canal ${canal} no período.`,
      formula: 'Σ vendas.total agrupado por canal_venda.',
      origem: ['vendas'], limitacoes: [],
    });
  }

  // Saúde operacional.
  const outboxPendente = outbox.filter((o) => ['PENDENTE', 'PROCESSANDO'].includes(String(o.estado || '').toUpperCase())).length;
  const outboxErro = outbox.filter((o) => ['ERRO', 'FALHA'].includes(String(o.estado || '').toUpperCase())).length;
  const limiteParado = agora.getTime() - 24 * 3_600_000;
  const pedidosParados = pedidos.filter((p) => {
    const estado = String(p.estado || '').toUpperCase();
    if (estado === 'ERRO' || estado === 'AGUARDANDO_CORRECAO') return true;
    if (estado === 'AGUARDANDO_PAGAMENTO') {
      const t = new Date(String(p.criado_em || 0)).getTime();
      return Number.isFinite(t) && t < limiteParado;
    }
    return false;
  }).length;
  const ticketsAbertos = tickets.filter((t) => ['aberto', 'em_atendimento', 'aguardando_cliente'].includes(String(t.status))).length;
  const ticketsSlaEstourado = tickets.filter((t) => ['aberto', 'em_atendimento', 'aguardando_cliente'].includes(String(t.status)) && t.prazo_resolucao_em && new Date(String(t.prazo_resolucao_em)).getTime() < agora.getTime()).length;
  const alertasCriticos = alertas.alertas.filter((a) => RANK[(String(a.severidade) as Severidade)] >= RANK.alta);

  // Previsões.
  const nomeProduto = (id: number) => (produtoPorId.get(id)?.nome != null ? String(produtoPorId.get(id)!.nome) : null);
  const demandaTop = [...forecasts]
    .sort((a, b) => Number(b.forecast || 0) - Number(a.forecast || 0))
    .slice(0, LIMITE_LISTAS)
    .map((f) => ({ produto_id: Number(f.produto_id), produto: nomeProduto(Number(f.produto_id)), periodo: String(f.periodo || ''), forecast: round2(Number(f.forecast || 0)), metodo: String(f.metodo || '') }));
  const suprimentoTop = [...planos]
    .sort((a, b) => Number(b.necessidade || 0) - Number(a.necessidade || 0))
    .slice(0, LIMITE_LISTAS)
    .map((p) => ({ produto_id: Number(p.produto_id), produto: nomeProduto(Number(p.produto_id)), periodo: String(p.periodo || ''), necessidade: round2(Number(p.necessidade || 0)), status: String(p.status || '') }));
  const acuracia = await acuraciaPrevisao(s, empresaId, agora);
  const limitacoesPrevisao = [
    'Previsões são estimativas: dependem do histórico de vendas e não são certeza.',
    'A acurácia compara previsões de períodos fechados com a receita realizada do período (proxy declarado) — não substitui backtesting por SKU.',
  ];
  if (!forecasts.length) limitacoesPrevisao.push('Nenhuma previsão materializada: gere o forecast de demanda antes de usar esta leitura.');

  // Recomendações pendentes (com rastreabilidade).
  const recomendsPendentes: RecomendacaoTower[] = recomends
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, LIMITE_LISTAS)
    .map((r) => {
      const ev = (r.evidencia as Record<string, unknown>) ?? {};
      return {
        id: Number(r.id),
        dominio: String(r.dominio || ''),
        score: Number(r.score || 0),
        recomendacao: String(r.recomendacao || ''),
        evidencia: ev,
        status: String(r.status || ''),
        criado_em: r.criado_em ? String(r.criado_em) : null,
        impacto_estimado: impactoDaEvidencia(ev),
        confianca: confiancaDeScore(Number(r.score || 0)),
        requer_aprovacao: true,
      };
    });

  // Pendências críticas (consolidação rastreável — nunca decorativa).
  const pendencias: ControlTower['pendencias_criticas'] = [];
  if (outboxErro > 0) pendencias.push({ origem: 'integracoes', descricao: `${outboxErro} evento(s) da fila em erro.`, severidade: 'alta', evidencia: { outbox_erro: outboxErro } });
  if (pedidosParados > 0) pendencias.push({ origem: 'operacao', descricao: `${pedidosParados} pedido(s) parado(s) há mais de 24h.`, severidade: 'alta', evidencia: { pedidos_parados: pedidosParados } });
  if (ticketsSlaEstourado > 0) pendencias.push({ origem: 'atendimento', descricao: `${ticketsSlaEstourado} ticket(s) com SLA estourado.`, severidade: 'alta', evidencia: { tickets_sla_estourado: ticketsSlaEstourado } });
  if (valorVencido > 0) pendencias.push({ origem: 'financeiro', descricao: `A receber vencido de ${valorVencido.toFixed(2)}.`, severidade: 'alta', evidencia: { valor_vencido: valorVencido } });
  for (const a of alertasCriticos.slice(0, LIMITE_LISTAS)) {
    pendencias.push({ origem: 'alerta', descricao: String(a.titulo || ''), severidade: String(a.severidade) as Severidade, evidencia: (a.evidencia as Record<string, unknown>) ?? {} });
  }
  pendencias.sort((a, b) => RANK[b.severidade] - RANK[a.severidade]);

  if (!faturadas.length) limitacoes.push('Sem vendas faturadas/entregues: indicadores comerciais refletem ausência de dado, não desempenho.');
  limitacoes.push('Indicadores de CAC/LTV não são calculados aqui: exigem metodologia definida e dados de investimento por canal.');

  return {
    empresa_id: empresaId,
    periodo: { atual, anterior },
    indicadores,
    saude_operacional: {
      outbox_pendente: outboxPendente,
      outbox_erro: outboxErro,
      pedidos_parados: pedidosParados,
      tickets_abertos: ticketsAbertos,
      tickets_sla_estourado: ticketsSlaEstourado,
      alertas_abertos: alertas.totais.abertos,
      alertas_criticos: alertasCriticos.length,
    },
    alertas: {
      totais: alertas.totais,
      criticos: alertasCriticos.slice(0, LIMITE_LISTAS).map((a) => ({
        id: Number(a.id), dominio: String(a.dominio), severidade: String(a.severidade),
        titulo: String(a.titulo), detalhe: String(a.detalhe), evidencia: (a.evidencia as Record<string, unknown>) ?? {},
      })),
    },
    previsoes: { demanda: demandaTop, suprimento: suprimentoTop, acuracia, limitacoes: limitacoesPrevisao },
    recomendacoes: { pendentes: recomendsPendentes, total_pendentes: recomends.length },
    pendencias_criticas: pendencias.slice(0, LIMITE_LISTAS),
    limitacoes,
    gerado_em: agora.toISOString(),
  };
}

export async function painelControlTowerHandler(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('alert_events')!, actor, 'read');
  const escopo = escopoDoAtor(actor);
  if (!(escopo.empresaId > 0)) throw new HttpError(400, 'Empresa ativa inválida.');
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await painelControlTower(escopo.empresaId));
}
