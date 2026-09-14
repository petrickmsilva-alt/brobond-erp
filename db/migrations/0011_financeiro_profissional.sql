-- 0011 — Financeiro profissional (auditoria):
--   • centros_custo: rateio gerencial (Loja × Produção × Administrativo...).
--   • categorias_financeiras.pai_id: plano de contas em dois níveis.
--   • lancamentos_financeiros.centro_custo_id / taxa_pct / valor_liquido:
--     taxas de operadora (Mercado Pago/cartão) visíveis no DRE como
--     despesas financeiras, com o líquido que realmente cai na conta.
--   • transferencias_financeiras: movimentação entre contas sem distorcer
--     receita/despesa (par de lançamentos do tipo 'transferencia').
--   • Trava contra geração dupla de recorrência (cron + botão concorrentes).
-- Idempotente — seguro rodar em bancos novos e existentes.

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

ALTER TABLE categorias_financeiras ADD COLUMN IF NOT EXISTS pai_id INTEGER REFERENCES categorias_financeiras(id);

ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS centro_custo_id INTEGER REFERENCES centros_custo(id);
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS taxa_pct NUMERIC(5,2) DEFAULT 0;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS valor_liquido NUMERIC(12,2);

ALTER TABLE recorrencias_financeiras ADD COLUMN IF NOT EXISTS centro_custo_id INTEGER REFERENCES centros_custo(id);

CREATE TABLE IF NOT EXISTS transferencias_financeiras (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL DEFAULT now(),
  conta_origem_id INTEGER NOT NULL REFERENCES contas_financeiras(id),
  conta_destino_id INTEGER NOT NULL REFERENCES contas_financeiras(id),
  valor NUMERIC(12,2) NOT NULL,
  descricao TEXT,
  status TEXT DEFAULT 'confirmado',
  lancamento_saida_id INTEGER,
  lancamento_entrada_id INTEGER,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_transf_fin_data    ON transferencias_financeiras (data DESC);
CREATE INDEX IF NOT EXISTS idx_transf_fin_origem  ON transferencias_financeiras (conta_origem_id);
CREATE INDEX IF NOT EXISTS idx_transf_fin_destino ON transferencias_financeiras (conta_destino_id);

-- Sem esta trava, cron + botão "Gerar" rodando juntos criam a mesma despesa
-- duas vezes. Defensivo: duplicata histórica adia o índice (NOTICE) em vez
-- de derrubar o boot.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lanc_fin_recorrencia_vencimento
    ON lancamentos_financeiros (referencia_recorrencia_id, vencimento)
    WHERE referencia_recorrencia_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'uq_lanc_fin_recorrencia_vencimento adiado: existem duplicatas de recorrência para revisar.';
END $$;

CREATE INDEX IF NOT EXISTS idx_lanc_fin_centro_custo ON lancamentos_financeiros (centro_custo_id);

-- Líquido padrão = bruto quando não há taxa (histórico incluído).
UPDATE lancamentos_financeiros SET valor_liquido = valor WHERE valor_liquido IS NULL;

-- Integridade mínima do dinheiro (NOT VALID primeiro: valida linhas antigas
-- só se der; a regra passa a valer para tudo que é novo imediatamente).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lanc_fin_valor_positivo') THEN
    ALTER TABLE lancamentos_financeiros ADD CONSTRAINT ck_lanc_fin_valor_positivo CHECK (valor > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_lanc_fin_taxa_pct') THEN
    ALTER TABLE lancamentos_financeiros ADD CONSTRAINT ck_lanc_fin_taxa_pct CHECK (taxa_pct >= 0 AND taxa_pct < 100) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_transf_fin_valor_positivo') THEN
    ALTER TABLE transferencias_financeiras ADD CONSTRAINT ck_transf_fin_valor_positivo CHECK (valor > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_transf_fin_contas_diferentes') THEN
    ALTER TABLE transferencias_financeiras ADD CONSTRAINT ck_transf_fin_contas_diferentes CHECK (conta_origem_id <> conta_destino_id) NOT VALID;
  END IF;
END $$;
