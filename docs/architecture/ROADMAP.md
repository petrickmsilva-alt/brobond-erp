# ROADMAP — plano de execução (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Programa:** Brobond ERP 3.0 — Fases 0, 1 e 2.

---

## 1. Visão geral

| Fase | Objetivo | Entregável | Branch |
|---|---|---|---|
| **Fase 0** | Auditar e desenhar a arquitetura-alvo | Blueprint em `docs/architecture/` + ADRs | `architecture/fase-0-blueprint` |
| **Fase 1** | Fundação e governança | Padrões + implementação mínima + testes | `architecture/fase-1-foundation` |
| **Fase 2** | Núcleo canônico de dados + descontinuação do `/loja` | Dados governados + retirada segura | `architecture/fase-2-canonical-erp-data` |

Cada fase parte da base consolidada da anterior (encadeamento de PRs).

---

## 2. Fase 0 — Architecture Discovery & Blueprint

| Entrega | Status |
|---|---|
| Auditoria do estado atual (`CURRENT-STATE.md`) | ✅ |
| Mapa de domínios (`DOMAIN-MAP.md`) | ✅ |
| Mapa de dependências (`DEPENDENCY-MAP.md`) | ✅ |
| Fontes oficiais (`SOURCE-OF-TRUTH.md`) | ✅ |
| Bounded contexts (`CONTEXT-MAP.md`) | ✅ |
| Arquitetura-alvo + C4 (`TARGET-ARCHITECTURE.md`) | ✅ |
| Arquitetura de dados (`DATA-ARCHITECTURE.md`) | ✅ |
| Integrações (`INTEGRATION-ARCHITECTURE.md`) | ✅ |
| Segurança (`SECURITY-ARCHITECTURE.md`) | ✅ |
| Contratos de API (`API-CONTRACTS.md`) | ✅ |
| Catálogo de eventos (`EVENT-CATALOG.md`) | ✅ |
| ADRs (`ADR/` 0001–0014) | ✅ |
| Roadmap, riscos, backlog | ✅ |
| Plano da loja nativa (`NATIVE-STORE-DECOMMISSION.md`) | ✅ |

**Critério de conclusão:** documentação completa, evidências coletadas, gates
verdes, PR aberto.

---

## 3. Fase 1 — Foundation & Governance

| # | Entrega | Tipo |
|---|---|---|
| 1 | `FOUNDATION-STANDARDS.md` — padrões de módulo/entidade/serviço/repo/DTO/erro/transação | doc |
| 2 | `TENANT-GOVERNANCE.md` — auditoria de isolamento + classificação de tabelas sem `empresa_id` | doc |
| 3 | `RBAC-MATRIX.md` — matriz de permissões por domínio | doc |
| 4 | `AUDIT-STANDARD.md` — padrão de auditoria | doc |
| 5 | `OBSERVABILITY-STANDARD.md` — logs/correlation/health | doc |
| 6 | `API-STANDARDS.md` — versionamento/DTO/paginação/idempotência | doc |
| 7 | `EVENT-STANDARDS.md` — publisher/handler/outbox/inbox/idempotência | doc |
| 8 | `DATABASE-MIGRATION-STANDARD.md` — nomeação/idempotência/rollback | doc |
| 9 | Testes negativos de isolamento (jobs/webhooks/relatórios) | código |
| 10 | Estrutura de referência de módulo (aplicada a 1–2 módulos) | código |
| 11 | Testes de RBAC (permitido × negado) | código |
| 12 | Testes de idempotência de eventos | código |

**Critério de aceite:** padrões documentados; tenant validado; RBAC validado;
auditoria e observabilidade consolidadas; contratos de API padronizados; eventos
governados; migrations governadas; testes automatizados; sem regressão crítica.

**Dependência:** Fase 0 (blueprint aprovado).

---

## 4. Fase 2 — Canonical ERP Core & Data

| # | Entrega | Tipo |
|---|---|---|
| 1 | `CANONICAL-DATA-MODEL.md` — modelo mestre | doc |
| 2 | `MASTER-DATA-GOVERNANCE.md` — governança de cadastros | doc |
| 3 | `ENTITY-OWNERSHIP.md` — dono × leitor × escritor por entidade | doc |
| 4 | `COMMERCIAL-IDENTITY.md` — identidade comercial formalizada | doc |
| 5 | `OPERATIONAL-ANALYTICAL-SEPARATION.md` — operacional × analítico | doc |
| 6 | `DATA-INTEGRITY-REPORT.md` — PK/FK/índices/constraints | doc |
| 7 | `DATA-MIGRATION-PLAN.md` — plano de migrações | doc |
| 8 | `DATA-QUALITY-REPORT.md` — qualidade de dados | doc |
| 9 | `NATIVE-STORE-DECOMMISSION-REPORT.md` — execução da retirada | doc |
| 10 | FK composta cross-tenant de `crm_*` (GAP-P2-04) | código+migração |
| 11 | Descontinuação segura da loja nativa `/loja` | código |
| 12 | Testes: isolamento, preços, estoque, identidade de pedido, projeções, comissões, logística, idempotência, reconciliação, RBAC, não-regressão RETAIL | código |
| 13 | Gates PostgreSQL reais (onde houver infraestrutura) | evidência |

**Critério de aceite:** núcleo de dados governado; fontes oficiais formalizadas;
integridade validada; implementação testada; PR independente.

**Dependência:** Fase 1 (fundação consolidada).

### 4.1 Status da Fase 2 (esta rodada)

| # | Entrega | Status |
|---|---|---|
| 1–8 | Documentos canônicos de dados (itens 1–8) | ✅ entregues |
| 9 | `NATIVE-STORE-DECOMMISSION-REPORT.md` | ✅ entregue — **execução BLOQUEADA** (impedimentos I-1..I-4) |
| 10 | FK composta cross-tenant de `crm_*` (GAP-P2-04) | ✅ migração `0104` + espelho + teste |
| 11 | Descontinuação segura da loja nativa `/loja` | ⛔ **não executada** — sem PG real, sem credenciais Woo, sem decisão DNS |
| 12 | Testes do núcleo (preço, disponibilidade, identidade, integridade) | ✅ `fase2-nucleo-canonico` (8), `fase2-identidade-comercial` (4), `fase2-integridade-referencial` (4) |
| 13 | Gates PostgreSQL reais | ⛔ bloqueado no sandbox (BL-009) — roda no CI |

> A retirada da loja nativa foi **conscientemente** deixada para a Fase 3: o §6.8
> do PROMPT MASTER manda entregar o plano e registrar o impedimento quando a
> remoção não puder ser feita com segurança. Ver BL-015 / DEC-004.

---

## 5. Dependências técnicas entre fases

```
Fase 0 (blueprint)
   └── Fase 1 (fundação: padrões + tenant + RBAC + eventos)
          └── Fase 2 (dados canônicos + retirada /loja)
```

- A retirada do `/loja` (Fase 2) depende da **decisão de DNS/edge** (Diretor) —
  não bloqueante, com fallback 410.
- A FK composta de `crm_*` (Fase 2) depende de validação de dados legados antes
  de `VALIDATE CONSTRAINT`.
- A unificação do caminho legado Woo (Fase 1/2) depende do runbook do Agente 07.

---

## 6. Critérios de aceite gerais (todas as fases)

1. Escopo implementado e testado.
2. Typecheck, lint (0 errors) e build verdes.
3. Suítes server/client verdes (ou falhas justificadas e documentadas).
4. Migrations testadas (quando houver).
5. Documentação atualizada.
6. Commit + push + PR por fase.
7. Relatório técnico por fase.

---

## 7. Estratégia de rollback

| Fase | Rollback |
|---|---|
| Fase 0 | Documentação pura — reverter o PR não afeta runtime |
| Fase 1 | Padrões documentais + testes; código aditivo — reverter o PR |
| Fase 2 | Migrações **aditivas** (não destrutivas); retirada da vitrine é reversível por revert do PR; dados nunca removidos |

Nenhuma fase executa operação destrutiva de dados.

---

*Próximo documento: [`RISK-REGISTER.md`](RISK-REGISTER.md).*
