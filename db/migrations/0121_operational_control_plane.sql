-- ============================================================================
-- 0121 — OPERATIONAL CONTROL PLANE + OAUTH 2.1 (Resource Server MCP)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O Diretor precisa operar o ERP por ferramentas MCP (ChatGPT) sem entregar
-- credencial ao agente e sem permitir execução arbitrária. Este é o núcleo de
-- SEGURANÇA E GOVERNANÇA dessa integração:
--
--   • operational_operations      — a SOLICITAÇÃO de operação (allowlist de
--     workflow, hash dos parâmetros, idempotência, prazo de validade);
--   • operational_approvals       — a APROVAÇÃO HUMANA, vinculada ao hash dos
--     parâmetros, de USO ÚNICO, com prazo;
--   • operational_executions      — o acompanhamento da execução no GitHub
--     Actions (run_id, status, conclusão, URL);
--   • operational_audit_events    — a trilha encadeada (previous_hash /
--     event_hash) dos eventos da operação;
--   • oauth_clients / oauth_authorization_codes / oauth_tokens / oauth_consents
--     — o Authorization Server OAuth 2.1 (Authorization Code + PKCE S256).
--
-- REGRAS (não negociáveis)
--   • ADITIVA e IDEMPOTENTE: nenhum DROP de dado/coluna, nenhum backfill.
--   • MULTIEMPRESA: toda tabela operacional carrega `empresa_id` com FK para
--     `empresas` e o escopo é aplicado pelo endpoint próprio (o CRUD genérico
--     não as expõe — mesmo padrão de logistics_*/payment_*).
--   • CONVENÇÃO DE CHAVE: como todas as tabelas do ERP, a chave primária é
--     `id SERIAL`. O identificador OPACO exposto pela API (`op_...`, `exec_...`)
--     vive em `public_id` (UNIQUE) — assim o store (pgstore/memdb) continua
--     sendo a única porta de acesso, sem uma segunda camada de persistência.
--   • O token OAuth NÃO é o JWT de sessão do ERP: mecanismos separados
--     (issuer, audience e chave próprios). Aqui só a ESTRUTURA; a emissão
--     vive em modules/operational-control/oauth.
--   • Aprovação é de USO ÚNICO: `consumed_at` marca o consumo atômico no
--     dispatch (CAS). Reutilizar é recusado.
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS oauth_consents;
--   DROP TABLE IF EXISTS oauth_tokens;
--   DROP TABLE IF EXISTS oauth_authorization_codes;
--   DROP TABLE IF EXISTS oauth_clients;
--   DROP TABLE IF EXISTS operational_audit_events;
--   DROP TABLE IF EXISTS operational_executions;
--   DROP TABLE IF EXISTS operational_approvals;
--   DROP TABLE IF EXISTS operational_operations;
--   DELETE FROM schema_migrations WHERE id = '0121_operational_control_plane.sql';
--   COMMIT;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) OPERAÇÕES — a SOLICITAÇÃO (nunca a execução)
--
-- `workflow_key` referencia o REGISTRO INTERNO (WORKFLOW_REGISTRY em
-- modules/operational-control/domain/workflow-registry.ts). O cliente NUNCA
-- envia repositório, arquivo de workflow, branch arbitrária ou comando: o
-- servidor resolve tudo do registro. `parameters_hash` é o vínculo entre a
-- operação e a aprovação — mudar o parâmetro invalida a aprovação.
-- `idempotency_key` é única por empresa: a mesma chave com os MESMOS parâmetros
-- devolve a operação existente; com parâmetros diferentes, 409.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_operations (
  id SERIAL PRIMARY KEY,
  public_id TEXT NOT NULL,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  operation_type TEXT NOT NULL,
  CONSTRAINT operational_operations_type_ck CHECK (operation_type IN (
    'workflow.dispatch', 'diagnostic.read_only'
  )),
  workflow_key TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES usuarios(id),
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT operational_operations_parameters_obj_ck CHECK (jsonb_typeof(parameters) = 'object'),
  parameters_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  CONSTRAINT operational_operations_status_ck CHECK (status IN (
    'requested', 'pending_approval', 'rejected', 'expired', 'cancelled',
    'approved', 'dispatching', 'dispatch_failed', 'dispatched',
    'running', 'completed', 'failed', 'unknown'
  )),
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
  requested_scopes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operational_operations_idempotency_nao_vazia CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT operational_operations_reason_nao_vazia CHECK (btrim(reason) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_operations_public_id
  ON operational_operations (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_operations_idempotencia
  ON operational_operations (empresa_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_operational_operations_empresa_status
  ON operational_operations (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_operational_operations_workflow
  ON operational_operations (empresa_id, workflow_key, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 2) APROVAÇÕES — decisão HUMANA, vinculada ao hash dos parâmetros, uso único
--
-- No máximo UMA aprovação 'approve' por operação (índice parcial): repetir a
-- aprovação é conflito, não empilha. `consumed_at` é gravado de forma atômica
-- no dispatch (CAS) — uma aprovação nunca é reutilizada.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_approvals (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  operation_id INTEGER NOT NULL REFERENCES operational_operations(id),
  approved_by INTEGER NOT NULL REFERENCES usuarios(id),
  decision TEXT NOT NULL,
  CONSTRAINT operational_approvals_decision_ck CHECK (decision IN ('approve', 'reject')),
  parameters_hash TEXT NOT NULL,
  confirmation TEXT,
  reason TEXT,
  consumed_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_approvals_aprovacao
  ON operational_approvals (operation_id) WHERE decision = 'approve';
CREATE INDEX IF NOT EXISTS ix_operational_approvals_operacao
  ON operational_approvals (operation_id, decided_at DESC);

-- ----------------------------------------------------------------------------
-- 3) EXECUÇÕES — acompanhamento do GitHub Actions (uma por operação)
--
-- `github_run_id` só existe DEPOIS do dispatch aceito pelo GitHub. `status` é o
-- estado NORMALIZADO (nunca o valor bruto da API externa). Sem webhook, a
-- reconciliação por consulta mantém o estado atualizado (nunca fica parado).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_executions (
  id SERIAL PRIMARY KEY,
  public_id TEXT NOT NULL,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  operation_id INTEGER NOT NULL REFERENCES operational_operations(id),
  workflow_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  github_run_id BIGINT,
  status TEXT NOT NULL DEFAULT 'not_dispatched',
  CONSTRAINT operational_executions_status_ck CHECK (status IN (
    'not_dispatched', 'queued', 'in_progress', 'completed', 'failed',
    'cancelled', 'unknown'
  )),
  conclusion TEXT,
  html_url TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_executions_public_id
  ON operational_executions (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_executions_operacao
  ON operational_executions (operation_id);
CREATE INDEX IF NOT EXISTS ix_operational_executions_empresa_status
  ON operational_executions (empresa_id, status, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 4) AUDITORIA OPERACIONAL — cadeia de hashes POR OPERAÇÃO (tamper-evidence)
--
-- Cada evento assina SHA-256(hash_anterior | payload canônico). Editar um
-- evento quebra o hash dele; remover um quebra a cadeia do seguinte. NUNCA
-- grava token, secret, senha ou corpo remoto bruto.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_audit_events (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  operation_id INTEGER,
  actor_id INTEGER,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT operational_audit_payload_obj_ck CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_hash TEXT,
  event_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_operational_audit_operacao
  ON operational_audit_events (operation_id, id);
CREATE INDEX IF NOT EXISTS ix_operational_audit_empresa
  ON operational_audit_events (empresa_id, id DESC);

-- ----------------------------------------------------------------------------
-- 5) OAUTH 2.1 — Authorization Server (Authorization Code + PKCE S256)
--
-- `oauth_clients` é GLOBAL (não tem empresa_id): o cliente é a aplicação
-- (ChatGPT), não o tenant. Códigos e tokens carregam `empresa_id` porque o
-- acesso é recortado pela empresa do usuário no momento do consentimento.
-- O token de acesso é ASSINADO e curto (JWT RS256, 15 min); guardamos o `jti`
-- para permitir REVOGAÇÃO — o JWT é validado por assinatura e, quando presente,
-- o `jti` é conferido contra esta tabela.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_clients (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  confidential BOOLEAN NOT NULL DEFAULT FALSE,
  secret_hash TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_clients_client_id_nao_vazio CHECK (btrim(client_id) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_clients_client_id ON oauth_clients (client_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id SERIAL PRIMARY KEY,
  code_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  perfil TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  CONSTRAINT oauth_codes_pkce_ck CHECK (code_challenge_method = 'S256'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_codes_hash ON oauth_authorization_codes (code_hash);
CREATE INDEX IF NOT EXISTS ix_oauth_codes_expira ON oauth_authorization_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  jti TEXT NOT NULL,
  client_id TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  scope TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL DEFAULT 'access',
  CONSTRAINT oauth_tokens_tipo_ck CHECK (tipo IN ('access', 'refresh')),
  parent_jti TEXT,
  refresh_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_tokens_jti ON oauth_tokens (jti);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_tokens_refresh ON oauth_tokens (refresh_hash)
  WHERE refresh_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_oauth_tokens_usuario ON oauth_tokens (usuario_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS oauth_consents (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  client_id TEXT NOT NULL,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  scope TEXT NOT NULL DEFAULT '',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_consents_ativo
  ON oauth_consents (usuario_id, client_id, empresa_id) WHERE revoked_at IS NULL;
