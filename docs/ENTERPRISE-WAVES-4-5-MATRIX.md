# ENTERPRISE WAVES 4–5 — MATRIZ DE CAPACIDADES

> Base: `main` @ `db80ebd` (Ondas 1–3 homologadas, preservadas).
> Branch: `openhands/enterprise-waves-4-5-final`.
> Data: 2026-10-30.
>
> **Status permitidos: `PASS` ou `BLOCKED`.** Uma capacidade só recebe `PASS`
> quando TODAS as colunas (DB, API, UI, Integração, Tenant, RBAC, Audit, Test,
> Jornada) estão comprovadas por código executado. Não há `PARTIAL`, `PLANNED`
> nem `FUTURE`.
>
> Regra de honestidade: nada é fabricado. Onde a operação depende de provedor
> externo (gateways, marketplaces, transportadoras, e-mail), a integração está
> **registrada e idempotente**, mas a homologação externa permanece separada —
> ver §Integração externa.

## Legenda das colunas

| Coluna | Significado |
| --- | --- |
| **DB** | Tabela(s) reais em `db/schema.sql` + `db/migrations`, com `empresa_id`. |
| **API** | Endpoints reais registrados em `server/src/index.ts`. |
| **UI** | Página real (padrão ZERO MODAL: `/recurso`, `/novo`, `/:id`, `/:id/editar`). |
| **Integração** | Consome/produz documentos de outros domínios existentes (sem sistema paralelo). |
| **Tenant** | Isolamento por `empresa_id` comprovado (A não vê B). |
| **RBAC** | Perfil mínimo aplicado no servidor e espelhado na UI. |
| **Audit** | Escrita em `auditoria`/outbox com ator, empresa e correlação. |
| **Test** | Teste de regressão executado (unitário + PG quando aplicável). |
| **Jornada** | Fluxo ponta a ponta exercitado. |

## Matriz D1–D8

| Código | Capacidade | DB | API | UI | Integração | Tenant | RBAC | Audit | Test | Jornada | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Customer Platform — CRM (cliente, contatos, interações, segmentos, consentimentos) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D1 | Customer 360 (pedidos, receita, LTV, tickets, canais) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D1 | Customer Service (tickets, SLA, prioridade, histórico, resolução) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D1 | CDP / Segmentação (RFM, canal, categoria, engajamento, abandono) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D2 | Campaigns (objetivo, público, orçamento, ROI/ROAS) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D2 | Marketing Automation (trigger→condição→ação→execução) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D2 | Loyalty (programa, níveis, pontos, resgate, expiração — idempotente) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D2 | Creators (perfil, campanha, parceria, afinidade, outreach manual) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D2 | Affiliate (tracking → order → attribution → commission → finance) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D3 | Data Platform (read models com empresa/origem/período/dimensão/métrica) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D3 | BI (receita, margem, pedidos, estoque, campanhas, creators) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D3 | Analytics (funil, cohort, retenção, churn, attribution) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D4 | AI Platform central (provider, modelo, prompt, custo, fallback, auditoria) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D4 | Inteligências (sales/customer/marketing/inventory/demand/commerce) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D5 | Demand Planning (histórico, sazonalidade, tendência, forecast, exceções) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D5 | Supply / MRP (demand→supply→MRP→procurement/manufacturing) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D5 | Replenishment (mín/máx, safety stock, lead time, forecast) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D5 | S&OP (demand→supply→capacidade→impacto→cenário→aprovação) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D6 | WMS (endereço, zona, put-away, picking, packing, wave, cycle count) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D6 | TMS (transportadora, modal, rota, shipment, tracking, SLA, ocorrência) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D6 | Supplier Collaboration (performance, OTIF, lead time, qualidade) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D7 | Accounting (plano de contas, lançamentos, períodos, balancete, DRE, conciliação) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D7 | Controlling (centro de custo/resultado, orçado, realizado, variação) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D7 | EPM (budget, actual, variance, forecast, scenario) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D7 | Assets (ativo, localização, manutenção, ordem, custo, histórico) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D7 | Projects (projeto, etapa, tarefa, orçamento, custo, cronograma) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D8 | Security (RBAC, tenant isolation, escalada, alçadas, auditoria, tokens) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D8 | Observability (structured logs, correlation/request/event/job id, retry) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D8 | Recovery (backup, restore, outbox replay, job/integration recovery) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D8 | API Governance (versionamento, erros, tenant scope, idempotência, paginação) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| D8 | Integration Governance (OAuth, webhook, outbox, retry, mapping, auditoria) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |

## Matriz E1–E5 (jornadas enterprise)

| Código | Jornada | Evidência | Status |
| --- | --- | --- | --- |
| E1 | CUSTOMER → COMMERCE → ORDER → PAYMENT → FINANCE → SERVICE → MARKETING → ANALYTICS | `d1-...`, `d2-d7-enterprise45.test.ts`, `pg-enterprise45.test.ts` | **PASS** |
| E2 | CAMPAIGN → CREATOR → TRACKING → ORDER → ATTRIBUTION → COMMISSION → FINANCE → ROI | `enterprise-creators.test.ts`, `pg-enterprise45.test.ts` | **PASS** |
| E3 | DEMAND → SUPPLY → MRP → PROCUREMENT/MANUFACTURING → WMS → TMS | `d2-d7-enterprise45.test.ts`, `pg-enterprise45.test.ts` | **PASS** |
| E4 | BUDGET → ACTUAL → VARIANCE → FORECAST → SCENARIO → MANAGEMENT | `d2-d7-enterprise45.test.ts`, `pg-enterprise45.test.ts` | **PASS** |
| E5 | DATA → AI → RECOMMENDATION → EVIDENCE → DECISION → AUDIT | `d2-d7-enterprise45.test.ts`, `pg-enterprise45.test.ts` | **PASS** |

## Correção desta execução (defeito de recurso órfão)

O executor anterior declarou `creator_matches` e `creator_outreach` como
recursos **públicos** em `resources.ts`, mas reverteu seus módulos de menu —
resultado: dois recursos sem dono funcional (2 erros bloqueantes na auditoria de
arquitetura). Correção aplicada:

1. `creator_matches` e `creator_outreach` reclassificados como **INTERNAL**
   (`internal: true`), no mesmo padrão de `creator_profiles`/`creator_partnerships`
   (contexto CREATORS, CRUD por handlers dedicados idempotentes).
2. CRUD dedicado em `server/src/creators.ts` para `match` e `outreach`
   (criação/edição validadas por domínio, idempotência por `Idempotency-Key`,
   auditoria por comando) + rotas em `server/src/index.ts`.
3. Páginas reais ZERO MODAL: `/matches` (afinidades) com parcerias manuais em
   `/matches/parcerias`; `/outreach-ai` (registro manual de contato).
4. `docs/ERP-3.0-CAPACITIES.json` aponta os testes das 4 capacidades de Creators
   para os arquivos reais.
5. Testes novos: `CreatorMatchesPage.test.tsx`, `CreatorOutreachPage.test.tsx`,
   caso de match/outreach em `server/test/enterprise-creators.test.ts`.

## Hardening desta execução (correção de defeitos reais encontrados na auditoria)

A matriz acima já refletia as capacidades implementadas; a auditoria final desta
execução encontrou **três defeitos reais** e os corrigiu com teste de regressão.
Nada foi fabricado: onde o produto depende de provedor externo, a homologação
externa permanece separada.

1. **Campo JSON sem editor (D1/D2/D4/D5, coluna UI).** Recursos públicos das
   Ondas 4–5 têm colunas JSONB editáveis (`customer_segments.regra`,
   `marketing_automations` condições, `ai_recommendations.evidencia`,
   `sop_scenarios`/`epm_scenarios` premissas). O `RecordForm` não conhecia o tipo
   `json`: caía no input de texto e o payload levava `"[object Object]"`.
   Correção: tipo `json` no `FieldType`, renderizador real (textarea JSON com
   validação de sintaxe) e `toPayload` que envia o OBJETO parseado (vazio →
   `null`). Provado por `client/src/components/RecordForm.json.test.tsx`.
   O contrato `contrato-tipo-coluna.test.ts` passou a reconhecer o renderizador
   (`CLIENTE_SUPORTA_JSON`), em vez de exigir `form: false`.

2. **Previsão de demanda contava o mês duas vezes (D5/E3, tenant).**
   `new Date(); setMonth(getMonth() - m)` transborda quando o dia é 29–31
   (31/10 → o mês corrente entrava duas vezes na série), dobrando o histórico e
   inflando a demanda. Defeito **pré-existente** (também falha na `main`), mas
   quebrava `multiempresa-p1` (P1 = 1). Correção: fixar o dia em 1 antes de
   recuar o mês. Regressão date-independente em
   `server/test/prediction-demanda.test.ts`.

3. **Gate `test:pg` lia o resumo no formato errado.** O parser esperava TAP
   (`# pass`), mas o Node 24 emite o reporter spec (`ℹ pass`) — o gate dava
   BLOCKED mesmo com 0 fail. Correção: aceitar os dois formatos.

### Evidência desta execução

| Verificação | Resultado |
| --- | --- |
| PostgreSQL 16.14 — `npm run test:pg` (banco novo) | **413/413 PASS**, 0 skip/todo — `ERP-03 GATE PASS` |
| Smoke E2E contra PostgreSQL novo (`smoke:pg`) | **398/398 OK** |
| Smoke E2E em memória (`smoke-e2e`) | **398/398 OK** |
| Testes do servidor (memória) | **1658 testes, 1582 pass, 0 fail, 76 skip** |
| Testes do cliente | **1067/1067 PASS** (123 arquivos) |
| `npm run typecheck` (domain + server + client) | PASS |
| `npm run build` | PASS |
| `npm run lint` | 0 erros (597 warnings `no-explicit-any`) |
| `architecture:audit` | 0 erros |
| `audit:menu` | 0 erros |
| `audit:ux` (zero-modal) | OK — nenhuma sobreposição em fluxo de módulo |
| `recovery:check` (backup restaura + idempotente) | PASS |
| `go-live:audit` | P0=0, P1=0, P2=0 (2 P3 informativos) |
| `commerce:go-live` | 42 OK, 0 falha |
| `payment:go-live` | PASS |

## Integração externa (não é homologação)

As integrações a seguir estão **implementadas e idempotentes no código**, mas
NÃO são declaradas homologadas: exigem credencial/ambiente oficiais, o que está
fora desta execução. Elas alimentam apenas `EXTERNAL_HOMOLOGATION_READY`.

| Integração | Estado no código | Homologação externa |
| --- | --- | --- |
| Mercado Pago | webhook assinado + outbox | PENDENTE (sem credencial) |
| PagBank | webhook assinado + outbox | PENDENTE (sem credencial) |
| Stripe | webhook assinado + outbox | PENDENTE (sem credencial) |
| Mercado Livre | conector + OAuth state | PENDENTE (sem credencial) |
| Nuvemshop | conector + OAuth state | PENDENTE (sem credencial) |
| Instagram/Meta | webhook `x-hub-signature-256` | PENDENTE (sem credencial) |
| Transportadoras | TMS + rastreio | PENDENTE (sem credencial) |

## Avisos classificados (não bloqueiam; P2/P3)

- `ROTA_SEM_MENU` para subrotas operacionais acessadas por link (ex.: `/loja*`,
  `/commerce/*`, `/matches/parcerias`): padrão de navegação por link, igual às
  subrotas pré-existentes (`/devolucoes/nova`). `audit:menu` sai com exit 0.
- `RECURSO_SEM_MENU` de `feriados`: dívida pré-existente, não das Ondas 4–5.
