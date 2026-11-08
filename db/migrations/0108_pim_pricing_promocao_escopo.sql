-- ============================================================================
-- 0108 — PIM & PRICING: PROMOÇÃO COM ESCOPO, CANAL E PRECEDÊNCIA DETERMINÍSTICA
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A promoção automática (`commerce_promocoes`) hoje só sabe descontar sobre o
-- SUBTOTAL DO PEDIDO e escolher "a maior regra" — um único desconto global.
-- Isso impede três coisas que a operação já pede:
--
--   • ELEGIBILIDADE — "10% só nesta coleção", "R$ 20 só neste produto". Sem
--     escopo, a única saída era uma promoção de pedido inteiro, que desconta o
--     que não deveria.
--   • CANAL — a promoção de varejo não pode valer no atacado (e vice-versa).
--   • PRECEDÊNCIA DETERMINÍSTICA — duas promoções que produzem o MESMO desconto
--     hoje são resolvidas pela ordem de leitura do banco (indeterminada). Falta
--     um desempate explícito e estável (prioridade e, por fim, a mais recente).
--
-- ESTA MIGRAÇÃO É ADITIVA E OPT-IN. As colunas novas nascem com o comportamento
-- ATUAL: `escopo='pedido'`, `canal='todos'`, `prioridade=0`. Uma promoção criada
-- antes desta migração continua descontando sobre o pedido inteiro, como hoje —
-- nenhum número muda até o gestor configurar o escopo. A tabela de alvos nasce
-- vazia e só é consultada quando `escopo <> 'pedido'`.
--
-- REGRAS (não negociáveis)
--   • Multiempresa: alvos carregam `empresa_id`; nada cruza empresa.
--   • Preço NUNCA fica negativo: a regra pura limita o desconto ao subtotal
--     elegível (o backend recalcula; o banco só guarda a intenção).
--   • Promoção e cupom continuam NÃO acumulando — a maior regra vence.
--   • Alvo é ou PRODUTO ou CATEGORIA, nunca os dois nem nenhum.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) PROMOÇÃO — escopo, canal e prioridade
-- ----------------------------------------------------------------------------
ALTER TABLE commerce_promocoes ADD COLUMN IF NOT EXISTS escopo TEXT NOT NULL DEFAULT 'pedido';
ALTER TABLE commerce_promocoes ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'todos';
ALTER TABLE commerce_promocoes ADD COLUMN IF NOT EXISTS prioridade INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE commerce_promocoes ADD CONSTRAINT commerce_promocoes_escopo_ck
    CHECK (escopo IN ('pedido', 'produto', 'categoria'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE commerce_promocoes ADD CONSTRAINT commerce_promocoes_canal_ck
    CHECK (canal IN ('todos', 'varejo', 'atacado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Desempate determinístico: prioridade desc, depois id desc (a mais recente).
CREATE INDEX IF NOT EXISTS commerce_promocoes_precedencia_idx
  ON commerce_promocoes (empresa_id, ativo, prioridade DESC, id DESC);

COMMENT ON COLUMN commerce_promocoes.escopo IS 'pedido = desconto sobre o pedido inteiro; produto/categoria = só sobre o subtotal elegível (alvos).';
COMMENT ON COLUMN commerce_promocoes.canal IS 'todos = qualquer canal; varejo/atacado restringe a elegibilidade ao canal do cliente.';
COMMENT ON COLUMN commerce_promocoes.prioridade IS 'Desempate determinístico quando dois descontos empatam (maior prioridade vence; empate → a mais recente).';

-- ----------------------------------------------------------------------------
-- 2) ALVOS DA PROMOÇÃO — o que a promoção escopada alcança
--
-- Para escopo 'produto', a linha aponta um `produto_id`; para 'categoria', um
-- `categoria_id`. Exatamente um dos dois (CHECK). O item do carrinho é elegível
-- se o produto dele OU a categoria dele estiver na lista de alvos.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_promocao_alvos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  promocao_id INTEGER NOT NULL REFERENCES commerce_promocoes(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  categoria_id INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commerce_promocao_alvos_exclusivo_ck CHECK (
    (produto_id IS NOT NULL AND categoria_id IS NULL)
    OR (produto_id IS NULL AND categoria_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS commerce_promocao_alvos_promocao_idx
  ON commerce_promocao_alvos (empresa_id, promocao_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_promocao_alvo_produto
  ON commerce_promocao_alvos (promocao_id, produto_id) WHERE produto_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_promocao_alvo_categoria
  ON commerce_promocao_alvos (promocao_id, categoria_id) WHERE categoria_id IS NOT NULL;
