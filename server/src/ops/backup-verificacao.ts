// ============================================================================
// VERIFICAÇÃO DE BACKUP — "backup que nunca foi restaurado é fé, não evidência".
//
// A ordem executiva (Fase Zero) exige backup RECUPERÁVEL: não basta o arquivo
// existir nem ter tamanho plausível. Este módulo:
//
//   1. GERA o dump com `pg_dump` (formato custom, `-Fc`) — mecanismo padrão e
//      compatível com PostgreSQL/Render;
//   2. CONFERE a INTEGRIDADE do arquivo: sha256 do arquivo, e leitura do
//      catálogo interno com `pg_restore --list` (arquivo corrompido não lista);
//   3. RESTAURA o dump num banco DESCARTÁVEL vazio com `pg_restore`;
//   4. COMPARA a contagem por tabela entre a origem e o banco restaurado —
//      divergência em qualquer tabela invalida o backup.
//
// O arquivo do dump e o manifesto ficam SEMPRE fora da árvore do repositório.
// Nenhuma credencial é gravada: `identificacaoOrigem` guarda só host/porta/banco.
// ============================================================================
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Pool } from 'pg';

export interface ManifestoBackup {
  /** Identificação do banco de origem SEM credenciais (host:porta/banco). */
  origem: string;
  geradoEm: string;
  ferramenta: string;
  arquivo: string;
  bytes: number;
  sha256: string;
  /** Contagem por tabela na origem no instante do dump. */
  tabelas: Record<string, number>;
}

export interface ResultadoVerificacao {
  ok: boolean;
  arquivo: string;
  sha256: string;
  bytes: number;
  origem: string;
  tabelasConferidas: number;
  divergencias: { tabela: string; esperado: number; restaurado: number }[];
  bancoDescartavel: string | null;
  problemas: string[];
}

export function sha256DeArquivo(caminho: string): string {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}

/** host:porta/banco — nunca usuário, senha ou query string. */
export function identificacaoOrigem(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

/** Catálogo de objetos do dump (prova que o arquivo abre e enumera tabelas). */
export function listarCatalogo(arquivo: string, bin = 'pg_restore'): { ok: boolean; tabelas: string[]; erro?: string } {
  const r = spawnSync(bin, ['--list', arquivo], { encoding: 'utf8' });
  if (r.error) return { ok: false, tabelas: [], erro: `pg_restore indisponível: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, tabelas: [], erro: (r.stderr || '').trim() || `pg_restore --list saiu com ${r.status}` };
  // Formato: `570; 1259 22798 TABLE public affiliate_commissions brobond`
  const tabelas = [...r.stdout.matchAll(/^\d+;\s+\d+\s+\d+\s+TABLE\s+\S+\s+(\S+)/gm)].map((m) => m[1]).filter(Boolean);
  return { ok: true, tabelas };
}

/**
 * Integridade do arquivo — não considera o tamanho suficiente:
 *   • o arquivo precisa existir e não estar vazio;
 *   • o sha256 precisa bater com o manifesto (o arquivo não mudou);
 *   • o catálogo interno precisa abrir e listar as tabelas do manifesto.
 */
export function validarIntegridade(arquivo: string, manifesto: ManifestoBackup, bin = 'pg_restore'): string[] {
  const problemas: string[] = [];
  let st;
  try {
    st = statSync(arquivo);
  } catch {
    return [`arquivo de backup inexistente: ${arquivo}`];
  }
  if (st.size === 0) problemas.push('arquivo de backup vazio');
  if (st.size !== manifesto.bytes) problemas.push(`tamanho divergente: manifesto ${manifesto.bytes}, arquivo ${st.size}`);
  const sha = sha256DeArquivo(arquivo);
  if (sha !== manifesto.sha256) problemas.push(`sha256 divergente: manifesto ${manifesto.sha256}, arquivo ${sha}`);
  const cat = listarCatalogo(arquivo, bin);
  if (!cat.ok) {
    problemas.push(`catálogo do dump ilegível (${cat.erro})`);
  } else {
    const faltando = Object.keys(manifesto.tabelas).filter((t) => !cat.tabelas.includes(t));
    if (faltando.length) problemas.push(`tabelas ausentes do catálogo do dump: ${faltando.slice(0, 10).join(', ')}${faltando.length > 10 ? '…' : ''}`);
  }
  return problemas;
}

/** Contagem por tabela do schema público (inventário para comparação). */
export async function inventarioDe(pool: Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT c.relname AS tabela
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
      ORDER BY 1`
  );
  const inv: Record<string, number> = {};
  for (const { tabela } of rows) {
    const { rows: n } = await pool.query(`SELECT count(*)::bigint AS n FROM "${tabela}"`);
    inv[tabela] = Number(n[0].n);
  }
  return inv;
}

export function compararInventario(esperado: Record<string, number>, restaurado: Record<string, number>) {
  const divergencias: { tabela: string; esperado: number; restaurado: number }[] = [];
  for (const [tabela, n] of Object.entries(esperado)) {
    const r = restaurado[tabela] ?? -1;
    if (r !== n) divergencias.push({ tabela, esperado: n, restaurado: r });
  }
  return divergencias;
}

export interface OpcoesVerificacao {
  arquivo: string;
  manifesto: ManifestoBackup;
  /** URL-base com permissão de CREATE DATABASE (o banco alvo é descartável). */
  baseUrl: string;
  /** Sufixo do banco descartável (default: backup_verif). */
  sufixo?: string;
  pgRestore?: string;
  pgDump?: string;
}

/** Gera um dump custom (`pg_dump -Fc`) para `arquivo`. Devolve bytes/sha256. */
export function gerarDump(url: string, arquivo: string, bin = 'pg_dump'): { bytes: number; sha256: string } {
  const r = spawnSync(bin, ['-Fc', '--no-owner', '--no-privileges', '-f', arquivo, url], { encoding: 'utf8' });
  if (r.error) throw new Error(`pg_dump indisponível: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`pg_dump falhou (${r.status}): ${(r.stderr || '').trim()}`);
  return { bytes: statSync(arquivo).size, sha256: sha256DeArquivo(arquivo) };
}

/**
 * Restaura o dump num banco DESCARTÁVEL vazio e compara o inventário.
 * O banco descartável é SEMPRE removido no fim (sucesso ou falha).
 */
export async function verificarComRestauracao(opts: OpcoesVerificacao): Promise<ResultadoVerificacao> {
  const problemas = validarIntegridade(opts.arquivo, opts.manifesto, opts.pgRestore);
  const base: ResultadoVerificacao = {
    ok: false,
    arquivo: opts.arquivo,
    sha256: opts.manifesto.sha256,
    bytes: opts.manifesto.bytes,
    origem: opts.manifesto.origem,
    tabelasConferidas: 0,
    divergencias: [],
    bancoDescartavel: null,
    problemas,
  };
  if (problemas.length) return base;

  const u = new URL(opts.baseUrl);
  const nome = `${(u.pathname.replace(/^\//, '') || 'db')}_${opts.sufixo ?? 'backup_verif'}_${Date.now().toString(36)}`;
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
  const alvoUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${nome}`;

  const { Pool: PgPool } = await import('pg');
  const admin = new PgPool({ connectionString: adminUrl, max: 1 });
  let alvo: Pool | null = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${nome}"`);
    base.bancoDescartavel = nome;

    const restore = spawnSync((opts.pgRestore ?? 'pg_restore'), ['-d', alvoUrl, '--no-owner', '--no-privileges', opts.arquivo], { encoding: 'utf8' });
    if (restore.error) throw new Error(`pg_restore indisponível: ${restore.error.message}`);
    // pg_restore devolve >0 para avisos não fatais; a prova real é a comparação.
    const avisosFatais = (restore.stderr || '').split('\n').filter((l) => /FATAL|could not|does not exist/i.test(l));
    if (avisosFatais.length) base.problemas.push(`pg_restore reportou: ${avisosFatais.slice(0, 5).join(' | ')}`);

    alvo = new PgPool({ connectionString: alvoUrl, max: 1 });
    const restaurado = await inventarioDe(alvo);
    base.divergencias = compararInventario(opts.manifesto.tabelas, restaurado);
    base.tabelasConferidas = Object.keys(opts.manifesto.tabelas).length;
    base.ok = base.divergencias.length === 0 && base.problemas.length === 0;
    return base;
  } catch (e: any) {
    base.problemas.push(`restauração falhou: ${e?.message ?? e}`);
    return base;
  } finally {
    await alvo?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
