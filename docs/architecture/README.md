# Arquitetura Brobond ERP 3.0 — índice

**Repositório:** `petrickmsilva-alt/brobond-erp`
**Escopo:** Blueprint arquitetural (Fase 0), fundação e governança (Fase 1) e
núcleo canônico de dados (Fase 2) do programa **Brobond ERP 3.0**.
**Natureza:** documentação de arquitetura **baseada em evidência de código**.
Todo número aqui é lido do repositório (`npm run architecture:audit`), nunca
digitado à mão.

> **Regra de honestidade (herdada de `docs/ERP-3.0-GAP-MATRIX.md`).** Este
> diretório separa três coisas que **não** podem ser confundidas:
> **o que existe hoje** (auditado), **a arquitetura-alvo** (decisão) e
> **o que falta** (gap com evidência e caminho de fechamento). Nada é
> declarado pronto por inspeção: quando a verificação não pôde ser executada,
> o item aparece como **BLOQUEADO**, nunca como "aprovado".

---

## 1. Como ler este diretório

| Camada | Documento | Pergunta que responde |
|---|---|---|
| **Estado atual** | [`CURRENT-STATE.md`](CURRENT-STATE.md) | O que o código é hoje, com números e evidências? |
| **Domínios** | [`DOMAIN-MAP.md`](DOMAIN-MAP.md) | Quais domínios existem, qual o estado de cada um e quais dependem de quem? |
| **Dependências** | [`DEPENDENCY-MAP.md`](DEPENDENCY-MAP.md) | Quem importa quem? Onde há acoplamento ou risco de ciclo? |
| **Fonte da verdade** | [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md) | Onde mora cada dado crítico, quem pode escrever e quem pode ler? |
| **Contextos** | [`CONTEXT-MAP.md`](CONTEXT-MAP.md) | Quais são os *bounded contexts* e seus contratos? |
| **Alvo** | [`TARGET-ARCHITECTURE.md`](TARGET-ARCHITECTURE.md) | Qual a arquitetura-alvo (Modular Monolith) e o que preservar/refatorar? |
| **Dados** | [`DATA-ARCHITECTURE.md`](DATA-ARCHITECTURE.md) | Como os dados são modelados, isolados e governados? |
| **Integrações** | [`INTEGRATION-ARCHITECTURE.md`](INTEGRATION-ARCHITECTURE.md) | Como o ERP fala com o mundo (WooCommerce, marketplaces, pagamentos, logística)? |
| **Segurança** | [`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md) | Autenticação, RBAC, tenancy, segredos, auditoria. |
| **Contratos de API** | [`API-CONTRACTS.md`](API-CONTRACTS.md) | Padrão de rota, payload, erro, paginação, idempotência. |
| **Eventos** | [`EVENT-CATALOG.md`](EVENT-CATALOG.md) | Catálogo real de eventos (outbox, hooks, webhooks). |
| **Decisões** | [`ADR/`](ADR/) | Architecture Decision Records numerados. |
| **Roadmap** | [`ROADMAP.md`](ROADMAP.md) | Plano de execução por fase, dependências e critérios de aceite. |
| **Riscos** | [`RISK-REGISTER.md`](RISK-REGISTER.md) | Riscos P0–P3, com evidência e mitigação. |
| **Loja nativa** | [`NATIVE-STORE-DECOMMISSION.md`](NATIVE-STORE-DECOMMISSION.md) | Plano de descontinuação da experiência pública `/loja`. |
| **Backlog** | [`MASTER-BACKLOG.md`](MASTER-BACKLOG.md) | Pendências entre fases (ID, fase, evidência, severidade, status). |

Documentos de **Fase 1** (fundação e governança):

- [`FOUNDATION-STANDARDS.md`](FOUNDATION-STANDARDS.md)
- [`TENANT-GOVERNANCE.md`](TENANT-GOVERNANCE.md)
- [`RBAC-MATRIX.md`](RBAC-MATRIX.md)
- [`AUDIT-STANDARD.md`](AUDIT-STANDARD.md)
- [`OBSERVABILITY-STANDARD.md`](OBSERVABILITY-STANDARD.md)
- [`API-STANDARDS.md`](API-STANDARDS.md)
- [`EVENT-STANDARDS.md`](EVENT-STANDARDS.md)
- [`DATABASE-MIGRATION-STANDARD.md`](DATABASE-MIGRATION-STANDARD.md)

Documentos de **Fase 2** (núcleo canônico de dados):

- [`CANONICAL-DATA-MODEL.md`](CANONICAL-DATA-MODEL.md)
- [`MASTER-DATA-GOVERNANCE.md`](MASTER-DATA-GOVERNANCE.md)
- [`ENTITY-OWNERSHIP.md`](ENTITY-OWNERSHIP.md)
- [`COMMERCIAL-IDENTITY.md`](COMMERCIAL-IDENTITY.md)
- [`OPERATIONAL-ANALYTICAL-SEPARATION.md`](OPERATIONAL-ANALYTICAL-SEPARATION.md)
- [`DATA-INTEGRITY-REPORT.md`](DATA-INTEGRITY-REPORT.md)
- [`DATA-MIGRATION-PLAN.md`](DATA-MIGRATION-PLAN.md)
- [`DATA-QUALITY-REPORT.md`](DATA-QUALITY-REPORT.md)
- [`NATIVE-STORE-DECOMMISSION-REPORT.md`](NATIVE-STORE-DECOMMISSION-REPORT.md)

Documentos de **Fases 6–9** (commerce, CRM, BI/Control Tower, integridade, UX):

- [`../FASE-8-BI-AI-CONTROL-TOWER.md`](../FASE-8-BI-AI-CONTROL-TOWER.md)
- [`../FASE-9-INTEGRIDADE-CRM-UX.md`](../FASE-9-INTEGRIDADE-CRM-UX.md)

---

## 2. Relação com a documentação existente

Este diretório **não substitui** a documentação histórica do repositório. Ele
a **consolida** e aponta para ela:

| Documento existente | Papel | Relação |
|---|---|---|
| `docs/ERP-3.0-ARCHITECTURE-BASELINE.md` | Fotografia verificável do estado atual | Fonte dos números; `CURRENT-STATE.md` resume e referencia |
| `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` | Inventário gerado por `architecture:audit` | Fonte automática dos números |
| `docs/ERP-3.0-GAP-MATRIX.md` | Gaps abertos/fechados por rodada | Base do `MASTER-BACKLOG.md` e `RISK-REGISTER.md` |
| `docs/ERP-3.0-DUPLICITY-AUDIT.md` | Classificação de duplicidades | Base do `ENTITY-OWNERSHIP.md` |
| `docs/ERP-3.0-MASTER-DATA-AUDIT.md` | Auditoria de master data | Base do `MASTER-DATA-GOVERNANCE.md` |
| `docs/ADR-001..008-*.md` | ADRs históricos | Migrados/referenciados em `ADR/` |
| `docs/AGENTE-06-*.md`, `docs/AGENTE-07-*.md` | Unificação comercial | Base de `COMMERCIAL-IDENTITY.md` |
| `docs/ESTOQUE-CANONICO.md` | Estoque canônico | Base de `DATA-ARCHITECTURE.md` §estoque |
| `docs/LOGISTICA-MOTOR-MULTICANAL.md` | Motor de logística | Base de `INTEGRATION-ARCHITECTURE.md` |
| `docs/architecture/payment-engine.md` | Payment Engine | Base de `INTEGRATION-ARCHITECTURE.md` |

**Hierarquia de autoridade em caso de divergência:** código executável
(`db/schema.sql` + `db/migrations/*.sql` + `server/src/*` + `client/src/*`) >
inventário gerado (`architecture:audit`) > este diretório (alvo) >
documentação histórica. A divergência entre um e outro **é** um gap e deve ser
registrada, não resolvida por decreto.

---

## 3. Sumário do estado (Fase 0)

Números lidos de `npm run architecture:audit` na baseline desta fase:

| Dimensão | Valor |
|---|---:|
| Migrations SQL | 104 |
| Migrations Prisma | 7 |
| Tabelas SQL | 212 (192 com `empresa_id`) |
| Índices / constraints | 580 / 386 |
| Recursos de API | 174 (156 multiempresa) |
| Cobertura de tenant | 89,7% dos recursos com tabela |
| Recursos com RBAC restrito | 80 |
| Módulos de navegação | 144 (11 áreas, 35 grupos) |
| Rotas HTTP | 474 |
| Modelos Prisma | 11 (5 com `empresaId`) |
| Casos de teste declarados | 3.578 em 427 arquivos |

> Números lidos do código por `npm run architecture:audit` na revisão atual
> (Fases 0–2). A cobertura de `empresa_id` é **192/212** (a Fase 1 corrigiu um
> falso positivo do parser de DDL que reportava 184). Ver a reconciliação em
> `CURRENT-STATE.md §2`.

**Veredito da Fase 0:** o ERP já é, na prática, um **Modular Monolith** com
domínios bem delimitados, multi-tenancy real e fonte de verdade SQL-first. A
missão das Fases 1 e 2 **não** é reescrevê-lo, e sim **consolidar, formalizar e
provar** o que existe, fechando as lacunas de governança e de dados identificadas
neste blueprint.

### 3.1 Delta após a Fase 2

Números relidos de `npm run architecture:audit` ao fim da Fase 2:

| Dimensão | Fase 0 | Fase 2 | Δ |
|---|---:|---:|---:|
| Migrations SQL | 103 | **104** | +1 (`0104_crm_integridade_multempresa.sql`) |
| Tabelas SQL | 212 | 212 | — |
| Tabelas com `empresa_id` | 184¹ | **192** | correção do parser de DDL (Fase 1) |
| Tabelas sem `empresa_id` (classificadas) | 28¹ | 20 | correção do parser de DDL (Fase 1) |
| Índices | 570 | **580** | +10 (E4.2 do CRM) |
| Constraints | 386 | 386 | — |
| Casos de teste declarados | 3.533 | **3.578** | +45 (Fases 1 e 2; +13 na revisão) |

> ¹ A baseline da Fase 0 reportava 184 tabelas com `empresa_id` e 28 sem. Era um
> **falso positivo do parser de DDL** (perdia colunas *inline*): as 8 tabelas
> `payment_*` **têm** `empresa_id`. A Fase 1 corrigiu o parser e adicionou teste
> de regressão (`server/test/arquitetura-audit-parser.test.ts`). O banco nunca
> mudou nesse ponto — só a leitura.

> O `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` é **regenerado** por
> `npm run architecture:audit`; quando o número de casos muda, o arquivo é
> commitado junto (regra do `AGENTS.md`).

---

## 4. Escopo desta missão

- **Fase 0** — auditoria + blueprint (este diretório). **Sem** refatoração
  funcional e **sem** alteração de banco.
- **Fase 1** — fundação e governança (padrões + implementação mínima + testes).
- **Fase 2** — núcleo canônico de dados + descontinuação da loja pública nativa
  `/loja`. **Status:** o núcleo de dados foi entregue; a **retirada da `/loja`
  não foi executada** (bloqueada por ambiente/decisão) — ver
  [`NATIVE-STORE-DECOMMISSION-REPORT.md`](NATIVE-STORE-DECOMMISSION-REPORT.md) e
  `MASTER-BACKLOG.md` (BL-015). A superfície nativa **ainda está ativa**.

**Fora de escopo (por decisão do Diretor):** microserviços, reescrita do ERP,
migração integral para Prisma, cutover comercial, ativação de integrações
externas, alteração de DNS e qualquer operação destrutiva em produção.

---

*Gerado na Fase 0 do programa ERP 3.0. Próximo documento sugerido: [`CURRENT-STATE.md`](CURRENT-STATE.md).*
