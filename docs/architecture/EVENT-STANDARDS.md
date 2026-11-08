# EVENT-STANDARDS — eventos, Outbox e Inbox

**Data:** 2026-11-07 · **Branch:** `architecture/fase-1-foundation`
**Referência:** ADR-0010 (eventos/outbox/inbox), `EVENT-CATALOG.md` (Fase 0).

> **Invariante.** Efeito externo é gravado no **outbox na mesma transação** do
> fato que o origina — nunca publicado antes do commit. Não existe um segundo
> mecanismo de outbox.

---

## 1. Componentes

| Componente | Onde | Papel |
|---|---|---|
| **Outbox** | `commerce_outbox` (`server/src/commerce/outbox.ts`) | fila única de efeitos externos: claim CAS, backoff, dead-letter |
| **Publisher (interno)** | `eventosVenda.ts`, `sale-events.ts` (módulos-folha) | notificação *best effort* de projeções internas |
| **Inbox (entrada)** | webhooks assinados (WooCommerce, gateways, conectores) | recepção idempotente, out-of-order safe |
| **Worker** | `scheduled.ts` (processos `relatorios|pagamentos|publicacoes|pedidos|crm`) | drena por tipo/processo |

## 2. Contrato de um evento

Todo evento tem: **tipo**, **versão** (implícita no `tipo`/payload), **chave
única** `(empresa_id, tipo, chave)`, **empresa**, **payload** e **correlação**.

Tipos de outbox aceitos pela cadeia de migrations (**conjunto fechado**):
`conversao`, `publicacao`, `sincronizacao`, `alerta`, `refund_devolucao`.

> **Por que o conjunto é fechado.** Introduzir um `tipo` novo exigiria alterar
> migrations **já aplicadas** (o `CHECK` da 0090 recusa linhas fora do conjunto
> ao reconstruir o schema). Por isso eventos de comunicação usam
> `sincronizacao` + `payload.acao='notificacao'` — sem criar um segundo outbox e
> sem mexer em migration existente.

## 3. Semântica de entrega

- **At-least-once:** a chave única evita duplicar o *registro*; a entrega externa
  pode repetir. O consumidor externo precisa ser idempotente.
- **Claim CAS** (`PENDENTE`→`PROCESSANDO`): duas varreduras não processam a mesma
  entrada; entrada presa há 10 min volta para a fila.
- **Backoff** por tentativa; após `MAX_TENTATIVAS`, vai para dead-letter.
- **Ordem:** não garantida; o consumidor trata fora de ordem.

## 4. Regras

1. Gravar o outbox **dentro** da transação do fato (`tx`).
2. Nunca publicar antes do commit.
3. Reentrega é esperada — idempotência por chave.
4. Erro externo → `ERRO` + `ultimo_erro`, não 500 silencioso.
5. Falha que precisa de gente → tipo `alerta`.
6. Correlação (request id) acompanha o payload quando aplicável.
7. Evento de domínio é **referência** (adaptar ao padrão real): `ProductCreated`,
   `PriceChanged`, `InventoryAvailabilityChanged`, `OrderReceived`,
   `InventoryReserved`, `PaymentAuthorized`, `PaymentSettled`, `ShipmentCreated`,
   `OrderDelivered`, `CommissionAccrued`.

## 5. Inbox (webhooks)

- Rota pública com rate limit; **assinatura verificada** antes de processar.
- Empresa resolvida pelo **conector/rota**, nunca pelo payload.
- Gravação antes do processamento; processamento idempotente; out-of-order safe.
- Testes: `woocommerce-webhooks-reconciliacao.test.ts`,
  `webhooks-empresa-isolamento.test.ts`, `outbox-notificacoes-cross-tenant.test.ts`.

## 6. Critérios de aceite

1. Efeito externo via outbox na mesma transação.
2. Chave única `(empresa,tipo,chave)`.
3. Reentrega idempotente.
4. Falha vira `ERRO`/dead-letter com evidência.
5. Nenhum segundo outbox criado.
6. Teste de idempotência e de não-cruzamento de tenant.
