# INTEGRATION-ARCHITECTURE — integrações (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `server/src/commerce/`, `server/src/loja.ts`, `modules/connectors/`,
`modules/payments/`, `modules/logistics/`, `docs/COMMERCE-WOOCOMMERCE-MULTI-STORE.md`,
`docs/LOGISTICA-MOTOR-MULTICANAL.md`, `docs/architecture/payment-engine.md`.

---

## 1. Canais comerciais (estrutura oficial)

| Canal | Plataforma | Endereço público | Papel |
|---|---|---|---|
| **RETAIL** | WooCommerce | `https://brobond.com.br` | loja de varejo (**única** pública após a retirada do `/loja` nativo) |
| **WHOLESALE** | WooCommerce | `https://atacado.brobond.com.br` | atacado |
| **REPRESENTATIVES** | Portal Brobond | `https://catalogo.brobond.com.br` | portal de representantes |

Regra: **preservar a independência de cada canal sem duplicar** o cadastro mestre
de produto, estoque, cliente, pedido ou financeiro. O cadastro é único (ERP);
os canais são janelas sobre ele.

---

## 2. Mapa de integrações

```
                         ┌──────────────────────────┐
   WooCommerce RETAIL ──►│                          │──► publicação (estoque/preço)
   WooCommerce WHOLESALE─►│      BROBOND ERP         │──► importação (pedidos)
   Marketplaces ────────►│  (outbox + conectores)   │──► webhooks assinados
   Gateways de pagamento►│                          │──► Payment Engine
   Transportadoras ─────►│                          │──► Logistics Engine
                         └──────────────────────────┘
```

| Integração | Direção | Mecanismo | Idempotência |
|---|---|---|---|
| WooCommerce multi-store | bidirecional | `commerce/woocommerce/` (registry multi-loja) | `WOO-<LOJA>-<id>` |
| WooCommerce legado | bidirecional | `loja.ts` (env único) | `WOO-<id>` (runbook de cutover) |
| Marketplaces (ML, Nuvemshop, Instagram) | entrada | `modules/connectors` | `reference` + índice único de `sales` |
| Pagamentos | bidirecional | `modules/payments` + webhook assinado | `external_reference` |
| Logística | bidirecional | `modules/logistics` + webhook assinado | chave de evento por entrega |
| Catálogo público | saída | `/api/publico/catalogo/:token` (iframe/JSON) | token por empresa |

---

## 3. Padrões de integração

### 3.1 Entrada (webhook)

1. Rota pública **antes** do `requireAuth` (por desenho), com rate limit próprio.
2. **Assinatura verificada** (segredo dedicado; nunca aceitar payload cego).
3. Evento gravado na caixa de entrada (`commerce_webhook_events`,
   `logistics_webhook_inbox`) — *at-least-once*.
4. Processamento **idempotente** e **out-of-order safe**.
5. A empresa é resolvida **pelo conector/cobrança**, nunca pelo payload.

### 3.2 Saída (publicação/estoque)

1. Efeito externo é **enfileirado na outbox na mesma transação** do fato.
2. Worker drena por tipo/processo (`TIPOS_OUTBOX_POR_PROCESSO`).
3. Backoff crescente + dead-letter; **nada** é publicado antes do commit.

### 3.3 Autoridade de preço/estoque (decisão preservada)

- **Preço:** ERP é a autoridade (`produtos.preco_venda` varejo,
  `produtos.preco_atacado` atacado); `commerce_precos` faz override por loja.
  Preço remoto é **evidência** (`preco_externo_recebido`), nunca autoridade.
- **Estoque:** ERP é a autoridade; disponível canônico (físico − reservas −
  empenhos − bloqueios); nunca somar locais indiscriminadamente.

---

## 4. Motor de logística (multicanal)

- Reusa `ShippingProvider`/`envios`/`envio_eventos`/outbox/config cifrada.
- Sem `LOGISTICS_ENABLED`, opera em **modo seguro**.
- Transportadora sem contrato nasce **desabilitada**; nenhum endpoint é presumido.
- Diferencia **cotação · frete · remessa · etiqueta · rastreamento · entrega ·
  ocorrência**.
- Doc: `docs/LOGISTICA-MOTOR-MULTICANAL.md`.

---

## 5. Payment Engine

- Motor **único** de pagamentos: criação de cobrança, autorização, liquidação,
  estorno, repasse, disputa, conciliação.
- Providers: Mercado Pago, PagBank, Stripe, generic, manual, testing.
- `gateway_cobrancas` = espelho do provider; `gateway_webhook_events` = inbox.
- Status de pedido **não** é prova de liquidação financeira.
- Doc: `docs/architecture/payment-engine.md`.

---

## 6. Conectores (marketplace)

- `modules/connectors/core` (factory, service, repository, crypto, oauth-state).
- `modules/connectors/ingestion` (venda: `sales.service.ts` com retry de corrida).
- `modules/connectors/webhooks` (verificação de assinatura).
- Providers por plataforma: mercadolivre, nuvemshop, mercadopago, instagram.
- **Nunca inventa cadastro:** SKU desconhecido volta em `pendentes`.

---

## 7. Configuração e segredos

- Toda variável de ambiente lida no código tem linha em
  `docs/auditoria/matriz-configuracao-producao.md` (teste
  `config-inventario-producao`).
- Toda chave do `render.yaml` também.
- Segredos de integração cifrados em `configuracoes`; nunca em claro.
- `TRUST_PROXY` explícito (padrão seguro: nenhum proxy confiado).

---

## 8. Homologação e produção

| Regra | Situação |
|---|---|
| Não ativar integração externa nesta missão | ✅ respeitado |
| Não realizar cutover comercial | ✅ respeitado |
| Não alterar DNS/edge | ✅ respeitado |
| Integração pronta ≠ homologada/autorizada | documentado |

---

*Próximo documento: [`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md).*
