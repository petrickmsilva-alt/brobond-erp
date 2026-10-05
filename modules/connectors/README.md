# `modules/connectors` — conectores oficiais de marketplace

Módulo portado do **brobond-ai-commerce** (`modules/marketplace` +
`modules/connectors/tiktok`) para o **Brobond AI ERP** na Fase 2 da fusão.
Ele concentra OAuth, credenciais cifradas, webhooks e ingestão de pedidos
dos quatro canais suportados.

| Canal             | Autenticação                              | Pedidos chegam por                     |
| ----------------- | ----------------------------------------- | -------------------------------------- |
| **Mercado Livre** | OAuth 2.0 (`redirect_uri` estático)       | notificação → re-fetch na API          |
| **Mercado Pago**  | credenciais de produção coladas no painel | webhook assinado (HMAC)                |
| **Shopee**        | OAuth (partner sign)                      | push assinado (HMAC sobre URL + corpo) |
| **TikTok**        | Login Kit v2 + Shop Partner Center        | webhook assinado (HMAC)                |

> A **Nuvemshop foi removida do ecossistema**. Não existe builder, slug,
> rótulo, enum de canal nem ramo de persistência para ela: `parseConnectorProvider('nuvemshop')`
> devolve `null` e `connector.factory.ts` é tipado como
> `Record<ConnectorProviderName, …>`, de modo que uma chave a mais ou a
> menos **quebra a compilação**.

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
ingestion/
  catalog-matcher.ts      casa o item com produtos e tamanhos do ERP
  sales.service.ts        upsert IDEMPOTENTE em sales / sale_items
  sale-ingestion.service.ts  evento de webhook → venda (+ varredura de pendentes)
webhooks/handlers.ts      verificação de assinatura, dedupe e resolução de dono
```

## Rotas expostas pelo ERP (`server/src/connectors.ts`)

Autenticadas (sessão do ERP):

```
GET    /api/connectors                        cartões dos 4 canais
GET    /api/connectors/:provider              status de um canal
POST   /api/connectors/:provider/autorizar    inicia o OAuth (devolve a URL)
POST   /api/connectors/mercadopago/conectar   { accessToken, publicKey }
POST   /api/connectors/:provider/sincronizar  rodada manual de catálogo
DELETE /api/connectors/:provider              desconecta e apaga as credenciais
```

Públicas — **fora** do middleware de sessão, por projeto:

```
GET|POST /api/connectors/:provider/callback   retorno do consentimento OAuth
GET|POST /api/webhooks/:provider              pedidos em tempo real
```

Elas são montadas **depois do `cors()` e antes do `express.json()`** porque:

1. quem bate nelas é o provedor externo, sem cookie e sem Bearer — o bloqueio
   de sessão transformaria todo webhook em 401;
2. a assinatura HMAC é calculada sobre os **bytes crus**, que o parser JSON
   destruiria (daí o `express.raw`).

A segurança não vem da sessão e sim do `state` de uso único (callback) e da
assinatura do provedor + `shop_id` já gravado no conector (webhook). Um
segmento `:provider` que não seja um dos quatro slugs cai em `next()`, de modo
que o **CRUD autenticado pré-existente de `/api/webhooks` continua intacto**.

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
`SHOPEE_PARTNER_ID/KEY`, `TIKTOK_CLIENT_KEY/SECRET` (+ `TIKTOK_APP_KEY/SECRET`
para a app vendedora) e os segredos opcionais de webhook.

## Testes

`server/test/connectors.test.ts` cobre registro estrito dos provedores,
criptografia em repouso, as três famílias de assinatura de webhook, o upsert
idempotente (com banco fingido) e o casamento de catálogo.
