-- ============================================================================
-- 0034 — GOLIVE-03: PONTE MARKETPLACE → VENDA OPERACIONAL
--
-- Até aqui a ingestão de marketplaces escrevia SOMENTE `sales`/`sale_items`
-- (registro ANALÍTICO). Esta migration abre o caminho para a venda de
-- marketplace entrar no fluxo OPERACIONAL canônico do ERP
-- (`vendas`/`itens_venda`), sem criar um segundo motor de vendas.
--
-- Identidade operacional do pedido externo: (empresa_id, canal, pedido_externo_id).
-- A MESMA ordem externa, processada N vezes ou concorrentemente, produz UMA
-- venda operacional — a unicidade é a garantia do banco, não um `if (!exists)`.
--
-- A venda de marketplace é operacionalmente indistinguível das demais, exceto
-- por `canal_venda = 'marketplace'` e pelos metadados do pedido externo abaixo.
--
-- `sales` ganha o vínculo de volta com a venda operacional e os dados do
-- comprador (preservados pela ingestão para a resolução determinística de
-- cliente). Idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Venda operacional: rastro do pedido externo de origem
-- ----------------------------------------------------------------------------
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_externo_canal TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_externo_id TEXT;

-- Idempotência/concorrência da conversão: UMA venda operacional por
-- (empresa, canal, pedido externo). Vendas que não vêm de marketplace ficam
-- com `pedido_externo_id` NULL e FORA da unicidade (no Postgres NULLs são
-- distintos) — o índice parcial não toca o fluxo existente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_pedido_externo
  ON vendas (empresa_id, pedido_externo_canal, pedido_externo_id)
  WHERE pedido_externo_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) `sales`: vínculo com a venda operacional + comprador
-- ----------------------------------------------------------------------------
-- `operational_venda_id` aponta para a venda operacional gerada a partir desta
-- ordem — é o rastro de auditoria que liga o registro analítico à venda. A
-- projeção `vendas → sales` (ADR-001) identifica a venda já representada por
-- `vendas.pedido_externo_id` (não por este vínculo) e não cria uma segunda linha.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS operational_venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL;

-- Comprador do pedido externo — preservado pela ingestão para resolver o
-- cliente do ERP de forma determinística (e-mail → nome → criação), sem
-- duplicar cliente em retries.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS buyer_email TEXT;

CREATE INDEX IF NOT EXISTS sales_operational_venda_idx
  ON sales (operational_venda_id)
  WHERE operational_venda_id IS NOT NULL;
