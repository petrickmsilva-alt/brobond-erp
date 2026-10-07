// ============================================================================
// EXPEDIÇÃO E LOGÍSTICA REVERSA — P1
//
//   PEDIDO → SEPARAÇÃO → CONFERÊNCIA → EMBALAGEM → EXPEDIÇÃO
//
// A conferência compara o que foi LIDO com o que o pedido PEDE, item a item:
// SKU, tamanho, quantidade. Divergência não é um detalhe logado no fim — é
// gravada em `divergencias_conferencia` mesmo quando a conferência aborta,
// porque é justamente o caso abortado que a operação precisa investigar.
//
// LOGÍSTICA REVERSA:
//   solicitação → autorização → recebimento → conferência → estoque → financeiro
//
// Nada entra no estoque sem rastreabilidade. Três travas:
//   1) só se recebe o que foi AUTORIZADO (CHECK `devolucoes_recebida_tem_autorizacao`);
//   2) a quantidade recebida nunca excede a solicitada (CHECK no item);
//   3) a entrada no estoque é um movimento com motivo explícito e a devolução
//      carimba `devolucao_estoque` uma única vez.
// ============================================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getResource } from './resources';
import { checkAccess, checkFluxo, getDefaultLocal, getStore, toHttpError } from './services';
import { currentUser, type AuthUser } from './auth';
import { assertRegistroDaEmpresa, escopoDoAtor, type EscopoEmpresa } from './empresa';
import { parseId } from './validate';
import { round2 } from './utils';
import { aplicarRegrasPedido } from './itens';
import { syncLancamentoVenda } from './financeiro';
import type { Row, Tx } from './store';

export const R_EXP_EVENTO = () => getResource('expedicao_eventos')!;
export const R_DIVERGENCIA = () => getResource('divergencias_conferencia')!;
export const R_DEVOLUCAO = () => getResource('devolucoes')!;
export const R_DEVOLUCAO_ITEM = () => getResource('devolucao_itens')!;

export type Etapa = 'pendente' | 'separacao' | 'conferida' | 'embalada' | 'expedida';

/** Ordem canônica das etapas. */
export const ETAPAS: Etapa[] = ['pendente', 'separacao', 'conferida', 'embalada', 'expedida'];

/** Avança no máximo uma etapa por vez: pular conferência não é permitido. */
export function proximaEtapa(atual: Etapa | null | undefined, alvo: Etapa): boolean {
  const i = ETAPAS.indexOf((atual || 'pendente') as Etapa);
  const j = ETAPAS.indexOf(alvo);
  if (i < 0 || j < 0) return false;
  return j === i + 1;
}

function num(v: unknown, padrao = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function chaveDoItem(produtoId: number, tamanhoId: number | null): string {
  return `${produtoId}:${tamanhoId ?? 0}`;
}

async function registrarEvento(
  vendaId: number,
  etapa: string,
  deEtapa: string | null,
  resultado: 'ok' | 'divergencia' | 'erro',
  mensagem: string,
  actor: { id: number | null; name: string },
  empresaId: number,
  tx: Tx,
  dados?: unknown
): Promise<void> {
  await getStore().insert(
    R_EXP_EVENTO(),
    { empresa_id: empresaId, venda_id: vendaId, etapa, de_etapa: deEtapa, resultado, mensagem, dados: dados === undefined ? null : dados, usuario_id: actor.id || null },
    tx
  );
}

async function assertVenda(vendaId: number, escopo: EscopoEmpresa, tx?: Tx): Promise<Row> {
  const venda = await getStore().get(getResource('vendas')!, vendaId, tx);
  return assertRegistroDaEmpresa(getResource('vendas')!, venda, escopo);
}

async function avancarEtapa(venda: Row, alvo: Etapa, actor: { id: number | null; name: string }, escopo: EscopoEmpresa, tx: Tx, mensagem: string): Promise<Row> {
  const atual = (String(venda.expedicao_etapa || 'pendente') || 'pendente') as Etapa;
  if (!proximaEtapa(atual, alvo)) {
    throw new HttpError(409, `Não é possível passar de "${atual}" para "${alvo}". A ordem é: ${ETAPAS.join(' → ')}.`);
  }
  const s = getStore();
  const atualizada = await s.tryUpdateIf(getResource('vendas')!, Number(venda.id), { expedicao_etapa: venda.expedicao_etapa ?? null }, { expedicao_etapa: alvo }, tx);
  if (!atualizada) throw new HttpError(409, 'O pedido mudou durante a operação. Recarregue e tente de novo.');
  await registrarEvento(Number(venda.id), alvo === 'conferida' ? 'conferencia' : alvo, atual, 'ok', mensagem, actor, escopo.empresaId, tx);
  await s.audit(
    { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'vendas', registro_id: Number(venda.id), descricao: `Venda #${venda.id}: expedição ${atual} → ${alvo}`, dados: { de: atual, para: alvo } },
    tx
  );
  return atualizada;
}

// ----------------------------------------------------------------------------
// SEPARAÇÃO
// ----------------------------------------------------------------------------

/**
 * POST /api/vendas/:id/expedicao/separar
 * Marca o pedido como em separação e devolve a lista do que separar.
 */
export async function separarPedido(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = await assertVenda(vendaId, escopo, tx);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado não vai para a expedição.');
      if (['faturada', 'entregue'].includes(String(venda.status))) {
        throw new HttpError(409, 'Este pedido já foi faturado — a separação acontece antes do faturamento.');
      }
      const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'O pedido não tem itens para separar.');
      const atualizada = await avancarEtapa(venda, 'separacao', { id: actor.id || null, name: actor.name }, escopo, tx, 'Pedido enviado para separação.');
      return { venda: atualizada, itens: itens.rows };
    }, { isolation: 'serializable' });
    res.json({ ok: true, venda: out.venda, itens: out.itens, etapa: out.venda.expedicao_etapa });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/** GET /api/vendas/:id/expedicao — situação da expedição + trilha. */
export async function situacaoExpedicao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const s = getStore();
  const venda = await assertVenda(vendaId, escopo);
  const eventos = await s.list(R_EXP_EVENTO(), { page: 1, pageSize: 500, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  const divergencias = await s.list(R_DIVERGENCIA(), { page: 1, pageSize: 200, filter: { venda_id: vendaId }, sort: 'id', dir: 'desc' });
  const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' });
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  res.json({
    venda_id: vendaId,
    status_venda: venda.status,
    etapa: venda.expedicao_etapa || 'pendente',
    etapas: ETAPAS,
    itens: itens.rows.map((i) => {
      const p = porId.get(Number(i.produto_id));
      return { produto_id: i.produto_id, sku: p?.sku ?? null, nome: p?.nome ?? null, codigo_barras: p?.codigo_barras ?? null, tamanho_id: i.tamanho_id, quantidade: num(i.quantidade) };
    }),
    eventos: eventos.rows,
    divergencias: divergencias.rows,
  });
}

// ----------------------------------------------------------------------------
// CONFERÊNCIA
// ----------------------------------------------------------------------------

export type Divergencia = {
  faltando: { produto_id: number; sku: string | null; tamanho_id: number | null; quantidade: number }[];
  sobrando: { codigo: string; quantidade: number }[];
};

/**
 * Compara o esperado com o lido.
 *
 * Exportada e pura para que o teste unitário prove os casos chatos: item
 * repetido, quantidade trocada, código lido a mais, código inexistente.
 */
export function compararLeitura(
  esperado: { produto_id: number; sku: string | null; codigo_barras: string | null; tamanho_id: number | null; quantidade: number }[],
  lidos: string[]
): { ok: boolean; faltando: Divergencia['faltando']; sobrando: Divergencia['sobrando']; esperado_total: number; lido_total: number } {
  const porCodigo = new Map<string, { produto_id: number; sku: string | null; tamanho_id: number | null; restante: number }>();
  for (const e of esperado) {
    const codigo = e.codigo_barras ? String(e.codigo_barras) : '';
    if (!codigo) continue;
    const atual = porCodigo.get(codigo);
    if (atual) atual.restante += e.quantidade;
    else porCodigo.set(codigo, { produto_id: e.produto_id, sku: e.sku, tamanho_id: e.tamanho_id, restante: e.quantidade });
  }
  const esperadoTotal = esperado.reduce((acc, e) => acc + e.quantidade, 0);
  const sobrando: Divergencia['sobrando'] = [];
  for (const codigo of lidos) {
    const c = String(codigo);
    const slot = porCodigo.get(c);
    if (!slot || slot.restante <= 0) {
      const achado = sobrando.find((x) => x.codigo === c);
      if (achado) achado.quantidade += 1;
      else sobrando.push({ codigo: c, quantidade: 1 });
      continue;
    }
    slot.restante -= 1;
  }
  const faltando: Divergencia['faltando'] = [];
  for (const e of esperado) {
    const slot = e.codigo_barras ? porCodigo.get(String(e.codigo_barras)) : null;
    const qtdFaltando = slot ? Math.min(slot.restante, e.quantidade) : e.quantidade;
    if (qtdFaltando > 0) {
      faltando.push({ produto_id: e.produto_id, sku: e.sku, tamanho_id: e.tamanho_id, quantidade: qtdFaltando });
      if (slot) slot.restante -= qtdFaltando;
    }
  }
  return { ok: faltando.length === 0 && sobrando.length === 0, faltando, sobrando, esperado_total: esperadoTotal, lido_total: lidos.length };
}

function normalizarLeitura(value: unknown): string[] {
  const bruto = Array.isArray(value) ? value : Array.isArray((value as Record<string, unknown>)?.barcodes) ? ((value as Record<string, unknown>).barcodes as unknown[]) : [];
  if (!bruto.length) throw new HttpError(400, 'Envie os códigos lidos em `codigos` (array de strings).');
  if (!bruto.every((c) => typeof c === 'string' && String(c).trim().length > 0)) {
    throw new HttpError(400, 'Todos os códigos lidos devem ser strings não vazias.');
  }
  return bruto.map((c) => String(c));
}

/**
 * POST /api/vendas/:id/expedicao/conferir
 *
 * Confere byte a byte. Sem divergência, avança para `conferida`.
 * COM divergência: registra a divergência, registra o evento e devolve 422 —
 * nenhuma baixa de estoque, nenhuma mudança de status.
 */
export async function conferirPedido(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const lidos = normalizarLeitura(Array.isArray(req.body) ? req.body : (req.body?.codigos ?? req.body?.barcodes ?? req.body?.codigos_lidos));
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = await assertVenda(vendaId, escopo, tx);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado não pode ser conferido.');
      if (['faturada', 'entregue'].includes(String(venda.status))) throw new HttpError(409, 'Este pedido já foi faturado — a conferência acontece antes.');

      const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'O pedido não tem itens para conferir.');
      const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } }, tx);
      const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));

      const esperado = itens.rows.map((i) => {
        const p = porId.get(Number(i.produto_id));
        return {
          produto_id: Number(i.produto_id),
          sku: p?.sku ? String(p.sku) : null,
          codigo_barras: p?.codigo_barras ? String(p.codigo_barras) : null,
          tamanho_id: i.tamanho_id === null || i.tamanho_id === undefined ? null : Number(i.tamanho_id),
          quantidade: Math.trunc(num(i.quantidade)),
        };
      });
      const semCodigo = esperado.filter((e) => !e.codigo_barras);
      if (semCodigo.length) {
        throw new HttpError(409, 'Há itens sem código de barras cadastrado — a conferência por leitura não é possível.', { itens_sem_codigo: semCodigo });
      }

      const comparacao = compararLeitura(esperado, lidos);
      if (!comparacao.ok) {
        // A conferência aborta, mas a divergência PRECISA sobreviver: é ela que
        // prova que a caixa foi conferida e o que não bateu. Lançar aqui dentro
        // abortaria a transação e o rollback apagaria exatamente o registro que
        // a auditoria exige. Por isso a divergência SAI do bloco e é gravada
        // depois, em transação própria.
        return { reprovada: { esperado, lidos, comparacao, etapaAtual: String(venda.expedicao_etapa || 'pendente') } };
      }

      const atualizada = await avancarEtapa(venda, 'conferida', { id: actor.id || null, name: actor.name }, escopo, tx, `Conferência aprovada: ${comparacao.lido_total} código(s) lido(s) conferem com o pedido.`);
      return { aprovada: atualizada };
    }, { isolation: 'serializable' });

    if (out.reprovada) {
      const { esperado, lidos, comparacao, etapaAtual } = out.reprovada;
      const gravada = await s.transaction(async (tx) => {
        const divergencia = await s.insert(
          R_DIVERGENCIA(),
          {
            empresa_id: escopo.empresaId,
            venda_id: vendaId,
            esperado: esperado.map((e) => ({ produto_id: e.produto_id, sku: e.sku, codigo_barras: e.codigo_barras, tamanho_id: e.tamanho_id, quantidade: e.quantidade })),
            lido: lidos,
            faltando: comparacao.faltando,
            sobrando: comparacao.sobrando,
            usuario_id: actor.id || null,
          },
          tx
        );
        await registrarEvento(
          vendaId,
          'conferencia',
          etapaAtual,
          'divergencia',
          `Conferência REPROVADA: ${comparacao.faltando.length} item(ns) faltando, ${comparacao.sobrando.length} código(s) não previsto(s). Nenhuma baixa de estoque foi realizada.`,
          { id: actor.id || null, name: actor.name },
          escopo.empresaId,
          tx,
          { faltando: comparacao.faltando, sobrando: comparacao.sobrando, divergencia_id: divergencia.id }
        );
        await s.audit(
          { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'vendas', registro_id: vendaId, descricao: `Venda #${vendaId}: divergência na conferência`, dados: { divergencia_id: divergencia.id, faltando: comparacao.faltando, sobrando: comparacao.sobrando } },
          tx
        );
        return divergencia;
      }, { isolation: 'serializable' });
      throw new HttpError(422, 'A conferência física não coincide com o pedido. Nenhuma baixa foi realizada.', {
        divergencia_id: gravada.id,
        faltando: comparacao.faltando,
        sobrando: comparacao.sobrando,
        esperado_total: comparacao.esperado_total,
        lido_total: comparacao.lido_total,
      });
    }

    res.json({ ok: true, venda_id: vendaId, etapa: out.aprovada!.expedicao_etapa, mensagem: 'Conferência aprovada. Nenhuma baixa de estoque foi feita ainda — ela acontece no faturamento.' });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/** POST /api/vendas/:id/expedicao/embalar */
export async function embalarPedido(req: Request, res: Response) {
  return avancar(req, res, 'embalada', 'embalagem', 'Pedido embalado.');
}

/**
 * POST /api/vendas/:id/expedicao/expedir
 *
 * Expedir fatura o pedido: baixa de estoque, comissão e financeiro pelo MESMO
 * caminho do pedido de balcão (`aplicarRegrasPedido` + `syncLancamentoVenda`).
 * A expedição não virou um segundo motor de faturamento.
 */
export async function expedirPedido(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = await assertVenda(vendaId, escopo, tx);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado não pode ser expedido.');
      if (['faturada', 'entregue'].includes(String(venda.status))) {
        throw new HttpError(409, 'Este pedido já está faturado.');
      }
      const etapaAtual = (String(venda.expedicao_etapa || 'pendente') || 'pendente') as Etapa;
      if (etapaAtual !== 'embalada') {
        throw new HttpError(409, `Só se expede um pedido embalado (etapa atual: ${etapaAtual}). Passe por separação, conferência e embalagem.`);
      }
      const antes = venda;
      const faturada = await s.tryUpdateIf(getResource('vendas')!, vendaId, { status: String(venda.status) }, { status: 'faturada' }, tx);
      if (!faturada) throw new HttpError(409, 'O pedido mudou durante a expedição. Recarregue.');
      await aplicarRegrasPedido('venda', antes, faturada, { status: 'faturada' }, { id: actor.id || null, name: actor.name }, tx);
      const depois = (await s.get(getResource('vendas')!, vendaId, tx)) || faturada;
      await syncLancamentoVenda(antes, depois, { status: 'faturada' }, { id: actor.id || null, name: actor.name }, tx);
      const comEtapa = await avancarEtapa(depois, 'expedida', { id: actor.id || null, name: actor.name }, escopo, tx, 'Pedido expedido e faturado.');
      return comEtapa;
    }, { isolation: 'serializable' });
    res.json({ ok: true, venda: out, etapa: out.expedicao_etapa, status: out.status, mensagem: 'Pedido expedido: estoque baixado, comissão congelada e financeiro lançado.' });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

async function avancar(req: Request, res: Response, alvo: Etapa, etapa: string, mensagem: string) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const vendaId = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const venda = await assertVenda(vendaId, escopo, tx);
      if (String(venda.status) === 'cancelada') throw new HttpError(409, 'Pedido cancelado.');
      if (alvo === 'embalada' && String(venda.expedicao_etapa) !== 'conferida') {
        throw new HttpError(409, 'Só se embala um pedido conferido. Rode a conferência antes.');
      }
      return avancarEtapa(venda, alvo, { id: actor.id || null, name: actor.name }, escopo, tx, mensagem);
    }, { isolation: 'serializable' });
    res.json({ ok: true, venda: out, etapa: out.expedicao_etapa, mensagem });
  } catch (e) {
    throw toHttpError(e, getResource('vendas')!);
  }
}

/** GET /api/expedicao/divergencias — painel de divergências da empresa. */
export async function listarDivergencias(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const out = await getStore().list(R_DIVERGENCIA(), {
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(200, Math.max(1, Number(req.query.pageSize) || 50)),
    filter: { empresa_id: escopo.empresaId },
    sort: 'criado_em',
    dir: 'desc',
  });
  res.json(out);
}

/** POST /api/expedicao/divergencias/:id/resolver */
export async function resolverDivergencia(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(getResource('vendas')!, actor, 'update');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const resolucao = String((req.body || {}).resolucao || '').trim();
  if (resolucao.length < 5) throw new HttpError(400, 'Descreva como a divergência foi resolvida (mínimo 5 caracteres).', { resolucao: 'Mínimo 5 caracteres' });
  const s = getStore();
  const out = await s.transaction(async (tx) => {
    const div = assertRegistroDaEmpresa(R_DIVERGENCIA(), await s.get(R_DIVERGENCIA(), id, tx), escopo);
    if (div.resolvido_em) throw new HttpError(409, 'Esta divergência já foi resolvida.');
    return s.update(R_DIVERGENCIA(), id, { resolvido_em: new Date().toISOString(), resolvido_por: actor.id || null, resolucao: resolucao.slice(0, 500) }, tx);
  });
  res.json(out);
}

// ============================================================================
// LOGÍSTICA REVERSA — DEVOLUÇÃO
// ============================================================================

/** POST /api/devolucoes — solicitação. */
export async function criarDevolucao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_DEVOLUCAO(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const body = (req.body || {}) as Record<string, unknown>;
  const motivo = String(body.motivo || '').trim();
  if (motivo.length < 5) throw new HttpError(400, 'Informe o motivo da devolução (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  const tipo = String(body.tipo || 'devolucao').toLowerCase();
  if (!['devolucao', 'troca', 'garantia', 'arrependimento'].includes(tipo)) {
    throw new HttpError(400, 'tipo deve ser devolucao, troca, garantia ou arrependimento.', { tipo: 'Inválido' });
  }
  const s = getStore();
  try {
    const criada = await s.transaction(async (tx) => {
      const vendaId = parseId(body.venda_id);
      const venda = assertRegistroDaEmpresa(getResource('vendas')!, await s.get(getResource('vendas')!, vendaId, tx), escopo);
      if (!['faturada', 'entregue'].includes(String(venda.status))) {
        throw new HttpError(409, 'Só se devolve mercadoria de um pedido faturado ou entregue.');
      }
      const itens = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: vendaId }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'O pedido não tem itens.');

      // Sem itens explícitos, a devolução é do pedido inteiro.
      const solicitados = Array.isArray(body.itens) && body.itens.length ? body.itens : itens.rows.map((i) => ({ item_venda_id: i.id, produto_id: i.produto_id, tamanho_id: i.tamanho_id, quantidade: num(i.quantidade) }));
      if (!solicitados.length) throw new HttpError(400, 'Informe os itens a devolver.');

      const devolucao = await s.insert(
        R_DEVOLUCAO(),
        {
          empresa_id: escopo.empresaId,
          venda_id: vendaId,
          cliente_id: venda.cliente_id ?? null,
          numero: body.numero ? String(body.numero).slice(0, 40) : null,
          status: 'solicitada',
          motivo: motivo.slice(0, 500),
          tipo,
          observacoes: body.observacoes ? String(body.observacoes).slice(0, 2000) : null,
          criado_por: actor.id || null,
        },
        tx
      );

      const porItem = new Map(itens.rows.map((i) => [Number(i.id), i]));
      // Índice por produto+tamanho: quem chama informando só o produto (o caso
      // comum na tela) também precisa ser confrontado com o pedido.
      const porChave = new Map(itens.rows.map((i) => [chaveDoItem(Number(i.produto_id), i.tamanho_id === null || i.tamanho_id === undefined ? null : Number(i.tamanho_id)), i]));
      // Devoluções deste pedido que ainda estão vivas. Recusada/cancelada não
      // conta: a mercadoria não vai voltar por ela, então o saldo do pedido
      // volta a ficar disponível para uma nova solicitação.
      const devsDestePedido = await s.list(R_DEVOLUCAO(), { page: 1, pageSize: 500, filter: { venda_id: vendaId } }, tx);
      const devViva = new Map(
        devsDestePedido.rows.filter((d) => !['recusada', 'cancelada'].includes(String(d.status))).map((d) => [Number(d.id), d])
      );
      const jaUsados = new Map<string, number>();
      for (const raw of solicitados as Record<string, unknown>[]) {
        const produtoId = Number(raw.produto_id ?? (raw.item_venda_id ? porItem.get(Number(raw.item_venda_id))?.produto_id : undefined));
        const tamanhoIdBruto = raw.tamanho_id === undefined || raw.tamanho_id === null || raw.tamanho_id === '' ? null : Number(raw.tamanho_id);
        const chave = chaveDoItem(produtoId, tamanhoIdBruto);
        const itemVenda = (raw.item_venda_id ? porItem.get(Number(raw.item_venda_id)) : null) ?? porChave.get(chave) ?? null;
        const tamanhoId = tamanhoIdBruto ?? (itemVenda?.tamanho_id === null || itemVenda?.tamanho_id === undefined ? null : Number(itemVenda?.tamanho_id));
        if (!Number.isInteger(produtoId) || produtoId <= 0) throw new HttpError(400, 'Cada item devolvido precisa de produto_id (ou item_venda_id).', { itens: 'produto_id inválido' });
        // O item precisa existir NO PEDIDO. Sem isso não há contra o que
        // comparar e a devolução poderia ser de mercadoria nunca vendida.
        if (!itemVenda) {
          throw new HttpError(404, `O pedido #${vendaId} não tem nenhuma linha do produto #${produtoId}${tamanhoId ? ` tamanho #${tamanhoId}` : ''}.`, { itens: 'item fora do pedido' });
        }
        const pedidoNoItem = Math.trunc(num(itemVenda.quantidade));
        const solicitada = Math.trunc(num(raw.quantidade ?? itemVenda.quantidade ?? 0));
        if (!(solicitada > 0)) throw new HttpError(400, `A quantidade devolvida do produto #${produtoId} deve ser maior que zero.`, { itens: 'quantidade' });
        const ja = jaUsados.get(chave) || 0;
        // Não se devolve mais do que o pedido levou — nem somando duas
        // devoluções. Só contam as devoluções VIVAS deste pedido.
        const existentes = await s.list(R_DEVOLUCAO_ITEM(), { page: 1, pageSize: 500, filter: { produto_id: produtoId } }, tx);
        const jaDevolvido = existentes.rows
          .filter((di) => devViva.has(Number(di.devolucao_id)))
          .filter((di) => chaveDoItem(Number(di.produto_id), di.tamanho_id === null || di.tamanho_id === undefined ? null : Number(di.tamanho_id)) === chave)
          .reduce((acc, di) => acc + num(di.quantidade_solicitada), 0);
        if (ja + jaDevolvido + solicitada > pedidoNoItem) {
          throw new HttpError(409, `O pedido #${vendaId} tem ${pedidoNoItem} unidade(s) do produto #${produtoId} e ${ja + jaDevolvido} já está(ão) em devolução. Não é possível devolver ${solicitada} a mais.`);
        }
        jaUsados.set(chave, ja + solicitada);
        await s.insert(
          R_DEVOLUCAO_ITEM(),
          { empresa_id: escopo.empresaId, devolucao_id: Number(devolucao.id), item_venda_id: Number(itemVenda.id), produto_id: produtoId, tamanho_id: tamanhoId === null ? null : Number(tamanhoId), quantidade_solicitada: solicitada, quantidade_recebida: 0, estado: 'bom', devolucao_estoque: false },
          tx
        );
      }
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'criar', recurso: 'devolucoes', registro_id: Number(devolucao.id), descricao: `Devolução #${devolucao.id} solicitada para a venda #${vendaId} — ${solicitados.length} item(ns)`, dados: { venda_id: vendaId, motivo, tipo } },
        tx
      );
      return devolucao;
    }, { isolation: 'serializable' });
    res.status(201).json(await detalharDevolucao(Number(criada.id), escopo));
  } catch (e) {
    throw toHttpError(e, R_DEVOLUCAO());
  }
}

/** GET /api/devolucoes/:id */
export async function obterDevolucao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkAccess(R_DEVOLUCAO(), actor, 'read');
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  res.json(await detalharDevolucao(parseId(req.params.id), escopo));
}

async function detalharDevolucao(id: number, escopo: EscopoEmpresa): Promise<Record<string, unknown>> {
  const s = getStore();
  const dev = assertRegistroDaEmpresa(R_DEVOLUCAO(), await s.get(R_DEVOLUCAO(), id), escopo);
  const itens = await s.list(R_DEVOLUCAO_ITEM(), { page: 1, pageSize: 500, filter: { devolucao_id: id }, sort: 'id', dir: 'asc' });
  const produtos = await s.list(getResource('produtos')!, { page: 1, pageSize: 20000, filter: { empresa_id: escopo.empresaId } });
  const porId = new Map(produtos.rows.map((p) => [Number(p.id), p]));
  return {
    ...dev,
    itens: itens.rows.map((i) => {
      const p = porId.get(Number(i.produto_id));
      return { ...i, sku: p?.sku ?? null, produto: p?.nome ?? null };
    }),
    proximas_acoes: acoesDaDevolucao(String(dev.status)),
  };
}

function acoesDaDevolucao(status: string): string[] {
  switch (status) {
    case 'solicitada':
      return ['autorizar', 'recusar', 'cancelar'];
    case 'autorizada':
      return ['registrar_rastreamento', 'receber'];
    case 'em_transito':
      return ['receber'];
    case 'recebida':
      return [];
    default:
      return [];
  }
}

/** POST /api/devolucoes/:id/autorizar */
export async function autorizarDevolucao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_DEVOLUCAO(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const dev = assertRegistroDaEmpresa(R_DEVOLUCAO(), await s.get(R_DEVOLUCAO(), id, tx), escopo);
      if (String(dev.status) !== 'solicitada') throw new HttpError(409, `Só se autoriza uma devolução solicitada (status atual: ${dev.status}).`);
      const patch: Record<string, unknown> = { status: 'autorizada', autorizada_em: new Date().toISOString(), autorizado_por: actor.id || null };
      if (body.autorizacao_codigo) patch.autorizacao_codigo = String(body.autorizacao_codigo).slice(0, 60);
      if (body.transportadora) patch.transportadora = String(body.transportadora).slice(0, 80);
      const atualizada = await s.tryUpdateIf(R_DEVOLUCAO(), id, { status: 'solicitada' }, patch, tx);
      if (!atualizada) throw new HttpError(409, 'A devolução mudou durante a autorização. Recarregue.');
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'devolucoes', registro_id: id, descricao: `Devolução #${id} autorizada`, dados: { autorizacao_codigo: patch.autorizacao_codigo ?? null } },
        tx
      );
      return atualizada;
    }, { isolation: 'serializable' });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, R_DEVOLUCAO());
  }
}

/** POST /api/devolucoes/:id/rastreamento — código de rastreio da logística reversa. */
export async function registrarRastreamento(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_DEVOLUCAO(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const codigo = String(body.codigo_rastreamento || '').trim();
  if (codigo.length < 5) throw new HttpError(400, 'Informe o código de rastreamento (mínimo 5 caracteres).', { codigo_rastreamento: 'Mínimo 5 caracteres' });
  const s = getStore();
  const out = await s.transaction(async (tx) => {
    const dev = assertRegistroDaEmpresa(R_DEVOLUCAO(), await s.get(R_DEVOLUCAO(), id, tx), escopo);
    if (String(dev.status) === 'solicitada') {
      throw new HttpError(409, 'Autorize a devolução antes de registrar o rastreamento.');
    }
    if (!['autorizada', 'em_transito'].includes(String(dev.status))) {
      throw new HttpError(409, `Não é possível registrar rastreamento numa devolução ${dev.status}.`);
    }
    const patch: Record<string, unknown> = { status: 'em_transito', codigo_rastreamento: codigo.slice(0, 60) };
    if (body.transportadora) patch.transportadora = String(body.transportadora).slice(0, 80);
    const atualizada = await s.tryUpdateIf(R_DEVOLUCAO(), id, { status: String(dev.status) }, patch, tx);
    if (!atualizada) throw new HttpError(409, 'A devolução mudou durante a atualização. Recarregue.');
    await s.audit(
      { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'devolucoes', registro_id: id, descricao: `Devolução #${id}: rastreamento ${codigo}`, dados: { codigo_rastreamento: codigo } },
      tx
    );
    return atualizada;
  });
  res.json(out);
}

/**
 * POST /api/devolucoes/:id/receber
 *
 * Recebimento com conferência: cada item informa a quantidade efetivamente
 * recebida e o estado. Só o que foi recebido em estado aproveitável volta ao
 * estoque — e o estoque sobe UMA vez, porque o item é marcado com
 * `devolucao_estoque` dentro da mesma transação.
 *
 * Rastreabilidade é pré-condição: sem código de rastreamento, não se recebe.
 */
export async function receberDevolucao(req: Request, res: Response) {
  const actor = currentUser(req);
  checkFluxo(R_DEVOLUCAO(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const body = (req.body || {}) as Record<string, unknown>;
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const dev = assertRegistroDaEmpresa(R_DEVOLUCAO(), await s.get(R_DEVOLUCAO(), id, tx), escopo);
      if (String(dev.status) === 'recebida') throw new HttpError(409, 'Esta devolução já foi recebida — o estoque não sobe duas vezes.');
      if (String(dev.status) === 'solicitada') throw new HttpError(409, 'Autorize a devolução antes de receber.');
      if (['recusada', 'cancelada'].includes(String(dev.status))) throw new HttpError(409, `Devolução ${dev.status} não pode ser recebida.`);
      if (!dev.codigo_rastreamento) {
        throw new HttpError(409, 'Mercadoria sem rastreabilidade não entra no estoque. Registre o código de rastreamento antes de receber.');
      }

      const itens = await s.list(R_DEVOLUCAO_ITEM(), { page: 1, pageSize: 500, filter: { devolucao_id: id }, sort: 'id', dir: 'asc' }, tx);
      if (!itens.rows.length) throw new HttpError(409, 'A devolução não tem itens.');

      const recebimentos = Array.isArray(body.itens) ? (body.itens as Record<string, unknown>[]) : [];
      const local = body.local ? String(body.local).slice(0, 60) : String(dev.local_entrada || (await getDefaultLocal(tx)));
      const localExiste = await s.findOneWhere(getResource('locais')!, { nome: local }, tx);
      if (!localExiste) throw new HttpError(400, `O armazém "${local}" não está cadastrado.`, { local: 'Não encontrado' });

      let totalRecebido = 0;
      const entradas: { produto_id: number; tamanho_id: number | null; quantidade: number }[] = [];
      for (const item of itens.rows) {
        const conf = recebimentos.find((r) => Number(r.id ?? r.devolucao_item_id) === Number(item.id));
        const recebida = Math.trunc(num(conf?.quantidade_recebida ?? conf?.quantidade ?? item.quantidade_solicitada));
        if (recebida < 0) throw new HttpError(400, `A quantidade recebida do item #${item.id} não pode ser negativa.`);
        if (recebida > Math.trunc(num(item.quantidade_solicitada))) {
          throw new HttpError(409, `O item #${item.id} solicita ${Math.trunc(num(item.quantidade_solicitada))} e não pode receber ${recebida}.`);
        }
        const estado = String(conf?.estado ?? item.estado ?? 'bom').toLowerCase();
        if (!['bom', 'avariado', 'usado', 'faltando_acessorio'].includes(estado)) {
          throw new HttpError(400, `Estado "${estado}" não é válido. Use bom, avariado, usado ou faltando_acessorio.`, { estado: 'Inválido' });
        }
        if (item.devolucao_estoque) continue;
        await s.update(R_DEVOLUCAO_ITEM(), Number(item.id), { quantidade_recebida: recebida, estado }, tx);
        if (recebida <= 0) continue;
        // Item avariado não volta para o saldo vendável: fica registrado na
        // devolução para descarte/reparo, sem inflar o estoque.
        if (estado !== 'bom' && conf?.devolucao_estoque !== true) {
          totalRecebido += recebida;
          continue;
        }
        entradas.push({ produto_id: Number(item.produto_id), tamanho_id: item.tamanho_id === null || item.tamanho_id === undefined ? null : Number(item.tamanho_id), quantidade: recebida });
        totalRecebido += recebida;
      }

      if (!totalRecebido) throw new HttpError(409, 'Nenhuma unidade foi recebida — nada a dar entrada.');

      for (const e of entradas) {
        await s.adjustStock(e.produto_id, e.tamanho_id as number, local, e.quantidade, tx);
        await s.insert(
          getResource('movimentacoes')!,
          {
            tipo: 'entrada',
            produto_id: e.produto_id,
            tamanho_id: e.tamanho_id,
            local,
            quantidade: e.quantidade,
            motivo: `Devolução #${id} — Venda #${dev.venda_id}`,
            usuario_id: actor.id || null,
          },
          tx
        );
        await s.update(R_DEVOLUCAO_ITEM(), Number(itens.rows.find((i) => Number(i.produto_id) === e.produto_id && (i.tamanho_id ?? null) === e.tamanho_id)!.id), { devolucao_estoque: true }, tx);
      }

      const recebida = await s.tryUpdateIf(R_DEVOLUCAO(), id, { status: String(dev.status) }, { status: 'recebida', recebida_em: new Date().toISOString(), recebido_por: actor.id || null, local_entrada: local }, tx);
      if (!recebida) throw new HttpError(409, 'A devolução mudou durante o recebimento. Recarregue.');

      // Ajuste financeiro: a venda cancelada/parcialmente devolvida precisa
      // deixar de constar como recebida. Só quando a devolução é TOTAL.
      const itensVenda = await s.list(getResource('itens_venda')!, { page: 1, pageSize: 1000, filter: { venda_id: Number(dev.venda_id) } }, tx);
      const qtdVendida = itensVenda.rows.reduce((acc, i) => acc + Math.trunc(num(i.quantidade)), 0);
      const todas = await s.list(R_DEVOLUCAO_ITEM(), { page: 1, pageSize: 1000, filter: { devolucao_id: id } }, tx);
      const qtdDevolvida = todas.rows.reduce((acc, i) => acc + Math.trunc(num(i.quantidade_recebida)), 0);
      let ajusteFinanceiro: { aplicado: boolean; motivo: string } = { aplicado: false, motivo: 'Devolução parcial: o financeiro da venda não é revertido automaticamente.' };
      if (qtdVendida > 0 && qtdDevolvida >= qtdVendida) {
        const venda = await s.get(getResource('vendas')!, Number(dev.venda_id), tx);
        if (venda && !['cancelada'].includes(String(venda.status))) {
          const cancelada = await s.update(getResource('vendas')!, Number(venda.id), { status: 'cancelada' }, tx);
          if (cancelada) {
            await aplicarRegrasPedido('venda', venda, cancelada, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx);
            const depois = (await s.get(getResource('vendas')!, Number(venda.id), tx)) || cancelada;
            await syncLancamentoVenda(venda, depois, { status: 'cancelada' }, { id: actor.id || null, name: actor.name }, tx);
            ajusteFinanceiro = { aplicado: true, motivo: `Devolução total: venda #${venda.id} cancelada e financeiro revertido.` };
          }
        }
      }

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'devolucoes',
          registro_id: id,
          descricao: `Devolução #${id} recebida: ${totalRecebido} unidade(s), ${entradas.length} entrada(s) de estoque em "${local}"`,
          dados: { total_recebido: totalRecebido, entradas, ajuste_financeiro: ajusteFinanceiro },
        },
        tx
      );
      return { recebida, totalRecebido, entradas, local, ajusteFinanceiro };
    }, { isolation: 'serializable' });
    res.json({ ok: true, devolucao: out.recebida, total_recebido: out.totalRecebido, entradas_estoque: out.entradas, local: out.local, financeiro: out.ajusteFinanceiro });
  } catch (e) {
    throw toHttpError(e, R_DEVOLUCAO());
  }
}

/** POST /api/devolucoes/:id/recusar | /cancelar */
export async function recusarDevolucao(req: Request, res: Response) {
  return fecharDevolucao(req, res, 'recusada');
}

export async function cancelarDevolucao(req: Request, res: Response) {
  return fecharDevolucao(req, res, 'cancelada');
}

async function fecharDevolucao(req: Request, res: Response, para: 'recusada' | 'cancelada') {
  const actor = currentUser(req);
  checkFluxo(R_DEVOLUCAO(), actor);
  const escopo = escopoDoAtor(actor as unknown as AuthUser);
  const id = parseId(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5) throw new HttpError(400, 'Informe o motivo (mínimo 5 caracteres).', { motivo: 'Mínimo 5 caracteres' });
  const s = getStore();
  const out = await s.transaction(async (tx) => {
    const dev = assertRegistroDaEmpresa(R_DEVOLUCAO(), await s.get(R_DEVOLUCAO(), id, tx), escopo);
    if (String(dev.status) === 'recebida') throw new HttpError(409, 'Devolução já recebida não pode ser recusada/cancelada — o estoque já subiu.');
    const atualizada = await s.tryUpdateIf(R_DEVOLUCAO(), id, { status: String(dev.status) }, { status: para }, tx);
    if (!atualizada) throw new HttpError(409, 'A devolução mudou. Recarregue.');
    await s.audit(
      { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'devolucoes', registro_id: id, descricao: `Devolução #${id} ${para} — ${motivo}`, dados: { motivo } },
      tx
    );
    return atualizada;
  });
  res.json(out);
}
