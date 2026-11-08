-- ============================================================================
-- 0112 — BI & AI CONTROL TOWER (FASE 8): ALERTAS CONFIGURÁVEIS
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A Onda 4–5 entregou o BI (bi_read_models, painel de BI), a plataforma de IA
-- (ai_providers/ai_prompts/ai_executions/ai_recommendations) e as previsões
-- (demand_forecasts/supply_plans/sop_scenarios). Faltava a peça que transforma
-- indicador em AÇÃO: um motor de ALERTAS que responda "o que exige atenção
-- agora, com qual severidade, quem já viu e o que já foi resolvido?".
--
-- Duas tabelas, um único motor determinístico (`server/src/alerts.ts`):
--
--   • `alert_rules`  — a REGRA configurável por empresa (limiar, severidade,
--     janela mínima entre notificações, canal, destinatários, ativação).
--   • `alert_events` — a OCORRÊNCIA real detectada, com identidade lógica por
--     `fingerprint` (UNIQUE por empresa): a mesma ocorrência REABRE quando
--     volta a existir, em vez de empilhar linhas; o que deixou de ser detectado
--     é fechado como RESOLVIDO.
--
-- ESTA MIGRAÇÃO É ADITIVA E IDEMPOTENTE. Não altera nenhuma tabela existente,
-- não faz backfill e não cria uma segunda fonte de verdade: o alerta é LEITURA
-- derivada dos documentos canônicos. Nenhum alerta executa operação crítica —
-- alertar não é agir.
--
-- REGRAS (não negociáveis)
--   • Multiempresa: `empresa_id` NOT NULL nas duas tabelas; nada cruza empresa.
--   • Deduplicação: `fingerprint` UNIQUE por empresa + `frequencia_minima_min`
--     na regra controlam a repetição de notificação.
--   • Silenciamento: `silenciado_ate` (regra ou ocorrência) suprime a
--     notificação sem apagar a ocorrência nem a evidência.
--   • Escalonamento e histórico vivem no próprio evento (reconhecer/resolver).
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  -- Chave estável do detector (o motor tem um catálogo fixo de detectores reais).
  chave TEXT NOT NULL,
  nome TEXT NOT NULL,
  dominio TEXT NOT NULL,
  CONSTRAINT alert_rules_dominio_ck CHECK (dominio IN (
    'estoque', 'vendas', 'financeiro', 'operacao', 'atendimento', 'marketing', 'integracoes'
  )),
  severidade TEXT NOT NULL DEFAULT 'media',
  CONSTRAINT alert_rules_severidade_ck CHECK (severidade IN ('baixa', 'media', 'alta', 'critica')),
  -- Limiares do detector (unidade definida pelo próprio detector). JSONB para
  -- não exigir uma coluna por detector e manter a migração aditiva.
  limiar JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  canal TEXT NOT NULL DEFAULT 'interno',
  CONSTRAINT alert_rules_canal_ck CHECK (canal IN ('interno', 'email', 'whatsapp', 'sms', 'push', 'portal')),
  destinatarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Janela mínima entre notificações da MESMA ocorrência (minutos). 0 = sempre.
  frequencia_minima_min INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT alert_rules_frequencia_ck CHECK (frequencia_minima_min >= 0),
  silenciado_ate TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_rules_nome_obrigatorio CHECK (TRIM(COALESCE(nome, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_rules_empresa_chave
  ON alert_rules (empresa_id, chave);
CREATE INDEX IF NOT EXISTS alert_rules_empresa_dominio_idx
  ON alert_rules (empresa_id, dominio, ativo);

CREATE TABLE IF NOT EXISTS alert_events (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  regra_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  -- Chave do detector que originou a ocorrência (sobrevive à remoção da regra).
  regra_chave TEXT NOT NULL,
  dominio TEXT NOT NULL,
  severidade TEXT NOT NULL DEFAULT 'media',
  CONSTRAINT alert_events_severidade_ck CHECK (severidade IN ('baixa', 'media', 'alta', 'critica')),
  titulo TEXT NOT NULL,
  detalhe TEXT NOT NULL,
  -- Evidência rastreável (documento/id que comprova a ocorrência).
  evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Identidade lógica da ocorrência (estável entre execuções).
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTO',
  CONSTRAINT alert_events_status_ck CHECK (status IN ('ABERTO', 'CIENTE', 'RESOLVIDO', 'SILENCIADO')),
  ocorrencias INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT alert_events_ocorrencias_ck CHECK (ocorrencias >= 1),
  primeira_deteccao TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_deteccao TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_notificacao_em TIMESTAMPTZ,
  reconhecido_por INTEGER REFERENCES usuarios(id),
  reconhecido_em TIMESTAMPTZ,
  resolvido_por INTEGER REFERENCES usuarios(id),
  resolvido_em TIMESTAMPTZ,
  resolucao TEXT,
  silenciado_ate TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_events_titulo_obrigatorio CHECK (TRIM(COALESCE(titulo, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_events_fingerprint
  ON alert_events (empresa_id, fingerprint);
CREATE INDEX IF NOT EXISTS alert_events_painel_idx
  ON alert_events (empresa_id, status, severidade, ultima_deteccao DESC);
CREATE INDEX IF NOT EXISTS alert_events_dominio_idx
  ON alert_events (empresa_id, dominio, status);
CREATE INDEX IF NOT EXISTS alert_events_regra_idx
  ON alert_events (empresa_id, regra_chave, status);
