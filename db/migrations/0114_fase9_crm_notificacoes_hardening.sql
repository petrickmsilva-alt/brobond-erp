-- ============================================================================
-- FASE 9.2 (hardening) — INTEGRIDADE E RETENÇÃO DA CAIXA INTERNA DO CRM
--
-- Revisão corretiva da caixa de notificações internas criada pela 0113. Três
-- endurecimentos, todos ADITIVOS e IDEMPOTENTES (nenhum DROP de dado/coluna):
--
--   1) RETENÇÃO. A FK `usuario_id` era `ON DELETE CASCADE`: apagar um usuário
--      APAGAVA a trilha de notificações dele. A trilha é histórico de auditoria
--      do aviso (quem foi avisado, quando, sobre qual atividade) — nunca se
--      apaga histórico para simplificar o fluxo. Passa a `ON DELETE SET NULL`:
--      o aviso sobrevive, sem destinatário.
--
--   2) INTEGRIDADE MULTIEMPRESA. A FK de `atividade_id` era SIMPLES
--      (`→ crm_atividades(id)`): um SQL manual poderia apontar um aviso da
--      empresa A para uma atividade da empresa B. Acrescenta-se a FK COMPOSTA
--      `(empresa_id, atividade_id) → crm_atividades(empresa_id, id)`, no mesmo
--      padrão E4.2 da migração 0104 — a atividade precisa ser do MESMO tenant.
--      `NOT VALID` + `VALIDATE`: protege toda escrita nova e confere o legado
--      (se houver linha cross-tenant, a migração FALHA em voz alta).
--
--      O destinatário (`usuario_id`) NÃO recebe FK composta para `usuarios`:
--      `usuarios` não tem `(empresa_id, id)` único e um usuário pode ter acesso
--      a VÁRIAS empresas (`usuario_empresas`) — uma FK composta a `usuarios`
--      proibiria um destinatário legítimo multiempresa. A garantia "o
--      destinatário pertence ao tenant do aviso" é aplicada na APLICAÇÃO
--      (`destinatarioDoTenant` em crmNotificacoes.ts), coberta por teste PG.
--
--   3) Suporte à FK composta: índice único `(empresa_id, id)` em crm_atividades
--      (alvo da FK). Não existia.
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   ALTER TABLE crm_notificacoes DROP CONSTRAINT IF EXISTS fk_e42_crm_notificacoes_empresa_atividade;
--   ALTER TABLE crm_notificacoes DROP CONSTRAINT IF EXISTS crm_notificacoes_usuario_id_fkey;
--   ALTER TABLE crm_notificacoes ADD CONSTRAINT crm_notificacoes_usuario_id_fkey
--     FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE;
--   DROP INDEX IF EXISTS uq_e42_crm_atividades_empresa_id;
--   DELETE FROM schema_migrations WHERE id = '0114_fase9_crm_notificacoes_hardening.sql';
--   COMMIT;
-- ============================================================================

-- 1) RETENÇÃO — a trilha do aviso sobrevive à remoção do destinatário.
ALTER TABLE crm_notificacoes ALTER COLUMN usuario_id DROP NOT NULL;
ALTER TABLE crm_notificacoes DROP CONSTRAINT IF EXISTS crm_notificacoes_usuario_id_fkey;
ALTER TABLE crm_notificacoes ADD CONSTRAINT crm_notificacoes_usuario_id_fkey
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;

-- 2) Alvo da FK composta: atividade é única por (empresa, id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_atividades_empresa_id
  ON crm_atividades (empresa_id, id);

-- 3) FK COMPOSTA: a atividade de origem precisa ser do MESMO tenant do aviso.
DO $e42_crm_notificacoes$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = to_regclass('public.crm_notificacoes')
       AND conname = 'fk_e42_crm_notificacoes_empresa_atividade'
  ) THEN
    ALTER TABLE crm_notificacoes
      ADD CONSTRAINT fk_e42_crm_notificacoes_empresa_atividade
      FOREIGN KEY (empresa_id, atividade_id) REFERENCES crm_atividades (empresa_id, id)
      NOT VALID;
  END IF;
  ALTER TABLE crm_notificacoes
    VALIDATE CONSTRAINT fk_e42_crm_notificacoes_empresa_atividade;
END
$e42_crm_notificacoes$;

CREATE INDEX IF NOT EXISTS e42_crm_notificacoes_empresa_atividade_idx
  ON crm_notificacoes (empresa_id, atividade_id);

COMMENT ON CONSTRAINT fk_e42_crm_notificacoes_empresa_atividade ON crm_notificacoes
  IS 'E4.2/CRM 9.2: o aviso e a atividade de origem são do mesmo tenant — a FK simples não garantia isso.';
COMMENT ON CONSTRAINT crm_notificacoes_usuario_id_fkey ON crm_notificacoes
  IS 'FASE 9.2: ON DELETE SET NULL — apagar o destinatário preserva a trilha do aviso (nunca se apaga histórico).';

-- ============================================================================
-- DIAGNÓSTICO (rodar ANTES, se o VALIDATE falhar num banco com dados):
-- lista avisos cuja atividade de origem é de OUTRA empresa — o que a FK
-- composta passa a proibir. Não é executado pela migração.
--
--   SELECT n.id, n.empresa_id AS empresa_aviso, a.empresa_id AS empresa_atividade
--     FROM crm_notificacoes n JOIN crm_atividades a ON a.id = n.atividade_id
--    WHERE n.atividade_id IS NOT NULL AND a.empresa_id <> n.empresa_id;
--
-- Saneamento: anular `atividade_id` (NULL) preserva o aviso e remove o vínculo
-- cross-tenant; nunca fundir empresas nem reatribuir histórico sem evidência.
-- ============================================================================
