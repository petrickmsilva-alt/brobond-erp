-- ============================================================================
-- 0041 — CADASTRO PROFISSIONAL DE INSUMOS (identificação + categorização).
--
-- O cadastro de insumos tinha apenas nome, unidade, custo_medio, fornecedor_id
-- e ativo (db/schema.sql). Faltavam as duas peças de um cadastro MESTRE de
-- matéria-prima:
--
--   1. IDENTIFICAÇÃO OPERACIONAL (`insumos.codigo_insumo`)
--      Um código curto que a produção/expedição usa para achar o insumo sem
--      depender do nome livre. Segue o MESMO desenho de `produtos.sku`
--      (ERP-03): único POR EMPRESA, NÃO obrigatório — os registros existentes
--      ficam com NULL e nada é reescrito.
--
--   2. CATEGORIZAÇÃO (`categorias_insumos` + `insumos.categoria_id`)
--      Agrupamento profissional (matéria-prima, aviamentos, identidade de
--      marca, embalagem...). NÃO reaproveita `categorias` (que é o catálogo
--      GLOBAL de tipo de peça do produto acabado) para não misturar a
--      taxonomia do produto com a do insumo. A tabela nova é POR EMPRESA,
--      como `categorias_financeiras`, e admite UM nível de categoria-pai
--      (mesmo padrão do plano de contas) para agrupar sem inflar o cadastro.
--
-- 100% ADITIVA e idempotente: nenhum dado é reescrito, nenhuma FK existente é
-- tocada, nenhum CASCADE é criado. Os insumos existentes continuam válidos
-- (código e categoria nulos) e seguem no fluxo Compras → Estoque → Ficha
-- Técnica → Custo → Formação de Preço sem alteração de comportamento.
-- ============================================================================

-- 1) Identificação operacional do insumo (única por empresa, opcional).
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS codigo_insumo TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insumos_codigo_empresa
  ON insumos (empresa_id, codigo_insumo)
  WHERE codigo_insumo IS NOT NULL AND codigo_insumo <> '';

-- 2) Categorias de insumo — cadastro auxiliar POR EMPRESA, com um nível de pai.
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

-- Unicidade do nome POR EMPRESA (mesmo desenho de `produtos.sku`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_categorias_insumos_empresa_nome
  ON categorias_insumos (empresa_id, nome);

CREATE INDEX IF NOT EXISTS categorias_insumos_empresa_idx ON categorias_insumos (empresa_id);
CREATE INDEX IF NOT EXISTS categorias_insumos_pai_idx ON categorias_insumos (pai_id);

-- 3) Vínculo do insumo com a categoria (opcional; FK NO ACTION preserva o
--    histórico — a exclusão de categoria em uso é diagnosticada, nunca cascata).
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_insumos(id);

CREATE INDEX IF NOT EXISTS insumos_categoria_idx ON insumos (categoria_id);

-- NENHUMA categoria é semeada: a taxonomia do insumo é decisão da empresa, não
-- do ERP. `categorias_insumos` nasce vazia e é preenchida no cadastro
-- /categorias-insumos — nada é inventado aqui.
