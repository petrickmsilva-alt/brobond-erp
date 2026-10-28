-- 0064 — Extensão do inventário canônico para contagem cíclica ABC.
-- Não cria saldo nem ledger: planos/contagens usam inventarios/itens_inventario;
-- ajustes seguem a rotina fecharInventario e movimentacoes já existentes.
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS inventario_id INTEGER REFERENCES inventarios(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_movimentacoes_inventario_celula
  ON movimentacoes (empresa_id, inventario_id, produto_id, COALESCE(tamanho_id, 0)) WHERE inventario_id IS NOT NULL;
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

DO $$ BEGIN
  ALTER TABLE inventarios ADD CONSTRAINT inventarios_modalidade_valida CHECK (modalidade IN ('inventario','ciclica_abc'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE inventarios ADD CONSTRAINT inventarios_contagem_ciclica_status_valido CHECK (
    contagem_status IS NULL OR contagem_status IN ('PLANEJADA','EM_CONTAGEM','CONFERIDA','APROVADA','CANCELADA')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE inventarios ADD CONSTRAINT inventarios_abc_class_valida CHECK (classificacao_abc IS NULL OR classificacao_abc IN ('A','B','C'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventarios_empresa_idempotency
  ON inventarios (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventarios_ciclica_empresa_status_data
  ON inventarios (empresa_id, modalidade, contagem_status, data_planejada);

ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS unidade TEXT NOT NULL DEFAULT 'un';
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS contado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS contado_em TIMESTAMPTZ;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS motivo_divergencia TEXT;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS classificacao_abc TEXT;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS prioridade INTEGER;
ALTER TABLE itens_inventario ADD COLUMN IF NOT EXISTS movimentacao_id INTEGER REFERENCES movimentacoes(id);
DO $$ BEGIN
  ALTER TABLE itens_inventario ADD CONSTRAINT itens_inventario_abc_class_valida CHECK (classificacao_abc IS NULL OR classificacao_abc IN ('A','B','C'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS itens_inventario_abc_classe_idx ON itens_inventario (empresa_id, classificacao_abc, prioridade);
COMMENT ON COLUMN movimentacoes.inventario_id IS 'Vínculo canônico do ajuste ao inventário que o originou; unicidade por célula torna fechamento repetível sem novo movimento.';

COMMENT ON COLUMN inventarios.abc_criterio IS 'Critério reproduzível implementado: soma das quantidades de movimentações do tipo saída, no período e local informados, agrupadas por produto.';
COMMENT ON COLUMN inventarios.abc_faixas IS 'Faixas cumulativas registradas na data do cálculo; os valores efetivamente usados são armazenados pelo serviço junto ao resultado.';
COMMENT ON COLUMN itens_inventario.saldo_sistema IS 'Snapshot original imutável da abertura; quantidade contada fica em contado.';
