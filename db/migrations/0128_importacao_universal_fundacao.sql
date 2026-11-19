-- Universal Data Ingestion Engine foundation (0128).
-- Additive only. Preserves original source file bytes and import-session state.
CREATE TABLE IF NOT EXISTS importacao_universal_sessoes (
  id UUID PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  nome_arquivo TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  tamanho_bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  arquivo_original BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'recebido',
  versao INTEGER NOT NULL DEFAULT 1,
  inventario_abas JSONB NOT NULL DEFAULT '[]'::jsonb,
  interpretacao JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliacao JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  aprovacao_usuario_id INTEGER REFERENCES usuarios(id) ON DELETE RESTRICT,
  aprovado_em TIMESTAMPTZ,
  importacao_iniciada_em TIMESTAMPTZ,
  importacao_finalizada_em TIMESTAMPTZ,
  resultado JSONB,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT importacao_universal_sessoes_status_ck CHECK (
    status IN ('recebido','analisando','aguardando_mapeamento','aguardando_aprovacao','aprovado','importando','concluido','falhou','cancelado')
  ),
  CONSTRAINT importacao_universal_sessoes_tamanho_ck CHECK (tamanho_bytes >= 0),
  CONSTRAINT importacao_universal_sessoes_versao_ck CHECK (versao >= 1),
  CONSTRAINT importacao_universal_sessoes_sha_ck CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT importacao_universal_sessoes_abas_array_ck CHECK (jsonb_typeof(inventario_abas) = 'array'),
  CONSTRAINT importacao_universal_sessoes_interpretacao_obj_ck CHECK (jsonb_typeof(interpretacao) = 'object'),
  CONSTRAINT importacao_universal_sessoes_reconciliacao_obj_ck CHECK (jsonb_typeof(reconciliacao) = 'object'),
  CONSTRAINT importacao_universal_sessoes_preview_obj_ck CHECK (jsonb_typeof(preview) = 'object'),
  CONSTRAINT importacao_universal_sessoes_aprovacao_ck CHECK (
    (status IN ('aprovado','importando','concluido') AND aprovacao_usuario_id IS NOT NULL AND aprovado_em IS NOT NULL)
    OR status NOT IN ('aprovado','importando','concluido')
  )
);
CREATE INDEX IF NOT EXISTS importacao_universal_sessoes_empresa_usuario_idx
  ON importacao_universal_sessoes (empresa_id, usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS importacao_universal_sessoes_empresa_status_idx
  ON importacao_universal_sessoes (empresa_id, status, atualizado_em DESC);
CREATE UNIQUE INDEX IF NOT EXISTS importacao_universal_sessoes_empresa_sha_idx
  ON importacao_universal_sessoes (empresa_id, usuario_id, sha256);
