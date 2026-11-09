-- ============================================================================
-- FASE 9.2 — CRM LIFECYCLE AUTOMATION: CAIXA DE ENTRADA INTERNA (BL-012/GAP-P2-06)
--
-- Contexto: o lembrete de atividade do CRM já é disparado pelo agendador
-- existente (`scheduled.ts` → `dispararLembretesCrm`), com idempotência por
-- `crm_atividades.lembrete_enviado_em` (compare-and-swap). O canal EXTERNO
-- (e-mail) é opcional e desligado por padrão; faltava o canal INTERNO, visível
-- dentro do ERP, para o responsável pela atividade.
--
-- Esta tabela é o canal INTERNO: um REGISTRO de notificação entregue ao usuário
-- responsável. Regras de arquitetura:
--   • `empresa_id` OBRIGATÓRIO (multiempresa) e o destinatário só vê o que é da
--     empresa dele (a listagem é recortada por tenant E por usuário);
--   • IDEMPOTÊNCIA por `(empresa_id, chave_idempotencia)` — o agendador grava a
--     notificação com a mesma chave do carimbo do lembrete, então reprocessar
--     NÃO duplica (UNIQUE);
--   • a notificação NÃO altera o estado da atividade — é um aviso, não uma ação;
--   • sem conector externo: nada aqui dispara e-mail/WhatsApp/SMS/push.
--
-- Aditiva e idempotente. Não remove dados nem colunas.
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS crm_notificacoes;
--   DELETE FROM schema_migrations WHERE id = '0113_fase9_crm_notificacoes.sql';
--   COMMIT;
-- ============================================================================

CREATE TABLE IF NOT EXISTS crm_notificacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  -- Atividade de origem (SET NULL: o histórico da notificação sobrevive à
  -- remoção da atividade — nunca apagamos trilha para simplificar o fluxo).
  atividade_id INTEGER REFERENCES crm_atividades(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,
  CONSTRAINT crm_notificacoes_tipo_ck CHECK (tipo IN (
    'atribuicao', 'lembrete', 'vencida', 'alteracao_responsavel', 'conclusao', 'reagendamento', 'cancelamento', 'falha'
  )),
  severidade TEXT NOT NULL DEFAULT 'media',
  CONSTRAINT crm_notificacoes_severidade_ck CHECK (severidade IN ('baixa', 'media', 'alta', 'critica')),
  -- Destinatário (usuário) — quem recebe a notificação interna.
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  -- Identificação de quem disparou o fato (auditoria), quando aplicável.
  ator_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  titulo TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Identidade idempotente do evento (tenant + chave): o mesmo fato não gera
  -- duas notificações, mesmo sob reprocessamento.
  chave_idempotencia TEXT NOT NULL,
  lida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_notificacoes_titulo_ck CHECK (TRIM(COALESCE(titulo, '')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_notificacoes_idempotencia
  ON crm_notificacoes (empresa_id, chave_idempotencia);
CREATE INDEX IF NOT EXISTS crm_notificacoes_empresa_usuario_lida_idx
  ON crm_notificacoes (empresa_id, usuario_id, lida_em);
CREATE INDEX IF NOT EXISTS crm_notificacoes_empresa_criado_idx
  ON crm_notificacoes (empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS crm_notificacoes_atividade_idx
  ON crm_notificacoes (atividade_id);

-- Diagnóstico (não falha a migração; apenas informa).
DO $diag_crm_notificacoes$
DECLARE total INTEGER;
BEGIN
  SELECT count(*) INTO total FROM crm_notificacoes;
  RAISE NOTICE 'crm_notificacoes pronta: % linha(s).', total;
END $diag_crm_notificacoes$;
