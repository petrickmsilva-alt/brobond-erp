-- ============================================================
-- BROBOND ERP — schema do banco (PostgreSQL)
-- Execute no seu banco Postgres (Render) com: psql $DATABASE_URL -f db/schema.sql
-- ============================================================

-- Cadastros base
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT,
  perfil TEXT DEFAULT 'usuario',
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tamanhos (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,   -- PP, P, M, G, GG
  descricao TEXT
);

CREATE TABLE IF NOT EXISTS colecoes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  temporada TEXT,
  ano INTEGER
);

CREATE TABLE IF NOT EXISTS fornecedores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cnpj TEXT,
  contato TEXT,
  email TEXT,
  telefone TEXT,
  ativo BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS insumos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  unidade TEXT DEFAULT 'un',     -- m, kg, un, etc.
  custo_medio NUMERIC(12,2) DEFAULT 0,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  ativo BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS representantes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  regiao TEXT,
  comissao_pct NUMERIC(5,2) DEFAULT 0,
  telefone TEXT,
  email TEXT,
  ativo BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cnpj_cpf TEXT,
  tipo TEXT DEFAULT 'loja',      -- loja, atacadista, varejo
  telefone TEXT,
  email TEXT,
  ativo BOOLEAN DEFAULT TRUE
);

-- Produtos acabados
CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  colecao_id INTEGER REFERENCES colecoes(id),
  preco_venda NUMERIC(12,2) DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE
);

-- Estoque físico (por produto + tamanho + local)
CREATE TABLE IF NOT EXISTS estoques (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local TEXT DEFAULT 'almoxarifado',
  quantidade INTEGER DEFAULT 0,
  estoque_min INTEGER DEFAULT 0,
  UNIQUE (produto_id, tamanho_id, local)
);

CREATE TABLE IF NOT EXISTS movimentacoes (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,            -- entrada, saida, ajuste
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  motivo TEXT,
  data TIMESTAMPTZ DEFAULT now()
);

-- Produção
CREATE TABLE IF NOT EXISTS ordens_fabricacao (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  status TEXT DEFAULT 'planejada', -- planejada, em_producao, concluida, cancelada
  inicio TIMESTAMPTZ,
  previsao TIMESTAMPTZ
);

-- Ficha técnica / BOM (quanto de cada insumo vira 1 peça)
CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  mao_obra NUMERIC(12,2) DEFAULT 0,
  custos_indiretos NUMERIC(12,2) DEFAULT 0,
  margem_pct NUMERIC(5,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS itens_ficha_tecnicica (
  id SERIAL PRIMARY KEY,
  ficha_id INTEGER REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id INTEGER REFERENCES insumos(id),
  consumo NUMERIC(12,3) DEFAULT 0  -- ex.: 1.5 m de tecido por peça
);

-- Compras de insumos
CREATE TABLE IF NOT EXISTS compras (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  data TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pendente',  -- pendente, recebido, cancelado
  total NUMERIC(12,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS itens_compra (
  id SERIAL PRIMARY KEY,
  compra_id INTEGER REFERENCES compras(id) ON DELETE CASCADE,
  insumo_id INTEGER REFERENCES insumos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL
);

-- Vendas
CREATE TABLE IF NOT EXISTS vendas (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id),
  representante_id INTEGER REFERENCES representantes(id),
  data TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'aberta',
  total NUMERIC(12,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS itens_venda (
  id SERIAL PRIMARY KEY,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL
);
