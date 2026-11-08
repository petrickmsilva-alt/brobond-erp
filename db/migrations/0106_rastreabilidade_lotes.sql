-- ============================================================================
-- 0106 — SUPPLY CHAIN: RASTREABILIDADE POR LOTE (ponta a ponta)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O ERP já vincula cada movimentação ao documento de origem por FK (compra,
-- recebimento, item da compra, ordem de fabricação, venda, devolução ao
-- fornecedor). O que NÃO existia era o LOTE: a identidade física do que entrou
-- (fornecedor + data de validade + fabricação), que é o que permite responder
-- "de onde veio esta peça?" e "para onde foi o lote X?".
--
-- Esta migração adiciona:
--   1) o cadastro de LOTES por empresa (produto OU insumo, código, validade,
--      fabricação e fornecedor de origem);
--   2) a coluna `lote_id` nas movimentações de produto e de insumo, no item do
--      recebimento de compra e no item da devolução ao fornecedor.
--
-- REGRAS (não negociáveis)
--   • NÃO cria saldo paralelo. O saldo do lote é DERIVADO das movimentações
--     (entrada soma, saída subtrai) — gravar saldo por lote seria uma segunda
--     fonte de verdade, exatamente o que o ERP proíbe.
--   • `lote_id` é OPCIONAL. Produto/insumo sem controle de lote continua
--     funcionando; a rastreabilidade apenas fica mais rica quando informado.
--   • Multiempresa: `lotes.empresa_id` NOT NULL e FK COMPOSTA
--     `(empresa_id, lote_id)` — um lote de outra empresa é recusado pelo banco.
--   • Nada é apagado: lote em uso é desativado, não excluído (o histórico de
--     movimentação aponta para ele).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CADASTRO DE LOTES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lotes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  produto_id INTEGER REFERENCES produtos(id),
  insumo_id INTEGER REFERENCES insumos(id),
  validade DATE,
  fabricacao DATE,
  -- Fornecedor que originou o lote (rastreabilidade da origem).
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  -- Um lote é de um produto OU de um insumo — nunca dos dois, nunca de nenhum.
  CONSTRAINT lotes_origem_check CHECK (
    (produto_id IS NOT NULL AND insumo_id IS NULL)
    OR (produto_id IS NULL AND insumo_id IS NOT NULL)
  ),
  CONSTRAINT lotes_codigo_obrigatorio CHECK (TRIM(COALESCE(codigo, '')) <> ''),
  CONSTRAINT lotes_validade_apos_fabricacao CHECK (
    validade IS NULL OR fabricacao IS NULL OR validade >= fabricacao
  )
);

-- O mesmo código de lote pode existir para produtos diferentes (lote do
-- fornecedor A para o produto X ≠ lote do fornecedor B para o produto Y), mas
-- NÃO se repete dentro do mesmo produto/insumo na empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lotes_empresa_codigo_produto
  ON lotes (empresa_id, codigo, produto_id) WHERE produto_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lotes_empresa_codigo_insumo
  ON lotes (empresa_id, codigo, insumo_id) WHERE insumo_id IS NOT NULL;
-- Alvo de FK composta por empresa (padrão E4.2 do ERP).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lotes_empresa_id ON lotes (empresa_id, id);
CREATE INDEX IF NOT EXISTS lotes_empresa_produto_idx ON lotes (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS lotes_empresa_insumo_idx ON lotes (empresa_id, insumo_id);
CREATE INDEX IF NOT EXISTS lotes_empresa_fornecedor_idx ON lotes (empresa_id, fornecedor_id);

-- ----------------------------------------------------------------------------
-- 2) VÍNCULO NAS MOVIMENTAÇÕES E NOS ITENS DE DOCUMENTO
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS lote_id INTEGER;
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS lote_id INTEGER;
ALTER TABLE compra_recebimento_itens ADD COLUMN IF NOT EXISTS lote_id INTEGER;
ALTER TABLE devolucao_fornecedor_itens ADD COLUMN IF NOT EXISTS lote_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_movimentacoes_lote ON movimentacoes (empresa_id, lote_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_insumos_lote ON movimentacoes_insumos (empresa_id, lote_id);
CREATE INDEX IF NOT EXISTS idx_recebimento_itens_lote ON compra_recebimento_itens (empresa_id, lote_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_fornecedor_itens_lote ON devolucao_fornecedor_itens (empresa_id, lote_id);

-- ----------------------------------------------------------------------------
-- 3) INTEGRIDADE COMPOSTA POR EMPRESA (o lote precisa ser do mesmo tenant)
-- ----------------------------------------------------------------------------
DO $lote_fks$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('movimentacoes', 'fk_lote_mov_empresa', 'FOREIGN KEY (empresa_id, lote_id) REFERENCES lotes (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_lote_mov_insumo_empresa', 'FOREIGN KEY (empresa_id, lote_id) REFERENCES lotes (empresa_id, id)'),
      ('compra_recebimento_itens', 'fk_lote_recebimento_item_empresa', 'FOREIGN KEY (empresa_id, lote_id) REFERENCES lotes (empresa_id, id)'),
      ('devolucao_fornecedor_itens', 'fk_lote_devolucao_item_empresa', 'FOREIGN KEY (empresa_id, lote_id) REFERENCES lotes (empresa_id, id)')
    ) AS v(tabela, nome, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.nome) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', fk.tabela, fk.nome, fk.ddl);
    END IF;
  END LOOP;
END $lote_fks$;

-- Valida o histórico já existente (nenhuma linha tinha `lote_id`, então a
-- validação é instantânea) e passa a proteger toda escrita nova.
ALTER TABLE movimentacoes VALIDATE CONSTRAINT fk_lote_mov_empresa;
ALTER TABLE movimentacoes_insumos VALIDATE CONSTRAINT fk_lote_mov_insumo_empresa;
ALTER TABLE compra_recebimento_itens VALIDATE CONSTRAINT fk_lote_recebimento_item_empresa;
ALTER TABLE devolucao_fornecedor_itens VALIDATE CONSTRAINT fk_lote_devolucao_item_empresa;

COMMENT ON TABLE lotes IS 'Lote físico (fornecedor + validade) por empresa. O saldo do lote é DERIVADO das movimentações — não há coluna de saldo.';
COMMENT ON COLUMN movimentacoes.lote_id IS 'Lote movimentado (opcional). FK composta por empresa; o saldo do lote é a soma das movimentações.';
