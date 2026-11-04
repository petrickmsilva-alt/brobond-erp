-- 0099 — estado UNKNOWN/INDETERMINADO para entrega cujo provedor pode ter
-- aceitado sem a aplicação ter persistido a confirmação.
-- Não reenvia automaticamente. Rollback (manutenção autorizada):
--   BEGIN;
--   UPDATE commerce_outbox SET estado = 'ERRO' WHERE estado = 'INDETERMINADO';
--   UPDATE cron_work_items SET state = 'FAILED' WHERE state = 'UNKNOWN';
--   ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
--   ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
--     CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO'));
--   ALTER TABLE cron_work_items DROP CONSTRAINT IF EXISTS cron_work_items_state_check;
--   ALTER TABLE cron_work_items ADD CONSTRAINT cron_work_items_state_check
--     CHECK (state IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYABLE','ABANDONED'));
--   DELETE FROM schema_migrations WHERE id = '0099_cron_unknown_outbox.sql';
--   COMMIT;
ALTER TABLE cron_work_items DROP CONSTRAINT IF EXISTS cron_work_items_state_check;
ALTER TABLE cron_work_items ADD CONSTRAINT cron_work_items_state_check
  CHECK (state IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYABLE','ABANDONED','UNKNOWN'));

ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
  CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO', 'INDETERMINADO'));
