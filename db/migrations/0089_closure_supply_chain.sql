-- Extend the existing quotation document into its requisition/approval phase.
ALTER TABLE cotacoes_compra ADD COLUMN IF NOT EXISTS requisicao_estado TEXT;
ALTER TABLE cotacoes_compra ADD COLUMN IF NOT EXISTS requisitada_por INTEGER REFERENCES usuarios(id);
ALTER TABLE cotacoes_compra ADD COLUMN IF NOT EXISTS requisicao_aprovada_por INTEGER REFERENCES usuarios(id);
ALTER TABLE cotacoes_compra ADD COLUMN IF NOT EXISTS requisicao_aprovada_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacao_requisicao_estado CHECK
  (requisicao_estado IS NULL OR requisicao_estado IN ('solicitada','aprovada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A reservation is a commitment on the official OP, NOT a second stock balance.
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS reservas_componentes JSONB;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS demanda_item_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_op_demanda_item ON ordens_fabricacao(empresa_id,demanda_item_id)
  WHERE demanda_item_id IS NOT NULL AND status <> 'cancelada';
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_venda_empresa_id ON itens_venda(empresa_id,id);
DO $$ BEGIN
  ALTER TABLE ordens_fabricacao ADD CONSTRAINT op_demanda_empresa_fk
  FOREIGN KEY(empresa_id,demanda_item_id) REFERENCES itens_venda(empresa_id,id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
