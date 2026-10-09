-- ============================================================================
-- 0027 — FASE E3: compras — cotação de fornecedor e custo de recebimento
--
-- Ataca GAP-COMP-COTACOES (crítico) e dá suporte a GAP-COMP-CUSTOS
-- (docs/ERP-GAPS.md).
--
-- DOMÍNIO — não confundir com o que já existe:
--   • `cotacao_decisoes` (schema.sql:1139) é do PORTAL DO CLIENTE: tem
--     `venda_id NOT NULL REFERENCES vendas(id)` e registra a decisão do cliente
--     sobre uma cotação de VENDA. Não tem nada a ver com fornecedor.
--   • As tabelas desta migration são de COMPRA: vários fornecedores cotando o
--     mesmo carrinho de insumos/produtos, e o comprador escolhendo por item.
--
-- Blocos:
--   A) cotacoes_compra               — o processo de cotação
--   B) cotacao_compra_itens          — o que está sendo cotado (carrinho)
--   C) cotacao_compra_fornecedores   — quem foi convidado a cotar
--   D) cotacao_compra_precos         — a resposta de cada fornecedor por item
--   E) custo de recebimento          — rateio de frete no item da compra
--
-- Aditiva e reversível: nenhuma tabela existente é renomeada, nenhuma coluna é
-- removida, nenhum CHECK existente é enfraquecido.
--
-- Idempotente: pode ser aplicada duas vezes, em banco limpo e em banco migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) COTAÇÃO DE COMPRA
--
-- Fluxo: RASCUNHO → COTANDO → DECIDIDA   (+ CANCELADA)
--
-- `compra_id` é o pedido de compra gerado pela decisão. É UNIQUE de propósito:
-- é o que torna a geração do pedido IDEMPOTENTE no banco, e não só na aplicação.
-- Duas decisões simultâneas da mesma cotação não conseguem criar dois pedidos —
-- a segunda estoura no índice único.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacoes_compra (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  titulo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho',
  prazo_validade DATE,
  previsao_compra DATE,
  observacoes TEXT,
  -- Decisão
  decidida_em TIMESTAMPTZ,
  decidida_por INTEGER REFERENCES usuarios(id),
  compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
  criterio TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cotacoes_compra_empresa_idx ON cotacoes_compra (empresa_id, status);
CREATE INDEX IF NOT EXISTS cotacoes_compra_previsao_idx ON cotacoes_compra (empresa_id, previsao_compra);

-- Um pedido de compra por cotação. UNIQUE = idempotência garantida no banco.
CREATE UNIQUE INDEX IF NOT EXISTS cotacoes_compra_compra_uniq
  ON cotacoes_compra (compra_id) WHERE compra_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacoes_compra_status_valido CHECK (
    status IN ('rascunho', 'cotando', 'decidida', 'cancelada')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O critério de escolha precisa ser declarável, senão a decisão vira arbitrária.
DO $$ BEGIN
  ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacoes_compra_criterio_valido CHECK (
    criterio IS NULL OR criterio IN ('menor_preco', 'menor_preco_total', 'prazo', 'qualidade')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- B) ITENS DA COTAÇÃO (o carrinho que os fornecedores vão orçar)
--
-- Mesma regra de `itens_compra`: ou insumo, ou produto. A escolha por item fica
-- em `escolhido_*`, preenchida na decisão.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes_compra(id) ON DELETE CASCADE,
  insumo_id INTEGER REFERENCES insumos(id),
  produto_id INTEGER REFERENCES produtos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  unidade TEXT,
  -- Preenchidos na decisão: quem ganhou este item e por quanto.
  escolhido_fornecedor_id INTEGER REFERENCES fornecedores(id),
  escolhido_preco NUMERIC(12,2),
  CONSTRAINT cotacao_compra_itens_origem_check CHECK (insumo_id IS NOT NULL OR produto_id IS NOT NULL),
  CONSTRAINT cotacao_compra_itens_qtd_positiva CHECK (quantidade > 0)
);

CREATE INDEX IF NOT EXISTS cotacao_compra_itens_idx ON cotacao_compra_itens (cotacao_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_itens_empresa_idx ON cotacao_compra_itens (empresa_id);

-- ----------------------------------------------------------------------------
-- C) FORNECEDORES CONVIDADOS
--
-- UNIQUE (cotacao, fornecedor): convidar o mesmo fornecedor duas vezes para a
-- mesma cotação é erro, não duas cotações paralelas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_fornecedores (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes_compra(id) ON DELETE CASCADE,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  status TEXT NOT NULL DEFAULT 'convidado',
  convidado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  respondeu_em TIMESTAMPTZ,
  prazo_entrega_dias INTEGER,
  condicao_pagamento TEXT,
  frete NUMERIC(12,2) DEFAULT 0,
  validade_proposta DATE,
  observacoes TEXT,
  CONSTRAINT cotacao_compra_fornecedores_qtd CHECK (prazo_entrega_dias IS NULL OR prazo_entrega_dias >= 0),
  CONSTRAINT cotacao_compra_fornecedores_frete CHECK (frete >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cotacao_compra_fornecedores_uniq
  ON cotacao_compra_fornecedores (cotacao_id, fornecedor_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_fornecedores_empresa_idx
  ON cotacao_compra_fornecedores (empresa_id);

DO $$ BEGIN
  ALTER TABLE cotacao_compra_fornecedores ADD CONSTRAINT cotacao_compra_fornecedores_status_valido CHECK (
    status IN ('convidado', 'cotado', 'recusado')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- D) PREÇOS POR FORNECEDOR × ITEM
--
-- É aqui que mora a comparação. UNIQUE (convite, item): um fornecedor não pode
-- mandar dois preços para o mesmo item — se mudar de ideia, EDITA.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_precos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  convite_id INTEGER NOT NULL REFERENCES cotacao_compra_fornecedores(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES cotacao_compra_itens(id) ON DELETE CASCADE,
  preco_unitario NUMERIC(12,2) NOT NULL,
  prazo_entrega_dias INTEGER,
  disponivel BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT cotacao_compra_precos_preco_positivo CHECK (preco_unitario >= 0),
  CONSTRAINT cotacao_compra_precos_prazo CHECK (prazo_entrega_dias IS NULL OR prazo_entrega_dias >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cotacao_compra_precos_uniq
  ON cotacao_compra_precos (convite_id, item_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_precos_empresa_idx ON cotacao_compra_precos (empresa_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_precos_item_idx ON cotacao_compra_precos (item_id);

-- ----------------------------------------------------------------------------
-- E) CUSTO DE RECEBIMENTO — rateio de frete
--
-- `itens_compra` ganha o custo de aquisição rateado. Ele existe porque o custo
-- médio do insumo NÃO pode ser calculado só com `preco_unitario`: frete e
-- imposto fazem parte do que a empresa pagou para ter o insumo na porta.
--
-- Coluna nova, `DEFAULT 0`, aditiva: nada que já existe muda de valor. O rateio
-- passa a ser escrito pelo recebimento (server/src/compras.ts), não por esta
-- migration — aqui só existe o lugar para guardá-lo.
-- ----------------------------------------------------------------------------
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS custo_frete_rateado NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS custo_impostos NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_custos_positivos CHECK (
    custo_frete_rateado >= 0 AND custo_impostos >= 0
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auditar repasse de custo é auditar dinheiro: sem índice, a trilha por compra
-- vira varredura de tabela inteira assim que houver histórico.
CREATE INDEX IF NOT EXISTS itens_compra_custo_idx ON itens_compra (compra_id, insumo_id);
