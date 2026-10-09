// ============================================================================
// E3 — COTAÇÃO DE COMPRA (fornecedor)
//
//   GET    /api/cotacoes-compra/:id/comparativo   matriz item × fornecedor
//   POST   /api/cotacoes-compra/:id/itens         adiciona item ao carrinho
//   PUT    /api/cotacoes-compra/:id/itens/:itemId
//   DELETE /api/cotacoes-compra/:id/itens/:itemId
//   POST   /api/cotacoes-compra/:id/convidar      convida fornecedores
//   POST   /api/cotacoes-compra/:id/abrir         rascunho → cotando
//   POST   /api/cotacoes-compra/:id/cotar         resposta do fornecedor
//   POST   /api/cotacoes-compra/:id/recusar       fornecedor declina
//   POST   /api/cotacoes-compra/:id/decidir       escolhe e GERA o pedido
//   POST   /api/cotacoes-compra/:id/cancelar
//
// Fluxo: RASCUNHO → COTANDO → DECIDIDA   (+ CANCELADA)
//
// Regras que este arquivo existe para garantir:
//
//   1) A DECISÃO GERA O PEDIDO UMA ÚNICA VEZ. `cotacoes_compra.compra_id` tem
//      índice único parcial no banco, e a transição é feita com `tryUpdateIf`
//      (compare-and-swap no status). Duas decisões simultâneas: uma vence e a
//      outra faz rollback do pedido que chegou a criar. Repetir o POST devolve
//      o pedido já gerado, não um segundo.
//
//   2) NENHUM PREÇO É INVENTADO. O comparativo mostra só o que o fornecedor
//      respondeu; item sem cotação aparece sem preço, e a decisão por
//      `menor_preco` recusa o item em vez de chutar valor.
//
//   3) EMPRESA. Toda leitura de cotação passa por `assertRegistroDaEmpresa`.
//      `findOneWhere({ id })` sozinho responde por qualquer empresa — foi
//      exatamente esse o vazamento corrigido na OP durante a E2.
//
//   4) DECIDIR É ATO DE GERENTE. Cotação vira pedido de compra, que vira conta
//      a pagar. Operador monta a cotação, não a decide.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { assertRegistroDaEmpresa, empresaDoRegistroAudit, escopoDoAtor, type EscopoEmpresa } from './empresa';
import { getResource, type Resource } from './resources';
import { checkAccess, getStore, toHttpError } from './services';
import { currentUser } from './auth';
import type { Row, Tx } from './store';
import { parseId } from './validate';
import { labelOf } from './store';
import { round2, round3 } from './utils';

const R = () => getResource('cotacoes_compra')!;
const R_ITENS = () => getResource('cotacao_compra_itens')!;
const R_FORN = () => getResource('cotacao_compra_fornecedores')!;
const R_PRECOS = () => getResource('cotacao_compra_precos')!;

export const STATUS_COTACAO = ['rascunho', 'cotando', 'decidida', 'cancelada'] as const;
export type StatusCotacao = (typeof STATUS_COTACAO)[number];

const ROTULO: Record<string, string> = {
  rascunho: 'rascunho',
  cotando: 'aguardando fornecedores',
  decidida: 'decidida',
  cancelada: 'cancelada',
};

const CRITERIOS = ['menor_preco', 'menor_preco_total', 'prazo', 'qualidade'] as const;
type Criterio = (typeof CRITERIOS)[number];

// ---------------------------------------------------------------------------
// Carga com escopo — obrigatório, não opcional (ver cabeçalho, regra 3).
// ---------------------------------------------------------------------------
async function getCotacao(id: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(R(), { id }, tx);
  return assertRegistroDaEmpresa(R(), row, escopo);
}

function exigirGerente(actor: { perfil?: string }, acao: string): void {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, `Somente gerentes e administradores podem ${acao}.`);
  }
}

function num(v: unknown, padrao = 0): number {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : padrao;
}

/** Itens do carrinho, com o rótulo do insumo/produto resolvido para exibição. */
async function itensDaCotacao(cotacaoId: number, tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const out = await s.list(R_ITENS(), { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { cotacao_id: cotacaoId } }, tx);
  return out.rows;
}

/**
 * Preços de uma cotação, já anotados com o fornecedor do convite.
 *
 * Uma consulta por convite, e não a tabela inteira: `filter` do store é
 * igualdade pura (sem IN), e varrer `cotacao_compra_precos` sem filtro
 * arrastaria preços de outras empresas para a memória só para descartá-los
 * depois. Os convites já vêm escopados pela cotação, então isto é ao mesmo
 * tempo mais barato e sem janela de vazamento.
 */
async function precosDaCotacao(convites: Row[], tx?: Tx): Promise<Row[]> {
  const s = getStore();
  const out: Row[] = [];
  for (const c of convites) {
    const res = await s.list(R_PRECOS(), { page: 1, pageSize: 1000, sort: 'id', dir: 'asc', filter: { convite_id: Number(c.id) } }, tx);
    for (const p of res.rows) {
      out.push({ ...p, fornecedor_id: c.fornecedor_id, fornecedor: c.fornecedor_id__label, convite_status: c.status });
    }
  }
  return out;
}

function rotuloItem(item: Row): string {
  if (item.insumo_id__label) return String(item.insumo_id__label);
  if (item.produto_id__label) return String(item.produto_id__label);
  return item.insumo_id ? `Insumo #${item.insumo_id}` : `Produto #${item.produto_id}`;
}

// ---------------------------------------------------------------------------
// GET /api/cotacoes-compra/:id/comparativo
//
// A matriz que justifica a existência desta tela: para cada item, o preço de
// cada fornecedor, o menor, e a economia entre o maior e o menor. Sem número
// inventado — item sem cotação vem com `precos` vazio e `menor_preco: null`.
// ---------------------------------------------------------------------------
export async function comparativoCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'read');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const cotacao = await getCotacao(id, escopo);
    const itens = await itensDaCotacao(id);
    const convites = await s.list(R_FORN(), { page: 1, pageSize: 200, sort: 'id', dir: 'asc', filter: { cotacao_id: id } });
    const todosPrecos = await precosDaCotacao(convites.rows);
    const porItem = new Map<number, Row[]>();
    for (const p of todosPrecos) {
      const lista = porItem.get(Number(p.item_id)) || [];
      lista.push(p);
      porItem.set(Number(p.item_id), lista);
    }

    const linhas = itens.map((item) => {
      // Todas as propostas aparecem — inclusive as indisponíveis, que a tela
      // mostra riscadas. Escondê-las faria o comprador achar que o fornecedor
      // não respondeu; mas elas NÃO competem no "menor preço" nem na economia.
      const todos = (porItem.get(Number(item.id)) || []).map((p) => ({
        convite_id: Number(p.convite_id),
        fornecedor_id: Number(p.fornecedor_id),
        fornecedor: p.fornecedor ?? null,
        preco_unitario: round2(num(p.preco_unitario)),
        prazo_entrega_dias: p.prazo_entrega_dias === null || p.prazo_entrega_dias === undefined ? null : Number(p.prazo_entrega_dias),
        total: round2(num(p.preco_unitario) * num(item.quantidade)),
        disponivel: p.disponivel !== false,
      }));
      const disponiveis = todos
        .filter((p) => p.disponivel)
        .sort((a, b) => a.preco_unitario - b.preco_unitario);
      const menor = disponiveis[0] ?? null;
      const maior = disponiveis.length ? disponiveis[disponiveis.length - 1] : null;
      return {
        item_id: Number(item.id),
        descricao: rotuloItem(item),
        quantidade: round3(num(item.quantidade)),
        unidade: item.unidade ?? null,
        cotacoes_recebidas: disponiveis.length,
        precos: todos,
        menor_preco: menor?.preco_unitario ?? null,
        melhor_fornecedor: menor?.fornecedor ?? null,
        melhor_prazo_dias: disponiveis.length ? Math.min(...disponiveis.map((p) => p.prazo_entrega_dias ?? Number.MAX_SAFE_INTEGER)) : null,
        economia_potencial: menor && maior ? round2(maior.total - menor.total) : 0,
        escolhido_fornecedor_id: item.escolhido_fornecedor_id ? Number(item.escolhido_fornecedor_id) : null,
        escolhido_preco: item.escolhido_preco === null || item.escolhido_preco === undefined ? null : round2(num(item.escolhido_preco)),
      };
    });

    const fornecedores = convites.rows.map((c) => {
      const meus = todosPrecos.filter((p) => Number(p.convite_id) === Number(c.id) && itens.some((i) => Number(i.id) === Number(p.item_id)));
      const total = round2(
        meus.reduce((acc, p) => {
          const item = itens.find((i) => Number(i.id) === Number(p.item_id));
          return acc + num(p.preco_unitario) * num(item?.quantidade || 0);
        }, 0)
      );
      return {
        convite_id: Number(c.id),
        fornecedor_id: Number(c.fornecedor_id),
        fornecedor: c.fornecedor_id__label ?? `#${c.fornecedor_id}`,
        status: String(c.status),
        itens_cotados: meus.length,
        total_cotado: meus.length === itens.length && itens.length > 0 ? total : null,
        frete: round2(num(c.frete)),
        prazo_entrega_dias: c.prazo_entrega_dias === null || c.prazo_entrega_dias === undefined ? null : Number(c.prazo_entrega_dias),
        condicao_pagamento: c.condicao_pagamento ?? null,
        respondeu_em: c.respondeu_em ?? null,
      };
    });

    res.json({
      cotacao: {
        id: Number(cotacao.id),
        titulo: cotacao.titulo,
        status: String(cotacao.status),
        criterio: cotacao.criterio ?? null,
        prazo_validade: cotacao.prazo_validade ?? null,
        compra_id: cotacao.compra_id ? Number(cotacao.compra_id) : null,
      },
      resumo: {
        itens: itens.length,
        fornecedores: fornecedores.length,
        fornecedores_que_cotaram: fornecedores.filter((f) => f.status === 'cotado').length,
        itens_sem_cotacao: linhas.filter((l) => l.cotacoes_recebidas === 0).length,
        economia_potencial_total: round2(linhas.reduce((a, l) => a + l.economia_potencial, 0)),
      },
      itens: linhas,
      fornecedores,
    });
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// Itens do carrinho — só enquanto a cotação não foi decidida
// ---------------------------------------------------------------------------
function assertEditavel(cotacao: Row, acao: string): void {
  const st = String(cotacao.status);
  if (st === 'decidida' || st === 'cancelada') {
    throw new HttpError(409, `Não dá para ${acao}: a cotação #${cotacao.id} está "${ROTULO[st] || st}".`);
  }
}

export async function criarItemCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'create');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      assertEditavel(cotacao, 'adicionar item');
      const insumoId = req.body?.insumo_id ? Number(req.body.insumo_id) : null;
      const produtoId = req.body?.produto_id ? Number(req.body.produto_id) : null;
      if (!insumoId && !produtoId) throw new HttpError(400, 'Informe o insumo ou o produto do item.', { insumo_id: 'Obrigatório (ou produto_id)' });
      if (insumoId && produtoId) throw new HttpError(400, 'O item é um insumo OU um produto, não os dois.');
      const quantidade = round3(num(req.body?.quantidade));
      if (!(quantidade > 0)) throw new HttpError(400, 'A quantidade deve ser maior que zero.', { quantidade: 'Maior que zero' });

      // Referência validada: insumo/produto de outra empresa não entra na cotação.
      const alvo = insumoId
        ? assertRegistroDaEmpresa(getResource('insumos')!, await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx), escopo)
        : assertRegistroDaEmpresa(getResource('produtos')!, await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx), escopo);

      const existente = await s.findOneWhere(R_ITENS(), { cotacao_id: id, ...(insumoId ? { insumo_id: insumoId } : { produto_id: produtoId }) }, tx);
      if (existente) throw new HttpError(409, `Este item já está na cotação (#${existente.id}). Edite a quantidade em vez de duplicar.`);

      const item = await s.insert(
        R_ITENS(),
        {
          empresa_id: escopo.empresaId,
          cotacao_id: id,
          insumo_id: insumoId,
          produto_id: produtoId,
          quantidade,
          unidade: typeof req.body?.unidade === 'string' ? String(req.body.unidade).slice(0, 20) : (alvo.unidade ?? null),
        },
        tx
      );
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'cotacoes_compra', registro_id: id, descricao: `Cotação #${id}: item ${labelOf(insumoId ? getResource('insumos')! : getResource('produtos')!, alvo)} × ${quantidade} adicionado`, empresa_id: escopo.empresaId },
        tx
      );
      return item;
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

export async function atualizarItemCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      assertEditavel(cotacao, 'editar item');
      const item = await s.findOneWhere(R_ITENS(), { id: itemId }, tx);
      if (!item || Number(item.cotacao_id) !== id) throw new HttpError(404, 'Item não encontrado nesta cotação.');
      const patch: Record<string, unknown> = {};
      if (req.body?.quantidade !== undefined) {
        const q = round3(num(req.body.quantidade));
        if (!(q > 0)) throw new HttpError(400, 'A quantidade deve ser maior que zero.', { quantidade: 'Maior que zero' });
        patch.quantidade = q;
      }
      if (req.body?.unidade !== undefined) patch.unidade = req.body.unidade ? String(req.body.unidade).slice(0, 20) : null;
      const atualizado = await s.update(R_ITENS(), itemId, patch, tx);
      // Mexeu na quantidade: os preços continuam válidos (são unitários), mas os
      // totais do comparativo mudam — nada a invalidar no banco.
      return atualizado;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

export async function removerItemCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      assertEditavel(cotacao, 'remover item');
      const item = await s.findOneWhere(R_ITENS(), { id: itemId }, tx);
      if (!item || Number(item.cotacao_id) !== id) throw new HttpError(404, 'Item não encontrado nesta cotação.');
      await s.remove(R_ITENS(), itemId, tx);
      return null;
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// Convidar fornecedores
// ---------------------------------------------------------------------------
export async function convidarFornecedores(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      assertEditavel(cotacao, 'convidar fornecedores');
      const ids = Array.isArray(req.body?.fornecedor_ids) ? req.body.fornecedor_ids.map((x: unknown) => Number(x)).filter((n: number) => n > 0) : [];
      if (!ids.length) throw new HttpError(400, 'Informe ao menos um fornecedor para convidar.', { fornecedor_ids: 'Lista vazia' });

      const itens = await itensDaCotacao(id, tx);
      if (!itens.length) throw new HttpError(409, 'Adicione ao menos um item antes de convidar fornecedores — convite sem carrinho não tem o que orçar.');

      const criados: Row[] = [];
      const jaConvidados: number[] = [];
      for (const fid of ids) {
        // Fornecedor de outra empresa não entra na cotação.
        assertRegistroDaEmpresa(getResource('fornecedores')!, await s.findOneWhere(getResource('fornecedores')!, { id: fid }, tx), escopo);
        const existente = await s.findOneWhere(R_FORN(), { cotacao_id: id, fornecedor_id: fid }, tx);
        if (existente) {
          jaConvidados.push(fid);
          continue;
        }
        criados.push(await s.insert(R_FORN(), { empresa_id: escopo.empresaId, cotacao_id: id, fornecedor_id: fid, status: 'convidado' }, tx));
      }

      // Convidar já coloca a cotação em andamento: rascunho não recebe cotação.
      let cotacaoDepois = cotacao;
      if (String(cotacao.status) === 'rascunho' && criados.length) {
        cotacaoDepois = (await s.update(R(), id, { status: 'cotando' }, tx)) || cotacao;
      }
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'cotacoes_compra',
          registro_id: id,
          descricao: `Cotação #${id}: ${criados.length} fornecedor(es) convidado(s)${jaConvidados.length ? `, ${jaConvidados.length} já estava(m) convidado(s)` : ''}`,
          dados: { convidados: ids, novos: criados.length, ja_convidados: jaConvidados },
          empresa_id: empresaDoRegistroAudit(R(), cotacao, actor),
        },
        tx
      );
      return { cotacao: cotacaoDepois, convidados: criados.length, ja_convidados: jaConvidados };
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// POST /api/cotacoes-compra/:id/abrir — rascunho → cotando
// ---------------------------------------------------------------------------
export async function abrirCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      if (String(cotacao.status) !== 'rascunho') throw new HttpError(409, `Só se abre uma cotação em rascunho (status atual: ${ROTULO[String(cotacao.status)] || cotacao.status}).`);
      const itens = await itensDaCotacao(id, tx);
      if (!itens.length) throw new HttpError(409, 'Adicione ao menos um item antes de abrir a cotação.');
      const convites = await s.list(R_FORN(), { page: 1, pageSize: 200, filter: { cotacao_id: id } }, tx);
      if (!convites.rows.length) throw new HttpError(409, 'Convide ao menos um fornecedor antes de abrir a cotação.');
      const atualizada = await s.tryUpdateIf(R(), id, { status: 'rascunho' }, { status: 'cotando' }, tx);
      if (!atualizada) throw new HttpError(409, 'A cotação mudou enquanto você operava. Recarregue.');
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// POST /api/cotacoes-compra/:id/cotar — resposta do fornecedor
//
// Idempotente por (convite, item): o índice único `cotacao_compra_precos_uniq`
// garante que reenviar a mesma cotação ATUALIZA em vez de duplicar.
// ---------------------------------------------------------------------------
export async function cotarFornecedor(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      if (String(cotacao.status) !== 'cotando') {
        throw new HttpError(409, `Só se registra cotação com a cotação aberta (status atual: ${ROTULO[String(cotacao.status)] || cotacao.status}).`);
      }
      const conviteId = Number(req.body?.convite_id || 0);
      const convite = await s.findOneWhere(R_FORN(), { id: conviteId }, tx);
      if (!convite || Number(convite.cotacao_id) !== id) throw new HttpError(404, 'Convite não encontrado nesta cotação.');
      assertRegistroDaEmpresa(R_FORN(), convite, escopo);

      const itens = await itensDaCotacao(id, tx);
      const porId = new Map(itens.map((i) => [Number(i.id), i]));
      const precos = Array.isArray(req.body?.precos) ? (req.body.precos as Record<string, unknown>[]) : [];
      if (!precos.length) throw new HttpError(400, 'Envie ao menos um preço.', { precos: 'Lista vazia' });

      const gravados: Row[] = [];
      for (const linha of precos) {
        const itemId = Number(linha.item_id);
        const item = porId.get(itemId);
        if (!item) throw new HttpError(404, `O item #${itemId} não pertence a esta cotação.`);
        const preco = round2(num(linha.preco_unitario));
        if (!(preco >= 0)) throw new HttpError(400, `Preço inválido no item #${itemId}.`, { preco_unitario: 'Número >= 0' });
        const prazo = linha.prazo_entrega_dias === undefined || linha.prazo_entrega_dias === null ? null : Math.trunc(num(linha.prazo_entrega_dias));
        if (prazo !== null && prazo < 0) throw new HttpError(400, `Prazo inválido no item #${itemId}.`, { prazo_entrega_dias: 'Inteiro >= 0' });

        const existente = await s.findOneWhere(R_PRECOS(), { convite_id: conviteId, item_id: itemId }, tx);
        const payload = {
          empresa_id: escopo.empresaId,
          convite_id: conviteId,
          item_id: itemId,
          preco_unitario: preco,
          prazo_entrega_dias: prazo,
          disponivel: linha.disponivel === undefined ? true : Boolean(linha.disponivel),
          observacoes: typeof linha.observacoes === 'string' ? String(linha.observacoes).slice(0, 500) : null,
        };
        gravados.push(existente ? (await s.update(R_PRECOS(), Number(existente.id), payload, tx))! : await s.insert(R_PRECOS(), payload, tx));
      }

      const conviteAtualizado = await s.update(
        R_FORN(),
        conviteId,
        {
          status: 'cotado',
          respondeu_em: new Date().toISOString(),
          frete: req.body?.frete === undefined ? num(convite.frete) : round2(num(req.body.frete)),
          prazo_entrega_dias: req.body?.prazo_entrega_dias === undefined ? convite.prazo_entrega_dias : Math.trunc(num(req.body.prazo_entrega_dias)),
          condicao_pagamento: req.body?.condicao_pagamento === undefined ? convite.condicao_pagamento : (req.body.condicao_pagamento ? String(req.body.condicao_pagamento).slice(0, 120) : null),
          validade_proposta: req.body?.validade_proposta === undefined ? convite.validade_proposta : (req.body.validade_proposta ? String(req.body.validade_proposta).slice(0, 10) : null),
        },
        tx
      );
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'cotacoes_compra',
          registro_id: id,
          descricao: `Cotação #${id}: ${convite?.fornecedor_id__label || `fornecedor #${convite?.fornecedor_id}`} cotou ${gravados.length} item(ns)`,
          dados: { convite_id: conviteId, itens: gravados.length },
          empresa_id: empresaDoRegistroAudit(R(), cotacao, actor),
        },
        tx
      );
      return { convite: conviteAtualizado, precos: gravados.length };
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// POST /api/cotacoes-compra/:id/recusar — fornecedor declina
// ---------------------------------------------------------------------------
export async function recusarCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      if (String(cotacao.status) !== 'cotando') throw new HttpError(409, 'Só se registra recusa com a cotação aberta.');
      const conviteId = Number(req.body?.convite_id || 0);
      const convite = await s.findOneWhere(R_FORN(), { id: conviteId }, tx);
      if (!convite || Number(convite.cotacao_id) !== id) throw new HttpError(404, 'Convite não encontrado nesta cotação.');
      assertRegistroDaEmpresa(R_FORN(), convite, escopo);
      const atualizado = await s.update(R_FORN(), conviteId, { status: 'recusado', respondeu_em: new Date().toISOString() }, tx);
      return atualizado;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// POST /api/cotacoes-compra/:id/decidir
//
// body: { criterio?: 'menor_preco'|'menor_preco_total'|'prazo'|'qualidade',
//         escolhas?: [{ item_id, convite_id }],   // obrigatório p/ 'qualidade'
//         fornecedor_id?, local_entrada?, previsao_entrega?, observacoes? }
//
// Gera o pedido de compra UMA vez. Ver regra 1 do cabeçalho.
// ---------------------------------------------------------------------------
type Escolha = { item_id: number; convite_id: number; preco: number; fornecedor_id: number; prazo: number | null };

export async function decidirCotacaoCompra(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGerente(actor, 'decidir uma cotação de compra');
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);

      // Repetição: devolve o pedido já gerado em vez de criar outro.
      if (cotacao.compra_id) {
        return { cotacao, compra_id: Number(cotacao.compra_id), idempotente: true, linhas: [] as Escolha[] };
      }
      if (String(cotacao.status) !== 'cotando') {
        throw new HttpError(409, `Só se decide uma cotação aberta (status atual: ${ROTULO[String(cotacao.status)] || cotacao.status}).`);
      }

      const criterio = (req.body?.criterio || cotacao.criterio || 'menor_preco') as Criterio;
      if (!CRITERIOS.includes(criterio)) {
        throw new HttpError(400, `Critério inválido: "${criterio}". Use ${CRITERIOS.join(', ')}.`, { criterio: 'Inválido' });
      }

      const itens = await itensDaCotacao(id, tx);
      if (!itens.length) throw new HttpError(409, 'A cotação não tem itens.');
      const convites = await s.list(R_FORN(), { page: 1, pageSize: 200, filter: { cotacao_id: id } }, tx);
      const convitePorId = new Map(convites.rows.map((c) => [Number(c.id), c]));
      const precos = await precosDaCotacao(convites.rows, tx);

      // ---- escolha por item ------------------------------------------------
      const escolhas: Escolha[] = [];
      const semCotacao: string[] = [];

      if (criterio === 'menor_preco_total') {
        // Fornecedor único: só entra quem cotou TODOS os itens e tem tudo
        // disponível. Sem isso a comparação de "total" seria entre coisas
        // diferentes — melhor recusar do que escolher errado.
        const completos = convites.rows.filter((c) => {
          const meus = precos.filter((p) => Number(p.convite_id) === Number(c.id));
          return meus.length === itens.length && meus.every((p) => p.disponivel !== false);
        });
        if (!completos.length) {
          throw new HttpError(409, 'Nenhum fornecedor cotou todos os itens com disponibilidade. Use "menor_preco" para escolher item a item.');
        }
        const comFrete = completos
          .map((c) => {
            const meus = precos.filter((p) => Number(p.convite_id) === Number(c.id));
            const itensTotal = meus.reduce((acc, p) => {
              const item = itens.find((i) => Number(i.id) === Number(p.item_id));
              return acc + num(p.preco_unitario) * num(item?.quantidade || 0);
            }, 0);
            return { convite: c, total: round2(itensTotal + num(c.frete)) };
          })
          .sort((a, b) => a.total - b.total);
        const vencedor = comFrete[0];
        for (const item of itens) {
          const p = precos.find((x) => Number(x.convite_id) === Number(vencedor.convite.id) && Number(x.item_id) === Number(item.id))!;
          escolhas.push({ item_id: Number(item.id), convite_id: Number(vencedor.convite.id), preco: round2(num(p.preco_unitario)), fornecedor_id: Number(vencedor.convite.fornecedor_id), prazo: p.prazo_entrega_dias === null || p.prazo_entrega_dias === undefined ? null : Number(p.prazo_entrega_dias) });
        }
      } else if (criterio === 'qualidade') {
        const pedidas = Array.isArray(req.body?.escolhas) ? (req.body.escolhas as Record<string, unknown>[]) : [];
        if (pedidas.length !== itens.length) {
          throw new HttpError(400, `O critério "qualidade" exige a escolha explícita de cada item (${itens.length} itens, ${pedidas.length} escolhas recebidas).`, { escolhas: 'Um por item' });
        }
        for (const e of pedidas) {
          const itemId = Number(e.item_id);
          const item = itens.find((i) => Number(i.id) === itemId);
          if (!item) throw new HttpError(404, `O item #${itemId} não pertence a esta cotação.`);
          const conviteId = Number(e.convite_id);
          const convite = convitePorId.get(conviteId);
          if (!convite) throw new HttpError(404, `O convite #${conviteId} não pertence a esta cotação.`);
          const p = precos.find((x) => Number(x.convite_id) === conviteId && Number(x.item_id) === itemId);
          if (!p) throw new HttpError(409, `O fornecedor não cotou o item "${rotuloItem(item)}" — não há preço para escolher.`);
          if (p.disponivel === false) throw new HttpError(409, `O fornecedor informou indisponibilidade para "${rotuloItem(item)}".`);
          escolhas.push({ item_id: itemId, convite_id: conviteId, preco: round2(num(p.preco_unitario)), fornecedor_id: Number(convite.fornecedor_id), prazo: p.prazo_entrega_dias === null || p.prazo_entrega_dias === undefined ? null : Number(p.prazo_entrega_dias) });
        }
      } else {
        // menor_preco | prazo — escolha item a item
        for (const item of itens) {
          const candidatos = precos
            .filter((p) => Number(p.item_id) === Number(item.id) && p.disponivel !== false)
            .sort((a, b) =>
              criterio === 'prazo'
                ? (a.prazo_entrega_dias ?? Number.MAX_SAFE_INTEGER) - (b.prazo_entrega_dias ?? Number.MAX_SAFE_INTEGER) || num(a.preco_unitario) - num(b.preco_unitario)
                : num(a.preco_unitario) - num(b.preco_unitario)
            );
          if (!candidatos.length) {
            semCotacao.push(rotuloItem(item));
            continue;
          }
          const p = candidatos[0];
          const convite = convitePorId.get(Number(p.convite_id))!;
          escolhas.push({ item_id: Number(item.id), convite_id: Number(p.convite_id), preco: round2(num(p.preco_unitario)), fornecedor_id: Number(convite.fornecedor_id), prazo: p.prazo_entrega_dias === null || p.prazo_entrega_dias === undefined ? null : Number(p.prazo_entrega_dias) });
        }
        if (semCotacao.length) {
          throw new HttpError(
            409,
            `Nenhum fornecedor cotou: ${semCotacao.join(', ')}. Espere as cotações, marque o item como fora ou decida por "qualidade" escolhendo item a item.`
          );
        }
      }

      // ---- pedido de compra -------------------------------------------------
      // Fornecedor do pedido: quando a escolha é por item pode haver mais de um
      // vencedor. Nesse caso o pedido fica com o fornecedor de maior valor e a
      // divergência vai nas observações — o comprador precisa ver, não descobrir.
      const porFornecedor = new Map<number, number>();
      for (const e of escolhas) {
        const item = itens.find((i) => Number(i.id) === e.item_id);
        porFornecedor.set(e.fornecedor_id, round2((porFornecedor.get(e.fornecedor_id) || 0) + e.preco * num(item?.quantidade || 0)));
      }
      const fornecedoresOrdenados = [...porFornecedor.entries()].sort((a, b) => b[1] - a[1]);
      const fornecedorPrincipal = req.body?.fornecedor_id ? Number(req.body.fornecedor_id) : fornecedoresOrdenados[0][0];
      const multiFornecedor = porFornecedor.size > 1;

      const total = round2(escolhas.reduce((acc, e) => {
        const item = itens.find((i) => Number(i.id) === e.item_id);
        return acc + e.preco * num(item?.quantidade || 0);
      }, 0));

      const compra = await s.insert(getResource('compras')!, {
        empresa_id: escopo.empresaId,
        fornecedor_id: fornecedorPrincipal,
        data: new Date().toISOString().slice(0, 10),
        status: 'pendente',
        total,
        previsao_entrega: req.body?.previsao_entrega ? String(req.body.previsao_entrega).slice(0, 10) : null,
        local_entrada: req.body?.local_entrada ? String(req.body.local_entrada).slice(0, 60) : null,
        observacoes: [
          `Gerado pela cotação #${id} (critério: ${criterio})`,
          multiFornecedor
            ? `ATENÇÃO: escolha por item resultou em ${porFornecedor.size} fornecedores diferentes; este pedido ficou com o de maior valor (${fornecedoresOrdenados.map(([f, v]) => `#${f} R$ ${v.toFixed(2)}`).join(', ')}). Desmembre se precisar.`
            : null,
          req.body?.observacoes ? String(req.body.observacoes).slice(0, 400) : null,
        ].filter(Boolean).join(' · '),
      }, tx);

      for (const e of escolhas) {
        const item = itens.find((i) => Number(i.id) === e.item_id)!;
        await s.insert(getResource('itens_compra')!, {
          empresa_id: escopo.empresaId,
          compra_id: Number(compra.id),
          insumo_id: item.insumo_id ? Number(item.insumo_id) : null,
          produto_id: item.produto_id ? Number(item.produto_id) : null,
          tamanho_id: null,
          codigo_fornecedor: null,
          quantidade: round3(num(item.quantidade)),
          preco_unitario: e.preco,
          unidade: item.unidade ?? null,
        }, tx);
        // A escolha fica gravada no item da cotação: é a trilha de "por que este
        // fornecedor e este preço".
        await s.update(R_ITENS(), e.item_id, { escolhido_fornecedor_id: e.fornecedor_id, escolhido_preco: e.preco }, tx);
      }

      // CAS: só marca decidida se ainda estiver `cotando` e sem pedido. Duas
      // decisões simultâneas — uma vence; a outra faz rollback do pedido acima.
      // O índice único em compra_id é a segunda trava, caso o CAS seja burlado.
      const decidida = await s.tryUpdateIf(
        R(),
        id,
        { status: 'cotando', compra_id: null },
        { status: 'decidida', compra_id: Number(compra.id), decidida_em: new Date().toISOString(), decidida_por: actor.id || null, criterio },
        tx
      );
      if (!decidida) throw new HttpError(409, 'A cotação foi decidida por outra operação ao mesmo tempo. Recarregue.');

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'cotacoes_compra',
          registro_id: id,
          descricao: `Cotação #${id} decidida por ${criterio} → pedido de compra #${compra.id} (R$ ${total.toFixed(2)}, ${escolhas.length} item(ns))`,
          dados: { criterio, compra_id: Number(compra.id), total, itens: escolhas.length, multi_fornecedor: multiFornecedor },
          empresa_id: empresaDoRegistroAudit(R(), cotacao, actor),
        },
        tx
      );
      return { cotacao: decidida, compra_id: Number(compra.id), idempotente: false, linhas: escolhas, total, multi_fornecedor: multiFornecedor };
    });
    res.status(out.idempotente ? 200 : 201).json({
      ...out,
      mensagem: out.idempotente
        ? `Esta cotação já gerou o pedido de compra #${out.compra_id}. Nenhum pedido duplicado foi criado.`
        : `Pedido de compra #${out.compra_id} criado a partir da cotação.`,
    });
  } catch (e) {
    throw toHttpError(e, R());
  }
}

// ---------------------------------------------------------------------------
// POST /api/cotacoes-compra/:id/cancelar
// ---------------------------------------------------------------------------
export async function cancelarCotacao(req: Request, res: Response) {
  const actor = currentUser(req);
  exigirGerente(actor, 'cancelar uma cotação de compra');
  checkAccess(R(), actor, 'update');
  const escopo = escopoDoAtor(actor);
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const cotacao = await getCotacao(id, escopo, tx);
      if (String(cotacao.status) === 'cancelada') throw new HttpError(409, 'A cotação já está cancelada.');
      if (cotacao.compra_id) throw new HttpError(409, `Esta cotação já gerou o pedido #${cotacao.compra_id}. Cancele o pedido, não a cotação — o histórico da escolha precisa ficar.`);
      const atualizada = await s.update(R(), id, { status: 'cancelada' }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'cotacoes_compra', registro_id: id, descricao: `Cotação #${id} cancelada${req.body?.motivo ? ` — ${String(req.body.motivo).slice(0, 200)}` : ''}`, empresa_id: empresaDoRegistroAudit(R(), cotacao, actor) },
        tx
      );
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R());
  }
}

/** Exportado para teste: resolve o recurso sem expor o helper interno. */
export function recursoCotacao(): Resource {
  return R();
}
