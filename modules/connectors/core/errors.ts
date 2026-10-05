/**
 * Erros de domínio dos conectores multicanal.
 *
 * Fonte: `modules/marketplace/core/errors.ts` do brobond-ai-commerce
 * (PR012). Classes dedicadas (nunca `Error` cru) para que as rotas do
 * Express mapeiem status HTTP precisos sem comparar strings — e para que
 * nenhum payload de provedor vaze para o navegador.
 */

import type { ConnectorProviderName } from './providers';

export interface ConnectorErrorOptions {
  /**
   * `true` quando o ÚNICO conserto é mandar o operador de volta ao fluxo
   * OAuth do provedor (sem token, token revogado/expirado, credencial
   * indecifrável após troca de chave). O painel transforma esta marca no
   * botão "Conectar Conta do …" em vez de uma mensagem sem saída.
   */
  requiresReauth?: boolean;
  /** Causa original, preservada para o log do servidor — nunca para a UI. */
  cause?: unknown;
}

/** Classe base de toda falha de integração multicanal. */
export class ConnectorError extends Error {
  readonly provider?: ConnectorProviderName;
  readonly requiresReauth: boolean;
  /** Status HTTP sugerido para a resposta da API do ERP. */
  readonly httpStatus: number = 502;

  constructor(message: string, provider?: ConnectorProviderName, options: ConnectorErrorOptions = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.provider = provider;
    this.requiresReauth = options.requiresReauth ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** O provedor pedido não tem adaptador registrado no mapeador central. */
export class ConnectorNotRegisteredError extends ConnectorError {
  override readonly httpStatus = 404;

  constructor(provider: string) {
    super(`Nenhum conector está registrado para o provedor "${provider}".`);
    this.name = 'ConnectorNotRegisteredError';
  }
}

/** O responsável não tem credencial CONNECTED para o provedor pedido. */
export class ConnectorNotConnectedError extends ConnectorError {
  override readonly httpStatus = 409;

  constructor(provider: ConnectorProviderName) {
    super(`O conector "${provider}" não está conectado. Conecte a conta antes de sincronizar.`, provider, { requiresReauth: true });
    this.name = 'ConnectorNotConnectedError';
  }
}

/**
 * O provedor recusou a credencial guardada (401/403, grant revogado,
 * refresh falho, cifra que não abre mais depois de uma troca de
 * CONNECTOR_ENCRYPTION_KEY). Repetir não muda nada: o operador precisa
 * autorizar a conta de novo.
 */
export class ConnectorReauthRequiredError extends ConnectorError {
  override readonly httpStatus = 409;

  constructor(provider: ConnectorProviderName, message: string, options: ConnectorErrorOptions = {}) {
    super(message, provider, { ...options, requiresReauth: true });
    this.name = 'ConnectorReauthRequiredError';
  }
}

/**
 * A cifra AES-256-GCM guardada não abre mais — a credencial foi gravada
 * ANTES de uma troca da `CONNECTOR_ENCRYPTION_KEY` (ou está corrompida),
 * e a tag de autenticação nunca mais vai bater.
 *
 * Especialização de `ConnectorReauthRequiredError` para que o canal possa
 * ser estacionado no status dedicado `REAUTH_REQUIRED` em vez do genérico
 * EXPIRED/ERROR. Reconectar é o ÚNICO conserto: a credencial nova é
 * re-cifrada com a chave atual.
 */
export class ConnectorTokenUndecryptableError extends ConnectorReauthRequiredError {
  constructor(provider: ConnectorProviderName, message: string, options: ConnectorErrorOptions = {}) {
    super(provider, message, options);
    this.name = 'ConnectorTokenUndecryptableError';
  }
}

/** Falta uma variável de ambiente obrigatória de um provedor. */
export class ConnectorConfigError extends ConnectorError {
  override readonly httpStatus = 409;
  readonly variable: string;

  constructor(variable: string, provider?: ConnectorProviderName) {
    super(`A variável de ambiente ${variable} é obrigatória para este conector.`, provider);
    this.name = 'ConnectorConfigError';
    this.variable = variable;
  }
}

/** Uma chamada à API do provedor falhou (rede, auth, rate limit ou 5xx). */
export class ProviderApiError extends ConnectorError {
  readonly status: number;
  override readonly httpStatus: number;

  constructor(message: string, status: number, provider?: ConnectorProviderName, options: ConnectorErrorOptions = {}) {
    super(message, provider, options);
    this.name = 'ProviderApiError';
    this.status = status;
    // Falha do provedor nunca vira 5xx do ERP sem necessidade: 502 é o
    // contrato (gateway ruim), 503 quando foi a rede.
    this.httpStatus = status === 503 ? 503 : 502;
  }
}

/** Um webhook chegou com assinatura inválida ou não verificável. */
export class WebhookSignatureError extends ConnectorError {
  override readonly httpStatus = 401;

  constructor(provider: ConnectorProviderName) {
    super(`Assinatura de webhook inválida para "${provider}".`, provider);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * O módulo de conectores exige Postgres (credenciais cifradas, eventos e
 * vendas são dados duráveis). No MODO DEMONSTRAÇÃO do ERP (sem
 * DATABASE_URL) os endpoints respondem 503 com esta mensagem em vez de
 * quebrar — mesma política de `marketplace.ts`/`loja.ts`.
 */
export class ConnectorDatabaseUnavailableError extends ConnectorError {
  override readonly httpStatus = 503;

  constructor() {
    super(
      'Os conectores multicanal exigem banco de dados. Configure DATABASE_URL — no modo demonstração as credenciais não podem ser guardadas com segurança.'
    );
    this.name = 'ConnectorDatabaseUnavailableError';
  }
}

/**
 * Esta falha significa "autorize a conta de novo"?
 *
 * Predicado único compartilhado pelo serviço de sincronização (que rebaixa
 * o conector para EXPIRED em vez de ERROR), pelas rotas (que repassam a
 * marca ao navegador) e pelo worker de ingestão. Aceita `unknown` para que
 * blocos `catch` chamem direto.
 */
export function requiresReauthentication(error: unknown): boolean {
  if (error instanceof ConnectorError) return error.requiresReauth;
  return typeof error === 'object' && error !== null && (error as { requiresReauth?: unknown }).requiresReauth === true;
}

/** Mensagem segura de um erro desconhecido (nunca vaza objeto do provedor). */
export function connectorErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Falha inesperada no conector.';
}
