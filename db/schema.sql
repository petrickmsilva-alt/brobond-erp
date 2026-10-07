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
  nome TEXT UNIQUE NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_produtos_codigo_barras ON produtos (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';
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

-- ------------------------------------------------------------
-- 4.1) MIGRAÇÃO DE DADOS — Locais de estoque
--    Idempotente: cria os locais a partir dos textos livres usados em
--    estoques e movimentações e preenche local_id onde estiver vazio.
--    A coluna texto `local` é mantida (chave única existente), nada quebra.
-- ------------------------------------------------------------
INSERT INTO locais (nome, tipo)
SELECT DISTINCT sub.local, 'loja'
FROM (
  SELECT local FROM estoques WHERE local IS NOT NULL AND TRIM(local) <> ''
  UNION
  SELECT local FROM movimentacoes WHERE local IS NOT NULL AND TRIM(local) <> ''
) sub
WHERE NOT EXISTS (SELECT 1 FROM locais l WHERE l.nome = sub.local);

UPDATE estoques e SET local_id = l.id
FROM locais l WHERE e.local_id IS NULL AND l.nome = e.local;

UPDATE movimentacoes m SET local_id = l.id
FROM locais l WHERE m.local_id IS NULL AND l.nome = m.local;

UPDATE movimentacoes m SET local_destino_id = l.id
FROM locais l WHERE m.local_destino IS NOT NULL AND m.local_destino = l.nome;

-- Garante um Local padrão (origem das movimentações) nas bases existentes,
-- marcando o primeiro local ativo quando nenhum ainda está marcado.
UPDATE locais SET padrao = TRUE
WHERE id = (
  SELECT id FROM locais WHERE ativo IS NOT FALSE ORDER BY nome ASC LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM locais WHERE padrao = TRUE);

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
