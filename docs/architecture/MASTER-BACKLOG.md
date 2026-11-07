# MASTER-BACKLOG — pendências entre fases

**Data:** 2026-11-07 · **Branch:** `architecture/fase-2-canonical-erp-data`
**Regra:** nenhuma pendência desaparece sem evidência de resolução.

Cada item: **ID · fase de origem · descrição · evidência · severidade · impacto ·
dependência · próxima fase responsável · critério de encerramento · status**.

---

## 1. Backlog ativo

| ID | Fase origem | Descrição | Evidência | Sev. | Impacto | Dependência | Próx. fase | Critério de encerramento | Status |
|---|---|---|---|---|---|---|---|---|---|
| BL-001 | 0 | Loja pública nativa `/loja` ainda ativa | `App.tsx:162-166`, `index.ts:602-613` | P2 | duplicidade de varejo | decisão DNS (Diretor) + PG/credenciais | Fase 3 | rotas públicas removidas + URLs 301/410 + RETAIL intacto | **aberto — impedimento registrado (DEC-001)** |
| BL-002 | 0 | Dois caminhos de ingestão Woo (legado × multi-store) | `loja.ts` + `commerce/woocommerce/` | P2 | divergência de canal | runbook Agente 07 | Fase 3 | cutover concluído e legado desativado | **aberto** |
| BL-009 | 0 | `test:pg`/`prisma validate` bloqueados no sandbox | GAP-P2-17 | P2 | evidência só no CI | CI | contínuo | CI verde nos jobs PG | **bloqueado (ambiente)** |
| BL-010 | 0 | Fiscal sem SPED/EFD | GAP-P2-11/12 | P2 | obrigação acessória | contador | pós-Fase 2 | layout oficial validado | **aberto (externo)** |
| BL-011 | 0 | Plano de contas sem importação | GAP-P2-13 | P2 | trabalho manual | formato acordado | pós-Fase 2 | importação CSV/SPED | **aberto** |
| BL-012 | 0 | CRM sem notificação ativa de lembrete | GAP-P2-14 | P2 | follow-up | canal | Fase 3 | notificação disparada por `scheduled.ts` | **aberto** |
| BL-013 | 0 | `insumos.unidade` texto livre | GAP-P3-04 | P3 | padronização | migração de dados | pós-Fase 2 | catálogo de unidades | **aberto** |
| BL-014 | 0 | Painéis de fluxo de módulo residuais (11) | `RELATORIO-PR95` §4.2 | P2/P3 | UX | reescrita por módulo | pós-Fase 2 | LISTA→PÁGINA em cada | **aberto** |
| BL-015 | 2 | Descontinuação da loja nativa não executada | `NATIVE-STORE-DECOMMISSION-REPORT.md` §4 | P2 | duplicidade de varejo | PG + credenciais Woo + decisão DNS | Fase 3 | remoção executada e RETAIL validado | **aberto — impedimento externo** |
| BL-016 | 2 | `sale_items` (projeção) sem `empresa_id`; leitura sem recorte no SQL | `commerce/analytics.ts` lê `sale_items` com `filter: {}` e recorta por `sale_id` em memória | P3 | over-fetch (não há vazamento: o item é filtrado pelo conjunto de `sales` da empresa) | migração aditiva + `test:pg` | Fase 3 | `empresa_id` na projeção + recorte no SQL | **aberto — performance** |

---

## 2. Decisões que exigem o Diretor

| ID | Pergunta | Alternativas | Impacto | Recomendação |
|---|---|---|---|---|
| DEC-001 | Destino de SEO das URLs antigas de `/loja` (301 vs 410) | (a) 301 para RETAIL; (b) 410 | SEO / link equity | (a) quando `STOREFRONT_REDIRECT_URL` definida; senão (b). **Não bloqueia** — fallback 410 |
| DEC-002 | Destino administrativo de `LojaConfigPage`/`estadoLoja` | (a) repurpor como config de canal; (b) remover | UX admin / config de frete | (a) para o que for compartilhado |
| DEC-003 | Ativar homologação externa das integrações | (a) agora; (b) depois | operação | (b) — fora do escopo desta missão |
| DEC-004 | Executar a descontinuação de `/loja` em ambiente com PostgreSQL + credenciais Woo | (a) Fase 3 com CI/banco real; (b) adiar | duplicidade de varejo | (a) — só com os gates de §6.8 satisfeitos |

> Nenhuma dessas decisões foi tomada unilateralmente.

---

## 3. Pendências resolvidas

| ID | Fase | Descrição | Evidência de resolução |
|---|---|---|---|
| BL-R-01 | 0 | Ausência de blueprint arquitetural unificado | `docs/architecture/` (Fase 0) |
| BL-R-02 | 0 | Decisão sobre `/loja` × RETAIL em aberto | ADR-0007 + `NATIVE-STORE-DECOMMISSION.md` |
| BL-R-03 | 0 | Fontes oficiais não inventariadas | `SOURCE-OF-TRUTH.md` |
| BL-R-04 | 0 | Fronteiras de contexto não documentadas | `CONTEXT-MAP.md` |
| BL-004 | 1 | Padrões de fundação implícitos | `FOUNDATION-STANDARDS.md` |
| BL-005 | 1 | Matriz RBAC não formalizada | `RBAC-MATRIX.md` + `rbac-matrix.test.ts` (9 casos) |
| BL-006 | 1 | Padrão de evento/outbox não formalizado | `EVENT-STANDARDS.md` |
| BL-007 | 1 | Padrão de migration não formalizado | `DATABASE-MIGRATION-STANDARD.md` |
| BL-008 | 1 | Tabelas sem `empresa_id` sem classificação | `TENANT-GOVERNANCE.md` + `tenant-tables.ts` + gate `tenant-tables-classificacao.test.ts` |
| BL-003 | 2 | Integridade cross-tenant de `crm_*` só por FK simples | migração `0104_crm_integridade_multempresa.sql` (FKs compostas E4.2 + `VALIDATE`) + `fase2-integridade-referencial.test.ts` |
| BL-R-05 | 2 | Defeito no parser de DDL do inventário (falso positivo) | `scripts/arquitetura-sql.ts` + `arquitetura-audit-parser.test.ts` (Fase 1) |
| BL-R-06 | 2 | Disponibilidade/preço canônicos sem prova explícita | `fase2-nucleo-canonico.test.ts` (8 casos) |

---

## 4. Regras de gestão

1. **Pendência resolvível na fase atual:** resolver antes de concluir.
2. **Pendência de fase posterior:** registrar aqui + incluir no escopo da fase.
3. **Pendência de credencial/serviço externo:** documentar bloqueio, criar
   contratos internos, deixar homologação externa pendente.
4. **Pendência de decisão do Diretor:** registrar pergunta/alternativas/impacto/
   recomendação (§2) — não decidir unilateralmente.
5. **Bloqueio crítico:** interromper só a operação afetada; não contornar com
   implementação insegura.

---

*Atualizar ao fim de cada fase; item só sai com evidência de resolução.*
