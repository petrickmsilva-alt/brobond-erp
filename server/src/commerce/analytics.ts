// ============================================================================
// COMMERCE OS — TRENDS E ANALYTICS (só dado real, nunca série fake).
//
// Toda métrica é agregação sobre `sales` (análise), `vendas`/`sale_items`
// (operação/faturamento) e `commerce_pedidos` (conversão). Sem dado nenhum a
// resposta vem com séries vazias e zeros — a tela mostra EMPTY STATE honesto.
// As fórmulas (razão, média, tendência) vivem em regras.ts e são cobertas pelo
// oráculo em server/test/commerce-oracle.test.ts.
// ============================================================================
import type { Request, Response } from 'express';
import { getStore, checkAccess } from '../services';
import { currentUser } from '../auth';
import { escopoDoAtor } from '../empresa';
import { getResource } from '../resources';
import type { Row } from '../store';
import { mediaOuZero, razao, round2, tendenciaLinear, type CanalPedido } from './regras';

const R_SALES = () => getResource('sales')!;
const R_VENDAS = () => getResource('vendas')!;
const R_PEDIDOS = () => getResource('commerce_pedidos')!;

function diasAtras(dias: number, agora = new Date()): number {
  return agora.getTime() - dias * 86_400_000;
}

function noPeriodo(iso: unknown, inicioMs: number, fimMs: number): boolean {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return false;
  return t >= inicioMs && t <= fimMs;
}

async function vendasDoPeriodo(empresaId: number, inicioMs: number, fimMs: number): Promise<Row[]> {
  const out = await getStore().list(R_SALES(), {
    page: 1,
    pageSize: 5000,
    filter: { empresa_id: empresaId },
    sort: 'occurred_at',
    dir: 'desc',
  });
  return out.rows.filter((r) => noPeriodo(r.occurred_at ?? r.criado_em, inicioMs, fimMs));
}

/** GET /api/commerce/analytics?dias=30 — GMV, conversão, canais, top produtos. */
export async function analyticsCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 30));
  const agora = new Date();
  const fimMs = agora.getTime();
  const inicioMs = diasAtras(dias, agora);
  const s = getStore();

  const [periodo, periodoAnterior, pedidosPeriodo, itensRecentes] = await Promise.all([
    vendasDoPeriodo(escopo.empresaId, inicioMs, fimMs),
    vendasDoPeriodo(escopo.empresaId, diasAtras(dias * 2, agora), diasAtras(dias, agora)),
    s.list(R_PEDIDOS(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId } }),
    s.list(getResource('sale_items')!, { page: 1, pageSize: 5000, filter: {} }),
  ]);

  const pagas = periodo.filter((v) => String(v.status) === 'PAID');
  const gmv = pagas.reduce((soma, v) => soma + Number(v.amount_cents || 0), 0) / 100;
  const gmvAnterior =
    periodoAnterior.filter((v) => String(v.status) === 'PAID').reduce((soma, v) => soma + Number(v.amount_cents || 0), 0) / 100;

  const pedidosNoPeriodo = periodo.length;
  const pagosNoPeriodo = pagas.length;
  const conversaoPagamento = razao(pagosNoPeriodo, pedidosNoPeriodo);
  const ticketMedio = razao(gmv, pagosNoPeriodo);

  // Conversão analítica → operacional no período (o que virou venda de fato).
  const convertidos = pedidosPeriodo.rows.filter(
    (p) => String(p.estado) === 'CONVERTIDO' && p.convertido_em && noPeriodo(p.convertido_em, inicioMs, fimMs)
  );
  const conversaoOperacional = razao(convertidos.length, pedidosNoPeriodo);

  // Canal (análise): contagem e GMV por `channel`.
  const porCanal = new Map<string, { pedidos: number; pagos: number; gmv: number }>();
  for (const v of periodo) {
    const canal = String(v.channel || 'BROBOND');
    const atual = porCanal.get(canal) ?? { pedidos: 0, pagos: 0, gmv: 0 };
    atual.pedidos += 1;
    if (String(v.status) === 'PAID') {
      atual.pagos += 1;
      atual.gmv += Number(v.amount_cents || 0) / 100;
    }
    porCanal.set(canal, atual);
  }

  // Top produtos: itens de vendas pagas no período (GMV atribuído ao item).
  const idsVendasPagas = new Set(periodo.filter((v) => String(v.status) === 'PAID').map((v) => String(v.id)));
  const topPorProduto = new Map<number, { quantidade: number; receita: number }>();
  for (const item of itensRecentes.rows) {
    if (!idsVendasPagas.has(String(item.sale_id))) continue;
    const pid = Number(item.product_id || 0);
    if (!pid) continue;
    const atual = topPorProduto.get(pid) ?? { quantidade: 0, receita: 0 };
    atual.quantidade += Number(item.quantity || 0);
    atual.receita += (Number(item.subtotal_cents ?? Number(item.quantity || 0) * Number(item.unit_price_cents || 0)) || 0) / 100;
    topPorProduto.set(pid, atual);
  }
  const topProdutosIds = [...topPorProduto.entries()]
    .map(([produto_id, v]) => ({ produto_id, ...v }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 10);
  const { nomesProdutos } = await import('./grade');
  const nomes = await nomesProdutos(escopo.empresaId, topProdutosIds.map((p) => p.produto_id));
  const topProdutos = topProdutosIds.map((p) => ({ ...p, produto: nomes.get(p.produto_id) ?? `#${p.produto_id}` }));

  // Prazo médio de conversão (pedido pago → venda operacional), em horas.
  const prazosHoras: number[] = [];
  for (const p of pedidosPeriodo.rows) {
    if (String(p.estado) !== 'CONVERTIDO' || !p.pago_em || !p.convertido_em) continue;
    if (!noPeriodo(p.convertido_em, inicioMs, fimMs)) continue;
    const delta = Date.parse(String(p.convertido_em)) - Date.parse(String(p.pago_em));
    if (Number.isFinite(delta) && delta >= 0) prazosHoras.push(delta / 3_600_000);
  }

  // Vendas operacionais faturadas no período (receita real do ERP).
  const vendasOperacionais = await s.list(R_VENDAS(), {
    page: 1,
    pageSize: 2000,
    filter: { empresa_id: escopo.empresaId },
    sort: 'criado_em',
    dir: 'desc',
  });
  const doPeriodoOp = vendasOperacionais.rows.filter((v) => noPeriodo(v.faturada_em ?? v.criado_em, inicioMs, fimMs));
  const receitaOperacional = doPeriodoOp.reduce((soma, v) => soma + Number(v.total || 0), 0);

  // Margem bruta: colunas do MOTOR de margem (`sales.gross_profit_cents`).
  // Só existem no PostgreSQL — no modo demonstração a resposta vem `null`
  // com o motivo (nunca um zero inventado para preencher a tela).
  let margem: { bruta: number | null; pct: number | null; indisponivel: string | null } = {
    bruta: null,
    pct: null,
    indisponivel: null,
  };
  try {
    const { query } = await import('../db');
    const r = await query<{ bruta: string | null; receita: string | null }>(
      `SELECT COALESCE(SUM(gross_profit_cents), 0)::text AS bruta,
              COALESCE(SUM(amount_cents), 0)::text AS receita
         FROM sales
        WHERE empresa_id = $1 AND status = 'PAID'
          AND gross_profit_cents IS NOT NULL
          AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`,
      [escopo.empresaId, new Date(inicioMs).toISOString(), new Date(fimMs).toISOString()]
    );
    const linha = r.rows[0];
    const bruta = Number(linha?.bruta ?? 0) / 100;
    const receitaBruta = Number(linha?.receita ?? 0) / 100;
    margem = {
      bruta: round2(bruta),
      pct: receitaBruta > 0 ? round2((bruta / receitaBruta) * 100) : 0,
      indisponivel: null,
    };
  } catch {
    margem = {
      bruta: null,
      pct: null,
      indisponivel: 'O motor de margem grava em PostgreSQL; no modo demonstração não há margem calculada para exibir.',
    };
  }

  const variacaoGmv = gmvAnterior > 0 ? round2(((gmv - gmvAnterior) / gmvAnterior) * 100) : null;

  res.json({
    periodo: { dias, inicio: new Date(inicioMs).toISOString(), fim: new Date(fimMs).toISOString() },
    gmv: round2(gmv),
    gmv_periodo_anterior: round2(gmvAnterior),
    variacao_gmv_pct: variacaoGmv,
    pedidos: pedidosNoPeriodo,
    pagos: pagosNoPeriodo,
    conversao_pagamento_pct: round2(conversaoPagamento * 100),
    conversao_operacional_pct: round2(conversaoOperacional * 100),
    ticket_medio: round2(ticketMedio),
    prazo_medio_conversao_h: mediaOuZero(prazosHoras),
    operacional: {
      vendas_faturadas: doPeriodoOp.length,
      receita: round2(receitaOperacional),
      margem_bruta: margem.bruta,
      margem_pct: margem.pct,
      ...(margem.indisponivel ? { margem_indisponivel: margem.indisponivel } : {}),
    },
    por_canal: [...porCanal.entries()]
      .map(([canal, v]) => ({ canal, pedidos: v.pedidos, pagos: v.pagos, gmv: round2(v.gmv) }))
      .sort((a, b) => b.gmv - a.gmv),
    top_produtos: topProdutos.map((p) => ({
      produto_id: p.produto_id,
      produto: p.produto,
      quantidade: p.quantidade,
      receita: round2(p.receita),
    })),
    vazio: pedidosNoPeriodo === 0,
  });
}

/** GET /api/commerce/trends?dias=30 — série diária + tendência real. */
export async function trendsCommerce(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PEDIDOS(), actor, 'read');
  const dias = Math.min(90, Math.max(7, Number(req.query.dias) || 30));
  const agora = new Date();
  const fimMs = agora.getTime();
  const inicioMs = diasAtras(dias, agora);
  const periodo = await vendasDoPeriodo(escopo.empresaId, inicioMs, fimMs);

  const porDia = new Map<string, { pedidos: number; receita: number }>();
  for (let d = dias - 1; d >= 0; d -= 1) {
    const dia = new Date(fimMs - d * 86_400_000).toISOString().slice(0, 10);
    porDia.set(dia, { pedidos: 0, receita: 0 });
  }
  for (const v of periodo) {
    const dia = String(v.occurred_at ?? v.criado_em ?? '').slice(0, 10);
    const linha = porDia.get(dia);
    if (!linha) continue;
    linha.pedidos += 1;
    if (String(v.status) === 'PAID') linha.receita = round2(linha.receita + Number(v.amount_cents || 0) / 100);
  }

  const serie = [...porDia.entries()].map(([dia, v]) => ({ dia, pedidos: v.pedidos, receita: round2(v.receita) }));
  const receitas = serie.map((p) => p.receita);
  const pedidosSerie = serie.map((p) => p.pedidos);
  const tendencia = tendenciaLinear(receitas);

  const melhorDia = serie.reduce((melhor, p) => (p.receita > melhor.receita ? p : melhor), serie[0] ?? { dia: '', pedidos: 0, receita: 0 });
  const piorDia = serie.reduce((pior, p) => (p.receita < pior.receita ? p : pior), serie[0] ?? { dia: '', pedidos: 0, receita: 0 });

  // Top 5 SKUs da metade final vs inicial (crescimento real, % simples).
  const metade = Math.floor(periodo.length / 2);
  const primeira = periodo.slice(metade);
  const segunda = periodo.slice(0, periodo.length - metade);
  const skus = async (linhas: Row[]) => {
    const mapa = new Map<number, number>();
    const ids = new Set(linhas.filter((v) => String(v.status) === 'PAID').map((v) => String(v.id)));
    if (!ids.size) return mapa;
    const itens = await getStore().list(getResource('sale_items')!, { page: 1, pageSize: 5000, filter: {} });
    for (const i of itens.rows) {
      if (!ids.has(String(i.sale_id))) continue;
      const pid = Number(i.product_id || 0);
      if (!pid) continue;
      mapa.set(pid, (mapa.get(pid) ?? 0) + Number(i.quantity || 0));
    }
    return mapa;
  };
  const mapaA = await skus(primeira);
  const mapaB = await skus(segunda);
  const crescimento = [...new Set([...mapaA.keys(), ...mapaB.keys()])]
    .map((pid) => {
      const a = mapaA.get(pid) ?? 0;
      const b = mapaB.get(pid) ?? 0;
      const variacao = a > 0 ? round2(((b - a) / a) * 100) : b > 0 ? 100 : 0;
      return { produto_id: pid, qtd_inicio: a, qtd_fim: b, variacao_pct: variacao };
    })
    .filter((c) => c.qtd_inicio > 0 || c.qtd_fim > 0)
    .sort((x, y) => y.variacao_pct - x.variacao_pct)
    .slice(0, 5);
  const { nomesProdutos } = await import('./grade');
  const nomes = await nomesProdutos(escopo.empresaId, crescimento.map((c) => c.produto_id));

  const totalReceita = receitas.reduce((a, b) => a + b, 0);
  res.json({
    periodo: { dias, inicio: new Date(inicioMs).toISOString(), fim: new Date(fimMs).toISOString() },
    serie,
    totais: {
      pedidos: pedidosSerie.reduce((a, b) => a + b, 0),
      receita: round2(totalReceita),
      media_diaria: round2(totalReceita / dias),
    },
    tendencia: {
      slope: tendencia.slope,
      direcao: tendencia.slope > 0 ? 'alta' : tendencia.slope < 0 ? 'baixa' : 'estavel',
    },
    melhor_dia: melhorDia,
    pior_dia: piorDia,
    top_crescimento: crescimento.map((c) => ({
      ...c,
      produto: nomes.get(c.produto_id) ?? `#${c.produto_id}`,
    })),
    vazio: periodo.length === 0,
  });
}
