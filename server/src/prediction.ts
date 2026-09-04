// ============================================================
// Previsão de Demanda — sugere quanto produzir baseado no histórico.
//
// Usa média móvel ponderada (mais peso para meses recentes) + sazonalidade
// básica (meses do ano) para prever demanda dos próximos 30/60/90 dias.
//
// GET /api/predicao/demanda    — previsão por produto (com sugestão de OP)
// GET /api/predicao/insumos    — insumos necessários para a produção prevista
// ============================================================
import type { Request, Response } from 'express';
import { getStore } from './services';
import { getResource } from './resources';
import { checkAccess, getRecord } from './services';
import { currentUser } from './auth';
import { labelOf } from './store';
import type { Row } from './store';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Calcula previsão de demanda para um produto.
 * Método: média móvel ponderada dos últimos 6 meses de vendas faturadas.
 * Peso: mês mais recente = 6, anterior = 5, ... até 1. Total = 21.
 */
function preverDemandaMensal(vendasPorMes: number[]): number {
  if (!vendasPorMes.length) return 0;
  const pesos = [6, 5, 4, 3, 2, 1]; // mais recente → mais peso
  let somaPonderada = 0;
  let somaPesos = 0;
  for (let i = 0; i < Math.min(vendasPorMes.length, 6); i++) {
    somaPonderada += vendasPorMes[i] * pesos[i];
    somaPesos += pesos[i];
  }
  return somaPesos > 0 ? round2(somaPonderada / somaPesos) : 0;
}

/** GET /api/predicao/demanda — previsão por produto. */
export async function predicaoDemanda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');

  const s = getStore();
  const dias = Math.min(180, Math.max(7, Number(req.query.dias) || 30));
  const categoriaId = req.query.categoria_id ? Number(req.query.categoria_id) : undefined;
  const colecaoId = req.query.colecao_id ? Number(req.query.colecao_id) : undefined;

  // Busca todos os produtos ativos
  const filter: Record<string, unknown> = { ativo: true };
  if (categoriaId) filter.categoria_id = categoriaId;
  if (colecaoId) filter.colecao_id = colecaoId;
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 2000, filter });

  // Busca vendas faturadas dos últimos 6 meses
  const seisMesesAtras = new Date();
  seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
  const seisMesesStr = seisMesesAtras.toISOString().slice(0, 10);

  const vendas = await s.list(getResource('vendas')!, { page: 1, pageSize: 5000, sort: 'faturada_em', dir: 'asc' });
  const vendasFaturadas = vendas.rows.filter(
    (v) => ['faturada', 'entregue'].includes(String(v.status)) && String(v.faturada_em || v.data || '') >= seisMesesStr
  );

  // Busca itens de todas as vendas faturadas
  const itensVenda = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 20000 });

  // Busca estoque atual
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 10000 });
  const saldoPorProduto = new Map<number, number>();
  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    saldoPorProduto.set(pid, (saldoPorProduto.get(pid) || 0) + Number(e.quantidade || 0));
  }

  // Busca OPs em andamento
  const ordens = await s.list(getResource('ordens')!, { page: 1, pageSize: 2000, filter: { status: 'em_producao' } });
  const producaoPorProduto = new Map<number, number>();
  for (const o of ordens.rows) {
    const pid = Number(o.produto_id);
    producaoPorProduto.set(pid, (producaoPorProduto.get(pid) || 0) + Number(o.quantidade || 0));
  }

  // Calcula previsão para cada produto
  const previsoes: Row[] = [];
  for (const p of produtos.rows) {
    const pid = Number(p.id);

    // Histórico de vendas por mês (últimos 6 meses, mês mais recente primeiro)
    const vendasPorMes: number[] = [];
    for (let m = 0; m < 6; m++) {
      const mesRef = new Date();
      mesRef.setMonth(mesRef.getMonth() - m);
      const mesStr = mesRef.toISOString().slice(0, 7); // YYYY-MM
      let totalMes = 0;
      for (const v of vendasFaturadas) {
        const fatMes = String(v.faturada_em || v.data || '').slice(0, 7);
        if (fatMes === mesStr) {
          // Soma a quantidade de itens deste produto nesta venda
          for (const it of itensVenda.rows) {
            if (Number(it.venda_id) === Number(v.id) && Number(it.produto_id) === pid) {
              totalMes += Number(it.quantidade || 0);
            }
          }
        }
      }
      vendasPorMes.push(totalMes);
    }

    const demandaMensal = preverDemandaMensal(vendasPorMes);
    const demandaPeriodo = round2(demandaMensal * (dias / 30));
    const saldoAtual = saldoPorProduto.get(pid) || 0;
    const emProducao = producaoPorProduto.get(pid) || 0;
    const necessidade = Math.max(0, round2(demandaPeriodo - saldoAtual - emProducao));

    const totalVendido6m = vendasPorMes.reduce((s, v) => s + v, 0);

    previsoes.push({
      id: pid,
      sku: p.sku,
      nome: p.nome,
      categoria: p.categoria_id__label || null,
      // Vendas históricas
      vendas_6m: totalVendido6m,
      vendas_por_mes: vendasPorMes.reverse(), // mês mais antigo primeiro
      // Previsão
      demanda_mensal: demandaMensal,
      demanda_periodo: demandaPeriodo,
      dias: dias,
      // Situação atual
      saldo_estoque: saldoAtual,
      em_producao: emProducao,
      // Sugestão
      necessidade_producao: necessidade,
      sugestao_op: necessidade > 0 ? Math.ceil(necessidade) : 0,
      // Status
      status: necessidade <= 0 ? 'ok' : saldoAtual <= 0 ? 'critico' : 'alerta',
    });
  }

  // Ordena: críticos primeiro, depois por necessidade decrescente
  previsoes.sort((a, b) => {
    if (a.status === 'critico' && b.status !== 'critico') return -1;
    if (b.status === 'critico' && a.status !== 'critico') return 1;
    return b.necessidade_producao - a.necessidade_producao;
  });

  res.json({
    dias,
    total_produtos: previsoes.length,
    produtos_ok: previsoes.filter((p) => p.status === 'ok').length,
    produtos_alerta: previsoes.filter((p) => p.status === 'alerta').length,
    produtos_critico: previsoes.filter((p) => p.status === 'critico').length,
    total_sugerido: round2(previsoes.reduce((s, p) => s + p.necessidade_producao, 0)),
    previsoes,
  });
}

/** GET /api/predicao/insumos — insumos necessários para a produção prevista. */
export async function predicaoInsumos(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');

  const s = getStore();
  // Primeiro, pega a previsão de demanda
  const dias = Math.min(180, Math.max(7, Number(req.query.dias) || 30));

  // Reutiliza a lógica de demanda (simplificada aqui)
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 2000, filter: { ativo: true } });
  const vendas = await s.list(getResource('vendas')!, { page: 1, pageSize: 5000 });
  const itensVenda = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 20000 });
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 10000 });

  // Calcula necessidade de produção por produto (simplificado)
  const saldoPorProduto = new Map<number, number>();
  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    saldoPorProduto.set(pid, (saldoPorProduto.get(pid) || 0) + Number(e.quantidade || 0));
  }

  // Para cada produto, calcula demanda e necessidade
  const necessidadePorProduto = new Map<number, number>();
  for (const p of produtos.rows) {
    const pid = Number(p.id);
    const vendasProd = itensVenda.rows.filter((it) => Number(it.produto_id) === pid);
    const totalVendido = vendasProd.reduce((s, it) => s + Number(it.quantidade || 0), 0);
    const mediaMensal = totalVendido / 6; // simplificado
    const demanda = round2(mediaMensal * (dias / 30));
    const saldo = saldoPorProduto.get(pid) || 0;
    const necessidade = Math.max(0, demanda - saldo);
    if (necessidade > 0) necessidadePorProduto.set(pid, Math.ceil(necessidade));
  }

  // Para cada produto com necessidade, busca a ficha técnica e calcula insumos
  const insumoNecessario = new Map<number, { insumo_id: number; nome: string; unidade: string; quantidade: number; saldo: number; faltante: number }>();

  for (const [pid, qtdProd] of necessidadePorProduto) {
    const fichas = await s.list(getResource('fichas')!, { page: 1, pageSize: 1, filter: { produto_id: pid } });
    if (!fichas.rows.length) continue;
    const ficha = fichas.rows[0];

    const itensFicha = await s.list(getResource('itens_ficha_tecnica')!, { page: 1, pageSize: 500, filter: { ficha_id: Number(ficha.id) } });
    for (const item of itensFicha.rows) {
      const insId = Number(item.insumo_id);
      const consumo = Number(item.consumo || 0);
      const perda = Number(item.perda_pct || 0);
      if (!insId || consumo <= 0) continue;

      const totalInsumo = round2(qtdProd * consumo * (1 + perda / 100));
      const atual = insumoNecessario.get(insId) || { insumo_id: insId, nome: '', unidade: '', quantidade: 0, saldo: 0, faltante: 0 };
      atual.quantidade += totalInsumo;
      insumoNecessario.set(insId, atual);
    }
  }

  // Busca dados dos insumos e saldo
  const insumos = await s.list(getResource('insumos')!, { page: 1, pageSize: 2000 });
  const estoqueIns = await s.list(getResource('estoque_insumos')!, { page: 1, pageSize: 2000 });
  const saldoInsMap = new Map(estoqueIns.rows.map((e) => [Number(e.insumo_id), Number(e.quantidade || 0)]));

  const resultado = [...insumoNecessario.values()].map((item) => {
    const ins = insumos.rows.find((i) => Number(i.id) === item.insumo_id);
    item.nome = ins ? labelOf(getResource('insumos')!, ins) : `#${item.insumo_id}`;
    item.unidade = ins?.unidade || 'un';
    item.saldo = saldoInsMap.get(item.insumo_id) || 0;
    item.faltante = Math.max(0, round2(item.quantidade - item.saldo));
    return item;
  });

  resultado.sort((a, b) => b.faltante - a.faltante);

  res.json({
    dias,
    total_insumos: resultado.length,
    insumos_com_falta: resultado.filter((i) => i.faltante > 0).length,
    insumos: resultado,
  });
}
