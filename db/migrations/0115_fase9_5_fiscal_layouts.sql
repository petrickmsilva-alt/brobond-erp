-- ============================================================================
-- 0115 — FASE 9.5: REGISTRO VERSIONADO DE LEIAUTES FISCAIS (SPED/EFD)
--
-- O QUE ESTA MIGRAÇÃO RESOLVE
-- ---------------------------
-- Até aqui o ERP tinha a ESTRUTURA fiscal (regras_fiscais, documentos_fiscais,
-- empresa_fiscal_config, fiscal_obrigacoes, fiscal_execucoes) mas NÃO tinha
-- como provar QUAL versão de leiaute é válida para um período de apuração. Sem
-- isso, qualquer geração de EFD seria "no chute" — e a 0063 proíbe justamente
-- inventar leiaute.
--
-- Esta migração cria `fiscal_layouts`: a TABELA DE REFERÊNCIA VERSIONADA que
-- diz, por sistema (EFD ICMS/IPI, EFD-Contribuições) e por código de versão
-- (campo COD_VER do registro 0000), o período de apuração em que cada versão
-- é válida, o ato normativo que a instituiu e a fonte oficial consultada.
--
-- FONTES OFICIAIS (consultadas em 2026-11-09; ver docs/fiscal/REGULATORY-SOURCES.md)
--   • EFD ICMS/IPI — Guia Prático v3.2.2 (atualização 11/02/2026) e
--     Notas Técnicas 2025.001 (leiaute 020), 2024.001 (019), 2023.001 (018).
--     http://sped.rfb.gov.br/pasta/show/1573
--   • EFD-Contribuições — Guia Prático v1.35, Tabela 3.1.1 (ADE Cofis).
--     http://sped.rfb.gov.br/item/show/1989
--
-- O QUE NÃO É FEITO AQUI
--   • nenhuma tabela de negócio é alterada (migração puramente ADITIVA);
--   • nenhum dado histórico é tocado;
--   • não há transmissão, assinatura ou geração de arquivo — só a referência.
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS fiscal_layouts;
--   DELETE FROM schema_migrations WHERE id = '0115_fase9_5_fiscal_layouts.sql';
--   COMMIT;
-- ============================================================================

CREATE TABLE IF NOT EXISTS fiscal_layouts (
  id SERIAL PRIMARY KEY,
  -- Sistema de escrituração. Não confundir EFD ICMS/IPI com EFD-Contribuições:
  -- são arquivos, registros e obrigações DIFERENTES.
  sistema TEXT NOT NULL,
  -- Código da versão do leiaute (campo COD_VER do registro 0000).
  codigo_versao TEXT NOT NULL,
  -- Versão "humana" do leiaute (ex.: 3.2.0 da EFD-Contribuições).
  versao_leiaute TEXT NOT NULL,
  -- Ato normativo que instituiu a versão (Nota Técnica / ADE Cofis / Ato COTEPE).
  ato_normativo TEXT,
  -- Período de apuração a partir do qual a versão é válida.
  vigencia_inicio DATE NOT NULL,
  -- Período em que deixa de ser válida (NULL = vigente).
  vigencia_fim DATE,
  -- Fonte oficial (URL do Portal SPED) e data da consulta — rastreabilidade.
  fonte_url TEXT NOT NULL,
  consultado_em DATE NOT NULL,
  -- Códigos de registro que o leiaute define (autodescrição mínima). A gramática
  -- de campos por registro vive no código (server/src/fiscalLayouts.ts).
  registros JSONB NOT NULL DEFAULT '[]'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_layouts_sistema_valido CHECK (sistema IN ('EFD_ICMS_IPI', 'EFD_CONTRIBUICOES')),
  CONSTRAINT fiscal_layouts_vigencia_coerente CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  CONSTRAINT fiscal_layouts_versao_nao_vazia CHECK (btrim(codigo_versao) <> ''),
  CONSTRAINT fiscal_layouts_registros_array CHECK (jsonb_typeof(registros) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_layouts_sistema_versao
  ON fiscal_layouts (sistema, codigo_versao);

CREATE INDEX IF NOT EXISTS fiscal_layouts_sistema_vigencia_idx
  ON fiscal_layouts (sistema, ativo, vigencia_inicio);

COMMENT ON TABLE fiscal_layouts IS
  'FASE 9.5 / 0115: tabela de referência VERSIONADA de leiautes SPED/EFD. Fonte oficial por versão; usada para recusar geração de arquivo em leiaute que não vigora no período de apuração. Não gera nem transmite arquivo fiscal.';

-- ----------------------------------------------------------------------------
-- SEED — versões oficiais confirmadas nas fontes acima. Idempotente.
-- ----------------------------------------------------------------------------
INSERT INTO fiscal_layouts
  (sistema, codigo_versao, versao_leiaute, ato_normativo, vigencia_inicio, vigencia_fim, fonte_url, consultado_em, registros)
VALUES
  -- EFD ICMS/IPI — códigos 018/019/020 (Notas Técnicas 2023.001/2024.001/2025.001)
  ('EFD_ICMS_IPI', '020', '020', 'Nota Técnica 2025.001 v1.0 (Ato COTEPE/ICMS)', '2025-01-01', NULL,
   'http://sped.rfb.gov.br/pasta/show/1573', '2026-11-09',
   '["0000","0001","0005","0010","0150","0190","0200","0990","C001","C100","C170","C190","C990","9999"]'::jsonb),
  ('EFD_ICMS_IPI', '019', '019', 'Nota Técnica 2024.001 v1.0 (Ato COTEPE/ICMS)', '2024-01-01', '2024-12-31',
   'http://sped.rfb.gov.br/pasta/show/1573', '2026-11-09',
   '["0000","0001","0005","0010","0150","0190","0200","0990","C001","C100","C170","C190","C990","9999"]'::jsonb),
  ('EFD_ICMS_IPI', '018', '018', 'Nota Técnica 2023.001 v1.2 (Ato COTEPE/ICMS)', '2023-01-01', '2023-12-31',
   'http://sped.rfb.gov.br/pasta/show/1573', '2026-11-09',
   '["0000","0001","0005","0010","0150","0190","0200","0990","C001","C100","C170","C190","C990","9999"]'::jsonb),
  -- EFD-Contribuições — Tabela 3.1.1 do Guia Prático v1.35 (ADE Cofis)
  ('EFD_CONTRIBUICOES', '006', '3.2.0', 'ADE Cofis (Guia Prático v1.35, Tabela 3.1.1)', '2020-01-01', NULL,
   'http://sped.rfb.gov.br/item/show/1989', '2026-11-09',
   '["0000","0001","0100","0110","0140","0150","0190","0200","0990","A001","A100","A170","A990","C001","C100","C170","C990","D001","D100","D990","F001","F100","F990","M001","M200","M990","9900","9999"]'::jsonb),
  ('EFD_CONTRIBUICOES', '005', '3.1.0', 'ADE Cofis nº 82/2018 (Guia Prático v1.35, Tabela 3.1.1)', '2019-01-01', '2019-12-31',
   'http://sped.rfb.gov.br/item/show/1989', '2026-11-09',
   '["0000","0001","0100","0110","0140","0150","0190","0200","0990","A001","A100","A170","A990","C001","C100","C170","C990","D001","D100","D990","F001","F100","F990","M001","M200","M990","9900","9999"]'::jsonb),
  ('EFD_CONTRIBUICOES', '004', '3.0.0', 'ADE Cofis nº 20/2012 (Guia Prático v1.35, Tabela 3.1.1)', '2018-06-01', '2018-12-31',
   'http://sped.rfb.gov.br/item/show/1989', '2026-11-09',
   '["0000","0001","0100","0110","0140","0150","0190","0200","0990","A001","A100","A170","A990","C001","C100","C170","C990","D001","D100","D990","F001","F100","F990","M001","M200","M990","9900","9999"]'::jsonb)
ON CONFLICT (sistema, codigo_versao) DO NOTHING;
