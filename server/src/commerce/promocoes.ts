// ============================================================================
// COMMERCE OS — PROMOÇÕES E CUPONS (regras de desconto do checkout).
//
// • promoções automáticas por período/mínimo do pedido;
// • cupons por código com validade e limite de uso ATÔMICO (CAS sobre
//   `uso_atual` dentro da transação do pedido — corrida do último cupom
//   só deixa passar uma);
// • promoção e cupom NÃO acumulam (a maior regra vence — regras.ts);
// • consumir no CRIAÇÃO do pedido e liberar no CANCELADO/EXPIRADO.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from '../errors';
import { getStore, checkAccess } from '../services';
import { currentUser } from '../auth';
import { escopoDoAtor, empresaDoRegistroAudit } from '../empresa';
import { getResource } from '../resources';
import type { Row, Tx } from '../store';
import { avaliarCupom, descontoDaRegra, melhorDesconto, round2, type RegraDesconto } from './regras';

const R_PROMOS = () => getResource('commerce_promocoes')!;
const R_CUPONS = () => getResource('commerce_cupons')!;

// ----------------------------------------------------------------------------
// Regras ativas de um dia (usadas pelo checkout)
// ----------------------------------------------------------------------------

function regraDaPromocao(row: Row): RegraDesconto {
  return {
    tipo: String(row.tipo || 'percentual') === 'valor' ? 'valor' : 'percentual',
    valor: Number(row.valor || 0),
    minimoPedido: row.minimo_pedido != null ? Number(row.minimo_pedido) : 0,
  };
}

function regraDoCupom(row: Row): RegraDesconto {
  return {
    tipo: String(row.tipo || 'percentual') === 'valor' ? 'valor' : 'percentual',
    valor: Number(row.valor || 0),
    minimoPedido: row.minimo_pedido != null ? Number(row.minimo_pedido) : 0,
  };
}

/** Melhor promoção automática vigente (maior desconto produzido). */
export async function melhorPromocaoAtiva(
  empresaId: number,
  subtotal: number,
  hoje = new Date(),
  tx?: Tx
): Promise<{ regra: RegraDesconto; nome: string } | null> {
  const s = getStore();
  const out = await s.list(R_PROMOS(), { page: 1, pageSize: 500, filter: { empresa_id: empresaId, ativo: true } }, tx);
  const dia = hoje.toISOString().slice(0, 10);
  let melhor: { regra: RegraDesconto; nome: string; desconto: number } | null = null;
  for (const row of out.rows) {
    const inicio = row.data_inicio ? String(row.data_inicio).slice(0, 10) : null;
    const fim = row.data_fim ? String(row.data_fim).slice(0, 10) : null;
    if (inicio && inicio > dia) continue;
    if (fim && fim < dia) continue;
    const regra = regraDaPromocao(row);
    const desconto = descontoDaRegra(subtotal, regra);
    if (!melhor || desconto > melhor.desconto) melhor = { regra, nome: String(row.nome || ''), desconto };
  }
  return melhor ? { regra: melhor.regra, nome: melhor.nome } : null;
}

/** Cupom por código (escopado na empresa) já validado contra o subtotal. */
export async function avaliarCupomCodigo(
  empresaId: number,
  codigo: string,
  subtotal: number,
  hoje = new Date(),
  tx?: Tx
): Promise<{ ok: true; cupom: Row; regra: RegraDesconto; desconto: number } | { ok: false; erro: string }> {
  const s = getStore();
  const bruto = normalizarCodigo(codigo);
  if (!bruto) return { ok: false, erro: 'Informe o código do cupom.' };
  const row = await s.findOneWhere(R_CUPONS(), { empresa_id: empresaId, codigo: bruto }, tx);
  if (!row) return { ok: false, erro: 'Cupom não encontrado.' };
  const validacao = avaliarCupom(
    {
      ativo: row.ativo !== false,
      validade: (row.validade as string | null) ?? null,
      usoMaximo: row.uso_maximo != null ? Number(row.uso_maximo) : null,
      usoAtual: row.uso_atual != null ? Number(row.uso_atual) : 0,
    },
    subtotal,
    hoje
  );
  if (!validacao.ok) return { ok: false, erro: validacao.erro };
  const regra = regraDoCupom(row);
  const desconto = descontoDaRegra(subtotal, regra);
  return { ok: true, cupom: row, regra, desconto };
}

/** Desconto final do checkout (melhor entre promoção e cupom — nunca ambos). */
export function descontoFinalDoCheckout(
  subtotal: number,
  promocao: { regra: RegraDesconto; nome: string } | null,
  cupom: { ok: true; regra: RegraDesconto; desconto: number; cupom: Row } | { ok: false; erro: string } | null
): { desconto: number; origem: 'promocao' | 'cupom' | null; cupomErro?: string } {
  const resultado = melhorDesconto(subtotal, {
    promocao: promocao?.regra ?? null,
    cupom: cupom && cupom.ok ? cupom.regra : null,
  });
  const saida: { desconto: number; origem: 'promocao' | 'cupom' | null; cupomErro?: string } = { ...resultado };
  if (cupom && !cupom.ok) saida.cupomErro = cupom.erro;
  return saida;
}

// ----------------------------------------------------------------------------
// Consumo / liberação atômica do uso do cupom
// ----------------------------------------------------------------------------

/**
 * Consome 1 uso DENTRO da transação do pedido (revalidando o limite lido no
 * tx). CAS (tryUpdateIf) — a corrida de dois checkouts com o último uso
 * devolve 409 honesto para o segundo.
 */
export async function consumirUsoCupom(empresaId: number, codigo: string, subtotal: number, tx: Tx): Promise<Row> {
  const s = getStore();
  const bruto = normalizarCodigo(codigo);
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const row = await s.findOneWhere(R_CUPONS(), { empresa_id: empresaId, codigo: bruto }, tx);
    if (!row) throw new HttpError(409, 'Cupom não encontrado.');
    const validacao = avaliarCupom(
      {
        ativo: row.ativo !== false,
        validade: (row.validade as string | null) ?? null,
        usoMaximo: row.uso_maximo != null ? Number(row.uso_maximo) : null,
        usoAtual: row.uso_atual != null ? Number(row.uso_atual) : 0,
      },
      subtotal
    );
    if (!validacao.ok) throw new HttpError(409, validacao.erro);
    const atual = Number(row.uso_atual || 0);
    const atualizado = await s.tryUpdateIf(
      R_CUPONS(),
      Number(row.id),
      { uso_atual: atual },
      { uso_atual: atual + 1, atualizado_em: new Date().toISOString() },
      tx
    );
    if (atualizado) return atualizado;
    // alguém mais consumiu ao mesmo tempo — relê e revalida
  }
  throw new HttpError(409, 'Cupom indisponível no momento (outro pedido concluiu a compra).');
}

/** Devolve 1 uso quando o pedido expira/cancela antes do pagamento. */
export async function liberarUsoCupom(empresaId: number, codigo: string | null | undefined, tx?: Tx): Promise<void> {
  if (!codigo) return;
  const s = getStore();
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const row = await s.findOneWhere(R_CUPONS(), { empresa_id: empresaId, codigo: normalizarCodigo(codigo) }, tx);
    if (!row) return;
    const atual = Number(row.uso_atual || 0);
    if (atual <= 0) return;
    const ok = await s.tryUpdateIf(
      R_CUPONS(),
      Number(row.id),
      { uso_atual: atual },
      { uso_atual: atual - 1, atualizado_em: new Date().toISOString() },
      tx
    );
    if (ok) return;
  }
}

/** Normaliza o código digitado (maúsculas, sem espaços). */
export function normalizarCodigo(codigo: unknown): string {
  return String(codigo || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .slice(0, 40);
}

// ----------------------------------------------------------------------------
// Handlers HTTP (gerentes — recurso + módulo exigem perfil gerente)
// ----------------------------------------------------------------------------

export async function listarPromocoes(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'read');
  const out = await getStore().list(R_PROMOS(), {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: { empresa_id: escopo.empresaId },
    sort: 'id',
    dir: 'desc',
  });
  res.json({ total: out.total, promocoes: out.rows });
}

function validarCorpoPromocao(body: Record<string, unknown>, exigirNome: boolean): {
  nome?: string;
  tipo: string;
  valor: number;
  minimo_pedido: number;
  data_inicio: string;
  data_fim: string | null;
  ativo: boolean;
} {
  const nome = body.nome !== undefined ? String(body.nome).trim().slice(0, 120) : '';
  if (exigirNome && !nome) throw new HttpError(400, 'Informe o nome da promoção.', { nome: 'Obrigatório' });
  const tipo = String(body.tipo || 'percentual');
  if (tipo !== 'percentual' && tipo !== 'valor') throw new HttpError(400, 'Tipo inválido.', { tipo: 'percentual ou valor' });
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor < 0 || (tipo === 'percentual' && valor > 100)) {
    throw new HttpError(400, 'Valor inválido para o tipo da promoção.', { valor: 'Inválido' });
  }
  const minimo = body.minimo_pedido == null || body.minimo_pedido === '' ? 0 : Number(body.minimo_pedido);
  if (!Number.isFinite(minimo) || minimo < 0) throw new HttpError(400, 'Pedido mínimo inválido.', { minimo_pedido: 'Inválido' });
  const inicio = String(body.data_inicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) throw new HttpError(400, 'Informe a data de início (AAAA-MM-DD).', { data_inicio: 'Obrigatória' });
  const fim = body.data_fim ? String(body.data_fim).slice(0, 10) : null;
  if (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) throw new HttpError(400, 'Data de fim inválida.', { data_fim: 'Inválida' });
  if (fim && fim < inicio) throw new HttpError(400, 'A data de fim não pode ser anterior ao início.', { data_fim: 'Inválida' });
  return { nome, tipo, valor, minimo_pedido: round2(minimo), data_inicio: inicio, data_fim: fim, ativo: body.ativo !== false };
}

export async function criarPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'create');
  const dados = validarCorpoPromocao((req.body || {}) as Record<string, unknown>, true);
  const linha = await getStore().insert(R_PROMOS(), { empresa_id: escopo.empresaId, ...dados, criado_por: actor.id ?? null });
  await getStore().audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'commerce_promocoes',
    registro_id: Number(linha.id),
    descricao: `Promoção "${dados.nome}" criada`,
    empresa_id: empresaDoRegistroAudit(R_PROMOS(), linha, actor),
    dados: { tipo: dados.tipo, valor: dados.valor },
  });
  res.status(201).json({ ok: true, promocao: linha });
}

export async function atualizarPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'update');
  const s = getStore();
  const existente = await s.findOneWhere(R_PROMOS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Promoção não encontrada.');
  const body = (req.body || {}) as Record<string, unknown>;
  const merged = { ...Object.fromEntries(Object.entries(existente).filter(([k]) => ['nome', 'tipo', 'valor', 'minimo_pedido', 'data_inicio', 'data_fim', 'ativo'].includes(k))), ...body };
  const dados = validarCorpoPromocao(merged as Record<string, unknown>, true);
  const atualizada = await s.update(R_PROMOS(), Number(existente.id), dados);
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_promocoes',
    registro_id: Number(existente.id),
    descricao: `Promoção "${dados.nome}" atualizada`,
    empresa_id: empresaDoRegistroAudit(R_PROMOS(), existente, actor),
    dados: dados as unknown as Record<string, unknown>,
  });
  res.json({ ok: true, promocao: atualizada ?? existente });
}

export async function excluirPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'delete');
  const s = getStore();
  const existente = await s.findOneWhere(R_PROMOS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Promoção não encontrada.');
  await s.remove(R_PROMOS(), Number(existente.id));
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'excluir',
    recurso: 'commerce_promocoes',
    registro_id: Number(existente.id),
    descricao: `Promoção "${String(existente.nome || '')}" excluída`,
    empresa_id: escopo.empresaId,
    dados: { nome: existente.nome },
  });
  res.json({ ok: true });
}

export async function listarCupons(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_CUPONS(), actor, 'read');
  const out = await getStore().list(R_CUPONS(), {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Number(req.query.pageSize) || 50),
    filter: { empresa_id: escopo.empresaId },
    sort: 'id',
    dir: 'desc',
  });
  res.json({ total: out.total, cupons: out.rows });
}

function validarCorpoCupom(body: Record<string, unknown>, exigirCodigo: boolean): {
  codigo?: string;
  tipo: string;
  valor: number;
  minimo_pedido: number;
  uso_maximo: number | null;
  validade: string | null;
  ativo: boolean;
} {
  const codigo = normalizarCodigo(body.codigo);
  if (exigirCodigo && !codigo) throw new HttpError(400, 'Informe o código do cupom.', { codigo: 'Obrigatório' });
  if (codigo && !/^[A-Z0-9_-]{2,40}$/.test(codigo)) {
    throw new HttpError(400, 'Código inválido: use letras, números, hífen ou sublinhado (2–40 caracteres).', { codigo: 'Inválido' });
  }
  const tipo = String(body.tipo || 'percentual');
  if (tipo !== 'percentual' && tipo !== 'valor') throw new HttpError(400, 'Tipo inválido.', { tipo: 'percentual ou valor' });
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor < 0 || (tipo === 'percentual' && valor > 100)) {
    throw new HttpError(400, 'Valor inválido para o tipo do cupom.', { valor: 'Inválido' });
  }
  const minimo = body.minimo_pedido == null || body.minimo_pedido === '' ? 0 : Number(body.minimo_pedido);
  if (!Number.isFinite(minimo) || minimo < 0) throw new HttpError(400, 'Pedido mínimo inválido.', { minimo_pedido: 'Inválido' });
  const usoMax = body.uso_maximo == null || body.uso_maximo === '' ? null : Math.trunc(Number(body.uso_maximo));
  if (usoMax != null && (!Number.isFinite(usoMax) || usoMax < 1)) throw new HttpError(400, 'Limite de usos inválido.', { uso_maximo: 'Inválido' });
  const validade = body.validade ? String(body.validade).slice(0, 10) : null;
  if (validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) throw new HttpError(400, 'Validade inválida.', { validade: 'Inválida' });
  return { tipo, valor, minimo_pedido: round2(minimo), uso_maximo: usoMax, validade, ativo: body.ativo !== false, ...(exigirCodigo || codigo ? { codigo } : {}) };
}

export async function criarCupom(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_CUPONS(), actor, 'create');
  const dados = validarCorpoCupom((req.body || {}) as Record<string, unknown>, true);
  const s = getStore();
  const duplicado = await s.findOneWhere(R_CUPONS(), { empresa_id: escopo.empresaId, codigo: dados.codigo });
  if (duplicado) throw new HttpError(409, 'Já existe um cupom com este código nesta empresa.', { codigo: 'Em uso' });
  const linha = await s.insert(R_CUPONS(), {
    empresa_id: escopo.empresaId,
    ...dados,
    uso_atual: 0,
    criado_por: actor.id ?? null,
  });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'commerce_cupons',
    registro_id: Number(linha.id),
    descricao: `Cupom ${dados.codigo} criado`,
    empresa_id: empresaDoRegistroAudit(R_CUPONS(), linha, actor),
    dados: { codigo: dados.codigo, tipo: dados.tipo, valor: dados.valor },
  });
  res.status(201).json({ ok: true, cupom: linha });
}

export async function atualizarCupom(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_CUPONS(), actor, 'update');
  const s = getStore();
  const existente = await s.findOneWhere(R_CUPONS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Cupom não encontrado.');
  const body = (req.body || {}) as Record<string, unknown>;
  const codigoFinal = body.codigo !== undefined ? normalizarCodigo(body.codigo) : String(existente.codigo);
  const merged = {
    ...Object.fromEntries(Object.entries(existente).filter(([k]) => ['tipo', 'valor', 'minimo_pedido', 'uso_maximo', 'validade', 'ativo'].includes(k))),
    ...body,
    codigo: codigoFinal,
  };
  const dados = validarCorpoCupom(merged as Record<string, unknown>, true);
  if (dados.codigo !== String(existente.codigo)) {
    const dono = await s.findOneWhere(R_CUPONS(), { empresa_id: escopo.empresaId, codigo: dados.codigo });
    if (dono && Number(dono.id) !== Number(existente.id)) {
      throw new HttpError(409, 'Já existe um cupom com este código nesta empresa.', { codigo: 'Em uso' });
    }
  }
  const { codigo, ...patch } = dados;
  const atualizado = await s.update(R_CUPONS(), Number(existente.id), { ...patch, ...(codigo ? { codigo } : {}) });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_cupons',
    registro_id: Number(existente.id),
    descricao: `Cupom ${codigo || existente.codigo} atualizado`,
    empresa_id: empresaDoRegistroAudit(R_CUPONS(), existente, actor),
    dados: patch as unknown as Record<string, unknown>,
  });
  res.json({ ok: true, cupom: atualizado ?? existente });
}

export async function excluirCupom(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_CUPONS(), actor, 'delete');
  const s = getStore();
  const existente = await s.findOneWhere(R_CUPONS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Cupom não encontrado.');
  if (Number(existente.uso_atual || 0) > 0) {
    // Nunca apagar histórico que afetou pedidos — desativa em vez de excluir.
    const atualizado = await s.update(R_CUPONS(), Number(existente.id), { ativo: false });
    return res.json({ ok: true, desativado: true, cupom: atualizado ?? existente });
  }
  await s.remove(R_CUPONS(), Number(existente.id));
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'excluir',
    recurso: 'commerce_cupons',
    registro_id: Number(existente.id),
    descricao: `Cupom ${String(existente.codigo || '')} excluído (sem usos)`,
    empresa_id: escopo.empresaId,
    dados: { codigo: existente.codigo },
  });
  res.json({ ok: true });
}
