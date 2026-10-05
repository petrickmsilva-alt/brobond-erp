/**
 * Gancho de auditoria do módulo de conectores.
 *
 * No commerce as conexões eram registradas em `prisma.auditLog`. O ERP já
 * tem a própria trilha encadeada (`server/src/auditChain.ts`), e o módulo
 * não deve conhecê-la: o servidor injeta a função no boot
 * (`server/src/connectors.ts`) e o módulo só a chama.
 *
 * A auditoria NUNCA derruba uma operação: falha nela é registrada no log
 * e a conexão/ingestão segue — o contrário transformaria um problema de
 * observabilidade em perda de credencial.
 */

import type { ConnectorProviderName } from './providers';

export interface ConnectorAuditEntry {
  /** Ex.: `MERCADOLIVRE_CONNECTED`, `SHOPEE_DISCONNECTED`. */
  action: string;
  usuarioId: number;
  provider: ConnectorProviderName;
  /** Id da linha de `connectors` afetada, quando houver. */
  connectorId?: string | null;
  /** Metadados NÃO SECRETOS (ids públicos, contadores). */
  metadata?: Record<string, unknown>;
}

export type ConnectorAuditLogger = (entry: ConnectorAuditEntry) => void | Promise<void>;

let logger: ConnectorAuditLogger | null = null;

export function setConnectorAuditLogger(fn: ConnectorAuditLogger | null): void {
  logger = fn;
}

/** Registra uma entrada de auditoria — "best effort", nunca lança. */
export async function auditConnector(entry: ConnectorAuditEntry): Promise<void> {
  if (!logger) return;
  try {
    await logger(entry);
  } catch (error) {
    console.warn('⚠️  Auditoria de conector indisponível:', error instanceof Error ? error.message : error);
  }
}
