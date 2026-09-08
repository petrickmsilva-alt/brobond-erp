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
  UNIQUE (medida_id, tamanho_id)
);
CREATE INDEX IF NOT EXISTS idx_medida_valores_medida ON medida_valores (medida_id);

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
  UNIQUE (produto_id, tamanho_id, local)
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
CREATE INDEX IF NOT EXISTS idx_movimentacoes_transferencia ON movimentacoes (transferencia_id);

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

-- Catálogo: canal (varejo/atacado), tabela de preço, pedido pelo site
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS canal TEXT DEFAULT 'todos';
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS tabela_preco TEXT DEFAULT 'automatico';
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS aceita_pedido_site BOOLEAN DEFAULT TRUE;
ALTER TABLE catalogos ADD COLUMN IF NOT EXISTS como_comprar TEXT;

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
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_insumos_insumo ON estoque_insumos (insumo_id);
CREATE INDEX IF NOT EXISTS idx_itens_venda_venda     ON itens_venda (venda_id);
CREATE INDEX IF NOT EXISTS idx_itens_compra_compra   ON itens_compra (compra_id);
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
-- Grades de tamanhos: vínculo com categoria (padrão) e produto (override)
-- ------------------------------------------------------------
ALTER TABLE categorias ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id);
ALTER TABLE produtos   ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id);
