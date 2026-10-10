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
    'separacao', 'conferencia', 'embalagem', 'expedicao'
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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_valor') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_valor CHECK (valor > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_metodo') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_metodo
      CHECK (metodo IN ('pix','boleto','cartao_credito','cartao_debito')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_status') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_status
      CHECK (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')) NOT VALID;
  END IF;
END $$;

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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_extrato_valor_positivo') THEN
    ALTER TABLE fin_extrato_transacoes ADD CONSTRAINT ck_extrato_valor_positivo CHECK (valor > 0) NOT VALID;
  END IF;
END $$;

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
