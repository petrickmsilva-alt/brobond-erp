# TENANCY TEST MATRIX — Fase 9.6

**Data:** 2026-11-09 · **Branch:** `architecture/fases-9-4-9-5-9-6`

Prova de que **Empresa = Tenant** e que o isolamento é aplicado no **servidor**
(e, quando há constraint, também no banco). Nenhum teste depende do frontend.

## 1. Regras de escopo (fonte única)

- O escopo vem de `escopoDoAtor(actor)` — **nunca** de `empresa_id` enviado pelo
  cliente. `?f.empresa_id=` na query é descartado no serviço.
- Leitura de registro de outra empresa responde **404** (não 403): não vaza a
  existência do registro.
- `carimbarEmpresa` fixa a empresa do novo registro pelo **servidor**.
- A empresa de um registro é **imutável** (PUT com `empresa_id` não transfere).

## 2. Matriz de testes negativos e positivos

| Garantia | Teste | Nível |
|---|---|---|
| A lê seus dados; B lê os seus | `multiempresa.test.ts`, `pg/fase9-6-enterprise-validation.test.ts` (A) | memória + PG |
| A **não** consulta dados de B | `multiempresa.test.ts` ("EMPRESA A não LISTA dados da EMPRESA B") | memória |
| A **não** altera/exclui dados de B | `multiempresa.test.ts`, `pg/fase9-6-enterprise-validation.test.ts` (A) | memória + PG |
| ID previsível não permite acesso cruzado | `pg/fase9-6-enterprise-validation.test.ts` (A), `pg/e42-tenant.test.ts` | PG real |
| Mesmo SKU/nome em duas empresas (unicidade por empresa) | `pg/e03-multiempresa-ab.test.ts`, `pg-multiempresa.test.ts` | PG real |
| Recorte aplicado no **SQL**, não só no JS | `pg-multiempresa.test.ts` | PG real |
| Trigger herda a empresa do pai (itens_venda) | `pg-multiempresa.test.ts` | PG real |
| Saldo de estoque não atravessa empresa | `pg/e03-multiempresa-ab.test.ts`, `pg/e42-tenant.test.ts` | PG real |
| Webhooks respeitam empresa e loja | `webhooks-empresa-isolamento.test.ts` | memória |
| Notificações respeitam destinatário e empresa | `outbox-notificacoes-cross-tenant.test.ts`, `segregacao-multiempresa-alertas.test.ts` | memória |
| Alertas/relatórios respeitam o tenant | `alertas-isolamento-empresa.test.ts`, `pg/pg-auditoria-multiempresa.test.ts` | memória + PG |
| Exportações respeitam o tenant | `pg/e42-tenant.test.ts` | PG real |
| Anexos respeitam o tenant | `pg/sec01-anexos-tenant.test.ts` | PG real |
| Auditoria multiempresa | `auditoria-multiempresa.test.ts`, `pg/pg-auditoria-multiempresa.test.ts` | memória + PG |
| Colisão de identificador entre empresas não ocorre | `pg/e03-multiempresa-ab.test.ts` | PG real |

## 3. Classificação de tabelas por tenancy

`server/src/tenant-tables.ts` classifica **toda** tabela: `empresa-id`,
`herda-tenant`, `referencia` (global) ou `sistema`. O teste
`tenant-tables-classificacao.test.ts` e a auditoria `architecture:audit`
garantem que nenhuma tabela fique sem classificação. A Fase 9.5 acrescentou
`fiscal_layouts` como **referência global** (leiaute é tabela nacional,
semeada por migração, só leitura).

## 4. Resultado

- Cobertura de tenancy: **89,7%** dos recursos são multiempresa (o restante é
  referência global legítima ou tabela de sistema) — ver
  `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`.
- **0** falhas de tenancy conhecidas em aberto.
