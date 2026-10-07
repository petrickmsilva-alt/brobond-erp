-- ============================================================================
-- 0018 — CADASTRO DE PRODUTO COMPLETO + VARIAÇÕES (SKU pai/filho) + KIT
--
-- Completa o cadastro de produtos até a especificação técnica SEM destruir o
-- modelo atual:
--   • a grade de tamanhos continua sendo `grades`/`grade_tamanhos`/`tamanhos`;
--   • o saldo continua em `estoques` (produto × tamanho × local);
--   • a VARIAÇÃO passa a ser um PRODUTO FILHO (`produto_pai_id`), o que dá a
--     cada SKU filho estoque, preço, GTIN e custo próprios de graça — sem um
--     segundo motor de estoque.
--
-- Idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Identificação e classificação
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS formato TEXT NOT NULL DEFAULT 'simples';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'mercadoria';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS condicao TEXT NOT NULL DEFAULT 'novo';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS unidade TEXT NOT NULL DEFAULT 'un';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS marca TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS descricao_curta TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS observacoes_internas TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS producao TEXT NOT NULL DEFAULT 'propria';

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_formato_valido
    CHECK (formato IN ('simples', 'variacao', 'kit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_condicao_valida
    CHECK (condicao IN ('novo', 'usado', 'recondicionado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_producao_valida
    CHECK (producao IN ('propria', 'terceiros'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2) Variação: SKU filho determinístico (pai + eixos cor/tamanho)
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS produto_pai_id INTEGER REFERENCES produtos(id) ON DELETE RESTRICT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS variacao_chave TEXT;   -- ex.: 'PRETA|M' (determinística)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS variacao_tamanho_id INTEGER REFERENCES tamanhos(id);

CREATE INDEX IF NOT EXISTS produtos_pai_idx ON produtos (produto_pai_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_variacao
  ON produtos (produto_pai_id, variacao_chave)
  WHERE produto_pai_id IS NOT NULL;

-- Um filho não pode ser pai (apenas um nível de variação).
DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_variacao_coerente
    CHECK (produto_pai_id IS NULL OR formato = 'variacao');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 3) Dimensões, peso e embalagem (frete e NF-e)
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_liquido_g INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_bruto_g INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS largura_mm INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS altura_mm INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS profundidade_mm INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS volumes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS itens_por_caixa INTEGER;

-- `peso_g` (legado) continua existindo e vira a fonte do peso líquido quando
-- este ainda não foi preenchido — compatibilidade com etiquetas e frete.
UPDATE produtos SET peso_liquido_g = peso_g WHERE peso_liquido_g IS NULL AND peso_g IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4) Estoque, localização e suprimento
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_max INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS localizacao TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS fornecedor_id INTEGER REFERENCES fornecedores(id);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_fornecedor TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_habitual NUMERIC(12,2) DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE produtos ADD CONSTRAINT produtos_estoque_faixa
    CHECK (estoque_max IS NULL OR estoque_max >= estoque_min);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS produtos_fornecedor_idx ON produtos (fornecedor_id);

-- ----------------------------------------------------------------------------
-- 5) GTIN tributário (o GTIN comercial já é `codigo_barras`)
-- ----------------------------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS gtin_tributario TEXT;

-- ----------------------------------------------------------------------------
-- 6) Composição / kit — lista de componentes de um produto formato='kit'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS produto_composicao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  componente_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantidade > 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (produto_id, componente_id),
  CONSTRAINT produto_composicao_sem_autorreferencia CHECK (produto_id <> componente_id)
);
CREATE INDEX IF NOT EXISTS produto_composicao_componente_idx ON produto_composicao (componente_id);
CREATE INDEX IF NOT EXISTS produto_composicao_empresa_idx ON produto_composicao (empresa_id);

DROP TRIGGER IF EXISTS trg_empresa_produto_composicao ON produto_composicao;
CREATE TRIGGER trg_empresa_produto_composicao
  BEFORE INSERT OR UPDATE ON produto_composicao
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('produtos', 'produto_id');

-- ----------------------------------------------------------------------------
-- 7) SKU é único POR EMPRESA (e não mais globalmente)
--
-- Duas empresas do grupo podem ter o mesmo código interno. Substituímos a
-- unicidade global por uma por empresa — sem perder a proteção.
-- O mesmo vale para o código de barras.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'produtos_sku_key') THEN
    ALTER TABLE produtos DROP CONSTRAINT produtos_sku_key;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'produtos_sku_key não removida: %', SQLERRM;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_sku_empresa ON produtos (empresa_id, sku);

DROP INDEX IF EXISTS uq_produtos_codigo_barras;
CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_codigo_barras_empresa
  ON produtos (empresa_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';
