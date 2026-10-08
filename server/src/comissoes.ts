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
import { escopoDoAtor, aplicarFiltroEmpresa, assertRegistroDaEmpresa, EMPRESA_PADRAO } from './empresa';
import { round2, somaMoeda } from './utils';
import type { Row, Tx } from './store';

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
): Promise<Row | null> {
  const s = getStore();
  const vendaId = Number(venda.id);
  const comissaoApurada = Number(venda.comissao_valor || 0);
  const totalVenda = Number(venda.total || 0);
  if (!venda.representante_id || !(comissaoApurada > 0) || !(totalVenda > 0)) return null;
  if (!(valorRecebido > 0)) return null;

  // Guarda de saldo: nunca efetivar além da apuração congelada. A proteção
  // contra o MESMO recebimento rodar duas vezes vem da baixa (status pendente).
  const jaEfetivado = await comissaoEfetivadaDaVenda(vendaId, tx);
  const saldo = round2(comissaoApurada - jaEfetivado);
  if (!(saldo > 0)) return null;
  const fracao = Math.min(1, valorRecebido / totalVenda);
  const valor = round2(Math.min(saldo, comissaoApurada * fracao));
  if (!(valor > 0)) return null;

  const evento = await s.insert(
    R_COMISSOES_EVENTOS,
    {
      empresa_id: empresaDe(venda),
      venda_id: vendaId,
      representante_id: Number(venda.representante_id),
      lancamento_id: lancamentoId,
      tipo: 'realizada',
      base: round2(valorRecebido),
      pct: round2(Number(venda.comissao_pct || 0)),
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
      descricao: `Comissão efetivada — venda #${vendaId} · ${valor.toFixed(2)} (${origem})`,
      empresa_id: empresaDe(venda),
      dados: { venda_id: vendaId, lancamento_id: lancamentoId, valor, base: round2(valorRecebido), origem },
    },
    tx
  );
  return evento;
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
): Promise<Row | null> {
  const s = getStore();
  const vendaId = Number(venda.id);
  const totalVenda = Number(venda.total || 0);
  if (!(totalVenda > 0)) return null;
  const jaEfetivado = await comissaoEfetivadaDaVenda(vendaId, tx);
  if (!(jaEfetivado > 0)) return null;
  const repetido = await s.findOneWhere(R_COMISSOES_EVENTOS, { venda_id: vendaId, tipo: 'estornada', origem }, tx);
  if (repetido) return repetido;

  // No CANCELAMENTO a venda já teve comissao_valor/comissao_pct zerados ANTES
  // deste estorno rodar — a apuração real sai do próprio livro. Nas demais
  // origens (ex.: estorno parcial de gateway) usa-se a apuração da venda.
  const comissaoApurada = Number(venda.comissao_valor || 0);
  const apuradaEfetiva = comissaoApurada > 0 ? comissaoApurada : jaEfetivado;
  let pct = Number(venda.comissao_pct || 0);
  if (!(pct > 0)) {
    const realizadas = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 50, filter: { venda_id: vendaId, tipo: 'realizada' } }, tx);
    const primeira = realizadas.rows[0];
    if (primeira) pct = Number(primeira.pct || 0);
  }

  const fracao = Math.min(1, Math.max(0, Number(valorBaseEstornado || 0)) / totalVenda);
  const valor = round2(Math.min(jaEfetivado, apuradaEfetiva * fracao));
  if (!(valor > 0)) return null;

  const evento = await s.insert(
    R_COMISSOES_EVENTOS,
    {
      empresa_id: empresaDe(venda),
      venda_id: vendaId,
      representante_id: venda.representante_id ? Number(venda.representante_id) : null,
      lancamento_id: null,
      tipo: 'estornada',
      base: round2(Number(valorBaseEstornado || 0)),
      pct: round2(pct),
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
      descricao: `Comissão estornada — venda #${vendaId} · ${valor.toFixed(2)} (${origem}: ${motivo})`,
      empresa_id: empresaDe(venda),
      dados: { venda_id: vendaId, valor, base: round2(Number(valorBaseEstornado || 0)), origem, motivo },
    },
    tx
  );
  return evento;
}

/** Cancelamento da venda: estorna TUDO que já foi efetivado dela. */
export async function estornarComissoesDaVenda(
  venda: Row,
  actor: { id: number | null; name: string },
  motivo: string,
  tx: Tx
): Promise<Row | null> {
  return registrarEstornoComissao(venda, Number(venda.total || 0), 'cancelamento', motivo, actor, tx);
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
  const s = getStore();
  const de = req.query.de ? String(req.query.de).slice(0, 10) : null;
  const ate = req.query.ate ? String(req.query.ate).slice(0, 10) : null;

  const rVendas = getResource('vendas')!;
  const rReps = getResource('representantes')!;
  const [vendasR, repsR, eventosR] = await Promise.all([
    s.list(rVendas, { page: 1, pageSize: 10000, filter: aplicarFiltroEmpresa(rVendas, undefined, escopo) }),
    s.list(rReps, { page: 1, pageSize: 1000, filter: aplicarFiltroEmpresa(rReps, undefined, escopo) }),
    s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 50000, filter: aplicarFiltroEmpresa(R_COMISSOES_EVENTOS, undefined, escopo) }),
  ]);

  const repNome = new Map(repsR.rows.map((r) => [Number(r.id), labelOf(rReps, r)]));
  const noPeriodo = (d: unknown) => {
    const ds = String(d || '').slice(0, 10);
    if (!ds) return false;
    return (!de || ds >= de) && (!ate || ds <= ate);
  };

  const porRep = new Map<number, { representante_id: number; representante: string; apurada: number; efetivada: number; estornada: number; vendas: number }>();
  const linhaDe = (rid: number) => {
    const l = porRep.get(rid) || { representante_id: rid, representante: repNome.get(rid) || `#${rid}`, apurada: 0, efetivada: 0, estornada: 0, vendas: 0 };
    porRep.set(rid, l);
    return l;
  };

  // Apuração: vendas faturadas com representante (valor congelado no faturamento).
  for (const v of vendasR.rows) {
    if (!['faturada', 'entregue'].includes(String(v.status))) continue;
    if (!v.representante_id) continue;
    if (!noPeriodo(v.faturada_em || v.data)) continue;
    const l = linhaDe(Number(v.representante_id));
    l.apurada = round2(l.apurada + Number(v.comissao_valor || 0));
    l.vendas += 1;
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
  res.json({
    periodo: { de, ate },
    linhas,
    resumo: {
      apurada: somaMoeda(linhas.map((l) => l.apurada)),
      efetivada: somaMoeda(linhas.map((l) => l.efetivada)),
      estornada: somaMoeda(linhas.map((l) => l.estornada)),
      saldo: somaMoeda(linhas.map((l) => l.saldo)),
    },
  });
}

/** GET /api/financeiro/comissoes/venda/:id — livro de eventos da venda. */
export async function comissoesDaVenda(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'Venda inválida.');
  const s = getStore();
  const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, id), escopo);
  const eventos = await s.list(R_COMISSOES_EVENTOS, { page: 1, pageSize: 500, filter: { venda_id: id } });
  const efetivada = await comissaoEfetivadaDaVenda(id);
  res.json({
    venda_id: id,
    representante_id: venda.representante_id ?? null,
    apurada: Number(venda.comissao_valor || 0),
    pct: Number(venda.comissao_pct || 0),
    efetivada,
    pendente: round2(Number(venda.comissao_valor || 0) - efetivada),
    eventos: eventos.rows.map((e) => ({
      id: Number(e.id),
      tipo: e.tipo,
      base: Number(e.base || 0),
      valor: Number(e.valor || 0),
      origem: e.origem,
      lancamento_id: e.lancamento_id ?? null,
      criado_em: e.criado_em ?? null,
    })),
  });
}
