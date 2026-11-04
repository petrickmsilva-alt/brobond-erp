-- 0097 — R-14 (Fase 4.3): associação empresarial de webhooks de saída.
-- Aditiva e não destrutiva:
--   • empresa_id NULL = webhook/entrega GLOBAL (sem empresa). Não há NOT NULL.
--   • NENHUM backfill: vínculos históricos não são inferidos (payload, URL ou nome).
--     Webhooks e entregas existentes ficam com empresa_id NULL até associação
--     explícita e auditada (procedimento em docs/auditoria/fase-4-3-registro.md, R-14).
--   • Eventos de empresa só são entregues a webhooks da mesma empresa; eventos
--     globais só a webhooks globais (ver server/src/webhooks.ts › alvosDoEvento).
-- Rollback: docs/auditoria/fase-4-3-registro.md (R-14). Esta pasta não contém script de descida.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS empresa_id INTEGER NULL REFERENCES empresas(id);
ALTER TABLE webhook_entregas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NULL REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS idx_webhooks_empresa ON webhooks (empresa_id);
CREATE INDEX IF NOT EXISTS idx_webhook_entregas_empresa ON webhook_entregas (empresa_id, id DESC);
