// ============================================================
// Fase 6 — Backup administrativo.
//
//   GET /api/admin/backup  (admin) → baixa um "pg_dump-like" em SQL com todas
//   as tabelas do sistema (sem os bytes das fotos — colunas dados/thumb).
//
// O Postgres grátis da Neon guarda 24 h de histórico; este download cobre o
// resto. Rode semanalmente no computador do proprietário com o script
// scripts/backup.mjs (documentado em docs/CONFIGURACAO-GRATUITA.md).
// ============================================================
import type { Request, Response } from 'express';
import { HttpError } from './errors';
import { getStore } from './services';
import { currentUser } from './auth';
import { RESOURCES } from './resources';

/** Colunas binárias de fotos que nunca entram no backup. */
const EXCLUIR_COLUNAS = new Set(['dados', 'thumb', 'senha_hash']);

async function colunasDaTabela(tabela: string): Promise<string[]> {
  const { pool } = await import('./db');
  if (!pool) return [];
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position`,
    [tabela]
  );
  return res.rows.map((r: any) => String(r.column_name));
}

export async function adminBackup(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores fazem backup.');
  const s = getStore();
  if (s.kind !== 'postgres') {
    throw new HttpError(409, 'O backup em arquivo só está disponível com o banco Postgres (modo demonstração usa memória).');
  }
  const { pool } = await import('./db');
  if (!pool) throw new HttpError(503, 'Banco indisponível.');

  const tabelas = Array.from(new Set(Object.values(RESOURCES).map((r) => r.table))).sort();
  const linhas: string[] = [];
  linhas.push('-- ============================================');
  linhas.push('-- BROBOND ERP — backup automático');
  linhas.push(`-- Gerado em: ${new Date().toISOString()} por ${actor.name}`);
  linhas.push('-- Aplicar:  psql "$DATABASE_URL" -f este-arquivo');
  linhas.push('-- (fotos ficam fora: use UPLOAD_PROVIDER=cloudinary ou o banco guarda as suas)');
  linhas.push('-- ============================================');
  linhas.push('BEGIN;');

  for (const tabela of tabelas) {
    const colunas = (await colunasDaTabela(tabela)).filter((c) => !EXCLUIR_COLUNAS.has(c));
    if (!colunas.length) continue;
    const resQ = await pool.query(`SELECT ${colunas.map((c) => `"${c}"`).join(', ')} FROM "${tabela}"`);
    if (!resQ.rows.length) continue;
    linhas.push('');
    linhas.push(`-- ${tabela}: ${resQ.rows.length} registro(s)`);
    for (const row of resQ.rows) {
      const valores = colunas.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return 'NULL';
        if (v instanceof Date) return `'${v.toISOString()}'`;
        if (typeof v === 'object' && !Buffer.isBuffer(v)) return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
        const str = String(v);
        if (/^-?\d+(\.\d+)?$/.test(str)) return str;
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return `'${str.replace(/'/g, "''")}'`;
      });
      linhas.push(`INSERT INTO "${tabela}" (${colunas.map((c) => `"${c}"`).join(', ')}) VALUES (${valores.join(', ')});`);
    }
  }
  linhas.push('');
  linhas.push('COMMIT;');
  const data = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="brobond-backup-${data}.sql"`);
  res.end(linhas.join('\n'));
}

/** GET /api/admin/backup/info — resumo para a tela de Configurações. */
export async function backupInfo(_req: Request, res: Response) {
  const s = getStore();
  const { pool } = await import('./db');
  let registros = 0;
  let tabelas = 0;
  if (pool) {
    try {
      for (const tabela of Array.from(new Set(Object.values(RESOURCES).map((r) => r.table)))) {
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM "${tabela}"`);
        registros += Number(r.rows[0]?.n || 0);
        tabelas++;
      }
    } catch {
      registros = -1;
    }
  }
  res.json({ kind: s.kind, registros, tabelas, historicoNeon: 'O plano grátis da Neon guarda 24 h de histórico' });
}
