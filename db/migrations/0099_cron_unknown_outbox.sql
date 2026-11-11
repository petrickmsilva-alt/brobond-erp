-- 0099 — estado UNKNOWN/INDETERMINADO para entrega cujo provedor pode ter
-- aceitado sem a aplicação ter persistido a confirmação.
-- Não reenvia automaticamente. Rollback (manutenção autorizada):
--   BEGIN;
--   UPDATE commerce_outbox SET estado = 'ERRO' WHERE estado IN ('INDETERMINADO','BLOQUEADO','OBSOLETO');
--   UPDATE cron_work_items SET state = 'FAILED' WHERE state = 'UNKNOWN';
--   ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
--   ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
--     CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO'));
--   ALTER TABLE cron_work_items DROP CONSTRAINT IF EXISTS cron_work_items_state_check;
--   ALTER TABLE cron_work_items ADD CONSTRAINT cron_work_items_state_check
--     CHECK (state IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYABLE','ABANDONED'));
--   DELETE FROM schema_migrations WHERE id = '0099_cron_unknown_outbox.sql';
--   COMMIT;
--
-- NÃO ESTREITAR (idempotência da cadeia): este DROP+ADD reexecuta sempre que a
-- cadeia é reaplicada (drift/recovery, ex.: o gate PROD-DB-01). Se o conjunto
-- aqui fosse MENOR que o estado terminal já em uso, o ADD falharia com
-- "check constraint ... is violated by some row" e degradaria o ERP — o mesmo
-- defeito que a 0094 documentou para `commerce_outbox_tipo_ck`. Por isso o
-- conjunto já inclui os estados terminais da 0116 (BLOQUEADO/OBSOLETO): uma
-- migração que reexecuta só pode AMPLIAR, nunca reduzir, os valores aceitos.
ALTER TABLE cron_work_items DROP CONSTRAINT IF EXISTS cron_work_items_state_check;
ALTER TABLE cron_work_items ADD CONSTRAINT cron_work_items_state_check
  CHECK (state IN ('PENDING','PROCESSING','COMPLETED','FAILED','RETRYABLE','ABANDONED','UNKNOWN'));

ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
  CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO', 'INDETERMINADO', 'BLOQUEADO', 'OBSOLETO'));
