-- ============================================================================
-- 0051 — CRM 3.0 EVOLUÇÃO: funil configurável, histórico de estágio,
--        origem/campanha controlada, lembretes de atividade e lead scoring
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A 0049 entregou o CRM mínimo (leads, oportunidades, atividades, motivos de
-- perda) com estágios FIXOS no CHECK do banco e a auditoria genérica como único
-- rastro de mudança. Quatro lacunas ficaram abertas:
--
--   1) FUNIL NÃO CONFIGURÁVEL — as etapas eram uma lista fechada em código.
--      Nenhuma empresa podia renomear, reordenar, desativar ou usar
--      probabilidade própria por etapa.
--   2) SEM HISTÓRICO DE ESTÁGIO — dava para saber que a oportunidade mudou de
--      etapa (auditoria genérica), mas não consultar "quando passou de proposta
--      para negociação, por quem, com qual observação" como uma trilha do
--      próprio funil.
--   3) ORIGEM ERA TEXTO LIVRE — impossível medir conversão por campanha.
--   4) ATIVIDADE SEM LEMBRETE/STATUS/PRIORIDADE — não havia como responder
--      "o que vence hoje", "o que está atrasado", "o que é urgente".
--   (5) Sem score explicável do lead.
--
-- DECISÕES ARQUITETURAIS (o que é e o que NÃO é)
-- ----------------------------------------------
--   • ADITIVA e IDEMPOTENTE. Nenhuma coluna existente é removida, nenhum dado é
--     reescrito. `crm_leads.origem` (texto) CONTINUA existindo e continua sendo
--     gravada: `origem_id` é a referência controlada, adicionada ao lado.
--   • `crm_oportunidades.etapa` (texto) continua sendo a coluna de leitura do
--     funil corrente, pelo mesmo motivo: o CHECK da 0049 não é ampliado nem
--     afrouxado — apenas as etapas canônicas são semeadas em `crm_etapas`.
--   • Multiempresa REAL: TODA tabela nova carrega `empresa_id` NOT NULL.
--   • Nenhum CASCADE: o histórico referencia a oportunidade com
--     ON DELETE RESTRICT (nada é apagado; registro se cancela).
--   • Vocabulário fechado via CHECK onde existe domínio real (prioridade,
--     status da atividade, canal).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) FUNIS — um por operação comercial, com um padrão por empresa
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_funis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  padrao BOOLEAN NOT NULL DEFAULT false,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_funis_empresa_idx ON crm_funis (empresa_id, ativo);
-- Um único funil padrão por empresa (índice parcial: o banco garante a regra,
-- não só o serviço).
CREATE UNIQUE INDEX IF NOT EXISTS crm_funis_padrao_unico
  ON crm_funis (empresa_id) WHERE padrao;

-- ----------------------------------------------------------------------------
-- 2) ETAPAS — ordem, probabilidade e disponibilidade por funil
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_etapas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  funil_id INTEGER NOT NULL REFERENCES crm_funis(id),
  nome TEXT NOT NULL,
  -- `chave` mantém compatibilidade com `crm_oportunidades.etapa` (texto) e com
  -- o CHECK da 0049; `nome` é o rótulo humano editável.
  chave TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  probabilidade INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_etapas_funil_chave_unico ON crm_etapas (funil_id, chave);
CREATE INDEX IF NOT EXISTS crm_etapas_empresa_ordem_idx ON crm_etapas (empresa_id, funil_id, ordem);

DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_ordem_nao_negativa
    CHECK (ordem >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Semente: um funil padrão por empresa cadastrada, com as CINCO etapas
-- canônicas que o CHECK da 0049 já aceita (nenhuma etapa nova é inventada).
INSERT INTO crm_funis (empresa_id, nome, descricao, padrao, ativo)
SELECT e.id, 'Funil comercial', 'Funil padrão criado pela evolução do CRM 3.0.', true, true
  FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM crm_funis f WHERE f.empresa_id = e.id AND f.padrao);

INSERT INTO crm_etapas (empresa_id, funil_id, nome, chave, ordem, probabilidade, ativo)
SELECT f.empresa_id, f.id, v.nome, v.chave, v.ordem, v.probabilidade, true
  FROM crm_funis f
  JOIN (VALUES
    ('Prospecção',   'prospeccao',   1, 10),
    ('Qualificação', 'qualificacao', 2, 25),
    ('Proposta',     'proposta',     3, 50),
    ('Negociação',   'negociacao',   4, 75),
    ('Fechamento',   'fechamento',   5, 90)
  ) AS v(nome, chave, ordem, probabilidade) ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM crm_etapas x WHERE x.funil_id = f.id AND x.chave = v.chave
 );

-- Oportunidades passam a apontar para o funil corrente (o estágio textual
-- continua sendo a verdade de leitura; `funil_id` diz a qual desenho ele
-- pertence quando houver mais de um funil).
ALTER TABLE crm_oportunidades ADD COLUMN IF NOT EXISTS funil_id INTEGER REFERENCES crm_funis(id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_funil_idx
  ON crm_oportunidades (empresa_id, funil_id);

-- Backfill conservador: só preenche o funil PADRÃO da empresa onde está nulo.
UPDATE crm_oportunidades o
   SET funil_id = f.id
  FROM crm_funis f
 WHERE o.funil_id IS NULL
   AND f.empresa_id = o.empresa_id
   AND f.padrao;

-- ----------------------------------------------------------------------------
-- 3) HISTÓRICO DE ESTÁGIO — trilha própria do funil
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_oportunidade_estagio_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  oportunidade_id INTEGER NOT NULL REFERENCES crm_oportunidades(id),
  estagio_anterior TEXT,
  estagio_novo TEXT NOT NULL,
  status_anterior TEXT,
  status_novo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_estagio_hist_oportunidade_idx
  ON crm_oportunidade_estagio_historico (empresa_id, oportunidade_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS crm_estagio_hist_data_idx
  ON crm_oportunidade_estagio_historico (empresa_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 4) ORIGEM / CANAL / CAMPANHA — estrutura controlada, dado antigo preservado
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_origens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  canal TEXT,          -- site, marketplace, loja_fisica, indicacao, evento, outbound, outro
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_origens_empresa_nome_unico ON crm_origens (empresa_id, nome);

DO $$ BEGIN
  ALTER TABLE crm_origens ADD CONSTRAINT crm_origens_canal_valido
    CHECK (canal IS NULL OR canal IN ('site', 'marketplace', 'loja_fisica', 'indicacao', 'evento', 'outbound', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS crm_campanhas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  origem_id INTEGER REFERENCES crm_origens(id),
  inicio DATE,
  fim DATE,
  investimento NUMERIC(14,2),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_campanhas_empresa_nome_unico ON crm_campanhas (empresa_id, nome);
CREATE INDEX IF NOT EXISTS crm_campanhas_empresa_origem_idx ON crm_campanhas (empresa_id, origem_id);

DO $$ BEGIN
  ALTER TABLE crm_campanhas ADD CONSTRAINT crm_campanhas_periodo_valido
    CHECK (inicio IS NULL OR fim IS NULL OR fim >= inicio);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O texto livre da 0049 permanece (compatibilidade e histórico); as colunas
-- novas são a referência controlada e a atribuição de mídia (UTM).
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS origem_id INTEGER REFERENCES crm_origens(id);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS campanha_id INTEGER REFERENCES crm_campanhas(id);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS canal TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_content TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_term TEXT;

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_canal_valido
    CHECK (canal IS NULL OR canal IN ('site', 'marketplace', 'loja_fisica', 'indicacao', 'evento', 'outbound', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_leads_empresa_origem_id_idx ON crm_leads (empresa_id, origem_id);
CREATE INDEX IF NOT EXISTS crm_leads_empresa_campanha_idx ON crm_leads (empresa_id, campanha_id);

-- Semente de origens canônicas (as mesmas do vocabulário textual da 0049).
INSERT INTO crm_origens (empresa_id, nome, canal, ativo)
SELECT e.id, v.nome, v.canal, true
  FROM empresas e
  JOIN (VALUES
    ('Indicação', 'indicacao'),
    ('Site', 'site'),
    ('Feira / evento', 'evento'),
    ('Outbound', 'outbound'),
    ('Outro', 'outro')
  ) AS v(nome, canal) ON true
 WHERE NOT EXISTS (SELECT 1 FROM crm_origens o WHERE o.empresa_id = e.id AND o.nome = v.nome);

-- ----------------------------------------------------------------------------
-- 5) LEAD SCORING — explicável, recalculável e auditável
-- ----------------------------------------------------------------------------
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score INTEGER;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_motivo TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_atualizado_em TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_score_range
    CHECK (score IS NULL OR (score >= 0 AND score <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_leads_empresa_score_idx ON crm_leads (empresa_id, score DESC);

-- ----------------------------------------------------------------------------
-- 6) ATIVIDADES — lembrete, prioridade, status e conclusão
-- ----------------------------------------------------------------------------
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS prioridade TEXT NOT NULL DEFAULT 'media';
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente';
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS lembrete_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS concluida_em TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_prioridade_valida
    CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_status_valido
    CHECK (status IN ('pendente', 'concluida', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Conclusão coerente: concluída exige carimbo de conclusão.
DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_conclusao_coerente
    CHECK (status <> 'concluida' OR concluida_em IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Agenda do CRM (hoje / atrasadas / próximas) filtra por status + lembrete.
CREATE INDEX IF NOT EXISTS crm_atividades_empresa_status_lembrete_idx
  ON crm_atividades (empresa_id, status, lembrete_em);
CREATE INDEX IF NOT EXISTS crm_atividades_empresa_responsavel_status_idx
  ON crm_atividades (empresa_id, responsavel_id, status);
