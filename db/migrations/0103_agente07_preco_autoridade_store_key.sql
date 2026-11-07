-- 0103 — SANEAMENTO COMERCIAL (AGENTE 07): AUTORIDADE DE PREÇO E ESCOPO POR LOJA
--
-- Duas colunas ADITIVAS, retrocompatíveis, sem backfill e sem DELETE:
--
--   1) itens_venda.preco_externo_recebido — EVIDÊNCIA do preço que a loja
--      (WooCommerce) informou no pedido importado. A autoridade do preço da
--      venda continua sendo o ERP (`produtos.preco_venda` / `preco_atacado` +
--      override `commerce_precos` da MESMA loja). Este campo existe só para
--      auditoria/conferência — nunca alimenta total, financeiro ou comissão.
--      NULL nas vendas legadas e nas vendas nativas (não importadas).
--
--   2) commerce_precos.store_key — separa os overrides de preço de RETAIL e
--      WHOLESALE. Antes, um override de canal WOOCOMMERCE era único por
--      (empresa, produto, canal) e podia vazar de uma loja para a outra. A
--      unicidade passa a considerar a loja via COALESCE(store_key, ''):
--      linhas legadas (store_key NULL) seguem com o comportamento antigo e
--      não são atribuídas arbitrariamente a nenhuma loja.
--
-- Aditiva e não destrutiva. Rollback (manutenção autorizada):
--   BEGIN;
--   DROP INDEX IF EXISTS uq_commerce_precos;
--   ALTER TABLE commerce_precos DROP CONSTRAINT IF EXISTS uq_commerce_precos_empresa_produto_canal;
--   ALTER TABLE commerce_precos DROP COLUMN IF EXISTS store_key;
--   ALTER TABLE itens_venda DROP COLUMN IF EXISTS preco_externo_recebido;
--   DELETE FROM schema_migrations WHERE id = '0103_agente07_preco_autoridade_store_key.sql';
--   COMMIT;

-- ----------------------------------------------------------------------------
-- 1) EVIDÊNCIA DO PREÇO EXTERNO NO ITEM DA VENDA (A06-01)
-- ----------------------------------------------------------------------------
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS preco_externo_recebido NUMERIC(12,2);
COMMENT ON COLUMN itens_venda.preco_externo_recebido IS
  'Preço informado pela loja externa (WooCommerce) no pedido importado — evidência. A autoridade do preço da venda é o ERP (A06-01).';

-- ----------------------------------------------------------------------------
-- 2) ESCOPO DE LOJA EM commerce_precos (A06-12)
-- ----------------------------------------------------------------------------
ALTER TABLE commerce_precos ADD COLUMN IF NOT EXISTS store_key TEXT;
ALTER TABLE commerce_precos DROP CONSTRAINT IF EXISTS commerce_precos_store_key_ck;
ALTER TABLE commerce_precos ADD CONSTRAINT commerce_precos_store_key_ck
  CHECK (store_key IS NULL OR store_key IN ('RETAIL', 'WHOLESALE'));

-- A unicidade passa a considerar a LOJA. COALESCE(store_key,'') preserva a
-- chave antiga para as linhas legadas (NULL = ""), então nenhuma linha existente
-- é invalidada nem reatribuída a uma loja que não é dela.
-- A constraint antiga (0068) vira um índice único standalone que inclui a loja.
ALTER TABLE commerce_precos DROP CONSTRAINT IF EXISTS uq_commerce_precos;
ALTER TABLE commerce_precos DROP CONSTRAINT IF EXISTS uq_commerce_precos_empresa_produto_canal;
DROP INDEX IF EXISTS uq_commerce_precos;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_precos
  ON commerce_precos (empresa_id, produto_id, canal, COALESCE(store_key, ''));
CREATE INDEX IF NOT EXISTS ix_commerce_precos_store
  ON commerce_precos (empresa_id, store_key, canal) WHERE store_key IS NOT NULL;
