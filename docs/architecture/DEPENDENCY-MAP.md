# DEPENDENCY-MAP — dependências e acoplamento (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Método:** análise estática de `import` em `server/src`, `modules/`,
`packages/` e `client/src` (grep por caminho de import).

> **Regra.** Um módulo pode depender de outro por **contrato** (tipo, serviço,
> evento). Acesso direto a **tabela interna** de outro domínio exige
> justificativa e contrato documentados (ver `CONTEXT-MAP.md` §contratos).

---

## 1. Grafo de alto nível

```
                       ┌────────────────────────────┐
                       │ packages/domain            │  (tipos puros, sem I/O)
                       │ packages/infra             │  (infra compartilhada)
                       └──────────────┬─────────────┘
                                      │ (tipos)
   ┌──────────────────────────────────┼───────────────────────────────────┐
   │                                  ▼                                   │
   │   server/src (ERP: resources, store, services, empresa, auth, ...)   │
   │        ▲                                    │                        │
   │        │ infra reusada (getStore/getResource)│ monta routers          │
   │        │                                    ▼                        │
   │   modules/logistics · modules/payments · modules/connectors          │
   │        (bounded contexts: domain/application/infrastructure/api)     │
   └──────────────────────────────────────────────────────────────────────┘
                                      │ HTTP
                                      ▼
                              client/src (SPA)
```

---

## 2. Dependências reais (verificadas)

### 2.1 `server/src` → `modules/*` (o ERP monta os routers dos contextos)

| Origem | Destino | Contrato |
|---|---|---|
| `server/src/index.ts` | `modules/payments/api/routes` (`paymentsRouter`, `checkoutMethods`) | Router Express |
| `server/src/index.ts` | `modules/logistics/api/routes` (`logisticsRouter`) | Router Express |
| `server/src/index.ts` | `modules/logistics/api/webhookRouter` | Router público assinado |
| `server/src/scheduled.ts` | `modules/connectors` (ingestão) | serviço de ingestão |
| `server/src/commerce/{pedidos,vitrine,notificacoes,estado-loja}.ts` | `modules/payments`, `modules/connectors` | serviço |
| `server/src/financeiroPeriodos.ts`, `backup.ts`, `connectors.ts` | `modules/*` | serviço |

### 2.2 `modules/*` → `server/src` (infra compartilhada reusada)

Os bounded contexts **reusam** a infraestrutura do ERP em vez de reimplementá-la
(decisão explícita de "não criar sistema concorrente"):

| Origem | Destino | O que reusa |
|---|---|---|
| `modules/logistics/infrastructure/*` | `server/src/{services,resources,store,empresa,errors,utils}` | `getStore`, `getResource`, `EMPRESA_PADRAO`, `HttpError`, `round2` |
| `modules/logistics/infrastructure/config.ts` | `server/src/{segredos,configuracoes,logistica}` | cifra AES-256-GCM + config |
| `modules/logistics/infrastructure/webhookInbox.ts` | `server/src/commerce/outbox` | `enfileirarOutbox` |
| `modules/payments/*` | `server/src/{services,store,resources,errors}` | store + tipos |
| `modules/connectors/*` | `server/src/{services,store,resources}` | store + tipos |

> **Avaliação de risco:** este acoplamento é **deliberado** e **unidirecional em
> camadas**: os contextos dependem da **infraestrutura** do ERP
> (`store`/`resources`/`segredos`), nunca das **regras de negócio** de um
> módulo de ERP específico. É o padrão correto de um Modular Monolith que quer
> permitir extração futura: a infraestrutura é o "kernel" compartilhado.
> **Risco:** se um módulo passar a importar regra de negócio de outro módulo, a
> fronteira se rompe. Ver §3.

### 2.3 `client/src` → `server` (somente via HTTP)

O front **não** importa código do servidor. Toda integração é por `/api/*`.
Evidência: `client/src/lib/*` (cliente HTTP); **0** ocorrências de
`process.env` no front (verificado em `RELATORIO-PR95`).

---

## 3. Riscos de acoplamento e ciclos

| Risco | Evidência | Avaliação | Mitigação (alvo) |
|---|---|---|---|
| `server/src/services.ts` importado por **100** arquivos | `grep -rl services.ts` | Alto fan-in, mas é o **kernel** (store + RBAC). Esperado em monólito. | Manter como kernel; proibir regra de negócio nova nele |
| `server/src/empresa.ts` importado por **81** arquivos | `grep -rl empresa.ts` | Idem — tenancy é transversal por desenho | Manter |
| `negocios.ts` ↔ `services.ts`/`itens.ts` | `eventosVenda.ts` existe **por causa** do risco de ciclo | **Ciclo evitado por módulo-folha** | Padrão a preservar: anunciante folha (`eventosVenda.ts`, `sale-events.ts`) |
| `modules/*` → `server/src/*` | §2.2 | Fronteira controlada (infra) | Proibir import de regra de negócio entre módulos |
| Dois caminhos de ingestão WooCommerce (`loja.ts` legado + `commerce/woocommerce/`) | `loja.ts`, `commerce/woocommerce/` | **Legado em coexistência** | Runbook Agente 07 (`docs/AGENTE-07-RUNBOOK-CUTOVER-LEGADO-MULTISTORE.md`) |
| Dois padrões de eventos (`commerce_outbox` + hooks em memória `eventosVenda`/`sale-events`) | `commerce/outbox.ts`, `eventosVenda.ts` | Complementares: outbox = integração externa confiável; hook = projeção interna *best effort* | Documentado em `EVENT-CATALOG.md` |

### 3.1 Sem ciclos detectados nas fronteiras de domínio

Não foi encontrado import circular entre domínios de negócio: os pontos de
acoplamento concentram-se em `services.ts`/`empresa.ts`/`store.ts`
(kernel) e nos módulos-folha de eventos. O único risco histórico de ciclo
(`negocios` ↔ `itens`) já está **resolvido por desenho** com `eventosVenda.ts`.

---

## 4. Dependências de runtime e infraestrutura

| Dependência | Uso | Config |
|---|---|---|
| PostgreSQL | base transacional | `DATABASE_URL` (`db/schema.sql` + migrations) |
| Redis | coordenação de lock distribuído (cron/outbox) | variáveis de ambiente; fallback seguro |
| Render | deploy (web + cron) | `render.yaml` |
| `psql` (cliente) | testes PG de wrapper E4.2 | CI instala `postgresql-client-16` |
| Prisma CLI | `prisma validate`/`migrate` (bounded context) | `prisma/schema.prisma` |

**Toda variável de ambiente lida no código precisa de linha em
`docs/auditoria/matriz-configuracao-producao.md`** (teste
`config-inventario-producao` trava isso) — e toda chave do `render.yaml`
também. Isso é uma dependência de governança que a Fase 1 deve preservar.

---

## 5. Direção permitida de dependências (alvo)

```
client  ──HTTP──►  server (api)  ──►  server (application/domain)
                         │                     │
                         ▼                     ▼
                 modules/* (api)  ──►  modules/* (application)  ──►  domain
                         │
                         └──►  kernel compartilhado (store/resources/empresa/segredos)

PROIBIDO:
  • domínio de um módulo importar regra de negócio de outro módulo
  • client importar código do server
  • módulo escrever direto em tabela interna de outro domínio sem contrato
  • publicar evento antes do commit da transação de origem
```

---

*Próximo documento: [`SOURCE-OF-TRUTH.md`](SOURCE-OF-TRUTH.md).*
