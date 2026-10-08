// ============================================================================
// HUB DE E-COMMERCE — CONTRATO COMUM DOS CANAIS (Fase P3, §2/§3/§4/§5)
//
// O ERP não tem "if Mercado Livre / if Nuvemshop / if WooCommerce" espalhado
// pelo código: cada canal implementa ESTE contrato e o resto do sistema fala
// só com ele. O que muda de canal para canal (URL, autenticação, formato do
// pedido, assinatura de webhook) mora no adaptador; o que o ERP faz com o
// pedido é uma coisa só — `hub.ts`.
//
// O contrato é explícito sobre LIMITES: capacidades, credencial exigida e
// erros transitórios × definitivos. Canal sem suporte a uma operação diz
// `false` em vez de fingir que funciona.
// ============================================================================

export const CANAIS_COMERCIO = ['MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE'] as const;
export type CanalComercio = (typeof CANAIS_COMERCIO)[number];

export function isCanalComercio(valor: unknown): valor is CanalComercio {
  return typeof valor === 'string' && (CANAIS_COMERCIO as readonly string[]).includes(valor);
}

/** O que o canal sabe fazer, declarado honestamente por adaptador. */
export type CapacidadesCanal = {
  /** Lista pedidos pela API do canal (polling controlado). */
  pedidos: boolean;
  /** Lista o catálogo publicado no canal. */
  produtos: boolean;
  /** Recebe atualização de saldo do ERP. */
  estoque: boolean;
  /** Recebe atualização de preço do ERP. */
  preco: boolean;
  /** Como o rastreio circula: o ERP envia, o canal informa por webhook, ou não há. */
  rastreio: 'envia' | 'recebe' | 'ausente';
  /** O canal entrega eventos por webhook (preferido sobre polling). */
  webhook: boolean;
  /** Precisa de polling para cobrir o que o webhook não manda. */
  polling: boolean;
};

/** Credencial resolvida no momento da chamada (nunca logada, nunca gravada aqui). */
export type CredencialCanal = {
  token?: string | null;
  lojaId?: string | null;
  baseUrl?: string | null;
  clientSecret?: string | null;
};

export type ContextoChamada = {
  credencial?: CredencialCanal | null;
  /** Injetável nos testes — em produção é o `fetch` global. */
  fetchImpl?: typeof fetch;
  /** Relógio injetável (testes determinísticos). */
  agora?: Date;
  /** Identificador de correlação que viaja com a chamada (§15). */
  requestId?: string;
};

export type ItemPedidoExterno = {
  /** SKU como o canal publica; `null` quando o canal não informa. */
  sku: string | null;
  /** Id do anúncio/variante no canal (para rastrear mapeamento). */
  externalItemId: string | null;
  titulo: string;
  quantidade: number;
  precoUnitario: number;
  desconto: number;
};

export type RastreioExterno = {
  codigo: string;
  transportadora?: string | null;
  url?: string | null;
};

export type ClienteExterno = {
  nome: string;
  email?: string | null;
  telefone?: string | null;
  documento?: string | null;
};

export type PedidoExterno = {
  externalId: string;
  numero: string;
  status: string;
  criadoEm: string;
  atualizadoEm: string | null;
  moeda: string;
  frete: number;
  desconto: number;
  cliente: ClienteExterno;
  itens: ItemPedidoExterno[];
  rastreio?: RastreioExterno | null;
  /** Payload original do canal — guardado para auditoria/conferência. */
  bruto?: unknown;
};

export type ProdutoExterno = {
  externalId: string;
  sku: string | null;
  nome: string;
  preco: number | null;
  estoque: number | null;
  ativo: boolean;
};

export type EventoWebhook = {
  /** Id do evento no canal — base da deduplicação por (empresa, canal, id). */
  externalId: string;
  tipo: string;
  pedidoExternoId?: string | null;
  recebidoEm: string;
  payload: unknown;
};

/** Item que o ERP publica no canal: SKU interno + id externo quando mapeado. */
export type ItemPublicacaoEstoque = { sku: string; quantidade: number; externoId?: string | null };
export type ItemPublicacaoPreco = { sku: string; preco: number; externoId?: string | null };

export type ResultadoEstoque = {
  atualizados: { sku: string; externalId: string }[];
  /** Sem mapeamento não se adivinha: o operador cadastra e roda de novo. */
  semMapeamento: string[];
  falhas: { sku: string; mensagem: string; transitorio: boolean }[];
};

export type ResultadoPreco = ResultadoEstoque;

// ---------------------------------------------------------------------------
// Erros: transitório × definitivo e backoff controlado (§16)
// ---------------------------------------------------------------------------

export type ClassificacaoErro = 'transitorio' | 'definitivo';

/**
 * 408/425/429 e 5xx são transitórios (vale retentar com backoff); 4xx de
 * validação/autenticação é definitivo (retentar só repete o erro).
 */
export function classificarStatusHttp(status: number): ClassificacaoErro {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transitorio';
  return 'definitivo';
}

/** Tentativas máximas antes de o canal ser dado como pendente de gente. */
export const MAX_TENTATIVAS = 6;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_TETO_MS = 6 * 60 * 60 * 1000;

/**
 * Quando tentar de novo (ISO) — ou `null` quando não vale mais automático.
 * Backoff exponencial com teto, tentativa 1 = 1 min.
 */
export function proximaTentativaEm(tentativa: number, agora: Date = new Date()): string | null {
  if (!Number.isFinite(tentativa) || tentativa < 1) return null;
  if (tentativa >= MAX_TENTATIVAS) return null;
  const espera = Math.min(BACKOFF_TETO_MS, BACKOFF_BASE_MS * 2 ** (tentativa - 1));
  return new Date(agora.getTime() + espera).toISOString();
}

export class ErroCanalError extends Error {
  readonly canal: CanalComercio;
  readonly operacao: string;
  readonly status: number | null;
  readonly classificacao: ClassificacaoErro;
  readonly requiresReauth: boolean;
  readonly requestId?: string;

  constructor(
    canal: CanalComercio,
    operacao: string,
    mensagem: string,
    opts: { status?: number | null; classificacao?: ClassificacaoErro; requiresReauth?: boolean; requestId?: string; cause?: unknown } = {}
  ) {
    super(mensagem, { cause: opts.cause });
    this.name = 'ErroCanalError';
    this.canal = canal;
    this.operacao = operacao;
    this.status = opts.status ?? null;
    this.classificacao = opts.classificacao ?? (opts.status ? classificarStatusHttp(opts.status) : 'transitorio');
    this.requiresReauth = opts.requiresReauth === true;
    this.requestId = opts.requestId;
  }

  get transitorio(): boolean {
    return this.classificacao === 'transitorio' && !this.requiresReauth;
  }
}

/** O canal não está configurado/conectado: é definitivo até alguém conectar. */
export class CredencialAusenteError extends ErroCanalError {
  constructor(canal: CanalComercio, operacao: string, detalhe = 'conecte o canal nas Integrações') {
    super(canal, operacao, `Canal ${canal} sem credencial válida: ${detalhe}.`, {
      classificacao: 'definitivo',
      requiresReauth: true,
      status: 409,
    });
    this.name = 'CredencialAusenteError';
  }
}

/** Operação que o canal não oferece — nunca silenciosa, nunca fingida. */
export class OperacaoNaoSuportadaError extends ErroCanalError {
  constructor(canal: CanalComercio, operacao: string) {
    super(canal, operacao, `O canal ${canal} não suporta "${operacao}" nesta integração.`, { classificacao: 'definitivo', status: 501 });
    this.name = 'OperacaoNaoSuportadaError';
  }
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

export interface CommerceProvider {
  readonly canal: CanalComercio;
  readonly rotulo: string;
  readonly capacidades: CapacidadesCanal;
  /** `true` quando as chamadas precisam de credencial (token/conexão). */
  readonly requerCredencial: boolean;

  /** Diz se dá para usar AGORA (config presente), sem chamar a rede. */
  configurado(ctx?: ContextoChamada): { ok: boolean; motivo?: string };

  /** Teste de conexão real; NUNCA lança — devolve o motivo. */
  testar(ctx?: ContextoChamada): Promise<{ ok: boolean; externoId?: string | null; mensagem?: string }>;

  listarPedidos(ctx: ContextoChamada & { desde: Date; limite: number }): Promise<PedidoExterno[]>;
  listarProdutos(ctx: ContextoChamada & { limite: number }): Promise<ProdutoExterno[]>;

  /** Publica saldo por SKU; devolve o que foi, o que não tem mapeamento e o que falhou. */
  publicarEstoque(itens: ItemPublicacaoEstoque[], ctx: ContextoChamada): Promise<ResultadoEstoque>;

  /** Publica preço por SKU. Canal sem suporte devolve `OperacaoNaoSuportadaError`. */
  publicarPreco(itens: ItemPublicacaoPreco[], ctx: ContextoChamada): Promise<ResultadoPreco>;

  /** Assinatura do webhook é válida? (Sem webhook, o adaptador não implementa.) */
  validarWebhook?(corpoBruto: string, headers: Record<string, string | undefined>, ctx?: ContextoChamada): boolean;

  /** Normaliza o webhook no formato do hub (a validação já rodou). */
  lerWebhook(corpoBruto: string, headers: Record<string, string | undefined>, ctx?: ContextoChamada): EventoWebhook[];
}

// ---------------------------------------------------------------------------
// Helpers de HTTP compartilhados pelos adaptadores
// ---------------------------------------------------------------------------

export async function httpJson(
  canal: CanalComercio,
  operacao: string,
  url: string,
  init: Parameters<typeof fetch>[1],
  ctx: ContextoChamada
): Promise<any> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await fetchImpl(url, init);
  } catch (e: any) {
    // Falha de rede/timeout é TRANSITÓRIA: retenta com backoff.
    throw new ErroCanalError(canal, operacao, `Falha de rede ao falar com ${canal}: ${e?.message || e}`, {
      classificacao: 'transitorio',
      requestId: ctx.requestId,
      cause: e,
    });
  }
  const texto = await resp.text();
  if (!resp.ok) {
    const detalhe = texto.replace(/\s+/g, ' ').slice(0, 200);
    throw new ErroCanalError(canal, operacao, `${canal} respondeu ${resp.status}: ${detalhe || '(sem corpo)'}`, {
      status: resp.status,
      requiresReauth: resp.status === 401 || resp.status === 403,
      requestId: ctx.requestId,
    });
  }
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroCanalError(canal, operacao, `${canal} respondeu um corpo que não é JSON.`, { classificacao: 'definitivo' });
  }
}

/** Número tolerante a string/undefined — o formato muda de canal para canal. */
export function numero(valor: unknown, padrao = 0): number {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string') {
    const limpo = valor.trim().replace(/\s/g, '');
    const n = limpo.includes(',') ? Number(limpo.replace(/\./g, '').replace(',', '.')) : Number(limpo);
    if (Number.isFinite(n)) return n;
  }
  return padrao;
}
