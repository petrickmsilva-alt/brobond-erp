-- 0066 — snapshot histórico da conversão usada em cada item de cotação.
-- Quantidade cotada fica na unidade de compra; origem/fator/caminho ficam congelados.
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS quantidade_original NUMERIC(14,3);
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_original TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_origem TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_fator NUMERIC(18,9);
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_status TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_snapshot JSONB;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE cotacao_compra_itens ADD CONSTRAINT cotacao_compra_conversao_status_valido
    CHECK (unidade_conversao_status IS NULL OR unidade_conversao_status IN ('IDENTICA','CONVERTIDA','NAO_CONVERTIDA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN cotacao_compra_itens.unidade_conversao_snapshot IS 'Regra(s) declarada(s) e caminho exatos usados no instante de inclusão; não recalcular itens históricos quando o cadastro mudar.';
COMMENT ON COLUMN cotacao_compra_itens.quantidade IS 'Quantidade convertida e cotada na unidade de compra registrada em unidade.';

ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS quantidade_original NUMERIC(14,3);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_original TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_origem TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_fator NUMERIC(18,9);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_status TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_snapshot JSONB;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_conversao_status_valido
    CHECK (unidade_conversao_status IS NULL OR unidade_conversao_status IN ('IDENTICA','CONVERTIDA','NAO_CONVERTIDA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN itens_compra.unidade_conversao_snapshot IS 'Cópia do snapshot de conversão herdado do item de cotação; não recalcular compras históricas.';
