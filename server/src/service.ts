// ============================================================================
// ONDA 4 / D1 — CUSTOMER PLATFORM: ATENDIMENTO (SERVICE) e CUSTOMER 360.
//
// O atendimento NÃO cria um segundo OMS, um segundo ledger ou um segundo
// customer master. Ele:
//   • lê o cliente do cadastro existente (`clientes`);
//   • referencia pedido/venda, devolução e pagamento REAIS por id;
//   • deriva prazos de SLA da política vigente no momento da abertura;
//   • grava a trilha em `service_ticket_interacoes` (append-only, auditada).
//
// O Customer 360 é uma LEITURA derivada (nunca uma tabela): receita, ticket
// médio, frequência, recência, LTV, produtos, devoluções, pagamentos, tickets,
// interações e canais saem de consultas aos documentos canônicos da empresa.
// ============================================================================
import type { Request, Response } from 'express';
import { getStore } from './services';
import { getResource } from './resources';
import { checkAccess } from './services';
import { currentUser } from './auth';
import type { AuthUser } from './auth';
import { escopoDoAtor, type EscopoEmpresa } from './empresa';
import { domainLock } from './domainLock';
import { HttpError } from './errors';
import { round2 } from './utils';
import type { Row, Tx } from './store';

const DIAS_MS = 86_400_000;

function escopoDe(req: Request): EscopoEmpresa {
  return escopoDoAtor(currentUser(req) as unknown as AuthUser);
}

/** Data/hora ISO do prazo: agora + N horas. */
function prazoEm(horas: number, base = Date.now()): string {
  return new Date(base + horas * 3_600_000).toISOString();
}

/**
 * Abre um ticket: resolve o SLA da prioridade, gera o número sequencial por
 * empresa (sob lock de domínio) e grava a interação de abertura — tudo na mesma
 * transação. O número é a chave de idempotência visual do atendimento.
 */
export async function abrirTicket(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('service_tickets')!;
  checkAccess(r, actor, 'create');
  const escopo = escopoDe(req);
  const body = (req.body ?? {}) as Row;
  const prioridade = String(body.prioridade || 'media');
  if (!['baixa', 'media', 'alta', 'urgente'].includes(prioridade)) throw new HttpError(400, 'Prioridade inválida.', { prioridade: 'Use baixa, media, alta ou urgente.' });
  if (!body.cliente_id) throw new HttpError(400, 'Informe o cliente.', { cliente_id: 'Obrigatório.' });
  if (!String(body.assunto || '').trim()) throw new HttpError(400, 'Informe o assunto.', { assunto: 'Obrigatório.' });

  const s = getStore();
  const criado = await domainLock(escopo.empresaId, 'service_ticket_numero', async (tx) => {
    // Cliente precisa ser da empresa ativa (isolamento).
    const cliente = await s.findOneWhere(getResource('clientes')!, { id: Number(body.cliente_id), empresa_id: escopo.empresaId }, tx);
    if (!cliente) throw new HttpError(404, 'Cliente não encontrado nesta empresa.');

    // SLA vigente da prioridade (a política ativa mais recente).
    const politicas = await s.list(getResource('service_sla_politicas')!, { page: 1, pageSize: 1, filter: { empresa_id: escopo.empresaId, prioridade, ativo: true } }, tx);
    const politica = politicas.rows[0];
    const agora = Date.now();
    const numero = await proximoNumero(escopo.empresaId, tx);
    const data: Row = {
      empresa_id: escopo.empresaId,
      numero,
      cliente_id: Number(body.cliente_id),
      categoria_id: body.categoria_id ? Number(body.categoria_id) : null,
      prioridade,
      status: 'aberto',
      assunto: String(body.assunto).trim().slice(0, 160),
      descricao: body.descricao ? String(body.descricao).slice(0, 4000) : null,
      responsavel_id: body.responsavel_id ? Number(body.responsavel_id) : null,
      canal: String(body.canal || 'interno'),
      venda_id: body.venda_id ? Number(body.venda_id) : null,
      devolucao_id: body.devolucao_id ? Number(body.devolucao_id) : null,
      commerce_pedido_id: body.commerce_pedido_id ? Number(body.commerce_pedido_id) : null,
      payment_intent_id: body.payment_intent_id ? Number(body.payment_intent_id) : null,
      prazo_resposta_em: politica ? prazoEm(Number(politica.resposta_horas), agora) : null,
      prazo_resolucao_em: politica ? prazoEm(Number(politica.resolucao_horas), agora) : null,
      criado_por: actor.id || null,
    };
    const row = await s.insert(r, data, tx);
    await s.insert(getResource('service_ticket_interacoes')!, {
      empresa_id: escopo.empresaId, ticket_id: Number(row.id), tipo: 'status',
      autor_id: actor.id || null, mensagem: 'Ticket aberto.', status_novo: 'aberto', publico: false,
    }, tx);
    return row;
  });
  const full = await s.get(r, Number(criado.id));
  res.status(201).json(full ?? criado);
}

/** Próximo número sequencial do ticket por empresa (TKT-000001). */
async function proximoNumero(empresaId: number, tx: Tx): Promise<string> {
  const s = getStore();
  const todos = await s.list(getResource('service_tickets')!, { page: 1, pageSize: 1, sort: 'id', dir: 'desc', filter: { empresa_id: empresaId } }, tx);
  const ultimo = Number(todos.rows[0]?.id || 0);
  return `TKT-${String(ultimo + 1).padStart(6, '0')}`;
}

/**
 * Transição de situação do ticket: grava a interação de histórico e atualiza os
 * marcos (primeira resposta / resolução / fechamento). Idempotente por natureza
 * (só transiciona se o estado mudou).
 */
export async function transicionarTicket(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('service_tickets')!;
  checkAccess(r, actor, 'update');
  const escopo = escopoDe(req);
  const id = Number(req.params.id);
  const novo = String((req.body ?? {}).status || '');
  const permitidos = ['aberto', 'em_atendimento', 'aguardando_cliente', 'resolvido', 'fechado', 'cancelado'];
  if (!permitidos.includes(novo)) throw new HttpError(400, 'Situação inválida.', { status: `Use uma de: ${permitidos.join(', ')}.` });

  const s = getStore();
  const atualizado = await s.transaction(async (tx) => {
    const atual = await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }, tx);
    if (!atual) throw new HttpError(404, 'Ticket não encontrado nesta empresa.');
    if (String(atual.status) === novo) return atual; // nada a fazer (idempotente)
    const patch: Row = { status: novo };
    const agora = new Date().toISOString();
    if (novo === 'em_atendimento' && !atual.primeira_resposta_em) patch.primeira_resposta_em = agora;
    if (novo === 'resolvido') {
      patch.resolvido_em = agora;
      if (req.body?.resolucao) patch.resolucao = String(req.body.resolucao).slice(0, 4000);
    }
    if (novo === 'fechado') {
      patch.fechado_em = agora;
      if (!atual.resolvido_em) patch.resolvido_em = agora;
    }
    const row = await s.update(r, id, patch, tx);
    await s.insert(getResource('service_ticket_interacoes')!, {
      empresa_id: escopo.empresaId, ticket_id: id, tipo: novo === 'resolvido' ? 'resolucao' : 'status',
      autor_id: actor.id || null, mensagem: req.body?.mensagem ? String(req.body.mensagem).slice(0, 4000) : null,
      status_anterior: String(atual.status), status_novo: novo, publico: Boolean(req.body?.publico),
    }, tx);
    return row;
  });
  res.json(atualizado);
}

/** Nota/resposta em um ticket. Grava a interação append-only e marca a 1ª resposta. */
export async function interagirTicket(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('service_tickets')!;
  checkAccess(r, actor, 'update');
  const escopo = escopoDe(req);
  const id = Number(req.params.id);
  const tipo = String((req.body ?? {}).tipo || 'nota');
  if (!['nota', 'resposta'].includes(tipo)) throw new HttpError(400, 'Tipo inválido.', { tipo: 'Use nota ou resposta.' });
  const mensagem = String((req.body ?? {}).mensagem || '').trim();
  if (!mensagem) throw new HttpError(400, 'Informe a mensagem.', { mensagem: 'Obrigatório.' });

  const s = getStore();
  const interacao = await s.transaction(async (tx) => {
    const atual = await s.findOneWhere(r, { id, empresa_id: escopo.empresaId }, tx);
    if (!atual) throw new HttpError(404, 'Ticket não encontrado nesta empresa.');
    const row = await s.insert(getResource('service_ticket_interacoes')!, {
      empresa_id: escopo.empresaId, ticket_id: id, tipo, autor_id: actor.id || null,
      mensagem: mensagem.slice(0, 4000), publico: tipo === 'resposta',
    }, tx);
    // Primeira resposta ao cliente carimba o marco de SLA.
    if (tipo === 'resposta' && !atual.primeira_resposta_em) {
      await s.update(r, id, { primeira_resposta_em: new Date().toISOString() }, tx);
    }
    return row;
  });
  res.status(201).json(interacao);
}

/** Painel do atendimento: contagens reais por situação, SLA estourado e tempo médio. */
export async function painelAtendimento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('service_tickets')!, actor, 'read');
  const escopo = escopoDe(req);
  const s = getStore();
  const tickets = await s.list(getResource('service_tickets')!, { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } });
  const agora = Date.now();
  const abertosStatus = ['aberto', 'em_atendimento', 'aguardando_cliente'];
  const porStatus: Record<string, number> = {};
  let estourados = 0;
  let somaResolucaoMs = 0;
  let resolvidos = 0;
  let foraDoSlaResposta = 0;
  for (const t of tickets.rows) {
    const st = String(t.status);
    porStatus[st] = (porStatus[st] || 0) + 1;
    if (abertosStatus.includes(st) && t.prazo_resolucao_em && new Date(String(t.prazo_resolucao_em)).getTime() < agora) estourados += 1;
    if (!t.primeira_resposta_em && t.prazo_resposta_em && new Date(String(t.prazo_resposta_em)).getTime() < agora) foraDoSlaResposta += 1;
    if (t.resolvido_em && t.criado_em) {
      somaResolucaoMs += new Date(String(t.resolvido_em)).getTime() - new Date(String(t.criado_em)).getTime();
      resolvidos += 1;
    }
  }
  res.json({
    total: tickets.total,
    por_status: porStatus,
    abertos: abertosStatus.reduce((acc, st) => acc + (porStatus[st] || 0), 0),
    estourados,
    fora_do_sla_resposta: foraDoSlaResposta,
    tempo_medio_resolucao_horas: resolvidos ? round2(somaResolucaoMs / resolvidos / 3_600_000) : 0,
    gerado_em: new Date().toISOString(),
  });
}

// ============================================================================
// CUSTOMER 360 — leitura derivada (nenhuma tabela nova, nenhum número fictício)
// ============================================================================

type MetricasCliente = {
  cliente_id: number;
  receita_total: number;
  pedidos: number;
  ticket_medio: number;
  primeira_compra: string | null;
  ultima_compra: string | null;
  recencia_dias: number | null;
  frequencia: number;
  ltv: number;
  devolucoes: number;
  tickets: number;
};

/** Receita por cliente a partir das vendas faturadas/entregues (canônico). */
async function metricasPorCliente(empresaId: number): Promise<Map<number, MetricasCliente>> {
  const s = getStore();
  const vendas = await s.list(getResource('vendas')!, { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const mapa = new Map<number, MetricasCliente>();
  const agora = Date.now();
  for (const v of vendas.rows) {
    const cid = v.cliente_id == null ? null : Number(v.cliente_id);
    if (!cid) continue;
    const status = String(v.status);
    const ehFaturada = ['faturada', 'entregue'].includes(status);
    const data = String(v.faturada_em || v.data || '');
    let m = mapa.get(cid);
    if (!m) {
      m = { cliente_id: cid, receita_total: 0, pedidos: 0, ticket_medio: 0, primeira_compra: null, ultima_compra: null, recencia_dias: null, frequencia: 0, ltv: 0, devolucoes: 0, tickets: 0 };
      mapa.set(cid, m);
    }
    if (ehFaturada) {
      m.receita_total = round2(m.receita_total + Number(v.total || 0));
      m.pedidos += 1;
      if (data) {
        if (!m.primeira_compra || data < m.primeira_compra) m.primeira_compra = data;
        if (!m.ultima_compra || data > m.ultima_compra) m.ultima_compra = data;
      }
    }
  }
  // Devoluções por cliente (contagem real).
  const devolucoes = await s.list(getResource('devolucoes')!, { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  for (const d of devolucoes.rows) {
    const cid = d.cliente_id == null ? null : Number(d.cliente_id);
    if (!cid) continue;
    const m = mapa.get(cid) || { cliente_id: cid, receita_total: 0, pedidos: 0, ticket_medio: 0, primeira_compra: null, ultima_compra: null, recencia_dias: null, frequencia: 0, ltv: 0, devolucoes: 0, tickets: 0 };
    m.devolucoes += 1;
    mapa.set(cid, m);
  }
  // Tickets por cliente.
  const tickets = await s.list(getResource('service_tickets')!, { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  for (const t of tickets.rows) {
    const cid = t.cliente_id == null ? null : Number(t.cliente_id);
    if (!cid) continue;
    const m = mapa.get(cid) || { cliente_id: cid, receita_total: 0, pedidos: 0, ticket_medio: 0, primeira_compra: null, ultima_compra: null, recencia_dias: null, frequencia: 0, ltv: 0, devolucoes: 0, tickets: 0 };
    m.tickets += 1;
    mapa.set(cid, m);
  }
  for (const m of mapa.values()) {
    m.frequencia = m.pedidos;
    m.ticket_medio = m.pedidos ? round2(m.receita_total / m.pedidos) : 0;
    m.ltv = m.receita_total;
    m.recencia_dias = m.ultima_compra ? Math.floor((agora - new Date(m.ultima_compra).getTime()) / DIAS_MS) : null;
  }
  return mapa;
}

/**
 * GET /api/customer360/:clienteId — visão 360 do cliente com dados REAIS.
 * Receita, pedidos, ticket médio, frequência, recência, LTV, produtos,
 * categorias, devoluções, pagamentos, tickets, interações e canais.
 */
export async function customer360(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('clientes')!, actor, 'read');
  const escopo = escopoDe(req);
  const clienteId = Number(req.params.id);
  const s = getStore();
  const cliente = await s.findOneWhere(getResource('clientes')!, { id: clienteId, empresa_id: escopo.empresaId });
  if (!cliente) throw new HttpError(404, 'Cliente não encontrado nesta empresa.');

  const metricas = (await metricasPorCliente(escopo.empresaId)).get(clienteId);

  // Produtos e categorias comprados (por itens das vendas do cliente).
  const vendasCliente = await s.list(getResource('vendas')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId, cliente_id: clienteId } });
  const vendaIds = new Set(vendasCliente.rows.map((v) => Number(v.id)));
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 40000, filter: { empresa_id: escopo.empresaId } });
  const porProduto = new Map<number, { produto_id: number; quantidade: number; receita: number }>();
  for (const it of itens.rows) {
    if (!vendaIds.has(Number(it.venda_id))) continue;
    const pid = Number(it.produto_id);
    const acc = porProduto.get(pid) || { produto_id: pid, quantidade: 0, receita: 0 };
    acc.quantidade += Number(it.quantidade || 0);
    acc.receita = round2(acc.receita + Number(it.subtotal || 0));
    porProduto.set(pid, acc);
  }
  const produtos = [...porProduto.values()].sort((a, b) => b.receita - a.receita).slice(0, 20);
  // Rótulos reais dos produtos.
  for (const p of produtos) {
    const prod = await s.findOneWhere(getResource('produtos')!, { id: p.produto_id, empresa_id: escopo.empresaId });
    (p as Row).nome = prod ? prod.nome : `#${p.produto_id}`;
    (p as Row).categoria = prod?.categoria_id__label ?? null;
  }

  const devolucoes = await s.list(getResource('devolucoes')!, { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, cliente_id: clienteId } });
  const tickets = await s.list(getResource('service_tickets')!, { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, cliente_id: clienteId } });
  const interacoes = await s.list(getResource('service_ticket_interacoes')!, { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId } });
  const ticketIds = new Set(tickets.rows.map((t) => Number(t.id)));
  const interacoesCliente = interacoes.rows.filter((i) => ticketIds.has(Number(i.ticket_id))).slice(0, 50);

  // Canais: origem/canal do CRM + canal do ticket (dados reais declarados).
  const canais = new Set<string>();
  for (const t of tickets.rows) if (t.canal) canais.add(String(t.canal));
  const leads = await s.list(getResource('crm_leads')!, { page: 1, pageSize: 200, filter: { empresa_id: escopo.empresaId, cliente_id: clienteId } });
  for (const l of leads.rows) if (l.canal) canais.add(String(l.canal));

  res.json({
    cliente: { id: clienteId, nome: cliente.nome, email: cliente.email ?? null, telefone: cliente.telefone ?? null, tipo: cliente.tipo ?? null },
    metricas: metricas ?? { cliente_id: clienteId, receita_total: 0, pedidos: 0, ticket_medio: 0, primeira_compra: null, ultima_compra: null, recencia_dias: null, frequencia: 0, ltv: 0, devolucoes: 0, tickets: 0 },
    produtos,
    devolucoes: devolucoes.rows.map((d) => ({ id: Number(d.id), numero: d.numero ?? null, status: d.status, motivo: d.motivo, criado_em: d.criado_em })),
    tickets: tickets.rows.map((t) => ({ id: Number(t.id), numero: t.numero ?? null, assunto: t.assunto, status: t.status, prioridade: t.prioridade, canal: t.canal, criado_em: t.criado_em, resolvido_em: t.resolvido_em ?? null })),
    interacoes: interacoesCliente.map((i) => ({ id: Number(i.id), ticket_id: Number(i.ticket_id), tipo: i.tipo, mensagem: i.mensagem ?? null, criado_em: i.criado_em })),
    canais: [...canais],
    gerado_em: new Date().toISOString(),
  });
}

// ============================================================================
// SEGMENTAÇÃO / CDP — avaliação de regras contra dados REAIS.
// ============================================================================

type RegraSegmento = {
  recencia_dias_max?: number;
  recencia_dias_min?: number;
  frequencia_min?: number;
  valor_min?: number;
  canal?: string;
  incluir_abandono?: boolean;
  consentimento_marketing?: boolean;
};

/** Avalia um segmento: devolve a contagem e a lista de clientes que casam. */
export async function avaliarSegmento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('customer_segments')!, actor, 'read');
  const escopo = escopoDe(req);
  const segmentoId = Number(req.params.id);
  const s = getStore();
  const segmento = await s.findOneWhere(getResource('customer_segments')!, { id: segmentoId, empresa_id: escopo.empresaId });
  if (!segmento) throw new HttpError(404, 'Segmento não encontrado nesta empresa.');
  const regra: RegraSegmento = typeof segmento.regra === 'string' ? JSON.parse(String(segmento.regra || '{}')) : (segmento.regra || {});

  const metricas = await metricasPorCliente(escopo.empresaId);
  const clientes = await s.list(getResource('clientes')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } });

  // Consentimento de marketing por cliente (quando exigido pela regra).
  let consentidos: Set<number> | null = null;
  if (regra.consentimento_marketing) {
    const consents = await s.list(getResource('customer_consents')!, { page: 1, pageSize: 40000, filter: { empresa_id: escopo.empresaId, finalidade: 'marketing', concedido: true } });
    consentidos = new Set(consents.rows.map((c) => Number(c.cliente_id)));
  }

  const selecionados: Row[] = [];
  for (const c of clientes.rows) {
    const cid = Number(c.id);
    const m = metricas.get(cid);
    const receita = m?.receita_total ?? 0;
    const freq = m?.frequencia ?? 0;
    const recencia: number | null = m?.recencia_dias ?? null;
    if (regra.valor_min !== undefined && receita < Number(regra.valor_min)) continue;
    if (regra.frequencia_min !== undefined && freq < Number(regra.frequencia_min)) continue;
    if (regra.recencia_dias_max !== undefined) {
      if (recencia === null) continue; // sem compra recente não casa "recente"
      if (recencia > Number(regra.recencia_dias_max)) continue;
    }
    if (regra.recencia_dias_min !== undefined) {
      if (recencia === null || recencia < Number(regra.recencia_dias_min)) continue;
    }
    if (regra.consentimento_marketing && consentidos && !consentidos.has(cid)) continue;
    if (regra.incluir_abandono) {
      // Abandono: cliente com compras mas inativo há mais de 90 dias.
      if (!(freq > 0 && recencia !== null && recencia > 90)) continue;
    }
    selecionados.push({ id: cid, nome: c.nome, receita_total: receita, frequencia: freq, recencia_dias: recencia });
  }
  selecionados.sort((a, b) => Number(b.receita_total) - Number(a.receita_total));
  res.json({
    segmento_id: segmentoId,
    nome: segmento.nome,
    regra,
    total: selecionados.length,
    clientes: selecionados.slice(0, 200),
    gerado_em: new Date().toISOString(),
  });
}
