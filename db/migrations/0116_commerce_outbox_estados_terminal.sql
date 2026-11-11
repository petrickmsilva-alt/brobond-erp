-- ============================================================================
-- 0116 — COMMERCE OUTBOX: ESTADOS TERMINAIS HONESTOS (BLOQUEADO / OBSOLETO)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O painel `/commerce/omnichannel` agrupa como `outbox_erro` (falha técnica
-- definitiva) TODA linha de `commerce_outbox` em estado ERRO. Isso mistura três
-- situações OPERACIONALMENTE DIFERENTES numa só categoria:
--
--   • FALHA TÉCNICA (ERRO)         — a integração quebrou de verdade; reprocessar
--                                    depois de corrigir a causa é o caminho.
--   • PENDÊNCIA DE CONFIGURAÇÃO     — o canal de comunicação (SMTP/WhatsApp) NÃO
--     (BLOQUEADO)                     está configurado. Repetir 10 vezes não cria
--                                    um provedor: o retry é INÚTIL e só produz um
--                                    ERRO enganoso ("falha de sincronização após
--                                    10 tentativas") que não é falha nenhuma.
--   • OBSOLETO                      — o evento pertencia a um canal DESCONTINUADO
--     (OBSOLETO)                      (vitrine nativa, ADR-0007) e não tem mais
--                                    finalidade. Reenviar seria mentir.
--
-- Sem esses dois estados, uma empresa que ainda não configurou SMTP/WhatsApp vê
-- um painel com "18 divergências abertas de severidade alta" que na verdade são
-- apenas configuração pendente. A honestidade do painel exige separar as três.
--
-- REGRAS (não negociáveis)
--   • ADITIVA e IDEMPOTENTE: nenhum DROP de dado/coluna; o CHECK apenas ACRESCENTA
--     valores (nenhuma linha existente passa a ser inválida).
--   • NÃO altera o significado de PENDENTE/PROCESSANDO/PROCESSADO/ERRO/INDETERMINADO.
--   • O encerramento por obsolescência é AUDITADO (motivo, data, responsável) e
--     NUNCA automático sobre evento financeiro com efeito pendente — a decisão
--     vive em `server/src/commerce/outbox.ts` (`encerrarEventosObsoletos`).
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   UPDATE commerce_outbox SET estado = 'ERRO' WHERE estado IN ('BLOQUEADO','OBSOLETO');
--   ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
--   ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
--     CHECK (estado IN ('PENDENTE','PROCESSANDO','PROCESSADO','ERRO','INDETERMINADO'));
--   ALTER TABLE commerce_outbox DROP COLUMN IF EXISTS motivo_encerramento;
--   ALTER TABLE commerce_outbox DROP COLUMN IF EXISTS encerrado_em;
--   ALTER TABLE commerce_outbox DROP COLUMN IF EXISTS encerrado_por;
--   DROP INDEX IF EXISTS ix_commerce_outbox_encerrados;
--   DELETE FROM schema_migrations WHERE id = '0116_commerce_outbox_estados_terminal.sql';
--   COMMIT;
-- ============================================================================

-- Trilha do encerramento por obsolescência (motivo, data e responsável técnico).
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS motivo_encerramento TEXT;
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS encerrado_em TIMESTAMPTZ;
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS encerrado_por TEXT;

-- Estados terminais: o CHECK só ACRESCENTA valores (nunca remove) — nenhuma
-- linha existente fica inválida.
ALTER TABLE commerce_outbox DROP CONSTRAINT IF EXISTS commerce_outbox_estado_ck;
ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_estado_ck
  CHECK (estado IN (
    'PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO', 'INDETERMINADO',
    'BLOQUEADO', 'OBSOLETO'
  ));

-- Leitura operacional dos encerrados (histórico com justificativa).
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_encerrados
  ON commerce_outbox (empresa_id, estado, encerrado_em DESC)
  WHERE estado IN ('BLOQUEADO', 'OBSOLETO');
