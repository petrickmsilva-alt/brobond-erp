# EVENT-CATALOG — catálogo de eventos (Fase 0)

**Data:** 2026-11-07 · **Branch:** `architecture/fase-0-blueprint`
**Base:** `server/src/commerce/outbox.ts`, `server/src/eventosVenda.ts`,
`modules/connectors/core/sale-events.ts`, `server/src/scheduled.ts`,
`db/schema.sql` (`commerce_outbox`, `commerce_webhook_events`,
`logistics_webhook_inbox`, `gateway_webhook_events`, `connector_events`).

> **Regra.** Todo evento tem contrato, versão/identidade e **contexto de
> empresa**. **Nenhum evento é publicado antes do commit** da transação de
> origem — efeitos externos passam pela `commerce_outbox`; notificações internas
> *best effort* usam módulo-folha.

---

## 1. Infraestrutura de eventos (real)

| Mecanismo | Papel | Garantia |
|---|---|---|
| `commerce_outbox` | fila única para **efeito externo** confiável | at-least-once, claim CAS, backoff, DLQ |
| Hooks internos (`eventosVenda.ts`, `sale-events.ts`) | notificar projeção/efeito interno | *best effort*, nunca derruba o fluxo |
| Caixas de entrada de webhook | receber eventos externos | *at-least-once*, assinatura verificada |
| Cron (`scheduled.ts`) | drenar a outbox por processo | processo dono por tipo |

### 1.1 Tipos de outbox (`TipoOutbox`)

| Tipo | Uso | Ação |
|---|---|---|
| `conversao` | converter pedido em venda | cria `vendas` |
| `publicacao` | publicar no canal | `processarPublicacao` |
| `sincronizacao` | entrega externa (estoque/pedido/notificação) | `acao` decide |
| `alerta` | alerta operacional | notificação |
| `refund_devolucao` | estorno/devolução | efeito financeiro/logístico |

### 1.2 Ações de `sincronizacao` (`payload.acao`)

| Ação | Efeito |
|---|---|
| `notificacao` | evento transacional de notificação |
| `woo-estoque` | empurra estoque para WooCommerce |
| `woo-pedidos` | importa pedidos da loja |
| `woo-publicacao` | publica produto na loja |
| `woo-webhook` | reprocessa webhook de loja |
| `logistics-*` | roteado para o motor de logística |

### 1.3 Processos de cron × tipos

| Processo | Tipos que drena |
|---|---|
| `relatorios` | — (emissão de relatórios) |
| `pagamentos` | sincronização de pagamentos, expiração de checkout, reembolso |
| `publicacoes` | `publicacao` |
| `pedidos` | `conversao`, `notificacao`, `alerta`, `sincronizacao` |
| `crm` | lembretes de CRM |

---

## 2. Catálogo de eventos de domínio

Os nomes abaixo são **arquiteturais** (a missão os cita). Onde o projeto já
implementa o fato, a coluna "mecanismo real" aponta o código. Onde não há evento
formal, o fato é tratado por **auditoria** ou por **hook interno** — não se
inventou um segundo barramento.

| Evento (referência) | Fato no ERP | Mecanismo real | Contexto de empresa |
|---|---|---|---|
| `ProductCreated` / `ProductUpdated` | criação/edição de produto | auditoria + publicação de canal (`publicacao`) | ✅ |
| `PriceChanged` | alteração de preço | auditoria; `commerce_precos` (override por loja) | ✅ |
| `InventoryAvailabilityChanged` | movimento de estoque | `movimentacoes` (evento) → projeção `estoques` | ✅ |
| `OrderReceived` | pedido recebido (canal) | `connector_events` / webhook → `sales` | ✅ |
| `OrderValidated` | pedido validado | `commerce_pedidos` (estado) | ✅ |
| `InventoryReserved` | reserva de estoque | `estoque_reservas` (SERIALIZABLE) | ✅ |
| `PaymentAuthorized` | pagamento autorizado | Payment Engine (`payment_*`) + webhook | ✅ |
| `PaymentSettled` | pagamento liquidado | Payment Engine + lançamento financeiro | ✅ |
| `ShipmentCreated` | envio criado | `envios` / `logistics-*` (outbox) | ✅ |
| `OrderDelivered` | entrega concluída | `envio_eventos` / webhook de transportadora | ✅ |
| `CommissionAccrued` | comissão apurada | `comissoes_apuradas` + `comissoes_eventos` | ✅ |
| `VendaFaturada` / `VendaEstornada` | venda faturada/estornada | `eventosVenda.ts` (hook folha) → projeção `sales` | ✅ |
| `SaleIngested` | venda de marketplace ingerida | `sale-events.ts` + `upsertIngestedSale` | ✅ |

---

## 3. Contrato de evento (padrão)

Todo evento **externo** carrega:

```jsonc
{
  "empresa_id": 1,            // contexto de tenant (obrigatório)
  "tipo": "sincronizacao",    // TipoOutbox
  "chave": "woo-estoque:produto:123", // idempotência (empresa,tipo,chave)
  "payload": { "acao": "woo-estoque", /* ... */ },
  "estado": "PENDENTE",       // PENDENTE|PROCESSANDO|PROCESSADO|ERRO|ESGOTADO
  "tentativas": 0
}
```

| Campo | Regra |
|---|---|
| identidade única | `(empresa_id, tipo, chave)` — `ON CONFLICT DO NOTHING` |
| versão | evolução por `tipo`/`acao`; novo `tipo` exige migração aplicada |
| retry/backoff | crescente; esgotamento → dead-letter |
| correlação | `request_id`/`correlation_id` propagados do HTTP |
| observabilidade | log estruturado por evento (`outbox_entrada_esgotada`) |

---

## 4. Consistência e ordenação

- **Publicação após commit:** o registro na outbox acontece **dentro** da
  transação do fato; o worker só publica depois.
- **Out-of-order safe:** evento de pedido já importado é apenas reconhecido
  (não sobrescreve) — ver `WH-3` nos testes.
- **Reentrega simultânea:** retry curto em `23505`/`40001`/`40P01`
  (`runInTransactionComCorrida`).
- **Idempotência por loja e por entrega** (WH-2).

---

## 5. Gaps de eventos

| Gap | Nível | Observação |
|---|---|---|
| Não há barramento de eventos de domínio genérico (só outbox + hooks) | — | **Por desenho**: não criar segundo mecanismo; a outbox atende |
| Evento de CRM de mudança de estágio | P3 | hoje é histórico + auditoria, não evento externo |

---

*Próximo documento: [`ADR/`](ADR/).*
