-- ============================================================
-- BROBOND ERP — schema do banco (PostgreSQL)
--
-- Este arquivo é IDEMPOTENTE: pode ser executado quantas vezes for preciso.
-- A API executa este arquivo automaticamente ao iniciar (server/src/db.ts),
-- então em um banco novo as tabelas são criadas sozinhas. Também pode ser
-- aplicado manualmente:  psql "$DATABASE_URL" -f db/schema.sql
--
-- Seções:
--   1) Tabelas (CREATE TABLE IF NOT EXISTS) — instalação nova
--   2) Migrações (ALTER TABLE ... IF NOT EXISTS) — bancos já existentes
--   3) Índices
-- ============================================================

-- ------------------------------------------------------------
-- 1) TABELAS
-- ------------------------------------------------------------

-- Usuários do sistema (login por e-mail + senha com hash bcrypt)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT,
  perfil TEXT NOT NULL DEFAULT 'operador',   -- admin, gerente, operador
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_login TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Trilha de auditoria: quem incluiu/alterou/excluiu o quê
CREATE TABLE IF NOT EXISTS auditoria (
  id SERIAL PRIMARY KEY,
  data TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id INTEGER,
  usuario TEXT,
  acao TEXT NOT NULL,                        -- criar, editar, excluir, login, senha
  recurso TEXT,
  registro_id INTEGER,
  descricao TEXT,
  dados JSONB
);

CREATE TABLE IF NOT EXISTS tamanhos (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,               -- PP, P, M, G, GG
  descricao TEXT,
  ordem INTEGER DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS colecoes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  temporada TEXT,
  ano INTEGER,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fornecedores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cnpj TEXT,
  contato TEXT,
  email TEXT,
  telefone TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS insumos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  unidade TEXT DEFAULT 'un',                 -- m, kg, un, etc.
  custo_medio NUMERIC(12,2) DEFAULT 0,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS representantes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  regiao TEXT,
  comissao_pct NUMERIC(5,2) DEFAULT 0,
  telefone TEXT,
  email TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cnpj_cpf TEXT,
  tipo TEXT DEFAULT 'loja',                  -- loja, atacadista, varejo
  telefone TEXT,
  email TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Categorias de produto (camisa, camiseta, calça, bermuda...)
CREATE TABLE IF NOT EXISTS categorias (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_categorias_nome ON categorias (LOWER(nome));

-- Cores padronizadas (nome + código hexadecimal para a "bolinha" na tela)
CREATE TABLE IF NOT EXISTS cores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  hex TEXT,                                  -- ex.: #1F3A5F
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cores_nome ON cores (LOWER(nome));

-- Produtos acabados
CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  cor TEXT,                                  -- texto livre (compatibilidade)
  cor_id INTEGER REFERENCES cores(id),       -- cor padronizada (cadastro Cores)
  categoria_id INTEGER REFERENCES categorias(id),
  colecao_id INTEGER REFERENCES colecoes(id),
  codigo_barras TEXT,                        -- EAN-13 / GTIN (etiquetas)
  descricao TEXT,                            -- descrição comercial (catálogo)
  composicao TEXT,                           -- ex.: 100% algodão
  ncm TEXT,                                  -- classificação fiscal (NF-e futura)
  peso_g INTEGER,                            -- peso da peça em gramas
  custo NUMERIC(12,2) DEFAULT 0,             -- custo unitário (valoriza o estoque)
  preco_venda NUMERIC(12,2) DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
-- Arquivos anexados a registros (fotos de produtos, etc.)
-- Os bytes ficam em `dados`/`thumb` quando não há provedor externo (Cloudinary).
CREATE TABLE IF NOT EXISTS arquivos (
  id SERIAL PRIMARY KEY,
  recurso TEXT NOT NULL,                     -- 'produtos', 'insumos'...
  registro_id INTEGER NOT NULL,
  nome TEXT,                                 -- nome original do arquivo
  mime TEXT,
  tamanho_bytes INTEGER,
  url TEXT,                                  -- imagem no provedor externo (CDN)
  thumb_url TEXT,                            -- miniatura no provedor externo
  externo_id TEXT,                           -- public_id no Cloudinary (para excluir)
  dados BYTEA,                               -- imagem otimizada (quando armazenada no banco)
  thumb BYTEA,                               -- miniatura (quando armazenada no banco)
  token TEXT NOT NULL,                       -- segredo aleatório usado na URL pública da imagem
  principal BOOLEAN DEFAULT FALSE,
  ordem INTEGER DEFAULT 0,
  criado_por INTEGER,
  criado_em TIMESTAMPTZ DEFAULT now()
);

-- Estoque físico (saldo por produto + tamanho + local)
CREATE TABLE IF NOT EXISTS estoques (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local TEXT DEFAULT 'almoxarifado',
  quantidade INTEGER DEFAULT 0,
  estoque_min INTEGER DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (produto_id, tamanho_id, local)
);

-- Movimentações (imutáveis — cada uma altera o saldo em `estoques`)
CREATE TABLE IF NOT EXISTS movimentacoes (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,                        -- entrada, saida, ajuste
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local TEXT DEFAULT 'almoxarifado',
  quantidade INTEGER NOT NULL,
  motivo TEXT,
  usuario_id INTEGER,
  data TIMESTAMPTZ DEFAULT now()
);

-- Produção
CREATE TABLE IF NOT EXISTS ordens_fabricacao (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  status TEXT DEFAULT 'planejada',           -- planejada, em_producao, concluida, cancelada
  inicio TIMESTAMPTZ,
  previsao TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Ficha técnica / BOM (quanto de cada insumo vira 1 peça)
CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER REFERENCES produtos(id),
  mao_obra NUMERIC(12,2) DEFAULT 0,
  custos_indiretos NUMERIC(12,2) DEFAULT 0,
  margem_pct NUMERIC(5,2) DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Corrige o nome digitado errado em versões anteriores (itens_ficha_tecnicica)
DO $$
BEGIN
  IF to_regclass('public.itens_ficha_tecnicica') IS NOT NULL
     AND to_regclass('public.itens_ficha_tecnica') IS NULL THEN
    ALTER TABLE itens_ficha_tecnicica RENAME TO itens_ficha_tecnica;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS itens_ficha_tecnica (
  id SERIAL PRIMARY KEY,
  ficha_id INTEGER REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id INTEGER REFERENCES insumos(id),
  consumo NUMERIC(12,3) DEFAULT 0            -- ex.: 1.5 m de tecido por peça
);

-- Compras de insumos
CREATE TABLE IF NOT EXISTS compras (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  data TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pendente',            -- pendente, recebido, cancelado
  total NUMERIC(12,2) DEFAULT 0,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
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
  status TEXT DEFAULT 'aberta',              -- aberta, faturada, entregue, cancelada
  total NUMERIC(12,2) DEFAULT 0,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS itens_venda (
  id SERIAL PRIMARY KEY,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL
);

-- ------------------------------------------------------------
-- 2) MIGRAÇÕES — colunas novas em bancos criados com a versão anterior
-- ------------------------------------------------------------
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS ultimo_login TIMESTAMPTZ;
ALTER TABLE usuarios       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;
ALTER TABLE usuarios       ALTER COLUMN perfil SET DEFAULT 'operador';
UPDATE usuarios SET perfil = 'operador' WHERE perfil IS NULL OR perfil = 'usuario';

ALTER TABLE tamanhos       ADD COLUMN IF NOT EXISTS ordem INTEGER DEFAULT 0;
ALTER TABLE tamanhos       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE tamanhos       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE colecoes       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE colecoes       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE fornecedores   ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE fornecedores   ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE insumos        ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE insumos        ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE representantes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE clientes       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE clientes       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS cor TEXT;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS cor_id INTEGER REFERENCES cores(id);
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias(id);
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS codigo_barras TEXT;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS composicao TEXT;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS ncm TEXT;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS peso_g INTEGER;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS custo NUMERIC(12,2) DEFAULT 0;
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE estoques       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE estoques       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE movimentacoes  ADD COLUMN IF NOT EXISTS local TEXT DEFAULT 'almoxarifado';
ALTER TABLE movimentacoes  ADD COLUMN IF NOT EXISTS usuario_id INTEGER;

ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE compras        ADD COLUMN IF NOT EXISTS observacoes TEXT;
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS observacoes TEXT;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 3) ÍNDICES
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_auditoria_data       ON auditoria (data DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_recurso    ON auditoria (recurso, registro_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_prod   ON movimentacoes (produto_id, tamanho_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_estoques_produto     ON estoques (produto_id);
CREATE INDEX IF NOT EXISTS idx_ordens_status        ON ordens_fabricacao (status);
CREATE INDEX IF NOT EXISTS idx_vendas_status        ON vendas (status);
CREATE INDEX IF NOT EXISTS idx_compras_status       ON compras (status);
CREATE INDEX IF NOT EXISTS idx_arquivos_registro    ON arquivos (recurso, registro_id, principal DESC, ordem);
CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_codigo_barras ON produtos (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';
CREATE INDEX IF NOT EXISTS idx_produtos_categoria   ON produtos (categoria_id);
CREATE INDEX IF NOT EXISTS idx_produtos_cor         ON produtos (cor_id);

-- ------------------------------------------------------------
-- 4) MIGRAÇÃO DE DADOS — cor em texto livre → cadastro de Cores
--    (idempotente: só cria cores que ainda não existem e só preenche
--     cor_id onde estiver vazio; o texto original é preservado)
-- ------------------------------------------------------------
INSERT INTO cores (nome)
SELECT DISTINCT INITCAP(TRIM(cor)) FROM produtos
WHERE cor IS NOT NULL AND TRIM(cor) <> ''
  AND NOT EXISTS (SELECT 1 FROM cores c WHERE LOWER(c.nome) = LOWER(TRIM(produtos.cor)));

UPDATE produtos p SET cor_id = c.id
FROM cores c
WHERE p.cor_id IS NULL AND p.cor IS NOT NULL AND LOWER(TRIM(p.cor)) = LOWER(c.nome);
