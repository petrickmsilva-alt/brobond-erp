# MASTER-BACKLOG — pendências entre fases

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Regra:** nenhuma pendência desaparece sem evidência de resolução.

Cada item: **ID · fase de origem · descrição · evidência · severidade · impacto ·
dependência · próxima fase responsável · critério de encerramento · status**.

---

## 1. Backlog ativo

| ID | Fase origem | Descrição | Evidência | Sev. | Impacto | Dependência | Próx. fase | Critério de encerramento | Status |
|---|---|---|---|---|---|---|---|---|---|
| BL-001 | 0 | Loja pública nativa `/loja` ainda ativa | `App.tsx:162-166`, `index.ts:602-613` | P2 | duplicidade de varejo | decisão DNS (Diretor) | Fase 2 | rotas públicas removidas + URLs 301/410 + RETAIL intacto | **todo** |
| BL-002 | 0 | Dois caminhos de ingestão Woo (legado × multi-store) | `loja.ts` + `commerce/woocommerce/` | P2 | divergência de canal | runbook Agente 07 | Fase 1/2 | cutover concluído e legado desativado | **todo** |
| BL-003 | 0 | Integridade cross-tenant de `crm_*` só por FK simples | GAP-P2-04 | P2 | SQL manual poderia cruzar empresa | validação de dados legados | Fase 2 | FK composta E4.2 + `VALIDATE CONSTRAINT` | **todo** |
| BL-004 | 0 | Padrões de fundação implícitos no código (não formalizados) | ausência de `docs/architecture/FOUNDATION-STANDARDS.md` | P1 | inconsistência entre módulos | — | Fase 1 | padrões escritos + aplicados a 1–2 módulos | **todo** |
| BL-005 | 0 | Matriz RBAC por domínio não formalizada | RBAC só em `resources.ts` | P1 | auditoria manual | — | Fase 1 | `RBAC-MATRIX.md` + testes permitido/negado | **todo** |
| BL-006 | 0 | Padrão de evento/outbox não formalizado | `commerce/outbox.ts` | P1 | onboarding/consistência | — | Fase 1 | `EVENT-STANDARDS.md` + testes idempotência | **todo** |
| BL-007 | 0 | Padrão de migration não formalizado | `db/migrations/*` | P1 | risco de migração destrutiva | — | Fase 1 | `DATABASE-MIGRATION-STANDARD.md` | **todo** |
| BL-008 | 0 | Tabelas sem `empresa_id` sem classificação formal | 28 tabelas | P1 | risco de isolamento | — | Fase 1 | `TENANT-GOVERNANCE.md` classifica todas | **todo** |
| BL-009 | 0 | `test:pg`/`prisma validate` bloqueados no sandbox | GAP-P2-17 | P2 | evidência só no CI | CI | contínuo | CI verde nos jobs PG | **bloqueado (ambiente)** |
| BL-010 | 0 | Fiscal sem SPED/EFD | GAP-P2-11/12 | P2 | obrigação acessória | contador | pós-Fase 2 | layout oficial validado | **todo (externo)** |
| BL-011 | 0 | Plano de contas sem importação | GAP-P2-13 | P2 | trabalho manual | formato acordado | pós-Fase 2 | importação CSV/SPED | **todo** |
| BL-012 | 0 | CRM sem notificação ativa de lembrete | GAP-P2-14 | P2 | follow-up | canal | Fase 2 | notificação disparada por `scheduled.ts` | **todo** |
| BL-013 | 0 | `insumos.unidade` texto livre | GAP-P3-04 | P3 | padronização | migração de dados | pós-Fase 2 | catálogo de unidades | **todo** |
| BL-014 | 0 | Painéis de fluxo de módulo residuais (11) | `RELATORIO-PR95` §4.2 | P2/P3 | UX | reescrita por módulo | pós-Fase 2 | LISTA→PÁGINA em cada | **todo** |

---

## 2. Decisões que exigem o Diretor

| ID | Pergunta | Alternativas | Impacto | Recomendação |
|---|---|---|---|---|
| DEC-001 | Destino de SEO das URLs antigas de `/loja` (301 vs 410) | (a) 301 para RETAIL; (b) 410 | SEO / link equity | (a) quando `STOREFRONT_REDIRECT_URL` definida; senão (b). **Não bloqueia** — fallback 410 |
| DEC-002 | Destino administrativo de `LojaConfigPage`/`estadoLoja` | (a) repurpor como config de canal; (b) remover | UX admin / config de frete | (a) para o que for compartilhado |
| DEC-003 | Ativar homologação externa das integrações | (a) agora; (b) depois | operação | (b) — fora do escopo desta missão |

> Nenhuma dessas decisões foi tomada unilateralmente.

---

## 3. Pendências resolvidas nesta Fase 0

| ID | Descrição | Evidência de resolução |
|---|---|---|
| BL-R-01 | Ausência de blueprint arquitetural unificado | este diretório `docs/architecture/` |
| BL-R-02 | Decisão sobre `/loja` × RETAIL em aberto (ADR-008 §6) | ADR-0007 + `NATIVE-STORE-DECOMMISSION.md` |
| BL-R-03 | Fontes oficiais não inventariadas | `SOURCE-OF-TRUTH.md` |
| BL-R-04 | Fronteiras de contexto não documentadas | `CONTEXT-MAP.md` |

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
