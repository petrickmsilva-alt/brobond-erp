// ============================================================================
// COMPRAS — aprovação, recebimento PARCIAL e sugestão de compra (P1)
//
// RECEBIMENTO PARCIAL
// Antes, `compras.status` era tudo-ou-nada: marcar "recebido" subia o saldo do
// pedido inteiro, mesmo que o fornecedor tivesse entregado metade. Agora cada
// recebimento é uma linha em `compra_recebimentos` com os itens e quantidades
// efetivamente conferidos, e:
//
//   • o estoque sobe EXATAMENTE a quantidade recebida, nunca a pedida;
//   • `itens_compra.quantidade_recebida` é atualizada por UPDATE condicional
//     (compare-and-swap): dois recebimentos simultâneos do mesmo item não
//     conseguem somar acima do pedido — o segundo falha e faz rollback;
//   • o CHECK `itens_compra_nao_excede_pedido` impede reduzir a quantidade
//     pedida para baixo do que já chegou;
//   • a compra vai para `parcial` e só vira `recebido` quando tudo chegou;
//   • receber duas vezes o mesmo recebimento é impossível (idempotency_key).
//
// SUGESTÃO DE COMPRA
// Calculada, não gravada. Ela olha estoque atual, mínimo/máximo, consumo,
// pedidos de venda em aberto e compras em trânsito. E NÃO gera pedido nenhum:
// gerar exige uma ação explícita do usuário (POST com a lista revisada).
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa, empresaDoRegistroAudit } from './empresa';
import { parseId } from './validate';
import { round2, round3 } from './utils';
import { syncLancamentoCompra } from './financeiro';
import type { Row, Tx } from './store';

export const R_RECEBIMENTO = () => getResource('compra_recebimentos')!;
export const R_RECEBIMENTO_ITEM = () => getResource('compra_recebimento_itens')!;

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

// ----------------------------------------------------------------------------
// APROVAÇÃO
// ----------------------------------------------------------------------------

/** POST /api/compras/:id/aprovar — alçada: gerente ou admin. */
export async function aprovarCompra(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('compras')!;
  checkAccess(r, actor, 'update');
  if (actor.perfil === 'operador') throw new HttpError(403, 'Somente gerentes e administradores aprovam pedidos de compra.');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const limite = req.body?.limite_alcada !== undefined ? round2(num(req.body.limite_alcada)) : null;
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const compra = assertRegistroDaEmpresa(r, await s.get(r, id, tx), escopo);
      if (String(compra.status) !== 'pendente') throw new HttpError(409, `Só se aprova um pedido pendente (status atual: ${compra.status}).`);
      // Alçada: se a compra passou do limite do usuário, a aprovação para aqui
      // em vez de seguir silenciosamente.
      if (limite !== null && num(compra.total) > limite) {
        throw new HttpError(403, `Este pedido (${num(compra.total).toFixed(2)}) está acima da sua alçada de ${limite.toFixed(2)}. Encaminhe para um administrador.`);
      }
      const atualizada = await s.tryUpdateIf(r, id, { status: 'pendente' }, { status: 'aprovado', aprovada_em: new Date().toISOString(), aprovada_por: actor.id || null }, tx);
      if (!atualizada) throw new HttpError(409, 'O pedido mudou durante a aprovação. Recarregue.');
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'compras', registro_id: id, descricao: `Pedido de compra #${id} aprovado (total ${num(compra.total).toFixed(2)})`, dados: { total: num(compra.total) }, empresa_id: empresaDoRegistroAudit(r, compra, actor) },
        tx
      );
      return atualizada;
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, r);
  }
}

// ----------------------------------------------------------------------------
// RECEBIMENTO PARCIAL
// ----------------------------------------------------------------------------

type LinhaRecebimento = { item_compra_id: number; quantidade: number };

function normalizarLinhas(bruto: unknown): LinhaRecebimento[] {
  if (!Array.isArray(bruto) || !bruto.length) {
    throw new HttpError(400, 'Envie `itens` com item_compra_id e quantidade recebida.');
  }
  return bruto.map((raw, index) => {
    const linha = (raw || {}) as Record<string, unknown>;
    const itemId = Number(linha.item_compra_id ?? linha.id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new HttpError(400, `Linha ${index + 1}: item_compra_id inválido.`, { [`itens[${index}].item_compra_id`]: 'Inválido' });
    }
    const quantidade = round3(num(linha.quantidade ?? linha.qtd));
    if (!(quantidade > 0)) {
      throw new HttpError(400, `Linha ${index + 1}: a quantidade recebida deve ser maior que zero.`, { [`itens[${index}].quantidade`]: 'Deve ser > 0' });
    }
    return { item_compra_id: itemId, quantidade };
  });
}

/**
 * POST /api/compras/:id/receber
 *
 * Idempotente por `idempotency_key` (default: `recebimento:compra:<id>:<n>`,
 * com n derivado dos itens e quantidades). Repetir a MESMA requisição devolve o
 * MESMO recebimento; o estoque não sobe duas vezes.
 */
export async function receberParcial(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('compras')!;
  checkAccess(r, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const linhas = normalizarLinhas(body.itens);
  const s = getStore();

  const chave = String(
    body.idempotency_key ||
      req.header('idempotency-key') ||
      `recebimento:compra:${id}:${linhas.map((l) => `${l.item_compra_id}x${l.quantidade}`).join(',')}`
  ).slice(0, 160);

  try {
    const out = await s.transaction(async (tx) => {
      const compra = assertRegistroDaEmpresa(r, await s.get(r, id, tx), escopo);
      if (String(compra.status) === 'cancelado') throw new HttpError(409, 'Compra cancelada não pode ser recebida.');
      if (String(compra.status) === 'recebido') throw new HttpError(409, 'Esta compra já foi totalmente recebida.');

      // ---- idempotência: mesma chave devolve o mesmo recebimento ----
      const jaExiste = await s.findOneWhere(R_RECEBIMENTO(), { compra_id: id, documento: chave.slice(0, 60) }, tx);
      if (jaExiste) return { recebimento: jaExiste, idempotente: true, entradas: [], total: num(jaExiste.total) };

      const itens = await s.list(getResource('itens_compra')!, { page: 1, pageSize: 1000, filter: { compra_id: id }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'A compra não tem itens para receber.');
      const porId = new Map(itens.rows.map((i) => [Number(i.id), i]));

      const local = body.local ? String(body.local).slice(0, 60) : String(compra.local_entrada || (await getDefaultLocal(tx)));
      const localRow = await s.findOneWhere(getResource('locais')!, { nome: local }, tx);
      if (!localRow) throw new HttpError(400, `O armazém "${local}" não está cadastrado.`, { local: 'Não encontrado' });

      const entradas: { produto_id: number | null; insumo_id: number | null; tamanho_id: number | null; quantidade: number; item_id: number }[] = [];
      let total = 0;

      for (const linha of linhas) {
        const item = porId.get(linha.item_compra_id);
        if (!item) throw new HttpError(404, `O item #${linha.item_compra_id} não pertence a esta compra.`);
        const pedido = round3(num(item.quantidade));
        const jaRecebido = round3(num(item.quantidade_recebida));
        const restante = round3(pedido - jaRecebido);
        if (linha.quantidade > restante + 1e-6) {
          throw new HttpError(
            409,
            `O item #${linha.item_compra_id} pede ${pedido} e já tem ${jaRecebido} recebido(s). Restam ${restante} — não é possível receber ${linha.quantidade}.`,
            { item_compra_id: linha.item_compra_id, pedido, ja_recebido: jaRecebido, restante }
          );
        }
        // COMPARE-AND-SWAP: o incremento só é aplicado se a quantidade recebida
        // ainda for a que lemos. Dois recebimentos simultâneos do mesmo item
        // não conseguem somar acima do pedido — o perdedor faz rollback.
        const novoTotal = round3(jaRecebido + linha.quantidade);
        const aplicado = await s.tryUpdateIf(
          getResource('itens_compra')!,
          linha.item_compra_id,
          { quantidade_recebida: jaRecebido },
          { quantidade_recebida: novoTotal },
          tx
        );
        if (!aplicado) {
          throw new HttpError(409, `O item #${linha.item_compra_id} foi recebido por outra operação ao mesmo tempo. Recarregue a compra e tente de novo.`);
        }
        total = round2(total + round3(linha.quantidade) * num(item.preco_unitario));
        entradas.push({
          produto_id: item.produto_id === null || item.produto_id === undefined ? null : Number(item.produto_id),
          insumo_id: item.insumo_id === null || item.insumo_id === undefined ? null : Number(item.insumo_id),
          tamanho_id: item.tamanho_id === null || item.tamanho_id === undefined ? null : Number(item.tamanho_id),
          quantidade: Math.trunc(linha.quantidade),
          item_id: linha.item_compra_id,
        });
      }

      const recebimento = await s.insert(
        R_RECEBIMENTO(),
        {
          empresa_id: escopo.empresaId,
          compra_id: id,
          data: body.data ? new Date(String(body.data)).toISOString() : new Date().toISOString(),
          local,
          // `documento` guarda a chave de idempotência — é o que permite
          // reconhecer a repetição sem coluna nova.
          documento: chave.slice(0, 60),
          total,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 500) : null,
          usuario_id: actor.id || null,
        },
        tx
      );

      for (const e of entradas) {
        await s.insert(R_RECEBIMENTO_ITEM(), { empresa_id: escopo.empresaId, recebimento_id: Number(recebimento.id), item_compra_id: e.item_id, quantidade: e.quantidade }, tx);
      }

      // ---- estoque: sobe EXATAMENTE o que foi recebido ----
      for (const e of entradas) {
        if (e.quantidade <= 0) continue;
        if (e.produto_id) {
          await s.adjustStock(e.produto_id, e.tamanho_id as number, local, e.quantidade, tx);
          await s.insert(
            getResource('movimentacoes')!,
            { tipo: 'entrada', produto_id: e.produto_id, tamanho_id: e.tamanho_id, local, quantidade: e.quantidade, motivo: `Recebimento parcial — Compra #${id}`, compra_id: id, usuario_id: actor.id || null },
            tx
          );
        } else if (e.insumo_id) {
          await s.adjustInsumoStock(e.insumo_id, e.quantidade, tx);
          await s.insert(
            getResource('movimentacoes_insumos')!,
            { tipo: 'entrada', insumo_id: e.insumo_id, quantidade: e.quantidade, motivo: `Recebimento parcial — Compra #${id}`, usuario_id: actor.id || null },
            tx
          );
        }
      }

      // ---- status: parcial até tudo chegar ----
      const itensDepois = await s.list(getResource('itens_compra')!, { page: 1, pageSize: 1000, filter: { compra_id: id } }, tx);
      const completo = itensDepois.rows.every((i) => round3(num(i.quantidade_recebida)) >= round3(num(i.quantidade)) - 1e-6);
      const novoStatus = completo ? 'recebido' : 'parcial';
      const patchCompra: Record<string, unknown> = { status: novoStatus };
      if (completo) patchCompra.recebida_em = new Date().toISOString();
      await s.update(r, id, patchCompra, tx);

      const compraDepois = (await s.get(r, id, tx)) || compra;
      // O financeiro só é lançado quando a compra está completa: um lançamento
      // por recebimento parcial duplicaria a conta a pagar.
      if (completo) {
        await syncLancamentoCompra(compra, compraDepois, { status: 'recebido' }, { id: actor.id || null, name: actor.name }, tx);
      }

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'compras',
          registro_id: id,
          descricao: `Compra #${id}: recebimento ${completo ? 'TOTAL' : 'PARCIAL'} de ${entradas.reduce((acc, e) => acc + e.quantidade, 0)} unidade(s) em "${local}"`,
          dados: { recebimento_id: Number(recebimento.id), entradas, total, status: novoStatus },
          empresa_id: empresaDoRegistroAudit(r, compra, actor),
        },
        tx
      );
      return { recebimento, idempotente: false, entradas, total, completo, status: novoStatus };
    }, { isolation: 'serializable' });

    res.status(out.idempotente ? 200 : 201).json({
      ok: true,
      idempotente: out.idempotente,
      recebimento: out.recebimento,
      entradas_estoque: out.entradas,
      total: out.total,
      status: out.idempotente ? undefined : out.status,
      mensagem: out.idempotente
        ? 'Este recebimento já havia sido registrado; nenhuma entrada duplicada de estoque foi feita.'
        : out.completo
          ? 'Compra totalmente recebida: estoque atualizado e contas a pagar geradas.'
          : 'Recebimento parcial registrado: o estoque subiu apenas pela quantidade recebida.',
    });
  } catch (e) {
    throw toHttpError(e, r);
  }
}

/** GET /api/compras/:id/recebimentos */
export async function listarRecebimentos(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('compras')!;
  checkAccess(r, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const s = getStore();
  assertRegistroDaEmpresa(r, await s.get(r, id), escopo);
  const recebimentos = await s.list(R_RECEBIMENTO(), { page: 1, pageSize: 500, filter: { compra_id: id }, sort: 'id', dir: 'asc' });
  const itens = await s.list(getResource('itens_compra')!, { page: 1, pageSize: 1000, filter: { compra_id: id }, sort: 'id', dir: 'asc' });
  res.json({
    compra_id: id,
    itens: itens.rows.map((i) => ({ item_compra_id: i.id, produto_id: i.produto_id, insumo_id: i.insumo_id, quantidade: num(i.quantidade), quantidade_recebida: num(i.quantidade_recebida), restante: round3(num(i.quantidade) - num(i.quantidade_recebida)) })),
    recebimentos: recebimentos.rows,
  });
}

// ----------------------------------------------------------------------------
// SUGESTÃO DE COMPRA
// ----------------------------------------------------------------------------

export type LinhaSugestao = {
  produto_id: number;
  sku: string | null;
  nome: string | null;
  estoque_atual: number;
  estoque_min: number;
  estoque_max: number;
  consumo_medio_mensal: number;
  em_pedidos_venda: number;
  em_compras_transito: number;
  disponivel_projetado: number;
  sugerido: number;
  fornecedor_id: number | null;
  codigo_fornecedor: string | null;
  custo_unitario: number;
  custo_total: number;
  motivo: string;
};

/**
 * Calcula a sugestão. Pura o suficiente para testar: recebe os dados, devolve
 * a linha. Exportada para o teste unitário da fórmula.
 */
export function sugerirQuantidade(input: {
  estoqueAtual: number;
  estoqueMin: number;
  estoqueMax: number;
  consumoMensal: number;
  emPedidosVenda: number;
  emComprasTransito: number;
}): { sugerido: number; disponivelProjetado: number; motivo: string } {
  const { estoqueAtual, estoqueMin, estoqueMax, consumoMensal, emPedidosVenda, emComprasTransito } = input;
  // O que sobra depois de atender o que já foi vendido e o que já está vindo.
  const disponivelProjetado = estoqueAtual + emComprasTransito - emPedidosVenda;
  if (disponivelProjetado >= estoqueMin) {
    return { sugerido: 0, disponivelProjetado, motivo: 'Estoque projetado acima do mínimo.' };
  }
  // Alvo: o teto declarado. Sem teto, cobre 1 mês de consumo além do mínimo —
  // uma regra explícita, não um palpite.
  const alvo = estoqueMax > estoqueMin ? estoqueMax : Math.max(estoqueMin, Math.ceil(consumoMensal) + estoqueMin);
  const bruto = alvo - disponivelProjetado;
  if (bruto <= 0) return { sugerido: 0, disponivelProjetado, motivo: 'Estoque projetado suficiente.' };
  return {
    sugerido: Math.max(1, Math.ceil(bruto)),
    disponivelProjetado,
    motivo:
      emComprasTransito > 0
        ? `Estoque projetado ${disponivelProjetado} abaixo do mínimo ${estoqueMin} (há ${emComprasTransito} em trânsito).`
        : `Estoque projetado ${disponivelProjetado} abaixo do mínimo ${estoqueMin}.`,
  };
}

/**
 * GET /api/suprimentos/sugestao-compra
 *
 * Só calcula. Não cria pedido de compra — isso exige POST explícito.
 */
export async function sugestaoCompra(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('compras')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const empresaId = escopo.empresaId;
  const diasConsumo = Math.min(365, Math.max(30, Number(req.query.dias) || 90));
  const s = getStore();

  const filtro = { empresa_id: empresaId, ativo: true };
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: filtro });
  const estoques = await s.list(getResource('estoques')!, { page: 1, pageSize: 50000, filter: { empresa_id: empresaId } });
  const itensVenda = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 100000, filter: { empresa_id: empresaId } });
  const vendas = await s.list(getResource('vendas')!, { page: 1, pageSize: 50000, filter: { empresa_id: empresaId } });
  const compras = await s.list(getResource('compras')!, { page: 1, pageSize: 20000, filter: { empresa_id: empresaId } });
  const itensCompra = await s.list(getResource('itens_compra')!, { page: 1, pageSize: 100000, filter: { empresa_id: empresaId } });
  const movimentos = await s.list(getResource('movimentacoes')!, { page: 1, pageSize: 200000, filter: { empresa_id: empresaId } });

  // ---- estoque atual por produto ----
  const estoqueAtual = new Map<number, number>();
  for (const e of estoques.rows) {
    const pid = Number(e.produto_id);
    estoqueAtual.set(pid, (estoqueAtual.get(pid) || 0) + num(e.quantidade));
  }

  // ---- pedidos de venda em aberto (reserva o que já foi vendido) ----
  const vendasAbertas = new Set(vendas.rows.filter((v) => ['aberta', 'cotacao'].includes(String(v.status))).map((v) => Number(v.id)));
  const emPedidosVenda = new Map<number, number>();
  for (const i of itensVenda.rows) {
    if (!vendasAbertas.has(Number(i.venda_id))) continue;
    const pid = Number(i.produto_id);
    emPedidosVenda.set(pid, (emPedidosVenda.get(pid) || 0) + num(i.quantidade));
  }

  // ---- compras em trânsito (pedidas, ainda não recebidas) ----
  const comprasAbertas = new Set(compras.rows.filter((c) => ['pendente', 'aprovado', 'parcial'].includes(String(c.status))).map((c) => Number(c.id)));
  const emComprasTransito = new Map<number, number>();
  for (const i of itensCompra.rows) {
    if (!comprasAbertas.has(Number(i.compra_id))) continue;
    if (!i.produto_id) continue;
    const pid = Number(i.produto_id);
    const restante = round3(num(i.quantidade) - num(i.quantidade_recebida));
    if (restante <= 0) continue;
    emComprasTransito.set(pid, (emComprasTransito.get(pid) || 0) + restante);
  }

  // ---- consumo: saídas de estoque no período ----
  const desde = new Date();
  desde.setDate(desde.getDate() - diasConsumo);
  const desdeISO = desde.toISOString();
  const saidas = new Map<number, number>();
  for (const m of movimentos.rows) {
    if (String(m.tipo) !== 'saida') continue;
    if (String(m.data || m.criado_em || '') < desdeISO) continue;
    const pid = Number(m.produto_id);
    saidas.set(pid, (saidas.get(pid) || 0) + Math.abs(num(m.quantidade)));
  }
  const meses = Math.max(1, diasConsumo / 30);

  const linhas: LinhaSugestao[] = [];
  for (const p of produtos.rows) {
    const pid = Number(p.id);
    const min = Math.trunc(num(p.estoque_min));
    if (min <= 0) continue;
    const atual = estoqueAtual.get(pid) || 0;
    const consumo = round2((saidas.get(pid) || 0) / meses);
    const calculo = sugerirQuantidade({
      estoqueAtual: atual,
      estoqueMin: min,
      estoqueMax: Math.trunc(num(p.estoque_max)),
      consumoMensal: consumo,
      emPedidosVenda: emPedidosVenda.get(pid) || 0,
      emComprasTransito: Math.trunc(emComprasTransito.get(pid) || 0),
    });
    if (calculo.sugerido <= 0) continue;
    const custo = round2(num(p.custo));
    linhas.push({
      produto_id: pid,
      sku: p.sku ? String(p.sku) : null,
      nome: p.nome ? String(p.nome) : null,
      estoque_atual: atual,
      estoque_min: min,
      estoque_max: Math.trunc(num(p.estoque_max)),
      consumo_medio_mensal: consumo,
      em_pedidos_venda: emPedidosVenda.get(pid) || 0,
      em_compras_transito: Math.trunc(emComprasTransito.get(pid) || 0),
      disponivel_projetado: calculo.disponivelProjetado,
      sugerido: calculo.sugerido,
      fornecedor_id: p.fornecedor_id ? Number(p.fornecedor_id) : null,
      codigo_fornecedor: p.codigo_fornecedor ? String(p.codigo_fornecedor) : null,
      custo_unitario: custo,
      custo_total: round2(custo * calculo.sugerido),
      motivo: calculo.motivo,
    });
  }
  linhas.sort((a, b) => b.custo_total - a.custo_total || a.sku!.localeCompare(b.sku || ''));

  res.json({
    empresa_id: empresaId,
    periodo_consumo_dias: diasConsumo,
    // A sugestão é um CÁLCULO: nada aqui vira pedido sem ação do usuário.
    automatico: false,
    total_itens: linhas.length,
    total_unidades: linhas.reduce((acc, l) => acc + l.sugerido, 0),
    custo_estimado: round2(linhas.reduce((acc, l) => acc + l.custo_total, 0)),
    por_fornecedor: agruparPorFornecedor(linhas),
    itens: linhas,
  });
}

function agruparPorFornecedor(linhas: LinhaSugestao[]): { fornecedor_id: number | null; itens: number; unidades: number; custo: number }[] {
  const mapa = new Map<number | null, { fornecedor_id: number | null; itens: number; unidades: number; custo: number }>();
  for (const l of linhas) {
    const chave = l.fornecedor_id;
    const atual = mapa.get(chave) || { fornecedor_id: chave, itens: 0, unidades: 0, custo: 0 };
    atual.itens += 1;
    atual.unidades += l.sugerido;
    atual.custo = round2(atual.custo + l.custo_total);
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => b.custo - a.custo);
}

/**
 * POST /api/suprimentos/sugestao-compra/gerar
 *
 * Ação EXPLÍCITA do usuário: recebe a lista revisada (fornecedor + itens +
 * quantidades) e cria o pedido de compra. A sugestão sozinha nunca cria nada.
 */
export async function gerarCompraDaSugestao(req: Request, res: Response) {
  const actor = currentUser(req);
  const r = getResource('compras')!;
  checkAccess(r, actor, 'create');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const fornecedorId = Number(body.fornecedor_id);
  if (!Number.isInteger(fornecedorId) || fornecedorId <= 0) {
    throw new HttpError(400, 'Informe o fornecedor do pedido de compra.', { fornecedor_id: 'Obrigatório' });
  }
  const itensBrutos = Array.isArray(body.itens) ? body.itens : [];
  if (!itensBrutos.length) throw new HttpError(400, 'Envie a lista revisada de itens em `itens`.');
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const fornecedor = assertRegistroDaEmpresa(getResource('fornecedores')!, await s.get(getResource('fornecedores')!, fornecedorId, tx), escopo);
      const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }, tx);
      const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));

      const compra = await s.insert(
        r,
        {
          empresa_id: escopo.empresaId,
          fornecedor_id: fornecedorId,
          data: body.data ? String(body.data).slice(0, 10) : new Date().toISOString().slice(0, 10),
          status: 'pendente',
          previsao_entrega: body.previsao_entrega ? String(body.previsao_entrega).slice(0, 10) : null,
          condicao_pagamento: body.condicao_pagamento ? String(body.condicao_pagamento).slice(0, 60) : null,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 2000) : 'Gerada a partir da sugestão de compra.',
        },
        tx
      );

      let total = 0;
      const criados: { item_compra_id: number; produto_id: number; quantidade: number; preco: number }[] = [];
      for (const raw of itensBrutos as Record<string, unknown>[]) {
        const pid = Number(raw.produto_id);
        const produto = porId.get(pid);
        if (!produto) throw new HttpError(404, `Produto #${pid} não encontrado nesta empresa.`);
        const quantidade = Math.trunc(num(raw.quantidade));
        if (!(quantidade > 0)) throw new HttpError(400, `A quantidade do produto ${produto.sku} deve ser maior que zero.`, { itens: 'quantidade' });
        // O preço vem da ficha (custo habitual) ou do que o comprador revisou.
        const preco = raw.preco_unitario !== undefined && raw.preco_unitario !== null && raw.preco_unitario !== '' ? round2(num(raw.preco_unitario)) : round2(num(produto.custo));
        const item = await s.insert(
          getResource('itens_compra')!,
          {
            empresa_id: escopo.empresaId,
            compra_id: Number(compra.id),
            produto_id: pid,
            insumo_id: null,
            quantidade: round3(quantidade),
            quantidade_recebida: 0,
            preco_unitario: preco,
            codigo_fornecedor: produto.codigo_fornecedor ?? null,
            ncm: produto.ncm ?? null,
            unidade: produto.unidade ?? null,
          },
          tx
        );
        total = round2(total + preco * quantidade);
        criados.push({ item_compra_id: Number(item.id), produto_id: pid, quantidade, preco });
      }
      await s.update(r, Number(compra.id), { total }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'compras', registro_id: Number(compra.id), descricao: `Pedido de compra #${compra.id} gerado da sugestão — ${criados.length} item(ns), total ${total.toFixed(2)}`, dados: { fornecedor_id: fornecedorId, itens: criados, total }, empresa_id: empresaDoRegistroAudit(r, compra, actor) },
        tx
      );
      const final = (await s.get(r, Number(compra.id), tx)) || compra;
      return { compra: final, total, criados };
    }, { isolation: 'serializable' });
    res.status(201).json({ ok: true, compra: out.compra, itens: out.criados, total: out.total, mensagem: 'Pedido de compra criado a partir da sugestão. Ele entra como pendente — aprove e receba normalmente.' });
  } catch (e) {
    throw toHttpError(e, r);
  }
}
