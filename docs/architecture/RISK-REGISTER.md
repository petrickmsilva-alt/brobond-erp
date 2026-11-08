# RISK-REGISTER — registro de riscos (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Classificação:** P0 (bloqueia) · P1 (necessário) · P2 (evolução) · P3 (desejável).

> **Regra.** Risco é o que foi **verificado** como risco, com evidência e
> caminho de verificação. Nada é marcado como "aprovado" por inspeção.

---

## 1. Resumo

| Nível | Abertos | Observação |
|---|---:|---|
| **P0** | **0** | nenhum risco crítico de dados/segurança/operação identificado |
| **P1** | **0** | nenhum bloqueador conhecido |
| **P2** | **9** | evolução planejada / evidência dependente de CI |
| **P3** | **5** | desejável / produto futuro |

Herdados de `docs/ERP-3.0-GAP-MATRIX.md` + achados desta Fase 0.

---

## 2. Riscos críticos (P0)

**Nenhum P0 identificado** no escopo auditado (tenancy, RBAC, conversão, projeção
de vendas, anexos, webhooks, dados canônicos). Isso **não** é prova de ausência
absoluta — é o resultado das verificações de §4 e dos gates executados.

---

## 3. Riscos P1

**Nenhum P1 aberto.** Os P1 conhecidos foram fechados nas rodadas anteriores
(`docs/ERP-3.0-GAP-MATRIX.md` §4: GAP-P1-01/02/03/04/05/06/21/22/23).

---

## 4. Riscos P2

| ID | Domínio | Risco | Evidência | Impacto | Mitigação / fase |
|---|---|---|---|---|---|
| R-P2-01 | Infra de teste | `test:pg`/`smoke:pg`/`prisma validate` **BLOQUEADOS** no sandbox | GAP-P2-17 | evidência de PG depende do CI | CI (Node 24 + PG 16.14 + `psql`) |
| R-P2-02 | Fiscal | Sem layout SPED/EFD | GAP-P2-11/12 | obrigação acessória sem arquivo | depende do contador |
| R-P2-03 | Financeiro | Plano de contas sem importação em massa | GAP-P2-13 | 200+ contas manuais | definir layout |
| R-P2-04 | CRM | Lembrete sem notificação ativa | GAP-P2-14 | follow-up depende de abrir tela | Fase 2 |
| R-P2-05 | Produção | Sem sequenciamento/feriados | GAP-P2-15 | ocupação otimista | Fase 2/3 |
| R-P2-06 | Estoque | Sem contagem cíclica automatizada | GAP-P2-16 | retrabalho de contagem | Fase 2/3 |
| R-P2-07 | CRM (banco) | Integridade cross-tenant só por FK simples | GAP-P2-04 | SQL manual poderia cruzar empresa | **Fase 2** — FK composta E4.2 |
| R-P2-08 | Commerce | Dois caminhos de ingestão Woo (legado × multi-store) | `loja.ts` + `commerce/woocommerce/` | divergência de canal | runbook Agente 07 |
| R-P2-09 | Loja nativa | Superfície pública `/loja` | ADR-0007 | duplicidade de varejo | **Fase 2** — descontinuação |

## 5. Riscos P3

| ID | Domínio | Risco | Evidência | Mitigação |
|---|---|---|---|---|
| R-P3-01 | Master data | `insumos.unidade` texto livre | GAP-P3-04 | catálogo de unidades |
| R-P3-02 | Estoque | Estoque de terceiros (facção) sem contrato de posse | GAP-P3-05 | contrato de posse |
| R-P3-03 | UX | `CatalogoPublico` com lightbox/carrinho sobrepostos | GAP-P3-06 | decisão de produto |
| R-P3-04 | Produção | MRP sem unidade de medida/conversão | GAP-P3-07 | depende de R-P3-01 |
| R-P3-05 | Commerce/Creators | 8 módulos `planned` | GAP-P3-03 | roadmap de produto |

---

## 6. Riscos por categoria (visão da missão)

| Categoria | Risco principal | Nível | Situação |
|---|---|---|---|
| **Segurança** | integridade cross-tenant de `crm_*` no banco | P2 | API garante; FK na Fase 2 |
| **Dados** | dados legados ambíguos sem `store_key` | P2 | não reatribuir arbitrariamente |
| **Integração** | homologação externa pendente | P2 | não ativada |
| **Operacional** | dois caminhos Woo coexistindo | P2 | runbook |
| **Arquitetural** | erosão de fronteiras | P3 | gates + `DEPENDENCY-MAP.md` |
| **Governança** | variável de ambiente sem linha na matriz | P2 | teste `config-inventario-producao` |

---

## 7. O que foi verificado (evidência)

| Verificação | Resultado |
|---|---|
| Typecheck (domain+server+client) | ✅ OK |
| Testes server | ✅ 2.183 pass / 0 fail / 88 skip |
| Testes client | ✅ 1.165 pass / 0 fail |
| Lint | ✅ 0 errors |
| `architecture:audit` | ✅ 0 erros (34 avisos classificados) |
| `audit:menu` | ✅ 0 erros (21 avisos classificados) |
| `audit:ux` | ✅ 0 sobreposição nova |
| PostgreSQL real | ⏳ BLOQUEADO no sandbox (CI cobre) |

---

*Próximo documento: [`MASTER-BACKLOG.md`](MASTER-BACKLOG.md).*
