/**
 * Porta de banco do módulo de conectores.
 *
 * O ERP não carrega o cliente Prisma em runtime: o servidor já mantém um
 * pool `pg` (server/src/db.ts) e TODO o resto da aplicação fala SQL por
 * ele. O módulo de conectores usa o MESMO pool através desta porta
 * mínima — uma única função `query`. Assim:
 *
 *   • não existe segunda conexão, segundo pool nem segundo ciclo de vida;
 *   • o módulo continua testável (basta injetar um executor falso);
 *   • o módulo não importa nada de `server/src` (dependência em uma via).
 *
 * O contrato é o do `pg.Pool.query`, propositalmente, para que a ligação
 * em `server/src/connectors.ts` seja uma linha.
 */

import { ConnectorDatabaseUnavailableError } from './errors';

export interface SqlQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface ConnectorDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<SqlQueryResult<T>>;
  /**
   * Executa `fn` dentro de uma transação, quando o executor suportar. A
   * ingestão de pedidos usa isto para que venda e itens entrem juntos —
   * nunca uma venda sem os itens dela. Opcional de propósito: um executor
   * de teste pode omitir e o chamador cai no modo sem transação.
   */
  transaction?<T>(fn: (db: ConnectorDatabase) => Promise<T>): Promise<T>;
}

/**
 * Roda `fn` em transação quando o executor suporta; caso contrário, roda
 * direto. O chamador escreve um caminho só.
 */
export async function runInTransaction<T>(db: ConnectorDatabase, fn: (db: ConnectorDatabase) => Promise<T>): Promise<T> {
  if (typeof db.transaction === 'function') return db.transaction(fn);
  return fn(db);
}

let current: ConnectorDatabase | null = null;

/**
 * Liga o módulo ao pool do ERP. Chamado uma única vez no boot do servidor
 * (`server/src/connectors.ts`). Passar `null` desliga o módulo — é o que
 * acontece no MODO DEMONSTRAÇÃO (sem DATABASE_URL).
 */
export function setConnectorDatabase(database: ConnectorDatabase | null): void {
  current = database;
}

/** `true` quando há banco ligado (os endpoints podem operar). */
export function hasConnectorDatabase(): boolean {
  return current !== null;
}

/**
 * Banco ligado, ou 503 com mensagem de operador. Nenhuma credencial é
 * gravada em memória volátil: conector sem Postgres simplesmente não opera.
 */
export function getConnectorDatabase(): ConnectorDatabase {
  if (!current) throw new ConnectorDatabaseUnavailableError();
  return current;
}
