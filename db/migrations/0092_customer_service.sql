-- ============================================================================
-- ONDA 4 / D1 — CUSTOMER PLATFORM: ATENDIMENTO (SERVICE) E SEGMENTAÇÃO
--
-- Esta migration adiciona o ATENDIMENTO (tickets, categorias, SLA, interações)
-- e a SEGMENTAÇÃO/CDP do cliente sobre os cadastros que JÁ existem:
--   • `clientes` continua sendo o customer master (não há segundo cadastro);
--   • `vendas`, `itens_venda`, `devolucoes`, `lancamentos_financeiros` e
--     `commerce_pedidos` continuam sendo a fonte de pedido/pagamento/devolução;
--   • o ticket apenas REFERENCIA cliente/pedido/devolução — não os duplica.
--
-- Nada aqui cria um segundo ledger, segundo estoque ou segundo OMS. Todo o
-- vocabulário é fechado por CHECK (defesa em profundidade) e toda tabela tem
-- `empresa_id` NOT NULL (empresa = tenant).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) SLA — política de prazo por prioridade (dado de configuração da empresa)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_sla_politicas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  prioridade TEXT NOT NULL,
  resposta_horas INTEGER NOT NULL,
  resolucao_horas INTEGER NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT service_sla_prioridade_valida CHECK (prioridade IN ('baixa','media','alta','urgente')),
  CONSTRAINT service_sla_prazos_validos CHECK (resposta_horas > 0 AND resolucao_horas >= resposta_horas)
);
CREATE UNIQUE INDEX IF NOT EXISTS service_sla_empresa_prioridade_uq
  ON service_sla_politicas (empresa_id, prioridade) WHERE ativo;

-- ----------------------------------------------------------------------------
-- 2) CATEGORIAS DE ATENDIMENTO
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_ticket_categorias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS service_categoria_empresa_nome_uq
  ON service_ticket_categorias (empresa_id, lower(nome));

-- ----------------------------------------------------------------------------
-- 3) TICKETS — o documento do atendimento
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_tickets (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  numero TEXT,
  cliente_id INTEGER REFERENCES clientes(id),
  categoria_id INTEGER REFERENCES service_ticket_categorias(id),
  prioridade TEXT NOT NULL DEFAULT 'media',
  status TEXT NOT NULL DEFAULT 'aberto',
  assunto TEXT NOT NULL,
  descricao TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  -- Vínculos com os documentos canônicos (nunca cópia de dados):
  venda_id INTEGER REFERENCES vendas(id),
  devolucao_id INTEGER REFERENCES devolucoes(id),
  commerce_pedido_id INTEGER REFERENCES commerce_pedidos(id),
  payment_intent_id BIGINT REFERENCES payment_intents(id),
  -- Prazos (derivados da política de SLA no momento da abertura):
  prazo_resposta_em TIMESTAMPTZ,
  prazo_resolucao_em TIMESTAMPTZ,
  primeira_resposta_em TIMESTAMPTZ,
  resolvido_em TIMESTAMPTZ,
  fechado_em TIMESTAMPTZ,
  resolucao TEXT,
  canal TEXT NOT NULL DEFAULT 'interno',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT service_ticket_prioridade_valida CHECK (prioridade IN ('baixa','media','alta','urgente')),
  CONSTRAINT service_ticket_status_valido CHECK (status IN (
    'aberto','em_atendimento','aguardando_cliente','resolvido','fechado','cancelado'
  )),
  CONSTRAINT service_ticket_canal_valido CHECK (canal IN ('interno','email','telefone','whatsapp','portal','chat')),
  -- Resolvido/fechado exige a marca de resolução (não se resolve sem registrar quando).
  CONSTRAINT service_ticket_resolvido_coerente CHECK (
    status NOT IN ('resolvido','fechado') OR resolvido_em IS NOT NULL
  ),
  CONSTRAINT service_ticket_assunto_obrigatorio CHECK (TRIM(COALESCE(assunto, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_ticket_numero
  ON service_tickets (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_tickets_empresa_status_idx
  ON service_tickets (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS service_tickets_empresa_cliente_idx
  ON service_tickets (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS service_tickets_empresa_responsavel_idx
  ON service_tickets (empresa_id, responsavel_id, status);
CREATE INDEX IF NOT EXISTS service_tickets_empresa_prazo_idx
  ON service_tickets (empresa_id, status, prazo_resolucao_em);

-- ----------------------------------------------------------------------------
-- 4) INTERAÇÕES — trilha APPEND-ONLY do ticket (histórico real)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_ticket_interacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  ticket_id INTEGER NOT NULL REFERENCES service_tickets(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'nota',
  autor_id INTEGER REFERENCES usuarios(id),
  mensagem TEXT,
  -- Transição de status registrada nesta interação (auditoria do fluxo).
  status_anterior TEXT,
  status_novo TEXT,
  publico BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_interacao_tipo_valido CHECK (tipo IN ('nota','resposta','status','atribuicao','resolucao'))
);
CREATE INDEX IF NOT EXISTS service_interacoes_ticket_idx
  ON service_ticket_interacoes (empresa_id, ticket_id, criado_em);

-- ----------------------------------------------------------------------------
-- 5) SEGMENTAÇÃO / CDP — regras reutilizáveis sobre o cliente existente
--
-- O segmento é uma REGRA avaliada contra dados reais (recência, frequência,
-- valor, categoria, canal, comportamento, engajamento, abandono). Nenhuma
-- cópia do cadastro do cliente é criada: a avaliação lê `clientes` + histórico.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_segments (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  -- Critérios objetivos e auditáveis (JSONB validado no serviço):
  --   { recencia_dias_max, frequencia_min, valor_min, categoria_id,
  --     canal, status, incluir_abandono, consentimento_marketing }
  regra JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT customer_segments_nome_obrigatorio CHECK (TRIM(COALESCE(nome, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_segments_empresa_nome_uq
  ON customer_segments (empresa_id, lower(nome));

-- ----------------------------------------------------------------------------
-- 6) CONSENTIMENTOS E PREFERÊNCIAS (LGPD) — por cliente e canal
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_consents (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  finalidade TEXT NOT NULL,
  concedido BOOLEAN NOT NULL DEFAULT false,
  origem TEXT,
  evidencia TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_consents_finalidade_valida CHECK (finalidade IN (
    'marketing','comunicacao','dados_analiticos','cookies'
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_consents_empresa_cliente_finalidade_uq
  ON customer_consents (empresa_id, cliente_id, finalidade);

CREATE TABLE IF NOT EXISTS customer_preferences (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  canal_preferido TEXT,
  idioma TEXT,
  observacoes TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_preferences_empresa_cliente_uq
  ON customer_preferences (empresa_id, cliente_id);

-- ----------------------------------------------------------------------------
-- 7) SEMENTE DE SLA CANÔNICO por empresa (idempotente).
--    Prazos usuais de mercado; o operador pode ajustar em /service/sla.
-- ----------------------------------------------------------------------------
INSERT INTO service_sla_politicas (empresa_id, nome, prioridade, resposta_horas, resolucao_horas, ativo)
SELECT e.id, v.nome, v.prioridade, v.resposta_horas, v.resolucao_horas, true
  FROM empresas e
  JOIN (VALUES
    ('SLA Padrão — Baixa',   'baixa',   24, 120),
    ('SLA Padrão — Média',   'media',    8,  48),
    ('SLA Padrão — Alta',    'alta',     4,  24),
    ('SLA Padrão — Urgente', 'urgente',  1,   8)
  ) AS v(nome, prioridade, resposta_horas, resolucao_horas) ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM service_sla_politicas p
    WHERE p.empresa_id = e.id AND p.prioridade = v.prioridade AND p.ativo
 );
