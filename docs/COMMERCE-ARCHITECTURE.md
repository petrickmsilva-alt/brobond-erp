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
| `commerce_promocoes` | Promoção automática da vitrine | período + mínimo; **não acumula** com cupom |
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
| `regras.ts` | Vocabulário e regras PURAS: transições de estado do pedido (9 estados), `estadoSeguraReserva`, preço efetivo/vigência, desconto/cupom sem acúmulo, `calcularTotaisCheckout` com **clamp por item** (nunca subtotal negativo), `round2` com nudge relativo, backoff de fila (teto 1 h), `tendenciaLinear`, `mapearEstadoPagamento` |
| `frete.ts` | `FreightProvider`: `nenhum` \| `retirada` \| `manual`. Sem provedor → `disponivel:false` com a mensagem exata **“Frete não configurado”** (fail-closed) |
| `loja-base.ts` | `empresaDaVitrine` (env → config única → fail-closed) e `responsavelCheckout` (dono operacional do checkout) |
| `grade.ts` | Disponibilidade por tamanho, coerência com o estoque canônico |
| `catalogo.ts` | Projeção (`projetarProdutoCommerce`), preço por canal, `enfileirarPublicacao` **idempotente** (catch `23505`), `processarPublicacao` com claim `tryUpdateIf`, `processarFilaPublicacoes` e publicadores: `BROBOND` (local, grava slug), `WOOCOMMERCE` (`wooFetch`), `MERCADOLIVRE`, `NUVEMSHOP`, `INSTAGRAM_SHOPPING` → **REJECTED honesto** (a Graph API não publica item individual) |
| `vitrine.ts` | 6 rotas públicas `/api/loja/*` (`rateLimitPublico`): config, produtos, produto/:slug, preview, checkout, pedido/:token. Checkout em **tx serializable**: idempotência por `chave_checkout`, reserva de estoque, cupom, cria `sales` COM `empresa_id`, cria cobrança no gateway (backend); falhou → `falharCheckout` devolve estoque/cupom e marca `ERRO` |
| `pedidos.ts` | `garantirPedidoDaSale` (catch `23505`), `converterPedidoSale` (ponte canônica, idempotente), `confirmarPagamentoCobranca` (ouvinte do gateway → `PAGO` + consumo de cupom), `expirarCheckoutsPendentes` (CAS `tryUpdateIf` + **retry 40001** `repetirSerial` — varredura × varredura nunca perde release), cancelamento devolve reserva/cupom |
| `promocoes.ts` | `consumirUsoCupom` por CAS (`uso_atual`) → **409** quando esgotado; criação/edição/exclusão de promoções e cupons |
| `analytics.ts` | `/commerce/trends`, `/commerce/analytics` — métricas reais da operação (período, série, tendência, top crescimento), `vazio` honesto |
| `outbox.ts` | Fila de eventos (`pedido.convertido`, `evento.enviado`…) com tentativas/backoff |

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
- Estado só avança com webhook do provedor:
  `payment.paid → gateway processa → onCobrancaAlterada →
  confirmarPagamentoCobranca → PAGO (+ consumo de cupom)`.
- Expiração (`expirarCheckoutsPendentes`, roda no intervalo de 60 s):
  `AGUARDANDO_PAGAMENTO` vencido → `EXPIRADO`, reserva liberada, sale
  `CANCELLED` — com retry de `40001` para corridas entre varreduras.
- Conversão (`POST /commerce/pedidos/:saleId/converter`) usa a ponte
  sales→vendas (reuso do motor) e é idempotente.

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
| Visuais (15) | `client/src/pages/commerce/*.test.tsx` + `LojaFluxoPages.test.tsx` | as 13 rotas do space `commerce` + subrotas + fluxo B2C completo — render real da API, ZERO MODAL, navegação por rota |

Comandos oficiais: `npm run typecheck`, `test:server`, `test:client`,
`audit:menu`, `test:pg` (PG 16.14, banco vazio), `smoke`, `smoke:pg`,
`commerce:go-live` (ver `COMMERCE-GO-LIVE.md`).
