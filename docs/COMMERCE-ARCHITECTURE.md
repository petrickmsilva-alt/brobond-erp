# BROBOND COMMERCE OS — Arquitetura

> Verdade de implementação. Toda decisão abaixo existe no código nomeado aqui e
> é provada por teste (unitário, PG real, E2E ou visual). Sem “em breve”, sem
> dado fake, sem segundo motor.

## 1. Princípios

1. **Um único motor.** Estoque canônico (`estoques`/`movimentacoes`), vendas
   (`vendas`/`itens_venda`) e financeiro (`lancamentos_financeiros`) continuam
   sendo os MESMOS do ERP. Commerce nunca escreve baixa/lance próprio: reserva
   no motor existente (`estoqueTransferencia.ts`), conversão pela ponte
   `sales → vendas` (`conversion-hooks.ts`), pagamento pelo gateway já
   existente (`gateway.ts`).
2. **SQL é a fonte de verdade.** `db/migrations/0068_commerce_os.sql`
   (+ espelho em `db/schema.sql`) cria as tabelas; nenhuma migração histórica
   foi alterada.
3. **Tenancy derivado do ator.** Toda linha nova carrega `empresa_id` vindo do
   token/sessão (`escopoDe(actor)`/`empresaDaVitrine`). Cross-tenant devolve
   **404** — nunca vazamento.
4. **RBAC no backend.** O cliente apenas espelha (`podeGerir`); a autoridade é
   o servidor (ver §6).
5. **Zero modal no fluxo operacional.** Lista/novo/detalhe/edição são rotas
   próprias; confirmações são `ConfirmacaoInline` (inline), nunca overlay.
6. **Pagamento só pelo backend.** O frontend nunca confirma nada; o estado
   muda quando o webhook ASSINADO do provedor é processado.

## 2. Modelo de dados (0068_commerce_os.sql)

| Tabela | Papel | Detalhes |
|---|---|---|
| `commerce_produtos` | Projeção do produto canônico na vitrine | `produto_id`→`produtos`, slug único/empresa, `canal_metadados JSONB` (ex.: `ml_category_id`) |
| `commerce_precos` | Preço por canal com vigência | CHECK de canal com **5** valores: `BROBOND, MERCADOLIVRE, NUVEMSHOP, WOOCOMMERCE, INSTAGRAM_SHOPPING` |
| `commerce_publicacoes` | Fila multicanal | UNIQUE parcial por `(empresa_id, produto_id, canal)`; estados `DRAFT→QUEUED→PUBLISHING→PUBLISHED/ERROR/REJECTED`; `versao`, `tentativas`, `ultimo_erro`, `proxima_tentativa_em` |
| `commerce_pedidos` | Pedido omnichannel | CHECK de canal com **6** valores (os 5 acima + `MERCADOPAGO`); `sale_id`→`sales`, `venda_id`→`vendas` (SET NULL), `cobranca_id`→`gateway_cobrancas` (SET NULL); estados `AGUARDANDO_PAGAMENTO … ERRO`; `chave_checkout` (idempotência do carrinho), `checkout_token` (credencial pública) |
| `commerce_rastreio` | Rastreio da entrega | `venda_id` NOT NULL→`vendas` (NO ACTION); UNIQUE `(empresa_id, venda_id)` |
| `commerce_promocoes` | Promoção automática da vitrine | período + mínimo; `escopo` (`pedido\|produto\|categoria`), `canal` (`todos\|varejo\|atacado`), `prioridade` (0108); **não acumula** com cupom |
| `commerce_promocao_alvos` | Alvos da promoção escopada (0108) | `produto_id` OU `categoria_id` (CHECK exclusivo), `empresa_id`, `ON DELETE CASCADE`; UNIQUE parcial por alvo |
| `commerce_cupons` | Cupom por código | `uso_maximo`/`uso_atual`, validade; exclusão com uso vira desativação |
| `commerce_configuracoes` | Config da loja | frete (`nenhum\|retirada\|manual`), prazo, `checkout_expira_minutos`, `responsavelCheckout` |
| `commerce_outbox` | Outbox de sincronização | `empresa_id,tipo,chave` únicos; `PENDENTE→PROCESSADO` com backoff (teto 1 h) |

`estoque_reservas` (tabela canônica pré-existe) ganhou o índice único parcial
`uq_estoque_reservas_checkout` sobre `origem_recurso='checkout'` — é a garantia
de banco de que **dois checkouts simultâneos da última peça criam UMA reserva**.
`sales` tem `empresa_id` desde a migração `0016` (qualquer INSERT bruto precisa
declará-lo — DEFAULT 1 seria cross-tenant).

## 3. Serviços (`server/src/commerce/`)

| Módulo | Responsabilidade |
|---|---|
| `regras.ts` | Vocabulário e regras PURAS: transições de estado do pedido (9 estados), `estadoSeguraReserva`, preço efetivo/vigência, desconto/cupom sem acúmulo, promoção ESCOPADA (`avaliarPromocao`/`melhorPromocaoEscopada`: maior desconto → prioridade → mais recente; base = subtotal elegível), `calcularTotaisCheckout` com **clamp por item** (nunca subtotal negativo), `round2` com nudge relativo, backoff de fila (teto 1 h), `tendenciaLinear`, `mapearEstadoPagamento` |
| `frete.ts` | `FreightProvider`: `nenhum` \| `retirada` \| `manual`. Sem provedor → `disponivel:false` com a mensagem exata **“Frete não configurado”** (fail-closed) |
| `loja-base.ts` | `empresaDaVitrine` (env → config única → fail-closed) e `responsavelCheckout` (dono operacional do checkout) |
| `grade.ts` | Disponibilidade por tamanho, coerência com o estoque canônico |
| `catalogo.ts` | Projeção (`projetarProdutoCommerce`), preço por canal, `enfileirarPublicacao` **idempotente** (catch `23505`), `processarPublicacao` com claim `tryUpdateIf`, `processarFilaPublicacoes` e publicadores: `BROBOND` (local, grava slug), `WOOCOMMERCE` (`wooFetch`), `MERCADOLIVRE`, `NUVEMSHOP`, `INSTAGRAM_SHOPPING` → **REJECTED honesto** (a Graph API não publica item individual) |
| `vitrine.ts` | 6 rotas públicas `/api/loja/*` (`rateLimitPublico`): config, produtos, produto/:slug, preview, checkout, pedido/:token. Checkout em **tx serializable**: idempotência por `chave_checkout`, reserva de estoque, cupom, cria `sales` COM `empresa_id`, cria cobrança no gateway (backend); falhou → `falharCheckout` devolve estoque/cupom e marca `ERRO` |
| `pedidos.ts` | `garantirPedidoDaSale` (catch `23505`), `converterPedidoSale` (ponte canônica, idempotente), `confirmarPagamentoCobranca` (ouvinte do gateway → `PAGO` + consumo de cupom), `expirarCheckoutsPendentes` (CAS `tryUpdateIf` + **retry 40001** `repetirSerial` — varredura × varredura nunca perde release), cancelamento devolve reserva/cupom |
| `promocoes.ts` | `promocoesVigentes` (com escopo/canal/prioridade e alvos), `melhorPromocaoDoCarrinho` (base elegível), `consumirUsoCupom` por CAS (`uso_atual`) → **409** quando esgotado; CRUD de promoções escopadas (alvos transacionais) e cupons; `POST /api/commerce/promocoes/simular` (mesma regra do checkout, nada é gravado) |
| `analytics.ts` | `/commerce/trends`, `/commerce/analytics` — métricas reais da operação (período, série, tendência, top crescimento), `vazio` honesto |
| `outbox.ts` | Fila de eventos (`pedido.convertido`, `evento.enviado`…) com tentativas/backoff |

### WooCommerce multi-store (`server/src/commerce/woocommerce/`)

Uma empresa, UM catálogo, DUAS lojas independentes (RETAIL `brobond.com.br`,
preço `preco_venda`; WHOLESALE `atacado.brobond.com.br`, preço `preco_atacado`).
Os identificadores `RETAIL`/`WHOLESALE` são imutáveis e persistem em
`store_key`. Guia operacional completo: [COMMERCE-WOOCOMMERCE-MULTI-STORE.md](COMMERCE-WOOCOMMERCE-MULTI-STORE.md).

| Módulo | Responsabilidade |
|---|---|
| `registry.ts` | Identidades imutáveis, config por loja, validação de URL (SSRF/HTTPS), `dry_run`, diagnóstico sem credencial |
| `cliente.ts` | Cliente HTTP autenticado por loja (Basic Auth, timeout, dry-run, erros sem corpo remoto) |
| `precos.ts` | Preço por loja (`preco_venda` × `preco_atacado`), `atacado_min_qtd`, recusa de preço inválido |
| `vinculos.ts` | Vínculo ERP ↔ loja (produto e variação), NULL-safe por loja, idempotente |
| `publicacao.ts` | Publicação por loja: vínculo → SKU → criação; variável nunca vira simples; preço da variação |
| `estoque.ts` | ERP → loja: disponível vendável, IDs externos da loja, lote confirmado, sem operação destrutiva |
| `pedidos.ts` | Importação por loja (`WOO-<store>-<id>`), incremental por água-marca, idempotente sob concorrência |
| `estado.ts` | `woocommerce_sync_state`: água-marca e último erro REAL por loja |
| `outboxStore.ts` | Eventos por loja na fila única (`store_key` na chave de idempotência) |
| `painel.ts` | Painel por loja, reconciliação (ERP × vínculos) e visão de vínculo |
| `rotas.ts` | Rotas administrativas por loja (RBAC gerente/admin, loja do path, sem credencial) |

### Integrações fora do pacote commerce

- `gateway.ts`: `criarCobrancaGateway` idempotente por
  `provider+idempotency_key`; `setOnCobrancaAlterada` →
  `notificarCobrancaAlterada` dispara os ouvintes **somente após** o evento do
  webhook estar de fato processado.
- `estoqueTransferencia.ts`: `criarReservaInterna` (tx serializable) e
  `liberarReservaInterna` (CAS ativa→liberada; liberada é idempotente — nunca
  sobrescreve `consumida`).
- `sale-events.ts`: `addOnSaleIngested` liga a ingestão de marketplace à
  conversão (prova em `test/pg/pg-golive03-marketplace-venda.test.ts`).
- `index.ts`: rotas `/api/loja/*` (6) e `/api/commerce/*` (~30), hooks
  `setOnCobrancaAlterada`/`addOnSaleIngested` e intervalo de 60 s para
  `processarComercioAgendado` (fila de publicações + expiração de checkouts).

## 4. Fila de publicação (outbox de canal)

```
POST /commerce/publicacoes ──► enfileirarPublicacao (idempotente)
        │                       (empresa+produto+canal → mesma row; versão nova)
        ▼
   DRAFT/QUEUED ──processarPublicacao (claim tryUpdateIf)──► PUBLISHING
        │                                                        │
        │                                    publicador real (BROBOND/Woo/ML/NUVEM)
        ▼                                                        ▼
   PUBLISHED (external_id)                          ERROR (ultimo_erro + backoff)
                                                    REJECTED (canal sem suporte)
```

- **Idempotência**: corrida list→insert engole `23505` e devolve a row
  existente; o claim garante que N processadores concorrentes publicam UMA vez
  (prova: cenário 02 do `commerce-concorrencia.test.ts`).
- Editar conteúdo/preço da projeção **incrementa a versão** e reenfileira.
- REPROCESSAR (`POST /:id/reprocessar`) só enfileira de novo; canais em
  `REJECTED` respondem 409 com o motivo (nunca “sucesso” falso).

## 5. Checkout B2C (`/loja`)

```
/loja ──► /loja/produto/:slug ──► /loja/carrinho ──► /loja/checkout ──► /loja/pedido/:token
                │                     │                   │
                └── carrinho (localStorage) ── POST /loja/preview revalida
                    preço/estoque/cupom/frete NO SERVIDOR a cada mudança
```

- O carrinho do cliente é só conveniência; **preview e checkout revalidam
  tudo** (preço do canal público, disponibilidade canônica, cupom, frete).
- Checkout cria `commerce_pedidos` + `sales` na tx serializable, reserva a
  peça, consome cupom (CAS) e chama o gateway; responde `201` com
  `checkout_token` (64 hex).
- Reenvio da mesma `chave` devolve o **mesmo** pedido (`idempotente:true`).
- Estado só avança com a confirmação do provedor:
  `webhook type=order (assinado) → GET /v1/orders/{id} → Payment Engine
  (máquina de estados) → gateway_cobrancas → onCobrancaAlterada →
  confirmarPagamentoCobranca → PAGO → conversão → CONVERTIDO`. O webhook só
  avisa; a verdade é a consulta autenticada da Order.
- Estoque do checkout (regra única, sem exceção):
  **Disponível = Físico − Reservado − Empenhado − Bloqueado**.
  Pedido pendente RESERVA (Físico 8 / Reservado 1 / Disponível 7) e nunca
  baixa o físico. Só o pagamento APROVADO consome a reserva, cria a venda
  operacional e a saída (Físico 7 / Reservado 0 / Disponível 7). Cancelado,
  recusado ou expirado devolve a reserva (8 / 0 / 8). Webhook duplicado ou
  novo event_id do mesmo pagamento: 1 pagamento / 1 venda / 1 saída.
- Expiração (`expirarCheckoutsPendentes`, roda no intervalo de 60 s):
  `AGUARDANDO_PAGAMENTO` vencido → `EXPIRADO`, reserva liberada, sale
  `CANCELLED`, notificação `ORDER_EXPIRED` — com retry de `40001` para
  corridas entre varreduras. Order expirada/cancelada no provedor segue o
  mesmo caminho pelo webhook.
- Instrumentos PIX (`modules/payments/domain/pix-instrument.ts`): Copia e Cola
  = BR Code EMV, QR = imagem base64 do provedor, link = `ticket_url` https.
  Nada é gerado localmente; os três ausentes = falha de integração (502).
- Conversão (`POST /commerce/pedidos/:saleId/converter`) usa a ponte
  sales→vendas (reuso do motor) e é idempotente.

### 5.1 Carrinho profissional (contrato)

O carrinho continua UM só (localStorage `brobond-loja-carrinho`, snapshot
opcional de nome/SKU/foto para exibir a linha enquanto a cotação carrega); a
**fonte de verdade de preço, estoque, desconto, frete e total é o servidor**
(`POST /api/loja/preview`, `Cache-Control: no-store`).

| Item | Regra |
|---|---|
| Quantidade | inteiro ≥ 1 e ≤ 99 (cliente: `normalizarQuantidade`; servidor: 400 para 0, negativo, NaN, Infinity, texto, decimal, `null`). Acima do estoque a linha vem `ok:false` + “Só N em estoque.” |
| Valores do browser | `total`, `preco_unitario`, `subtotal`, `desconto`, `frete` enviados pelo cliente são **ignorados** (preview e checkout) |
| Item despublicado/inexistente/de outro tenant | a cotação **não falha inteira**: a linha vem `ok:false`, `indisponivel:true`, sem vazar nome; o cliente continua podendo removê-la; o checkout recusa (409) |
| Payment Engine fora do ar | só `payment_methods` degrada (`payment_methods_erro`); o carrinho continua cotando |
| Frete | real (FreightProvider) ou fail-closed: “Frete indisponível para esta configuração.” e `pronto_para_checkout:false` — nunca inventado |
| Cupom | validado no servidor a cada cotação, persistido no carrinho, removível; consumo atômico (CAS) só no checkout |
| Estados da tela | `LOADING · READY · EMPTY · ERROR · INVALID` (`data-estado-carrinho`), com “Tentar novamente”; valores aparecem como “—” só enquanto não sincronizados — nunca `...` indefinido |
| Concorrência | `AbortController` + número de sequência: resposta antiga nunca sobrescreve a nova |
| Abas | evento `storage` mantém as abas sincronizadas; F5 preserva o carrinho |

**Causa estrutural do bug “Carrinho 1 / itens vazios / totais `...`”.** Antes,
o preview falhava inteiro (409/400) quando QUALQUER linha estava
despublicada/sem tamanho/sem preço, ou quando o Payment Engine falhava (sem
`try/catch`, com N+1 em `account()`). Sem `itens` na resposta a tela não tinha
linhas para mostrar nem para remover, e os totais ficavam em `...`. O badge do
topo lê o localStorage (por isso mostrava “1”). A falha em produção não pôde ser
reproduzida neste ambiente; a causa estrutural acima foi corrigida e coberta por
testes (`LojaCarrinhoPage.test.tsx` — o cenário ERROR reproduz o comportamento
original no código antigo — e `commerce-cart.test.ts` em PG real).

### 5.2 SEO e status HTTP da vitrine

`server/src/commerce/storefront-seo.ts` responde `GET /loja` e
`GET /loja/produto/:slug` **antes** do fallback do SPA, injetando no
`index.html`: `<title>`, `description`, `canonical` (origem de `urlPublica`),
`robots`, Open Graph e JSON-LD `Product` (preço e disponibilidade do servidor),
tudo escapado. Visibilidade = a mesma regra da vitrine (ativo + projetado +
publicação `PUBLISHED` no canal BROBOND, do tenant da loja). Produto
inexistente, não publicado ou de outro tenant → **HTTP 404 real** (HTML do SPA
com `noindex`, sem revelar nada). Produto publicado e sem estoque continua
indexável (`OutOfStock`). Sem loja configurada, cai no SPA normal.

## 6. RBAC e camadas de alçada

| Camada | Uso | O que confere |
|---|---|---|
| `checkAccess(r, actor, op)` | CRUD genérico `/api/:recurso` | `minPerfil`, `adminOnly`, comercial, `minPerfilEscrita` e **`r.ops[op]`** (405 quando o recurso é fechado ao CRUD) |
| `checkFluxo(r, actor)` | Endpoints de fluxo que só leem/acionam | alçada de leitura (padrão PDV/expedição) |
| `checkFluxoEscrita(r, actor, op)` | Endpoints de fluxo que ESCREVEM em recurso com `ops` fechado | MESMA alçada de escrita (`minPerfilEscrita` + trava de exclusão do operador) **sem** consultar `r.ops` — o `ops:false` só barra o CRUD genérico; o endpoint `/api/commerce/...` é o caminho legítimo |

Recursos commerce com `ops` fechados (`commerce_produtos`,
`commerce_precos`, `commerce_publicacoes`): escrita só pelos endpoints de
fluxo; o operador recebe **403**, o outro tenant **404**, o CRUD genérico
**405**. Leitura do catálogo fica aberta a todos os perfis (o operário enxerga
a vitrine) — quem escreve é gerente/admin (espelhado no cliente).

## 7. Observabilidade

- `/api/commerce/eventos` → outbox + publicações + webhooks (`status`,
  `tentativas`, `ultimo_erro`, `proxima_tentativa_em`).
- `/api/commerce/trends|analytics` → métricas reais (nada de série fictícia).
- Webhook events persistidos em `gateway_webhook_events`
  (UNIQUE `provider+evento_id`, `assinatura_ok`, payload consultável).
- Auditoria: inserts/updates críticos registram ator via `s.audit`.

## 8. Provas (arquivos de teste)

| Camada | Arquivo | Escopo |
|---|---|---|
| Unitário/oráculo | `server/test/commerce-oracle.test.ts` (24) | dinheiro, preço/vigência, desconto/cupom, totais (clamp), máquina de 9 estados, backoff, métricas, slug, mapeamento de pagamento, CHECKs × vocabulário |
| Concorrência PG (12) | `server/test/pg/commerce-concorrencia.test.ts` | fila idempotente, claim único, versão única, cupom ×6, última peça ×6, mesmo checkout ×6, liberação ×6, garantir pedido ×6, expiração ×4, outbox ×4, preço ×6, expiração × pagamento |
| E2E PG | `server/test/pg/commerce-e2e.test.ts` | cadeia HTTP real: catálogo→fila→vitrine→checkout→webhook→conversão, RBAC/403, tenancy/404, frete fail-closed |
| Marketplace | `server/test/pg/pg-golive03-marketplace-venda.test.ts` | ingestão → venda operacional, idempotência, multiempresa, fail-closed de SKU |
| WooCommerce multi-store (unitário) | `server/test/woocommerce-multistore.test.ts` | registry/SSRF, preço por loja, publicação idempotente, variações, estoque sem atualização cruzada, pedidos por loja, ausência de credencial |
| WooCommerce multi-store (rotas) | `server/test/woocommerce-multistore-rotas.test.ts` | RBAC gerente/admin, isolamento por empresa, loja do path, respostas sem CK/CS, inventário pós-guarda |
| WooCommerce multi-store (PG) | `server/test/pg/woocommerce-multistore-pg.test.ts` | migration 0100, unicidade NULL-safe por loja, CHECK/FK, importação concorrente, publicações por loja |
| Carrinho/Storefront PG | `server/test/pg/commerce-cart.test.ts` (+ `_commerce-harness.ts`) | cotação autoritativa, anti-tamper (total:1), quantidades inválidas, estoque/reserva, cupom, frete fail-closed, despublicação, tenancy, SEO/404, webhook duplicado, RBAC |
| SEO unitário | `server/test/storefront-seo.test.ts` | escape HTML/JSON-LD, canonical, noindex |
| Visuais (15) | `client/src/pages/commerce/*.test.tsx` + `LojaFluxoPages.test.tsx` | as 13 rotas do space `commerce` + subrotas + fluxo B2C completo — render real da API, ZERO MODAL, navegação por rota |

Comandos oficiais: `npm run typecheck`, `test:server`, `test:client`,
`audit:menu`, `test:pg` (PG 16.14, banco vazio), `smoke`, `smoke:pg`,
`commerce:go-live` (ver `COMMERCE-GO-LIVE.md`).

## 9. Menu Commerce (fonte única: `client/src/modules.ts`)

| Grupo | Itens | Rota |
|---|---|---|
| Catálogo | Produtos · Publicações | `/commerce/produtos` · `/commerce/publicacoes` |
| Comercial (chave interna `Comercial Commerce`) | Preços · Promoções · Cupons | `/commerce/precos` · `/commerce/promocoes` · `/commerce/cupons` |
| Experiência | Loja própria | `/commerce/loja` |
| Pedidos | Pedidos | `/commerce/pedidos` |
| Fulfillment | Delivery | `/commerce/delivery` |
| Pagamentos | Payment Engine · Providers · Mercado Pago | `/commerce/pagamentos` · `/commerce/pagamentos/provedores` · `/conectores/mercado-pago` |
| Canais | Mercado Livre · Nuvemshop · Instagram | `/conectores/*` |
| Integrações | Fila & sync | `/commerce/fila` |
| Inteligência | Trends | `/commerce/trends` |

- Mercado Pago saiu de Canais (é provider de pagamento) e **mantém** a rota
  `/conectores/mercado-pago`; aparece uma única vez no menu.
- “Preços” é uma visão de leitura sobre o mesmo dado de `/api/commerce/produtos`
  (a edição continua no detalhe do produto) — não há segunda fonte de preço.
- Aliases (apenas redirecionam, sem página duplicada): `/providers`,
  `/commerce/providers` → `/commerce/pagamentos/provedores`; `/payment-engine`,
  `/payments` → `/commerce/pagamentos`. As rotas `/commerce/pagamentos/*`
  passaram a usar o módulo `commerce-pagamentos` (gerente+, igual à API).
- Nenhuma rota “Em breve”: `scripts/auditar-menu.ts` e
  `scripts/commerce-enterprise-audit.ts` verificam.

## 10. Cadeia de pagamento e estado dos providers

```
Checkout (vitrine.ts) → Payment Engine (paymentEngine.createForOrder)
   → Orchestrator (rotas configuradas, fallback determinístico, idempotência por operationKey)
   → Provider Adapter (registry) → Mercado Pago
```

- O checkout **nunca** importa adapter nem fala com o Mercado Pago.
- **Mercado Pago é o único provider operacional**: só anuncia método (PIX)
  quando há `access_token` + segredo de webhook do tenant. Segredos ficam
  cifrados no servidor; nunca no frontend nem em logs.
- **PagBank e Stripe são arquitetura extensível** (adapters registrados que não
  anunciam nenhum método sem credenciais e sem homologação). Não são
  apresentados como conectados.
- Webhook assinado → `gateway_webhook_events` (UNIQUE provider+evento) → estado
  interno do pedido (`PAGO`, `EXPIRADO`…); webhook duplicado e reconversão
  produzem UMA venda.
- vendas é a fonte operacional; `sales` é a projeção. Pedido único por
  `empresa_id + canal + pedido_externo` (`uq_commerce_pedidos_externo`) e
  checkout idempotente por `chave_checkout`.
- Estoque: Disponível = Físico − Reservado − Empenhado − Bloqueado
  (ver `ESTOQUE-CANONICO.md`); reserva SERIALIZABLE e idempotente.
- Mercado Pago Orders API: `POST /v1/orders` (Bearer, `X-Idempotency-Key`
  determinística = `external_reference`, `type=online`,
  `processing_mode=automatic`, `pix`/`bank_transfer`, `payer.email` +
  `identification`); `provider_order_id` persistido antes de validar a
  resposta; criação assíncrona relê a MESMA Order. Reembolso só com evidência
  (`refunded`/`partially_refunded`) — uma Order pendente nunca é projetada como
  reembolsada.
- Sem nova cobrança automática após erro HTTP: o replay reutiliza a intent e a
  referência; a atualização manual (`POST /commerce/pedidos/:saleId/
  atualizar-pagamento`) só consulta a referência gravada.
- Notificações: evento de domínio → `commerce_notificacoes` (1 linha por
  canal) + 1 trabalho no `commerce_outbox` → worker → e-mail (SMTP) /
  WhatsApp (Meta Cloud API oficial). Credencial ausente = `NÃO CONFIGURADO`
  com o nome das variáveis; nunca "ENVIADO" sem aceite do provedor.

## 11. DEPENDE DE HOMOLOGAÇÃO EXTERNA (não provado por testes locais)

- Cobrança real/sandbox no Mercado Pago com credenciais do tenant e webhook
  público com assinatura real.
- Frete com transportadora real (hoje: retirada/tabela configurada, fail-closed).
- PagBank e Stripe: adapters sem homologação.
- Reprodução do bug do carrinho no ambiente de produção.
- Imagem do produto COTTON “B”: a vitrine usa a foto cadastrada; a divergência
  imagem/SKU de produção só pode ser corrigida com evidência do cadastro real.

Auditoria: `npm run commerce:enterprise-audit` (verificações reais, sai com
código 1 se houver qualquer P0/P1/P2).
