-- 0125 — PIM / FORMAÇÃO DE PREÇO: custos, tributos, margens e faixas de quantidade
--
-- A planilha-base contém os parâmetros unitários da política comercial:
-- custo de fabricação, alíquotas, margens por canal e fatores financeiros.
-- O ERP passa a recalcular os valores derivados no servidor e a guardar:
--   • entradas e resultados fiscais/custos em colunas tipadas de produtos;
--   • a memória completa da formação por linha de origem;
--   • preços finais por condição, fator financeiro, margem efetiva e quantidade mínima.
--
-- A regra de varejo "2 unidades" é uma faixa da condição VAREJO À VISTA,
-- não uma nova forma de pagamento. Por isso o preço por condição aceita
-- múltiplas faixas (quantidade_minima) para o mesmo produto/canal/condição.
--
-- Não altera nenhuma quantidade de estoques nem movimentacoes.
-- Aditiva e idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) MEMÓRIA DE FORMAÇÃO DO PRODUTO
-- ----------------------------------------------------------------------------
ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS custo_unitario_fabricacao NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS custo_aquisicao_unitario NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS simples_nacional_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS simples_nacional_valor NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS icms_planilha_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS icms2_planilha_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS icms_planilha_valor NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS icms2_planilha_valor NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS total_imposto_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS total_imposto_valor NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS custo_total_imposto NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS margem_atacado_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS margem_varejo_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS margem_varejo_2un_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS margem_varejo_cartao_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS margem_varejo_combo_cartao_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS memoria_formacao_preco JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE produtos DROP CONSTRAINT IF EXISTS produtos_memoria_formacao_preco_obj_ck;
ALTER TABLE produtos
  ADD CONSTRAINT produtos_memoria_formacao_preco_obj_ck
  CHECK (jsonb_typeof(memoria_formacao_preco) = 'object');

-- ----------------------------------------------------------------------------
-- 2) PREÇO POR CONDIÇÃO: política de quantidade e memória da fórmula
-- ----------------------------------------------------------------------------
ALTER TABLE produto_precos_condicao
  ADD COLUMN IF NOT EXISTS quantidade_minima INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS margem_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS ajuste_pct NUMERIC(8,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS regra_calculo JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE produto_precos_condicao DROP CONSTRAINT IF EXISTS produto_precos_condicao_quantidade_minima_ck;
ALTER TABLE produto_precos_condicao
  ADD CONSTRAINT produto_precos_condicao_quantidade_minima_ck CHECK (quantidade_minima >= 1);

ALTER TABLE produto_precos_condicao DROP CONSTRAINT IF EXISTS produto_precos_condicao_regra_calculo_obj_ck;
ALTER TABLE produto_precos_condicao
  ADD CONSTRAINT produto_precos_condicao_regra_calculo_obj_ck
  CHECK (jsonb_typeof(regra_calculo) = 'object');

-- Uma linha vigente por (produto, canal, condição, faixa de quantidade).
-- Mantém compatibilidade para todas as linhas antigas (quantidade_minima = 1).
DROP INDEX IF EXISTS uq_produto_precos_condicao_vigente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_precos_condicao_vigente
  ON produto_precos_condicao (empresa_id, produto_id, canal, condicao, quantidade_minima)
  WHERE vigencia_fim IS NULL;

-- O histórico conserva também a faixa e a memória dos cálculos anteriores.
ALTER TABLE produto_precos_condicao_historico
  ADD COLUMN IF NOT EXISTS quantidade_minima INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS margem_pct NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS ajuste_pct NUMERIC(8,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS regra_calculo JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE produto_precos_condicao_historico DROP CONSTRAINT IF EXISTS produto_precos_condicao_historico_quantidade_minima_ck;
ALTER TABLE produto_precos_condicao_historico
  ADD CONSTRAINT produto_precos_condicao_historico_quantidade_minima_ck CHECK (quantidade_minima >= 1);

ALTER TABLE produto_precos_condicao_historico DROP CONSTRAINT IF EXISTS produto_precos_condicao_historico_regra_calculo_obj_ck;
ALTER TABLE produto_precos_condicao_historico
  ADD CONSTRAINT produto_precos_condicao_historico_regra_calculo_obj_ck
  CHECK (jsonb_typeof(regra_calculo) = 'object');

CREATE INDEX IF NOT EXISTS produto_precos_condicao_faixa_idx
  ON produto_precos_condicao (empresa_id, produto_id, canal, condicao, quantidade_minima)
  WHERE vigencia_fim IS NULL;

COMMENT ON COLUMN produtos.custo_unitario_fabricacao IS 'Custo unitário sem tributos informado na planilha-base.';
COMMENT ON COLUMN produtos.simples_nacional_pct IS 'Alíquota percentual do Simples Nacional usada na formação do custo.';
COMMENT ON COLUMN produtos.icms_planilha_pct IS 'Alíquota percentual ICMS da planilha-base.';
COMMENT ON COLUMN produtos.icms2_planilha_pct IS 'Alíquota percentual ICMS2 da planilha-base.';
COMMENT ON COLUMN produtos.total_imposto_pct IS 'Soma das alíquotas de tributos consideradas na formação do custo.';
COMMENT ON COLUMN produtos.custo_total_imposto IS 'Custo de fabricação acrescido dos tributos calculados pelo ERP.';
COMMENT ON COLUMN produtos.margem_atacado_pct IS 'Margem bruta-alvo do atacado, em percentual.';
COMMENT ON COLUMN produtos.margem_varejo_pct IS 'Margem bruta-alvo do varejo à vista, em percentual.';
COMMENT ON COLUMN produtos.margem_varejo_2un_pct IS 'Margem efetiva da faixa varejo à vista a partir de duas unidades.';
COMMENT ON COLUMN produtos.memoria_formacao_preco IS 'Memória auditável dos insumos, fórmulas, resultados e conferências da planilha-base.';
COMMENT ON COLUMN produto_precos_condicao.quantidade_minima IS 'Quantidade mínima do pedido para esta faixa de preço.';
COMMENT ON COLUMN produto_precos_condicao.margem_pct IS 'Margem bruta efetiva calculada pelo ERP para esta condição.';
COMMENT ON COLUMN produto_precos_condicao.ajuste_pct IS 'Acréscimo financeiro percentual aplicado à base do canal; negativo quando é desconto.';
COMMENT ON COLUMN produto_precos_condicao.regra_calculo IS 'Memória JSON da fórmula e dos parâmetros usados pelo ERP para calcular o preço.';
