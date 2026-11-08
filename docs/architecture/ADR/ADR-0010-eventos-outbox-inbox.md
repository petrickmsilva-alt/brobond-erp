# ADR-0010 — Eventos e Outbox/Inbox

* **Identificador:** ADR-0010
* **Título:** Eventos de domínio, Outbox e Inbox
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0002, `EVENT-CATALOG.md`

## Contexto

`commerce_outbox` é a fila única (claim CAS, backoff, dead-letter) para efeitos
externos; hooks internos *best effort* (`eventosVenda.ts`, `sale-events.ts`)
mantêm projeções; caixas de entrada recebem webhooks.

## Problema

Garantir consistência entre o commit de um fato e seus efeitos externos, sem
criar um segundo mecanismo de outbox.

## Decisão

1. **Efeito externo** → `commerce_outbox`, gravado na **mesma transação** do
   fato; **nunca** publicar antes do commit.
2. **Notificação interna** → módulo-folha *best effort* (nunca derruba o fluxo).
3. **Entrada externa** → caixa de entrada com assinatura verificada,
   *at-least-once*, idempotente, out-of-order safe.
4. **Idempotência** por `(empresa_id, tipo, chave)`.
5. **Não criar um segundo outbox** — o existente atende.

## Alternativas consideradas

- **Kafka/RabbitMQ:** rejeitada. Sem requisito; adicionaria infraestrutura.
- **Publicar direto no commit sem outbox:** rejeitada (perda em falha externa).

## Consequências

- Entrega *at-least-once* com deduplicação por chave.
- Cron drena por processo dono do tipo.

## Riscos

- Reentrega simultânea → tratada por retry de corrida (`runInTransactionComCorrida`).
