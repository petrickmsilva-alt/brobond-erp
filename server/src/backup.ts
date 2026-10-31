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
import { PAYMENT_RESOURCES } from '../../modules/payments/infrastructure/resources';

/** Colunas binárias/secretas que nunca entram no backup (fotos e segredos). */
const EXCLUIR_COLUNAS = new Set(['dados', 'thumb', 'senha_hash', 'mfa_secret', 'convite_token_hash', 'reset_token_hash']);

async function colunasDaTabela(pool: any, tabela: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position`,
    [tabela]
  );
  return res.rows.map((r: any) => String(r.column_name));
}

/**
 * Gera o SQL de backup (o mesmo conteúdo servido por GET /api/admin/backup).
 * Extraído do handler para que o script de recuperação (`scripts/recovery-check.mjs`)
 * prove que o arquivo gerado RESTAURA — backup que nunca foi restaurado é fé, não
 * evidência.
 */
export async function gerarBackupSql(usuario: string): Promise<string> {
  const { pool } = await import('./db');
  if (!pool) throw new HttpError(503, 'Banco indisponível.');
  const tabelas = Array.from(new Set([...Object.values(RESOURCES), ...PAYMENT_RESOURCES].map((r) => r.table))).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sql = await montarBackupSql(client, tabelas, usuario);
    await client.query('COMMIT');
    return sql;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

  const sql = await gerarBackupSql(actor.name);
  const data = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="brobond-backup-${data}.sql"`);
  res.end(sql);
}

/**
 * Monta o SQL de backup/restauração. O arquivo é AUTO-CONTIDO: além dos
 * INSERTs, traz um TRUNCATE atômico e restaura dependências em duas fases, de
 * modo que aplicá-lo num banco já migrado (mas vazio) restaura o estado sem
 * violar FK — e reaplicá-lo é idempotente (recomeça do zero). As colunas
 * secretas (`senha_hash`, `mfa_secret`, tokens) ficam FORA, por política.
 */
/** Resolve ciclos de FK anuláveis em duas fases, sem desabilitar constraints. */
async function planoDeRestauracao(pool: any, tabelas: string[]) {
  const alvo = new Set(tabelas);
  const { rows } = await pool.query(`
    SELECT c.conrelid::regclass::text AS filha, c.confrelid::regclass::text AS mae,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                 WHERE NOT a.attnotnull) AS anulaveis
      FROM pg_constraint c WHERE c.contype = 'f'`);
  const arestas = rows.map((r: any) => ({
    filha: String(r.filha).replace(/^public\./, '').replace(/"/g, ''),
    mae: String(r.mae).replace(/^public\./, '').replace(/"/g, ''),
    anulaveis: r.anulaveis as string[],
  })).filter((e: any) => alvo.has(e.filha) && alvo.has(e.mae));
  const caminho = (de: string, ate: string, vistos = new Set<string>()): boolean => {
    if (de === ate) return true;
    if (vistos.has(de)) return false;
    vistos.add(de);
    return arestas.some((e: any) => e.filha === de && caminho(e.mae, ate, vistos));
  };
  const diferidas = new Map<string, Set<string>>();
  const imediatas = arestas.filter((e: any) => {
    if (e.anulaveis.length && caminho(e.mae, e.filha)) {
      const cols = diferidas.get(e.filha) || new Set<string>();
      for (const c of e.anulaveis) cols.add(c);
      diferidas.set(e.filha, cols);
      return false;
    }
    return true;
  });
  const visitado = new Set<string>();
  const ativos = new Set<string>();
  const ordem: string[] = [];
  const visitar = (t: string) => {
    if (ativos.has(t)) throw new HttpError(409, 'Backup: ciclo de FK não anulável exige estratégia de restauração específica.');
    if (visitado.has(t)) return;
    ativos.add(t);
    for (const e of imediatas.filter((e: any) => e.filha === t && e.mae !== t)) visitar(e.mae);
    ativos.delete(t);
    visitado.add(t);
    ordem.push(t);
  };
  for (const t of [...tabelas].sort()) visitar(t);
  return { ordem, diferidas };
}

function literalSql(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const str = typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : String(v);
  return `'${str.replace(/'/g, "''")}'`;
}

export async function montarBackupSql(pool: any, tabelas: string[], usuario: string): Promise<string> {
  // Recursos não enumeram todos os pais operacionais (ex.: gateway_cobrancas).
  // Incluir o fechamento de FKs evita backups órfãos sem criar outro ledger.
  const { rows: fks } = await pool.query(`SELECT child.relname AS filha, parent.relname AS mae
    FROM pg_constraint fk JOIN pg_class child ON child.oid = fk.conrelid
    JOIN pg_class parent ON parent.oid = fk.confrelid
    JOIN pg_namespace ns ON ns.oid = parent.relnamespace
    WHERE fk.contype = 'f' AND ns.nspname = current_schema()`);
  const completas = new Set(tabelas);
  let anterior = -1;
  while (anterior !== completas.size) {
    anterior = completas.size;
    for (const fk of fks) if (completas.has(fk.filha)) completas.add(fk.mae);
  }
  tabelas = [...completas].sort();
  const linhas: string[] = [];
  linhas.push('-- ============================================');
  linhas.push('-- BROBOND ERP — backup automático');
  linhas.push(`-- Gerado em: ${new Date().toISOString()} por ${usuario.replace(/[\r\n]/g, ' ')}`);
  linhas.push('-- Aplicar num banco já migrado:  psql "$DATABASE_URL" -f este-arquivo');
  linhas.push('-- O arquivo TRUNCA e reinsere (restauração idempotente).');
  linhas.push('-- (fotos ficam fora: use UPLOAD_PROVIDER=cloudinary ou o banco guarda as suas)');
  linhas.push('-- ============================================');
  linhas.push('BEGIN;');
  linhas.push('SET LOCAL standard_conforming_strings = on;');

  // Inclui tabelas vazias para também remover resíduos do destino no restore.
  const conteudo: { tabela: string; colunas: string[]; rows: any[] }[] = [];
  for (const tabela of tabelas) {
    const colunas = (await colunasDaTabela(pool, tabela)).filter((c) => !EXCLUIR_COLUNAS.has(c) && (c === 'token' || c.endsWith('token_hash') || !/(?:senha|password|secret|token|credencia|cifrad|mfa_backup)/i.test(c)));
    if (!colunas.length) continue;
    const resQ = await pool.query(`SELECT ${colunas.map((c) => `"${c}"`).join(', ')} FROM "${tabela}"`);
    conteudo.push({ tabela, colunas, rows: resQ.rows });
  }
  // Ordena as tabelas de acordo com as FKs REAIS (mães antes das filhas), para
  // que a reinserção não esbarre em constraint. A ordem alfabética não serve:
  // `crm_funis` < `empresas`, mas a filha não pode vir antes da mãe.
  const { ordem, diferidas } = await planoDeRestauracao(pool, conteudo.map((c) => c.tabela));
  const conteudoOrdenado = ordem.map((t) => conteudo.find((c) => c.tabela === t)!).filter(Boolean);

  // Limpa com TRUNCATE ... CASCADE: uma única instrução que resolve a teia de
  // FKs sem depender de ordem, e é idempotente na reaplicação.
  linhas.push('');
  linhas.push('-- Limpeza: restauração idempotente (reaplicar não duplica).');
  if (conteudoOrdenado.length) linhas.push(`TRUNCATE TABLE ${conteudoOrdenado.map((c) => `"${c.tabela}"`).join(', ')} CASCADE;`);
  const atualizacoes: string[] = [];
  const fechamentos: string[] = [];

  for (const { tabela, colunas, rows } of conteudoOrdenado) {
    linhas.push('');
    linhas.push(`-- ${tabela}: ${rows.length} registro(s)`);
    for (const row of rows) {
      const adiar = diferidas.get(tabela) || new Set<string>();
      const valores = colunas.map((c) => literalSql(adiar.has(c) ? null : (c === 'token' || c.endsWith('token_hash')) && row[c] != null ? `REVOKED_BY_RESTORE:${tabela}:${row.id}` : row[c]));
      const pendentes = [...adiar].filter((c) => row[c] != null && colunas.includes(c));
      if (pendentes.length) {
        if (row.id == null) throw new HttpError(409, 'Backup: restauração de ciclo exige chave id.');
        atualizacoes.push(`UPDATE "${tabela}" SET ${pendentes.map((c) => `"${c}" = ${literalSql(row[c])}`).join(', ')} WHERE "id" = ${literalSql(row.id)};`);
      }
      const insert = `INSERT INTO "${tabela}" (${colunas.map((c) => `"${c}"`).join(', ')}) VALUES (${valores.join(', ')});`;
      // Reconstituir o histórico antes dos fechamentos: os guards canônicos
      // continuam ativos; nenhum período é reaberto nem trigger desabilitado.
      if (tabela === 'fin_periodos_contabeis') fechamentos.push(insert);
      else linhas.push(insert);
    }
  }
  linhas.push('');
  linhas.push(...atualizacoes, ...fechamentos);
  // INSERTs com id explícito não avançam a sequence. Sem isto o primeiro
  // cadastro após o restore pode colidir com uma PK restaurada.
  for (const { tabela, colunas } of conteudoOrdenado) {
    if (!colunas.includes('id')) continue;
    const { rows: sequences } = await pool.query('SELECT pg_get_serial_sequence($1, $2) AS sequence', [tabela, 'id']);
    if (sequences[0]?.sequence) linhas.push(`SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), COALESCE((SELECT MAX(id) FROM "${tabela}"), 1), EXISTS(SELECT 1 FROM "${tabela}"));`);
  }
  linhas.push('COMMIT;');
  return linhas.join('\n');
}

/** GET /api/admin/backup/info — resumo para a tela de Configurações. */
export async function backupInfo(_req: Request, res: Response) {
  const s = getStore();
  const { pool } = await import('./db');
  let registros = 0;
  let tabelas = 0;
  if (pool) {
    try {
      for (const tabela of Array.from(new Set([...Object.values(RESOURCES), ...PAYMENT_RESOURCES].map((r) => r.table)))) {
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
