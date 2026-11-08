# DATA-MIGRATION-PLAN — plano de migração do núcleo de dados

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Referência:** [`DATABASE-MIGRATION-STANDARD.md`](DATABASE-MIGRATION-STANDARD.md).

> **Regra.** Migração é **aditiva, idempotente e não destrutiva**. Constraint só
> entra depois de verificar os dados existentes. Nada destrutivo é automático.

---

## 1. Migrações desta fase

| Arquivo | Objetivo | Tipo | Dados |
|---|---|---|---|
| `db/migrations/0104_crm_integridade_multempresa.sql` | FKs compostas E4.2 do CRM (GAP-P2-04) | aditiva | `NOT VALID` + `VALIDATE` |

Espelho: `db/schema.sql` (linhas ~4011-4053) — mesma estrutura, idempotente.

## 2. Padrão E4.2 (passo a passo)

1. **Destino único:** `CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_<tabela>_empresa_id ON <tabela> (empresa_id, id);`
2. **FK composta:** `ALTER TABLE <filho> ADD CONSTRAINT fk_e42_<...> FOREIGN KEY (empresa_id, <col>) REFERENCES <pai> (empresa_id, id) NOT VALID;`
3. **Validar:** `ALTER TABLE <filho> VALIDATE CONSTRAINT fk_e42_<...>;`
4. **Índice de apoio:** `CREATE INDEX IF NOT EXISTS e42_<...>_idx ON <filho> (empresa_id, <col>);`
5. **Espelhar** em `db/schema.sql`.
6. **Provar** com `server/test/fase2-integridade-referencial.test.ts`.

`NOT VALID` protege **toda escrita nova** imediatamente; `VALIDATE` confere o
legado e **falha em voz alta** se houver inconsistência (não mascara dado sujo).

## 3. População afetada e pré-condições

| Item | Antes | Depois | Rollback |
|---|---|---|---|
| FKs do CRM | simples | simples + composta | `DROP CONSTRAINT fk_e42_crm_*` |
| Índices únicos | — | `uq_e42_crm_*` | `DROP INDEX uq_e42_crm_*` |
| Colunas | — | nenhuma | — |
| Dados | intactos | intactos | — |

**Pré-condição para VALIDATE:** não existir linha do CRM cujo pai pertença a
outra empresa. Diagnóstico no rodapé da 0104 (SELECTs prontos). Plano de
saneamento: realinhar `empresa_id` do filho ao do pai quando a origem é
inequívoca; senão anular a referência e registrar em auditoria. **Nunca** fundir
empresas.

## 4. Execução por ambiente

| Ambiente | Ação |
|---|---|
| Memória (testes) | não executa SQL; prova de **forma** e **regra** |
| CI PostgreSQL (`test:pg`) | executa a cadeia real (gate de deploy) |
| Homologação | executar `VALIDATE` e conferir o diagnóstico |
| Produção | **somente** com autorização expressa (não nesta missão) |

> `npm run test:pg` exige `DATABASE_URL` de banco **vazio** e PostgreSQL 16.14.
> No sandbox atual ele está bloqueado (BL-009); a prova real roda no CI.

## 5. Estratégia de rollback

```sql
BEGIN;
ALTER TABLE crm_oportunidades DROP CONSTRAINT IF EXISTS fk_e42_crm_oportunidades_empresa_lead;
-- ... demais fk_e42_crm_*
DROP INDEX IF EXISTS uq_e42_crm_leads_empresa_id;
-- ... demais uq_e42_crm_*
DELETE FROM schema_migrations WHERE id = '0104_crm_integridade_multempresa.sql';
COMMIT;
```

Rollback **não** apaga dados (a migração não altera dados).

## 6. Backfill

Nesta fase **não** há backfill. A 0104 só adiciona estrutura. Qualquer backfill
futuro deve seguir §3 do `MASTER-DATA-GOVERNANCE.md` (população → quantidade →
integridade → correção → rollback → homologação → documentação).

## 7. Critérios de aceite

1. Migração aditiva/idempotente — ✅.
2. `NOT VALID` + `VALIDATE` — ✅ testado.
3. Espelho em `schema.sql` — ✅ testado.
4. Rollback documentado — ✅.
5. Gate PostgreSQL no CI — pendente de ambiente (BL-009).
