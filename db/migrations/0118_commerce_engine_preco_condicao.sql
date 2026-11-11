-- ============================================================================
-- 0118 — COMMERCE ENGINE: PREÇO POR CONDIÇÃO DE PAGAMENTO, PREÇO MÍNIMO E
--        MEMÓRIA DE PRECIFICAÇÃO
--
-- Lacunas reais apontadas na auditoria (docs/architecture/COMMERCE_ENGINE_AUDIT.md):
--   • a planilha-base traz preços OFICIAIS por condição de pagamento (à vista,
--     boleto 30/60/90, cartão débito/crédito) e o modelo não tinha onde
--     representá-los sem esmagá-los em `preco_venda`/`preco_atacado`;
--   • não havia parâmetro de PREÇO MÍNIMO / margem mínima / limite de desconto;
--   • não havia MEMÓRIA de cálculo (a origem de cada preço/desconto aplicado).
--
-- O que esta migração NÃO faz (proibições da missão):
--   • não cria um segundo motor de preço — apenas uma CAMADA de condição que
--     refina o preço já resolvido por `listas_preco`/`politicas_comerciais`;
--   • não inventa alíquota, margem ou preço: todo parâmetro nasce NULO/desligado
--     e só passa a valer quando o Diretor/contabilidade cadastra;
--   • não sobrescreve `produtos.preco_venda` nem `produtos.preco_atacado`.
--
-- Aditiva e idempotente. Rollback (manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS precificacao_memoria;
--   DROP TABLE IF EXISTS politica_preco_minimo;
--   DROP TABLE IF EXISTS produto_precos_condicao;
--   DROP TABLE IF EXISTS condicoes_pagamento;
--   DELETE FROM schema_migrations WHERE id = '0118_commerce_engine_preco_condicao.sql';
--   COMMIT;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CONDIÇÕES DE PAGAMENTO (catálogo por empresa)
--
-- Estrutura, não valor: descreve COMO se paga (pix, boleto 30/60/90, cartão).
-- O preço de cada condição vive em `produto_precos_condicao`. `prazo_dias` é o
-- prazo do primeiro vencimento; `parcelas` a quantidade de parcelas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS condicoes_pagamento (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  codigo TEXT NOT NULL,                          -- 'pix', 'boleto_30', 'cartao_credito_30_60'...
  nome TEXT NOT NULL,
  canal TEXT NOT NULL DEFAULT 'todos',           -- atacado | varejo | todos
  parcelas INTEGER NOT NULL DEFAULT 1,
  prazo_dias INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT condicoes_pagamento_canal_ck CHECK (canal IN ('atacado', 'varejo', 'todos')),
  CONSTRAINT condicoes_pagamento_parcelas_ck CHECK (parcelas >= 1),
  CONSTRAINT condicoes_pagamento_prazo_ck CHECK (prazo_dias >= 0),
  CONSTRAINT condicoes_pagamento_codigo_ck CHECK (codigo ~ '^[a-z0-9_]+$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_condicoes_pagamento_empresa_codigo
  ON condicoes_pagamento (empresa_id, codigo);

-- ----------------------------------------------------------------------------
-- 2) PREÇO OFICIAL POR PRODUTO × CANAL × CONDIÇÃO
--
-- Fonte de dados: as colunas "Atacado *" e "Varejo/VRJ/Vlr Cartão *" da
-- planilha-base. `origem` registra de onde veio (auditoria da carga). A coluna
-- `preco` é o preço COMERCIAL OFICIAL daquela condição — não é fórmula.
--
-- Unicidade (empresa, produto, canal, condição): reimportar a planilha ATUALIZA
-- a linha, nunca duplica.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS produto_precos_condicao (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  canal TEXT NOT NULL,                           -- atacado | varejo
  condicao TEXT NOT NULL,                        -- codigo da condição
  preco NUMERIC(12,2) NOT NULL,
  origem TEXT NOT NULL DEFAULT 'planilha',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT produto_precos_condicao_canal_ck CHECK (canal IN ('atacado', 'varejo')),
  CONSTRAINT produto_precos_condicao_preco_ck CHECK (preco >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_precos_condicao
  ON produto_precos_condicao (empresa_id, produto_id, canal, condicao);
CREATE INDEX IF NOT EXISTS produto_precos_condicao_produto_idx
  ON produto_precos_condicao (empresa_id, produto_id);

-- ----------------------------------------------------------------------------
-- 3) POLÍTICA DE PREÇO MÍNIMO (parâmetro por empresa)
--
-- UMA linha por empresa. Todos os limites nascem NULOS e `bloqueio_ativo` FALSO:
-- a missão proíbe inventar limite de margem. Enquanto desligada, o motor apenas
-- INFORMA a margem; não bloqueia venda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS politica_preco_minimo (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL UNIQUE REFERENCES empresas(id) ON DELETE CASCADE,
  margem_minima_pct NUMERIC(6,2),
  desconto_max_pct NUMERIC(6,2),
  bloqueio_ativo BOOLEAN NOT NULL DEFAULT FALSE,
  exige_justificativa BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT politica_preco_minimo_margem_ck CHECK (margem_minima_pct IS NULL OR (margem_minima_pct >= -100 AND margem_minima_pct <= 100)),
  CONSTRAINT politica_preco_minimo_desconto_ck CHECK (desconto_max_pct IS NULL OR (desconto_max_pct >= 0 AND desconto_max_pct <= 100))
);

-- ----------------------------------------------------------------------------
-- 4) MEMÓRIA DE PRECIFICAÇÃO (append-only)
--
-- Cada simulação/pedido que aplica a política grava AQUI a origem do cálculo:
-- preço de lista, preço aplicado, desconto, custo, impostos, frete, taxas e a
-- margem resultante, além das regras usadas em `regras` (JSONB). É o "por que
-- este preço?" respondível por auditoria — nunca recalculado silenciosamente.
-- Histórico: não se edita nem se exclui (`ops.delete = false`).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS precificacao_memoria (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  canal TEXT NOT NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL DEFAULT 1,
  condicao TEXT,
  preco_lista NUMERIC(12,2) NOT NULL DEFAULT 0,
  preco_aplicado NUMERIC(12,2) NOT NULL DEFAULT 0,
  desconto_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  custo NUMERIC(12,2) NOT NULL DEFAULT 0,
  impostos NUMERIC(12,2) NOT NULL DEFAULT 0,
  frete NUMERIC(12,2) NOT NULL DEFAULT 0,
  taxas NUMERIC(12,2) NOT NULL DEFAULT 0,
  margem_valor NUMERIC(12,2) NOT NULL DEFAULT 0,
  margem_pct NUMERIC(6,2),
  origem_preco TEXT NOT NULL DEFAULT 'produto',
  regras JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT precificacao_memoria_canal_ck CHECK (canal IN ('atacado', 'varejo', 'todos')),
  CONSTRAINT precificacao_memoria_quantidade_ck CHECK (quantidade >= 1)
);
CREATE INDEX IF NOT EXISTS precificacao_memoria_produto_idx
  ON precificacao_memoria (empresa_id, produto_id, criado_em);
CREATE INDEX IF NOT EXISTS precificacao_memoria_venda_idx
  ON precificacao_memoria (empresa_id, venda_id);
