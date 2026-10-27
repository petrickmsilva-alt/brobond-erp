-- ============================================================================
-- 0056 — FINANCEIRO: ESTRUTURA PARA CONTABILIDADE (SEM VIRAR CONTABILIDADE)
--
-- ESCOPO — o que esta migração É e o que ela NÃO É
-- ------------------------------------------------
-- O BROBOND tem UM financeiro: `lancamentos_financeiros` (livro-caixa),
-- `contas_financeiras`, `categorias_financeiras`, `centros_custo`. Esta
-- migração NÃO cria um segundo financeiro nem um motor contábil paralelo.
-- Ela prepara a ESTRUTURA para que, quando a contabilidade real for ligada,
-- cada lançamento já tenha a informação que o contador vai pedir:
--
--   • PLANO DE CONTAS (`plano_contas`) — cadastro por empresa, com código,
--     natureza (ativo/passivo/PL/receita/despesa), sintética/analítica e pai;
--   • DÉBITO / CRÉDITO no lançamento — `conta_contabil_id` + `natureza_lancamento`;
--   • DOCUMENTO DE ORIGEM — `documento_origem_recurso` / `documento_origem_id`
--     (a venda, a compra, o aporte, a transferência que gerou o lançamento);
--   • COMPETÊNCIA — `competencia` separada da `data` (regime de competência vs.
--     caixa). Sem competência preenchida, a data é usada no balancete.
--
-- O QUE NÃO ENTRA
--   • NENHUM lançamento contábil automático e NENHUMA partida dobrada gerada
--     por código: sem plano de contas mapeado, o lançamento fica SEM
--     classificação e aparece assim no balancete (honesto, não inventado);
--   • NENHUM plano de contas "padrão" é semeado: o plano é da empresa/contador;
--   • nada é apagado e nenhuma coluna existente muda de significado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS plano_contas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  natureza TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'analitica',
  pai_id INTEGER REFERENCES plano_contas(id),
  descricao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS plano_contas_codigo_unico
  ON plano_contas (empresa_id, codigo);

CREATE INDEX IF NOT EXISTS plano_contas_empresa_idx
  ON plano_contas (empresa_id, natureza, ativo);

DO $$ BEGIN
  ALTER TABLE plano_contas ADD CONSTRAINT plano_contas_natureza_valida
    CHECK (natureza IN ('ativo', 'passivo', 'patrimonio_liquido', 'receita', 'despesa', 'custo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE plano_contas ADD CONSTRAINT plano_contas_tipo_valido
    CHECK (tipo IN ('sintetica', 'analitica'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- CLASSIFICAÇÃO CONTÁBIL NO LANÇAMENTO (opcional por desenho)
-- ----------------------------------------------------------------------------
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_contabil_id INTEGER REFERENCES plano_contas(id);
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS natureza_lancamento TEXT;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS documento_origem_recurso TEXT;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS documento_origem_id INTEGER;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS competencia DATE;

CREATE INDEX IF NOT EXISTS lancamentos_financeiros_conta_contabil_idx
  ON lancamentos_financeiros (empresa_id, conta_contabil_id, competencia);

CREATE INDEX IF NOT EXISTS lancamentos_financeiros_origem_idx
  ON lancamentos_financeiros (empresa_id, documento_origem_recurso, documento_origem_id);

DO $$ BEGIN
  ALTER TABLE lancamentos_financeiros ADD CONSTRAINT lancamentos_natureza_contabil_valida
    CHECK (natureza_lancamento IS NULL OR natureza_lancamento IN ('debito', 'credito'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Natureza e conta andam juntas: uma sem a outra não classifica nada.
DO $$ BEGIN
  ALTER TABLE lancamentos_financeiros ADD CONSTRAINT lancamentos_classificacao_coerente
    CHECK ((conta_contabil_id IS NULL) = (natureza_lancamento IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
