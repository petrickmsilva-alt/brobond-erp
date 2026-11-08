// ============================================================================
// OMS — MÁQUINA DE ESTADOS EXPLÍCITA DO PEDIDO DE VENDA (migration 0109)
//
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------
// O ciclo do pedido tem UM estado autoritativo (`vendas.status`), mas as regras
// de transição estavam espalhadas: `aplicarRegrasPedido` (itens.ts) conhecia
// duas transições proibidas, a expedição conhecia as suas, a aprovação as suas.
// Nenhum lugar declarava o conjunto de estados e transições VÁLIDAS, e nenhuma
// trilha única respondia "por que este pedido está neste estado?".
//
// Este módulo é FOLHA (não importa services/itens para não criar ciclo) e faz
// duas coisas:
//   1. declara a máquina de estados (estados, transições válidas, terminais);
//   2. grava a PROVA da transição em `vendas_status_historico`.
//
// A AUTORIDADE do estado continua sendo `vendas.status`. Este módulo NÃO cria
// uma segunda fonte de verdade — ele registra a transição que já aconteceu.
//
// REGRAS
//   • Idempotência: chamar sem mudança de estado não grava nada.
//   • Transição proibida entre estados conhecidos → HttpError 409 (a origem do
//     fluxo, não o frontend, é quem decide).
//   • `anterior` desconhecido (dado legado) não bloqueia: registra-se o fato.
//   • Multiempresa: a linha carrega `empresa_id`; nada cruza empresa.
// ============================================================================
import { HttpError } from './errors';
import { getResource } from './resources';
import type { Row, Store, Tx } from './store';

/** Estados conhecidos de um pedido de venda, na ordem do ciclo comercial. */
export const STATUS_PEDIDO = [
  'cotacao',
  'pendente_aprovacao',
  'aberta',
  'faturada',
  'entregue',
  'cancelada',
] as const;
export type StatusPedido = (typeof STATUS_PEDIDO)[number];

/** Canal que disparou a transição — filtro operacional da trilha. */
export type OrigemTransicao =
  | 'erp'
  | 'expedicao'
  | 'fiscal'
  | 'pdv'
  | 'portal'
  | 'marketplace'
  | 'aprovacao'
  | 'devolucao'
  | 'sistema';

const ORIGENS: readonly OrigemTransicao[] = [
  'erp', 'expedicao', 'fiscal', 'pdv', 'portal', 'marketplace', 'aprovacao', 'devolucao', 'sistema',
];

/**
 * Transições VÁLIDAS. A chave é o estado atual; o valor, os estados alcançáveis.
 *
 * O grafo espelha EXATAMENTE o comportamento já vigente do ERP — esta migração
 * não introduz regra comercial nova, apenas CENTRALIZA e AUDITA o que já valia:
 *
 *   cotacao ──aprovar──▶ aberta ──faturar──▶ faturada ──entregar──▶ entregue
 *      │  └─▶ pendente_aprovacao ─▶ aberta
 *      └────────────────▶ cancelada (recusa do cliente)
 *   faturada ─cancelar──▶ cancelada   (estorna estoque/financeiro)
 *   entregue ─cancelar──▶ cancelada
 *
 * O que o grafo BLOQUEIA (e já era bloqueado em `aplicarRegrasPedido`):
 *   • sair de `cancelada` — é terminal; reabrir seria outra venda;
 *   • `faturada`/`entregue` → `cotacao`/`pendente_aprovacao`/`aberta` — não se
 *     "desfatura" um pedido sem cancelar (o estoque saiu).
 *
 * As arestas permissivas dos estados pré-faturamento (ex.: `aberta → entregue`,
 * aceita pelo fluxo de balcão/expedição) permanecem para não regredir. Estados
 * industriais (separação, expedição, entrega parcial, devolução) vivem nas
 * tabelas de expedição/envio e serão promovidos a este grafo em evolução
 * própria — não são inventados aqui.
 */
const TRANSICOES: Record<StatusPedido, readonly StatusPedido[]> = {
  cotacao: ['pendente_aprovacao', 'aberta', 'faturada', 'entregue', 'cancelada'],
  pendente_aprovacao: ['aberta', 'faturada', 'entregue', 'cancelada'],
  aberta: ['pendente_aprovacao', 'faturada', 'entregue', 'cancelada'],
  faturada: ['entregue', 'cancelada'],
  entregue: ['faturada', 'cancelada'],
  cancelada: [],
};

export function statusConhecido(valor: unknown): valor is StatusPedido {
  return typeof valor === 'string' && (STATUS_PEDIDO as readonly string[]).includes(valor);
}

export function origemValida(valor: unknown): valor is OrigemTransicao {
  return typeof valor === 'string' && (ORIGENS as readonly string[]).includes(valor);
}

/** Estados a partir dos quais não há saída (exceto permanecer neles). */
export function ehTerminal(status: string): boolean {
  return statusConhecido(status) && TRANSICOES[status].length === 0;
}

/** Estados em que o pedido já produziu efeito econômico (estoque baixado). */
export function ehFaturado(status: string): boolean {
  return status === 'faturada' || status === 'entregue';
}

/**
 * Decide se `de → para` é uma transição permitida.
 *
 * - Sem mudança de estado → permitida (nada a fazer).
 * - `para` desconhecido → SEMPRE recusada (não se inventa estado).
 * - `de` desconhecido (legado) → permitida; não há como julgar o passado.
 * - Ambos conhecidos → permitida apenas se estiver em TRANSICOES.
 */
export function transicaoPermitida(de: string | null | undefined, para: string): boolean {
  if (de === para) return true;
  if (!statusConhecido(para)) return false;
  if (de === null || de === undefined) return true; // criação: estado inicial livre
  if (!statusConhecido(de)) return true;            // legado: não bloqueia
  return TRANSICOES[de].includes(para);
}

/** Lança 409 quando a transição é proibida; devolve o motivo legível. */
export function validarTransicao(de: string | null | undefined, para: string): void {
  if (transicaoPermitida(de, para)) return;
  if (!statusConhecido(para)) {
    throw new HttpError(409, `Estado de pedido inválido: "${para}".`);
  }
  if (statusConhecido(de) && ehTerminal(de)) {
    throw new HttpError(409, `Pedido ${de} é estado final e não pode ser reaberto. Duplique o pedido se precisar de uma nova venda.`);
  }
  if (statusConhecido(de) && ehFaturado(de)) {
    throw new HttpError(409, `Pedido faturado não pode voltar para "${para}". Para desfazer o faturamento, cancele o pedido (o estoque é estornado).`);
  }
  throw new HttpError(409, `Transição de pedido inválida: "${de}" → "${para}".`);
}

const R_HIST = () => getResource('vendas_status_historico')!;

export interface TransicaoStatusInput {
  empresaId: number;
  vendaId: number;
  anterior: string | null;
  novo: string;
  origem?: OrigemTransicao;
  motivo?: string | null;
  referenciaExterna?: string | null;
  usuarioId?: number | null;
  usuarioNome?: string | null;
  dados?: unknown;
}

/**
 * Grava a prova de UMA transição de estado do pedido.
 *
 * É chamada pelos MESMOS pontos que já mudam `vendas.status` (nunca por um
 * caminho paralelo). Sem mudança de estado não grava nada (idempotente). Não
 * valida aqui — a validação acontece antes da escrita, em `validarTransicao`,
 * para que um estado inválido não chegue a ser gravado.
 */
export async function registrarTransicaoStatus(
  s: Store,
  tx: Tx,
  input: TransicaoStatusInput
): Promise<void> {
  const { empresaId, vendaId, anterior, novo } = input;
  if (!Number.isInteger(empresaId) || !Number.isInteger(vendaId)) return;
  if (anterior !== null && String(anterior) === String(novo)) return;
  const origem: OrigemTransicao = origemValida(input.origem) ? input.origem : 'erp';
  await s.insert(
    R_HIST(),
    {
      empresa_id: empresaId,
      venda_id: vendaId,
      status_anterior: anterior,
      status_novo: novo,
      origem,
      motivo: input.motivo ?? null,
      referencia_externa: input.referenciaExterna ?? null,
      usuario_id: input.usuarioId ?? null,
      usuario_nome: input.usuarioNome ?? null,
      dados: input.dados === undefined ? null : input.dados,
    },
    tx
  );
}

/** Extrai empresa_id e id de uma linha de venda, tolerando colunas ausentes. */
export function identificacaoDaVenda(venda: Row): { empresaId: number; vendaId: number } | null {
  const empresaId = Number(venda.empresa_id);
  const vendaId = Number(venda.id);
  if (!Number.isInteger(empresaId) || !Number.isInteger(vendaId)) return null;
  return { empresaId, vendaId };
}
