# ADR-001 — Caminho canônico de pagamentos

Status: **proposto nesta entrega, em cumprimento da ordem de execução da Fase 3**. Não há decisão específica do Diretor sobre o caminho canônico. Implementação parcial; a consolidação completa é pendência registrada.

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

- **Duas portas de entrada de webhook** (`/api/gateway/webhooks/:provider` e o engine) — risco P1-07. Deduplicação e estado são aplicados por caminhos diferentes; falta um único ponto de entrada.
- **PagBank:** o identificador de evento é o hash do corpo (P3-02). Reentrega com bytes diferentes não é deduplicada. Precisa de confirmação do contrato de reentrega do PagBank (**não verificado**).
- **Migração da cobrança avulsa do Mercado Pago** para o engine: não iniciada. Exige decisão de cronograma do Diretor e homologação.
- Nenhuma destas afirmações foi verificada com os provedores reais (ver `docs/pagamentos/homologacao-sandbox.md`).
