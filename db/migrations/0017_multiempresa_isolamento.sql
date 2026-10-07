-- ============================================================================
-- 0017 — MULTIEMPRESA: ISOLAMENTO REAL POR EMPRESA
--
-- Até aqui apenas o motor analítico (`sales`, `produto_abc`) conhecia
-- `empresa_id`. Esta migration leva a empresa para TODA a cadeia transacional
-- do ERP, de modo que nenhuma consulta possa atravessar a fronteira entre
-- empresas do grupo.
--
-- Princípios:
--   1) Toda tabela transacional ganha `empresa_id NOT NULL DEFAULT 1`. O
--      backfill é trivial e seguro: tudo que existe hoje é da BROBOND (id 1),
--      a única empresa cadastrada — nenhum dado muda de dono.
--   2) Tabelas FILHAS (itens, estoque, movimentações) não confiam no app: um
--      trigger deriva `empresa_id` do registro-pai a cada INSERT/UPDATE. Assim
--      `adjustStock()` e qualquer SQL direto continuam corretos sem alteração.
--   3) O usuário ganha empresa padrão + lista de empresas autorizadas
--      (`usuario_empresas`) + a permissão explícita de consolidar o grupo.
--   4) A auditoria passa a identificar a empresa do fato registrado.
--
-- Idempotente: pode ser reaplicada sem efeito colateral.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Empresa: campos necessários para o cadastro fiscal/operacional
-- ----------------------------------------------------------------------------
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ie TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS im TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS crt TEXT;                -- 1 Simples | 2 Simples excesso | 3 Regime normal
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;   -- IBGE (NF-e)
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS telefone TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_empresas_cnpj
  ON empresas (regexp_replace(cnpj, '[^0-9]', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '[^0-9]', '', 'g') <> '';

-- ----------------------------------------------------------------------------
-- 2) Usuário: empresa padrão, consolidação e empresas autorizadas
-- ----------------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pode_consolidar BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE usuarios SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE usuarios ALTER COLUMN empresa_id SET DEFAULT 1;

-- Administradores consolidam por padrão (compatibilidade: hoje eles já veem tudo).
UPDATE usuarios SET pode_consolidar = TRUE WHERE perfil = 'admin' AND pode_consolidar = FALSE;

-- Empresas que cada usuário pode acessar além da padrão.
CREATE TABLE IF NOT EXISTS usuario_empresas (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (usuario_id, empresa_id)
);
CREATE INDEX IF NOT EXISTS usuario_empresas_empresa_idx ON usuario_empresas (empresa_id);
CREATE INDEX IF NOT EXISTS usuario_empresas_usuario_idx ON usuario_empresas (usuario_id);

-- Todo usuário existente recebe acesso explícito à sua empresa padrão.
INSERT INTO usuario_empresas (usuario_id, empresa_id)
SELECT id, COALESCE(empresa_id, 1) FROM usuarios
ON CONFLICT (usuario_id, empresa_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3) empresa_id nas tabelas RAIZ (a empresa é definida pelo escopo do ator)
-- ----------------------------------------------------------------------------
-- Raízes: a empresa vem do escopo do ator (carimbada pelo servidor).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS clientes_empresa_idx ON clientes (empresa_id);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS fornecedores_empresa_idx ON fornecedores (empresa_id);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS produtos_empresa_idx ON produtos (empresa_id);
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS representantes_empresa_idx ON representantes (empresa_id);
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS insumos_empresa_idx ON insumos (empresa_id);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS vendas_empresa_idx ON vendas (empresa_id);
ALTER TABLE compras ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS compras_empresa_idx ON compras (empresa_id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS ordens_fabricacao_empresa_idx ON ordens_fabricacao (empresa_id);
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS inventarios_empresa_idx ON inventarios (empresa_id);
ALTER TABLE locais ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS locais_empresa_idx ON locais (empresa_id);
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS catalogos_empresa_idx ON catalogos (empresa_id);
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS fichas_tecnicas_empresa_idx ON fichas_tecnicas (empresa_id);
ALTER TABLE colecoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS colecoes_empresa_idx ON colecoes (empresa_id);
ALTER TABLE categorias_financeiras ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS categorias_financeiras_empresa_idx ON categorias_financeiras (empresa_id);
ALTER TABLE contas_financeiras ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS contas_financeiras_empresa_idx ON contas_financeiras (empresa_id);
ALTER TABLE centros_custo ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS centros_custo_empresa_idx ON centros_custo (empresa_id);
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS lancamentos_financeiros_empresa_idx ON lancamentos_financeiros (empresa_id);
ALTER TABLE recorrencias_financeiras ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS recorrencias_financeiras_empresa_idx ON recorrencias_financeiras (empresa_id);
ALTER TABLE transferencias_financeiras ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS transferencias_financeiras_empresa_idx ON transferencias_financeiras (empresa_id);
ALTER TABLE investidores ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS investidores_empresa_idx ON investidores (empresa_id);
ALTER TABLE aportes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS aportes_empresa_idx ON aportes (empresa_id);
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS produto_fornecedor_skus_empresa_idx ON produto_fornecedor_skus (empresa_id);
ALTER TABLE importacoes_nfe ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS importacoes_nfe_empresa_idx ON importacoes_nfe (empresa_id);
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS auditoria_empresa_idx ON auditoria (empresa_id);

-- ----------------------------------------------------------------------------
-- 4) empresa_id nas tabelas FILHAS + trigger que deriva do pai
--
-- O app nunca precisa (nem pode) informar a empresa aqui: ela vem sempre do
-- registro-pai. Isso mantém `adjustStock`, importações e qualquer SQL direto
-- coerentes por construção.
-- ----------------------------------------------------------------------------
-- Filhas: a empresa é derivada do pai pelos triggers logo abaixo.
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS itens_venda_empresa_idx ON itens_venda (empresa_id);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS itens_compra_empresa_idx ON itens_compra (empresa_id);
ALTER TABLE itens_ordem ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS itens_ordem_empresa_idx ON itens_ordem (empresa_id);
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS itens_inventario_empresa_idx ON itens_inventario (empresa_id);
ALTER TABLE itens_ficha_tecnica ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS itens_ficha_tecnica_empresa_idx ON itens_ficha_tecnica (empresa_id);
ALTER TABLE estoques ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS estoques_empresa_idx ON estoques (empresa_id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS movimentacoes_empresa_idx ON movimentacoes (empresa_id);
ALTER TABLE estoque_insumos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS estoque_insumos_empresa_idx ON estoque_insumos (empresa_id);
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_empresa_idx ON movimentacoes_insumos (empresa_id);

-- Função genérica: herda empresa_id da tabela-pai indicada nos argumentos do
-- trigger (TG_ARGV[0] = tabela pai, TG_ARGV[1] = coluna FK na tabela filha).
CREATE OR REPLACE FUNCTION brobond_herdar_empresa() RETURNS trigger AS $$
DECLARE
  pai_tabela TEXT := TG_ARGV[0];
  fk_coluna  TEXT := TG_ARGV[1];
  fk_valor   INTEGER;
  empresa    INTEGER;
BEGIN
  EXECUTE format('SELECT ($1).%I', fk_coluna) INTO fk_valor USING NEW;
  IF fk_valor IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT empresa_id FROM %I WHERE id = $1', pai_tabela)
    INTO empresa USING fk_valor;
  IF empresa IS NOT NULL THEN
    NEW.empresa_id := empresa;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    ARRAY['itens_venda', 'vendas', 'venda_id'],
    ARRAY['itens_compra', 'compras', 'compra_id'],
    ARRAY['itens_ordem', 'ordens_fabricacao', 'ordem_id'],
    ARRAY['itens_inventario', 'inventarios', 'inventario_id'],
    ARRAY['itens_ficha_tecnica', 'fichas_tecnicas', 'ficha_id'],
    ARRAY['estoques', 'produtos', 'produto_id'],
    ARRAY['movimentacoes', 'produtos', 'produto_id'],
    ARRAY['estoque_insumos', 'insumos', 'insumo_id'],
    ARRAY['movimentacoes_insumos', 'insumos', 'insumo_id']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    IF to_regclass(spec[1]) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = spec[1] AND column_name = spec[3]) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_empresa_' || spec[1], spec[1]);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa(%L, %L)',
        'trg_empresa_' || spec[1], spec[1], spec[2], spec[3]);
      -- Backfill dos registros já existentes.
      EXECUTE format(
        'UPDATE %I f SET empresa_id = p.empresa_id FROM %I p
          WHERE p.id = f.%I AND f.empresa_id IS DISTINCT FROM p.empresa_id',
        spec[1], spec[2], spec[3]);
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5) Índices compostos das consultas mais quentes (empresa + filtro habitual)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS vendas_empresa_status_idx    ON vendas (empresa_id, status);
CREATE INDEX IF NOT EXISTS vendas_empresa_data_idx      ON vendas (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS compras_empresa_status_idx   ON compras (empresa_id, status);
CREATE INDEX IF NOT EXISTS estoques_empresa_produto_idx ON estoques (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS movimentacoes_empresa_data_idx ON movimentacoes (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS lanc_fin_empresa_data_idx    ON lancamentos_financeiros (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS auditoria_empresa_data_idx   ON auditoria (empresa_id, data DESC);
