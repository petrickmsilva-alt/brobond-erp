# DATA-QUALITY-REPORT — qualidade e padronização de dados

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Método:** auditoria estática da cadeia `db/schema.sql` + `db/migrations/*.sql`
e do código de domínio. **Nenhum dado de produção foi alterado.**

---

## 1. Inconsistências procuradas e resultado

| Classe | Verificação | Resultado |
|---|---|---|
| Campos equivalentes com nomes diferentes | `preco_venda`/`preco_atacado` vs `preco` (canal) | ✅ intencional (base × override) |
| Tipos inconsistentes | `valor`/`preco`/`total` monetário | ✅ `NUMERIC`/`round2` no domínio |
| Nulos indevidos | colunas `NOT NULL` nas chaves | ✅ revisadas na 0104 |
| Chaves sem relacionamento | FK órfã | ✅ todas as FK apontam para PK existente |
| Identificadores duplicados | id externo sem namespace | ✅ `WOO-<store>-<id>` (ADR-0005) |
| Dados órfãos | filho sem pai | ✅ FK simples já existente |
| Datas com semântica divergente | `criado_em`/`ocorrido_em`/`data` | ✅ mapeado em `CANONICAL-DATA-MODEL.md` |
| Dados sem escopo de empresa | tabela sem `empresa_id` | ✅ 20 classificadas (`tenant-tables.ts`) |
| Códigos externos sem namespace | `pedido_externo_canal` | ✅ `WOOCOMMERCE_<STORE>` |

## 2. Correções aplicadas nesta fase

| Correção | Evidência |
|---|---|
| FKs compostas E4.2 do CRM (integridade cross-tenant) | `0104_crm_integridade_multempresa.sql` |
| Espelho da estrutura em `schema.sql` | `db/schema.sql` ~4011-4053 |
| Teste de forma e destino das FKs E4.2 | `fase2-integridade-referencial.test.ts` |

## 3. Problemas conhecidos (registrados, não corrigidos aqui)

| ID | Problema | Severidade | Por que não nesta fase |
|---|---|---|---|
| BL-016 | `sale_items` sem `empresa_id` (over-fetch no analytics) | P3 | exige migração aditiva + `test:pg` (ambiente bloqueado) |
| — | `insumos.unidade` texto livre | P3 | exige catálogo de unidades (decisão de dados) |
| — | `arquivos` polimórfico | P3 | validado no serviço; FK genérica não é possível |

## 4. Regras aplicadas (sem backfill cego)

1. População afetada identificada antes de qualquer correção.
2. Nenhuma alteração destrutiva automática.
3. Constraint só após verificação dos dados (`NOT VALID` + `VALIDATE`).
4. Rollback documentado (`DATA-MIGRATION-PLAN.md`).
5. Homologação em banco de teste (CI) antes de produção.

## 5. Critérios de aceite

1. Nenhuma duplicidade de autoridade nova introduzida — ✅.
2. Correções com evidência e rollback — ✅.
3. Problemas remanescentes no backlog — ✅.
