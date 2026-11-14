-- ============================================================================
-- 0122 — ETAPA 07: CREATOR_COMMANDS ACEITA AS CINCO ENTIDADES REAIS.
--
-- Achado: match/outreach já gravavam creator_commands.entity='match'/'outreach'
-- (creators.ts), mas o CHECK original da 0075 só admitia profile/campaign/
-- partnership. No store em memória o teste passava; no PostgreSQL real a
-- transação abortava depois de criar o registro. Este alinhamento é ADITIVO:
-- nenhum valor anterior deixa de ser aceito e nenhum dado é removido.
--
-- A 0075 foi alinhada para instalações novas; esta migração cobre bancos que já
-- aplicaram a versão anterior. Reaplicar é seguro (DROP IF EXISTS + ADD).
-- Rollback só após provar que não há linhas match/outreach:
--   ALTER TABLE creator_commands DROP CONSTRAINT creator_commands_entity_check;
--   ALTER TABLE creator_commands ADD CONSTRAINT creator_commands_entity_check
--     CHECK (entity IN ('profile','campaign','partnership'));
-- ============================================================================
ALTER TABLE creator_commands DROP CONSTRAINT IF EXISTS creator_commands_entity_check;
ALTER TABLE creator_commands ADD CONSTRAINT creator_commands_entity_check
  CHECK (entity IN ('profile', 'campaign', 'partnership', 'match', 'outreach'));
