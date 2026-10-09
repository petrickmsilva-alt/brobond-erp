// ============================================================
// Fase 3 — Produção e custo real.
//
// Rotas (sub-recursos genéricos, mesmo padrão de itens.ts):
//   GET    /api/ordens/:id/itens            itens da OP por grade
//   POST   /api/ordens/:id/itens            adiciona tamanho à OP
//   PUT    /api/ordens/:id/itens/:itemId    altera quantidade
//   DELETE /api/ordens/:id/itens/:itemId    remove tamanho da OP
//   GET    /api/fichas/:id/insumos          insumos da ficha técnica
//   POST   /api/fichas/:id/insumos          adiciona insumo (consumo/perda)
//   PUT    /api/fichas/:id/insumos/:itemId
//   DELETE /api/fichas/:id/insumos/:itemId
//   POST   /api/fichas/:id/aplicar-preco    custo/preço sugerido → produto
//
// Regras:
//   • OP por tamanho usa ordens_fabricacao.tamanho_id/quantidade;
//     OP por grade usa itens_ordem (uma linha por tamanho);
//   • concluir OP → entrada no estoque por tamanho (1 adjustStock +
//     movimentação por item) + baixa de insumos da ficha técnica com perda;
//     reabrir estorna tudo;
//   • consumo sem saldo bloqueia com 409 listando os insumos em falta;
//     ?forcar=true (gerente/admin) executa mesmo assim e registra na auditoria;
//   • custo calculado = Σ(consumo × (1+perda) × custo_médio) + mão de obra
//     + custos indiretos; preço sugerido = custo × (1 + margem/100).
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { empresaDoRegistroAudit } from './empresa';
import { getResource, type Resource } from './resources';
import { checkAccess, escopoDe, getDefaultLocal, getStore, toHttpError, updateRecord } from './services';
import { currentUser } from './auth';
import type { Payload, Row, Tx } from './store';
import { parseId, validatePayload } from './validate';
import { labelOf } from './store';
import { round2, round3 } from './utils';

type Actor = { id: number | null; name: string; perfil?: string };
type OrdemOpts = { forcar?: boolean };

function recursoOrdem() {
  return { op: getResource('ordens')!, itens: getResource('itens_ordem')! };
}

function recursoFicha() {
  return { ficha: getResource('fichas')!, itens: getResource('itens_ficha_tecnica')! };
}

function recursoEventos() {
  return { eventos: getResource('ordens_eventos')!, apontamentos: getResource('ordens_apontamentos')! };
}

// ============================================================================
// MÁQUINA DE ESTADOS DA OP (E2)
//
// Fluxo da especificação:
//   PLANEJADA → LIBERADA → EM_PRODUÇÃO → PARCIAL → CONCLUÍDA   (+ CANCELADA)
//
// O que é permitido e POR QUÊ:
//   • planejada → liberada | em_producao | concluida | cancelada
//       "em_producao" e "concluida" direto da planejada são o atalho de quem
//       produz internamente sem liberar para a facção — era o único caminho que
//       existia antes da E2 (botão "Iniciar produção" da ficha da OP) e
//       continua valendo. A transição fica registrada como evento `atalho`.
//   • liberada → planejada | em_producao | concluida | cancelada
//       voltar para planejada é devolver a OP ao planejamento.
//   • em_producao → liberada | parcial | concluida | cancelada
//   • parcial → em_producao | concluida | cancelada
//       `parcial` é posto pelo servidor quando há apontamento e ainda falta
//       peça; voltar a `em_producao` é retomar o chão de fábrica.
//   • concluida → planejada | em_producao
//       REABRIR. É a única saída de uma OP concluída e ESTORNA estoque e
//       consumo (estornarOrdem). O botão "Reabrir (estorna)" da tela usa
//       `planejada`; `em_producao` existe para reabrir já produzindo.
//   • cancelada → (nada)
//       estado TERMINAL. Antes qualquer string era aceita; agora não se
//       ressuscita OP cancelada — se foi erro, abre-se outra.
//
// O vocabulário é garantido no banco pela constraint
// `ordens_fabricacao_status_valido` (migration 0026), então mesmo um UPDATE em
// SQL cru fora da API não consegue inventar estado.
// ============================================================================
export const STATUS_OP = ['planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada'] as const;
export type StatusOp = (typeof STATUS_OP)[number];

export const TRANSICOES_OP: Record<StatusOp, StatusOp[]> = {
  planejada: ['liberada', 'em_producao', 'concluida', 'cancelada'],
  liberada: ['planejada', 'em_producao', 'concluida', 'cancelada'],
  em_producao: ['liberada', 'parcial', 'concluida', 'cancelada'],
  parcial: ['em_producao', 'concluida', 'cancelada'],
  concluida: ['planejada', 'em_producao'],
  cancelada: [],
};

/** Rotulo em português para mensagens de erro (não é i18n, é legibilidade). */
export const ROTULO_STATUS: Record<StatusOp, string> = {
  planejada: 'planejada',
  liberada: 'liberada',
  em_producao: 'em produção',
  parcial: 'parcial',
  concluida: 'concluída',
  cancelada: 'cancelada',
};

/** Status que ainda aceitam edição de grade/quantidade. */
export function opEditavel(status: string): boolean {
  return status === 'planejada' || status === 'liberada';
}

export function ehStatusOp(v: unknown): v is StatusOp {
  return typeof v === 'string' && (STATUS_OP as readonly string[]).includes(v);
}

/**
 * A transição é legal? `de === null` é criação (qualquer estado inicial serve,
 * porque criar já concluída é o caminho de quem importa histórico).
 */
export function transicaoPermitida(de: string | null, para: string): boolean {
  if (de === null) return ehStatusOp(para);
  if (!ehStatusOp(de) || !ehStatusOp(para)) return false;
  if (de === para) return true; // PUT que repete o status não é transição
  return TRANSICOES_OP[de].includes(para);
}

/** Conclusão que pula etapa (registrada como evento `atalho`, não como erro). */
export function ehAtalho(de: string, para: string): boolean {
  return para === 'concluida' && (de === 'planejada' || de === 'liberada');
}

/**
 * Trilha da OP. Append-only, empresa derivada por trigger a partir da OP.
 * Nunca lança: a trilha é consequência da operação, não pré-requisito — se ela
 * falhasse, uma conclusão legítima seria desfeita por causa do log.
 */
export async function registrarEventoOrdem(
  ordemId: number,
  evento: string,
  info: { de?: string | null; para?: string | null; mensagem?: string; dados?: Record<string, unknown>; usuario_id?: number | null },
  tx: Tx
): Promise<void> {
  try {
    await getStore().insert(
      recursoEventos().eventos,
      {
        ordem_id: ordemId,
        evento,
        de_status: info.de ?? null,
        para_status: info.para ?? null,
        mensagem: info.mensagem ?? null,
        dados: info.dados ?? null,
        usuario_id: info.usuario_id ?? null,
      },
      tx
    );
  } catch {
    // silencioso de propósito — ver comentário acima
  }
}


// ----------------------------------------------------------------------------
// Validação do payload da OP (tipo tamanho × grade)
// ----------------------------------------------------------------------------

/** Exigências por tipo: por tamanho precisa tamanho+quantidade; por grade não. */
export async function validarOrdemPayload(data: Payload, before: Row | null): Promise<void> {
  const merged = { ...(before || {}), ...data };
  const tipo = String(data.tipo ?? merged.tipo ?? 'tamanho');
  if (tipo !== 'tamanho' && tipo !== 'grade') {
    throw new HttpError(400, 'Tipo de OP inválido. Use "tamanho" ou "grade".', { tipo: 'Opção inválida' });
  }
  if (tipo === 'grade') {
    data.tamanho_id = null;
    data.quantidade = null;
    return;
  }
  // Por tamanho: tamanho_id e quantidade são obrigatórios.
  const tam = merged.tamanho_id ?? data.tamanho_id;
  const qtd = merged.quantidade ?? data.quantidade;
  if (!tam || !Number.isInteger(Number(tam))) {
    throw new HttpError(400, 'OP "por tamanho" exige um tamanho.', { tamanho_id: 'Campo obrigatório em OP por tamanho' });
  }
  if (qtd === null || qtd === undefined || Number(qtd) <= 0) {
    throw new HttpError(400, 'OP "por tamanho" exige uma quantidade maior que zero.', { quantidade: 'Campo obrigatório em OP por tamanho' });
  }
}

/** Itens efetivos de produção (grade → itens_ordem; tamanho → linha única). */
async function itensProducao(op: Row, tx?: Tx): Promise<{ tamanho_id: number; quantidade: number }[]> {
  const s = getStore();
  const tipo = String(op.tipo || 'tamanho');
  if (tipo === 'grade') {
    const itens = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, filter: { ordem_id: Number(op.id) } }, tx);
    return itens.rows.map((it) => ({ tamanho_id: Number(it.tamanho_id), quantidade: Number(it.quantidade || 0) }));
  }
  if (!op.tamanho_id) return [];
  return [{ tamanho_id: Number(op.tamanho_id), quantidade: Number(op.quantidade || 0) }];
}

/** Encontra a ficha técnica do produto (única por produto). */
async function fichaDoProduto(produtoId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  return s.findOneWhere(recursoFicha().ficha, { produto_id: produtoId }, tx);
}

// ============================================================================
// CONSUMO DE INSUMOS, ENTRADA DE PRODUTO ACABADO E CUSTO REAL (E2)
//
// Três regras que valem para os três caminhos (apontamento, conclusão, estorno):
//
//  1) O vínculo entre a OP e o estoque é a FK `ordem_id`, não o texto do motivo.
//     O motivo continua sendo escrito (`Consumo — OP #7`) porque é o que o
//     usuário lê na tela de Movimentações — mas ele deixou de ser a chave.
//
//  2) Peça refugada CUSTA. A base de consumo é
//     `produzida + perdida` (peças que passaram pelo processo), enquanto a
//     entrada no estoque é só `produzida`. É isso que faz a perda aparecer no
//     custo real em vez de sumir.
//
//  3) Nada de consumo duplo. A conclusão calcula a necessidade da ficha e
//     subtrai o que os apontamentos já baixaram; sem apontamento nenhum, o
//     resultado é exatamente o que a OP fazia antes da E2.
// ============================================================================

type LinhaConsumo = {
  insumo_id: number;
  necessidade: number;
  custo_unitario: number;
  nome: string;
  unidade: string;
  faltando: number;
};

/** Local onde a peça entra: o local de produção da OP, senão o Local padrão. */
async function localDeEntrada(op: Row, tx: Tx): Promise<{ id: number | null; nome: string }> {
  const s = getStore();
  const localId = op.local_producao_id ? Number(op.local_producao_id) : null;
  if (localId) {
    const local = await s.findOneWhere(getResource('locais')!, { id: localId }, tx);
    if (local) return { id: localId, nome: String(local.nome) };
  }
  return { id: null, nome: await getDefaultLocal(tx) };
}

/** Apontamentos da OP, do mais antigo ao mais recente. */
async function apontamentosDaOrdem(ordemId: number, tx?: Tx): Promise<Row[]> {
  const out = await getStore().list(
    recursoEventos().apontamentos,
    { page: 1, pageSize: 1000, sort: 'apontado_em', dir: 'asc', filter: { ordem_id: ordemId } },
    tx
  );
  return out.rows;
}

/** Peças boas apontadas por tamanho (só o que tem quantidade > 0). */
function produzidasPorTamanho(apontamentos: Row[]): Map<number, number> {
  const mapa = new Map<number, number>();
  for (const a of apontamentos) {
    const qtd = Number(a.quantidade_produzida || 0);
    if (qtd <= 0 || !a.tamanho_id) continue;
    const t = Number(a.tamanho_id);
    mapa.set(t, (mapa.get(t) || 0) + qtd);
  }
  return mapa;
}

/**
 * O que a ficha técnica exige para `pecas` peças, já com a perda de insumo de
 * cada linha. Chave: insumo_id.
 */
async function necessidadeDaFicha(ficha: Row | null, pecas: number, tx: Tx): Promise<Map<number, LinhaConsumo>> {
  const s = getStore();
  const mapa = new Map<number, LinhaConsumo>();
  if (!ficha || pecas <= 0) return mapa;
  const linhas = await s.list(recursoFicha().itens, { page: 1, pageSize: 500, filter: { ficha_id: Number(ficha.id) } }, tx);
  for (const linha of linhas.rows) {
    const insumoId = Number(linha.insumo_id);
    const consumo = Number(linha.consumo || 0);
    const perdaPct = Number(linha.perda_pct || 0);
    if (!insumoId || consumo <= 0) continue;
    const insumo = await s.findOneWhere(getResource('insumos')!, { id: insumoId }, tx);
    mapa.set(insumoId, {
      insumo_id: insumoId,
      necessidade: round3(pecas * consumo * (1 + perdaPct / 100)),
      custo_unitario: Number(insumo?.custo_medio || 0),
      nome: insumo ? labelOf(getResource('insumos')!, insumo) : `#${insumoId}`,
      unidade: insumo?.unidade || 'un',
      faltando: 0,
    });
  }
  return mapa;
}

/**
 * Insumos que esta OP JÁ baixou (FK `ordem_id`, saídas não estornadas). É o que
 * impede a conclusão de consumir duas vezes o que o apontamento já consumiu.
 */
async function jaConsumidoNaOrdem(ordemId: number, tx: Tx): Promise<Map<number, number>> {
  const s = getStore();
  const r = getResource('movimentacoes_insumos')!;
  const out = await s.list(r, { page: 1, pageSize: 5000, filter: { ordem_id: ordemId } }, tx);
  const mapa = new Map<number, number>();
  for (const m of out.rows) {
    if (String(m.tipo) !== 'saida') continue;
    const id = Number(m.insumo_id);
    mapa.set(id, (mapa.get(id) || 0) + Number(m.quantidade || 0));
  }
  return mapa;
}

/**
 * Custo real da OP até aqui: insumos efetivamente baixados (quantidade × custo
 * unitário gravado na movimentação) + mão de obra e custos indiretos da ficha
 * reconhecidos na proporção de peças processadas sobre as planejadas.
 *
 * Os indiretos são proporcionais de propósito: uma OP parada na metade não pode
 * carregar o rateio inteiro, senão o custo real de uma OP parcial parece pior do
 * que o de uma concluída.
 */
async function calcularCustoReal(ordemId: number, ficha: Row | null, pecasPlanejadas: number, pecasProcessadas: number, tx: Tx): Promise<number> {
  const s = getStore();
  const r = getResource('movimentacoes_insumos')!;
  const out = await s.list(r, { page: 1, pageSize: 5000, filter: { ordem_id: ordemId } }, tx);
  let insumos = 0;
  for (const m of out.rows) {
    if (String(m.tipo) !== 'saida') continue;
    insumos += Number(m.quantidade || 0) * Number(m.custo_unitario || 0);
  }
  const indiretos = ficha ? Number(ficha.mao_obra || 0) + Number(ficha.custos_indiretos || 0) : 0;
  const proporcao = pecasPlanejadas > 0 ? Math.min(1, pecasProcessadas / pecasPlanejadas) : pecasProcessadas > 0 ? 1 : 0;
  return round2(insumos + indiretos * proporcao);
}

/**
 * Baixa de insumos de uma OP. `pecasBase` é `produzida + perdida` quando há
 * apontamento, ou a quantidade planejada quando não há. O que os apontamentos
 * já baixaram é subtraído — e se já baixaram MAIS do que a ficha pede, a
 * divergência é devolvida em `divergencia` para o chamador registrar, nunca
 * corrigida em silêncio.
 */
async function baixarInsumos(
  op: Row,
  ficha: Row | null,
  pecasBase: number,
  actor: Actor,
  tx: Tx,
  opts: OrdemOpts,
  contexto: string
): Promise<{ linhas: LinhaConsumo[]; emFalta: LinhaConsumo[]; divergencia: { insumo_id: number; nome: string; excesso: number }[] }> {
  const s = getStore();
  const id = Number(op.id);
  const forcar = opts.forcar === true && (actor.perfil === 'admin' || actor.perfil === 'gerente');
  const necessidade = await necessidadeDaFicha(ficha, pecasBase, tx);
  const jaConsumido = await jaConsumidoNaOrdem(id, tx);
  const linhas: LinhaConsumo[] = [];
  const divergencia: { insumo_id: number; nome: string; excesso: number }[] = [];

  for (const linha of necessidade.values()) {
    const ja = round3(jaConsumido.get(linha.insumo_id) || 0);
    const resto = round3(linha.necessidade - ja);
    if (resto < 0) {
      // Apontamento consumiu mais do que a ficha prevê: registra, não "conserta".
      divergencia.push({ insumo_id: linha.insumo_id, nome: linha.nome, excesso: round3(-resto) });
      continue;
    }
    if (resto === 0) continue;
    const saldo = round3(await s.insumoStock(linha.insumo_id, tx));
    linhas.push({ ...linha, necessidade: resto, faltando: saldo < resto ? round3(resto - saldo) : 0 });
  }

  const emFalta = linhas.filter((l) => l.faltando > 0);
  if (emFalta.length && !forcar) {
    const lista = emFalta.map((l) => `• ${l.nome}: precisa ${l.necessidade} ${l.unidade}, há ${round3(l.necessidade - l.faltando)}`).join('\n');
    throw new HttpError(
      409,
      `Sem saldo de insumos para ${contexto} a OP #${id}:\n${lista}\nCompre os insumos ou, se for gerente/administrador, repita a operação com ?forcar=true (o saldo ficará negativo e o fato será auditado).`
    );
  }

  // Efetiva a baixa — mesmo no forçar, deixando o saldo negativo e auditado.
  for (const l of linhas) {
    await s.adjustInsumoStock(l.insumo_id, -l.necessidade, tx);
    await s.insert(
      getResource('movimentacoes_insumos')!,
      {
        tipo: 'saida',
        insumo_id: l.insumo_id,
        quantidade: l.necessidade,
        custo_unitario: l.custo_unitario,
        motivo: `${contexto} — OP #${id}${forcar && l.faltando > 0 ? ' (forçado)' : ''}`,
        usuario_id: actor.id || null,
        ordem_id: id,
      },
      tx
    );
  }
  return { linhas, emFalta, divergencia };
}

// ----------------------------------------------------------------------------
// Concluir OP: entrada de produto acabado + consumo restante + custo real.
// Reabrir: estorna tudo, pelos vínculos formais.
// ----------------------------------------------------------------------------

async function concluirOrdem(op: Row, actor: Actor, tx: Tx, opts: OrdemOpts) {
  const s = getStore();
  const id = Number(op.id);
  const itensPlanejados = await itensProducao(op, tx);
  const pecasPlanejadas = itensPlanejados.reduce((a, i) => a + i.quantidade, 0);
  if (!itensPlanejados.length || pecasPlanejadas <= 0) {
    throw new HttpError(409, 'Adicione ao menos um tamanho com quantidade antes de concluir a OP.');
  }

  // Com apontamento, entra o que foi produzido de verdade; sem apontamento, a
  // quantidade planejada (comportamento anterior à E2, preservado).
  const apontamentos = await apontamentosDaOrdem(id, tx);
  const porTamanho = produzidasPorTamanho(apontamentos);
  const pecasProduzidas = Number(op.quantidade_produzida || 0);
  const pecasPerdidas = Number(op.quantidade_perdida || 0);
  const pecasProcessadas = pecasProduzidas + pecasPerdidas;
  const entradas =
    pecasProduzidas > 0
      ? [...porTamanho.entries()].map(([tamanho_id, quantidade]) => ({ tamanho_id, quantidade }))
      : itensPlanejados;
  const totalEntrada = entradas.reduce((a, i) => a + i.quantidade, 0);
  if (totalEntrada <= 0) {
    throw new HttpError(409, 'Nada a dar entrada: a OP não tem quantidade planejada nem apontamento com peças boas.');
  }

  const ficha = await fichaDoProduto(Number(op.produto_id), tx);
  const pecasBase = pecasProcessadas > 0 ? pecasProcessadas : pecasPlanejadas;
  const { linhas, emFalta, divergencia } = await baixarInsumos(op, ficha, pecasBase, actor, tx, opts, 'Consumo');

  // --- entrada de produto acabado, com vínculo formal à OP -------------------
  const local = await localDeEntrada(op, tx);
  for (const it of entradas) {
    await s.adjustStock(Number(op.produto_id), it.tamanho_id, local.nome, it.quantidade, tx);
    await s.insert(
      getResource('movimentacoes')!,
      {
        tipo: 'entrada',
        produto_id: op.produto_id,
        tamanho_id: it.tamanho_id,
        local: local.nome,
        quantidade: it.quantidade,
        motivo: `Produção concluída — OP #${id}`,
        usuario_id: actor.id || null,
        ordem_id: id,
      },
      tx
    );
  }

  // Espelha produzido/perdido por tamanho na grade da OP (OP "por grade").
  if (String(op.tipo || 'tamanho') === 'grade') {
    for (const it of itensPlanejados) {
      const itemId = await itemIdPorTamanho(id, it.tamanho_id, tx);
      const produzido = pecasProduzidas > 0 ? porTamanho.get(it.tamanho_id) || 0 : it.quantidade;
      const perdido = Number(
        apontamentos.filter((a) => Number(a.tamanho_id) === it.tamanho_id).reduce((acc, a) => acc + Number(a.quantidade_perdida || 0), 0)
      );
      await s.update(recursoOrdem().itens, itemId, { produzido, perdido }, tx);
    }
  }

  const custoReal = await calcularCustoReal(id, ficha, pecasPlanejadas, pecasBase, tx);
  await s.update(
    recursoOrdem().op,
    id,
    { concluida_em: new Date().toISOString(), custo_real: custoReal, quantidade_produzida: totalEntrada, quantidade_perdida: pecasPerdidas },
    tx
  );

  const forcarNota = emFalta.length ? ` — CONSUMO FORÇADO por ${actor.name}: ${emFalta.map((l) => `${l.nome} (−${l.faltando} ${l.unidade})`).join(', ')}` : '';
  const perdaNota = pecasPerdidas > 0 ? `, ${pecasPerdidas} peça(s) perdida(s)` : '';
  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'editar',
      recurso: 'ordens',
      registro_id: id,
      descricao: `OP #${id} concluída — entrada de ${totalEntrada} peça(s) em ${local.nome}${perdaNota} e baixa de ${linhas.length} insumo(s); custo real R$ ${custoReal.toFixed(2)}${forcarNota}`,
      dados: { pecas: totalEntrada, perdidas: pecasPerdidas, insumos: linhas.length, custo_real: custoReal, forcar: emFalta.length > 0, divergencia },
      empresa_id: empresaDoRegistroAudit(recursoOrdem().op, op, actor),
    },
    tx
  );
  await registrarEventoOrdem(
    id,
    'concluida',
    {
      para: 'concluida',
      mensagem: `Entrada de ${totalEntrada} peça(s) em ${local.nome}${perdaNota}; custo real R$ ${custoReal.toFixed(2)}`,
      dados: { pecas: totalEntrada, perdidas: pecasPerdidas, insumos: linhas.length, custo_real: custoReal, local: local.nome, divergencia_insumos: divergencia },
      usuario_id: actor.id || null,
    },
    tx
  );
}

/** Busca o id do item de grade por tamanho (para atualizar produzido/perdido). */
async function itemIdPorTamanho(ordemId: number, tamanhoId: number, tx?: Tx): Promise<number> {
  const s = getStore();
  const itens = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, sort: 'id', dir: 'desc', filter: { ordem_id: ordemId, tamanho_id: tamanhoId } }, tx);
  if (!itens.rows.length) throw new HttpError(404, 'Item da OP não encontrado.');
  return Number(itens.rows[0].id);
}

async function estornarOrdem(op: Row, actor: Actor, tx: Tx) {
  const s = getStore();
  const id = Number(op.id);

  // 1) estorna as ENTRADAS de produto acabado — pela FK `ordem_id`, não pelo
  //    texto do motivo (que continua existindo só para leitura na tela).
  const movs = await s.list(getResource('movimentacoes')!, { page: 1, pageSize: 1000, sort: 'id', dir: 'desc', filter: { ordem_id: id } }, tx);
  let pecas = 0;
  for (const m of movs.rows) {
    if (String(m.tipo) !== 'entrada' || m.estornado) continue;
    const qtd = Number(m.quantidade || 0);
    if (!qtd) continue;
    await s.adjustStock(Number(m.produto_id), m.tamanho_id, m.local, -qtd, tx);
    await s.insert(
      getResource('movimentacoes')!,
      {
        tipo: 'saida',
        produto_id: m.produto_id,
        tamanho_id: m.tamanho_id,
        local: m.local,
        quantidade: qtd,
        motivo: `Estorno — OP #${id} reaberta`,
        usuario_id: actor.id || null,
        ordem_id: id,
      },
      tx
    );
    await s.update(getResource('movimentacoes')!, Number(m.id), { estornado: true, estornado_em: new Date().toISOString(), estornado_por: actor.name }, tx);
    pecas += qtd;
  }

  // 2) devolve os insumos consumidos pela OP (de novo pela FK).
  //
  // A devolução é pelo LÍQUIDO por insumo (saídas − entradas já estornadas), não
  // linha a linha: `movimentacoes_insumos` não tem coluna de estorno, então sem o
  // líquido um segundo "reabrir" devolveria o mesmo insumo de novo. Com o
  // líquido, o segundo estorno encontra zero e não faz nada — idempotente.
  const movsInsumo = await s.list(getResource('movimentacoes_insumos')!, { page: 1, pageSize: 5000, filter: { ordem_id: id } }, tx);
  const liquido = new Map<number, { qtd: number; custo: number }>();
  for (const m of movsInsumo.rows) {
    const insumoId = Number(m.insumo_id);
    const qtd = Number(m.quantidade || 0);
    const sinal = String(m.tipo) === 'saida' ? 1 : String(m.tipo) === 'entrada' ? -1 : 0;
    if (!sinal || !qtd) continue;
    const atual = liquido.get(insumoId) || { qtd: 0, custo: Number(m.custo_unitario || 0) };
    liquido.set(insumoId, { qtd: round3(atual.qtd + sinal * qtd), custo: Number(m.custo_unitario || 0) || atual.custo });
  }
  let insumos = 0;
  for (const [insumoId, { qtd, custo }] of liquido) {
    if (qtd <= 0) continue;
    await s.adjustInsumoStock(insumoId, qtd, tx);
    await s.insert(
      getResource('movimentacoes_insumos')!,
      {
        tipo: 'entrada',
        insumo_id: insumoId,
        quantidade: qtd,
        custo_unitario: custo,
        motivo: `Estorno — OP #${id} reaberta`,
        usuario_id: actor.id || null,
        ordem_id: id,
      },
      tx
    );
    insumos++;
  }

  // 3) zera a produção acumulada e descarta os apontamentos. A trilha fica em
  //    ordens_eventos (o evento `reaberta` carrega o resumo do que foi anulado),
  //    então a história não se perde — mas os apontamentos não podem continuar
  //    vivos, ou a próxima conclusão leria produção que já foi estornada.
  const apontamentos = await apontamentosDaOrdem(id, tx);
  const resumoApontamentos = apontamentos.map((a) => ({
    id: Number(a.id),
    tamanho_id: a.tamanho_id ? Number(a.tamanho_id) : null,
    produzida: Number(a.quantidade_produzida || 0),
    perdida: Number(a.quantidade_perdida || 0),
  }));
  for (const a of apontamentos) await s.remove(recursoEventos().apontamentos, Number(a.id), tx);

  const itensGrade = await s.list(recursoOrdem().itens, { page: 1, pageSize: 200, filter: { ordem_id: id } }, tx);
  for (const it of itensGrade.rows) await s.update(recursoOrdem().itens, Number(it.id), { produzido: 0, perdido: 0 }, tx);

  await s.update(recursoOrdem().op, id, { concluida_em: null, quantidade_produzida: 0, quantidade_perdida: 0, custo_real: 0 }, tx);

  await s.audit(
    {
      usuario_id: actor.id || null,
      usuario: actor.name,
      acao: 'estornar',
      recurso: 'ordens',
      registro_id: id,
      descricao: `OP #${id} reaberta/cancelada — estorno de ${pecas} peça(s), de ${insumos} consumo(s) de insumos e de ${apontamentos.length} apontamento(s)`,
      dados: { pecas, insumos, apontamentos: resumoApontamentos },
      empresa_id: empresaDoRegistroAudit(recursoOrdem().op, op, actor),
    },
    tx
  );
  await registrarEventoOrdem(
    id,
    'reaberta',
    {
      de: 'concluida',
      // `dados` fica no banco para perícia, mas NÃO sai pela API (memdb.decorate
      // apaga o campo em toda leitura). O que o operador precisa ver vai na
      // mensagem — inclusive o que cada apontamento anulado produzia.
      mensagem:
        `Estorno de ${pecas} peça(s), ${insumos} consumo(s) de insumos e ${apontamentos.length} apontamento(s)` +
        (resumoApontamentos.length
          ? ` (${resumoApontamentos.map((a) => `${a.produzida} boa(s)/${a.perdida} refugada(s) no tamanho #${a.tamanho_id ?? '—'}`).join('; ')})`
          : ''),
      dados: { pecas, insumos, apontamentos: resumoApontamentos },
      usuario_id: actor.id || null,
    },
    tx
  );
}

/**
 * Hook chamado por services.ts no create/update de OP quando o status muda
 * (ou ao criar já concluída). Executa DENTRO da transação do serviço.
 */
export async function aplicarRegrasOrdem(
  before: Row | null,
  after: Row,
  data: Payload,
  actor: Actor,
  tx: Tx,
  opts: OrdemOpts = {}
): Promise<void> {
  if (data.status === undefined) return;
  const s = getStore();
  const id = Number(after.id);
  const statusAnterior = before ? String(before.status) : null;
  const statusNovo = String(after.status);

  // --- 1) a transição é legal? -------------------------------------------------
  // Antes da E2 qualquer string era aceita (a coluna não tinha CHECK). Agora o
  // vocabulário e o grafo são conferidos aqui E no banco.
  if (!ehStatusOp(statusNovo)) {
    throw new HttpError(400, `Status de OP inválido: "${statusNovo}". Use ${STATUS_OP.join(', ')}.`, { status: 'Status inválido' });
  }
  if (!transicaoPermitida(statusAnterior, statusNovo)) {
    const permitidos = statusAnterior && ehStatusOp(statusAnterior) ? TRANSICOES_OP[statusAnterior] : [];
    throw new HttpError(
      409,
      permitidos.length
        ? `A OP #${id} está "${ROTULO_STATUS[statusAnterior as StatusOp]}" e não pode ir para "${ROTULO_STATUS[statusNovo]}". Transições permitidas: ${permitidos.map((t) => ROTULO_STATUS[t]).join(', ')}.`
        : `A OP #${id} está "${statusAnterior}" e não pode ir para "${ROTULO_STATUS[statusNovo]}".`
    );
  }
  if (statusAnterior === statusNovo) return; // PUT que repete o status não é transição

  // --- 2) marcos de tempo do fluxo --------------------------------------------
  const agora = new Date().toISOString();
  const marco: Payload = {};
  if (statusNovo === 'liberada' && !before?.liberada_em) Object.assign(marco, { liberada_em: agora, liberada_por: actor.id || null });
  if (statusNovo === 'em_producao' && !before?.iniciada_em) Object.assign(marco, { iniciada_em: agora });
  if (statusNovo === 'cancelada') Object.assign(marco, { cancelada_em: agora, cancelada_por: actor.id || null, motivo_cancelamento: data.motivo_cancelamento ?? before?.motivo_cancelamento ?? null });
  if (Object.keys(marco).length) await s.update(recursoOrdem().op, id, marco, tx);

  // --- 3) efeitos de estoque ---------------------------------------------------
  const concluindo = statusNovo === 'concluida' && statusAnterior !== 'concluida';
  // Atalho de fluxo (ex.: planejada → concluida, sem passar por liberação e
  // produção). É legal — existia antes da E2 — mas fica marcado na trilha,
  // porque pulou etapas e quem audita precisa saber disso.
  if (statusAnterior && ehAtalho(statusAnterior, statusNovo)) {
    await registrarEventoOrdem(
      id,
      'atalho',
      {
        de: statusAnterior,
        para: statusNovo,
        mensagem: `Conclusão direta a partir de "${ROTULO_STATUS[statusAnterior as StatusOp]}": liberação e produção foram puladas`,
        usuario_id: actor.id || null,
      },
      tx
    );
  }
  const estornando = statusAnterior === 'concluida' && statusNovo !== 'concluida';
  const cancelando = statusNovo === 'cancelada';

  if (concluindo) await concluirOrdem(after, actor, tx, opts);
  else if (estornando) await estornarOrdem(before!, actor, tx);
  else if (cancelando && statusAnterior) await registrarEventoOrdem(
    id,
    'cancelada',
    {
      de: statusAnterior,
      para: 'cancelada',
      mensagem: data.motivo_cancelamento ? String(data.motivo_cancelamento) : 'OP cancelada',
      dados: { motivo: data.motivo_cancelamento ?? null },
      usuario_id: actor.id || null,
    },
    tx
  );
  else {
    // `statusAnterior === null` é a criação da OP: o evento é `criada`, não
    // `edicao` (a trilha começava dizendo que a OP tinha sido editada).
    const rotulo =
      statusAnterior === null
        ? 'criada'
        : statusNovo === 'liberada'
          ? 'liberada'
          : statusNovo === 'em_producao'
            ? 'iniciada'
            : statusNovo === 'parcial'
              ? 'parcial'
              : 'edicao';
    await registrarEventoOrdem(
      id,
      rotulo,
      {
        de: statusAnterior,
        para: statusNovo,
        mensagem: statusAnterior === null ? `OP criada já como "${ROTULO_STATUS[statusNovo]}"` : `OP ${ROTULO_STATUS[statusNovo]}`,
        usuario_id: actor.id || null,
      },
      tx
    );
  }
}

// ----------------------------------------------------------------------------
// Itens da OP (grade) — sub-recurso /api/ordens/:id/itens
// ----------------------------------------------------------------------------

async function getOrdem(id: number, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(recursoOrdem().op, { id }, tx);
  if (!row) throw new HttpError(404, 'Ordem de fabricação não encontrada.');
  return row;
}

function assertOrdemEditavel(op: Row) {
  const status = String(op.status);
  // `parcial` entrou na lista na E2: a partir do primeiro apontamento existe
  // produção real registrada, e mudar a grade ali descolaria o produzido do
  // planejado. Planejada, liberada e em produção continuam editáveis.
  if (status === 'parcial' || status === 'concluida' || status === 'cancelada') {
    throw new HttpError(
      409,
      `A OP #${op.id} está "${ROTULO_STATUS[status as StatusOp] || status}" e os tamanhos não podem mais ser alterados. ${status === 'parcial' ? 'Conclua ou cancele a OP para revisar o plano.' : 'Reabra a OP para editar.'}`
    );
  }
}

export async function listItensOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  checkAccess(op, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getOrdem(id);
  const out = await getStore().list(itens, { page: 1, pageSize: 200, sort: 'tamanho_id', dir: 'asc', filter: { ordem_id: id } });
  res.json(out.rows);
}

export async function createItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      if (String(ordem.tipo || 'tamanho') !== 'grade') {
        throw new HttpError(409, 'Esta OP é "por tamanho". Use os campos tamanho/quantidade da própria OP. Converta para "por grade" para usar a grade PP–GG.');
      }
      assertOrdemEditavel(ordem);
      const data = validatePayload(itens, req.body, 'create');
      const qtd = Number(data.quantidade || 0);
      if (qtd <= 0) throw new HttpError(400, 'Informe uma quantidade maior que zero.', { quantidade: 'Deve ser maior que zero' });
      const duplicado = await s.findOneWhere(itens, { ordem_id: id, tamanho_id: Number(data.tamanho_id) }, tx);
      if (duplicado) {
        throw new HttpError(409, 'Este tamanho já está na OP. Edite a quantidade existente.', { tamanho_id: 'Tamanho já incluído' });
      }
      const item = await s.insert(itens, { ...data, ordem_id: id, produzido: 0 }, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: tamanho adicionado à grade (${qtd} un.)`, empresa_id: empresaDoRegistroAudit(recursoOrdem().op, ordem, actor) },
        tx
      );
      return (await s.get(itens, Number(item.id), tx)) ?? item;
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function updateItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      assertOrdemEditavel(ordem);
      const before = await s.findOneWhere(itens, { id: itemId, ordem_id: id }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado nesta OP.');
      const data = validatePayload(itens, req.body, 'update');
      const item = await s.update(itens, itemId, data, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: item ${itemId} alterado`, empresa_id: empresaDoRegistroAudit(recursoOrdem().op, ordem, actor) },
        tx
      );
      return (await s.get(itens, itemId, tx)) ?? item;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function deleteItemOrdem(req: Request, res: Response) {
  const { op, itens } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      assertOrdemEditavel(ordem);
      const before = await s.findOneWhere(itens, { id: itemId, ordem_id: id }, tx);
      if (!before) throw new HttpError(404, 'Item não encontrado nesta OP.');
      await s.remove(itens, itemId, tx);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: tamanho removido da grade`, empresa_id: empresaDoRegistroAudit(recursoOrdem().op, ordem, actor) },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

// ----------------------------------------------------------------------------
// Custo de fabricação
// ----------------------------------------------------------------------------

/** Recalcula custo_calculado e preco_sugerido de uma ficha. */
export async function recalcularFichaValores(fichaId: number, tx?: Tx): Promise<Row | null> {
  const s = getStore();
  const { ficha, itens } = recursoFicha();
  const f = await s.findOneWhere(ficha, { id: fichaId }, tx);
  if (!f) return null;

  const linhas = await s.list(itens, { page: 1, pageSize: 500, filter: { ficha_id: fichaId } }, tx);
  let insumosTotal = 0;
  for (const linha of linhas.rows) {
    const insumo = await s.findOneWhere(getResource('insumos')!, { id: Number(linha.insumo_id) }, tx);
    const custo = Number(insumo?.custo_medio || 0);
    const consumo = Number(linha.consumo || 0);
    const perda = Number(linha.perda_pct || 0);
    insumosTotal += consumo * (1 + perda / 100) * custo;
  }
  const custo = round2(insumosTotal + Number(f.mao_obra || 0) + Number(f.custos_indiretos || 0));
  const margem = Number(f.margem_pct || 0);
  const preco = round2(custo * (1 + margem / 100));
  const updated = await s.update(ficha, fichaId, { custo_calculado: custo, preco_sugerido: preco, calculado_em: new Date().toISOString() }, tx);
  return updated;
}

async function getFicha(id: number, tx?: Tx): Promise<Row> {
  const row = await getStore().findOneWhere(recursoFicha().ficha, { id }, tx);
  if (!row) throw new HttpError(404, 'Ficha técnica não encontrada.');
  return row;
}

export async function listInsumosFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  checkAccess(ficha, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getFicha(id);
  const out = await getStore().list(itens, { page: 1, pageSize: 200, filter: { ficha_id: id } });
  res.json(out.rows);
}

export async function createInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const data = validatePayload(itens, req.body, 'create');
      const item = await s.insert(itens, { ...data, ficha_id: id }, tx);
      const f = await recalcularFichaValores(id, tx);
      const ins = await s.findOneWhere(getResource('insumos')!, { id: Number(data.insumo_id) }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${ins ? labelOf(getResource('insumos')!, ins) : `#${data.insumo_id}`} incluído (consumo ${Number(data.consumo)}${data.perda_pct ? `, perda ${data.perda_pct}%` : ''}) — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
          empresa_id: empresaDoRegistroAudit(recursoFicha().ficha, f, actor),
        },
        tx
      );
      return (await s.get(itens, Number(item.id), tx)) ?? item;
    });
    res.status(201).json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function updateInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const before = await s.findOneWhere(itens, { id: itemId, ficha_id: id }, tx);
      if (!before) throw new HttpError(404, 'Insumo não encontrado nesta ficha.');
      const data = validatePayload(itens, req.body, 'update');
      const item = await s.update(itens, itemId, data, tx);
      const f = await recalcularFichaValores(id, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${itemId} alterado — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
          empresa_id: empresaDoRegistroAudit(recursoFicha().ficha, f, actor),
        },
        tx
      );
      return (await s.get(itens, itemId, tx)) ?? item;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

export async function deleteInsumoFicha(req: Request, res: Response) {
  const { ficha, itens } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const s = getStore();
  try {
    await s.transaction(async (tx) => {
      await getFicha(id, tx);
      const before = await s.findOneWhere(itens, { id: itemId, ficha_id: id }, tx);
      if (!before) throw new HttpError(404, 'Insumo não encontrado nesta ficha.');
      await s.remove(itens, itemId, tx);
      const f = await recalcularFichaValores(id, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'fichas',
          registro_id: id,
          descricao: `Ficha #${id}: insumo ${itemId} removido — custo recalculado para R$ ${f?.custo_calculado ?? 0}`,
          empresa_id: empresaDoRegistroAudit(recursoFicha().ficha, f, actor),
        },
        tx
      );
    });
    res.json({ ok: true });
  } catch (e) {
    throw toHttpError(e, itens);
  }
}

/** POST /api/fichas/:id/aplicar-preco — copia custo/preço calculados ao produto. */
export async function aplicarPrecoFicha(req: Request, res: Response) {
  const { ficha } = recursoFicha();
  const actor = currentUser(req);
  checkAccess(ficha, actor, 'update');
  // Aplicar a ficha escreve custo E preço de venda no produto — é decisão de
  // precificação, não de chão de fábrica. O recurso `fichas` não declara
  // minPerfil (o operador precisa editar consumo/perda), então a trava tem que
  // estar aqui. Encontrado pelo teste de custo: antes, qualquer operador aplicava.
  exigirGerenteProducao(actor, 'aplicar o preço da ficha ao produto');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const f = await getFicha(id, tx);
      const produtoId = Number(f.produto_id);
      if (!produtoId) throw new HttpError(400, 'A ficha não está vinculada a um produto.');
      const produto = await s.findOneWhere(getResource('produtos')!, { id: produtoId }, tx);
      if (!produto) throw new HttpError(404, 'Produto da ficha não encontrado.');
      const custo = Number(f.custo_calculado ?? 0);
      const preco = Number(f.preco_sugerido ?? 0);
      await s.update(getResource('produtos')!, produtoId, { custo, preco_venda: preco }, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'produtos',
          registro_id: produtoId,
          descricao: `Custo e preço aplicados da ficha #${id} ao produto ${labelOf(getResource('produtos')!, produto)} — custo R$ ${custo}, preço sugerido R$ ${preco}`,
          dados: { ficha_id: id, custo, preco_venda: preco },
          empresa_id: empresaDoRegistroAudit(recursoFicha().ficha, f, actor),
        },
        tx
      );
      return { custo, preco_venda: preco, produto_id: produtoId };
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, ficha);
  }
}

// ----------------------------------------------------------------------------
// GET /api/producao/painel — cockpit da Produção (KPIs para o topo da lista de OPs)
// ----------------------------------------------------------------------------
export async function producaoPainel(req: Request, res: Response) {
  const actor = currentUser(req);
  const { op } = recursoOrdem();
  checkAccess(op, actor, 'read');
  const s = getStore();
  const [ordens, itensOrdem] = await Promise.all([
    s.list(op, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' }),
    s.list(getResource('itens_ordem')!, { page: 1, pageSize: 10000 }),
  ]);
  const pecasDa = (o: Row): number => {
    if (String(o.tipo) === 'grade') {
      return itensOrdem.rows.filter((i) => Number(i.ordem_id) === Number(o.id)).reduce((a, i) => a + Number(i.quantidade || 0), 0);
    }
    return Number(o.quantidade || 0);
  };

  const hoje = new Date().toISOString().slice(0, 10);
  const mes = hoje.slice(0, 7);
  // E2: `liberada` e `parcial` são estados novos e contam como OP aberta.
  const abertas = ordens.rows.filter((o) => ['planejada', 'liberada', 'em_producao', 'parcial'].includes(String(o.status)));
  const atrasadas = abertas.filter((o) => o.previsao && String(o.previsao).slice(0, 10) < hoje);
  const concluidasMes = ordens.rows.filter((o) => {
    if (String(o.status) !== 'concluida') return false;
    const d = String(o.concluida_em || o.atualizado_em || o.criado_em || '').slice(0, 7);
    return d === mes;
  });
  const pecasMes = concluidasMes.reduce((a, o) => a + pecasDa(o), 0);
  const pecasAbertas = abertas.reduce((a, o) => a + pecasDa(o), 0);

  // Produção por semana (últimas 8 semanas, OPs concluídas)
  const semanas: { semana: string; label: string; pecas: number }[] = [];
  const agora = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - i * 7 - agora.getDay() + 1);
    const chave = d.toISOString().slice(0, 10);
    semanas.push({ semana: chave, label: `${chave.slice(8, 10)}/${chave.slice(5, 7)}`, pecas: 0 });
  }
  for (const o of ordens.rows) {
    if (String(o.status) !== 'concluida') continue;
    const dia = String(o.concluida_em || o.atualizado_em || o.criado_em || '').slice(0, 10);
    for (let i = semanas.length - 1; i >= 0; i--) {
      const ini = semanas[i].semana;
      const fim = i + 1 < semanas.length ? semanas[i + 1].semana : '9999-12-31';
      if (dia >= ini && dia < fim) {
        semanas[i].pecas += pecasDa(o);
        break;
      }
    }
  }

  res.json({
    planejadas: ordens.rows.filter((o) => String(o.status) === 'planejada').length,
    liberadas: ordens.rows.filter((o) => String(o.status) === 'liberada').length,
    emProducao: ordens.rows.filter((o) => ['em_producao', 'parcial'].includes(String(o.status))).length,
    parciais: ordens.rows.filter((o) => String(o.status) === 'parcial').length,
    atrasadas: atrasadas.length,
    pecasAbertas,
    concluidasMes: concluidasMes.length,
    pecasMes,
    porSemana: semanas,
    alertas: atrasadas.slice(0, 6).map((o) => ({
      id: Number(o.id),
      produto: o.produto_id__label || `#${o.produto_id}`,
      previsao: o.previsao ? String(o.previsao).slice(0, 10) : null,
      quantidade: pecasDa(o),
      status: String(o.status),
    })),
  });
}

// ============================================================================
// ENDPOINTS DE FLUXO DA OP (E2)
//
//   POST /api/ordens/:id/liberar        planejada → liberada (grava custo previsto)
//   POST /api/ordens/:id/iniciar        → em_producao
//   POST /api/ordens/:id/apontamentos   registra produção/perda e consome insumo
//   GET  /api/ordens/:id/apontamentos   histórico de apontamentos
//   GET  /api/ordens/:id/eventos        trilha de transições
//   POST /api/ordens/:id/concluir       → concluida (entrada no estoque)
//   POST /api/ordens/:id/cancelar       → cancelada (gerente/admin)
//   POST /api/ordens/:id/reabrir        concluida → em_producao (gerente/admin; estorna)
//
// Todos os efeitos de estoque passam por `updateRecord` → `aplicarRegrasOrdem`,
// que é o MESMO caminho do PUT genérico. Não existe uma segunda implementação
// da baixa de insumos ou da entrada de produto acabado.
//
// Concorrência: a transição de status é feita com `tryUpdateIf` (UPDATE ... WHERE
// status = esperado), então duas requisições simultâneas não passam as duas — a
// perdedora vê a linha já mudada e devolve 409.
// ============================================================================

function exigirGerenteProducao(actor: Actor, acao: string): void {
  if (actor.perfil !== 'admin' && actor.perfil !== 'gerente') {
    throw new HttpError(403, `Somente gerentes e administradores podem ${acao}.`);
  }
}

/** Transição atômica de status. `null` quando a condição não bateu (concorrência). */
async function transicionar(id: number, esperado: StatusOp, para: StatusOp, extra: Payload, tx: Tx): Promise<Row | null> {
  return getStore().tryUpdateIf(recursoOrdem().op, id, { status: esperado }, { ...extra, status: para }, tx);
}

/** Mensagem de 409 padrão quando a OP não está no estado que a ação exige. */
function erroEstado(op: Row, acao: string, esperados: StatusOp[]): HttpError {
  return new HttpError(
    409,
    `Não dá para ${acao}: a OP #${op.id} está "${ROTULO_STATUS[String(op.status) as StatusOp] || op.status}". Esta ação exige ${esperados.map((e) => `"${ROTULO_STATUS[e]}"`).join(' ou ')}.`
  );
}

/** POST /api/ordens/:id/liberar */
export async function liberarOrdem(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  exigirGerenteProducao(actor, 'liberar uma ordem de produção');
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      if (String(ordem.status) !== 'planejada') throw erroEstado(ordem, 'liberar a OP', ['planejada']);
      const itens = await itensProducao(ordem, tx);
      const pecas = itens.reduce((a, i) => a + i.quantidade, 0);
      if (!itens.length || pecas <= 0) throw new HttpError(409, 'Adicione ao menos um tamanho com quantidade antes de liberar a OP.');

      // Custo previsto = peças planejadas × custo da ficha NESTE momento.
      // Fica congelado de propósito: editar a ficha depois não reescreve o que
      // foi orçado quando a OP foi para o chão de fábrica.
      const ficha = await fichaDoProduto(Number(ordem.produto_id), tx);
      const custoUnitario = ficha ? Number(ficha.custo_calculado || 0) : 0;
      const custoPrevisto = round2(pecas * custoUnitario);

      const atualizada = await transicionar(id, 'planejada', 'liberada', {
        custo_previsto: custoPrevisto,
        liberada_em: new Date().toISOString(),
        liberada_por: actor.id || null,
      }, tx);
      if (!atualizada) throw new HttpError(409, `A OP #${id} mudou de estado enquanto você operava. Recarregue e tente de novo.`);

      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'ordens',
          registro_id: id,
          descricao: `OP #${id} liberada para produção — ${pecas} peça(s), custo previsto R$ ${custoPrevisto.toFixed(2)}`,
          dados: { pecas, custo_previsto: custoPrevisto, custo_unitario_ficha: custoUnitario, tem_ficha: !!ficha },
          empresa_id: empresaDoRegistroAudit(op, ordem, actor),
        },
        tx
      );
      await registrarEventoOrdem(id, 'liberada', {
        de: 'planejada',
        para: 'liberada',
        mensagem: `Liberada para produção — ${pecas} peça(s), custo previsto R$ ${custoPrevisto.toFixed(2)}`,
        dados: { pecas, custo_previsto: custoPrevisto, tem_ficha: !!ficha },
        usuario_id: actor.id || null,
      }, tx);
      if (!ficha) {
        await registrarEventoOrdem(id, 'edicao', {
          para: 'liberada',
          mensagem: 'O produto não tem ficha técnica: o custo previsto ficou em R$ 0,00 e a conclusão não baixará insumos.',
          usuario_id: actor.id || null,
        }, tx);
      }
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, op);
  }
}

/** POST /api/ordens/:id/iniciar */
export async function iniciarOrdem(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      const de = String(ordem.status);
      if (de !== 'planejada' && de !== 'liberada' && de !== 'parcial') throw erroEstado(ordem, 'iniciar a OP', ['planejada', 'liberada', 'parcial']);
      const extra: Payload = ordem.iniciada_em ? {} : { iniciada_em: new Date().toISOString() };
      // `parcial` volta para `em_producao` (retomar o chão de fábrica); as outras
      // vão para `em_producao` pela primeira vez.
      const atualizada = await transicionar(id, de as StatusOp, 'em_producao', extra, tx);
      if (!atualizada) throw new HttpError(409, `A OP #${id} mudou de estado enquanto você operava. Recarregue e tente de novo.`);
      await s.audit(
        { usuario_id: actor.id || null, usuario: actor.name, acao: 'editar', recurso: 'ordens', registro_id: id, descricao: `OP #${id}: produção iniciada`, empresa_id: empresaDoRegistroAudit(op, ordem, actor) },
        tx
      );
      await registrarEventoOrdem(id, 'iniciada', { de, para: 'em_producao', mensagem: 'Produção iniciada', usuario_id: actor.id || null }, tx);
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, op);
  }
}

/** GET /api/ordens/:id/apontamentos */
export async function listApontamentos(req: Request, res: Response) {
  const { op } = recursoOrdem();
  checkAccess(op, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getOrdem(id);
  // id desc: mesmo motivo do histórico — `apontado_em` empata quando o turno
  // aponta dois tamanhos em seguida.
  const out = await getStore().list(recursoEventos().apontamentos, { page: 1, pageSize: 500, sort: 'id', dir: 'desc', filter: { ordem_id: id } });
  res.json(out.rows);
}

/** GET /api/ordens/:id/eventos */
export async function listEventosOrdem(req: Request, res: Response) {
  const { op } = recursoOrdem();
  checkAccess(op, currentUser(req), 'read');
  const id = parseId(req.params.id);
  await getOrdem(id);
  // Ordena por id, não por criado_em: apontamento e perda são gravados no mesmo
  // milissegundo e o empate em criado_em deixava a ordem a cargo do banco (a UI
  // chegou a mostrar a perda antes do apontamento). O id é monotônico na trilha.
  const out = await getStore().list(recursoEventos().eventos, { page: 1, pageSize: 500, sort: 'id', dir: 'asc', filter: { ordem_id: id } });
  res.json(out.rows);
}

/**
 * POST /api/ordens/:id/apontamentos
 *
 * body: { tamanho_id?, quantidade_produzida, quantidade_perdida?, observacoes?,
 *         idempotency_key? }
 *
 * O apontamento é o que o chão de fábrica informa. Efeitos:
 *   • consome insumo da ficha para (produzida + perdida) — peça refugada custa;
 *   • acumula quantidade_produzida / quantidade_perdida na OP;
 *   • recalcula o custo real;
 *   • move a OP para `parcial`.
 *
 * Idempotente quando `idempotency_key` vem: repetir o POST devolve o mesmo
 * apontamento sem consumir insumo de novo (rede instável no apontador).
 */
export async function criarApontamento(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const forcar = req.query.forcar === 'true' || req.query.forcar === '1';
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      const de = String(ordem.status);
      if (de !== 'liberada' && de !== 'em_producao' && de !== 'parcial') {
        throw erroEstado(ordem, 'apontar produção', ['liberada', 'em_producao', 'parcial']);
      }

      // ---- idempotência -------------------------------------------------
      const chave = typeof req.body?.idempotency_key === 'string' && req.body.idempotency_key.trim() ? req.body.idempotency_key.trim().slice(0, 120) : null;
      if (chave) {
        const existente = await s.findOneWhere(recursoEventos().apontamentos, { ordem_id: id, idempotency_key: chave }, tx);
        if (existente) return { ...existente, idempotente: true };
      }

      // ---- validação ----------------------------------------------------
      const produzida = Number(req.body?.quantidade_produzida ?? 0);
      const perdida = Number(req.body?.quantidade_perdida ?? 0);
      if (!Number.isInteger(produzida) || !Number.isInteger(perdida) || produzida < 0 || perdida < 0) {
        throw new HttpError(400, 'Quantidades do apontamento devem ser inteiros maiores ou iguais a zero.', {
          quantidade_produzida: 'Inteiro >= 0',
          quantidade_perdida: 'Inteiro >= 0',
        });
      }
      if (produzida <= 0 && perdida <= 0) {
        throw new HttpError(400, 'Informe peças produzidas ou perdidas — um apontamento vazio não registra nada.');
      }
      let tamanhoId = req.body?.tamanho_id ? Number(req.body.tamanho_id) : null;
      if (!tamanhoId) {
        if (ordem.tamanho_id) tamanhoId = Number(ordem.tamanho_id);
        else throw new HttpError(400, 'Esta OP é por grade: informe o tamanho do apontamento.', { tamanho_id: 'Obrigatório em OP por grade' });
      }
      const itensPlanejados = await itensProducao(ordem, tx);
      if (!itensPlanejados.some((i) => i.tamanho_id === tamanhoId)) {
        throw new HttpError(400, `O tamanho #${tamanhoId} não faz parte do plano desta OP.`, { tamanho_id: 'Tamanho fora do plano da OP' });
      }

      // ---- consumo de insumo (peça refugada também consome) --------------
      const ficha = await fichaDoProduto(Number(ordem.produto_id), tx);
      const produzidasAteAqui = Number(ordem.quantidade_produzida || 0);
      const perdidasAteAqui = Number(ordem.quantidade_perdida || 0);
      const { linhas, emFalta, divergencia } = await baixarInsumos(
        ordem,
        ficha,
        produzidasAteAqui + perdidasAteAqui + produzida + perdida,
        actor,
        tx,
        { forcar },
        'Consumo'
      );

      const apontamento = await s.insert(
        recursoEventos().apontamentos,
        {
          ordem_id: id,
          tamanho_id: tamanhoId,
          quantidade_produzida: produzida,
          quantidade_perdida: perdida,
          observacoes: typeof req.body?.observacoes === 'string' ? req.body.observacoes.slice(0, 500) : null,
          idempotency_key: chave,
          usuario_id: actor.id || null,
        },
        tx
      );

      // ---- acumula na OP e recalcula o custo real ------------------------
      const pecasPlanejadas = itensPlanejados.reduce((a, i) => a + i.quantidade, 0);
      const novaProduzida = produzidasAteAqui + produzida;
      const novaPerdida = perdidasAteAqui + perdida;
      const custoReal = await calcularCustoReal(id, ficha, pecasPlanejadas, novaProduzida + novaPerdida, tx);
      const acumulado: Payload = {
        quantidade_produzida: novaProduzida,
        quantidade_perdida: novaPerdida,
        custo_real: custoReal,
      };
      if (!ordem.iniciada_em) acumulado.iniciada_em = new Date().toISOString();

      // Transição condicional: só vai a `parcial` se ainda estiver no estado lido
      // acima. Duas requisições simultâneas não acumulam duas vezes sobre a mesma
      // base — a perdedora cai no 409.
      const alvo: StatusOp = 'parcial';
      const atualizada = de === alvo
        ? await s.update(recursoOrdem().op, id, acumulado, tx)
        : await transicionar(id, de as StatusOp, alvo, acumulado, tx);
      if (!atualizada) throw new HttpError(409, `A OP #${id} mudou de estado enquanto você apontava. Recarregue e tente de novo.`);

      // espelha na grade da OP
      if (String(ordem.tipo || 'tamanho') === 'grade') {
        const itemId = await itemIdPorTamanho(id, tamanhoId, tx);
        const linha = await s.findOneWhere(recursoOrdem().itens, { id: itemId }, tx);
        await s.update(
          recursoOrdem().itens,
          itemId,
          {
            produzido: Number(linha?.produzido || 0) + produzida,
            perdido: Number(linha?.perdido || 0) + perdida,
          },
          tx
        );
      }

      const resumo = `${produzida} peça(s) boa(s)` + (perdida > 0 ? ` e ${perdida} refugada(s)` : '') + ` no tamanho #${tamanhoId}`;
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          acao: 'editar',
          recurso: 'ordens',
          registro_id: id,
          descricao: `OP #${id}: apontamento — ${resumo}; ${linhas.length} insumo(s) baixado(s); custo real R$ ${custoReal.toFixed(2)}${emFalta.length ? ` — CONSUMO FORÇADO por ${actor.name}` : ''}`,
          dados: { produzida, perdida, tamanho_id: tamanhoId, insumos: linhas.length, custo_real: custoReal, forcar: emFalta.length > 0, divergencia },
          empresa_id: empresaDoRegistroAudit(op, ordem, actor),
        },
        tx
      );
      await registrarEventoOrdem(id, 'apontamento', {
        de,
        para: alvo,
        mensagem: resumo,
        dados: { produzida, perdida, tamanho_id: tamanhoId, insumos: linhas.length, custo_real: custoReal, divergencia_insumos: divergencia },
        usuario_id: actor.id || null,
      }, tx);
      if (perdida > 0) {
        await registrarEventoOrdem(id, 'perda', {
          para: alvo,
          mensagem: `${perdida} peça(s) refugada(s) no tamanho #${tamanhoId} — o insumo foi consumido e não entrou no estoque`,
          dados: { perdida, tamanho_id: tamanhoId },
          usuario_id: actor.id || null,
        }, tx);
      }
      return { ...(await s.get(recursoEventos().apontamentos, Number(apontamento.id), tx))!, idempotente: false };
    });
    res.status(out.idempotente ? 200 : 201).json(out);
  } catch (e) {
    throw toHttpError(e, op);
  }
}

/** POST /api/ordens/:id/concluir */
export async function concluirOrdemHandler(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const forcar = req.query.forcar === 'true' || req.query.forcar === '1';
  const out = await updateRecord(op, id, { status: 'concluida' }, actor, { forcar, escopo: escopoDe(actor) });
  res.json(out);
}

/**
 * POST /api/ordens/:id/cancelar — operação sensível: gerente/admin.
 *
 * Não usa `updateRecord` de propósito: `motivo_cancelamento` é readonly e
 * `form: false`, e `writableFields()` o remove do payload validado — o PUT
 * genérico nunca conseguiria gravá-lo. A transição roda aqui dentro de uma
 * transação própria e reaproveita `aplicarRegrasOrdem`, então a máquina de
 * estados, a trilha e o efeito de estoque continuam sendo UM caminho só.
 */
export async function cancelarOrdem(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  exigirGerenteProducao(actor, 'cancelar uma ordem de produção');
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const motivo = typeof req.body?.motivo === 'string' && req.body.motivo.trim() ? req.body.motivo.trim().slice(0, 500) : null;
  const s = getStore();
  try {
    const out = await s.transaction(async (tx) => {
      const ordem = await getOrdem(id, tx);
      const de = String(ordem.status);
      if (de === 'cancelada') throw new HttpError(409, `A OP #${id} já está cancelada.`);
      if (!transicaoPermitida(de as StatusOp, 'cancelada')) throw erroEstado(ordem, 'cancelar a OP', ['planejada', 'liberada', 'em_producao', 'parcial']);

      const atualizada = await transicionar(id, de as StatusOp, 'cancelada', {
        motivo_cancelamento: motivo,
        cancelada_em: new Date().toISOString(),
        cancelada_por: actor.id || null,
      }, tx);
      if (!atualizada) throw new HttpError(409, `A OP #${id} mudou de estado enquanto você operava. Recarregue e tente de novo.`);

      // Payload cru (não validado): é assim que o motivo chega a aplicarRegrasOrdem.
      await aplicarRegrasOrdem(ordem, atualizada, { status: 'cancelada', motivo_cancelamento: motivo }, actor, tx);
      await s.audit(
        {
          usuario_id: actor.id || null,
          usuario: actor.name,
          // `cancelar` não existe no vocabulário de `auditoria.acao`; 'editar' é a
          // ação de mudança de estado já usada pelos outros fluxos da OP.
          acao: 'editar',
          recurso: 'ordens',
          registro_id: id,
          descricao: `OP #${id} cancelada${motivo ? ` — ${motivo}` : ''}`,
          dados: { motivo, de },
          empresa_id: empresaDoRegistroAudit(op, ordem, actor),
        },
        tx
      );
      return atualizada;
    });
    res.json(out);
  } catch (e) {
    throw toHttpError(e, op);
  }
}

/** POST /api/ordens/:id/reabrir — retroativo: gerente/admin. Estorna estoque e consumo. */
export async function reabrirOrdem(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  exigirGerenteProducao(actor, 'reabrir uma ordem de produção concluída');
  checkAccess(op, actor, 'read');
  const id = parseId(req.params.id);
  const s = getStore();
  const ordem = await s.findOneWhere(op, { id });
  if (!ordem) throw new HttpError(404, 'Ordem de fabricação não encontrada.');
  if (String(ordem.status) !== 'concluida') throw erroEstado(ordem, 'reabrir a OP', ['concluida']);
  // A tela usa `planejada`; `?produzindo=true` reabre já no chão de fábrica.
  const para: StatusOp = req.query.produzindo === 'true' ? 'em_producao' : 'planejada';
  const out = await updateRecord(op, id, { status: para }, actor, { escopo: escopoDe(actor) });
  res.json(out);
}

// ============================================================================
// GET /api/producao/planejamento — plano de produção e necessidade de insumos
//
// Responde duas perguntas com dado real do domínio (nada é estimado nem
// interpolado):
//   1) o que está planejado por semana, quanto já foi produzido e o que está
//      atrasado;
//   2) quais insumos faltam para executar o que está planejado (necessidade da
//      ficha × peças planejadas − saldo atual − o que já está comprado/em OP).
//
// Sem OP planejada no período, a resposta vem vazia — a tela mostra o estado
// vazio em vez de inventar número.
// ============================================================================

function segundaDaSemana(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dia = (d.getUTCDay() + 6) % 7; // segunda = 0
  d.setUTCDate(d.getUTCDate() - dia);
  return d.toISOString().slice(0, 10);
}

export async function planejamentoProducao(req: Request, res: Response) {
  const { op } = recursoOrdem();
  const actor = currentUser(req);
  checkAccess(op, actor, 'read');
  const s = getStore();

  const hoje = new Date().toISOString().slice(0, 10);
  const de = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? req.query.de : segundaDaSemana(hoje);
  const ate = typeof req.query.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate) ? req.query.ate : (() => {
    const d = new Date(`${de}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 55); // 8 semanas a partir do início
    return d.toISOString().slice(0, 10);
  })();

  const todas = await s.list(op, { page: 1, pageSize: 5000, sort: 'id', dir: 'desc' });
  const noPeriodo = todas.rows.filter((o) => {
    const status = String(o.status);
    if (!['planejada', 'liberada', 'em_producao', 'parcial'].includes(status)) return false;
    const dia = String(o.previsao || o.criado_em || '').slice(0, 10);
    return dia >= de && dia <= ate;
  });

  // ---- peças planejadas × produzidas por OP ---------------------------------
  const linhas: {
    id: number;
    produto: string;
    produto_id: number;
    status: string;
    previsao: string | null;
    semana: string;
    planejadas: number;
    produzidas: number;
    perdidas: number;
    faltam: number;
    atrasada: boolean;
    custo_previsto: number;
    responsavel: string | null;
  }[] = [];

  for (const o of noPeriodo) {
    const itens = await itensProducao(o);
    const planejadas = itens.reduce((a, i) => a + i.quantidade, 0);
    const produzidas = Number(o.quantidade_produzida || 0);
    const perdidas = Number(o.quantidade_perdida || 0);
    const dia = String(o.previsao || o.criado_em || '').slice(0, 10) || de;
    linhas.push({
      id: Number(o.id),
      produto: o.produto_id__label ? String(o.produto_id__label) : `#${o.produto_id}`,
      produto_id: Number(o.produto_id),
      status: String(o.status),
      previsao: o.previsao ? String(o.previsao).slice(0, 10) : null,
      semana: segundaDaSemana(dia),
      planejadas,
      produzidas,
      perdidas,
      faltam: Math.max(0, planejadas - produzidas),
      atrasada: !!o.previsao && String(o.previsao).slice(0, 10) < hoje,
      custo_previsto: Number(o.custo_previsto || 0),
      responsavel: o.responsavel_id__label ? String(o.responsavel_id__label) : null,
    });
  }

  // ---- semanas ---------------------------------------------------------------
  const porSemana = new Map<string, { semana: string; ops: number; planejadas: number; produzidas: number; atrasadas: number; custo_previsto: number }>();
  for (const l of linhas) {
    const s2 = porSemana.get(l.semana) || { semana: l.semana, ops: 0, planejadas: 0, produzidas: 0, atrasadas: 0, custo_previsto: 0 };
    s2.ops++;
    s2.planejadas += l.planejadas;
    s2.produzidas += l.produzidas;
    s2.custo_previsto = round2(s2.custo_previsto + l.custo_previsto);
    if (l.atrasada) s2.atrasadas++;
    porSemana.set(l.semana, s2);
  }

  // ---- necessidade de insumos (MRP) ------------------------------------------
  // Necessidade = Σ (peças que faltam produzir × consumo da ficha com perda).
  // Disponível = saldo atual do insumo. Faltando = necessidade − disponível.
  const necessidade = new Map<number, { insumo_id: number; nome: string; unidade: string; necessaria: number; disponivel: number; faltando: number }>();
  for (const l of linhas) {
    if (l.faltam <= 0) continue;
    const ficha = await fichaDoProduto(l.produto_id);
    if (!ficha) continue;
    const mapa = await necessidadeDaFicha(ficha, l.faltam, null);
    for (const [insumoId, linha] of mapa) {
      const atual = necessidade.get(insumoId) || {
        insumo_id: insumoId,
        nome: linha.nome,
        unidade: linha.unidade,
        necessaria: 0,
        disponivel: round3(await s.insumoStock(insumoId)),
        faltando: 0,
      };
      atual.necessaria = round3(atual.necessaria + linha.necessidade);
      necessidade.set(insumoId, atual);
    }
  }
  const insumos = [...necessidade.values()].map((i) => ({ ...i, faltando: round3(Math.max(0, i.necessaria - i.disponivel)) }));
  insumos.sort((a, b) => b.faltando - a.faltando || a.nome.localeCompare(b.nome));

  res.json({
    de,
    ate,
    hoje,
    resumo: {
      ops: linhas.length,
      planejadas: linhas.reduce((a, l) => a + l.planejadas, 0),
      produzidas: linhas.reduce((a, l) => a + l.produzidas, 0),
      perdidas: linhas.reduce((a, l) => a + l.perdidas, 0),
      faltam: linhas.reduce((a, l) => a + l.faltam, 0),
      atrasadas: linhas.filter((l) => l.atrasada).length,
      custo_previsto: round2(linhas.reduce((a, l) => a + l.custo_previsto, 0)),
      insumos_em_falta: insumos.filter((i) => i.faltando > 0).length,
    },
    porSemana: [...porSemana.values()].sort((a, b) => a.semana.localeCompare(b.semana)),
    ordens: linhas.sort((a, b) => a.semana.localeCompare(b.semana) || a.id - b.id),
    insumos,
  });
}
