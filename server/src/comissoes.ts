// ============================================================================
// COMISSÕES — efetivadas conforme RECEBIMENTO da venda.
//
// Regra da especificação (P2 §5): a comissão só é efetivada quando o dinheiro
// da venda entra (baixa, conciliação, pagamento no balcão) — nunca pela mera
// criação do pedido. O congelamento no faturamento (`vendas.comissao_valor`,
// já existente em itens.ts) continua sendo a APURAÇÃO: ali o percentual e a
// base ficam congelados. Este módulo é o LIVRO DE EFETIVAÇÃO:
//
//   • recebimento parcial  → efetiva a parte proporcional ao valor recebido;
//   • quitação             → efetiva o restante (saldo do livro ≤ apuração);
//   • cancelamento         → estorno único do que já foi efetivado;
//   • o mesmo lançamento NUNCA efetiva duas vezes (índice único + saldo).
//
// Nada aqui altera a lógica de congelamento/estorno do faturamento — ela já
// estava correta. O que faltava era o vínculo com o pagamento.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { labelOf } from './store';
import { checkAccess, getStore } from './services';
import { currentUser, type AuthUser } from './auth';
import { escopoDoAtor, aplicarFiltroEmpresa, assertRegistroDaEmpresa, EMPRESA_PADRAO, idCarteiraDoEscopo, type EscopoEmpresa } from './empresa';
import { round2, somaMoeda, diaISO } from './utils';
import { R_COMISSOES_APURADAS } from './comercial';
import type { Row, Tx } from './store';

/**
 * Alçada de COMISSÕES (A06-07): o menu exige gerente/administrador, e o
 * servidor aplica a MESMA regra. Ocultar o item de menu não é autorização —
 * a chamada direta à API precisa ser recusada para operador.
 *
 * A06-14: a exceção é o PRÓPRIO representante. Um usuário vinculado a um
 * representante (`representantes.usuario_id`, resolvido em `escopo.carteira`)
 * pode ler as SUAS comissões — nunca as da empresa inteira. O operador de
 * backoffice SEM vínculo continua recusado, como antes.
 *
 * Devolve o id da carteira a recortar, ou `null` quando o acesso é amplo.
 */
function exigirAcessoComissao(actor: { perfil?: string }, escopo: EscopoEmpresa): number | null {
  if (actor.perfil === 'admin' || actor.perfil === 'gerente') return null;
  const carteira = idCarteiraDoEscopo(escopo);
  if (carteira === null) {
    throw new HttpError(403, 'Apenas gerentes e administradores acessam comissões.');
  }
  return carteira;
}

export const R_COMISSOES_EVENTOS: Resource = {
  key: 'comissoes_eventos',
  table: 'comissoes_eventos',
  label: 'Eventos de comissão',
  singular: 'Evento de comissão',
  labelFields: ['id'],
  internal: true,
  empresa: true,
  ops: { create: false, update: false, delete: false },
  orderBy: { field: 'id', dir: 'asc' },
  fields: [
    { name: 'empresa_id', label: 'Empresa', type: 'integer', readonly: true },
    { name: 'venda_id', label: 'Venda', type: 'integer' },
    { name: 'representante_id', label: 'Representante', type: 'integer' },
    { name: 'lancamento_id', label: 'Lançamento', type: 'integer' },
    { name: 'tipo', label: 'Tipo', type: 'text' },
    { name: 'base', label: 'Base (recebido)', type: 'money' },
    { name: 'pct', label: 'Percentual', type: 'percent' },
    { name: 'valor', label: 'Valor', type: 'money' },
    { name: 'origem', label: 'Origem', type: 'text' },
    { name: 'usuario', label: 'Usuário', type: 'text' },
    { name: 'observacoes', label: 'Observações', type: 'text' },
    { name: 'criado_em', label: 'Criado em', type: 'datetime', readonly: true },
  ],
};

/** Empresa do registro, com fallback para a empresa padrão (linhas antigas). */
function empresaDe(row: Row | null | undefined): number {
  const e = Number(row?.empresa_id || 0);
  return e > 0 ? e : EMPRESA_PADRAO;
}

/**
 * Alvo de efetivação/estorno: uma linha do livro por REPRESENTANTE. A apuração
 * (A06-06) é POR representante; a efetivação precisa acompanhar cada uma — não
 * apenas o principal congelado em `vendas.comissao_valor`.
 */
export type AlvoComissao = {
  representante_id: number;
  valor_apurado: number;
  apurada_id: number | null;
  pct: number;
};

/** Apurações ATIVAS da venda (uma por representante), do motor de comissões. */
async function apuracoesAtivasDaVenda(vendaId: number, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const lista = await s.list(R_COMISSOES_APURADAS, { page: 1, pageSize: 200, filter: { venda_id: vendaId, status: 'apurada' } }, tx);
  return lista.rows;
}

/**
 * Alvos de comissão de uma venda. Preferência: as APURAÇÕES ativas do motor
 * (todos os representantes). Sem apuração (venda legada ou nunca apurada), cai
 * no contrato antigo: representante principal × `vendas.comissao_valor`.
 */
export async function alvosComissaoDaVenda(venda: Row, tx?: Tx): Promise<AlvoComissao[]> {
  const vendaId = Number(venda.id);
  const apuracoes = await apuracoesAtivasDaVenda(vendaId, tx);
  if (apuracoes.length) {
    return apuracoes
      .map((a) => ({
        representante_id: Number(a.representante_id),
        valor_apurado: round2(Number(a.valor || 0)),
        apurada_id: Number(a.id),
        pct: round2(Number(a.percentual || 0)),
      }))
      .filter((a) => a.representante_id > 0 && a.valor_apurado > 0);
  }
  const valor = round2(Number(venda.comissao_valor || 0));
  const rep = Number(venda.representante_id || 0);
  if (!(rep > 0) || !(valor > 0)) return [];
  return [{ representante_id: rep, valor_apurado: valor, apurada_id: null, pct: round2(Number(venda.comissao_pct || 0)) }];
}

/** Σ efetivada de UM representante numa venda (realizada − estornada). */
export async function comissaoEfetivadaDoRepresentante(vendaId: number, representanteId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const lista = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 500, filter: { venda_id: vendaId, representante_id: representanteId } }, tx);
  let saldo = 0;
  for (const e of lista.rows) {
    const v = Number(e.valor || 0);
    saldo = e.tipo === 'estornada' ? saldo - v : saldo + v;
  }
  return round2(saldo);
}

/**
 * Representantes com efetivação registrada na venda (e o respectivo saldo
 * líquido + percentual do último evento). É a fonte de verdade do estorno
 * quando a venda já não carrega `comissao_valor` (cancelamento) — nunca o
 * cadastro do produto.
 */
async function representantesComEfetivacao(vendaId: number, tx?: Tx): Promise<Map<number, { efetivado: number; pct: number }>> {
  const s = getStore();
  const lista = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 1000, filter: { venda_id: vendaId } }, tx);
  const porRep = new Map<number, { efetivado: number; pct: number }>();
  for (const e of lista.rows) {
    const rid = Number(e.representante_id || 0);
    if (!rid) continue;
    const atual = porRep.get(rid) || { efetivado: 0, pct: 0 };
    const v = Number(e.valor || 0);
    atual.efetivado = e.tipo === 'estornada' ? round2(atual.efetivado - v) : round2(atual.efetivado + v);
    if (!atual.pct) atual.pct = round2(Number(e.pct || 0));
    porRep.set(rid, atual);
  }
  return porRep;
}

/** Saldo efetivado da venda: Σ(realizada) − Σ(estornada). */
export async function comissaoEfetivadaDaVenda(vendaId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const lista = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 500, filter: { venda_id: vendaId } }, tx);
  let saldo = 0;
  for (const e of lista.rows) {
    const v = Number(e.valor || 0);
    saldo = e.tipo === 'estornada' ? saldo - v : saldo + v;
  }
  return round2(saldo);
}

/**
 * Efetiva a comissão proporcional a um recebimento.
 *
 * `valorRecebido` é quanto entrou da venda neste evento (baixa parcial ou
 * total, conciliação, pagamento no balcão). O valor efetivado é a fração da
 * apuração congelada (`vendas.comissao_valor`) correspondente à fração do
 * total recebido — sem nunca passar do saldo ainda não efetivado.
 *
 * Idempotente por construção:
 *   1) só roda dentro de uma transição de baixa bem-sucedida — o lançamento
 *      deixa de ser 'pendente' sob guarda atômica, então o MESMO recebimento
 *      não dispara o gancho duas vezes (a mesma parcela pode, legitimamente,
 *      receber mais de um recebimento: baixa parcial + quitação);
 *   2) o valor é limitado pelo saldo do livro (realizada − estornada) — nunca
 *      se efetiva além da apuração congelada no faturamento.
 */
export async function registrarComissaoPorRecebimento(
  venda: Row,
  lancamentoId: number | null,
  valorRecebido: number,
  origem: string,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<Row[]> {
  const s = getStore();
  const vendaId = Number(venda.id);
  const totalVenda = Number(venda.total || 0);
  if (!(totalVenda > 0)) return [];
  if (!(valorRecebido > 0)) return [];

  // A apuração é POR representante (A06-06): cada um tem a própria linha no
  // livro. Sem apuração do motor, cai no principal congelado (compatibilidade).
  const alvos = await alvosComissaoDaVenda(venda, tx);
  if (!alvos.length) return [];

  const fracao = Math.min(1, valorRecebido / totalVenda);
  const eventos: Row[] = [];
  for (const alvo of alvos) {
    // Guarda de saldo POR representante: nunca efetivar além da própria
    // apuração. A proteção contra o MESMO recebimento rodar duas vezes vem da
    // baixa (status pendente).
    const jaEfetivado = await comissaoEfetivadaDoRepresentante(vendaId, alvo.representante_id, tx);
    const saldo = round2(alvo.valor_apurado - jaEfetivado);
    if (!(saldo > 0)) continue;
    const valor = round2(Math.min(saldo, alvo.valor_apurado * fracao));
    if (!(valor > 0)) continue;

    const evento = await s.insert(
      R_COMISSOES_EVENTOS,
      {
        empresa_id: empresaDe(venda),
        venda_id: vendaId,
        representante_id: alvo.representante_id,
        lancamento_id: lancamentoId,
        tipo: 'realizada',
        base: round2(valorRecebido),
        pct: alvo.pct,
        valor,
        origem,
        usuario: actor.name || null,
        observacoes: `Comissão efetivada sobre recebimento de ${round2(valorRecebido).toFixed(2)} (venda total ${totalVenda.toFixed(2)})`,
      },
      tx
    );
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'criar',
        recurso: 'comissoes_eventos',
        registro_id: Number(evento.id),
        descricao: `Comissão efetivada — venda #${vendaId} · representante #${alvo.representante_id} · ${valor.toFixed(2)} (${origem})`,
        empresa_id: empresaDe(venda),
        dados: { venda_id: vendaId, representante_id: alvo.representante_id, lancamento_id: lancamentoId, valor, base: round2(valorRecebido), origem },
      },
      tx
    );
    eventos.push(evento);
  }
  return eventos;
}

/**
 * Estorna comissão efetivada da venda.
 *
 * `valorBaseEstornado` é o valor da venda que deixou de ser recebido
 * (cancelamento = total da venda; estorno de gateway = valor estornado).
 * O estorno é proporcional à apuração e limitado pelo saldo efetivado —
 * nunca fica comissão estornada além da efetivada.
 *
 * Idempotência: para uma MESMA origem, um estorno por venda (verificação +
 * saldo). Cancelamento e estorno de gateway são origens distintas e podem
 * coexistir sem passar do saldo do livro.
 */
export async function registrarEstornoComissao(
  venda: Row,
  valorBaseEstornado: number,
  origem: string,
  motivo: string,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<Row[]> {
  const s = getStore();
  const vendaId = Number(venda.id);
  const totalVenda = Number(venda.total || 0);
  if (!(totalVenda > 0)) return [];
  const repetido = await s.findOneWhere(R_COMISSOES_EVENTOS, { venda_id: vendaId, tipo: 'estornada', origem }, tx);
  if (repetido) return [repetido];

  const alvos = await alvosComissaoDaVenda(venda, tx);
  const fracao = Math.min(1, Math.max(0, Number(valorBaseEstornado || 0)) / totalVenda);
  // Alvos do estorno: as apurações do motor (todos os representantes). No
  // CANCELAMENTO a venda pode já ter `comissao_valor` zerado — nesse caso os
  // alvos vêm do PRÓPRIO LIVRO (quem de fato teve efetivação).
  const doLivro = await representantesComEfetivacao(vendaId, tx);
  const alvosEstorno = alvos.length
    ? alvos.map((a) => ({ representante_id: a.representante_id, valor_apurado: a.valor_apurado, pct: a.pct }))
    : [...doLivro.entries()].map(([representante_id, v]) => ({ representante_id, valor_apurado: v.efetivado, pct: v.pct }));

  const eventos: Row[] = [];
  for (const alvo of alvosEstorno) {
    const jaEfetivado = doLivro.get(alvo.representante_id)?.efetivado ?? (await comissaoEfetivadaDoRepresentante(vendaId, alvo.representante_id, tx));
    if (!(jaEfetivado > 0)) continue;
    const baseReferencia = alvo.valor_apurado > 0 ? alvo.valor_apurado : jaEfetivado;
    const valor = round2(Math.min(jaEfetivado, baseReferencia * fracao));
    if (!(valor > 0)) continue;

    const evento = await s.insert(
      R_COMISSOES_EVENTOS,
      {
        empresa_id: empresaDe(venda),
        venda_id: vendaId,
        representante_id: alvo.representante_id,
        lancamento_id: null,
        tipo: 'estornada',
        base: round2(Number(valorBaseEstornado || 0)),
        pct: alvo.pct,
        valor,
        origem,
        usuario: actor.name || null,
        observacoes: motivo,
      },
      tx
    );
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'criar',
        recurso: 'comissoes_eventos',
        registro_id: Number(evento.id),
        descricao: `Comissão estornada — venda #${vendaId} · representante #${alvo.representante_id} · ${valor.toFixed(2)} (${origem}: ${motivo})`,
        empresa_id: empresaDe(venda),
        dados: { venda_id: vendaId, representante_id: alvo.representante_id, valor, base: round2(Number(valorBaseEstornado || 0)), origem, motivo },
      },
      tx
    );
    eventos.push(evento);
  }
  return eventos;
}

/** Cancelamento da venda: estorna TUDO que já foi efetivado dela. */
export async function estornarComissoesDaVenda(
  venda: Row,
  actor: { id: number | null; name: string },
  motivo: string,
  tx: Tx
): Promise<Row[]> {
  return registrarEstornoComissao(venda, Number(venda.total || 0), 'cancelamento', motivo, actor, tx);
}

/**
 * REAPURAÇÃO PÓS-RECEBIMENTO (A06-06): quando a apuração de uma venda já
 * recebida muda (reapuração do motor, correção de atribuição, etc.), o livro de
 * efetivação precisa de um AJUSTE para fechar — sem sobrescrever histórico.
 *
 * Compara o total JÁ EFETIVADO por representante com a nova apuração:
 *   • a mais  → evento `ajuste` (complemento) até o novo valor;
 *   • a menos → evento `estornada` de origem `ajuste` da diferença;
 *   • novo representante apurado sem efetivação → efetiva a parte recebida
 *     proporcional (a venda já foi recebida integralmente).
 *
 * Idempotente por (venda, representante, origem 'ajuste'): reexecutar sem
 * mudança de apuração não gera novo evento.
 */
export async function reconciliarEfetivacaoAposReapuracao(
  venda: Row,
  actor: { id: number | null; name: string },
  tx: Tx
): Promise<Row[]> {
  const s = getStore();
  const vendaId = Number(venda.id);
  const totalVenda = Number(venda.total || 0);
  if (!(totalVenda > 0)) return [];
  const alvos = await alvosComissaoDaVenda(venda, tx);
  if (!alvos.length) return [];
  const recebido = await totalRecebidoDaVenda(vendaId, tx);
  if (!(recebido > 0)) return [];

  const eventos: Row[] = [];
  for (const alvo of alvos) {
    const jaEfetivado = await comissaoEfetivadaDoRepresentante(vendaId, alvo.representante_id, tx);
    const esperado = round2(alvo.valor_apurado * Math.min(1, recebido / totalVenda));
    const delta = round2(esperado - jaEfetivado);
    if (Math.abs(delta) < 0.01) continue;
    const jaAjustado = await s.findOneWhere(
      R_COMISSOES_EVENTOS,
      { venda_id: vendaId, representante_id: alvo.representante_id, origem: 'ajuste' },
      tx
    );
    if (jaAjustado) continue;
    const tipo = delta > 0 ? 'realizada' : 'estornada';
    const evento = await s.insert(
      R_COMISSOES_EVENTOS,
      {
        empresa_id: empresaDe(venda),
        venda_id: vendaId,
        representante_id: alvo.representante_id,
        lancamento_id: null,
        tipo,
        base: round2(esperado),
        pct: alvo.pct,
        valor: round2(Math.abs(delta)),
        origem: 'ajuste',
        usuario: actor.name || null,
        observacoes: `Ajuste de reapuração pós-recebimento (${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)})`,
      },
      tx
    );
    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'ajuste',
        recurso: 'comissoes_eventos',
        registro_id: Number(evento.id),
        descricao: `Ajuste de comissão — venda #${vendaId} · representante #${alvo.representante_id} · ${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`,
        empresa_id: empresaDe(venda),
        dados: { venda_id: vendaId, representante_id: alvo.representante_id, delta, esperado, efetivado: jaEfetivado },
      },
      tx
    );
    eventos.push(evento);
  }
  return eventos;
}

/** Total recebido da venda (Σ das baixas do livro de efetivação). */
async function totalRecebidoDaVenda(vendaId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const lista = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 500, filter: { venda_id: vendaId } }, tx);
  let recebido = 0;
  for (const e of lista.rows) {
    if (e.tipo === 'realizada' && e.origem !== 'ajuste') recebido = round2(recebido + Number(e.base || 0));
  }
  return recebido;
}

// ----------------------------------------------------------------------------
// Relatório — apuração (faturamento) × efetivação (recebimento)
// ----------------------------------------------------------------------------

/**
 * GET /api/financeiro/comissoes
 * Comissões por representante no período: o que foi APURADO nas vendas
 * faturadas e o que foi de fato EFETIVADO pelos recebimentos (saldo do livro).
 */
export async function resumoComissoes(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  checkAccess(getResource('representantes')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  // A06-07 + A06-14: gerente/admin veem tudo; o representante vê só a própria
  // carteira; o operador de backoffice sem vínculo é recusado.
  const carteira = exigirAcessoComissao(actor, escopo);
  const s = getStore();
  const de = req.query.de ? String(req.query.de).slice(0, 10) : null;
  const ate = req.query.ate ? String(req.query.ate).slice(0, 10) : null;

  const rVendas = getResource('vendas')!;
  const rReps = getResource('representantes')!;
  const [vendasR, repsR, eventosR, apuracoesR] = await Promise.all([
    s.list(rVendas, { page: 1, pageSize: 10000, filter: aplicarFiltroEmpresa(rVendas, undefined, escopo) }),
    s.list(rReps, { page: 1, pageSize: 1000, filter: aplicarFiltroEmpresa(rReps, undefined, escopo) }),
    s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 50000, filter: aplicarFiltroEmpresa(R_COMISSOES_EVENTOS, undefined, escopo) }),
    s.list(R_COMISSOES_APURADAS, { page: 1, pageSize: 50000, filter: { ...aplicarFiltroEmpresa(R_COMISSOES_APURADAS, undefined, escopo), status: 'apurada' } }),
  ]);

  const repNome = new Map(repsR.rows.map((r) => [Number(r.id), labelOf(rReps, r)]));
  const noPeriodo = (d: unknown) => {
    const ds = diaISO(d);
    if (!ds) return false;
    return (!de || ds >= de) && (!ate || ds <= ate);
  };

  const porRep = new Map<number, { representante_id: number; representante: string; apurada: number; efetivada: number; estornada: number; vendas: number }>();
  const linhaDe = (rid: number) => {
    const l = porRep.get(rid) || { representante_id: rid, representante: repNome.get(rid) || `#${rid}`, apurada: 0, efetivada: 0, estornada: 0, vendas: 0 };
    porRep.set(rid, l);
    return l;
  };

  const vendaPorId = new Map(vendasR.rows.map((v) => [Number(v.id), v]));
  const vendasComApuracao = new Set<number>();

  // Apuração POR REPRESENTANTE: quando o motor de comissões tem apuração ativa
  // (A06-06), ela é a fonte — TODOS os representantes, não só o principal.
  // Vendas sem apuração do motor caem no congelado `vendas.comissao_valor`.
  for (const a of apuracoesR.rows) {
    const venda = vendaPorId.get(Number(a.venda_id));
    if (!venda) continue;
    if (!['faturada', 'entregue'].includes(String(venda.status))) continue;
    if (!noPeriodo(venda.faturada_em || venda.data)) continue;
    const rid = Number(a.representante_id || 0);
    if (!rid) continue;
    const l = linhaDe(rid);
    l.apurada = round2(l.apurada + Number(a.valor || 0));
    vendasComApuracao.add(Number(venda.id));
  }
  for (const v of vendasR.rows) {
    if (vendasComApuracao.has(Number(v.id))) continue;
    if (!['faturada', 'entregue'].includes(String(v.status))) continue;
    if (!v.representante_id) continue;
    if (!noPeriodo(v.faturada_em || v.data)) continue;
    const l = linhaDe(Number(v.representante_id));
    l.apurada = round2(l.apurada + Number(v.comissao_valor || 0));
    l.vendas += 1;
  }
  for (const id of vendasComApuracao) {
    const v = vendaPorId.get(id);
    if (v?.representante_id) linhaDe(Number(v.representante_id)).vendas += 1;
  }

  // Efetivação/estorno: saldo do livro no período do evento.
  for (const e of eventosR.rows) {
    if (!noPeriodo(e.criado_em)) continue;
    const rid = Number(e.representante_id || 0);
    if (!rid) continue;
    const l = linhaDe(rid);
    if (e.tipo === 'realizada') l.efetivada = round2(l.efetivada + Number(e.valor || 0));
    else l.estornada = round2(l.estornada + Number(e.valor || 0));
  }

  const linhas = [...porRep.values()].map((l) => ({ ...l, saldo: round2(l.efetivada - l.estornada) }));
  linhas.sort((a, b) => b.efetivada - a.efetivada);
  // A06-14: o representante enxerga apenas a própria linha.
  const visiveis = carteira === null ? linhas : linhas.filter((l) => l.representante_id === carteira);
  res.json({
    periodo: { de, ate },
    linhas: visiveis,
    resumo: {
      apurada: somaMoeda(visiveis.map((l) => l.apurada)),
      efetivada: somaMoeda(visiveis.map((l) => l.efetivada)),
      estornada: somaMoeda(visiveis.map((l) => l.estornada)),
      saldo: somaMoeda(visiveis.map((l) => l.saldo)),
    },
  });
}

/** GET /api/financeiro/comissoes/venda/:id — livro de eventos da venda. */
export async function comissoesDaVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  // A06-07 + A06-14: gerente/admin ou o PRÓPRIO representante (que só vê a sua
  // linha). O operador de backoffice sem vínculo é recusado.
  const carteira = exigirAcessoComissao(actor, escopo);
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'Venda inválida.');
  const s = getStore();
  const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, id), escopo);
  const eventos = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 500, filter: { venda_id: id } });
  const efetivada = await comissaoEfetivadaDaVenda(id);
  // Apuração POR REPRESENTANTE (A06-06): o secundário tem a própria linha no
  // livro. Sem apuração do motor, cai no principal congelado (compatibilidade).
  const alvosTodos = await alvosComissaoDaVenda(venda);
  // A06-14: um representante só acessa o livro de uma venda em que PARTICIPA —
  // nunca o de uma venda de outro (a empresa sozinha não basta).
  if (carteira !== null && !alvosTodos.some((a) => a.representante_id === carteira)) {
    throw new HttpError(404, 'Venda não encontrada.');
  }
  // ...e, quando participa, enxerga apenas a PRÓPRIA linha.
  const alvos = carteira === null ? alvosTodos : alvosTodos.filter((a) => a.representante_id === carteira);
  const apuradaTotal = round2(alvos.reduce((acc, a) => acc + a.valor_apurado, 0));
  const representantes = [] as { representante_id: number; apurada: number; efetivada: number; pendente: number }[];
  for (const alvo of alvos) {
    const efetivadaRep = await comissaoEfetivadaDoRepresentante(id, alvo.representante_id);
    representantes.push({
      representante_id: alvo.representante_id,
      apurada: alvo.valor_apurado,
      efetivada: efetivadaRep,
      pendente: round2(alvo.valor_apurado - efetivadaRep),
    });
  }
  // A06-14: quando é o próprio representante, o cabeçalho e o livro de eventos
  // falam apenas da SUA participação — nunca das linhas dos outros.
  const propria = carteira === null ? null : representantes.find((r) => r.representante_id === carteira) || null;
  const eventosVisiveis = carteira === null ? eventos.rows : eventos.rows.filter((e) => Number(e.representante_id || 0) === carteira);
  res.json({
    venda_id: id,
    representante_id: propria ? propria.representante_id : venda.representante_id ?? null,
    apurada: propria ? propria.apurada : Number(venda.comissao_valor || 0),
    pct: Number(venda.comissao_pct || 0),
    efetivada: propria ? propria.efetivada : efetivada,
    pendente: propria ? propria.pendente : round2(Number(venda.comissao_valor || 0) - efetivada),
    apurada_total: apuradaTotal,
    efetivada_total: propria ? propria.efetivada : efetivada,
    pendente_total: round2(apuradaTotal - (propria ? propria.efetivada : efetivada)),
    representantes,
    eventos: eventosVisiveis.map((e) => ({
      id: Number(e.id),
      representante_id: e.representante_id ?? null,
      tipo: e.tipo,
      base: Number(e.base || 0),
      valor: Number(e.valor || 0),
      origem: e.origem,
      lancamento_id: e.lancamento_id ?? null,
      criado_em: e.criado_em ?? null,
    })),
  });
}
