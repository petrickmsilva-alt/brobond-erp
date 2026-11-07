# ADR-0003 — Fonte canônica dos dados (SQL-first)

* **Identificador:** ADR-0003
* **Título:** Fonte canônica dos dados e persistência SQL-first
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0008, ADR-0014

## Contexto

O schema é definido em `db/schema.sql` + `db/migrations/*.sql` (PostgreSQL).
Prisma existe apenas no bounded context do commerce (11 modelos).

## Problema

Definir a fonte oficial da estrutura de dados e evitar segunda fonte de verdade.

## Decisão

1. **PostgreSQL** é a base transacional.
2. **`db/schema.sql` + `db/migrations/*.sql`** são a referência estrutural
   oficial; `db/bootstrap.sql` é gerado e testado.
3. **Prisma permanece restrito** aos contextos em que já é usado.
4. **Uma informação tem uma fonte oficial**; a segunda é projeção/cache/cópia/
   snapshot/legado (ver `SOURCE-OF-TRUTH.md`).
5. **Derivado não é coluna** (saldo, disponibilidade, custo, score…).

## Alternativas consideradas

- **Migrar todo o banco para Prisma:** rejeitada (proibida pelo escopo).
- **Escolher uma tabela arbitrária onde há ambiguidade:** rejeitada; registra-se
  como GAP.

## Consequências

- Acesso SQL parametrizado e dirigido por metadados (`resources.ts` + `store.ts`).
- Divergência Prisma × SQL deve ser documentada e corrigida só no escopo
  necessário.

## Riscos

- Divergência silenciosa entre espelho `schema.sql` e migrations → mitigada por
  `prod-db-02-bootstrap-sync` e `architecture:audit`.
