// ============================================================================
// LISTAS DE PREÇO — P1
//
// Uma lista de preço é um conjunto de preços com vigência e prioridade. A
// resolução é DETERMINÍSTICA e explicável:
//
//   1) lista ATIVA;
//   2) dentro da vigência (inicio_em ≤ hoje ≤ fim_em, quando informados);
//   3) que tenha preço para o produto;
//   4) desempate: MAIOR prioridade → MAIS RECENTE (maior id).
//
// O preço resolvido é CONGELADO no item da venda (`lista_preco_id` e
// `preco_tabela`). É isso que impede a lista de reescrever a história: mudar a
// lista amanhã não muda o que foi vendido ontem.
//
// Toda alteração de preço deixa uma linha em `listas_preco_historico`.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import type { Row, Tx } from './store';

export const R_LISTA = () => getResource('listas_preco')!;
export const R_LISTA_ITEM = () => getResource('lista_preco_itens')!;
export const R_LISTA_HIST = () => getResource('listas_preco_historico')!;

export type PrecoResolvido = {
  preco: number;
  origem: 'lista' | 'produto';
  lista_id: number | null;
  lista_nome: string | null;
  preco_tabela: number;
};

function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function dataISO(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v).slice(0, 10);
}

/** A lista vale hoje? (ativa + vigência) */
export function listaVigente(lista: Row, referencia?: string): boolean {
  if (lista.ativo === false) return false;
  const hoje = referencia || hojeISO();
  const inicio = dataISO(lista.inicio_em);
  const fim = dataISO(lista.fim_em);
  if (inicio && hoje < inicio) return false;
  if (fim && hoje > fim) return false;
  return true;
}

/**
 * Ordena as listas candidatas na ordem de aplicação.
 * Exportada porque os testes precisam provar o desempate.
 */
export function ordenarListas(listas: Row[]): Row[] {
  return [...listas].sort(
    (a, b) => num(b.prioridade) - num(a.prioridade) || num(b.id) - num(a.id)
  );
}

/**
 * Listas aplicáveis para um produto, na ordem de prioridade.
 * O filtro por produto acontece no banco (índice `lista_preco_itens_empresa_idx`).
 */
export async function listasParaProduto(
  produtoId: number,
  escopo: EscopoEmpresa,
  tx?: Tx,
  referencia?: string
): Promise<Row[]> {
  const s = getStore();
  const itens = await s.list(
    R_LISTA_ITEM(),
    { page: 1, pageSize: 500, filter: { produto_id: produtoId, empresa_id: escopo.empresaId } },
    tx
  );
  if (!itens.rows.length) return [];
  const listaIds = [...new Set(itens.rows.map((i) => Number(i.lista_id)))];
  const listas = await s.list(
    R_LISTA(),
    { page: 1, pageSize: 500, filter: { empresa_id: escopo.empresaId, ativo: true } },
    tx
  );
  const porId = new Map(listas.rows.map((l) => [Number(l.id), l]));
  const candidatas = listaIds
    .map((id) => porId.get(id))
    .filter((l): l is Row => !!l && listaVigente(l, referencia));
  return ordenarListas(candidatas);
}

/**
 * Preço que vale para o produto.
 * Sem lista aplicável, cai no preço da ficha — nunca inventa valor.
 */
export async function precoDe(
  produto: Row,
  escopo: EscopoEmpresa,
  tx?: Tx,
  referencia?: string
): Promise<PrecoResolvido> {
  const s = getStore();
  const produtoId = Number(produto.id);
  const precoFicha = round2(num(produto.preco_venda));
  const candidatas = await listasParaProduto(produtoId, escopo, tx, referencia);
  for (const lista of candidatas) {
    const item = await s.findOneWhere(
      R_LISTA_ITEM(),
      { lista_id: Number(lista.id), produto_id: produtoId },
      tx
    );
    if (!item) continue;
    return {
      preco: round2(num(item.preco)),
      origem: 'lista',
      lista_id: Number(lista.id),
      lista_nome: String(lista.nome),
      preco_tabela: precoFicha,
    };
  }
  return { preco: precoFicha, origem: 'produto', lista_id: null, lista_nome: null, preco_tabela: precoFicha };
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

/** GET /api/listas-preco/:id/itens — preços da lista com o SKU do produto. */
export async function listarItensLista(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LISTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  const lista = assertRegistroDaEmpresa(R_LISTA(), await s.get(R_LISTA(), id), escopo);
  const itens = await s.list(
    R_LISTA_ITEM(),
    { page: 1, pageSize: 5000, filter: { lista_id: id }, sort: 'id', dir: 'asc' }
  );
  const produtos = await s.list(getResource('produtos')!, {
    page: 1,
    pageSize: 10000,
    filter: { empresa_id: escopo.empresaId },
  });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  res.json({
    lista: { id: lista.id, nome: lista.nome, prioridade: lista.prioridade, ativo: lista.ativo, inicio_em: lista.inicio_em, fim_em: lista.fim_em, vigente: listaVigente(lista) },
    itens: itens.rows.map((i) => {
      const p = porId.get(Number(i.produto_id));
      return {
        id: i.id,
        produto_id: i.produto_id,
        sku: p?.sku ?? null,
        nome: p?.nome ?? null,
        preco: num(i.preco),
        preco_ficha: p ? round2(num(p.preco_venda)) : null,
        diferenca_pct: p && num(p.preco_venda) > 0 ? round2(((num(i.preco) - num(p.preco_venda)) / num(p.preco_venda)) * 100) : null,
      };
    }),
  });
}

/**
 * PUT /api/listas-preco/:id/itens — grava preços em lote.
 * Aceita { itens: [{ produto_id, preco }] } ou { produto_id, preco }.
 * Cada mudança vira uma linha de histórico; nada é gravado pela metade.
 */
export async function gravarItensLista(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LISTA(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const bruto = Array.isArray(body.itens) ? body.itens : Array.isArray(body) ? body : [body];
  if (!bruto.length) throw new HttpError(400, 'Informe ao menos um item com produto_id e preco.');

  const s = getStore();
  const resultado = await s.transaction(async (tx) => {
    const lista = assertRegistroDaEmpresa(R_LISTA(), await s.get(R_LISTA(), id, tx), escopo);
    const produtos = await s.list(
      getResource('produtos')!,
      { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } },
      tx
    );
    const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));

    let criados = 0;
    let alterados = 0;
    let inalterados = 0;
    const erros: { linha: number; produto_id: unknown; mensagem: string }[] = [];

    for (let i = 0; i < bruto.length; i++) {
      const linha = (bruto[i] || {}) as Record<string, unknown>;
      const produtoId = Number(linha.produto_id ?? linha.produtoId);
      if (!Number.isInteger(produtoId) || produtoId <= 0) {
        erros.push({ linha: i + 1, produto_id: linha.produto_id, mensagem: 'produto_id inválido.' });
        continue;
      }
      // O produto precisa existir E pertencer à empresa — senão a lista viraria
      // um canal para escrever preço em produto alheio.
      if (!porId.has(produtoId)) {
        erros.push({ linha: i + 1, produto_id: produtoId, mensagem: 'Produto não encontrado nesta empresa.' });
        continue;
      }
      if (linha.preco === null || linha.preco === undefined || linha.preco === '') {
        erros.push({ linha: i + 1, produto_id: produtoId, mensagem: 'preco é obrigatório.' });
        continue;
      }
      const preco = round2(Number(linha.preco));
      if (!Number.isFinite(preco) || preco < 0) {
        erros.push({ linha: i + 1, produto_id: produtoId, mensagem: 'preco deve ser um número ≥ 0.' });
        continue;
      }
      const atual = await s.findOneWhere(R_LISTA_ITEM(), { lista_id: id, produto_id: produtoId }, tx);
      if (atual) {
        if (round2(num(atual.preco)) === preco) {
          inalterados++;
          continue;
        }
        await s.update(R_LISTA_ITEM(), Number(atual.id), { preco, atualizado_em: new Date().toISOString() }, tx);
        await s.insert(
          R_LISTA_HIST(),
          { empresa_id: escopo.empresaId, lista_id: id, produto_id: produtoId, preco_anterior: num(atual.preco), preco_novo: preco, usuario_id: actor.id || null },
          tx
        );
        alterados++;
      } else {
        await s.insert(R_LISTA_ITEM(), { empresa_id: escopo.empresaId, lista_id: id, produto_id: produtoId, preco }, tx);
        await s.insert(
          R_LISTA_HIST(),
          { empresa_id: escopo.empresaId, lista_id: id, produto_id: produtoId, preco_anterior: null, preco_novo: preco, usuario_id: actor.id || null },
          tx
        );
        criados++;
      }
    }

    if (erros.length && !criados && !alterados && !inalterados) {
      throw new HttpError(422, 'Nenhum preço pôde ser gravado.', { erros });
    }

    await s.audit(
      {
        usuario_id: actor.id || null,
        usuario: actor.name,
        acao: 'editar',
        recurso: 'listas_preco',
        registro_id: id,
        descricao: `Lista "${lista.nome}": ${criados} preço(s) criado(s), ${alterados} alterado(s)`,
        dados: { criados, alterados, inalterados, erros },
        empresa_id: empresaDoRegistroAudit(R_LISTA(), lista, actor),
      },
      tx
    );
    return { criados, alterados, inalterados, erros };
  });

  res.json({ ok: true, lista_id: id, ...resultado });
}

/** DELETE /api/listas-preco/:id/itens/:produtoId — remove o preço da lista. */
export async function removerItemLista(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LISTA(), actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const produtoId = parseId(req.params.produtoId);
  const s = getStore();
  await s.transaction(async (tx) => {
    const lista = assertRegistroDaEmpresa(R_LISTA(), await s.get(R_LISTA(), id, tx), escopo);
    const item = await s.findOneWhere(R_LISTA_ITEM(), { lista_id: id, produto_id: produtoId }, tx);
    if (!item) throw new HttpError(404, 'Este produto não tem preço nesta lista.');
    await s.remove(R_LISTA_ITEM(), Number(item.id), tx);
    await s.insert(
      R_LISTA_HIST(),
      { empresa_id: escopo.empresaId, lista_id: id, produto_id: produtoId, preco_anterior: num(item.preco), preco_novo: null, usuario_id: actor.id || null },
      tx
    );
    await s.audit(
      { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'listas_preco', registro_id: id, descricao: `Preço do produto #${produtoId} removido da lista`, dados: { produto_id: produtoId }, empresa_id: empresaDoRegistroAudit(R_LISTA(), lista, actor) },
      tx
    );
  });
  res.json({ ok: true });
}

/** GET /api/listas-preco/:id/historico — trilha de preços. */
export async function historicoLista(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LISTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(R_LISTA(), await s.get(R_LISTA(), id), escopo);
  const out = await s.list(R_LISTA_HIST(), {
    page: 1,
    pageSize: Math.min(1000, Math.max(1, Number(req.query.limit) || 200)),
    filter: { lista_id: id },
    sort: 'criado_em',
    dir: 'desc',
  });
  res.json(out.rows);
}

/**
 * GET /api/listas-preco/resolver?produto_id=1
 * Mostra QUAL lista venceria e por quê — o preço nunca é um mistério.
 */
export async function resolverLista(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_LISTA(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const produtoId = parseId(req.query.produto_id ?? req.params.produtoId);
  const referencia = req.query.em ? String(req.query.em).slice(0, 10) : undefined;
  const s = getStore();
  const produto = assertRegistroDaEmpresa(getResource('produtos')!, await s.get(getResource('produtos')!, produtoId), escopo);
  const candidatas = await listasParaProduto(produtoId, escopo, null, referencia);
  const detalhe: { lista_id: number; nome: string; prioridade: number; preco: number }[] = [];
  for (const lista of candidatas) {
    const item = await s.findOneWhere(R_LISTA_ITEM(), { lista_id: Number(lista.id), produto_id: produtoId });
    if (item) detalhe.push({ lista_id: Number(lista.id), nome: String(lista.nome), prioridade: num(lista.prioridade), preco: round2(num(item.preco)) });
  }
  const escolhido = await precoDe(produto, escopo, null, referencia);
  res.json({
    produto: { id: produto.id, sku: produto.sku, nome: produto.nome, preco_ficha: round2(num(produto.preco_venda)) },
    referencia: referencia || hojeISO(),
    candidatas: detalhe,
    aplicado: escolhido,
  });
}

/** GET /api/produtos/:id/preco — preço efetivo (usado pelo PDV e pelo pedido). */
export async function precoProduto(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('produtos')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const produtoId = parseId(req.params.id);
  const s = getStore();
  const produto = assertRegistroDaEmpresa(getResource('produtos')!, await s.get(getResource('produtos')!, produtoId), escopo);
  res.json({ produto_id: produtoId, ...(await precoDe(produto, escopo)) });
}

export { toHttpError };
