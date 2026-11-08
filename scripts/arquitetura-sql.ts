// ============================================================================
// Leitura de colunas de DDL do PostgreSQL para o inventário arquitetural.
//
// Extraído de scripts/arquitetura-audit.ts para ser testável sem executar o
// audit inteiro (que tem efeitos colaterais: grava o JSON e pode `process.exit`).
// Ver server/test/arquitetura-audit-parser.test.ts (regressão do falso positivo
// em `tabelas_sem_empresa_id`).
// ============================================================================

/**
 * Extrai os nomes de coluna do bloco `CREATE TABLE` (texto entre os parênteses).
 *
 * Aceita colunas em linhas separadas **ou inline** na mesma linha:
 *
 * ```sql
 * CREATE TABLE payment_intents (
 *   id bigserial PRIMARY KEY, empresa_id integer NOT NULL,
 *   order_id bigint NOT NULL, status text NOT NULL
 * );
 * ```
 *
 * O parser antigo (baseado em indentação de exatamente dois espaços) perdia as
 * colunas inline — o que gerava falso positivo em `tabelas_sem_empresa_id`.
 *
 * Cada segmento separado por vírgula é tokenizado; as restrições por tabela
 * (`CONSTRAINT`/`PRIMARY KEY`/`FOREIGN KEY`/`UNIQUE`/`CHECK`/`EXCLUDE`) são
 * descartadas e o primeiro identificador do segmento é a definição da coluna.
 */
export function extrairColunasCreateTable(corpo: string): string[] {
  const colunas: string[] = [];
  for (const segmento of corpo.split(',')) {
    const limpo = segmento
      .replace(/^\s*(?:CONSTRAINT\s+[a-z_][a-z0-9_]*\s+)?(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b[\s\S]*$/i, '')
      .trim();
    const col = limpo.match(/^([a-z_][a-z0-9_]*)\s+[a-z]/i);
    if (col) colunas.push(col[1].toLowerCase());
  }
  return colunas;
}

/**
 * Nomes das tabelas que declaram `empresa_id`, lidos do DDL real.
 *
 * ÚNICA implementação da métrica "tabelas com `empresa_id`": `architecture:audit`
 * e `audit:menu` precisam concordar. Ler `CREATE TABLE` (com colunas inline) e
 * `ALTER TABLE ... ADD COLUMN`; os comentários de linha são removidos antes.
 */
export function tabelasComEmpresaId(sqlFontes: string[]): Set<string> {
  const tabelas = new Set<string>();
  for (const sqlBruto of sqlFontes) {
    const sql = sqlBruto.replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi)) {
      if (extrairColunasCreateTable(m[2]).includes('empresa_id')) tabelas.add(m[1].toLowerCase());
    }
    for (const stmt of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]*?);/gi)) {
      for (const col of stmt[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
        if (col[1].toLowerCase() === 'empresa_id') tabelas.add(stmt[1].toLowerCase());
      }
    }
  }
  return tabelas;
}
