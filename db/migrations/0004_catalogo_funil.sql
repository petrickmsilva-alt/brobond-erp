-- Fase 2B: valor e pedido vinculados ao evento de conversão.
ALTER TABLE catalogo_eventos ADD COLUMN IF NOT EXISTS pedido_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL;
ALTER TABLE catalogo_eventos ADD COLUMN IF NOT EXISTS valor NUMERIC(12,2);
CREATE INDEX IF NOT EXISTS idx_catalogo_eventos_pedido ON catalogo_eventos(pedido_id) WHERE pedido_id IS NOT NULL;
