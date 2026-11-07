# ADR-0011 — Padrão de migrations

* **Identificador:** ADR-0011
* **Título:** Padrão de migrations e evolução do schema
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0003

## Contexto

Existem 103 migrations SQL (`db/migrations/*.sql`, ordem léxica) e 7 Prisma. O
`schema.sql` espelha a estrutura; `bootstrap.sql` é gerado.

## Problema

Definir regras para nomeação, versionamento, idempotência, compatibilidade,
índices, constraints, FKs, rollback e execução.

## Decisão

1. Nomeação `NNNN_descricao.sql`, ordem **léxica**; Prisma em
   `prisma/migrations/`.
2. **Aditivas e idempotentes** (`IF NOT EXISTS`, `ON CONFLICT`, `DO $$`).
3. **Nunca destrutivas** automaticamente; remover coluna/tabela/índice exige
   análise de dependências e plano de migração.
4. **Constraints** com `NOT VALID` quando o legado pode violar; validar depois.
5. **Índices** só para consultas quentes reais.
6. **FK composta por empresa** no padrão E4.2 (`uq_e42_*`) onde há cross-tenant.
7. **Tabela nova** entra na migração **e** no espelho `schema.sql`.
8. SQL permanece a referência oficial do schema.

## Alternativas consideradas

- **Só Prisma migrations:** rejeitada (Prisma é bounded context).
- **Migração destrutiva automática:** rejeitada (risco de perda).

## Consequências

- Deploy de schema seguro e reversível por não-uso.
- `architecture:audit` regenera o inventário; número mudou → commitar o JSON.

## Riscos

- Divergência espelho × migrations → gate `prod-db-02-bootstrap-sync`.
