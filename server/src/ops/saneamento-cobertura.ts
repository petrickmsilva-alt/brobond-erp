// ============================================================================
// COBERTURA DO SANEAMENTO — inventário do grafo de chaves estrangeiras.
//
// O plano de limpeza é uma lista FINITA de tabelas. Se existir QUALQUER chave
// estrangeira que aponte para uma tabela do plano e não esteja coberta (nem por
// exclusão em cascata, nem por desvínculo explícito), o DELETE vai falhar no
// meio da transação — ou pior, alguém seria tentado a desabilitar a constraint.
//
// Este módulo lê o grafo REAL de FKs do PostgreSQL e classifica cada aresta:
//
//   LIMPA       — filho e pai estão no plano; o filho é apagado antes do pai.
//   DESVINCULA  — o filho é preservado; a coluna é zerada de forma GUARDADA.
//   CASCATA     — a FK é ON DELETE CASCADE: o banco apaga o filho sozinho.
//   SET_NULL    — a FK é ON DELETE SET NULL: o banco zera a coluna sozinha.
//   BLOQUEIO    — NO ACTION/RESTRICT sem cobertura: o saneamento NÃO pode rodar.
//
// `bloqueios()` precisa devolver lista vazia; qualquer item é falha dura.
// ============================================================================
import type { Pool, PoolClient } from 'pg';

export interface FkInfo {
  nome: string;
  filho: string;
  pai: string;
  colunas: string[];
  /** a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT. */
  deltype: string;
}

export type ClasseFk = 'LIMPA' | 'DESVINCULA' | 'CASCATA' | 'SET_NULL' | 'BLOQUEIO';

export interface ClassificacaoFk extends FkInfo {
  classe: ClasseFk;
  motivo?: string;
}

export interface Cobertura {
  totalFks: number;
  alvos: string[];
  classificacoes: ClassificacaoFk[];
  bloqueios: ClassificacaoFk[];
}

/** Lê TODAS as chaves estrangeiras do schema atual (grafo completo). */
export async function grafoFks(pool: Pool | PoolClient): Promise<FkInfo[]> {
  const { rows } = await pool.query(
    `SELECT con.conname AS nome,
            con.conrelid::regclass::text  AS filho,
            con.confrelid::regclass::text AS pai,
            con.confdeltype               AS deltype,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS colunas
       FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.connamespace = 'public'::regnamespace
      ORDER BY 2, 3, 1`
  );
  return rows.map((r: any) => ({
    nome: String(r.nome),
    filho: String(r.filho),
    pai: String(r.pai),
    colunas: (r.colunas as string[]) ?? [],
    deltype: String(r.deltype),
  }));
}

export interface PassoParaCobertura {
  tabela: string;
}

export interface DesvinculoParaCobertura {
  tabela: string;
  sets: string[];
}

/** Extrai o nome da coluna de um set no formato `coluna = NULL`. */
function colunaDoSet(set: string): string {
  return set.split('=')[0].trim();
}

/**
 * Classifica o grafo contra o plano. É uma função PURA (não toca no banco), o
 * que permite testá-la com um grafo sintético sem subir PostgreSQL.
 */
export function classificar(
  grafo: FkInfo[],
  plano: PassoParaCobertura[],
  desvinculos: DesvinculoParaCobertura[]
): Cobertura {
  const alvos = new Set(plano.map((p) => p.tabela));
  const indice = new Map(plano.map((p, i) => [p.tabela, i]));
  const desvPorTabela = new Map<string, Set<string>>();
  for (const d of desvinculos) {
    const cols = desvPorTabela.get(d.tabela) ?? new Set<string>();
    for (const s of d.sets) cols.add(colunaDoSet(s));
    desvPorTabela.set(d.tabela, cols);
  }

  const classificacoes: ClassificacaoFk[] = [];
  for (const fk of grafo) {
    // Só interessam as arestas que apontam para uma tabela que será apagada.
    if (!alvos.has(fk.pai)) continue;

    let classe: ClasseFk;
    let motivo: string | undefined;

    // Desvínculo vem PRIMEIRO: se a coluna da FK é zerada antes do plano (e a
    // coluna é anulável), a FK deixa de apontar para a linha apagada — vale
    // mesmo que o filho também esteja no plano (aí a ordem entre eles não
    // importa). Numa FK COMPOSTA, zerar QUALQUER coluna já anula a referência
    // (MATCH SIMPLE), então basta haver interseção entre as colunas da FK e as
    // colunas desvinculadas.
    const desvCols = desvPorTabela.get(fk.filho);
    const desvinculada = desvCols && fk.colunas.some((c) => desvCols.has(c));

    if (desvinculada) {
      classe = 'DESVINCULA';
    } else if (alvos.has(fk.filho)) {
      classe = 'LIMPA';
      const iFilho = indice.get(fk.filho)!;
      const iPai = indice.get(fk.pai)!;
      if (iFilho > iPai) {
        classe = 'BLOQUEIO';
        motivo = `ordem invertida: ${fk.filho} (posição ${iFilho}) é apagado DEPOIS de ${fk.pai} (posição ${iPai})`;
      }
    } else if (fk.deltype === 'c') {
      classe = 'CASCATA';
    } else if (fk.deltype === 'n') {
      classe = 'SET_NULL';
    } else {
      classe = 'BLOQUEIO';
      motivo = `${fk.filho}.${fk.colunas.join(',')} -> ${fk.pai} é ${fk.deltype === 'r' ? 'RESTRICT' : 'NO ACTION'} e não tem desvínculo nem exclusão`;
    }
    classificacoes.push({ ...fk, classe, motivo });
  }

  const bloqueios = classificacoes.filter((c) => c.classe === 'BLOQUEIO');
  return { totalFks: grafo.length, alvos: [...alvos].sort(), classificacoes, bloqueios };
}

/**
 * Roda a cobertura no banco e FALHA se houver qualquer aresta não coberta.
 * Chamado dentro da transação: melhor abortar antes de apagar nada.
 */
export async function verificarCobertura(
  pool: Pool | PoolClient,
  plano: PassoParaCobertura[],
  desvinculos: DesvinculoParaCobertura[]
): Promise<Cobertura> {
  const cobertura = classificar(await grafoFks(pool), plano, desvinculos);
  if (cobertura.bloqueios.length > 0) {
    const lista = cobertura.bloqueios.map((b) => `  • ${b.filho}.${b.colunas.join(',')} -> ${b.pai}: ${b.motivo}`).join('\n');
    throw new Error(`COBERTURA INCOMPLETA — ${cobertura.bloqueios.length} FK(s) bloqueante(s) não tratada(s):\n${lista}`);
  }
  return cobertura;
}
