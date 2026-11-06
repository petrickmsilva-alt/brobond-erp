# WooCommerce Multi-Store — RETAIL / WHOLESALE

> Uma empresa, UM catálogo, DUAS lojas independentes. Este documento é a
> verdade operacional do módulo `server/src/commerce/woocommerce/` e da
> migration `0100_woocommerce_multistore.sql`. Sem “em breve”, sem dado fake.

## 1. Arquitetura

| Item | Valor |
|---|---|
| Empresa | `empresa_id = 1` (uma empresa dona das duas lojas) |
| Catálogo | **Único** (`produtos` do ERP). Nenhum produto é duplicado por loja |
| RETAIL | `https://brobond.com.br` — preço = `produtos.preco_venda` |
| WHOLESALE | `https://atacado.brobond.com.br` — preço = `produtos.preco_atacado` |
| Estoque | ERP é a fonte canônica (disponível vendável = físico − reservas − empenhado) |
| Identificadores | `RETAIL` / `WHOLESALE` — **IMUTÁVEIS**, persistidos como `store_key` |

Os identificadores entram no banco (`woocommerce_product_links.store_key`), na
chave de idempotência do outbox (`woo-estoque:RETAIL` ≠ `woo-estoque:WHOLESALE`)
e na referência do pedido importado (`WOO-RETAIL-123` ≠ `WOO-WHOLESALE-123`).
Eles **nunca** são derivados da URL nem do nome da loja: trocar o domínio não
reclassifica vínculos históricos.

## 2. Configuração (Render › Environment)

Com `WOOCOMMERCE_MULTI_STORE_ENABLED=false` (padrão), vale o bloco single-store
(`WOOCOMMERCE_URL/CK/CS`) e **nada muda** no comportamento atual.

| Variável | Obrigatória | Efeito |
|---|---|---|
| `WOOCOMMERCE_MULTI_STORE_ENABLED` | Não | Liga o modo multi-loja (default `false`) |
| `WOOCOMMERCE_RETAIL_ENABLED` | Condicional | Habilita a loja RETAIL |
| `WOOCOMMERCE_RETAIL_URL` | Condicional | Origem da RETAIL (validada contra SSRF; HTTPS em produção) |
| `WOOCOMMERCE_RETAIL_CK` / `_CS` | Condicional | Consumer key/secret da RETAIL (Leitura/Gravação) |
| `WOOCOMMERCE_RETAIL_EMPRESA_ID` | Não | Empresa dona; cai em `WOOCOMMERCE_EMPRESA_ID` e, por fim, em 1 |
| `WOOCOMMERCE_WHOLESALE_ENABLED` | Condicional | Habilita a loja WHOLESALE |
| `WOOCOMMERCE_WHOLESALE_URL` | Condicional | Origem da WHOLESALE |
| `WOOCOMMERCE_WHOLESALE_CK` / `_CS` | Condicional | Credenciais da WHOLESALE |
| `WOOCOMMERCE_WHOLESALE_EMPRESA_ID` | Não | Igual à RETAIL quando ausente |
| `WOOCOMMERCE_SYNC_DRY_RUN` | Não | `true` suprime **toda** escrita nas lojas (homologação) |
| `WOOCOMMERCE_TIMEOUT_MS` | Não | Timeout das chamadas (default 20 000 ms) |

As chaves são criadas em **WooCommerce › Configurações › Avançado › API REST**
na loja correspondente, com permissão de Leitura/Gravação. **Nenhuma credencial
é versionada** — nem em `render.yaml`, nem em testes, nem em logs.

## 3. Migration 0100 — aditiva e não destrutiva

| Objeto | Papel |
|---|---|
| `woocommerce_product_links` | Vínculo ERP ↔ loja por produto **e** por variação |
| `woocommerce_sync_state` | Água-marca incremental + último erro por loja |
| `commerce_publicacoes.store_key` | NULL = linha legada (single-store), preservada |
| `commerce_outbox.store_key` | NULL = linha legada; índice por loja |
| `uq_commerce_publicacoes_versao_loja` | Unicidade com `COALESCE(store_key, '')` |
| `uq_commerce_publicacoes_ativa` | Uma publicação ativa por (produto, canal, loja) |
| `ix_vendas_pedido_cliente` | Acelera a leitura do “já importado” |

A unicidade dos vínculos é **NULL-safe** em dois índices parciais:

- `uq_woo_links_produto_simples` — um vínculo de PRODUTO por (empresa, loja, produto)
  quando `external_variation_id IS NULL`;
- `uq_woo_links_produto_variacao` — um vínculo de VARIAÇÃO por
  (empresa, loja, produto, `external_variation_id`) quando não nulo.

Um ID externo pertence a **uma** empresa e a **uma** loja
(`uq_woo_links_external_produto` / `uq_woo_links_external_variacao`) — o ID da
RETAIL nunca é confundido com o da WHOLESALE.

Rollback (manutenção autorizada): o bloco comentado no topo do arquivo da
migration remove tabelas/colunas/índices criados e restaura as constraints
originais. Nenhum `DROP` de tabela histórica e nenhum `DELETE` de dados.

## 4. Regras de preço

| Loja | Base | Observação |
|---|---|---|
| RETAIL | `produtos.preco_venda` | — |
| WHOLESALE | `produtos.preco_atacado` | Respeita `atacado_min_qtd` |

A precedência de promoção por canal continua no Commerce (`precoEfetivo` em
`commerce/regras.ts`): linha vigente em `commerce_precos` para o canal vence a
base. O que muda por loja é **apenas** a base.

Preço inválido (ausente ou ≤ 0) **não é publicado**: a publicação falha com
motivo acionável em vez de deixar anúncio sem preço na loja.

## 5. Regras de estoque

- O ERP é a autoridade. A loja nunca vira fonte.
- O saldo enviado é o **disponível vendável** (`disponibilidadesPorTamanho`):
  físico − reservas − empenhado − bloqueado.
- Cada loja recebe a **sua** sincronização, usando os IDs externos **do seu**
  vínculo — nunca um ID descoberto por SKU em outra loja (evita atualização
  cruzada).
- Nenhuma operação destrutiva: só `stock_quantity` + `manage_stock`.
- Produtos simples e variações são sincronizados em lote; o lote só é sucesso
  se a loja confirmar **todos** os itens enviados.

## 6. Publicação de catálogo

Idempotência em três camadas, nesta ordem:

1. **Vínculo persistido** (`woocommerce_product_links`) — a memória da loja;
2. **SKU exato na loja** (`GET /products?sku=`) — adota o anúncio já existente,
   nunca cria o segundo;
3. só então `POST /products` (criação).

Produto **variável** nunca vira simples: o pai é publicado como `type=variable`
com o atributo de tamanho, e cada variação do ERP (filho com `produto_pai_id`)
ganha o próprio `external_variation_id`, o próprio SKU, o próprio preço (da
**variação**, não do pai) e o próprio estoque.

## 7. Importação de pedidos

- Referência lógica por loja: `WOO-RETAIL-<id>` / `WOO-WHOLESALE-<id>`,
  gravada em `vendas.pedido_cliente`.
- Idempotência **forte** desde a migration 0034:
  `uq_vendas_pedido_externo (empresa_id, pedido_externo_canal, pedido_externo_id)`,
  com o canal gravado por loja (`WOOCOMMERCE_RETAIL` / `WOOCOMMERCE_WHOLESALE`).
  O mesmo id nas duas lojas gera **duas** vendas legítimas; reimportar não
  duplica (o INSERT perdedor recebe 23505 e é tratado como já importado).
- Compatibilidade: um pedido já importado pelo fluxo legado (`WOO-<id>`) é
  adotado, sem criar uma segunda venda.
- Incremental: a água-marca é `woocommerce_sync_state.ultimo_pedido_em` **da
  loja**; a primeira carga usa a janela `dias`. A água-marca nunca retrocede.
- Item sem SKU no ERP **não entra calado** — volta em `pendentes`.
- Valores financeiros (total, frete, desconto, forma de pagamento) são
  preservados. Cancelamento/reembolso **não** é aplicado automaticamente.

## 8. Outbox e resiliência

O multi-loja **não** cria uma segunda fila: reusa `commerce_outbox` com
`store_key` no payload e na coluna. A chave de idempotência inclui a loja, então
`woo-estoque:RETAIL` e `woo-estoque:WHOLESALE` são eventos distintos. Nenhuma
chamada externa acontece dentro de transação longa: o enfileiramento só grava a
linha; quem fala com a loja é o worker (`processarEventoStore`).

O processo de cron `pedidos` chama `enfileirarSincronizacaoMultiLoja`, que
enfileira, por loja, a sincronização de **estoque** e a importação incremental de
**pedidos** — sem tocar a rede. O worker do outbox drena os eventos no processo
`pedidos` (tipo `sincronizacao`).

Uma loja indisponível **não** interrompe a outra: cada varredura itera as lojas
e acumula desfechos; a falha de uma é registrada no estado **daquela** loja.

## 9. Rotas administrativas

Todas exigem identidade, recorte pela empresa do ator e perfil de gestão
(gerente/admin); a loja vem sempre do path e é validada contra o registry.

| Método | Rota | Ação |
|---|---|---|
| GET | `/api/commerce/woocommerce/status` | Diagnóstico de configuração (sem credencial) |
| GET | `/api/commerce/woocommerce/lojas` | Painel por loja (`?testar=1` testa a conexão) |
| GET | `/api/commerce/woocommerce/lojas/:store` | Painel de uma loja |
| GET | `/api/commerce/woocommerce/lojas/:store/reconciliacao` | ERP × vínculos |
| POST | `/api/commerce/woocommerce/lojas/:store/estoque` | Sincroniza estoque (`?enfileirar=1` só enfileira) |
| POST | `/api/commerce/woocommerce/lojas/:store/pedidos` | Importa pedidos (`?enfileirar=1` só enfileira) |
| POST | `/api/commerce/woocommerce/lojas/:store/produtos/:id/publicar` | Publica um produto |

Nenhuma resposta carrega CK/CS, URL com usuário/senha ou corpo remoto da loja.
O painel do cliente (`WooLojasPanel`) vive dentro de `/commerce/fila` — sem menu
paralelo.

## 10. Homologação (antes de habilitar escrita)

1. Definir `WOOCOMMERCE_SYNC_DRY_RUN=true` e `WOOCOMMERCE_MULTI_STORE_ENABLED=true`;
2. Preencher URL + CK/CS de **uma** loja por vez (a outra permanece desabilitada);
3. `GET /lojas?testar=1` — confirmar conexão e autenticação por loja;
4. `GET /lojas/:store/reconciliacao` — conferir correspondência de SKUs e
   variações; SKU conflitante **não** é alterado automaticamente;
5. Conferir os preços calculados por loja (`preco_venda` × `preco_atacado`);
6. `POST /lojas/:store/pedidos` — validar a importação incremental;
7. Só então desligar o dry-run, loja por loja, e habilitar a escrita.

Não executar exclusões em massa. Não realizar operações financeiras. Não
afirmar que as lojas estão sincronizadas sem credenciais e evidências reais.

## 11. Provas de teste

| Arquivo | Cobertura |
|---|---|
| `server/test/woocommerce-multistore.test.ts` | Registry, preço por loja, publicação idempotente, variações, estoque sem atualização cruzada, pedidos por loja, painel/segurança |
| `server/test/woocommerce-multistore-rotas.test.ts` | RBAC, isolamento por empresa, loja do path, ausência de credencial, inventário de rotas |
| `server/test/pg/woocommerce-multistore-pg.test.ts` | Migration 0100, unicidade NULL-safe por loja, CHECK/FK, concorrência de importação, publicações por loja |

## 12. Pendências externas

- Credenciais reais das duas lojas (CK/CS) — provisionadas pelo cliente no
  Render; sem elas o painel mostra exatamente o que falta e nenhuma escrita é
  feita.
- Webhooks do WooCommerce: não habilitados nesta entrega (a importação é
  incremental por polling). Se forem habilitados, validar assinatura antes de
  processar.
