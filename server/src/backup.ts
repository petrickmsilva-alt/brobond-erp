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

// ----------------------------------------------------------------------------
// GET /api/admin/backup/xlsx — planilha completa (uma aba por tabela).
// Funciona também em modo demonstração (usa o store, não o SQL direto).
// ----------------------------------------------------------------------------
const PLANILHA_ORDENADA = [
  'produtos',
  'categorias',
  'cores',
  'tamanhos',
  'colecoes',
  'insumos',
  'fornecedores',
  'representantes',
  'clientes',
  'locais',
  'estoques',
  'estoque_insumos',
  'movimentacoes',
  'movimentacoes_insumos',
  'inventarios',
  'itens_inventario',
  'ordens',
  'itens_ordem',
  'fichas',
  'itens_ficha_tecnica',
  'compras',
  'itens_compra',
  'vendas',
  'itens_venda',
  'catalogos',
  'lancamentos_financeiros',
  'categorias_financeiras',
  'contas_financeiras',
  'investidores',
  'aportes',
  'recorrencias_financeiras',
  'usuarios',
  'auditoria',
];

export async function adminBackupXlsx(req: Request, res: Response) {
  const actor = currentUser(req);
  if (actor.perfil !== 'admin') throw new HttpError(403, 'Somente administradores fazem backup.');
  const ExcelJS = (await import('exceljs')).default;
  const s = getStore();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BROBOND ERP';
  wb.created = new Date();

  const chaves = Object.keys(RESOURCES).sort((a, b) => {
    const ia = PLANILHA_ORDENADA.indexOf(a);
    const ib = PLANILHA_ORDENADA.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  let linhasTotais = 0;
  for (const key of chaves) {
    const r = RESOURCES[key as keyof typeof RESOURCES];
    // tabelas auxiliares (sub-recursos) entram sem os campos virtuais/secretos
    const colunas = r.fields.filter((f) => !f.virtual && f.type !== 'images' && f.type !== 'password');
    const resultado = await s.list(r, { page: 1, pageSize: 10000 });
    if (!resultado.rows.length) continue;
    const ws = wb.addWorksheet(r.table.slice(0, 28));
    const cabecalho = ['id', ...colunas.map((c) => c.name)];
    ws.columns = cabecalho.map((c) => {
      const f = colunas.find((x) => x.name === c);
      return { header: c === 'id' ? 'id' : `${c}${f?.label && f.label !== c ? ` (${f.label})` : ''}`, key: c, width: Math.max(12, Math.min(36, c.length + 6)) };
    });
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } };
    for (const row of resultado.rows) {
      const vals: Record<string, unknown> = {};
      for (const c of cabecalho) {
        const v = row[c];
        vals[c] = v === null || v === undefined ? undefined : typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
      }
      ws.addRow(vals);
      linhasTotais++;
    }
  }

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const data = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="brobond-completo-${data}.xlsx"`);
  res.end(buf);
}
