// ============================================================================
// MOTOR DE FRETE › CONTRATO DE TRANSPORTADORA
//
// `CarrierAdapter` é o contrato que o núcleo conhece. Adicionar uma
// transportadora é registrar um objeto que o implementa — sem migration, sem
// alterar nenhum outro módulo. O `slug` é a identidade estável (gravada em
// `envios.provider` e em `logistics_webhook_inbox.provider`).
//
// Três regras que todo adaptador DEVE respeitar:
//   1. SEM CREDENCIAL, a operação devolve `nao_configurado` — nunca um valor
//      inventado e nunca "postado" sem prova;
//   2. uma resposta sem código E sem referência NÃO vira remessa: é `recusado`;
//   3. o adaptador declara suas CAPACIDADES — o painel mostra o que existe de
//      verdade e o que depende de homologação.
// ============================================================================
import type { EnderecoFrete, VolumeFrete } from '../domain/contract';

export type MotivoFalha = 'nao_configurado' | 'falha' | 'recusado';

export type ResultadoProvedor<T> =
  | { ok: true; data: T }
  | { ok: false; motivo: MotivoFalha; mensagem: string };

/** Como o operador é configurado. Documenta o que falta para homologar. */
export type RequisitoCredencial = {
  chave: string;
  label: string;
  obrigatoria: boolean;
};

export type CapacidadesProvedor = {
  cotacao: boolean;
  remessa: boolean;
  etiqueta: boolean;
  rastreio: boolean;
  cancelamento: boolean;
  webhook: boolean;
};

export type DisponibilidadeProvedor = {
  /** tem credencial/configuração suficiente para operar */
  configurado: boolean;
  /** ligado pela empresa/ambiente (pode estar configurado mas desligado) */
  habilitado: boolean;
  motivo: string | null;
};

export type ContextoOperacao = {
  empresaId: number;
  origem: EnderecoFrete;
  destino: EnderecoFrete;
  volumes: VolumeFrete[];
  pesoTotalG: number;
  valorDeclarado: number;
  /** serviço escolhido (código no provedor) — para remessa/etiqueta */
  servico?: string;
  /** referência do pedido no ERP, para correlação/idempotência no provedor */
  referenciaPedido?: string;
};

export type CotacaoBruta = {
  servico: string;
  nome: string;
  codigo: string;
  valor: number;
  prazo_dias: number;
  empresa?: string;
  aviso?: string;
  /** referência da resposta externa (id da cotação no provedor), quando houver */
  referencia?: string;
};

export type RemessaCriada = {
  provider_ref: string | null;
  codigo_rastreamento: string | null;
  etiqueta_url: string | null;
  custo: number;
  servico: string;
  mensagem?: string;
};

export type EtiquetaGerada = {
  provider_ref: string | null;
  url_externa: string | null;
  mime: string;
  /** conteúdo em base64 quando o provedor devolve o arquivo inline */
  conteudo_base64?: string;
  mensagem?: string;
};

export type EventoRastreioBruto = {
  codigo: string;
  status: string;
  mensagem: string;
  local?: string | null;
  em?: string | null;
  /** payload cru do evento, preservado para auditoria */
  bruto?: unknown;
};

export interface CarrierAdapter {
  readonly slug: string;
  readonly nome: string;
  readonly capacidades: CapacidadesProvedor;
  /** Credenciais que o operador exige (alimenta o painel e a homologação). */
  readonly credenciais: RequisitoCredencial[];
  /** URL oficial do serviço, quando pública e documentada. */
  readonly docUrl?: string;
  disponivel(empresaId: number): Promise<DisponibilidadeProvedor>;
  cotar(ctx: ContextoOperacao): Promise<ResultadoProvedor<CotacaoBruta[]>>;
  criarRemessa?(ctx: ContextoOperacao): Promise<ResultadoProvedor<RemessaCriada>>;
  gerarEtiqueta?(empresaId: number, providerRef: string): Promise<ResultadoProvedor<EtiquetaGerada>>;
  rastrear(empresaId: number, codigo: string): Promise<ResultadoProvedor<EventoRastreioBruto[]>>;
  cancelar?(empresaId: number, providerRef: string): Promise<ResultadoProvedor<{ mensagem: string }>>;
  /** Health check: a credencial existe e o serviço responde? (sem efeito colateral) */
  healthCheck?(empresaId: number): Promise<DisponibilidadeProvedor>;
}

// ----------------------------------------------------------------------------
// REGISTRO
// ----------------------------------------------------------------------------
const REGISTRO = new Map<string, CarrierAdapter>();

export function registrarCarrier(adapter: CarrierAdapter): void {
  if (!adapter?.slug) throw new Error('CarrierAdapter precisa de slug.');
  REGISTRO.set(adapter.slug.toLowerCase(), adapter);
}

export function carrier(slug: string | null | undefined): CarrierAdapter | null {
  return REGISTRO.get(String(slug || '').toLowerCase()) || null;
}

export function carriers(): CarrierAdapter[] {
  return [...REGISTRO.values()];
}

export function limparRegistro(): void {
  REGISTRO.clear();
}

/** Adaptador NULO: nada configurado. Não finge nada. */
export const CARRIER_NULO: CarrierAdapter = {
  slug: 'nenhum',
  nome: 'Nenhuma transportadora',
  capacidades: { cotacao: false, remessa: false, etiqueta: false, rastreio: false, cancelamento: false, webhook: false },
  credenciais: [],
  disponivel: async () => ({ configurado: false, habilitado: false, motivo: 'Nenhuma transportadora configurada.' }),
  cotar: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada.' }),
  rastrear: async () => ({ ok: false, motivo: 'nao_configurado', mensagem: 'Nenhuma transportadora configurada para rastrear.' }),
};
