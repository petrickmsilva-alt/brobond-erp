-- ============================================================================
-- 0111 — CRM, MARKETING & LOYALTY (FASE 7): LIMITE DE FREQUÊNCIA, EXPIRAÇÃO
--        DE PONTOS E ESTORNO AUDITÁVEL.
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A Onda 4–5 entregou o núcleo de growth: automação (marketing_automations /
-- marketing_automation_runs), fidelidade (loyalty_programs / loyalty_tiers /
-- loyalty_movements, com saldo DERIVADO dos movimentos) e consentimento LGPD
-- (customer_consents). Faltavam três peças para fechar o ciclo sem inventar
-- um segundo motor:
--
--   1. LIMITE DE FREQUÊNCIA por automação — sem ele, um gatilho que dispara em
--      rajada pode reenviar a mesma comunicação. O limite é declarativo (dias)
--      e checado contra a trilha append-only de execuções.
--   2. IDENTIDADE IDEMPOTENTE de expiração — a expiração de pontos já é um tipo
--      de movimento (`expiracao`), mas sem chave determinística por lote/venci-
--      mento o mesmo vencimento poderia ser processado duas vezes. A chave passa
--      a ser obrigatória e única por empresa (índice já existente em
--      loyalty_movements: (empresa_id, chave_idempotencia)).
--   3. NADA A CRIAR para estorno — o estorno já é um movimento (`estorno`,
--      pontos negativos). Esta migração só documenta a regra: estorno é
--      proporcional à origem (venda/devolução) e nunca deixa o saldo negativo
--      indevidamente.
--
-- ESTA MIGRAÇÃO É ADITIVA E IDEMPOTENTE. Não altera dados, não reescreve o
-- passado e não cria uma segunda fonte de verdade para saldo de pontos. O saldo
-- continua sendo a SOMA dos movimentos.
--
-- REGRAS (não negociáveis)
--   • Multiempresa: toda coluna nova convive com `empresa_id` já existente.
--   • `limite_frequencia_dias` NULL/0 = sem limite (comportamento atual).
--   • Nenhum backfill: automações existentes continuam sem limite até serem
--     editadas — não se presume uma janela que o operador não configurou.
-- ============================================================================

ALTER TABLE marketing_automations
  ADD COLUMN IF NOT EXISTS limite_frequencia_dias INTEGER;

-- Limite explícito e não negativo (0 e NULL significam "sem limite").
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketing_automations_limite_frequencia_ck'
  ) THEN
    ALTER TABLE marketing_automations
      ADD CONSTRAINT marketing_automations_limite_frequencia_ck
      CHECK (limite_frequencia_dias IS NULL OR limite_frequencia_dias >= 0);
  END IF;
END $$;

-- Recorte da checagem de frequência (empresa + automação + cliente, mais recente
-- primeiro). Índice parcial: execuções sem cliente não participam do limite.
CREATE INDEX IF NOT EXISTS marketing_automation_runs_frequencia_idx
  ON marketing_automation_runs (empresa_id, automacao_id, cliente_id, criado_em DESC)
  WHERE cliente_id IS NOT NULL;
