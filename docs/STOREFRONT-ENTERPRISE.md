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
DOMAIN EVENT → commerce_outbox (`sincronizacao` + `payload.acao='notificacao'`)
  → commerce_notificacoes (1 linha por evento/canal/destinatário)
  → EMAIL ADAPTER (mail.ts / SMTP)
  → WHATSAPP ADAPTER (Meta WhatsApp Business Cloud API, template aprovado)
```

**Correção real do ciclo de fechamento**: um `tipo='notificacao'` novo exigiria
alterar `commerce_outbox_tipo_ck`, cuja migração `0090` RECRIA com conjunto mais
estreito ao ser reaplicada em banco com dados. Isso derrubava o job
`testes-postgres` do PR #99 com `check constraint "commerce_outbox_tipo_ck" ...
is violated by some row`. Mantivemos o conjunto de tipos aceito por TODA a cadeia
(`0068` + `0090`) e despachamos a comunicação por `payload.acao`; nenhuma
migration existente foi editada, nenhuma constraint foi trocada.

Eventos canônicos (constantes persistidas) e o vocabulário de homologação:

| Homologação | Constante |
| --- | --- |
| `PEDIDO_CRIADO` | `ORDER_CREATED` |
| `PIX_GENERATED` | `PIX_GENERATED` |
| `PAGAMENTO_APROVADO` | `PAYMENT_APPROVED` |
| `PAGAMENTO_RECUSADO` | `PAYMENT_REJECTED` |
| `PEDIDO_PROCESSANDO` | `ORDER_PROCESSING` |
| `PEDIDO_ENVIADO` | `ORDER_SHIPPED` |
| `PEDIDO_ENTREGUE` | `ORDER_DELIVERED` |
| `PEDIDO_CANCELADO` | `ORDER_CANCELLED` |

`PAYMENT_PENDING` também existe (aguardando transferência PIX).
`PAYMENT_REJECTED` é emitido quando `gateway_cobrancas.status='falhou'` vira
`pagamento_estado=REJECTED`: o pedido é cancelado, a reserva/cupom são liberados
e o comprador é avisado — antes o pedido ficava preso em
`AGUARDANDO_PAGAMENTO` sem aviso. Cada linha registra `evento`, `canal`,
`destinatário`, `estado`, `tentativas`, `ultimo_erro`, `enviado_em` e
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

**Galeria administrativa concluída** em `/commerce/produtos/:id`
(`GaleriaAdminProduto.tsx`, seção inline da própria rota, ZERO MODAL):
adicionar imagens pela infraestrutura existente (`prepareImage` + validação de
tipo/tamanho no servidor, tenant por `SEC-01`), definir **imagem principal**
com `PUT {principal:true}` sem duplicar arquivo, persistir a ordem completa
`1..n` com `PUT {ordem:[ids]}`, alternar **ATIVA/INATIVA** com `PUT {ativo}`
sem apagar, salvar `Texto alternativo` em `arquivos.alt_text`, vincular
produto → variação → imagem via `variante_id` (validado contra `tamanhos` no
servidor) e excluir **somente** após confirmação inline explícita
(`ConfirmacaoInline`; sem `window.confirm`, sem modal). A tela só mostra as
URLs públicas tokenizadas — nenhum caminho interno, token, mime ou byte é
exposto. Cobertura: `GaleriaAdminProduto.test.tsx` (7 testes) +
`ProdutoDetalhePage.test.tsx`.

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
* `PAYMENT_REJECTED` no `CHECK` de `commerce_notificacoes.evento`.

**`commerce_outbox` NÃO é alterado por `0094`** (sem `DROP CONSTRAINT`). Causa
raiz do FAIL do CI, reproduzida em PostgreSQL real: a migração `0090` faz
`DROP CONSTRAINT commerce_outbox_tipo_ck` + `ADD CONSTRAINT` com conjunto mais
estreito; ao reaplicar a cadeia num banco com dados (cenários de
drift/recovery cobertos por `PROD-DB-01`), linhas com um tipo novo fazem o
`ADD` falhar e o ERP sobe **degradado**. Os eventos de comunicação usam
`sincronizacao` + `payload.acao`, valor aceito por `0068` E por `0090`.
Nenhuma migration já aplicada foi editada, removida ou reordenada.

⚠️ **Bancos existentes**: `0094` é 100% aditiva (`ADD COLUMN IF NOT EXISTS`,
`CREATE TABLE/INDEX IF NOT EXISTS`) — sem `DROP`, `TRUNCATE`, `DELETE` ou
`UPDATE`. Rollback das colunas/tabela seria `DROP COLUMN`/`DROP TABLE`
(**destrutivo**) e só pode ocorrer após conferência manual de dados; não é
executado automaticamente. Nenhum dado foi apagado, renomeado ou alterado em
silêncio. `node scripts/gerar-bootstrap.mjs --check` confirma que
`db/bootstrap.sql` continua sincronizado com `db/schema.sql`.

**Validação SQL em PostgreSQL real (complementar ao CI)**: `bootstrap.sql` +
as **94 migrations em ordem lexical** foram aplicadas num engine PostgreSQL
real (PGlite 18.6/WASM — **não** é o PostgreSQL 16.14 do CI) com 29 checagens
PASS/0 FAIL: colunas/defaults/NOT NULL de `arquivos`, 14 colunas e 5
constraints de `commerce_notificacoes` (PK, 2 FK, 3 CHECK, UNIQUE), 7 índices
novos, `ticket_url TEXT`, `commerce_outbox_tipo_ck` intacto, reexecução de
`0094` preservando dados, reaplicação de `0090` **com dados** agora OK, insert
real de `PAYMENT_REJECTED`, bloqueio de duplicata pela UNIQUE e recusa de
evento fora do catálogo pelo CHECK. O gate oficial de PostgreSQL 16.14 é o job
`testes-postgres` do CI (`npm run test:pg` + `npm run smoke:pg`).

`docs/ERP-3.0-CAPACITIES.json` ganhou a capacidade
`commerce-notificacoes` (dono funcional do recurso, com teste nominal).

## 8. Performance — medições reais desta execução

| Medição | Antes | Depois | Como foi obtida |
| --- | --- | --- | --- |
| `GET /loja/config` por montagem do checkout | 2 | **1** | teste `performance: UMA requisição de /loja/config no fluxo` em `LojaFluxoPages.test.tsx` (contagem real de `apiFetch`) |
| Resolução de produto no SEO/detalhe | varredura completa do catálogo | **point lookup indexado** `lower(slug)` + 3 consultas em paralelo | `resolverProdutoVitrine` + índice `ix_commerce_produtos_empresa_slug_lower` |
| Imagem de card | original | **miniatura 240 px** com dimensões explícitas e lazy loading | `uploads.ts` + `CardProduto.tsx` |
| Bundle inicial (`index-*.js`) | — | **425,85 kB / 120,76 kB gzip** | saída real de `npm run build` (Vite 6) |
| Chunks da loja | — | `CatalogoPublico` 33,02 kB / 9,51 kB gzip, `CommerceModulePage` 55,06 kB / 13,70 kB gzip | saída real de `npm run build` |

**NÃO MEDIDO (sem browser no sandbox)**: LCP, INP, CLS, TTFB, contagem de
requisições na rede, tamanho de imagens transferidas, JS inicial efetivo,
duplicatas na waterfall, tempos nas viewports `1440/1280/1024/768/390/375/320`
e cold start do Render. Não há números inventados nestas linhas. O alvo
`LCP < 2,5 s / INP < 200 ms / CLS < 0,1` permanece como **meta**, não como
resultado aprovado. O que está na tabela acima é **MEDIDO** apenas em
artefato de build e em teste de contagem de chamadas (sem navegador).

**Análise estática (sem browser)**: `preload` ausente para thumbnails além do
primeiro viewport, `loading=lazy` + `decoding=async` nas miniaturas, dimensões
explícitas (`width`/`height`) evitando reflow, `AbortController` na busca com
debounce, `useSyncExternalStore` eliminando a 2ª chamada de `/loja/config`,
`lazy()` por rota (`CatalogoPublico`, `CommerceModulePage`), consultas em
paralelo no detalhe do produto e índice funcional `lower(slug)` para point
lookup (sem varredura/N+1). `fetch_page` em
`https://brobond-erp.onrender.com/loja` e `/api/health` retornou a página
"Application loading" da Render (instância free suspensa) — **não** foi
possível validar a loja publicada; além disso o deploy publicado reflete
`main`, não este branch (nenhum deploy foi feito).

Decisão de ouro mantida: pode cachear **conteúdo/catálogo/categorias/imagens**;
`PREÇO FINAL`, `ESTOQUE`, `RESERVA`, `TOTAL DO PEDIDO` e `PAGAMENTO` são
recalculados no servidor a cada operação (`Cache-Control: no-store` nas rotas
de catálogo/preço/checkout).

## 9. Testes e gates executados

| Gate | Resultado |
| --- | --- |
| `npm test` | **EXIT 0** — node:test 1698 testes (1622 pass / 0 fail / 76 skipped) + Vitest 129 arquivos / 1112 testes |
| `npm run typecheck` | **EXIT 0** (domain + server + client) |
| `npm run build` | **EXIT 0** (Vite + PWA, 170 entradas / 2109,37 KiB no precache) |
| `npm run lint` | **EXIT 0** (0 erros; 606 avisos preexistentes) |
| `npm run smoke` | **EXIT 0** — 398/398 com servidor em memória (mesmo fluxo do job `verificar`) |
| `npm run commerce:enterprise-audit` | **EXIT 0** — 32/32, P0=P1=P2=0 |
| `npm run architecture:audit` | **EXIT 0** — sem erros de coerência |
| `npm run payment:go-live` | **EXIT 0** — `CODE_STRUCTURE_READY: YES`, `EXTERNAL_HOMOLOGATION: NO`, `FULL_GO_LIVE: NO` |
| `npm run commerce:go-live` | **EXIT 0** — P0: 41 ok / 0 falha |
| `npm run audit:ux` | **EXIT 0** — nenhuma sobreposição nova |
| `npm run audit:menu` | **EXIT 0** — sem erros (aviso informativo: `commerce_notificacoes` sem tela de consulta) |
| `npm run test:payments` | **EXIT 0** — 27/27 |
| `node scripts/gerar-bootstrap.mjs --check` | **EXIT 0** — bootstrap sincronizado |
| `npm run test:pg` / `npm run smoke:pg` | **BLOQUEADO local** — `DATABASE_URL` ausente; executados de fato pelo job `testes-postgres` do CI com PostgreSQL 16.14 |
| `npm run db:validate` | **BLOQUEADO** — engine Prisma em `binaries.prisma.sh` fora da allowlist de rede |
| Validação SQL de `0094` | **EXIT 0** — 29/29 em engine PostgreSQL real (PGlite 18.6/WASM), complementar ao CI |

Novos testes: `server/test/commerce-orders-pix.test.ts` (7),
`server/test/commerce-notificacoes.test.ts` (6),
`server/test/commerce-galeria.test.ts` (9),
`server/test/commerce-pagamento-recusado.test.ts` (3: contrato do comprador
usado nos E2E PG, vocabulário `PAGAMENTO_RECUSADO` e a transição real
`falhou` → `REJECTED` + liberação de reserva + outbox idempotente),
`client/.../GaleriaProduto.test.tsx` (5),
`client/.../GaleriaAdminProduto.test.tsx` (7), teste de `x-signature` com
`data.id` da query em `commerce-orders-pix.test.ts` e um teste de performance
de requisição única em `LojaFluxoPages.test.tsx`.

### 9.1 Diagnóstico do CI (evidência do log do job `testes-postgres`)

O primeiro push do ciclo (`580a01c`) falhou na reaplicação da migração `0090`:
o CHECK `commerce_outbox_tipo_ck` (4 tipos) rejeitava linhas `notificacao`
criadas por `0094`. Corrigido em `44cb44d`: comunicação passou a usar
`sincronizacao` + `payload.acao='notificacao'`, `0094` ficou 100% aditiva e o
bootstrap foi sincronizado. Nesse commit o job `verificar` ficou **PASS**
(4m57s, 16/16 steps) e `testes-postgres` **FAIL** (7m0s) com apenas 2 de 415
testes falhando: `CARRINHO PG` (128) e `COMMERCE E2E` (141). As anotações
do check-run não traziam a mensagem do `AssertionError`; o log completo do job
mostrou a causa exata:

* `commerce-cart.test.ts:253` — `400 !== 409`, corpo
  `{"error":"Informe o nome completo do comprador."}`;
* `commerce-e2e.test.ts:374` — `400 !== 201`, corpo
  `{"error":"Informe um WhatsApp válido para as atualizações do pedido."}`.

Ou seja, o novo contrato de `normalizarComprador` (nome completo, e-mail e
WhatsApp normalizado para E.164, exigido também pelo formulário do checkout)
passou a rejeitar os fixtures antigos, que tinham só `{ nome, email }` e, em
três casos, `nome: 'X'`.

O commit seguinte (`97cd2b5`) corrigiu nome/WhatsApp nos 7 fixtures, mas o
job voltou a falhar **nos mesmos dois testes**, agora com a próxima barreira
do contrato (comprovada de novo pelo log completo do job):

* `commerce-cart.test.ts:257` — `400 !== 409`, corpo
  `{"error":"CPF é necessário para este meio de pagamento."}`;
* `commerce-e2e.test.ts:374` — `400 !== 201`, mesmo corpo.

Causa: `lojaCriarCheckout` usa `exigirDocumento: method === 'PIX'` — decisão
100% server-side, o navegador não escolhe — e o CPF é necessário ao `payer`
da Orders API. Os 7 fixtures receberam também `documento: '529.982.247-25'`
(CPF de fixture com dígitos verificadores válidos, sem dado real de cliente),
**sem alterar nenhuma asserção** de estoque/frete/tenancy/SEO/idempotência.
O teste unitário novo trava o formato completo (nome, e-mail, WhatsApp E.164,
CPF válido e recusa de CPF inválido/ausente) para evitar regressão silenciosa.

Em `a8c1acb` os dois testes de commerce **passaram** (`ok 128`, `ok 141`) e
restou apenas 1 de 415 falhas no job PG, além de uma falha nova no `verificar`:

* `commerce-concorrencia.test.ts:475` — `11 !== 6` em
  `processarOutbox ×4`. O worker de outbox é **global**: agora que o checkout
  emite eventos `sincronizacao`/`acao='notificacao'`, as 4 corridas também
  reclamaram trabalhos PENDENTES deixados por outras suítes no mesmo banco.
  A asserção foi tornada hermética (`processados >= N`) e a garantia de
  "exatamente uma vez" passou a ser medida **no tenant do teste** — N linhas,
  todas `PROCESSADO`, `tentativas = 1` e soma das tentativas `= N`. Nenhuma
  asserção de concorrência foi removida.
* `verificar / Testes client` — `ReferenceError: window is not defined`
  originado em `src/components/ui.tsx:23` (`VendaFlow.test.tsx`). O
  `ToastProvider` agendava `window.setTimeout(..., 3000)` sem cancelar no
  unmount; o callback disparava depois do teardown do jsdom e o React lia
  `window` em `getCurrentEventPriority`. Corrigido com registro e cancelamento
  dos timers no `useEffect` de limpeza, usando `globalThis`. A suíte client
  completa (129 arquivos / 1112 testes) passou duas vezes localmente depois
  da correção.

As duas mensagens de migração `0030/E4.2` e `9999_prod_db_01_falha_intencional`
que aparecem no log são cenários de falha **intencionais** dos testes de
degradação/recuperação, não defeitos da cadeia de migrations.

## 10. Segurança e multiempresa

* Token/secret de webhook/CPF completo nunca no frontend nem em logs.
* Assinatura do webhook validada antes de qualquer efeito; o manifesto
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` usa **`data.id` da QUERY**
  (especificação oficial de `type=order`), e divergência com o `data.id` do
  corpo é recusada. A consulta `GET /v1/orders/{id}` é a autoridade, não o
  corpo não assinado.
* Idempotência em `X-Idempotency-Key`, `commerce_outbox.chave`,
  `commerce_notificacoes.chave_idempotencia` e no checkout — webhook duplicado
  não duplica pagamento, pedido, venda, baixa, reserva ou notificação.
* Produto inexistente/despublicado/de outra empresa → `HTTP 404` real +
  `noindex`; ponto de lookup sempre com `empresa_id = $1`.
* Isolamento A × B coberto por testes de exposição, pedido e notificações.

## 11. Homologação externa — **pendente e obrigatória**

Gates locais verdes **não** significam homologação. Antes de
`FULL_COMMERCE_GO_LIVE`:

1. **Compra PIX real** de R$ 80,00 de `COTTON "B"`
   (`CAM-BAS-PREM-VERM-"B" LOGO BRANCA`): exige
   `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, conta com
   `/v1/orders` habilitado e webhook `type=order` apontando para o ambiente
   publicado. Nenhuma compra foi simulada nem executada.
2. **E-mail/SMTP** (`SMTP_HOST`, `SMTP_USER`, …) e **WhatsApp oficial**
   (`WHATSAPP_CLOUD_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, template aprovado
   na Meta): sem credenciais não há envio real, apenas linhas `PENDENTE` com
   retry/backoff. Nenhum envio foi alegado.
3. **Loja publicada**: a URL `https://brobond-erp.onrender.com/loja` respondeu
   "Application loading" da Render (serviço free suspenso) e não contém as
   alterações deste branch — não houve merge nem deploy. Validar galeria,
   COTTON "B", touch/mobile e zoom inline no ambiente que receber o branch.
4. **Métricas de browser** LCP/INP/CLS/TTFB nas viewports
   `1440/1280/1024/768/390/375/320`, com cold start e antes/depois reais.
5. **PG 16.14 do CI**: confirmar `testes-postgres` PASS no commit final (o
   gate local de `DATABASE_URL` continua indisponível no sandbox). Histórico
   real: `580a01c` FAIL na cadeia de migrations; `44cb44d` e `97cd2b5`
   `verificar` PASS + `testes-postgres` FAIL nos 2 fixtures de comprador
   (nome/WhatsApp e depois CPF); `a8c1acb` já teve `ok 128`/`ok 141` e
   falhou só no teste global de outbox + no timer de toast (§9.1).
6. **Tela de consulta** de `commerce_notificacoes` no backoffice (aviso
   informativo de `audit:menu`; a fila e o orchestrator já funcionam).

## 12. Fechamento do ciclo — status exatos

| Rótulo | Valor | Motivo |
| --- | --- | --- |
| `CODE_READY` | **PENDENTE até `verificar` + `testes-postgres` PASS** | todos os gates locais verdes; 3 rodadas de CI diagnosticadas pelo log completo do job e corrigidas (§9.1); `ok 128`/`ok 141` já comprovados em PostgreSQL 16.14 no `a8c1acb`; veredito do commit final a confirmar |
| `INTERNAL_COMMERCE_READY` | **PENDENTE até CI verde** | cadeia única STOREFRONT → CHECKOUT → PAYMENT ENGINE/MP/PIX → OMS/PEDIDO → VENDA ERP/ESTOQUE/FINANCEIRO/FULFILLMENT → COMUNICAÇÃO → GOVERNANÇA; galeria admin concluída; migrations validadas; `smoke` 398/398 |
| `EXTERNAL_HOMOLOGATION_READY` | **NO** | falta loja publicada, credenciais MP/SMTP/Meta e métricas de browser |
| `REAL_PIX_HOMOLOGATION` | **BLOCKED** | `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `/v1/orders` habilitado e ambiente publicado ausentes |
| `EMAIL_EXTERNAL_HOMOLOGATION` | **BLOCKED** | credenciais SMTP ausentes |
| `WHATSAPP_EXTERNAL_HOMOLOGATION` | **BLOCKED** | token/phone id/template aprovado da Meta ausentes |
| `PG_EXTERNAL_VALIDATION` | **NÃO BLOQUEADO** | validado via PostgreSQL real (PGlite) + job `testes-postgres` 16.14 do CI; `TEST_PG`/`SMOKE_PG` locais indisponíveis apenas por `DATABASE_URL` |
| `FULL_COMMERCE_GO_LIVE` | **NO** | sem evidência de venda E2E real (compra PIX + webhook + baixa + envio) |

**Sem merge, sem deploy, sem alteração de `main`, sem `backups/`.**
