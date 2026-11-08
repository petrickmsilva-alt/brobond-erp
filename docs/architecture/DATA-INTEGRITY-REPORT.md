# DATA-INTEGRITY-REPORT — integridade e relacionamentos

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Método:** leitura de `db/schema.sql` + `db/migrations/*.sql` (cadeia lexica),
cruzada com `server/src/resources.ts` e o inventário
`docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`.

---

## 1. Números do núcleo (evidência)

| Métrica | Valor | Fonte |
|---|---|---|
| Tabelas | 212 | inventário |
| Tabelas com `empresa_id` | 192 | inventário |
| Tabelas sem `empresa_id` (classificadas) | 20 | `tenant-tables.ts` |
| Índices | 580 | inventário (após 0104) |
| Constraints | 386 | inventário |
| Migrations na cadeia | 104 | `db/migrations/*.sql` |
| Recursos CRUD | 174 | inventário |
| Cobertura de tenant | 89,7% | inventário |

## 2. Chaves e relacionamentos

| Verificação | Resultado |
|---|---|
| PK em todas as tabelas | ✅ (`id`/PK declarada) |
| FK simples onde a relação é global | ✅ |
| FK composta E4.2 onde há risco cross-tenant | ✅ locais/estoque/compras (0030) + **CRM (0104)** |
| Todo destino de FK E4.2 com `UNIQUE (empresa_id, id)` | ✅ provado por `fase2-integridade-referencial.test.ts` |
| Integridade produto ↔ variação | ✅ `variacoes.pai_id` |
| Integridade pedido ↔ itens | ✅ `itens_venda.venda_id`, `sale_items.sale_id` |
| Integridade venda ↔ comissão | ✅ por (representante, venda) |
| Integridade pedido ↔ pagamento ↔ entrega | ✅ por `sales.reference`/`operational_venda_id` |

## 3. Fechamento GAP-P2-04 (CRM cross-tenant)

**Antes:** `crm_*` com FKs **simples** — a API garante 404 cross-tenant, mas SQL
manual poderia apontar um registro do CRM a um pai de outra empresa.

**Depois (migração `0104_crm_integridade_multempresa.sql`):**

- 6 índices `uq_e42_crm_*_empresa_id` (+ `uq_e42_clientes_empresa_id`).
- 10 FKs compostas `fk_e42_crm_*` — todas `NOT VALID` + `VALIDATE`.
- 5 índices de apoio para as novas FKs.
- Aditiva, idempotente, não destrutiva (`DROP TABLE/COLUMN/DELETE/TRUNCATE`
  proibidos — testado).

## 4. Onde a integridade é **aplicacional** (não constraint)

| Caso | Motivo | Classificação |
|---|---|---|
| `sale_items` sem `empresa_id` | projeção do read model | P3 — herda `sales` (BL-016) |
| `arquivos` polimórfico | FK depende do recurso | P3 — validado no serviço |
| `cotacao_decisoes`/`portal_acessos` | herda-tenant | P3 — classificados |

## 5. Riscos remanescentes

| Risco | Nível | Mitigação |
|---|---|---|
| VALIDATE falhar em banco com dado sujo | P2 | diagnóstico no rodapé da 0104 + plano de saneamento |
| Constraint nova não espelhada em `schema.sql` | P2 | gate `fase2-integridade-referencial.test.ts` |
| Divergência Prisma × SQL | P2 | documentada (ADR-0014); Prisma = bounded context |

## 6. Critérios de aceite

1. Toda FK composta com destino único — ✅ testado.
2. Migração não destrutiva — ✅ testado.
3. Espelho em `schema.sql` — ✅ testado.
4. Integridade aplicacional restante registrada no backlog — ✅.
