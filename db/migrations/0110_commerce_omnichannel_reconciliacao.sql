-- ============================================================================
-- 0110 — COMMERCE & OMNICHANNEL: RECONCILIAÇÃO MULTICANAL UNIFICADA
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A Fase 5 entregou reconciliação ERP × loja para o canal WooCommerce
-- multi-loja (`woocommerce_reconciliacao_divergencias`, migração 0101). O
-- mesmo problema — "o que o ERP diz" ≠ "o que o canal mostra" — existe em
-- TODOS os canais (Mercado Livre, Nuvemshop, Instagram Shopping, WooCommerce
-- RETAIL/WHOLESALE) e nas dimensões que o ERP controla: catálogo publicado,
-- preço, estoque e pedidos. Hoje cada canal tem o seu próprio recorte e não
-- há uma trilha ÚNICA que responda "quais divergências existem agora, em
-- qualquer canal, por empresa, com gravidade e ação recomendada?".
--
-- Esta migração cria essa trilha única. Ela NÃO substitui nem reescreve a
-- reconciliação WooCommerce (0101) — ela a COMPLEMENTA e é o lugar onde os
-- demais canais passam a registrar divergência. As duas convivem: a 0101
-- continua sendo a autoridade do detalhe por loja WooCommerce; esta tabela é
-- a visão multicanal com classificação, severidade e ação recomendada.
--
-- ESTA MIGRAÇÃO É ADITIVA E IDEMPOTENTE. Não altera nenhuma tabela existente,
-- não toca `produtos`, `commerce_precos`, `commerce_publicacoes`,
-- `commerce_pedidos`, `sales` nem `vendas`. A autoridade canônica continua
-- sendo o ERP: a tabela é PROVA da divergência, nunca fonte de verdade.
--
-- REGRAS (não negociáveis)
--   • Multiempresa: `empresa_id` NOT NULL; nada cruza empresa.
--   • Identidade lógica por `fingerprint` (UNIQUE por empresa): a MESMA
--     divergência reabre quando volta a existir, em vez de empilhar linhas.
--   • Nenhuma sobrescrita automática de dado canônico do ERP. A correção
--     automática (quando existir) é explícita, idempotente e auditada; a
--     classificação AUTOMATICA diz que a correção é SEGURA, não que ela foi
--     feita.
--   • `canal` usa o MESMO vocabulário de `commerce_publicacoes` — não existe
--     canal novo aqui sem justificativa de negócio e migração própria.
-- ============================================================================

CREATE TABLE IF NOT EXISTS commerce_reconciliacao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_reconciliacao_canal_ck CHECK (canal IN (
    'BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO'
  )),
  -- RETAIL/WHOLESALE no WooCommerce multi-loja; NULL quando o canal não tem
  -- lojas separadas.
  store_key TEXT,
  CONSTRAINT commerce_reconciliacao_store_key_ck
    CHECK (store_key IS NULL OR store_key IN ('RETAIL', 'WHOLESALE')),
  categoria TEXT NOT NULL,
  CONSTRAINT commerce_reconciliacao_categoria_ck CHECK (categoria IN (
    'CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS', 'CONECTOR'
  )),
  tipo TEXT NOT NULL,
  -- Destino da divergência (nunca o contrário):
  --   LEGITIMA   — diferença esperada; informativa, não corrige;
  --   AUTOMATICA — corrigível com segurança pelo ERP (idempotente/auditável);
  --   HUMANA     — exige decisão de gente.
  classificacao TEXT NOT NULL,
  CONSTRAINT commerce_reconciliacao_classificacao_ck
    CHECK (classificacao IN ('LEGITIMA', 'AUTOMATICA', 'HUMANA')),
  severidade TEXT NOT NULL DEFAULT 'media',
  CONSTRAINT commerce_reconciliacao_severidade_ck
    CHECK (severidade IN ('baixa', 'media', 'alta', 'critica')),
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  sku TEXT,
  referencia TEXT,
  detalhe TEXT NOT NULL,
  acao_recomendada TEXT,
  dados JSONB,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTA',
  CONSTRAINT commerce_reconciliacao_status_ck
    CHECK (status IN ('ABERTA', 'CORRIGIDA', 'IGNORADA')),
  resolucao TEXT,
  detectada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identidade lógica: a mesma ocorrência não empilha; reabre.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_reconciliacao_fingerprint
  ON commerce_reconciliacao (empresa_id, fingerprint);

-- Painel operacional por canal/status (recorte mais comum).
CREATE INDEX IF NOT EXISTS commerce_reconciliacao_painel_idx
  ON commerce_reconciliacao (empresa_id, canal, status, detectada_em DESC);

-- Contagem por categoria (cards do painel).
CREATE INDEX IF NOT EXISTS commerce_reconciliacao_categoria_idx
  ON commerce_reconciliacao (empresa_id, categoria, status);

-- Recorte por loja (WooCommerce multi-loja).
CREATE INDEX IF NOT EXISTS commerce_reconciliacao_store_idx
  ON commerce_reconciliacao (empresa_id, store_key, status)
  WHERE store_key IS NOT NULL;

-- Recorte por produto (detalhe do produto mostra suas divergências).
CREATE INDEX IF NOT EXISTS commerce_reconciliacao_produto_idx
  ON commerce_reconciliacao (empresa_id, produto_id)
  WHERE produto_id IS NOT NULL;
