# BROBOND Payment Engine

## 1. Fronteiras e decisão arquitetural

O checkout não escolhe gateways. `server/src/commerce/vitrine.ts` calcula preço,
estoque, frete, promoção e cupom no servidor, reserva estoque pela infraestrutura
canônica e chama `paymentEngine.createForOrder`. O domínio reside em
`modules/payments`, adaptado ao Store/SQL já usados pelo ERP.

```text
Commerce Checkout → PaymentOrchestrator → ProviderRouter → ProviderRegistry
                                                        ↓
                                                   PaymentProvider
                                                        ↓
                                             API externa / ambiente hosted
```

`gateway_configs` continua sendo a conta empresarial cifrada;
`gateway_cobrancas` continua sendo a transação compatível com o Finance;
`gateway_webhook_events` é o inbox existente. Não há outro ledger, encryption,
audit ou segundo inbox. Os dados antigos não são apagados/backfilled com status
inventados. A migration SQL 0069 é aditiva. O boot existente aplica a migration;
Prisma não é o dono destas tabelas (assim como o financeiro operacional).

## 2. Domínio e persistência

- `payment_intents`: uma intenção por empresa/pedido, moeda, expoente monetário,
  valor inteiro em unidades mínimas, canal, método, provider, correlação e estado.
- `payment_attempts`: histórico por tentativa, referência externa, valores
  solicitado/autorizado/capturado/reembolsado, falha normalizada, correlação.
- `payment_operations`: idempotência operacional, hash dos parâmetros, claim,
  resultado e incerteza. `active_operation` serializa mutações da intenção.
- `payment_methods` e `payment_routing_rules`: configuração por empresa.
- `payment_refunds`: solicitação e conclusão, inclusive parcial.
- `payment_disputes`: estado e referência da disputa; sem inventar evidência externa.
- `payment_settlements`: realidade de liquidação/reconciliação; não movimenta caixa.
- `payment_payouts` (0073): relatório manual normalizado e vínculo opcional à linha do extrato da mesma empresa; evidência, não lançamento de caixa.

Todas possuem `empresa_id`. FKs compostas impedem vincular intent/attempt/refund
entre empresas. As APIs por ID consultam empresa + ID, nunca apenas ID. Uma
chave única em `(empresa_id, order_id)` impede duas intenções para o mesmo pedido.
O catálogo normalizado está em `domain/payment.ts`. PIX e BOLETO são métodos;
`PIX_DIRECT` é apenas o slot não vinculado de um futuro banco/PSP: não possui
capabilities, não cria PIX e não é anunciado como gateway Pix funcional.

## 3. Adapters: cobertura efetivamente implementada

A interface normalizada declara criação, autorização, captura, cancelamento,
refund/partial refund, consulta, verificação/normalização de webhook, health e
capabilities. Operação não implementada falha explicitamente, nunca simula êxito.

| Adapter                               | Fluxo implementado no novo checkout                                                                                   | Observação                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mercado Pago                          | PIX via `/v1/payments`; consulta, cancelamento e refund                                                               | Preserva a API Payments já usada, **não** afirma ter migrado para Orders. A implementação legada foi movida para `providers/mercado-pago/legacy.ts`. Fluxos legados de cartão/boleto continuam disponíveis no gateway financeiro, mas não são anunciados no novo checkout sem um fluxo seguro completo. |
| Stripe                                | Checkout Sessions hosted: cartão, PIX e boleto com opt-in; autorização/captura manual de cartão, cancelamento, refund | Depende da disponibilidade real na conta/região e da habilitação explícita. O ERP não captura cartão. PaymentIntent e charge são consultados para confirmar o estado.                                                                                                                                   |
| PagBank                               | Orders PIX, consulta de Order, cancel/refund da charge via API oficial                                                | **Cartão, débito e boleto PagBank não estão implementados neste round.** Não são anunciados como capabilities nem tratados como simples pendência de credencial.                                                                                                                                        |
| Manual                                | `PENDING_MANUAL_CONFIRMATION`                                                                                         | Confirmação somente por gerente/admin no backend; nunca paga automaticamente.                                                                                                                                                                                                                           |
| Generic / banco/PSP / boleto genérico | Contrato extensível, sem API externa vinculada                                                                        | `NOT_CONFIGURED`, sem transações fictícias.                                                                                                                                                                                                                                                             |

A matriz é derivada dos adapters + configuração empresarial, não de uma tabela
marketing de capacidades do mercado. Sem credencial/URL/webhook necessários não
há método disponível. Campos de capability incluem país/moeda, limites,
parcelamento, auth/capture/cancel/refund, recorrência, tokenização, 3DS,
assincronicidade e comportamento de settlement. Não se anuncia recorrência ou
payment method vaulting: `createPaymentMethod` falha fechado nos adapters atuais.

## 4. Configuração e segredos

`gateway_configs` é reutilizada, com AES-256-GCM de `server/src/segredos.ts`.
Respostas públicas/admin não retornam token, segredo, requisição cifrada nem
payload externo. Não existem colunas PAN/CVV nem formulário de cartão no ERP.
O replay de criação guarda **apenas** input sem cartão/token cifrado na tentativa:
valor, moeda, referência, email/nome, CPF/CNPJ quando necessário, prazo e parcelas.

Configuração de provider preserva a alçada anterior: **admin + reautenticação**.
A tela usa senha em formulário de rota própria, sem modal. Outras operações
administrativas exigem gerente/admin e a empresa ativa do ator autenticado.
Auditoria usa `Store.audit`, com ator nas autorizações e correlação nas operações.
Uma chave dedicada de criptografia é exigida ao salvar credenciais em produção.

Ambiente seguro (não gravar valores em arquivos ou logs):

- Existentes: `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`.
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ENABLED_METHODS`,
  `STRIPE_RETURN_URL`, `STRIPE_ENVIRONMENT`, `STRIPE_CAPTURE_MODE`.
- PagBank: `PAGBANK_ACCESS_TOKEN`, `PAGBANK_NOTIFICATION_URL`,
  `PAGBANK_ENABLED_METHODS`, `PAGBANK_ENVIRONMENT`; `PAGBANK_WEBHOOK_SECRET` é
  opcional na configuração de ambiente. A assinatura oficial utiliza o token
  de acesso, não um HMAC com segredo inventado.

Fallback de ambiente é **exclusivo da empresa determinística da vitrine**
(`COMMERCE_LOJA_EMPRESA_ID`). Uma configuração persistida, inclusive desabilitada,
tem prioridade. Não há fallback global de credenciais entre empresas.
`enabled_methods` usa códigos separados por vírgula. Stripe também exige URL
HTTPS de retorno; PagBank exige URL HTTPS de notificação e CPF/CNPJ do comprador.
Salvar configuração não é teste de conexão nem homologação financeira.

## 5. Roteamento e fallback

As regras determinísticas consideram método, empresa, canal, loja, país/moeda,
valor em centavos, parcelas, disponibilidade, prioridade, custo, janela UTC e
limite por transação. Ordem de desempate: prioridade, custo, código de provider.
Métodos desabilitados não roteiam. Os limites configurados não ampliam as
capabilities do adapter. O rollout sem regra publicada mantém uma regra
**explícita de compatibilidade**: PIX/OWN_STORE → Mercado Pago. Nenhum novo provider
é selecionado silenciosamente. Configure e publique regras para utilizá-lo.

Fallback exige falha técnica **definitivamente não submetida** e opt-in na rota
seguinte. Não existe fallback de fraude, recusa, saldo insuficiente ou dados
inválidos. Timeout/5xx depois de um possível write são ambíguos: manter pendente,
consultar/repetir **o mesmo provider e a mesma chave**, jamais cobrar em outro.
Este refinamento é obrigatório para não confundir disponibilidade com segurança
contra dupla cobrança. Não há IA nem circuit breaker que invente health.

## 6. Lifecycle e ação do cliente

`transition()` define explicitamente as arestas dos estados CREATED, PENDING,
REQUIRES_ACTION, AUTHORIZED, CAPTURE_PENDING, CAPTURED, PAID,
PARTIALLY_REFUNDED, REFUNDED, CANCELED, FAILED, EXPIRED, CHARGEBACK, DISPUTED e
PENDING_MANUAL_CONFIRMATION. Notificações atrasadas não fazem regressão de pago
para pendente, nem ressuscitam um estado terminal.

HTTP 200 de criação não é pagamento. Stripe devolve ação de redirecionamento para
checkout hosted, incluindo desafios 3DS do provider; Pix retorna instrução/código
e expiração. O comprador vê ação pendente como fluxo legítimo, não como erro.
Métodos só aparecem se disponíveis na cotação calculada pelo backend. O front
envia `payment_method`, nunca escolhe o provider nem define o total financeiro.

## 7. Idempotência e concorrência

- Checkout: chave empresarial de carrinho e transação serializable já existentes.
- Intent: lock PostgreSQL transacional por empresa/pedido e unique constraints.
- Tentativas: chave externa determinística por empresa/intenção/tentativa/provider.
- Capture/cancel/refund/manual-confirm: claim persistido antes da chamada externa,
  exclusão por intenção, hash dos parâmetros e resultado reutilizável.
- Refunds pendentes bloqueiam outra mutação até confirmação: nunca se reutiliza
  saldo não confirmado para gerar outro reembolso.
- A atualização dos saldos de refund, estado, financeiro e auditoria é transacional.
- O replay de criação usa a mesma chave e o mesmo provider, nunca muda o routing
  após uma resposta incerta. Replay automático cessa após 20h, antes da janela
  habitual de retenção de idempotência do provider; exige investigação após isso.
- O mock do repositório existe **somente na registry de teste** (`NODE_ENV=test`),
  explicitamente identificado como `mock`; não é dado apresentado em produção.

O lock em memória é apenas a implementação de teste/demonstração já existente;
produção usa `pg_advisory_xact_lock` e constraints reais. Não depende de um único
processo Node para a exclusão.

## 8. Webhook engine e jobs

O endpoint compatível `/api/gateway/webhooks/:provider` recebe bytes crus ANTES do
parser JSON/autenticação de usuário. Resolve a empresa pela transação candidata,
valida a assinatura antes da deduplicação e guarda inbox/hash/correlação. Só são
retidos identificadores necessários ao parse: nenhum corpo arbitrário com cartão,
segredos ou dados do comprador. MP usa manifesto oficial, Stripe HMAC com tolerância
de timestamp, PagBank SHA256(token + '-' + corpo cru). O worker consulta estado,
valor e moeda oficiais; o browser/redirect nunca é autoridade.

```text
Webhook → verificação → inbox existente → deduplicação → normalização
        → consulta oficial → state machine → Commerce → vendas → Finance
```

Jobs são chamados pela rotina Commerce já conectada ao scheduler:
status sync, recuperação de criação interrompida e retry de inbox verificado,
com limite de lote/tentativas e backoff existente do inbox. Estados incertos de
refund/cancel/capture são resolvidos por consulta, sem reenviar nova cobrança.
Eventos Stripe de sessão cobrem checkout; reembolso externo é também descoberto
pela consulta periódica da charge. Não se afirma integração completa de todos os
tópicos de dispute/refund de cada provider.

## 9. Integração ERP/Finance e ADR-001

Somente PAID confirmado chama `confirmarPagamentoCobranca` e a ponte canônica de
Commerce. Ela preserva `vendas` como verdade operacional e `sales` como projeção
analítica, consome a reserva, fatura, gera comissão e executa o financeiro já
existente. Não há venda final por simples início de checkout ou redirect.

Após conversão, o Engine liga a cobrança ao título financeiro canônico e chama
`efetuarBaixa`, condicional e idempotente. Divergência de valor não é corrigida
silenciosamente: exige revisão. Correções de conversão usam o outbox existente.
Refund confirmado aplica somente o incremento ainda não registrado por
`reverterFinanceiroDaCobranca`, na mesma transação do saldo de refund. Refund não
faz devolução física de estoque por conta própria: o ERP mantém o fluxo de
cancelamento/devolução operacional já estabelecido.

## 10. Settlement e reconciliação

**Evolução de 2026-10-29:** a API `/api/commerce/payments/payouts` aceita
relatório manual normalizado, em centavos, com replay por hash e vínculo manual
a uma entrada de extrato do mesmo tenant e valor exato. O relatório é comparado
com liquidações já existentes; divergências não viram `MATCHED`. Reembolso ou
chargeback posterior torna a evidência divergente. As páginas de lista, nova,
detalhe e conciliação ficam em `/commerce/pagamentos/repasses`. Não há
interpretação de layout de provider, ingestão automática, baixa de caixa nem
correção operacional completa de divergências. Detalhes e resultados atuais:
[`BROBOND-ENTERPRISE-FINAL-AUDIT.md`](../BROBOND-ENTERPRISE-FINAL-AUDIT.md).


Captura/pagamento confirmado cria registro UNRECONCILED. Taxas e líquido ainda
não informados no settlement ficam **NULL**. O relatório manual agora exige
`currency: BRL` e todos os componentes de taxa, estorno e chargeback explícitos
em centavos: campo ausente/nulo não vira zero. A UI pede que zero seja informado
somente se constar da evidência. Isso é uma declaração manual, não um arquivo ou
layout homologado do provider. Repasses com disputa pendente ficam `DIVERGENT`.

**Estornos:** `REFUNDED` sem valor explícito é recusado; o acumulado sozinho
não identifica a operação solicitada. A migration `0081` conserva no refund a
identidade e o status da operação individual retornada por Mercado Pago ou
Stripe, valida payment/valor e impõe unicidade por empresa/provedor/ID. Prova
`PENDING` pode ser consultada pelo ID; somente `SUCCEEDED` mais saldo acumulado
consistente conclui a operação. Consultas/retries locais não repetem o write
externo; sem prova identificável (inclusive PagBank ou crash antes de persistir
ID), permanece `UNCERTAIN` e bloqueado para revisão. Dados legados não recebem
identidade presumida. A criação MP mantém a referência como pendente até uma
leitura autenticada validar valores. Não há prova de homologação dos adapters.

**Disputa/chargeback:** estado do provider sem valor não cria perda integral:
`0082` registra quantia desconhecida como `NULL`/`UNKNOWN`, mantém valores
legados como `LEGACY_UNVERIFIED` e identifica quantia declarada manualmente
como `MANUAL_REPORTED`. Disputa automática ou manual marca settlement e eventual
repasse como divergentes, preservando valores e vínculo bancário; o registro não
é confirmação do débito nem altera caixa. A trava não é liberada só porque um
operador mudou o estado interno: faltam fluxo de comprovação/revisão financeira,
impacto contábil/fiscal e resolução autorizada integrada. A migration bloqueia
conciliações legadas afetadas sem sobrescrever valores anteriores. Testes PG
cobrem disputa/repasse, snapshot concorrente em processos distintos, replay e
isolamento; não substituem homologação, carga ou fechamento empresarial.

**Limite real:** não há importador automático de extrato/payout/MDR específico dos
três providers neste round. A estrutura de settlement/reconciliation existe; a
homologação de liquidação automática completa não deve ser declarada. Disputas
possuem domínio e persistência, mas envio de evidências depende de futuras
integrações específicas. Não se apresenta esse trabalho como concluído apenas
por existir uma tela.

## 11. APIs e UI

`/api/commerce/payments`: prontidão; `/providers`, `/methods`, `/routing`,
`/transactions`, `/transactions/:id`, `/refunds`, `/disputes`, `/reconciliation`,
`/webhooks`; mutações `/:id/refund|capture|cancel|manual-confirm`. Atualizações
pedem `Idempotency-Key`. Configuração de provider usa PUT `/providers/:code`.
As APIs antigas são preservadas; cancel/refund de cobrança já vinculada a intent
são encaminhados ao Engine, impedindo bypass da trava e dupla operação.

`POST /api/loja/payment-methods` e preview calculam disponibilidade a partir do
carrinho real. `POST /api/commerce/checkout/payment-intent` é alias do checkout
canônico: valida vitrine/empresa, carrinho, estoque, frete e total no servidor.
`POST /api/loja/checkout` permanece compatível. Não há endpoint público que
aceita total arbitrário ou empresa escolhida pelo navegador.

Área administrativa `/commerce/pagamentos` com navegação para providers, métodos,
roteamento, transações/detalhe, reembolsos, disputas, reconciliação e webhooks.
Configuração, nova regra, reembolso, captura, cancelamento, confirmação manual e
resolução possuem rotas próprias; zero modal/drawer/sheet. Status vazio é dado
vazio; NOT_CONFIGURED não significa uma falsa conexão. Loja própria consome
readiness do Engine em vez de codificar Mercado Pago como arquitetura central.

## 12. Como adicionar Cielo, Stone, Rede, Getnet, Adyen ou Pagar.me

1. Implementar `PaymentProvider` (pode estender `GenericPaymentProvider`) em
   `providers/<nome>` utilizando documentação/SDK oficial e timeouts limitados.
2. Declarar apenas capabilities implementadas e habilitadas na conta/região.
3. Registrar o adapter na registry e no webhook compatibility bridge se necessário.
4. Reutilizar a conta empresarial cifrada e nunca transportar token ao browser.
5. Implementar autenticação/normalização de webhook e consulta autoritativa.
6. Normalizar falhas; writes ambíguos jamais autorizam fallback.
7. Testar adapter, estado, idempotência, concorrência PG, tenancy, RBAC e segredo.
8. Publicar routing auditável e realizar homologação financeira no ambiente próprio.

Não alterar Checkout, Order, estoque, `vendas` ou criar um financeiro paralelo.
Capabilities futuras podem cobrir recorrência, multiacquirer, BNPL, wallet,
gift card, split e moedas adicionais, sem alegar suporte antes de implementá-lo.

## 13. Validação e readiness

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
`DATABASE_URL=... npm run test:pg`, `npm run smoke:pg`, `npm run audit:ux`,
`npm run architecture:audit`, `npm run commerce:go-live`,
`npm run payment:go-live`.

O gate PostgreSQL exige banco **novo**, PostgreSQL **16.14** e CLI psql real.
Os testes novos de provider usam fixtures explícitas e interceptação de HTTP,
não afirmam homologação financeira. Ausência de credenciais é
`EXTERNAL CONFIGURATION PENDING`, não falha estrutural.

CODE_READY (estrutura), PROVIDER_CONFIGURED (configuração), EXTERNAL_HOMOLOGATION
(teste financeiro real) e FULL_GO_LIVE são etapas distintas. A auditoria de
arquitetura não substitui execução dos gates, nem certifica as lacunas de escopo
expressamente documentadas acima.

## Atualização de ondas 1–3 (2026-10-29)

A revisão de pagamento tardio, o tratamento de refund incerto e as limitações atuais estão documentados em `../payments/enterprise-payments.md` e `../BROBOND-ENTERPRISE-WAVES-1-2-3-AUDIT.md`. As evidências anteriores desta página não substituem os resultados mais recentes nem constituem homologação externa.
