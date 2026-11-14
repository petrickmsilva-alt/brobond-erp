# ADR-0015 — Identidade de migrations = nome completo; colisão histórica 0121

* **Identificador:** ADR-0015
* **Título:** Identidade de migrations pelo nome completo e tratamento da colisão de prefixo 0121
* **Status:** Aceita (evidência forense em PG 16.14; rename bloqueado até evidência de produção)
* **Data:** 2026-11-14
* **Relacionados:** ADR-0011 (padrão de migrations), ADR-0003 (fonte canônica)

## Contexto

O runner (`server/src/db.ts`, `aplicarMigrationsVersionadas`) registra cada
migration em `schema_migrations` com **o nome completo do arquivo** como
PRIMARY KEY e aplica em **ordem lexical**, uma única vez, em transação por
arquivo. Dois PRs paralelos criaram o prefixo `0121` duas vezes
(`0121_operational_control_plane.sql` e `0121_perf_busca_trigram_e_listagens.sql`).
O gate `go-live:audit` usava outro modelo (`prefixo == posição+1`) e reprovava
a cadeia, sugerindo na prática um rename.

## Problema

Qual é a identidade da migration — o prefixo ou o nome completo? É seguro
renomear `0121_perf…` para `0122_…`?

## Decisão

1. **Identidade = nome completo** (o que o runner já faz). Prefixo é convenção
   de ordenação, não chave.
2. **Não renomear** arquivo já enviado sem antes reconciliar
   `schema_migrations` do ambiente alvo. Forense em PG 16.14 provou: rename sem
   reconciliação **REAPLICA** a migration (cenários C4/d); com reconciliação
   prévia (`INSERT … SELECT` do id novo quando o antigo existe), não reaplica
   (C5/e). Evidência: `docs/auditoria/etapa-01-migration-forensics.md`,
   `server/test/pg/prod-db-04-identidade-migrations.test.ts`.
3. **Gate final usa o mesmo modelo** (`scripts/migrations-identidade.ts`):
   prefixos distintos contíguos a partir de 0001; duplicidade nova é P0;
   a colisão 0121 é registrada em `COLISOES_HISTORICAS` (P2 visível, com plano),
   exigindo igualdade exata com o disco — não é exceção silenciosa.
4. **Reconciliação futura** (rename para 0122) só com consulta READ-ONLY
   autorizada do histórico de produção e migration aditiva de reconciliação
   publicada junto. Plano completo no módulo e no documento forense.

## Alternativas consideradas

- **Renomear agora:** rejeitada — reaplicação comprovada em banco que já
  registrou o nome antigo; histórico de produção indisponível
  (BLOQUEADO — EVIDÊNCIA DE PRODUÇÃO INDISPONÍVEL).
- **Manter o gate antigo (prefixo único):** rejeitada — critério incoerente
  com o runner; forçaria rename inseguro ou gate permanentemente vermelho.
- **Checksum de conteúdo:** fora de escopo; exigiria backfill em produção sem
  evidência disponível. Registrado como evolução possível.

## Consequências

- Gates e runner falam a mesma língua; cadeia atual passa sem falsa reprovação.
- Duplicidade nova continua bloqueada (P0) por gate + testes unitários.
- A colisão permanece visível no relatório (P2) até a reconciliação autorizada.
