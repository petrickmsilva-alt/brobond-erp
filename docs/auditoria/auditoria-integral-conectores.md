# Auditoria integral dos conectores — BroBond ERP e BroBond Commerce

**Status:** relatório final de auditoria técnica. **Somente leitura.** Nenhuma correção foi aplicada.
**Data da auditoria:** 2026-11-03 (UTC).
**Repositório:** `petrickmsilva-alt/brobond-erp`.
**Branch:** `arena/c0104925-brobond-erp`.
**Commit base:** `ad8123762fc2c5ca007cef4b563e2c7da80d34ed` (branched de `main`).
**Estado do working tree no início:** limpo. Ao final, a única alteração é este arquivo novo (`docs/auditoria/`). O diretório `server/node_modules` foi criado pela instalação de dependências e é ignorado pelo Git.
**Produção de referência:** `https://brobond-erp.onrender.com`. **Não foi acessada** (sem egress para esse host; sem credenciais; sem acesso ao painel do Render).

> **Aprovação pendente.** Conforme o escopo, nenhuma fase do roadmap foi implementada. A implementação depende de aprovação expressa do Diretor.

---

## 0. Sumário executivo

- **22 conectores/integrações** foram inventariados e avaliados (existência confirmada por código de produção, não por variável, página ou documentação). **Shopee** e **TikTok Shop** foram removidos do código ativo (decisão de 2026-10-05, migration `0014_drop_shopee_and_tiktok_connectors`) e não entram na contagem.
- **Conformes: 0.** Nenhum conector tem comunicação funcional externa comprovada. A própria matriz de homologação do repositório (`docs/EXTERNAL-HOMOLOGATION-MATRIX.md`, 2026-10-31) registra `EXTERNAL_HOMOLOGATION_READY = NO` e nenhuma operação real contra parceiro.
- **Parciais: 14.** Código real e testes locais, sem prova externa, com lacunas.
- **Não conformes: 2** (Mercado Livre e Nuvemshop). A publicação em marketplace pode criar **anúncios duplicados** (P0-01).
- **Não implementados: 6** (provedores genéricos placeholder, Facebook como canal próprio, NF-e por variável global simulada, IA, Redis/BullMQ, S3/R2).
- **Riscos P0: 1.** P1: 8. P2: 10. P3: 9.
- **Verificação complementar concluída:** typecheck, lint (0 erros), build, testes do client (1151/1151), suíte completa do servidor (1662 aprovados, 0 falhas, 76 pulados que exigem banco), smoke (398/398), `test:pg` em PostgreSQL 16.14 (423/423, gate PASS), `smoke:pg` (398/398) e recovery (PASS). Execução **local**, não no job de CI. Nenhum dos gates verdes cobre o P0-01 (seção 9).
- **Parecer:** **não apto** para operação dos canais de marketplace (ML/Nuvemshop) e **não comprovado** para WhatsApp, e-mail e pagamentos. Não é possível afirmar integração funcional com nenhum parceiro externo a partir do repositório.
- **Ponto positivo relevante:** a base de segurança das credenciais e das assinaturas é sólida em vários pontos (AES-256-GCM, OAuth state com TTL e consumo atômico, HMAC com comparação constante, verificação de assinatura antes de processar, confirmação de pagamento pela API e não pelo corpo do webhook).

---

## 1. Identificação e início obrigatório

| Item | Resultado |
|---|---|
| Branch atual | `arena/c0104925-brobond-erp` (única branch usada; não renomeada) |
| HEAD | `ad8123762fc2c5ca007cef4b563e2c7da80d34ed` |
| Estado do repositório | Árvore limpa antes da auditoria; ~1.143 arquivos |
| Conectores realmente existentes | 4 canais no registro oficial (`CONNECTOR_PROVIDERS`: MERCADOLIVRE, MERCADOPAGO, NUVEMSHOP, INSTAGRAM) + integrações fora do registro (WhatsApp, SMTP, WooCommerce, PagBank/Stripe no engine, transportadoras, fiscal, Cloudinary, CEP, webhooks de saída) |
| Conectores removidos | Shopee e TikTok Shop (`parseConnectorProvider` retorna `null`; comentários e um trecho de `marketplace.ts` remanescentes) |
| Conectores documentados mas não encontrados no código | Facebook como canal próprio; IA; Redis/BullMQ; S3/R2 |

---

## 2. Método, evidência e legenda

**Método.** Leitura de código de produção (`server/src`, `modules/`, `client/src`), das migrations e dos blueprints (`render.yaml`, `.github/workflows/ci.yml`), e execução local da suíte automatizada focada nos conectores. Não houve chamada a nenhum provedor externo, nenhum disparo de mensagem ou cobrança, nenhuma alteração de configuração.

**Legenda de status (aplicada a cada conector):**

- **CONFORME:** comunicação funcional comprovada por evidência externa (homologação ou produção) e controles de segurança verificados.
- **PARCIAL:** código implementado e testado localmente, com lacunas de segurança, operação ou prova externa.
- **NÃO CONFORME:** há defeito material no código atual que afeta dados, dinheiro ou segurança, ou a funcionalidade declarada não corresponde ao que o código faz.
- **NÃO IMPLEMENTADO:** não existe integração funcional no código (placeholder, simulação ou ausência).
- **NÃO VERIFICADO:** depende de acesso que não existe nesta auditoria (painel Render, console Meta, conta de parceiro, rede externa).

**Hierarquia de evidência (do mais fraco ao mais forte):**

1. Existência de arquivo, página, variável de ambiente, endpoint ou adapter.
2. Teste automatizado local (com mocks de `fetch`, sem rede).
3. Teste local contra PostgreSQL real (`test:pg`), sem provedor externo.
4. Homologação com credencial de sandbox do provedor, com evento real recebido.
5. Operação em produção com evidência rastreável (logs, transações, recebimentos).

Pelo que foi possível verificar, **nenhum conector está acima do nível 2.**

**Testes automatizados executados nesta auditoria (local, sem rede externa):**

- `npm ci` em `server/` concluiu com sucesso (332 pacotes).
- `node --import tsx --test` em 12 arquivos focados (Central de Notificações, conectores, webhooks, payment engine, gateway legado, segurança de e-mail, URL pública, catálogo público, PIX, exposição de comércio): **171 testes, 171 aprovados, 0 falhas.**
- Interpretação: a suíte prova **contratos internos com mocks**. Não prova operação com provedor.

**Verificação complementar (continuação de 2026-11-03).** Após a aprovação do escopo de leitura, foram executadas as verificações que faltavam. Todas são locais, sem rede externa a provedores e sem disparos. Resultados (detalhes na seção 9):

| Verificação | Resultado |
|---|---|
| `npm ci` na raiz (workspaces: `packages/*`, `server`, `client`) | OK, 964 pacotes |
| `npm run typecheck` (domain, server, client) | OK (exit 0) |
| `npm run architecture:audit` | OK (exit 0), sem erros de coerência. Ver nota sobre inventário versionado na seção 9.4 |
| `npm run commerce:go-live` | OK (exit 0): P0 41/41 ok, P1 0 avisos, P2 4 informativos |
| `npm run lint` | OK (exit 0): 0 erros, 607 avisos |
| `npm --workspace client test` | OK: 133 arquivos, 1151 testes aprovados |
| `npm run build` (client) | OK (exit 0) |
| `npm test` (suíte completa do servidor) | 1738 testes: 1662 aprovados, 0 falhas, 76 pulados (todos exigem `DATABASE_URL`) |
| `scripts/smoke-e2e.mjs` (servidor em modo demonstração, sem banco) | 398/398 verificações OK |
| `npm run test:pg` (PostgreSQL 16.14, banco novo) | Gate PASS: 423 testes reais, 0 falhas, 0 pulados, 0 TODO |
| `npm run smoke:pg` (smoke E2E contra PostgreSQL real, banco novo) | 398/398 verificações OK |
| `npm run recovery:check` (backup restaurado em banco vazio) | PASS: 186 tabelas com contagem exata; reaplicação idempotente |

**Ambiente das verificações com PostgreSQL.** O CI usa a imagem `postgres:16.14`. Nesta sandbox, o servidor foi o binário PostgreSQL 16.14 do pacote npm `@embedded-postgres/linux-x64` (versão 16.14.0-beta.17), em loopback e em cluster descartável. O cliente `psql` veio do wheel `pgserver` do PyPI (versão 16.2), porque o pacote npm não traz `psql` e o CI instala o client 16. Esses resultados são **evidência local**, não uma execução do job de CI do GitHub. Nenhum banco de produção ou do usuário foi usado.

---

## 3. Inventário de conectores

Legenda da coluna "Existe no código": **Sim (ativo)**, **Sim (parcial)**, **Não**, **Removido**.

| ID | Conector / integração | Tipo | Existe no código | Arquivos principais |
|---|---|---|---|---|
| C-01 | Mercado Pago (pagamentos, PIX, cartão por token, estorno) | Pagamento | Sim (ativo) | `modules/payments/providers/mercado-pago/`, `modules/connectors/mercadopago/`, `server/src/gateway.ts`, `modules/payments/providers/mercado-pago/legacy.ts` |
| C-02 | PagBank (PIX; cartão/boleto não homologados) | Pagamento | Sim (ativo) | `modules/payments/providers/pagbank/index.ts` |
| C-03 | Stripe (Checkout Sessions / PaymentIntents) | Pagamento | Sim (ativo) | `modules/payments/providers/stripe/index.ts` |
| C-04 | Provedores genéricos (`ACQUIRER_GENERIC`, `PIX_DIRECT`, `BOLETO_GENERIC`) | Pagamento | Sim (placeholder) | `modules/payments/providers/generic/index.ts` |
| C-05 | WhatsApp Business Cloud API (Meta) | Mensageria | Sim (ativo) | `server/src/commerce/notificacoes.ts` |
| C-06 | E-mail SMTP (nodemailer) | Mensageria | Sim (ativo) | `server/src/mail.ts`, `server/src/commerce/notificacoes.ts` |
| C-07 | Mercado Livre (OAuth, pedidos por webhook, publicação de anúncios) | Canal | Sim (ativo) + caminho legado | `modules/connectors/mercadolivre/`, `modules/connectors/webhooks/handlers.ts`, `server/src/commerce/catalogo.ts`, `server/src/marketplace.ts` (legado) |
| C-08 | Nuvemshop (OAuth, pedidos por webhook, publicação de produtos) | Canal | Sim (ativo) | `modules/connectors/nuvemshop/`, `server/src/commerce/catalogo.ts` |
| C-09 | Instagram Shopping (Meta Graph, OAuth, webhook assinado) | Canal | Sim (ativo) | `modules/connectors/instagram/`, `server/src/modules/connectors/instagram/instagram.controller.ts` |
| C-10 | Facebook (canal próprio) | Canal | Não (somente Facebook Login dentro do fluxo Instagram) | `modules/connectors/instagram/instagram.service.ts` (OAuth) |
| C-11 | WooCommerce (REST `/wp-json/wc/v3`) | Loja/canal | Sim (ativo) | `server/src/loja.ts`, `server/src/commerce/catalogo.ts` |
| C-12 | Webhooks de saída (admin, assinados HMAC) | Webhook | Sim (ativo) | `server/src/webhooks.ts` |
| C-13 | Melhor Envio (cotação, envio, rastreio) | Logística | Sim (ativo) | `server/src/logistica.ts` |
| C-14 | Correios (cotação e rastreio; etiqueta não implementada) | Logística | Sim (parcial) | `server/src/logistica.ts` (`CORREIOS_BASE`, `gerarEnvio` retorna `nao_configurado`) |
| C-15 | Focus NFe (fiscal, homologação/produção por empresa) | Fiscal | Sim (ativo) | `server/src/fiscalProvider.ts` |
| C-16 | PlugNotas (fiscal, sandbox/produção por empresa) | Fiscal | Sim (ativo) | `server/src/fiscalProvider.ts` |
| C-17 | NF-e por variáveis globais (`NFE_*`, modo simulação) | Fiscal | Sim (simulado) | `server/src/nfe.ts` |
| C-18 | Cloudinary (imagens/uploads) | Storage | Sim (ativo) | `server/src/uploads.ts` |
| C-19 | BrasilAPI / ViaCEP (CEP e frete) | Consulta pública | Sim (ativo) | `server/src/cep.ts`, `server/src/frete.ts` |
| C-20 | IA (provedores de LLM: OpenAI, Anthropic, Gemini etc.) | IA | Não | — (busca por nomes sem resultado em código de produção) |
| C-21 | Redis / BullMQ (fila externa) | Fila | Não (a fila é PostgreSQL: `commerce_outbox`) | `server/src/commerce/outbox.ts`; comentário em `modules/connectors/ingestion/sale-ingestion.service.ts` ("Sem BullMQ/Redis") |
| C-22 | Armazenamento S3/R2 | Storage | Não | — |

**Removidos (não contados):** Shopee e TikTok Shop. Remanescentes apenas em comentários, na migration `0014` e em `marketplace.ts`.

---

## 4. Matriz de conformidade

### 4.1 Status por conector

| ID | Conector | Status | Motivo principal | Evidência externa |
|---|---|---|---|---|
| C-01 | Mercado Pago | **PARCIAL** | Código sólido (Orders API, status pela API, idempotência). Webhook do conector aceita sem segredo (P1-02). Duas trilhas de processamento (P1-07). | NÃO VERIFICADO / nenhuma |
| C-02 | PagBank | **PARCIAL** | Assinatura e API implementadas. Só PIX declarado. Duas trilhas (P1-07). | NÃO VERIFICADO / nenhuma |
| C-03 | Stripe | **PARCIAL** | Webhook HMAC com janela de 300 s e API correta. Sem evidência de sandbox. Duas trilhas (P1-07). | NÃO VERIFICADO / nenhuma |
| C-04 | Provedores genéricos | **NÃO IMPLEMENTADO** | Todas as operações lançam `INVALID_PAYMENT_METHOD` (fail-closed). Aparecem no registro. | Não aplicável |
| C-05 | WhatsApp Cloud API | **PARCIAL** | Envio via Graph API com template. Sem webhook de status, sem teste de envio, sem verificação de template aprovado (P1-05). | NÃO VERIFICADO / nenhuma |
| C-06 | E-mail SMTP | **PARCIAL** | Envio implementado. Sem `verify()`, sem teste de envio, falhas sem detalhe (P1-06). | NÃO VERIFICADO / nenhuma |
| C-07 | Mercado Livre | **NÃO CONFORME** | Publicação cria anúncio novo em vez de atualizar (P0-01). Webhook sem autenticação quando o segredo não está definido (P1-01). Sem envio de estoque após venda (P1-03). Caminho legado simulado (P2-03). | NÃO VERIFICADO / nenhuma |
| C-08 | Nuvemshop | **NÃO CONFORME** | Mesmo defeito de publicação (P0-01). Sem envio de estoque (P1-03). Webhook com HMAC fail-closed (ponto positivo). | NÃO VERIFICADO / nenhuma |
| C-09 | Instagram Shopping | **PARCIAL** | Handshake e HMAC implementados. Publicação recusada por desenho. Afirmações sobre a Meta não verificadas (P2-02). | NÃO VERIFICADO / nenhuma |
| C-10 | Facebook | **NÃO IMPLEMENTADO** | Não há canal próprio. Facebook aparece apenas como provedor de login do fluxo Instagram. | Não aplicável |
| C-11 | WooCommerce | **PARCIAL** | Integração real (Basic Auth, teste somente leitura, estoque por outbox). Idempotência sem garantia de unicidade (P1-08); importação em página única. | NÃO VERIFICADO / nenhuma |
| C-12 | Webhooks de saída | **PARCIAL** | Assinatura HMAC, admin com reautenticação, log de entregas. Anti-SSRF incompleto (P2-01). | NÃO VERIFICADO / nenhuma |
| C-13 | Melhor Envio | **PARCIAL** | Adapter real contra API pública, token por empresa, sandbox separado. Sem evidência de envio. | NÃO VERIFICADO / nenhuma |
| C-14 | Correios | **PARCIAL** | Cotação e rastreio implementados. Geração de etiqueta explicitamente não implementada (exige SIGEP). | NÃO VERIFICADO / nenhuma |
| C-15 | Focus NFe | **PARCIAL** | Adapter real, homologação/produção por empresa. Sem evidência de emissão. | NÃO VERIFICADO / nenhuma |
| C-16 | PlugNotas | **PARCIAL** | Adapter real, sandbox/produção por empresa. Sem evidência de emissão. | NÃO VERIFICADO / nenhuma |
| C-17 | NF-e por variáveis globais | **NÃO IMPLEMENTADO** | Sem modo simulação, responde 503. Em modo `simulacao`, marca documento como simulado. Duplica C-15/C-16 (P2-04). | Não aplicável |
| C-18 | Cloudinary | **PARCIAL** | Upload implementado; sem evidência de operação em produção. | NÃO VERIFICADO / nenhuma |
| C-19 | BrasilAPI / ViaCEP | **PARCIAL** | Consultas implementadas; dependência de terceiros sem verificação em produção. | NÃO VERIFICADO / nenhuma |
| C-20 | IA | **NÃO IMPLEMENTADO** | Nenhum provedor de LLM no código de produção. | Não aplicável |
| C-21 | Redis / BullMQ | **NÃO IMPLEMENTADO** | Fila em PostgreSQL com claim CAS. Decisão deliberada e documentada no código. | Não aplicável |
| C-22 | S3 / R2 | **NÃO IMPLEMENTADO** | Storage é Cloudinary. | Não aplicável |

**Resumo:** CONFORME 0 · PARCIAL 14 · NÃO CONFORME 2 · NÃO IMPLEMENTADO 6 · NÃO VERIFICADO 0 como status geral (a dimensão "evidência externa" é NÃO VERIFICADO para os 16 conectores que têm código ativo).

### 4.2 Dimensões de verificação (onde ficou NÃO VERIFICADO)

| Dimensão | Situação |
|---|---|
| Variáveis reais no Render (valores e presença) | NÃO VERIFICADO. Sem acesso ao painel. Só há o que o `render.yaml` declara (`sync: false`). |
| Webhook real do Mercado Pago, Mercado Livre, Nuvemshop, Meta e Stripe | NÃO VERIFICADO. Sem egress aos hosts e sem conta de parceiro. |
| Entrega de WhatsApp (sent/delivered/read) | NÃO VERIFICADO. Não há webhook de status no código e não é permitido disparar mensagens. |
| Aprovação dos templates `brobond_*` na Meta | NÃO VERIFICADO. Os nomes aparecem só como referência estática em UI e docs. |
| Configuração da WABA 5476… e Phone Number ID 5235… | NÃO VERIFICADO. Os IDs não aparecem em nenhum arquivo do repositório (correto: são valores de ambiente). Conferência só no painel da Meta. |
| Envio real de e-mail via SMTP | NÃO VERIFICADO. Não há endpoint de teste de envio nem `verify()`. |
| Observabilidade (Sentry) | NÃO VERIFICADO. Fora do escopo solicitado; existe inicialização condicionada a `SENTRY_DSN`. |
| Print agents e creators | NÃO VERIFICADO. Não auditados nesta etapa. |

---

## 5. Auditoria por conector

### 5.1 Pagamentos — C-01 Mercado Pago

**Código.**
- Engine novo: `modules/payments/providers/mercado-pago/index.ts`. `healthCheck` chama `GET https://api.mercadopago.com/users/me` (teste real de conexão, sem efeito colateral).
- Legado: `modules/payments/providers/mercado-pago/legacy.ts`. PIX via **Orders API**, com `X-Idempotency-Key` determinística derivada da referência. Estado confirmado por `GET /v1/orders/{id}`, e não pelo corpo do webhook. Estorno e cancelamento com chave de idempotência. Divergência de valor retorna 409. Cartão exige token do SDK (o ERP não captura PAN, o que reduz escopo PCI).
- Conector de credenciais: `modules/connectors/mercadopago/mercadopago.service.ts`. `validateMercadoPagoAccessToken` chama `/users/me` **antes de salvar** a credencial. Credencial cifrada.
- Verificação de assinatura: manifesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com HMAC-SHA256 e comparação constante.

**Pontos positivos.** Confirmação de status pela API; idempotência nas operações de escrita; validação de credencial na conexão; validação de valor.

**Lacunas.**
- **P1-02:** `verifyMercadoPagoWebhookSignature` retorna `true` quando `MERCADOPAGO_WEBHOOK_SECRET` não está definido (fail-open). A mitigação é a re-busca do pagamento na API antes de ingerir, o que limita o dano, mas um evento forjado ainda dispara consultas e grava registro.
- **P1-07:** o gateway legado (`server/src/gateway.ts`, `POST /api/gateway/webhooks/:provider`) e o engine novo (`modules/payments/`) coexistem. O legado fecha (fail-closed) para providers sem segredo, o que é correto, mas há dois caminhos para o mesmo provedor.
- Não há evidência de sandbox. Os testes locais usam mocks.

**Status:** PARCIAL.

### 5.2 Pagamentos — PIX (função, pelo C-01 e C-02)

- PIX via Mercado Pago Orders API e via PagBank Orders. Retorna `code` (EMV) e `qrCodeBase64` separados, conforme contrato em `payment-provider.ts`.
- Pendência: sem homologação de PIX em sandbox, sem teste de expiração real, sem teste de pagamento tardio (há `late-reviews`, mas sem evidência externa).
- **Status:** PARCIAL.

### 5.3 Pagamentos — cartões

- Stripe: `capabilities` só existe se houver `secret_key`, `webhookSecret` e `return_url` com `https://`. `createPaymentIntent` exige `supports()`.
- Mercado Pago: cartão exige token do SDK (o ERP não recebe número de cartão).
- PagBank: só PIX está declarado. Cartão e boleto dependem de contrato PCI/pagador não homologado (declarado em `docs/EXTERNAL-HOMOLOGATION-MATRIX.md`).
- Captura manual via `capture_mode`. Estorno parcial com `RefundEvidence` do mesmo provedor.
- **Status:** PARCIAL (Stripe e MP); cartão PagBank NÃO IMPLEMENTADO.

### 5.4 Pagamentos — PagBank (C-02) e Stripe (C-03)

**PagBank** (`modules/payments/providers/pagbank/index.ts`):
- Base `sandbox.api.pagseguro.com` ou `api.pagseguro.com` conforme o ambiente.
- Autenticação do webhook por `SHA256(token + '-' + corpo)` no header `x-authenticity-token`, comparação constante. Corresponde ao mecanismo de token do PagBank, conforme código; não foi verificado contra a documentação oficial do provedor nesta auditoria.
- ID do evento = `sha256(corpo)`. Reentrega com bytes diferentes não será deduplicada (P3-02).

**Stripe** (`modules/payments/providers/stripe/index.ts`):
- Webhook: `stripe-signature` com `t=` e `v1=` (HMAC-SHA256 de `t.corpo`), tolerância de **300 s** e comparação constante. Correto.
- Processa apenas `checkout.session.*`.
- `healthCheck` chama `GET /v1/account` (leitura).

**Status:** PARCIAL para ambos.

### 5.5 Pagamentos — C-04 provedores genéricos (placeholder)

- `GenericPaymentProvider` lança `INVALID_PAYMENT_METHOD` em todas as operações, `verifyWebhook` retorna `false`, `healthCheck` retorna `NOT_CONFIGURED`. Fail-closed, correto.
- Mas `PIX_DIRECT` e `BOLETO_GENERIC` estão **registrados** em `providers/registry.ts`. Podem aparecer como opção sem funcionar (P3-01).
- **Status:** NÃO IMPLEMENTADO.

### 5.6 Pagamentos — webhooks recebidos, idempotência e estoque

**Roteamento público (antes de `express.json`).**
- `app.use(publicGatewayRouter)` (`server/src/index.ts` ~478) → `POST /api/gateway/webhooks/:provider` com corpo cru.
- `app.use(publicConnectorsRouter)` (~473) → `GET|POST /api/webhooks/:provider` (`server/src/connectors.ts` ~421). Para segmento que não é provedor, chama `next()` e segue para o CRUD admin `/api/webhooks`. **Colisão tratada corretamente.**

**Gateway legado (`server/src/gateway.ts`, ~1034 e ~1166).**
- Assinatura verificada antes de responder duplicata (no fluxo de evento).
- Segredo por empresa (`webhook_segredo_cifrado`). Provider não-mock sem segredo é recusado (fail-closed). `mockProvider` bloqueado fora de desenvolvimento por `exigirForaDeProducao()`.
- Reprocessamento exige assinatura válida (`evento.assinatura_ok === true`).
- **P2-10:** a resposta 409 "Evento já registrado para outra cobrança" é emitida **antes** da checagem de assinatura. Terceiro sem segredo consegue sondar a existência de `evento_id`.

**Idempotência de pagamento.** Chaves determinísticas no Mercado Pago (`X-Idempotency-Key`) e `operationKey` no engine. As mutações do engine (`POST /:id/:op` em `modules/payments/api/routes.ts`) leem o header `Idempotency-Key` e o repassam ao motor; ausência do header é repassada como string vazia. A obrigatoriedade efetiva depende de `paymentEngine.mutate`, que não foi auditado em profundidade (lacuna a validar na Fase 3).

**Estoque na venda com pagamento.** A venda é reservada pelo motor de estoque canônico (`estoqueCanonico`). A consistência entre pagamento e reserva não foi testada de ponta a ponta nesta auditoria. Lacuna a validar na Fase 3.

**Status:** PARCIAL.

### 5.7 Mensageria — C-05 WhatsApp Business Cloud API

**Código** (`server/src/commerce/notificacoes.ts`).
- Chamada: `POST https://graph.facebook.com/{WHATSAPP_API_VERSION}/{phoneId}/messages`, com template e 5 parâmetros.
- Credenciais por variáveis: `WHATSAPP_CLOUD_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
- Templates por evento: `WHATSAPP_TEMPLATE_ORDER_CREATED`, `WHATSAPP_TEMPLATE_PAYMENT_APPROVED`, `WHATSAPP_TEMPLATE_TRANSACIONAL` (fallback). Idioma `WHATSAPP_TEMPLATE_IDIOMA` (padrão `pt_BR`). Versão `WHATSAPP_API_VERSION` (padrão `v21.0`). Timeout 12 s.
- Sucesso = HTTP 2xx + `messages[0].id`. Estado gravado: `ENVIADO` com `provider_status=REQUEST_ACCEPTED`.
- Ausência de token, de phone ID ou de template gera `NAO_CONFIGURADO` ou `PENDENTE`, sem tentativa.

**Os nomes `brobond_pedido_recebido`, `brobond_pagamento_confirmado` e `brobond_transacional` não são lidos pelo código.** Só existem como referência estática em `client/src/pages/commerce/NotificacoesPage.tsx` e em `docs/commerce/central-notificacoes.md`. O código lê o **nome do template a partir de variável de ambiente**. Portanto, a correspondência com os modelos aprovados na Meta depende da configuração no Render, que não foi verificada.

**Lacunas.**
- **P1-05:** não existe rota de webhook da Meta para status de mensagem (`sent`, `delivered`, `read`, `failed`). O estado "aceito pela API" é tratado como envio. Entrega e falha por usuário não são registradas.
- Não há verificação de template aprovado (status `APPROVED` na Meta) antes do envio.
- Não há teste de envio real (e não é permitido nesta etapa).
- **P2-06:** WhatsApp usa Graph `v21.0` por padrão; Instagram usa `v26.0`. Versões divergentes sem justificativa documentada.

**Status:** PARCIAL.

### 5.8 Mensageria — C-06 E-mail SMTP

**Código.**
- `server/src/mail.ts`: nodemailer carregado via `require`. Variáveis `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`. `secure` por `SMTP_SECURE` ou porta 465. Remetente = `SMTP_FROM` ou `SMTP_USER`.
- Valida links com `linksQueNaoAbrem` (checagem de links antes do envio). Erros do transporte são mascarados.
- Falhas retornam `nao_enviado` sem detalhe, o que protege dados mas dificulta diagnóstico.

**Lacunas.**
- **P1-06:** `statusCanaisNotificacao` marca SMTP como `CONFIGURADO` apenas por presença das variáveis. Não há `transporter.verify()` nem rota de teste de envio.
- **Dessincronia de dependência:** `server/package.json` declara `nodemailer ^10.3.1`; `server/package-lock.json` registra `9.1.1` para `node_modules/nodemailer` e `^9.1.1` na raiz. O `npm ci` concluiu sem erro e instalou **10.3.1**. A instalação não é reproduzível a partir do lockfile como está.
- `SMTP_*` declarado em `render.yaml` com `sync: false`. Valores não verificados.

**Status:** PARCIAL.

### 5.9 Canais — C-07 Mercado Livre

**Conector oficial** (`modules/connectors/mercadolivre/`, `modules/connectors/webhooks/handlers.ts`).
- OAuth2 com state de 10 min (SHA-256 no banco, consumo atômico `DELETE ... RETURNING`, vínculo empresa/usuário).
- Tokens cifrados AES-256-GCM (`v1.<iv>.<tag>.<ct>`) com `CONNECTOR_ENCRYPTION_KEY`.
- Refresh pelo `connectorService.getValidAccessToken`.
- Webhook: resolve dono por `shop_id` (ambíguo → ignorado), grava evento idempotente (`hasEvent`/`recordEvent`), re-busca o pedido na API com token do conector.
- `testConnection` valida **somente a presença das variáveis** (`configured`). Não chama a API (P2-09).

**Defeitos.**

- **P0-01 — Duplicação de anúncios (publicação).** Ver seção 5.13 (vale também para Nuvemshop).

- **P1-01 — Webhook fail-open.** `handlers.ts` (~94–98): com `MERCADOLIVRE_WEBHOOK_SECRET` ausente, qualquer POST é aceito. Com a variável definida, o segredo é exigido em `?secret=`. A variável está declarada em `render.yaml` com `sync: false`; **o valor em produção é NÃO VERIFICADO.** Mitigação parcial: re-busca do pedido e `findByShopId` com dono ambíguo rejeitado.

- **P1-01b — Chave de deduplicação fraca.** Quando o payload não traz `_id`, o `externalEventId` vira `${topic}:${resource}`. Eventos distintos do mesmo recurso (por exemplo, pago e cancelado) podem ser tratados como duplicata e um deles descartado.

**Caminho legado** (`server/src/marketplace.ts`, `POST /api/marketplace/sincronizar`).
- Token **estático** `MERCADOLIVRE_TOKEN`, sem OAuth, refresh ou cifra.
- URL literal `https://api.mercadolibre.com/orders/search?seller=seller_id`. O valor `seller_id` é um **placeholder**, não o ID do vendedor. Essa chamada não busca pedidos reais.
- Erros são engolidos (`console.warn`). Pedidos não são persistidos; a resposta só conta.
- **P2-03:** caminho simulado coexistindo com o conector oficial. Deve ser removido na Fase 1 após confirmação de que não há uso.

**Estoque.** Não há envio de saldo ao Mercado Livre após venda. O campo `available_quantity` é enviado **apenas na criação** do anúncio (`catalogo.ts` ~611). **P1-03:** risco de venda acima do estoque no canal.

**Status:** NÃO CONFORME.

### 5.10 Canais — C-08 Nuvemshop

**Conector oficial** (`modules/connectors/nuvemshop/nuvemshop.service.ts`).
- OAuth2 (`NUVEMSHOP_CLIENT_ID/SECRET`, `NUVEMSHOP_REDIRECT_URI`). Token **permanente**, sem refresh (declarado).
- Webhook: HMAC-SHA256 hex do corpo cru em `x-linkedstore-hmac-sha256` com `NUVEMSHOP_CLIENT_SECRET`. **Sem segredo configurado, retorna `false` (fail-closed).** Comparação manual constante. Testado em `connectors.test.ts` (corpo alterado com espaço é rejeitado).

**Defeitos.**
- **P0-01:** publicação (`publicarNuvemshop`, `catalogo.ts` ~625–640) faz `POST /v1/{shop}/products` a cada publicação, sem chave de idempotência, sem `external_id` e sem busca prévia por SKU. Mesmo defeito do Mercado Livre.
- **P1-03:** sem envio de `stock` após venda. O campo `stock` só existe na criação.

**Status:** NÃO CONFORME (pela publicação); ingestão de pedidos isoladamente seria PARCIAL.

### 5.11 Canais — C-09 Instagram Shopping (Meta Graph)

**Código.**
- Graph API **`v26.0`** (`INSTAGRAM_GRAPH_VERSION`, `modules/connectors/instagram/instagram.service.ts`).
- OAuth via Facebook Login for Business (`https://www.facebook.com`). Token de longa duração (60 dias).
- Credenciais: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`.
- Webhook (`instagram.controller.ts`):
  - `GET /api/webhooks/instagram`: handshake com `hub.verify_token`. Verificação com token ausente ou errado responde **403**. Chamada sem parâmetros responde 200 (liveness).
  - `POST`: corpo cru (`express.raw`, 2 MB), HMAC-SHA256 em `x-hub-signature-256` com `INSTAGRAM_APP_SECRET`. Assinatura inválida responde **401**. Sem banco responde **503** (para a Meta reentregar).
- Publicação de item individual **rejeitada por desenho** (`PublicacaoFalha(..., true)`), com mensagem explicando que o item é gerido pelo catálogo Meta.

**Pontos positivos.** Handshake e HMAC implementados; 503 sem banco evita perda silenciosa; rejeição honesta da publicação.

**Lacunas.**
- Nenhum evento real da Meta foi recebido. A assinatura do webhook depende da inscrição no app Meta, que é **NÃO VERIFICADA**.
- **P2-02 (documentação):** `instagram.service.ts` cita o encerramento de 47 endpoints de Commerce Order Management na v26.0 (2026-07-29) e a extensão do bloqueio a todas as versões (2026-10-27). O `README` do módulo também registra essa afirmação. **Não foi verificada nesta auditoria**, e a decisão de desenho pode depender dela. Deve ser checada na documentação oficial da Meta antes de qualquer decisão.

**Status:** PARCIAL.

### 5.12 Canais — C-10 Facebook

- Não existe conector de Facebook como canal (publicação, pedidos ou páginas).
- O Facebook aparece como **provedor de login** (OAuth do Instagram) e como domínio de OAuth.
- Se o escopo comercial exige Facebook Shop, é **NÃO IMPLEMENTADO** (P3-06).
- **Status:** NÃO IMPLEMENTADO.

### 5.13 Publicação de produtos em canais (transversal: ML, Nuvemshop, WooCommerce)

Arquivo: `server/src/commerce/catalogo.ts`.

**Fluxo.**
1. A atualização do cadastro de produto (handler de edição em `catalogo.ts`, ~860–870) chama `reenfileirarPublicacoesAfetadas` (~884–898) quando o conteúdo muda. Canais com histórico em `PUBLISHED`, `ERROR`, `UPDATE_QUEUED` ou `QUEUED` são reenfileirados.
2. `enfileirarPublicacao` (~325–365) procura uma linha ativa em `ESTADOS_PIPELINE` (`DRAFT`, `READY`, `QUEUED`, `PUBLISHING`, `UPDATE_QUEUED`). **`PUBLISHED` não está nessa lista.** Logo, uma linha publicada **não é atualizada**: é inserida uma nova linha `QUEUED` com `versao + 1`.
3. `processarPublicacao` (~389–440) chama `publicarNoCanal`. Para ML e Nuvemshop, isso é um **`POST` de criação**.
4. `external_id` **não é consultado** no caminho de publicação. `UPDATE_QUEUED` **nunca é atribuído** no código (só existe em enum, rótulo e filtros).
5. Retentativas após `ERROR` (timeout com criação já feita no canal, por exemplo) geram novo `POST`, também sem chave de idempotência.

**Consequência (P0-01).** Cada alteração de título, descrição ou atributo de um produto já publicado no Mercado Livre ou na Nuvemshop tende a **criar um novo anúncio**, deixando os anteriores ativos com preço e estoque antigos. Uma retentativa após timeout pode duplicar o anúncio. A comparação do próprio código é clara: o comentário em `reenfileirarPublicacoesAfetadas` diz "os canais com histórico ganham nova versão na fila", mas a implementação não atualiza.

**Cobertura de testes.** `commerce-paineis-api.test.ts` e `enterprise-wave3-commerce.test.ts` cobrem ofertas e publicação por canal, **não** os `POST` de criação de ML/Nuvemshop nem o reenfileiramento que duplica. Nenhum teste afirma atualização em vez de criação.

**Status (transversal):** NÃO CONFORME para ML e Nuvemshop. WooCommerce faz busca por SKU antes de criar (`GET /products?sku=`) e atualiza (ponto positivo, mas com outras lacunas).

**Confirmação necessária.** A duplicação está confirmada por leitura de código. Não foi reproduzida contra conta real. Deve ser confirmada por teste automatizado de regressão com `fetch` simulado (Fase 0) e por homologação em conta de teste (Fase 5).

### 5.14 Canais — C-11 WooCommerce

**Código** (`server/src/loja.ts`).
- Basic Auth sobre HTTPS. Credenciais por variáveis `WOOCOMMERCE_URL`, `WOOCOMMERCE_CK`, `WOOCOMMERCE_CS` e vínculo `WOOCOMMERCE_EMPRESA_ID` (sem vínculo, responde 409).
- Teste de conexão somente leitura (`GET /orders?per_page=1`, com `?testar=1`).
- Pedidos importados com idempotência por `vendas.pedido_cliente = WOO-<id>` (`findOne` + `insert`).
- Estoque empurrado pelo outbox (`woo-estoque`), com bloqueio de SKU/tamanho/saldo duplicado.
- Publicação com busca por SKU antes de criar, e atualização de variações (ponto positivo).

**Lacunas.**
- **P1-08:** idempotência não confirmada por restrição de unicidade. Não encontrei `UNIQUE` em `pedido_cliente` nas migrations; o armazenamento usa tabelas genéricas. Duas importações concorrentes podem criar duas vendas (verificar no modelo de armazenamento).
- Importação em **página única** (`per_page=${limite}`), sem paginação verificada. Pedidos além da primeira página não são importados.
- Sem webhook do WooCommerce. Captura é **pull manual**.
- Variáveis `WOOCOMMERCE_*` **não constam** em `server/.env.example` (P3-03).

**Status:** PARCIAL.

### 5.15 Webhooks de saída — C-12

**Código** (`server/src/webhooks.ts`).
- CRUD admin (`/api/webhooks`). Criação exige admin e **reautenticação** (`exigirReautenticacao`).
- Assinatura HMAC-SHA256 do corpo (header `X-Brobond-Signature`). Segredo cifrado com `cifrarSegredoMfa` (mesma chave do MFA, ver seção 8).
- Entrega com `fetch`, timeout de 6 s, registro de entregas (últimas 200) e reenvio manual.
- Disparo fire-and-forget que não derruba a ação principal.

**Lacunas.**
- **P2-01 (anti-SSRF incompleto).** `validarUrlWebhook` bloqueia apenas **literais** de host interno (`localhost`, `127.0.0.1`, `::1`, `10.x`, `192.168.x`, `172.16–31.x`) e **só em produção**. Não resolve DNS (rebinding e nomes que apontam para rede interna passam), não bloqueia link-local (`169.254.x.x`) nem `0.0.0.0`, e o `fetch` segue redirecionamentos (sem `redirect: 'manual'`). O risco é mitigado porque o cadastro é restrito a administradores com reautenticação e MFA obrigatório para admin (`mfa.ts`).
- Não há teste automatizado cobrindo `validarUrlWebhook` com hosts internos (`webhooks.test.ts` não cobre esses casos).

**Status:** PARCIAL.

### 5.16 Logística — C-13 Melhor Envio e C-14 Correios

**Melhor Envio** (`server/src/logistica.ts`).
- `https://api.melhorenvio.com.br` (produção) e `https://sandbox.melhorenvio.com.br` (sandbox). Token por empresa (`me_token`), cifrado.
- Sem token, responde `nao_configurado`. Não inventa cotação.
- Operações: `cotar`, `gerarEnvio`, `rastrear`, `cancelar`. Sem evidência de envio real.

**Correios.**
- `https://proxyapp.correios.com.br/v1`. Credenciais por empresa (`correios_senha`).
- `cotar` e `rastrear` implementados.
- `gerarEnvio` **explicitamente não implementado** (requer contrato SIGEP Web com certificado). Retorna `nao_configurado`. Coerente com `docs/EXTERNAL-HOMOLOGATION-MATRIX.md`, item 4.
- Envio manual (registro de código de rastreio) como alternativa.

**Lacuna comum (P2):** `SEGREDOS_ENCRYPTION_KEY` ausente faz o sistema emitir aviso em `logistica.ts` (~697): tokens cifrados com chave derivada de `JWT_SECRET`.

**Status:** PARCIAL (ambos).

### 5.17 Fiscal — C-15 Focus NFe, C-16 PlugNotas, C-17 NF-e por variável

**Focus NFe e PlugNotas** (`server/src/fiscalProvider.ts`).
- Focus: `https://api.focusnfe.com.br` (produção) ou `https://homologacao.focusnfe.com.br` (homologação), por `cred.ambiente`. Autenticação Basic com o token da empresa.
- PlugNotas: `https://api.plugnotas.com.br` (produção) ou `https://api.sandbox.plugnotas.com.br`. Header `x-api-key`.
- Timeout configurável por `FISCAL_TIMEOUT_MS`.
- Credenciais por empresa, cifradas.
- **Sem evidência de emissão em homologação ou produção.** Não há NF-e autorizada registrada em ambiente externo.

**NF-e por variável global** (`server/src/nfe.ts`).
- Lê `NFE_PROVIDER`, `NFE_API_KEY`, `NFE_MODO`, `NFE_EMITENTE_CNPJ/IE/RAZAO` diretamente do ambiente, **sem tenant**.
- Sem `NFE_MODO=simulacao`, responde **503**. Em simulação, grava `nfe_status = simulada`.
- **P2-04:** duplica o caminho de C-15/C-16 com outro modelo de credenciais (global, sem empresa). Risco de documento simulado ser confundido com fiscal. Viola "não duplicar mecanismos de integração".

**Status:** C-15 e C-16 PARCIAIS; C-17 NÃO IMPLEMENTADO (como emissão real).

### 5.18 Storage — C-18 Cloudinary e C-22 S3/R2

- Cloudinary (`server/src/uploads.ts`): `UPLOAD_PROVIDER`, `CLOUDINARY_URL`, `CLOUDINARY_FOLDER` (declarados em `render.yaml`). Upload implementado. Sem evidência de operação em produção. **PARCIAL.**
- S3/R2: não existe. **NÃO IMPLEMENTADO.**
- Armazenamento local e de banco não foi auditado em profundidade.

### 5.19 Consulta pública — C-19 BrasilAPI / ViaCEP

- `server/src/cep.ts` consulta BrasilAPI e ViaCEP. `server/src/frete.ts` usa ViaCEP. Variáveis `CEP_*` não documentadas em `.env.example`.
- Consultas somente leitura. Sem evidência de operação em produção. **PARCIAL.**

### 5.20 IA — C-20

- Busca por nomes de provedores de LLM (OpenAI, Anthropic, Gemini) no código de produção: **sem resultado**. **NÃO IMPLEMENTADO.**

### 5.21 Filas — C-21 Redis / BullMQ

- Não há Redis nem BullMQ. A fila é a tabela `commerce_outbox` (PostgreSQL), com claim CAS, retentativas com backoff exponencial (30 s base, teto 1 h, **máximo 10 tentativas**, `regras.ts`), recuperação de itens presos (10 min) e reprocessamento administrativo (`POST /api/commerce/outbox/:id/reprocessar`).
- Decisão documentada: "Sem BullMQ/Redis: o ERP é um processo só" (`modules/connectors/ingestion/sale-ingestion.service.ts`).
- **Ponto positivo:** o pedido não espera o processamento do canal; a fila é a autoridade.
- Lacuna: itens que estouram 10 tentativas ficam em `ERRO` sem alerta dedicado ao operador (P2-08, a validar).
- **Status:** NÃO IMPLEMENTADO (como Redis/BullMQ); a alternativa interna é funcional, sem evidência em carga.

### 5.22 Conectores de canal — ingestão de vendas (transversal)

- `modules/connectors/ingestion/sale-ingestion.service.ts`: `processSaleIngestionEvent`, `resolveDraft`, `isSaleIngestionEvent`.
- Padrão: webhook grava evento → worker re-busca pedido na API → cria rascunho de venda → resolve SKU por `catalog-matcher`. Falha transitória responde **200 com `deferred`** e é recuperada depois.
- Pedido sem correspondência de produto gera `retry` com pendência, sem derrubar a ingestão.
- **Lacuna:** a ingestão de venda de ML/Nuvemshop **não baixa estoque de canal** (ver P1-03).

---

## 6. Central de Notificações (`/commerce/notificacoes`)

### 6.1 Arquitetura

- Página: `client/src/pages/commerce/NotificacoesPage.tsx` (350 linhas) e teste `NotificacoesPage.test.tsx`.
- Endpoint: `GET /api/commerce/notificacoes/status` (`server/src/index.ts` ~1074), autenticado, com `checkAccess` e visibilidade por perfil (gerente e administrador).
- Serviço: `server/src/commerce/notificacoes.ts` (685 linhas), com `statusCanaisNotificacao` e `situacaoCanaisNotificacao`.
- Eventos emitidos por `server/src/commerce/pedidos.ts` (`ORDER_PROCESSING`, `ORDER_EXPIRED`, `PAYMENT_REJECTED`, `ORDER_CANCELLED`, `ORDER_DELIVERED`, `ORDER_SHIPPED`) e `server/src/commerce/vitrine.ts` (`registrarEventoSeguro`).
- Processamento: outbox `sincronizacao` com `acao='notificacao'` (`commerce/outbox.ts`), com retentativa e reprocessamento. O pedido **não espera** o envio.

### 6.2 O que a tela mostra (verificado)

- **E-mail:** presença de `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e, separadamente, `SMTP_FROM` (remetente dedicado).
- **WhatsApp:** presença do token e do Phone Number ID; idioma (validado por formato, valor oculto se inválido); presença das variáveis de template por evento; lista de eventos sem modelo; fallback `WHATSAPP_TEMPLATE_TRANSACIONAL`.
- **Modelos:** nomes "esperados" fixos na UI (`brobond_pedido_recebido`, `brobond_pagamento_confirmado`, `brobond_transacional`), marcados como referência, não como confirmação de aprovação na Meta.
- **Link público do pedido:** presença de `APP_URL` ou `PUBLIC_BASE_URL`.
- **Pendências de configuração:** lista textual.

### 6.3 Pontos positivos (verificados)

- Alerta explícito: **"Configuração local não comprova conexão nem entrega."** Texto e comportamento consistentes com a realidade.
- Nenhum segredo, endereço de e-mail, ID de telefone, URL base ou token individual é exibido (projeção por allowlist).
- Não renderiza mensagens arbitrárias de erro de provedor.
- Pendências explicitam que "conexão e entrega não foram testadas".
- Permissão: gerente e administrador; `checkAccess` no servidor (autorização efetiva).

### 6.4 Lacunas (contra a especificação)

A especificação exige estados distintos. Situação:

| Estado exigido | Situação |
|---|---|
| Não configurado | **Exibido** (`NAO_CONFIGURADO`) |
| Parcialmente configurado | **Exibido** (flag `parcial`) |
| Configurado (variáveis presentes) | **Exibido** (`CONFIGURADO`, com aviso de que não comprova conexão) |
| Conexão validada | **Não implementado** (nenhum teste de conexão SMTP ou WhatsApp) |
| Último envio realizado | **Não exibido.** O backend calcula `CONECTADO` a partir do último envio aceito, mas a tela não renderiza `ultimo_envio_em` nem o estado, e o tipo TypeScript da página não os declara |
| Falha de credencial | **Não implementado** |
| Falha de envio | **Não exibido** (sem campo de último erro na tela) |
| Entrega confirmada | **Não implementado** (sem webhook de status da Meta) |

**P1-05 (reafirmado):** o termo "CONECTADO" existe no backend para envio aceito pelo provedor. Ele **não significa conexão validada nem entrega**. Se algum dia for exibido, induzirá o operador a erro.

**P2-07:** existem **dois** endpoints de status: `/api/commerce/notificacoes/status` (commerce) e `/api/admin/notificacoes/status` (`server/src/notifications.ts`, alertas internos de estoque e compras, com `smtp_configurado` por presença). Dois pontos de verdade para SMTP.

**P2-08 (a validar):** sem SMTP ou WhatsApp configurado, notificações ficam em `PENDENTE`. Após 10 tentativas, a entrada do outbox vai para `ERRO`. Não foi confirmado se há alerta ao operador nesse caso.

### 6.5 Status da Central

**PARCIAL.** Diagnóstico de configuração correto e honesto. Não é um painel de saúde de conectores: não prova conexão, envio ou entrega.

---

## 7. Variáveis de ambiente

### 7.1 Fontes de verdade

- `server/.env.example`: documenta variáveis de aplicação.
- `render.yaml`: blueprint; variáveis com `sync: false` têm valor fora do repositório.
- Código: `process.env.*` e `env.*` (módulos de conectores).

**Método.** Cruzamento feito com **os dois padrões** de leitura (`process.env.X` e `env.X`). Um primeiro cruzamento só com `process.env` gerou falsos "não usados", corrigidos nesta versão.

### 7.2 Variáveis sem documentação em `.env.example`

`WHATSAPP_*`, `SMTP_*`, `NFE_*`, `CRON_SECRET`, `SEGREDOS_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `SENTRY_DSN`, `CEP_*`, `FISCAL_TIMEOUT_MS`, `PGSSL`, `NOTIFICAR_*`, `PRINT_*`, `WOOCOMMERCE_*`, `GATEWAY_MP_API_BASE_URL`, `MERCADOLIVRE_TOKEN`.

### 7.3 Declaradas em `render.yaml` sem uso encontrado no código

- `MERCADOLIVRE_CLIENT_ID`, `MERCADOLIVRE_CLIENT_SECRET`, `MERCADOLIVRE_REDIRECT_URI`, `MERCADOPAGO_PUBLIC_KEY`, `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_REDIRECT_URI`: lidas por `env.*` no módulo de conectores (uso confirmado no segundo padrão). Não há ausência real.
- `VITE_SENTRY_DSN`: uso no cliente via `import.meta.env` **não verificado** nesta etapa.

### 7.4 Ausências críticas sem valor verificado

| Variável | Papel | Situação |
|---|---|---|
| `SEGREDOS_ENCRYPTION_KEY` | Cifra de credenciais de gateway, fiscal e logística | **Não declarada no `render.yaml`.** Sem ela, a chave é derivada de `JWT_SECRET` (P1-04). Valor em produção NÃO VERIFICADO. |
| `MFA_ENCRYPTION_KEY` | Cifra de TOTP e de webhooks de saída | **Não declarada no `render.yaml`.** Mesmo problema. |
| `CONNECTOR_ENCRYPTION_KEY` | Cifra de tokens de conectores | Declarada (`sync: false`). Valor NÃO VERIFICADO. |
| `MERCADOLIVRE_WEBHOOK_SECRET` | Autenticação do webhook ML | Declarada (`sync: false`). Se ausente, fail-open (P1-01). Valor NÃO VERIFICADO. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Autenticação do webhook MP (conector) | Documentada. Se ausente, fail-open (P1-02). Valor NÃO VERIFICADO. |
| `APP_URL` e `PUBLIC_BASE_URL` | URLs públicas | `APP_URL` usado em ~18 pontos, `PUBLIC_BASE_URL` em 3 (P2-05). Valores NÃO VERIFICADOS. |
| `WHATSAPP_CLOUD_API_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | Credenciais WhatsApp | Declaradas (`sync: false`). Valores NÃO VERIFICADOS. |
| `WHATSAPP_TEMPLATE_*` | Nomes dos modelos | Declarados. Nomes em produção NÃO VERIFICADOS. |
| `SMTP_*` | Credenciais de e-mail | Declaradas (`sync: false`). NÃO VERIFICADAS. |

### 7.5 Comportamento em produção quando ausentes (verificado no código)

- `JWT_SECRET` fraco ou ausente em produção: **aborta a inicialização** (`assertProductionSecrets`, `server/src/security.ts`).
- `SEGREDOS_ENCRYPTION_KEY` e `APP_ENCRYPTION_KEY` ausentes: `PUT /api/commerce/payments/providers/:code` responde **503** ("Chave dedicada de criptografia necessária"). **Se o Render não tiver uma dessas variáveis, o cadastro de credenciais do novo motor de pagamento está bloqueado em produção.** Verificar no painel.

---

## 8. Multiempresa, autenticação e segredos (transversal)

### 8.1 Multiempresa

- Empresa = tenant; usuário = identidade; vínculo = autorização. Mantido.
- Credenciais de conectores são por empresa (`connectors.empresa_id`, `commerce_outbox` com `empresa_id`).
- `organizationId` **não foi introduzido** nesta auditoria (verificado: sem ocorrência).
- Ponto de atenção: `NFE_*` (C-17) e `WOOCOMMERCE_*` são **globais** (variáveis); o vínculo com empresa é feito por `WOOCOMMERCE_EMPRESA_ID`. Isso não é multiempresa real para WooCommerce (P2, a documentar).
- Publicação em ML/Nuvemshop resolve o token pela empresa do evento (`tokenDoConector`), com `status='CONNECTED'`. **Ponto positivo.**

### 8.2 Segredos e chaves (P1-04)

Foram identificados **três mecanismos de cifra** no mesmo sistema:

1. **Conectores:** AES-256-GCM versionado, chave `CONNECTOR_ENCRYPTION_KEY` (32 bytes, hex ou base64url, sem derivação por hash; erro se inválida).
2. **Segredos gerais (`server/src/segredos.ts`):** AES-256-GCM com scrypt. Chave: `SEGREDOS_ENCRYPTION_KEY`, ou `APP_ENCRYPTION_KEY`, ou `JWT_SECRET`, ou **string fixa `'brobond-dev-secret'`**. Sal próprio `brobond-segredos-v1`.
3. **MFA (`server/src/mfa.ts`):** mesmo esquema, chave `MFA_ENCRYPTION_KEY`, ou `JWT_SECRET`, ou **`'brobond-dev-secret'`**. Sal `brobond-mfa-v1`.

**Problemas:**
- Duplicação de mecanismo de cifra (viola "não duplicar mecanismos de integração").
- Chaves de domínios diferentes derivadas do **mesmo** `JWT_SECRET` em produção quando as dedicadas não são definidas. Rotacionar `JWT_SECRET` invalida a decifragem de credenciais.
- O fallback `'brobond-dev-secret'` existe em `auth.ts`, `websocket.ts`, `mfa.ts` e `segredos.ts`. **Em produção, o boot aborta** se `JWT_SECRET` for fraco (`security.ts`), o que torna o fallback inalcançável no Render, desde que o `JWT_SECRET` seja mantido. Não foi possível verificar o valor real.
- `decifrarSegredo` retorna `null` em qualquer erro, o que transforma credencial corrompida em "não configurado" sem diagnóstico (P3-04).

**Status:** P1-04 (ver riscos).

### 8.3 Autenticação de webhooks (resumo)

| Webhook | Verificação | Quando ausente |
|---|---|---|
| Stripe | HMAC v1, janela 300 s | Recusa (`verifyWebhook` retorna `false`) |
| PagBank | SHA-256 do token + corpo | Recusa |
| Mercado Pago (gateway legado) | Manifesto HMAC | Recusa (fail-closed) |
| Mercado Pago (conector) | Manifesto HMAC | **Aceita (P1-02)** |
| Mercado Livre | `?secret=` | **Aceita (P1-01)** |
| Nuvemshop | HMAC hex do corpo | Recusa (fail-closed) |
| Instagram/Meta | HMAC `x-hub-signature-256` + verify token | Recusa (401/403) |
| WhatsApp (status) | **Não existe** | — |

### 8.4 URLs públicas

- `APP_URL` é a base estática para a URL de webhook que alguns provedores assinam (`appUrl(connectorWebhookPath(...))`). Se `APP_URL` divergir da URL cadastrada no painel do provedor, a verificação falha (fail-closed). Dependência operacional (P2-05).
- `APP_URL_PERMITIR_INTERNA` permite host interno. Uso fora de desenvolvimento deve ser auditado.
- `CORS_ORIGINS` e `CATALOGO_EMBED_ORIGENS` controlam origens. Não auditados em profundidade.

---

## 9. Testes automatizados — cobertura e lacunas

### 9.1 Executados nesta auditoria

- **171/171** testes aprovados em 12 arquivos focados (primeira etapa).
- **Suíte completa do servidor:** 1738 testes, 1662 aprovados, 0 falhas, 76 pulados (exigem `DATABASE_URL`).
- **Suíte do client:** 1151/1151 aprovados (133 arquivos).
- **PostgreSQL 16.14 (banco novo):** `test:pg` 423/423 aprovados, sem pulos. Os 76 pulados da suíte do servidor são cobertos por esse gate.
- **Smoke E2E:** 398/398 em modo demonstração e 398/398 contra PostgreSQL real.
- **Recovery:** backup restaurado e reaplicado sem duplicar (186 tabelas).

**Leitura crítica dos resultados.** Todos os gates internos estão verdes, mas **nenhum deles cobre o P0-01**. O smoke de comércio só publica o canal BROBOND, e a suíte não testa os `POST` de criação de Mercado Livre ou Nuvemshop. Gate verde comprova o comportamento que os testes descrevem, não a ausência de defeitos fora deles.

### 9.2 Cobertura confirmada

- Central de Notificações: status, pendências e envio (`commerce-notificacoes-status.test.ts`, `commerce-notificacoes.test.ts`). Fetch do WhatsApp **mockado** (`t.mock.method(globalThis, 'fetch', ...)`).
- Conectores: assinatura Nuvemshop, OAuth e state (`connectors.test.ts`).
- Payment engine e gateway legado (`payment-engine.test.ts`, `enterprise-legacy-gateway.test.ts`).
- PIX (`commerce-orders-pix.test.ts`, `commerce-pix-real-flow.test.ts`).
- Segurança de e-mail (`enterprise-mail-security.test.ts`).
- Ofertas por canal (`commerce-paineis-api.test.ts`).

### 9.3 Lacunas de teste (sem cobertura automatizada)

- Publicação real de ML/Nuvemshop (`POST /items`, `POST /products`) e reenfileiramento que duplica (P0-01).
- Webhook ML sem `MERCADOLIVRE_WEBHOOK_SECRET` (fail-open) e chave de deduplicação (P1-01).
- Webhook MP do conector sem segredo (P1-02).
- `validarUrlWebhook` com hosts internos e redirecionamentos (P2-01).
- Idempotência de WooCommerce sob concorrência (P1-08).
- Envio de estoque após venda para ML/Nuvemshop (inexistente; P1-03).
- Verificação SMTP (`verify()`), inexistente (P1-06).

### 9.4 Testes de CI

- `.github/workflows/ci.yml`: jobs `verificar` (typecheck, testes, smoke, `commerce:go-live`, `architecture:audit`, lint, build) e `testes-postgres` (PostgreSQL 16.14, `test:pg`, recovery, `smoke:pg`, `prisma migrate deploy`).
- Os passos equivalentes foram executados localmente (seção 2). **O job do GitHub Actions não foi executado.** Passar localmente é evidência de automação, não de produção.
- **Achado de higiene:** `npm run architecture:audit` regrava `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` (timestamp e contagens). O arquivo versionado está defasado: registra 143 módulos navegáveis, e a geração atual produz 144 (e 107 com recurso, contra 106). Restaurei o arquivo para manter esta auditoria somente leitura. Sugestão para a Fase 0: regenerar e versionar o inventário, ou separar o modo "verificar" do modo "gravar" do script. Classificação: **P3-08**.
- **Achado de qualidade:** lint sem erros, mas com 607 avisos de `@typescript-eslint/no-explicit-any` e similares. Não bloqueia o CI atual. Classificação: **P3-09** (higiene de tipos).

---

## 10. Riscos (P0–P3)

Totais: **P0: 1 · P1: 8 · P2: 10 · P3: 9.**

Escala: **P0** bloqueia go-live ou causa dano financeiro/de dados reais; **P1** alto, corrigir antes de operar o conector; **P2** médio, corrigir no ciclo seguinte; **P3** baixo, higiene e documentação.

### P0 — crítico (1)

**P0-01 — Duplicação de anúncios em Mercado Livre e Nuvemshop.**
- *Evidência:* `server/src/commerce/catalogo.ts` — `reenfileirarPublicacoesAfetadas` (~884–898), `enfileirarPublicacao` (~325–365, `PUBLISHED` fora de `ESTADOS_PIPELINE`), `processarPublicacao` (~389–440), `publicarMercadoLivre` (~590–620, `POST /items`), `publicarNuvemshop` (~625–640, `POST /products`), `UPDATE_QUEUED` nunca atribuído.
- *Impacto:* anúncios duplicados e ativos em marketplace real, com preço e estoque divergentes; venda em anúncio antigo; retentativa após timeout pode criar outro duplicado.
- *Status:* confirmado por leitura de código; **a reproduzir** em teste automatizado de regressão (Fase 0) e em conta de teste (Fase 5).
- *Mitigação imediata recomendada (a decidir pelo Diretor):* não publicar nem editar produtos já publicados em ML/Nuvemshop até a correção.

### P1 — alto (8)

**P1-01 — Webhook Mercado Livre aceito sem autenticação quando o segredo não está definido.** `modules/connectors/webhooks/handlers.ts` (~94–98). Chave de deduplicação `${topic}:${resource}` pode descartar eventos distintos. Valor de `MERCADOLIVRE_WEBHOOK_SECRET` em produção: NÃO VERIFICADO.

**P1-02 — Webhook Mercado Pago (conector) aceito sem segredo.** `verifyMercadoPagoWebhookSignature` retorna `true` sem `MERCADOPAGO_WEBHOOK_SECRET`. Mitigado pela re-busca na API.

**P1-03 — Estoque de ML e Nuvemshop não é sincronizado após venda.** O saldo é enviado apenas na criação do anúncio. Risco de venda acima do estoque no canal. Somente WooCommerce recebe estoque (outbox `woo-estoque`).

**P1-04 — Gestão de chaves de cifra.** Três mecanismos de cifra; chaves dedicadas (`SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`) ausentes do `render.yaml`, o que deriva segredos do `JWT_SECRET`; rotação do `JWT_SECRET` quebra credenciais; fallback fixo `'brobond-dev-secret'` no código. Cadastro do novo motor de pagamento responde 503 sem `SEGREDOS_ENCRYPTION_KEY`/`APP_ENCRYPTION_KEY`.

**P1-05 — Status de WhatsApp sem prova de entrega e sem webhook de status.** A tela diz "Configurado" (correto, com aviso), mas o backend trata "aceito pela API" como envio e não há webhook da Meta para `delivered`, `read` ou `failed`. Falhas por usuário e por template não são registradas.

**P1-06 — E-mail sem verificação de conexão e sem teste de envio.** `mail.ts` não chama `verify()`. Status "CONFIGURADO" é só presença de variáveis. Falhas retornam `nao_enviado` sem detalhe. Dessincronia de `nodemailer` (lock 9.1.1 vs manifesto ^10.3.1; instalado 10.3.1).

**P1-07 — Duplicidade de motores de pagamento.** `server/src/gateway.ts` (legado) e `modules/payments/` (engine) processam os mesmos provedores (Mercado Pago, PagBank, Stripe), com regras de idempotência e de webhook que podem divergir. A ponte `processEngineWebhook` (`gateway.ts` ~1223) reduz o risco, mas não elimina a duplicidade.

**P1-08 — Idempotência de importação WooCommerce sem garantia de unicidade.** `findOne` + `insert` em `vendas.pedido_cliente`, sem `UNIQUE` evidente nas migrations. Importação concorrente pode criar venda duplicada. Importação limitada à primeira página.

### P2 — médio (10)

**P2-01 — Anti-SSRF incompleto em webhooks de saída.** Sem resolução de DNS, sem bloqueio de link-local e `0.0.0.0`, redirecionamentos seguidos. Mitigado por admin com reautenticação e MFA.

**P2-02 — Afirmações não verificadas sobre a Meta.** `modules/connectors/instagram/instagram.service.ts` e o `README` do módulo citam encerramento de 47 endpoints de Commerce Order Management (v26.0, 2026-07-29) e extensão a todas as versões (2026-10-27). **Não verificado** nesta auditoria. Não usar como premissa de decisão sem checagem na documentação oficial.

**P2-03 — Caminho legado de Mercado Livre simulado.** `server/src/marketplace.ts` (`POST /api/marketplace/sincronizar`): URL com `seller_id` placeholder, token estático, erros engolidos, pedidos não persistidos, resposta com contagem enganosa. Coexiste com o conector oficial.

**P2-04 — NF-e por variável global duplica o fiscal por empresa.** `server/src/nfe.ts` vs `server/src/fiscalProvider.ts`. Simulação gravada como `simulada` pode ser confundida com documento fiscal.

**P2-05 — Divergência de URL pública.** `APP_URL` (~18 usos) vs `PUBLIC_BASE_URL` (3 usos). URL de verificação de assinatura depende de `APP_URL` estático.

**P2-06 — Versões de Graph API divergentes.** WhatsApp `v21.0` (padrão) e Instagram `v26.0`. Verificar versões suportadas pela Meta e padronizar com decisão documentada.

**P2-07 — Central de Notificações incompleta e com dois pontos de verdade para SMTP.** Ausentes: conexão validada, último envio, último erro e falha de credencial. Dois endpoints de status (`/api/commerce/notificacoes/status` e `/api/admin/notificacoes/status`).

**P2-08 — Notificações em `ERRO` sem alerta explícito (a validar).** Após 10 tentativas, sem SMTP ou WhatsApp, a entrada do outbox vai para `ERRO`. Confirmar se há alerta ao operador.

**P2-09 — Teste de conexão do Mercado Livre não chama a API.** `testConnection` valida somente presença de variáveis. Mercado Pago tem `validateMercadoPagoAccessToken` (ponto positivo, não replicado).

**P2-10 — Gateway legado responde 409 antes de verificar assinatura.** `server/src/gateway.ts`: "Evento já registrado para outra cobrança" é emitido antes da checagem de assinatura, permitindo que terceiro sem segredo sonde a existência de `evento_id`. Corrigir a ordem (verificar assinatura antes de qualquer resposta de duplicidade).

### P3 — baixo (9)

**P3-01 — Provedores placeholder registrados.** `PIX_DIRECT` e `BOLETO_GENERIC` (e `ACQUIRER_GENERIC`) aparecem no registro sem funcionar (fail-closed). Confirmar se a UI os exibe como opção.

**P3-02 — Identificador de evento PagBank por hash do corpo.** Reentrega com bytes diferentes não é deduplicada. Confirmar com o comportamento de reentrega do provedor.

**P3-03 — `server/.env.example` incompleto.** Ver seção 7.2.

**P3-04 — Falha de decifragem silenciosa.** `decifrarSegredo` retorna `null` sem diagnóstico. Credencial corrompida vira "não configurado".

**P3-05 — Observabilidade não auditada.** Sentry condicionado a `SENTRY_DSN`. Fora do escopo.

**P3-06 — Facebook como canal.** Não há conector próprio. Confirmar se é requisito comercial.

**P3-08 — Inventário arquitetural versionado defasado e script que o regrava.** `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json` registra 143 módulos; a geração atual produz 144. `architecture:audit` sobrescreve o arquivo ao rodar (seção 9.4).

**P3-09 — Avisos de lint em tipos.** 607 avisos (`no-explicit-any` e similares), 0 erros. Não bloqueia CI hoje (seção 9.4).

**P3-07 — Documentação interna com afirmações não verificadas.** `modules/connectors/README.md` contém afirmações sobre a Meta (ver P2-02). Deve ser marcada como alegação até validação.

---

## 11. Roadmap em fases 0–7 (proposta, não executada)

Nenhuma fase foi implementada. Cada fase exige aprovação do Diretor.

**Fase 0 — Baseline e bloqueios operacionais (sem mudança de produto).**
- Diretor decide: suspender publicação e edição de produtos publicados em ML/Nuvemshop (P0-01).
- Diretor confirma no Render a presença e o valor de: `SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `MERCADOLIVRE_WEBHOOK_SECRET`, `MERCADOPAGO_WEBHOOK_SECRET`, `APP_URL`, `PUBLIC_BASE_URL`, variáveis WhatsApp e SMTP. Registrar **presença**, nunca o valor.
- Rodar a suíte completa no job de CI oficial (já executada localmente nesta etapa, seção 2). Regenerar e versionar o inventário arquitetural (P3-08).
- Escrever testes de regressão (sem rede) que **reproduzam** P0-01, P1-01, P1-02, P2-01 e P1-08.

**Fase 1 — Correções críticas de publicação e webhooks (P0/P1).**
- Publicação em ML/Nuvemshop: atualizar por `external_id` quando existir; buscar por SKU antes de criar; chave de idempotência; retentativa sem novo `POST`.
- Webhooks ML e MP do conector: **fail-closed** sem segredo; chave de deduplicação com `_id` ou hash do corpo.
- Remover ou isolar o caminho legado `marketplace.ts` (após confirmar não uso).

**Fase 2 — Segredos e configuração (P1-04, P2-05, P3-03).**
- Chaves dedicadas e separadas por domínio; plano de rotação sem perda de decifragem.
- Consolidar os três mecanismos de cifra em um único serviço de segredos.
- Declarar as chaves no `render.yaml` (`sync: false`) e documentar em `.env.example`.
- Padronizar `APP_URL` como base única de URLs públicas.

**Fase 3 — Pagamentos (P1-07, P2-10, P3-01, P3-02).**
- Definir o motor canônico (`modules/payments/`) e migrar ou aposentar o gateway legado.
- Corrigir a ordem de verificação do 409 (P2-10).
- Remover placeholders do registro ou marcar como não disponíveis na UI.
- Homologação em sandbox: Mercado Pago (PIX, cartão via token, estorno parcial, divergência de valor), PagBank (PIX), Stripe (Checkout).

**Fase 4 — Mensageria (P1-05, P1-06, P2-06, P2-07, P2-08).**
- SMTP: rota de verificação explícita (`verify()`) e envio de teste sob comando do administrador.
- WhatsApp: webhook de status da Meta com assinatura; registro de `sent/delivered/read/failed`; verificação de modelo aprovado por leitura de metadados da Meta.
- Central de Notificações com os 8 estados exigidos e último envio/erro.
- Padronizar versão da Graph API com decisão documentada.

**Fase 5 — Canais, logística e fiscal (P1-03, P1-08, P2-03, P2-04, P2-09).**
- Mercado Livre e Nuvemshop: envio de estoque após venda; homologação OAuth, webhook e publicação em conta de teste.
- WooCommerce: unicidade de pedido e paginação completa; webhook opcional.
- Melhor Envio e Correios: decisão sobre etiqueta SIGEP (fora do escopo atual).
- Focus NFe e PlugNotas: homologação de emissão; remover ou isolar `nfe.ts`.

**Fase 6 — Segurança (P2-01, P3-04).**
- Anti-SSRF completo em webhooks de saída (resolução de DNS, bloqueio de faixas internas, `redirect: 'manual'`).
- Diagnóstico de decifragem; revisão de CORS e origens.
- Revisão de Sentry e logs para garantir ausência de segredos.

**Fase 7 — Go-live controlado e monitoramento.**
- Evidências por conector (seção 12) arquivadas.
- Alertas para outbox em `ERRO`, falhas de webhook e falhas de envio.
- Runbook de incidentes por conector.
- Decisão formal de go-live do Diretor.

---

## 12. Critérios de homologação

Um conector só pode ser declarado **CONFORME** quando todos os critérios aplicáveis tiverem **evidência registrada** (data, ambiente, identificador de transação, sem valores de segredo).

| Critério | Mercado Pago | PagBank | Stripe | Mercado Livre | Nuvemshop | Instagram | WhatsApp | SMTP | WooCommerce | Melhor Envio | Focus/PlugNotas |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Credencial de sandbox cadastrada e validada por chamada real | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Teste de conexão real (não só presença de variável) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Evento real recebido com assinatura válida | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ |
| Evento com assinatura inválida rejeitado | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ |
| Reentrega do mesmo evento não duplica | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | ✔ |
| Operação de escrita com idempotência (criar, estornar, publicar) | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | ✔ |
| Retentativa sem duplicar no provedor | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | ✔ |
| Atualização de item já existente (sem criar novo) | — | — | — | ✔ | ✔ | — | — | — | ✔ | — | — |
| Estoque/saldo refletido no canal após venda | — | — | — | ✔ | ✔ | — | — | — | ✔ | — | — |
| Divergência de valor/estado tratada (409 ou equivalente) | ✔ | ✔ | ✔ | — | — | — | — | — | — | — | — |
| Mensagem de status do provedor (delivered/read/failed) | — | — | — | — | — | — | ✔ | — | — | — | — |
| Verificação de conexão SMTP e envio de teste | — | — | — | — | — | — | — | ✔ | — | — | — |
| Log sem segredos, PII ou tokens | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Segredo cifrado com chave dedicada (não derivada de `JWT_SECRET`) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Teste automatizado de regressão no CI | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

**Evidências mínimas por conector** (exemplos, sem valores):
- Mercado Pago: data, ID de pagamento de sandbox, ID de evento recebido, resposta de consulta `GET /v1/orders/{id}`, ID de estorno, prova de rejeição de assinatura inválida.
- WhatsApp: ID de mensagem aceito, webhook de status `delivered` com carimbo de tempo, nome e idioma do template aprovado, sem os números de destinatário.
- SMTP: resposta do `verify()`, ID de envio de teste recebido em caixa de teste.
- Mercado Livre e Nuvemshop: ID do anúncio criado, prova de atualização sem novo anúncio, prova de baixa de estoque no canal após venda de teste.

---

## 13. Limitações e evidências necessárias

**Limitações desta auditoria.**
- Sem acesso a produção (`brobond-erp.onrender.com`), ao painel do Render, à Meta, aos painéis de Mercado Pago, PagBank, Stripe, Mercado Livre, Nuvemshop, WooCommerce e transportadoras.
- Sem egress aos hosts de provedores. A rede da sandbox só alcança GitHub, npm e PyPI.
- Sem envio de mensagem, cobrança ou webhook real (proibido nesta etapa).
- O job `testes-postgres` do GitHub Actions não foi executado. O PostgreSQL usado foi local (16.14, pacote npm), com `psql` 16.2 de outro pacote (seção 2).
- A verificação de tipos, lint, build, testes, smoke e go-live foi **executada localmente** (seção 2). Não reflete o ambiente de produção.

**Evidências necessárias para fechar NÃO VERIFICADO.**
1. Presença e valor **mascarado** (somente tamanho ou prefixo não sensível) das variáveis declaradas em `render.yaml`, feito pelo Diretor no painel.
2. Console da Meta: status do app, webhooks inscritos, modelos de mensagem WhatsApp com status `APPROVED`, versão da Graph API suportada.
3. Contas de sandbox de cada provedor, com credenciais entregues pelo Diretor por canal seguro (fora do chat e fora do repositório).
4. Confirmação da afirmação sobre encerramento da Commerce Order Management API da Meta (P2-02), na documentação oficial.
5. Confirmação do uso de `caminho legado marketplace.ts` em produção (logs de acesso a `POST /api/marketplace/sincronizar`).
6. Confirmação de `UNIQUE` em `pedido_cliente` no modelo real de armazenamento (P1-08).

---

## 14. Parecer final

**Parecer: NÃO APTO para operação de produção nos conectores auditados, com as seguintes ressalvas:**

1. **Mercado Livre e Nuvemshop: NÃO APTO.** A publicação pode criar anúncios duplicados (P0-01), e não há envio de estoque após venda (P1-03). Recomenda-se suspender publicação e edição de produtos já publicados nesses canais até a Fase 1.
2. **Pagamentos (Mercado Pago, PagBank, Stripe): código de boa qualidade em pontos críticos** (confirmação pela API, idempotência, assinatura HMAC, validação de credencial na conexão), **sem nenhuma prova de operação externa.** Dois caminhos de processamento e um webhook sem segredo (P1-02) exigem correção antes de aceitar tráfego real.
3. **WhatsApp e e-mail: envio implementado, operação não comprovada.** A Central de Notificações é honesta sobre o que não comprova, mas não tem os estados de conexão, entrega e falha. Não é possível afirmar que mensagens chegam ao cliente.
4. **Instagram, WooCommerce e logística: código real com lacunas e sem prova externa.**
5. **Fiscal: adaptadores reais por empresa, sem evidência de emissão.** O caminho de NF-e por variável global deve ser removido ou isolado.
6. **Segurança transversal: base sólida** (AES-GCM, fail-closed na maioria dos webhooks, reautenticação, MFA para admin), com **gestão de chaves a corrigir** (P1-04) e anti-SSRF a completar (P2-01).

**Conclusão.** O repositório **não comprova** integração funcional com nenhum parceiro externo. A matriz de homologação do próprio repositório já registra `EXTERNAL_HOMOLOGATION_READY = NO`, e esta auditoria confirma essa conclusão. A única classificação possível hoje é **"implementado no código, não homologado"**, com um defeito crítico (P0-01) que deve ser tratado antes de qualquer operação de publicação em marketplace.

---

## 15. Respostas objetivas

1. **Quantos conectores foram auditados?** **22** conectores/integrações (Shopee e TikTok Shop foram removidos e não entram na contagem).
2. **Quantos estão CONFORMES?** **0.**
3. **Quantos estão PARCIAIS?** **14.**
4. **Quantos estão NÃO CONFORMES?** **2** (Mercado Livre e Nuvemshop).
5. **Quantos estão NÃO IMPLEMENTADOS?** **6** (provedores genéricos placeholder, Facebook como canal, NF-e por variável global como emissão real, IA, Redis/BullMQ, S3/R2).
6. **Quantos estão operacionais com evidência?** **0.** Todos os gates automatizados locais passam (incluindo `test:pg` com 423 testes em PostgreSQL 16.14), mas eles provam contratos internos com mocks e banco local, não operação com provedor. A matriz de homologação do repositório confirma que nenhuma integração externa foi testada.
7. **Quantos riscos críticos (P0)?** **1** (P0-01: duplicação de anúncios em Mercado Livre e Nuvemshop, confirmada por código e a reproduzir em teste de regressão). Há ainda **8 riscos P1**.
8. **O que falta?**
   - **Decisão do Diretor:** suspender publicação e edição de produtos publicados em ML/Nuvemshop; aprovar o roadmap das fases 0–7.
   - **Verificação no Render (pelo Diretor):** presença e valor mascarado de `SEGREDOS_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `MERCADOLIVRE_WEBHOOK_SECRET`, `MERCADOPAGO_WEBHOOK_SECRET`, `APP_URL`, `PUBLIC_BASE_URL`, variáveis WhatsApp e SMTP.
   - **Meta (pelo Diretor):** status do app, webhooks inscritos, modelos WhatsApp aprovados, versão da Graph API; checagem da alegação de encerramento de endpoints.
   - **Contas de sandbox** de Mercado Pago, PagBank, Stripe, Mercado Livre, Nuvemshop, WooCommerce, Melhor Envio, Focus NFe e PlugNotas, entregues por canal seguro.
   - **Fase 0 de código:** testes de regressão para P0-01, P1-01, P1-02, P2-01 e P1-08 (os gates atuais já passam sem eles); execução do job de CI oficial do GitHub Actions; regeneração do inventário arquitetural (P3-08).
   - **Implementação das fases 1–7**, somente após aprovação expressa.

---

## 16. Próximo passo

Aguardando **aprovação expressa do Diretor** para iniciar qualquer implementação. Nenhuma correção, migration, alteração de variável, token, configuração da Meta, checkout, endpoint, commit, PR, merge, deploy ou disparo foi realizado.

---

## 17. Status de execução (atualizado após a execução das fases)

Este relatório registra a auditoria em 2026-11-03 e **não foi reescrito** para refletir correções. O estado atual de cada fase está em:

- Fases 0–1 (P0-01 e suspensão ML/Nuvemshop): `docs/auditoria/execucao-fase-0-1.md`, commit `0c0e6f5`.
- Fases 2–3 (segredos, webhooks fail-closed, P2-10, placeholders e caminho canônico): `docs/auditoria/execucao-fases-2-3.md`, commits `300ba0c` e `1e5e57c`.
- Plano de migração de segredos (não executado): `docs/seguranca/plano-migracao-segredos.md`.
- Caminho canônico de pagamentos: `docs/pagamentos/ADR-001-motor-canonico.md`; homologação sandbox não executada: `docs/pagamentos/homologacao-sandbox.md`.

- Migração da publicação Nuvemshop para o contrato 2025-03 (decisão (b) aprovada): `docs/auditoria/execucao-migracao-nuvemshop-2025.md`, commit `2c93e33`. Parcial: a leitura de pedidos e produtos continua em v1.
- Fase 6, parte P2-01 (anti-SSRF em webhooks de saída): `docs/auditoria/execucao-fase-6-antissrf.md`, commit `4b8dceb`. Rebinding de DNS permanece como risco residual.

**Ainda não executado:** P1-05 e P1-06 (SMTP `verify()` e webhook de status do WhatsApp; este último depende da decisão (d), não autorizada); Central de Notificações; envio de estoque após venda (P1-03); WooCommerce (P1-08); fiscal (P2-04, homologação); alertas e runbooks da Fase 7; go-live (decisão formal do Diretor). Todas as correções acima têm evidência **local** apenas; nenhuma foi verificada em homologação ou produção.
