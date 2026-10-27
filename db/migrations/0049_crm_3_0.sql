-- ============================================================================
-- 0049 — CRM 3.0 · LEADS, OPORTUNIDADES, ATIVIDADES E MOTIVOS DE PERDA
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O ERP não tinha cobertura de CRM: não havia onde registrar um lead, qualificar
-- uma oportunidade, acompanhar o pipeline de vendas nem documentar por que uma
-- negociação foi perdida. Cada um destes domínios era preenchido à força em
-- tabelas de venda (que só existem depois de faturar) ou em campos de texto
-- livre sem rastreabilidade.
--
-- Esta migration é ADITIVA e IDEMPOTENTE. Ela NÃO reescreve vendas, clientes,
-- representantes, comissões nem qualquer cadastro existente; apenas adiciona
-- quatro tabelas próprias do CRM 3.0, todas com `empresa_id` e escopo por
-- tenant (multiempresa real).
--
-- DECISÕES ARQUITETURAIS
-- ----------------------
--   • `crm_motivos_perda` é a tabela de referência dos motivos de perda.
--     Oportunidade perdida exige motivo (preenchimento obrigatório no serviço).
--   • `crm_leads` é o topo do funil: contato potencial ainda não convertido em
--     cliente. Pode (mas não precisa) virar `crm_oportunidade` e/ou `clientes`.
--   • `crm_oportunidades` é a negociação em curso, com estágio do pipeline,
--     valor, probabilidade e previsão de fechamento. Vinculada ao lead de origem
--     e ao cliente quando já cadastrado.
--   • `crm_atividades` é o registro de interação (chamada, visita, e-mail,
--     reunião, tarefa, follow-up) vinculada a lead, oportunidade e/ou cliente.
--   • Nenhuma FK em CASCADE: exclusão recusa com 409 via diagnóstico de
--     dependências (`server/src/dependencias.ts`). Nada é apagado, só
--     desativado.
--   • `status`/`etapa`/`tipo` usam vocabulário fechado via CHECK, para que o
--     banco seja a autoridade final (defesa em profundidade).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) MOTIVOS DE PERDA — catálogo de referência por empresa
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_motivos_perda (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_motivos_perda_empresa_idx
  ON crm_motivos_perda (empresa_id, ativo);

-- ----------------------------------------------------------------------------
-- 2) LEADS — topo do funil de vendas
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_leads (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  documento TEXT,                      -- CPF/CNPJ apenas dígitos
  email TEXT,
  telefone TEXT,
  origem TEXT,                         -- indicacao, site, feira, outbound, outro
  status TEXT NOT NULL DEFAULT 'novo', -- novo, contato, qualificacao, proposta, ganho, perdido
  valor_estimado NUMERIC(14,2),
  probabilidade INTEGER DEFAULT 0,     -- 0 a 100
  cliente_id INTEGER REFERENCES clientes(id), -- quando convertido em cliente
  lead_convertido_em TIMESTAMPTZ,      -- quando virou oportunidade/cliente
  previsao_contato DATE,
  observacoes TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_leads_empresa_status_idx
  ON crm_leads (empresa_id, status);
CREATE INDEX IF NOT EXISTS crm_leads_empresa_responsavel_idx
  ON crm_leads (empresa_id, responsavel_id);
CREATE INDEX IF NOT EXISTS crm_leads_cliente_idx
  ON crm_leads (cliente_id);

-- ----------------------------------------------------------------------------
-- 3) OPORTUNIDADES — negociação em pipeline
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_oportunidades (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  lead_id INTEGER REFERENCES crm_leads(id),
  nome TEXT NOT NULL,
  etapa TEXT NOT NULL DEFAULT 'prospeccao', -- prospecao, qualificacao, proposta, negociacao, fechamento
  valor NUMERIC(14,2),
  probabilidade INTEGER DEFAULT 0,          -- 0 a 100
  previsao_fechamento DATE,
  data_fechamento DATE,
  motivo_perda_id INTEGER REFERENCES crm_motivos_perda(id),
  observacoes TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  status TEXT NOT NULL DEFAULT 'aberta',    -- aberta, ganha, perdida
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_status_idx
  ON crm_oportunidades (empresa_id, status);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_idx
  ON crm_oportunidades (empresa_id, etapa);
CREATE INDEX IF NOT EXISTS crm_oportunidades_cliente_idx
  ON crm_oportunidades (cliente_id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_lead_idx
  ON crm_oportunidades (lead_id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_responsavel_idx
  ON crm_oportunidades (empresa_id, responsavel_id);

-- ----------------------------------------------------------------------------
-- 4) ATIVIDADES — registro de interação (chamada, visita, e-mail, reunião...)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_atividades (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lead_id INTEGER REFERENCES crm_leads(id),
  oportunidade_id INTEGER REFERENCES crm_oportunidades(id),
  cliente_id INTEGER REFERENCES clientes(id),
  tipo TEXT NOT NULL,                          -- chamada, visita, email, reuniao, tarefa, follow_up
  data_atividade TIMESTAMPTZ NOT NULL DEFAULT now(),
  resultado TEXT,                              -- realizado, agendado, nao_compareceu
  resumo TEXT,
  proxima_acao DATE,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_atividades_empresa_tipo_idx
  ON crm_atividades (empresa_id, tipo);
CREATE INDEX IF NOT EXISTS crm_atividades_lead_idx
  ON crm_atividades (lead_id);
CREATE INDEX IF NOT EXISTS crm_atividades_oportunidade_idx
  ON crm_atividades (oportunidade_id);
CREATE INDEX IF NOT EXISTS crm_atividades_cliente_idx
  ON crm_atividades (cliente_id);
CREATE INDEX IF NOT EXISTS crm_atividades_data_idx
  ON crm_atividades (empresa_id, data_atividade);

-- ----------------------------------------------------------------------------
-- 5) COERÊNCIA — vocabulário fechado no banco (defesa em profundidade)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_status_valido
    CHECK (status IN ('novo', 'contato', 'qualificacao', 'proposta', 'ganho', 'perdido'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_etapa_valido
    CHECK (etapa IN ('prospeccao', 'qualificacao', 'proposta', 'negociacao', 'fechamento'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_status_valido
    CHECK (status IN ('aberta', 'ganha', 'perdida'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_perda_exige_motivo
    CHECK (status <> 'perdida' OR motivo_perda_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_tipo_valido
    CHECK (tipo IN ('chamada', 'visita', 'email', 'reuniao', 'tarefa', 'follow_up'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_resultado_valido
    CHECK (resultado IS NULL OR resultado IN ('realizado', 'agendado', 'nao_compareceu'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Probabilidade entre 0 e 100.
DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 6) ÍNDICES DE BUSCA (texto livre)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS crm_leads_empresa_nome_idx
  ON crm_leads (empresa_id, nome);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_nome_idx
  ON crm_oportunidades (empresa_id, nome);
