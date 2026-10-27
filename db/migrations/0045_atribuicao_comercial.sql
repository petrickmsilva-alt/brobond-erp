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
