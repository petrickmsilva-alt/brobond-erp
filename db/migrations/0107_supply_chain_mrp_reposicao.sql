-- ============================================================================
-- 0107 — SUPPLY CHAIN: MRP EVOLUÍDO / REPOSIÇÃO (lead time, lote mínimo,
--         múltiplo de compra e estoque de segurança)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A sugestão de compra já existe (`compras.ts` → `sugerirQuantidade`), mas o
-- cálculo só olhava estoque atual, mínimo, máximo, consumo e trânsito. Faltavam
-- os parâmetros que a operação realmente usa para repor:
--
--   • ESTOQUE DE SEGURANÇA — o colchão que não se toca (mínimo é alerta;
--     segurança é piso de reposição). Sem ele, o mínimo e a segurança eram o
--     mesmo número e a reposição oscilava em torno do alerta.
--   • LOTE MÍNIMO e MÚLTIPLO DE COMPRA — o fornecedor vende em caixa fechada:
--     a quantidade sugerida precisa ser arredondada para cima no múltiplo e
--     nunca menor que o lote mínimo. Sem isso a sugestão pedia 7 peças quando o
--     fornecedor só despacha 10.
--   • LEAD TIME DO PRODUTO — o prazo de entrega do fornecedor principal, para a
--     data de necessidade e o ponto de pedido. Antes o lead time só existia para
--     INSUMO (derivado de `fornecedores.prazo_entrega_dias`); o produto não tinha
--     de onde tirá-lo.
--
-- ESTA MIGRAÇÃO SÓ ADICIONA COLUNAS ADITIVAS em `produtos`. Nenhum dado é
-- apagado, nenhuma coluna é alterada de tipo. Os parâmetros nascem NEUTROS
-- (0/1/1/NULL): a sugestão de hoje continua dando o MESMO número até que o
-- gestor configure os novos parâmetros — a evolução é opt-in, nunca um "big bang".
--
-- REGRAS (não negociáveis)
--   • Multiempresa: `produtos` já é tenantada; nada aqui cruza empresa.
--   • O parâmetro é CADASTRO, não saldo: não existe segunda fonte de verdade de
--     estoque. Estoque de segurança e mínimo são números de POLÍTICA.
--   • CHECKs garantem invariantes de faixa (não-negativo; máximo ≥ mínimo já é
--     garantido por `produtos_estoque_faixa`).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) PRODUTO — parâmetros de reposição
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_seguranca INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lote_minimo_compra INTEGER NOT NULL DEFAULT 1;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS multiplo_compra INTEGER NOT NULL DEFAULT 1;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lead_time_dias INTEGER;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_estoque_seguranca_nao_negativo
    CHECK (estoque_seguranca >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_lote_minimo_positivo
    CHECK (lote_minimo_compra >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_multiplo_positivo
    CHECK (multiplo_compra >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_lead_time_nao_negativo
    CHECK (lead_time_dias IS NULL OR lead_time_dias >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN produtos.estoque_seguranca IS 'Colchão de reposição (piso). O mínimo é alerta; a segurança é o piso que a sugestão de compra usa para repor.';
COMMENT ON COLUMN produtos.lote_minimo_compra IS 'Menor quantidade que o fornecedor despacha. A sugestão nunca fica abaixo disso.';
COMMENT ON COLUMN produtos.multiplo_compra IS 'A sugestão é arredondada para cima neste múltiplo (caixa fechada).';
COMMENT ON COLUMN produtos.lead_time_dias IS 'Prazo de entrega em dias do fornecedor principal, quando não herdado de `fornecedores.prazo_entrega_dias`.';
