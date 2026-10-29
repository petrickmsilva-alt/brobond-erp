# COMMERCE — ACEITAÇÃO FINAL (reconstruída a partir do código real)

> **Nota de 2026-10-29:** este documento é um retrato histórico. As antigas afirmações de `CODE_READY`/exit 0 não certificam a plataforma atual; credenciais presentes não são homologação. Para a decisão vigente, consulte [BROBOND-ENTERPRISE-FINAL-AUDIT.md](BROBOND-ENTERPRISE-FINAL-AUDIT.md).

> **Este documento foi reconstruído em 2026-10-29 a partir do código, dos testes
> e das execuções realizadas nesta rodada. Nenhum item aqui foi declarado sem
> ter sido executado; tudo que não pôde ser executado aparece como NÃO
> EXECUTADO com o motivo. Não substitui `npm test` — é a ficha de aceitação
> que aponta para a evidência de cada critério.**

- **Branch real do checkout:** `arena/dd9f70bb-brobond-erp`
- **HEAD:** `eaf6b6f31a16745e9b5e0f9813ac01a3abeef3a4` (= `origin/main`, commit único gravado do merge-base)
- **Referências obsoletas em documentos antigos:** `arena/de803fe9-brobond-erp`
  (não existe neste repositório) e `arena/d1b7a6e9-brobond-erp` (legada) — nenhum
  trabalho desta rodada foi feito nelas.

## 1. Vereditos do gate final

| Frente | Veredito | Como foi obtido |
| --- | --- | --- |
| `CODE_READY` | **SIM** | `npm run commerce:final-go-live` → 0 achados P0 e 1 de código; exit 0 |
| `EXTERNAL_HOMOLOGATION_READY` | **NÃO — `EXTERNAL_HOMOLOGATION_BLOCKED`** | 4/4 conectores sem credencial oficial utilizável (ver §4) |
| `FULL_GO_LIVE` | **NÃO** | `CODE_READY && EXTERNAL_HOMOLOGATION_READY` = falso; a falta de homologação externa **não** é mascarada |

## 2. Bateria de comandos (executada nesta rodada)

| Comando | Resultado real | Evidência |
| --- | --- | --- |
| `npm run typecheck` | **EXIT 0** (domain + server + client, 0 erros TS) | executado 2×, inclusive após o fix de `f.status` |
| `npm run test:server` | **EXIT 0 — 1521 testes, 0 fail, 0 todo, 68 skip** (68 = arquivos PG-only do job `testes-postgres`; enumerados 1 a 1, nenhum skip fora do conjunto PG) | processo `test-server-full-rerun-0c3df68a` |
| `npm run test:client` | **EXIT 0 — 108 arquivos / 986 testes, todos pass** (após os 12 novos arquivos de teste; rerun final de `npm test` §2.1) | processo `test-client-full-rerun-a32d190a` |
| `npm run lint` | **EXIT 0 — 0 erros, 591 warnings** (baseline era 588; warnings não bloqueiam e nenhum é de erro) | processos `lint-full-9555c359` / `lint-final-942c0f3c` |
| `npm run build` | **EXIT 0** — `vite build` ✓ 24.9s + PWA (153 entradas no precache) | processo `build-full-2fd56bdf` |
| `npm run audit:ux` | **EXIT 0** — "OK — nenhuma sobreposição nova em fluxo de módulo" (zero modal em Commerce) | execução direta |
| `npm run audit:menu` | **EXIT 0** — "✅ Sem erros" (infos `ROTA_SEM_MENU` = subrotas por link, comportamento esperado) | execução direta |
| `npm run architecture:audit` | **EXIT 0** — "✅ Sem erros de coerência" (warnings `TENANT_SEM_TESTE` listados no relatório) | execução direta |
| `npm run db:validate` (`prisma validate`) | **EXIT 0** — "The schema at prisma/schema.prisma is valid 🚀" | ver nota da §3 |
| `npm run smoke` | **EXIT 0 — 396/396 verificações OK** (inclui bloco `0058 COMMERCE` completo) | servidor demo porta 3001 + script |
| `npm run smoke:pg` | **EXIT 0 — 396/396 verificações OK contra PostgreSQL real** (banco novo `brobond_smoke_*` por execução) | processo `smoke-pg-gate-aac39739` |
| `npm run test:pg` | **EXIT 0 — `ERP-03 GATE PASS: 315 testes PostgreSQL reais; 0 fail/skip/todo`** em PG 16.14 (`server_version_num 160014`, banco novo com 0 relações na entrada) | processo `test-pg-gate-76115804` |
| `npm run commerce:go-live` | gate P0/P1/P2 existente — sem regressão nesta rodada | `scripts/commerce-go-live-audit.ts` |
| `npm run commerce:final-go-live` | **EXIT 0 — CODE_READY**, P0=0, P1=0; P2 listou só os 4 docs (agora criados); `EXTERNAL_HOMOLOGATION_BLOCKED` declarado | `scripts/commerce-final-go-live-audit.ts` |

### Nota da §3 — como `prisma validate` foi executado com rede bloqueada

O host `binaries.prisma.sh` **não é alcançável** neste ambiente (allowlist de
rede), então o CLI do Prisma falhava ao baixar `schema-engine`/`libquery_engine`
antes mesmo de validar. Execução real, sem mascarar nada:

1. `DATABASE_URL` definido + `PRISMA_SCHEMA_ENGINE_BINARY`/`PRISMA_QUERY_ENGINE_LIBRARY`/`PRISMA_QUERY_ENGINE_BINARY` = `/bin/false`
   (apenas pula o download impossível; se algum engine fosse **invocado**, `/bin/false`
   retornaria ≠ 0 e o comando falharia).
2. Resultado: **exit 0 + "The schema ... is valid 🚀"**.
3. **Prova negativa:** um `model` inválido acrescentado ao schema fez o mesmo
   comando sair com **exit 1** e o erro real `P1012`/`validate` — depois o schema
   foi restaurado byte a byte (`git diff` vazio). Ou seja: a validação roda
   (WASM embutido do Prisma `prisma_schema_build_bg.wasm`) e é genuína.

## 3. Critérios de aceitação por frente (P0)

| Critério | Evidência executada | Estado |
| --- | --- | --- |
| Publicação (fila → claim → publicar) | `smoke`/`smoke:pg` `0058 COMMERCE: publicação enfileirada (idempotente)` + `processador real da fila publica BROBOND (PUBLISHED)`; `server/test/pg/commerce-concorrencia.test.ts` (corrida 8×) | ✅ |
| Edição do catálogo (`PUT /api/commerce/produtos/:id`) | **Bug P0 corrigido nesta rodada:** projeção resolvida por `{ produto_id, empresa_id }` em `server/src/commerce/catalogo.ts`; coberto por `commerce-paineis-api.test.ts` (PUT decoy) e typecheck | ✅ |
| Catálogo (produtos, preços, grade, migração) | `db/migrations/0068_commerce_os.sql` (empresa_id em tudo); `commerce-oracle.test.ts`; `smoke 0058` produto → vitrine | ✅ |
| Pedidos (projeção idempotente por sale) | `garantirPedidoDaSale` (`pedidos.ts`) testado em `commerce-concorrencia.test.ts` + E2E `commerce-e2e.test.ts` no `test:pg` | ✅ |
| Checkout (serializable: pedido + reserva + venda) | `vitrine.ts` usa `s.transaction(..., { isolation: 'serializable' })`; E2E `commerce-e2e.test.ts` roda no `test:pg` (315/0/0/0) | ✅ |
| Reserva (motor canônico + regressão 25P02) | `criarReservaInterna`; **25P02 executado em PG real: 3/3** (`commerce-rollback-25p02.test.ts`: 23505 → rollback byte-idêntico; 409 → sem órfão; controle 5→4 PAID) | ✅ |
| Pagamento (gateway, confirmação, estados) | `gateway.ts` `processarEvento` + CAS `tryUpdateIf → status 'paga'`; `gateway-cadeia-pagamento-e2e.test.ts` no `test:pg` | ✅ |
| Webhook (assinatura, idempotência, erro visível) | `timingSafeEqual` (`gateway.ts:269`); `e01-gateway-webhook-postgresql.test.ts`; painel `GET /api/commerce/erros` + reprocessar (`commerce-paineis-api.test.ts`) | ✅ |
| Integração ERP (hooks + conversão) | `registrarHooksCommerce` e `processarComercioAgendado` no boot (`index.ts`); `commerce-oracle.test.ts` | ✅ |
| Tenancy | `0068` (empresa_id), `escopoDoAtor`, teste `p0-commerce-tenant.test.ts` (ingestão por empresa + lock serializado) | ✅ |
| RBAC | `resources.ts` (`commerce_publicacoes`, `devolucoes`, `minPerfil`); rotas do front com `<ModuleAccess>`; `commerce-paineis-api.test.ts` nega `/erros` a operador (403) | ✅ |
| Concorrência (PG real) | `commerce-concorrencia` (12) + `commerce-reentrega-concorrente` + 25P02 (3) executados dentro do `test:pg` **315 pass / 0 fail / 0 skip / 0 todo** | ✅ |
| Zero modal/drawer/sheet em Commerce | `audit:ux` EXIT 0 + gate `commerce:final-go-live` (scan `createPortal`/`role=dialog`/`aria-modal`/`<Modal|<Drawer|<Sheet` em `client/src/pages/commerce/**` não-teste) = 0 achados | ✅ |
| Zero placeholders em Commerce | scan `TODO/FIXME/coming soon/lorem` no gate = 0 achados em `client/src/pages/commerce` (não-teste) e `server/src/commerce` | ✅ |
| Regressão 25P02 | 3/3 em PG real (acima) | ✅ |

## 4. Frente externa (conectores) — NÃO mascarada

Credencial = token utilizável (`access_token IS NOT NULL` e status
`CONNECTED`/`SANDBOX_ACTIVE`) na tabela `connectors`, **ou** variável de
ambiente oficial correspondente. Valores nunca são impressos; nenhum segredo é
solicitado.

| Conector | Status na rodada | Motivo |
| --- | --- | --- |
| Mercado Livre | `CREDENCIAL_AUSENTE` | `MERCADOLIVRE_TOKEN` ausente + tabela `connectors` sem linha utilizável |
| Nuvemshop | `CREDENCIAL_AUSENTE` | sem credencial oficial homologada (`connectors` vazia) |
| Mercado Pago | `CREDENCIAL_AUSENTE` | sem credencial oficial (`GATEWAY_MP_API_BASE_URL`/token não configurados) |
| Instagram (Meta) | `CREDENCIAL_AUSENTE` | sem credencial oficial (webhook próprio com `x-hub-signature-256` existe, credencial não) |

→ **`EXTERNAL_HOMOLOGATION_BLOCKED`** (frente separada; alimenta apenas
`EXTERNAL_HOMOLOGATION_READY`, nunca mascara `CODE_READY`). Enquanto os 4
conectores não tiverem credencial oficial, **`FULL_GO_LIVE = NÃO`**.

## 5. Telas novas desta rodada (12 páginas + 13 rotas, todas com teste)

| Rota (`App.tsx`) | Página | Teste |
| --- | --- | --- |
| `commerce/publicacoes/novo` | `PublicacaoNovaPage` | ✅ |
| `commerce/publicacoes/:id/editar` | `PublicacaoEditarPage` | ✅ |
| `commerce/publicacoes/:id` | `PublicacaoDetalhePage` | ✅ |
| `commerce/ofertas` | `OfertasPage` | ✅ |
| `commerce/ofertas/novo` | `OfertaFormPage` | ✅ |
| `commerce/ofertas/:id/editar` | `OfertaFormPage` | ✅ |
| `commerce/ofertas/:id` | `OfertaDetalhePage` | ✅ |
| `commerce/pagamentos` | `PagamentosPage` | ✅ |
| `commerce/reservas` | `ReservasPage` | ✅ |
| `commerce/fulfillment` | `FulfillmentPage` | ✅ |
| `commerce/devolucoes` | `DevolucoesPage` | ✅ |
| `commerce/eventos` | `EventosPage` | ✅ |
| `commerce/erros` | `ErrosPage` | ✅ |

Todas envoltas em `<ModuleAccess moduleId=…>` do módulo pai correspondente
(sem novos módulos: `modules.test.ts` segue com os asserts 111/92/13/4/2 +
33 páginas especiais — inalterados e verdes).

**Bug encontrado e corrigido na auditoria desta rodada:** `DevolucoesPage`
enviava `?filter.status=`, que a rota genérica `GET /api/:resource` ignora
(só interpreta `?f.<coluna>=`). O filtro de status era silenciosamente inócuo.
Corrigido para `f.status` + teste de contrato novo (`DevolucoesPage.test.tsx`,
4/4).

## 6. O que NÃO foi executado (honesto)

- **Homologação oficial dos conectores** (OAuth real com credenciais dos
  marketplaces): não executada — sem credenciais no ambiente. Não é
  substituída por mock; `EXTERNAL_HOMOLOGATION_BLOCKED` registrada.
- **Nada além disso:** toda a bateria da §2 foi executada nesta rodada.
