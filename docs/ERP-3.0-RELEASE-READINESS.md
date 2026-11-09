# BROBOND ERP 3.0 — RELEASE READINESS (Fases 0–8)

**Branch:** `fix/aud-01-production-release`
**Base:** `main` @ `9506ed2` (Merge PR #125 — Fase 8 BI/AI Control Tower)
**Data:** 2026-11-09

> Este documento substitui o esperado `docs/ERP-3.0-MASTER-ARCHITECTURE-AUDIT.md`,
> que **não existe** no repositório. Os achados AUD-01, SEC-01 e TEST-01 foram
> re-derivados diretamente do código no HEAD atual.

---

## A. Correções

### AUD-01 — Transições de alerta devolviam HTTP 405 para todo ator

**Causa raiz.** Os handlers de reconhecer/resolver/silenciar alerta
(`server/src/alerts.ts`) usavam `checkAccess(getResource('alert_events'), actor, 'update')`.
O recurso `alert_events` (Fase 8) declara `ops.update = false` — o CRUD genérico
(`PUT /api/alert_events/:id`) não pode editar uma ocorrência, e `checkAccess`
honra essa flag. Resultado: **HTTP 405** para qualquer perfil, inclusive
gerente/admin autorizados, tornando o fluxo de alertas inoperável.

**Correção.** Os três handlers passam a usar `checkFluxoEscrita(r, actor, 'update')`
— o helper canônico dos *endpoints de fluxo* (o mesmo padrão de `expedicao.ts`,
`fiscal.ts`): confere a **mesma alçada** (autenticação, `minPerfil`, RBAC
comercial, `minPerfilEscrita`) **sem** consultar `ops`. O CRUD genérico continua
fechado (`ops.update = false`), portanto `PUT/PATCH/POST/DELETE` em
`/api/alert_events` seguem recusados (405).

**Arquivos modificados**

- `server/src/alerts.ts` — importa `checkFluxoEscrita`; 3 handlers trocam a guarda.
- `server/test/aud-01-alertas-transicoes-http.test.ts` — **novo**, 12 casos HTTP.

**Evidência.** Suíte HTTP real (express + `requireAuth` com JWT/sessão) cobre
gerente 200, admin 200, operador 403, anônimo 401, inexistente 404, outra empresa
404 (sem vazar existência), `empresa_id` forjado sem acesso cruzado, transição
inválida 400, idempotência (data da 1ª transição preservada), auditoria com autor,
CRUD genérico 405 e concorrência. Reintroduzir o defeito reprova 9 dos 12 casos
(mutação verificada).

### SEC-01 — Customer Platform ignorava a carteira do representante

**Causa raiz.** `server/src/service.ts` lia `clientes`/`vendas` filtrando apenas
por `empresa_id` em `customer360`, `avaliarSegmento` e `analiseRfm`, ignorando
`escopo.carteira`. Um usuário **representante** (perfil operador vinculado por
`representantes.usuario_id`) enxergava a empresa inteira — furando o recorte
A06-14 que `listRecords` já aplica em `/api/clientes`. Endpoints afetados:
`GET /api/customer360/:id` (vazava cliente de outra carteira, 200) e
`GET /api/customer-segments/rfm` (incluía compras de outras carteiras).
`GET /api/customer-segments/:id/avaliar` já era barrado por RBAC (`customer_segments`
exige gerente), mas recebeu o recorte por defesa em profundidade.

**Correção.** Helper `clientesDaCarteira(escopo, rows)` aplica `idCarteiraDoEscopo`
+ comparação com `clientes.representante_id`; `customer360` passa a usar
`foraDaCarteira` (404, sem vazar existência). Admin/gerente/consolidado/operador
sem vínculo **não** são recortados — a regra A06-14 é preservada.

**Arquivos modificados**

- `server/src/service.ts` — import `foraDaCarteira`/`idCarteiraDoEscopo`, helper e 3 aplicações.
- `server/test/sec-01-carteira-customer-platform-http.test.ts` — **novo**, 5 casos com 2 empresas e 2 representantes.

**Evidência.** Teste HTTP real com duas empresas e representantes distintos:
representante recebe 404 para cliente de outra carteira e não vê compras alheias
no RFM; gerente/admin continuam vendo a empresa inteira (e não a outra empresa);
operador sem vínculo não é recortado. Mutações (remover o recorte) reprovam 2 casos.

### TEST-01 — Gate `go-live:audit` tratava "existe arquivo de teste" como aprovação

**Causa raiz.** O gate verificava a **estrutura** (arquivo/módulo canônico existe),
mas **nunca executava** os testes de autorização HTTP. Um P1 real (AUD-01) passava
com P0/P1/P2 = 0.

**Correção.** Novo `scripts/gate-testes.mjs` **executa** os testes obrigatórios
pelo runner real e classifica em aprovado / falho / ignorado / **não executado**.
`scripts/final-go-live-audit.ts` passa a consumir o resultado: `fail > 0` ou
nenhum teste executado (falta de evidência) vira **P1 bloqueante**; `skipped`
nunca é somado aos aprovados.

**Arquivos modificados**

- `scripts/gate-testes.mjs` — **novo**.
- `scripts/final-go-live-audit.ts` — integra o executor e reporta a contagem.
- `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` — regenerado (`architecture:audit`), casos de teste 2559→2576.

**Evidência.** Reintroduzir o defeito AUD-01 faz o gate reportar
`TESTES_AUTORIZACAO_REPROVADOS` + `TESTE_AUTORIZACAO_FALHO` (P1, 10 achados) e
sair com **exit 1**; com a correção, `veredito: PASSOU` e exit 0.

---

## B. Testes

| Suíte / gate | Comando | Resultado |
|---|---|---|
| Typecheck (domínio + server + client) | `npm run typecheck` | **0 erros** |
| Testes do servidor | `npm --workspace server test` | **2348 pass / 0 fail / 93 skipped** (2441 casos) |
| Testes do cliente | `npm --workspace client test` | **1180 pass** (138 arquivos) |
| Lint | `npm run lint` | **0 errors** (623 warnings — baseline) |
| Build | `npm run build` | **OK** |
| Menu audit | `npm run audit:menu` | sem erros |
| UX audit | `npm run audit:ux` | OK (zero modal) |
| Architecture audit | `npm run architecture:audit` | sem erros |
| Commerce gate | `npm run commerce:go-live` | P0 41 ok / 0 falhas |
| **Go-live gate** | `npm run go-live:audit` | **P0/P1/P2 = 0; P3 = 2; testes de autorização 17 pass / 0 fail** |

- **Regressão:** baseline do servidor 2331 pass → 2348 pass (**+17**, os novos
  casos), `fail` 0 → 0, `skipped` 93 → 93. Nenhuma regressão.
- **Ignorados:** 93 (inalterado vs. baseline; **não** contabilizados como aprovados).
- **Não executados no gate:** 0.
- **Gate PostgreSQL:** indisponível neste sandbox (sem daemon Docker / sem
  `DATABASE_URL` de banco vazio PG 16.14). Executar `npm run test:pg` no ambiente
  com o container `postgres:16.14` antes do merge (ver CI `testes-postgres`).

---

## C. Git

- **Branch:** `fix/aud-01-production-release`
- **Base:** `main` @ `9506ed2`
- **PR:** #126
- **Commits:** `20f6202` (AUD-01/SEC-01/TEST-01), `5735ec6` (SEC-01 `sem_compra`)
- **Merge SHA:** pendente
- **HEAD da main:** pendente de CI

---

## D. Render

| Item | Valor |
|---|---|
| Serviço | `brobond-erp` (web, único: a API Express também serve o front buildado) |
| Root | `.` (monorepo) |
| Build | `npm install --include=dev && npm run build` |
| Start | `npm --workspace server start` |
| Health check | `/api/health` |
| Branch de deploy | `main` (autoDeploy padrão do Render para blueprint) |
| Banco | PostgreSQL externo via `DATABASE_URL` (sync:false, painel) |
| Migrations | aplicadas pela própria API no boot (`aplicarMigrationsVersionadas`) |

**Deploy:** BLOQUEADO neste ambiente — sem CLI do Render, sem token/API e sem
egress para `brobond-erp.onrender.com` (`curl` → HTTP 000). O deploy deve ser
executado pelo operador (automático após merge, ou pelo painel). Sem comandos
manuais de migration: o boot da API aplica as pendentes.

---

## E. Banco

- **Mecanismo real:** `schema_migrations` (id TEXT PK, `aplicado_em`) + ordem
  léxica dos arquivos `db/migrations/*.sql`, cada um em **transação única**
  (DDL/DML + registro no mesmo commit; rollback total em falha; retry reexecuta).
- **Migrations 0110/0111/0112:** aditivas e idempotentes (`IF NOT EXISTS`,
  `ON CONFLICT`, `DO $$`), **sem** `DROP TABLE/COLUMN`, `TRUNCATE`, `DELETE` ou
  `ALTER ... TYPE`. FKs/índices presentes (0110: 2 FK/5 idx; 0112: 6 FK/6 idx).
- **Espelho em `db/schema.sql`:** `alert_events`, `alert_rules`,
  `commerce_reconciliacao`, `customer_consents`, `loyalty_movements` presentes.
- **Backup:** NÃO comprovável neste ambiente (sem acesso ao banco de produção).
  **Pré-requisito de deploy:** confirmar backup recente e restaurável antes do merge.

---

## F. Integrações externas

Inventário (código implementado; ativação por flag — **nada ativado neste release**):

| Integração | Código | Config (painel) | Estado |
|---|---|---|---|
| WooCommerce multi-store (RETAIL/WHOLESALE) | ✅ | `WOOCOMMERCE_*` (sync:false) | desligado por flag; webhook por loja fail-closed |
| Mercado Livre / Nuvemshop | ✅ | `MERCADOLIVRE_*`, `NUVEMSHOP_*` | desligado |
| Mercado Pago / gateway | ✅ | `MERCADOPAGO_*` | desligado |
| Motor de logística | ✅ | `LOGISTICS_ENABLED` (sync:false) | modo seguro (desligado) |
| SMTP / WhatsApp Cloud | ✅ | `SMTP_*`, `WHATSAPP_*` | desligado sem credencial |
| Meta/Marketplaces (publicação) | ✅ | — | não presumido; sem cutover |

Pendência: homologação externa de cada conector permanece sob autorização
específica — fora do escopo deste release.

---

## G. Produção

**Smoke tests:** NÃO EXECUTADOS — sem egress para produção neste sandbox
(`curl https://brobond-erp.onrender.com/api/health` → HTTP 000) e sem acesso ao
painel do Render. Após o deploy, executar o checklist (login/sessão/permissões,
`/alertas`, RBAC, tenant scope, logs sem secrets) **sem** transicionar alertas
reais de operação.

---

## H. Resultado final

**MERGE BLOQUEADO** neste ambiente — não por falha de código (todos os gates
locais passaram), mas por **evidências de produção indisponíveis**: sem acesso ao
Render, sem egress para produção e sem backup comprovável. Conforme a ordem:
*"SE QUALQUER GATE CRÍTICO FALHAR, INTERROMPA A IMPLANTAÇÃO."*

**Pendências para autorizar merge + deploy:**

1. CI verde no PR (jobs `verificar` e `testes-postgres`, Node 24).
2. `npm run test:pg` com PostgreSQL 16.14 em banco **vazio**.
3. Backup de produção recente e restaurável confirmado.
4. Egress/painel do Render para acompanhar deploy e rodar os smoke tests.

**Critérios de código (atendidos):** AUD-01 corrigido; SEC-01 corrigido; gate
fortalecido e aprovado; migrations revisadas (aditivas/idempotentes); zero P0; zero
P1 conhecido; nenhuma regressão crítica; CRUD genérico continua protegido; tenant
scope aprovado.
