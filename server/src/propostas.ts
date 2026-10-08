// ============================================================================
// PROPOSTAS COMERCIAIS — P1
//
//   PROPOSTA → aprovação → conversão → PEDIDO
//
// Máquina de estados explícita (e travada no banco pela CHECK de status):
//
//   rascunho --enviar--> enviada --aprovar--> aprovada --converter--> convertida
//                          |                     |
//                          +--recusar--> recusada +--(validade vencida)--> expirada
//   rascunho|enviada --cancelar--> cancelada
//
// Três coisas não são negociáveis aqui:
//
//   1) O TOTAL É DO SERVIDOR. O cliente manda quantidade e, opcionalmente,
//      desconto por item; o preço unitário vem da lista de preço vigente ou da
//      ficha do produto, e o subtotal/total são calculados aqui. Um `total`
//      enviado no corpo da requisição é ignorado.
//
//   2) A CONVERSÃO É IDEMPOTENTE. Três camadas independentes impedem que a
//      mesma proposta gere dois pedidos:
//        a) `propostas.venda_id` é UNIQUE;
//        b) índice parcial único em `vendas.proposta_id`;
//        c) a transição usa UPDATE condicional (compare-and-swap) dentro de
//           transação serializable — quem perde faz rollback e o pedido que
//           criou some junto.
//      Repetir a requisição devolve o MESMO pedido, não um segundo.
//
//   3) O PREÇO É CONGELADO. O item da proposta guarda `lista_preco_id` e
//      `preco_tabela`; mudar a lista depois não reescreve a proposta.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, validarReferenciasDaEmpresa, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import { precoDe } from './listasPreco';
import type { Row, Tx } from './store';

export const R_PROPOSTA = () => getResource('propostas')!;
export const R_ITEM = () => getResource('proposta_itens')!;
export const R_EVENTO = () => getResource('proposta_eventos')!;

/** Transições permitidas. Qualquer outra é 409, não um silêncio. */
export const TRANSICOES: Record<string, string[]> = {
  rascunho: ['enviada', 'cancelada'],
  enviada: ['aprovada', 'recusada', 'cancelada'],
  aprovada: ['convertida', 'expirada'],
  recusada: [],
  convertida: [],
  cancelada: [],
  expirada: [],
};

export function podeTransicionar(de: string, para: string): boolean {
  return (TRANSICOES[de] || []).includes(para);
}

const ROTULO: Record<string, string> = {
  rascunho: 'Rascunho',
  enviada: 'Enviada',
  aprovada: 'Aprovada',
  recusada: 'Recusada',
  convertida: 'Convertida em pedido',
  cancelada: 'Cancelada',
  expirada: 'Expirada',
};

/**
 * Alçada para operar o fluxo da proposta.
 *
 * Não é `checkAccess(propostas, 'update')` de propósito: `propostas.ops.update`
 * é `false` justamente para que o CRUD genérico NÃO consiga reescrever por PUT
 * uma proposta já enviada/aprovada (o total e o status só mudam pelo fluxo).
 * O workflow, então, exige duas coisas que fazem sentido por si:
 *   • poder LER propostas;
 *   • poder CRIAR pedidos de venda — porque é isso que a conversão produz.
 */
function exigirEscrita(actor: AuthUser): void {
  checkAccess(R_PROPOSTA(), actor, 'read');
  checkAccess(getResource('vendas')!, actor, 'create');
}

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function dataISO(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v).slice(0, 10);
}

async function registrarEvento(
  propostaId: number,
  de: string | null,
  para: string,
  mensagem: string,
  actor: { id: number | null; name: string },
  empresaId: number,
  tx: Tx
): Promise<void> {
  await getStore().insert(
    R_EVENTO(),
    { empresa_id: empresaId, proposta_id: propostaId, de_status: de, para_status: para, mensagem, usuario_id: actor.id || null },
    tx
  );
}

/** Uma proposta aprovada cuja validade venceu está expirada. */
export function propostaExpirada(proposta: Row): boolean {
  if (String(proposta.status) !== 'aprovada') return false;
  const validade = dataISO(proposta.valida_ate);
  if (!validade) return false;
  return validade < new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Itens — sempre recalculados pelo servidor
// ----------------------------------------------------------------------------

type ItemEntrada = {
  produto_id: number;
  tamanho_id?: number | null;
  quantidade: number;
  desconto_pct?: number;
  preco_unitario?: number | null;
};

function normalizarItens(bruto: unknown): ItemEntrada[] {
  if (!Array.isArray(bruto)) throw new HttpError(400, 'itens deve ser uma lista.');
  const itens: ItemEntrada[] = [];
  bruto.forEach((raw, index) => {
    const linha = (raw || {}) as Record<string, unknown>;
    const produtoId = Number(linha.produto_id ?? linha.produtoId);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw new HttpError(400, `Item ${index + 1}: produto_id inválido.`, { [`itens[${index}].produto_id`]: 'Inválido' });
    }
    const quantidade = Number(linha.quantidade ?? linha.qtd);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new HttpError(400, `Item ${index + 1}: a quantidade deve ser maior que zero.`, { [`itens[${index}].quantidade`]: 'Deve ser > 0' });
    }
    let desconto = Number(linha.desconto_pct ?? 0);
    if (!Number.isFinite(desconto)) desconto = 0;
    if (desconto < 0 || desconto > 100) {
      throw new HttpError(400, `Item ${index + 1}: desconto_pct deve estar entre 0 e 100.`, { [`itens[${index}].desconto_pct`]: 'Entre 0 e 100' });
    }
    itens.push({
      produto_id: produtoId,
      tamanho_id: linha.tamanho_id === undefined || linha.tamanho_id === null || linha.tamanho_id === '' ? null : Number(linha.tamanho_id),
      quantidade: round2(quantidade),
      desconto_pct: round2(desconto),
      preco_unitario: linha.preco_unitario === undefined || linha.preco_unitario === null || linha.preco_unitario === '' ? null : Number(linha.preco_unitario),
    });
  });
  return itens;
}

/**
 * Resolve e grava os itens. Devolve o subtotal somado.
 * O preço vem da lista vigente; um preço enviado manualmente é aceito apenas
 * como exceção e fica registrado ao lado do preço de tabela.
 */
async function gravarItens(
  propostaId: number,
  itens: ItemEntrada[],
  escopo: EscopoEmpresa,
  tx: Tx
): Promise<number> {
  const s = getStore();
  const produtos = await s.list(
    getResource('produtos')!,
    { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } },
    tx
  );
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));

  let subtotalTotal = 0;
  for (const item of itens) {
    const produto = porId.get(item.produto_id);
    // Produto de outra empresa não é "não encontrado por acaso": é 404 explícito,
    // sem revelar o que existe do outro lado.
    if (!produto) throw new HttpError(404, `Produto #${item.produto_id} não encontrado nesta empresa.`);
    if (produto.ativo === false) throw new HttpError(409, `O produto ${produto.sku} está inativo e não pode entrar numa proposta.`);

    if (item.tamanho_id) {
      const tamanho = await s.findOneWhere(getResource('tamanhos')!, { id: item.tamanho_id }, tx);
      if (!tamanho) throw new HttpError(404, `Tamanho #${item.tamanho_id} não encontrado.`);
    }

    const resolvido = await precoDe(produto, escopo, tx);
    const manual = item.preco_unitario ?? null;
    const preco = manual !== null && Number.isFinite(manual) && manual >= 0 ? round2(manual) : resolvido.preco;
    const subtotal = round2(item.quantidade * preco * (1 - (item.desconto_pct ?? 0) / 100));
    subtotalTotal += subtotal;

    await s.insert(
      R_ITEM(),
      {
        empresa_id: escopo.empresaId,
        proposta_id: propostaId,
        produto_id: item.produto_id,
        tamanho_id: item.tamanho_id ?? null,
        quantidade: item.quantidade,
        preco_unitario: preco,
        desconto_pct: item.desconto_pct,
        subtotal,
        lista_preco_id: resolvido.lista_id,
        preco_tabela: resolvido.preco_tabela,
      },
      tx
    );
  }
  return round2(subtotalTotal);
}

function totalDe(subtotalItens: number, desconto: number, frete: number): number {
  return round2(Math.max(0, subtotalItens - desconto + frete));
}

// ----------------------------------------------------------------------------
// POST /api/propostas
// ----------------------------------------------------------------------------

export async function criarProposta(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PROPOSTA(), actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  // O cliente vem antes dos itens na ordem das validações: é o campo mais
  // fundamental da proposta e o erro dele é o que o operador resolve primeiro.
  const clienteId = Number(body.cliente_id ?? null);
  if (!Number.isInteger(clienteId) || clienteId <= 0) {
    throw new HttpError(400, 'Informe o cliente da proposta.', { cliente_id: 'Obrigatório' });
  }
  const itens = normalizarItens(body.itens);
  if (!itens.length) throw new HttpError(400, 'A proposta precisa de ao menos um item.');

  const s = getStore();
  try {
    const criada = await s.transaction(async (tx) => {
      // Cliente tem que existir E pertencer à empresa ativa.
      const cliente = await s.get(getResource('clientes')!, clienteId, tx);
      assertRegistroDaEmpresa(getResource('clientes')!, cliente, escopo);

      const cabecalho: Record<string, unknown> = {
        empresa_id: escopo.empresaId,
        cliente_id: clienteId,
        representante_id: body.representante_id === undefined || body.representante_id === null || body.representante_id === '' ? null : Number(body.representante_id),
        data: body.data ? String(body.data).slice(0, 10) : new Date().toISOString().slice(0, 10),
        valida_ate: body.valida_ate ? String(body.valida_ate).slice(0, 10) : null,
        status: 'rascunho',
        condicao_pagamento: body.condicao_pagamento ? String(body.condicao_pagamento).slice(0, 60) : null,
        observacoes: body.observacoes ? String(body.observacoes).slice(0, 2000) : null,
        numero: body.numero ? String(body.numero).slice(0, 40) : null,
        desconto: Math.max(0, round2(num(body.desconto))),
        frete: Math.max(0, round2(num(body.frete))),
        criado_por: actor.id || null,
      };
      if (cabecalho.valida_ate && dataISO(cabecalho.valida_ate)! < String(cabecalho.data)) {
        throw new HttpError(400, 'A validade não pode ser anterior à data da proposta.', { valida_ate: 'Anterior à data' });
      }
      await validarReferenciasDaEmpresa(R_PROPOSTA(), cabecalho, escopo, (r, id, t) => s.get(r, id, t), tx);

      const proposta = await s.insert(R_PROPOSTA(), cabecalho, tx);
      const subtotal = await gravarItens(Number(proposta.id), itens, escopo, tx);
      const total = totalDe(subtotal, num(cabecalho.desconto), num(cabecalho.frete));
      await s.update(R_PROPOSTA(), Number(proposta.id), { total }, tx);
      await registrarEvento(Number(proposta.id), null, 'rascunho', `Proposta criada com ${itens.length} item(ns), total ${total.toFixed(2)}.`, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'propostas', registro_id: Number(proposta.id), descricao: `Proposta #${proposta.id} criada (${itens.length} item(ns), R$ ${total.toFixed(2)})`, dados: { cliente_id: clienteId, itens: itens.length, total }, empresa_id: empresaDoRegistroAudit(R_PROPOSTA(), proposta, actor) },
        tx
      );
      const completa = (await s.get(R_PROPOSTA(), Number(proposta.id), tx)) || proposta;
      return { id: Number(completa.id), subtotal_itens: subtotal };
    }, { isolation: 'serializable' });
    res.status(201).json(await detalhar(Number(criada.id), escopo));
  } catch (e) {
    throw toHttpError(e, R_PROPOSTA());
  }
}

/** GET /api/propostas/:id — proposta + itens + trilha de estados. */
export async function detalharProposta(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PROPOSTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  res.json(await detalhar(parseId(req.params.id), escopo));
}

async function detalhar(id: number, escopo: EscopoEmpresa): Promise<Record<string, unknown>> {
  const s = getStore();
  const proposta = assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id), escopo);
  const itens = await s.list(R_ITEM(), { page: 1, pageSize: 1000, filter: { proposta_id: id }, sort: 'id', dir: 'asc' });
  const eventos = await s.list(R_EVENTO(), { page: 1, pageSize: 200, filter: { proposta_id: id }, sort: 'id', dir: 'asc' });
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  const subtotal = round2(itens.rows.reduce((acc, i) => acc + num(i.subtotal), 0));
  return {
    ...proposta,
    expirada: propostaExpirada(proposta),
    proximas_transicoes: TRANSICOES[String(proposta.status)] || [],
    subtotal_itens: subtotal,
    itens: itens.rows.map((i) => {
      const p = porId.get(Number(i.produto_id));
      return { ...i, sku: p?.sku ?? null, produto: p?.nome ?? null, preco_ficha: p ? round2(num(p.preco_venda)) : null };
    }),
    eventos: eventos.rows,
  };
}

/** GET /api/propostas/:id/itens */
export async function listarItens(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PROPOSTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id), escopo);
  const out = await s.list(R_ITEM(), { page: 1, pageSize: 1000, filter: { proposta_id: id }, sort: 'id', dir: 'asc' });
  res.json(out.rows);
}

/**
 * POST /api/propostas/:id/itens — reescreve os itens da proposta.
 * Só em `rascunho`: depois de enviada, o que o cliente viu não pode mudar.
 */
export async function reescreverItens(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirEscrita(actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const itens = normalizarItens((req.body || {}).itens ?? req.body);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const proposta = assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id, tx), escopo);
      if (String(proposta.status) !== 'rascunho') {
        throw new HttpError(409, 'Os itens só podem ser alterados enquanto a proposta está em rascunho.');
      }
      if (!itens.length) throw new HttpError(400, 'A proposta precisa de ao menos um item.');
      const antigos = await s.list(R_ITEM(), { page: 1, pageSize: 1000, filter: { proposta_id: id } }, tx);
      for (const antigo of antigos.rows) await s.remove(R_ITEM(), Number(antigo.id), tx);
      const subtotal = await gravarItens(id, itens, escopo, tx);
      const total = totalDe(subtotal, num(proposta.desconto), num(proposta.frete));
      await s.update(R_PROPOSTA(), id, { total }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'propostas', registro_id: id, descricao: `Proposta #${id}: itens reescritos (${itens.length}), total ${total.toFixed(2)}`, dados: { itens: itens.length, total }, empresa_id: empresaDoRegistroAudit(R_PROPOSTA(), proposta, actor) },
        tx
      );
      return total;
    }, { isolation: 'serializable' });
    res.json({ ok: true, proposta_id: id, total: out });
  } catch (e) {
    throw toHttpError(e, R_PROPOSTA());
  }
}

// ----------------------------------------------------------------------------
// Transições de estado
// ----------------------------------------------------------------------------

function exigirTransicao(proposta: Row, para: string): void {
  const de = String(proposta.status);
  if (!podeTransicionar(de, para)) {
    throw new HttpError(409, `Não é possível passar uma proposta ${ROTULO[de] || de} para ${ROTULO[para] || para}.`);
  }
}

/** POST /api/propostas/:id/enviar */
export async function enviarProposta(req: Request, res: Response) {
  return transicionar(req, res, 'enviada');
}

/** POST /api/propostas/:id/aprovar */
export async function aprovarProposta(req: Request, res: Response) {
  return transicionar(req, res, 'aprovada');
}

/** POST /api/propostas/:id/recusar */
export async function recusarProposta(req: Request, res: Response) {
  return transicionar(req, res, 'recusada');
}

/** POST /api/propostas/:id/cancelar */
export async function cancelarProposta(req: Request, res: Response) {
  return transicionar(req, res, 'cancelada');
}

async function transicionar(req: Request, res: Response, para: 'enviada' | 'aprovada' | 'recusada' | 'cancelada') {
  const actor = currentUser(req);
  exigirEscrita(actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const mensagem = body.motivo ? String(body.motivo).slice(0, 500) : body.mensagem ? String(body.mensagem).slice(0, 500) : `Proposta ${para}.`;
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const proposta = assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id, tx), escopo);
      exigirTransicao(proposta, para);
      if (para === 'enviada' && !proposta.valida_ate) {
        throw new HttpError(400, 'Defina a validade antes de enviar a proposta ao cliente.', { valida_ate: 'Obrigatório para enviar' });
      }
      const patch: Record<string, unknown> = { status: para };
      if (para === 'recusada') {
        patch.recusado_em = new Date().toISOString();
        patch.recusado_motivo = mensagem;
      }
      if (para === 'cancelada') patch.cancelado_em = new Date().toISOString();
      // Compare-and-swap: se alguém já moveu a proposta, esta escrita não casa.
      const atualizada = await s.tryUpdateIf(R_PROPOSTA(), id, { status: proposta.status }, patch, tx);
      if (!atualizada) throw new HttpError(409, 'A proposta mudou enquanto você operava. Recarregue e tente de novo.');
      await registrarEvento(id, String(proposta.status), para, mensagem, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'propostas', registro_id: id, descricao: `Proposta #${id}: ${proposta.status} → ${para}`, dados: { de: proposta.status, para, mensagem }, empresa_id: empresaDoRegistroAudit(R_PROPOSTA(), proposta, actor) },
        tx
      );
      return atualizada;
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R_PROPOSTA());
  }
}

// ----------------------------------------------------------------------------
// POST /api/propostas/:id/converter — proposta aprovada vira pedido de venda
// ----------------------------------------------------------------------------

export async function converterProposta(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirEscrita(actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const resultado = await s.transaction(async (tx) => {
      const proposta = assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id, tx), escopo);

      // ---- IDEMPOTÊNCIA (camada 1): já convertida? devolve o MESMO pedido. ----
      if (Number(proposta.venda_id) > 0) {
        const venda = await s.get(getResource('vendas')!, Number(proposta.venda_id), tx);
        return { venda_id: Number(proposta.venda_id), venda, idempotente: true };
      }

      exigirTransicao(proposta, 'convertida');
      if (propostaExpirada(proposta)) {
        throw new HttpError(409, `A proposta venceu em ${dataISO(proposta.valida_ate)} e não pode mais virar pedido. Reaprove ou faça uma nova.`);
      }

      const itens = await s.list(R_ITEM(), { page: 1, pageSize: 1000, filter: { proposta_id: id }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'A proposta não tem itens — nada a converter.');

      const venda = await s.insert(
        getResource('vendas')!,
        {
          empresa_id: escopo.empresaId,
          cliente_id: Number(proposta.cliente_id),
          representante_id: proposta.representante_id ?? null,
          data: new Date().toISOString().slice(0, 10),
          status: 'aberta',
          canal_venda: 'representante',
          desconto: num(proposta.desconto),
          frete: num(proposta.frete),
          total: num(proposta.total),
          condicao_pagamento: proposta.condicao_pagamento ?? null,
          observacoes: proposta.observacoes ? `Convertida da proposta #${id}. ${String(proposta.observacoes)}`.slice(0, 2000) : `Convertida da proposta #${id}.`,
          proposta_id: id,
        },
        tx
      );

      for (const item of itens.rows) {
        await s.insert(
          getResource('itens_venda')!,
          {
            empresa_id: escopo.empresaId,
            venda_id: Number(venda.id),
            produto_id: Number(item.produto_id),
            tamanho_id: item.tamanho_id ?? null,
            quantidade: Number(item.quantidade),
            preco_unitario: num(item.preco_unitario),
            desconto_pct: num(item.desconto_pct),
            subtotal: num(item.subtotal),
            lista_preco_id: item.lista_preco_id ?? null,
            preco_tabela: item.preco_tabela ?? null,
          },
          tx
        );
      }

      // ---- IDEMPOTÊNCIA (camada 3): compare-and-swap na própria proposta. ----
      // Quem perde a corrida faz rollback e o pedido criado acima desaparece.
      const convertida = await s.tryUpdateIf(
        R_PROPOSTA(),
        id,
        { status: 'aprovada', venda_id: null },
        { status: 'convertida', venda_id: Number(venda.id), convertido_em: new Date().toISOString(), convertido_por: actor.id || null },
        tx
      );
      if (!convertida) {
        throw new HttpError(409, 'Esta proposta já foi convertida por outra operação. Nenhum pedido duplicado foi criado.');
      }

      await registrarEvento(id, 'aprovada', 'convertida', `Convertida no pedido de venda #${venda.id}.`, { id: actor.id || null, name: actor.name }, escopo.empresaId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'propostas', registro_id: id, descricao: `Proposta #${id} convertida no pedido #${venda.id}`, dados: { venda_id: Number(venda.id) }, empresa_id: empresaDoRegistroAudit(R_PROPOSTA(), proposta, actor) },
        tx
      );
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'vendas', registro_id: Number(venda.id), descricao: `Pedido #${venda.id} criado a partir da proposta #${id}`, dados: { proposta_id: id }, empresa_id: empresaDoRegistroAudit(getResource('vendas')!, venda, actor) },
        tx
      );
      return { venda_id: Number(venda.id), venda, idempotente: false };
    }, { isolation: 'serializable' });

    const vendaFinal = (await s.get(getResource('vendas')!, resultado.venda_id)) || resultado.venda;
    res.status(resultado.idempotente ? 200 : 201).json({
      ok: true,
      proposta_id: id,
      venda_id: resultado.venda_id,
      // Repetição da mesma conversão devolve o pedido existente — não um novo.
      idempotente: resultado.idempotente,
      venda: vendaFinal,
      mensagem: resultado.idempotente
        ? 'Esta proposta já havia sido convertida; devolvendo o pedido existente.'
        : 'Proposta convertida em pedido de venda.',
    });
  } catch (e) {
    throw toHttpError(e, R_PROPOSTA());
  }
}

/** GET /api/propostas/:id/eventos */
export async function eventosProposta(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_PROPOSTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(R_PROPOSTA(), await s.get(R_PROPOSTA(), id), escopo);
  const out = await s.list(R_EVENTO(), { page: 1, pageSize: 500, filter: { proposta_id: id }, sort: 'id', dir: 'asc' });
  res.json(out.rows);
}
