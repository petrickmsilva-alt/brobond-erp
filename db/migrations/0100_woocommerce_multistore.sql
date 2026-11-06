-- 0100 — WOOCOMMERCE MULTI-STORE (RETAIL / WHOLESALE)
--
-- Uma empresa, um catálogo, DUAS lojas WooCommerce independentes:
--   RETAIL     https://brobond.com.br          preço = produtos.preco_venda
--   WHOLESALE  https://atacado.brobond.com.br  preço = produtos.preco_atacado
--
-- Aditiva e não destrutiva. Nenhuma linha existente é reescrita:
--   • `store_key` nasce NULL nas linhas legadas (fluxo single-store);
--     a unicidade é recalculada com COALESCE(store_key, '') — o
--     comportamento para as linhas antigas é EXATAMENTE o de antes;
--   • os vínculos externos vivem em tabela própria, com unicidade
--     NULL-safe (produto simples × variação), para que um ID externo da
--     RETAIL nunca seja confundido com o da WHOLESALE;
--   • nenhum DROP de tabela, nenhum DELETE, nenhum backfill silencioso.
--
-- Rollback (manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS woocommerce_sync_state;
--   DROP TABLE IF EXISTS woocommerce_product_links;
--   DROP INDEX IF EXISTS uq_commerce_publicacoes_versao_loja;
--   DROP INDEX IF EXISTS uq_commerce_publicacoes_ativa;
--   ALTER TABLE commerce_publicacoes DROP COLUMN IF EXISTS store_key;
--   ALTER TABLE commerce_outbox DROP COLUMN IF EXISTS store_key;
--   DROP INDEX IF EXISTS ix_vendas_pedido_cliente;
--   ALTER TABLE commerce_publicacoes
--     ADD CONSTRAINT uq_commerce_publicacoes_versao UNIQUE (empresa_id, produto_id, canal, versao);
--   CREATE UNIQUE INDEX uq_commerce_publicacoes_ativa
--     ON commerce_publicacoes (empresa_id, produto_id, canal)
--     WHERE estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'UPDATE_QUEUED');
--   DELETE FROM schema_migrations WHERE id = '0100_woocommerce_multistore.sql';
--   COMMIT;

-- ----------------------------------------------------------------------------
-- 1) VÍNCULOS EXTERNOS POR LOJA (ERP ↔ WooCommerce)
--
-- Um produto do ERP pode ter UM vínculo na RETAIL e OUTRO na WHOLESALE.
-- Uma variação (tamanho) do ERP pode ter o próprio external_variation_id.
-- `external_variation_id` NULL identifica o vínculo do PRODUTO (pai ou simples).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS woocommerce_product_links (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT NOT NULL,
  CONSTRAINT woocommerce_product_links_store_ck CHECK (store_key IN ('RETAIL', 'WHOLESALE')),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  external_product_id TEXT NOT NULL,
  external_variation_id TEXT,
  sku TEXT,
  status TEXT NOT NULL DEFAULT 'LINKED',
  CONSTRAINT woocommerce_product_links_status_ck CHECK (status IN ('PENDING', 'LINKED', 'ERROR', 'UNLINKED')),
  synced_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um vínculo por (empresa, loja, produto) para o PRODUTO (sem variação)…
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_links_produto_simples
  ON woocommerce_product_links (empresa_id, store_key, produto_id)
  WHERE external_variation_id IS NULL;
-- …e um vínculo por (empresa, loja, produto, variação) quando há variação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_links_produto_variacao
  ON woocommerce_product_links (empresa_id, store_key, produto_id, external_variation_id)
  WHERE external_variation_id IS NOT NULL;
-- Um ID externo pertence a UMA empresa e a UMA loja — nunca é reutilizado por
-- outra loja nem por outro produto da mesma loja.
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_links_external_produto
  ON woocommerce_product_links (empresa_id, store_key, external_product_id)
  WHERE external_variation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_links_external_variacao
  ON woocommerce_product_links (empresa_id, store_key, external_product_id, external_variation_id)
  WHERE external_variation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_woo_links_empresa_loja
  ON woocommerce_product_links (empresa_id, store_key, status, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS ix_woo_links_sku
  ON woocommerce_product_links (empresa_id, store_key, sku) WHERE sku IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) ESTADO DE SINCRONIZAÇÃO POR LOJA
--
-- Água-marca incremental (importação de pedidos por loja), data da última
-- sincronização de estoque/catálogo e o último erro real. Uma linha por
-- (empresa, loja). Falha da RETAIL não toca a linha da WHOLESALE.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS woocommerce_sync_state (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT NOT NULL,
  CONSTRAINT woocommerce_sync_state_store_ck CHECK (store_key IN ('RETAIL', 'WHOLESALE')),
  ultimo_pedido_em TIMESTAMPTZ,
  ultima_sincronizacao_estoque_em TIMESTAMPTZ,
  ultima_publicacao_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_woocommerce_sync_state UNIQUE (empresa_id, store_key)
);

-- ----------------------------------------------------------------------------
-- 3) `store_key` NO PIPELINE DE PUBLICAÇÃO E NA FILA (OUTBOX)
--
-- NULL = linha legada do fluxo single-store (WOOCOMMERCE_*), preservada.
-- A unicidade passa a considerar a loja via COALESCE(store_key, ''): as linhas
-- antigas continuam se comportando exatamente como antes (a chave efetiva é a
-- mesma), e a RETAIL e a WHOLESALE deixam de colidir entre si.
-- ----------------------------------------------------------------------------
ALTER TABLE commerce_publicacoes ADD COLUMN IF NOT EXISTS store_key TEXT;
ALTER TABLE commerce_publicacoes DROP CONSTRAINT IF EXISTS uq_commerce_publicacoes_versao;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_publicacoes_versao_loja
  ON commerce_publicacoes (empresa_id, produto_id, canal, COALESCE(store_key, ''), versao);
DROP INDEX IF EXISTS uq_commerce_publicacoes_ativa;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_publicacoes_ativa
  ON commerce_publicacoes (empresa_id, produto_id, canal, COALESCE(store_key, ''))
  WHERE estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'UPDATE_QUEUED');
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_loja
  ON commerce_publicacoes (empresa_id, canal, store_key, estado, atualizado_em DESC);

ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS store_key TEXT;
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_loja
  ON commerce_outbox (empresa_id, store_key, estado, id DESC) WHERE store_key IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4) ÍNDICE DA REFERÊNCIA DO PEDIDO IMPORTADO
--
-- A idempotência FORTE da importação já existe desde a migration 0034:
-- `uq_vendas_pedido_externo (empresa_id, pedido_externo_canal, pedido_externo_id)`
-- — e o canal é gravado por loja (`WOOCOMMERCE_RETAIL` / `WOOCOMMERCE_WHOLESALE`),
-- então o mesmo id de pedido nas duas lojas gera duas vendas legítimas e a
-- reimportação nunca duplica. Este índice apenas acelera a busca por
-- `pedido_cliente` (WOO-RETAIL-<id> / WOO-WHOLESALE-<id>), que é o caminho de
-- leitura do "já importado". NÃO é único: as vendas legadas (WOO-<id>) podem
-- ter colisões históricas que um índice único recusaria.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_vendas_pedido_cliente
  ON vendas (empresa_id, pedido_cliente) WHERE pedido_cliente IS NOT NULL;
