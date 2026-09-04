// ============================================================
// FINANCEIRO — livro-caixa ligado a vendas, compras, custos e aportes.
//
// O sistema usa um "lançamento financeiro" como razão única:
//   • venda faturada  → lançamento RECEITA (status conforme fin_status)
//   • compra recebida → lançamento DESPESA (status conforme fin_status)
//   • aporte confirmado → lançamento INVESTIMENTO (entrada de capital)
//   • cancelamento/estorno → marca o lançamento como CANCELADO
// A tela "Financeiro" usa este livro para fluxo de caixa, DRE simplificada,
// saldo por conta e contas a receber/pagar.
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import type { Row, Tx } from './store';
import { labelOf } from './store';

const r2 = (n: number) => Math.round(n * 100) / 100;
const hoje = () => new Date().toISOString().slice(0, 10);

function faturados(v: Row): boolean {
  return ['faturada', 'entregue'].includes(String(v.status));
}

/** Busca a primeira categoria de um tipo (mocks/decorres no Postgres) — ou null. */
async function categoriaPadrao(tipo: 'receita' | 'despesa' | 'investimento', tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const r = getResource('categorias_financeiras')!;
  const lista = await s.list(r, { page: 1, pageSize: 1, filter: { tipo } }, tx);
  return lista.rows[0] ?? null;
}

async function lancamentoExistente(tipo: string, refId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const r = getResource('lancamentos_financeiros')!;
  const lista = await s.list(r, { page: 1, pageSize: 10, filter: { referencia_tipo: tipo, referencia_id: refId } }, tx);
  return lista.rows[0] ?? null;
}

async function criarLancamento(data: Row, actor: { id: number | null; name: string }, tx: Tx): Promise<Row> {
  const s = getStore();
  const r = getResource('lancamentos_financeiros')!;
  const row = await s.insert(r, data, tx);
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'criar',
      recurso: r.key,
      registro_id: Number(row.id),
      descricao: `Lançamento financeiro criado — ${data.descricao} (${data.tipo})`,
      dados: { tipo: data.tipo, valor: data.valor, referencia_tipo: data.referencia_tipo, referencia_id: data.referencia_id },
    },
    tx
  );
  return row;
}

async function atualizarLancamento(id: number, data: Row, actor: { id: number | null; name: string }, tx: Tx): Promise<Row> {
  const s = getStore();
  const r = getResource('lancamentos_financeiros')!;
  const updated = await s.update(r, id, data, tx);
  if (updated) {
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: r.key,
        registro_id: id,
        descricao: `Lançamento financeiro atualizado — ${data.descricao || ''}`,
        dados: data,
      },
      tx
    );
  }
  return updated ?? data;
}

/**
 * Sincroniza o lançamento financeiro de uma VENDA.
 * Chamado dentro da transação do pedido (services.ts).
 */
export async function syncLancamentoVenda(
  before: Row | null,
  after: Row,
  data: Record<string, unknown>,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<void> {
  const id = Number(after.id);
  const s = getStore();
  const vendasR = getResource('vendas')!;
  const cliente = after.cliente_id ? await s.findOneWhere(getResource('clientes')!, { id: Number(after.cliente_id) }, tx) : null;
  const descricao = before
    ? `Venda #${id} — ${cliente ? labelOf(getResource('clientes')!, cliente) : ''}`
    : `Venda #${id} criada — ${cliente ? labelOf(getResource('clientes')!, cliente) : ''}`;
  const referencia = 'venda';
  const existente = await lancamentoExistente(referencia, id, tx);

  if (existente) {
    const status = after.fin_status === 'recebido' ? 'confirmado' : after.fin_status === 'cancelado' ? 'cancelado' : 'pendente';
    const mudou =
      Number(existente.valor) !== Number(after.total || 0) ||
      String(existente.status) !== status ||
      Number(existente.referencia_id || 0) !== id ||
      String(existente.descricao || '') !== descricao;
    if (mudou) {
      await atualizarLancamento(
        Number(existente.id),
        { ...existente, valor: Number(after.total || 0), status, conta_id: after.fin_conta_id ?? existente.conta_id ?? null, forma_pagamento: after.fin_forma_pagamento ?? existente.forma_pagamento ?? null, descricao, referencia_id: id },
        actor,
        tx
      );
    }
    return;
  }

  if (!faturados(after)) return;
  const cat = await categoriaPadrao('receita', tx);
  await criarLancamento(
    {
      data: String(after.faturada_em || after.data || hoje()).slice(0, 10),
      tipo: 'receita',
      categoria_id: cat?.id ?? null,
      conta_id: after.fin_conta_id ?? null,
      descricao,
      valor: Number(after.total || 0),
      forma_pagamento: after.fin_forma_pagamento ?? null,
      status: after.fin_status === 'recebido' ? 'confirmado' : 'pendente',
      referencia_tipo: referencia,
      referencia_id: id,
      observacoes: `Canal: ${String(after.canal_venda || 'balcao')}`,
    },
    actor,
    tx
  );
}

/**
 * Sincroniza o lançamento financeiro de uma COMPRA.
 */
export async function syncLancamentoCompra(
  before: Row | null,
  after: Row,
  data: Record<string, unknown>,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<void> {
  const id = Number(after.id);
  const s = getStore();
  const fornecedor = after.fornecedor_id ? await s.findOneWhere(getResource('fornecedores')!, { id: Number(after.fornecedor_id) }, tx) : null;
  const descricao = `Compra #${id} — ${fornecedor ? labelOf(getResource('fornecedores')!, fornecedor) : ''}`;
  const referencia = 'compra';
  const existente = await lancamentoExistente(referencia, id, tx);

  if (existente) {
    const status = after.fin_status === 'pago' ? 'confirmado' : after.fin_status === 'cancelado' ? 'cancelado' : 'pendente';
    const mudou =
      Number(existente.valor) !== Number(after.total || 0) ||
      String(existente.status) !== status ||
      Number(existente.referencia_id || 0) !== id ||
      String(existente.descricao || '') !== descricao;
    if (mudou) {
      await atualizarLancamento(
        Number(existente.id),
        { ...existente, valor: Number(after.total || 0), status, conta_id: after.fin_conta_id ?? existente.conta_id ?? null, forma_pagamento: after.fin_forma_pagamento ?? existente.forma_pagamento ?? null, descricao, referencia_id: id },
        actor,
        tx
      );
    }
    return;
  }

  if (String(after.status) !== 'recebido') return;
  const cat = await categoriaPadrao('despesa', tx);
  await criarLancamento(
    {
      data: String(after.recebida_em || after.data || hoje()).slice(0, 10),
      tipo: 'despesa',
      categoria_id: cat?.id ?? null,
      conta_id: after.fin_conta_id ?? null,
      descricao,
      valor: Number(after.total || 0),
      forma_pagamento: after.fin_forma_pagamento ?? null,
      status: after.fin_status === 'pago' ? 'confirmado' : 'pendente',
      referencia_tipo: referencia,
      referencia_id: id,
    },
    actor,
    tx
  );
}

/**
 * Sincroniza o lançamento de um APORTE (investidor/sócio).
 * Chamado na criação/edição de aportes em services.ts.
 */
export async function syncAporte(
  before: Row | null,
  after: Row,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<void> {
  const id = Number(after.id);
  const s = getStore();
  const investidor = after.investidor_id ? await s.findOneWhere(getResource('investidores')!, { id: Number(after.investidor_id) }, tx) : null;
  const descricao = `Aporte #${id} — ${investidor ? labelOf(getResource('investidores')!, investidor) : ''}`;
  const referencia = 'aporte';
  const existente = await lancamentoExistente(referencia, id, tx);

  if (existente) {
    const status = after.status === 'confirmado' ? 'confirmado' : after.status === 'estornado' ? 'cancelado' : 'pendente';
    const mudou =
      Number(existente.valor) !== Number(after.valor || 0) ||
      String(existente.status) !== status ||
      Number(existente.conta_id || 0) !== Number(after.conta_id || 0) ||
      String(existente.descricao || '') !== descricao;
    if (mudou) {
      await atualizarLancamento(
        Number(existente.id),
        { ...existente, valor: Number(after.valor || 0), status, conta_id: after.conta_id ?? existente.conta_id ?? null, forma_pagamento: after.forma_pagamento ?? existente.forma_pagamento ?? null, descricao, referencia_id: id },
        actor,
        tx
      );
    }
    return;
  }

  if (String(after.status) !== 'confirmado') return;
  const cat = await categoriaPadrao('investimento', tx);
  const lanc = await criarLancamento(
    {
      data: String(after.data || hoje()).slice(0, 10),
      tipo: 'investimento',
      categoria_id: cat?.id ?? null,
      conta_id: after.conta_id ?? null,
      descricao,
      valor: Number(after.valor || 0),
      forma_pagamento: after.forma_pagamento ?? null,
      status: 'confirmado',
      referencia_tipo: referencia,
      referencia_id: id,
    },
    actor,
    tx
  );
  await s.update(getResource('aportes')!, id, { fin_lancamento_id: Number(lanc.id) }, tx);
}

// ----------------------------------------------------------------------------
// Painel financeiro (fluxo de caixa + DRE simplificada + contas a pagar/receber)
// ----------------------------------------------------------------------------

export async function resumoFinanceiro(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'read');
  checkAccess(getResource('vendas')!, actor, 'read');
  checkAccess(getResource('compras')!, actor, 'read');
  checkAccess(getResource('aportes')!, actor, 'read');
  checkAccess(getResource('contas_financeiras')!, actor, 'read');

  const s = getStore();
  const [lancR, vendasR, comprasR, aportesR, contasR, categoriasR] = await Promise.all([
    s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 10000, sort: 'data', dir: 'desc' }),
    s.list(getResource('vendas')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('compras')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('aportes')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('contas_financeiras')!, { page: 1, pageSize: 1000 }),
    s.list(getResource('categorias_financeiras')!, { page: 1, pageSize: 1000 }),
  ]);

  const mes = new Date().toISOString().slice(0, 7);
  const catPorId = new Map<number, Row>(categoriasR.rows.map((c) => [Number(c.id), c]));
  const nomeCat = (id: unknown) => {
    const c = catPorId.get(Number(id || 0));
    return c ? String(c.nome || 'Sem categoria') : 'Sem categoria';
  };
  const contaPorId = new Map<number, Row>(contasR.rows.map((c) => [Number(c.id), c]));
  const nomeConta = (id: unknown) => {
    const c = contaPorId.get(Number(id || 0));
    return c ? String(c.nome || '—') : '—';
  };

  const confirmados = lancR.rows.filter((l) => String(l.status) === 'confirmado');
  const doMes = (l: Row) => String(l.data || '').slice(0, 7) === mes;

  // Saldo por conta = saldo inicial + entradas − saídas (confirmados)
  const saldoContas = contasR.rows.map((conta) => {
    let valor = Number(conta.saldo_inicial || 0);
    for (const l of confirmados) {
      if (Number(l.conta_id || 0) !== Number(conta.id)) continue;
      const entrada = ['receita', 'investimento'].includes(String(l.tipo));
      valor += entrada ? Number(l.valor || 0) : -Number(l.valor || 0);
    }
    return { conta_id: Number(conta.id), nome: nomeConta(conta.id), tipo: String(conta.tipo || 'caixa'), saldo: r2(valor) };
  });
  const saldoContasTotal = r2(saldoContas.reduce((sum, c) => sum + c.saldo, 0));

  const receitasMes = r2(confirmados.filter((l) => doMes(l) && l.tipo === 'receita').reduce((s, l) => s + Number(l.valor || 0), 0));
  const despesasMes = r2(confirmados.filter((l) => doMes(l) && l.tipo === 'despesa').reduce((s, l) => s + Number(l.valor || 0), 0));
  const investimentosMes = r2(confirmados.filter((l) => doMes(l) && l.tipo === 'investimento').reduce((s, l) => s + Number(l.valor || 0), 0));
  const resultadoOperacionalMes = r2(receitasMes - despesasMes);
  const resultadoCaixaMes = r2(resultadoOperacionalMes + investimentosMes);

  const aReceber = r2(vendasR.rows.filter((v) => faturados(v) && String(v.fin_status || 'a_receber') !== 'recebido').reduce((s, v) => s + Number(v.total || 0), 0));
  const aPagar = r2(comprasR.rows.filter((c) => String(c.status) === 'recebido' && String(c.fin_status || 'a_pagar') !== 'pago').reduce((s, c) => s + Number(c.total || 0), 0));

  const porCategoria = new Map<string, { categoria: string; receita: number; despesa: number; investimento: number }>();
  for (const l of confirmados) {
    const nome = nomeCat(l.categoria_id);
    const item = porCategoria.get(nome) || { categoria: nome, receita: 0, despesa: 0, investimento: 0 };
    if (l.tipo === 'receita') item.receita = r2(item.receita + Number(l.valor || 0));
    if (l.tipo === 'despesa') item.despesa = r2(item.despesa + Number(l.valor || 0));
    if (l.tipo === 'investimento') item.investimento = r2(item.investimento + Number(l.valor || 0));
    porCategoria.set(nome, item);
  }
  const categorias = [...porCategoria.values()].sort((a, b) => b.despesa + b.receita + b.investimento - (a.despesa + a.receita + a.investimento));

  const porCanal = [
    { canal: 'balcao', valor: 0 },
    { canal: 'representante', valor: 0 },
    { canal: 'whatsapp', valor: 0 },
    { canal: 'site_varejo', valor: 0 },
    { canal: 'site_atacado', valor: 0 },
    { canal: 'marketplace', valor: 0 },
  ];
  for (const v of vendasR.rows) {
    if (!faturados(v) || !doMes(v)) continue;
    const item = porCanal.find((p) => p.canal === String(v.canal_venda || 'balcao'));
    if (item) item.valor = r2(item.valor + Number(v.total || 0));
  }

  const recentes = lancR.rows.slice(0, 24).map((l) => ({
    id: Number(l.id),
    data: String(l.data || ''),
    tipo: String(l.tipo || ''),
    descricao: String(l.descricao || ''),
    status: String(l.status || ''),
    valor: Number(l.valor || 0),
    categoria: nomeCat(l.categoria_id),
    conta: nomeConta(l.conta_id),
    referencia_tipo: l.referencia_tipo || null,
    referencia_id: l.referencia_id || null,
  }));

  res.json({
    mes,
    saldoContas,
    saldoContasTotal,
    receitasMes,
    despesasMes,
    investimentosMes,
    resultadoOperacionalMes,
    resultadoCaixaMes,
    aReceber,
    aPagar,
    categorias,
    vendasPorCanal: porCanal.filter((p) => p.valor > 0),
    recentes,
    contasTotal: contasR.rows.filter((c) => c.ativo !== false).length,
    aportesTotal: aportesR.rows.filter((a) => String(a.status) === 'confirmado').reduce((s, a) => s + Number(a.valor || 0), 0),
  });
}

/** Lançamento manual simples (usado pela tela Financeiro). */
export async function criarLancamentoManual(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'create');
  const body = req.body || {};
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw new HttpError(400, 'Informe um valor maior que zero.', { valor: 'Valor inválido' });
  if (!body.descricao || !String(body.descricao).trim()) throw new HttpError(400, 'Informe a descrição.', { descricao: 'Campo obrigatório' });

  const s = getStore();
  try {
    const row = await s.transaction(async (tx) => {
      const data: Row = {
        data: String(body.data || hoje()).slice(0, 10),
        tipo: ['receita', 'despesa', 'investimento', 'estorno'].includes(String(body.tipo)) ? String(body.tipo) : 'despesa',
        categoria_id: body.categoria_id ?? null,
        conta_id: body.conta_id ?? null,
        descricao: String(body.descricao).trim(),
        valor: r2(valor),
        forma_pagamento: body.forma_pagamento ?? null,
        status: String(body.status || 'confirmado'),
        referencia_tipo: body.referencia_tipo || 'outro',
        referencia_id: body.referencia_id ?? null,
        observacoes: body.observacoes ?? null,
      };
      const inserted = await s.insert(getResource('lancamentos_financeiros')!, data, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'lancamentos_financeiros', registro_id: Number(inserted.id), descricao: `Lançamento manual — ${data.descricao} (${data.tipo})`, dados: { valor: data.valor } },
        tx
      );
      return inserted;
    });
    res.status(201).json(row);
  } catch (e) {
    throw toHttpError(e, getResource('lancamentos_financeiros'));
  }
}
