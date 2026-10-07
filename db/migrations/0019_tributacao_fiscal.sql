-- ============================================================================
-- 0019 — TRIBUTAÇÃO DO PRODUTO + MOTOR DE REGRAS FISCAIS EXTENSÍVEL
--
-- Objetivo: tirar alíquota de dentro do código e dar à emissão fiscal (NF-e /
-- NFC-e) e ao motor de margem a MESMA fonte de verdade tributária.
--
--   • `produtos` ganha o cadastro fiscal próprio (CEST, origem, CFOP padrão,
--     CST/alíquota de ICMS, PIS, COFINS e IPI).
--   • `regras_fiscais` é a camada EXTENSÍVEL: casa por empresa, NCM (prefixo),
--     UF de destino, regime e operação, com prioridade e vigência. O que o
--     produto não define, a regra resolve; o que nenhuma regra resolve cai no
--     padrão da empresa.
--   • `impostos_ncm` (motor 1. MEU NEGÓCIOS) NÃO é tocado: ele continua sendo
--     a carga tributária efetiva usada no cálculo de margem. As regras fiscais
--     tratam do documento fiscal, que é outra pergunta.
--
-- Idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Cadastro tributário do produto
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cest TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT '0';  -- 0..8 (NF-e)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cfop_saida TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS icms_cst TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS icms_aliquota NUMERIC(5,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS pis_cst TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS pis_aliquota NUMERIC(5,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cofins_cst TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cofins_aliquota NUMERIC(5,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ipi_cst TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ipi_aliquota NUMERIC(5,2);

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_origem_valida CHECK (origem ~ '^[0-8]$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_cest_valido
    CHECK (cest IS NULL OR cest = '' OR regexp_replace(cest, '[^0-9]', '', 'g') ~ '^[0-9]{7}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2) Regras fiscais — camada extensível, por empresa
--
-- Resolução: filtra as regras vigentes e aplicáveis, ordena por
-- especificidade (prioridade DESC, comprimento do NCM DESC, UF específica
-- antes de curinga) e aplica a primeira.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regras_fiscais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  -- Critérios de casamento (NULL/'' = curinga)
  ncm TEXT,                                   -- prefixo de 2 a 8 dígitos
  uf_destino TEXT,                            -- 'SP', 'MG'... NULL = qualquer
  operacao TEXT NOT NULL DEFAULT 'saida',     -- saida | entrada
  modelo TEXT,                                -- '55' NF-e | '65' NFC-e | NULL = ambos
  consumidor_final BOOLEAN,                   -- NULL = indiferente
  regime TEXT,                                -- crt da empresa: 1 | 2 | 3 | NULL
  -- Resultado fiscal
  cfop TEXT,
  icms_cst TEXT,
  icms_aliquota NUMERIC(5,2),
  icms_reducao_pct NUMERIC(5,2),
  icms_mod_bc TEXT,
  csosn TEXT,                                 -- Simples Nacional
  pis_cst TEXT,
  pis_aliquota NUMERIC(5,2),
  cofins_cst TEXT,
  cofins_aliquota NUMERIC(5,2),
  ipi_cst TEXT,
  ipi_aliquota NUMERIC(5,2),
  -- Governança
  prioridade INTEGER NOT NULL DEFAULT 0,
  vigencia_inicio DATE,
  vigencia_fim DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT regras_fiscais_ncm_valido
    CHECK (ncm IS NULL OR ncm = '' OR ncm ~ '^[0-9]{2,8}$'),
  CONSTRAINT regras_fiscais_uf_valida
    CHECK (uf_destino IS NULL OR uf_destino = '' OR uf_destino ~ '^[A-Z]{2}$'),
  CONSTRAINT regras_fiscais_operacao_valida
    CHECK (operacao IN ('saida', 'entrada')),
  CONSTRAINT regras_fiscais_vigencia_coerente
    CHECK (vigencia_fim IS NULL OR vigencia_inicio IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE INDEX IF NOT EXISTS regras_fiscais_empresa_idx ON regras_fiscais (empresa_id, ativo, operacao);
CREATE INDEX IF NOT EXISTS regras_fiscais_ncm_idx ON regras_fiscais (ncm);

-- ----------------------------------------------------------------------------
-- 3) Configuração fiscal da empresa (emitente, provedor, ambiente, séries)
--
-- SEGREDOS NUNCA EM TEXTO PURO: `certificado_senha_cifrada`,
-- `provider_token_cifrado` e `csc_token_cifrado` guardam AES-256-GCM
-- (mesmo esquema do MFA/webhooks). O certificado A1 em si fica FORA do banco:
-- `certificado_ref` aponta para o cofre/arquivo gerenciado pelo provedor.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresa_fiscal_config (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'nenhum',     -- nenhum | focus | plugnotas
  ambiente TEXT NOT NULL DEFAULT 'homologacao',-- homologacao | producao
  provider_token_cifrado TEXT,
  provider_base_url TEXT,
  certificado_ref TEXT,
  certificado_senha_cifrada TEXT,
  certificado_validade DATE,
  csc_id TEXT,                                 -- NFC-e
  csc_token_cifrado TEXT,
  serie_nfe INTEGER NOT NULL DEFAULT 1,
  proximo_numero_nfe INTEGER NOT NULL DEFAULT 1,
  serie_nfce INTEGER NOT NULL DEFAULT 1,
  proximo_numero_nfce INTEGER NOT NULL DEFAULT 1,
  natureza_operacao_padrao TEXT NOT NULL DEFAULT 'Venda de mercadoria',
  cfop_padrao_dentro_uf TEXT NOT NULL DEFAULT '5102',
  cfop_padrao_fora_uf TEXT NOT NULL DEFAULT '6102',
  habilitado BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT empresa_fiscal_provider_valido CHECK (provider IN ('nenhum', 'focus', 'plugnotas')),
  CONSTRAINT empresa_fiscal_ambiente_valido CHECK (ambiente IN ('homologacao', 'producao')),
  CONSTRAINT empresa_fiscal_series_positivas CHECK (serie_nfe > 0 AND serie_nfce > 0),
  CONSTRAINT empresa_fiscal_numeros_positivos CHECK (proximo_numero_nfe > 0 AND proximo_numero_nfce > 0)
);

-- Toda empresa nasce com configuração fiscal DESABILITADA — nada é emitido
-- enquanto um humano não configurar provedor, certificado e ambiente.
INSERT INTO empresa_fiscal_config (empresa_id)
SELECT id FROM empresas
ON CONFLICT (empresa_id) DO NOTHING;
