-- ============================================================================
-- 0059 — FINANCEIRO: IMPORTAÇÃO CONTÁBIL SOBRE O LIVRO ÚNICO
--
-- O QUE É
-- -------
-- Importação de um lote de lançamentos contábeis (partida dobrada) vindos do
-- contador. NÃO cria um segundo ledger: as partidas são gravadas em
-- `lancamentos_financeiros` — a MESMA tabela que o balancete lê — com
-- `conta_contabil_id` + `natureza_lancamento` (estrutura da 0056) e a
-- proveniência carimbada (`documento_origem_recurso = 'fin_importacoes_contabeis'`).
--
-- O QUE ESTA MIGRATION ADICIONA
-- -----------------------------
--   1) `fin_importacoes_contabeis` — CABEÇALHO do lote. Existe para dar
--      idempotência (hash único por empresa), rastreabilidade (quem/quando/
--      arquivo) e conferência (Σ débitos e Σ créditos do lote).
--   2) `lancamentos_financeiros.partida_id` — número do lançamento (ENTRY)
--      dentro do lote. Sem ele não há como provar "Σ débitos = Σ créditos POR
--      LANÇAMENTO": as linhas de um mesmo entry precisam ser agrupáveis.
--
-- O QUE ESTA MIGRATION **NÃO** FAZ
-- --------------------------------
--   • não cria tabela de partidas paralela (as partidas SÃO lançamentos);
--   • não altera nenhuma linha existente;
--   • não inventa plano de contas: conta citada na importação precisa existir
--     no plano DA EMPRESA (validado no serviço, dentro da transação).
--
-- EFEITO NO FLUXO DE CAIXA
-- ------------------------
-- Lançamento contábil de competência NÃO é movimento de caixa. As linhas
-- importadas ficam com `documento_origem_recurso = 'fin_importacoes_contabeis'`
-- e o resumo financeiro (fluxo/DRE de caixa) as EXCLUI explicitamente — senão
-- a mesma receita já lançada pela venda seria contada duas vezes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CABEÇALHO DO LOTE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_importacoes_contabeis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  /** SHA-256 do conteúdo normalizado: é a chave de idempotência. */
  hash TEXT NOT NULL,
  arquivo TEXT,
  competencia DATE,
  entradas INTEGER NOT NULL DEFAULT 0,
  partidas INTEGER NOT NULL DEFAULT 0,
  total_debitos NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_creditos NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aplicada',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS fin_importacoes_contabeis_hash_unico
  ON fin_importacoes_contabeis (empresa_id, hash);

CREATE INDEX IF NOT EXISTS fin_importacoes_contabeis_empresa_idx
  ON fin_importacoes_contabeis (empresa_id, competencia DESC, criado_em DESC);

DO $$ BEGIN
  ALTER TABLE fin_importacoes_contabeis ADD CONSTRAINT fin_importacoes_status_valido
    CHECK (status IN ('aplicada', 'estornada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lote balanceado é invariante de NEGÓCIO: cabe ao banco recusar lote torto.
DO $$ BEGIN
  ALTER TABLE fin_importacoes_contabeis ADD CONSTRAINT fin_importacoes_balanceado
    CHECK (total_debitos = total_creditos);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fin_importacoes_contabeis ADD CONSTRAINT fin_importacoes_totais_nao_negativos
    CHECK (total_debitos >= 0 AND total_creditos >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2) AGRUPAMENTO DAS PARTIDAS NO LIVRO ÚNICO
-- ----------------------------------------------------------------------------
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS partida_id INTEGER;

CREATE INDEX IF NOT EXISTS lancamentos_financeiros_partida_idx
  ON lancamentos_financeiros (empresa_id, documento_origem_recurso, documento_origem_id, partida_id);

COMMENT ON COLUMN lancamentos_financeiros.partida_id IS
  'FIN 3.0/0059: número do lançamento (entry) dentro de um lote de importação contábil. Agrupa as linhas de débito/crédito para conferir Σ débitos = Σ créditos por lançamento.';
COMMENT ON TABLE fin_importacoes_contabeis IS
  'FIN 3.0/0059: cabeçalho de lote de importação contábil. As partidas vivem em lancamentos_financeiros (livro único) com documento_origem_recurso = ''fin_importacoes_contabeis''.';
