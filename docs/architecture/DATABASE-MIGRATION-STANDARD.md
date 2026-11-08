# DATABASE-MIGRATION-STANDARD — migrações e evolução do schema

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** ADR-0011 (migrations), ADR-0003 (fonte canônica), ADR-0014
(Prisma×SQL).

> **Invariante.** Migração é **aditiva, idempotente e não destrutiva**. SQL
> permanece a referência oficial da estrutura.

---

## 1. Estrutura

- `db/schema.sql` — espelho estrutural (bootstrap).
- `db/bootstrap.sql` — **gerado** por `scripts/gerar-bootstrap.mjs`; testado por
  `prod-db-02-bootstrap-sync`.
- `db/migrations/NNNN_descricao.sql` — cadeia versionada, ordem **léxica**.
- `prisma/migrations/` — migrações do bounded context commerce (dual-track).

**104** migrações SQL + **7** Prisma (contagem do `architecture:audit`).

## 2. Regras

1. **Nomeação:** `NNNN_descricao.sql`, sequência sem lacunas.
2. **Aditiva e idempotente:** `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
   `ADD COLUMN IF NOT EXISTS`, blocos `DO $$ ... $$`.
3. **Nunca destrutiva automaticamente:** remover coluna/tabela/índice exige
   análise de dependências e plano de migração.
4. **Constraints** com `NOT VALID` quando o legado pode violar; `VALIDATE
   CONSTRAINT` depois, com os dados verificados.
5. **Índices** só para consultas quentes reais (não indexar por reflexo).
6. **FK composta por empresa** no padrão E4.2 (`uq_e42_*`) onde há risco de
   cross-tenant.
7. **Tabela nova** entra na migração **e** no espelho `schema.sql`.
8. **Rollback** documentado no cabeçalho da migração (ex.: 0098 descreve o
   `DROP` de manutenção autorizada) — mas nunca automático.

## 3. Execução em ambientes

- `npm run test:pg` — gate PostgreSQL real; exige `DATABASE_URL` de banco
  **vazio** e PostgreSQL **16.14**.
- `prisma validate` roda no CI (`verificar`).
- **Node 24** no CI (bug do runner `node --test` no 22 — ver `AGENTS.md`).
- `architecture:audit` regenera `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`; se o
  número de casos mudar, o JSON é commitado junto.

## 4. Divergência Prisma × SQL

Documentar e corrigir **só o escopo necessário**; nunca gerar alteração
indiscriminada. Prisma permanece restrito ao commerce (ADR-0014).

## 5. Critérios de aceite

1. Migração idempotente e reaplicável.
2. Sem operação destrutiva.
3. Espelho `schema.sql` atualizado.
4. `bootstrap.sql` regenerado quando a estrutura muda.
5. Teste de sincronia (`prod-db-02-bootstrap-sync`) verde.
6. Rollback descrito.
