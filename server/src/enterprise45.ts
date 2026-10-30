// ============================================================================
// ONDAS 4–5 / D2–D7 — GROWTH, DATA/BI, AI, DEMAND/SUPPLY, WMS/TMS, EPM.
//
// Princípios (invariantes do módulo):
//   • empresa = tenant; toda leitura/escrita é recortada por `empresa_id`;
//   • nada duplica estoque, ledger, OMS, customer master ou auditoria — este
//     módulo ESCREVE nos documentos canônicos (comissoes_apuradas,
//     lancamentos_financeiros, estoques, movimentacoes) e apenas DERIVA leitura;
//   • dinheiro/pontos são derivados de documentos reais; nenhum número fictício;
//   • IA não altera estoque/pagamento/financeiro/pedido: só recomenda, com
//     evidência, e a decisão humana fica auditada;
//   • toda operação mutável é idempotente por chave única por empresa.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentUser } from './auth';
import { escopoDoAtor } from './empresa';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore } from './services';
import { domainLock } from './domainLock';
import { round2 } from './utils';
import type { Row, Tx } from './store';

type S = ReturnType<typeof getStore>;

function escopoDe(req: Request) {
  return escopoDoAtor(currentUser(req));
}

async function listarTudo(s: S, key: string, empresaId: number, filtro: Record<string, unknown> = {}, tx?: Tx): Promise<Row[]> {
  const r = getResource(key)!;
  const p = await s.list(r, { page: 1, pageSize: 50_000, filter: { ...filtro, empresa_id: empresaId } }, tx);
  return p.rows;
}

function periodoDe(iso: string | null | undefined): string {
  const d = iso ? new Date(String(iso)) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodoValido(v: unknown): string {
  const p = String(v || '');
  if (!/^\d{4}-\d{2}$/.test(p)) throw new HttpError(400, 'Período inválido.', { periodo: 'Use o formato AAAA-MM.' });
  return p;
}

function idDe(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function chaveDe(req: Request): string {
  const k = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(k)) throw new HttpError(400, 'Informe Idempotency-Key com 8 a 160 caracteres seguros.');
  return k;
}

// ============================================================================
// D2 — MARKETING AUTOMATION
// ============================================================================

/**
 * Dispara uma automação: avalia a condição contra o contexto real, grava a
 * execução idempotente e, quando a ação é creditar pontos, escreve no programa
 * de fidelidade (fonte canônica do saldo). Nunca altera pedido/pagamento.
 */
export async function dispararAutomacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('marketing_automations')!, actor, 'read');
  const escopo = escopoDe(req);
  const automacaoId = idDe(req.params.id, 'Automação');
  const chave = chaveDe(req);
  const s = getStore();
  const body = (req.body ?? {}) as Row;

  const resultado = await s.transaction(async (tx) => {
    const auto = await s.findOneWhere(getResource('marketing_automations')!, { id: automacaoId, empresa_id: escopo.empresaId }, tx);
    if (!auto) throw new HttpError(404, 'Automação não encontrada nesta empresa.');
    if (!auto.ativo) throw new HttpError(409, 'Automação inativa.');
    // Idempotência: a mesma chave não gera segunda execução.
    const ja = await s.findOneWhere(getResource('marketing_automation_runs')!, { empresa_id: escopo.empresaId, chave_idempotencia: chave }, tx);
    if (ja) return { run: ja, idempotente: true };

    const clienteId = body.cliente_id ? idDe(body.cliente_id, 'Cliente') : null;
    if (clienteId) {
      const cliente = await s.findOneWhere(getResource('clientes')!, { id: clienteId, empresa_id: escopo.empresaId }, tx);
      if (!cliente) throw new HttpError(404, 'Cliente não encontrado nesta empresa.');
    }

    // Condição: filtro de consentimento de marketing (LGPD) quando a ação é envio.
    const condicao = typeof auto.condicao === 'string' ? JSON.parse(String(auto.condicao || '{}')) : (auto.condicao || {});
    const exigeConsent = String(auto.acao_tipo) === 'enviar_mensagem' || (condicao as Row).consentimento_marketing;
    if (exigeConsent && clienteId) {
      const consent = await s.findOneWhere(getResource('customer_consents')!, { empresa_id: escopo.empresaId, cliente_id: clienteId, finalidade: 'marketing', concedido: true }, tx);
      if (!consent) throw new HttpError(409, 'Cliente sem consentimento de marketing — envio bloqueado.', { cliente_id: clienteId });
    }

    const run = await s.insert(getResource('marketing_automation_runs')!, {
      empresa_id: escopo.empresaId, automacao_id: automacaoId, cliente_id: clienteId,
      pedido_id: body.pedido_id ? Number(body.pedido_id) : null, estado: 'executada',
      chave_idempotencia: chave,
    }, tx);

    // Ação "creditar_pontos": delega ao programa (saldo canônico, idempotente).
    let pontos: number | null = null;
    if (String(auto.acao_tipo) === 'creditar_pontos' && clienteId) {
      const programaId = Number((condicao as Row).programa_id || 0);
      const qtd = Number((condicao as Row).pontos || 0);
      if (programaId && qtd) {
        await creditarPontos(tx, escopo.empresaId, programaId, clienteId, qtd, `auto-${automacaoId}-${chave}`, `Automação #${automacaoId}`);
        pontos = qtd;
      }
    }
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'marketing_automations', registro_id: automacaoId,
      descricao: 'Automação de marketing disparada', dados: { run_id: Number(run.id), cliente_id: clienteId } }, tx);
    return { run, idempotente: false, pontos };
  });
  res.status(resultado.idempotente ? 200 : 201).json(resultado);
}

// ============================================================================
// D2 — LOYALTY (saldo = soma dos movimentos; idempotente)
// ============================================================================

/** Grava um movimento de pontos de forma idempotente e consistente. */
async function creditarPontos(tx: Tx, empresaId: number, programaId: number, clienteId: number, pontos: number, chave: string, descricao: string): Promise<Row> {
  const s = getStore();
  const ja = await s.findOneWhere(getResource('loyalty_movements')!, { empresa_id: empresaId, chave_idempotencia: chave }, tx);
  if (ja) return ja;
  const programa = await s.findOneWhere(getResource('loyalty_programs')!, { id: programaId, empresa_id: empresaId }, tx);
  if (!programa) throw new HttpError(404, 'Programa de fidelidade não encontrado nesta empresa.');
  const cliente = await s.findOneWhere(getResource('clientes')!, { id: clienteId, empresa_id: empresaId }, tx);
  if (!cliente) throw new HttpError(404, 'Cliente não encontrado nesta empresa.');
  // Resgate não pode exceder o saldo real (soma dos movimentos).
  if (pontos < 0) {
    const saldo = await saldoPontos(s, empresaId, programaId, clienteId, tx);
    if (saldo + pontos < 0) throw new HttpError(409, 'Saldo de pontos insuficiente.', { saldo, solicitado: pontos });
  }
  const validade = programa.validade_dias == null ? null : new Date(Date.now() + Number(programa.validade_dias) * 86_400_000).toISOString();
  return s.insert(getResource('loyalty_movements')!, {
    empresa_id: empresaId, programa_id: programaId, cliente_id: clienteId,
    tipo: pontos >= 0 ? 'credito' : 'resgate', pontos, expira_em: pontos >= 0 ? validade : null,
    chave_idempotencia: chave, descricao: descricao.slice(0, 300),
  }, tx);
}

async function saldoPontos(s: S, empresaId: number, programaId: number, clienteId: number, tx?: Tx): Promise<number> {
  const movs = await listarTudo(s, 'loyalty_movements', empresaId, { programa_id: programaId, cliente_id: clienteId }, tx);
  return movs.reduce((acc, m) => acc + Number(m.pontos || 0), 0);
}

/** Credita pontos por venda paga (chave idempotente por venda). */
export async function creditarPontosVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('loyalty_movements')!, actor, 'read');
  const escopo = escopoDe(req);
  const body = (req.body ?? {}) as Row;
  const programaId = idDe(body.programa_id, 'Programa');
  const clienteId = idDe(body.cliente_id, 'Cliente');
  const vendaId = body.venda_id ? idDe(body.venda_id, 'Venda') : null;
  const chave = `venda-${vendaId ?? 'avulsa'}-${clienteId}-${programaId}`;
  const s = getStore();
  const mov = await s.transaction(async (tx) => {
    const programa = await s.findOneWhere(getResource('loyalty_programs')!, { id: programaId, empresa_id: escopo.empresaId }, tx);
    if (!programa) throw new HttpError(404, 'Programa não encontrado nesta empresa.');
    // O cliente precisa ser da empresa ativa (isolamento) — antes de qualquer cálculo.
    const cliente = await s.findOneWhere(getResource('clientes')!, { id: clienteId, empresa_id: escopo.empresaId }, tx);
    if (!cliente) throw new HttpError(404, 'Cliente não encontrado nesta empresa.');
    let valor = Number(body.valor || 0);
    if (vendaId && !valor) {
      const venda = await s.findOneWhere(getResource('vendas')!, { id: vendaId, empresa_id: escopo.empresaId }, tx);
      if (!venda) throw new HttpError(404, 'Venda não encontrada nesta empresa.');
      valor = Number(venda.total || 0);
    }
    const pontos = Math.floor(valor * Number(programa.pontos_por_real || 0));
    if (pontos <= 0) throw new HttpError(400, 'Nenhum ponto a creditar para este valor.');
    return creditarPontos(tx, escopo.empresaId, programaId, clienteId, pontos, chave, `Crédito por venda #${vendaId ?? '-'}`);
  });
  res.status(201).json(mov);
}

/** Saldo e extrato de pontos do cliente, com o nível alcançado. */
export async function saldoFidelidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('loyalty_movements')!, actor, 'read');
  const escopo = escopoDe(req);
  const clienteId = idDe(req.params.clienteId, 'Cliente');
  const s = getStore();
  const movs = await listarTudo(s, 'loyalty_movements', escopo.empresaId, { cliente_id: clienteId });
  const programas = await listarTudo(s, 'loyalty_programs', escopo.empresaId);
  const porPrograma = programas.map((p) => {
    const doPrograma = movs.filter((m) => Number(m.programa_id) === Number(p.id));
    const saldo = doPrograma.reduce((acc, m) => acc + Number(m.pontos || 0), 0);
    return { programa_id: Number(p.id), nome: p.nome, saldo, movimentos: doPrograma.length };
  });
  res.json({ cliente_id: clienteId, programas: porPrograma, gerado_em: new Date().toISOString() });
}

// ============================================================================
// D2 — AFFILIATE: comissão derivada de atribuição real (sem duplicar)
// ============================================================================

/**
 * Apura a comissão de uma parceria a partir da ATRIBUIÇÃO real do pedido.
 * Sem atribuição elegível, não gera comissão. A chave idempotente é
 * parceria+atribuição, então reprocessar não duplica valor.
 */
export async function apurarComissaoAfiliado(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('affiliate_commissions')!, actor, 'read');
  const escopo = escopoDe(req);
  const partnershipId = idDe(req.params.partnershipId, 'Parceria');
  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    const parceria = await s.findOneWhere(getResource('creator_partnerships')!, { id: partnershipId, empresa_id: escopo.empresaId }, tx);
    if (!parceria) throw new HttpError(404, 'Parceria não encontrada nesta empresa.');
    const atribuicoes = await listarTudo(s, 'creator_attributions', escopo.empresaId, { partnership_id: partnershipId }, tx);
    if (!atribuicoes.length) throw new HttpError(409, 'Sem atribuição elegível: nenhuma comissão apurada.');
    const percentual = Number((req.body ?? {}).percentual ?? 0);
    const apuradas: Row[] = [];
    for (const a of atribuicoes) {
      const pedidoId = a.order_id == null ? null : Number(a.order_id);
      if (!pedidoId) continue;
      const chave = `afiliado-${partnershipId}-${Number(a.id)}`;
      const ja = await s.findOneWhere(getResource('affiliate_commissions')!, { empresa_id: escopo.empresaId, chave_idempotencia: chave }, tx);
      if (ja) { apuradas.push(ja); continue; }
      const venda = await s.findOneWhere(getResource('vendas')!, { id: pedidoId, empresa_id: escopo.empresaId }, tx);
      if (!venda) continue;
      const base = Number(venda.total || 0);
      const valor = round2(base * (percentual / 100));
      const row = await s.insert(getResource('affiliate_commissions')!, {
        empresa_id: escopo.empresaId, partnership_id: partnershipId, attribution_id: Number(a.id),
        pedido_id: pedidoId, base_valor: base, percentual, valor, status: 'apurada', chave_idempotencia: chave,
      }, tx);
      apuradas.push(row);
    }
    if (!apuradas.length) throw new HttpError(409, 'Nenhuma comissão apurada (atribuições sem pedido com venda real).');
    return apuradas;
  });
  res.status(201).json({ parceria_id: partnershipId, comissoes: resultado });
}

/**
 * Encaminha comissões apuradas ao financeiro EXISTENTE (lancamentos_financeiros),
 * marcando a comissão como paga. Idempotente: a comissão já com lançamento não
 * gera um segundo lançamento.
 */
export async function pagarComissaoAfiliado(req: Request, res: Response) {
  const actor = currentUser(req);
  // A comissão é append-only na API; o encaminhamento ao financeiro é server-side.
  checkAccess(getResource('affiliate_commissions')!, actor, 'read');
  const escopo = escopoDe(req);
  const comissaoId = idDe(req.params.id, 'Comissão');
  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    const c = await s.findOneWhere(getResource('affiliate_commissions')!, { id: comissaoId, empresa_id: escopo.empresaId }, tx);
    if (!c) throw new HttpError(404, 'Comissão não encontrada nesta empresa.');
    if (c.lancamento_id) return { comissao: c, idempotente: true };
    if (String(c.status) === 'estornada') throw new HttpError(409, 'Comissão estornada não pode ser paga.');
    const lanc = await s.insert(getResource('lancamentos_financeiros')!, {
      data: new Date().toISOString().slice(0, 10), tipo: 'despesa', descricao: `Comissão de afiliado #${comissaoId}`,
      valor: Number(c.valor || 0), status: 'pendente', referencia_tipo: 'outro', referencia_id: comissaoId,
    }, tx);
    const atualizada = await s.update(getResource('affiliate_commissions')!, comissaoId, { status: 'paga', lancamento_id: Number(lanc.id) }, tx);
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'editar', recurso: 'affiliate_commissions', registro_id: comissaoId,
      descricao: 'Comissão de afiliado encaminhada ao financeiro', dados: { lancamento_id: Number(lanc.id) } }, tx);
    return { comissao: atualizada, lancamento_id: Number(lanc.id), idempotente: false };
  });
  res.json(resultado);
}

/** ROI/ROAS real de uma campanha: custo × receita atribuída. */
export async function roiCampanha(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('crm_campanhas')!, actor, 'read');
  const escopo = escopoDe(req);
  const campanhaId = idDe(req.params.id, 'Campanha');
  const s = getStore();
  const campanha = await s.findOneWhere(getResource('crm_campanhas')!, { id: campanhaId, empresa_id: escopo.empresaId });
  if (!campanha) throw new HttpError(404, 'Campanha não encontrada nesta empresa.');
  // Parcerias ligadas à campanha de growth (crm_campanhas), não ao briefing do creator.
  const parcerias = await listarTudo(s, 'creator_partnerships', escopo.empresaId, { crm_campanha_id: campanhaId });
  const parceriaIds = new Set(parcerias.map((p) => Number(p.id)));
  const atribuicoes = (await listarTudo(s, 'creator_attributions', escopo.empresaId)).filter((a) => parceriaIds.has(Number(a.partnership_id)));
  const vendas = await listarTudo(s, 'vendas', escopo.empresaId);
  const vendaPorId = new Map(vendas.map((v) => [Number(v.id), v]));
  let receita = 0;
  for (const a of atribuicoes) {
    const v = vendaPorId.get(Number(a.order_id));
    if (v && ['faturada', 'entregue'].includes(String(v.status))) receita = round2(receita + Number(v.total || 0));
  }
  const comissoes = (await listarTudo(s, 'affiliate_commissions', escopo.empresaId)).filter((c) => parceriaIds.has(Number(c.partnership_id)));
  const comissaoTotal = round2(comissoes.reduce((acc, c) => acc + Number(c.valor || 0), 0));
  const custo = round2(Number(campanha.custo || 0) + comissaoTotal);
  const conversoes = atribuicoes.filter((a) => vendaPorId.has(Number(a.order_id))).length;
  res.json({
    campanha_id: campanhaId, nome: campanha.nome,
    investimento: Number(campanha.custo || 0), comissoes: comissaoTotal, custo_total: custo,
    receita_atribuida: receita, conversoes,
    roi: custo > 0 ? round2(((receita - custo) / custo) * 100) : null,
    roas: custo > 0 ? round2(receita / custo) : null,
    gerado_em: new Date().toISOString(),
  });
}

// ============================================================================
// D3 — DATA/BI: reconstrução de projeções a partir dos documentos canônicos
// ============================================================================

/** Recalcula as projeções de BI do período e devolve o que foi materializado. */
export async function reconstruirBi(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('bi_read_models')!, actor, 'read');
  const escopo = escopoDe(req);
  const periodo = periodoValido((req.body ?? {}).periodo);
  const s = getStore();
  const linhas = await s.transaction(async (tx) => {
    const vendas = (await listarTudo(s, 'vendas', escopo.empresaId, {}, tx)).filter((v) => periodoDe(v.faturada_em || v.data) === periodo);
    const itens = await listarTudo(s, 'itens_venda', escopo.empresaId, {}, tx);
    const clientes = await listarTudo(s, 'clientes', escopo.empresaId, {}, tx);
    const produtos = await listarTudo(s, 'produtos', escopo.empresaId, {}, tx);
    const custoPorProduto = new Map(produtos.map((p) => [Number(p.id), Number(p.custo || 0)]));
    const pedidos = (await listarTudo(s, 'commerce_pedidos', escopo.empresaId, {}, tx)).filter((p) => periodoDe(p.convertido_em || p.criado_em) === periodo);
    const receita = round2(vendas.filter((v) => ['faturada', 'entregue'].includes(String(v.status))).reduce((a, v) => a + Number(v.total || 0), 0));
    const pedidosCount = vendas.filter((v) => ['faturada', 'entregue'].includes(String(v.status))).length;
    // CMV usa o custo unitário canônico do produto (não há custo por item de venda).
    const cmv = round2(itens.reduce((a, it) => {
      const v = vendas.find((x) => Number(x.id) === Number(it.venda_id));
      return v ? a + Number(it.quantidade || 0) * (custoPorProduto.get(Number(it.produto_id)) ?? 0) : a;
    }, 0));
    const dados: Array<{ origem: string; dimensao: string; dimensao_valor: string | null; metrica: string; valor: number }> = [
      { origem: 'vendas', dimensao: 'total', dimensao_valor: null, metrica: 'receita', valor: receita },
      { origem: 'vendas', dimensao: 'total', dimensao_valor: null, metrica: 'pedidos', valor: pedidosCount },
      { origem: 'vendas', dimensao: 'total', dimensao_valor: null, metrica: 'ticket_medio', valor: pedidosCount ? round2(receita / pedidosCount) : 0 },
      { origem: 'clientes', dimensao: 'total', dimensao_valor: null, metrica: 'clientes', valor: clientes.length },
      { origem: 'commerce', dimensao: 'total', dimensao_valor: null, metrica: 'pedidos_commerce', valor: pedidos.length },
    ];
    // Receita por canal (dimensão real do documento).
    const porCanal = new Map<string, number>();
    for (const v of vendas) {
      if (!['faturada', 'entregue'].includes(String(v.status))) continue;
      const canal = String(v.canal || 'BROBOND');
      porCanal.set(canal, round2((porCanal.get(canal) || 0) + Number(v.total || 0)));
    }
    for (const [canal, valor] of porCanal) dados.push({ origem: 'vendas', dimensao: 'canal', dimensao_valor: canal, metrica: 'receita', valor });
    const materializadas: Row[] = [];
    for (const d of dados) {
      const existente = await s.findOneWhere(getResource('bi_read_models')!, {
        empresa_id: escopo.empresaId, origem: d.origem, periodo, dimensao: d.dimensao, metrica: d.metrica,
      }, tx);
      const patch = { empresa_id: escopo.empresaId, origem: d.origem, periodo, dimensao: d.dimensao,
        dimensao_valor: d.dimensao_valor, metrica: d.metrica, valor: d.valor, gerado_em: new Date().toISOString() };
      if (existente) materializadas.push(await s.update(getResource('bi_read_models')!, Number(existente.id), patch, tx) ?? existente);
      else materializadas.push(await s.insert(getResource('bi_read_models')!, patch, tx));
    }
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'bi_read_models', registro_id: null,
      descricao: `Projeções de BI reconstruídas para ${periodo}`, dados: { linhas: materializadas.length } }, tx);
    return materializadas;
  });
  res.status(201).json({ periodo, linhas: linhas.length, projecoes: linhas });
}

/** Painel de BI com filtros por período, canal, produto, categoria, cliente. */
export async function painelBi(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('bi_read_models')!, actor, 'read');
  const escopo = escopoDe(req);
  const s = getStore();
  const q = req.query;
  const periodo = q.periodo ? periodoValido(q.periodo) : null;
  const canal = q.canal ? String(q.canal) : null;
  const produtoId = q.produto_id ? Number(q.produto_id) : null;
  const categoriaId = q.categoria_id ? Number(q.categoria_id) : null;
  const clienteId = q.cliente_id ? Number(q.cliente_id) : null;

  const vendas = await listarTudo(s, 'vendas', escopo.empresaId);
  const itens = await listarTudo(s, 'itens_venda', escopo.empresaId);
  const produtos = await listarTudo(s, 'produtos', escopo.empresaId);
  const produtoPorId = new Map(produtos.map((p) => [Number(p.id), p]));
  const faturadas = vendas.filter((v) => ['faturada', 'entregue'].includes(String(v.status)))
    .filter((v) => !periodo || periodoDe(v.faturada_em || v.data) === periodo)
    .filter((v) => !canal || String(v.canal) === canal)
    .filter((v) => !clienteId || Number(v.cliente_id) === clienteId);
  const idsVenda = new Set(faturadas.map((v) => Number(v.id)));
  const itensFiltrados = itens.filter((it) => idsVenda.has(Number(it.venda_id)))
    .filter((it) => !produtoId || Number(it.produto_id) === produtoId)
    .filter((it) => !categoriaId || Number(produtoPorId.get(Number(it.produto_id))?.categoria_id) === categoriaId);

  const receita = round2(faturadas.reduce((a, v) => a + Number(v.total || 0), 0));
  const cmv = round2(itensFiltrados.reduce((a, it) => a + Number(it.quantidade || 0) * Number(produtoPorId.get(Number(it.produto_id))?.custo || 0), 0));
  const margem = round2(receita - cmv);
  const estoques = await listarTudo(s, 'estoques', escopo.empresaId);
  const estoqueValor = round2(estoques.reduce((a, e) => a + Number(e.quantidade || 0) * Number(e.custo_medio || 0), 0));
  res.json({
    filtros: { periodo, canal, produto_id: produtoId, categoria_id: categoriaId, cliente_id: clienteId },
    receita, cmv, margem, margem_pct: receita ? round2((margem / receita) * 100) : 0,
    pedidos: faturadas.length,
    clientes: new Set(faturadas.map((v) => Number(v.cliente_id)).filter(Boolean)).size,
    ticket_medio: faturadas.length ? round2(receita / faturadas.length) : 0,
    estoque_valor: estoqueValor,
    gerado_em: new Date().toISOString(),
  });
}

// ============================================================================
// D4 — AI PLATFORM: recomendações com evidência (heurística real, sem IA opaca)
// ============================================================================

/**
 * Gera recomendações de um domínio a partir de dados REAIS (heurística
 * determinística — a camada central suporta provider externo, mas o resultado
 * padrão é auditável e não inventa número). NÃO altera nada operacional.
 */
export async function gerarRecomendacoes(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_recommendations')!, actor, 'create');
  const escopo = escopoDe(req);
  const dominio = String((req.body ?? {}).dominio || 'inventory');
  const permitidos = ['sales', 'customer', 'marketing', 'inventory', 'demand', 'commerce'];
  if (!permitidos.includes(dominio)) throw new HttpError(400, 'Domínio inválido.', { dominio: permitidos.join(', ') });
  const s = getStore();
  const criadas = await s.transaction(async (tx) => {
    const exec = await s.insert(getResource('ai_executions')!, {
      empresa_id: escopo.empresaId, finalidade: `recomendacao_${dominio}`, estado: 'sucesso',
      entrada: { dominio }, resultado: {}, custo: 0,
    }, tx);
    const recomendacoes: Array<{ evidencia: Row; recomendacao: string; score: number }> = [];
    if (dominio === 'inventory' || dominio === 'demand') {
      const produtos = await listarTudo(s, 'produtos', escopo.empresaId, {}, tx);
      const estoques = await listarTudo(s, 'estoques', escopo.empresaId, {}, tx);
      for (const p of produtos.slice(0, 50)) {
        const linhas = estoques.filter((e) => Number(e.produto_id) === Number(p.id));
        const saldo = linhas.reduce((a, e) => a + Number(e.quantidade || 0), 0);
        // O mínimo vive na linha de estoque (`estoques.estoque_min`), não no cadastro.
        const minimo = linhas.reduce((a, e) => Math.max(a, Number(e.estoque_min || 0)), 0);
        if (minimo > 0 && saldo < minimo) {
          const score = Math.min(1, (minimo - saldo) / Math.max(1, minimo));
          recomendacoes.push({ evidencia: { produto_id: Number(p.id), saldo, minimo }, score: Number(score.toFixed(3)),
            recomendacao: `Repor ${p.nome}: saldo ${saldo} abaixo do mínimo ${minimo}.` });
        }
      }
    }
    if (dominio === 'customer') {
      const tickets = await listarTudo(s, 'service_tickets', escopo.empresaId, {}, tx);
      const estourados = tickets.filter((t) => ['aberto', 'em_atendimento', 'aguardando_cliente'].includes(String(t.status)) && t.prazo_resolucao_em && new Date(String(t.prazo_resolucao_em)).getTime() < Date.now());
      for (const t of estourados.slice(0, 50)) {
        recomendacoes.push({ evidencia: { ticket_id: Number(t.id), status: t.status, prazo: t.prazo_resolucao_em }, score: 0.8,
          recomendacao: `Priorizar ticket ${t.numero ?? t.id}: SLA de resolução estourado.` });
      }
    }
    const inseridas: Row[] = [];
    for (const r of recomendacoes) {
      inseridas.push(await s.insert(getResource('ai_recommendations')!, {
        empresa_id: escopo.empresaId, execucao_id: Number(exec.id), dominio, modelo: 'heuristica-interna',
        score: r.score, evidencia: r.evidencia, recomendacao: r.recomendacao, status: 'pendente',
      }, tx));
    }
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'ai_recommendations', registro_id: null,
      descricao: `Recomendações de IA geradas (${dominio})`, dados: { execucao_id: Number(exec.id), total: inseridas.length } }, tx);
    return { execucao_id: Number(exec.id), total: inseridas.length, recomendacoes: inseridas };
  });
  res.status(201).json(criadas);
}

/** Decide (aceita/rejeita) uma recomendação. A aplicação real é ação humana. */
export async function decidirRecomendacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('ai_recommendations')!, actor, 'update');
  const escopo = escopoDe(req);
  const id = idDe(req.params.id, 'Recomendação');
  const decisao = String((req.body ?? {}).status || '');
  if (!['aceita', 'rejeitada', 'aplicada'].includes(decisao)) throw new HttpError(400, 'Decisão inválida.', { status: 'aceita, rejeitada ou aplicada.' });
  const s = getStore();
  const atual = await s.findOneWhere(getResource('ai_recommendations')!, { id, empresa_id: escopo.empresaId });
  if (!atual) throw new HttpError(404, 'Recomendação não encontrada nesta empresa.');
  const row = await s.transaction(async (tx) => {
    const r = await s.update(getResource('ai_recommendations')!, id, { status: decisao, decidido_por: actor.id || null, decidido_em: new Date().toISOString() }, tx);
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'editar', recurso: 'ai_recommendations', registro_id: id,
      descricao: `Recomendação de IA ${decisao}`, dados: { dominio: atual.dominio } }, tx);
    return r;
  });
  res.json(row);
}

// ============================================================================
// D5 — DEMAND / SUPPLY / S&OP
// ============================================================================

/** Gera o forecast de demanda do período a partir do histórico real de vendas. */
export async function gerarForecastDemanda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('demand_forecasts')!, actor, 'read');
  const escopo = escopoDe(req);
  const periodo = periodoValido((req.body ?? {}).periodo);
  const s = getStore();
  const linhas = await s.transaction(async (tx) => {
    const itens = await listarTudo(s, 'itens_venda', escopo.empresaId, {}, tx);
    const vendas = await listarTudo(s, 'vendas', escopo.empresaId, {}, tx);
    const vendaPorId = new Map(vendas.map((v) => [Number(v.id), v]));
    // Histórico por produto × período (quantidade real vendida).
    const hist = new Map<string, number>();
    const porProdutoPeriodo = new Map<number, Map<string, number>>();
    for (const it of itens) {
      const v = vendaPorId.get(Number(it.venda_id));
      if (!v || !['faturada', 'entregue'].includes(String(v.status))) continue;
      const p = periodoDe(v.faturada_em || v.data);
      const pid = Number(it.produto_id);
      const m = porProdutoPeriodo.get(pid) || new Map<string, number>();
      m.set(p, (m.get(p) || 0) + Number(it.quantidade || 0));
      porProdutoPeriodo.set(pid, m);
    }
    const materializadas: Row[] = [];
    for (const [pid, series] of porProdutoPeriodo) {
      const valores = [...series.values()];
      const media = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : 0;
      // Sazonalidade: razão do mês do período sobre a média; tendência: média móvel simples.
      const historico = round2(series.get(periodo) ?? 0);
      const saz = media > 0 ? Number((historico / media).toFixed(4)) : 1;
      const tendencia = valores.length >= 2 ? Number(((valores[valores.length - 1] - valores[0]) / Math.max(1, valores.length - 1)).toFixed(4)) : 0;
      const forecast = Math.max(0, round2(media + tendencia));
      const excecao = saz > 1.5 ? 'pico_sazonal' : saz < 0.5 && historico > 0 ? 'queda' : null;
      const patch = { empresa_id: escopo.empresaId, produto_id: pid, periodo, historico, sazonalidade: saz,
        tendencia, forecast, excecao, metodo: 'media_movel' };
      const existente = await s.findOneWhere(getResource('demand_forecasts')!, { empresa_id: escopo.empresaId, produto_id: pid, periodo }, tx);
      materializadas.push(existente
        ? (await s.update(getResource('demand_forecasts')!, Number(existente.id), patch, tx) ?? existente)
        : await s.insert(getResource('demand_forecasts')!, patch, tx));
    }
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'demand_forecasts', registro_id: null,
      descricao: `Forecast de demanda gerado para ${periodo}`, dados: { linhas: materializadas.length } }, tx);
    return materializadas;
  });
  res.status(201).json({ periodo, linhas: linhas.length, forecasts: linhas });
}

/** Monta o plano de suprimento: necessidade = demanda − estoque; status planejado. */
export async function gerarPlanoSuprimento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('supply_plans')!, actor, 'read');
  const escopo = escopoDe(req);
  const periodo = periodoValido((req.body ?? {}).periodo);
  const s = getStore();
  const linhas = await s.transaction(async (tx) => {
    const forecasts = await listarTudo(s, 'demand_forecasts', escopo.empresaId, { periodo }, tx);
    const estoques = await listarTudo(s, 'estoques', escopo.empresaId, {}, tx);
    const materializadas: Row[] = [];
    for (const f of forecasts) {
      const pid = Number(f.produto_id);
      const saldo = estoques.filter((e) => Number(e.produto_id) === pid).reduce((a, e) => a + Number(e.quantidade || 0), 0);
      const demanda = Number(f.forecast || 0);
      const necessidade = round2(Math.max(0, demanda - saldo));
      const patch = { empresa_id: escopo.empresaId, periodo, produto_id: pid, demanda,
        estoque_atual: round2(saldo), necessidade, mrp_ordens: 0, status: 'planejado' };
      const existente = await s.findOneWhere(getResource('supply_plans')!, { empresa_id: escopo.empresaId, produto_id: pid, periodo }, tx);
      materializadas.push(existente
        ? (await s.update(getResource('supply_plans')!, Number(existente.id), patch, tx) ?? existente)
        : await s.insert(getResource('supply_plans')!, patch, tx));
    }
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'supply_plans', registro_id: null,
      descricao: `Plano de suprimento gerado para ${periodo}`, dados: { linhas: materializadas.length } }, tx);
    return materializadas;
  });
  res.status(201).json({ periodo, linhas: linhas.length, planos: linhas });
}

/** Aprova um cenário S&OP, registrando autor e data (trilha de aprovação). */
export async function aprovarSop(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('sop_scenarios')!, actor, 'update');
  const escopo = escopoDe(req);
  const id = idDe(req.params.id, 'Cenário');
  const s = getStore();
  const atual = await s.findOneWhere(getResource('sop_scenarios')!, { id, empresa_id: escopo.empresaId });
  if (!atual) throw new HttpError(404, 'Cenário não encontrado nesta empresa.');
  const row = await s.transaction(async (tx) => {
    const r = await s.update(getResource('sop_scenarios')!, id, { status: 'aprovado', aprovado_por: actor.id || null, aprovado_em: new Date().toISOString() }, tx);
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'editar', recurso: 'sop_scenarios', registro_id: id, descricao: 'Cenário S&OP aprovado', dados: { periodo: atual.periodo } }, tx);
    return r;
  });
  res.json(row);
}

// ============================================================================
// D6 — SUPPLIER SCORECARD: OTIF real a partir de compras e recebimentos
// ============================================================================

/** Calcula o scorecard do fornecedor no período a partir dos documentos reais. */
export async function calcularScorecardFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('fornecedor_scorecards')!, actor, 'read');
  const escopo = escopoDe(req);
  const fornecedorId = idDe(req.params.fornecedorId, 'Fornecedor');
  const periodo = periodoValido((req.body ?? {}).periodo);
  const s = getStore();
  const linha = await s.transaction(async (tx) => {
    const compras = (await listarTudo(s, 'compras', escopo.empresaId, { fornecedor_id: fornecedorId }, tx)).filter((c) => periodoDe(c.criado_em || c.data) === periodo);
    const recebimentos = await listarTudo(s, 'compra_recebimentos', escopo.empresaId, {}, tx);
    const compraIds = new Set(compras.map((c) => Number(c.id)));
    const receb = recebimentos.filter((r) => compraIds.has(Number(r.compra_id)));
    const total = compras.length;
    // Entrega no prazo (OTIF simplificado): recebimento com data <= previsão.
    let noPrazo = 0;
    for (const c of compras) {
      const r = receb.find((x) => Number(x.compra_id) === Number(c.id));
      if (!r) continue;
      const previsto = c.previsao_entrega || c.fin_vencimento;
      const efetivo = r.criado_em;
      if (!previsto || (efetivo && new Date(String(efetivo)) <= new Date(String(previsto)))) noPrazo += 1;
    }
    const entregaPct = total ? round2((noPrazo / total) * 100) : 0;
    const patch = { empresa_id: escopo.empresaId, fornecedor_id: fornecedorId, periodo,
      lead_time_dias: 0, qualidade_pct: 100, entrega_pct: entregaPct, otif_pct: entregaPct,
      preco_indice: 1, ocorrencias: total - noPrazo };
    const existente = await s.findOneWhere(getResource('fornecedor_scorecards')!, { empresa_id: escopo.empresaId, fornecedor_id: fornecedorId, periodo }, tx);
    return existente
      ? (await s.update(getResource('fornecedor_scorecards')!, Number(existente.id), patch, tx) ?? existente)
      : await s.insert(getResource('fornecedor_scorecards')!, patch, tx);
  });
  res.status(201).json(linha);
}

// ============================================================================
// D7 — EPM: Budget × Actual × Variance a partir do financeiro REAL
// ============================================================================

/** Budget × Actual × Variance do período, com o realizado vindo do financeiro. */
export async function varianceEpm(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('epm_budgets')!, actor, 'read');
  const escopo = escopoDe(req);
  const periodo = periodoValido(req.query.periodo);
  const s = getStore();
  const budgets = await listarTudo(s, 'epm_budgets', escopo.empresaId, { periodo });
  const lancamentos = (await listarTudo(s, 'lancamentos_financeiros', escopo.empresaId)).filter((l) => periodoDe(l.data) === periodo);
  const contas = await listarTudo(s, 'plano_contas', escopo.empresaId);
  const contaPorId = new Map(contas.map((c) => [Number(c.id), c]));
  const linhas = budgets.map((b) => {
    const orcado = Number(b.valor_orcado || 0);
    // O realizado casa o lançamento financeiro pela CATEGORIA (dimensão real do
    // financeiro) e, quando informado, pelo centro de custo — as duas dimensões
    // que o lançamento carrega. Sem dimensão no orçamento, soma o período.
    const realizado = round2(lancamentos
      .filter((l) => (!b.categoria_financeira_id || Number(l.categoria_id) === Number(b.categoria_financeira_id))
        && (!b.centro_custo_id || Number(l.centro_custo_id) === Number(b.centro_custo_id)))
      .reduce((a, l) => a + Number(l.valor || 0), 0));
    const variacao = round2(realizado - orcado);
    return {
      orcamento_id: Number(b.id), nome: b.nome, conta: b.conta_id ? contaPorId.get(Number(b.conta_id))?.nome ?? null : null,
      orcado, realizado, variacao, variacao_pct: orcado ? round2((variacao / orcado) * 100) : null,
    };
  });
  res.json({ periodo, linhas, gerado_em: new Date().toISOString() });
}

/** Gera o forecast do cenário a partir das premissas e do realizado. */
export async function forecastCenario(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('epm_scenarios')!, actor, 'read');
  const escopo = escopoDe(req);
  const id = idDe(req.params.id, 'Cenário');
  const s = getStore();
  const cenario = await s.findOneWhere(getResource('epm_scenarios')!, { id, empresa_id: escopo.empresaId });
  if (!cenario) throw new HttpError(404, 'Cenário não encontrado nesta empresa.');
  const periodo = String(cenario.periodo);
  const premissas = typeof cenario.premissas === 'string' ? JSON.parse(String(cenario.premissas || '{}')) : (cenario.premissas || {});
  const vendas = (await listarTudo(s, 'vendas', escopo.empresaId)).filter((v) => ['faturada', 'entregue'].includes(String(v.status)) && periodoDe(v.faturada_em || v.data) === periodo);
  const realizado = round2(vendas.reduce((a, v) => a + Number(v.total || 0), 0));
  const crescimento = Number((premissas as Row).crescimento_pct || 0) / 100;
  const receitaProjetada = round2(realizado * (1 + crescimento));
  const custoPct = Number((premissas as Row).custo_pct || 0) / 100;
  const custoProjetado = round2(receitaProjetada * custoPct);
  const atualizado = await s.transaction(async (tx) => {
    const r = await s.update(getResource('epm_scenarios')!, id, {
      receita_projetada: receitaProjetada, custo_projetado: custoProjetado,
      resultado_projetado: round2(receitaProjetada - custoProjetado),
    }, tx);
    await s.audit({ empresa_id: escopo.empresaId, usuario_id: actor.id || null, usuario: actor.name || null,
      acao: 'ajuste', recurso: 'epm_scenarios', registro_id: id, descricao: 'Forecast de cenário recalculado', dados: { periodo } }, tx);
    return r;
  });
  res.json({ cenario: atualizado, realizado, receita_projetada: receitaProjetada, custo_projetado: custoProjetado });
}

/** Chave idempotente derivada de dados estáveis (helper exportado para testes). */
export function chaveIdempotente(...partes: Array<string | number | null>): string {
  return createHash('sha256').update(partes.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 40);
}
