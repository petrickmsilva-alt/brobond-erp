/**
 * Sincronização manual de catálogo — "Sincronizar" no painel.
 *
 * Fonte: `modules/marketplace/core/sync.service.ts` do
 * brobond-ai-commerce (PR012). Mantém o contrato de contadores REAIS
 * (importados · duplicados · falhas · rodadas) gravados na linha do
 * conector, agora escopados por `usuarioId`.
 *
 * O conteúdo trazido NÃO vira produto no ERP: o catálogo do ERP é a
 * fonte da verdade e nunca é sobrescrito por marketplace. A
 * sincronização serve para (a) provar que a credencial funciona, (b)
 * alimentar os KPIs do cartão e (c) mostrar ao operador o que o canal
 * está anunciando. A criação de registro só acontece no caminho de
 * PEDIDO (ingestão → `sales`/`sale_items`).
 */

import { connectorRepository, type ConnectorRepository } from './connector.repository';
import { getConnector } from './connector.factory';
import type { NormalizedContent } from './connector.interface';
import { connectorErrorMessage, requiresReauthentication } from './errors';
import type { ConnectorProviderName } from './providers';
import type { ConnectorSyncCounters } from './types';

export interface ConnectorSyncResult {
  provider: ConnectorProviderName;
  ok: boolean;
  counters: ConnectorSyncCounters;
  /** Itens trazidos (projeção enxuta para o painel). */
  items: Array<Pick<NormalizedContent, 'externalId' | 'title' | 'sku' | 'priceCents'>>;
  lastError: string | null;
  requiresReauth: boolean;
}

export interface SyncServiceDependencies {
  repository?: ConnectorRepository;
}

export function createConnectorSyncService(deps: SyncServiceDependencies = {}) {
  const repository = deps.repository ?? connectorRepository;

  return {
    /** Executa UMA rodada de sincronização de catálogo de um provedor. */
    async sync(usuarioId: number, provider: ConnectorProviderName, limit = 50): Promise<ConnectorSyncResult> {
      const connector = getConnector(provider);
      const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
      try {
        const items = await connector.fetchCatalog({ usuarioId, limit: take });
        // Dedupe pelo `externalId`: um provedor que repete item na mesma
        // página conta como duplicado, não como dois importados.
        const seen = new Set<string>();
        let duplicated = 0;
        const unique = items.filter((item) => {
          if (seen.has(item.externalId)) {
            duplicated += 1;
            return false;
          }
          seen.add(item.externalId);
          return true;
        });
        const counters: ConnectorSyncCounters = {
          imported: unique.length,
          duplicated,
          failed: 0,
        };
        await repository.recordSyncResult(usuarioId, provider, {
          status: 'CONNECTED',
          counters,
          lastError: null,
        });
        return {
          provider,
          ok: true,
          counters,
          items: unique.map((item) => ({
            externalId: item.externalId,
            title: item.title,
            sku: item.sku,
            priceCents: item.priceCents,
          })),
          lastError: null,
          requiresReauth: false,
        };
      } catch (error) {
        const message = connectorErrorMessage(error);
        const reauth = requiresReauthentication(error);
        const counters: ConnectorSyncCounters = { imported: 0, duplicated: 0, failed: 1 };
        // Falha de autorização rebaixa para EXPIRED (o painel oferece
        // reconectar); as demais marcam ERROR (o painel oferece repetir).
        await repository.recordSyncResult(usuarioId, provider, {
          status: reauth ? 'EXPIRED' : 'ERROR',
          counters,
          lastError: message,
        });
        return {
          provider,
          ok: false,
          counters,
          items: [],
          lastError: message,
          requiresReauth: reauth,
        };
      }
    },
  };
}

export const connectorSyncService = createConnectorSyncService();
