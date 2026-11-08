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
import { avaliarCupom, descontoDaRegra, melhorDesconto, round2, type RegraDesconto, melhorPromocaoEscopada, type PromocaoEscopada, type ItemElegivel, type AvaliacaoPromocao, type EscopoPromocao, type CanalPromocao } from './regras';

const R_PROMOS = () => getResource('commerce_promocoes')!;
const R_CUPONS = () => getResource('commerce_cupons')!;

// ----------------------------------------------------------------------------
// Regras ativas de um dia (usadas pelo checkout)
// ----------------------------------------------------------------------------

function regraDoCupom(row: Row): RegraDesconto {
  return {
    tipo: String(row.tipo || 'percentual') === 'valor' ? 'valor' : 'percentual',
    valor: Number(row.valor || 0),
    minimoPedido: row.minimo_pedido != null ? Number(row.minimo_pedido) : 0,
  };
}

/**
 * Melhor promoção automática vigente (maior desconto produzido).
 * Compatível com o comportamento pré-0108: considera apenas promoções de
 * escopo 'pedido' e canal 'todos' (as demais exigem itens do carrinho e são
 * resolvidas por `melhorPromocaoDoCarrinho`).
 */
export async function melhorPromocaoAtiva(
  empresaId: number,
  subtotal: number,
  hoje = new Date(),
  tx?: Tx
): Promise<{ regra: RegraDesconto; nome: string } | null> {
  const vigentes = await promocoesVigentes(empresaId, hoje, tx);
  const apenasPedido = vigentes.filter((p) => p.escopo === 'pedido' && p.canal === 'todos');
  const { melhor } = melhorPromocaoEscopada(apenasPedido, [], subtotal, 'todos');
  if (!melhor) return null;
  const origem = apenasPedido.find((p) => p.id === melhor.id)!;
  return { regra: { tipo: origem.tipo, valor: origem.valor, minimoPedido: origem.minimoPedido ?? 0 }, nome: melhor.nome };
}

// ----------------------------------------------------------------------------
// Promoções com ESCOPO/CANAL/PRECEDÊNCIA (migração 0108)
//
// `melhorPromocaoAtiva` acima é a regra LEGADA (só pedido inteiro). Estas
// funções leem escopo, canal, prioridade e alvos e delegam a decisão à regra
// pura `melhorPromocaoEscopada` (regras.ts). Compatível: promoção com
// escopo='pedido' e canal='todos' produz o mesmo desconto de antes.
// ----------------------------------------------------------------------------

const R_ALVOS = () => getResource('commerce_promocao_alvos')!;

/** Promoções ativas e vigentes na data, com escopo/canal/prioridade e alvos. */
export async function promocoesVigentes(
  empresaId: number,
  hoje = new Date(),
  tx?: Tx
): Promise<PromocaoEscopada[]> {
  const s = getStore();
  const all: Row[] = [];
  for (let page = 1; ; page += 1) {
    const out = await s.list(R_PROMOS(), { page, pageSize: 500, filter: { empresa_id: empresaId, ativo: true }, sort: 'id', dir: 'asc' }, tx);
    if (out.total > 10000) throw new HttpError(409, 'Promoções ativas excedem o limite seguro para cálculo.');
    all.push(...out.rows);
    if (all.length >= out.total || out.rows.length === 0) break;
  }
  const dia = hoje.toISOString().slice(0, 10);
  const vigentes = all.filter((row) => {
    const inicio = row.data_inicio ? String(row.data_inicio).slice(0, 10) : null;
    const fim = row.data_fim ? String(row.data_fim).slice(0, 10) : null;
    if (inicio && inicio > dia) return false;
    if (fim && fim < dia) return false;
    return true;
  });
  if (!vigentes.length) return [];
  const alvos: Row[] = [];
  for (let page = 1; ; page += 1) {
    const out = await s.list(R_ALVOS(), { page, pageSize: 1000, filter: { empresa_id: empresaId }, sort: 'id', dir: 'asc' }, tx);
    alvos.push(...out.rows);
    if (alvos.length >= out.total || out.rows.length === 0) break;
  }
  const porPromo = new Map<number, { produtos: number[]; categorias: number[] }>();
  for (const a of alvos) {
    const pid = Number(a.promocao_id);
    if (!porPromo.has(pid)) porPromo.set(pid, { produtos: [], categorias: [] });
    const alvo = porPromo.get(pid)!;
    if (a.produto_id != null) alvo.produtos.push(Number(a.produto_id));
    if (a.categoria_id != null) alvo.categorias.push(Number(a.categoria_id));
  }
  return vigentes.map((row) => {
    const alvo = porPromo.get(Number(row.id)) ?? { produtos: [], categorias: [] };
    return {
      id: Number(row.id),
      nome: String(row.nome || ''),
      tipo: String(row.tipo || 'percentual') === 'valor' ? 'valor' : 'percentual',
      valor: Number(row.valor || 0),
      minimoPedido: row.minimo_pedido != null ? Number(row.minimo_pedido) : 0,
      escopo: (String(row.escopo || 'pedido') as EscopoPromocao),
      canal: (String(row.canal || 'todos') as CanalPromocao),
      prioridade: Number(row.prioridade || 0),
      alvosProduto: alvo.produtos,
      alvosCategoria: alvo.categorias,
    };
  });
}

/**
 * Melhor promoção escopada aplicável ao carrinho, já como `RegraDesconto`
 * sobre o SUBTOTAL ELEGÍVEL. Devolve também a lista de candidatas avaliadas
 * (para o simulador e a trilha de auditoria).
 */
export async function melhorPromocaoDoCarrinho(
  empresaId: number,
  itens: ItemElegivel[],
  subtotal: number,
  canal?: string | null,
  hoje = new Date(),
  tx?: Tx
): Promise<{ promocao: { regra: RegraDesconto; nome: string; id: number; desconto: number } | null; avaliacoes: AvaliacaoPromocao[] }> {
  const promocoes = await promocoesVigentes(empresaId, hoje, tx);
  const { melhor, avaliacoes } = melhorPromocaoEscopada(promocoes, itens, subtotal, canal);
  if (!melhor) return { promocao: null, avaliacoes };
  const origem = promocoes.find((p) => p.id === melhor.id)!;
  return {
    promocao: {
      regra: { tipo: origem.tipo, valor: origem.valor, minimoPedido: origem.minimoPedido ?? 0 },
      nome: melhor.nome,
      id: melhor.id,
      desconto: melhor.desconto,
    },
    avaliacoes,
  };
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

/**
 * Desconto final do checkout (melhor entre promoção e cupom — nunca ambos).
 * `promocao` pode trazer o desconto JÁ calculado (escopo produto/categoria usa
 * a base elegível, não o subtotal); sem ele, o desconto é derivado da regra
 * sobre o subtotal (compatibilidade com o legado de pedido inteiro).
 */
export function descontoFinalDoCheckout(
  subtotal: number,
  promocao: { regra: RegraDesconto; nome: string; desconto?: number } | null,
  cupom: { ok: true; regra: RegraDesconto; desconto: number; cupom: Row } | { ok: false; erro: string } | null
): { desconto: number; origem: 'promocao' | 'cupom' | null; cupomErro?: string } {
  const descontoPromo = promocao
    ? promocao.desconto != null
      ? Math.max(0, round2(promocao.desconto))
      : descontoDaRegra(subtotal, promocao.regra)
    : 0;
  const descontoCupom = cupom && cupom.ok ? cupom.desconto : 0;
  const origem: 'promocao' | 'cupom' | null = descontoCupom > descontoPromo ? 'cupom' : descontoPromo > 0 ? 'promocao' : descontoCupom > 0 ? 'cupom' : null;
  const desconto = Math.max(descontoPromo, descontoCupom);
  const saida: { desconto: number; origem: 'promocao' | 'cupom' | null; cupomErro?: string } = { desconto, origem };
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
  throw new HttpError(409, 'Não foi possível liberar o uso do cupom; tente novamente.');
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
  // Alvos por promoção (para a tela reabrir o escopo produto/categoria).
  const alvos = await getStore().list(R_ALVOS(), { page: 1, pageSize: 5000, filter: { empresa_id: escopo.empresaId } });
  const porPromo = new Map<number, { produtos: number[]; categorias: number[] }>();
  for (const a of alvos.rows) {
    const pid = Number(a.promocao_id);
    if (!porPromo.has(pid)) porPromo.set(pid, { produtos: [], categorias: [] });
    const alvo = porPromo.get(pid)!;
    if (a.produto_id != null) alvo.produtos.push(Number(a.produto_id));
    if (a.categoria_id != null) alvo.categorias.push(Number(a.categoria_id));
  }
  res.json({
    total: out.total,
    promocoes: out.rows.map((row) => {
      const alvo = porPromo.get(Number(row.id)) ?? { produtos: [], categorias: [] };
      return { ...row, produtos: alvo.produtos, categorias: alvo.categorias };
    }),
  });
}

function normalizarIds(valor: unknown, campo: string): number[] {
  if (valor == null) return [];
  if (!Array.isArray(valor)) throw new HttpError(400, `Lista de ${campo} inválida.`, { [campo]: 'Deve ser uma lista.' });
  const ids: number[] = [];
  for (const bruto of valor) {
    const n = typeof bruto === 'number' ? bruto : Number(String(bruto).trim());
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `Identificador inválido em ${campo}.`, { [campo]: 'Somente IDs positivos.' });
    ids.push(n);
  }
  const unicos = [...new Set(ids)];
  if (unicos.length > 500) throw new HttpError(400, `Limite de 500 alvos por promoção (${campo}).`, { [campo]: 'Máximo 500.' });
  return unicos;
}

function validarCorpoPromocao(body: Record<string, unknown>, exigirNome: boolean): {
  nome?: string;
  tipo: string;
  valor: number;
  escopo: EscopoPromocao;
  canal: CanalPromocao;
  prioridade: number;
  minimo_pedido: number;
  data_inicio: string;
  data_fim: string | null;
  ativo: boolean;
  produtos: number[];
  categorias: number[];
} {
  const nome = body.nome !== undefined ? String(body.nome).trim().slice(0, 120) : '';
  if (exigirNome && !nome) throw new HttpError(400, 'Informe o nome da promoção.', { nome: 'Obrigatório' });
  const tipo = String(body.tipo || 'percentual');
  if (tipo !== 'percentual' && tipo !== 'valor') throw new HttpError(400, 'Tipo inválido.', { tipo: 'percentual ou valor' });
  const valor = Number(body.valor);
  if (!Number.isFinite(valor) || valor < 0 || (tipo === 'percentual' && valor > 100)) {
    throw new HttpError(400, 'Valor inválido para o tipo da promoção.', { valor: 'Inválido' });
  }
  const escopo = String(body.escopo || 'pedido');
  if (escopo !== 'pedido' && escopo !== 'produto' && escopo !== 'categoria') {
    throw new HttpError(400, 'Escopo inválido.', { escopo: 'pedido, produto ou categoria' });
  }
  const canal = String(body.canal || 'todos');
  if (canal !== 'todos' && canal !== 'varejo' && canal !== 'atacado') {
    throw new HttpError(400, 'Canal inválido.', { canal: 'todos, varejo ou atacado' });
  }
  const prioridadeBruta = body.prioridade == null || body.prioridade === '' ? 0 : Number(body.prioridade);
  if (!Number.isSafeInteger(prioridadeBruta) || prioridadeBruta < 0) {
    throw new HttpError(400, 'Prioridade inválida (inteiro ≥ 0).', { prioridade: 'Inválida' });
  }
  const minimo = body.minimo_pedido == null || body.minimo_pedido === '' ? 0 : Number(body.minimo_pedido);
  if (!Number.isFinite(minimo) || minimo < 0) throw new HttpError(400, 'Pedido mínimo inválido.', { minimo_pedido: 'Inválido' });
  const inicio = String(body.data_inicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) throw new HttpError(400, 'Informe a data de início (AAAA-MM-DD).', { data_inicio: 'Obrigatória' });
  const fim = body.data_fim ? String(body.data_fim).slice(0, 10) : null;
  if (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) throw new HttpError(400, 'Data de fim inválida.', { data_fim: 'Inválida' });
  if (fim && fim < inicio) throw new HttpError(400, 'A data de fim não pode ser anterior ao início.', { data_fim: 'Inválida' });
  // Alvos só fazem sentido em escopo produto/categoria; em 'pedido' são ignorados.
  const produtos = escopo === 'produto' ? normalizarIds(body.produtos, 'produtos') : [];
  const categorias = escopo === 'categoria' ? normalizarIds(body.categorias, 'categorias') : [];
  if (escopo === 'produto' && produtos.length === 0) throw new HttpError(400, 'Selecione ao menos um produto para a promoção.', { produtos: 'Obrigatório no escopo produto.' });
  if (escopo === 'categoria' && categorias.length === 0) throw new HttpError(400, 'Selecione ao menos uma categoria para a promoção.', { categorias: 'Obrigatório no escopo categoria.' });
  return {
    nome,
    tipo,
    valor,
    escopo: escopo as EscopoPromocao,
    canal: canal as CanalPromocao,
    prioridade: prioridadeBruta,
    minimo_pedido: round2(minimo),
    data_inicio: inicio,
    data_fim: fim,
    ativo: body.ativo !== false,
    produtos,
    categorias,
  };
}

/** Substitui os alvos de uma promoção (transacional: apaga e regrava). */
async function sincronizarAlvos(empresaId: number, promocaoId: number, dados: { produtos: number[]; categorias: number[] }, tx?: Tx): Promise<void> {
  const s = getStore();
  const existentes = await s.list(R_ALVOS(), { page: 1, pageSize: 2000, filter: { empresa_id: empresaId, promocao_id: promocaoId } }, tx);
  for (const alvo of existentes.rows) await s.remove(R_ALVOS(), Number(alvo.id), tx);
  for (const produtoId of dados.produtos) {
    await s.insert(R_ALVOS(), { empresa_id: empresaId, promocao_id: promocaoId, produto_id: produtoId }, tx);
  }
  for (const categoriaId of dados.categorias) {
    await s.insert(R_ALVOS(), { empresa_id: empresaId, promocao_id: promocaoId, categoria_id: categoriaId }, tx);
  }
}

export async function criarPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'create');
  const dados = validarCorpoPromocao((req.body || {}) as Record<string, unknown>, true);
  const { produtos, categorias, ...campos } = dados;
  const s = getStore();
  const linha = await s.transaction(async (tx) => {
    const nova = await s.insert(R_PROMOS(), { empresa_id: escopo.empresaId, ...campos, criado_por: actor.id ?? null }, tx);
    await sincronizarAlvos(escopo.empresaId, Number(nova.id), { produtos, categorias }, tx);
    return nova;
  });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'criar',
    recurso: 'commerce_promocoes',
    registro_id: Number(linha.id),
    descricao: `Promoção "${dados.nome}" criada`,
    empresa_id: empresaDoRegistroAudit(R_PROMOS(), linha, actor),
    dados: { tipo: dados.tipo, valor: dados.valor, escopo: dados.escopo, canal: dados.canal, prioridade: dados.prioridade, alvos: produtos.length + categorias.length },
  });
  res.status(201).json({ ok: true, promocao: { ...linha, produtos, categorias } });
}

export async function atualizarPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'update');
  const s = getStore();
  const existente = await s.findOneWhere(R_PROMOS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Promoção não encontrada.');
  const body = (req.body || {}) as Record<string, unknown>;
  const camposExistentes = ['nome', 'tipo', 'valor', 'escopo', 'canal', 'prioridade', 'minimo_pedido', 'data_inicio', 'data_fim', 'ativo'];
  const merged: Record<string, unknown> = { ...Object.fromEntries(Object.entries(existente).filter(([k]) => camposExistentes.includes(k))), ...body };
  // Alvos não vêm na linha: se o corpo não os trouxer, PRESERVA os atuais.
  // Sem isso, editar só o canal de uma promoção escopada falharia pedindo alvos.
  if (body.produtos === undefined || body.categorias === undefined) {
    const atuais = await s.list(R_ALVOS(), { page: 1, pageSize: 2000, filter: { empresa_id: escopo.empresaId, promocao_id: Number(existente.id) } });
    if (body.produtos === undefined) merged.produtos = atuais.rows.filter((a) => a.produto_id != null).map((a) => Number(a.produto_id));
    if (body.categorias === undefined) merged.categorias = atuais.rows.filter((a) => a.categoria_id != null).map((a) => Number(a.categoria_id));
  }
  const dados = validarCorpoPromocao(merged as Record<string, unknown>, true);
  const { produtos, categorias, ...campos } = dados;
  const atualizada = await s.transaction(async (tx) => {
    const upd = await s.update(R_PROMOS(), Number(existente.id), campos, tx);
    await sincronizarAlvos(escopo.empresaId, Number(existente.id), { produtos, categorias }, tx);
    return upd;
  });
  await s.audit({
    usuario_id: actor.id || null,
    usuario: actor.name,
    acao: 'editar',
    recurso: 'commerce_promocoes',
    registro_id: Number(existente.id),
    descricao: `Promoção "${dados.nome}" atualizada`,
    empresa_id: empresaDoRegistroAudit(R_PROMOS(), existente, actor),
    dados: { escopo: dados.escopo, canal: dados.canal, prioridade: dados.prioridade, alvos: produtos.length + categorias.length },
  });
  res.json({ ok: true, promocao: { ...(atualizada ?? existente), produtos, categorias } });
}

export async function excluirPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'delete');
  const s = getStore();
  const existente = await s.findOneWhere(R_PROMOS(), { id: Number(req.params.id), empresa_id: escopo.empresaId });
  if (!existente) throw new HttpError(404, 'Promoção não encontrada.');
  await s.transaction(async (tx) => {
    await sincronizarAlvos(escopo.empresaId, Number(existente.id), { produtos: [], categorias: [] }, tx);
    await s.remove(R_PROMOS(), Number(existente.id), tx);
  });
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
  const { R_CREATOR_PARTNERSHIPS } = await import('../creatorsResources');
  const { domainLock } = await import('../domainLock');
  const result = await domainLock(escopo.empresaId, 'creators', async (tx) => {
    const existente = await s.findOneWhere(R_CUPONS(), { id: Number(req.params.id), empresa_id: escopo.empresaId }, tx);
    if (!existente) throw new HttpError(404, 'Cupom não encontrado.');
    const vinculado = await s.findOneWhere(R_CREATOR_PARTNERSHIPS, { empresa_id: escopo.empresaId, coupon_id: Number(existente.id) }, tx);
    if (Number(existente.uso_atual || 0) > 0 || vinculado) {
      // O mesmo lock da criação de parceria impede excluir o cupom entre a
      // verificação e o vínculo. Histórico e FK são preservados.
      const atualizado = await s.update(R_CUPONS(), Number(existente.id), { ativo: false }, tx);
      await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'commerce_cupons',
        registro_id: Number(existente.id), descricao: 'Cupom desativado para preservar histórico ou parceria',
        empresa_id: escopo.empresaId, dados: { partnership_id: vinculado?.id || null } }, tx);
      return { ok: true, desativado: true, cupom: atualizado ?? existente };
    }
    await s.remove(R_CUPONS(), Number(existente.id), tx);
    await s.audit({ usuario_id: actor.id || null, usuario: actor.name, acao: 'excluir', recurso: 'commerce_cupons',
      registro_id: Number(existente.id), descricao: 'Cupom sem usos excluído',
      empresa_id: escopo.empresaId, dados: { codigo: existente.codigo } }, tx);
    return { ok: true };
  });
  res.json(result);
}

// ----------------------------------------------------------------------------
// SIMULADOR DE IMPACTO — POST /api/commerce/promocoes/simular
//
// Calcula, sobre um carrinho informado, o desconto de CADA promoção candidata e
// qual venceria (maior desconto → maior prioridade → mais recente), além do
// cupom quando informado. É a mesma regra pura do checkout — o simulador nunca
// tem um cálculo próprio. Nada é persistido.
// ----------------------------------------------------------------------------


function validarItensSimulacao(bruto: unknown): ItemElegivel[] {
  if (!Array.isArray(bruto) || bruto.length === 0) throw new HttpError(400, 'Informe ao menos um item para simular.', { itens: 'Obrigatório' });
  if (bruto.length > 30) throw new HttpError(400, 'A simulação aceita no máximo 30 linhas.');
  return bruto.map((linha, idx) => {
    const item = (linha && typeof linha === 'object' && !Array.isArray(linha) ? linha : {}) as Record<string, unknown>;
    const produtoId = Number(item.produto_id);
    const quantidade = Number(item.quantidade);
    const preco = Number(item.preco_unitario);
    if (!Number.isSafeInteger(produtoId) || produtoId <= 0) throw new HttpError(400, `Item ${idx + 1}: produto inválido.`, { itens: 'Produto inválido.' });
    if (!Number.isSafeInteger(quantidade) || quantidade < 1 || quantidade > 999) throw new HttpError(400, `Item ${idx + 1}: quantidade inválida (1 a 999).`, { itens: 'Quantidade inválida.' });
    if (!Number.isFinite(preco) || preco < 0) throw new HttpError(400, `Item ${idx + 1}: preço inválido.`, { itens: 'Preço inválido.' });
    const categoria = item.categoria_id == null ? null : Number(item.categoria_id);
    return {
      subtotal: round2(preco * quantidade),
      produtoId,
      categoriaId: categoria != null && Number.isSafeInteger(categoria) && categoria > 0 ? categoria : null,
    };
  });
}

export async function simularPromocao(req: Request, res: Response) {
  const actor = currentUser(req);
  const escopo = escopoDoAtor(actor);
  checkAccess(R_PROMOS(), actor, 'read');
  const corpo = (req.body || {}) as Record<string, unknown>;
  const itens = validarItensSimulacao(corpo.itens);
  const subtotal = round2(itens.reduce((s, i) => s + i.subtotal, 0));
  const canal = corpo.canal == null || corpo.canal === '' ? null : String(corpo.canal);
  if (canal != null && canal !== 'varejo' && canal !== 'atacado') {
    throw new HttpError(400, 'Canal inválido para simulação.', { canal: 'varejo ou atacado' });
  }
  const promocoes = await promocoesVigentes(escopo.empresaId);
  const { melhor, avaliacoes } = melhorPromocaoEscopada(promocoes, itens, subtotal, canal);
  const codigoCupom = corpo.cupom ? normalizarCodigo(corpo.cupom) : '';
  const cupom = codigoCupom ? await avaliarCupomCodigo(escopo.empresaId, codigoCupom, subtotal) : null;
  const desconto = descontoFinalDoCheckout(subtotal, melhor ? { regra: { tipo: 'percentual', valor: 0 }, nome: melhor.nome, desconto: melhor.desconto } : null, cupom);
  res.json({
    subtotal,
    canal,
    candidatas: avaliacoes,
    melhor: melhor ? { id: melhor.id, nome: melhor.nome, desconto: melhor.desconto, base: melhor.base } : null,
    cupom: cupom && cupom.ok ? { codigo: cupom.cupom.codigo, desconto: cupom.desconto } : cupom ? { erro: cupom.erro } : null,
    desconto_aplicado: desconto.desconto,
    origem: desconto.origem,
    total: round2(subtotal - desconto.desconto),
  });
}
