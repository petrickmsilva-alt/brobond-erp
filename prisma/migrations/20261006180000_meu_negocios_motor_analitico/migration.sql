-- ============================================================
-- 0016 — MOTOR ANALÍTICO "1. MEU NEGÓCIOS"
--
-- Substitui os mocks de relatórios por dados reais calculados no
-- banco, conforme a especificação técnica do módulo:
--
--   1) Margem por pedido na tabela `sales`:
--        Lucro bruto = Valor Líquido (amount_cents)
--                    − CMV (custo médio da ficha técnica)
--                    − Impostos (alíquota por NCM)
--                    − Frete pago (freight_cents)
--      O resultado alimenta as COLUNAS REAIS de lucro bruto
--      (gross_profit_cents) e margem percentual (margin_pct).
--
--   2) Curva ABC contínua por produto: faturamento acumulado
--      classificado em A (até 80%), B (até 95%) e C (5% restantes),
--      persistido em `produto_abc` pela rotina em segundo plano.
--
--   3) Filtros estritos de BI nos agregadores: período (De/Até),
--      `empresa_id` e canal de venda agrupado em Loja Física,
--      E-commerce e Marketplaces.
--
-- Tudo idempotente: o boot aplica db/schema.sql (que espelha esta
-- migration) e o runner versionado registra o nome do arquivo em
-- `schema_migrations`.
-- ============================================================

-- ------------------------------------------------------------------
-- EMPRESAS — cadastro multi-empresa; a BROBOND é a empresa padrão (1)
-- ------------------------------------------------------------------
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

-- Mantém a SEQUENCE sincronizada com o id inserido explicitamente
-- (próxima empresa criada pelo CRUD não pode colidir com o id 1).
SELECT setval(
  pg_get_serial_sequence('empresas', 'id'),
  GREATEST((SELECT COALESCE(MAX(id), 1) FROM empresas), 1),
  true
);

CREATE INDEX IF NOT EXISTS empresas_ativo_idx ON empresas (ativo);

-- ------------------------------------------------------------------
-- IMPOSTOS POR NCM — alíquotas editáveis pelo módulo fiscal
-- ------------------------------------------------------------------
-- `ncm` é a CHAVE de casamento com produtos.ncm (normalizado: apenas
-- dígitos, sem pontos). Aceita:
--   • 8 dígitos  — NCM exato (ex.: 61091000);
--   • 6/4/2      — prefixo (posição/subposição/capítulo, ex.: 6109, 61);
--   • NULL       — alíquota PADRÃO para NCMs sem casamento (o CRUD envia
--                  ncm vazio, que o validador persiste como NULL — é a
--                  única linha "sem chave").
-- O motor escolhe sempre a chave MAIS LONGA que casa com o NCM do
-- produto (exato > prefixo > padrão). Sem nenhuma linha: 0%.
-- O índice parcial garante UMA única linha-padrão (NULL) — o UNIQUE
-- comum trata NULLs como distintos.
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

-- ------------------------------------------------------------------
-- CANAL — Loja Física no enum sale_channel
-- ------------------------------------------------------------------
-- O enum já cobre E-commerce (BROBOND, NUVEMSHOP, INSTAGRAM_SHOPPING,
-- MERCADOPAGO — checkouts próprios) e Marketplaces (MERCADOLIVRE).
-- Falta o canal de vendas presenciais, registradas manualmente.
ALTER TYPE "sale_channel" ADD VALUE IF NOT EXISTS 'LOJA_FISICA';

-- ------------------------------------------------------------------
-- SALES — colunas do motor de margem
-- ------------------------------------------------------------------
ALTER TABLE sales ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS freight_cents INTEGER NOT NULL DEFAULT 0;
-- Colunas calculadas pelo motor (materializadas — "colunas reais"):
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

-- ------------------------------------------------------------------
-- CURVA ABC — classificação contínua por produto/empresa
-- ------------------------------------------------------------------
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
