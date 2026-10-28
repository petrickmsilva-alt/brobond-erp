-- 0063 — SPED/EFD seguro: histórico de execuções e evidências imutáveis por API.
-- Não codifica leiautes, registros, campos, códigos, validações ou versões oficiais.
-- Sem um manifesto oficial configurado, toda tentativa termina em ERRO/NAO_SUPORTADO.

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_obrigacoes_empresa_id
  ON fiscal_obrigacoes (empresa_id, id);

CREATE TABLE IF NOT EXISTS fiscal_execucoes (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  obrigacao_id INTEGER NOT NULL,
  periodo TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  executed_by INTEGER REFERENCES usuarios(id),
  versao TEXT NOT NULL,
  execution_hash CHAR(64) NOT NULL,
  resultado TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_execucoes_obrigacao_empresa_fk
    FOREIGN KEY (empresa_id, obrigacao_id) REFERENCES fiscal_obrigacoes(empresa_id, id),
  CONSTRAINT fiscal_execucoes_periodo_formato CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT fiscal_execucoes_status_valido CHECK (status IN ('PENDENTE','EM_PROCESSAMENTO','VALIDADO','ERRO','ENTREGUE')),
  CONSTRAINT fiscal_execucoes_versao_nao_vazia CHECK (btrim(versao) <> ''),
  CONSTRAINT fiscal_execucoes_hash_formato CHECK (execution_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fiscal_execucoes_chave_idempotente UNIQUE (empresa_id, obrigacao_id, periodo, versao)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_execucoes_empresa_id
  ON fiscal_execucoes (empresa_id, id);

CREATE INDEX IF NOT EXISTS fiscal_execucoes_empresa_periodo_idx
  ON fiscal_execucoes (empresa_id, obrigacao_id, periodo, criado_em DESC);

CREATE TABLE IF NOT EXISTS fiscal_execucao_evidencias (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  execucao_id BIGINT NOT NULL,
  arquivo_ref TEXT NOT NULL,
  hash_sha256 CHAR(64) NOT NULL,
  tamanho_bytes BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id INTEGER REFERENCES usuarios(id),
  resultado TEXT NOT NULL,
  CONSTRAINT fiscal_execucao_evidencias_execucao_empresa_fk
    FOREIGN KEY (empresa_id, execucao_id) REFERENCES fiscal_execucoes(empresa_id, id),
  CONSTRAINT fiscal_execucao_evidencias_hash_formato CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fiscal_execucao_evidencias_tamanho_positivo CHECK (tamanho_bytes > 0),
  CONSTRAINT fiscal_execucao_evidencias_resultado_valido CHECK (btrim(resultado) <> '')
);

CREATE INDEX IF NOT EXISTS fiscal_execucao_evidencias_execucao_idx
  ON fiscal_execucao_evidencias (empresa_id, execucao_id, timestamp);

COMMENT ON TABLE fiscal_execucoes IS
  'Histórico append-only via API de tentativas fiscais por empresa/obrigação/período/versão. Sem manifesto oficial, tentativa registra ERRO/NAO_SUPORTADO; não gera SPED inventado.';
COMMENT ON TABLE fiscal_execucao_evidencias IS
  'Metadados append-only de evidências externas: referência, SHA-256, tamanho, timestamp, usuário e resultado. Não altera o arquivo referenciado.';
