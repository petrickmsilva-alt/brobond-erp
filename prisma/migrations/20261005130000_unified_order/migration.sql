-- Unified Order aggregate: tenant boundary and idempotency.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tenant_id uuid DEFAULT gen_random_uuid();
UPDATE sales SET tenant_id = gen_random_uuid() WHERE tenant_id IS NULL;
ALTER TABLE sales ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS tenant_id uuid DEFAULT gen_random_uuid();
UPDATE sale_items SET tenant_id = gen_random_uuid() WHERE tenant_id IS NULL;
ALTER TABLE sale_items ALTER COLUMN tenant_id SET NOT NULL;
-- Existing rows are assigned by the deployment operator before enforcing NOT NULL.
CREATE INDEX IF NOT EXISTS sales_tenant_channel_idx ON sales (tenant_id, channel);
CREATE UNIQUE INDEX IF NOT EXISTS sales_channel_external_id_key ON sales (channel, external_order_id) WHERE external_order_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_audit_chain (
  id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, sale_id text NOT NULL,
  previous_hash text NOT NULL, event_hash text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
