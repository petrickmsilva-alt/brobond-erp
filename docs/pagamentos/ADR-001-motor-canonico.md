# ADR-001 — Caminho canônico de pagamentos

Status: **aceito pelo Diretor em 2026-11-03 (decisão (e))**. Escopo confirmado: (1) o Payment Engine (`modules/payments/`) é o caminho canônico de pagamentos; (2) o gateway legado (`server/src/gateway.ts`) passa a ser adaptador de compatibilidade, sem novas funcionalidades; (3) a cifra consolidada descrita em `docs/seguranca/plano-migracao-segredos.md` e na Fase 2 é o padrão.

**Atualização 2026-11-07 (Agente 05):** a cobrança avulsa Mercado Pago foi migrada para o engine (Missão A); as duas portas de webhook foram unificadas em um único pipeline de ingestão (Missão B, P1-07); a identidade de evento do PagBank passou a usar o identificador oficial (`notification_id`) com evidência de hash (Missão C, P3-02). Detalhes em "Consequências verificadas" e "O que NÃO está resolvido". A homologação sandbox externa continua não executada.

## Contexto

Há duas trilhas que tocam os mesmos provedores (Mercado Pago, PagBank, Stripe):

| Trilha | Onde | O que faz hoje |
|---|---|---|
| **Payment Engine** | `modules/payments/` | Intents, tentativas, operações (estorno, captura, cancelamento, confirmação manual), reconciliação, webhooks PagBank/Stripe/MP e lançamento financeiro. Usado pelo checkout de pedidos (`server/src/commerce/pedidos.ts`) e pela devolução (`devolucaoRefund.ts`). |
| **Gateway legado** | `server/src/gateway.ts` + `modules/payments/providers/mercado-pago/legacy.ts` | Cobrança avulsa do financeiro (`POST /api/financeiro/gateway/cobrancas`), vinculada a lançamentos e vendas; recebe `POST /api/gateway/webhooks/:provider` e encaminha PagBank/Stripe ao engine (`processEngineWebhook`). |

Os provedores PagBank e Stripe **não** criam cobrança pela trilha legada (retorna 405 "Utilize o Payment Engine"). Só o Mercado Pago cria cobrança avulsa no legado.

## Decisão

1. **O Payment Engine (`modules/payments/`) é o caminho canônico** para integração com provedores: criação, consulta, operações, webhooks e lançamento. Novos provedores ou fluxos entram só pelo engine.
2. **O gateway legado fica como adaptador de compatibilidade.** Ele não ganha funcionalidades novas de provedor. Migrar a cobrança avulsa do Mercado Pago para o engine é a pendência principal desta decisão.
3. **Provedores sem adaptador real** (`PIX_DIRECT`, `BOLETO_GENERIC`, `ACQUIRER_GENERIC`) permanecem no registro como instâncias da base fail-closed, mas **não são oferecidos** para configuração nem para roteamento (`provedorImplementado`, `readiness().implementado`).

## Invariantes que devem valer nas duas trilhas

- **Idempotência de criação:** engine usa `operationKey` por tentativa e `createForOrder` com chave; legado reserva a cobrança como `PROCESSING` antes da chamada, marca `UNCERTAIN` em erro e não repete a chamada às cegas.
- **Idempotência de operação:** `mutate` exige `Idempotency-Key` válida (8–120 caracteres seguros) e compara o hash da operação; reuso com dados diferentes é 409.
- **Webhook fail-closed:** sem segredo (ou token, no PagBank) nenhuma entrega é aceita. Stripe tem janela de 300 s. Mercado Pago confere o manifesto HMAC.
- **Resposta sem sondagem:** conflito de `evento_id` só é revelado a quem prova a assinatura (P2-10, corrigido na Fase 2).
- **Histórico preservado:** nenhum caminho financeiro apaga cobrança, tentativa, operação, estorno ou evento.

## Consequências verificadas nesta entrega

- Testes automatizados: `server/test/fase3-pagamentos-canonico.test.ts` (contratos locais, sem rede) e `server/test/fase2-seguranca-credenciais.test.ts` (webhooks e P2-10).
- Placeholders não aparecem mais como opção de configuração na tela de provedores nem nas regras de roteamento.

## O que NÃO está resolvido

- **Cobrança avulsa Mercado Pago** — RESOLVIDA (Missão A, 2026-11-07). O gateway legado (`criarCobrancaGateway`) não cria mais cobrança por conta própria: ele reserva a cobrança (idempotência, `PROCESSING`/`UNCERTAIN`/`FAILED`) e encaminha a criação ao adaptador canônico do engine (`modules/payments/application/standalone-charge.ts`). Não existe segunda implementação de criação. Compatibilidade do contrato público (`POST /api/financeiro/gateway/cobrancas`) preservada. Testes: `server/test/payments-avulsa-engine.test.ts`.
- **Duas portas de entrada de webhook (P1-07)** — RESOLVIDA (Missão B, 2026-11-07). Há um único ponto de entrada por provedor (`POST /api/gateway/webhooks/:provider`) e uma única regra de ingestão/deduplicação (`modules/payments/application/webhook-ingest.ts`), aplicada a todos os provedores e roteada internamente ao engine (`processEngineWebhook`). Assinatura verificada sobre os bytes crus antes da deduplicação; evento autenticado persistido antes do processamento; deduplicação por (provedor, evento_id) com isolamento por empresa. Testes: `server/test/payments-webhook-pipeline.test.ts`.
- **PagBank reentrega (P3-02)** — RESOLVIDA (Missão C, 2026-11-07). O contrato oficial do PagBank (`developer.pagbank.com.br/reference/webhooks`) inclui, para PIX, um identificador oficial de notificação (`charges[].payment_method.pix.notification_id`, formato `NTF_...`). A identidade de evento agora usa esse id quando presente e, no fallback, a Order + o conjunto normalizado de cobranças/estados; o hash do corpo continua como evidência complementar (`payload_hash`), nunca como chave. Testes: `server/test/pagbank-webhook-reentrega.test.ts`.
- **Homologação sandbox externa** — PENDENTE. Nenhuma afirmação foi verificada com provedores reais (ver `docs/pagamentos/homologacao-sandbox.md`). Sem credenciais autorizadas, os casos externos permanecem como pendência de homologação.
