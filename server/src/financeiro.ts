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
import { round2, somaMoeda } from './utils';

const r2 = round2;

const hoje = () => new Date().toISOString().slice(0, 10);
const addDias = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const fmtData = (d: Date) => d.toISOString().slice(0, 10);
const primeiroDiaMes = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12));

/** Segunda-feira da semana da data (projeção semanal). */
function inicioSemana(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
  const dia = t.getUTCDay(); // 0=domingo
  const off = dia === 0 ? -6 : 1 - dia;
  return addDias(t, off);
}

type EventoProjetado = { data: string; tipo: 'receita' | 'despesa'; descricao: string; valor: number };

/** Próximas ocorrências de uma recorrência dentro do horizonte (projeção). */
function ocorrenciasRecorrencia(r: Row, de: string, ate: string, max = 60): EventoProjetado[] {
  const eventos: EventoProjetado[] = [];
  let data = String(r.proxima_geracao || calcularProximaGeracao(r)).slice(0, 10);
  if (data < de) data = calcularProximaGeracao(r, new Date(`${de}T12:00:00Z`));
  const tipo = String(r.tipo || 'despesa') === 'receita' ? 'receita' : 'despesa';
  let guard = 0;
  while (data <= ate && eventos.length < max && guard++ < max * 2) {
    eventos.push({ data, tipo, descricao: String(r.descricao || 'Recorrência'), valor: Number(r.valor || 0) });
    data = calcularProximaGeracao(r, new Date(`${data}T12:00:00Z`));
  }
  return eventos;
}

/** Monta o fluxo projetado (semana/mês) a partir de pendentes + recorrências futuras. */
function montarFluxoProjetado(pendentes: Row[], recorrencias: Row[], saldoBase: number) {
  const de = hoje();
  const ate = addDias(new Date(), 365).toISOString().slice(0, 10);
  const eventos: EventoProjetado[] = pendentes
    .filter((l) => ['receita', 'despesa'].includes(String(l.tipo)) && String(l.status) === 'pendente')
    .filter((l) => (String(l.vencimento || l.data || '') >= de))
    .map((l) => ({
      data: String(l.vencimento || l.data || '').slice(0, 10),
      tipo: String(l.tipo) === 'receita' ? 'receita' : 'despesa',
      descricao: String(l.descricao || 'Conta em aberto'),
      valor: Number(l.valor || 0),
    }));
  for (const r of recorrencias) {
    if (String(r.status || 'ativo') !== 'ativo') continue;
    eventos.push(...ocorrenciasRecorrencia(r, de, ate));
  }
  eventos.sort((a, b) => a.data.localeCompare(b.data));

  const agrupar = (inicio: Date, periodo: 'semana' | 'mes', meses = 12) => {
    const linhas: { periodo: string; label: string; entradas: number; saidas: number; liquido: number; acumulado: number }[] = [];
    let acumulado = saldoBase;
    let cursor = inicio;
    const passos = periodo === 'semana' ? 12 : meses;
    for (let i = 0; i < passos; i++) {
      let fim: Date;
      if (periodo === 'semana') {
        fim = addDias(cursor, 7);
      } else {
        fim = primeiroDiaMes(addDias(cursor, 31));
      }
      const iniS = fmtData(cursor);
      const fimS = fmtData(fim);
      const noPeriodo = eventos.filter((e) => e.data >= iniS && e.data < fimS);
      const entradas = somaMoeda(noPeriodo.filter((e) => e.tipo === 'receita').map((e) => e.valor));
      const saidas = somaMoeda(noPeriodo.filter((e) => e.tipo === 'despesa').map((e) => e.valor));
      const liquido = r2(entradas - saidas);
      acumulado = r2(acumulado + liquido);
      const label = periodo === 'semana' ? `Semana ${fmtData(cursor).slice(8, 10)}/${fmtData(cursor).slice(5, 7)}` : `${fmtData(cursor).slice(0, 7)}`;
      linhas.push({ periodo: periodo === 'semana' ? iniS : fmtData(cursor).slice(0, 7), label, entradas, saidas, liquido, acumulado });
      cursor = fim;
    }
    return linhas;
  };

  return {
    saldoBase,
    semanal: agrupar(inicioSemana(new Date()), 'semana'),
    mensal: agrupar(primeiroDiaMes(new Date()), 'mes'),
  };
}

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

/** Busca a primeira categoria de uma classe do DRE (ex.: receitas_financeiras). */
async function categoriaPorClasse(classe: string, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const r = getResource('categorias_financeiras')!;
  const lista = await s.list(r, { page: 1, pageSize: 1, filter: { classificacao_dre: classe } }, tx);
  return lista.rows[0] ?? null;
}

async function lancamentoExistente(tipo: string, refId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const r = getResource('lancamentos_financeiros')!;
  const lista = await s.list(r, { page: 1, pageSize: 10, filter: { referencia_tipo: tipo, referencia_id: refId } }, tx);
  return lista.rows[0] ?? null;
}

/** Todas as parcelas (lançamentos) de uma origem — base da reconciliação. */
async function parcelasDaOrigem(tipo: string, refId: number, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const r = getResource('lancamentos_financeiros')!;
  const lista = await s.list(r, { page: 1, pageSize: 500, filter: { referencia_tipo: tipo, referencia_id: refId } }, tx);
  return lista.rows;
}

/** Soma meses à data preservando o dia (31 jan + 1m = 28/29 fev, não 3 mar). */
function addMeses(dataISO: string, meses: number): string {
  const d = new Date(`${dataISO}T12:00:00Z`);
  const dia = d.getUTCDate();
  const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + meses, 1, 12));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0, 12)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

/**
 * Reconcilia o contas a receber/pagar de uma venda/compra como PARCELA REAL:
 * fin_parcelas = N gera N lançamentos (1/N..N/N) com vencimentos mensais, a
 * última absorvendo os centavos da divisão. Edição do pedido atualiza as
 * parcelas; redução do plano cancela as parcelas excedentes (histórico).
 * Baixas já confirmadas (conciliação/baixa manual) não são revertidas —
 * só o cancelamento/faturamento global do pedido redefine o status.
 */
async function reconciliarParcelasPedido(
  referencia: 'venda' | 'compra',
  after: Row,
  descricaoBase: string,
  dataBase: string,
  tipo: 'receita' | 'despesa',
  categoriaId: number | null,
  actor: { id: number | null; name: string },
  tx: Tx,
  extraObs?: string | null
): Promise<void> {
  const id = Number(after.id);
  const finCancelado = ['cancelado', 'cancelada'].includes(String(after.fin_status)) || ['cancelado', 'cancelada'].includes(String(after.status));
  const finLiquidado = ['recebido', 'pago'].includes(String(after.fin_status));
  const total = Math.max(0, Number(after.total || 0));
  const n = Math.max(1, Math.min(60, Math.trunc(Number(after.fin_parcelas || 1) || 1)));
  const baseVenc = (String(after.fin_vencimento || '').slice(0, 10) || dataBase).slice(0, 10);
  const valorParcela = r2(total / n);
  const detalhes = Array.isArray(after.fin_parcelas_detalhes) ? after.fin_parcelas_detalhes as Row[] : [];
  const existentes = await parcelasDaOrigem(referencia, id, tx);

  for (let i = 1; i <= n; i++) {
    const detalhe = detalhes.find((item) => Number(item.parcela || 0) === i) || detalhes[i - 1];
    const valor = detalhe && Number.isFinite(Number(detalhe.valor)) ? r2(Number(detalhe.valor)) : i === n ? r2(total - valorParcela * (n - 1)) : valorParcela;
    const alvo = existentes.find((l) => Number(l.parcela || 1) === i);
    const dados: Row = {
      data: i === 1 || !alvo ? dataBase : String(alvo.data || dataBase).slice(0, 10),
      tipo,
      categoria_id: categoriaId,
      conta_id: after.fin_conta_id ?? alvo?.conta_id ?? null,
      descricao: n > 1 ? `${descricaoBase} (${i}/${n})` : descricaoBase,
      valor,
      forma_pagamento: after.fin_forma_pagamento ?? alvo?.forma_pagamento ?? null,
      vencimento: detalhe?.vencimento ? String(detalhe.vencimento).slice(0, 10) : addMeses(baseVenc, i - 1),
      parcela: i,
      total_parcelas: n,
      referencia_tipo: referencia,
      referencia_id: id,
      observacoes: alvo?.observacoes ?? extraObs ?? null,
    };
    if (alvo) {
      // Status: cancelamento global zera tudo; liquidação global confirma tudo;
      // fora isso a parcela confirmada por baixa/conciliação é intocável.
      let status = String(alvo.status || 'pendente');
      if (finCancelado) status = 'cancelado';
      else if (finLiquidado) status = 'confirmado';
      else if (status === 'cancelado') status = 'pendente';
      await atualizarLancamento(Number(alvo.id), { ...alvo, ...dados, status }, actor, tx);
    } else {
      const status = finCancelado ? 'cancelado' : finLiquidado ? 'confirmado' : 'pendente';
      await criarLancamento({ ...dados, status, taxa_pct: 0, valor_liquido: valor }, actor, tx);
    }
  }
  // Parcelas excedentes (plano encolheu): cancelamento preserva a trilha.
  for (const l of existentes) {
    if (Number(l.parcela || 1) > n && String(l.status) !== 'cancelado') {
      await atualizarLancamento(Number(l.id), { ...l, status: 'cancelado', observacoes: [String(l.observacoes || ''), `Parcela cancelada: plano reduzido para ${n}x em ${hoje()}`].filter(Boolean).join('\n') }, actor, tx);
    }
  }
}


/**
 * Líquido que realmente movimenta a conta: bruto − taxa da operadora
 * (Mercado Pago, cartão...). Sem taxa, líquido = bruto.
 */
export function calcularLiquido(valor: number, taxaPct: number): number {
  const v = Number(valor || 0);
  const t = Number(taxaPct || 0);
  if (!(t > 0)) return r2(v);
  return r2(v - (v * t) / 100);
}

/** Líquido de um lançamento já salvo (histórico sem taxa usa o bruto). */
function liquidoDe(l: Row): number {
  const liq = Number(l.valor_liquido);
  return Number.isFinite(liq) && liq > 0 ? liq : Number(l.valor || 0);
}

/** Transferências são neutras no DRE: o dinheiro só mudou de conta. */
function ehTransferencia(l: Row): boolean {
  return String(l.referencia_tipo || '') === 'transferencia';
}

/**
 * Garante taxa_pct e valor_liquido coerentes no payload de um lançamento.
 * Chamado pelos ganchos de criação/edição (services.ts) e pelo POST manual.
 * Se o usuário informou valor_liquido explicitamente (ajuste de centavos),
 * respeita; senão calcula bruto − taxa. Líquido nunca passa do bruto.
 */
export function hookTaxaLancamento(data: Row, before?: Row | null): void {
  const valor = Number(data.valor ?? before?.valor ?? 0);
  const taxa = Math.min(99.99, Math.max(0, Number(data.taxa_pct ?? before?.taxa_pct ?? 0)));
  data.taxa_pct = r2(taxa);
  if (data.valor_liquido === undefined || data.valor_liquido === null || data.valor_liquido === '') {
    data.valor_liquido = calcularLiquido(valor, taxa);
  } else {
    const liq = Number(data.valor_liquido);
    if (!Number.isFinite(liq) || liq < 0) data.valor_liquido = calcularLiquido(valor, taxa);
    else if (liq > valor) data.valor_liquido = r2(valor);
  }
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
 * Sincroniza o contas a receber de uma VENDA como parcelas reais.
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
  const cliente = after.cliente_id ? await s.findOneWhere(getResource('clientes')!, { id: Number(after.cliente_id) }, tx) : null;
  const descricao = `Venda #${id} — ${cliente ? labelOf(getResource('clientes')!, cliente) : ''}`;
  const tinha = await lancamentoExistente('venda', id, tx);
  if (!tinha && !faturados(after)) return;

  const cat = await categoriaPadrao('receita', tx);
  await reconciliarParcelasPedido(
    'venda',
    after,
    descricao,
    String(after.faturada_em || after.data || hoje()).slice(0, 10),
    'receita',
    cat?.id ?? null,
    actor,
    tx,
    `Canal: ${String(after.canal_venda || 'balcao')}`
  );
}

/**
 * Sincroniza o contas a pagar de uma COMPRA como parcelas reais.
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
  const tinha = await lancamentoExistente('compra', id, tx);
  if (!tinha && String(after.status) !== 'recebido') return;

  const cat = await categoriaPadrao('despesa', tx);
  await reconciliarParcelasPedido('compra', after, descricao, String(after.recebida_em || after.data || hoje()).slice(0, 10), 'despesa', cat?.id ?? null, actor, tx, null);
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

/**
 * Sincroniza o PAR ESPELHO de uma TRANSFERÊNCIA entre contas:
 *   • conta de origem  → lançamento DESPESA (referencia_tipo 'transferencia')
 *   • conta de destino → lançamento RECEITA (mesmo vínculo)
 * O resumo financeiro exclui esses pares do DRE e de receitas/despesas —
 * eles só mudam o dinheiro de lugar. Cancelar a transferência cancela o par;
 * o histórico nunca é apagado. Chamado pelos ganchos de services.ts.
 */
export async function syncTransferencia(before: Row | null, after: Row, actor: { id: number | null; name: string }, tx: Tx): Promise<void> {
  const s = getStore();
  const id = Number(after.id);
  const rLanc = getResource('lancamentos_financeiros')!;
  const rContas = getResource('contas_financeiras')!;
  const origemId = Number(after.conta_origem_id || 0);
  const destinoId = Number(after.conta_destino_id || 0);
  if (!origemId || !destinoId) throw new HttpError(400, 'Informe as contas de origem e de destino.');
  if (origemId === destinoId) throw new HttpError(400, 'Origem e destino precisam ser contas diferentes.', { conta_destino_id: 'Escolha outra conta' });
  const valor = Number(after.valor || 0);
  if (!Number.isFinite(valor) || valor <= 0) throw new HttpError(400, 'Informe um valor maior que zero.', { valor: 'Valor inválido' });

  const data = String(after.data || hoje()).slice(0, 10);
  const status = String(after.status) === 'cancelado' ? 'cancelado' : 'confirmado';
  const nomeConta = async (cid: number) => {
    const c = await s.findOneWhere(rContas, { id: cid }, tx);
    return c ? String(c.nome || `Conta #${cid}`) : `Conta #${cid}`;
  };
  const [nomeOrigem, nomeDestino] = [await nomeConta(origemId), await nomeConta(destinoId)];
  const descBase = String(after.descricao || '').trim() || `Transferência #${id} — ${nomeOrigem} → ${nomeDestino}`;

  let saidaId = after.lancamento_saida_id ? Number(after.lancamento_saida_id) : null;
  let entradaId = after.lancamento_entrada_id ? Number(after.lancamento_entrada_id) : null;

  const dadosSaida: Row = {
    data,
    tipo: 'despesa',
    categoria_id: null,
    centro_custo_id: null,
    conta_id: origemId,
    descricao: `${descBase} · saída → ${nomeDestino}`,
    valor: r2(valor),
    taxa_pct: 0,
    valor_liquido: r2(valor),
    forma_pagamento: 'transferencia',
    status,
    vencimento: data,
    parcela: 1,
    total_parcelas: 1,
    referencia_tipo: 'transferencia',
    referencia_id: id,
    observacoes: `Espelho automático da transferência #${id}. Neutra no DRE.`,
  };
  const dadosEntrada: Row = { ...dadosSaida, tipo: 'receita', conta_id: destinoId, descricao: `${descBase} · entrada ⇐ ${nomeOrigem}` };

  if (saidaId) {
    const atual = await s.get(rLanc, saidaId, tx);
    if (atual) await atualizarLancamento(saidaId, { ...atual, ...dadosSaida }, actor, tx);
    else saidaId = null;
  }
  if (!saidaId) {
    const saida = await criarLancamento(dadosSaida, actor, tx);
    saidaId = Number(saida.id);
  }
  if (entradaId) {
    const atual = await s.get(rLanc, entradaId, tx);
    if (atual) await atualizarLancamento(entradaId, { ...atual, ...dadosEntrada }, actor, tx);
    else entradaId = null;
  }
  if (!entradaId) {
    const entrada = await criarLancamento(dadosEntrada, actor, tx);
    entradaId = Number(entrada.id);
  }

  if (Number(after.lancamento_saida_id || 0) !== saidaId || Number(after.lancamento_entrada_id || 0) !== entradaId) {
    await s.update(getResource('transferencias_financeiras')!, id, { lancamento_saida_id: saidaId, lancamento_entrada_id: entradaId }, tx);
  }
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
  const [lancR, vendasR, comprasR, aportesR, contasR, categoriasR, clientesR, fornecedoresR, recorrenciasR, centrosR] = await Promise.all([
    s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 10000, sort: 'data', dir: 'desc' }),
    s.list(getResource('vendas')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('compras')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('aportes')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('contas_financeiras')!, { page: 1, pageSize: 1000 }),
    s.list(getResource('categorias_financeiras')!, { page: 1, pageSize: 1000 }),
    s.list(getResource('clientes')!, { page: 1, pageSize: 2000 }),
    s.list(getResource('fornecedores')!, { page: 1, pageSize: 2000 }),
    s.list(getResource('recorrencias_financeiras')!, { page: 1, pageSize: 1000, filter: { status: 'ativo' } }),
    s.list(getResource('centros_custo')!, { page: 1, pageSize: 1000 }),
  ]);

  const mes = new Date().toISOString().slice(0, 7);
  const catPorId = new Map<number, Row>(categoriasR.rows.map((c) => [Number(c.id), c]));
  const nomeCat = (id: unknown) => {
    const c = catPorId.get(Number(id || 0));
    return c ? String(c.nome || 'Sem categoria') : 'Sem categoria';
  };
  const classeCat = (l: Row): string => {
    const c = catPorId.get(Number(l.categoria_id || 0));
    if (c?.classificacao_dre) return String(c.classificacao_dre);
    const tipo = String(l.tipo || '');
    return tipo === 'receita' ? 'receita' : tipo === 'investimento' ? 'investimento' : 'despesas_operacionais';
  };
  const contaPorId = new Map<number, Row>(contasR.rows.map((c) => [Number(c.id), c]));
  const nomeConta = (id: unknown) => {
    const c = contaPorId.get(Number(id || 0));
    return c ? String(c.nome || '—') : '—';
  };

  const confirmados = lancR.rows.filter((l) => String(l.status) === 'confirmado');
  // Resultado ignora transferências: elas só mudam o dinheiro de conta.
  const operacionais = confirmados.filter((l) => !ehTransferencia(l));
  const pendentesOper = lancR.rows.filter((l) => String(l.status) === 'pendente' && !ehTransferencia(l));
  const doMes = (l: Row) => String(l.data || '').slice(0, 7) === mes;

  // Saldo por conta = saldo inicial + entradas (líquidas, já sem taxa) − saídas.
  // "Previsto" soma o que está pendente (bruto) — a visão do caixa futuro.
  const saldoContas = contasR.rows.map((conta) => {
    const cid = Number(conta.id);
    let valor = Number(conta.saldo_inicial || 0);
    for (const l of confirmados) {
      if (Number(l.conta_id || 0) !== cid) continue;
      const entrada = ['receita', 'investimento'].includes(String(l.tipo));
      valor += entrada ? liquidoDe(l) : -Number(l.valor || 0);
    }
    let previsto = valor;
    for (const l of pendentesOper) {
      if (Number(l.conta_id || 0) !== cid) continue;
      const entrada = ['receita', 'investimento'].includes(String(l.tipo));
      previsto += entrada ? liquidoDe(l) : -Number(l.valor || 0);
    }
    return { conta_id: cid, nome: nomeConta(cid), tipo: String(conta.tipo || 'caixa'), saldo: r2(valor), previsto: r2(previsto) };
  });
  const saldoContasTotal = somaMoeda(saldoContas.map((c) => c.saldo));

  const receitasMes = somaMoeda(operacionais.filter((l) => doMes(l) && l.tipo === 'receita').map((l) => liquidoDe(l)));
  const despesasMes = somaMoeda(operacionais.filter((l) => doMes(l) && l.tipo === 'despesa').map((l) => Number(l.valor || 0)));
  const investimentosMes = somaMoeda(operacionais.filter((l) => doMes(l) && l.tipo === 'investimento').map((l) => liquidoDe(l)));
  const taxasMes = somaMoeda(operacionais.filter((l) => doMes(l) && ['receita', 'investimento'].includes(String(l.tipo))).map((l) => r2(Number(l.valor || 0) - liquidoDe(l))));
  const resultadoOperacionalMes = r2(receitasMes - despesasMes);
  const resultadoCaixaMes = r2(resultadoOperacionalMes + investimentosMes);

  // DRE gerencial do mês — classificado pela categoria do lançamento.
  // Receita aqui é BRUTA; a taxa da operadora aparece em linha própria.
  const dre = { receita: 0, cmv: 0, mao_obra: 0, despesas_operacionais: 0, despesas_financeiras: 0, receitas_financeiras: 0, impostos: 0, investimentos: 0, taxas_operadoras: 0 };
  for (const l of operacionais) {
    if (!doMes(l)) continue;
    const classe = classeCat(l);
    const valor = Number(l.valor || 0);
    if (classe === 'receita') dre.receita += valor;
    else if (classe === 'cmv') dre.cmv += valor;
    else if (classe === 'mao_obra') dre.mao_obra += valor;
    else if (classe === 'despesas_financeiras') dre.despesas_financeiras += valor;
    else if (classe === 'receitas_financeiras') dre.receitas_financeiras += valor;
    else if (classe === 'impostos') dre.impostos += valor;
    else if (classe === 'investimento') dre.investimentos += valor;
    else dre.despesas_operacionais += valor;
  }
  dre.taxas_operadoras = taxasMes;
  dre.receita = r2(dre.receita);
  dre.cmv = r2(dre.cmv);
  dre.mao_obra = r2(dre.mao_obra);
  dre.despesas_operacionais = r2(dre.despesas_operacionais);
  dre.despesas_financeiras = r2(dre.despesas_financeiras);
  dre.receitas_financeiras = r2(dre.receitas_financeiras);
  dre.impostos = r2(dre.impostos);
  dre.investimentos = r2(dre.investimentos);
  const lucroBruto = r2(dre.receita - dre.cmv);
  const resultadoOperacional = r2(lucroBruto - dre.mao_obra - dre.despesas_operacionais - dre.impostos);
  const resultadoFinanceiro = r2(resultadoOperacional - dre.despesas_financeiras - dre.taxas_operadoras + dre.receitas_financeiras);
  const resultadoGeral = r2(resultadoFinanceiro + dre.investimentos);

  // Contas a receber/pagar em aberto = lançamentos PENDENTES do livro financeiro
  // (vendas faturadas, compras recebidas, recorrências, lançamentos manuais).
  const clienteNome = new Map(clientesR.rows.map((c) => [Number(c.id), labelOf(getResource('clientes')!, c)]));
  const fornecedorNome = new Map(fornecedoresR.rows.map((c) => [Number(c.id), labelOf(getResource('fornecedores')!, c)]));
  const nomeRef = (l: Row): string => {
    const tipo = String(l.referencia_tipo || '');
    const id = Number(l.referencia_id || 0);
    if (tipo === 'venda') return clienteNome.get(id) || `#${id}`;
    if (tipo === 'compra') return fornecedorNome.get(id) || `#${id}`;
    return String(l.descricao || 'Conta em aberto');
  };
  const vencidas = (d: unknown) => {
    const s = String(d || '').slice(0, 10);
    if (!s) return false;
    return s < hoje();
  };
  const somaVencidas = (lista: { vencimento: unknown; valor: number }[]) => somaMoeda(lista.filter((l) => vencidas(l.vencimento)).map((l) => l.valor));

  const pendentesReceber = pendentesOper.filter((l) => String(l.tipo) === 'receita');
  const pendentesPagar = pendentesOper.filter((l) => String(l.tipo) === 'despesa');

  const aReceberLista = pendentesReceber
    .map((l) => ({
      id: Number(l.id),
      tipo: String(l.referencia_tipo || 'outro'),
      nome: nomeRef(l),
      valor: Number(l.valor || 0),
      vencimento: String(l.vencimento || l.data || '').slice(0, 10) || null,
      parcelas: Number(l.parcela || 1),
      total_parcelas: Number(l.total_parcelas || 1),
      status: String(l.status || 'pendente'),
      referencia_tipo: String(l.referencia_tipo || 'outro'),
      referencia_id: Number(l.referencia_id || l.id),
    }))
    .sort((a, b) => (a.vencimento || '9999').localeCompare(b.vencimento || '9999'));

  const aPagarLista = pendentesPagar
    .map((l) => ({
      id: Number(l.id),
      tipo: String(l.referencia_tipo || 'outro'),
      nome: nomeRef(l),
      valor: Number(l.valor || 0),
      vencimento: String(l.vencimento || l.data || '').slice(0, 10) || null,
      parcelas: Number(l.parcela || 1),
      total_parcelas: Number(l.total_parcelas || 1),
      status: String(l.status || 'pendente'),
      referencia_tipo: String(l.referencia_tipo || 'outro'),
      referencia_id: Number(l.referencia_id || l.id),
    }))
    .sort((a, b) => (a.vencimento || '9999').localeCompare(b.vencimento || '9999'));

  const aReceber = somaMoeda(aReceberLista.map((l) => l.valor));
  const aPagar = somaMoeda(aPagarLista.map((l) => l.valor));

  // Aging do contas a receber: quanto está vencido e há quanto tempo, por faixa.
  // Sem vencimento registrado entra como "a vencer" (conservador).
  const hojeMs = Date.parse(hoje());
  const agingFaixas = { a_vencer: 0, vencido_1_30: 0, vencido_31_60: 0, vencido_61_90: 0, vencido_90_mais: 0 };
  const agingCliente = new Map<string, { nome: string; total: number; vencido: number }>();
  for (const l of aReceberLista) {
    const atraso = l.vencimento ? Math.floor((hojeMs - Date.parse(String(l.vencimento))) / 86400000) : 0;
    if (atraso <= 0) agingFaixas.a_vencer = r2(agingFaixas.a_vencer + l.valor);
    else if (atraso <= 30) agingFaixas.vencido_1_30 = r2(agingFaixas.vencido_1_30 + l.valor);
    else if (atraso <= 60) agingFaixas.vencido_31_60 = r2(agingFaixas.vencido_31_60 + l.valor);
    else if (atraso <= 90) agingFaixas.vencido_61_90 = r2(agingFaixas.vencido_61_90 + l.valor);
    else agingFaixas.vencido_90_mais = r2(agingFaixas.vencido_90_mais + l.valor);
    const cli = agingCliente.get(l.nome) || { nome: l.nome, total: 0, vencido: 0 };
    cli.total = r2(cli.total + l.valor);
    if (atraso > 0) cli.vencido = r2(cli.vencido + l.valor);
    agingCliente.set(l.nome, cli);
  }
  const agingReceber = {
    faixas: agingFaixas,
    clientes: [...agingCliente.values()].sort((a, b) => b.total - a.total).slice(0, 8),
  };

  const emJanela = (d: unknown, dias: number) => {
    const s = String(d || '').slice(0, 10);
    if (!s) return true; // sem vencimento — conta como próximo
    const hojeS = hoje();
    const limite = new Date();
    limite.setDate(limite.getDate() + dias);
    return s >= hojeS && s <= limite.toISOString().slice(0, 10);
  };

  const aReceber30 = somaMoeda(aReceberLista.filter((l) => emJanela(l.vencimento, 30)).map((l) => l.valor));
  const aPagar30 = somaMoeda(aPagarLista.filter((l) => emJanela(l.vencimento, 30)).map((l) => l.valor));
  const aReceberVencidas = somaVencidas(aReceberLista);
  const aPagarVencidas = somaVencidas(aPagarLista);

  const recorrencias = recorrenciasR.rows.map((r) => ({
    id: Number(r.id),
    descricao: String(r.descricao || ''),
    tipo: String(r.tipo || 'despesa'),
    categoria: nomeCat(r.categoria_id),
    conta: nomeConta(r.conta_id),
    valor: Number(r.valor || 0),
    forma_pagamento: r.forma_pagamento || null,
    frequencia: String(r.frequencia || 'mensal'),
    dia: Number(r.dia || 1),
    proxima_geracao: String(r.proxima_geracao || '').slice(0, 10) || null,
    status: String(r.status || 'ativo'),
  }));

  const saldoBase = saldoContasTotal;
  const fluxoProjetado = montarFluxoProjetado(lancR.rows, recorrenciasR.rows, saldoBase);

  // Semáforo de caixa: pior acumulado das próximas 12 semanas de projeção.
  // vermelho = caixa negativa; amarelo = queda de mais de 30% do saldo atual.
  const acumulados = fluxoProjetado.semanal.map((s2) => s2.acumulado);
  const minAcumulado = acumulados.length ? Math.min(...acumulados) : saldoBase;
  const semanaMin = fluxoProjetado.semanal.find((s2) => s2.acumulado === minAcumulado);
  const semaforo = {
    status: minAcumulado < 0 ? 'vermelho' : minAcumulado < saldoBase * 0.7 ? 'amarelo' : 'verde',
    minAcumulado: r2(minAcumulado),
    periodo: semanaMin ? semanaMin.label : null,
  };

  // Comparativo mensal: últimos 6 meses de operação confirmada (líquido).
  const serieMensal: { mes: string; label: string; receita: number; despesa: number; investimento: number; resultado: number }[] = [];
  for (let k = 5; k >= 0; k--) {
    const alvo = primeiroDiaMes(new Date());
    alvo.setUTCMonth(alvo.getUTCMonth() - k);
    const chave = alvo.toISOString().slice(0, 7);
    const doMesK = operacionais.filter((l) => String(l.data || '').slice(0, 7) === chave);
    const rec = somaMoeda(doMesK.filter((l) => l.tipo === 'receita').map((l) => liquidoDe(l)));
    const desp = somaMoeda(doMesK.filter((l) => l.tipo === 'despesa').map((l) => Number(l.valor || 0)));
    const inv = somaMoeda(doMesK.filter((l) => l.tipo === 'investimento').map((l) => liquidoDe(l)));
    serieMensal.push({ mes: chave, label: `${chave.slice(5, 7)}/${chave.slice(2, 4)}`, receita: rec, despesa: desp, investimento: inv, resultado: r2(rec - desp) });
  }

  const porCategoria = new Map<string, { categoria: string; receita: number; despesa: number; investimento: number }>();
  for (const l of operacionais) {
    const nome = nomeCat(l.categoria_id);
    const item = porCategoria.get(nome) || { categoria: nome, receita: 0, despesa: 0, investimento: 0 };
    if (l.tipo === 'receita') item.receita = r2(item.receita + Number(l.valor || 0));
    if (l.tipo === 'despesa') item.despesa = r2(item.despesa + Number(l.valor || 0));
    if (l.tipo === 'investimento') item.investimento = r2(item.investimento + Number(l.valor || 0));
    porCategoria.set(nome, item);
  }
  const categorias = [...porCategoria.values()].sort((a, b) => b.despesa + b.receita + b.investimento - (a.despesa + a.receita + a.investimento));

  // Resultado por centro de custo (mês): o raio-x Loja × Produção × Adm.
  const ccPorId = new Map<number, Row>(centrosR.rows.map((c) => [Number(c.id), c]));
  const porCentro = new Map<string, { centro: string; receita: number; despesa: number; investimento: number }>();
  for (const l of operacionais) {
    if (!doMes(l)) continue;
    const cc = ccPorId.get(Number(l.centro_custo_id || 0));
    const nome = cc ? String(cc.nome || 'Sem centro de custo') : 'Sem centro de custo';
    const item = porCentro.get(nome) || { centro: nome, receita: 0, despesa: 0, investimento: 0 };
    if (l.tipo === 'receita') item.receita = r2(item.receita + liquidoDe(l));
    if (l.tipo === 'despesa') item.despesa = r2(item.despesa + Number(l.valor || 0));
    if (l.tipo === 'investimento') item.investimento = r2(item.investimento + liquidoDe(l));
    porCentro.set(nome, item);
  }
  const porCentroCusto = [...porCentro.values()].sort((a, b) => b.despesa + b.receita - (a.despesa + a.receita));

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
    vencimento: String(l.vencimento || '').slice(0, 10) || null,
    parcela: Number(l.parcela || 1),
    total_parcelas: Number(l.total_parcelas || 1),
    referencia_tipo: l.referencia_tipo || null,
    referencia_id: l.referencia_id || null,
    atrasado: l.status !== 'confirmado' && l.status !== 'cancelado' && vencidas(l.vencimento),
  }));

  res.json({
    mes,
    saldoContas,
    saldoContasTotal,
    receitasMes,
    despesasMes,
    investimentosMes,
    taxasMes,
    semaforo,
    serieMensal,
    resultadoOperacionalMes,
    resultadoCaixaMes,
    aReceber,
    aPagar,
    aReceber30,
    aPagar30,
    aReceberVencidas,
    aPagarVencidas,
    aReceberLista,
    aPagarLista,
    agingReceber,
    categorias,
    porCentroCusto,
    vendasPorCanal: porCanal.filter((p) => p.valor > 0),
    dre,
    lucroBruto,
    resultadoOperacional,
    resultadoFinanceiro,
    resultadoGeral,
    recorrencias,
    fluxoProjetado,
    recentes,
    contasTotal: contasR.rows.filter((c) => c.ativo !== false).length,
    aportesTotal: aportesR.rows.filter((a) => String(a.status) === 'confirmado').reduce((s, a) => s + Number(a.valor || 0), 0),
  });
}

// ----------------------------------------------------------------------------
// RECORRÊNCIAS — despesas/receitas fixas (aluguel, energia, folha, facção...)
// ----------------------------------------------------------------------------

function calcularProximaGeracao(r: Row, base?: Date): string {
  const frequencia = String(r.frequencia || 'mensal');
  const dia = Math.min(31, Math.max(1, Number(r.dia || 1)));
  const baseD = base || new Date();
  const d = new Date(Date.UTC(baseD.getUTCFullYear(), baseD.getUTCMonth(), dia, 12));
  if (frequencia === 'semanal') {
    // Semanal: mantém a próxima geração dentro dos próximos 7 dias.
    const hoje = new Date();
    const t = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 12));
    let n = new Date(t.getTime());
    // programa para o próximo dia da semana correspondente a `dia` (1=segunda..7=domingo)
    const alvo = dia > 7 ? 1 : dia;
    const atual = (n.getUTCDay() + 6) % 7 + 1; // 1=segunda..7=domingo
    let diff = alvo - atual;
    if (diff < 0) diff += 7;
    n = new Date(t.getTime() + diff * 86400000);
    return n.toISOString().slice(0, 10);
  }
  if (frequencia === 'anual') {
    const mesAno = d.getUTCMonth() === 1 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
    return new Date(Date.UTC(mesAno, d.getUTCMonth(), Math.min(28, dia), 12)).toISOString().slice(0, 10);
  }
  // Mensal: primeiro dia do mês seguinte, na data `dia`.
  const m = new Date(Date.UTC(baseD.getUTCFullYear(), baseD.getUTCMonth() + 1, Math.min(28, dia), 12));
  return m.toISOString().slice(0, 10);
}

/** Gera lançamentos das recorrências vencidas (chamado manual ou pelo cron). */
export async function processarRecorrencias(actor: { id: number | null; name: string }): Promise<{ gerados: number; descricoes: string[] }> {
  const s = getStore();
  const r = getResource('recorrencias_financeiras')!;
  const lista = await s.list(r, { page: 1, pageSize: 1000, filter: { status: 'ativo' } });
  const hojeS = hoje();
  const gerados: string[] = [];
  let total = 0;

  for (const rec of lista.rows) {
    const proxima = String(rec.proxima_geracao || calcularProximaGeracao(rec)).slice(0, 10);
    if (proxima > hojeS) continue;

    // Data do lançamento: usa o vencimento da recorrência.
    const data = proxima;
    const categoria = rec.categoria_id ?? null;
    const conta = rec.conta_id ?? null;
    try {
      await s.transaction(async (tx) => {
        const r2 = getResource('lancamentos_financeiros')!;
        const row = await s.insert(
          r2,
          {
            data,
            tipo: String(rec.tipo || 'despesa'),
            categoria_id: categoria,
            conta_id: conta,
            centro_custo_id: rec.centro_custo_id ?? null,
            descricao: String(rec.descricao || 'Lançamento recorrente'),
            valor: Number(rec.valor || 0),
            taxa_pct: 0,
            valor_liquido: Number(rec.valor || 0),
            forma_pagamento: rec.forma_pagamento ?? null,
            status: 'pendente',
            vencimento: data,
            parcela: 1,
            total_parcelas: 1,
            referencia_tipo: 'recorrencia',
            referencia_id: Number(rec.id),
            referencia_recorrencia_id: Number(rec.id),
            observacoes: `Gerado automaticamente (${rec.frequencia})`,
          },
          tx
        );
        await s.audit(
          { usuario_id: actor.id || null, usuario: actor.name || 'Sistema', acao: 'criar', recurso: 'lancamentos_financeiros', registro_id: Number(row.id), descricao: `Lançamento recorrente — ${rec.descricao}`, dados: { recorrencia_id: Number(rec.id), valor: Number(rec.valor || 0) } },
          tx
        );
      });
    } catch (e: any) {
      // Outra execução (cron + botão) gerou a mesma competência primeiro:
      // o índice único (recorrencia, vencimento) barra a duplicata — segue.
      if (e?.code === '23505') continue;
      throw e;
    }

    // Calcula a próxima geração e atualiza a recorrência.
    const prox = calcularProximaGeracao(rec, new Date(`${proxima}T12:00:00Z`));
    await s.update(r, Number(rec.id), { proxima_geracao: prox, ultimo_gerado_em: new Date().toISOString() });

    gerados.push(String(rec.descricao || 'Recorrência'));
    total++;
  }

  return { gerados: total, descricoes: gerados };
}

/** POST /api/financeiro/recorrencias/gerar — gera as recorrências vencidas. */
export async function gerarRecorrencias(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'create');
  checkAccess(getResource('recorrencias_financeiras')!, actor, 'read');
  const out = await processarRecorrencias({ id: actor.id || null, name: actor.name });
  res.json({ ok: true, ...out });
}

/** Endpoint para o cron externo gerar recorrências (autentica por CRON_SECRET). */
export async function cronRecorrencias(req: Request, res: Response) {
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  const secret = process.env.CRON_SECRET || '';
  if (secret && token !== secret) throw new HttpError(401, 'Token inválido.');
  const out = await processarRecorrencias({ id: null, name: 'Agendador' });
  res.json({ ok: true, ...out });
}

// ----------------------------------------------------------------------------
// RENTABILIDADE — margem por produto e por canal
// ----------------------------------------------------------------------------

export async function rentabilidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  checkAccess(getResource('produtos')!, actor, 'read');
  checkAccess(getResource('fichas')!, actor, 'read');
  const s = getStore();
  const [vendasR, produtosR, fichasR, itensR] = await Promise.all([
    s.list(getResource('vendas')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('produtos')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('fichas')!, { page: 1, pageSize: 10000 }),
    s.list(getResource('itens_venda')!, { page: 1, pageSize: 100000 }),
  ]);

  const custoPorProduto = new Map<number, number>();
  for (const p of produtosR.rows) custoPorProduto.set(Number(p.id), Number(p.custo || 0));
  for (const f of fichasR.rows) {
    const id = Number(f.produto_id || 0);
    const custoFicha = Number(f.custo_calculado || 0);
    if (id && custoFicha > 0) custoPorProduto.set(id, custoFicha);
  }
  const nomeProduto = new Map(produtosR.rows.map((p) => [Number(p.id), labelOf(getResource('produtos')!, p)]));

  const vendas = vendasR.rows.filter((v) => ['faturada', 'entregue'].includes(String(v.status)));
  const porProduto = new Map<number, { produto: string; receita: number; cmv: number; margem: number; quantidade: number }>();
  const porCanal = new Map<string, { canal: string; receita: number; cmv: number; margem: number; quantidade: number }>();
  let receitaTotal = 0;
  let cmvTotal = 0;
  let qtdTotal = 0;

  for (const v of vendas) {
    const canal = String(v.canal_venda || 'balcao');
    for (const item of itensR.rows.filter((i) => Number(i.venda_id) === Number(v.id))) {
      const pid = Number(item.produto_id || 0);
      const qtd = Number(item.quantidade || 0);
      const preco = Number(item.subtotal || (item.preco_unitario || 0) * qtd);
      const custoU = custoPorProduto.get(pid) || 0;
      const custo = r2(custoU * qtd);
      const margem = r2(preco - custo);
      receitaTotal += preco;
      cmvTotal += custo;
      qtdTotal += qtd;

      const p = porProduto.get(pid) || { produto: nomeProduto.get(pid) || `#${pid}`, receita: 0, cmv: 0, margem: 0, quantidade: 0 };
      p.receita += preco;
      p.cmv += custo;
      p.margem += margem;
      p.quantidade += qtd;
      porProduto.set(pid, p);

      const c = porCanal.get(canal) || { canal, receita: 0, cmv: 0, margem: 0, quantidade: 0 };
      c.receita += preco;
      c.cmv += custo;
      c.margem += margem;
      c.quantidade += qtd;
      porCanal.set(canal, c);
    }
  }

  const arredonda = <T extends { receita: number; cmv: number; margem: number; quantidade: number }>(x: T): T => ({ ...x, receita: r2(x.receita), cmv: r2(x.cmv), margem: r2(x.margem), margem_pct: x.receita > 0 ? r2((x.margem / x.receita) * 100) : 0 } as T & { margem_pct: number });

  res.json({
    receitaTotal: r2(receitaTotal),
    cmvTotal: r2(cmvTotal),
    margemTotal: r2(receitaTotal - cmvTotal),
    margemPctTotal: receitaTotal > 0 ? r2(((receitaTotal - cmvTotal) / receitaTotal) * 100) : 0,
    quantidadeTotal: qtdTotal,
    porProduto: [...porProduto.values()].map(arredonda).sort((a, b) => b.receita - a.receita),
    porCanal: [...porCanal.values()].map(arredonda).sort((a, b) => b.receita - a.receita),
  });
}

// ----------------------------------------------------------------------------
// INVESTIDORES — resumo de aportes, participação e distribuição
// ----------------------------------------------------------------------------

export async function resumoInvestidores(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('investidores')!, actor, 'read');
  checkAccess(getResource('aportes')!, actor, 'read');
  const s = getStore();
  const [investR, aportesR] = await Promise.all([
    s.list(getResource('investidores')!, { page: 1, pageSize: 5000 }),
    s.list(getResource('aportes')!, { page: 1, pageSize: 10000 }),
  ]);

  const confirmados = aportesR.rows.filter((a) => String(a.status) === 'confirmado');
  const porInvestidor = investR.rows.map((inv) => {
    const id = Number(inv.id);
    const doInv = confirmados.filter((a) => Number(a.investidor_id) === id);
    const aportes = doInv.filter((a) => String(a.tipo) !== 'distribuicao_lucro');
    const distribuicao = doInv.filter((a) => String(a.tipo) === 'distribuicao_lucro');
    const totalAportado = somaMoeda(aportes.map((a) => Number(a.valor || 0)));
    const totalDistribuido = somaMoeda(distribuicao.map((a) => Number(a.valor || 0)));
    return {
      id,
      nome: labelOf(getResource('investidores')!, inv),
      tipo: String(inv.tipo || 'investidor'),
      participacao_pct: Number(inv.participacao_pct || 0),
      totalAportado,
      totalDistribuido,
      posicao: r2(totalAportado - totalDistribuido),
      quantidadeAportes: aportes.length,
      ultimoAporte: doInv.length ? String(doInv[doInv.length - 1].data || '') : null,
    };
  });

  res.json({
    totalInvestido: somaMoeda(confirmados.filter((a) => String(a.tipo) !== 'distribuicao_lucro').map((a) => Number(a.valor || 0))),
    totalDistribuido: somaMoeda(confirmados.filter((a) => String(a.tipo) === 'distribuicao_lucro').map((a) => Number(a.valor || 0))),
    aportesNoMes: somaMoeda(confirmados.filter((a) => String(a.data || '').slice(0, 7) === hoje().slice(0, 7)).map((a) => Number(a.valor || 0))),
    porInvestidor: porInvestidor.sort((a, b) => b.totalAportado - a.totalAportado),
  });
}

// ----------------------------------------------------------------------------
// CONCILIAÇÃO BANCÁRIA — importar extrato e casar com lançamentos pendentes
// ----------------------------------------------------------------------------

/** Extrai os lançamentos de um extrato OFX (Internet Banking) colado. */
function parseOFX(conteudo: string): { data: string; valor: number; descricao: string }[] {
  const linhas: { data: string; valor: number; descricao: string }[] = [];
  const blocos = conteudo.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/STMTTRN>|$)/gi) || [];
  for (const bloco of blocos) {
    const dataM = bloco.match(/<DTPOSTED>(\d{8})/i);
    const valorM = bloco.match(/<TRNAMT>(-?[\d]+(?:\.\d+)?)/i);
    const descM = bloco.match(/<NAME>([^<]+)/i) || bloco.match(/<MEMO>([^<]+)/i);
    if (!valorM) continue;
    const valor = Math.abs(Number(valorM[1]));
    if (!Number.isFinite(valor) || valor <= 0) continue;
    const data = dataM ? `${dataM[1].slice(0, 4)}-${dataM[1].slice(4, 6)}-${dataM[1].slice(6, 8)}` : '';
    linhas.push({ data, valor: r2(valor), descricao: descM ? descM[1].trim() : '' });
  }
  return linhas;
}

/** Verdadeiro quando o conteúdo parece um arquivo OFX/SGML de extrato. */
function pareceOFX(conteudo: string): boolean {
  return /OFXHEADER|<OFX>/i.test(conteudo);
}

function parseLinhasExtrato(body: Record<string, unknown>): { data: string; valor: number; descricao: string }[] {
  const textoCompleto = String(body.texto || body.csv || body.extrato || body.ofx || '');
  if (pareceOFX(textoCompleto)) return parseOFX(textoCompleto);
  const linhas: { data: string; valor: number; descricao: string }[] = [];
  const add = (d: unknown, v: unknown, desc: unknown) => {
    const valor = Math.abs(Number(String(v).replace(',', '.').replace(/[^\d.-]/g, '')));
    if (!isFinite(valor) || valor <= 0) return;
    const data = String(d || '').trim().slice(0, 10);
    linhas.push({ data, valor: r2(valor), descricao: String(desc || '').trim() });
  };

  const raw = body.linhas;
  if (Array.isArray(raw)) {
    for (const l of raw as Record<string, unknown>[]) add(l.data, l.valor, l.descricao || l.desc || l.texto);
    return linhas;
  }
  const texto = String(body.texto || body.csv || body.extrato || '');
  for (const line of texto.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // formato flexível: data;valor;descricao  ou  valor;descricao  ou valor,descricao
    const parts = t.split(/[;,\t]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 3) add(parts[0], parts[1], parts.slice(2).join(' '));
    else if (parts.length === 2) {
      const v = Number(parts[0].replace(',', '.'));
      if (isFinite(v) && /^[\d.,]+$/.test(parts[0])) add(hoje(), parts[0], parts[1]);
      else add(parts[0], parts[1], '');
    }
  }
  return linhas;
}

export async function conciliarExtrato(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const s = getStore();
  const conteudoBruto = String(req.body?.texto || req.body?.csv || req.body?.extrato || req.body?.ofx || '');
  const fonte = pareceOFX(conteudoBruto) ? 'OFX' : 'texto/CSV';
  const linhas = parseLinhasExtrato(req.body || {});
  if (linhas.length === 0) throw new HttpError(400, 'Nenhuma linha válida. Use: data;valor;descrição — ou cole um extrato OFX do Internet Banking.');

  const contaId = req.body.conta_id ?? null;
  const formaPagamento = req.body.forma_pagamento ?? null;
  const lancR = await s.list(getResource('lancamentos_financeiros')!, { page: 1, pageSize: 100000 });
  const pendentes = lancR.rows.filter((l) => String(l.status) === 'pendente' && ['receita', 'despesa'].includes(String(l.tipo)));

  const confirmados: { data: string; valor: number; descricao: string; lancamento_id: number }[] = [];
  const naoConfirmados: { data: string; valor: number; descricao: string; motivo: string }[] = [];

  for (const linha of linhas) {
    const valor = Number(linha.valor);
    const buscaDesc = (linha.descricao || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    let cand = pendentes.filter((l) => Math.abs(Number(l.valor || 0) - valor) < 0.01);
    // Extrato de operadora (Mercado Pago/cartão) mostra o valor já sem taxa:
    // casa também pelo valor líquido registrado no lançamento.
    if (cand.length === 0) cand = pendentes.filter((l) => Math.abs(liquidoDe(l) - valor) < 0.01);
    if (linha.data) cand = cand.filter((l) => String(l.vencimento || l.data || '').slice(0, 10) === linha.data);
    if (buscaDesc && cand.length > 1) {
      const sobreDesc = cand.filter((l) => buscaDesc.includes(String(l.descricao || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()) || String(l.descricao || '').toLowerCase().includes(buscaDesc));
      if (sobreDesc.length) cand = sobreDesc;
    }
    if (cand.length !== 1) {
      naoConfirmados.push({ ...linha, motivo: cand.length === 0 ? 'Nenhum lançamento pendente com esse valor/data.' : 'Mais de um lançamento compatível — confira manualmente.' });
      continue;
    }

    const l = cand[0];
    const id = Number(l.id);
    await s.update(getResource('lancamentos_financeiros')!, id, {
      status: 'confirmado',
      conta_id: contaId ?? l.conta_id ?? null,
      forma_pagamento: formaPagamento ?? l.forma_pagamento ?? null,
      observacoes: [String(l.observacoes || ''), `Conciliado em ${hoje()} (extrato ${fonte})`].filter(Boolean).join('\n'),
    });
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'lancamentos_financeiros',
        registro_id: id,
        descricao: `Lançamento conciliado pelo extrato — ${l.descricao}`,
        dados: { conciliado: true, valor: Number(l.valor || 0) },
      }
    );

    // mantém a fonte (venda/compra) consistente
    const tipoRef = String(l.referencia_tipo || '');
    const refId = Number(l.referencia_id || 0);
    if (tipoRef === 'venda' && refId) {
      await s.update(getResource('vendas')!, refId, { fin_status: 'recebido', fin_recebido_em: linha.data || hoje() });
    } else if (tipoRef === 'compra' && refId) {
      await s.update(getResource('compras')!, refId, { fin_status: 'pago', fin_pago_em: linha.data || hoje() });
    }

    pendentes.splice(pendentes.indexOf(l), 1);
    confirmados.push({ data: linha.data || String(l.data || ''), valor, descricao: String(l.descricao || ''), lancamento_id: id });
  }

  res.json({ ok: true, totalLinhas: linhas.length, confirmados, naoConfirmados });
}

// ----------------------------------------------------------------------------
// BAIXA DEDICADA — receber/pagar um lançamento pendente com juros, multa e
// desconto, sem editar a origem (venda/compra). O valor da origem permanece:
// o acerto acontece por LANÇAMENTOS FILHOS ('baixa'), que mantêm o extrato e
// o DRE exatos (caixa bate centavo a centavo com o que entrou/saiu da conta).
// ----------------------------------------------------------------------------

export async function baixarLancamento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('lancamentos_financeiros')!, actor, 'update');
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'Lançamento inválido.');

  const body = req.body || {};
  const juros = Number(body.juros || 0);
  const multa = Number(body.multa || 0);
  const desconto = Number(body.desconto || 0);
  for (const [nome, v] of [['juros', juros], ['multa', multa], ['desconto', desconto]] as const) {
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Informe ${nome} maior ou igual a zero.`, { [nome]: 'Valor inválido' });
  }
  // Baixa parcial: valor informado < valor do título → recebe/paga parte e o
  // principal continua pendente com o saldo restante (rastreado no título).
  const temValorParcial = body.valor !== undefined && body.valor !== null && body.valor !== '';
  const valorParcial = temValorParcial ? Number(String(body.valor).replace(',', '.')) : null;
  if (valorParcial !== null && (!Number.isFinite(valorParcial) || valorParcial <= 0)) {
    throw new HttpError(400, 'Informe o valor da baixa parcial maior que zero.', { valor: 'Valor inválido' });
  }
  const dataBaixa = String(body.data || hoje()).slice(0, 10);

  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    const lancR = getResource('lancamentos_financeiros')!;
    const lanc = await s.get(lancR, id, tx);
    if (!lanc) throw new HttpError(404, 'Lançamento não encontrado.');
    if (String(lanc.status) !== 'pendente') {
      throw new HttpError(409, `Apenas lançamentos pendentes podem ser baixados (este está "${String(lanc.status)}").`);
    }
    const tipo = String(lanc.tipo);
    if (!['receita', 'despesa'].includes(tipo)) throw new HttpError(400, 'Baixa aplicável apenas a receitas e despesas.');
    if (ehTransferencia(lanc)) throw new HttpError(400, 'Transferências são gerenciadas pelo módulo Transferências.');

    const contaBaixa = body.conta_id ?? lanc.conta_id ?? null;
    const formaBaixa = body.forma_pagamento ?? lanc.forma_pagamento ?? null;
    const jurosMulta = r2(juros + multa);
    const filhos: number[] = [];
    const valorTitulo = Number(lanc.valor || 0);
    const ehParcial = valorParcial !== null && valorParcial < valorTitulo;

    // 1) Principal: baixa total confirma; baixa parcial reduz o título e ele
    //    segue pendente pelo saldo restante (o recebido sai em lançamento filho).
    const restante = ehParcial ? r2(valorTitulo - Number(valorParcial)) : 0;
    const notas = [
      String(lanc.observacoes || ''),
      ehParcial
        ? `Baixa parcial em ${dataBaixa}: ${formatoMoeda(Number(valorParcial))} · restante ${formatoMoeda(restante)} · por ${actor.name || '—'}`
        : `Baixa em ${dataBaixa}${jurosMulta > 0 ? ` · juros/multa ${formatoMoeda(jurosMulta)}` : ''}${desconto > 0 ? ` · desconto ${formatoMoeda(desconto)}` : ''} · por ${actor.name || '—'}`,
    ].filter(Boolean);
    const atualizado = await atualizarLancamento(
      id,
      ehParcial
        ? { ...lanc, valor: restante, valor_liquido: calcularLiquido(restante, Number(lanc.taxa_pct || 0)), conta_id: contaBaixa, forma_pagamento: formaBaixa, observacoes: notas.join('\n') }
        : { ...lanc, status: 'confirmado', conta_id: contaBaixa, forma_pagamento: formaBaixa, observacoes: notas.join('\n') },
      actor,
      tx
    );

    // Baixa parcial: o valor efetivamente movimentado sai em lançamento filho
    // confirmado na mesma categoria (DRE coerente), com o saldo no histórico.
    if (ehParcial) {
      const parcial = await criarLancamento(
        {
          data: dataBaixa,
          tipo,
          categoria_id: lanc.categoria_id ?? null,
          centro_custo_id: lanc.centro_custo_id ?? null,
          conta_id: contaBaixa,
          descricao: `${tipo === 'receita' ? 'Recebimento' : 'Pagamento'} parcial — ${String(lanc.descricao)} · restante ${formatoMoeda(restante)}`,
          valor: r2(Number(valorParcial)),
          taxa_pct: 0,
          valor_liquido: r2(Number(valorParcial)),
          forma_pagamento: formaBaixa,
          status: 'confirmado',
          referencia_tipo: 'baixa',
          referencia_id: id,
          observacoes: `Baixa parcial do lançamento #${id} (título de ${formatoMoeda(valorTitulo)})`,
        },
        actor,
        tx
      );
      filhos.push(Number(parcial.id));
    }

    // 2) Filhotes do acerto: caixa e DRE batem com o extrato.
    const catRecFin = (await categoriaPorClasse('receitas_financeiras', tx)) ?? (await categoriaPadrao('receita', tx));
    const catDespFin = (await categoriaPorClasse('despesas_financeiras', tx)) ?? (await categoriaPadrao('despesa', tx));
    if (jurosMulta > 0) {
      const filho = await criarLancamento(
        {
          data: dataBaixa,
          tipo,
          categoria_id: tipo === 'receita' ? catRecFin?.id ?? null : catDespFin?.id ?? null,
          conta_id: contaBaixa,
          descricao: `${tipo === 'receita' ? 'Juros/multa recebidos' : 'Juros/multa pagos'} — ${String(lanc.descricao)}`,
          valor: jurosMulta,
          taxa_pct: 0,
          valor_liquido: jurosMulta,
          forma_pagamento: formaBaixa,
          status: 'confirmado',
          referencia_tipo: 'baixa',
          referencia_id: id,
          observacoes: `Gerado na baixa do lançamento #${id}`,
        },
        actor,
        tx
      );
      filhos.push(Number(filho.id));
    }
    // Desconto abate dívida: só faz sentido na quitação total (na parcial
    // ele inflaria o saldo restante além do valor do título).
    if (desconto > 0 && ehParcial) {
      throw new HttpError(400, 'Na baixa parcial não cabe desconto — aplique-o quando quitar o saldo restante do título.', { desconto: 'Use na quitação total' });
    }
    if (desconto > 0) {
      // Desconto em receita = saída financeira; em despesa = ganho financeiro.
      const tipoFilho = tipo === 'receita' ? 'despesa' : 'receita';
      const filho = await criarLancamento(
        {
          data: dataBaixa,
          tipo: tipoFilho,
          categoria_id: tipoFilho === 'receita' ? catRecFin?.id ?? null : catDespFin?.id ?? null,
          conta_id: contaBaixa,
          descricao: `${tipo === 'receita' ? 'Desconto concedido' : 'Desconto obtido'} — ${String(lanc.descricao)}`,
          valor: r2(desconto),
          taxa_pct: 0,
          valor_liquido: r2(desconto),
          forma_pagamento: formaBaixa,
          status: 'confirmado',
          referencia_tipo: 'baixa',
          referencia_id: id,
          observacoes: `Gerado na baixa do lançamento #${id}`,
        },
        actor,
        tx
      );
      filhos.push(Number(filho.id));
    }

    // 3) Mantém a origem consistente (mesma regra do conciliador) — só na
    //    quitação total: com saldo parcial o pedido segue "a receber/a pagar".
    if (!ehParcial) {
      const refTipo = String(lanc.referencia_tipo || '');
      const refId = Number(lanc.referencia_id || 0);
      if (refTipo === 'venda' && refId) {
        await s.update(getResource('vendas')!, refId, { fin_status: 'recebido', fin_recebido_em: dataBaixa, fin_conta_id: contaBaixa, fin_forma_pagamento: formaBaixa }, tx);
      } else if (refTipo === 'compra' && refId) {
        await s.update(getResource('compras')!, refId, { fin_status: 'pago', fin_pago_em: dataBaixa, fin_conta_id: contaBaixa, fin_forma_pagamento: formaBaixa }, tx);
      }
    }
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'lancamentos_financeiros',
        registro_id: id,
        descricao: ehParcial
          ? `Baixa parcial — ${String(lanc.descricao)} · recebido ${formatoMoeda(Number(valorParcial))} de ${formatoMoeda(valorTitulo)} · restante ${formatoMoeda(restante)}`
          : `Baixa — ${String(lanc.descricao)} · valor ${formatoMoeda(Number(lanc.valor || 0))}${jurosMulta > 0 ? ` + juros/multa ${formatoMoeda(jurosMulta)}` : ''}${desconto > 0 ? ` − desconto ${formatoMoeda(desconto)}` : ''}`,
        dados: { baixa: true, parcial: ehParcial, data: dataBaixa, valor_pago: ehParcial ? Number(valorParcial) : valorTitulo, restante, juros, multa, desconto, conta_id: contaBaixa, forma_pagamento: formaBaixa, filhos },
      },
      tx
    );
    return { lancamento: atualizado, filhos, parcial: ehParcial, restante };
  });

  res.json({ ok: true, ...resultado });
}

function formatoMoeda(v: number): string {
  return `R$ ${r2(v).toFixed(2).replace('.', ',')}`;
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
        centro_custo_id: body.centro_custo_id ?? null,
        descricao: String(body.descricao).trim(),
        valor: r2(valor),
        taxa_pct: Number(body.taxa_pct || 0),
        forma_pagamento: body.forma_pagamento ?? null,
        status: String(body.status || 'confirmado'),
        vencimento: body.vencimento ? String(body.vencimento).slice(0, 10) : null,
        parcela: Number(body.parcela || 1),
        total_parcelas: Number(body.total_parcelas || 1),
        referencia_tipo: body.referencia_tipo || 'outro',
        referencia_id: body.referencia_id ?? null,
        observacoes: body.observacoes ?? null,
      };
      if (body.valor_liquido !== undefined && body.valor_liquido !== null && body.valor_liquido !== '') data.valor_liquido = Number(body.valor_liquido);
      hookTaxaLancamento(data);
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
