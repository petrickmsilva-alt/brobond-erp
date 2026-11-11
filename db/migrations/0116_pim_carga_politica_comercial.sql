-- ============================================================================
-- 0116 — CARGA OFICIAL DA POLÍTICA COMERCIAL: IDENTIFICADORES DE ORIGEM
--
-- A planilha-base ("TABELA DE PREÇO BASE PARA ERP.xlsx") traz, além do SKU
-- canônico (`Código Industria`), dois identificadores de origem que o ERP
-- precisa PRESERVAR sem reinterpretar:
--   • `Item`           → número sequencial do item na origem;
--   • `Cód Categoria`  → código de categoria da origem (agrupa a família).
--
-- São TEXTO (nunca inteiro): preservam zeros à esquerda e códigos alfanuméricos
-- exatamente como vieram. `Código Industria` também é guardado em coluna
-- própria (é o `sku` canônico, mas separado para não se perder caso o SKU mude).
--
-- Aditiva e idempotente. Não cria tabela paralela de produtos/SKUs: tudo vive
-- no cadastro canônico `produtos`.
-- ============================================================================

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_item TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_categoria TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_industria TEXT;

CREATE INDEX IF NOT EXISTS produtos_codigo_industria_idx ON produtos (empresa_id, codigo_industria);
CREATE INDEX IF NOT EXISTS produtos_codigo_item_idx ON produtos (empresa_id, codigo_item);
