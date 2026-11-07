-- 0102 — MOTOR DE FRETE E LOGÍSTICA MULTICANAL
--
-- Módulo `modules/logistics/`. ADITIVA e NÃO DESTRUTIVA. Nenhuma tabela
-- histórica é removida, nenhum DELETE, nenhum backfill silencioso.
--
-- O que já existia e é REUTILIZADO (não recriado):
--   • `envios` / `envio_eventos` (migration 0024) — a remessa e o histórico de
--     rastreio. Aqui elas ganham COLUNAS aditivas (store_key, modalidade,
--     custo previsto/efetivo, quote_id) e o conjunto de status é AMPLIADO
--     (superset — todo status antigo continua válido).
--   • `commerce_outbox` — a fila at-least-once com claim CAS e backoff. Nada
--     é entregue a transportadora/loja fora dela.
--   • `envio_ocorrencias` (migration 0093) — ocorrências do TMS.
--
-- O que nasce aqui:
--   1) logistics_shipping_rules  — motor de regras comerciais de frete;
--   2) logistics_quotes          — cotações persistidas (com a origem, o
--      operador, a modalidade, o valor, o prazo, a validade e a referência da
--      resposta externa) — NUNCA um valor inventado;
--   3) logistics_packages        — volumes de uma remessa (multi-volume);
--   4) logistics_labels          — etiquetas (referência externa + metadados,
--      sem armazenar documento em caminho público);
--   5) logistics_webhook_inbox   — inbox DURÁVEL de webhooks de transportadora,
--      idempotente por (empresa, operador, entrega) com proteção de replay;
--   6) logistics_audit_logs      — trilha de auditoria das operações logísticas.
--
-- Rollback (manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS logistics_audit_logs;
--   DROP TABLE IF EXISTS logistics_webhook_inbox;
--   DROP TABLE IF EXISTS logistics_labels;
--   DROP TABLE IF EXISTS logistics_packages;
--   DROP TABLE IF EXISTS logistics_quotes;
--   DROP TABLE IF EXISTS logistics_shipping_rules;
--   ALTER TABLE envio_eventos DROP COLUMN IF EXISTS status_normalizado,
--     DROP COLUMN IF EXISTS external_code, DROP COLUMN IF EXISTS origem,
--     DROP COLUMN IF EXISTS dedupe_key;
--   DROP INDEX IF EXISTS uq_logistics_evento_dedupe;
--   ALTER TABLE envios DROP COLUMN IF EXISTS store_key, DROP COLUMN IF EXISTS modalidade,
--     DROP COLUMN IF EXISTS quote_id, DROP COLUMN IF EXISTS servico_nome,
--     DROP COLUMN IF EXISTS custo_previsto, DROP COLUMN IF EXISTS custo_efetivo;
--   ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_status_valido;
--   ALTER TABLE envios ADD CONSTRAINT envios_status_valido CHECK (status IN (
--     'pendente','cotado','gerado','postado','em_transito','entregue',
--     'devolvido','extraviado','cancelado','erro'));
--   ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_postado_tem_prova;
--   ALTER TABLE envios ADD CONSTRAINT envios_postado_tem_prova CHECK (
--     status NOT IN ('postado','em_transito','entregue')
--     OR codigo_rastreamento IS NOT NULL OR provider_ref IS NOT NULL);
--   DELETE FROM schema_migrations WHERE id = '0102_logistics_engine.sql';
--   COMMIT;

-- ----------------------------------------------------------------------------
-- 1) MOTOR DE REGRAS COMERCIAIS DE FRETE
--
-- A regra NÃO é acoplada a nenhuma transportadora: ela decide sobre a
-- COTAÇÃO (frete grátis, subsídio, restrição de modalidade, operador
-- preferencial). `condicoes`/`acoes` são JSONB avaliados pelo motor em
-- `modules/logistics/domain/rules.ts`. A prioridade decide o desempate (maior
-- primeiro). Vigência opcional.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_shipping_rules (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT,
  CONSTRAINT logistics_rules_store_ck CHECK (store_key IS NULL OR store_key IN ('RETAIL', 'WHOLESALE')),
  nome TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL,
  CONSTRAINT logistics_rules_tipo_ck CHECK (tipo IN (
    'FRETE_GRATIS_VALOR', 'FRETE_GRATIS_REGIAO', 'FRETE_SUBSIDIADO', 'DESCONTO_LOGISTICO',
    'RESTRICAO_MODALIDADE', 'OPERADOR_PREFERENCIAL', 'RESTRICAO_REGIAO'
  )),
  prioridade INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  condicoes JSONB NOT NULL DEFAULT '{}'::jsonb,
  acoes JSONB NOT NULL DEFAULT '{}'::jsonb,
  inicio_em TIMESTAMPTZ,
  fim_em TIMESTAMPTZ,
  CONSTRAINT logistics_rules_vigencia_ck CHECK (
    inicio_em IS NULL OR fim_em IS NULL OR fim_em >= inicio_em
  ),
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_logistics_rules_ativas
  ON logistics_shipping_rules (empresa_id, ativo, prioridade DESC);
CREATE INDEX IF NOT EXISTS ix_logistics_rules_store
  ON logistics_shipping_rules (empresa_id, store_key) WHERE store_key IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) COTAÇÕES
--
-- Uma cotação é uma FOTOGRAFIA: guarda os parâmetros usados, o provedor, a
-- modalidade, as opções devolvidas (JSONB) e a REFERÊNCIA da resposta externa.
-- Quando o provedor está indisponível, a cotação é gravada com `estado` de
-- falha e o MOTIVO técnico — nunca um valor fictício. O `fingerprint` dá a
-- identidade lógica (mesma venda + mesmos parâmetros) para reaproveitar uma
-- cotação válida e evitar chamadas repetidas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_quotes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT,
  CONSTRAINT logistics_quotes_store_ck CHECK (store_key IS NULL OR store_key IN ('RETAIL', 'WHOLESALE')),
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  modalidade TEXT,
  estado TEXT NOT NULL DEFAULT 'OK',
  CONSTRAINT logistics_quotes_estado_ck CHECK (estado IN (
    'OK', 'PROVIDER_UNAVAILABLE', 'CREDENTIALS_MISSING', 'QUOTE_FAILED',
    'INVALID_DESTINATION', 'NO_SERVICE_AVAILABLE'
  )),
  cep_origem TEXT,
  cep_destino TEXT,
  peso_g INTEGER,
  volumes INTEGER,
  valor_declarado NUMERIC(12,2),
  valor_pedido NUMERIC(12,2),
  opcoes JSONB NOT NULL DEFAULT '[]'::jsonb,
  opcao_selecionada TEXT,
  valor_escolhido NUMERIC(12,2),
  prazo_escolhido INTEGER,
  frete_gratis BOOLEAN NOT NULL DEFAULT FALSE,
  subsidio NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_final NUMERIC(12,2),
  referencia_externa TEXT,
  motivo TEXT,
  fingerprint TEXT NOT NULL,
  valida_ate TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT logistics_quotes_valores_ck CHECK (
    (valor_escolhido IS NULL OR valor_escolhido >= 0)
    AND subsidio >= 0
    AND (valor_final IS NULL OR valor_final >= 0)
  )
);

CREATE INDEX IF NOT EXISTS ix_logistics_quotes_venda
  ON logistics_quotes (empresa_id, venda_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_logistics_quotes_fingerprint
  ON logistics_quotes (empresa_id, fingerprint, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_logistics_quotes_store
  ON logistics_quotes (empresa_id, store_key) WHERE store_key IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) VOLUMES (PACKAGES)
--
-- Uma remessa pode ter MAIS DE UM volume. Cada volume tem peso/dimensões e o
-- próprio código de rastreio quando a transportadora individualiza.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_packages (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  indice INTEGER NOT NULL DEFAULT 1,
  peso_g INTEGER,
  altura_cm NUMERIC(8,2),
  largura_cm NUMERIC(8,2),
  comprimento_cm NUMERIC(8,2),
  codigo_rastreamento TEXT,
  provider_ref TEXT,
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT logistics_packages_indice_ck CHECK (indice >= 1),
  CONSTRAINT logistics_packages_peso_ck CHECK (peso_g IS NULL OR peso_g >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_packages_indice
  ON logistics_packages (envio_id, indice);
CREATE INDEX IF NOT EXISTS ix_logistics_packages_envio
  ON logistics_packages (empresa_id, envio_id);

-- ----------------------------------------------------------------------------
-- 4) ETIQUETAS
--
-- A etiqueta aponta para a referência EXTERNA do operador e guarda os
-- metadados. O documento em si fica em `arquivos` (com controle de acesso) ou é
-- buscado sob demanda na API do operador — NUNCA em caminho público.
-- Idempotente por (empresa, envio, chave).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_labels (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  url_externa TEXT,
  arquivo_id INTEGER,
  mime TEXT,
  tamanho_bytes INTEGER,
  estado TEXT NOT NULL DEFAULT 'PENDENTE',
  CONSTRAINT logistics_labels_estado_ck CHECK (estado IN ('PENDENTE', 'GERADA', 'ERRO', 'CANCELADA')),
  idempotency_key TEXT,
  erro TEXT,
  gerada_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_labels_idempotency
  ON logistics_labels (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_logistics_labels_envio
  ON logistics_labels (empresa_id, envio_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 5) INBOX DE WEBHOOKS DE TRANSPORTADORA
--
-- DURÁVEL e idempotente. A entrega é identificada por (empresa, provedor,
-- delivery_id) quando o operador informa o ID; sem ele, a dedupe alternativa é
-- (empresa, provedor, hash do corpo). `recebido_em` alimenta a proteção de
-- replay (janela de tolerância validada em `webhookSeguranca`).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_webhook_inbox (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  provider TEXT NOT NULL,
  external_delivery_id TEXT,
  event_type TEXT,
  payload JSONB,
  payload_hash TEXT NOT NULL,
  assinatura_ok BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'recebido',
  CONSTRAINT logistics_webhook_inbox_status_ck CHECK (status IN (
    'recebido', 'enfileirado', 'processado', 'erro', 'rejeitado', 'duplicado'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outbox_id INTEGER,
  correlation_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_webhook_delivery
  ON logistics_webhook_inbox (empresa_id, provider, external_delivery_id)
  WHERE external_delivery_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_webhook_dedupe
  ON logistics_webhook_inbox (empresa_id, provider, event_type, payload_hash)
  WHERE external_delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_logistics_webhook_provider_status
  ON logistics_webhook_inbox (empresa_id, provider, status, received_at DESC);
CREATE INDEX IF NOT EXISTS ix_logistics_webhook_pendentes
  ON logistics_webhook_inbox (status, received_at) WHERE status IN ('recebido', 'enfileirado');

-- ----------------------------------------------------------------------------
-- 6) AUDITORIA LOGÍSTICA
--
-- Trilha própria das operações do módulo (regras, cotação, remessa, etiqueta,
-- rastreio, reconciliação). `dados` guarda a evidência MINIMIZADA — nunca
-- credencial, token ou PII de terceiro.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logistics_audit_logs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT,
  entidade TEXT NOT NULL,
  entidade_id INTEGER,
  acao TEXT NOT NULL,
  descricao TEXT,
  dados JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_logistics_audit_entidade
  ON logistics_audit_logs (empresa_id, entidade, entidade_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 7) COLUNAS ADITIVAS EM `envios`
-- ----------------------------------------------------------------------------
ALTER TABLE envios ADD COLUMN IF NOT EXISTS store_key TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS modalidade TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS quote_id INTEGER;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS servico_nome TEXT;
ALTER TABLE envios ADD COLUMN IF NOT EXISTS custo_previsto NUMERIC(12,2);
ALTER TABLE envios ADD COLUMN IF NOT EXISTS custo_efetivo NUMERIC(12,2);

-- A loja de origem é RETAIL/WHOLESALE ou vazio (fluxo single-store legado).
ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_store_ck;
ALTER TABLE envios ADD CONSTRAINT envios_store_ck CHECK (
  store_key IS NULL OR store_key IN ('RETAIL', 'WHOLESALE')
);
CREATE INDEX IF NOT EXISTS ix_envios_store
  ON envios (empresa_id, store_key, status) WHERE store_key IS NOT NULL;

-- AMPLIAÇÃO do conjunto de status: SUPERset do anterior (todo status antigo
-- permanece válido). Acrescenta os estados do ciclo logístico completo sem
-- renomear os existentes — a operação atual não muda de comportamento.
ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_status_valido;
ALTER TABLE envios ADD CONSTRAINT envios_status_valido CHECK (status IN (
  'pendente', 'cotado', 'pronto_expedicao', 'separacao', 'embalada',
  'etiqueta_pendente', 'etiqueta_gerada', 'gerado', 'postado', 'em_transito',
  'em_rota', 'entregue', 'tentativa_falha', 'devolvido', 'extraviado',
  'cancelado', 'erro'
));

-- A prova de postagem continua obrigatória nos estados que afirmam movimento.
ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_postado_tem_prova;
ALTER TABLE envios ADD CONSTRAINT envios_postado_tem_prova CHECK (
  status NOT IN ('postado', 'em_transito', 'em_rota', 'entregue')
  OR codigo_rastreamento IS NOT NULL OR provider_ref IS NOT NULL
);

-- ----------------------------------------------------------------------------
-- 8) COLUNAS ADITIVAS EM `envio_eventos` + DEDUPE DE EVENTOS
--
-- `status_normalizado` é o status do ERP derivado do status bruto do operador.
-- `dedupe_key` é a identidade do evento (código + status bruto + instante) e o
-- índice único parcial garante a IDEMPOTÊNCIA — um evento reentregue não vira
-- duas linhas.
-- ----------------------------------------------------------------------------
ALTER TABLE envio_eventos ADD COLUMN IF NOT EXISTS status_normalizado TEXT;
ALTER TABLE envio_eventos ADD COLUMN IF NOT EXISTS external_code TEXT;
ALTER TABLE envio_eventos ADD COLUMN IF NOT EXISTS origem TEXT;
ALTER TABLE envio_eventos ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_evento_dedupe
  ON envio_eventos (envio_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_logistics_evento_status
  ON envio_eventos (empresa_id, envio_id, status_normalizado);
