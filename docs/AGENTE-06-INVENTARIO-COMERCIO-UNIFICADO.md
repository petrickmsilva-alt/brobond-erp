# Agente 06 — Inventário do comércio unificado

**Data da auditoria:** 2026-11-07
**Base:** `f432ca17be6a68307f4bc0ddebf927a1e02d0774`
**Branch:** `arena/106e72e0-brobond-erp`
**Natureza:** inventário estático, leitura cruzada e reproduções isoladas; nenhuma correção funcional foi aplicada.

Este documento registra o que existe no repositório. Não é homologação das lojas nem declaração de prontidão. Os defeitos e bloqueios estão em `AGENTE-06-RELATORIO-UNIFICACAO-COMERCIAL.md`; as comparações por canal estão em `AGENTE-06-MATRIZ-COMERCIO-UNIFICADO.md`.

## 1. Escopo e documentos lidos integralmente

Foram lidos `AGENTS.md`, `README.md` e os doze documentos arquiteturais obrigatórios:

- `docs/ERP-3.0-ARCHITECTURE.md`;
- `docs/ERP-3.0-ROADMAP.md`;
- `docs/ERP-3.0-DATA-OWNERSHIP.md`;
- `docs/ERP-3.0-UI-MAP.md`;
- `docs/ERP-3.0-MULTIEMPRESA.md`;
- `docs/ERP-3.0-ACCESS-CONTROL.md`;
- `docs/ERP-3.0-TEST-STRATEGY.md`;
- `docs/COMMERCE-ARCHITECTURE.md`;
- `docs/COMMERCE-CHANNEL-MATRIX.md`;
- `docs/COMMERCE-GAP-AUDIT.md`;
- `docs/COMMERCE-GO-LIVE.md`;
- `docs/COMMERCE-WOOCOMMERCE-MULTI-STORE.md`.

Também foram confrontados `db/schema.sql`, migrations relevantes (`0015`, `0016`, `0024`, `0034`, `0046`, `0068`, `0100`, `0101` e `0102`), `prisma/schema.prisma`, `render.yaml`, `.github/workflows/ci.yml` e o inventário gerado `docs/ERP-3.0-ARCHITECTURE-INVENTORY.json`.

## 2. Stack real encontrada

| Camada | Implementação encontrada |
|---|---|
| Frontend | React 18 + Vite + TypeScript; páginas em `client/src/pages`; menu declarativo em `client/src/modules.ts` |
| API | Express + TypeScript em `server/src/index.ts`; handlers por domínio; CRUD e autorização em `services.ts` |
| Persistência operacional | PostgreSQL por `PgStore`; `MemStore` para demonstração/testes |
| Migrações | `db/bootstrap.sql` + cadeia lexicográfica `db/migrations/*.sql`; Prisma em bounded context/dual-track |
| Catálogo | `produtos`, variações por `produto_pai_id`/`variacao_tamanho_id`, `tamanhos`, grades |
| Estoque | Célula `empresa_id + produto_id + tamanho_id + local_id`; compromissos em `estoque_reservas` |
| Pedido operacional | `vendas` + `itens_venda`; faturamento, estoque e financeiro em `itens.ts`/`financeiro.ts` |
| Pedido analítico | `sales` + `sale_items`; BI em `negocios.ts` |
| Pedido Commerce | `commerce_pedidos`; checkout, pagamento, reserva e projeção em `commerce/pedidos.ts` |
| Integrações | WooCommerce legado, WooCommerce Multi-Store, conectores Mercado Livre/Nuvemshop/Mercado Pago/Instagram |
| Assíncrono | `commerce_outbox`, inbox de webhooks Woo, jobs agendados e locks distribuídos |

## 3. Verdades de dados e limites entre os modelos

| Tabela/recurso | Papel encontrado | Não deve ser confundido com |
|---|---|---|
| `produtos` | Catálogo ERP único, preços-base, publicação e hierarquia pai/variação | Uma tabela de produtos por loja |
| `estoques` | Saldo físico por produto/tamanho/local | Disponível vendável |
| `estoque_reservas` | Reserva, empenho ou bloqueio ativo/consumido/liberado | Baixa física de estoque |
| `vendas`/`itens_venda` | Pedido e venda operacional; origem de faturamento, estoque, financeiro e comissão | `sales` |
| `sales`/`sale_items` | Ingestão multicanal e projeção analítica do BI | Uma segunda venda operacional |
| `commerce_pedidos` | Máquina de estados do checkout/pedido Commerce, token e vínculos | `vendas` |
| `commerce_produtos` | Projeção de conteúdo para a vitrine | Novo catálogo independente |
| `commerce_precos` | Preço/promoção por produto e canal | Identidade por loja Woo; não possui `store_key` |
| `commerce_publicacoes` | Pipeline idempotente por canal e, desde 0100, `store_key` | Anúncio externo em si |
| `representantes` | Cadastro comercial por empresa, vínculo opcional com `usuarios` | Perfil de autorização `REPRESENTATIVE` |
| `venda_atribuicao` | Principal/secundários e participação na venda | Evento de comissão efetivada |
| `comissoes_apuradas` | Apuração append-only por venda/representante | Livro de recebimento |
| `comissoes_eventos` | Efetivação e estorno de comissão pelo recebimento | Plano/regra de comissão |
| `woocommerce_product_links` | Vínculo por empresa, loja, produto e variação | Publicação ou preço |
| `woocommerce_sync_state` | Água-marca e diagnóstico por empresa/loja | Fila de execução |
| `woocommerce_webhook_events` | Inbox durável e deduplicação por loja/entrega | `commerce_outbox` |
| `woocommerce_reconciliacao_divergencias` | Divergências classificadas e seu ciclo de vida | Log transitório |

A ponte `marketplaceOperacional.ts` converte `sales` em `vendas` e mantém a linha analítica original ligada por `operational_venda_id`. `negocios.projetarVendasErp` exclui qualquer `venda` com `pedido_externo_id` para evitar duplicar marketplace no BI. Essa mesma exclusão afeta o WooCommerce Multi-Store, que não cria uma `sale` própria; o efeito está reportado como A06-05.

## 4. Canais e fluxos existentes

### 4.1 Loja Própria nativa — canal `BROBOND`

- Vitrine pública `/loja` e API `/api/loja/*` em `commerce/vitrine.ts`.
- Tenant resolvido por `COMMERCE_LOJA_EMPRESA_ID` ou por exatamente uma configuração; multiempresa ambíguo falha fechado (`commerce/loja-base.ts`).
- Catálogo projetado de `produtos`; preço de `precoNoCanal(..., 'BROBOND')`.
- Disponível por pai+tamanho e melhor local vendável; reserva antes da cobrança.
- Total, cupom e frete calculados no servidor.
- Payment Engine e webhooks confirmam pagamento; `commerce_pedidos` acompanha o fluxo.
- Conversão cria `sales`/`sale_items` e depois `vendas`/`itens_venda`; a `sale` original permanece no BI.
- Não existe identificador operacional `RETAIL` nesse fluxo.

### 4.2 WooCommerce RETAIL

- Identidade imutável `RETAIL`, URL própria e credenciais `WOOCOMMERCE_RETAIL_*`.
- Base de preço `produtos.preco_venda`; vínculos e publicações independentes por `store_key`.
- Pedido importado como `vendas` em `cotacao`, `canal_venda='site_varejo'`, referência `WOO-RETAIL-<id>` e canal externo `WOOCOMMERCE_RETAIL`.
- Não cria `commerce_pedidos` nem `sales` no momento da importação.
- Webhook confirma o pedido na API antes de reutilizar `importarUmPedido`.

### 4.3 WooCommerce WHOLESALE

- Identidade imutável `WHOLESALE`, URL e credenciais próprias.
- Base de preço `produtos.preco_atacado`.
- Publica `_brobond_atacado_min_qtd` como metadado. Não foi encontrado plugin/consumer no repositório que transforme esse metadado em regra de checkout WooCommerce.
- Pedido importado como `vendas` em `cotacao`, `canal_venda='site_atacado'`, referência `WOO-WHOLESALE-<id>` e canal externo `WOOCOMMERCE_WHOLESALE`.
- Não há vitrine atacadista nativa separada em `/loja`.

### 4.4 WooCommerce single-store legado

- Implementação em `server/src/loja.ts`, rotas `/api/marketplace/loja/*` e variáveis `WOOCOMMERCE_URL/CK/CS/CANAL/EMPRESA_ID`.
- Continua registrado mesmo quando o Multi-Store existe; o agendador Multi-Store só executa quando a flag está ligada.
- Importa `WOO-<id>` e usa canal externo `WOOCOMMERCE`.
- Publica estoque por agregação própria de `estoques.quantidade`; difere do motor de disponível usado pelo Multi-Store (A06-02).

### 4.5 Marketplaces/conectores

- Ingestão oficial grava `sales` e `sale_items` por empresa/usuário/canal/pedido externo.
- `garantirPedidoDaSale` projeta `commerce_pedidos`.
- `converterOrdemMarketplaceEmVenda` exige itens casados, consome reserva quando aplicável, fatura pela regra canônica e sincroniza financeiro.
- Canais analíticos existentes: `BROBOND`, `INSTAGRAM_SHOPPING`, `MERCADOLIVRE`, `MERCADOPAGO`, `NUVEMSHOP`, `LOJA_FISICA`.
- O reprocessamento com cabeçalho inalterado não reprocessa itens (A06-08).

### 4.6 Representante

- Venda assistida real usa `vendas.canal_venda='representante'` e `vendas.representante_id`.
- Atribuição adicional em `venda_atribuicao` permite um principal e secundários com participação total de até 100%.
- Planos, regras e apuração em `comercial.ts`; efetivação por recebimento em `comissoes.ts`.
- O tipo `REPRESENTATIVE` aparece no pacote de domínio, mas não no enum PostgreSQL `sale_channel`; a projeção `vendas → sales` mapeia esse canal para `BROBOND`.
- `representantes.usuario_id` é vínculo cadastral opcional, não um perfil RBAC próprio nem escopo automático “somente minha carteira”.

## 5. Recursos, tenancy e autorização

`ops` descreve o CRUD genérico; fluxos especializados podem escrever por handlers próprios após `checkFluxo` e validações específicas.

| Recurso | Empresa | CRUD genérico | Perfil mínimo declarado | Observação |
|---|---:|---|---|---|
| `produtos` | Sim | C/U/D | Leitura livre autenticada | Catálogo único |
| `estoques` | Sim | C/U/D | — | Escrita operacional também tem fluxos próprios |
| `estoque_reservas` | Sim | Somente leitura | Gerente | Criação/liberação por fluxo |
| `vendas` | Sim | C/U/D | — | Faturamento/cancelamento por hooks |
| `itens_venda` | Sim | Nenhum | — | Subrecurso da venda |
| `representantes` | Sim | C/U/D | — | Delete protegido por dependências; desativação preserva histórico |
| `venda_atribuicao` | Sim | C/U/D | — | Não altera atribuição após faturamento |
| `planos_comissao` | Sim | C/U/D | Gerente | Motor em `comercial.ts` |
| `regras_comissao` | Sim | C/U/D | Gerente | Resolução por escopo/vigência/prioridade |
| `lancamentos_financeiros` | Sim | C/U/D | Gerente | Comissões têm endpoints adicionais |
| `sales` | Sim | Nenhum | — | Ingestão/projeção |
| `commerce_configuracoes` | Sim | C/U | Gerente | Dono da vitrine |
| `commerce_produtos` | Sim | Nenhum | Escrita gerente | Projeção de catálogo |
| `commerce_precos` | Sim | Nenhum | Escrita gerente | Não contém `store_key` |
| `commerce_publicacoes` | Sim | Nenhum | Gerente | Pipeline |
| `commerce_pedidos` | Sim | Nenhum | — | Handlers de pedido |
| `commerce_outbox` | Sim | Nenhum | Gerente | Fila persistente |
| `woocommerce_product_links` | Sim | Nenhum | — | Recurso interno |
| `woocommerce_sync_state` | Sim | Nenhum | — | Recurso interno |
| `woocommerce_webhook_events` | Sim | Nenhum | — | Inbox interno |
| `woocommerce_reconciliacao_divergencias` | Sim | Nenhum | — | Correção por rota gerente/admin |
| `commerce_promocoes`/`commerce_cupons` | Sim | C/U/D | Gerente | Regras do checkout |
| `commerce_rastreio` | Sim | C/U | — | Fulfillment |

As ações individuais Woo exigem gerente/admin e chamam `exigirStoreDaEmpresa`. As rotas agregadas `/commerce/woocommerce/status` e `/commerce/woocommerce/lojas` não aplicam esse filtro a cada loja (A06-09). O menu Comissões exige gerente, mas os dois handlers de leitura não repetem essa alçada (A06-07).

## 6. Rotas e navegação

| Superfície | Rotas encontradas | Uso |
|---|---|---|
| Vitrine nativa | `/loja`, `/loja/carrinho`, `/loja/pedido/:token`; `/api/loja/*` | Compra pública BROBOND |
| Vendas ERP | `/vendas`, `/api/vendas`, hooks de itens/status | Representante, pedidos Woo e operação |
| Representantes | `/representantes`, detalhe/edição, carteira, hierarquia, equipes, metas | Backoffice comercial |
| Comissões | `/comissoes`, `/planos-comissao`, `/regras-comissao`; `/api/financeiro/comissoes*` | Apuração/efetivação |
| Commerce admin | `/commerce/produtos`, `/publicacoes`, `/precos`, `/pedidos`, `/pagamentos`, `/fila` | Gestão multicanal |
| Woo Multi-Store | Painel embutido em `/commerce/fila`; `/api/commerce/woocommerce/*` | Lojas, publicação, estoque, pedidos, webhooks e reconciliação |
| Woo legado | `/api/marketplace/loja/*` | Single-store |
| Conectores | `/conectores/mercado-livre`, `/nuvemshop`, `/mercado-pago`, `/instagram` | Configuração e operação |

Não há menu WooCommerce autônomo: `WooLojasPanel.tsx` é uma seção de Fila & Sync. O painel possui teste de conexão, publicação, sincronização de estoque, importação, reconciliação, webhooks, reprocessamento e correção controlada. Pedidos importados são operados na tela genérica de Vendas, não em uma fila específica RETAIL/WHOLESALE.

## 7. Motor de estoque e variações

O motor canônico usa:

- identidade `empresa + produto + tamanho + local`;
- disponível `físico − reservas/empenhos/bloqueios ativos`;
- melhor célula entre local de saída e local padrão para cada linha;
- saldo vendável no produto pai+tamanho quando o SKU/preço está na variação filha;
- reserva no checkout e baixa física somente no faturamento/pagamento convertido.

`client/src/lib/productSearch.ts` e `server/src/productSearch.ts` explicitam que o saldo do filho não é somado quando ele é apenas SKU da variação. Em contraste, `woocommerce/publicacao.ts` e `woocommerce/estoque.ts` consultam disponibilidade pelo ID do filho (A06-04), e `loja.ts` agrega físico sem reservas (A06-02).

## 8. Comissões: componentes e sequência

1. O faturamento congela `vendas.comissao_pct` e `vendas.comissao_valor` a partir do representante/cadastro.
2. O endpoint explícito `POST /api/comercial/vendas/:id/apurar-comissao` resolve planos/regras por item e grava `comissoes_apuradas`.
3. A apuração reescreve os campos da venda com o valor do principal.
4. Recebimentos geram `comissoes_eventos` proporcionais, limitados por `vendas.comissao_valor`.
5. Cancelamento/estorno gera evento de estorno; relatórios leem a venda e o livro de eventos.

Não são motores redundantes: `comercial.ts` apura e `comissoes.ts` efetiva. Entretanto, o contrato entre eles só comporta corretamente o principal; a divisão perde o secundário no relatório/efetivação (A06-06), e reapuração após recebimento não agenda nova efetivação por si só.

## 9. Testes existentes relacionados

- `server/test/woocommerce-multistore.test.ts`: registry, preço-base, publicação, vínculos, estoque, pedidos, painel e dry-run com mocks.
- `server/test/woocommerce-multistore-rotas.test.ts`: autorização e tenant das ações por loja.
- `server/test/woocommerce-webhook-rota.test.ts` e `woocommerce-webhooks-reconciliacao.test.ts`: HMAC, inbox, worker, deduplicação e reconciliação.
- `server/test/pg/woocommerce-multistore-pg.test.ts`: constraints, unicidade por loja, concorrência de pedidos e inbox real.
- `server/test/loja.test.ts`: fluxo single-store legado.
- `server/test/commerce-*.test.ts`, `server/test/pg/commerce-*.test.ts`: catálogo, checkout, pagamento, reserva, conversão e tenancy.
- `server/test/pg/pg-golive03-marketplace-venda.test.ts`: ponte marketplace → venda.
- `server/test/representantes-*.test.ts`, `server/test/pg/representantes-pg.test.ts`: cadastro, carteira e isolamento.
- `server/test/financeiro-p2.test.ts`, `server/test/pg/comissoes-e2e.test.ts`, `comissoes-periodo.test.ts`: apuração simples, recebimento, período e estorno.
- `client/src/pages/ComissoesPage.test.tsx`, testes de representantes, Commerce e vitrine.

Lacunas de cobertura diretamente relacionadas aos achados: preço remoto divergente do ERP; referência `WOO-<id>` colidindo entre lojas; saldo apenas no pai da variação; projeção analítica Woo; comissão com secundários; alçada de operador nos relatórios; reingestão com cabeçalho inalterado; filtro de tenant nos painéis agregados.

## 10. Evidências gerais do inventário automatizado

Na base auditada, `architecture:audit` reportou 102 migrations SQL, 212 tabelas (184 com `empresa_id`), 174 recursos (156 multiempresa), 144 módulos e 474 rotas HTTP, sem erro de coerência e com 34 avisos. `audit:menu` encontrou 107 recursos navegáveis e 21 avisos, incluindo rotas Commerce sem menu e endpoints públicos pré-auth. Esses números são cobertura estrutural, não prova de correção funcional nem de homologação externa.
