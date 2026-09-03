import { Pool } from 'pg';

// Se DATABASE_URL não existir (ex.: dev local sem Postgres), o pool fica nulo
// e a API responde com dados mock — assim o front funciona mesmo sem banco.
export const pool =
  process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : undefined,
      })
    : null;

export function isDbConnected(): boolean {
  return !!pool;
}

export async function query(text: string, params?: any[]) {
  if (!pool) throw new Error('NO_DB');
  return pool.query(text, params);
}
