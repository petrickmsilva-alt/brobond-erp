# ETAPA 04 — COMMERCE & INTEGRATION READINESS (P1)

**Data:** 2026-11-14 · **Branch:** `arena/20369110-brobond-erp`
**Método:** leitura dos adaptadores reais + gates executados + testes PG.
**Regra:** nenhuma afirmação de operação externa sem evidência; credencial
ausente no executor ≠ credencial ausente no cliente (banco de produção
inacessível). Estados: `CODE_READY` → `PROVIDER_CONFIGURED` →
`EXTERNAL_HOMOLOGATION` → `FULL_GO_LIVE`.

## 1. Matriz por conector/provedor REALMENTE presente no código

| Integração | API/Auth | Webhook (assinatura) | Idempotência | Retry/Outbox | Reconciliação | Observabilidade | Testes locais | Homologação externa | Estado |
|---|---|---|---|---|---|---|---|---|---|
| **WooCommerce** (RETAIL/WHOLESALE) | REST v3, Basic over HTTPS, credencial por loja (`cliente.ts`); SSRF-guard | HMAC-SHA256 base64 sobre bytes crus (`webhookSeguranca.ts`) + rate-limit de flood | inbox `(empresa, store, delivery_id)` único; replay=duplicado (provado Etapa 02) | outbox com backoff/MAX_TENTATIVAS; ERRO≠BLOQUEADO≠OBSOLETO | `reconciliacao.ts` (preço/estoque/identidade, fingerprint por empresa) | painel `/commerce` + erros visíveis | multistore, webhooks-reconciliacao, publicação/adoção por SKU, PG e2e | **NÃO COMPROVADA** | **CODE_READY** (estrutura); loja real brobond.com.br não acessada |
| **Mercado Livre** | OAuth2 authorization_code + refresh 6h (`exchangeMercadoLivreCode`/`refresh…`); token estático legado SÓ com contrato declarado (ADR-005) | handlers unificados (`connector_events`, dedupe por id) | inbox durável `connector_events` | varredura de recuperação de pendentes | `reconciliacaoMercadoLivre.ts` + leitura de anúncios | painel conectores | `connectors.test.ts`, p0-commerce-tenant, ingestão PG | **NÃO COMPROVADA** (MERCADOLIVRE_TOKEN ausente no executor) | **CODE_READY** |
| **Nuvemshop** | OAuth2 authorization_code → token permanente; header `Authentication: bearer`; user_id = loja | `x-linkedstore-hmac-sha256` sobre bytes crus | inbox durável | recuperação de pendentes | via ingestão/projeção | painel conectores | testes de conector + gate escrita 2025-03 (ADR-006) | **NÃO COMPROVADA** | **CODE_READY** |
| **Mercado Pago** (connector) | token colado pelo operador (sem OAuth redirect) | manifesto HMAC `x-signature` | inbox durável | recuperação | — | painel | testes webhook/tenant | **NÃO COMPROVADA** | **CODE_READY** |
| **Meta/Instagram** | Facebook Login for Business (Graph, OAuth, redirect allowlist) | `hub.challenge` + `x-hub-signature-256` | inbox durável | recuperação | — | painel | testes instagram graph/webhook | **NÃO COMPROVADA**; limitação Graph API documentada (REJECTED em capabilities) | **CODE_READY** (ingestão); Shopping depende de aprovação Meta |
| **Mercado Pago** (payments provider) | access token por empresa (cifrado) | assinatura + segredo dedicado | payment_intents + eventos CAS | engine + outbox | settlement/payout/disputas (estrutura) | Payment Engine painel | payment-engine, webhook-pipeline, PG operações | **NÃO COMPROVADA** | **CODE_READY** |
| **PagBank** | access token por empresa | segredo webhook dedicado (ADR-004) | idem | idem | idem | idem | pagbank-webhook-* (5 arquivos), PG | **NÃO COMPROVADA**; **só PIX** implementado (cartão/boleto exigem contratos PCI) | **CODE_READY** (PIX) |
| **Stripe** | secret key por empresa | assinatura oficial | idem | idem | idem | idem | payment-engine + registry | **NÃO COMPROVADA**; Checkout Sessions/PaymentIntents; opt-in da conta obrigatório | **CODE_READY** |
| **WhatsApp** (status) | webhook verificação + status de mensagem | verify token | eventos gravados | — | — | painel | whatsappStatus | **NÃO COMPROVADA** | **CODE_READY** (status; não é envio) |
| **Logística: Melhor Envio / Correios** | token/credenciais por empresa (cifradas) | webhook inbox logístico | `logistics_webhook_inbox` | jobs + reconciliação | tracking/reconciliation | painel logística | logistics-* | **NÃO COMPROVADA**; **Correios sem SIGEP** (`nao_configurado` explícito) | **CODE_READY** (cotação/etiqueta ME); Correios parcial |
| **manual / generic / testing** (payments) | — | — | — | — | — | — | test-only (`NODE_ENV=test`) | n/a — **não é homologação** | internos |

**Frente externa (gate `commerce:final-go-live`, executado):** mercadolivre
`CREDENCIAL_AUSENTE` (env do executor); nuvemshop/mercadopago/instagram
`NAO_VERIFICAVEL` (sem DATABASE_URL de produção). **Nenhum** operou contra o
parceiro nesta missão (egress restrito). Todos: `EXTERNAL_HOMOLOGATION` **pendente**.

## 2. Jornada comercial ponta-a-ponta (14 passos) — evidência INTERNA

Cadeia verificada por testes reais executados nesta missão (gate PG 500/500 +
smoke:pg 398/398), não por simulação de parceiro:

| # | Passo | Evidência interna | Externo |
|---|---|---|---|
| 1 | Produto ERP → projeção catálogo | `commerce-e2e.test.ts` (PG) | — |
| 2 | Preço por canal/condição (motor) | `commerce-motor-precos` (14/14), preço mínimo/cumulativo | — |
| 3 | Publicação enfileirada (outbox, claim) | `commerce-concorrencia` (PG, corrida 8×), smoke 0058 | — |
| 4 | Publicação no canal (adapter) | testes com HTTP fake do canal (multistore, PUT/adoção por SKU) | **pendente** (loja real) |
| 5 | Pedido externo → inbox/webhook assinado | `woocommerce-webhooks-reconciliacao`, `e01-gateway-webhook-postgresql` (PG) | **pendente** (entrega real) |
| 6 | Ingestão idempotente → `sales` | `pg/commerce-e2e`, reentrega concorrente (PG) | — |
| 7 | Checkout interno serializable (pedido+reserva) | `pg/commerce-e2e`, rollback 25P02 (PG) | — |
| 8 | Reserva de estoque canônico | `criarReservaInterna` + concorrência PG | — |
| 9 | Pagamento (engine → provider) | `payment-engine.test.ts`, cadeia gateway PG | **pendente** (transação sandbox/real) |
| 10 | Webhook pagamento → PAGO (CAS) | `gateway-cadeia-pagamento-e2e` (PG) | **pendente** |
| 11 | Conversão `sales → vendas` + financeiro | hooks + E2E PG; ADR-001 fonte única | — |
| 12 | Fulfillment/expedição + frete fail-closed | `expedicao.test.ts`, smoke 0058 frete | **pendente** (carrier) |
| 13 | Devolução/estorno | `pg-devolucao-fornecedor`, `devolucao-e2e`, refund/disputa PG | **pendente** |
| 14 | Reconciliação/divergências + observabilidade | `reconciliacao` (teste Etapa 02), painéis, smoke 0058 | **pendente** (dados reais) |

## 3. Gates executados nesta missão (resultados reais)

| Comando | Resultado |
|---|---|
| `commerce:go-live` | **PASS estrutural** — 42 P0 ok, 0 falha; 4 P2 informativos; banco não verificado (sem DATABASE_URL alvo) |
| `payment:go-live` | **PASS estrutural** — CODE_STRUCTURE_READY: YES; EXTERNAL_HOMOLOGATION: NO; FULL_GO_LIVE: NO; gaps: PagBank cartão/boleto, payout automático, evidência de disputa por provider |
| `commerce:final-go-live` | **estrutural SIM (0 P0/P1)** após reconciliação com ADR-0007 (Etapa 03); `CODE_READY: NÃO`/`FULL_GO_LIVE: NÃO` por desenho (o script não certifica escopo integral/homologação); conectores sem credencial verificável |
| `test:pg` (PG 16.14, banco vazio) | **500/500, 0 skip** — inclui todos os E2E commerce/gateway/woocommerce desta matriz |
| `smoke:pg` (API real + PG novo) | **398/398** — inclui bloco 0058 COMMERCE (publicação, procesador, trends, observabilidade, frete fail-closed) |
| `recovery:check` | **OK** — 221 tabelas restauradas com contagem exata; reaplicação idempotente |
| `test:cron-lock:pg` | **2/2** — aquisição entre processos + fencing ( bancos `brobond_test_*`) |
| `prisma validate` | **exit 0** (WASM; truque documentado `/bin/false` p/ engine binário — rede bloqueada para binaries.prisma.sh) |
| `prisma migrate resolve/deploy` | **BLOQUEADO no executor** — schema-engine binário não baixável (host fora da allowlist). Evidência indireta: CI do HEAD base (`7742332`, run 43602502086) passou o passo "Migration Prisma fusion_commerce_into_erp (dual-track)" com sucesso |

## 4. Veredito por integração

Todas as integrações externas: **CODE_READY** (código + testes locais/PG reais),
**nenhuma** em `PROVIDER_CONFIGURED` verificável neste ambiente, **nenhuma** em
`EXTERNAL_HOMOLOGATION` ou `FULL_GO_LIVE`. Para avançar, o Diretor precisa:
provisionar credenciais por empresa no ambiente autorizado, liberar egress aos
hosts oficiais, registrar callbacks públicos e executar o roteiro de homologação
(`docs/EXTERNAL-HOMOLOGATION-MATRIX.md` — jornadas F1–F8) com evidência real.

**Bloqueios objetivos registrados:** egress do executor restrito (GitHub/npm/PyPI);
sem acesso a banco/credenciais de produção; PagBank cartão/boleto e Correios SIGEP
não implementados (declarado, não mascarado); Meta Shopping depende de aprovação
da plataforma.
