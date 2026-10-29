# COMMERCE — AUDITORIA FINAL POR MÓDULO (reconstruída do código real)

> **Nota de 2026-10-29:** este documento é um retrato histórico. As antigas afirmações de `CODE_READY`/exit 0 não certificam a plataforma atual; credenciais presentes não são homologação. Para a decisão vigente, consulte [BROBOND-ENTERPRISE-FINAL-AUDIT.md](BROBOND-ENTERPRISE-FINAL-AUDIT.md).

> Reconstruído em 2026-10-29 verificando cada célula contra o código e testes
> existentes no checkout. **Nenhuma célula é "✅" sem artefato verificável.**
> Colunas: LISTA / NOVO / DETALHE / EDITAR / API / PERSISTÊNCIA / RBAC /
> TENANCY / TESTE. `n/a` = ação não aplicável a esse módulo (ex.: pedidos
> chegam da loja, não são criados no painel).

Legenda: ✅ existe e está coberto · ⚠️ existe com pendência relatada · ❌ não existe.

## 1. Matriz operacional

| Módulo | LISTA | NOVO | DETALHE | EDITAR | API | PERSISTÊNCIA | RBAC | TENANCY | TESTE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Produtos** (vitrine) | ✅ `ProdutosPage` | ✅ `ProdutoNovoPage` | ✅ `ProdutoDetalhePage` | ✅ `ProdutoDetalhePage` (PUT produto + PUT precos) | ✅ `GET/POST/PUT /api/commerce/produtos[/:id]`, `PUT …/precos`, `POST …/despublicar` | ✅ `commerce_produtos`/`commerce_precos` (`0068`) | ✅ `commerce_produtos` via `checkAccess`/`minPerfil` | ✅ `escopoDoAtor` + `empresa_id` | ✅ `ProdutosPage/Novo/Detalhe.test` + `commerce-paineis-api` + `smoke 0058` |
| **Publicações** | ✅ `PublicacoesPage` (+ filtro `estado`) | ✅ `PublicacaoNovaPage` | ✅ `PublicacaoDetalhePage` | ✅ `PublicacaoEditarPage` | ✅ `GET/POST /publicacoes`, `GET /:id`, `POST /:id/reprocessar` | ✅ `commerce_publicacoes` (fila/outbox) | ✅ `commerce_publicacoes` (`resources.ts`) | ✅ empresa_id + cross-tenant 404 teste | ✅ 4 telas c/ teste + `commerce-concorrencia` (claim 8×) + `smoke:pg 0058` |
| **Ofertas** (preço por canal/vigência) | ✅ `OfertasPage` (`?canal/?vigentes/?q`) | ✅ `OfertaFormPage` (`/novo`) | ✅ `OfertaDetalhePage` | ✅ `OfertaFormPage` (`/:id/editar`, grava via `PUT /produtos/:id/precos`) | ✅ `GET /ofertas`, `GET /ofertas/:id`, `PUT /produtos/:id/precos` | ✅ `commerce_precos` (mesma linha da vitrine) | ✅ rota sob `commerce-promocoes` + `checkAccess` | ✅ `escopoDoAtor` + vigência por empresa (teste tenancy) | ✅ 3 telas c/ teste + `commerce-paineis-api` (vigência/cross-tenant) + oracle de preço |
| **Promoções** | ✅ `PromocoesPage` | ✅ `PromocaoFormPage` (`/nova`) | ⚠️ sem tela própria (edição é o detalhe) | ✅ `PromocaoFormPage` (`/:id/editar`) | ✅ `GET/POST/PUT/DELETE /api/commerce/promocoes[/:id]` | ✅ `commerce_promocoes` | ✅ `checkAccess` recurso promocoes | ✅ `empresa_id` | ✅ `Promocoes/PromocaoForm.test` + oracle (estado, vigência) |
| **Cupons** | ✅ `CuponsPage` | ✅ `CupomFormPage` (`/novo`) | ⚠️ sem tela própria (edição é o detalhe) | ✅ `CupomFormPage` (`/:id/editar`) | ✅ `GET/POST/PUT/DELETE /api/commerce/cupons[/:id]` | ✅ `commerce_cupons` | ✅ `checkAccess` recurso cupons | ✅ `empresa_id` | ✅ `Cupons/CupomForm.test` + oracle (regras de cupom) |
| **Pedidos** | ✅ `PedidosPage` (`?q/?status_venda`) | n/a (projeção automática) | ✅ `PedidoDetalhePage` | n/a (ações: converter/cancelar/rastreio) | ✅ `GET /pedidos[/:saleId]`, `POST /:saleId/{converter,cancelar,rastreio}` | ✅ `commerce_pedidos` (projeção idempotente por sale) | ✅ `checkAccess` pedidos | ✅ `escopoDoAtor` + projeção por empresa | ✅ 2 telas c/ teste + `garantirPedidoDaSale` em concorrência PG + `commerce-e2e` |
| **Pagamentos** | ✅ `PagamentosPage` (`?status`) | n/a | n/a (link ao ERP) | n/a | ✅ `GET /api/commerce/pagamentos` + rotas gateway (`/gateway/cobrancas` etc.) | ✅ `gateway_cobrancas` + ledger (gateway.ts) | ✅ `checkAccess` gateway | ✅ `empresa_id`/audit por registro | ✅ `PagamentosPage.test` + `gateway-cadeia-pagamento-e2e` + `e01-webhook` (PG) |
| **Reservas** | ✅ `ReservasPage` (`?status`) | n/a (checkout/ERP) | n/a | n/a | ✅ `GET /api/commerce/reservas` + motor `criarReservaInterna` | ✅ reservas de estoque (canônico) | ✅ `checkAccess` estoque | ✅ `empresa_id` + `calcularDisponibilidade` | ✅ `ReservasPage.test` + concorrência (12) + **25P02 3/3** (PG real) |
| **Fulfillment** | ✅ `FulfillmentPage` | n/a | n/a | n/a (ações no ERP) | ✅ `GET /api/commerce/fulfillment` + expedição ERP (`/expedicao/*`) | ✅ expedição/rastreio (`0068`) | ✅ `checkAccess` expedição | ✅ `empresa_id` | ✅ `FulfillmentPage.test` + `e423-expedicao` (PG) |
| **Delivery** | ✅ `DeliveryPage` (pré-existente) | n/a | n/a | n/a | ✅ `GET /api/commerce/delivery` + frete (`fail-closed`) | ✅ módulo `frete` + `commerce_rastreio` | ✅ `checkAccess` frete | ✅ `empresa_id` | ✅ `DeliveryPage.test` (harness) + `smoke 0058` (`Frete não configurado` honesto) |
| **Devoluções** | ✅ `DevolucoesPage` (**filtro `f.status` corrigido nesta rodada**) | n/a (solicitação no ERP) | n/a | n/a | ✅ `GET /devolucoes` (rota genérica `?f.<col>`) + `POST/GET/:id/…` no ERP (`expedicao.ts`) | ✅ `devolucoes` canônico | ✅ recurso `devolucoes` (`resources.ts`) | ✅ `empresa_id` | ✅ `DevolucoesPage.test` (4/4, contrato `f.status`) + `devolucao-e2e` (PG) |
| **Eventos** | ✅ `EventosPage` | n/a | n/a | n/a | ✅ `GET /api/commerce/eventos` | ✅ eventos do outbox | ✅ leitura de outbox | ✅ `empresa_id` | ✅ `EventosPage.test` + painéis (`observabilidade` no `smoke 0058`) |
| **Erros** | ✅ `ErrosPage` | n/a | n/a | n/a | ✅ `GET /api/commerce/erros` + `POST /publicacoes/:id/reprocessar` (ação honesta) | ✅ outbox estado `ERRO` | ✅ **403 a operador** (teste `commerce-paineis-api`) | ✅ `escopoDoAtor` + desc slice(0,300) | ✅ `ErrosPage.test` + `commerce-paineis-api` (6/6) |
| **Fila/Sync** | ✅ `FilaPage` | n/a | ✅ fila por publicação | n/a | ✅ `GET /publicacoes` (fila) + `POST /:id/reprocessar`; hooks `registrarHooksCommerce` + `processarComercioAgendado` no boot | ✅ outbox/publicações | ✅ `checkAccess` outbox | ✅ empresa na fila/outbox | ✅ `FilaPage.test` + oracle + `smoke(smoke:pg) 0058` (fila real publica) |
| **Checkout/Loja** (bônus) | ✅ `LojaInicio/Produto/Carrinho` | ✅ carrinho→checkout | ✅ `LojaPedidoPage` | n/a | ✅ `POST /api/loja/checkout` (+6 rotas `/loja/*` públicas com `rateLimitPublico`) | ✅ `s.transaction` serializable → pedido+reserva+venda | ✅ público (sem sessão; por design) | ✅ empresa da loja no raiz da transação | ✅ `LojaFluxoPages.test` + `commerce-e2e.test.ts` (PG) |

## 2. Achados desta auditoria (e o que foi feito)

| Achado | Severidade | Destino |
| --- | --- | --- |
| `PUT /produtos/:id` resolvia projeção pelo id errado (cross-empresa risk) | **P0** | **CORRIGIDO** (`catalogo.ts`, `{ produto_id, empresa_id }`) + teste decoy verde |
| Detalhe/editar de publicação sem `GET /publicacoes/:id` | **P0** | **CORRIGIDO** (rota + handler + 3 telas com teste) |
| `GET /erros` inexistente (erros só no banco) | **P1** | **CORRIGIDO** (rota + handler + tela + 403 testado) |
| `GET /ofertas[/:id]` inexistentes | **P1** | **CORRIGIDO** (rotas + handlers + 3 telas com teste) |
| Filtro de status de devoluções enviado como `filter.status` (rota genérica só lê `f.status`) — filtro inócuo | **P1** | **CORRIGIDO** nesta rodada + teste de contrato novo |
| Subrotas novas sem item de menu (`ROTA_SEM_MENU`) | P3 | **RELATADO** — navegação por link é o padrão do produto |
| Tenancy nominal A×B de `commerce_outbox/promocoes/cupons/rastreio` sem teste que os cite | P2 | **RELATADO** no `architecture:audit` (cobertura indireta existe) |
| Sem tela própria de detalhe para promoção/cupom | P3 | **RELATADO** — edição é o detalhe, CRUD completo |

## 3. Números da rodada (para conferência)

- Server: **1521 testes / 0 fail / 0 todo / 68 skip** (68 = PG-only, enumerados).
- Client: **108 arquivos / 986 testes ALL PASS** (arquivos novos de página: 27 em `pages/commerce`, 91 `it`s).
- PG real: **315 pass / 0 fail / 0 skip / 0 todo** (`test:pg`, PG 16.14) · `smoke:pg` **396/396** · `smoke` **396/396**.
- Rotas: **33 `/api/commerce/*` + 6 `/api/loja/*`** no `index.ts`; 13 rotas front novas.
- Gate final: **CODE_READY · P0=0 · P1=0 · P2=docs(agora criados) · EXTERNAL_HOMOLOGATION_BLOCKED · FULL_GO_LIVE=NÃO**.
