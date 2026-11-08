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
