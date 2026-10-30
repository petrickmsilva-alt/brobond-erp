-- ============================================================================
-- ONDAS 4–5 / D2–D7 — GROWTH, DATA/BI, AI, DEMAND/SUPPLY, WMS/TMS/SUPPLIER, EPM
--
-- Regras canônicas respeitadas:
--   • empresa = tenant (toda tabela tem empresa_id NOT NULL);
--   • NÃO se cria segundo estoque, segundo ledger, segundo OMS, segundo
--     customer master nem segundo sistema de eventos/auditoria;
--   • campanhas usam o documento EXISTENTE (`crm_campanhas`) — estendido, não
--     duplicado; comissões de afiliado usam `comissoes_apuradas` e o financeiro
--     EXISTENTE (`lancamentos_financeiros`);
--   • projeções de BI carregam empresa, origem, período, timestamp, dimensão e
--     métrica;
--   • recomendação de IA carrega empresa, timestamp, modelo, score, evidência,
--     recomendação e status — e NÃO altera estoque/pagamento/financeiro/pedido
--     por conta própria.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- D2 — GROWTH: campanha (extensão do documento existente crm_campanhas)
-- ----------------------------------------------------------------------------
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS segmento_id INTEGER REFERENCES customer_segments(id);
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS canal TEXT;
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS orcamento NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS custo NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS objetivo TEXT;
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS inicio_em TIMESTAMPTZ;
ALTER TABLE crm_campanhas ADD COLUMN IF NOT EXISTS fim_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE crm_campanhas ADD CONSTRAINT crm_campanhas_valores_nao_negativos
  CHECK (orcamento >= 0 AND custo >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- D2 — MARKETING AUTOMATION: automação (trigger → condição → ação) e execuções
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_automations (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  trigger_tipo TEXT NOT NULL,
  trigger_valor TEXT,
  condicao JSONB NOT NULL DEFAULT '{}'::jsonb,
  acao_tipo TEXT NOT NULL,
  canal TEXT NOT NULL DEFAULT 'interno',
  template_id INTEGER REFERENCES crm_campanhas(id),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT marketing_automations_trigger_valido CHECK (trigger_tipo IN (
    'pedido_criado','pedido_pago','cliente_inativo','carrinho_abandonado','ticket_aberto','aniversario'
  )),
  CONSTRAINT marketing_automations_acao_valida CHECK (acao_tipo IN (
    'enviar_mensagem','aplicar_cupom','creditar_pontos','criar_tarefa','notificar_equipe'
  )),
  CONSTRAINT marketing_automations_canal_valido CHECK (canal IN ('interno','email','whatsapp','sms','push','portal')),
  CONSTRAINT marketing_automations_nome_obrigatorio CHECK (TRIM(COALESCE(nome,'')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_automations_empresa_nome_uq
  ON marketing_automations (empresa_id, lower(nome));

CREATE TABLE IF NOT EXISTS marketing_automation_runs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  automacao_id INTEGER NOT NULL REFERENCES marketing_automations(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id),
  pedido_id INTEGER,
  estado TEXT NOT NULL DEFAULT 'executada',
  entregue_em TIMESTAMPTZ,
  interagiu_em TIMESTAMPTZ,
  converteu_em TIMESTAMPTZ,
  chave_idempotencia TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT marketing_runs_estado_valido CHECK (estado IN ('executada','entregue','interagiu','converteu','falhou')),
  CONSTRAINT marketing_runs_chave_obrigatoria CHECK (TRIM(COALESCE(chave_idempotencia,'')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_runs_empresa_chave_uq
  ON marketing_automation_runs (empresa_id, chave_idempotencia);
CREATE INDEX IF NOT EXISTS marketing_runs_automacao_idx
  ON marketing_automation_runs (empresa_id, automacao_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- D2 — LOYALTY: programa, níveis, movimentos (saldo = soma dos movimentos)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loyalty_programs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  pontos_por_real NUMERIC(10,2) NOT NULL DEFAULT 1,
  validade_dias INTEGER,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT loyalty_programs_pontos_validos CHECK (pontos_por_real >= 0),
  CONSTRAINT loyalty_programs_validade_valida CHECK (validade_dias IS NULL OR validade_dias > 0),
  CONSTRAINT loyalty_programs_nome_obrigatorio CHECK (TRIM(COALESCE(nome,'')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_programs_empresa_nome_uq
  ON loyalty_programs (empresa_id, lower(nome));

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  programa_id INTEGER NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  pontos_minimos INTEGER NOT NULL DEFAULT 0,
  beneficio TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_tiers_pontos_validos CHECK (pontos_minimos >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_tiers_programa_nome_uq
  ON loyalty_tiers (empresa_id, programa_id, lower(nome));

-- Movimentos são a fonte do saldo. Nada de coluna "saldo" mutável: o saldo é a
-- soma dos movimentos, e a idempotência impede crédito duplicado.
CREATE TABLE IF NOT EXISTS loyalty_movements (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  programa_id INTEGER NOT NULL REFERENCES loyalty_programs(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  tipo TEXT NOT NULL,
  pontos INTEGER NOT NULL,
  venda_id INTEGER REFERENCES vendas(id),
  expira_em TIMESTAMPTZ,
  chave_idempotencia TEXT NOT NULL,
  descricao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_movements_tipo_valido CHECK (tipo IN ('credito','resgate','expiracao','estorno')),
  CONSTRAINT loyalty_movements_pontos_validos CHECK (pontos <> 0),
  CONSTRAINT loyalty_movements_chave_obrigatoria CHECK (TRIM(COALESCE(chave_idempotencia,'')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_movements_empresa_chave_uq
  ON loyalty_movements (empresa_id, chave_idempotencia);
CREATE INDEX IF NOT EXISTS loyalty_movements_saldo_idx
  ON loyalty_movements (empresa_id, programa_id, cliente_id);

-- ----------------------------------------------------------------------------
-- D2 — AFFILIATE: comissão derivada da ATRIBUIÇÃO real (creator_attributions).
-- Sem atribuição elegível não há comissão; a chave de idempotência impede
-- comissão duplicada. O pagamento entra no financeiro EXISTENTE.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  partnership_id INTEGER NOT NULL REFERENCES creator_partnerships(id),
  attribution_id INTEGER REFERENCES creator_attributions(id),
  pedido_id INTEGER,
  base_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  percentual NUMERIC(7,4) NOT NULL DEFAULT 0,
  valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'apurada',
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  chave_idempotencia TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT affiliate_commissions_status_valido CHECK (status IN ('apurada','paga','estornada')),
  CONSTRAINT affiliate_commissions_valores CHECK (base_valor >= 0 AND valor >= 0),
  CONSTRAINT affiliate_commissions_chave_obrigatoria CHECK (TRIM(COALESCE(chave_idempotencia,'')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commissions_empresa_chave_uq
  ON affiliate_commissions (empresa_id, chave_idempotencia);

-- ----------------------------------------------------------------------------
-- D2 — CREATORS: matches (afinidade real por nicho/categoria) e outreach
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creator_matches (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  creator_id INTEGER NOT NULL REFERENCES creator_profiles(id),
  campaign_id INTEGER REFERENCES creator_campaigns(id),
  categoria_id INTEGER REFERENCES categorias(id),
  score NUMERIC(6,2) NOT NULL DEFAULT 0,
  evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'sugerido',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT creator_matches_status_valido CHECK (status IN ('sugerido','aceito','descartado')),
  CONSTRAINT creator_matches_score_valido CHECK (score >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_matches_empresa_creator_campanha_uq
  ON creator_matches (empresa_id, creator_id, campaign_id);

CREATE TABLE IF NOT EXISTS creator_outreach (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  creator_id INTEGER NOT NULL REFERENCES creator_profiles(id),
  partnership_id INTEGER REFERENCES creator_partnerships(id),
  canal TEXT NOT NULL DEFAULT 'email',
  assunto TEXT,
  mensagem TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho',
  enviado_em TIMESTAMPTZ,
  respondido_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT creator_outreach_status_valido CHECK (status IN ('rascunho','enviado','respondido','sem_resposta')),
  CONSTRAINT creator_outreach_canal_valido CHECK (canal IN ('email','whatsapp','instagram','telefone','outro'))
);

-- ----------------------------------------------------------------------------
-- D3 — DATA/BI: projeção de leitura (empresa, origem, período, timestamp,
-- dimensão, métrica). Reconstruída a partir dos documentos canônicos.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bi_read_models (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  origem TEXT NOT NULL,
  periodo TEXT NOT NULL,
  dimensao TEXT NOT NULL,
  dimensao_valor TEXT,
  metrica TEXT NOT NULL,
  valor NUMERIC(18,4) NOT NULL DEFAULT 0,
  gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bi_read_models_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS bi_read_models_uq
  ON bi_read_models (empresa_id, origem, periodo, dimensao, COALESCE(dimensao_valor, ''), metrica);

-- ----------------------------------------------------------------------------
-- D4 — AI PLATFORM: camada CENTRAL (provider, modelo, prompt, versão, execução,
-- custo, limites, fallback, resultado, auditoria) e recomendações com evidência.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_providers (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'interno',
  modelo TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  limite_mensal_custo NUMERIC(14,2),
  fallback_provider_id INTEGER REFERENCES ai_providers(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_providers_tipo_valido CHECK (tipo IN ('interno','externo','heuristica'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_empresa_nome_uq
  ON ai_providers (empresa_id, lower(nome));

CREATE TABLE IF NOT EXISTS ai_prompts (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  chave TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1,
  conteudo TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_prompts_versao_valida CHECK (versao >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_prompts_empresa_chave_versao_uq
  ON ai_prompts (empresa_id, chave, versao);

CREATE TABLE IF NOT EXISTS ai_executions (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider_id INTEGER REFERENCES ai_providers(id),
  prompt_id INTEGER REFERENCES ai_prompts(id),
  finalidade TEXT NOT NULL,
  entrada JSONB NOT NULL DEFAULT '{}'::jsonb,
  resultado JSONB,
  custo NUMERIC(14,4) NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'sucesso',
  erro TEXT,
  chave_idempotencia TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_executions_estado_valido CHECK (estado IN ('sucesso','falha','fallback')),
  CONSTRAINT ai_executions_custo_valido CHECK (custo >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_executions_empresa_chave_uq
  ON ai_executions (empresa_id, chave_idempotencia) WHERE chave_idempotencia IS NOT NULL;

-- Recomendação: nunca aplica sozinha; exige decisão humana e fica auditada.
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  execucao_id INTEGER REFERENCES ai_executions(id),
  dominio TEXT NOT NULL,
  modelo TEXT,
  score NUMERIC(6,3) NOT NULL DEFAULT 0,
  evidencia JSONB NOT NULL DEFAULT '{}'::jsonb,
  recomendacao TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  decidido_por INTEGER REFERENCES usuarios(id),
  decidido_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_recommendations_dominio_valido CHECK (dominio IN (
    'sales','customer','marketing','inventory','demand','commerce'
  )),
  CONSTRAINT ai_recommendations_status_valido CHECK (status IN ('pendente','aceita','rejeitada','aplicada')),
  CONSTRAINT ai_recommendations_score_valido CHECK (score >= 0 AND score <= 1),
  CONSTRAINT ai_recommendations_texto_obrigatorio CHECK (TRIM(COALESCE(recomendacao,'')) <> '')
);
CREATE INDEX IF NOT EXISTS ai_recommendations_dominio_idx
  ON ai_recommendations (empresa_id, dominio, status, criado_em DESC);

-- ----------------------------------------------------------------------------
-- D5 — DEMAND / SUPPLY / S&OP
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demand_forecasts (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  periodo TEXT NOT NULL,
  historico NUMERIC(14,2) NOT NULL DEFAULT 0,
  sazonalidade NUMERIC(10,4) NOT NULL DEFAULT 1,
  tendencia NUMERIC(14,4) NOT NULL DEFAULT 0,
  forecast NUMERIC(14,2) NOT NULL DEFAULT 0,
  excecao TEXT,
  metodo TEXT NOT NULL DEFAULT 'media_movel',
  gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demand_forecasts_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT demand_forecasts_forecast_valido CHECK (forecast >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS demand_forecasts_empresa_produto_periodo_uq
  ON demand_forecasts (empresa_id, produto_id, periodo);

CREATE TABLE IF NOT EXISTS supply_plans (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  periodo TEXT NOT NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  demanda NUMERIC(14,2) NOT NULL DEFAULT 0,
  estoque_atual NUMERIC(14,2) NOT NULL DEFAULT 0,
  necessidade NUMERIC(14,2) NOT NULL DEFAULT 0,
  mrp_ordens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planejado',
  gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supply_plans_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT supply_plans_status_valido CHECK (status IN ('planejado','aprovado','executado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS supply_plans_empresa_produto_periodo_uq
  ON supply_plans (empresa_id, produto_id, periodo);

CREATE TABLE IF NOT EXISTS sop_scenarios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  periodo TEXT NOT NULL,
  demanda_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  capacidade_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  impacto_financeiro NUMERIC(14,2) NOT NULL DEFAULT 0,
  detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'rascunho',
  aprovado_por INTEGER REFERENCES usuarios(id),
  aprovado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sop_scenarios_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT sop_scenarios_status_valido CHECK (status IN ('rascunho','aprovado','rejeitado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS sop_scenarios_empresa_nome_uq
  ON sop_scenarios (empresa_id, lower(nome));

-- ----------------------------------------------------------------------------
-- D6 — WMS/TMS/SUPPLIER: extensões sobre os documentos EXISTENTES (envios,
-- fornecedores) — nenhum segundo estoque nem segundo OMS.
-- ----------------------------------------------------------------------------
ALTER TABLE envios ADD COLUMN IF NOT EXISTS transportadora TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS modal TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS rota TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS sla_em TIMESTAMPTZ;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS custo_frete NUMERIC(12,2);
DO $$ BEGIN
  ALTER TABLE envios ADD CONSTRAINT envios_modal_valido CHECK (modal IS NULL OR modal IN ('rodoviario','aereo','maritimo','ferroviario','urbano'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS envio_ocorrencias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  descricao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT envio_ocorrencias_tipo_valido CHECK (tipo IN (
    'atraso','avaria','extravio','tentativa_entrega','recusa','devolvido','entregue','outro'
  ))
);
CREATE INDEX IF NOT EXISTS envio_ocorrencias_envio_idx
  ON envio_ocorrencias (empresa_id, envio_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS fornecedor_scorecards (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  periodo TEXT NOT NULL,
  lead_time_dias NUMERIC(10,2) NOT NULL DEFAULT 0,
  qualidade_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  entrega_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  otif_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  preco_indice NUMERIC(10,4) NOT NULL DEFAULT 1,
  ocorrencias INTEGER NOT NULL DEFAULT 0,
  gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fornecedor_scorecards_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT fornecedor_scorecards_pct_validos CHECK (qualidade_pct >= 0 AND entrega_pct >= 0 AND otif_pct >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS fornecedor_scorecards_empresa_forn_periodo_uq
  ON fornecedor_scorecards (empresa_id, fornecedor_id, periodo);

-- ----------------------------------------------------------------------------
-- D7 — ENTERPRISE FINANCE / EPM (sem segundo ledger: usa plano de contas e
-- centros de custo EXISTENTES).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epm_budgets (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  periodo TEXT NOT NULL,
  conta_id INTEGER REFERENCES plano_contas(id),
  centro_custo_id INTEGER REFERENCES centros_custo(id),
  -- Elo com o realizado: o lançamento financeiro aponta para a CATEGORIA e para
  -- o CENTRO DE CUSTO. O orçamento usa a mesma dimensão para que a variação
  -- venha do financeiro real — nunca de um número digitado.
  categoria_financeira_id INTEGER REFERENCES categorias_financeiras(id),
  responsavel_id INTEGER REFERENCES usuarios(id),
  valor_orcado NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'rascunho',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT epm_budgets_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT epm_budgets_status_valido CHECK (status IN ('rascunho','aprovado','revisado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS epm_budgets_empresa_nome_periodo_uq
  ON epm_budgets (empresa_id, lower(nome), periodo);

CREATE TABLE IF NOT EXISTS epm_scenarios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  periodo TEXT NOT NULL,
  premissas JSONB NOT NULL DEFAULT '{}'::jsonb,
  receita_projetada NUMERIC(14,2) NOT NULL DEFAULT 0,
  custo_projetado NUMERIC(14,2) NOT NULL DEFAULT 0,
  resultado_projetado NUMERIC(14,2) NOT NULL DEFAULT 0,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT epm_scenarios_periodo_valido CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS epm_scenarios_empresa_nome_periodo_uq
  ON epm_scenarios (empresa_id, lower(nome), periodo);

CREATE TABLE IF NOT EXISTS epm_assets (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  localizacao TEXT,
  valor_aquisicao NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_depreciado NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ativo',
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT epm_assets_status_valido CHECK (status IN ('ativo','manutencao','baixado','vendido')),
  CONSTRAINT epm_assets_valores CHECK (valor_aquisicao >= 0 AND valor_depreciado >= 0)
);

CREATE TABLE IF NOT EXISTS epm_projects (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  inicio DATE,
  fim_previsto DATE,
  orcamento NUMERIC(14,2) NOT NULL DEFAULT 0,
  custo_real NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planejado',
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT epm_projects_status_valido CHECK (status IN ('planejado','em_andamento','concluido','cancelado')),
  CONSTRAINT epm_projects_valores CHECK (orcamento >= 0 AND custo_real >= 0)
);

CREATE TABLE IF NOT EXISTS epm_project_tasks (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  projeto_id INTEGER NOT NULL REFERENCES epm_projects(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  responsavel_id INTEGER REFERENCES usuarios(id),
  custo NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pendente',
  prazo DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT epm_project_tasks_status_valido CHECK (status IN ('pendente','em_andamento','concluida','bloqueada'))
);

-- ----------------------------------------------------------------------------
-- D2 — ponte CREATOR ↔ GROWTH CAMPAIGN.
-- `creator_campaigns` é o briefing do creator; a CAMPANHA de growth (com
-- segmento, orçamento, custo e ROI) é o documento `crm_campanhas`. A parceria
-- aponta para a campanha de growth para que tracking→atribuição→comissão→ROI
-- feche sobre o MESMO documento — sem criar uma segunda campanha.
-- ----------------------------------------------------------------------------
ALTER TABLE creator_partnerships ADD COLUMN IF NOT EXISTS crm_campanha_id INTEGER REFERENCES crm_campanhas(id);
CREATE INDEX IF NOT EXISTS creator_partnerships_crm_campanha_idx
  ON creator_partnerships (empresa_id, crm_campanha_id) WHERE crm_campanha_id IS NOT NULL;
