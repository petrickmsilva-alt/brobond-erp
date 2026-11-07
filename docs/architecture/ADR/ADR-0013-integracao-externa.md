# ADR-0013 — Estratégia de integração externa

* **Identificador:** ADR-0013
* **Título:** Estratégia de integração externa (webhooks, conectores, providers)
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0006, ADR-0010, `INTEGRATION-ARCHITECTURE.md`

## Contexto

O ERP integra WooCommerce (multi-store + legado), marketplaces (conectores),
gateways (Payment Engine) e transportadoras (Logistics Engine), com webhooks
assinados e outbox para saída.

## Problema

Padronizar entrada e saída, autoridade de dados e isolamento por tenant.

## Decisão

1. **Entrada:** rota pública (antes do `requireAuth`), rate limit, **assinatura
   verificada**, gravação na caixa de entrada, processamento idempotente.
2. **Saída:** outbox na mesma transação; worker drena por tipo/processo.
3. **Empresa resolvida pelo conector/cobrança**, nunca pelo payload.
4. **Preço/estoque:** ERP é autoridade; externo é evidência.
5. **Bounded contexts** (`modules/payments`, `modules/logistics`,
   `modules/connectors`) com provider por plataforma.
6. **Transportadora sem contrato nasce desabilitada.**
7. **Não ativar integração/cutover** sem homologação e autorização.

## Alternativas consideradas

- **Webhook sem assinatura:** rejeitada (aceitar payload cego é inseguro).
- **Sincronizar por polling apenas:** rejeitada; webhook + reconciliação cobre
  melhor.

## Consequências

- Reconciliação ERP × loja com divergências classificadas (automática × humana).
- Homologação externa permanece pendente por contrato.

## Riscos

- Falha externa não derruba o ERP (erros viram 502 e vão para dead-letter).
