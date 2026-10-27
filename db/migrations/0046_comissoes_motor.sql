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
