-- ============================================================================
-- 0055 — FISCAL: OBRIGAÇÕES ACESSÓRIAS, CALENDÁRIO E ENTREGAS
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O módulo fiscal já emite NF-e/NFC-e (documento, evento, cancelamento,
-- inutilização, config por empresa). O que NÃO existia era o controle das
-- OBRIGAÇÕES ACESSÓRIAS: quais declarações a empresa entrega, em que
-- periodicidade, até que dia, com que protocolo e onde está o arquivo. Sem
-- isso, "estamos em dia com o SPED?" não tem resposta no sistema.
--
-- O QUE ENTRA
--   1) `fiscal_obrigacoes` — a REGRA da obrigação por empresa: código, nome,
--      tipo, periodicidade, dia de vencimento, ativo. É cadastro: quem sabe a
--      regra é o contador da empresa, não o código.
--   2) `fiscal_obrigacao_entregas` — a ENTREGA de uma competência: status,
--      protocolo, arquivo de referência, data e responsável.
--
-- O QUE NÃO ENTRA (de propósito)
--   • NENHUMA alíquota, NENHUM cálculo de imposto, NENHUM layout de SPED é
--     embutido aqui. Alíquota hard-coded é erro fiscal esperando acontecer; o
--     motor tributário continua sendo `fiscalRegras.ts`, alimentado por regra
--     cadastrada, e o SPED é arquivo gerado fora do ERP (referenciado por
--     `arquivo_ref`).
--   • Nada é apagado: obrigação sai de uso por `ativo = false`, entrega por
--     `dispensada` (com motivo).
-- ============================================================================

CREATE TABLE IF NOT EXISTS fiscal_obrigacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  periodicidade TEXT NOT NULL DEFAULT 'mensal',
  dia_vencimento INTEGER NOT NULL DEFAULT 15,
  -- Competência em que a obrigação passa a valer (permite cadastrar histórico
  -- sem reescrever o passado).
  inicio_competencia DATE,
  responsavel_id INTEGER REFERENCES usuarios(id),
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_obrigacoes_codigo_unico
  ON fiscal_obrigacoes (empresa_id, codigo);

CREATE INDEX IF NOT EXISTS fiscal_obrigacoes_empresa_idx
  ON fiscal_obrigacoes (empresa_id, ativo, tipo);

DO $$ BEGIN
  ALTER TABLE fiscal_obrigacoes ADD CONSTRAINT fiscal_obrigacoes_tipo_valido
    CHECK (tipo IN ('sped_fiscal', 'sped_contribuicoes', 'efd_reinf', 'dctfweb', 'esocial',
                    'sitfis', 'defis', 'das', 'nfe_mensal', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fiscal_obrigacoes ADD CONSTRAINT fiscal_obrigacoes_periodicidade_valida
    CHECK (periodicidade IN ('mensal', 'trimestral', 'anual', 'eventual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fiscal_obrigacoes ADD CONSTRAINT fiscal_obrigacoes_vencimento_valido
    CHECK (dia_vencimento BETWEEN 1 AND 31);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fiscal_obrigacao_entregas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  obrigacao_id INTEGER NOT NULL REFERENCES fiscal_obrigacoes(id),
  -- Competência normalizada AAAA-MM: uma entrega por competência.
  competencia TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  protocolo TEXT,
  arquivo_ref TEXT,
  entregue_em TIMESTAMPTZ,
  responsavel_id INTEGER REFERENCES usuarios(id),
  motivo_dispensa TEXT,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_entregas_competencia_unica
  ON fiscal_obrigacao_entregas (empresa_id, obrigacao_id, competencia);

CREATE INDEX IF NOT EXISTS fiscal_entregas_empresa_idx
  ON fiscal_obrigacao_entregas (empresa_id, competencia, status);

DO $$ BEGIN
  ALTER TABLE fiscal_obrigacao_entregas ADD CONSTRAINT fiscal_entregas_competencia_formato
    CHECK (competencia ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fiscal_obrigacao_entregas ADD CONSTRAINT fiscal_entregas_status_valido
    CHECK (status IN ('pendente', 'entregue', 'atrasada', 'dispensada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Entrega marcada como ENTREGUE exige protocolo e data (nada de "entregue"
-- sem prova); dispensada exige motivo.
DO $$ BEGIN
  ALTER TABLE fiscal_obrigacao_entregas ADD CONSTRAINT fiscal_entregas_coerente
    CHECK (
      (status <> 'entregue' OR (entregue_em IS NOT NULL AND protocolo IS NOT NULL AND btrim(protocolo) <> ''))
      AND (status <> 'dispensada' OR (motivo_dispensa IS NOT NULL AND btrim(motivo_dispensa) <> ''))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
