# `modules/connectors` — conectores oficiais de marketplace

Módulo portado do **brobond-ai-commerce** (`modules/marketplace`) para o
**Brobond AI ERP** na Fase 2 da fusão. Ele concentra OAuth, credenciais
cifradas, webhooks e ingestão de pedidos dos **quatro canais de produção**.

| Canal                 | Autenticação                              | O que chega em tempo real                      |
| --------------------- | ----------------------------------------- | ---------------------------------------------- |
| **Mercado Livre**     | OAuth 2.0 (`redirect_uri` estático)       | notificação → re-fetch na API                   |
| **Mercado Pago**      | credenciais de produção coladas no painel | webhook assinado (HMAC)                         |
| **Nuvemshop**         | OAuth 2.0 (token **permanente**)          | webhook magro assinado (HMAC) → re-fetch        |
| **Instagram Shopping**| OAuth 2.0 da Meta (token de **60 dias**)  | webhook do objeto `instagram` (`x-hub-signature-256`) — **interações**, catálogo por re-fetch |

> **Shopee e TikTok foram removidos do ecossistema** (decisão da diretoria,
> 2026-10-05 — restrições e barreiras burocráticas das APIs deles). Não
> existe builder, slug, rótulo, enum de canal nem ramo de persistência para
> eles: `parseConnectorProvider('shopee')` e `parseConnectorProvider('tiktok')`
> devolvem `null`, os valores saíram dos enums do banco na migration
> `drop_shopee_and_tiktok_connectors`, e `connector.factory.ts` é tipado como
> `Record<ConnectorProviderName, …>`, de modo que uma chave a mais ou a
> menos **quebra a compilação**.
>
> A **Nuvemshop é a plataforma-ponte** da triangulação de vendas: o catálogo
> publicado por ela (inclusive o exibido na vitrine do TikTok) e os pedidos
> que ela fecha são a fonte desses canais.

### Instagram Shopping — o que a Meta entrega HOJE (2026-10)

O canal `instagram/` fala **direto com a Graph API da Meta** (v26.0), sem
plataforma intermediária. Três fatos da plataforma definem o desenho dele —
estão aqui para que ninguém "conserte" o módulo tentando algo que a Meta não
oferece mais:

1. **O objeto `instagram` do Webhooks não tem campo de comércio.** A
   [referência oficial](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram/)
   lista exatamente `comments`, `live_comments`, `mentions`, `messages`,
   `message_edit`, `message_reactions`, `messaging_handover`,
   `messaging_postbacks`, `messaging_referral`, `messaging_seen`, `standby` e
   `story_insights`. **Não existe** tópico de pedido, carrinho ou
   "compra iniciada".
2. **A API de Commerce Order Management foi desligada.** A Meta bloqueou os
   47 endpoints de pedido em 29/07/2026 com a v26.0, estendendo a restrição a
   **todas** as versões suportadas em 27/10/2026, **sem API sucessora**.
3. **O checkout nativo nunca existiu no Brasil** (era exclusivo dos EUA e foi
   encerrado em setembro de 2025). A sacolinha brasileira **leva o cliente
   para o checkout do site** — o pedido nasce lá, não na Meta.

Consequência prática, honesta e verificável em tela:

- o webhook alimenta **"Webhooks — eventos recebidos"** com interação REAL
  (comentário, menção, DM, referral da sacolinha). Interação **nunca** vira
  receita — `mapInstagramOrderPayload()` devolve `null` para qualquer payload
  que não seja um pedido inteiro, e nada é gravado em `sales`;
- **"Conteúdo importado desta plataforma"** é abastecido de verdade pela
  Product Tagging API (`available_catalogs` → `catalog_product_search`);
- **"Pedidos Importados"** e **"Receita do Canal"** mostram **0** enquanto a
  Meta não entregar pedido — o mapeador e a ingestão estão prontos, tipados e
  testados, e passam a gravar no canal `INSTAGRAM_SHOPPING` no instante em que
  um payload de pedido chegar;
- a receita realmente gerada pelo Instagram hoje fecha no **site** (Nuvemshop).
  Atribuí-la ao canal é trabalho de *marketing attribution* (UTM/referrer sobre
  o pedido da Nuvemshop), não de API da Meta.

## Decisões estruturais

- **Tenancy `usuarioId`.** Onde o commerce usava `organizationId`, o ERP usa
  `usuarios.id`. É o operador do ERP que responde pela conexão, pela receita
  importada e pela trilha de auditoria.
- **Agnóstico de framework.** Nada aqui importa `express`, `next` ou `prisma`.
  O servidor injeta o banco (`setConnectorDatabase`) e a auditoria
  (`setConnectorAuditLogger`) no boot — ver `server/src/connectors.ts`.
- **Superfície única.** Quem consome o módulo importa apenas `index.ts`.
- **Postgres obrigatório.** A credencial cifrada e a idempotência da ingestão
  dependem das tabelas/índices da migração `0012`. Sem `DATABASE_URL` as rotas
  respondem **503** com a ação concreta — o modo demonstração do ERP continua
  intacto.

## Mapa de arquivos

```
core/
  providers.ts            registro estrito dos 4 canais, slugs, enums e rótulos
  errors.ts               erros de domínio com status HTTP embutido
  crypto.service.ts       AES-256-GCM (CONNECTOR_ENCRYPTION_KEY) + HMAC + máscara
  types.ts                linhas do banco e DTOs do painel
  database.ts             porta de SQL injetável (+ transação opcional)
  id.ts                   identificadores TEXT (cuid-like) das tabelas novas
  connector.repository.ts SQL puro de connectors / connector_events
  oauth-state.service.ts  state CSRF de uso único, atado ao usuário
  app-url.ts              URLs ESTÁTICAS de callback e webhook (APP_URL)
  audit.ts                gancho de auditoria injetado pelo servidor
  connector.interface.ts  contrato ProviderConnector
  connector.service.ts    conectar, renovar token, status, desconectar
  connector.factory.ts    provedor → adaptador (exaustivo, sem referência morta)
  sync.service.ts         rodada manual de catálogo + contadores reais
<canal>/<canal>.service.ts    API oficial do provedor (OAuth, pedidos, assinatura)
<canal>/<canal>.connector.ts  adaptador que implementa ProviderConnector
instagram/
  instagram.service.ts            Graph API v26.0: OAuth, conta comercial,
                                  catálogo, verificação/parse do webhook e
                                  mapeador de pedido
  instagram.connector.ts          adaptador ProviderConnector do canal
  instagram.connector.service.ts  InstagramConnectorService — webhook ponta a
                                  ponta, ingestão idempotente e as consultas
                                  do painel (motor PRÓPRIO, fora do
                                  despachante genérico)
  index.ts                        superfície pública do canal
ingestion/
  catalog-matcher.ts      casa o item com produtos e tamanhos do ERP
  sales.service.ts        upsert IDEMPOTENTE em sales / sale_items
  sale-ingestion.service.ts  evento de webhook → venda (+ varredura de pendentes)
webhooks/handlers.ts      verificação de assinatura, dedupe e resolução de dono
```

## Rotas expostas pelo ERP (`server/src/connectors.ts`)

Autenticadas (sessão do ERP):

```
GET    /api/connectors                        cartões dos quatro canais
GET    /api/connectors/:provider              status de um canal
POST   /api/connectors/:provider/autorizar    inicia o OAuth (devolve a URL)
                                               • body opcional: { redirect_uri }
                                                 — a ORIGEM onde o painel está
                                                 rodando (na Render,
                                                 https://brobond-erp.onrender.com).
                                                 Validada no servidor; o caminho
                                                 canônico /api/connectors/<slug>/callback
                                                 é derivado AQUI e a URI escolhida
                                                 é persistida com o state para a
                                                 troca do código repeti-la byte a byte.
POST   /api/connectors/mercadopago/conectar   { accessToken, publicKey }
POST   /api/connectors/:provider/sincronizar  rodada manual de catálogo
DELETE /api/connectors/:provider              desconecta e apaga as credenciais
```

Públicas — **fora** do middleware de sessão, por projeto:

```
GET|POST /api/connectors/:provider/callback   retorno do consentimento OAuth
GET|POST /api/webhooks/:provider              pedidos em tempo real
GET|POST /api/webhooks/instagram              controller PRÓPRIO do Instagram
                                               (`server/src/modules/connectors/
                                               instagram/instagram.controller.ts`),
                                               montado ANTES do despachante
                                               genérico — GET devolve o
                                               `hub.challenge` em TEXTO PURO e
                                               POST valida `x-hub-signature-256`
```

Elas são montadas **depois do `cors()` e antes do `express.json()`** porque:

1. quem bate nelas é o provedor externo, sem cookie e sem Bearer — o bloqueio
   de sessão transformaria todo webhook em 401;
2. a assinatura HMAC é calculada sobre os **bytes crus**, que o parser JSON
   destruiria (daí o `express.raw`).

A segurança não vem da sessão e sim do `state` de uso único (callback) e da
assinatura do provedor + `shop_id` já gravado no conector (webhook). Um
segmento `:provider` que não seja um dos slugs registrados cai em `next()`, de
modo que o **CRUD autenticado pré-existente de `/api/webhooks` continua
intacto**.

## Idempotência

- `connector_events` tem `UNIQUE (usuario_id, provider, external_event_id)`:
  reentrega do provedor é reconhecida e descartada.
- `sales` tem `UNIQUE (usuario_id, channel, external_order_id)`: o upsert
  aterrissa nessa chave em vez de inserir às cegas. Reprocessar o mesmo pedido
  **atualiza**, nunca duplica receita.
- Venda e itens são gravados na **mesma transação**; os itens são reescritos em
  bloco para que uma correção do pedido não deixe linha órfã.
- O que não terminar fica com `processed_at = NULL` e é retomado por
  `processPendingSaleEvents()`, chamado pelo agendador (`/api/admin/scheduled/*`).

## Variáveis de ambiente

Já descritas em `server/.env.example`: `CONNECTOR_ENCRYPTION_KEY` (32 bytes em
hex — obrigatória para conectar qualquer canal), `APP_URL`,
`MERCADOLIVRE_CLIENT_ID/SECRET`, `MERCADOPAGO_ACCESS_TOKEN/PUBLIC_KEY`,
`NUVEMSHOP_CLIENT_ID/SECRET` + `NUVEMSHOP_REDIRECT_URI` (o webhook da
Nuvemshop é assinado com o próprio client secret — não há segredo separado),
`INSTAGRAM_APP_ID/SECRET` + `INSTAGRAM_REDIRECT_URI` (o webhook da Meta é
assinado com o próprio app secret) e `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` —
**opcional de propósito**: ele só é exigido para registrar o endpoint no
painel da Meta, e sua falta não impede conectar a conta nem importar o
catálogo. Por isso não entra em `CONNECTOR_PROVIDER_REQUIRED_ENV`.

## Testes

`server/test/connectors.test.ts` cobre registro estrito dos provedores,
criptografia em repouso, as quatro famílias de assinatura de webhook, o upsert
idempotente (com banco fingido) e o casamento de catálogo.

Do Instagram, em particular: handshake `hub.challenge` (token certo, errado e
ausente), assinatura `sha256=` sobre os bytes crus, normalização do payload
multi-entrada (`changes[]` + `messaging[]`) com chave de dedupe estável,
ingestão no canal `INSTAGRAM_SHOPPING` com os contadores do cartão, e o
contrato de produto que importa: **toda** interação da Meta devolve `null` no
mapeador e não encosta em `sales`.
