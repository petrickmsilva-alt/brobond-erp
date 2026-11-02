# STOREFRONT ENTERPRISE — evolução da loja própria `/loja/*`

> **Escopo**: evolução do que já existe. Não foi criada outra loja, outro
> checkout, outro pedido, outro estoque, outro Payment Engine, outro ledger
> financeiro nem uma segunda integração com Mercado Pago. `/commerce/*`
> continua sendo backoffice; `/loja/*` continua sendo a única superfície
> pública do comprador.

## 1. Fluxo preservado (ponta a ponta)

```
STOREFRONT → CHECKOUT → PAYMENT ENGINE → PAYMENT ORCHESTRATOR
  → PROVIDER ADAPTER (Mercado Pago) → MERCADO PAGO → WEBHOOK
  → PAYMENT STATUS → ORDER → VENDA ERP → ESTOQUE / FINANCEIRO / FULFILLMENT
```

Nenhuma etapa foi substituída por um atalho. O checkout continua criando
`sale` + `sale_items` + `commerce_pedidos`, reservando estoque com
`criarReservaInterna` e chamando `paymentEngine.createForOrder`. O total,
preço, frete, desconto e estoque continuam sendo calculados **exclusivamente**
no servidor — o navegador envia apenas `itens`, `chave`, `cupom` e a
identificação do comprador.

## 2. Identificação do comprador e consentimento

`server/src/commerce/cliente.ts` normaliza e valida, no servidor:

| Campo | Regra |
| --- | --- |
| `nome`, `email` | obrigatórios |
| `whatsapp` | obrigatório, normalizado para E.164 |
| `documento` (CPF) | validado com dígitos verificadores; **exigido somente quando o meio de pagamento é PIX** (decisão do servidor) |
| `telefone` | opcional, legado |
| `marketing_opt_in` | consentimento **separado**, opcional, com `consentimento_em`; nunca condiciona o pedido e nesta rodada não gera nenhuma mensagem promocional |
| `transacional` | inerente ao pedido, sem opt-in |

Não há nova entidade de cliente: o contato fica em
`commerce_pedidos.comprador` (JSONB) e a `sale` canônica já guarda
`buyer_name`/`buyer_email`. A visão pública do pedido **mascara** WhatsApp e
CPF (`mascararWhatsApp`, `mascararCPF`).

A tela de checkout mostra as 4 etapas visuais
`1. Seus dados / 2. Entrega / 3. Pagamento / 4. Revisão` sem quebrar o backend
único, sem modal/dialog/drawer/sheet/overlay. Endereço só é exigido quando o
frete configurado é `manual`; na `retirada` não há endereço.

## 3. PIX via Mercado Pago **Orders API**

`modules/payments/providers/mercado-pago/legacy.ts` é o **mesmo** adapter de
sempre (o `MercadoPagoProvider` do Payment Engine chama `criaCobranca`). A
criação de PIX migrou de `POST /v1/payments` para `POST /v1/orders`:

```json
{
  "type": "online",
  "processing_mode": "automatic",
  "total_amount": "109.90",
  "external_reference": "checkout:<pedido>",
  "description": "Pedido BROBOND",
  "payer": { "email": "...", "first_name": "...", "last_name": "...",
             "identification": { "type": "CPF", "number": "52998224725" } },
  "transactions": { "payments": [ {
      "amount": "109.90",
      "payment_method": { "id": "pix", "type": "bank_transfer" },
      "expiration_time": "PT60M"
  } ] }
}
```

* `Authorization: Bearer <ACCESS_TOKEN>` e `X-Idempotency-Key` **somente no
  backend**; o token nunca aparece no frontend nem em logs.
* `qr_code_base64`, `qr_code` (EMV Copia e Cola), `ticket_url` e o `id` da
  Order vêm **exclusivamente** da resposta do provedor. Se não vierem, ficam
  `null` e a tela mostra estado honesto — **nenhum QR é gerado localmente**.
* Confirmação primária: webhook `type="order"` com assinatura `x-signature`
  (`id:<data.id>;request-id:<x-request-id>;ts:<ts>;`), seguido de
  `GET /v1/orders/{id}`. Só `status=processed` + `status_detail=accredited`
  projeta "pago". O polling do navegador é complemento controlado (45 s,
  máximo de 8 consultas, pausa com aba oculta).
* Cobranças legadas (`/v1/payments`) continuam consultadas/canceladas pelo
  caminho antigo: histórico e regressões permanecem válidos.
* Referências divergentes e valores/moeda que não batem com o pedido → `409`
  de conciliação, sem baixa financeira.
* `server/src/gateway.ts` persiste `ticket_url` em `gateway_cobrancas`;
  `server/src/commerce/pedidos.ts` expõe `qr_code_base64`, `ticket_url` e
  `provider_order_id` na visão pública (token é a credencial).

Referências oficiais consultadas: Checkout API Orders / Pix e "Configure
orders notifications" (Mercado Pago Developers).

## 4. Notificações (Outbox → E-mail / WhatsApp)

```
DOMAIN EVENT → commerce_outbox (tipo `notificacao`)
  → commerce_notificacoes (1 linha por evento/canal/destinatário)
  → EMAIL ADAPTER (mail.ts / SMTP)
  → WHATSAPP ADAPTER (Meta WhatsApp Business Cloud API, template aprovado)
```

Eventos: `ORDER_CREATED`, `PIX_GENERATED`, `PAYMENT_PENDING`,
`PAYMENT_APPROVED`, `ORDER_PROCESSING`, `ORDER_SHIPPED`, `ORDER_DELIVERED`,
`ORDER_CANCELLED`. Cada linha registra `evento`, `canal`, `destinatário`,
`estado`, `tentativas`, `ultimo_erro`, `enviado_em` e
`chave_idempotencia` (`pedido:evento:canal:hash(destinatário)`). O outbox
usa uma única chave `pedido:<id>:<evento>` — webhook duplicado não reenvia.

* Registro do evento é assíncrono e fora do caminho crítico: provedor
  indisponível **não invalida o pedido**; a linha volta para retry com
  backoff até o teto do outbox.
* WhatsApp: somente API oficial Cloud da Meta, com template aprovado
  configurado no backend (`WHATSAPP_TEMPLATE_*`). Sem API não oficial, sem
  automação de WhatsApp Web, sem marketing e sem token no frontend.
* E-mail: reutiliza `mail.ts`/SMTP; nenhum `falhou e-mail → falhou pedido`.
* Marketing é arquiteturalmente separado: `marketing_opt_in` não gera evento
  nesta rodada.

## 5. Storefront (marca de moda, não tela de ERP)

* `LojaShell.tsx`: cabeçalho/rodapé de marca, logo, Produtos, Categorias,
  Busca, Carrinho; nenhum link para `/commerce`, `/dashboard`, `/admin` ou
  `/conectores`.
* `useConfigLoja()` virou um **store de módulo** (`useSyncExternalStore`):
  **uma** chamada a `/loja/config` por fluxo, compartilhada por shell e por
  todas as páginas (antes o checkout fazia uma segunda chamada). O cache é
  apenas de conteúdo estático — preço, estoque, reserva, total e pagamento
  continuam server-authoritative a cada operação.
* `LojaInicioPage.tsx`: Hero, Categorias, Destaques, Ofertas, Novidades,
  Coleção e Benefícios. **Seções vazias são ocultas**; nenhuma avaliação,
  contagem de clientes, "mais vendidos", desconto ou depoimento é inventado.
  Busca rápida por nome/SKU/categoria/termo com debounce e `AbortController`.
* `CardProduto.tsx`: miniatura de 240 px com `width`/`height`, `loading=lazy`
  fora do primeiro viewport, `decoding=async`, preço real, preço promocional
  real, disponibilidade real, imagem e nome clicáveis, CTA "Ver produto" —
  **nunca** vai direto para o checkout.
* `LojaProdutoPage.tsx`: breadcrumb, variações, quantidade com +/−,
  disponibilidade do servidor, descrição/detalhes reais, frete/retirada da
  config, relacionados da mesma categoria (publicados e ativos), "Comprar
  agora" passando pelo carrinho/checkout oficial.
* `GaleriaProduto.tsx`: uma/muitas fotos, miniaturas, contador, navegação,
  **zoom inline** (sem overlay), carrossel touch com `scroll-snap` no mobile,
  galeria por variação com fallback para as fotos do produto e placeholder
  honesto quando não há mídia.
* `LojaPedidoPage.tsx`: `Pedido #...`, contato mascarado, QR real, Copia e
  Cola, `ticket_url`, estados `AGUARDANDO_PAGAMENTO`/`PROCESSANDO`/`PAGO`/
  `RECUSADO`/`EXPIRADO`/`CANCELADO`/`ESTORNADO`/`ERRO`, timeline, rastreio e
  atualização manual. Abrir a página **não** marca pagamento.

## 6. Mídia (tabela `arquivos` reaproveitada)

Campos aditivos: `alt_text`, `ativo`, `variante_id`. `principal`/`ordem`
já existiam. `uploads.ts` filtra inativas, ordena
`principal → ordem → id` e devolve `foto_url` (miniatura 240 px) para cards.
`galeria.ts` resolve galeria por variação com fallback. O limite de fotos do
produto passou de 5 para 20. Nenhum binário gigante é gravado no PostgreSQL;
as miniaturas usam a infraestrutura de otimização JPEG já existente.

**Pendência honesta**: a UI administrativa de `/commerce/produtos/17` ainda
não expõe ordenar/definir principal/excluir/desativar/vincular variação/editar
alt text. A API e o domínio já suportam; a tela não foi concluída nesta
rodada.

## 7. Banco — migração incremental

A migração versionada **`db/migrations/0094_storefront_enterprise.sql`** é a
que efetivamente chega a bancos já existentes (`server/src/db.ts` aplica
`db/bootstrap.sql` + a cadeia `db/migrations/*.sql` em ordem lexical, com
registro transacional em `schema_migrations`). `db/schema.sql` (fonte de
verdade do inventário) e `db/bootstrap.sql` (**regenerado** por
`node scripts/gerar-bootstrap.mjs`) receberam apenas alterações aditivas:

* `ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS alt_text/ativo/variante_id`;
* `ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS ticket_url TEXT`;
* `CREATE TABLE IF NOT EXISTS commerce_notificacoes` + índices + UNIQUE de
  idempotência;
* índices `ix_commerce_produtos_empresa_slug_lower`,
  `ix_commerce_publicacoes_canal_estado`, `ix_produtos_categoria_ativo`;
* ampliação do `CHECK` de `commerce_outbox.tipo` para aceitar `notificacao`.

⚠️ **Atenção para bancos existentes**: a ampliação do `CHECK` usa
`DROP CONSTRAINT` + `ADD CONSTRAINT` (não apaga dados, mas é uma troca de
restrição). Validar em homologação com `DATABASE_URL` real antes de aplicar;
há `NOT VALID`/`VALIDATE` condicional no mesmo padrão das migrações P2-04.
Rollback das colunas é `DROP COLUMN` — **destrutivo**, portanto só após
confirmação de que nenhuma linha depende delas; não é executado
automaticamente. Nenhum dado foi apagado, renomeado ou alterado em silêncio.

`docs/ERP-3.0-CAPACITIES.json` ganhou a capacidade
`commerce-notificacoes` (dono funcional do recurso, com teste nominal).

## 8. Performance — medições reais desta execução

| Medição | Antes | Depois | Como foi obtida |
| --- | --- | --- | --- |
| `GET /loja/config` por montagem do checkout | 2 | **1** | teste `performance: UMA requisição de /loja/config no fluxo` em `LojaFluxoPages.test.tsx` (contagem real de `apiFetch`) |
| Resolução de produto no SEO/detalhe | varredura completa do catálogo | **point lookup indexado** `lower(slug)` + 3 consultas em paralelo | `resolverProdutoVitrine` + índice `ix_commerce_produtos_empresa_slug_lower` |
| Imagem de card | original | **miniatura 240 px** com dimensões explícitas e lazy loading | `uploads.ts` + `CardProduto.tsx` |
| Bundle inicial (`index-*.js`) | — | **425,73 kB / 120,74 kB gzip** | saída real de `npm run build` (Vite 6) |
| Chunks da loja | — | `CatalogoPublico` 33,02 kB, `CommerceModulePage` 54,97 kB | saída real de `npm run build` |

**Não medido (sem browser no sandbox)**: LCP, INP, CLS, TTFB de produção,
waterfall de rede e cold start do Render. Não há números inventados nestas
linhas. O alvo `LCP < 2,5 s / INP < 200 ms / CLS < 0,1` permanece como meta
de homologação externa, não como resultado aprovado.

Decisão de ouro mantida: pode cachear **conteúdo/catálogo/categorias/imagens**;
`PREÇO FINAL`, `ESTOQUE`, `RESERVA`, `TOTAL DO PEDIDO` e `PAGAMENTO` são
recalculados no servidor a cada operação (`Cache-Control: no-store` nas rotas
de catálogo/preço/checkout).

## 9. Testes e gates executados

| Gate | Resultado |
| --- | --- |
| `npm test` | **EXIT 0** — node:test 1694 testes (1618 pass / 0 fail / 76 skipped) + Vitest 128 arquivos / 1105 testes |
| `npm run typecheck` | **EXIT 0** (domain + server + client) |
| `npm run build` | **EXIT 0** (Vite + PWA) |
| `npm run lint` | **EXIT 0** (0 erros; 606 avisos preexistentes de `no-explicit-any` / unused) |
| `npm run commerce:enterprise-audit` | **EXIT 0** — 32/32, P0=P1=P2=0 |
| `npm run architecture:audit` | **EXIT 0** — sem erros de coerência |
| `npm run payment:go-live` | **EXIT 0** — `CODE_STRUCTURE_READY: YES`, `EXTERNAL_HOMOLOGATION: NO` |
| `npm run audit:ux` | **EXIT 0** — nenhuma sobreposição nova em fluxo de módulo |
| `npm run db:validate` | **BLOQUEADO** — `binaries.prisma.sh` fora da allowlist de rede do sandbox |
| PG gate | **`PG GATE BLOCKED — DATABASE_URL indisponível`** — nenhuma afirmação sobre PostgreSQL real |

Novos testes: `server/test/commerce-orders-pix.test.ts` (7),
`server/test/commerce-notificacoes.test.ts` (6),
`server/test/commerce-galeria.test.ts` (9),
`client/.../GaleriaProduto.test.tsx` (5) e um teste de performance de
requisição única em `LojaFluxoPages.test.tsx`.

## 10. Segurança e multiempresa

* Token/secret de webhook/CPF completo nunca no frontend nem em logs.
* Assinatura do webhook validada antes de qualquer efeito; consulta da Order
  é a autoridade, não o corpo não assinado.
* Idempotência em `X-Idempotency-Key`, `commerce_outbox.chave`,
  `commerce_notificacoes.chave_idempotencia` e no checkout — webhook duplicado
  não duplica pagamento, pedido, venda, baixa, reserva ou notificação.
* Produto inexistente/despublicado/de outra empresa → `HTTP 404` real +
  `noindex`; ponto de lookup sempre com `empresa_id = $1`.
* Isolamento A × B coberto por testes de exposição, pedido e notificações.

## 11. Homologação externa — **pendente e obrigatória**

Testes locais verdes **não** significam homologação. Antes de `FULL_GO_LIVE`:

1. Aplicar `db/schema.sql` em PostgreSQL real com `DATABASE_URL`, rodar
   `npm run test:pg` / `npm run smoke:pg` e validar a troca do `CHECK` do
   outbox em banco com dados.
2. Cadastrar credenciais reais de produção do Mercado Pago no backoffice e
   configurar o webhook de **Orders** (`type=order`) com o secret;`/v1/orders`
   precisa estar habilitado na conta.
3. Executar **uma transação PIX real** e comprovar: QR/Copia e Cola vindos do
   provedor, `order.processed`, baixa da venda, reserva convertida e
   notificação entregue.
4. Configurar SMTP e template aprovado da Meta WhatsApp Cloud API; validar
   retry/backoff e ausência de mensagem promocional sem consentimento.
5. Medir LCP/INP/CLS nas viewports `1440, 1280, 1024, 768, 390, 375, 320`
   em ambiente com cold start do Render, com antes/depois reais.
6. Concluir a UI administrativa de galeria em `/commerce/produtos/17`.
7. Verificar CI do PR (nenhum status de CI foi consultado nesta execução).

**Status**: `CODE_READY = SIM` (gates locais) ·
`EXTERNAL_HOMOLOGATION_READY = NÃO` · `FULL_GO_LIVE = NÃO`.
Nenhum pagamento real foi comprovado nesta execução.
