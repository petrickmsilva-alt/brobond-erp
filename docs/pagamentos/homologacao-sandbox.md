# Checklist de homologação de pagamentos (sandbox)

Status: **NÃO EXECUTADA**. Nesta sandbox não há saída de rede para os provedores, nem credenciais de teste. Os testes automatizados em `server/test/fase3-pagamentos-canonico.test.ts` e `server/test/fase2-seguranca-credenciais.test.ts` verificam contratos locais e **não** são homologação.

## Pré-requisitos

- Credenciais de **sandbox** cadastradas por empresa em Financeiro → Gateway / Commerce → Pagamentos (PagBank e Stripe guardam credenciais no banco, cifradas; não há variável de ambiente para elas). Não colar credenciais neste documento nem em chat.
- Mercado Pago: `MERCADOPAGO_WEBHOOK_SECRET` (informado pelo Diretor como já cadastrado em produção; presença não verificada por mim). `MERCADOPAGO_ACCESS_TOKEN`: **presença não confirmada**.
- Ambiente de teste com `APP_URL` público alcançável pelo provedor para webhooks.

## Casos (marcar com data, ambiente, identificador de transação; nunca o valor de segredo)

| # | Provedor | Caso | Evidência exigida | Status |
|---|---|---|---|---|
| 1 | Mercado Pago | PIX: criar, pagar no sandbox, receber webhook assinado, pedido vai a PAGO | id do pagamento, id do evento, estado final | NÃO EXECUTADO |
| 2 | Mercado Pago | Cartão via token: aprovado e recusado | id do pagamento e motivo de recusa | NÃO EXECUTADO |
| 3 | Mercado Pago | Estorno parcial: saldo reembolsável respeitado; reenvio com a mesma Idempotency-Key não duplica | id do estorno, duas respostas idênticas | NÃO EXECUTADO |
| 4 | Mercado Pago | Divergência de valor entre webhook e consulta: estado não é aplicado | id e valores comparados | NÃO EXECUTADO |
| 5 | Mercado Pago | Webhook sem assinatura e com assinatura adulterada: 401, nada gravado | resposta HTTP e ausência de linha nova | NÃO EXECUTADO |
| 6 | PagBank | PIX: criação, pagamento, webhook com token `x-authenticity-token` | id do pedido ORDE_, evento | NÃO EXECUTADO |
| 7 | PagBank | Reentrega do mesmo evento com bytes diferentes (P3-02) | comportamento observado do provedor | NÃO EXECUTADO |
| 8 | Stripe | Checkout Session: criar, pagar, `checkout.session.completed` com `Stripe-Signature` válida | id da sessão e do evento | NÃO EXECUTADO |
| 9 | Stripe | Assinatura fora da janela de 300 s: recusada | resposta HTTP | NÃO EXECUTADO |

## Critério de conclusão

Uma linha só vira **CONFORME** com evidência reproduzível anexada. Um caso sem execução permanece NÃO EXECUTADO, mesmo que o teste automatizado correspondente passe.
