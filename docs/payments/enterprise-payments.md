# Pagamentos e conciliação — estado implementado

O Engine trabalha em centavos, roteia por empresa/método/capacidade e registra intenção, tentativa e operação. Mercado Pago PIX, Stripe Checkout/PaymentIntent e PagBank PIX têm adapters; capabilities não habilitadas não são anunciadas. Confirmação manual é explícita. Cartão não é capturado pelo ERP: usa token/checkout do provider. Nenhuma chamada de teste constitui homologação financeira.

## Contrato operacional

- `GET /api/commerce/payments/late-reviews[/:id]` é paginado, sem cache compartilhado, escopado à empresa e restrito à gestão autorizada. Não há botão de marcar como resolvido sem evidência.
- `GET /api/commerce/payments/transactions[/:id]`; `POST /api/commerce/payments/:id/{refund,capture,cancel,manual-confirm}` usam RBAC e chave `Idempotency-Key`. O valor do Engine é em unidades mínimas; a cobrança legada usa reais.
- `GET /api/commerce/payments/{refunds,reconciliation,webhooks}`; `GET/POST /api/commerce/payments/payouts...` e `/disputes...` expõem extratos importados/correções/concilições e disputas/evidências internas auditadas. MATCHED exige vínculo coerente ao extrato; não prova transferência por si só.
- Webhooks autenticados são persistidos antes do processamento, com hash/correlação e campos minimizados; erros de processamento não salvam/logam mensagem arbitrária do provider. O job volta a consultar provider por lote, inclusive intenções encerradas e operações ativas, e pode recuperar evidência de pagamento tardio ou refund incerto.
- Refund com valor confirmado menor que baseline + solicitado mantém operação e refund `UNCERTAIN` e lock ativo, sem repetir escrita externa; somente a parte comprovada é projetada. `REFUNDED` sem quantia cumulativa integral é recusado. Stripe e PagBank não confirmam pagamento integral sem prova de captura integral. O fluxo legado não aceita refund parcial, e `charged_back` não é sinônimo de refund.
- O `REFUNDED` de cobrança legada histórica, sozinho, não fecha a fila tardia. Mercado Pago valida referência, BRL, total e valor devolvido via consulta autorizada antes de fechamento. Outras cobranças legadas sem prova ficam abertas para investigação.

## Limitações

Não existem ingestão automática completa de repasses/MDR por provider, envio externo de evidências de disputa, todos os meios por todos os adapters, nem sincronização automática de toda mudança posterior de disputa. A identificação do refund apenas pelo saldo cumulativo pode não atribuir um estorno externo concorrente à operação local. A política de captura integral e pagamentos parciais precisa de evolução de domínio para suportar captura parcial. Reconciliação de timeout e concorrências entre provedor e ERP requer operação supervisionada. Ver `../BROBOND-ENTERPRISE-WAVES-1-2-3-AUDIT.md` para gaps e evidências.

### Closure Pass — evidências bancárias

Baixa financeira, vínculo de extrato e auditoria são atômicos; payout e baixa não podem disputar a mesma linha por coincidência de valor. CSV sem identificador bancário igual a uma linha anterior é ambíguo e bloqueado. CNAB novo usa uma transação por linha e não presume valor nominal pago nem associação por ID interno; os layouts e provedores não foram homologados. As respostas de Mercado Pago com identidade ou valor de refund desconhecidos permanecem inconclusivas, sem sucesso fabricado. O fechamento integrado, a atribuição de refunds concorrentes e os efeitos financeiros completos de disputas permanecem abertos.
