# `modules/connectors/nuvemshop` — plataforma-ponte do Hub Omnichannel

Estrutura inicial do conector da **Nuvemshop**, decidida pelo Diretor em
2026-10-05 como a **plataforma-ponte** para a triangulação de vendas do
Hub Omnichannel — em substituição aos conectores nativos de **Shopee** e
**TikTok Shop**, desprovisionados por restrições e barreiras burocráticas
de suas APIs.

A estratégia: **uma única integração oficial** (Nuvemshop / Tiendanube)
traz o catálogo e a receita dos canais de social commerce — incluindo o
catálogo publicado no TikTok — para dentro do ERP.

## Estado atual

| Peça                              | Situação                                                     |
| --------------------------------- | ------------------------------------------------------------ |
| `nuvemshop.connector.ts`          | ✅ esqueleto registrado no `connector.factory.ts` (trio ML·MP·NS) |
| `nuvemshop.service.ts`            | ⏳ a implementar (OAuth2, catálogo, pedidos, assinatura)      |
| Variáveis de ambiente             | ✅ `NUVEMSHOP_CLIENT_ID/SECRET/REDIRECT_URI` em `server/.env.example` |
| Enum `connector_provider`         | ✅ `NUVEMSHOP` incluído (migration `drop_shopee_and_tiktok_connectors`) |
| Enum `sale_channel`               | ✅ `NUVEMSHOP` incluído (mesma migration)                     |

Até o `nuvemshop.service.ts` existir, o adaptador responde com erro de
domínio claro (`ConnectorError`) em qualquer operação de rede — nunca com
um comportamento fantasma. O `connector.factory.ts` é tipado como
`Record<ConnectorProviderName, …>`, então o trio
MERCADOLIVRE · MERCADOPAGO · NUVEMSHOP é garantido pelo compilador.

## Contrato planejado do serviço (quando implementado)

- **OAuth2** — o app é autorizado no Developer Center da Nuvemshop;
  callback canônico `${APP_URL}/api/connectors/nuvemshop/callback`
  (`NUVEMSHOP_REDIRECT_URI`), troca de código por access token e rotação
  via refresh token no `TOKEN_REFRESHERS` do `connector.service.ts`.
- **Catálogo** — `fetchCatalog` normaliza os produtos da loja no
  contrato `NormalizedContent` (a triangulação do catálogo TikTok
  nasce do espelho publicado pela própria Nuvemshop).
- **Pedidos** — webhook `${APP_URL}/api/webhooks/nuvemshop` com
  verificação de assinatura no `webhooks/handlers.ts` e ingestão
  idempotente em `sales`/`sale_items` pelo `sale-ingestion.service.ts`
  (canal `NUVEMSHOP`).

Documentação oficial da API: https://developers.nuvemshop.com.br
