# `modules/connectors` — conectores oficiais de marketplace

Módulo portado do **brobond-ai-commerce** (`modules/marketplace`) para o
**Brobond AI ERP** na Fase 2 da fusão. Ele concentra OAuth, credenciais
cifradas, webhooks e ingestão de pedidos do **trio de produção**.

| Canal             | Autenticação                              | Pedidos chegam por                       |
| ----------------- | ----------------------------------------- | ---------------------------------------- |
| **Mercado Livre** | OAuth 2.0 (`redirect_uri` estático)       | notificação → re-fetch na API            |
| **Mercado Pago**  | credenciais de produção coladas no painel | webhook assinado (HMAC)                  |
| **Nuvemshop**     | OAuth 2.0 (token **permanente**)          | webhook magro assinado (HMAC) → re-fetch |

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
  providers.ts            registro estrito do trio, slugs, enums e rótulos
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
GET    /api/connectors                        cartões do trio de canais
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
```

Elas são montadas **depois do `cors()` e antes do `express.json()`** porque:

1. quem bate nelas é o provedor externo, sem cookie e sem Bearer — o bloqueio
   de sessão transformaria todo webhook em 401;
2. a assinatura HMAC é calculada sobre os **bytes crus**, que o parser JSON
   destruiria (daí o `express.raw`).

A segurança não vem da sessão e sim do `state` de uso único (callback) e da
assinatura do provedor + `shop_id` já gravado no conector (webhook). Um
segmento `:provider` que não seja um dos três slugs cai em `next()`, de modo
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
`NUVEMSHOP_CLIENT_ID/SECRET` + `NUVEMSHOP_REDIRECT_URI` (o webhook da
Nuvemshop é assinado com o próprio client secret — não há segredo separado)
e os segredos opcionais de webhook dos demais canais.

## Testes

`server/test/connectors.test.ts` cobre registro estrito dos provedores,
criptografia em repouso, as três famílias de assinatura de webhook, o upsert
idempotente (com banco fingido) e o casamento de catálogo.
