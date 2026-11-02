# BROBOND COMMERCE — Matriz de homologação operacional

**Data da execução:** 2026-11-02 (UTC)
**Escopo da evidência:** checkout versionado na branch Arena desta sessão.
**Conclusão:** `COMMERCE_REAL_GO_LIVE = NO`.

> Esta é uma auditoria do código e dos recursos disponíveis nesta execução, não uma certificação de venda no ambiente do cliente. Não havia `DATABASE_URL`, credenciais dos provedores nem conexão de homologação disponíveis. Nenhuma venda real/sandbox foi criada e nenhum canal recebe `PASS_REAL` ou `PASS_SANDBOX`. Nenhum registro comercial de cliente foi alterado.

## Escala de resultado

- `PASS_REAL`: operação confirmada pelo provedor real e refletida no BROBOND.
- `PASS_SANDBOX`: operação processada na sandbox oficial/test-user do provedor e refletida no BROBOND.
- `CODE_READY_EXTERNAL_UNTESTED`: caminho de código presente, sem teste operacional externo nesta execução.
- `BLOCKED_CREDENTIAL`: credencial de provedor necessária ausente/não disponibilizada.
- `BLOCKED_PROVIDER_CONFIGURATION`: configuração externa/tenant necessária ausente ou não validada.
- `BLOCKED_EXTERNAL_HOMOLOGATION`: depende de conta, autorização ou homologação externa ainda não executada.
- `FAIL`: defeito funcional demonstrado; não usado para ausência de credenciais.
- `NOT_IMPLEMENTED`: fluxo solicitado não existe no código/provedor suportado.

## Evidências da execução

| ID | Evidência | Resultado observável | Limite |
|---|---|---|---|
| H-001 | `npm run commerce:go-live` | 41 verificações estruturais P0 passaram; relatório explicitou que não certifica homologação externa. | A consulta ao banco foi omitida porque `DATABASE_URL` não estava definida. |
| H-002 | `npm run payment:go-live` | `CODE_STRUCTURE_READY: YES`; relatório do próprio gate marcou `DATABASE: NOT_EXECUTED`, `EXTERNAL_HOMOLOGATION: NO` e `FULL_GO_LIVE: NO`. | Gate estrutural, não operação de pagamento. |
| H-003 | `npm run smoke` com API local em modo demonstração | 398/398 verificações passaram. O subconjunto Commerce projetou produto de smoke, publicou na vitrine local `BROBOND`, e observou frete fail-closed. O smoke também percorreu fluxo financeiro com provider/mock de teste e reentrega idempotente. | Dados em memória, efêmeros; sem PostgreSQL, canal externo, credencial real ou venda no provedor. O mock é somente evidência auxiliar. Não é `PASS_SANDBOX`. |
| H-004 | `npm test` | Suíte server e client terminou com exit 0; client: 123 arquivos / 1.067 testes aprovados. | Testes automatizados não provam venda real. |
| H-005 | `npm run typecheck` | Domain, server e client sem erros. | Verificação estática. |
| H-006 | `npm run lint` | Exit 0; 0 erros e 600 warnings preexistentes. | Avisos registrados; lint não é prova operacional. |
| H-007 | `npm run build` | Build Vite de produção concluído. | Build não prova canal externo. |
| H-008 | `npm run test:pg` | Não executado: gate encerrou com código 2 e a mensagem de que exige `DATABASE_URL` de PostgreSQL de teste novo. | Não marcar como skip/pass. As provas PG de checkout, reserva concorrente, tenancy, gateway e marketplace não foram executadas. |
| H-009 | primeira tentativa de `npm run smoke` sem servidor | Falhou com `ECONNREFUSED 127.0.0.1:3001`; iniciado depois servidor local em modo demonstração e repetido com sucesso (H-003). | A falha inicial não é falha de negócio; repetição foi feita sem mascarar o resultado final. |
| H-010 | inventário de ambiente, somente presença/ausência | Ausentes: DB, variáveis de app ML/Nuvemshop/Meta, credenciais de Mercado Pago, credenciais WooCommerce e chave de cifra de conectores. Somente `server/.env.example` foi encontrado como arquivo `.env*`. | Valores de segredos não foram lidos, exibidos ou registrados. |
| H-011 | testes Mercado Livre webhook fail-closed (`node --import tsx --test server/test/connectors.test.ts`) | 55/55 testes do arquivo passaram; dois novos cenários cobrem segredo ausente/incorreto e fixture local | Corrige regra de validação no código; não testa provedor. |
| H-012 | `npm run commerce:final-go-live` | Gate exit 1, estrutural 0 P0/P1/P2/P3, mas `CODE_READY: NÃO`, `EXTERNAL_HOMOLOGATION_BLOCKED` e `FULL_GO_LIVE: NÃO`; conector ML reportado sem variável legada de token, outros sem DB para verificar | Falha de gate esperada por evidência externa incompleta, não aprovada nem mascarada. |
| H-013 | `npm run smoke:pg` | Exit 2, exige `DATABASE_URL` | Smoke PostgreSQL não executado; não converter em skip/pass. |
| H-014 | `npm run test:payments` | 27/27 testes locais passaram, incluindo guardas de Mercado Pago, webhook, idempotência, refund, RBAC e tenancy | Cobertura automatizada auxiliar; as rotas simuladas não são uma transação externa e não demonstram `PASS_SANDBOX`. |

## A — Loja Própria (`BROBOND` / `/loja`)

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Catálogo e publicação na vitrine | Auditoria estrutural + smoke local de produto Commerce e publicação `BROBOND` | Demo local, memória | `CODE_READY_EXTERNAL_UNTESTED` | H-001, H-003; rotas `/api/loja/*`, fila de publicação e vitrine estão no código | Sem banco durável/produto de QA persistente; o produto de smoke era descartável e não equivale ao SKU solicitado. |
| Carrinho / preview / checkout | Testes de UI e implementação presentes; E2E PostgreSQL disponível no repositório, não executado | Sem PostgreSQL configurado | `CODE_READY_EXTERNAL_UNTESTED` | H-004, H-008 | Sem execução transacional real no banco alvo. |
| Pedido pago no canal próprio | Não foi feita compra, cobrança real nem operação oficial de teste | Nenhum | `BLOCKED_CREDENTIAL` | H-008, H-010; Payment Engine exige configuração do provedor | Sem credencial Mercado Pago e sem endpoint/conta de homologação fornecidos. |
| Frete | Smoke verificou explicitamente recusa quando não configurado | Demo local | `CODE_READY_EXTERNAL_UNTESTED` | H-001, H-003 | Com `nenhum`, checkout fail-closed; retirada/manual exigem configuração do lojista. Não foi cotação real de transportadora. |
| Estoque, venda operacional, financeiro e auditoria | Cobertos por cenários PG no código, mas não executados nesta rodada | Sem PostgreSQL | `CODE_READY_EXTERNAL_UNTESTED` | `server/test/pg/commerce-e2e.test.ts`; H-008 | Sem estado persistido para inspecionar. |

**Resultado da loja:** o código apresenta vitrine e checkout, mas esta execução não provou uma venda paga end-to-end. `PASS_REAL` e `PASS_SANDBOX` não se aplicam.

## B — Mercado Pago (gateway)

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Adapter e checkout server-side | Auditoria do Payment Engine/Commerce e testes automatizados | Código/testes locais | `CODE_READY_EXTERNAL_UNTESTED` | H-001, H-002, H-004 | Teste estrutural/local não valida conta ou credencial. |
| Criação e consulta de pagamento; idempotency key; cancelamento/refund | Operação de API não iniciada por ausência de credencial | Nenhum | `BLOCKED_CREDENTIAL` | H-010; adapter em `modules/payments/providers/mercado-pago/` e integração legado em `server/src/gateway.ts` | Sem Access Token/Public Key disponibilizados. Nenhum pagamento externo foi criado. |
| Webhook, assinatura, repetição e reconciliação | Testes de código presentes; smoke local usou evento de teste/mock, não evento Mercado Pago | Demo/mock | `BLOCKED_CREDENTIAL` | H-003, H-004, H-008 | Segredo/configuração webhook e transação externa não disponíveis. Mock não confere `PASS_SANDBOX`. |
| Estado final no ERP | Nenhuma confirmação real de pagamento foi recebida | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | H-002, H-008 | Necessária operação do provedor e conferência backend→pedido→venda→financeiro. |

## C — Mercado Livre

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| OAuth, refresh e vínculo seller/empresa | Código inspecionado; OAuth não iniciado | Nenhum | `BLOCKED_CREDENTIAL` | `modules/connectors/mercadolivre/`, `server/src/connectors.ts`; H-010 | Client ID/Secret ausentes; seller/test-user não fornecido. Compatibilidade atual da aplicação e eventual separação de app Mercado Livre/Mercado Pago não pôde ser confirmada externamente. |
| Publicação/atualização de anúncio | Publicador de API presente; nenhum write externo feito | Nenhum | `BLOCKED_CREDENTIAL` | `server/src/commerce/catalogo.ts`; exige token conectado, categoria e dados do produto | Sem OAuth, categoria/conta de teste e ambiente autorizado. |
| Pedido, webhook, buyer/payment/shipping e ingestão | Handler/ingestão presente; nenhuma ordem real ou de test-user recebida | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | H-008; teste `server/test/pg/pg-golive03-marketplace-venda.test.ts` existe mas não rodou aqui | Sem seller test-user, webhook cadastrado e PostgreSQL. |
| Estoque/cancelamento/pós-venda | Caminhos de ERP e estados foram inspecionados; integração externa não exercitada | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | H-008 | Sem ordem externa. Não houve cancelamento, devolução ou reclamação real/teste. |
| Segurança de webhook | Corrigido nesta rodada: segredo de URL agora é obrigatório e validação é fail-closed | Teste automatizado local | `CODE_READY_EXTERNAL_UNTESTED` | `modules/connectors/webhooks/handlers.ts`; testes em `server/test/connectors.test.ts` | Exige configurar o segredo no provedor/ambiente e verificar entrega real. Não valida o modelo oficial atualizado do Mercado Livre. |
| Endpoint Mercado Livre legado (`/api/marketplace/sincronizar`) | Código indica simulação, usa seller placeholder e não persiste ordem em `sales`/`vendas` | Estático; não chamado por falta de token | `NOT_IMPLEMENTED` | `server/src/marketplace.ts` | Não usar este endpoint como canal de venda; o connector OAuth atual é distinto. |

## D — Nuvemshop

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| OAuth, loja e credencial | Código inspecionado; autorização não iniciada | Nenhum | `BLOCKED_CREDENTIAL` | `modules/connectors/nuvemshop/`; H-010 | Client ID/Secret/redirect URI ausentes e loja não autorizada. |
| Catálogo, publicação e estoque | Adapter de catálogo e publicador existem; sem chamadas externas | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | `modules/connectors/nuvemshop/nuvemshop.connector.ts`, `server/src/commerce/catalogo.ts` | Loja autorizada, dados/categoria e comprovação remota ausentes. |
| Pedido/webhook/cliente/cancelamento | Ingestão, assinatura HMAC e mapeadores existem; sem entrega externa | Nenhum | `BLOCKED_CREDENTIAL` | `modules/connectors/webhooks/handlers.ts`; H-008, H-010 | Sem credencial, loja, webhook registrado ou DB persistente. |
| Venda refletida no ERP | Sem operação real/sandbox | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | H-008 | A prova de ingestão/conversão em PostgreSQL não foi executada. |

## E — Instagram / Meta

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| OAuth, leitura de catálogo/Product Tagging e interações | Código de OAuth/catálogo/webhook revisado; credenciais ausentes | Nenhum | `BLOCKED_CREDENTIAL` | `modules/connectors/instagram/`; H-010 | App Meta, conta profissional, catálogo, permissões e webhook não foram conectados. |
| Publicação direta de produto individual | Código retorna `REJECTED` explicitamente para publicação individual pelo adapter Commerce | Estático | `NOT_IMPLEMENTED` | `server/src/commerce/catalogo.ts`; `docs/COMMERCE-GAP-AUDIT.md` | O fluxo existente direciona manutenção de item ao catálogo Meta; não há publicação individual via esta rota. |
| Compra/checkout nativo e webhook de pedido do Instagram | Não há caminho de venda nativa comprovado pelo conector nesta implementação | Estático | `NOT_IMPLEMENTED` | `modules/connectors/README.md`; parser de interação não transforma comentário/DM em venda | Não declarar venda por catálogo, tag ou interação. O checkout do site é outro canal e exige prova própria. |
| Catálogo/eventos recebidos | Conector pronto em código, mas sem conta Meta autorizada | Nenhum | `CODE_READY_EXTERNAL_UNTESTED` | H-004, H-010 | Homologação externa não executada. |

## F — ERP (`sales` → `vendas`, financeiro, cliente, auditoria)

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Fonte operacional única `vendas`; `sales` como ingestão/projeção | Arquitetura e conversor revisados; testes PG descritos no repositório | Código | `CODE_READY_EXTERNAL_UNTESTED` | `docs/COMMERCE-ARCHITECTURE.md`; `modules/connectors/ingestion/sales.service.ts`; H-008 | Sem banco PostgreSQL alvo para confirmar escrita e reconciliação. |
| Conversão de ordem marketplace → venda, financeiro, estoque/auditoria | Teste GOLIVE-03 existe mas não foi executado | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | `server/test/pg/pg-golive03-marketplace-venda.test.ts`; H-008 | Nenhum `external_order_id` real/sandbox. |
| Registro de cliente/endereço/frete do canal | Campos/mapeadores variam por canal; payload real não recebido | Nenhum | `CODE_READY_EXTERNAL_UNTESTED` | Ingestão identificada em `modules/connectors/ingestion/` | Mapeamento precisa ser verificado com payloads autorizados e banco real. |

## G — Estoque central

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Uma fonte de estoque/reserva; disponibilidade não-negativa | Regra/migrations e testes PG concorrentes presentes; não executados nesta sessão | Código | `CODE_READY_EXTERNAL_UNTESTED` | `server/src/estoqueTransferencia.ts`, migration Commerce, `server/test/pg/commerce-concorrencia.test.ts`; H-008 | Sem DB; concorrência real solicitada não foi executada. |
| Reversão por cancelamento/expiração | Caminho implementado e cenários automatizados disponíveis | Código | `CODE_READY_EXTERNAL_UNTESTED` | `server/src/commerce/pedidos.ts`; H-008 | Sem order persistido para verificar antes/depois. |
| Sincronização externa bidirecional | Documento do projeto registra leitura canônica e lacuna de reconciliação de ida-e-volta | Código/escopo | `NOT_IMPLEMENTED` | `docs/COMMERCE-GAP-AUDIT.md` | Não há confirmação de alterações de saldo vindas de todos os canais. |

## H — OMS / pedidos / delivery

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Pedido omnichannel e estado de checkout | Serviços/rotas/migrations revisados | Código | `CODE_READY_EXTERNAL_UNTESTED` | `server/src/commerce/pedidos.ts`, `server/src/commerce/vitrine.ts`; H-001 | E2E PostgreSQL não executado. |
| Delivery/rastreio e atualização de envio | Rotas/serviços existem; sem despacho externo | Código | `CODE_READY_EXTERNAL_UNTESTED` | `/api/commerce/delivery`, `/api/commerce/pedidos/:saleId/rastreio` | Não foi emitida etiqueta ou atualização real de transportadora. |
| OMS de ciclo completo multi-provedor | A documentação existente classifica partes do OMS como parciais | Documentado | `NOT_IMPLEMENTED` | `docs/commerce/enterprise-commerce.md` | Sem expansão improvisada de arquitetura nesta rodada. |

## I — Financeiro

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Lançamento canônico derivado de venda | Fluxo existente e prova PostgreSQL no repositório, não executada | Código | `CODE_READY_EXTERNAL_UNTESTED` | `server/test/pg/pg-golive03-marketplace-venda.test.ts`; H-008 | Sem DB e sem venda originada por provedor. |
| Pagamento, cancelamento/refund e consistência | Nenhum pagamento/refund externo executado | Nenhum | `BLOCKED_CREDENTIAL` | H-002, H-008, H-010 | Sem conta/configuração Mercado Pago. |
| PagBank/Stripe e outros adapters no Payment Engine | Adaptadores existem no registry; fora da homologação de canais desta rodada e sem provisionamento | Código | `BLOCKED_CREDENTIAL` | `modules/payments/providers/registry.ts`; H-010 | Não foram configurados nem testados; não os declarar canais aprovados. |

## J — Segurança

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Segredos fora do frontend; confirmação de pagamento no backend | Inspeção de rotas/serviços + testes automatizados | Código/testes locais | `CODE_READY_EXTERNAL_UNTESTED` | `docs/COMMERCE-ARCHITECTURE.md`, H-002, H-004 | Sem teste com provedor real. |
| Assinaturas MP/Nuvemshop/Meta e ingestão idempotente | Código e testes auxiliares; sem evento externo | Local | `CODE_READY_EXTERNAL_UNTESTED` | `modules/connectors/webhooks/handlers.ts`, testes `server/test/connectors.test.ts` | Configuração de chaves/webhooks não disponível. |
| Assinatura ML | Corrigida para exigir segredo configurado; ausência/erro recusa antes do lookup | Fixture somente de teste | `CODE_READY_EXTERNAL_UNTESTED` | H-011 abaixo | Ainda depende de segredo configurado e validação externa; confirmar compatibilidade com o contrato oficial atual. |

## K — Multi-tenancy e RBAC

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Escopo empresa em rotas e conexões | Testes automatizados e checks estruturais passam; testes PG não executados | Código/testes locais | `CODE_READY_EXTERNAL_UNTESTED` | H-001, H-004, H-008 | O teste isolado com PostgreSQL não foi executado nesta sessão. |
| GET/POST/PUT/webhook/pedido/estoque entre empresas | Auditoria estática identifica regras; sem ambiente DB/atores A e B persistentes | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | `server/test/pg/pg-p0-commerce-tenant.test.ts`, `server/test/pg/e42-tenant.test.ts`; H-008 | Não houve execução PG nessa rodada. |
| Admin/Manager/Member para operações críticas | Matriz de autorização presente no código/testes; sem ensaio de API persistida | Testes locais | `CODE_READY_EXTERNAL_UNTESTED` | `server/src/connectors.ts` restringe conectores a admin/gerente; `server/src/services.ts`; H-004, H-008 | Gate PG de RBAC/tenancy não rodou. |

## L — Idempotência e recuperação

| Capacidade | Teste | Ambiente | Resultado | Evidência | Bloqueio |
|---|---|---|---|---|---|
| Reentrega de eventos de webhook | Testes locais e smoke de mock verificaram dedupe/sem segundo efeito no fluxo de teste | Demo/mock | `CODE_READY_EXTERNAL_UNTESTED` | H-003, H-004 | Não equivale a repetir evento de provedor ou transação PostgreSQL. |
| Checkout, reserva, conversão de venda, financeiro | Chaves únicas/CAS/serialização e testes PG presentes; não executados | Código | `CODE_READY_EXTERNAL_UNTESTED` | `server/test/pg/commerce-concorrencia.test.ts`, `server/test/pg/commerce-reentrega-concorrente.test.ts`, H-008 | Requer PostgreSQL de teste dedicado. |
| Timeout/400/401/403/429/500 e retry/outbox de provedor | Outbox/backoff existem; sem chamadas autorizadas ou falhas provocadas no provedor | Nenhum | `BLOCKED_EXTERNAL_HOMOLOGATION` | H-001, H-008 | Não provocar falhas em contas externas sem autorização. |

## H-011 — Correção de segurança incluída nesta rodada

A auditoria identificou que o parser de webhook do Mercado Livre só comparava `MERCADOLIVRE_WEBHOOK_SECRET` quando a variável estava configurada; caso contrário, aceitava a notificação sem autenticação do segredo compartilhado. A validação foi alterada para falhar fechada quando o segredo está ausente, quando o parâmetro está ausente ou quando não corresponde. O exemplo de ambiente agora documenta o requisito. Dois testes automatizados auxiliares verificam essa regra usando apenas fixture de teste, nunca credencial de provedor.

**Limite:** não foi configurado segredo real nem feito teste de entrega do Mercado Livre. H-011 prova apenas a política local fail-closed.
