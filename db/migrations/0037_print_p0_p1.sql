-- ============================================================================
-- 0037 — IMPRESSÃO P0/P1: FILA PERSISTENTE (PrintIR) + AGENTES LOCAIS
--
-- Fundação do programa de impressão profissional:
--
--   ERP ──► PrintIR ──► print_jobs (esta fila) ──► claim/lease ──► agente local
--
-- Tabelas (todas multiempresa via empresa_id, como o restante do ERP):
--   • print_jobs          — a fila. Máquina de estados QUEUED → CLAIMED →
--                           PRINTING → PRINTED | FAILED | CANCELLED, com
--                           lease (claimed_by_agent_id + lease_expires_at +
--                           lease_token_hash), retry com backoff
--                           (attempts/max_attempts/next_retry_at) e
--                           idempotência por (empresa_id, idempotency_key).
--   • print_agents        — machine identity: cada instalação do agente tem
--                           machine_id próprio e token REVOGÁVEL (só o hash
--                           SHA-256 é guardado). Não é o JWT de usuário.
--   • print_pairing_codes — código temporário de uso único que o ERP emite
--                           (gerente+) e o agente troca pela machine identity.
--   • print_agent_nonces  — replay protection das chamadas do agente
--                           (nonce único por agente + janela de timestamp).
--
-- Idempotência (adaptada do padrão de documentos fiscais, migration 0020 —
-- NÃO copiada cegamente: lá a chave protege a EMISSÃO de um documento único;
-- aqui ela protege a IMPRESSÃO FÍSICA, então ela é NOT NULL e acompanha um
-- content_hash: mesma chave com conteúdo diferente é conflito (409), nunca
-- uma segunda impressão silenciosa).
--
-- Claim atômico: a aplicação reivindica com UPDATE condicional (tryUpdateIf:
-- status esperado + agente esperado) — em concorrência, exatamente um agente
-- afeta a linha. Os índices abaixo servem a varredura de candidatos
-- (empresa, status, prioridade, ordem de chegada) e à expiração de lease.
--
-- Idempotente (CREATE ... IF NOT EXISTS). Reversível: nenhuma tabela
-- existente é alterada; o rollback é o DROP das quatro tabelas novas
-- (ver bloco comentado no fim — o runner só anda para frente).
-- ============================================================================

CREATE TABLE IF NOT EXISTS print_agents (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  machine_id TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  terminal TEXT,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ativo',
  agent_version TEXT,
  platform TEXT,
  printers JSONB,
  last_heartbeat_at TIMESTAMPTZ,
  last_ip TEXT,
  paired_by INTEGER REFERENCES usuarios(id),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_agents_status_valido CHECK (status IN ('ativo', 'revogado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agents_machine ON print_agents (machine_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agents_token_hash ON print_agents (token_hash);
CREATE INDEX IF NOT EXISTS print_agents_empresa_status_idx ON print_agents (empresa_id, status);

CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  public_id TEXT NOT NULL,
  ir_version INTEGER NOT NULL DEFAULT 1,
  doc_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  terminal TEXT,
  printer_name TEXT,
  copies INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by_agent_id INTEGER REFERENCES print_agents(id),
  lease_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error TEXT,
  permanent_error BOOLEAN NOT NULL DEFAULT false,
  reprint_of TEXT,
  requested_by INTEGER REFERENCES usuarios(id),
  claimed_at TIMESTAMPTZ,
  printing_at TIMESTAMPTZ,
  printed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_jobs_status_valido CHECK (status IN ('QUEUED', 'CLAIMED', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED')),
  CONSTRAINT print_jobs_copies_valido CHECK (copies >= 1 AND copies <= 99),
  CONSTRAINT print_jobs_priority_valido CHECK (priority >= 0 AND priority <= 100),
  CONSTRAINT print_jobs_attempts_valido CHECK (attempts >= 0 AND max_attempts >= 1 AND max_attempts <= 20),
  -- Job em voo (CLAIMED/PRINTING) SEMPRE tem dono e lease: sem isso, um job
  -- órfão ficaria preso para sempre em vez de voltar à fila na expiração.
  CONSTRAINT print_jobs_em_voo_tem_lease CHECK (
    status NOT IN ('CLAIMED', 'PRINTING')
    OR (claimed_by_agent_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT print_jobs_impresso_tem_data CHECK (status <> 'PRINTED' OR printed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_public_id ON print_jobs (public_id);
-- A garantia física da idempotência: uma chave, uma empresa, UM job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_idempotency ON print_jobs (empresa_id, idempotency_key);
-- Varredura do claim: empresa + estado, prioridade maior primeiro, FIFO no empate.
CREATE INDEX IF NOT EXISTS print_jobs_claim_idx ON print_jobs (empresa_id, status, priority DESC, criado_em ASC, id ASC);
CREATE INDEX IF NOT EXISTS print_jobs_terminal_idx ON print_jobs (empresa_id, terminal, status) WHERE terminal IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_lease_idx ON print_jobs (lease_expires_at) WHERE status IN ('CLAIMED', 'PRINTING');
CREATE INDEX IF NOT EXISTS print_jobs_empresa_criado_idx ON print_jobs (empresa_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS print_pairing_codes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  code_hash TEXT NOT NULL,
  terminal TEXT,
  nome_sugerido TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_agent_id INTEGER REFERENCES print_agents(id),
  tentativas INTEGER NOT NULL DEFAULT 0,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_pairing_code_hash ON print_pairing_codes (code_hash);
CREATE INDEX IF NOT EXISTS print_pairing_empresa_idx ON print_pairing_codes (empresa_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS print_agent_nonces (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  agent_id INTEGER NOT NULL REFERENCES print_agents(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agent_nonces ON print_agent_nonces (agent_id, nonce);
CREATE INDEX IF NOT EXISTS print_agent_nonces_criado_idx ON print_agent_nonces (criado_em);

-- ============================================================================
-- ROLLBACK MANUAL (o runner de migrações só anda para frente; executar à mão
-- somente em ambiente de desenvolvimento, nunca em produção com histórico):
--
--   DROP TABLE IF EXISTS print_agent_nonces;
--   DROP TABLE IF EXISTS print_pairing_codes;
--   DROP TABLE IF EXISTS print_jobs;
--   DROP TABLE IF EXISTS print_agents;
--   DELETE FROM schema_migrations WHERE id = '0037_print_p0_p1.sql';
-- ============================================================================
