# COMMERCE — Matriz de canais

> Estado real por canal, no código. “Suportado” = publicação/pedido percorre o
> caminho de verdade com teste; “Sem credencial” = caminho implementado, exige
> OAuth/credencial do cliente em produção (sem credencial o resultado é
> `ERROR`/409 honesto, nunca sucesso falso).

## Canais de PUBLICAÇÃO (`commerce_publicacoes.canal` — CHECK de 5)

| Canal | Publicação | Pedido/ingestão | Conector UI | Observações |
|---|---|---|---|---|
| **BROBOND** (loja própria) | ✅ local: grava slug + link canônico na projeção | ✅ checkout `/loja` | — (é o produto) | público imediato; não depende de rede externa |
| **MERCADOLIVRE** | ✅ implementado (`publicador` + `canal_metadados.ml_category_id`) | ✅ via connectors/ingestão | ✅ `conector-mercadolivre` (OAuth2) | sem credencial → `ERROR` com a mensagem do provedor |
| **NUVEMSHOP** | ✅ implementado | ✅ pedidos entram como canal | ✅ `conector-nuvemshop` (OAuth2) | mesmo comportamento honesto sem credencial |
| **WOOCOMMERCE** | ✅ implementado (`wooFetch` em `loja.ts`) | ✅ importação de pedidos/itens já existe | ⚠️ módulo UI dedicado ausente (config via `ConfigLoja` do servidor) | gap de UX documentada em `COMMERCE-GAP-AUDIT.md` |
| **INSTAGRAM_SHOPPING** | ❌ **REJECTED por design** | ⚠️ ingestão de pedido de sacolinha prevista (conector) | ✅ `conector-instagram` (Graph API) | a Graph API não publica item individual; fila responde 409 com o motivo (código `catalogo.ts:14`) |

Garantias comuns a todos: fila `DRAFT→QUEUED→PUBLISHING→PUBLISHED|ERROR|REJECTED`,
idempotência `(empresa+produto+canal)`, `versao` no pedido de publicação,
backoff exponencial (teto 1 h), claim único (`tryUpdateIf`), bump de versão ao
editar conteúdo, `REPROCESSAR` controlado.

## Canais de PEDIDO (`commerce_pedidos.canal` — CHECK de 6)

| Canal | Origem | Conversão sales→vendas | Exemplos de teste |
|---|---|---|---|
| BROBOND | checkout `/loja` | ✅ (`converterPedidoSale`, idempotente) | E2E (`commerce-e2e`) |
| MERCADOLIVRE | ingestão marketplace | ✅ (hooks de ingestão) | `pg-golive03-marketplace-venda` |
| NUVEMSHOP | ingestão marketplace | ✅ | — |
| WOOCOMMERCE | ingestão `wooFetch` | ✅ | — |
| MERCADOPAGO | pedido via gateway MP | ✅ | — |
| INSTAGRAM_SHOPPING | ingestão Graph API | ✅ | — |

> O enum legado `sale_channel` (criado antes deste projeto, **não alterado por
> regra de migração histórica**) não possui `WOOCOMMERCE`; o CHECK de
> `commerce_pedidos` é independente e o canônico é `vendas` (que já absorve os
> canais pré-existentes). A divergência fica registrada em
> `COMMERCE-GAP-AUDIT.md` como item conhecido (não bloqueia: a conversão grava
> a venda canônica com o canal da venda de origem).

## Pagamentos

| Provedor | Papel | Confirmação |
|---|---|---|
| **Mercado Pago** (Orders/checkout API) | produção (`provider mercadopago`) | webhook **público + assinado** (`/api/gateway/webhooks/mercadopago`, HMAC por empresa em `webhook_segredo_cifrado`, idempotência `UNIQUE(provider,evento_id)`) → gateway processa → `onCobrancaAlterada` → `confirmarPagamentoCobranca` → `PAGO` |
| **mock** (assinatura `mock-signature`) | apenas testes/homologação local | mesmo fluxo idempotente; **bloqueado fora de produção** |

Nenhum estado de pagamento vem do frontend. Cupom só é consumido no passo do
backend (CAS) e devolvido em falha/expiração/cancelamento.

## Frete (`commerce_configuracoes.frete`)

| Provider | Comportamento |
|---|---|
| ausente/`nenhum` | `disponivel:false` — **“Frete não configurado”** (checkout não avança sem linha de frete quando o provider exige) |
| `retirada` | R$ 0,00, prazo configurado |
| `manual` | valor/tabela definidos pelo lojista, por CEP ou fixo |

Cálculo sempre revalidado no `POST /loja/preview` e no `POST /loja/checkout`
(server-side). `test:server` — `frete: Frete não configurado quando não há
provider` — prova o fail-closed.

## Ciclo de vida de um produto na vitrine

1. Produto ERP → `POST /commerce/produtos` projeta (`commerce_produtos`).
2. Preço por canal: `PUT /commerce/produtos/:id/precos` (vigência/passo).
3. `POST /commerce/publicacoes` enfileira (idempotente).
4. Processador (agendado de 60 s e on-demand) publica e grava `external_id`.
5. Vitrine pública lê projeção + preço vigente do canal `BROBOND`.
6. Editar → bump de `versao` → reenfileira.
