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
| BL-002 | 0 | Dois caminhos de ingestão Woo (legado × multi-store) | `loja.ts` + `commerce/woocommerce/` | P2 | divergência de canal | runbook Agente 07 | Fase 3 | cutover concluído e legado desativado | **parcial na Fase 9.4** — ver §3 (visão unificada pronta; desativação do legado segue na Fase 3) |
| BL-009 | 0 | `test:pg`/`prisma validate` bloqueados no sandbox | GAP-P2-17 | P2 | evidência só no CI | CI | contínuo | CI verde nos jobs PG | **bloqueado (ambiente)** |
| BL-010 | 0 | Fiscal sem SPED/EFD | GAP-P2-11/12 | P2 | obrigação acessória | contador | pós-Fase 2 | layout oficial validado | **parcial na Fase 9.5** — ver §3 (estrutura versionada + validador estrutural; homologação externa pendente) |
| BL-011 | 0 | Plano de contas sem importação | GAP-P2-13 | P2 | trabalho manual | formato acordado | pós-Fase 2 | importação CSV/SPED | **encerrado na Fase 9.5** — ver §3 |
| BL-012 | 0 | CRM sem notificação ativa de lembrete | GAP-P2-14 | P2 | follow-up | canal | Fase 3 | notificação disparada por `scheduled.ts` | **encerrado na Fase 9.2** — ver §3 |
| BL-013 | 0 | `insumos.unidade` texto livre | GAP-P3-04 | P3 | padronização | migração de dados | pós-Fase 2 | catálogo de unidades | **parcial na Fase 9.5** — ver §3 (catálogo + conversões declaradas; resolução de legado preservada) |
| BL-014 | 0 | Painéis de fluxo de módulo residuais (11) | `RELATORIO-PR95` §4.2 | P2/P3 | UX | reescrita por módulo | pós-Fase 2 | LISTA→PÁGINA em cada | **encerrado na Fase 9.3** — ver §3 |
| BL-015 | 2 | Descontinuação da loja nativa `/loja` | `NATIVE-STORE-DECOMMISSION-REPORT.md` | P2 | duplicidade de varejo | — | **executada** | remoção executada e RETAIL preservado | **encerrado — código retirado (ADR-0007); URLs antigas 301/410; RETAIL preservado** |
| BL-017 | 9.4 | Conector REPRESENTATIVES (portal de representantes) sem implementação | `COMMERCIAL-ARCHITECTURE.md` §7 | P2 | canal próprio sem integração | portal/credenciais do representante | pós-9.4 | conector + homologação | **aberto (externo)** |
| BL-018 | 9.5 | Homologação fiscal externa (PVA oficial / contador) pendente | `fiscal/FISCAL-VALIDATION.md` §6 | P2 | obrigação acessória | contador + ambiente fiscal | pós-9.5 | arquivo gerado validado no PVA | **aberto (externo)** |

> **BL-016 encerrado na Fase 9.1** e **BL-014 encerrado na Fase 9.3** — ver §3
> (Pendências resolvidas). A projeção continua SEM `empresa_id` (decisão de
> arquitetura mantida); o over-fetch foi corrigido recortando o tenant no SQL. Os
> fluxos de módulo em painel viraram páginas (trava `scripts/ux-guard.mjs`).

---

## 2. Decisões que exigem o Diretor

| ID | Pergunta | Alternativas | Impacto | Recomendação |
|---|---|---|---|---|
| DEC-001 | Destino de SEO das URLs antigas de `/loja` (301 vs 410) | (a) 301 para RETAIL; (b) 410 | SEO / link equity | (a) quando `STOREFRONT_REDIRECT_URL` definida; senão (b). **Não bloqueia** — fallback 410 |
| DEC-002 | Destino administrativo de `LojaConfigPage`/`estadoLoja` | (a) repurpor como config de canal; (b) remover | UX admin / config de frete | (a) para o que for compartilhado |
| DEC-003 | Ativar homologação externa das integrações | (a) agora; (b) depois | operação | (b) — fora do escopo desta missão |
| DEC-004 | Executar a descontinuação de `/loja` | (a) retirar do código preservando os serviços compartilhados; (b) adiar | duplicidade de varejo | **(a) decidida e executada** — loja nativa retirada; motor de checkout mantido como serviço interno autenticado |

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
| BL-R-07 | 2 | Divergência numérica `184 × 192` (tabelas com `empresa_id`) e `174 × 176` (recursos RBAC) | Causa: falso positivo do parser (Fase 1) e contagem de linhas do `RBAC-MATRIX.md` (174 recursos + cabeçalho/separador). Docs alinhados (`CURRENT-STATE.md`, `README.md`, `ADR-0011`, `DATABASE-MIGRATION-STANDARD.md`); travado por `rbac-matrix.test.ts` (matriz × código). **Segunda passada:** o gerador `audit:menu` (`scripts/auditar-menu.ts`) ainda usava o parser ingênuo e reportava 184 — passou a consumir o parser único `tabelasComEmpresaId` de `scripts/arquitetura-sql.ts` (192, igual ao `architecture:audit`), travado por `arquitetura-audit-parser.test.ts` |
| BL-R-08 | 2 | Documentação tratava a retirada da `/loja` como concluída, mas a superfície segue ativa | Corrigido em `SECURITY-ARCHITECTURE.md`, `TARGET-ARCHITECTURE.md`, `README.md`, `NATIVE-STORE-DECOMMISSION.md`; travado por `fase2-loja-coerencia.test.ts`. **Segunda passada:** o cabeçalho de `NATIVE-STORE-DECOMMISSION.md` ainda dizia "A retirada é executada na Fase 2" (contradizendo o relatório e o próprio rodapé) — corrigido para "execução bloqueada / superfície ativa", com teste que varre a afirmação em prosa |
| BL-R-09 | 2 | Disponibilidade canônica sem prova de "sem dupla dedução" e dos 4 componentes | `fase2-nucleo-canonico.test.ts` (+5 casos: quatro componentes, tipo desconhecido, quantidade ≤ 0, 1× célula × total, `saldoVendavel`) |
| BL-016 | 9.1 | Over-fetch de `sale_items` (projeção sem `empresa_id`): analytics lia `filter: {}` e recortava por `sale_id` em memória | `server/src/commerce/projecao.ts` + filtro de lista (`= ANY`) no Store (`pgstore.ts`/`memdb.ts`); `analytics.ts` recorta o tenant no SQL. Provas: `fase9-1-data-integrity.test.ts` (memória) e `pg/fase9-1-data-integrity.test.ts` (PG real: isolamento A/B + Index Scan `sale_items_sale_id_idx`). **Sem migração** — a projeção permanece sem `empresa_id` (decisão mantida) |
| BL-012 | 9.2 | CRM sem notificação ativa de lembrete (GAP-P2-06/P2-14): só havia o carimbo CAS do agendador, sem canal interno visível | Canal INTERNO em `crm_notificacoes` (migration `0113`, aditiva) com `UNIQUE (empresa_id, chave_idempotencia)` — idempotência pelo BANCO; hooks de ciclo de vida em `services.ts` (mesma transação) e `crmNotificacoes.ts`; endpoints `GET /api/crm/notificacoes` + `/lida(s)` (caixa pessoal); tela `/crm/notificacoes`. **Revisão corretiva (migration `0114`)**: FK composta `(empresa_id, atividade_id)` (aviso e atividade do MESMO tenant), `usuario_id` `ON DELETE SET NULL` (retenção — não se apaga trilha), guarda `destinatarioDoTenant` e contagem/marcação sem teto de 500. Provas: `fase9-2-crm-lifecycle.test.ts` (26 casos) e `pg/fase9-2-crm-lifecycle.test.ts` (PG real). **Canal externo NÃO ativado** |
| BL-014 | 9.3 | Painéis de fluxo de módulo residuais (PR95 §4.2): criação/edição de entidade escondida em `PainelInline` | Convertidos para PÁGINA (`/custo/nova`, `/devolucoes/nova`, `/empresas/:id/editar`, `/ncm/novo`, `/webhooks/novo`, `/config/impressao/…`, `/importar/:tipo`, `/usuarios/novo`, `/compras/:id/receber`, `/cotacoes-compra/novo`); trava `scripts/ux-guard.mjs` (rota + página + ausência do painel antigo). Moldura de página unificada em `PageShell`; gate `client/src/test/page-shell.test.ts`. **Revisão corretiva**: o gate ganhou prova de moldura manual (`<div p-4 sm:p-6>` no raiz de um `return`) e de `<Spinner>` cru de página inteira; páginas fora do padrão convertidas para `PageShell`/`PageLoading`. Painéis auxiliares legítimos (leitura/child-flow) preservados |
| BL-011 | 9.5 | Plano de contas sem importação | Importação em lote transacional com **prévia** e **confirmação** (`server/src/financeiroImportacao.ts`: `normalizarPlanoDeContas`, `previewImportacaoPlano`, `confirmarImportacaoPlano`; rotas `POST /api/financeiro/plano-contas/importar/preview` e `/importar`), idempotência e validação prévia (duplicidade de código, pai inexistente, ciclo, conta em uso). Provas: `fase9-5-plano-contas.test.ts` (hierarquia, ciclo, sintética×analítica, importação) e `pg/fase9-6-enterprise-validation.test.ts`. Migration `0059` (já existente, reusada). Documento: `docs/finance/CHART-OF-ACCOUNTS.md` §4 |
| BL-002 | 9.4 | Dois caminhos de ingestão Woo (legado × multi-store) | **Parcial**: a **visão unificada dos canais** (`server/src/commerce/canaisComerciais.ts`, `GET /api/commerce/canais`) consolida RETAIL/WHOLESALE sobre o registry multi-loja com identidade por `store_key`, sem duplicar serviço. A **desativação do caminho legado** segue na Fase 3 (depende de decisão de cutover). Provas: `fase9-4-canais-comerciais.test.ts`, `woocommerce-multistore.test.ts`. Documento: `docs/architecture/WOOCOMMERCE-INTEGRATION.md` |
| BL-010 | 9.5 | Fiscal sem SPED/EFD | **Parcial**: estrutura fiscal versionada (`fiscal_layouts`, migration `0115`) + validador **estrutural** de EFD (`server/src/fiscalEfd.ts`, `validarEfd`; rota `POST /api/fiscal/efd/validar`), com fonte oficial e vigência por período. **Não** transmite/assina/emite documento fiscal; homologação no PVA oficial é externa (BL-018). Provas: `fase9-5-fiscal-efd.test.ts`, `pg/fase9-6-enterprise-validation.test.ts`. Documento: `docs/fiscal/SPED-EFD-ARCHITECTURE.md` |
| BL-013 | 9.5 | `insumos.unidade` texto livre | **Parcial**: catálogo canônico de unidades + conversões **declaradas** por empresa (`unidades_medida`/`unidade_conversoes`, migration `0060`), com recusa entre grandezas e `null` sem regra. Valores históricos são **preservados** (não substituídos por unidade arbitrária); a resolução segura de legado permanece sinalizada pelo MRP (`conversao_ausente`). Provas: `estoque-unidades-medida.test.ts`, `pg/fase9-6-enterprise-validation.test.ts`. Documento: `docs/data/UNIT-OF-MEASURE-GOVERNANCE.md` |

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
