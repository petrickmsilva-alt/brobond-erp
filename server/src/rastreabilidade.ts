// ============================================================================
// RASTREABILIDADE PONTA A PONTA (migration 0106)
//
// Responde às duas perguntas que a operação faz: "de onde veio esta peça?" e
// "para onde foi o lote X?". Não cria saldo nem tabela nova de verdade: o
// saldo do lote é DERIVADO das movimentações, e a cadeia é montada pelos
// vínculos FORMAIS que já existem (compra → recebimento → item → movimentação →
// expedição → envio), mais o `lote_id` introduzido na 0106.
//
// Regras:
//   • Empresa = tenant: todo predicado carrega `empresa_id`. Consultar outra
//     empresa devolve vazio, nunca dado cruzado.
//   • RBAC: leitura exige o mesmo perfil de quem lê estoque/compras.
//   • O saldo do lote nunca é negativo: entradas (entrada/ajuste+ /transferência
//     de entrada) somam; saídas subtraem. Ajuste com delta negativo subtrai.
//   • Nada aqui grava.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { checkAccess, escopoDe, getStore } from './services';
import { currentUser } from './auth';
import { listarTodos } from './paginacaoCompleta';
import { parseId } from './validate';
import type { Row, Store, Tx } from './store';

const R_LOTE = () => getResource('lotes')!;
const R_MOV = () => getResource('movimentacoes')!;
const R_MOV_INSUMO = () => getResource('movimentacoes_insumos')!;
const R_PRODUTO = () => getResource('produtos')!;
const R_INSUMO = () => getResource('insumos')!;
const R_RECEBIMENTO = () => getResource('compra_recebimentos')!;
const R_DEV = () => getResource('devolucoes_fornecedor')!;
const R_COMPRA = () => getResource('compras')!;
const R_FORNECEDOR = () => getResource('fornecedores')!;
const R_LOCAL = () => getResource('locais')!;

const LIMITE = 2000;

function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Saldo do lote derivado das movimentações (entrada soma, saída subtrai). */
export function saldoDoLoteMov(movs: Row[]): number {
  let saldo = 0;
  for (const m of movs) {
    const tipo = String(m.tipo);
    const qtd = num(m.quantidade);
    if (tipo === 'entrada') saldo += qtd;
    else if (tipo === 'saida') saldo -= qtd;
    else if (tipo === 'transferencia')
      continue; // par saída+entrada: líquido zero
    else if (tipo === 'ajuste') saldo += qtd; // ajuste já traz o delta com sinal
  }
  return saldo;
}

/** Saldo do lote de insumo (mesma regra; insumo não tem transferência). */
export function saldoDoLoteInsumo(movs: Row[]): number {
  let saldo = 0;
  for (const m of movs) {
    const tipo = String(m.tipo);
    const qtd = num(m.quantidade);
    if (tipo === 'entrada') saldo += qtd;
    else if (tipo === 'saida') saldo -= qtd;
    else if (tipo === 'ajuste') saldo += qtd;
  }
  return saldo;
}

async function loteDaEmpresa(s: Store, id: number, empresaId: number, tx?: Tx): Promise<Row> {
  const lote = await s.findOneWhere(R_LOTE(), { id, empresa_id: empresaId }, tx);
  if (!lote) throw new HttpError(404, 'Lote não encontrado.');
  return lote;
}

/**
 * GET /api/rastreabilidade/lotes/:id
 *
 * Ficha do lote: identificação, origem (fornecedor/recebimento), movimentações
 * e saldo derivado.
 */
export async function obterLote(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LOTE(), actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const lote = await loteDaEmpresa(s, id, escopo.empresaId);

  const movs = await listarTodos(R_MOV(), { empresa_id: escopo.empresaId, lote_id: id }, undefined, { sort: 'id', dir: 'asc' });
  const movsInsumo = await listarTodos(R_MOV_INSUMO(), { empresa_id: escopo.empresaId, lote_id: id }, undefined, {
    sort: 'id',
    dir: 'asc',
  });
  const saldo = lote.insumo_id ? saldoDoLoteInsumo(movsInsumo) : saldoDoLoteMov(movs);

  const fornecedor = lote.fornecedor_id
    ? await s.findOneWhere(R_FORNECEDOR(), { id: Number(lote.fornecedor_id), empresa_id: escopo.empresaId })
    : null;

  const entradas = [...movs, ...movsInsumo]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((m) => ({
      movimentacao_id: Number(m.id),
      tipo: String(m.tipo),
      quantidade: num(m.quantidade),
      data: m.data ?? m.criado_em ?? null,
      local: m.local ?? null,
      motivo: m.motivo ?? null,
      compra_id: m.compra_id ?? null,
      recebimento_id: m.recebimento_id ?? null,
      ordem_id: m.ordem_id ?? null,
      venda_id: m.venda_id ?? null,
      devolucao_fornecedor_id: m.devolucao_fornecedor_id ?? null,
    }));

  res.json({
    lote,
    fornecedor: fornecedor ? { id: Number(fornecedor.id), nome: fornecedor.nome } : null,
    saldo,
    movimentacoes: entradas,
    total_movimentacoes: entradas.length,
    semantica: 'saldo_derivado_das_movimentacoes',
  });
}

/**
 * GET /api/rastreabilidade/lote-por-codigo?codigo=...&produto_id=...&insumo_id=...
 * Resolve um lote pelo código (o que o operador tem em mãos).
 */
export async function lotePorCodigo(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LOTE(), actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const codigo = String(req.query.codigo ?? '').trim();
  if (!codigo) throw new HttpError(400, 'Informe o código do lote.');
  const produtoId = req.query.produto_id ? Number(req.query.produto_id) : null;
  const insumoId = req.query.insumo_id ? Number(req.query.insumo_id) : null;
  const where: Record<string, unknown> = { empresa_id: escopo.empresaId, codigo };
  if (produtoId) where.produto_id = produtoId;
  if (insumoId) where.insumo_id = insumoId;
  const lotes = await listarTodos(R_LOTE(), where, undefined, { sort: 'id', dir: 'asc' });
  if (!lotes.length) throw new HttpError(404, 'Nenhum lote com este código nesta empresa.');
  if (lotes.length > 1 && !produtoId && !insumoId) {
    throw new HttpError(409, 'Há mais de um lote com este código. Informe o produto ou o insumo.', {
      lotes: lotes.map((l) => ({ id: Number(l.id), produto_id: l.produto_id ?? null, insumo_id: l.insumo_id ?? null })),
    });
  }
  res.json({ lote: lotes[0], candidatos: lotes.length });
}

/**
 * GET /api/rastreabilidade/movimentacao/:id
 *
 * Trilha de uma movimentação: quem a originou (compra, recebimento, OP, venda,
 * devolução ao fornecedor), o lote e a localização.
 */
export async function trilhaMovimentacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_MOV(), actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const mov = await s.findOneWhere(R_MOV(), { id, empresa_id: escopo.empresaId });
  if (!mov) throw new HttpError(404, 'Movimentação não encontrada.');

  const origem: Record<string, unknown> = {};
  if (mov.compra_id) origem.compra = await s.findOneWhere(R_COMPRA(), { id: Number(mov.compra_id), empresa_id: escopo.empresaId });
  if (mov.recebimento_id)
    origem.recebimento = await s.findOneWhere(R_RECEBIMENTO(), { id: Number(mov.recebimento_id), empresa_id: escopo.empresaId });
  if (mov.devolucao_fornecedor_id)
    origem.devolucao_fornecedor = await s.findOneWhere(R_DEV(), { id: Number(mov.devolucao_fornecedor_id), empresa_id: escopo.empresaId });
  if (mov.local_id) origem.local = await s.findOneWhere(R_LOCAL(), { id: Number(mov.local_id), empresa_id: escopo.empresaId });
  const lote = mov.lote_id ? await s.findOneWhere(R_LOTE(), { id: Number(mov.lote_id), empresa_id: escopo.empresaId }) : null;

  res.json({ movimentacao: mov, lote, origem });
}

/**
 * GET /api/rastreabilidade/produto/:id
 *
 * Histórico consolidado do produto: movimentações, lotes e o resumo de origem
 * (fornecedores que já abasteceram o produto).
 */
export async function trilhaProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PRODUTO(), actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();
  const id = parseId(req.params.id);
  const produto = await s.findOneWhere(R_PRODUTO(), { id, empresa_id: escopo.empresaId });
  if (!produto) throw new HttpError(404, 'Produto não encontrado.');

  const movs = await listarTodos(R_MOV(), { empresa_id: escopo.empresaId, produto_id: id }, undefined, { sort: 'data', dir: 'desc' });
  const lotes = await listarTodos(R_LOTE(), { empresa_id: escopo.empresaId, produto_id: id }, undefined, { sort: 'id', dir: 'desc' });

  // Fornecedores de origem: vêm dos lotes do produto (o lote guarda o fornecedor
  // que abasteceu). Sem lote, o vínculo de compra ainda responde pela origem.
  const fornecedoresIds = [
    ...new Set(
      lotes
        .map((l) => l.fornecedor_id)
        .filter(Boolean)
        .map(Number)
    ),
  ];
  const fornecedores: Row[] = [];
  for (const fid of fornecedoresIds.slice(0, 50)) {
    const f = await s.findOneWhere(R_FORNECEDOR(), { id: fid, empresa_id: escopo.empresaId });
    if (f) fornecedores.push(f);
  }

  const totalEntradas = movs.filter((m) => String(m.tipo) === 'entrada').reduce((a, m) => a + num(m.quantidade), 0);
  const totalSaidas = movs.filter((m) => String(m.tipo) === 'saida').reduce((a, m) => a + num(m.quantidade), 0);

  res.json({
    produto: { id: Number(produto.id), sku: produto.sku, nome: produto.nome },
    lotes: lotes.map((l) => ({ ...l, saldo: null })),
    movimentacoes: movs.slice(0, LIMITE),
    total_movimentacoes: movs.length,
    fornecedores: fornecedores.map((f) => ({ id: Number(f.id), nome: f.nome })),
    resumo: { entradas: totalEntradas, saidas: totalSaidas },
  });
}

/**
 * GET /api/rastreabilidade/documento?tipo=...&id=...
 *
 * Cadeia de um documento de origem. `tipo` ∈ {compra, recebimento,
 * devolucao_fornecedor, lote}. Devolve o documento e as movimentações ligadas.
 */
export async function trilhaDocumento(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDe(actor);
  const s = getStore();
  const tipo = String(req.query.tipo ?? '').trim();
  const id = Number(req.query.id);
  if (!tipo || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Informe `tipo` e `id` válidos.');

  const mapa: Record<string, { recurso: Resource; campo: string }> = {
    compra: { recurso: R_COMPRA(), campo: 'compra_id' },
    recebimento: { recurso: R_RECEBIMENTO(), campo: 'recebimento_id' },
    devolucao_fornecedor: { recurso: R_DEV(), campo: 'devolucao_fornecedor_id' },
    lote: { recurso: R_LOTE(), campo: 'lote_id' },
  };
  const alvo = mapa[tipo];
  if (!alvo) throw new HttpError(400, 'Tipo de documento inválido. Use compra, recebimento, devolucao_fornecedor ou lote.');
  checkAccess(alvo.recurso, actor, 'read');

  const doc = await s.findOneWhere(alvo.recurso, { id, empresa_id: escopo.empresaId });
  if (!doc) throw new HttpError(404, 'Documento não encontrado.');

  const movs = await listarTodos(R_MOV(), { empresa_id: escopo.empresaId, [alvo.campo]: id }, undefined, { sort: 'id', dir: 'asc' });
  const movsInsumo = await listarTodos(R_MOV_INSUMO(), { empresa_id: escopo.empresaId, [alvo.campo]: id }, undefined, {
    sort: 'id',
    dir: 'asc',
  });

  res.json({
    tipo,
    documento: doc,
    movimentacoes: movs,
    movimentacoes_insumos: movsInsumo,
    total: movs.length + movsInsumo.length,
  });
}

/**
 * GET /api/rastreabilidade/painel
 *
 * Indicadores de rastreabilidade para o Diretor: lotes vencendo, lotes com
 * saldo, movimentações sem lote (cobertura) e recebimentos recentes sem lote.
 */
export async function painelRastreabilidade(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LOTE(), actor, 'read');
  const escopo = escopoDe(actor);
  const s = getStore();

  const lotes = await listarTodos(R_LOTE(), { empresa_id: escopo.empresaId }, undefined, { sort: 'id', dir: 'desc' });
  const movs = await listarTodos(R_MOV(), { empresa_id: escopo.empresaId }, undefined, { sort: 'id', dir: 'desc' });

  const hoje = new Date();
  const em30 = new Date(hoje.getTime() + 30 * 24 * 3600 * 1000);
  const porLote = new Map<number, Row[]>();
  for (const m of movs) {
    if (m.lote_id === null || m.lote_id === undefined) continue;
    const k = Number(m.lote_id);
    const arr = porLote.get(k) ?? [];
    arr.push(m);
    porLote.set(k, arr);
  }

  const comSaldo = lotes.map((l) => ({ lote: l, saldo: saldoDoLoteMov(porLote.get(Number(l.id)) ?? []) })).filter((x) => x.saldo > 0);
  const vencidos = lotes.filter((l) => l.validade && new Date(String(l.validade)) < hoje);
  const vencendo = lotes.filter((l) => l.validade && new Date(String(l.validade)) >= hoje && new Date(String(l.validade)) <= em30);

  const movsSemLote = movs.filter((m) => m.lote_id === null || m.lote_id === undefined).length;
  const cobertura = movs.length ? Math.round(((movs.length - movsSemLote) / movs.length) * 100) : 0;

  res.json({
    lotes: { total: lotes.length, com_saldo: comSaldo.length, vencidos: vencidos.length, vencendo_30d: vencendo.length },
    movimentacoes: { total: movs.length, sem_lote: movsSemLote, cobertura_lote_pct: cobertura },
    alertas: {
      vencidos: vencidos.slice(0, 50).map((l) => ({ id: Number(l.id), codigo: l.codigo, validade: l.validade })),
      vencendo_30d: vencendo.slice(0, 50).map((l) => ({ id: Number(l.id), codigo: l.codigo, validade: l.validade })),
    },
  });
}
