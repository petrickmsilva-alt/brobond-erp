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

O cron roda a cada ciclo com a MESMA chave idempotente
(`woo-estoque:<loja>:lote`). Um evento já `PROCESSADO` é **re-armado** para
`PENDENTE` (mesma linha, `claim_versao` preservado pelo CAS): sem isso a
sincronização periódica aconteceria UMA vez e nunca mais. Eventos `PENDENTE` /
`PROCESSANDO` **não** são re-armados — já têm trabalho em voo.

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
| GET | `/api/commerce/woocommerce/lojas/:store/webhooks` | Estado do inbox, pendentes e falhas |
| POST | `/api/commerce/woocommerce/lojas/:store/webhooks/reprocessar` | Re-enfileira entregas presas |
| POST | `/api/commerce/woocommerce/lojas/:store/webhooks/:id/reprocessar` | Reprocessa UMA entrega |
| POST | `/api/commerce/woocommerce/lojas/:store/reconciliar` | Executa a reconciliação ERP × loja |
| GET | `/api/commerce/woocommerce/lojas/:store/divergencias` | Painel de divergências (`?categoria=`/`?status=`) |
| POST | `/api/commerce/woocommerce/lojas/:store/divergencias/:id/corrigir` | Correção controlada de uma divergência |

Nenhuma resposta carrega CK/CS, URL com usuário/senha ou corpo remoto da loja.
O painel do cliente (`WooLojasPanel`) vive dentro de `/commerce/fila` — sem menu
paralelo.

## 9.1 Webhooks (migration 0101) — notificação, nunca fonte de verdade

O WooCommerce **notifica**; o ERP **confirma pela API** antes de aplicar
qualquer alteração sensível. O webhook nunca substitui o polling — é o caminho
rápido ao lado dele.

| Loja | Endpoint público | Segredo |
|---|---|---|
| RETAIL | `POST /api/commerce/woocommerce/webhooks/RETAIL` | `WOOCOMMERCE_RETAIL_WEBHOOK_SECRET` |
| WHOLESALE | `POST /api/commerce/woocommerce/webhooks/WHOLESALE` | `WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET` |

**Segurança (falha fechada):**

- Assinatura **HMAC-SHA256** calculada sobre os **bytes crus** do corpo
  (`X-WC-Webhook-Signature`), comparada em tempo constante
  (`crypto.timingSafeEqual`). O parser JSON só roda **depois** da validação —
  a rota é montada antes de `express.json()`.
- Segredo **independente por loja**; sem segredo configurado o endpoint daquela
  loja recusa **toda** entrega (401). A loja vem do **path**, nunca do corpo —
  um `store_key` no payload é ignorado para escolher o segredo.
- Teto de corpo (`WOOCOMMERCE_WEBHOOK_MAX_BYTES`, 1 MiB), rate limit por IP
  (`WOOCOMMERCE_WEBHOOK_RATE_MAX`/`_RATE_WINDOW_MS`) e janela de timestamp
  opcional (`WOOCOMMERCE_WEBHOOK_TOLERANCE_S`; 0 desliga).
- Logs sem segredo e sem payload pessoal: grava-se o **hash** do corpo, o
  tópico e o recurso externo — nunca a credencial.

**Idempotência (inbox `woocommerce_webhook_events`):**

- `uq_woo_webhook_delivery` — único por (empresa, loja, `external_delivery_id`).
- `uq_woo_webhook_dedupe` — quando a plataforma **não** envia ID de entrega, a
  identidade é (empresa, loja, tópico, recurso externo, **hash do corpo**): a
  mesma reentrega é descartada, mas um corpo **diferente** (atualização
  legítima) nunca é perdido.
- Receber é rápido: grava a entrega e **enfileira** no `commerce_outbox`
  (`woo-webhook:<loja>:<entrega>`); o worker processa fora da requisição HTTP.
  RETAIL e WHOLESALE têm filas independentes — a falha de uma não bloqueia a
  outra.

**Worker:** claim atômico por CAS (`claim_versao`), retry com backoff, limite
de tentativas, estado terminal e recuperação de eventos presos
(`recuperarEntregasPendentes`). O botão **Reprocessar pendentes** e o
**reprocessar** por entrega usam a **mesma** chave idempotente (reusam a linha
do outbox).

**Ordem e reconciliação de pedidos:** o pedido é relido na API oficial antes de
gravar; evento atrasado (fora de ordem) **não** sobrescreve estado mais novo. A
referência lógica continua `WOO-RETAIL-<id>` / `WOO-WHOLESALE-<id>` com
idempotência forte da 0034. Nenhum pagamento, estorno ou cancelamento é
executado automaticamente.

## 9.2 Reconciliação ERP × loja (migration 0101)

A reconciliação compara o ERP (autoridade) com o que está publicado em **cada**
loja e registra **divergências** em `woocommerce_reconciliacao_divergencias` —
nunca exclui produto ou vínculo automaticamente.

| Categoria | Detecta | Classificação típica |
|---|---|---|
| `CATALOGO` | Vínculo órfão, produto excluído externamente, SKU divergente, variação ausente/duplicada, produto visível sem vínculo | Humana (decisão) |
| `PRECO` | Preço externo divergente/ausente/inválido, preço de variação divergente | Automática (corrigível) ou humana |
| `ESTOQUE` | Saldo da loja ≠ disponível vendável do ERP (produto e variação) | Automática (corrigível) |
| `PEDIDOS` | Pedido na loja ausente no ERP, status/valor divergente, importação incompleta | Humana |

- **Classificação:** `LEGITIMA` (diferença esperada), `AUTOMATICA` (corrigível
  pela sincronização) e `HUMANA` (exige decisão — ex.: republicar excluído).
- **Idempotência:** `uq_woo_divergencia_fingerprint` por (empresa, loja,
  fingerprint). Reabrir a mesma divergência **não** empilha linha; reaparecer
  reabre a existente.
- **Correção controlada:** só divergência `AUTOMATICA` e `ABERTA` é corrigível
  pela rota; a correção **enfileira** a operação no outbox (o ERP empurra o
  valor **canônico** — preço do ERP, disponibilidade do ERP) e registra a
  resolução. Divergência `HUMANA` permanece para análise.
- **Correção automática:** o preço canônico do ERP **nunca** é sobrescrito pelo
  valor externo; a loja é que recebe o valor do ERP.
- A execução roda no cron (`WOOCOMMERCE_RECONCILIACAO_INTERVALO_MIN`) **apenas**
  com o modo multi-loja ligado e a loja configurada; também há a rota manual
  `POST /lojas/:store/reconciliar`.

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
| `server/test/woocommerce-webhooks-reconciliacao.test.ts` | Assinatura HMAC (válida/inválida/corpo alterado/segredo trocado/replay/payload excessivo/inválido), idempotência por entrega, worker/retry, pedidos fora de ordem, reconciliação (catálogo/preço/estoque/pedido), RBAC e isolamento |
| `server/test/woocommerce-webhook-rota.test.ts` | A ROTA pública de ponta a ponta (express + supertest): assinatura sobre os BYTES CRUS (corpo reformatado é recusado), segredo de outra loja recusado, loja sem segredo falha fechada, replay por timestamp, teto de corpo (413), duplicata (202), loja desconhecida cai no 404, e nenhuma resposta vaza CK/CS/segredo |
| `server/test/pg/woocommerce-multistore-pg.test.ts` | Migration 0100 e **0101**, unicidade NULL-safe por loja, CHECK/FK, índice parcial de idempotência sob corrida, dedupe alternativa por hash, **reaplicação idempotente da 0101 (caminho legado)**, concorrência de importação, publicações por loja |

## 12. Pendências externas

- Credenciais reais das duas lojas (CK/CS) — provisionadas pelo cliente no
  Render; sem elas o painel mostra exatamente o que falta e nenhuma escrita é
  feita.
- **Webhooks do WooCommerce:** o código está completo e testado, mas os
  endpoints só aceitam entregas depois que o cliente cadastrar o webhook em
  **cada** loja e informar o segredo (`WOOCOMMERCE_RETAIL_WEBHOOK_SECRET` /
  `WOOCOMMERCE_WHOLESALE_WEBHOOK_SECRET`) no Render. Sem o segredo a rota
  recusa a entrega (falha fechada) — é homologação externa pendente, não código
  faltando. O polling incremental continua sendo o caminho ativo até lá.
- Nenhuma entrega de teste real foi recebida das lojas: não há credencial nem
  segredo provisionados neste ambiente. A prova é estrutural (HMAC sobre bytes
  crus, idempotência, worker, reconciliação).

## 13. Endurecimento (auditoria de produção)

Defeitos reais corrigidos, cada um com teste de regressão (`WS-7` em
`server/test/woocommerce-multistore.test.ts` e item 10 do gate PostgreSQL):

| Defeito | Correção |
|---|---|
| URL de loja inválida (ex.: rede interna) fazia `configStore` LANÇAR — derrubava o painel e a leitura da outra loja | `configStore` degrada para `null` com `motivo` acionável; `exigirConfigStore` continua falhando fechado |
| Host com ponto final (`http://10.0.0.5.`, `localhost.`) furava o filtro de SSRF | `hostInterno` normaliza o ponto final do FQDN raiz antes de comparar |
| Sincronização de estoque em dry-run terminava em ERRO (o lote sintético não é confirmação da loja) | o dry-run não confere o lote; reporta quantos itens SERIAM enviados e **não** avança a água-marca |
| Dry-run gravava vínculos com `external_product_id` vazio (memória envenenada) | publicação em dry-run não grava vínculo; `registrarVinculo` recusa ID externo vazio |
| Paginação `order=desc` na importação incremental pulava pedidos quando a janela excedia o limite | `order=asc`: o truncamento deixa de fora só os mais novos, que a próxima execução pega |
| Cron recorrente sincronizava UMA vez e nunca mais (chave idempotente já `PROCESSADO`) | evento terminal é re-armado para `PENDENTE` na mesma linha; `PENDENTE`/`PROCESSANDO` não são tocados |
| Lote de estoque podia exceder o máximo de 100 itens por chamada da API do WooCommerce | envio fatiado em blocos de 100 (variações e produtos) |
| Lista de produtos da loja vazia era lida como leitura truncada (falso positivo de `RECONCILIACAO_TRUNCADA`) | a paginação distingue “vazio” de “truncado” pela quantidade de páginas |
| Coluna `dados` (json) some da API por ser coluna protegida — a divergência parecia não guardar o valor canônico | o teste prova pelo registro bruto; o valor canônico também fica no `detalhe` legível |
