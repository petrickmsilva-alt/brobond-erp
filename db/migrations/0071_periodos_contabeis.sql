-- Períodos controlam somente a escrituração importada no livro financeiro
-- existente; não são um segundo ledger nem um fechamento fiscal automático.
CREATE TABLE IF NOT EXISTS fin_periodos_contabeis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  competencia DATE NOT NULL CHECK (EXTRACT(DAY FROM competencia) = 1),
  estado TEXT NOT NULL CHECK (estado IN ('aberto', 'fechado')),
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) BETWEEN 8 AND 500),
  alterado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_periodos_empresa_competencia_uq UNIQUE (empresa_id, competencia)
);
CREATE INDEX IF NOT EXISTS fin_periodos_empresa_estado_idx ON fin_periodos_contabeis (empresa_id, estado, competencia DESC);
