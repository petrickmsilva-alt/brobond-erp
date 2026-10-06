/**
 * Superfície pública do módulo de conectores.
 *
 * O servidor Express do ERP consome EXCLUSIVAMENTE o que sai daqui:
 * nenhuma rota importa arquivo interno do módulo. Isso mantém o módulo
 * livre de framework (nada de `express` dentro de `modules/`) e permite
 * reaproveitá-lo em um worker ou numa CLI sem arrastar o servidor junto.
 */

export * from './core/providers';
export * from './core/errors';
export * from './core/types';
export * from './core/crypto.service';
export * from './core/database';
export * from './core/audit';
export * from './core/app-url';
export * from './core/connector.interface';
export * from './core/connector.repository';
export * from './core/oauth-state.service';
export * from './core/connector.service';
export * from './core/connector.factory';
export * from './core/sync.service';
export * from './core/panel.service';
export * from './core/sale-events';
export * from './instagram/index';
export * from './ingestion/catalog-matcher';
export * from './ingestion/sales.service';
export * from './ingestion/sale-ingestion.service';
export * from './webhooks/handlers';
