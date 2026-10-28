-- ============================================================================
-- 0060 — UNIDADES DE MEDIDA E CONVERSÃO DECLARADA (P3-04 / P3-07)
--
-- O PROBLEMA
-- ----------
-- `insumos.unidade` é TEXTO livre ('m', 'kg', 'rolo'...). Compra-se em ROLO e
-- consome-se em METRO. Sem uma regra explícita, qualquer conversão seria
-- inventada pelo sistema — e um MRP que inventa fator erra a compra em silêncio.
--
-- A DECISÃO
-- ---------
-- O ERP NÃO conhece conversão universal. Ele conhece as conversões que a EMPRESA
-- DECLAROU, e só usa essas:
--   • `unidades_medida`     — catálogo por empresa (código, grandeza, casas);
--   • `unidade_conversoes`  — regra de fator entre dois códigos, por empresa;
--   • `insumos.unidade_compra` — a unidade em que o insumo é COMPRADO (opcional,
--     porque nem todo insumo tem unidade de compra diferente).
--
-- Sem regra declarada, o serviço (server/src/unidades.ts) devolve `null` — e o
-- MRP declara `conversao_ausente: true` em vez de converter no chute.
--
-- O QUE NÃO É FEITO AQUI
-- ----------------------
--   • não há conversão entre grandezas diferentes (massa ↔ comprimento): a
--     grandeza é validada, e a regra entre grandezas distintas é recusada;
--   • não há tabela de fatores "de fábrica" — fator é dado da empresa;
--   • nenhuma linha existente é alterada (`unidade_compra` nasce NULL).
-- ============================================================================

CREATE TABLE IF NOT EXISTS unidades_medida (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  grandeza TEXT NOT NULL DEFAULT 'contagem',
  casas_decimais SMALLINT NOT NULL DEFAULT 2,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_unidades_medida_empresa_codigo
  ON unidades_medida (empresa_id, codigo);

DO $$ BEGIN
  ALTER TABLE unidades_medida ADD CONSTRAINT unidades_medida_grandeza_valida
    CHECK (grandeza IN ('comprimento', 'massa', 'volume', 'area', 'contagem', 'tempo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE unidades_medida ADD CONSTRAINT unidades_medida_casas_validas
    CHECK (casas_decimais BETWEEN 0 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS unidade_conversoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  de_codigo TEXT NOT NULL,
  para_codigo TEXT NOT NULL,
  /** 1 `de_codigo` = `fator` `para_codigo`. */
  fator NUMERIC(16,6) NOT NULL,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_unidade_conversoes_empresa_par
  ON unidade_conversoes (empresa_id, de_codigo, para_codigo);

DO $$ BEGIN
  ALTER TABLE unidade_conversoes ADD CONSTRAINT unidade_conversoes_fator_positivo
    CHECK (fator > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Converter 'm' para 'm' é identidade: a regra é recusada (regra com fator 1
-- esconde erro de cadastro de quem queria 'm' → 'cm').
DO $$ BEGIN
  ALTER TABLE unidade_conversoes ADD CONSTRAINT unidade_conversoes_par_distinto
    CHECK (de_codigo <> para_codigo);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Unidade de COMPRA do insumo (opcional). NULL = compra na mesma unidade de uso.
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS unidade_compra TEXT;

COMMENT ON COLUMN insumos.unidade_compra IS
  'P3-04/0060: unidade em que o insumo é comprado (ex.: rolo). NULL = compra na mesma unidade de uso (`insumos.unidade`). A conversão, quando diferente, tem de estar declarada em `unidade_conversoes` — o ERP não inventa fator.';
COMMENT ON TABLE unidade_conversoes IS
  'P3-04/0060: regra de conversão DECLARADA pela empresa (1 de_codigo = fator para_codigo). Única fonte de fator usada por estoque/compras/MRP.';
COMMENT ON TABLE unidades_medida IS
  'P3-04/0060: catálogo de unidades por empresa, com grandeza — impede conversão entre grandezas diferentes.';
