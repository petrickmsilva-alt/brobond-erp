---
files:
  - "db/migrations/*.sql"
  - "db/schema.sql"
---

# Migrações: novas, aditivas, seguras em banco com dado e espelhadas em `schema.sql`

Bancos de produção já aplicaram a cadeia versionada e o deploy roda a migração ANTES de a
API ficar pronta: uma migração que falha num banco real derruba o deploy. Uma mudança em
`db/migrations/` ou `db/schema.sql` precisa:

1. **Não editar migração já aplicada.** Arquivo que já existe em `main` não muda de
   conteúdo nem de nome; evolução vai num NOVO arquivo com o próximo prefixo (como a 0127
   corrigiu a 0126). Editar a antiga não altera bancos que já a rodaram.
2. **Ser aditiva e idempotente.** `CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   constraint guardada por `IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)`. Nada de
   `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`/`DELETE` de dado de negócio.
3. **Aceitar as linhas que já existem.** Constraint nova em tabela existente precisa de
   backfill/reconciliação antes (ou `NOT VALID`): coluna recém-adicionada é NULL em toda
   linha antiga. Migração que reinstala um CHECK só pode AMPLIÁ-LO — reinstalar a lista
   antiga de estados quebra quando já há linha no estado novo (0099 × `BLOQUEADO`/`OBSOLETO`).
   Ao adicionar estado, atualize o CHECK em `schema.sql`, na migração que o criou e em toda
   migração que o reinstala.
4. **Espelhar em `db/schema.sql`.** Tabela, coluna, índice ou CHECK novo também entra em
   `schema.sql`, declarado DEPOIS das tabelas que referencia (`empresas` nasce no meio do
   arquivo), e `db/bootstrap.sql` é regerado por `scripts/gerar-bootstrap.mjs`.

Incorreto (0127 como proposta no PR #160 — jobs `running` antigos não têm `lease_token`):

```sql
ALTER TABLE carga_politica_comercial_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE carga_politica_comercial_jobs ADD CONSTRAINT carga_politica_comercial_jobs_lease_ck
  CHECK ((status = 'running' AND lease_token IS NOT NULL) OR (status <> 'running' AND lease_token IS NULL));
```

Correto:

```sql
ALTER TABLE carga_politica_comercial_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
UPDATE carga_politica_comercial_jobs SET status = 'failed', lease_token = NULL
 WHERE status = 'running' AND lease_token IS NULL;   -- reconcilia o legado antes
-- ... e só então adiciona o CHECK guardado por IF NOT EXISTS em pg_constraint
```

Não precisa reportar o que os testes já travam: sincronia de `db/bootstrap.sql`
(`prod-db-02-bootstrap-sync`) e sequência/colisão de prefixos (`migrations-identidade`).
