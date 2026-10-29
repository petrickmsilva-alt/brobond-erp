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

-- Usuários do sistema (login por e-mail + senha com hash Argon2id;
-- hashes bcrypt antigos migram gradualmente no login)
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT,
  perfil TEXT NOT NULL DEFAULT 'operador',   -- admin, gerente, operador
  CONSTRAINT usuarios_perfil_valido CHECK (perfil IN ('admin', 'gerente', 'operador')),
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

-- Grades de tamanhos: conjuntos NOMEADOS de tamanhos, na ordem correta.
-- Ex.: "Camiseta PP-GG" (PP,P,M,G,GG), "Calça 36-48" (36..48), "Calçado 34-44".
-- Cada produto (ou categoria) aponta para UMA grade, evitando que os tamanhos
-- de tipos diferentes de peça se misturem no estoque.
CREATE TABLE IF NOT EXISTS grades (
  id SERIAL PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,                 -- "Camiseta PP-GG", "Calça 36-48"...
  descricao TEXT,
  instrucoes_medidas TEXT,                   -- como medir + tolerância (vai para o cliente)
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Itens de uma grade (muitos-para-muitos grade × tamanho, com ordem).
CREATE TABLE IF NOT EXISTS grade_tamanhos (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER REFERENCES grades(id) ON DELETE CASCADE,
  tamanho_id INTEGER REFERENCES tamanhos(id) ON DELETE CASCADE,
  ordem INTEGER DEFAULT 0,
  UNIQUE (grade_id, tamanho_id)
);
CREATE INDEX IF NOT EXISTS idx_grade_tamanhos_grade ON grade_tamanhos (grade_id, ordem);

-- Tabela de medidas (colunas da grade: largura, comprimento, manga, cintura...)
CREATE TABLE IF NOT EXISTS medidas (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER REFERENCES grades(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,                        -- "Largura (A)", "Comprimento (B)"...
  unidade TEXT DEFAULT 'cm',                 -- cm, mm, pol
  ordem INTEGER DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (grade_id, nome)
);

-- Valor de cada medida para cada tamanho da grade
CREATE TABLE IF NOT EXISTS medida_valores (
  id SERIAL PRIMARY KEY,
  medida_id INTEGER REFERENCES medidas(id) ON DELETE CASCADE,
  tamanho_id INTEGER REFERENCES tamanhos(id) ON DELETE CASCADE,
  valor NUMERIC(12,2),
  atualizado_em TIMESTAMPTZ,                 -- quando a célula foi preenchida/alterada
  UNIQUE (medida_id, tamanho_id)
);
CREATE INDEX IF NOT EXISTS idx_medida_valores_medida ON medida_valores (medida_id);
CREATE INDEX IF NOT EXISTS idx_medida_valores_tamanho ON medida_valores (tamanho_id);

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
  local TEXT DEFAULT 'loja',
  quantidade INTEGER DEFAULT 0,
  estoque_min INTEGER DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (produto_id, tamanho_id, local),
  CONSTRAINT estoques_quantidade_nao_negativo CHECK (quantidade >= 0)
);

-- Movimentações (imutáveis — cada uma altera o saldo em `estoques`)
CREATE TABLE IF NOT EXISTS movimentacoes (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,                        -- entrada, saida, ajuste
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local TEXT DEFAULT 'loja',
  quantidade INTEGER NOT NULL,
  motivo TEXT,
  usuario_id INTEGER,
  data TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT movimentacoes_tipo_valido CHECK (tipo IN ('entrada', 'saida', 'transferencia', 'ajuste')),
  CONSTRAINT movimentacoes_quantidade_nao_zero CHECK (quantidade <> 0)
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
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  codigo_fornecedor TEXT,
  quantidade NUMERIC(12,3) NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL,
  unidade TEXT,
  ncm TEXT,
  cfop TEXT,
  dados_fiscais JSONB,
  local TEXT,
  CONSTRAINT itens_compra_origem_check CHECK (insumo_id IS NOT NULL OR produto_id IS NOT NULL)
);

-- De-para persistente: o mesmo código pode ser usado por fornecedores
-- diferentes, mas não pode apontar para dois produtos dentro do mesmo fornecedor.
CREATE TABLE IF NOT EXISTS produto_fornecedor_skus (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  codigo_fornecedor TEXT NOT NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (fornecedor_id, codigo_fornecedor)
);

-- Idempotência da entrada de NF-e: uma chave fiscal não pode gerar duas compras.
CREATE TABLE IF NOT EXISTS importacoes_nfe (
  id SERIAL PRIMARY KEY,
  chave_acesso TEXT UNIQUE NOT NULL,
  xml_hash TEXT NOT NULL,
  compra_id INTEGER REFERENCES compras(id),
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  numero TEXT,
  serie TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  dados_fiscais JSONB,
  importado_em TIMESTAMPTZ DEFAULT now()
);

-- Estoque de insumos (matéria-prima) — saldo por insumo.
CREATE TABLE IF NOT EXISTS estoque_insumos (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER UNIQUE REFERENCES insumos(id),
  quantidade NUMERIC(12,3) DEFAULT 0,
  estoque_min NUMERIC(12,3) DEFAULT 0,
  atualizado_em TIMESTAMPTZ
);

-- Movimentações de insumos (entrada por compra, ajuste, saída por consumo de OP)
CREATE TABLE IF NOT EXISTS movimentacoes_insumos (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,                        -- entrada, saida, ajuste
  insumo_id INTEGER REFERENCES insumos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  custo_unitario NUMERIC(12,2) DEFAULT 0,
  motivo TEXT,
  usuario_id INTEGER,
  data TIMESTAMPTZ DEFAULT now()
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
  preco_unitario NUMERIC(12,2) NOT NULL,
  desconto_pct NUMERIC(5,2) DEFAULT 0,
  subtotal NUMERIC(12,2) DEFAULT 0
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
-- 0040: status ativo/inativo — o cadastro se desativa; o histórico (produtos) permanece.
ALTER TABLE colecoes       ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;

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

-- Estas duas colunas estavam no CREATE TABLE mas faltavam na seção de
-- migrações — bancos criados antes delas nunca as recebiam.
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS colecao_id INTEGER REFERENCES colecoes(id);
ALTER TABLE produtos       ADD COLUMN IF NOT EXISTS preco_venda NUMERIC(12,2) DEFAULT 0;

ALTER TABLE estoques       ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT now();
ALTER TABLE estoques       ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;

ALTER TABLE movimentacoes  ADD COLUMN IF NOT EXISTS local TEXT DEFAULT 'loja';
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

-- Fase 2: pedidos de venda com itens, condição de pagamento, frete e comissão
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS condicao_pagamento TEXT;
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS frete NUMERIC(12,2) DEFAULT 0;
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS previsao_entrega DATE;
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS nota_fiscal TEXT;
ALTER TABLE compras        ADD COLUMN IF NOT EXISTS recebida_em TIMESTAMPTZ;

ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS condicao_pagamento TEXT;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS desconto NUMERIC(12,2) DEFAULT 0;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS frete NUMERIC(12,2) DEFAULT 0;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS previsao_entrega DATE;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS pedido_cliente TEXT;
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS local_saida TEXT DEFAULT 'loja';
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2);
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS comissao_valor NUMERIC(12,2);
ALTER TABLE vendas         ADD COLUMN IF NOT EXISTS faturada_em TIMESTAMPTZ;

ALTER TABLE itens_venda    ADD COLUMN IF NOT EXISTS desconto_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE itens_venda    ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) DEFAULT 0;

-- ------------------------------------------------------------
-- 2.5) FASE 3 — Produção e custo real
-- ------------------------------------------------------------

-- Itens de uma OP "por grade": uma linha por tamanho.
CREATE TABLE IF NOT EXISTS itens_ordem (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER REFERENCES ordens_fabricacao(id) ON DELETE CASCADE,
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL DEFAULT 0,
  produzido INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now()
);

-- Colunas novas de OP: tipo (tamanho | grade), etapa, facção, observações.
ALTER TABLE ordens_fabricacao ALTER COLUMN tamanho_id DROP NOT NULL;
ALTER TABLE ordens_fabricacao ALTER COLUMN quantidade DROP NOT NULL;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'tamanho';
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS etapa TEXT;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS faccao TEXT;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS observacoes TEXT;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS concluida_em TIMESTAMPTZ;

-- Ficha técnica: perda de cada insumo + custo calculado + preço sugerido.
ALTER TABLE itens_ficha_tecnica ADD COLUMN IF NOT EXISTS perda_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS custo_calculado NUMERIC(12,2);
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS preco_sugerido NUMERIC(12,2);
ALTER TABLE fichas_tecnicas ADD COLUMN IF NOT EXISTS calculado_em TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 2.6) FASE 4 — Locais, transferências e inventário
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locais (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT DEFAULT 'loja',        -- loja | expedicao | faccao
  ativo BOOLEAN DEFAULT TRUE,
  padrao BOOLEAN DEFAULT FALSE,            -- local padrão (origem das movimentações)
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

ALTER TABLE locais ADD COLUMN IF NOT EXISTS padrao BOOLEAN DEFAULT FALSE;

ALTER TABLE estoques      ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS local_destino TEXT;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS local_destino_id INTEGER REFERENCES locais(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS transferencia_id INTEGER;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS compra_id INTEGER REFERENCES compras(id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_transferencia ON movimentacoes (transferencia_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_compra ON movimentacoes (compra_id);

-- Estorno de movimentações: a movimentação original é preservada e marcada como
-- estornada, apontando para o lançamento inverso que reverteu o saldo.
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS estornado BOOLEAN DEFAULT false;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS estornado_em TIMESTAMPTZ;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS estornado_por TEXT;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS movimentacao_estorno_id INTEGER REFERENCES movimentacoes(id);

-- Consulta do histórico por célula da grade (produto + tamanho, mais recentes primeiro).
CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto_tamanho ON movimentacoes (produto_id, tamanho_id, id DESC);

-- Inventários (contagem física) e seus itens
CREATE TABLE IF NOT EXISTS inventarios (
  id SERIAL PRIMARY KEY,
  local TEXT NOT NULL,
  local_id INTEGER REFERENCES locais(id),
  status TEXT DEFAULT 'aberto',            -- aberto | fechado
  CONSTRAINT inventarios_status_valido CHECK (status IN ('aberto', 'fechado')),
  aberto_por TEXT,
  aberto_em TIMESTAMPTZ DEFAULT now(),
  fechado_por TEXT,
  fechado_em TIMESTAMPTZ,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS itens_inventario (
  id SERIAL PRIMARY KEY,
  inventario_id INTEGER REFERENCES inventarios(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  saldo_sistema INTEGER DEFAULT 0,
  contado INTEGER,
  diferenca INTEGER DEFAULT 0,
  UNIQUE (inventario_id, produto_id, tamanho_id)
);

-- ------------------------------------------------------------
-- 2.7) FASE 6 — Segurança de senhas e sessões
-- ------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expira_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trocar_senha BOOLEAN DEFAULT FALSE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_versao INTEGER DEFAULT 0;

-- Fase 7 — preferências por usuário (JSONB opcional)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS preferencias JSONB DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------
-- 2.8) FASE 7 — Catálogos públicos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalogos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  senha_hash TEXT,                         -- opcional (acesso com senha)
  colecao_id INTEGER REFERENCES colecoes(id),
  categoria_id INTEGER REFERENCES categorias(id),
  filtros JSONB,                           -- legado: { colecao_id?, categoria_id? }
  mostrar_preco BOOLEAN DEFAULT FALSE,
  mostrar_saldo BOOLEAN DEFAULT FALSE,
  mostrar_medidas BOOLEAN DEFAULT FALSE,
  ativo BOOLEAN DEFAULT TRUE,
  expira_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Bancos que já tinham a tabela sem as colunas (CREATE TABLE IF NOT EXISTS
-- não altera o existente). Sem isso, GET /api/catalogos quebra com:
--   "column t.colecao_id does not exist"
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS colecao_id INTEGER REFERENCES colecoes(id);
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias(id);

-- Copia filtros JSONB antigos para as colunas (só se a FK existir).
UPDATE catalogos c
SET colecao_id = x.id
FROM colecoes x
WHERE c.colecao_id IS NULL
  AND c.filtros ? 'colecao_id'
  AND (c.filtros->>'colecao_id') ~ '^[0-9]+$'
  AND x.id = (c.filtros->>'colecao_id')::int;

UPDATE catalogos c
SET categoria_id = x.id
FROM categorias x
WHERE c.categoria_id IS NULL
  AND c.filtros ? 'categoria_id'
  AND (c.filtros->>'categoria_id') ~ '^[0-9]+$'
  AND x.id = (c.filtros->>'categoria_id')::int;

-- ------------------------------------------------------------
-- 2.9) COMÉRCIO — varejo/atacado, catálogo com pedido e exposição no site
-- ------------------------------------------------------------

-- Produto: preço de atacado, quantidade mínima, exibição no site/catálogo
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_atacado NUMERIC(12,2) DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS atacado_min_qtd INTEGER DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS exibir_site BOOLEAN DEFAULT FALSE;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS destaque BOOLEAN DEFAULT FALSE;

-- Venda: canal de venda e dados financeiros (a receber / recebido).
-- A FK fin_conta_id é criada em 2.10, depois da tabela contas_financeiras.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS canal_venda TEXT DEFAULT 'balcao';
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS fin_status TEXT DEFAULT 'a_receber';
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS fin_forma_pagamento TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS fin_recebido_em DATE;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS fin_documento TEXT;

-- Compra: dados financeiros (a pagar / pago)
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_status TEXT DEFAULT 'a_pagar';
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_forma_pagamento TEXT;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_pago_em DATE;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_documento TEXT;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS local_entrada TEXT;

-- Catálogo: canal (varejo/atacado), tabela de preço, pedido pelo site
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS canal TEXT DEFAULT 'todos';
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS tabela_preco TEXT DEFAULT 'automatico';
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS aceita_pedido_site BOOLEAN DEFAULT TRUE;
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS como_comprar TEXT;
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS mostrar_medidas BOOLEAN DEFAULT FALSE;

-- ------------------------------------------------------------
-- 2.10) FINANCEIRO — livro-caixa, contas, categorias, investidores e aportes
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categorias_financeiras (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT DEFAULT 'despesa',           -- receita | despesa | investimento
  cor TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_categorias_financeiras_nome ON categorias_financeiras (LOWER(nome));

CREATE TABLE IF NOT EXISTS contas_financeiras (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT DEFAULT 'caixa',             -- caixa | banco | pix | cartao | boleto | outro
  saldo_inicial NUMERIC(12,2) DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_contas_financeiras_nome ON contas_financeiras (LOWER(nome));

-- Liga vendas/compras à conta financeira. Criada após a tabela de contas
-- para que a migração funcione também em instalações novas.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS fin_conta_id INTEGER REFERENCES contas_financeiras(id);
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_conta_id INTEGER REFERENCES contas_financeiras(id);

CREATE TABLE IF NOT EXISTS investidores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cnpj_cpf TEXT,
  tipo TEXT DEFAULT 'investidor',        -- investidor | socio | emprestador
  participacao_pct NUMERIC(5,2) DEFAULT 0,
  email TEXT,
  telefone TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS aportes (
  id SERIAL PRIMARY KEY,
  investidor_id INTEGER REFERENCES investidores(id),
  data DATE NOT NULL DEFAULT now(),
  tipo TEXT DEFAULT 'aporte',            -- capital_inicial | aporte | reinvestimento | emprestimo_socio | distribuicao_lucro
  valor NUMERIC(12,2) NOT NULL,
  forma_pagamento TEXT DEFAULT 'pix',
  conta_id INTEGER REFERENCES contas_financeiras(id),
  status TEXT DEFAULT 'previsto',        -- previsto | confirmado | estornado
  observacoes TEXT,
  fin_lancamento_id INTEGER,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lancamentos_financeiros (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL DEFAULT now(),
  tipo TEXT NOT NULL DEFAULT 'despesa',  -- receita | despesa | investimento | estorno
  categoria_id INTEGER REFERENCES categorias_financeiras(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  descricao TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  forma_pagamento TEXT,
  status TEXT DEFAULT 'confirmado',      -- confirmado | pendente | cancelado
  referencia_tipo TEXT,                  -- venda | compra | aporte | outro
  referencia_id INTEGER,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
-- Lançamento: vencimento, parcelas e vínculo com recorrência geradora
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS vencimento DATE;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS parcela INTEGER DEFAULT 1;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS total_parcelas INTEGER DEFAULT 1;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS referencia_recorrencia_id INTEGER;

-- Contas a receber/a pagar de vendas e compras
ALTER TABLE vendas  ADD COLUMN IF NOT EXISTS fin_vencimento DATE;
ALTER TABLE vendas  ADD COLUMN IF NOT EXISTS fin_parcelas INTEGER DEFAULT 1;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_vencimento DATE;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_parcelas INTEGER DEFAULT 1;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fin_parcelas_detalhes JSONB;

-- Categoria: classe usada na DRE gerencial
ALTER TABLE categorias_financeiras ADD COLUMN IF NOT EXISTS classificacao_dre TEXT DEFAULT 'despesas_operacionais';

-- Recorrências financeiras: despesas/receitas fixas (aluguel, energia, folha...)
CREATE TABLE IF NOT EXISTS recorrencias_financeiras (
  id SERIAL PRIMARY KEY,
  descricao TEXT NOT NULL,
  tipo TEXT DEFAULT 'despesa',           -- receita | despesa | investimento
  categoria_id INTEGER REFERENCES categorias_financeiras(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  valor NUMERIC(12,2) NOT NULL,
  forma_pagamento TEXT,
  frequencia TEXT DEFAULT 'mensal',      -- semanal | mensal | anual
  dia INTEGER DEFAULT 1,
  proxima_geracao DATE,
  status TEXT DEFAULT 'ativo',           -- ativo | inativo
  ultimo_gerado_em TIMESTAMPTZ,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recor_fin_proxima ON recorrencias_financeiras (status, proxima_geracao);
CREATE INDEX IF NOT EXISTS idx_recor_fin_status   ON recorrencias_financeiras (status);

CREATE INDEX IF NOT EXISTS idx_lanc_fin_data       ON lancamentos_financeiros (data DESC);
CREATE INDEX IF NOT EXISTS idx_lanc_fin_tipo       ON lancamentos_financeiros (tipo, status);
CREATE INDEX IF NOT EXISTS idx_lanc_fin_categoria  ON lancamentos_financeiros (categoria_id);
CREATE INDEX IF NOT EXISTS idx_lanc_fin_conta      ON lancamentos_financeiros (conta_id);
CREATE INDEX IF NOT EXISTS idx_lanc_fin_referencia ON lancamentos_financeiros (referencia_tipo, referencia_id);
CREATE INDEX IF NOT EXISTS idx_aportes_data        ON aportes (data DESC);
CREATE INDEX IF NOT EXISTS idx_aportes_invest      ON aportes (investidor_id);

-- ------------------------------------------------------------
-- 2.11) FINANCEIRO PROFISSIONAL — centros de custo, plano de
-- contas hierárquico, taxas de operadora e transferências
-- ------------------------------------------------------------

-- Centros de custo (Loja, Produção/Facção, Administrativo, Marketing...)
CREATE TABLE IF NOT EXISTS centros_custo (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  descricao TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_centros_custo_codigo ON centros_custo (LOWER(codigo));
CREATE UNIQUE INDEX IF NOT EXISTS uq_centros_custo_nome   ON centros_custo (LOWER(nome));

-- Plano de contas hierárquico: categoria pode ter categoria-pai
ALTER TABLE categorias_financeiras ADD COLUMN IF NOT EXISTS pai_id INTEGER REFERENCES categorias_financeiras(id);

-- Lançamento: centro de custo e taxas de operadora (Mercado Pago, cartão...)
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS centro_custo_id INTEGER REFERENCES centros_custo(id);
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS taxa_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS valor_liquido NUMERIC(12,2);

-- Recorrência: centro de custo padrão para os lançamentos gerados
ALTER TABLE recorrencias_financeiras ADD COLUMN IF NOT EXISTS centro_custo_id INTEGER REFERENCES centros_custo(id);

-- Transferências entre contas (Caixa → Banco Inter, Mercado Pago → Banco...).
-- Espelhadas como par de lançamentos do tipo 'transferencia' (neutros no DRE).
CREATE TABLE IF NOT EXISTS transferencias_financeiras (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL DEFAULT now(),
  conta_origem_id INTEGER NOT NULL REFERENCES contas_financeiras(id),
  conta_destino_id INTEGER NOT NULL REFERENCES contas_financeiras(id),
  valor NUMERIC(12,2) NOT NULL,
  descricao TEXT,
  status TEXT DEFAULT 'confirmado',      -- confirmado | cancelado
  lancamento_saida_id INTEGER,
  lancamento_entrada_id INTEGER,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_transf_fin_data    ON transferencias_financeiras (data DESC);
CREATE INDEX IF NOT EXISTS idx_transf_fin_origem  ON transferencias_financeiras (conta_origem_id);
CREATE INDEX IF NOT EXISTS idx_transf_fin_destino ON transferencias_financeiras (conta_destino_id);

-- Recorrência não gera duplicata concorrente (cron + botão ao mesmo tempo).
-- Defensivo: se houver duplicata histórica, o índice é adiado (NOTICE) para
-- não derrubar o boot — a limpeza vira exceção operacional registrada.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lanc_fin_recorrencia_vencimento
    ON lancamentos_financeiros (referencia_recorrencia_id, vencimento)
    WHERE referencia_recorrencia_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'uq_lanc_fin_recorrencia_vencimento adiado: existem duplicatas de recorrência para revisar.';
END $$;

CREATE INDEX IF NOT EXISTS idx_lanc_fin_centro_custo ON lancamentos_financeiros (centro_custo_id);

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
-- ERP-03 (P0-05): o índice UNIQUE GLOBAL de `codigo_barras` NÃO volta a ser
-- criado aqui. Desde a 0018 a unicidade é POR EMPRESA
-- (`uq_produtos_codigo_barras_empresa`, criado mais abaixo e na 0018), e este
-- CREATE rodava a cada boot ANTES do DROP daquele trecho: num banco que já tem o
-- mesmo código de barras em duas empresas — estado legítimo desde a 0018 — o
-- boot morria em `could not create unique index "uq_produtos_codigo_barras"` e
-- a API não subia. O DROP mais abaixo continua limpando o índice legado.
CREATE INDEX IF NOT EXISTS idx_produtos_categoria   ON produtos (categoria_id);
CREATE INDEX IF NOT EXISTS idx_produtos_cor         ON produtos (cor_id);
-- FIX 2026-09-04: índice para o filtro por coleção dos catálogos públicos
CREATE INDEX IF NOT EXISTS idx_produtos_colecao     ON produtos (colecao_id);

-- Fase 2: itens de pedidos e estoque de insumos
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS produto_id INTEGER REFERENCES produtos(id);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS tamanho_id INTEGER REFERENCES tamanhos(id);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS codigo_fornecedor TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS ncm TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS cfop TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS dados_fiscais JSONB;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS local TEXT;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS local_entrada TEXT;
CREATE TABLE IF NOT EXISTS produto_fornecedor_skus (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  codigo_fornecedor TEXT NOT NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (fornecedor_id, codigo_fornecedor)
);
CREATE TABLE IF NOT EXISTS importacoes_nfe (
  id SERIAL PRIMARY KEY,
  chave_acesso TEXT UNIQUE NOT NULL,
  xml_hash TEXT NOT NULL,
  compra_id INTEGER REFERENCES compras(id),
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  numero TEXT,
  serie TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  dados_fiscais JSONB,
  importado_em TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_insumos_insumo ON estoque_insumos (insumo_id);
CREATE INDEX IF NOT EXISTS idx_itens_venda_venda     ON itens_venda (venda_id);
CREATE INDEX IF NOT EXISTS idx_itens_compra_compra   ON itens_compra (compra_id);
CREATE INDEX IF NOT EXISTS idx_produto_fornecedor_sku ON produto_fornecedor_skus (fornecedor_id, codigo_fornecedor);
CREATE INDEX IF NOT EXISTS idx_importacoes_nfe_compra ON importacoes_nfe (compra_id);
CREATE INDEX IF NOT EXISTS idx_mov_insumos_insumo    ON movimentacoes_insumos (insumo_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_vendas_faturada       ON vendas (faturada_em);

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

-- Fase 3: ficha única por produto; itens de OP e grade
CREATE UNIQUE INDEX IF NOT EXISTS uq_fichas_tecnicas_produto ON fichas_tecnicas (produto_id);
CREATE INDEX IF NOT EXISTS idx_itens_ordem_ordem       ON itens_ordem (ordem_id);
CREATE INDEX IF NOT EXISTS idx_ficha_insumos_ficha     ON itens_ficha_tecnica (ficha_id);
CREATE INDEX IF NOT EXISTS idx_inventario_status       ON inventarios (status);
CREATE INDEX IF NOT EXISTS idx_itens_inventario_inv    ON itens_inventario (inventario_id);
CREATE INDEX IF NOT EXISTS idx_catalogos_token         ON catalogos (token);

-- E4.2 remove o antigo backfill global por texto de local. Registros legados
-- sem local_id permanecem intactos; qualquer associação exige decisão explícita
-- e validada dentro da empresa. Também não se escolhe um local padrão global.

-- ------------------------------------------------------------
-- 4.2) Padrões de coluna dos locais (bancos já existentes)
-- ------------------------------------------------------------
ALTER TABLE estoques      ALTER COLUMN local       SET DEFAULT 'loja';
ALTER TABLE movimentacoes ALTER COLUMN local       SET DEFAULT 'loja';
ALTER TABLE vendas        ALTER COLUMN local_saida SET DEFAULT 'loja';
ALTER TABLE locais        ALTER COLUMN tipo        SET DEFAULT 'loja';

-- ------------------------------------------------------------
-- FASE 8 — NF-e, chat e melhorias
-- ------------------------------------------------------------

-- NF-e (vendas)
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_numero TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_emitida_em TIMESTAMPTZ;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_provider TEXT;
-- Estado real da nota: sem esta coluna, uma simulação aparecia como documento emitido.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_status TEXT NOT NULL DEFAULT 'nao_emitida';

-- Status pendente_aprovacao (workflow de aprovação)
-- (já coberto pelo status TEXT existente)

-- Chat interno (usa tabela auditoria com recurso='chat')
-- Nenhum schema novo necessário — auditoria já suporta JSONB

-- ============================================================
-- Fase 8 — Autenticação profissional
-- ============================================================

-- Sessões de login (invalidação por dispositivo — JTI no JWT)
CREATE TABLE IF NOT EXISTS sessoes (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  revogada_em TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);

-- Rate limit PERSISTENTE (login/reset/MFA/convites — sobrevive a reinícios)
CREATE TABLE IF NOT EXISTS login_tentativas (
  chave TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  primeira_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  bloqueado_ate TIMESTAMPTZ
);

-- Auditoria segura: cadeia de hashes (tamper-evidence)
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS hash_anterior TEXT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS hash TEXT;

-- MFA/TOTP (segredo gravado CIFRADO — chave em MFA_ENCRYPTION_KEY ou derivada de JWT_SECRET)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mfa_ativado_em TIMESTAMPTZ;

-- Convite de acesso (token só em hash; expiração)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS convite_token_hash TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS convite_expira_em TIMESTAMPTZ;

-- Estado da senha (provisória = gerada pelo admin, troca obrigatória)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_provisoria BOOLEAN DEFAULT FALSE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_definida_em TIMESTAMPTZ;
UPDATE usuarios SET senha_definida_em = COALESCE(atualizado_em, criado_em, now())
 WHERE senha_hash IS NOT NULL AND senha_definida_em IS NULL;

-- Fim do cofre de senhas: a coluna de senha reversível é DESTRUÍDA.
-- (As senhas ficam apenas em hash Argon2id/bcrypt — nunca recuperáveis.)
ALTER TABLE usuarios DROP COLUMN IF EXISTS senha_cifrada;

-- ------------------------------------------------------------
-- 0008) USUÁRIOS PROFISSIONAL — cadastro, ciclo de vida e segurança
-- (espelho do db/migrations/0008_usuarios_profissional.sql para bancos novos)
-- ------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cargo TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS departamento TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS observacoes TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_ate TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tentativas_falhas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_falha_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_ip TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_expira_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_por INTEGER;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_por TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_motivo TEXT;
UPDATE usuarios SET tentativas_falhas = 0 WHERE tentativas_falhas IS NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_ativo ON usuarios (ativo);
CREATE INDEX IF NOT EXISTS idx_usuarios_perfil ON usuarios (perfil);
CREATE INDEX IF NOT EXISTS idx_usuarios_bloqueado ON usuarios (bloqueado_ate) WHERE bloqueado_ate IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_convite ON usuarios (convite_expira_em) WHERE convite_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_ultimo_login ON usuarios (ultimo_login DESC NULLS LAST);

-- ------------------------------------------------------------
-- Grades de tamanhos: vínculo com categoria (padrão) e produto (override)
-- ------------------------------------------------------------
ALTER TABLE categorias ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id);
ALTER TABLE produtos   ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id);

-- ------------------------------------------------------------
-- 2.11) TABELA DE MEDIDAS — instruções para o cliente + trilha de atualização
-- ------------------------------------------------------------

-- Grade: texto "como medir" + tolerância, exibido junto da tabela de medidas
-- (catálogo público, detalhe do produto, impressão, etiquetas).
ALTER TABLE grades ADD COLUMN IF NOT EXISTS instrucoes_medidas TEXT;

-- Cada valor de medida registra quando foi preenchido/alterado — o cliente vê
-- "atualizada em" e o time sabe qual grade está desatualizada.
ALTER TABLE medida_valores ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_medida_valores_tamanho ON medida_valores (tamanho_id);

-- Novos catálogos nascem com a tabela de medidas visível (padrão da API; os
-- catálogos já existentes não são alterados — a visibilidade é uma escolha).
ALTER TABLE catalogos ALTER COLUMN mostrar_medidas SET DEFAULT TRUE;
-- Fase 2: compartilhamentos individualizados e eventos comerciais.
CREATE TABLE IF NOT EXISTS catalogo_compartilhamentos (
  id BIGSERIAL PRIMARY KEY,
  catalogo_id INTEGER NOT NULL REFERENCES catalogos(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  canal TEXT NOT NULL DEFAULT 'link',
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  primeiro_acesso_em TIMESTAMPTZ,
  ultimo_acesso_em TIMESTAMPTZ,
  acessos INTEGER NOT NULL DEFAULT 0 CHECK (acessos >= 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalogo_comp_catalogo ON catalogo_compartilhamentos(catalogo_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_catalogo_comp_cliente ON catalogo_compartilhamentos(cliente_id, criado_em DESC);
CREATE TABLE IF NOT EXISTS catalogo_eventos (
  id BIGSERIAL PRIMARY KEY,
  compartilhamento_id BIGINT REFERENCES catalogo_compartilhamentos(id) ON DELETE CASCADE,
  catalogo_id INTEGER NOT NULL REFERENCES catalogos(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  pedido_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  valor NUMERIC(12,2),
  tipo TEXT NOT NULL CHECK (tipo IN ('abertura','produto_visualizado','carrinho_iniciado','pedido_enviado')),
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalogo_eventos_funil ON catalogo_eventos(catalogo_id, tipo, criado_em DESC);
-- Fase 3A: motor de políticas comerciais sazonais e hierárquicas.
CREATE TABLE IF NOT EXISTS politicas_comerciais (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  escopo TEXT NOT NULL DEFAULT 'geral' CHECK (escopo IN ('geral','canal','colecao','catalogo','cliente')),
  canal TEXT CHECK (canal IS NULL OR canal IN ('varejo','atacado','todos')),
  colecao_id INTEGER REFERENCES colecoes(id) ON DELETE CASCADE,
  catalogo_id INTEGER REFERENCES catalogos(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  inicio_em DATE,
  fim_em DATE,
  prioridade INTEGER NOT NULL DEFAULT 0,
  desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (desconto_pct BETWEEN 0 AND 100),
  pedido_min_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pedido_min_valor >= 0),
  pedido_min_pecas INTEGER NOT NULL DEFAULT 0 CHECK (pedido_min_pecas >= 0),
  produto_min_qtd INTEGER NOT NULL DEFAULT 0 CHECK (produto_min_qtd >= 0),
  multiplo_qtd INTEGER NOT NULL DEFAULT 1 CHECK (multiplo_qtd >= 1),
  reserva_horas INTEGER NOT NULL DEFAULT 0 CHECK (reserva_horas >= 0),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_politicas_vigencia ON politicas_comerciais(ativo, inicio_em, fim_em);
CREATE INDEX IF NOT EXISTS idx_politicas_contexto ON politicas_comerciais(escopo, catalogo_id, colecao_id, cliente_id, canal);
-- Fase 3B: capacidades comerciais por usuário (herdar/permitir/negar) e alçadas.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_catalogos TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_catalogos IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_compartilhar TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_compartilhar IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_metricas TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_metricas IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_politicas TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_politicas IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_aprovar TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_aprovar IN ('herdar','permitir','negar'));
-- Autorização para alterar o preço de TABELA dentro da venda (espelho de db/migrations/0039).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_preco_tabela TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_preco_tabela IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desconto_max_pct NUMERIC(5,2) CHECK (desconto_max_pct IS NULL OR desconto_max_pct BETWEEN 0 AND 100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS venda_sem_aprovacao_ate NUMERIC(12,2) CHECK (venda_sem_aprovacao_ate IS NULL OR venda_sem_aprovacao_ate >= 0);
-- Fase 4: acessos aleatórios revogáveis e decisões imutáveis sobre cotações.
CREATE TABLE IF NOT EXISTS portal_acessos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  ultimo_acesso_em TIMESTAMPTZ,
  acessos INTEGER NOT NULL DEFAULT 0 CHECK (acessos >= 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_acessos_cliente ON portal_acessos(cliente_id, criado_em DESC);
CREATE TABLE IF NOT EXISTS cotacao_decisoes (
  id BIGSERIAL PRIMARY KEY,
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  decisao TEXT NOT NULL CHECK (decisao IN ('aceitar','recusar','alteracao')),
  responsavel TEXT NOT NULL,
  mensagem TEXT,
  proposta_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cotacao_decisoes_venda ON cotacao_decisoes(venda_id, criado_em DESC);

-- 0009) USUÁRIOS ONDA 3 — bloqueio manual + códigos de recuperação do MFA
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueio_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mfa_backup_hashes TEXT;
UPDATE usuarios SET bloqueio_manual = FALSE WHERE bloqueio_manual IS NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_bloqueio_manual ON usuarios (bloqueio_manual) WHERE bloqueio_manual = TRUE;

-- 0010) GOVERNANÇA ONDA 4 — histórico de senha, certificação, configurações, webhooks
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_historico TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_por TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_obs TEXT;
CREATE TABLE IF NOT EXISTS configuracoes (
  id SERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  valor TEXT NOT NULL DEFAULT '',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por TEXT
);
CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT NOT NULL,
  segredo_cifrado TEXT,
  eventos TEXT NOT NULL DEFAULT '[]',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_entregas (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'erro',
  tentativas INTEGER NOT NULL DEFAULT 1,
  resposta_status INTEGER,
  resposta_corpo TEXT,
  erro TEXT,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webhook_entregas_webhook ON webhook_entregas (webhook_id, id DESC);


-- ============================================================
-- 0012) FUSÃO COMMERCE → ERP — Brobond AI ERP (Fase 1)
-- (espelho do db/migrations/0012_fusion_commerce_into_erp.sql e da
--  migration Prisma prisma/migrations/20261005120000_fusion_commerce_into_erp/)
--
-- Motor comercial do brobond-ai-commerce como módulo de conectores
-- multicanal: conectores (Mercado Livre, Mercado Pago, Nuvemshop e
-- Instagram Shopping), eventos, estados OAuth e vendas
-- com itens casados no catálogo do ERP (produtos/tamanhos). FK de
-- tenancy aponta para usuarios (RESTRICT — nada de login é alterado).
-- ============================================================

-- ------------------------------------------------------------------
-- ENUMS (tipos snake_case, coerentes com o padrão do banco do ERP;
-- @@map no prisma/schema.prisma aponta para estes nomes)
-- ------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "sale_status" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- LOJA_FISICA (motor analítico "1. MEU NEGÓCIOS"): vendas presenciais
  -- registradas manualmente — completa os grupos Loja Física / E-commerce
  -- (BROBOND, INSTAGRAM_SHOPPING, NUVEMSHOP, MERCADOPAGO) / Marketplaces
  -- (MERCADOLIVRE).
  CREATE TYPE "sale_channel" AS ENUM ('BROBOND', 'INSTAGRAM_SHOPPING', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP', 'LOJA_FISICA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Bancos que já têm o enum (criado antes do canal de loja física):
ALTER TYPE "sale_channel" ADD VALUE IF NOT EXISTS 'LOJA_FISICA';

DO $$ BEGIN
  CREATE TYPE "connector_provider" AS ENUM ('INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "connection_status" AS ENUM (
    'DISCONNECTED', 'CONNECTED', 'EXPIRED', 'ERROR',
    'PENDING_APPROVAL', 'REAUTH_REQUIRED', 'SANDBOX_ACTIVE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- CONECTORES MULTICANAL
-- ------------------------------------------------------------------

-- Uma integração ativa com marketplace/meio de pagamento
-- (Mercado Livre, Mercado Pago, Nuvemshop, Instagram Shopping).
-- Credenciais SEMPRE cifradas em AES-256-GCM (CONNECTOR_ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,                       -- cuid() gerado pelo Prisma
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  provider "connector_provider" NOT NULL,
  status "connection_status" NOT NULL DEFAULT 'DISCONNECTED',
  shop_id TEXT,                              -- id no provedor (shop/conta/coletor)
  shop_name TEXT,
  access_token TEXT,                         -- cifra AES-256-GCM v1.iv.tag.valor
  refresh_token TEXT,                        -- cifra AES-256-GCM
  client_secret TEXT,                        -- cifra AES-256-GCM
  public_key TEXT,                           -- MP public key (cifrada)
  expires_at TIMESTAMPTZ,
  imported_count INTEGER NOT NULL DEFAULT 0, -- KPIs reais de sincronização
  duplicated_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  sync_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB,                            -- extras não-secretos do provedor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- @updatedAt + default p/ SQL manual
);

-- Um conector por provedor por responsável (contrato do commerce).
CREATE UNIQUE INDEX IF NOT EXISTS connectors_usuario_id_provider_key
  ON connectors (usuario_id, provider);
CREATE INDEX IF NOT EXISTS connectors_usuario_id_status_idx
  ON connectors (usuario_id, status);
CREATE INDEX IF NOT EXISTS connectors_provider_shop_id_idx
  ON connectors (provider, shop_id);

-- Evento bruto ingerido (webhook/polling) com deduplicação por
-- (responsável, provedor, id externo). Sobrevive à exclusão do
-- conector (SET NULL) como trilha de ingestão.
CREATE TABLE IF NOT EXISTS connector_events (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
  provider "connector_provider" NOT NULL,
  external_event_id TEXT NOT NULL,
  topic TEXT,
  payload JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_events_usuario_id_provider_external_event_id_key
  ON connector_events (usuario_id, provider, external_event_id);
CREATE INDEX IF NOT EXISTS connector_events_usuario_id_provider_created_at_idx
  ON connector_events (usuario_id, provider, created_at);
CREATE INDEX IF NOT EXISTS connector_events_connector_id_idx
  ON connector_events (connector_id);

-- Estado CSRF do fluxo OAuth de conexão (SHA-256 do state; expira em
-- minutos). Dado efêmero: CASCADE com o usuário.
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  provider "connector_provider" NOT NULL,
  state_hash TEXT NOT NULL,
  -- redirect_uri escolhido na autorização (origem dinâmica do painel, ex.:
  -- https://brobond-erp.onrender.com/api/connectors/<slug>/callback). A
  -- troca do código reusa EXATAMENTE este valor (contrato byte a byte).
  redirect_uri TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bancos criados antes desta coluna (boot com schema.sql antigo):
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS redirect_uri TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS connector_oauth_states_state_hash_key
  ON connector_oauth_states (state_hash);
CREATE INDEX IF NOT EXISTS connector_oauth_states_usuario_id_provider_expires_at_idx
  ON connector_oauth_states (usuario_id, provider, expires_at);

-- ------------------------------------------------------------------
-- VENDAS MULTICANAL
-- ------------------------------------------------------------------

-- Receita originada em qualquer canal (loja própria, Mercado Livre,
-- Mercado Pago, Nuvemshop, Instagram Shopping). Valores em CENTAVOS
-- (convenção do motor financeiro do commerce — Int, sem erro de
-- ponto flutuante). A venda do ERP B2B/offline continua em `vendas`;
-- `sales` é o lado multicanal sincronizado pelos conectores.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,                       -- cuid()
  reference TEXT NOT NULL,                   -- id canônico (checkout próprio)
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status "sale_status" NOT NULL DEFAULT 'PENDING',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel "sale_channel" NOT NULL DEFAULT 'BROBOND',
  external_order_id TEXT,                    -- id do pedido no marketplace
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_reference_key
  ON sales (reference);
-- Idempotência da ingestão: uma linha por (responsável, canal, pedido
-- externo). NULLs são distintos no Postgres → checkout próprio fora
-- da chave.
CREATE UNIQUE INDEX IF NOT EXISTS sales_usuario_id_channel_external_order_id_key
  ON sales (usuario_id, channel, external_order_id);
CREATE INDEX IF NOT EXISTS sales_status_idx ON sales (status);
CREATE INDEX IF NOT EXISTS sales_usuario_id_idx ON sales (usuario_id);
CREATE INDEX IF NOT EXISTS sales_usuario_id_status_idx ON sales (usuario_id, status);
CREATE INDEX IF NOT EXISTS sales_usuario_id_channel_idx ON sales (usuario_id, channel);
CREATE INDEX IF NOT EXISTS sales_channel_occurred_at_idx ON sales (channel, occurred_at);

-- Item da venda multicanal, casado com o catálogo REAL do ERP
-- (produtos + tamanhos) — espelha a semântica de itens_venda.
CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES tamanhos(id) ON DELETE SET NULL,
  variacao_externa TEXT,                     -- variante literal do marketplace
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product_id_idx ON sale_items (product_id);
CREATE INDEX IF NOT EXISTS sale_items_size_id_idx ON sale_items (size_id);

-- ------------------------------------------------------------------
-- MOTOR ANALÍTICO "1. MEU NEGÓCIOS" (migration 0016)
--
--   1) Margem por pedido em `sales`: lucro bruto = valor líquido −
--      CMV (ficha técnica) − impostos (alíquota/NCM) − frete pago,
--      materializado nas colunas reais gross_profit_cents/margin_pct.
--   2) Curva ABC contínua (80/15/5) persistida em `produto_abc`.
--   3) Filtros estritos de BI: De/Até, empresa_id e canal agrupado
--      (Loja Física / E-commerce / Marketplaces).
-- Espelha db/migrations/0016_meu_negocios_motor_analitico.sql —
-- idempotente para bancos existentes.
-- ------------------------------------------------------------------

-- EMPRESAS — multi-empresa pronta; BROBOND é a empresa padrão (id 1)
CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  razao_social TEXT,
  cnpj TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

INSERT INTO empresas (id, nome, razao_social)
VALUES (1, 'BROBOND', 'BROBOND CONFECÇÕES LTDA')
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('empresas', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM empresas), 1),
  true
);

CREATE INDEX IF NOT EXISTS empresas_ativo_idx ON empresas (ativo);

-- IMPOSTOS POR NCM — chaves de 8/6/4/2 dígitos; NULL = alíquota padrão.
-- O motor usa sempre a chave mais longa que casa com produtos.ncm; o
-- índice parcial garante uma única linha-padrão.
CREATE TABLE IF NOT EXISTS impostos_ncm (
  id SERIAL PRIMARY KEY,
  ncm TEXT UNIQUE,
  descricao TEXT,
  aliquota_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (aliquota_pct >= 0 AND aliquota_pct <= 100),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS impostos_ncm_ncm_idx ON impostos_ncm (ncm);
CREATE UNIQUE INDEX IF NOT EXISTS impostos_ncm_padrao_unico ON impostos_ncm ((true)) WHERE ncm IS NULL;

-- SALES — colunas do motor de margem (empresa + frete + cálculo real)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS freight_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS net_cents INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cmv_cents INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_cents INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS gross_profit_cents INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS margin_pct NUMERIC(12,4);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS margem_calculada_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sales_empresa_channel_occurred_idx
  ON sales (empresa_id, channel, occurred_at);
CREATE INDEX IF NOT EXISTS sales_empresa_status_occurred_idx
  ON sales (empresa_id, status, occurred_at);

-- CURVA ABC — classificação contínua por produto/empresa
CREATE TABLE IF NOT EXISTS produto_abc (
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  faturamento_cents BIGINT NOT NULL DEFAULT 0,
  pct_total NUMERIC(12,4) NOT NULL DEFAULT 0,
  pct_acumulado NUMERIC(12,4) NOT NULL DEFAULT 0,
  classe TEXT NOT NULL CHECK (classe IN ('A', 'B', 'C')),
  janela_de TIMESTAMPTZ,
  janela_ate TIMESTAMPTZ,
  calculado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, produto_id)
);

CREATE INDEX IF NOT EXISTS produto_abc_classe_idx ON produto_abc (empresa_id, classe);

-- ==================================================================
-- BLOCO P0 — MULTIEMPRESA, CADASTRO DE PRODUTO, TRIBUTAÇÃO E
-- DOCUMENTOS FISCAIS (migrations 0017 a 0020)
--
-- Espelha db/migrations/0017..0020 — idempotente, aplicado a cada
-- boot antes das migrations versionadas.
-- ==================================================================

-- ---- 0017_multiempresa_isolamento ----

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

-- E4.2 — diagnosticar antes do trigger legado de herança de empresa, que pode
-- regravar `empresa_id` nas filhas. Nenhuma referência/local é reatribuída aqui.
DO $e42_preflight_core$
DECLARE
  duplicatas_locais BIGINT;
  duplicatas_padroes BIGINT;
  duplicatas_saldos BIGINT;
  duplicatas_itens_inventario BIGINT;
  dados_saldos_invalidos BIGINT;
  vinculos_empresa BIGINT;
  vinculos_locais BIGINT;
  nomes_locais_inconsistentes BIGINT;
  saldos_sem_local BIGINT;
  saldos_sem_local_ambiguos BIGINT;
  movimentos_sem_local BIGINT;
  inventarios_sem_local BIGINT;
BEGIN
  SELECT count(*) INTO duplicatas_locais FROM (
    SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_padroes FROM (
    SELECT empresa_id FROM locais WHERE padrao IS TRUE GROUP BY empresa_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_saldos FROM (
    SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
    GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_itens_inventario FROM (
    SELECT empresa_id, inventario_id, produto_id, tamanho_id FROM itens_inventario
    GROUP BY empresa_id, inventario_id, produto_id, tamanho_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dados_saldos_invalidos FROM estoques WHERE produto_id IS NULL OR local IS NULL;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN produtos p ON p.id = e.produto_id
      WHERE e.produto_id IS NULL OR p.id IS NULL OR e.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id
      WHERE m.produto_id IS NULL OR p.id IS NULL OR m.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM estoque_insumos e LEFT JOIN insumos i ON i.id = e.insumo_id
      WHERE e.insumo_id IS NULL OR i.id IS NULL OR e.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN insumos i ON i.id = m.insumo_id
      WHERE m.insumo_id IS NULL OR i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM itens_compra ic
       LEFT JOIN compras c ON c.id = ic.compra_id
       LEFT JOIN produtos p ON p.id = ic.produto_id
       LEFT JOIN insumos i ON i.id = ic.insumo_id
      WHERE ic.compra_id IS NULL OR c.id IS NULL OR ic.empresa_id IS DISTINCT FROM c.empresa_id
         OR (ic.produto_id IS NOT NULL AND (p.id IS NULL OR ic.empresa_id IS DISTINCT FROM p.empresa_id))
         OR (ic.insumo_id IS NOT NULL AND (i.id IS NULL OR ic.empresa_id IS DISTINCT FROM i.empresa_id))) +
    (SELECT count(*) FROM itens_inventario ii
       LEFT JOIN inventarios inv ON inv.id = ii.inventario_id
       LEFT JOIN produtos p ON p.id = ii.produto_id
      WHERE ii.inventario_id IS NULL OR ii.produto_id IS NULL OR inv.id IS NULL OR p.id IS NULL
         OR ii.empresa_id IS DISTINCT FROM inv.empresa_id
         OR ii.empresa_id IS DISTINCT FROM p.empresa_id)
    INTO vinculos_empresa;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND (l.id IS NULL OR inv.empresa_id IS DISTINCT FROM l.empresa_id))
    INTO vinculos_locais;
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO nomes_locais_inconsistentes;

  SELECT count(*) INTO saldos_sem_local FROM estoques WHERE local_id IS NULL;
  SELECT count(*) INTO saldos_sem_local_ambiguos FROM estoques e
    WHERE e.local_id IS NULL AND (SELECT count(*) FROM locais l WHERE l.empresa_id = e.empresa_id AND l.nome = e.local) <> 1;
  SELECT count(*) INTO movimentos_sem_local FROM movimentacoes WHERE local_id IS NULL;
  SELECT count(*) INTO inventarios_sem_local FROM inventarios WHERE local_id IS NULL;
  IF saldos_sem_local + movimentos_sem_local + inventarios_sem_local > 0 THEN
    RAISE NOTICE 'E4.2 diagnóstico sem backfill: saldos sem local_id=%, dos quais sem correspondência única de nome na própria empresa=%; movimentações sem local_id=%; inventários sem local_id=%',
      saldos_sem_local, saldos_sem_local_ambiguos, movimentos_sem_local, inventarios_sem_local;
  END IF;

  IF duplicatas_locais + duplicatas_padroes + duplicatas_saldos + duplicatas_itens_inventario + dados_saldos_invalidos + vinculos_empresa + vinculos_locais + nomes_locais_inconsistentes > 0 THEN
    RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_sem_produto_ou_local=%, vinculos_empresa_inconsistentes=%, vinculos_locais_estrangeiros=%, nomes_locais_inconsistentes=%. Nenhum vínculo foi corrigido automaticamente.',
      duplicatas_locais, duplicatas_padroes, duplicatas_saldos, duplicatas_itens_inventario, dados_saldos_invalidos, vinculos_empresa, vinculos_locais, nomes_locais_inconsistentes
      USING HINT = 'Revise explicitamente os registros usando empresa_id e IDs canônicos; preserve os dados originais e execute novamente após correção administrativa.';
  END IF;
END
$e42_preflight_core$;

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

-- ---- 0018_produto_cadastro_completo ----

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

-- ---- 0019_tributacao_fiscal ----

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

-- ---- 0020_documentos_fiscais ----

CREATE TABLE IF NOT EXISTS documentos_fiscais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),

  -- Origem no ERP (a venda continua sendo a fonte; o documento é um satélite)
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  modelo TEXT NOT NULL DEFAULT '55',           -- 55 = NF-e | 65 = NFC-e
  operacao TEXT NOT NULL DEFAULT 'saida',      -- saida | entrada
  natureza_operacao TEXT,

  -- Máquina de estados
  status TEXT NOT NULL DEFAULT 'rascunho',
  motivo TEXT,                                 -- rejeição/erro legível
  tentativas INTEGER NOT NULL DEFAULT 0,

  -- Numeração (só preenchida quando o documento sai para o provedor)
  serie INTEGER,
  numero INTEGER,
  chave_acesso TEXT,
  protocolo TEXT,
  autorizado_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,
  cancelamento_protocolo TEXT,
  cancelamento_justificativa TEXT,

  -- Provedor
  provider TEXT NOT NULL DEFAULT 'nenhum',
  provider_ref TEXT,                           -- id do documento no provedor
  ambiente TEXT NOT NULL DEFAULT 'homologacao',

  -- Documentos armazenados
  xml TEXT,
  xml_cancelamento TEXT,
  danfe_url TEXT,
  danfe_pdf BYTEA,

  -- Totais congelados no momento do envio (auditoria fiscal)
  valor_produtos NUMERIC(12,2),
  valor_frete NUMERIC(12,2),
  valor_desconto NUMERIC(12,2),
  valor_total NUMERIC(12,2),
  valor_icms NUMERIC(12,2),
  valor_pis NUMERIC(12,2),
  valor_cofins NUMERIC(12,2),
  valor_ipi NUMERIC(12,2),

  -- Efeitos colaterais: aplicados UMA ÚNICA VEZ, na autorização
  estoque_baixado_em TIMESTAMPTZ,
  financeiro_lancado_em TIMESTAMPTZ,

  idempotency_key TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,

  CONSTRAINT documentos_fiscais_modelo_valido CHECK (modelo IN ('55', '65')),
  CONSTRAINT documentos_fiscais_operacao_valida CHECK (operacao IN ('saida', 'entrada')),
  CONSTRAINT documentos_fiscais_ambiente_valido CHECK (ambiente IN ('homologacao', 'producao')),
  CONSTRAINT documentos_fiscais_status_valido CHECK (status IN (
    'rascunho', 'pendente', 'processando', 'autorizado',
    'rejeitado', 'cancelado', 'inutilizado', 'erro'
  )),
  -- Autorizado EXIGE prova do provedor: chave + protocolo. Sem isso o estado
  -- é inalcançável — o banco impede a NF-e fantasma.
  CONSTRAINT documentos_fiscais_autorizado_tem_prova CHECK (
    status <> 'autorizado'
    OR (chave_acesso IS NOT NULL AND protocolo IS NOT NULL
        AND numero IS NOT NULL AND serie IS NOT NULL
        AND provider <> 'nenhum')
  ),
  CONSTRAINT documentos_fiscais_cancelado_tem_origem CHECK (
    status <> 'cancelado' OR chave_acesso IS NOT NULL
  ),
  CONSTRAINT documentos_fiscais_chave_formato CHECK (
    chave_acesso IS NULL OR chave_acesso ~ '^[0-9]{44}$'
  )
);

-- Uma chave de acesso é única no universo — e aqui também.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_chave
  ON documentos_fiscais (chave_acesso) WHERE chave_acesso IS NOT NULL;

-- Numeração não se repete dentro da empresa/modelo/série/ambiente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_numeracao
  ON documentos_fiscais (empresa_id, modelo, serie, numero, ambiente)
  WHERE numero IS NOT NULL;

-- Idempotência da emissão.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_idempotency
  ON documentos_fiscais (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Uma venda não pode ter dois documentos vivos do mesmo modelo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_venda_viva
  ON documentos_fiscais (venda_id, modelo)
  WHERE venda_id IS NOT NULL AND status IN ('rascunho', 'pendente', 'processando', 'autorizado');

CREATE INDEX IF NOT EXISTS documentos_fiscais_empresa_status_idx
  ON documentos_fiscais (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS documentos_fiscais_venda_idx ON documentos_fiscais (venda_id);

-- ----------------------------------------------------------------------------
-- Histórico/auditoria imutável do documento: toda transição vira uma linha.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos_fiscais_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  documento_id INTEGER NOT NULL REFERENCES documentos_fiscais(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  evento TEXT NOT NULL,                        -- emitir | consultar | cancelar | inutilizar | rejeicao | erro
  mensagem TEXT,
  payload JSONB,                               -- resposta bruta do provedor (sem segredos)
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documentos_fiscais_eventos_doc_idx
  ON documentos_fiscais_eventos (documento_id, criado_em DESC);

DROP TRIGGER IF EXISTS trg_empresa_documentos_fiscais_eventos ON documentos_fiscais_eventos;
CREATE TRIGGER trg_empresa_documentos_fiscais_eventos
  BEFORE INSERT OR UPDATE ON documentos_fiscais_eventos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('documentos_fiscais', 'documento_id');

-- ----------------------------------------------------------------------------
-- Inutilização de faixa de numeração (obrigação acessória)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inutilizacoes_fiscais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  modelo TEXT NOT NULL DEFAULT '55',
  serie INTEGER NOT NULL,
  numero_inicial INTEGER NOT NULL,
  numero_final INTEGER NOT NULL,
  justificativa TEXT NOT NULL,
  ambiente TEXT NOT NULL DEFAULT 'homologacao',
  status TEXT NOT NULL DEFAULT 'pendente',     -- pendente | homologado | rejeitado | erro
  protocolo TEXT,
  motivo TEXT,
  provider TEXT NOT NULL DEFAULT 'nenhum',
  xml TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT inutilizacoes_faixa_valida CHECK (numero_final >= numero_inicial AND numero_inicial > 0),
  CONSTRAINT inutilizacoes_justificativa_minima CHECK (char_length(justificativa) >= 15),
  CONSTRAINT inutilizacoes_status_valido CHECK (status IN ('pendente', 'homologado', 'rejeitado', 'erro')),
  CONSTRAINT inutilizacoes_modelo_valido CHECK (modelo IN ('55', '65'))
);

CREATE INDEX IF NOT EXISTS inutilizacoes_empresa_idx ON inutilizacoes_fiscais (empresa_id, modelo, serie);

-- ----------------------------------------------------------------------------
-- Venda: ligação com o documento fiscal vigente.
-- `nfe_status` legado permanece (a UI atual depende dele) e passa a ser
-- espelho do documento — nunca escrito à mão.
-- ----------------------------------------------------------------------------
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS documento_fiscal_id INTEGER REFERENCES documentos_fiscais(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_chave TEXT;
CREATE INDEX IF NOT EXISTS vendas_documento_fiscal_idx ON vendas (documento_fiscal_id);

-- ---- 0021_cadastros_pessoas ----

-- ----------------------------------------------------------------------------
-- 1) CLIENTES — PF/PJ, fiscal, endereço e comercial
-- ----------------------------------------------------------------------------
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pessoa TEXT NOT NULL DEFAULT 'pj';   -- pf | pj | estrangeiro
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rg_ie TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS indicador_ie TEXT NOT NULL DEFAULT '9'; -- 1 contribuinte | 2 isento | 9 não contribuinte
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS im TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS suframa TEXT;

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;              -- IBGE
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pais TEXT NOT NULL DEFAULT 'Brasil';

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS representante_id INTEGER REFERENCES representantes(id);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS observacoes TEXT;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_pessoa_valida CHECK (pessoa IN ('pf', 'pj', 'estrangeiro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_indicador_ie_valido CHECK (indicador_ie IN ('1', '2', '9'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_uf_valida
    CHECK (uf IS NULL OR uf = '' OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_limite_credito_nao_negativo CHECK (limite_credito >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill conservador: quem já tem CPF (11 dígitos) é PF; o resto segue PJ,
-- que é o default histórico do cadastro.
UPDATE clientes
   SET pessoa = 'pf'
 WHERE pessoa = 'pj'
   AND cnpj_cpf IS NOT NULL
   AND length(regexp_replace(cnpj_cpf, '[^0-9]', '', 'g')) = 11;

-- Documento único POR EMPRESA (duas empresas do grupo podem atender o mesmo
-- cliente). Índice parcial: cadastro sem documento continua permitido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_documento_empresa
  ON clientes (empresa_id, regexp_replace(cnpj_cpf, '[^0-9]', '', 'g'))
  WHERE cnpj_cpf IS NOT NULL AND regexp_replace(cnpj_cpf, '[^0-9]', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS clientes_representante_idx ON clientes (representante_id);

-- ----------------------------------------------------------------------------
-- 2) FORNECEDORES — espelho fiscal/comercial do cliente
-- ----------------------------------------------------------------------------
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS pessoa TEXT NOT NULL DEFAULT 'pj';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS ie TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS indicador_ie TEXT NOT NULL DEFAULT '1';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS im TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS prazo_entrega_dias INTEGER;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS condicao_pagamento TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS observacoes TEXT;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_pessoa_valida CHECK (pessoa IN ('pf', 'pj', 'estrangeiro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_indicador_ie_valido CHECK (indicador_ie IN ('1', '2', '9'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_uf_valida
    CHECK (uf IS NULL OR uf = '' OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_documento_empresa
  ON fornecedores (empresa_id, regexp_replace(cnpj, '[^0-9]', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '[^0-9]', '', 'g') <> '';

-- Contatos adicionais do fornecedor (compras, financeiro, expedição...).
CREATE TABLE IF NOT EXISTS fornecedor_contatos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cargo TEXT,
  email TEXT,
  telefone TEXT,
  whatsapp TEXT,
  principal BOOLEAN NOT NULL DEFAULT FALSE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fornecedor_contatos_fornecedor_idx ON fornecedor_contatos (fornecedor_id);
CREATE INDEX IF NOT EXISTS fornecedor_contatos_empresa_idx ON fornecedor_contatos (empresa_id);

DROP TRIGGER IF EXISTS trg_empresa_fornecedor_contatos ON fornecedor_contatos;
CREATE TRIGGER trg_empresa_fornecedor_contatos
  BEFORE INSERT OR UPDATE ON fornecedor_contatos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('fornecedores', 'fornecedor_id');

-- ----------------------------------------------------------------------------
-- 3) REPRESENTANTES → VENDEDORES / FUNCIONÁRIOS
--
-- A entidade existente é EVOLUÍDA (regra: não duplicar). `comissao_pct`,
-- `regiao`, `telefone` e `email` continuam valendo como estão.
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cpf TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cargo TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS admissao DATE;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS desligamento DATE;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS observacoes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_cpf_empresa
  ON representantes (empresa_id, regexp_replace(cpf, '[^0-9]', '', 'g'))
  WHERE cpf IS NOT NULL AND regexp_replace(cpf, '[^0-9]', '', 'g') <> '';

-- Um usuário do sistema representa no máximo um vendedor por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_usuario_empresa
  ON representantes (empresa_id, usuario_id)
  WHERE usuario_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_desligamento_coerente
    CHECK (desligamento IS NULL OR admissao IS NULL OR desligamento >= admissao);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- 0022_fiscal_config_id ----
ALTER TABLE empresa_fiscal_config ADD COLUMN IF NOT EXISTS id SERIAL;
DO $$ BEGIN
  ALTER TABLE empresa_fiscal_config ADD CONSTRAINT empresa_fiscal_config_id_unico UNIQUE (id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- ---- 0023_fiscal_provider_extensivel ----
ALTER TABLE empresa_fiscal_config DROP CONSTRAINT IF EXISTS empresa_fiscal_provider_valido;
DO $$ BEGIN
  ALTER TABLE empresa_fiscal_config ADD CONSTRAINT empresa_fiscal_provider_valido
    CHECK (provider ~ '^[a-z0-9_]{2,20}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- 0024_p1_comercial_logistica ----
-- Espelho da migration db/migrations/0024_p1_comercial_logistica.sql
-- (idempotente: um banco novo sobe completo por aqui, um banco antigo
--  recebe o mesmo conteúdo pela migration versionada).
-- ============================================================================
-- 0024 — FASE P1: operação comercial, logística e suprimentos
--
-- Esta migration é ADITIVA. Nenhuma tabela existente é renomeada, nenhuma
-- coluna antiga é removida, nenhum CHECK existente é enfraquecido.
--
-- Blocos:
--   A) Listas de preço            (listas_preco, lista_preco_itens, histórico)
--   B) Propostas comerciais       (propostas, proposta_itens, proposta_eventos)
--   C) PDV                        (pdv_caixas, pdv_caixa_movimentos, pdv_pagamentos)
--   D) Logística                  (envios, envio_eventos, ShippingProvider)
--   E) Expedição / conferência    (expedicao_eventos, divergencias_conferencia)
--   F) Logística reversa          (devolucoes, devolucao_itens)
--   G) Recebimento parcial        (compra_recebimentos, compra_recebimento_itens)
--   H) Colunas de amarração nas tabelas existentes
--
-- Idempotente: pode ser aplicada duas vezes, em banco limpo e em banco migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) LISTAS DE PREÇO
--
-- Uma lista é um conjunto de preços com vigência. A regra de aplicação é
-- determinística: lista ATIVA, dentro da vigência, com MAIOR prioridade; em
-- caso de empate, a mais recente. O preço escolhido é CONGELADO no item da
-- venda (itens_venda.lista_preco_id / preco_tabela), de modo que mudar a lista
-- depois não reescreve a história da venda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listas_preco (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  prioridade INTEGER NOT NULL DEFAULT 0,
  inicio_em DATE,
  fim_em DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT listas_preco_vigencia_coerente CHECK (
    inicio_em IS NULL OR fim_em IS NULL OR fim_em >= inicio_em
  )
);

CREATE INDEX IF NOT EXISTS listas_preco_empresa_ativa_idx
  ON listas_preco (empresa_id, ativo, prioridade DESC);

CREATE TABLE IF NOT EXISTS lista_preco_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lista_id INTEGER NOT NULL REFERENCES listas_preco(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  preco NUMERIC(12,2) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT lista_preco_itens_preco_positivo CHECK (preco >= 0)
);

-- Um produto tem UM preço por lista (não importa o caminho pelo qual se chega).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lista_preco_item
  ON lista_preco_itens (lista_id, produto_id);
CREATE INDEX IF NOT EXISTS lista_preco_itens_empresa_idx
  ON lista_preco_itens (empresa_id, produto_id);

-- Histórico de preço: toda alteração de preço de lista vira uma linha.
-- É o que permite responder "quanto este produto custava na lista X em maio?".
CREATE TABLE IF NOT EXISTS listas_preco_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lista_id INTEGER NOT NULL REFERENCES listas_preco(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  preco_anterior NUMERIC(12,2),
  preco_novo NUMERIC(12,2),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listas_preco_historico_idx
  ON listas_preco_historico (empresa_id, lista_id, produto_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- B) PROPOSTAS COMERCIAIS
--
-- Máquina de estados EXPLÍCITA e fechada no banco:
--   rascunho → enviada → aprovada → convertida
--                    ↘ recusada
--   (rascunho|enviada) → cancelada
--   (aprovada)         → expirada
--
-- A conversão para pedido é IDEMPOTENTE por três camadas:
--   1) `propostas.venda_id` é UNIQUE — uma proposta não aponta para dois pedidos;
--   2) o índice parcial `uq_vendas_proposta` impede duas vendas com a mesma proposta;
--   3) a transição usa UPDATE condicional (compare-and-swap) no status.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS propostas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  numero TEXT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  representante_id INTEGER REFERENCES representantes(id),
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  valida_ate DATE,
  status TEXT NOT NULL DEFAULT 'rascunho',
  condicao_pagamento TEXT,
  observacoes TEXT,
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
  frete NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Conversão: preenchido UMA vez. UNIQUE impede o segundo pedido.
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  convertido_em TIMESTAMPTZ,
  convertido_por INTEGER REFERENCES usuarios(id),
  recusado_em TIMESTAMPTZ,
  recusado_motivo TEXT,
  cancelado_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT propostas_status_valido CHECK (status IN (
    'rascunho', 'enviada', 'aprovada', 'recusada', 'convertida', 'cancelada', 'expirada'
  )),
  -- Uma proposta só é "convertida" se existir o pedido; e só tem pedido se convertida.
  CONSTRAINT propostas_convertida_tem_pedido CHECK (
    (status = 'convertida') = (venda_id IS NOT NULL)
  ),
  CONSTRAINT propostas_desconto_nao_negativo CHECK (desconto >= 0),
  CONSTRAINT propostas_frete_nao_negativo CHECK (frete >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_propostas_numero
  ON propostas (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS propostas_empresa_status_idx
  ON propostas (empresa_id, status, data DESC);
CREATE INDEX IF NOT EXISTS propostas_cliente_idx ON propostas (cliente_id);
-- A segunda camada de idempotência da conversão (índice único em
-- `vendas.proposta_id`) é criada na seção H, depois que a coluna existe.

CREATE TABLE IF NOT EXISTS proposta_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  proposta_id INTEGER NOT NULL REFERENCES propostas(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL,
  desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Preço congelado: qual lista deu este preço (auditoria comercial).
  lista_preco_id INTEGER REFERENCES listas_preco(id) ON DELETE SET NULL,
  preco_tabela NUMERIC(12,2),
  CONSTRAINT proposta_itens_quantidade_positiva CHECK (quantidade > 0),
  CONSTRAINT proposta_itens_desconto_valido CHECK (desconto_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS proposta_itens_proposta_idx ON proposta_itens (proposta_id);

CREATE TABLE IF NOT EXISTS proposta_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  proposta_id INTEGER NOT NULL REFERENCES propostas(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  mensagem TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposta_eventos_idx
  ON proposta_eventos (proposta_id, criado_em);

-- ----------------------------------------------------------------------------
-- C) PDV — ponto de venda
--
-- O caixa é uma entidade com abertura e fechamento. O fechamento compara o
-- valor contado com o valor esperado pelo sistema e grava a diferença — sem
-- isso não existe conferência de caixa.
--
-- A venda do PDV é a MESMA entidade `vendas` (canal_venda = 'pdv'): o ERP não
-- ganha um segundo motor de venda. Aqui entram apenas o vínculo com o caixa e
-- os pagamentos (uma venda de balcão pode ser paga em mais de uma forma).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdv_caixas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  numero TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  local TEXT,
  local_id INTEGER REFERENCES locais(id),
  abertura_em TIMESTAMPTZ,
  fechamento_em TIMESTAMPTZ,
  valor_abertura NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_fechamento NUMERIC(12,2),
  valor_sistema NUMERIC(12,2),
  diferenca NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'aberto',
  observacoes TEXT,
  fechado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT pdv_caixas_status_valido CHECK (status IN ('aberto', 'fechado', 'cancelado')),
  CONSTRAINT pdv_caixas_abertura_coerente CHECK (
    status <> 'fechado' OR (abertura_em IS NOT NULL AND fechamento_em IS NOT NULL)
  ),
  CONSTRAINT pdv_caixas_valor_abertura_valido CHECK (valor_abertura >= 0)
);
ALTER TABLE pdv_caixas ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id);

-- Um caixa aberto por vez, por empresa e por terminal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdv_caixas_aberto
  ON pdv_caixas (empresa_id, numero) WHERE status = 'aberto';
CREATE INDEX IF NOT EXISTS pdv_caixas_empresa_idx
  ON pdv_caixas (empresa_id, status, abertura_em DESC);

-- Suprimentos (entrada de troco) e sangrias (retirada) do caixa.
CREATE TABLE IF NOT EXISTS pdv_caixa_movimentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  caixa_id INTEGER NOT NULL REFERENCES pdv_caixas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pdv_caixa_movimentos_tipo_valido CHECK (tipo IN ('suprimento', 'sangria')),
  CONSTRAINT pdv_caixa_movimentos_valor_positivo CHECK (valor > 0)
);

CREATE INDEX IF NOT EXISTS pdv_caixa_movimentos_idx ON pdv_caixa_movimentos (caixa_id);

-- Pagamentos da venda de balcão: uma venda pode ser paga em dinheiro + cartão.
-- O servidor valida que a soma cobre o total; o troco é derivado, não digitado
-- como fonte de verdade.
CREATE TABLE IF NOT EXISTS pdv_pagamentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  caixa_id INTEGER REFERENCES pdv_caixas(id) ON DELETE SET NULL,
  forma TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  parcelas INTEGER NOT NULL DEFAULT 1,
  -- Comprovante da adquirente. NÃO é autorização fiscal: é o dado do cartão.
  nsu TEXT,
  bandeira TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pdv_pagamentos_forma_valida CHECK (forma IN (
    'dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'vale', 'boleto', 'transferencia', 'outros'
  )),
  CONSTRAINT pdv_pagamentos_valor_positivo CHECK (valor > 0),
  CONSTRAINT pdv_pagamentos_parcelas_validas CHECK (parcelas >= 1)
);

CREATE INDEX IF NOT EXISTS pdv_pagamentos_venda_idx ON pdv_pagamentos (venda_id);

-- ----------------------------------------------------------------------------
-- D) LOGÍSTICA — envios
--
-- O `provider` guarda o slug do adaptador (melhor_envio, correios, manual...).
-- Sem credencial o adaptador devolve "não configurado" e o envio NÃO é criado
-- como se tivesse sido postado: o mesmo princípio do provedor fiscal.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'manual',
  servico TEXT,
  provider_ref TEXT,
  codigo_rastreamento TEXT,
  etiqueta_url TEXT,
  etiqueta_pdf BYTEA,
  status TEXT NOT NULL DEFAULT 'pendente',
  custo NUMERIC(12,2) NOT NULL DEFAULT 0,
  peso_g INTEGER,
  volumes INTEGER NOT NULL DEFAULT 1,
  cep_destino TEXT,
  prazo_dias INTEGER,
  erro TEXT,
  idempotency_key TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT envios_status_valido CHECK (status IN (
    'pendente', 'cotado', 'gerado', 'postado', 'em_transito', 'entregue',
    'devolvido', 'extraviado', 'cancelado', 'erro'
  )),
  -- Um envio só é "postado" se houver prova: código de rastreamento OU a
  -- referência do provedor. Sem isso, "postado" é inalcançável.
  CONSTRAINT envios_postado_tem_prova CHECK (
    status NOT IN ('postado', 'em_transito', 'entregue')
    OR codigo_rastreamento IS NOT NULL OR provider_ref IS NOT NULL
  ),
  CONSTRAINT envios_custo_valido CHECK (custo >= 0),
  CONSTRAINT envios_volumes_valido CHECK (volumes >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_envios_idempotency
  ON envios (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Uma venda tem no máximo um envio vivo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_envios_venda_vivo
  ON envios (venda_id) WHERE status NOT IN ('cancelado', 'erro');
CREATE INDEX IF NOT EXISTS envios_empresa_status_idx
  ON envios (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS envios_rastreamento_idx
  ON envios (codigo_rastreamento) WHERE codigo_rastreamento IS NOT NULL;

CREATE TABLE IF NOT EXISTS envio_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  codigo TEXT,
  mensagem TEXT,
  local TEXT,
  payload JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS envio_eventos_idx ON envio_eventos (envio_id, criado_em);

-- ----------------------------------------------------------------------------
-- E) EXPEDIÇÃO — separação → conferência → embalagem → expedição
--
-- As etapas ficam na venda (expedicao_etapa) e cada transição vira uma linha
-- em expedicao_eventos. A divergência de conferência SEMPRE é registrada,
-- inclusive quando a conferência é abortada — é a auditoria que a operação pede.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expedicao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  etapa TEXT NOT NULL,
  de_etapa TEXT,
  resultado TEXT NOT NULL DEFAULT 'ok',
  mensagem TEXT,
  dados JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expedicao_eventos_etapa_valida CHECK (etapa IN (
    'pendente', 'separacao', 'conferida', 'embalada', 'expedida'
  )),
  CONSTRAINT expedicao_eventos_resultado_valido CHECK (resultado IN ('ok', 'divergencia', 'erro'))
);

CREATE INDEX IF NOT EXISTS expedicao_eventos_idx
  ON expedicao_eventos (venda_id, criado_em);

CREATE TABLE IF NOT EXISTS divergencias_conferencia (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  esperado JSONB NOT NULL,
  lido JSONB NOT NULL,
  faltando JSONB,
  sobrando JSONB,
  resolvido_em TIMESTAMPTZ,
  resolvido_por INTEGER REFERENCES usuarios(id),
  resolucao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS divergencias_conferencia_idx
  ON divergencias_conferencia (empresa_id, venda_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- F) LOGÍSTICA REVERSA — devolução
--
-- Nada entra no estoque sem rastreabilidade: a devolução só é recebida depois
-- de autorizada, e o recebimento registra o que foi conferido.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  numero TEXT,
  status TEXT NOT NULL DEFAULT 'solicitada',
  motivo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'devolucao',
  autorizada_em TIMESTAMPTZ,
  autorizado_por INTEGER REFERENCES usuarios(id),
  autorizacao_codigo TEXT,
  codigo_rastreamento TEXT,
  transportadora TEXT,
  recebida_em TIMESTAMPTZ,
  recebido_por INTEGER REFERENCES usuarios(id),
  local_entrada TEXT,
  documento_fiscal_id INTEGER REFERENCES documentos_fiscais(id) ON DELETE SET NULL,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT devolucoes_status_valido CHECK (status IN (
    'solicitada', 'autorizada', 'em_transito', 'recebida', 'recusada', 'cancelada'
  )),
  CONSTRAINT devolucoes_tipo_valido CHECK (tipo IN ('devolucao', 'troca', 'garantia', 'arrependimento')),
  -- Recebida exige autorização prévia: não existe entrada "espontânea".
  CONSTRAINT devolucoes_recebida_tem_autorizacao CHECK (
    status <> 'recebida' OR autorizada_em IS NOT NULL
  ),
  CONSTRAINT devolucoes_motivo_obrigatorio CHECK (TRIM(COALESCE(motivo, '')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucoes_numero
  ON devolucoes (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS devolucoes_empresa_status_idx
  ON devolucoes (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS devolucoes_venda_idx ON devolucoes (venda_id);

CREATE TABLE IF NOT EXISTS devolucao_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  devolucao_id INTEGER NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  item_venda_id INTEGER REFERENCES itens_venda(id) ON DELETE SET NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade_solicitada NUMERIC(12,3) NOT NULL,
  quantidade_recebida NUMERIC(12,3) NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'bom',
  devolucao_estoque BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT devolucao_itens_qtd_positiva CHECK (quantidade_solicitada > 0),
  CONSTRAINT devolucao_itens_recebida_valida CHECK (
    quantidade_recebida >= 0 AND quantidade_recebida <= quantidade_solicitada
  ),
  CONSTRAINT devolucao_itens_estado_valido CHECK (estado IN (
    'bom', 'avariado', 'usado', 'faltando_acessorio'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucao_item
  ON devolucao_itens (devolucao_id, produto_id, COALESCE(tamanho_id, 0));
CREATE INDEX IF NOT EXISTS devolucao_itens_idx ON devolucao_itens (devolucao_id);

-- ----------------------------------------------------------------------------
-- G) RECEBIMENTO PARCIAL DE COMPRA
--
-- Sem isso, "recebido" é tudo-ou-nada e o estoque sobe além do que chegou.
-- Cada recebimento é uma linha; a soma dos itens nunca passa do pedido
-- (índice/garantia aplicada na escrita condicional + CHECK agregado abaixo).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compra_recebimentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  data TIMESTAMPTZ NOT NULL DEFAULT now(),
  local TEXT,
  documento TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compra_recebimentos_total_valido CHECK (total >= 0)
);

CREATE INDEX IF NOT EXISTS compra_recebimentos_idx ON compra_recebimentos (compra_id, data);

CREATE TABLE IF NOT EXISTS compra_recebimento_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  recebimento_id INTEGER NOT NULL REFERENCES compra_recebimentos(id) ON DELETE CASCADE,
  item_compra_id INTEGER NOT NULL REFERENCES itens_compra(id) ON DELETE CASCADE,
  quantidade NUMERIC(12,3) NOT NULL,
  CONSTRAINT compra_recebimento_itens_qtd_positiva CHECK (quantidade > 0)
);

CREATE INDEX IF NOT EXISTS compra_recebimento_itens_idx
  ON compra_recebimento_itens (recebimento_id);

-- O total recebido de um item NUNCA ultrapassa o pedido.
--
-- O CHECK é uma trava de segurança para o caminho mais provável de erro
-- (reduzir `itens_compra.quantidade` para abaixo do que já chegou). Ele não é
-- a garantia principal contra excesso de recebimento: um CHECK só é revalidado
-- quando a própria linha muda, e receber não muda a linha do item. Quem impede
-- o excesso é o UPDATE condicional em `itens_compra.quantidade_recebida`
-- (compare-and-swap na mesma transação do recebimento) — ver suprimentos.ts.
--
-- A função é marcada IMMUTABLE porque o Postgres só aceita esse rótulo em
-- CHECK. Ela não é dobrada em constante: o argumento é uma referência de
-- coluna, nunca um literal.
CREATE OR REPLACE FUNCTION brobond_qtd_recebida_item(item_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(cri.quantidade), 0)
  FROM compra_recebimento_itens cri
  JOIN compra_recebimentos cr ON cr.id = cri.recebimento_id
  WHERE cri.item_compra_id = item_id;
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE itens_compra DROP CONSTRAINT IF EXISTS itens_compra_nao_excede_pedido;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_nao_excede_pedido CHECK (
    brobond_qtd_recebida_item(id) <= quantidade
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- H) COLUNAS DE AMARRAÇÃO NAS TABELAS EXISTENTES (aditivas)
-- ----------------------------------------------------------------------------
-- Pedido de venda: de onde veio, em que etapa da expedição está, qual caixa.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS proposta_id INTEGER REFERENCES propostas(id) ON DELETE SET NULL;

-- Segunda camada de idempotência da conversão: nenhuma venda nasce duas vezes
-- da mesma proposta (a primeira é o UNIQUE em propostas.venda_id; a terceira é
-- o UPDATE condicional no status).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_proposta
  ON vendas (proposta_id) WHERE proposta_id IS NOT NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_caixa_id INTEGER REFERENCES pdv_caixas(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS envio_id INTEGER REFERENCES envios(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS expedicao_etapa TEXT;

DO $$ BEGIN
  ALTER TABLE vendas ADD CONSTRAINT vendas_expedicao_etapa_valida CHECK (
    expedicao_etapa IS NULL OR expedicao_etapa IN (
      'pendente', 'separacao', 'conferida', 'embalada', 'expedida'
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Item de venda: o preço de tabela e a lista que o originaram ficam congelados.
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS lista_preco_id INTEGER REFERENCES listas_preco(id) ON DELETE SET NULL;
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS preco_tabela NUMERIC(12,2);

-- Item de compra: quanto já foi recebido (parcial).
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS quantidade_recebida NUMERIC(12,3) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_recebida_valida CHECK (
    quantidade_recebida >= 0 AND quantidade_recebida <= quantidade
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `compras` ganha o estado intermediário do recebimento parcial.
ALTER TABLE compras DROP CONSTRAINT IF EXISTS compras_status_valido;
DO $$ BEGIN
  ALTER TABLE compras ADD CONSTRAINT compras_status_valido CHECK (
    status IN ('pendente', 'aprovado', 'parcial', 'recebido', 'cancelado')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS aprovada_em TIMESTAMPTZ;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS aprovada_por INTEGER REFERENCES usuarios(id);

-- `pdv` como canal de venda reconhecido.
ALTER TABLE vendas DROP CONSTRAINT IF EXISTS vendas_canal_venda_valido;
DO $$ BEGIN
  ALTER TABLE vendas ADD CONSTRAINT vendas_canal_venda_valido CHECK (
    canal_venda IS NULL OR canal_venda IN (
      'balcao', 'pdv', 'representante', 'whatsapp', 'site_varejo',
      'site_atacado', 'marketplace', 'outro'
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- Herança de empresa por trigger — até um INSERT em SQL cru cai na empresa
-- certa (mesmo mecanismo da migration 0017).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    ARRAY['lista_preco_itens',        'listas_preco',        'lista_id'],
    ARRAY['listas_preco_historico',   'listas_preco',        'lista_id'],
    ARRAY['proposta_itens',           'propostas',           'proposta_id'],
    ARRAY['proposta_eventos',         'propostas',           'proposta_id'],
    ARRAY['pdv_caixa_movimentos',     'pdv_caixas',          'caixa_id'],
    ARRAY['pdv_pagamentos',           'vendas',              'venda_id'],
    ARRAY['envio_eventos',            'envios',              'envio_id'],
    ARRAY['expedicao_eventos',        'vendas',              'venda_id'],
    ARRAY['divergencias_conferencia', 'vendas',              'venda_id'],
    ARRAY['devolucao_itens',          'devolucoes',          'devolucao_id'],
    ARRAY['compra_recebimentos',      'compras',             'compra_id'],
    ARRAY['compra_recebimento_itens', 'compra_recebimentos', 'recebimento_id']
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
    END IF;
  END LOOP;
END $$;

-- Índices de caminho quente com a empresa na frente (mesmo padrão da 0017).
CREATE INDEX IF NOT EXISTS propostas_empresa_cliente_idx ON propostas (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS pdv_pagamentos_empresa_idx   ON pdv_pagamentos (empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS envios_empresa_venda_idx     ON envios (empresa_id, venda_id);
CREATE INDEX IF NOT EXISTS devolucoes_empresa_cliente_idx ON devolucoes (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS compra_recebimentos_empresa_idx ON compra_recebimentos (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS vendas_empresa_expedicao_idx ON vendas (empresa_id, expedicao_etapa);

-- ---------------------------------------------------------------------------
-- § P2 — FINANCEIRO: GATEWAYS, WEBHOOKS DE ENTRADA, COMISSÕES POR
-- RECEBIMENTO, EXTRATO PERSISTENTE (OFX/CSV/CNAB) E IDEMPOTÊNCIA
-- Espelho da migration db/migrations/0025_p2_financeiro_gateways.sql
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gateway_configs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider TEXT NOT NULL,
  ambiente TEXT NOT NULL DEFAULT 'producao',
  credenciais_cifradas TEXT,
  webhook_segredo_cifrado TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_configs_empresa_provider
  ON gateway_configs (empresa_id, LOWER(provider));

CREATE TABLE IF NOT EXISTS gateway_cobrancas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider TEXT NOT NULL,
  metodo TEXT NOT NULL,
  venda_id INTEGER REFERENCES vendas(id),
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  valor NUMERIC(12,2) NOT NULL,
  taxa_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  valor_liquido NUMERIC(12,2),
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pendente',
  provider_ref TEXT,
  idempotency_key TEXT,
  expires_em TIMESTAMPTZ,
  nosso_numero TEXT,
  linha_digitavel TEXT,
  qr_code TEXT,
  copia_cola TEXT,
  nsu TEXT,
  webhook_evento_id TEXT,
  payload JSONB,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_empresa ON gateway_cobrancas (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_venda   ON gateway_cobrancas (venda_id);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_lanc    ON gateway_cobrancas (lancamento_id);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_ref     ON gateway_cobrancas (provider, provider_ref);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_cobrancas_idempotencia
  ON gateway_cobrancas (empresa_id, LOWER(provider), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- P2-04: o CHECK nasce NOT VALID para proteger escritas novas em bancos que já
-- têm linhas, e é VALIDADO logo abaixo quando o conjunto está limpo. Antes a
-- VALIDATE era esquecida e a constraint ficava NOT VALID para sempre — mesmo em
-- banco novo e vazio. A validação condicional abaixo é o mesmo contrato de 0032.
DO $p204_gateway_checks$
DECLARE
  c RECORD;
  n_violacoes BIGINT;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('ck_gateway_cobrancas_valor',  $$ valor > 0 $$,
       $$ NOT (valor > 0) $$),
      ('ck_gateway_cobrancas_metodo', $$ metodo IN ('pix','boleto','cartao_credito','cartao_debito') $$,
       $$ NOT (metodo IN ('pix','boleto','cartao_credito','cartao_debito')) $$),
      ('ck_gateway_cobrancas_status', $$ status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou') $$,
       $$ NOT (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')) $$)
    ) AS v(nome, ddl, regra_invalida)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.gateway_cobrancas'::regclass AND conname = c.nome) THEN
      EXECUTE format('ALTER TABLE gateway_cobrancas ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.nome, c.ddl);
    END IF;
    IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.gateway_cobrancas'::regclass AND conname = c.nome) THEN
      EXECUTE format('SELECT COUNT(*) FROM gateway_cobrancas WHERE %s', c.regra_invalida) INTO n_violacoes;
      IF n_violacoes = 0 THEN
        EXECUTE format('ALTER TABLE gateway_cobrancas VALIDATE CONSTRAINT %I', c.nome);
      ELSE
        RAISE NOTICE 'P2-04: %.% mantida NOT VALID — % linha(s) legada(s) violam a regra.', 'gateway_cobrancas', c.nome, n_violacoes;
      END IF;
    END IF;
  END LOOP;
END
$p204_gateway_checks$;

CREATE TABLE IF NOT EXISTS gateway_webhook_events (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),
  provider TEXT NOT NULL,
  evento_id TEXT NOT NULL,
  evento TEXT,
  payload JSONB,
  assinatura_ok BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'recebido',
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ,
  ultima_tentativa_em TIMESTAMPTZ,
  erro TEXT,
  cobranca_id INTEGER,
  lancamento_id INTEGER,
  recebido_em TIMESTAMPTZ DEFAULT now(),
  processado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_webhook_evento
  ON gateway_webhook_events (LOWER(provider), evento_id);
CREATE INDEX IF NOT EXISTS idx_gateway_webhook_retry
  ON gateway_webhook_events (status, proxima_tentativa_em);

CREATE TABLE IF NOT EXISTS comissoes_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  representante_id INTEGER REFERENCES representantes(id),
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  tipo TEXT NOT NULL,
  base NUMERIC(12,2) NOT NULL,
  pct NUMERIC(5,2) NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  origem TEXT,
  usuario TEXT,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comissoes_eventos_venda ON comissoes_eventos (venda_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_eventos_rep   ON comissoes_eventos (empresa_id, representante_id);

CREATE TABLE IF NOT EXISTS fin_extrato_transacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  origem TEXT NOT NULL DEFAULT 'ofx',
  linha_hash TEXT NOT NULL,
  fitid TEXT,
  data DATE,
  valor NUMERIC(12,2) NOT NULL,
  direcao TEXT NOT NULL DEFAULT 'entrada',
  descricao TEXT,
  documento TEXT,
  codigo_movimento TEXT,
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  status TEXT NOT NULL DEFAULT 'importada',
  motivo TEXT,
  conciliado_em TIMESTAMPTZ,
  importado_em TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_extrato_linha ON fin_extrato_transacoes (conta_id, linha_hash);
CREATE INDEX IF NOT EXISTS idx_extrato_empresa_status ON fin_extrato_transacoes (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_extrato_conta_data ON fin_extrato_transacoes (conta_id, data DESC);
-- P2-04: mesmo contrato do bloco gateway acima — cria NOT VALID para proteger
-- escritas novas e valida condicionalmente quando não há linha legada inválida.
DO $p204_extrato_check$
DECLARE
  n_violacoes BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fin_extrato_transacoes'::regclass AND conname = 'ck_extrato_valor_positivo') THEN
    ALTER TABLE fin_extrato_transacoes ADD CONSTRAINT ck_extrato_valor_positivo CHECK (valor > 0) NOT VALID;
  END IF;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conrelid = 'public.fin_extrato_transacoes'::regclass AND conname = 'ck_extrato_valor_positivo') THEN
    SELECT COUNT(*) INTO n_violacoes FROM fin_extrato_transacoes WHERE NOT (valor > 0);
    IF n_violacoes = 0 THEN
      ALTER TABLE fin_extrato_transacoes VALIDATE CONSTRAINT ck_extrato_valor_positivo;
    ELSE
      RAISE NOTICE 'P2-04: fin_extrato_transacoes.ck_extrato_valor_positivo mantida NOT VALID — % linha(s) legada(s) violam a regra.', n_violacoes;
    END IF;
  END IF;
END
$p204_extrato_check$;

-- ---- 0026_producao_completa (FASE E2 — produção completa) ----
--
-- ESPELHO de db/migrations/0026_producao_completa.sql. O boot aplica este
-- arquivo primeiro e depois as migrações versionadas; manter os dois iguais é o
-- que garante que um banco novo e um banco antigo terminem idênticos.
-- Tudo aqui é aditivo e idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) MÁQUINA DE ESTADOS
--
-- Fluxo da especificação:
--   PLANEJADA → LIBERADA → EM_PRODUÇÃO → PARCIAL → CONCLUÍDA   (+ CANCELADA)
--
-- `liberada` e `parcial` são estados NOVOS. Os quatro que já existiam
-- (planejada, em_producao, concluida, cancelada) continuam valendo com o mesmo
-- significado — nenhuma linha existente muda de sentido.
-- ----------------------------------------------------------------------------
-- NULL vira 'planejada' (o DEFAULT da coluna já é esse; só garante o histórico).
UPDATE ordens_fabricacao SET status = 'planejada' WHERE status IS NULL;

-- Diagnóstico ANTES de criar a constraint: se houver status fora do vocabulário,
-- a migration falha com a lista dos ids em vez de um erro críptico de CHECK.
DO $$
DECLARE
  invalidos TEXT;
BEGIN
  SELECT string_agg(id || ':' || status, ', ' ORDER BY id)
    INTO invalidos
    FROM ordens_fabricacao
   WHERE status NOT IN ('planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada');
  IF invalidos IS NOT NULL THEN
    RAISE EXCEPTION
      '0026_producao_completa: status inválido em ordens_fabricacao (%). Corrija esses registros antes de subir — a máquina de estados da E2 só aceita planejada, liberada, em_producao, parcial, concluida e cancelada.',
      invalidos;
  END IF;
END $$;

ALTER TABLE ordens_fabricacao DROP CONSTRAINT IF EXISTS ordens_fabricacao_status_valido;
ALTER TABLE ordens_fabricacao ADD CONSTRAINT ordens_fabricacao_status_valido CHECK (
  status IN ('planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada')
);

-- ----------------------------------------------------------------------------
-- B) PERDAS, PRODUZIDO E CUSTOS
--
-- Semântica (é o que o serviço implementa — a coluna só guarda):
--   • quantidade_produzida  peças BOAS apontadas na OP (soma dos apontamentos);
--   • quantidade_perdida    peças refugadas — consumiram insumo e não viram
--                           estoque. É isso que faz a perda custar dinheiro;
--   • custo_previsto        gravado na LIBERAÇÃO: peças planejadas × custo da
--                           ficha técnica naquele momento. Congelado de
--                           propósito: mudar a ficha depois não reescreve o
--                           que foi orçado;
--   • custo_real            insumos realmente baixados + mão de obra e
--                           indiretos reconhecidos na proporção processada.
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS quantidade_produzida INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS quantidade_perdida   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS custo_previsto NUMERIC(12,2);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS custo_real     NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE ordens_fabricacao DROP CONSTRAINT IF EXISTS ordens_fabricacao_qtd_nao_negativa;
ALTER TABLE ordens_fabricacao ADD CONSTRAINT ordens_fabricacao_qtd_nao_negativa CHECK (
  quantidade_produzida >= 0 AND quantidade_perdida >= 0 AND custo_real >= 0
);

-- Perda por tamanho na OP "por grade": espelho de itens_ordem.produzido.
-- Derivável dos apontamentos, mas mantido aqui porque a grade da OP lê a linha.
ALTER TABLE itens_ordem ADD COLUMN IF NOT EXISTS perdido INTEGER NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- C) RESPONSÁVEL, LOCAL DE PRODUÇÃO E MARCOS DE TEMPO
--
-- `faccao` (texto livre) continua existindo: é quem faz fora. `local_producao_id`
-- é onde a peça fica enquanto é produzida — a entrada de produto acabado na
-- conclusão usa este local quando ele existe, e cai no Local padrão quando não.
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS responsavel_id      INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS local_producao_id   INTEGER REFERENCES locais(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS liberada_em         TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS liberada_por        INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS iniciada_em         TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS cancelada_em        TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS cancelada_por       INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

-- Índice das consultas do painel e do planejamento (empresa + status).
CREATE INDEX IF NOT EXISTS ordens_fabricacao_empresa_status_idx
  ON ordens_fabricacao (empresa_id, status);
CREATE INDEX IF NOT EXISTS ordens_fabricacao_empresa_previsao_idx
  ON ordens_fabricacao (empresa_id, previsao);

-- ----------------------------------------------------------------------------
-- D) VÍNCULO FORMAL OP → ESTOQUE  (GAP-ESTQ-ORDEM-ID)
--
-- Antes: a entrada de produto acabado era achada por TEXTO
-- (`motivo = 'Produção concluída — OP #N'`, server/src/producao.ts). Renomear a
-- string quebrava o estorno em silêncio. Agora a coluna existe, tem FK e índice;
-- o texto continua sendo escrito para legibilidade na tela de Movimentações.
--
-- ON DELETE SET NULL: apagar a OP não pode apagar a história do estoque.
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS ordem_id INTEGER REFERENCES ordens_fabricacao(id) ON DELETE SET NULL;

-- Backfill seguro: só preenche quando o id extraído do motivo REALMENTE existe
-- em ordens_fabricacao. Motivo sem padrão, ou com id órfão, fica NULL — nunca
-- se inventa vínculo.
UPDATE movimentacoes m
   SET ordem_id = x.oid::int
  FROM (
    SELECT mm.id, (regexp_match(mm.motivo, 'OP #(\d+)'))[1] AS oid
      FROM movimentacoes mm
     WHERE mm.ordem_id IS NULL
       AND mm.motivo ~ 'OP #[0-9]+'
  ) x
 WHERE m.id = x.id
   AND x.oid IS NOT NULL
   AND EXISTS (SELECT 1 FROM ordens_fabricacao o WHERE o.id = x.oid::int);

CREATE INDEX IF NOT EXISTS movimentacoes_ordem_idx       ON movimentacoes (ordem_id);
CREATE INDEX IF NOT EXISTS movimentacoes_empresa_ordem_idx ON movimentacoes (empresa_id, ordem_id);

-- ----------------------------------------------------------------------------
-- E) VÍNCULO FORMAL OP → INSUMOS  (GAP-PROD-CONSUMO-VINCULO)
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS ordem_id INTEGER REFERENCES ordens_fabricacao(id) ON DELETE SET NULL;

UPDATE movimentacoes_insumos mi
   SET ordem_id = x.oid::int
  FROM (
    SELECT mm.id, (regexp_match(mm.motivo, 'OP #(\d+)'))[1] AS oid
      FROM movimentacoes_insumos mm
     WHERE mm.ordem_id IS NULL
       AND mm.motivo ~ 'OP #[0-9]+'
  ) x
 WHERE mi.id = x.id
   AND x.oid IS NOT NULL
   AND EXISTS (SELECT 1 FROM ordens_fabricacao o WHERE o.id = x.oid::int);

CREATE INDEX IF NOT EXISTS movimentacoes_insumos_ordem_idx         ON movimentacoes_insumos (ordem_id);
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_empresa_ordem_idx ON movimentacoes_insumos (empresa_id, ordem_id);

-- ----------------------------------------------------------------------------
-- F) TRILHA DE TRANSIÇÕES DA OP  (GAP-PROD-EVENTOS)
--
-- Append-only, no mesmo formato das demais trilhas do ERP (expedicao_eventos,
-- envio_eventos, proposta_eventos). A empresa é DERIVADA da OP por trigger:
-- até um INSERT em SQL cru cai na empresa certa.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordens_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  de_status TEXT,
  para_status TEXT,
  mensagem TEXT,
  dados JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordens_eventos_evento_valido CHECK (evento IN (
    'criada', 'liberada', 'iniciada', 'apontamento', 'perda', 'consumo',
    'parcial', 'concluida', 'reaberta', 'cancelada', 'atalho', 'edicao'
  ))
);

CREATE INDEX IF NOT EXISTS ordens_eventos_ordem_idx   ON ordens_eventos (ordem_id, criado_em);
CREATE INDEX IF NOT EXISTS ordens_eventos_empresa_idx ON ordens_eventos (empresa_id, ordem_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- G) APONTAMENTOS DE PRODUÇÃO  (GAP-PROD-APONTAMENTOS)
--
-- Um apontamento é o que o chão de fábrica informa: "fiz N peças boas e
-- refuguei M neste tamanho". É ele que alimenta quantidade_produzida,
-- quantidade_perdida e o custo real — e é ele que consome insumo durante a
-- produção, em vez de tudo de uma vez na conclusão.
--
-- `idempotency_key` evita o duplo apontamento do mesmo turno quando a rede
-- repete o POST (mesmo mecanismo de `envios`).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordens_apontamentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id) ON DELETE CASCADE,
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade_produzida INTEGER NOT NULL DEFAULT 0,
  quantidade_perdida INTEGER NOT NULL DEFAULT 0,
  observacoes TEXT,
  idempotency_key TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  apontado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordens_apontamentos_qtd_valida CHECK (
    quantidade_produzida >= 0
    AND quantidade_perdida >= 0
    AND (quantidade_produzida > 0 OR quantidade_perdida > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ordens_apontamentos_idem_uniq
  ON ordens_apontamentos (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordens_apontamentos_ordem_idx   ON ordens_apontamentos (ordem_id, apontado_em);
CREATE INDEX IF NOT EXISTS ordens_apontamentos_empresa_idx ON ordens_apontamentos (empresa_id, ordem_id, apontado_em DESC);

-- ----------------------------------------------------------------------------
-- Herança de empresa por trigger (mesma função de 0017, novos pares).
-- Reutiliza brobond_herdar_empresa, que já existe no schema.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_empresa_ordens_eventos ON ordens_eventos;
CREATE TRIGGER trg_empresa_ordens_eventos
  BEFORE INSERT OR UPDATE ON ordens_eventos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('ordens_fabricacao', 'ordem_id');

DROP TRIGGER IF EXISTS trg_empresa_ordens_apontamentos ON ordens_apontamentos;
CREATE TRIGGER trg_empresa_ordens_apontamentos
  BEFORE INSERT OR UPDATE ON ordens_apontamentos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('ordens_fabricacao', 'ordem_id');
-- ============================================================================
-- 0027 — FASE E3: compras — cotação de fornecedor e custo de recebimento
--
-- Ataca GAP-COMP-COTACOES (crítico) e dá suporte a GAP-COMP-CUSTOS
-- (docs/ERP-GAPS.md).
--
-- DOMÍNIO — não confundir com o que já existe:
--   • `cotacao_decisoes` (schema.sql:1139) é do PORTAL DO CLIENTE: tem
--     `venda_id NOT NULL REFERENCES vendas(id)` e registra a decisão do cliente
--     sobre uma cotação de VENDA. Não tem nada a ver com fornecedor.
--   • As tabelas desta migration são de COMPRA: vários fornecedores cotando o
--     mesmo carrinho de insumos/produtos, e o comprador escolhendo por item.
--
-- Blocos:
--   A) cotacoes_compra               — o processo de cotação
--   B) cotacao_compra_itens          — o que está sendo cotado (carrinho)
--   C) cotacao_compra_fornecedores   — quem foi convidado a cotar
--   D) cotacao_compra_precos         — a resposta de cada fornecedor por item
--   E) custo de recebimento          — rateio de frete no item da compra
--
-- Aditiva e reversível: nenhuma tabela existente é renomeada, nenhuma coluna é
-- removida, nenhum CHECK existente é enfraquecido.
--
-- Idempotente: pode ser aplicada duas vezes, em banco limpo e em banco migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) COTAÇÃO DE COMPRA
--
-- Fluxo: RASCUNHO → COTANDO → DECIDIDA   (+ CANCELADA)
--
-- `compra_id` é o pedido de compra gerado pela decisão. É UNIQUE de propósito:
-- é o que torna a geração do pedido IDEMPOTENTE no banco, e não só na aplicação.
-- Duas decisões simultâneas da mesma cotação não conseguem criar dois pedidos —
-- a segunda estoura no índice único.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacoes_compra (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  titulo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'rascunho',
  prazo_validade DATE,
  previsao_compra DATE,
  observacoes TEXT,
  -- Decisão
  decidida_em TIMESTAMPTZ,
  decidida_por INTEGER REFERENCES usuarios(id),
  compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
  criterio TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cotacoes_compra_empresa_idx ON cotacoes_compra (empresa_id, status);
CREATE INDEX IF NOT EXISTS cotacoes_compra_previsao_idx ON cotacoes_compra (empresa_id, previsao_compra);

-- Um pedido de compra por cotação. UNIQUE = idempotência garantida no banco.
CREATE UNIQUE INDEX IF NOT EXISTS cotacoes_compra_compra_uniq
  ON cotacoes_compra (compra_id) WHERE compra_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacoes_compra_status_valido CHECK (
    status IN ('rascunho', 'cotando', 'decidida', 'cancelada')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O critério de escolha precisa ser declarável, senão a decisão vira arbitrária.
DO $$ BEGIN
  ALTER TABLE cotacoes_compra ADD CONSTRAINT cotacoes_compra_criterio_valido CHECK (
    criterio IS NULL OR criterio IN ('menor_preco', 'menor_preco_total', 'prazo', 'qualidade')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- B) ITENS DA COTAÇÃO (o carrinho que os fornecedores vão orçar)
--
-- Mesma regra de `itens_compra`: ou insumo, ou produto. A escolha por item fica
-- em `escolhido_*`, preenchida na decisão.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes_compra(id) ON DELETE CASCADE,
  insumo_id INTEGER REFERENCES insumos(id),
  produto_id INTEGER REFERENCES produtos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  unidade TEXT,
  -- Preenchidos na decisão: quem ganhou este item e por quanto.
  escolhido_fornecedor_id INTEGER REFERENCES fornecedores(id),
  escolhido_preco NUMERIC(12,2),
  CONSTRAINT cotacao_compra_itens_origem_check CHECK (insumo_id IS NOT NULL OR produto_id IS NOT NULL),
  CONSTRAINT cotacao_compra_itens_qtd_positiva CHECK (quantidade > 0)
);

CREATE INDEX IF NOT EXISTS cotacao_compra_itens_idx ON cotacao_compra_itens (cotacao_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_itens_empresa_idx ON cotacao_compra_itens (empresa_id);

-- ----------------------------------------------------------------------------
-- C) FORNECEDORES CONVIDADOS
--
-- UNIQUE (cotacao, fornecedor): convidar o mesmo fornecedor duas vezes para a
-- mesma cotação é erro, não duas cotações paralelas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_fornecedores (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes_compra(id) ON DELETE CASCADE,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  status TEXT NOT NULL DEFAULT 'convidado',
  convidado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  respondeu_em TIMESTAMPTZ,
  prazo_entrega_dias INTEGER,
  condicao_pagamento TEXT,
  frete NUMERIC(12,2) DEFAULT 0,
  validade_proposta DATE,
  observacoes TEXT,
  CONSTRAINT cotacao_compra_fornecedores_qtd CHECK (prazo_entrega_dias IS NULL OR prazo_entrega_dias >= 0),
  CONSTRAINT cotacao_compra_fornecedores_frete CHECK (frete >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cotacao_compra_fornecedores_uniq
  ON cotacao_compra_fornecedores (cotacao_id, fornecedor_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_fornecedores_empresa_idx
  ON cotacao_compra_fornecedores (empresa_id);

DO $$ BEGIN
  ALTER TABLE cotacao_compra_fornecedores ADD CONSTRAINT cotacao_compra_fornecedores_status_valido CHECK (
    status IN ('convidado', 'cotado', 'recusado')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- D) PREÇOS POR FORNECEDOR × ITEM
--
-- É aqui que mora a comparação. UNIQUE (convite, item): um fornecedor não pode
-- mandar dois preços para o mesmo item — se mudar de ideia, EDITA.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotacao_compra_precos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  convite_id INTEGER NOT NULL REFERENCES cotacao_compra_fornecedores(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES cotacao_compra_itens(id) ON DELETE CASCADE,
  preco_unitario NUMERIC(12,2) NOT NULL,
  prazo_entrega_dias INTEGER,
  disponivel BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT cotacao_compra_precos_preco_positivo CHECK (preco_unitario >= 0),
  CONSTRAINT cotacao_compra_precos_prazo CHECK (prazo_entrega_dias IS NULL OR prazo_entrega_dias >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cotacao_compra_precos_uniq
  ON cotacao_compra_precos (convite_id, item_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_precos_empresa_idx ON cotacao_compra_precos (empresa_id);
CREATE INDEX IF NOT EXISTS cotacao_compra_precos_item_idx ON cotacao_compra_precos (item_id);

-- ----------------------------------------------------------------------------
-- E) CUSTO DE RECEBIMENTO — rateio de frete
--
-- `itens_compra` ganha o custo de aquisição rateado. Ele existe porque o custo
-- médio do insumo NÃO pode ser calculado só com `preco_unitario`: frete e
-- imposto fazem parte do que a empresa pagou para ter o insumo na porta.
--
-- Coluna nova, `DEFAULT 0`, aditiva: nada que já existe muda de valor. O rateio
-- passa a ser escrito pelo recebimento (server/src/compras.ts), não por esta
-- migration — aqui só existe o lugar para guardá-lo.
-- ----------------------------------------------------------------------------
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS custo_frete_rateado NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS custo_impostos NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_custos_positivos CHECK (
    custo_frete_rateado >= 0 AND custo_impostos >= 0
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auditar repasse de custo é auditar dinheiro: sem índice, a trilha por compra
-- vira varredura de tabela inteira assim que houver histórico.
CREATE INDEX IF NOT EXISTS itens_compra_custo_idx ON itens_compra (compra_id, insumo_id);


-- ============================================================================
-- ESPELHO DE db/migrations/0028_compras_custo_canonico.sql
-- Mantido aqui para que um banco criado direto do schema.sql fique idêntico
-- a um banco migrado incrementalmente. Não editar sem editar a migration.
-- ============================================================================

-- ============================================================================
-- 0028 — FASE E3.1: custo canônico de recebimento de compra
--
-- Fecha GAP-COMP-CUSTOS (docs/ERP-GAPS.md).
--
-- O PROBLEMA (auditado, não suposto)
-- ----------------------------------
-- Existiam TRÊS caminhos de recebimento e cada um tratava custo de um jeito:
--
--   1. receberCompra   (server/src/itens.ts:436)  — atualizava custo_medio e
--                                                   gravava custo_unitario.
--   2. receberParcial  (server/src/compras.ts:111) — NÃO atualizava custo_medio
--                                                   e gravava a movimentação SEM
--                                                   custo_unitario.
--   3. importarXmlCompra (server/src/suprimentos.ts:383) — terceira cópia da
--                                                   média ponderada, só produto.
--
-- Consequência concreta: o CMV do "Meu Negócio" é calculado a partir de
-- `insumos.custo_medio` (server/src/negocios.ts:511 — Σ consumo × (1+perda) ×
-- custo_medio). Compra recebida pelo caminho parcial subia o estoque sem mover
-- o custo médio, então a margem de todo produto cuja ficha usa aquele insumo
-- saía errada — silenciosamente.
--
-- E o estorno era pior: estornarCompra localizava as entradas de insumo pelo
-- TEXTO do motivo (`'Compra #N'`), mas o recebimento parcial grava
-- `'Recebimento parcial — Compra #N'`. Ou seja, cancelar uma compra recebida
-- parcialmente devolvia o estoque de PRODUTOS e deixava o de INSUMOS para cima,
-- com o custo médio alterado para sempre.
--
-- O QUE ESTA MIGRATION FAZ
-- ------------------------
-- Cria os VÍNCULOS ESTRUTURAIS que permitem uma única regra canônica:
--
--   • movimentacoes_insumos.compra_id ......... achar as entradas de insumo por
--                                               pedido, não por texto de motivo;
--   • movimentacoes_insumos.recebimento_id .... saber QUAL recebimento gerou a
--                                               entrada (essencial quando o
--                                               mesmo item chega em 2 lotes com
--                                               custos diferentes);
--   • movimentacoes.recebimento_id ............ o mesmo para produto acabado;
--   • movimentacoes.custo_unitario ............ produto também passa a ter o
--                                               custo gravado na movimentação —
--                                               sem isso o estorno teria que
--                                               adivinhar o preço;
--   • índice único parcial .................... trava no BANCO contra duas
--                                               entradas de estoque para a mesma
--                                               linha do mesmo recebimento.
--
-- A REGRA DE CÁLCULO NÃO MORA AQUI. Ela mora em server/src/custoRecebimento.ts.
-- Esta migration só garante que os dados necessários existem e são íntegros.
--
-- Aditiva e reversível: nenhuma coluna removida, nenhum CHECK enfraquecido.
-- Idempotente: pode ser aplicada em banco limpo e em banco já migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) VÍNCULO ESTRUTURAL: movimentação de insumo → compra e recebimento
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS compra_id INTEGER REFERENCES compras(id);
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS recebimento_id INTEGER REFERENCES compra_recebimentos(id);
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS item_compra_id INTEGER REFERENCES itens_compra(id);

-- ----------------------------------------------------------------------------
-- B) VÍNCULO ESTRUTURAL + CUSTO: movimentação de produto → recebimento
--
-- custo_unitario em `movimentacoes` é NOVO. Sem ele, o estorno de um produto
-- recebido em dois lotes de preço diferente não tem como saber qual preço
-- desfazer — e "voltar ao custo anterior" seria chute.
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS recebimento_id INTEGER REFERENCES compra_recebimentos(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS item_compra_id INTEGER REFERENCES itens_compra(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS custo_unitario NUMERIC(12,2);

-- Custo unitário nunca é negativo em nenhuma das duas tabelas.
ALTER TABLE movimentacoes DROP CONSTRAINT IF EXISTS movimentacoes_custo_unitario_nao_negativo;
ALTER TABLE movimentacoes ADD CONSTRAINT movimentacoes_custo_unitario_nao_negativo CHECK (custo_unitario IS NULL OR custo_unitario >= 0);

-- Em movimentacoes_insumos a coluna já existia com DEFAULT 0. O CHECK só é
-- adicionado se não houver linha histórica negativa — adicionar às cegas
-- derrubaria a migração (e o serviço) em banco de produção com dado antigo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'movimentacoes_insumos_custo_nao_negativo'
  ) AND NOT EXISTS (
    SELECT 1 FROM movimentacoes_insumos WHERE custo_unitario < 0
  ) THEN
    ALTER TABLE movimentacoes_insumos
      ADD CONSTRAINT movimentacoes_insumos_custo_nao_negativo CHECK (custo_unitario >= 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- C) ÍNDICES
--
-- O estorno percorre as entradas de um pedido/recebimento; sem índice isso é
-- varredura de tabela inteira dentro de uma transação serializable.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_compra_idx
  ON movimentacoes_insumos (compra_id, tipo);
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_recebimento_idx
  ON movimentacoes_insumos (recebimento_id, tipo);
CREATE INDEX IF NOT EXISTS movimentacoes_recebimento_idx
  ON movimentacoes (recebimento_id, tipo);

-- ----------------------------------------------------------------------------
-- D) TRAVA DE DUPLICIDADE NO BANCO
--
-- Uma linha de recebimento gera UMA entrada de estoque por insumo e UMA por
-- produto. A idempotência de aplicação já é garantida por
-- `compra_recebimentos.documento`; este índice é a segunda camada — se algum
-- caminho novo esquecer a checagem, o banco recusa em vez de dobrar o estoque.
--
-- Parcial (WHERE recebimento_id IS NOT NULL): movimentos que não vêm de
-- recebimento de compra — produção, ajuste, transferência, venda — continuam
-- livres, e NULL não colide.
-- ----------------------------------------------------------------------------
-- Chave = a LINHA da compra, não o insumo: duas linhas do mesmo pedido podem
-- comprar o MESMO insumo (código de fornecedor ou condição diferente), e isso é
-- legítimo. Bloquear por insumo quebraria esse caso.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_insumos_entrada_por_recebimento
  ON movimentacoes_insumos (recebimento_id, item_compra_id)
  WHERE recebimento_id IS NOT NULL AND tipo = 'entrada';

CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_produtos_entrada_por_recebimento
  ON movimentacoes (recebimento_id, item_compra_id)
  WHERE recebimento_id IS NOT NULL AND tipo = 'entrada';

-- ----------------------------------------------------------------------------
-- E) RETROAJUSTE (backfill) — liga o que já existe, sem inventar vínculo
--
-- As entradas de insumo anteriores a esta migration só podem ser ligadas ao
-- pedido pelo TEXTO do motivo, que é o único vínculo que elas têm. Fazemos isso
-- de forma estrita: só quando o motivo é exatamente 'Compra #N' E o pedido N
-- existe. O que não casa fica NULL — ligação inventada é pior que ligação
-- ausente, porque o estorno passaria a desfazer o movimento errado.
--
-- NÃO fazemos backfill de custo_unitario nem de recebimento_id: o custo histórico
-- não é recuperável (o preço do item pode ter sido editado depois) e o
-- recebimento de origem não está registrado. Deixar NULL é honesto; preencher
-- seria fabricar contabilidade.
-- ----------------------------------------------------------------------------
UPDATE movimentacoes_insumos mi
SET compra_id = x.oid
FROM (
  SELECT mi2.id AS mid,
         (regexp_match(mi2.motivo, '^Compra #(\d+)$'))[1]::int AS oid
  FROM movimentacoes_insumos mi2
  WHERE mi2.compra_id IS NULL
    AND mi2.tipo = 'entrada'
    AND mi2.motivo ~ '^Compra #[0-9]+$'
) x
WHERE mi.id = x.mid
  AND EXISTS (SELECT 1 FROM compras c WHERE c.id = x.oid);

-- O mesmo para o vínculo por recebimento nas entradas PARCIAIS de insumo: o
-- motivo 'Recebimento parcial — Compra #N' identifica o pedido, e o
-- recebimento é o único daquela compra com a mesma data/hora da movimentação.
-- Sem correspondência inequívoca, fica NULL.
UPDATE movimentacoes_insumos mi
SET compra_id = x.oid
FROM (
  SELECT mi2.id AS mid,
         (regexp_match(mi2.motivo, '^Recebimento parcial — Compra #(\d+)$'))[1]::int AS oid
  FROM movimentacoes_insumos mi2
  WHERE mi2.compra_id IS NULL
    AND mi2.tipo = 'entrada'
    AND mi2.motivo ~ '^Recebimento parcial — Compra #[0-9]+$'
) x
WHERE mi.id = x.mid
  AND EXISTS (SELECT 1 FROM compras c WHERE c.id = x.oid);


-- ============================================================================
-- 0029 — DE-PARA DE SKU DE FORNECEDOR COMPLETO  (E3.2 · GAP-COMP-DEPARA-MENU)
-- espelho de db/migrations/0029_compras_depara_completo.sql
-- ============================================================================

-- ---- 1) colunas -----------------------------------------------------------
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS unidade   TEXT;
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS ativo     BOOLEAN NOT NULL DEFAULT true;

-- A descrição do fornecedor costuma vir em caixa alta e com espaços duplos no
-- XML; normalizar na gravação é responsabilidade da aplicação, não do banco.
-- Aqui só garantimos que texto vazio não vire um valor "fantasma".
UPDATE produto_fornecedor_skus SET descricao = NULL WHERE btrim(COALESCE(descricao, '')) = '';
UPDATE produto_fornecedor_skus SET unidade   = NULL WHERE btrim(COALESCE(unidade, ''))   = '';

-- ---- 2) índice de busca ---------------------------------------------------
-- O de-para é consultado o tempo todo pelo par (fornecedor, código) — esse já é
-- UNIQUE. O que faltava era achar pelo PRODUTO: "de quais fornecedores eu
-- compro este SKU?" e a pesquisa por descrição na tela.
CREATE INDEX IF NOT EXISTS produto_fornecedor_skus_produto_idx
  ON produto_fornecedor_skus (produto_id);
CREATE INDEX IF NOT EXISTS produto_fornecedor_skus_ativos_idx
  ON produto_fornecedor_skus (empresa_id, ativo)
  WHERE ativo;

-- ---- 0030 E4.2 — ownership multiempresa para locais, saldos, movimentos e inventário ----
-- ============================================================================
-- E4.2 — ownership multiempresa para locais, saldos, movimentos e inventário
--
-- PRECONDICAO: os blocos de diagnóstico rodam antes de qualquer DDL que remova
-- unicidade ou acrescente FK/índice. Não há backfill por texto, reatribuição de
-- empresa nem escolha de linha em duplicidades históricas.
-- Idempotente; executado em transação pelo executor de migrations.
-- ============================================================================

-- O schema.sql executa este mesmo diagnóstico antes dos triggers antigos de
-- herança de empresa. Mantemos a cópia aqui para execução manual da migration e
-- para deixar o gate de upgrade autocontido.
DO $e42_preflight_core$
DECLARE
  duplicatas_locais BIGINT;
  duplicatas_padroes BIGINT;
  duplicatas_saldos BIGINT;
  duplicatas_itens_inventario BIGINT;
  dados_saldos_invalidos BIGINT;
  vinculos_empresa BIGINT;
  vinculos_locais BIGINT;
  nomes_locais_inconsistentes BIGINT;
  saldos_sem_local BIGINT;
  saldos_sem_local_ambiguos BIGINT;
  movimentos_sem_local BIGINT;
  inventarios_sem_local BIGINT;
  pdv_locais_inconsistentes BIGINT := 0;
  pdv_nomes_inconsistentes BIGINT := 0;
  pdv_locais_ambiguos BIGINT := 0;
BEGIN
  SELECT count(*) INTO duplicatas_locais FROM (
    SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_padroes FROM (
    SELECT empresa_id FROM locais WHERE padrao IS TRUE GROUP BY empresa_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_saldos FROM (
    SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
    GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_itens_inventario FROM (
    SELECT empresa_id, inventario_id, produto_id, tamanho_id FROM itens_inventario
    GROUP BY empresa_id, inventario_id, produto_id, tamanho_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dados_saldos_invalidos FROM estoques WHERE produto_id IS NULL OR local IS NULL;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN produtos p ON p.id = e.produto_id
      WHERE e.produto_id IS NULL OR p.id IS NULL OR e.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id
      WHERE m.produto_id IS NULL OR p.id IS NULL OR m.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM estoque_insumos e LEFT JOIN insumos i ON i.id = e.insumo_id
      WHERE e.insumo_id IS NULL OR i.id IS NULL OR e.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN insumos i ON i.id = m.insumo_id
      WHERE m.insumo_id IS NULL OR i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM itens_compra ic
       LEFT JOIN compras c ON c.id = ic.compra_id
       LEFT JOIN produtos p ON p.id = ic.produto_id
       LEFT JOIN insumos i ON i.id = ic.insumo_id
      WHERE ic.compra_id IS NULL OR c.id IS NULL OR ic.empresa_id IS DISTINCT FROM c.empresa_id
         OR (ic.produto_id IS NOT NULL AND (p.id IS NULL OR ic.empresa_id IS DISTINCT FROM p.empresa_id))
         OR (ic.insumo_id IS NOT NULL AND (i.id IS NULL OR ic.empresa_id IS DISTINCT FROM i.empresa_id))) +
    (SELECT count(*) FROM itens_inventario ii
       LEFT JOIN inventarios inv ON inv.id = ii.inventario_id
       LEFT JOIN produtos p ON p.id = ii.produto_id
      WHERE ii.inventario_id IS NULL OR ii.produto_id IS NULL OR inv.id IS NULL OR p.id IS NULL
         OR ii.empresa_id IS DISTINCT FROM inv.empresa_id
         OR ii.empresa_id IS DISTINCT FROM p.empresa_id)
    INTO vinculos_empresa;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND (l.id IS NULL OR inv.empresa_id IS DISTINCT FROM l.empresa_id))
    INTO vinculos_locais;
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO nomes_locais_inconsistentes;

  SELECT count(*) INTO saldos_sem_local FROM estoques WHERE local_id IS NULL;
  SELECT count(*) INTO saldos_sem_local_ambiguos FROM estoques e
    WHERE e.local_id IS NULL AND (SELECT count(*) FROM locais l WHERE l.empresa_id = e.empresa_id AND l.nome = e.local) <> 1;
  SELECT count(*) INTO movimentos_sem_local FROM movimentacoes WHERE local_id IS NULL;
  SELECT count(*) INTO inventarios_sem_local FROM inventarios WHERE local_id IS NULL;
  IF saldos_sem_local + movimentos_sem_local + inventarios_sem_local > 0 THEN
    RAISE NOTICE 'E4.2 diagnóstico sem backfill: saldos sem local_id=%, dos quais sem correspondência única de nome na própria empresa=%; movimentações sem local_id=%; inventários sem local_id=%',
      saldos_sem_local, saldos_sem_local_ambiguos, movimentos_sem_local, inventarios_sem_local;
  END IF;

  SELECT count(*) INTO pdv_locais_inconsistentes FROM pdv_caixas p LEFT JOIN locais l ON l.id = p.local_id
    WHERE p.local_id IS NOT NULL AND (l.id IS NULL OR p.empresa_id IS DISTINCT FROM l.empresa_id);
  SELECT count(*) INTO pdv_nomes_inconsistentes FROM pdv_caixas p JOIN locais l ON l.id = p.local_id
    WHERE p.local_id IS NOT NULL AND p.local IS DISTINCT FROM l.nome;
  SELECT count(*) INTO pdv_locais_ambiguos FROM pdv_caixas p
    WHERE p.local_id IS NULL AND p.local IS NOT NULL
      AND (SELECT count(*) FROM locais l WHERE l.empresa_id = p.empresa_id AND l.nome = p.local) <> 1;
  IF pdv_locais_ambiguos > 0 THEN
    RAISE NOTICE 'E4.2 diagnóstico sem backfill: caixas PDV com nome de local sem correspondência única na própria empresa=%; nenhum local_id foi inferido.', pdv_locais_ambiguos;
  END IF;

  IF duplicatas_locais + duplicatas_padroes + duplicatas_saldos + duplicatas_itens_inventario + dados_saldos_invalidos + vinculos_empresa + vinculos_locais + nomes_locais_inconsistentes + pdv_locais_inconsistentes + pdv_nomes_inconsistentes > 0 THEN
    RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_sem_produto_ou_local=%, vinculos_empresa_inconsistentes=%, vinculos_locais_estrangeiros=%, nomes_locais_inconsistentes=%, vinculos_pdv_estrangeiros=%, nomes_pdv_inconsistentes=%. Nenhum vínculo foi corrigido automaticamente.',
      duplicatas_locais, duplicatas_padroes, duplicatas_saldos, duplicatas_itens_inventario, dados_saldos_invalidos, vinculos_empresa, vinculos_locais, nomes_locais_inconsistentes, pdv_locais_inconsistentes, pdv_nomes_inconsistentes
      USING HINT = 'Revise explicitamente os registros usando empresa_id e IDs canônicos; preserve os dados originais e execute novamente após correção administrativa.';
  END IF;
END
$e42_preflight_core$;

-- Referências operacionais introduzidas em fases posteriores do schema.
-- Novamente, só diagnostica: não altera os links históricos.
DO $e42_preflight_operacional$
DECLARE
  refs_estrangeiras BIGINT;
BEGIN
  SELECT
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compra_recebimentos r ON r.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (r.id IS NULL OR m.empresa_id IS DISTINCT FROM r.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.movimentacao_estorno_id
      WHERE m.movimentacao_estorno_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.transferencia_id
      WHERE m.transferencia_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compra_recebimentos r ON r.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (r.id IS NULL OR m.empresa_id IS DISTINCT FROM r.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM compra_recebimentos r LEFT JOIN compras c ON c.id = r.compra_id
      WHERE r.compra_id IS NULL OR c.id IS NULL OR r.empresa_id IS DISTINCT FROM c.empresa_id) +
    (SELECT count(*) FROM compra_recebimento_itens ri
       LEFT JOIN compra_recebimentos r ON r.id = ri.recebimento_id
       LEFT JOIN itens_compra i ON i.id = ri.item_compra_id
      WHERE ri.recebimento_id IS NULL OR ri.item_compra_id IS NULL OR r.id IS NULL OR i.id IS NULL
         OR ri.empresa_id IS DISTINCT FROM r.empresa_id
         OR ri.empresa_id IS DISTINCT FROM i.empresa_id)
    INTO refs_estrangeiras;

  IF refs_estrangeiras > 0 THEN
    RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: % referências operacionais ausentes ou de outra empresa (compra, recebimento, item, OP, estorno ou transferência). Nenhuma referência foi alterada.', refs_estrangeiras
      USING HINT = 'Use os SELECTs de diagnóstico documentados em docs/RELATORIO-E4.2.md; não associe por nome nem escolha um destino automaticamente.';
  END IF;
END
$e42_preflight_operacional$;

-- Campos indispensáveis às chaves de estoque/contagem. O diagnóstico acima
-- interrompe antes de tornar os vínculos obrigatórios.
ALTER TABLE estoques ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE estoques ALTER COLUMN local SET NOT NULL;
ALTER TABLE movimentacoes ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE estoque_insumos ALTER COLUMN insumo_id SET NOT NULL;
ALTER TABLE movimentacoes_insumos ALTER COLUMN insumo_id SET NOT NULL;
ALTER TABLE itens_inventario ALTER COLUMN inventario_id SET NOT NULL;
ALTER TABLE itens_inventario ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE itens_compra ALTER COLUMN compra_id SET NOT NULL;

-- Remove apenas a antiga unicidade global de locais.nome. O diagnóstico acima
-- ocorre antes e a substituição é por (empresa_id, nome), preservando homônimos
-- válidos entre empresas.
DO $e42_drop_global_local_unique$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.conrelid = 'public.locais'::regclass
       AND con.contype = 'u'
       AND array_length(con.conkey, 1) = 1
       AND a.attname = 'nome'
  LOOP
    EXECUTE format('ALTER TABLE public.locais DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$e42_drop_global_local_unique$;

-- Chaves únicas de destino para FKs compostas e invariantes de unicidade.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_id ON locais (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_padrao_empresa ON locais (empresa_id) WHERE padrao IS TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_produtos_empresa_id ON produtos (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_inventarios_empresa_id ON inventarios (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_movimentacoes_empresa_id ON movimentacoes (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_insumos_empresa_id ON insumos (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_compras_empresa_id ON compras (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_compra_empresa_id ON itens_compra (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_recebimentos_empresa_id ON compra_recebimentos (empresa_id, id);
-- Saldo canônico: a chave de movimento usa o ID do local, nunca o nome.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_tam_local_id
  ON estoques (empresa_id, produto_id, tamanho_id, local_id)
  WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id
  ON estoques (empresa_id, produto_id, local_id)
  WHERE tamanho_id IS NULL AND local_id IS NOT NULL;
-- Linhas históricas sem local_id permanecem no lugar e têm unicidade por texto
-- apenas para impedir duplicação da mesma chave legada; não são reenquadradas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_tam_legado
  ON estoques (empresa_id, produto_id, tamanho_id, local)
  WHERE tamanho_id IS NOT NULL AND local_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_sem_tam_legado
  ON estoques (empresa_id, produto_id, local)
  WHERE tamanho_id IS NULL AND local_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_inv_empresa_prod_tam
  ON itens_inventario (empresa_id, inventario_id, produto_id, tamanho_id) WHERE tamanho_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_inv_empresa_prod_sem_tam
  ON itens_inventario (empresa_id, inventario_id, produto_id) WHERE tamanho_id IS NULL;

CREATE INDEX IF NOT EXISTS e42_estoques_empresa_local_idx ON estoques (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_produto_idx ON movimentacoes (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_local_idx ON movimentacoes (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_destino_idx ON movimentacoes (empresa_id, local_destino_id);
CREATE INDEX IF NOT EXISTS e42_inv_empresa_local_idx ON inventarios (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_pdv_caixas_empresa_local_idx ON pdv_caixas (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_itens_inv_empresa_inv_idx ON itens_inventario (empresa_id, inventario_id);
CREATE INDEX IF NOT EXISTS e42_itens_inv_empresa_prod_idx ON itens_inventario (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS e42_estoque_insumos_empresa_insumo_idx ON estoque_insumos (empresa_id, insumo_id);
CREATE INDEX IF NOT EXISTS e42_mov_insumos_empresa_insumo_idx ON movimentacoes_insumos (empresa_id, insumo_id);

-- Integridade composta: o ID estrangeiro precisa pertencer ao mesmo tenant.
-- NOT VALID é validado imediatamente abaixo e também protege toda escrita nova.
DO $e42_foreign_keys$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('estoques', 'fk_e42_estoques_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('estoques', 'fk_e42_estoques_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_destino', 'FOREIGN KEY (empresa_id, local_destino_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_estorno', 'FOREIGN KEY (empresa_id, movimentacao_estorno_id) REFERENCES movimentacoes (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_transferencia', 'FOREIGN KEY (empresa_id, transferencia_id) REFERENCES movimentacoes (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_item_compra', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id)'),
      ('inventarios', 'fk_e42_inventarios_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('pdv_caixas', 'fk_e42_pdv_caixas_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('itens_inventario', 'fk_e42_itens_inv_empresa_inventario', 'FOREIGN KEY (empresa_id, inventario_id) REFERENCES inventarios (empresa_id, id) ON DELETE CASCADE'),
      ('itens_inventario', 'fk_e42_itens_inv_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('estoque_insumos', 'fk_e42_estoque_insumos_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('compra_recebimentos', 'fk_e42_recebimentos_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id) ON DELETE CASCADE'),
      ('compra_recebimento_itens', 'fk_e42_recebimento_itens_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id) ON DELETE CASCADE'),
      ('compra_recebimento_itens', 'fk_e42_recebimento_itens_empresa_item', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id) ON DELETE CASCADE'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_item_compra', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id)')
    ) AS v(tabela, nome, ddl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.' || fk.tabela) AND conname = fk.nome
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', fk.tabela, fk.nome, fk.ddl);
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tabela, fk.nome);
  END LOOP;
END
$e42_foreign_keys$;

COMMENT ON INDEX uq_e42_locais_empresa_nome IS 'E4.2: local é único apenas dentro da empresa.';
COMMENT ON INDEX uq_e42_locais_padrao_empresa IS 'E4.2: no máximo um local padrão por empresa.';
COMMENT ON INDEX uq_e42_estoques_empresa_prod_sem_tam_local_id IS 'E4.2: célula sem tamanho canônica é única por empresa/produto/ID do local.';
COMMENT ON INDEX uq_e42_estoques_empresa_prod_sem_tam_legado IS 'E4.2: saldos sem local_id preservam unicidade textual legada sem backfill.';
COMMENT ON INDEX uq_e42_itens_inv_empresa_prod_sem_tam IS 'E4.2: linha sem tamanho é única por empresa/inventário/produto.';

-- ---- 0031 E4.2.1 — integridade de estoque: venda_id, local canônico de venda e idempotência de devolução ----
DO $e421_preflight$
DECLARE
  n_dev_venda INTEGER;
  n_devit_dev INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_dev_venda
    FROM devolucoes d JOIN vendas v ON v.id = d.venda_id
   WHERE v.empresa_id IS DISTINCT FROM d.empresa_id;
  SELECT COUNT(*) INTO n_devit_dev
    FROM devolucao_itens i JOIN devolucoes d ON d.id = i.devolucao_id
   WHERE d.empresa_id IS DISTINCT FROM i.empresa_id;
  IF n_dev_venda > 0 OR n_devit_dev > 0 THEN
    RAISE EXCEPTION 'E4.2.1 preflight bloqueou o DDL: devolucoes_de_outra_empresa=%, itens_de_devolucao_de_outra_empresa=%. Nenhuma linha foi alterada.',
      n_dev_venda, n_devit_dev;
  END IF;
END
$e421_preflight$;

ALTER TABLE movimentacoes    ADD COLUMN IF NOT EXISTS venda_id INTEGER;
ALTER TABLE vendas           ADD COLUMN IF NOT EXISTS local_saida_id INTEGER;
ALTER TABLE devolucoes       ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Diagnóstico informativo (depois do ADD COLUMN, para não citar coluna inexistente
-- em banco antigo): saídas de faturamento anteriores à E4.2.1 não têm venda_id.
-- Elas NÃO são associadas agora; o estorno legado as localiza pelo texto exato da
-- mesma empresa enquanto venda_id for NULL.
DO $e421_diagnostico$
DECLARE n_saidas_legadas INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_saidas_legadas
    FROM movimentacoes
   WHERE tipo = 'saida' AND venda_id IS NULL AND motivo LIKE 'Venda #%';
  RAISE NOTICE 'E4.2.1 diagnóstico sem backfill: saídas de venda sem venda_id=%', n_saidas_legadas;
END
$e421_diagnostico$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_vendas_empresa_id ON vendas (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_devolucoes_empresa_id ON devolucoes (empresa_id, id);
CREATE INDEX IF NOT EXISTS e421_mov_empresa_venda_idx ON movimentacoes (empresa_id, venda_id);
CREATE INDEX IF NOT EXISTS e421_vendas_empresa_local_saida_idx ON vendas (empresa_id, local_saida_id);
CREATE INDEX IF NOT EXISTS e421_devolucoes_empresa_venda_idx ON devolucoes (empresa_id, venda_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_devolucoes_empresa_idempotency
  ON devolucoes (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

DO $e421_foreign_keys$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('movimentacoes', 'fk_e421_mov_empresa_venda', 'FOREIGN KEY (empresa_id, venda_id) REFERENCES vendas (empresa_id, id)'),
      ('vendas', 'fk_e421_vendas_empresa_local_saida', 'FOREIGN KEY (empresa_id, local_saida_id) REFERENCES locais (empresa_id, id)'),
      ('devolucoes', 'fk_e421_devolucoes_empresa_venda', 'FOREIGN KEY (empresa_id, venda_id) REFERENCES vendas (empresa_id, id)'),
      ('devolucao_itens', 'fk_e421_devolucao_itens_empresa_devolucao', 'FOREIGN KEY (empresa_id, devolucao_id) REFERENCES devolucoes (empresa_id, id) ON DELETE CASCADE')
    ) AS v(tabela, nome, ddl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.' || fk.tabela) AND conname = fk.nome
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', fk.tabela, fk.nome, fk.ddl);
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tabela, fk.nome);
  END LOOP;
END
$e421_foreign_keys$;

COMMENT ON COLUMN movimentacoes.venda_id IS 'E4.2.1: venda que originou a baixa, a entrada de devolução ou o estorno. NULL em lançamentos manuais e no histórico anterior (sem backfill).';
COMMENT ON COLUMN vendas.local_saida_id IS 'E4.2.1: local canônico de saída. NULL em vendas legadas (usam local_saida texto).';
COMMENT ON INDEX uq_e421_devolucoes_empresa_idempotency IS 'E4.2.1: criação de devolução é idempotente por chave dentro da empresa.';

-- ---- 0032 E4.2.3 — vocabulário canônico da máquina de expedição (AUD-01) ----
-- Mesmo conteúdo de db/migrations/0032_e423_expedicao_vocabulario.sql, para
-- banco novo sobe completo por aqui e banco antigo recebe a substituição do
-- CHECK já no bootstrap. Idempotente. NÃO altera dados históricos (sem backfill).
DO $e423_diagnostico$
DECLARE
  r RECORD;
  n_incomp INTEGER;
  n_total INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_total FROM expedicao_eventos;
  SELECT COUNT(*) INTO n_incomp FROM expedicao_eventos
   WHERE etapa NOT IN ('pendente', 'separacao', 'conferida', 'embalada', 'expedida');
  RAISE NOTICE 'E4.2.3 diagnóstico sem backfill: expedicao_eventos total=%, fora_do_vocabulario_canonico=%', n_total, n_incomp;
  FOR r IN SELECT etapa, COUNT(*) AS n FROM expedicao_eventos GROUP BY etapa ORDER BY etapa LOOP
    RAISE NOTICE 'E4.2.3 diagnóstico: etapa="%" quantidade=%', r.etapa, r.n;
  END LOOP;
  IF n_incomp > 0 THEN
    RAISE NOTICE 'E4.2.3: existem linhas históricas com vocabulário antigo. ELAS NÃO SÃO CONVERTIDAS (sem backfill heurístico). O CHECK novo será criado NOT VALID e a VALIDATE CONSTRAINT fica pendente até tratamento explícito.';
  END IF;
END
$e423_diagnostico$;

ALTER TABLE expedicao_eventos DROP CONSTRAINT IF EXISTS expedicao_eventos_etapa_valida;

DO $e423_check$
DECLARE
  n_incomp INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_incomp FROM expedicao_eventos
   WHERE etapa NOT IN ('pendente', 'separacao', 'conferida', 'embalada', 'expedida');
  EXECUTE $ddl$
    ALTER TABLE expedicao_eventos ADD CONSTRAINT expedicao_eventos_etapa_valida CHECK (etapa IN (
      'pendente', 'separacao', 'conferida', 'embalada', 'expedida'
    )) NOT VALID
  $ddl$;
  IF n_incomp = 0 THEN
    EXECUTE 'ALTER TABLE expedicao_eventos VALIDATE CONSTRAINT expedicao_eventos_etapa_valida';
    RAISE NOTICE 'E4.2.3: CHECK expedicao_eventos_etapa_valida validado no vocabulário canônico.';
  ELSE
    RAISE NOTICE 'E4.2.3: CHECK expedicao_eventos_etapa_valida criado NOT VALID (linhas históricas incompatíveis=%). Novas escritas já são limitadas ao vocabulário canônico.', n_incomp;
  END IF;
END
$e423_check$;

COMMENT ON CONSTRAINT expedicao_eventos_etapa_valida ON expedicao_eventos IS
  'E4.2.3: vocabulário canônico da máquina de expedição (pendente, separacao, conferida, embalada, expedida) — o mesmo de vendas.expedicao_etapa. Linhas históricas com conferencia/embalagem/expedicao são preservadas sem conversão; se existirem, o CHECK fica NOT VALID até tratamento explícito.';

-- ============================================================
-- 0033) P0 — TENANT EXPLÍCITO EM CATÁLOGO PÚBLICO E COMMERCE
-- Espelha db/migrations/0033_p0_commerce_tenant_scope.sql.
-- ============================================================

ALTER TABLE politicas_comerciais ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
-- Para regras vinculadas, deriva o tenant só quando catálogo/cliente/coleção
-- apontam todos para a mesma empresa. Regras gerais legadas e relações
-- conflitantes são atribuídas conservadoramente à empresa padrão (1).
UPDATE politicas_comerciais p
   SET empresa_id = COALESCE((
     SELECT MIN(link.empresa_id)
       FROM (
         SELECT c.empresa_id FROM catalogos c WHERE c.id = p.catalogo_id
         UNION
         SELECT cl.empresa_id FROM clientes cl WHERE cl.id = p.cliente_id
         UNION
         SELECT co.empresa_id FROM colecoes co WHERE co.id = p.colecao_id
       ) AS link
      HAVING COUNT(DISTINCT link.empresa_id) = 1
   ), 1)
 WHERE p.empresa_id IS NULL;
ALTER TABLE politicas_comerciais ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE politicas_comerciais ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS politicas_comerciais_empresa_idx ON politicas_comerciais (empresa_id, ativo, prioridade DESC);

ALTER TABLE connectors ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connectors c SET empresa_id = COALESCE(u.empresa_id, 1)
  FROM usuarios u WHERE c.usuario_id = u.id AND c.empresa_id IS NULL;
UPDATE connectors SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connectors ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connectors ALTER COLUMN empresa_id SET NOT NULL;
DROP INDEX IF EXISTS connectors_usuario_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_empresa_usuario_provider_key
  ON connectors (empresa_id, usuario_id, provider);
CREATE INDEX IF NOT EXISTS connectors_empresa_usuario_status_idx
  ON connectors (empresa_id, usuario_id, status);
CREATE INDEX IF NOT EXISTS connectors_empresa_shop_idx
  ON connectors (empresa_id, provider, shop_id);

ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connector_events e SET empresa_id = COALESCE(
    (SELECT c.empresa_id FROM connectors c WHERE c.id = e.connector_id),
    (SELECT u.empresa_id FROM usuarios u WHERE u.id = e.usuario_id),
    1
  ) WHERE e.empresa_id IS NULL;
UPDATE connector_events SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connector_events ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connector_events ALTER COLUMN empresa_id SET NOT NULL;
DROP INDEX IF EXISTS connector_events_usuario_id_provider_external_event_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS connector_events_empresa_usuario_provider_external_event_id_key
  ON connector_events (empresa_id, usuario_id, provider, external_event_id);
CREATE INDEX IF NOT EXISTS connector_events_empresa_usuario_provider_created_idx
  ON connector_events (empresa_id, usuario_id, provider, created_at);

ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connector_oauth_states s SET empresa_id = COALESCE(u.empresa_id, 1)
  FROM usuarios u WHERE s.usuario_id = u.id AND s.empresa_id IS NULL;
UPDATE connector_oauth_states SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connector_oauth_states ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connector_oauth_states ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS connector_oauth_states_empresa_usuario_provider_expires_idx
  ON connector_oauth_states (empresa_id, usuario_id, provider, expires_at);

UPDATE sales
   SET reference = 'empresa:' || empresa_id::text || ':usuario:' || usuario_id::text || ':' || lower(channel::text) || ':' || external_order_id
 WHERE external_order_id IS NOT NULL
   AND reference NOT LIKE 'empresa:' || empresa_id::text || ':usuario:' || usuario_id::text || ':%';
DROP INDEX IF EXISTS sales_usuario_id_channel_external_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS sales_empresa_usuario_channel_external_order_id_key
  ON sales (empresa_id, usuario_id, channel, external_order_id);
CREATE INDEX IF NOT EXISTS sales_empresa_usuario_channel_occurred_idx
  ON sales (empresa_id, usuario_id, channel, occurred_at DESC);

-- ==================================================================
-- BLOCO GOLIVE-03 — PONTE MARKETPLACE → VENDA OPERACIONAL (migration 0034)
--
-- Espelha db/migrations/0034_golive03_marketplace_venda_operacional.sql
-- (idempotente para bancos existentes).
-- ==================================================================
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_externo_canal TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_externo_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_pedido_externo
  ON vendas (empresa_id, pedido_externo_canal, pedido_externo_id)
  WHERE pedido_externo_id IS NOT NULL;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS operational_venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS buyer_email TEXT;
CREATE INDEX IF NOT EXISTS sales_operational_venda_idx
  ON sales (operational_venda_id)
  WHERE operational_venda_id IS NOT NULL;

-- ==================================================================
-- BLOCO LISTAGEM DE PRODUTOS EM ESCALA (migration 0036)
--
-- Espelha db/migrations/0036_produtos_listagem_escala.sql (idempotente para
-- bancos existentes). Índice da ORDEM PADRÃO da listagem de produtos —
-- (empresa_id, nome ASC NULLS LAST, id DESC) — para que a paginação do
-- servidor não ordene o catálogo inteiro do tenant a cada página.
-- ==================================================================
CREATE INDEX IF NOT EXISTS idx_produtos_empresa_nome_id
  ON produtos (empresa_id, nome ASC NULLS LAST, id DESC);

-- ==================================================================
-- BLOCO IMPRESSÃO P0/P1 — FILA (PrintIR) + AGENTES LOCAIS (migration 0037)
--
-- Espelha db/migrations/0037_print_p0_p1.sql (idempotente para bancos
-- existentes). Fila persistente de impressão com claim/lease, retry com
-- backoff e idempotência (empresa_id, idempotency_key); machine identity
-- dos agentes com token revogável (só hash); códigos de pareamento de uso
-- único; nonces anti-replay. Ver docs/IMPRESSAO-P0-P1.md.
-- ==================================================================
CREATE TABLE IF NOT EXISTS print_agents (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  machine_id TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  terminal TEXT,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ativo',
  agent_version TEXT,
  platform TEXT,
  printers JSONB,
  last_heartbeat_at TIMESTAMPTZ,
  last_ip TEXT,
  paired_by INTEGER REFERENCES usuarios(id),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_agents_status_valido CHECK (status IN ('ativo', 'revogado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agents_machine ON print_agents (machine_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agents_token_hash ON print_agents (token_hash);
CREATE INDEX IF NOT EXISTS print_agents_empresa_status_idx ON print_agents (empresa_id, status);

CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  public_id TEXT NOT NULL,
  ir_version INTEGER NOT NULL DEFAULT 1,
  doc_type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  terminal TEXT,
  printer_name TEXT,
  copies INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by_agent_id INTEGER REFERENCES print_agents(id),
  lease_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error TEXT,
  permanent_error BOOLEAN NOT NULL DEFAULT false,
  reprint_of TEXT,
  requested_by INTEGER REFERENCES usuarios(id),
  claimed_at TIMESTAMPTZ,
  printing_at TIMESTAMPTZ,
  printed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_jobs_status_valido CHECK (status IN ('QUEUED', 'CLAIMED', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED')),
  CONSTRAINT print_jobs_copies_valido CHECK (copies >= 1 AND copies <= 99),
  CONSTRAINT print_jobs_priority_valido CHECK (priority >= 0 AND priority <= 100),
  CONSTRAINT print_jobs_attempts_valido CHECK (attempts >= 0 AND max_attempts >= 1 AND max_attempts <= 20),
  CONSTRAINT print_jobs_em_voo_tem_lease CHECK (
    status NOT IN ('CLAIMED', 'PRINTING')
    OR (claimed_by_agent_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT print_jobs_impresso_tem_data CHECK (status <> 'PRINTED' OR printed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_public_id ON print_jobs (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_idempotency ON print_jobs (empresa_id, idempotency_key);
CREATE INDEX IF NOT EXISTS print_jobs_claim_idx ON print_jobs (empresa_id, status, priority DESC, criado_em ASC, id ASC);
CREATE INDEX IF NOT EXISTS print_jobs_terminal_idx ON print_jobs (empresa_id, terminal, status) WHERE terminal IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_lease_idx ON print_jobs (lease_expires_at) WHERE status IN ('CLAIMED', 'PRINTING');
CREATE INDEX IF NOT EXISTS print_jobs_empresa_criado_idx ON print_jobs (empresa_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS print_pairing_codes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  code_hash TEXT NOT NULL,
  terminal TEXT,
  nome_sugerido TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_agent_id INTEGER REFERENCES print_agents(id),
  tentativas INTEGER NOT NULL DEFAULT 0,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_pairing_code_hash ON print_pairing_codes (code_hash);
CREATE INDEX IF NOT EXISTS print_pairing_empresa_idx ON print_pairing_codes (empresa_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS print_agent_nonces (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  agent_id INTEGER NOT NULL REFERENCES print_agents(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_agent_nonces ON print_agent_nonces (agent_id, nonce);
CREATE INDEX IF NOT EXISTS print_agent_nonces_criado_idx ON print_agent_nonces (criado_em);

-- ============================================================================
-- 0038 — Impressão Profissional (P2 + P3 + P4 + P5 + P6):
-- idempotência e dados canônicos de cupom no PDV, índices operacionais de
-- fila/histórico e configuração multi-impressora por terminal (print_terminals).
-- ============================================================================

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_valor_recebido NUMERIC(12,2);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_troco NUMERIC(12,2);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_operador_id INTEGER REFERENCES usuarios(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_empresa_idempotency
  ON vendas (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE pdv_pagamentos ADD COLUMN IF NOT EXISTS valor_informado NUMERIC(12,2);

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_protocol TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS reprint_reason TEXT;

CREATE INDEX IF NOT EXISTS print_jobs_source_ref_idx
  ON print_jobs (empresa_id, source_ref, criado_em DESC)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_doc_type_idx
  ON print_jobs (empresa_id, doc_type, criado_em DESC);

CREATE INDEX IF NOT EXISTS print_jobs_agent_idx
  ON print_jobs (empresa_id, claimed_by_agent_id, criado_em DESC)
  WHERE claimed_by_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_user_idx
  ON print_jobs (empresa_id, requested_by, criado_em DESC)
  WHERE requested_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_reprint_idx
  ON print_jobs (empresa_id, reprint_of)
  WHERE reprint_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS print_terminals (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  agent_id INTEGER REFERENCES print_agents(id) ON DELETE SET NULL,
  default_printer TEXT,
  receipt_printer TEXT,
  receipt_protocol TEXT NOT NULL DEFAULT 'escpos',
  receipt_width_cols INTEGER NOT NULL DEFAULT 48,
  label_printer TEXT,
  label_protocol TEXT NOT NULL DEFAULT 'zpl',
  document_printer TEXT,
  document_protocol TEXT NOT NULL DEFAULT 'pdf',
  fallback_mode TEXT NOT NULL DEFAULT 'browser_pdf',
  auto_print_pdv BOOLEAN NOT NULL DEFAULT true,
  allow_operator_reprint BOOLEAN NOT NULL DEFAULT true,
  copies_recibo INTEGER NOT NULL DEFAULT 1,
  copies_documento INTEGER NOT NULL DEFAULT 1,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_terminals_receipt_proto_valido CHECK (receipt_protocol IN ('escpos', 'text')),
  CONSTRAINT print_terminals_label_proto_valido CHECK (label_protocol IN ('zpl', 'epl2', 'a4')),
  CONSTRAINT print_terminals_doc_proto_valido CHECK (document_protocol IN ('pdf', 'escpos', 'text')),
  CONSTRAINT print_terminals_fallback_valido CHECK (fallback_mode IN ('browser_pdf', 'browser_html', 'queue_only', 'none')),
  CONSTRAINT print_terminals_copies_valido CHECK (copies_recibo >= 1 AND copies_recibo <= 10 AND copies_documento >= 1 AND copies_documento <= 10),
  CONSTRAINT print_terminals_cols_valido CHECK (receipt_width_cols IN (32, 42, 48))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_print_terminals_empresa_codigo
  ON print_terminals (empresa_id, codigo);

CREATE INDEX IF NOT EXISTS print_terminals_empresa_ativo_idx
  ON print_terminals (empresa_id, ativo);

-- ============================================================================
-- SEÇÃO 0041..0046 — EVOLUÇÃO MASTER (MA-02..MA-07) · FUNDAÇÃO COMERCIAL
--
-- Espelho de db/migrations/0041..0046. A autoridade em banco novo é a
-- CADEIA VERSIONADA (o boot aplica bootstrap.sql + migrations); este bloco
-- existe para o schema consolidado refletir o estado final.
-- ============================================================================

-- ---- 0041_territorios ----

-- ============================================================================
-- 0041 — MA-02 · TERRITÓRIOS (domínio próprio, hierárquico)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Até aqui "território" era `representantes.regiao TEXT` (texto livre) e o
-- endereço do cliente. Isso não hierarquiza, não tem dono, não tem status e não
-- serve para carteira, meta nem indicador territorial.
--
-- Esta migration cria o DOMÍNIO de território — separado do cadastro de
-- representante (docs/ERP-MASTER-ARCHITECTURE.md §9). Ela é ADITIVA e
-- IDEMPOTENTE: não altera nenhuma tabela existente e NÃO migra
-- `representantes.regiao` (o texto legado continua valendo; um de-para futuro
-- pode popular `representante_territorio` sem apagar nada).
--
-- PRINCÍPIOS
--   • hierarquia LIVRE (auto-FK), não uma árvore fixa de níveis;
--   • território pode ser NÃO geográfico (comercial, digital, key account,
--     especial, canal) — geografia é opcional (uf/cidade);
--   • ciclo hierárquico é impossível: recusado pelo trigger no banco E pela
--     validação de serviço (defesa em profundidade);
--   • pai de outra empresa é recusado pelo trigger;
--   • `nivel` é DERIVADO do pai (nunca digitado à mão), limitado a 10;
--   • desativação (`status = 'inativo'`) preserva todo o histórico;
--   • exclusão com dependência continua devolvendo 409 pelo diagnóstico
--     (server/src/dependencias.ts) — nenhuma FK em CASCADE é criada aqui.
-- ============================================================================

CREATE TABLE IF NOT EXISTS territorios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT,
  nome TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL DEFAULT 'comercial',
  territorio_pai_id INTEGER REFERENCES territorios(id),
  nivel INTEGER NOT NULL DEFAULT 1,
  responsavel_id INTEGER REFERENCES representantes(id),
  uf TEXT,
  cidade TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT territorios_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT territorios_tipo_valido CHECK (tipo IN (
    'pais', 'estado', 'regiao', 'cidade', 'zona',
    'comercial', 'digital', 'key_account', 'especial', 'canal'
  )),
  CONSTRAINT territorios_nivel_valido CHECK (nivel >= 1 AND nivel <= 10),
  CONSTRAINT territorios_sem_auto_pai CHECK (territorio_pai_id IS NULL OR territorio_pai_id <> id)
);

-- Código é único POR EMPRESA — e só quando informado (nulo/vazio não colide).
CREATE UNIQUE INDEX IF NOT EXISTS uq_territorios_empresa_codigo
  ON territorios (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';

-- Nome é único entre irmãos (mesma empresa + mesmo pai). Sem isso, dois
-- "Zona Sul" no mesmo pai tornariam o relatório ambíguo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_territorios_empresa_nome_pai
  ON territorios (empresa_id, upper(nome), COALESCE(territorio_pai_id, 0));

CREATE INDEX IF NOT EXISTS territorios_empresa_pai_idx
  ON territorios (empresa_id, territorio_pai_id);
CREATE INDEX IF NOT EXISTS territorios_empresa_status_idx
  ON territorios (empresa_id, status);
CREATE INDEX IF NOT EXISTS territorios_empresa_tipo_idx
  ON territorios (empresa_id, tipo);
CREATE INDEX IF NOT EXISTS territorios_responsavel_idx
  ON territorios (empresa_id, responsavel_id);

-- ----------------------------------------------------------------------------
-- Hierarquia sã: pai da MESMA empresa, nível derivado, sem ciclo.
-- A checagem de ciclo sobe a cadeia a partir do pai; profundidade máxima 10
-- (a mesma do CHECK de nivel) impede laço infinito mesmo em dado corrompido.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_territorio_valida() RETURNS trigger AS $$
DECLARE
  pai        territorios%ROWTYPE;
  atual      INTEGER;
  passos     INTEGER := 0;
BEGIN
  IF NEW.nivel IS NULL OR NEW.nivel < 1 THEN
    NEW.nivel := 1;
  END IF;

  IF NEW.territorio_pai_id IS NULL THEN
    NEW.nivel := 1;
    RETURN NEW;
  END IF;

  SELECT * INTO pai FROM territorios WHERE id = NEW.territorio_pai_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'território pai inexistente' USING ERRCODE = '23503';
  END IF;
  IF pai.empresa_id <> NEW.empresa_id THEN
    RAISE EXCEPTION 'o território pai pertence a outra empresa' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS NOT NULL AND pai.id = NEW.id THEN
    RAISE EXCEPTION 'um território não pode ser pai de si mesmo' USING ERRCODE = '23514';
  END IF;

  NEW.nivel := COALESCE(pai.nivel, 1) + 1;
  IF NEW.nivel > 10 THEN
    RAISE EXCEPTION 'hierarquia de territórios excede 10 níveis' USING ERRCODE = '23514';
  END IF;

  atual := pai.id;
  WHILE atual IS NOT NULL LOOP
    passos := passos + 1;
    IF passos > 10 THEN
      RAISE EXCEPTION 'hierarquia de territórios com ciclo' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS NOT NULL AND atual = NEW.id THEN
      RAISE EXCEPTION 'hierarquia de territórios com ciclo' USING ERRCODE = '23514';
    END IF;
    SELECT territorio_pai_id INTO atual FROM territorios WHERE id = atual;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_territorios_valida ON territorios;
CREATE TRIGGER trg_territorios_valida
  BEFORE INSERT OR UPDATE ON territorios
  FOR EACH ROW EXECUTE FUNCTION brobond_territorio_valida();

-- ---- 0042_equipes_comerciais ----

-- ============================================================================
-- 0042 — MA-06 · EQUIPES COMERCIAIS E HIERARQUIA
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O cadastro de representantes é FINALIZADO e não recebe colunas de equipe,
-- líder ou supervisor. Equipe e hierarquia são ESTRUTURA ORGANIZACIONAL
-- (ERP-MASTER-ARCHITECTURE.md §8): entidades próprias, com vigência, para
-- preservar histórico e permitir roll-up de vendas/metas/comissão.
--
--   • equipes_comerciais   — a equipe (nome, líder, território, status);
--   • equipe_membros       — composição com papel, participação e vigência;
--   • representante_hierarquia — supervisor → subordinado (N níveis).
--
-- REGRAS
--   • um representante tem NO MÁXIMO um supervisor ativo (árvore, não grafo);
--   • ciclo é impossível (trigger sobe a cadeia + validação de serviço);
--   • histórico: saída/fim encerram a vigência — nada é apagado;
--   • `equipe_membros` é COMPOSIÇÃO da equipe (linha-filha): CASCADE, como
--     `itens_venda`/`grade_tamanhos`. As FKs para representantes são NO ACTION
--     (o diagnóstico de vínculos responde 409 antes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS equipes_comerciais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT,
  nome TEXT NOT NULL,
  descricao TEXT,
  lider_id INTEGER REFERENCES representantes(id),
  territorio_id INTEGER REFERENCES territorios(id),
  status TEXT NOT NULL DEFAULT 'ativo',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT equipes_comerciais_status_valido CHECK (status IN ('ativo', 'inativo'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_equipes_comerciais_empresa_nome
  ON equipes_comerciais (empresa_id, upper(nome));
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipes_comerciais_empresa_codigo
  ON equipes_comerciais (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';
CREATE INDEX IF NOT EXISTS equipes_comerciais_empresa_status_idx
  ON equipes_comerciais (empresa_id, status);
CREATE INDEX IF NOT EXISTS equipes_comerciais_lider_idx
  ON equipes_comerciais (empresa_id, lider_id);

CREATE TABLE IF NOT EXISTS equipe_membros (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  equipe_id INTEGER NOT NULL REFERENCES equipes_comerciais(id) ON DELETE CASCADE,
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  papel TEXT NOT NULL DEFAULT 'membro',
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  entrada DATE NOT NULL DEFAULT CURRENT_DATE,
  saida DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT equipe_membros_papel_valido CHECK (papel IN ('membro', 'lider', 'supervisor')),
  CONSTRAINT equipe_membros_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT equipe_membros_vigencia CHECK (saida IS NULL OR saida >= entrada),
  CONSTRAINT equipe_membros_participacao CHECK (participacao_pct > 0 AND participacao_pct <= 100)
);

-- Um representante não entra duas vezes na MESMA equipe com vigência aberta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipe_membros_aberto
  ON equipe_membros (empresa_id, equipe_id, representante_id)
  WHERE status = 'ativo' AND saida IS NULL;
CREATE INDEX IF NOT EXISTS equipe_membros_equipe_idx
  ON equipe_membros (empresa_id, equipe_id, status);
CREATE INDEX IF NOT EXISTS equipe_membros_representante_idx
  ON equipe_membros (empresa_id, representante_id, status);

CREATE TABLE IF NOT EXISTS representante_hierarquia (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  supervisor_id INTEGER NOT NULL REFERENCES representantes(id),
  subordinado_id INTEGER NOT NULL REFERENCES representantes(id),
  nivel TEXT NOT NULL DEFAULT 'supervisor',
  inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fim DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT representante_hierarquia_nivel_valido CHECK (nivel IN ('diretor', 'gerente', 'supervisor', 'coordenador')),
  CONSTRAINT representante_hierarquia_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT representante_hierarquia_sem_auto CHECK (supervisor_id <> subordinado_id),
  CONSTRAINT representante_hierarquia_vigencia CHECK (fim IS NULL OR fim >= inicio)
);

-- Árvore: no máximo UM supervisor ativo por subordinado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representante_hierarquia_ativa
  ON representante_hierarquia (empresa_id, subordinado_id)
  WHERE status = 'ativo' AND fim IS NULL;
CREATE INDEX IF NOT EXISTS representante_hierarquia_supervisor_idx
  ON representante_hierarquia (empresa_id, supervisor_id, status);

-- ----------------------------------------------------------------------------
-- Ciclo hierárquico é impossível: sobe a cadeia de supervisores a partir do
-- supervisor proposto e recusa se alcançar o próprio subordinado.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_hierarquia_sem_ciclo() RETURNS trigger AS $$
DECLARE
  atual  INTEGER := NEW.supervisor_id;
  passos INTEGER := 0;
BEGIN
  IF NEW.supervisor_id = NEW.subordinado_id THEN
    RAISE EXCEPTION 'um representante não pode ser supervisor de si mesmo' USING ERRCODE = '23514';
  END IF;

  WHILE atual IS NOT NULL LOOP
    IF atual = NEW.subordinado_id THEN
      RAISE EXCEPTION 'hierarquia comercial com ciclo' USING ERRCODE = '23514';
    END IF;
    passos := passos + 1;
    IF passos > 25 THEN
      RAISE EXCEPTION 'hierarquia comercial excede 25 níveis' USING ERRCODE = '23514';
    END IF;
    SELECT h.supervisor_id INTO atual
      FROM representante_hierarquia h
     WHERE h.subordinado_id = atual
       AND h.status = 'ativo'
       AND h.fim IS NULL
       AND h.empresa_id = NEW.empresa_id
       AND (TG_OP = 'INSERT' OR h.id <> NEW.id)
     LIMIT 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_representante_hierarquia_ciclo ON representante_hierarquia;
CREATE TRIGGER trg_representante_hierarquia_ciclo
  BEFORE INSERT OR UPDATE ON representante_hierarquia
  FOR EACH ROW EXECUTE FUNCTION brobond_hierarquia_sem_ciclo();

-- ---- 0043_representante_cliente ----

-- ============================================================================
-- 0043 — MA-03 · CARTEIRA TEMPORAL (representante × cliente)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Hoje o vínculo é `clientes.representante_id` (uma coluna): ao trocar o
-- representante, o vínculo anterior se perde — não há histórico de carteira.
--
-- `representante_cliente` guarda a CARTEIRA COM VIGÊNCIA:
--
--   01/01/2026 → Representante A   (fim = 2026-06-30)
--   01/07/2026 → Representante B   (fim = NULL)
--
-- Trocar de representante ENCERRA a vigência anterior; nunca sobrescreve nem
-- apaga. As vendas antigas continuam com o `representante_id` congelado no
-- próprio documento (vendas/itens já são assim) — o histórico não depende da
-- carteira atual.
--
-- REGRAS
--   • no máximo UMA carteira ABERTA (`fim IS NULL` + `status='ativo'`) por
--     cliente/empresa — índice único parcial (a exclusividade é do banco);
--   • sobreposição de vigência entre linhas é recusada pelo serviço (409) —
--     período sobreposto tornaria ambíguo "quem é o representante do cliente";
--   • `participacao_pct` já prepara carteira COMPARTILHADA (dois representantes
--     no mesmo cliente somando 100%);
--   • `clientes.representante_id` NÃO é alterado: continua sendo o vínculo
--     vigente "de conveniência" das telas. A carteira é a fonte temporal.
-- ============================================================================

CREATE TABLE IF NOT EXISTS representante_cliente (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  territorio_id INTEGER REFERENCES territorios(id),
  inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fim DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  prioridade INTEGER NOT NULL DEFAULT 1,
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT representante_cliente_status_valido CHECK (status IN ('ativo', 'encerrado', 'cancelado')),
  CONSTRAINT representante_cliente_vigencia CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT representante_cliente_participacao CHECK (participacao_pct > 0 AND participacao_pct <= 100),
  CONSTRAINT representante_cliente_prioridade CHECK (prioridade >= 1 AND prioridade <= 9),
  CONSTRAINT representante_cliente_encerrado_tem_fim CHECK (status <> 'encerrado' OR fim IS NOT NULL)
);

-- Exclusividade: uma única carteira ABERTA por cliente/empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representante_cliente_aberta
  ON representante_cliente (empresa_id, cliente_id)
  WHERE status = 'ativo' AND fim IS NULL;

CREATE INDEX IF NOT EXISTS representante_cliente_emp_rep_idx
  ON representante_cliente (empresa_id, representante_id, status);
CREATE INDEX IF NOT EXISTS representante_cliente_emp_cli_idx
  ON representante_cliente (empresa_id, cliente_id, inicio);
CREATE INDEX IF NOT EXISTS representante_cliente_territorio_idx
  ON representante_cliente (empresa_id, territorio_id);

-- ---- 0044_metas ----

-- ============================================================================
-- 0044 — MA-04 · METAS COMERCIAIS (domínio próprio, realizado DERIVADO)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Meta NÃO é atributo de representante (`representantes.meta_valor` seria a
-- modelagem errada). É planejamento com período + alvo + métrica + recorte.
--
-- O QUE ESTA TABELA NÃO TEM — DE PROPÓSITO
--   • `realizado`   — é SEMPRE derivado das vendas/itens (consulta);
--   • `atingimento` — é `realizado / meta`, calculado;
--   • `variacao`    — idem.
-- Nenhum usuário digita "82%". O servidor calcula (server/src/comercial.ts).
--
-- ALVOS SUPORTADOS (um por meta): representante, equipe, território, empresa.
-- MÉTRICAS: faturamento, quantidade, margem, pedidos, clientes.
-- RECORTES: todos, produto, categoria, coleção.
-- PERÍODO: mensal, trimestral ou anual (granularidade declarada; o realizado é
--          sempre apurado pela janela `periodo_inicio..periodo_fim`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS metas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT,
  alvo_tipo TEXT NOT NULL,
  representante_id INTEGER REFERENCES representantes(id),
  equipe_id INTEGER REFERENCES equipes_comerciais(id),
  territorio_id INTEGER REFERENCES territorios(id),
  metrica TEXT NOT NULL,
  recorte_tipo TEXT NOT NULL DEFAULT 'todos',
  produto_id INTEGER REFERENCES produtos(id),
  categoria_id INTEGER REFERENCES categorias(id),
  colecao_id INTEGER REFERENCES colecoes(id),
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  granularidade TEXT NOT NULL DEFAULT 'mensal',
  valor_meta NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_meta NUMERIC(14,3) NOT NULL DEFAULT 0,
  distribuicao TEXT NOT NULL DEFAULT 'linear',
  status TEXT NOT NULL DEFAULT 'ativa',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT metas_alvo_valido CHECK (alvo_tipo IN ('representante', 'equipe', 'territorio', 'empresa')),
  CONSTRAINT metas_metrica_valida CHECK (metrica IN ('faturamento', 'quantidade', 'margem', 'pedidos', 'clientes')),
  CONSTRAINT metas_recorte_valido CHECK (recorte_tipo IN ('todos', 'produto', 'categoria', 'colecao')),
  CONSTRAINT metas_granularidade_valida CHECK (granularidade IN ('mensal', 'trimestral', 'anual')),
  CONSTRAINT metas_distribuicao_valida CHECK (distribuicao IN ('linear', 'unica')),
  CONSTRAINT metas_status_valido CHECK (status IN ('rascunho', 'ativa', 'encerrada', 'cancelada')),
  CONSTRAINT metas_periodo_coerente CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT metas_valor_nao_negativo CHECK (valor_meta >= 0 AND quantidade_meta >= 0),
  CONSTRAINT metas_algum_alvo CHECK (valor_meta > 0 OR quantidade_meta > 0),
  -- O alvo preenchido tem de ser EXATAMENTE o do tipo declarado.
  CONSTRAINT metas_alvo_coerente CHECK (
    (alvo_tipo = 'representante' AND representante_id IS NOT NULL AND equipe_id IS NULL AND territorio_id IS NULL)
    OR (alvo_tipo = 'equipe' AND equipe_id IS NOT NULL AND representante_id IS NULL AND territorio_id IS NULL)
    OR (alvo_tipo = 'territorio' AND territorio_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL)
    OR (alvo_tipo = 'empresa' AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL)
  ),
  -- O recorte preenchido tem de ser EXATAMENTE o do tipo declarado.
  CONSTRAINT metas_recorte_coerente CHECK (
    (recorte_tipo = 'todos' AND produto_id IS NULL AND categoria_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'produto' AND produto_id IS NOT NULL AND categoria_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'categoria' AND categoria_id IS NOT NULL AND produto_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'colecao' AND colecao_id IS NOT NULL AND produto_id IS NULL AND categoria_id IS NULL)
  )
);

-- Duas metas ATIVAS idênticas (mesmo alvo, métrica, recorte e período) seriam
-- dado ambíguo: o índice impede. Sobreposição de período é recusada pelo
-- serviço (409).
CREATE UNIQUE INDEX IF NOT EXISTS uq_metas_alvo_ativa
  ON metas (
    empresa_id, alvo_tipo, metrica, recorte_tipo, periodo_inicio, periodo_fim,
    COALESCE(representante_id, 0), COALESCE(equipe_id, 0), COALESCE(territorio_id, 0),
    COALESCE(produto_id, 0), COALESCE(categoria_id, 0), COALESCE(colecao_id, 0)
  )
  WHERE status = 'ativa';

CREATE INDEX IF NOT EXISTS metas_empresa_periodo_idx
  ON metas (empresa_id, periodo_inicio, periodo_fim);
CREATE INDEX IF NOT EXISTS metas_representante_idx
  ON metas (empresa_id, representante_id, status);
CREATE INDEX IF NOT EXISTS metas_equipe_idx
  ON metas (empresa_id, equipe_id, status);
CREATE INDEX IF NOT EXISTS metas_territorio_idx
  ON metas (empresa_id, territorio_id, status);

-- ---- 0045_atribuicao_comercial ----

-- ============================================================================
-- 0045 — MA-07 · ATRIBUIÇÃO COMERCIAL (contribuição ≠ comissão)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Uma venda pode ser ATRIBUÍDA a mais de um representante (A = 60%, B = 40%).
-- Atribuição é quem participou do negócio — NÃO é comissão (o cálculo
-- financeiro vive no motor de comissão, migration 0046). Confundir os dois é o
-- erro clássico de modelagem que este desenho evita.
--
--   venda_atribuicao  →  participação comercial congelada NO DOCUMENTO
--   comissoes_apuradas →  cálculo financeiro por representante (0046)
--
-- REGRAS
--   • a soma das participações ativas de uma venda não passa de 100%
--     (validado no serviço, dentro da mesma transação);
--   • `vendas.representante_id` continua sendo o representante PRINCIPAL
--     (compatibilidade com faturamento, comissão legada e relatórios);
--   • território/equipe são CONGELADOS na atribuição: mudar a equipe depois não
--     reescreve o histórico da venda;
--   • apagar a venda remove as atribuições (CASCADE) — são composição do
--     documento, como `itens_venda`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS venda_atribuicao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  equipe_id INTEGER REFERENCES equipes_comerciais(id),
  territorio_id INTEGER REFERENCES territorios(id),
  papel TEXT NOT NULL DEFAULT 'principal',
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  origem TEXT NOT NULL DEFAULT 'manual',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT venda_atribuicao_papel_valido CHECK (papel IN ('principal', 'secundario')),
  CONSTRAINT venda_atribuicao_origem_valida CHECK (origem IN ('manual', 'carteira', 'equipe', 'importacao')),
  CONSTRAINT venda_atribuicao_participacao CHECK (participacao_pct > 0 AND participacao_pct <= 100)
);

-- Um representante aparece UMA vez por venda.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venda_atribuicao_representante
  ON venda_atribuicao (venda_id, representante_id);
CREATE INDEX IF NOT EXISTS venda_atribuicao_empresa_rep_idx
  ON venda_atribuicao (empresa_id, representante_id);
CREATE INDEX IF NOT EXISTS venda_atribuicao_empresa_equipe_idx
  ON venda_atribuicao (empresa_id, equipe_id);
CREATE INDEX IF NOT EXISTS venda_atribuicao_empresa_territorio_idx
  ON venda_atribuicao (empresa_id, territorio_id);
CREATE INDEX IF NOT EXISTS venda_atribuicao_venda_idx
  ON venda_atribuicao (venda_id);

-- No máximo UMA atribuição principal por venda.
CREATE UNIQUE INDEX IF NOT EXISTS uq_venda_atribuicao_principal
  ON venda_atribuicao (venda_id)
  WHERE papel = 'principal';

-- ---- 0046_comissoes_motor ----

-- ============================================================================
-- 0046 — MA-05 · MOTOR DE COMISSÕES (plano + regra com prioridade)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- `representantes.comissao_pct` é o DEFAULT do cadastro — não é motor de regra.
-- O motor precisa expressar: produto 8%, categoria 7%, cliente 10%, território,
-- equipe, representante, geral 5% — com vigência, base de cálculo e prioridade.
--
-- ENTIDADES
--   planos_comissao   — a política (vigência, base, momento de efetivação);
--   regras_comissao   — a regra com ESCOPO (geral/representante/equipe/
--                       território/cliente/coleção/categoria/produto);
--   comissoes_apuradas — a APURAÇÃO por venda × representante (congelada).
--
-- RESOLUÇÃO DA REGRA (implementada em server/src/comercial.ts)
--   1) especificidade do escopo: produto > categoria > coleção > cliente >
--      território > equipe > representante > geral;
--   2) prioridade declarada (maior vence), dentro do mesmo escopo;
--   3) vigência mais recente; 4) id (desempate determinístico).
--   Empate nunca é resolvido por "o último que rodou".
--
-- COMPATIBILIDADE (não quebra nada do que existe)
--   • `vendas.comissao_pct` / `comissao_valor` continuam sendo o CONGELAMENTO
--     da apuração (fonte que o faturamento e o relatório já leem);
--   • `comissoes_eventos` continua sendo o LIVRO de efetivação/estorno;
--   • as colunas novas em `comissoes_eventos` são NULLABLE e aditivas: os
--     lançamentos legados seguem idênticos;
--   • sem plano ativo com regra, o ERP se comporta EXATAMENTE como antes
--     (`representantes.comissao_pct`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS planos_comissao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  vigencia_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_fim DATE,
  base_calculo TEXT NOT NULL DEFAULT 'faturamento',
  momento_efetivacao TEXT NOT NULL DEFAULT 'recebimento',
  prioridade INTEGER NOT NULL DEFAULT 0,
  padrao BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ativo',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT planos_comissao_base_valida CHECK (base_calculo IN ('faturamento', 'liquido', 'margem')),
  CONSTRAINT planos_comissao_momento_valido CHECK (momento_efetivacao IN ('faturamento', 'recebimento')),
  CONSTRAINT planos_comissao_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT planos_comissao_vigencia CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_planos_comissao_empresa_nome
  ON planos_comissao (empresa_id, upper(nome));

-- Um plano PADRÃO ativo por empresa (é o que o motor usa quando nada mais casa).
CREATE UNIQUE INDEX IF NOT EXISTS uq_planos_comissao_padrao
  ON planos_comissao (empresa_id)
  WHERE padrao AND status = 'ativo';

CREATE INDEX IF NOT EXISTS planos_comissao_empresa_status_idx
  ON planos_comissao (empresa_id, status, prioridade);

CREATE TABLE IF NOT EXISTS regras_comissao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  plano_id INTEGER NOT NULL REFERENCES planos_comissao(id) ON DELETE CASCADE,
  escopo TEXT NOT NULL DEFAULT 'geral',
  representante_id INTEGER REFERENCES representantes(id),
  equipe_id INTEGER REFERENCES equipes_comerciais(id),
  territorio_id INTEGER REFERENCES territorios(id),
  cliente_id INTEGER REFERENCES clientes(id),
  colecao_id INTEGER REFERENCES colecoes(id),
  categoria_id INTEGER REFERENCES categorias(id),
  produto_id INTEGER REFERENCES produtos(id),
  tipo_valor TEXT NOT NULL DEFAULT 'percentual',
  valor NUMERIC(12,4) NOT NULL DEFAULT 0,
  base TEXT NOT NULL DEFAULT 'bruto',
  prioridade INTEGER NOT NULL DEFAULT 0,
  vigencia_inicio DATE,
  vigencia_fim DATE,
  status TEXT NOT NULL DEFAULT 'ativa',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT regras_comissao_escopo_valido CHECK (escopo IN (
    'geral', 'representante', 'equipe', 'territorio', 'cliente', 'colecao', 'categoria', 'produto'
  )),
  CONSTRAINT regras_comissao_tipo_valor_valido CHECK (tipo_valor IN ('percentual', 'fixo')),
  CONSTRAINT regras_comissao_base_valida CHECK (base IN ('bruto', 'liquido', 'margem')),
  CONSTRAINT regras_comissao_status_valido CHECK (status IN ('ativa', 'inativa')),
  CONSTRAINT regras_comissao_valor_valido CHECK (
    valor >= 0 AND (tipo_valor <> 'percentual' OR valor <= 100)
  ),
  CONSTRAINT regras_comissao_vigencia CHECK (vigencia_fim IS NULL OR vigencia_inicio IS NULL OR vigencia_fim >= vigencia_inicio),
  -- O escopo declarado tem de ter EXATAMENTE a coluna correspondente preenchida.
  CONSTRAINT regras_comissao_escopo_coerente CHECK (
    (escopo = 'geral' AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'representante' AND representante_id IS NOT NULL AND equipe_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'equipe' AND equipe_id IS NOT NULL AND representante_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'territorio' AND territorio_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'cliente' AND cliente_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'colecao' AND colecao_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND categoria_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'categoria' AND categoria_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND produto_id IS NULL)
    OR (escopo = 'produto' AND produto_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL AND cliente_id IS NULL AND colecao_id IS NULL AND categoria_id IS NULL)
  )
);

-- Duas regras ativas com o mesmo escopo/alvo no mesmo plano seriam ambíguas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_regras_comissao_escopo
  ON regras_comissao (
    plano_id, escopo,
    COALESCE(representante_id, 0), COALESCE(equipe_id, 0), COALESCE(territorio_id, 0),
    COALESCE(cliente_id, 0), COALESCE(colecao_id, 0), COALESCE(categoria_id, 0), COALESCE(produto_id, 0)
  )
  WHERE status = 'ativa';

CREATE INDEX IF NOT EXISTS regras_comissao_empresa_escopo_idx
  ON regras_comissao (empresa_id, escopo, status);
CREATE INDEX IF NOT EXISTS regras_comissao_plano_idx
  ON regras_comissao (plano_id);

-- ----------------------------------------------------------------------------
-- APURAÇÃO por venda × representante.
--
-- `vendas.comissao_valor` guarda o valor do representante PRINCIPAL (o mesmo
-- contrato de antes). Esta tabela guarda a apuração de CADA representante
-- atribuído — inclusive os secundários (60/40). Só a EFETIVAÇÃO (recebimento)
-- escreve em `comissoes_eventos`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comissoes_apuradas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  atribuicao_id INTEGER REFERENCES venda_atribuicao(id),
  plano_id INTEGER REFERENCES planos_comissao(id),
  regra_id INTEGER REFERENCES regras_comissao(id),
  base_tipo TEXT NOT NULL DEFAULT 'bruto',
  base_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  percentual NUMERIC(7,4),
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  origem TEXT NOT NULL DEFAULT 'motor',
  status TEXT NOT NULL DEFAULT 'apurada',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT comissoes_apuradas_base_valida CHECK (base_tipo IN ('bruto', 'liquido', 'margem')),
  CONSTRAINT comissoes_apuradas_status_valido CHECK (status IN ('apurada', 'estornada')),
  CONSTRAINT comissoes_apuradas_valores CHECK (valor >= 0 AND base_valor >= 0)
);

-- Uma apuração ATIVA por venda × representante (reapuração substitui, não soma).
CREATE UNIQUE INDEX IF NOT EXISTS uq_comissoes_apuradas_venda_rep
  ON comissoes_apuradas (venda_id, representante_id)
  WHERE status = 'apurada';

CREATE INDEX IF NOT EXISTS comissoes_apuradas_empresa_rep_idx
  ON comissoes_apuradas (empresa_id, representante_id, status);
CREATE INDEX IF NOT EXISTS comissoes_apuradas_venda_idx
  ON comissoes_apuradas (venda_id);

-- ----------------------------------------------------------------------------
-- Livro de efetivação: rastrear QUAL regra/plano/apuração gerou o lançamento.
-- Colunas NULLABLE — os lançamentos legados continuam válidos e inalterados.
-- ----------------------------------------------------------------------------
ALTER TABLE comissoes_eventos ADD COLUMN IF NOT EXISTS plano_id INTEGER REFERENCES planos_comissao(id);
ALTER TABLE comissoes_eventos ADD COLUMN IF NOT EXISTS regra_id INTEGER REFERENCES regras_comissao(id);
ALTER TABLE comissoes_eventos ADD COLUMN IF NOT EXISTS apurada_id INTEGER REFERENCES comissoes_apuradas(id);
ALTER TABLE comissoes_eventos ADD COLUMN IF NOT EXISTS base_tipo TEXT;

-- ---- 0048_representantes_2_0 ----
-- Espelho da migration db/migrations/0048_representantes_2_0.sql
-- (idempotente: um banco novo sobe completo por aqui, um banco antigo recebe a
-- mesma alteração pela migration versionada — nenhuma migration histórica é
-- editada). O cadastro de representante é EVOLUÍDO, não recriado: `regiao`,
-- `comissao_pct`, `telefone`, `whatsapp` e `email` continuam válidos.

ALTER TABLE representantes ADD COLUMN IF NOT EXISTS codigo TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS tipo_pessoa TEXT NOT NULL DEFAULT 'PF';
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS registro_profissional TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS orgao_registro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS tipo_representante TEXT NOT NULL DEFAULT 'REPRESENTANTE_COMERCIAL';
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS data_nascimento DATE;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS celular TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS pais TEXT DEFAULT 'Brasil';
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS territorio_id INTEGER REFERENCES territorios(id);

UPDATE representantes
   SET codigo = 'REP' || lpad(id::text, 5, '0')
 WHERE codigo IS NULL OR btrim(codigo) = '';
UPDATE representantes SET pais = 'Brasil' WHERE pais IS NULL OR btrim(pais) = '';

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_tipo_pessoa_valido
    CHECK (tipo_pessoa IN ('PF', 'PJ'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_tipo_valido
    CHECK (tipo_representante IN (
      'INTERNO', 'EXTERNO', 'REPRESENTANTE_COMERCIAL', 'SUPERVISOR',
      'COORDENADOR', 'GERENTE', 'PARCEIRO', 'TERCEIRIZADO'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_uf_valida
    CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_cep_valido
    CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_nascimento_plausivel
    CHECK (data_nascimento IS NULL OR (data_nascimento >= '1900-01-01' AND data_nascimento < '2100-01-01'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_empresa_codigo
  ON representantes (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_cnpj_empresa
  ON representantes (empresa_id, regexp_replace(cnpj, '[^0-9]', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '[^0-9]', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS representantes_empresa_ativo_idx
  ON representantes (empresa_id, ativo);
CREATE INDEX IF NOT EXISTS representantes_empresa_tipo_idx
  ON representantes (empresa_id, tipo_representante);
CREATE INDEX IF NOT EXISTS representantes_empresa_pessoa_idx
  ON representantes (empresa_id, tipo_pessoa);
CREATE INDEX IF NOT EXISTS representantes_empresa_territorio_idx
  ON representantes (empresa_id, territorio_id);
CREATE INDEX IF NOT EXISTS representantes_empresa_codigo_idx
  ON representantes (empresa_id, codigo);

CREATE OR REPLACE FUNCTION brobond_representante_valida() RETURNS trigger AS $$
DECLARE
  terr territorios%ROWTYPE;
BEGIN
  NEW.tipo_pessoa := upper(btrim(COALESCE(NULLIF(NEW.tipo_pessoa, ''), 'PF')));
  NEW.tipo_representante := upper(btrim(COALESCE(NULLIF(NEW.tipo_representante, ''), 'REPRESENTANTE_COMERCIAL')));

  IF NEW.codigo IS NOT NULL THEN
    NEW.codigo := upper(btrim(NEW.codigo));
    IF NEW.codigo = '' THEN NEW.codigo := NULL; END IF;
  END IF;
  IF NEW.cpf IS NOT NULL THEN
    NEW.cpf := regexp_replace(NEW.cpf, '[^0-9]', '', 'g');
    IF NEW.cpf = '' THEN NEW.cpf := NULL; END IF;
  END IF;
  IF NEW.cnpj IS NOT NULL THEN
    NEW.cnpj := regexp_replace(NEW.cnpj, '[^0-9]', '', 'g');
    IF NEW.cnpj = '' THEN NEW.cnpj := NULL; END IF;
  END IF;
  IF NEW.cep IS NOT NULL THEN
    NEW.cep := regexp_replace(NEW.cep, '[^0-9]', '', 'g');
    IF NEW.cep = '' THEN NEW.cep := NULL; END IF;
  END IF;
  IF NEW.uf IS NOT NULL THEN
    NEW.uf := upper(btrim(NEW.uf));
    IF NEW.uf = '' THEN NEW.uf := NULL; END IF;
  END IF;
  IF NEW.pais IS NULL OR btrim(NEW.pais) = '' THEN
    NEW.pais := 'Brasil';
  END IF;

  IF NEW.territorio_id IS NOT NULL THEN
    SELECT * INTO terr FROM territorios WHERE id = NEW.territorio_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'território inexistente' USING ERRCODE = '23503';
    END IF;
    IF terr.empresa_id <> NEW.empresa_id THEN
      RAISE EXCEPTION 'o território pertence a outra empresa' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_representante_valida ON representantes;
CREATE TRIGGER trg_representante_valida
  BEFORE INSERT OR UPDATE ON representantes
  FOR EACH ROW EXECUTE FUNCTION brobond_representante_valida();


-- ============================================================================
-- 0047 — CADASTRO PROFISSIONAL DE INSUMOS (identificação + categorização).
-- Espelha db/migrations/0047_insumos_cadastro_profissional.sql.
-- ============================================================================

ALTER TABLE insumos ADD COLUMN IF NOT EXISTS codigo_insumo TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insumos_codigo_empresa
  ON insumos (empresa_id, codigo_insumo)
  WHERE codigo_insumo IS NOT NULL AND codigo_insumo <> '';

CREATE TABLE IF NOT EXISTS categorias_insumos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  pai_id INTEGER REFERENCES categorias_insumos(id),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categorias_insumos_empresa_nome
  ON categorias_insumos (empresa_id, nome);

CREATE INDEX IF NOT EXISTS categorias_insumos_empresa_idx ON categorias_insumos (empresa_id);
CREATE INDEX IF NOT EXISTS categorias_insumos_pai_idx ON categorias_insumos (pai_id);

ALTER TABLE insumos ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_insumos(id);

CREATE INDEX IF NOT EXISTS insumos_categoria_idx ON insumos (categoria_id);

-- ============================================================================
-- 0049 — CRM 3.0 · LEADS, OPORTUNIDADES, ATIVIDADES E MOTIVOS DE PERDA
-- Espelho da migration db/migrations/0049_crm_3_0.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS crm_motivos_perda (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_motivos_perda_empresa_idx
  ON crm_motivos_perda (empresa_id, ativo);

CREATE TABLE IF NOT EXISTS crm_leads (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  documento TEXT,
  email TEXT,
  telefone TEXT,
  origem TEXT,
  status TEXT NOT NULL DEFAULT 'novo',
  valor_estimado NUMERIC(14,2),
  probabilidade INTEGER DEFAULT 0,
  cliente_id INTEGER REFERENCES clientes(id),
  lead_convertido_em TIMESTAMPTZ,
  previsao_contato DATE,
  observacoes TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_leads_empresa_status_idx
  ON crm_leads (empresa_id, status);
CREATE INDEX IF NOT EXISTS crm_leads_empresa_responsavel_idx
  ON crm_leads (empresa_id, responsavel_id);
CREATE INDEX IF NOT EXISTS crm_leads_cliente_idx
  ON crm_leads (cliente_id);

CREATE TABLE IF NOT EXISTS crm_oportunidades (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  lead_id INTEGER REFERENCES crm_leads(id),
  nome TEXT NOT NULL,
  etapa TEXT NOT NULL DEFAULT 'prospeccao',
  valor NUMERIC(14,2),
  probabilidade INTEGER DEFAULT 0,
  previsao_fechamento DATE,
  data_fechamento DATE,
  motivo_perda_id INTEGER REFERENCES crm_motivos_perda(id),
  observacoes TEXT,
  responsavel_id INTEGER REFERENCES usuarios(id),
  status TEXT NOT NULL DEFAULT 'aberta',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_status_idx
  ON crm_oportunidades (empresa_id, status);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_idx
  ON crm_oportunidades (empresa_id, etapa);
CREATE INDEX IF NOT EXISTS crm_oportunidades_cliente_idx
  ON crm_oportunidades (cliente_id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_lead_idx
  ON crm_oportunidades (lead_id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_responsavel_idx
  ON crm_oportunidades (empresa_id, responsavel_id);

CREATE TABLE IF NOT EXISTS crm_atividades (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lead_id INTEGER REFERENCES crm_leads(id),
  oportunidade_id INTEGER REFERENCES crm_oportunidades(id),
  cliente_id INTEGER REFERENCES clientes(id),
  tipo TEXT NOT NULL,
  data_atividade TIMESTAMPTZ NOT NULL DEFAULT now(),
  resultado TEXT,
  resumo TEXT,
  proxima_acao DATE,
  responsavel_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_atividades_empresa_tipo_idx
  ON crm_atividades (empresa_id, tipo);
CREATE INDEX IF NOT EXISTS crm_atividades_lead_idx
  ON crm_atividades (lead_id);
CREATE INDEX IF NOT EXISTS crm_atividades_oportunidade_idx
  ON crm_atividades (oportunidade_id);
CREATE INDEX IF NOT EXISTS crm_atividades_cliente_idx
  ON crm_atividades (cliente_id);
CREATE INDEX IF NOT EXISTS crm_atividades_data_idx
  ON crm_atividades (empresa_id, data_atividade);

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_status_valido
    CHECK (status IN ('novo', 'contato', 'qualificacao', 'proposta', 'ganho', 'perdido'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_etapa_valido
    CHECK (etapa IN ('prospeccao', 'qualificacao', 'proposta', 'negociacao', 'fechamento'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_status_valido
    CHECK (status IN ('aberta', 'ganha', 'perdida'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_perda_exige_motivo
    CHECK (status <> 'perdida' OR motivo_perda_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_tipo_valido
    CHECK (tipo IN ('chamada', 'visita', 'email', 'reuniao', 'tarefa', 'follow_up'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_resultado_valido
    CHECK (resultado IS NULL OR resultado IN ('realizado', 'agendado', 'nao_compareceu'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- Espelho da migration db/migrations/0050_crm_funil_indices.sql
-- (CRM 3.0 — índices do funil; o contrato de conversão está documentado lá)
-- ============================================================================
CREATE INDEX IF NOT EXISTS crm_leads_empresa_origem_idx
  ON crm_leads (empresa_id, origem);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_lead_idx
  ON crm_oportunidades (empresa_id, lead_id);

-- ============================================================================
-- ESPELHO DAS MIGRATIONS 0051..0057 (ERP 3.0)
--
-- O schema.sql é aplicado a cada boot em bancos NOVOS (server/src/db.ts) e é a
-- referência de "coluna existe" para o teste `api.test.ts`. Toda migration
-- versionada precisa do seu espelho aqui — senão um banco novo nasce sem a
-- tabela e o teste de contrato acusa a divergência.
--
-- As migrations continuam sendo a FONTE DE VERDADE: o texto abaixo é o mesmo
-- DDL idempotente (IF NOT EXISTS / DO $$ ... EXCEPTION duplicate_object).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0051_crm_3_0_evolucao.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 0051 — CRM 3.0 EVOLUÇÃO: funil configurável, histórico de estágio,
--        origem/campanha controlada, lembretes de atividade e lead scoring
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A 0049 entregou o CRM mínimo (leads, oportunidades, atividades, motivos de
-- perda) com estágios FIXOS no CHECK do banco e a auditoria genérica como único
-- rastro de mudança. Quatro lacunas ficaram abertas:
--
--   1) FUNIL NÃO CONFIGURÁVEL — as etapas eram uma lista fechada em código.
--      Nenhuma empresa podia renomear, reordenar, desativar ou usar
--      probabilidade própria por etapa.
--   2) SEM HISTÓRICO DE ESTÁGIO — dava para saber que a oportunidade mudou de
--      etapa (auditoria genérica), mas não consultar "quando passou de proposta
--      para negociação, por quem, com qual observação" como uma trilha do
--      próprio funil.
--   3) ORIGEM ERA TEXTO LIVRE — impossível medir conversão por campanha.
--   4) ATIVIDADE SEM LEMBRETE/STATUS/PRIORIDADE — não havia como responder
--      "o que vence hoje", "o que está atrasado", "o que é urgente".
--   (5) Sem score explicável do lead.
--
-- DECISÕES ARQUITETURAIS (o que é e o que NÃO é)
-- ----------------------------------------------
--   • ADITIVA e IDEMPOTENTE. Nenhuma coluna existente é removida, nenhum dado é
--     reescrito. `crm_leads.origem` (texto) CONTINUA existindo e continua sendo
--     gravada: `origem_id` é a referência controlada, adicionada ao lado.
--   • `crm_oportunidades.etapa` (texto) continua sendo a coluna de leitura do
--     funil corrente, pelo mesmo motivo: o CHECK da 0049 não é ampliado nem
--     afrouxado — apenas as etapas canônicas são semeadas em `crm_etapas`.
--   • Multiempresa REAL: TODA tabela nova carrega `empresa_id` NOT NULL.
--   • Nenhum CASCADE: o histórico referencia a oportunidade com
--     ON DELETE RESTRICT (nada é apagado; registro se cancela).
--   • Vocabulário fechado via CHECK onde existe domínio real (prioridade,
--     status da atividade, canal).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) FUNIS — um por operação comercial, com um padrão por empresa
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_funis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  padrao BOOLEAN NOT NULL DEFAULT false,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_funis_empresa_idx ON crm_funis (empresa_id, ativo);
-- Um único funil padrão por empresa (índice parcial: o banco garante a regra,
-- não só o serviço).
CREATE UNIQUE INDEX IF NOT EXISTS crm_funis_padrao_unico
  ON crm_funis (empresa_id) WHERE padrao;

-- ----------------------------------------------------------------------------
-- 2) ETAPAS — ordem, probabilidade e disponibilidade por funil
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_etapas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  funil_id INTEGER NOT NULL REFERENCES crm_funis(id),
  nome TEXT NOT NULL,
  -- `chave` mantém compatibilidade com `crm_oportunidades.etapa` (texto) e com
  -- o CHECK da 0049; `nome` é o rótulo humano editável.
  chave TEXT NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  probabilidade INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_etapas_funil_chave_unico ON crm_etapas (funil_id, chave);
CREATE INDEX IF NOT EXISTS crm_etapas_empresa_ordem_idx ON crm_etapas (empresa_id, funil_id, ordem);

DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_probabilidade_range
    CHECK (probabilidade >= 0 AND probabilidade <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_ordem_nao_negativa
    CHECK (ordem >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Semente: um funil padrão por empresa cadastrada, com as CINCO etapas
-- canônicas que o CHECK da 0049 já aceita (nenhuma etapa nova é inventada).
INSERT INTO crm_funis (empresa_id, nome, descricao, padrao, ativo)
SELECT e.id, 'Funil comercial', 'Funil padrão criado pela evolução do CRM 3.0.', true, true
  FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM crm_funis f WHERE f.empresa_id = e.id AND f.padrao);

INSERT INTO crm_etapas (empresa_id, funil_id, nome, chave, ordem, probabilidade, ativo)
SELECT f.empresa_id, f.id, v.nome, v.chave, v.ordem, v.probabilidade, true
  FROM crm_funis f
  JOIN (VALUES
    ('Prospecção',   'prospeccao',   1, 10),
    ('Qualificação', 'qualificacao', 2, 25),
    ('Proposta',     'proposta',     3, 50),
    ('Negociação',   'negociacao',   4, 75),
    ('Fechamento',   'fechamento',   5, 90)
  ) AS v(nome, chave, ordem, probabilidade) ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM crm_etapas x WHERE x.funil_id = f.id AND x.chave = v.chave
 );

-- Oportunidades passam a apontar para o funil corrente (o estágio textual
-- continua sendo a verdade de leitura; `funil_id` diz a qual desenho ele
-- pertence quando houver mais de um funil).
ALTER TABLE crm_oportunidades ADD COLUMN IF NOT EXISTS funil_id INTEGER REFERENCES crm_funis(id);
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_funil_idx
  ON crm_oportunidades (empresa_id, funil_id);

-- Backfill conservador: só preenche o funil PADRÃO da empresa onde está nulo.
UPDATE crm_oportunidades o
   SET funil_id = f.id
  FROM crm_funis f
 WHERE o.funil_id IS NULL
   AND f.empresa_id = o.empresa_id
   AND f.padrao;

-- ----------------------------------------------------------------------------
-- 3) HISTÓRICO DE ESTÁGIO — trilha própria do funil
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_oportunidade_estagio_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  oportunidade_id INTEGER NOT NULL REFERENCES crm_oportunidades(id),
  estagio_anterior TEXT,
  estagio_novo TEXT NOT NULL,
  status_anterior TEXT,
  status_novo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_estagio_hist_oportunidade_idx
  ON crm_oportunidade_estagio_historico (empresa_id, oportunidade_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS crm_estagio_hist_data_idx
  ON crm_oportunidade_estagio_historico (empresa_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 4) ORIGEM / CANAL / CAMPANHA — estrutura controlada, dado antigo preservado
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_origens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  canal TEXT,          -- site, marketplace, loja_fisica, indicacao, evento, outbound, outro
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_origens_empresa_nome_unico ON crm_origens (empresa_id, nome);

DO $$ BEGIN
  ALTER TABLE crm_origens ADD CONSTRAINT crm_origens_canal_valido
    CHECK (canal IS NULL OR canal IN ('site', 'marketplace', 'loja_fisica', 'indicacao', 'evento', 'outbound', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS crm_campanhas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  origem_id INTEGER REFERENCES crm_origens(id),
  inicio DATE,
  fim DATE,
  investimento NUMERIC(14,2),
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_campanhas_empresa_nome_unico ON crm_campanhas (empresa_id, nome);
CREATE INDEX IF NOT EXISTS crm_campanhas_empresa_origem_idx ON crm_campanhas (empresa_id, origem_id);

DO $$ BEGIN
  ALTER TABLE crm_campanhas ADD CONSTRAINT crm_campanhas_periodo_valido
    CHECK (inicio IS NULL OR fim IS NULL OR fim >= inicio);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- O texto livre da 0049 permanece (compatibilidade e histórico); as colunas
-- novas são a referência controlada e a atribuição de mídia (UTM).
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS origem_id INTEGER REFERENCES crm_origens(id);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS campanha_id INTEGER REFERENCES crm_campanhas(id);
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS canal TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_content TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS utm_term TEXT;

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_canal_valido
    CHECK (canal IS NULL OR canal IN ('site', 'marketplace', 'loja_fisica', 'indicacao', 'evento', 'outbound', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_leads_empresa_origem_id_idx ON crm_leads (empresa_id, origem_id);
CREATE INDEX IF NOT EXISTS crm_leads_empresa_campanha_idx ON crm_leads (empresa_id, campanha_id);

-- Semente de origens canônicas (as mesmas do vocabulário textual da 0049).
INSERT INTO crm_origens (empresa_id, nome, canal, ativo)
SELECT e.id, v.nome, v.canal, true
  FROM empresas e
  JOIN (VALUES
    ('Indicação', 'indicacao'),
    ('Site', 'site'),
    ('Feira / evento', 'evento'),
    ('Outbound', 'outbound'),
    ('Outro', 'outro')
  ) AS v(nome, canal) ON true
 WHERE NOT EXISTS (SELECT 1 FROM crm_origens o WHERE o.empresa_id = e.id AND o.nome = v.nome);

-- ----------------------------------------------------------------------------
-- 5) LEAD SCORING — explicável, recalculável e auditável
-- ----------------------------------------------------------------------------
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score INTEGER;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_motivo TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_atualizado_em TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_score_range
    CHECK (score IS NULL OR (score >= 0 AND score <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_leads_empresa_score_idx ON crm_leads (empresa_id, score DESC);

-- ----------------------------------------------------------------------------
-- 6) ATIVIDADES — lembrete, prioridade, status e conclusão
-- ----------------------------------------------------------------------------
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS prioridade TEXT NOT NULL DEFAULT 'media';
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente';
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS lembrete_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS concluida_em TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_prioridade_valida
    CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_status_valido
    CHECK (status IN ('pendente', 'concluida', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Conclusão coerente: concluída exige carimbo de conclusão.
DO $$ BEGIN
  ALTER TABLE crm_atividades ADD CONSTRAINT crm_atividades_conclusao_coerente
    CHECK (status <> 'concluida' OR concluida_em IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Agenda do CRM (hoje / atrasadas / próximas) filtra por status + lembrete.
CREATE INDEX IF NOT EXISTS crm_atividades_empresa_status_lembrete_idx
  ON crm_atividades (empresa_id, status, lembrete_em);
CREATE INDEX IF NOT EXISTS crm_atividades_empresa_responsavel_status_idx
  ON crm_atividades (empresa_id, responsavel_id, status);


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0052_estoque_transferencia_reserva.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 0052 — ESTOQUE: TRANSFERÊNCIA FORMAL, RESERVA E DISPONIBILIDADE
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O ERP já movimentava estoque entre locais, mas só por um ÚNICO lançamento
-- (`movimentacoes.tipo = 'transferencia'`): não havia documento, não havia
-- aprovação, não havia "em trânsito" e não havia como saber o que está
-- RESERVADO (venda em separação, OP programada, bloqueio de qualidade).
--
-- Esta migração adiciona três coisas — e NENHUMA delas altera o saldo por
-- conta própria:
--
--   1) TRANSFERÊNCIA FORMAL (documento + itens + eventos)
--      Estados: SOLICITADA → APROVADA → EM_TRANSITO → RECEBIDA
--               (ou CANCELADA, antes da expedição)
--      O saldo só muda em DOIS eventos, pelos lançamentos oficiais:
--        • expedir  → movimentação de SAÍDA no local de origem;
--        • receber  → movimentação de ENTRADA no local de destino.
--      "Em trânsito" é o estado do documento, não um saldo paralelo.
--
--   2) RESERVA / EMPENHO / BLOQUEIO (`estoque_reservas`)
--      Quantidade comprometida por um documento (venda, OP, qualidade),
--      com tipo explícito. Liberar a reserva NÃO movimenta estoque — só
--      devolve a quantidade ao disponível.
--
--   3) DISPONIBILIDADE derivada (sem tabela nova)
--      disponível = físico − reservado − bloqueado − empenhado
--      Calculada por consulta (server/src/estoqueDisponibilidade.ts). Nenhum
--      saldo é duplicado: `estoques.quantidade` continua sendo o FÍSICO.
--
-- REGRAS QUE NÃO MUDAM
--   • multiempresa: toda tabela tem `empresa_id` NOT NULL;
--   • nada é apagado (CANCELADA é estado, não DELETE);
--   • vocabulário fechado por CHECK (defesa em profundidade no banco);
--   • o saldo continua sendo movimentado APENAS por `movimentacoes`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) DOCUMENTO DE TRANSFERÊNCIA
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  origem_local_id INTEGER NOT NULL REFERENCES locais(id),
  destino_local_id INTEGER NOT NULL REFERENCES locais(id),
  status TEXT NOT NULL DEFAULT 'solicitada',
  solicitante_id INTEGER REFERENCES usuarios(id),
  aprovador_id INTEGER REFERENCES usuarios(id),
  solicitada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  aprovada_em TIMESTAMPTZ,
  expedida_em TIMESTAMPTZ,
  recebida_em TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_status_idx
  ON estoque_transferencias (empresa_id, status);
CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_origem_idx
  ON estoque_transferencias (empresa_id, origem_local_id);
CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_destino_idx
  ON estoque_transferencias (empresa_id, destino_local_id);

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_status_valido
    CHECK (status IN ('solicitada', 'aprovada', 'em_transito', 'recebida', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_locais_diferentes
    CHECK (origem_local_id <> destino_local_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_cancelamento_coerente
    CHECK (status <> 'cancelada' OR (cancelada_em IS NOT NULL AND motivo_cancelamento IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2) ITENS DO DOCUMENTO
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencia_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  transferencia_id INTEGER NOT NULL REFERENCES estoque_transferencias(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  quantidade_recebida INTEGER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estoque_transf_itens_transferencia_idx
  ON estoque_transferencia_itens (empresa_id, transferencia_id);
CREATE INDEX IF NOT EXISTS estoque_transf_itens_produto_idx
  ON estoque_transferencia_itens (empresa_id, produto_id, tamanho_id);

DO $$ BEGIN
  ALTER TABLE estoque_transferencia_itens ADD CONSTRAINT estoque_transf_itens_quantidade_positiva
    CHECK (quantidade > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencia_itens ADD CONSTRAINT estoque_transf_itens_recebida_valida
    CHECK (quantidade_recebida IS NULL OR (quantidade_recebida >= 0 AND quantidade_recebida <= quantidade));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 3) EVENTOS DO DOCUMENTO (trilha própria da transferência)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencia_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  transferencia_id INTEGER NOT NULL REFERENCES estoque_transferencias(id),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estoque_transf_eventos_transferencia_idx
  ON estoque_transferencia_eventos (empresa_id, transferencia_id, criado_em);

-- ----------------------------------------------------------------------------
-- 4) RESERVAS / EMPENHOS / BLOQUEIOS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_reservas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local_id INTEGER REFERENCES locais(id),
  tipo TEXT NOT NULL DEFAULT 'reserva',
  quantidade INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa',
  -- Documento de origem da reserva (venda, OP, transferência, qualidade...).
  -- `origem_recurso` é o nome do RECURSO (não da tabela) para reusar o
  -- diagnóstico de dependências e o vocabulário do ERP.
  origem_recurso TEXT,
  origem_id INTEGER,
  motivo TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  expira_em DATE,
  liberada_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS estoque_reservas_saldo_idx
  ON estoque_reservas (empresa_id, produto_id, tamanho_id, local_id, status);
CREATE INDEX IF NOT EXISTS estoque_reservas_origem_idx
  ON estoque_reservas (empresa_id, origem_recurso, origem_id);

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_tipo_valido
    CHECK (tipo IN ('reserva', 'empenho', 'bloqueio'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_status_valido
    CHECK (status IN ('ativa', 'liberada', 'consumida', 'expirada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_quantidade_positiva
    CHECK (quantidade > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Liberação coerente: liberada/expirada exigem carimbo.
DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_liberacao_coerente
    CHECK (status NOT IN ('liberada', 'expirada') OR liberada_em IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0053_compras_fornecedor_homologacao.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 0053 — COMPRAS: HOMOLOGAÇÃO DE FORNECEDOR, DOCUMENTOS E HISTÓRICO
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O cadastro de fornecedores já existia (razão social, documento, contato,
-- endereço, prazo e condição de pagamento). O que NÃO existia era o processo
-- de HOMOLOGAÇÃO: saber se o fornecedor está apto a receber pedido, com que
-- abrangência, com quais documentos e até quando. Sem isso, qualquer cadastro
-- podia comprar — inclusive um fornecedor suspenso por qualidade.
--
-- O que entra aqui:
--   1) ESTADO DE HOMOLOGAÇÃO no próprio fornecedor (uma coluna, não um
--      cadastro paralelo): PENDENTE → EM_ANALISE → HOMOLOGADO →
--      SUSPENSO → BLOQUEADO. A transição é registrada na trilha (item 3).
--   2) DOCUMENTOS do fornecedor (validade, número, arquivo/referência), cada
--      um com situação própria. "Vencido" é DERIVADO da validade — não é
--      coluna, para não existir status que envelhece sozinho no banco.
--   3) TRILHA DE HOMOLOGAÇÃO (append-only): quem mudou, de qual estado para
--      qual, quando e por quê.
--
-- REGRAS QUE NÃO MUDAM
--   • `fornecedores` continua sendo UMA tabela, por empresa (empresa_id),
--     e continua sendo o único cadastro de fornecedor do ERP;
--   • nada é apagado: SUSPENSO/BLOQUEADO são estados, não DELETE;
--   • nenhum pedido de compra é criado automaticamente por esta migração;
--   • o desempenho do fornecedor (prazo, atendimento, preço) é CALCULADO a
--     partir de compras/itens/recebimentos já existentes — nenhum número é
--     copiado nem duplicado em coluna.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) ESTADO DE HOMOLOGAÇÃO
-- ----------------------------------------------------------------------------
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_status TEXT NOT NULL DEFAULT 'pendente';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_categoria TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_responsavel_id INTEGER REFERENCES usuarios(id);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologado_em TIMESTAMPTZ;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_atualizada_em TIMESTAMPTZ;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS validade_documentos DATE;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS avaliacao_manual NUMERIC(3,1);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_motivo TEXT;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_status_valido
    CHECK (homologacao_status IN ('pendente', 'em_analise', 'homologado', 'suspenso', 'bloqueado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_categoria_valida
    CHECK (homologacao_categoria IS NULL OR homologacao_categoria IN
      ('materia_prima', 'embalagem', 'acabamento', 'servico', 'logistica', 'quimico', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_avaliacao_manual_valida
    CHECK (avaliacao_manual IS NULL OR (avaliacao_manual >= 0 AND avaliacao_manual <= 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Homologado exige carimbo de data; suspenso/bloqueado exigem motivo (a
-- decisão precisa ser explicável — mesma lógica de "motivo da perda" no CRM).
DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_coerente
    CHECK (
      (homologacao_status <> 'homologado' OR homologado_em IS NOT NULL)
      AND (homologacao_status NOT IN ('suspenso', 'bloqueado') OR (homologacao_motivo IS NOT NULL AND btrim(homologacao_motivo) <> ''))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS fornecedores_homologacao_idx
  ON fornecedores (empresa_id, homologacao_status);

-- ----------------------------------------------------------------------------
-- 2) DOCUMENTOS DO FORNECEDOR
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fornecedor_documentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  numero TEXT,
  emissao DATE,
  validade DATE,
  arquivo_ref TEXT,
  observacoes TEXT,
  situacao TEXT NOT NULL DEFAULT 'pendente',
  validado_por INTEGER REFERENCES usuarios(id),
  validado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fornecedor_documentos_fornecedor_idx
  ON fornecedor_documentos (empresa_id, fornecedor_id, tipo);
CREATE INDEX IF NOT EXISTS fornecedor_documentos_validade_idx
  ON fornecedor_documentos (empresa_id, validade);

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_tipo_valido
    CHECK (tipo IN ('contrato_social', 'cartao_cnpj', 'certidao_federal', 'certidao_estadual',
                    'certidao_municipal', 'certidao_fgts', 'certidao_trabalhista', 'alvara', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_situacao_valida
    CHECK (situacao IN ('pendente', 'aprovado', 'reprovado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_validade_coerente
    CHECK (validade IS NULL OR emissao IS NULL OR validade >= emissao);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 3) TRILHA DE HOMOLOGAÇÃO (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fornecedor_homologacao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fornecedor_homologacao_eventos_idx
  ON fornecedor_homologacao_eventos (empresa_id, fornecedor_id, criado_em);

-- ----------------------------------------------------------------------------
-- 4) BACKFILL CONSERVADOR
--    Fornecedor que JÁ tem pedido de compra comprovadamente aprovado/recebido
--    não pode nascer "pendente" e travar a operação: ele é marcado como já
--    homologado (com data do primeiro pedido). Quem nunca comprou continua
--    pendente — o estado inicial honesto.
--    Nenhum fornecedor é suspenso/bloqueado por backfill: bloqueio é decisão
--    humana, nunca inferência de migração.
-- ----------------------------------------------------------------------------
UPDATE fornecedores f
   SET homologacao_status = 'homologado',
       homologado_em = COALESCE(f.homologado_em, sub.primeiro),
       homologacao_atualizada_em = now()
  FROM (
    SELECT fornecedor_id, MIN(data)::timestamptz AS primeiro
      FROM compras
     WHERE fornecedor_id IS NOT NULL
       AND status IN ('aprovado', 'parcial', 'recebido')
     GROUP BY fornecedor_id
  ) sub
 WHERE f.id = sub.fornecedor_id
   AND f.homologacao_status = 'pendente'
   AND f.homologado_em IS NULL;

-- A trilha registra o backfill (sem usuário: foi o sistema).
INSERT INTO fornecedor_homologacao_eventos (empresa_id, fornecedor_id, status_anterior, status_novo, motivo)
SELECT f.empresa_id, f.id, 'pendente', 'homologado',
       'Homologação registrada na implantação: fornecedor já possui pedido de compra aprovado/recebido.'
  FROM fornecedores f
 WHERE f.homologacao_status = 'homologado'
   AND NOT EXISTS (SELECT 1 FROM fornecedor_homologacao_eventos e WHERE e.fornecedor_id = f.id);


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0054_producao_recurso_capacidade.sql
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 0054 — PRODUÇÃO: RECURSO PRODUTIVO, CAPACIDADE E CARGA (MRP 3.0)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A produção já sabia O QUE fabricar (OP, ficha técnica, apontamento, MRP de
-- insumos a partir das OPs em aberto). Não sabia ONDE fabricar nem QUANTO cabe:
-- não havia recurso produtivo (costura, corte, estamparia, bordado, facção),
-- nem capacidade diária, nem forma de responder "qual é o gargalo da semana?".
--
-- O que entra aqui:
--   1) `producao_recursos` — o recurso produtivo POR EMPRESA: nome, tipo,
--      capacidade diária (peças/dia), eficiência e ativo. É um CADASTRO, não um
--      indicador: capacidade é dado de engenharia, informado por quem produz.
--   2) `ordens_fabricacao.recurso_id` — a ligação OP → recurso. NULA de
--      propósito: OP sem recurso continua válida (o gargalo é DERIVADO, e uma
--      OP sem alocação aparece como "sem recurso", nunca como zero).
--
-- REGRAS QUE NÃO MUDAM
--   • a carga NÃO é coluna: é Σ do que falta produzir nas OPs do recurso no
--     período (server/src/producaoCapacidade.ts). Nenhum número é duplicado;
--   • MRP é SUGESTÃO DE LEITURA — esta migração e o endpoint não criam pedido
--     de compra. Gerar compra continua exigindo ação explícita do usuário;
--   • nada é apagado: recurso sai de uso por `ativo = false`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS producao_recursos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'costura',
  capacidade_diaria INTEGER NOT NULL DEFAULT 0,
  eficiencia_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  dias_uteis_semana INTEGER NOT NULL DEFAULT 5,
  local_id INTEGER REFERENCES locais(id),
  responsavel_id INTEGER REFERENCES usuarios(id),
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS producao_recursos_empresa_idx
  ON producao_recursos (empresa_id, ativo, nome);

DO $$ BEGIN
  ALTER TABLE producao_recursos ADD CONSTRAINT producao_recursos_tipo_valido
    CHECK (tipo IN ('corte', 'costura', 'estamparia', 'bordado', 'acabamento', 'embalagem', 'faccao', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE producao_recursos ADD CONSTRAINT producao_recursos_capacidade_valida
    CHECK (capacidade_diaria >= 0 AND eficiencia_pct >= 0 AND eficiencia_pct <= 200
           AND dias_uteis_semana BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- OP → RECURSO (a alocação é decisão do planejador; sem recurso é válido)
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS recurso_id INTEGER REFERENCES producao_recursos(id);

CREATE INDEX IF NOT EXISTS ordens_fabricacao_recurso_idx
  ON ordens_fabricacao (empresa_id, recurso_id, previsao);


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0055_fiscal_obrigacoes.sql
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0056_financeiro_estrutura_contabil.sql
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- ESPELHO DE db/migrations/0057_crm_etapa_configuravel.sql
--
-- CRM: etapa da oportunidade realmente configurável por empresa.
-- `etapa_id` é a referência operacional (FK composta por empresa); `etapa`
-- (texto) continua como chave de leitura/compatibilidade/histórico.
-- ----------------------------------------------------------------------------

ALTER TABLE crm_oportunidades ADD COLUMN IF NOT EXISTS etapa_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_etapas_empresa_id
  ON crm_etapas (empresa_id, id);

DO $$ BEGIN
  ALTER TABLE crm_oportunidades
    ADD CONSTRAINT fk_e42_crm_oportunidades_empresa_etapa
    FOREIGN KEY (empresa_id, etapa_id) REFERENCES crm_etapas (empresa_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_id_idx
  ON crm_oportunidades (empresa_id, etapa_id);

DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_chave_formato
    CHECK (chave ~ '^[a-z][a-z0-9_]{0,39}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE crm_oportunidades DROP CONSTRAINT IF EXISTS crm_oportunidades_etapa_valido;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_etapa_nao_vazia
    CHECK (etapa IS NOT NULL AND btrim(etapa) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE crm_oportunidades o
   SET etapa_id = e.id
  FROM crm_etapas e
 WHERE o.etapa_id IS NULL
   AND e.empresa_id = o.empresa_id
   AND e.chave = o.etapa
   AND (o.funil_id IS NULL OR e.funil_id = o.funil_id);

UPDATE crm_oportunidades o
   SET etapa_id = e.id,
       funil_id = COALESCE(o.funil_id, e.funil_id)
  FROM crm_etapas e
  JOIN crm_funis f ON f.id = e.funil_id AND f.empresa_id = e.empresa_id
 WHERE o.etapa_id IS NULL
   AND e.empresa_id = o.empresa_id
   AND f.padrao
   AND e.chave = o.etapa;

-- ----------------------------------------------------------------------------
-- CRM 3.0 — FECHAMENTO DO HARDENING P2/P3 (espelho da migration 0058)
--
-- O schema base precisa conhecer estas colunas: o recurso declara o campo e a
-- API grava nele. A regra de dados (normalização de `chave`, renumeração de
-- `ordem`, VALIDATE da constraint) continua exclusiva da cadeia versionada —
-- aqui entra apenas a ESTRUTURA, idempotente como o resto deste arquivo.
-- ----------------------------------------------------------------------------
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS funil_id INTEGER;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS estagio_anterior_id INTEGER;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS estagio_novo_id INTEGER;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS estagio_anterior_nome TEXT;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS estagio_novo_nome TEXT;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS usuario_nome TEXT;
ALTER TABLE crm_oportunidade_estagio_historico ADD COLUMN IF NOT EXISTS snapshot_versao SMALLINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_funis_empresa_id
  ON crm_funis (empresa_id, id);

CREATE INDEX IF NOT EXISTS crm_estagio_hist_etapa_nova_idx
  ON crm_oportunidade_estagio_historico (empresa_id, estagio_novo_id);

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_classificacao TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_fatores JSONB;

ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS lembrete_enviado_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

CREATE INDEX IF NOT EXISTS crm_atividades_lembrete_pendente_idx
  ON crm_atividades (empresa_id, lembrete_em)
  WHERE status = 'pendente' AND lembrete_enviado_em IS NULL;

-- ============================================================================
-- FINANCEIRO 3.0 — IMPORTAÇÃO CONTÁBIL (espelho da migration 0059)
-- Cabeçalho do lote + agrupamento das partidas no livro único.
-- ============================================================================
CREATE TABLE IF NOT EXISTS fin_importacoes_contabeis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
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
CREATE UNIQUE INDEX IF NOT EXISTS fin_importacoes_contabeis_hash_unico ON fin_importacoes_contabeis (empresa_id, hash);
CREATE INDEX IF NOT EXISTS fin_importacoes_contabeis_empresa_idx ON fin_importacoes_contabeis (empresa_id, competencia DESC, criado_em DESC);
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS partida_id INTEGER;
CREATE INDEX IF NOT EXISTS lancamentos_financeiros_partida_idx ON lancamentos_financeiros (empresa_id, documento_origem_recurso, documento_origem_id, partida_id);

-- ============================================================================
-- ESTOQUE 3.0 — UNIDADES DE MEDIDA E CONVERSÃO DECLARADA (espelho da 0060)
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_unidades_medida_empresa_codigo ON unidades_medida (empresa_id, codigo);

CREATE TABLE IF NOT EXISTS unidade_conversoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  de_codigo TEXT NOT NULL,
  para_codigo TEXT NOT NULL,
  fator NUMERIC(16,6) NOT NULL,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_unidade_conversoes_empresa_par ON unidade_conversoes (empresa_id, de_codigo, para_codigo);
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS unidade_compra TEXT;

-- ============================================================================
-- P2-10 — CONTRATO TIPO × COLUNA (espelho da migration 0061)
-- Nome de funil é único por empresa (case-insensitive), como o recurso declara.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_funis_empresa_nome
  ON crm_funis (empresa_id, nome);

-- ============================================================================
-- P2-15 — CALENDÁRIO PRODUTIVO: FERIADOS POR EMPRESA (espelho da 0062)
-- ============================================================================
CREATE TABLE IF NOT EXISTS feriados (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  data DATE NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'nacional',
  uf TEXT,
  recorrente BOOLEAN NOT NULL DEFAULT FALSE,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_feriados_empresa_data ON feriados (empresa_id, data);
CREATE INDEX IF NOT EXISTS feriados_empresa_recorrente_idx ON feriados (empresa_id, ativo, recorrente);

-- Snapshot mirror of migration 0063 (SPED/EFD run history and evidence).
-- Keep the versioned migration as the upgrade path for existing databases.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_obrigacoes_empresa_id
  ON fiscal_obrigacoes (empresa_id, id);

CREATE TABLE IF NOT EXISTS fiscal_execucoes (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  obrigacao_id INTEGER NOT NULL,
  periodo TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  executed_by INTEGER REFERENCES usuarios(id),
  versao TEXT NOT NULL,
  execution_hash CHAR(64) NOT NULL,
  resultado TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_execucoes_obrigacao_empresa_fk FOREIGN KEY (empresa_id, obrigacao_id) REFERENCES fiscal_obrigacoes(empresa_id, id),
  CONSTRAINT fiscal_execucoes_periodo_formato CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT fiscal_execucoes_status_valido CHECK (status IN ('PENDENTE','EM_PROCESSAMENTO','VALIDADO','ERRO','ENTREGUE','NAO_SUPORTADO')),
  CONSTRAINT fiscal_execucoes_versao_nao_vazia CHECK (btrim(versao) <> ''),
  CONSTRAINT fiscal_execucoes_hash_formato CHECK (execution_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fiscal_execucoes_chave_idempotente UNIQUE (empresa_id, obrigacao_id, periodo, versao)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_execucoes_empresa_id ON fiscal_execucoes (empresa_id, id);
CREATE INDEX IF NOT EXISTS fiscal_execucoes_empresa_periodo_idx ON fiscal_execucoes (empresa_id, obrigacao_id, periodo, criado_em DESC);

CREATE TABLE IF NOT EXISTS fiscal_execucao_evidencias (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  execucao_id BIGINT NOT NULL,
  arquivo_ref TEXT NOT NULL,
  hash_sha256 CHAR(64) NOT NULL,
  tamanho_bytes BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id INTEGER REFERENCES usuarios(id),
  resultado TEXT NOT NULL,
  CONSTRAINT fiscal_execucao_evidencias_execucao_empresa_fk FOREIGN KEY (empresa_id, execucao_id) REFERENCES fiscal_execucoes(empresa_id, id),
  CONSTRAINT fiscal_execucao_evidencias_hash_formato CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT fiscal_execucao_evidencias_tamanho_positivo CHECK (tamanho_bytes > 0),
  CONSTRAINT fiscal_execucao_evidencias_resultado_valido CHECK (btrim(resultado) <> '')
);
CREATE INDEX IF NOT EXISTS fiscal_execucao_evidencias_execucao_idx ON fiscal_execucao_evidencias (empresa_id, execucao_id, timestamp);

-- Snapshot mirror of migration 0064 (ABC/cyclic counting metadata on canonical inventory).
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS inventario_id INTEGER REFERENCES inventarios(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_movimentacoes_inventario_celula ON movimentacoes (empresa_id, inventario_id, produto_id, COALESCE(tamanho_id, 0)) WHERE inventario_id IS NOT NULL;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS modalidade TEXT NOT NULL DEFAULT 'inventario';
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS contagem_status TEXT;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS classificacao_abc TEXT;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS prioridade INTEGER;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS data_planejada DATE;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS responsavel_id INTEGER REFERENCES usuarios(id);
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_periodo_inicio DATE;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_periodo_fim DATE;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_criterio TEXT;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_faixas JSONB;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_calculado_em TIMESTAMPTZ;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS abc_resultado JSONB;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS conferido_por INTEGER REFERENCES usuarios(id);
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS conferido_em TIMESTAMPTZ;
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS aprovado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE inventarios ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMPTZ;
DO $$ BEGIN ALTER TABLE inventarios ADD CONSTRAINT inventarios_modalidade_valida CHECK (modalidade IN ('inventario','ciclica_abc')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE inventarios ADD CONSTRAINT inventarios_contagem_ciclica_status_valido CHECK (contagem_status IS NULL OR contagem_status IN ('PLANEJADA','EM_CONTAGEM','CONFERIDA','APROVADA','CANCELADA')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE inventarios ADD CONSTRAINT inventarios_abc_class_valida CHECK (classificacao_abc IS NULL OR classificacao_abc IN ('A','B','C')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventarios_empresa_idempotency ON inventarios (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventarios_ciclica_empresa_status_data ON inventarios (empresa_id, modalidade, contagem_status, data_planejada);
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS unidade TEXT NOT NULL DEFAULT 'un';
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS contado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS contado_em TIMESTAMPTZ;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS motivo_divergencia TEXT;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS classificacao_abc TEXT;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS prioridade INTEGER;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS movimentacao_id INTEGER REFERENCES movimentacoes(id);
DO $$ BEGIN ALTER TABLE itens_inventario ADD CONSTRAINT itens_inventario_abc_class_valida CHECK (classificacao_abc IS NULL OR classificacao_abc IN ('A','B','C')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS itens_inventario_abc_classe_idx ON itens_inventario (empresa_id, classificacao_abc, prioridade);
COMMENT ON COLUMN movimentacoes.inventario_id IS 'Vínculo canônico do ajuste ao inventário que o originou; unicidade por célula torna fechamento repetível sem novo movimento.';
COMMENT ON COLUMN inventarios.abc_criterio IS 'Critério reproduzível implementado: soma das quantidades de movimentações do tipo saída, no período e local informados, agrupadas por produto.';
COMMENT ON COLUMN inventarios.abc_faixas IS 'Faixas cumulativas registradas na data do cálculo; os valores efetivamente usados são armazenados pelo serviço junto ao resultado.';
COMMENT ON COLUMN itens_inventario.saldo_sistema IS 'Snapshot original imutável da abertura; quantidade contada fica em contado.';
-- 0065 — custódia e faccionamento rastreável usando o estoque canônico.
-- Eventos são trilha operacional, não saldo nem mecanismo de consumo paralelo.
CREATE TABLE IF NOT EXISTS terceiros_operacionais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  documento TEXT,
  contato TEXT,
  telefone TEXT,
  email TEXT,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS terceiros_operacionais_empresa_idx ON terceiros_operacionais (empresa_id, ativo, nome);
CREATE UNIQUE INDEX IF NOT EXISTS terceiros_operacionais_documento_empresa_uq
  ON terceiros_operacionais (empresa_id, documento) WHERE documento IS NOT NULL AND documento <> '';

ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS terceiro_id INTEGER REFERENCES terceiros_operacionais(id);
CREATE INDEX IF NOT EXISTS ordens_fabricacao_terceiro_idx ON ordens_fabricacao (empresa_id, terceiro_id);

CREATE TABLE IF NOT EXISTS terceirizacao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id),
  terceiro_id INTEGER NOT NULL REFERENCES terceiros_operacionais(id),
  evento TEXT NOT NULL CHECK (evento IN ('ENVIO_INSUMO','RETORNO_INSUMO','RETORNO_PRODUTO','PERDA_PRODUTO','CUSTODIA')),
  tipo_material TEXT NOT NULL CHECK (tipo_material IN ('insumo','produto')),
  insumo_id INTEGER REFERENCES insumos(id),
  produto_id INTEGER REFERENCES produtos(id),
  proprietario_tipo TEXT NOT NULL CHECK (proprietario_tipo IN ('empresa','terceiro')),
  proprietario_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  custodiante_anterior_tipo TEXT NOT NULL CHECK (custodiante_anterior_tipo IN ('empresa','terceiro')),
  custodiante_anterior_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  custodiante_novo_tipo TEXT NOT NULL CHECK (custodiante_novo_tipo IN ('empresa','terceiro')),
  custodiante_novo_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  quantidade NUMERIC(14,3) NOT NULL CHECK (quantidade > 0),
  unidade TEXT NOT NULL,
  referencia_evento_id INTEGER REFERENCES terceirizacao_eventos(id),
  movimentacao_insumo_id INTEGER REFERENCES movimentacoes_insumos(id),
  apontamento_id INTEGER REFERENCES ordens_apontamentos(id),
  idempotency_key TEXT NOT NULL,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT terceirizacao_eventos_material_coerente CHECK (
    (tipo_material = 'insumo' AND insumo_id IS NOT NULL AND produto_id IS NULL) OR
    (tipo_material = 'produto' AND produto_id IS NOT NULL AND insumo_id IS NULL)
  ),
  CONSTRAINT terceirizacao_eventos_proprietario_coerente CHECK (
    (proprietario_tipo = 'empresa' AND proprietario_terceiro_id IS NULL) OR
    (proprietario_tipo = 'terceiro' AND proprietario_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_custodiante_anterior_coerente CHECK (
    (custodiante_anterior_tipo = 'empresa' AND custodiante_anterior_terceiro_id IS NULL) OR
    (custodiante_anterior_tipo = 'terceiro' AND custodiante_anterior_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_custodiante_novo_coerente CHECK (
    (custodiante_novo_tipo = 'empresa' AND custodiante_novo_terceiro_id IS NULL) OR
    (custodiante_novo_tipo = 'terceiro' AND custodiante_novo_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_idem_uq UNIQUE (empresa_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_ordem_idx ON terceirizacao_eventos (empresa_id, ordem_id, id);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_terceiro_idx ON terceirizacao_eventos (empresa_id, terceiro_id, criado_em);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_referencia_idx ON terceirizacao_eventos (empresa_id, referencia_evento_id);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_apontamento_idx ON terceirizacao_eventos (empresa_id, apontamento_id);
COMMENT ON TABLE terceirizacao_eventos IS 'Trilha imutável de custódia e faccionamento. Não é saldo; consumo de insumos é movimentacoes_insumos e entrada do acabado segue o fluxo de apontamento/conclusão da OP.';
COMMENT ON COLUMN ordens_fabricacao.terceiro_id IS 'Terceiro operacional responsável por facção/terceirização; a custódia detalhada fica em terceirizacao_eventos.';
-- 0066 — snapshot histórico da conversão usada em cada item de cotação.
-- Quantidade cotada fica na unidade de compra; origem/fator/caminho ficam congelados.
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS quantidade_original NUMERIC(14,3);
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_original TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_origem TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_fator NUMERIC(18,9);
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_status TEXT;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_snapshot JSONB;
ALTER TABLE cotacao_compra_itens ADD COLUMN IF NOT EXISTS unidade_conversao_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE cotacao_compra_itens ADD CONSTRAINT cotacao_compra_conversao_status_valido
    CHECK (unidade_conversao_status IS NULL OR unidade_conversao_status IN ('IDENTICA','CONVERTIDA','NAO_CONVERTIDA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN cotacao_compra_itens.unidade_conversao_snapshot IS 'Regra(s) declarada(s) e caminho exatos usados no instante de inclusão; não recalcular itens históricos quando o cadastro mudar.';
COMMENT ON COLUMN cotacao_compra_itens.quantidade IS 'Quantidade convertida e cotada na unidade de compra registrada em unidade.';

ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS quantidade_original NUMERIC(14,3);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_original TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_origem TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_fator NUMERIC(18,9);
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_status TEXT;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_snapshot JSONB;
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS unidade_conversao_em TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_conversao_status_valido
    CHECK (unidade_conversao_status IS NULL OR unidade_conversao_status IN ('IDENTICA','CONVERTIDA','NAO_CONVERTIDA'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN itens_compra.unidade_conversao_snapshot IS 'Cópia do snapshot de conversão herdado do item de cotação; não recalcular compras históricas.';

-- 0067 — status explícito para executor fiscal sem manifesto oficial.
COMMENT ON COLUMN fiscal_execucoes.status IS 'Estado explícito; NAO_SUPORTADO indica ausência de manifesto/leiaute oficial e que nenhum arquivo/validação foi produzido.';
-- Snapshot mirror of migration 0068 (BROBOND COMMERCE OS: catálogo multicanal,
-- publicação por canal, preço por canal, pedidos omnichannel, checkout B2C,
-- promoções/cupons, frete, outbox e rastreio). Keep the versioned migration
-- as the upgrade path for existing databases.

-- =======================================================================

-- ----------------------------------------------------------------------------
-- Configuração da loja própria (1 linha por empresa): frete (FreightProvider),
-- dono do checkout (sales.usuario_id NOT NULL) e expiração do carrinho.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_configuracoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL UNIQUE REFERENCES empresas(id),
  loja_nome TEXT,
  loja_descricao TEXT,
  frete_provedor TEXT NOT NULL DEFAULT 'nenhum',
  CONSTRAINT commerce_frete_provedor_ck CHECK (frete_provedor IN ('nenhum', 'retirada', 'manual')),
  frete_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (frete_valor >= 0),
  frete_gratis_acima NUMERIC(12,2) CHECK (frete_gratis_acima IS NULL OR frete_gratis_acima >= 0),
  frete_prazo_dias INTEGER CHECK (frete_prazo_dias IS NULL OR frete_prazo_dias >= 0),
  checkout_usuario_id INTEGER REFERENCES usuarios(id),
  checkout_expira_minutos INTEGER NOT NULL DEFAULT 60 CHECK (checkout_expira_minutos >= 5 AND checkout_expira_minutos <= 1440),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commerce_configuracoes_empresa ON commerce_configuracoes (empresa_id);

-- ----------------------------------------------------------------------------
-- Projeção de catálogo da vitrine própria. O conteúdo longo continua em
-- `produtos` (descricao/destaque são do cadastro canônico) — aqui só mora o
-- que é da VITRINE: slug público, resumo curto e ordenação.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_produtos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  slug TEXT NOT NULL,
  resumo TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  -- Metadados por canal da VITRINE (ex.: ml_category_id exigido pelo Mercado
  -- Livre na criação do anúncio). JSONB: o servidor nunca inventa esses IDs.
  canal_metadados JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_produtos_produto UNIQUE (empresa_id, produto_id),
  CONSTRAINT uq_commerce_produtos_slug UNIQUE (empresa_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_commerce_produtos_empresa ON commerce_produtos (empresa_id, ordem);

-- ----------------------------------------------------------------------------
-- Preço por canal (sobre a base `produtos.preco_venda`). Vigência opcional;
-- sem linha vigente, o preço efetivo é o de tabela do produto.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_precos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_precos_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  preco NUMERIC(12,2) NOT NULL CHECK (preco >= 0),
  preco_promo NUMERIC(12,2) CHECK (preco_promo IS NULL OR preco_promo >= 0),
  vigencia_inicio DATE,
  vigencia_fim DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_precos UNIQUE (empresa_id, produto_id, canal)
);
CREATE INDEX IF NOT EXISTS ix_commerce_precos_empresa ON commerce_precos (empresa_id, canal);

-- ----------------------------------------------------------------------------
-- FILA DE PUBLICAÇÃO multicanal — máquina de estados + idempotência
-- (empresa + produto + canal + versão). PUBLISHED só após confirmação da
-- API externa (ou da própria vitrine, no canal BROBOND). Nunca fake.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_publicacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_publicacoes_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  versao INTEGER NOT NULL CHECK (versao >= 1),
  estado TEXT NOT NULL DEFAULT 'DRAFT',
  CONSTRAINT commerce_publicacoes_estado_ck CHECK (estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'UPDATE_QUEUED', 'ERROR', 'REJECTED', 'UNPUBLISHED')),
  payload JSONB,
  payload_hash TEXT,
  external_id TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro TEXT,
  proxima_tentativa_em TIMESTAMPTZ,
  publicado_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_publicacoes_versao UNIQUE (empresa_id, produto_id, canal, versao)
);
-- UMA linha no pipeline ativo por (empresa, produto, canal): enfileirar de
-- novo com a mesma versão é idempotente; versão nova é história.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_publicacoes_ativa
  ON commerce_publicacoes (empresa_id, produto_id, canal)
  WHERE estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'UPDATE_QUEUED');
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_empresa_estado ON commerce_publicacoes (empresa_id, estado, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_retry ON commerce_publicacoes (proxima_tentativa_em)
  WHERE estado IN ('ERROR', 'READY', 'QUEUED', 'UPDATE_QUEUED');

-- ----------------------------------------------------------------------------
-- PROJEÇÃO DE PEDIDOS OMNICHANNEL (checkout próprio + canais). Não é segunda
-- fonte de verdade: `sales` (analítico) e `vendas` (operacional) continuam
-- mandando; esta tabela guarda o que só o checkout precisa — token público,
-- endereço, vínculo da cobrança e a máquina de estados de pós-venda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_pedidos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_pedidos_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  pedido_externo TEXT NOT NULL,
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  cobranca_id INTEGER REFERENCES gateway_cobrancas(id) ON DELETE SET NULL,
  checkout_token TEXT UNIQUE,
  chave_checkout TEXT,
  estado TEXT NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',
  CONSTRAINT commerce_pedidos_estado_ck CHECK (estado IN ('AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO', 'PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO', 'CANCELADO', 'EXPIRADO', 'ESTORNADO', 'ERRO')),
  pagamento_estado TEXT,
  CONSTRAINT commerce_pedidos_pagamento_ck CHECK (pagamento_estado IS NULL OR pagamento_estado IN ('PENDING', 'AUTHORIZED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'CHARGEBACK', 'EXPIRED')),
  frete_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (frete_valor >= 0),
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
  cupom_codigo TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  comprador JSONB,
  endereco JSONB,
  expira_em TIMESTAMPTZ,
  pago_em TIMESTAMPTZ,
  convertido_em TIMESTAMPTZ,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_pedidos_externo UNIQUE (empresa_id, canal, pedido_externo)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_pedidos_chave ON commerce_pedidos (empresa_id, chave_checkout)
  WHERE chave_checkout IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_empresa_estado ON commerce_pedidos (empresa_id, estado, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_sale ON commerce_pedidos (empresa_id, sale_id);
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_cobranca ON commerce_pedidos (cobranca_id);

-- ----------------------------------------------------------------------------
-- OUTBOX — fila de sincronização/aténtação (at-least-once, chave única por
-- empresa + tipo + chave). Conversão, publicação e pushes de canal passam por
-- aqui quando o processamento imediato falha — nunca somem, nunca duplicam.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_outbox (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_outbox_tipo_ck CHECK (tipo IN ('conversao', 'publicacao', 'sincronizacao', 'alerta')),
  chave TEXT NOT NULL,
  payload JSONB,
  estado TEXT NOT NULL DEFAULT 'PENDENTE',
  CONSTRAINT commerce_outbox_estado_ck CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO')),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro TEXT,
  proxima_tentativa_em TIMESTAMPTZ,
  processado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_outbox_chave UNIQUE (empresa_id, tipo, chave)
);
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_fila ON commerce_outbox (estado, proxima_tentativa_em);

-- ----------------------------------------------------------------------------
-- Promoções e cupons (vitrine própria). Cálculo é função pura do servidor
-- (server/src/commerce/regras.ts) — aqui só vive o cadastro + contadores.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_promocoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_promocoes_tipo_ck CHECK (tipo IN ('percentual', 'valor')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  minimo_pedido NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (minimo_pedido >= 0),
  data_inicio DATE NOT NULL,
  data_fim DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commerce_promocoes_empresa ON commerce_promocoes (empresa_id, ativo);

CREATE TABLE IF NOT EXISTS commerce_cupons (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_cupons_tipo_ck CHECK (tipo IN ('percentual', 'valor')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  minimo_pedido NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (minimo_pedido >= 0),
  uso_maximo INTEGER CHECK (uso_maximo IS NULL OR uso_maximo >= 1),
  uso_atual INTEGER NOT NULL DEFAULT 0 CHECK (uso_atual >= 0),
  validade DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_cupons_codigo UNIQUE (empresa_id, codigo)
);
CREATE INDEX IF NOT EXISTS ix_commerce_cupons_empresa ON commerce_cupons (empresa_id, ativo);

-- ----------------------------------------------------------------------------
-- Rastreio/entrega (projeção da entrega; a expedição canônica continua em
-- `vendas.expedicao_etapa` — vocabulário da migration 0032).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_rastreio (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  transportadora TEXT,
  codigo TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'postado',
  CONSTRAINT commerce_rastreio_status_ck CHECK (status IN ('postado', 'em_transito', 'saiu_entrega', 'entregue', 'devolvido', 'extraviado')),
  estimativa_em DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_rastreio_venda UNIQUE (empresa_id, venda_id)
);
CREATE INDEX IF NOT EXISTS ix_commerce_rastreio_empresa_status ON commerce_rastreio (empresa_id, status);

-- ----------------------------------------------------------------------------
-- Reservas do checkout: idempotência para o motor EXISTENTE de reservas.
-- Uma reserva ativa por (origem de checkout, produto, tamanho, local) —
-- dois checkouts concorrentes do último SKU não criam duas reservas.
-- (`estoque_reservas` já existe; só ganha a trava de idempotência aqui.)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_reservas_checkout
  ON estoque_reservas (origem_recurso, origem_id, produto_id, COALESCE(tamanho_id, 0), COALESCE(local_id, 0))
  WHERE origem_recurso = 'commerce_checkout' AND status = 'ativa';

-- Mirror of migration 0069_payment_engine.sql
-- Incremental payment domain. Reuses gateway_configs, gateway_cobrancas,
-- gateway_webhook_events, audit and Commerce outbox. No second financial ledger.
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS payment_policy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS health_status text;
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
ALTER TABLE gateway_configs ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE gateway_webhook_events ADD COLUMN IF NOT EXISTS payload_hash text;
ALTER TABLE gateway_webhook_events ADD COLUMN IF NOT EXISTS correlation_id text;
CREATE UNIQUE INDEX IF NOT EXISTS gateway_cobrancas_empresa_id_id ON gateway_cobrancas(empresa_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_pedidos_empresa_id_id ON commerce_pedidos(empresa_id,id);
CREATE TABLE IF NOT EXISTS payment_intents (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id),
  order_id bigint NOT NULL, customer_ref text, channel text NOT NULL, currency varchar(3) NOT NULL,
  minor_units smallint NOT NULL DEFAULT 2 CHECK(minor_units BETWEEN 0 AND 4),
  amount bigint NOT NULL CHECK(amount > 0), method text NOT NULL, provider text,
  status text NOT NULL CHECK(status IN ('CREATED','PENDING','PENDING_MANUAL_CONFIRMATION','REQUIRES_ACTION','AUTHORIZED','CAPTURE_PENDING','CAPTURED','PAID','PARTIALLY_REFUNDED','REFUNDED','CANCELED','FAILED','EXPIRED','CHARGEBACK','DISPUTED')),
  idempotency_key text NOT NULL, correlation_id text NOT NULL, active_operation bigint,
  cobranca_id bigint, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,order_id), UNIQUE(empresa_id,idempotency_key),
  FOREIGN KEY(empresa_id,order_id) REFERENCES commerce_pedidos(empresa_id,id),
  FOREIGN KEY(empresa_id,cobranca_id) REFERENCES gateway_cobrancas(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider text NOT NULL, provider_transaction_id text, method text NOT NULL,
  requested_amount bigint NOT NULL CHECK(requested_amount>0), authorized_amount bigint NOT NULL DEFAULT 0,
  captured_amount bigint NOT NULL DEFAULT 0, refunded_amount bigint NOT NULL DEFAULT 0,
  status text NOT NULL, failure_code text, failure_message text,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  idempotency_key text NOT NULL, correlation_id text NOT NULL, safe_reference jsonb NOT NULL DEFAULT '{}', request_cifradas text,
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,provider,idempotency_key), UNIQUE(provider,provider_transaction_id),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id),
  CHECK(refunded_amount>=0 AND captured_amount>=refunded_amount AND authorized_amount>=0)
);
CREATE TABLE IF NOT EXISTS payment_operations (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  operation text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('PROCESSING','SUCCEEDED','FAILED','UNCERTAIN')),
  amount bigint NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,payment_intent_id,operation,idempotency_key),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), code text NOT NULL,
  name text NOT NULL, enabled boolean NOT NULL DEFAULT false, settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,code)
);
CREATE TABLE IF NOT EXISTS payment_routing_rules (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), method text NOT NULL, provider text NOT NULL,
  priority integer NOT NULL CHECK(priority>=0), enabled boolean NOT NULL DEFAULT false,
  conditions jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(empresa_id,method,priority)
);
CREATE TABLE IF NOT EXISTS payment_refunds (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  operation_id bigint NOT NULL, amount bigint NOT NULL CHECK(amount>0), status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,operation_id),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id),
  FOREIGN KEY(empresa_id,operation_id) REFERENCES payment_operations(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_disputes (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider_reference text NOT NULL, status text NOT NULL CHECK(status IN ('DISPUTE_OPENED','UNDER_REVIEW','EVIDENCE_REQUIRED','EVIDENCE_SUBMITTED','WON','LOST','CLOSED')),
  amount bigint NOT NULL CHECK(amount>=0), reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(empresa_id,provider_reference),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE TABLE IF NOT EXISTS payment_settlements (
  id bigserial PRIMARY KEY, empresa_id integer NOT NULL REFERENCES empresas(id), payment_intent_id bigint NOT NULL,
  provider text NOT NULL, provider_reference text NOT NULL, settlement_date date,
  gross_amount bigint NOT NULL CHECK(gross_amount>=0), provider_fee bigint, gateway_fee bigint, installment_fee bigint, antifraud_fee bigint,
  net_amount bigint, refund_amount bigint NOT NULL DEFAULT 0, chargeback_amount bigint NOT NULL DEFAULT 0,
  payout_reference text, status text NOT NULL CHECK(status IN ('UNRECONCILED','MATCHED','PARTIAL','DIVERGENT','RESOLVED')),
  evidence jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,provider,provider_reference),
  FOREIGN KEY(empresa_id,payment_intent_id) REFERENCES payment_intents(empresa_id,id)
);
CREATE INDEX IF NOT EXISTS payment_intents_tenant_status ON payment_intents(empresa_id,status,id DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_tenant_intent ON payment_attempts(empresa_id,payment_intent_id);
CREATE INDEX IF NOT EXISTS payment_operations_recovery ON payment_operations(status,updated_at);


-- Mirror of migration 0070_foundation_integrity.sql
-- Foundation: new audit signatures cover tenant and event time. Historical
-- signatures remain version 1; no historical row is rewritten or re-signed.
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS hash_versao SMALLINT NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE auditoria ADD CONSTRAINT auditoria_hash_versao_ck CHECK (hash_versao IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Monotonically increasing fencing token survives manual retries; it is not a
-- retry counter and therefore never resets when an operator requeues an event.
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS claim_versao INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE commerce_outbox ADD CONSTRAINT commerce_outbox_claim_versao_ck CHECK (claim_versao >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Due work and expired leases can be found without scanning unrelated rows.
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_devida
  ON commerce_outbox (proxima_tentativa_em, id) WHERE estado = 'PENDENTE';
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_lease
  ON commerce_outbox (atualizado_em, id) WHERE estado = 'PROCESSANDO';

-- Mirror of migration 0071_periodos_contabeis.sql
-- Períodos controlam somente a escrituração importada no livro financeiro
-- existente; não são um segundo ledger nem um fechamento fiscal automático.
CREATE TABLE IF NOT EXISTS fin_periodos_contabeis (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  competencia DATE NOT NULL CHECK (EXTRACT(DAY FROM competencia) = 1),
  estado TEXT NOT NULL CHECK (estado IN ('aberto', 'fechado')),
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) BETWEEN 8 AND 500),
  alterado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_periodos_empresa_competencia_uq UNIQUE (empresa_id, competencia)
);
CREATE INDEX IF NOT EXISTS fin_periodos_empresa_estado_idx ON fin_periodos_contabeis (empresa_id, estado, competencia DESC);

-- Mirror of migration 0072_wms_enderecamento.sql
-- WMS: endereçamento no cadastro canônico de locais. Não cria saldo ou movimento.
ALTER TABLE locais ADD COLUMN IF NOT EXISTS nivel_wms TEXT NOT NULL DEFAULT 'local';
ALTER TABLE locais ADD COLUMN IF NOT EXISTS local_pai_id INTEGER;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_nivel_wms_ck CHECK (nivel_wms IN ('local', 'armazem', 'zona', 'endereco'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_pai_wms_ck CHECK (
    (nivel_wms IN ('local', 'armazem') AND local_pai_id IS NULL) OR
    (nivel_wms IN ('zona', 'endereco') AND local_pai_id IS NOT NULL AND local_pai_id <> id)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_pai_empresa_fk
    FOREIGN KEY (empresa_id, local_pai_id) REFERENCES locais (empresa_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS locais_wms_pai_idx ON locais (empresa_id, local_pai_id, nivel_wms);

-- Mirror of migration 0073_payment_payouts.sql
-- Repasses declarados por relatório do provedor. São evidência de liquidação,
-- não lançamentos financeiros ou um segundo livro-caixa.
CREATE UNIQUE INDEX IF NOT EXISTS fin_extrato_empresa_id_uq ON fin_extrato_transacoes (empresa_id, id);
CREATE TABLE IF NOT EXISTS payment_payouts (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  provider TEXT NOT NULL,
  payout_reference TEXT NOT NULL,
  settlement_date DATE NOT NULL,
  currency VARCHAR(3) NOT NULL CHECK (currency = 'BRL'),
  net_amount BIGINT NOT NULL CHECK (net_amount >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('IMPORTED', 'DIVERGENT', 'MATCHED')),
  bank_transaction_id INTEGER,
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, provider, payout_reference),
  FOREIGN KEY (empresa_id, bank_transaction_id) REFERENCES fin_extrato_transacoes (empresa_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_payout_bank_once_uq
  ON payment_payouts (empresa_id, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_payout_status_idx ON payment_payouts (empresa_id, status, settlement_date DESC);
ALTER TABLE payment_settlements ADD COLUMN IF NOT EXISTS payout_id BIGINT;
DO $$ BEGIN
  ALTER TABLE payment_settlements ADD CONSTRAINT payment_settlement_payout_empresa_fk
    FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS payment_settlement_payout_idx ON payment_settlements (empresa_id, payout_id);

-- Mirror of migration 0074_payment_operations.sql
-- Disputas e versões de relatórios são evidências operacionais. Nenhuma dessas
-- tabelas substitui os pagamentos, o extrato bancário ou o livro financeiro.
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS external_dispute_id TEXT;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'ENGINE';
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_origin_ck CHECK (origin IN ('ENGINE', 'MANUAL'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_version_ck CHECK (version >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_external_ck CHECK (
    external_dispute_id IS NULL OR (provider IS NOT NULL AND length(trim(external_dispute_id)) BETWEEN 1 AND 160)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payment_disputes_empresa_id_uq ON payment_disputes (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_disputes_external_uq
  ON payment_disputes (empresa_id, provider, external_dispute_id) WHERE external_dispute_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_disputes_status_idx ON payment_disputes (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS payment_dispute_evidence (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  dispute_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NOTE', 'DOCUMENT_REFERENCE')),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 200),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 4000),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, dispute_id, idempotency_key),
  FOREIGN KEY (empresa_id, dispute_id) REFERENCES payment_disputes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_dispute_evidence_page_idx ON payment_dispute_evidence (empresa_id, dispute_id, id DESC);

CREATE TABLE IF NOT EXISTS payment_dispute_events (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  dispute_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REGISTER', 'TRANSITION')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  external_reference TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, idempotency_key),
  FOREIGN KEY (empresa_id, dispute_id) REFERENCES payment_disputes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_dispute_events_page_idx ON payment_dispute_events (empresa_id, dispute_id, id DESC);

CREATE TABLE IF NOT EXISTS payment_payout_revisions (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  payout_id BIGINT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  report JSONB NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
  previous_hash TEXT CHECK (previous_hash IS NULL OR length(previous_hash) = 64),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT CHECK (request_hash IS NULL OR length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, payout_id, revision),
  UNIQUE (empresa_id, payout_id, content_hash),
  FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_payout_revisions_page_idx ON payment_payout_revisions (empresa_id, payout_id, revision DESC);

CREATE UNIQUE INDEX IF NOT EXISTS payment_payout_revision_key_uq
  ON payment_payout_revisions (empresa_id, payout_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_payout_unlinks (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  payout_id BIGINT NOT NULL,
  bank_transaction_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 500),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, payout_id, idempotency_key),
  FOREIGN KEY (empresa_id, payout_id) REFERENCES payment_payouts (empresa_id, id),
  FOREIGN KEY (empresa_id, bank_transaction_id) REFERENCES fin_extrato_transacoes (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS payment_payout_unlinks_page_idx ON payment_payout_unlinks (empresa_id, payout_id, id DESC);

-- Mirror of migration 0075_creators_partnerships.sql
-- Creators e campanhas têm identidade própria. A atribuição referencia o
-- checkout existente; não cria venda, cliente, comissão, caixa ou estoque.
CREATE TABLE IF NOT EXISTS creator_profiles (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  platform TEXT NOT NULL CHECK (platform IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OTHER')),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 100),
  niche TEXT CHECK (niche IS NULL OR length(niche) <= 100),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_profiles_handle_uq ON creator_profiles (empresa_id, platform, lower(handle));
CREATE INDEX IF NOT EXISTS creator_profiles_page_idx ON creator_profiles (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS creator_campaigns (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  objective TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 8 AND 500),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK (ends_on >= starts_on),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS creator_campaigns_page_idx ON creator_campaigns (empresa_id, status, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_cupons_empresa_id_uq ON commerce_cupons (empresa_id, id);
CREATE TABLE IF NOT EXISTS creator_partnerships (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  creator_id BIGINT NOT NULL,
  campaign_id BIGINT NOT NULL,
  coupon_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'ACTIVE', 'PAUSED', 'ENDED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, creator_id, campaign_id),
  FOREIGN KEY (empresa_id, creator_id) REFERENCES creator_profiles (empresa_id, id),
  FOREIGN KEY (empresa_id, campaign_id) REFERENCES creator_campaigns (empresa_id, id),
  FOREIGN KEY (empresa_id, coupon_id) REFERENCES commerce_cupons (empresa_id, id)
);
-- Um cupom não pode ser transferido para outra parceria, inclusive após fim:
-- assim as atribuições históricas não mudam de dono.
CREATE UNIQUE INDEX IF NOT EXISTS creator_partnerships_coupon_uq ON creator_partnerships (empresa_id, coupon_id) WHERE coupon_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS creator_partnerships_page_idx ON creator_partnerships (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS creator_attributions (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  partnership_id BIGINT NOT NULL,
  order_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, order_id),
  FOREIGN KEY (empresa_id, partnership_id) REFERENCES creator_partnerships (empresa_id, id),
  FOREIGN KEY (empresa_id, order_id) REFERENCES commerce_pedidos (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS creator_attributions_page_idx ON creator_attributions (empresa_id, partnership_id, id DESC);

CREATE TABLE IF NOT EXISTS creator_commands (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  entity TEXT NOT NULL CHECK (entity IN ('profile', 'campaign', 'partnership')),
  entity_id BIGINT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, idempotency_key)
);

-- Mirror of migration 0076_payment_late_reviews.sql
-- A late review is an operational exception, not a second payment ledger.
-- The original order, charge and payment intent remain the sources of truth.
CREATE TABLE IF NOT EXISTS payment_late_reviews (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  order_id BIGINT NOT NULL,
  cobranca_id BIGINT NOT NULL,
  payment_intent_id BIGINT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, order_id),
  FOREIGN KEY (empresa_id, order_id) REFERENCES commerce_pedidos (empresa_id, id),
  FOREIGN KEY (empresa_id, cobranca_id) REFERENCES gateway_cobrancas (empresa_id, id),
  FOREIGN KEY (empresa_id, payment_intent_id) REFERENCES payment_intents (empresa_id, id),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status = 'REFUNDED' AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payment_late_reviews_queue_idx
  ON payment_late_reviews (empresa_id, status, id DESC);

-- 0077: receipt command idempotency without rewriting legacy documents.
ALTER TABLE compra_recebimentos ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE compra_recebimentos ADD COLUMN IF NOT EXISTS request_hash TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compra_recebimentos_idempotencia_formato_ck'
                 AND conrelid = 'compra_recebimentos'::regclass) THEN
    ALTER TABLE compra_recebimentos ADD CONSTRAINT compra_recebimentos_idempotencia_formato_ck CHECK (
      (idempotency_key IS NULL AND request_hash IS NULL)
      OR (idempotency_key IS NOT NULL AND length(idempotency_key) BETWEEN 1 AND 160
          AND request_hash IS NOT NULL AND request_hash ~ '^[a-f0-9]{64}$')
    );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS compra_recebimentos_comando_uq
  ON compra_recebimentos (empresa_id, compra_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
