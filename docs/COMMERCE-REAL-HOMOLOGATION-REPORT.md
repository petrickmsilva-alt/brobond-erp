# BROBOND COMMERCE — Relatório executivo de homologação operacional

**Data:** 2026-11-02 (UTC)
**Resultado da rodada:** `COMMERCE_REAL_GO_LIVE = NO`
**Resposta curta:** **não há evidência nesta execução de que um dos canais venda ponta a ponta em produção ou em sandbox oficial**. O código contém vitrine, checkout, connectors, ingestão de pedido, ERP, estoque e financeiro, mas não foi possível realizar a operação externa: não havia PostgreSQL de homologação, credenciais de canal/pagamento nem contas oficiais de teste disponíveis. Não é correto concluir que o sistema está pronto para vender apenas com telas, testes automatizados ou HTTP 200.

## 1. Limites, segurança e branch

- Branch efetivamente usada: `arena/cae062a7-brobond-erp`.
- Base local inicial: commit `fa34360080935cf81ad196753a3a5e24edeee1a4`, igual ao `origin/main` observado. `git fetch origin main` foi executado.
- **Não foi feito checkout de `main`, pull nem criação/troca para `arena/commerce-real-homologation`**: esta sessão está vinculada a uma branch fixa diferente e o trabalho permaneceu nela.
- Nenhuma credencial/token/segredo foi lido ou impresso; a checagem de ambiente registrou somente presença/ausência. Não foi alterado valor de credencial existente.
- Nenhum arquivo de `backups/` foi lido, incluído ou modificado.
- Sem PostgreSQL configurado, nenhum produto `BROBOND QA COMMERCE TEST`, SKU `QA-COMMERCE-001`, variação `PRETA-M`, reserva, pedido ou venda persistente foi criado. Não foi utilizado produto real de cliente.
- Nenhuma API externa de provedor foi chamada. Não houve publicação externa, pagamento, refund, webhook real ou pedido de test-user.

## 2. Inventário e conclusão por canal

| Canal | O código permite | O que foi provado nesta execução | Status final | Bloqueio principal |
|---|---|---|---|---|
| Loja Própria / BROBOND | Publicação na vitrine local, carrinho, preview, checkout, pedido e integração com gateway | Smoke de demo passou em publicação e vitrine; compra paga real/sandbox não executada | `CODE_READY_EXTERNAL_UNTESTED` | PostgreSQL e credencial/configuração de pagamento indisponíveis; frete fail-closed se não configurado |
| Mercado Pago | Adapter existente, checkout server-side, consulta, webhook, cancelamento/refund e estados | Apenas auditoria estrutural e smoke local com provider/mock de teste | `BLOCKED_CREDENTIAL` | Sem Access Token/Public Key, segredo/configuração de webhook e homologação do vendedor |
| Mercado Livre | OAuth, leitura/publicação de anúncio, ingestão, webhook, conversão para venda canônica | Nenhum seller conectado, anúncio, pedido ou webhook externo | `BLOCKED_CREDENTIAL` | Client ID/Secret ausentes; test-user, seller e revisão da aplicação atual pendentes |
| Nuvemshop | OAuth, catálogo, publicação, webhook assinado e ingestão de pedidos | Nenhuma loja conectada nem chamada externa | `BLOCKED_CREDENTIAL` | Credenciais do app e loja ausentes; webhook/redirect externo não homologados |
| Instagram/Meta — catálogo e interações | OAuth, catálogo/Product Tagging, handshake e webhook de interações | Código e testes locais; conta Meta não conectada | `BLOCKED_CREDENTIAL` para ativação externa; `CODE_READY_EXTERNAL_UNTESTED` para catálogo/interações | App, permissões, conta profissional, catálogo e webhook não configurados |
| Instagram/Meta — checkout/pedido nativo | O Commerce recusa publicação individual; interação não deve virar receita | Não existe prova de venda nativa do Instagram | `NOT_IMPLEMENTED` | Não presumir pedido/checkout de Instagram a partir de catálogo, tag, DM ou comentário |
| WooCommerce (conector adicional encontrado) | Publicação, importação de pedidos e sincronização de saldo | Nenhuma loja/credencial acessível | `BLOCKED_CREDENTIAL` + `BLOCKED_PROVIDER_CONFIGURATION` | Credenciais ausentes e vínculo `WOOCOMMERCE_EMPRESA_ID` precisa estar definido e verificado |
| Mercado Livre legado (`/api/marketplace/sincronizar`) | Endpoint antigo por token; não é o adapter OAuth multitenant atual | Nenhum | `NOT_IMPLEMENTED` como ingestão de venda | O próprio código marca o trecho como simulação, usa seller placeholder fixo e não persiste ordem em `sales`/`vendas`; usar exclusivamente o connector atual após homologá-lo |

**Nenhum canal recebe `PASS_REAL` ou `PASS_SANDBOX`.** O checkout `/loja` está no caminho de código, mas não há uma venda paga confirmada por provedor refletida no ERP nesta execução.

## 3. Inventário técnico dos conectores encontrados

| Integração | Adapter/service e endpoints externos no código | Rotas/callback/webhook BROBOND | OAuth/credenciais/ambiente | Persistência, tenant, idempotência, retry e auditoria | Operações identificadas / resultado |
|---|---|---|---|---|---|
| Mercado Livre (connector atual) | `MercadoLivreConnector` + `mercadolivre.service.ts`; OAuth e API `api.mercadolibre.com` para itens/anúncios e leitura/re-fetch de pedidos | `/api/connectors/mercadolivre/autorizar`, callback `/api/connectors/mercadolivre/callback`, `/api/webhooks/mercadolivre`, sync `/api/connectors/mercadolivre/sincronizar`; conversão `POST /api/connectors/marketplace/venda-operacional` | OAuth2 com `MERCADOLIVRE_CLIENT_ID`/`MERCADOLIVRE_CLIENT_SECRET`, refresh pelo serviço; credenciais cifradas em connector; ambiente real configurável, nenhuma sandbox provada | connector por empresa/responsável, eventos com chave externa única, ingesta `sales` + itens com upsert; fila/recuperação no pipeline. Webhook BROBOND usa query secret compartilhado obrigatório após esta correção. Auditoria via hook do servidor. | Leitura de anúncios e pedidos; publicação de anúncio; ingestão e ponte para venda; estados/cancelamento mapeados no serviço. Nenhuma operação externa executada; status `BLOCKED_CREDENTIAL`. |
| Mercado Pago (reporting connector + gateway) | `MercadoPagoConnector`/`mercadopago.service.ts` lê `/users/me`, `/v1/payments/search`, `/v1/payments/{id}`; gateway legado e provider Payment Engine em `modules/payments/providers/mercado-pago/` | Credenciais via `/api/connectors/mercadopago/conectar`; webhook connector `/api/webhooks/mercadopago`; checkout/webhook financeiro também possui rotas do gateway/payment engine | Access Token/Public Key ligados à empresa; webhook MP valida manifesto `x-signature`; sem credenciais nesta sessão | Pagamento no backend, chave de idempotência do engine, consulta autoritativa, webhook inbox/dedupe, operação financeira existente; escopo por empresa. Retry/review estão no payment engine, não foram exercidos remotamente. | Pagamento/consulta/cancelamento/refund suportados em código conforme método/capacidade. Feed de pagamentos é leitura, não deve ser confundido com checkout de pedido. Sem operação externa: `BLOCKED_CREDENTIAL`. |
| Nuvemshop | `NuvemshopConnector`/`nuvemshop.service.ts`; OAuth e `api.nuvemshop.com.br/v1/{store}/...` para catálogo e re-fetch de ordem | `/api/connectors/nuvemshop/autorizar`, callback `/api/connectors/nuvemshop/callback`, webhook `/api/webhooks/nuvemshop` | OAuth2; token por loja (documentação interna diz que não expira automaticamente); Client ID/Secret e redirect externos ausentes | Connector por empresa/responsável; webhook HMAC-SHA256 do corpo cru com segredo do app; dedupe de evento; `sales`/`sale_items` com upsert e resolução de produto; retry/varredura de eventos pendentes no código | Leitura/publicação de catálogo, recebimento e ingestão de pedidos/status, pós-venda mapeado. Nenhuma loja ligada ou evento recebido: `BLOCKED_CREDENTIAL`. |
| Instagram/Meta | `InstagramConnector` + service próprio Graph API v26 e Product Tagging/catalog search | `/api/connectors/instagram/autorizar`, callback Meta, controller dedicado `/api/webhooks/instagram` (GET handshake + POST webhook) | OAuth Meta, app ID/secret; token de longa duração tratado no serviço; todos ausentes nesta sessão | Eventos assinados por HMAC-SHA256 (`x-hub-signature-256`), canal de webhook próprio, persistência/ingestão escopada e idempotência. Interações não geram receita; auditoria/painel lê eventos | Leitura de catálogo e interações; publicação individual rejeitada pelo publicador Commerce. Não foi provada venda nativa/checkout por Instagram: `NOT_IMPLEMENTED` para pedido nativo e `BLOCKED_CREDENTIAL` para catálogo/interações. |
| WooCommerce (loja própria/connector adicional) | `wooFetch` em `server/src/loja.ts` (REST `/wp-json/wc/v3` via Basic Auth HTTPS); publicador Commerce usa esta função | `/api/marketplace/loja/status`, `/produtos`, `/pedidos`, `/estoque`; publicação Commerce por fila; sem OAuth/webhook do adapter de marketplace | `WOOCOMMERCE_URL`, CK/CS e `WOOCOMMERCE_EMPRESA_ID` explícitos; todos ausentes/não verificados | Tenant único vinculado por empresa e ACL gerente/admin; pedido importado identificável `WOO-<id>` para não duplicar; write erros convertidos em HTTP operacional sem propagar corpo remoto; não foi encontrada homologação de webhook de pedido nesta integração | Publicar/atualizar produto; importar pedidos; sincronizar saldo ERP→loja. Não foram feitos reads/writes remotos: `BLOCKED_CREDENTIAL` + `BLOCKED_PROVIDER_CONFIGURATION`. |
| Mercado Livre legado | `server/src/marketplace.ts`, token `MERCADOLIVRE_TOKEN`, chamada a `/orders/search` | `/api/marketplace/status`, `POST /api/marketplace/sincronizar` | Token global legado; não é o OAuth multitenant do connector atual | Não persiste pedido; sem webhook/idempotência de venda nessa rota; retorna resultados da chamada e audita apenas a tentativa | O código comenta “Simulação”, usa seller placeholder e não converte pedido ao ERP. Classificado `NOT_IMPLEMENTED` como venda — não confundir com o connector atual. |
| PagBank/Stripe (adapters encontrados no Payment Engine; fora do escopo de canal) | `PagBankProvider` Orders sandbox/produção e `StripeProvider` Checkout Sessions/PaymentIntents | Rotas compartilhadas do Payment Engine; não se abriu nova integração nem foi feita homologação dedicada | Credenciais/configuração não detectadas; PagBank e Stripe foram excluídos desta rodada | Engine possui capabilities, chaves de operação e tratamento de evento/refund em código; sem teste externo | Presentes em código, mas não classificados como canais homologados nem configurados. Não implementar nem declarar sucesso nesta rodada. |

A persistência multicanal moderna fica em `connectors`/`connector_events` e depois `sales`/`sale_items`; a Loja Própria/WooCommerce antiga usa fluxos próprios de `loja.ts`. Rotas existentes de WooCommerce não são OAuth. O endpoint Mercado Livre legado é distinto do connector atual e não pode servir como evidência de venda.

## 4. Respostas objetivas às perguntas de go-live

1. **Qual canal está pronto para vender?** Nenhum canal foi comprovado como pronto por operação real ou sandbox oficial. A Loja Própria é `CODE_READY_EXTERNAL_UNTESTED`, não aprovada para go-live.
2. **Qual canal consegue publicar?** O código publica na vitrine BROBOND local. WooCommerce, Mercado Livre e Nuvemshop têm publicadores implementados; nenhuma publicação externa foi executada. Instagram Shopping rejeita publicação individual pela rota atual.
3. **Qual canal consegue receber pedido?** Ingestores existem para Mercado Livre, Mercado Pago, Nuvemshop e WooCommerce; o Instagram não foi comprovado como origem de pedido nativo. Nenhum pedido externo foi recebido nesta rodada.
4. **Qual canal sincroniza estoque?** O BROBOND mantém o estoque canônico e há código de integração WooCommerce. A sincronização externa de ida-e-volta não foi homologada; a documentação do projeto registra essa lacuna para canais marketplace.
5. **Qual canal recebe pagamento?** O Payment Engine e adapter Mercado Pago existem, mas nenhuma conta foi configurada nem pagamento externo recebido. Não considerar mock como pagamento.
6. **Qual canal consegue enviar webhook?** O sistema expõe endpoints para callbacks/webhooks de provedores, com validações previstas. Nenhum provedor enviou evento. O smoke usou evento de teste local.
7. **Qual canal reflete venda no ERP?** A ponte `sales` → `vendas` e conversão para estoque/financeiro estão implementadas e têm cenários PostgreSQL no repositório; esses cenários não rodaram nesta execução.
8. **Qual canal cancela?** O código contém cancelamento de pedido/cobrança, mas nenhum cancelamento externo foi executado.
9. **Qual canal devolve/refunda?** Há suporte de refund no adapter Mercado Pago; não foi testado com pagamento real/sandbox.
10. **Qual canal está bloqueado por credencial?** Mercado Pago, Mercado Livre, Nuvemshop, Instagram/Meta e WooCommerce; seus respectivos valores não estavam disponíveis no ambiente da execução.
11. **Qual canal está bloqueado por configuração externa?** WooCommerce exige vínculo explícito à empresa; ML/Nuvemshop/Meta/MP dependem ainda de cadastro, redirect, conta e webhook no provedor. Essas configurações não puderam ser validadas.
12. **Qual canal possui falha de código?** Foi corrigida uma falha de segurança na validação do webhook Mercado Livre: segredo ausente antes era aceito; agora o handler falha fechada. Não se concluiu falha de venda de provedor porque não houve ambiente/credenciais para testar essa operação.
13. **Qual canal está apenas “code ready”?** Loja Própria, fluxos de pedido/conversão ERP, estoque e OMS têm caminhos de código/testes, mas sem homologação PostgreSQL externa nesta execução; catálogo/interações Meta também estão code-ready, com ativação externa pendente.

## 5. Arquitetura de verdade única observada

- `vendas` continua sendo a fonte operacional; `sales` é a camada de ingestão/projeção associada a `sale_items`.
- Estoque e reservas usam o domínio canônico do ERP; não foi criado ledger, estoque ou fonte de venda paralelos.
- Pagamento só deve mudar de estado no backend após validação/consulta de evento. O frontend não é autoridade de confirmação.
- O código tem outbox/retry, reservas serializáveis, proteção de idempotência e escopo de empresa. Nesta sessão, os cenários que exigem PostgreSQL não foram executados.

Referências internas: `docs/COMMERCE-ARCHITECTURE.md`, `docs/COMMERCE-GAP-AUDIT.md`, `docs/COMMERCE-CHANNEL-MATRIX.md`, `docs/commerce/enterprise-commerce.md`.

## 6. Evidência operacional (o que existe e o que não existe)

Os IDs H-001 a H-011 e seus limites estão descritos na matriz `docs/COMMERCE-REAL-HOMOLOGATION-MATRIX.md`. Para fins de evidência transacional por canal:

| ID | Canal/fluxo | Empresa/produto/SKU | Pedido/ID externo/pagamento | Antes → ação → depois | Estoque/financeiro/ERP/auditoria/webhook | Resultado/erro/observação |
|---|---|---|---|---|---|---|
| O-001 | Loja Própria, compra paga | Não criado; nenhum tenant persistente de QA | Não existe; checkout de provedor não iniciado | Não executado | Sem estado persistente a conferir | `CODE_READY_EXTERNAL_UNTESTED`; bloqueado por DB e pagamento |
| O-002 | Mercado Pago, pagamento/webhook/refund | Não aplicável | Não existe cobrança externa | Não executado | Nenhum lançamento, baixa, reserva ou webhook externo | `BLOCKED_CREDENTIAL`; mock apenas no smoke local, sem aprovação de negócio |
| O-003 | Mercado Livre, publicação/pedido/pós-venda | Não criado | Não existe seller/anúncio/pedido externo | Não executado | Nenhuma mutação no ERP | `BLOCKED_CREDENTIAL`; OAuth e test-user não disponíveis |
| O-004 | Nuvemshop, publicação/pedido/webhook | Não criado | Não existe loja/pedido externo | Não executado | Nenhuma mutação no ERP | `BLOCKED_CREDENTIAL`; OAuth e webhook não configurados |
| O-005 | Instagram/Meta, catálogo/interação/venda | Não criado | Não existe evento recebido | Não executado externamente | Nenhuma receita lançada; interação não deve ser interpretada como venda | `BLOCKED_CREDENTIAL` para ativar catálogo; pedido nativo `NOT_IMPLEMENTED` |
| O-006 | WooCommerce, publicação/pedido/estoque | Não criado | Não existe loja/pedido externo | Não executado | Nenhuma mutação no ERP | `BLOCKED_CREDENTIAL` + vínculo de empresa não confirmado |
| O-007 | Marketplace → `sales` → `vendas` → estoque/financeiro | Dados de fixtures dos testes existentes, não uma ordem externa desta rodada | Nenhum ID real disponível | Teste PostgreSQL não executado | Sem antes/depois de DB para registrar | `BLOCKED_EXTERNAL_HOMOLOGATION`; `npm run test:pg` exigiu DB novo |
| O-008 | Webhook Mercado Livre sem segredo | Fixture sintética de teste; sem empresa/produto | Nenhum evento de provedor | Tentativas ausente/incorreta agora recusadas antes do lookup | Nenhuma gravação | Teste auxiliar da correção H-011; não é webhook real |

**Produto controlado:** `product_id=N/A`, `sku_id=N/A`, `stock_id=N/A`, `empresa_id=N/A`, preço e estoque inicial `N/A`. A ausência é intencional e correta: sem DB e tenant de teste autorizado, não se criou produto nem se alterou catálogo de cliente.

## 7. Defeito encontrado e correção aplicada

**Mercado Livre — webhook sem segredo configurado:** antes desta rodada, o parser só validava o parâmetro `secret` quando `MERCADOLIVRE_WEBHOOK_SECRET` existia. Com a variável ausente, a entrega podia continuar para resolução/ingestão sem o segredo compartilhado. Isso não atendia ao requisito de webhook autenticado.

**Correção:** validação agora é fail-closed; variável ausente, query ausente ou valor incorreto rejeitam o evento. `server/.env.example` explica que o segredo deve ser gerido fora do repositório. Foram adicionados testes auxiliares com fixture não real. O teste externo continua pendente e a correção não prova compatibilidade com a configuração atual do Mercado Livre.

Além do endpoint Mercado Livre legado explicitamente classificado como `NOT_IMPLEMENTED` no inventário (não corrigido porque o connector OAuth atual já é a implementação canônica), não foi possível demonstrar outros defeitos de negócio sem integração externa ativa. Não houve mudança arquitetural, adição de gateway ou expansão de connector.

## 8. Testes e gates

| Comando | Resultado desta sessão | Interpretação |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Concluído (964 pacotes) | Instalou dependências para executar testes; não modificou dependências declaradas. |
| `npm test` | Reexecutado após a correção; exit 0; client 123 arquivos / 1.067 testes aprovados; suíte server aprovada pelo comando | Automatizado; não substitui E2E de provedor. |
| `npm run typecheck` | Reexecutado após a correção; exit 0 | Domain/server/client sem erros. |
| `npm run lint` | Reexecutado após a correção; exit 0, 0 erros / 600 warnings | Avisos não foram escondidos. |
| `npm run build` | Reexecutado após a correção; exit 0 | Build Vite concluído. |
| `node --import tsx --test server/test/connectors.test.ts` | 55/55 | Inclui os dois novos casos auxiliares de webhook fail-closed. |
| `npm run test:payments` | 27/27 | Testes locais do Payment Engine e exposição do Commerce; não é pagamento externo. |
| `npm run smoke` | 398/398 após iniciar API local em modo demonstração | Smoke local passou; incluiu mock/test provider, não venda externa. Primeira chamada sem servidor falhou com connection refused e não foi contada como sucesso. |
| `npm run test:pg` | Exit 2; exige `DATABASE_URL` de PostgreSQL novo | Bloqueado; PG E2E/concorrência/tenancy não executados. |
| `npm run commerce:go-live` | 41 P0 estruturais OK; DB explicitamente não verificado | Gate estrutural não certifica operação externa. |
| `npm run payment:go-live` | Adapter/arquitetura estruturalmente prontos; marcou database not executed, external homologation NO e full go-live NO | Sem configuração de provedor. |
| `npm run commerce:final-go-live` | Exit 1 por gate bloqueado: estruturalmente 0 P0/P1/P2/P3, porém `CODE_READY: NÃO`, `EXTERNAL_HOMOLOGATION_BLOCKED` e `FULL_GO_LIVE: NÃO` | Resultado preservado como bloqueio real, não convertido em green. |
| `npm run smoke:pg` | Exit 2; exige `DATABASE_URL` | PostgreSQL não foi configurado; nenhum smoke PG. |

## 9. Condição para reabrir a homologação

1. Preparar PostgreSQL novo de homologação e executar migrations/gates PG, sem usar banco de produção.
2. Criar empresa/usuário de teste autorizados e o SKU controlado, registrando IDs e saldo, sem tocar produto de cliente.
3. Provisionar credenciais através do cofre/gerenciador aprovado e confirmar redirect, URLs de webhook, permissões e ambiente oficial de cada plataforma; não enviar segredos pelo chat ou por commits.
4. Para Mercado Livre, usar conta/test-user de homologação e validar modelo atual da aplicação, OAuth, seller e recebimento de notificações conforme documentação oficial vigente.
5. Para cada fluxo, conservar somente referências externas seguras, IDs não secretos, estado anterior/posterior e efeitos do ERP; validar venda, reserva/baixa, financeiro e auditoria.
6. Executar cancelamento/refund, repetição de webhook, corrida de estoque, RBAC e isolamento multiempresa no banco de teste.
7. Atualizar esta matriz somente com evidência observada. Só declarar `COMMERCE_REAL_GO_LIVE = YES` após um canal completar produto → publicação → cliente → pedido → pagamento confirmado → webhook → estoque → ERP → financeiro → auditoria em operação real ou sandbox oficial.

Documentação oficial de referência fornecida para próxima rodada:

- Mercado Pago: https://www.mercadopago.com.br/developers/pt/reference
- Mercado Pago Orders notifications: https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications
- Mercado Livre: https://developers.mercadolivre.com.br/
- Mercado Livre vendas: https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas
- Mercado Livre publicação: https://developers.mercadolivre.com.br/pt_br/publicacao-de-produtos

As URLs acima não foram acessadas nesta sessão; nenhuma afirmação sobre mudanças externas recentes foi certificada.
