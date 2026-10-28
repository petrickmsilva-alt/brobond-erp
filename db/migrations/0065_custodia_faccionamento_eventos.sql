-- 0065 — custódia e faccionamento rastreável usando o estoque canônico.
-- Eventos são trilha operacional, não saldo nem mecanismo de consumo paralelo.
CREATE TABLE IF NOT EXISTS terceiros_operacionais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  documento TEXT,
  contato TEXT,
  telefone TEXT,
  email TEXT,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS terceiros_operacionais_empresa_idx ON terceiros_operacionais (empresa_id, ativo, nome);
CREATE UNIQUE INDEX IF NOT EXISTS terceiros_operacionais_documento_empresa_uq
  ON terceiros_operacionais (empresa_id, documento) WHERE documento IS NOT NULL AND documento <> '';

ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS terceiro_id INTEGER REFERENCES terceiros_operacionais(id);
CREATE INDEX IF NOT EXISTS ordens_fabricacao_terceiro_idx ON ordens_fabricacao (empresa_id, terceiro_id);

CREATE TABLE IF NOT EXISTS terceirizacao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id),
  terceiro_id INTEGER NOT NULL REFERENCES terceiros_operacionais(id),
  evento TEXT NOT NULL CHECK (evento IN ('ENVIO_INSUMO','RETORNO_INSUMO','RETORNO_PRODUTO','PERDA_PRODUTO','CUSTODIA')),
  tipo_material TEXT NOT NULL CHECK (tipo_material IN ('insumo','produto')),
  insumo_id INTEGER REFERENCES insumos(id),
  produto_id INTEGER REFERENCES produtos(id),
  proprietario_tipo TEXT NOT NULL CHECK (proprietario_tipo IN ('empresa','terceiro')),
  proprietario_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  custodiante_anterior_tipo TEXT NOT NULL CHECK (custodiante_anterior_tipo IN ('empresa','terceiro')),
  custodiante_anterior_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  custodiante_novo_tipo TEXT NOT NULL CHECK (custodiante_novo_tipo IN ('empresa','terceiro')),
  custodiante_novo_terceiro_id INTEGER REFERENCES terceiros_operacionais(id),
  quantidade NUMERIC(14,3) NOT NULL CHECK (quantidade > 0),
  unidade TEXT NOT NULL,
  referencia_evento_id INTEGER REFERENCES terceirizacao_eventos(id),
  movimentacao_insumo_id INTEGER REFERENCES movimentacoes_insumos(id),
  apontamento_id INTEGER REFERENCES ordens_apontamentos(id),
  idempotency_key TEXT NOT NULL,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT terceirizacao_eventos_material_coerente CHECK (
    (tipo_material = 'insumo' AND insumo_id IS NOT NULL AND produto_id IS NULL) OR
    (tipo_material = 'produto' AND produto_id IS NOT NULL AND insumo_id IS NULL)
  ),
  CONSTRAINT terceirizacao_eventos_proprietario_coerente CHECK (
    (proprietario_tipo = 'empresa' AND proprietario_terceiro_id IS NULL) OR
    (proprietario_tipo = 'terceiro' AND proprietario_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_custodiante_anterior_coerente CHECK (
    (custodiante_anterior_tipo = 'empresa' AND custodiante_anterior_terceiro_id IS NULL) OR
    (custodiante_anterior_tipo = 'terceiro' AND custodiante_anterior_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_custodiante_novo_coerente CHECK (
    (custodiante_novo_tipo = 'empresa' AND custodiante_novo_terceiro_id IS NULL) OR
    (custodiante_novo_tipo = 'terceiro' AND custodiante_novo_terceiro_id IS NOT NULL)
  ),
  CONSTRAINT terceirizacao_eventos_idem_uq UNIQUE (empresa_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_ordem_idx ON terceirizacao_eventos (empresa_id, ordem_id, id);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_terceiro_idx ON terceirizacao_eventos (empresa_id, terceiro_id, criado_em);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_referencia_idx ON terceirizacao_eventos (empresa_id, referencia_evento_id);
CREATE INDEX IF NOT EXISTS terceirizacao_eventos_apontamento_idx ON terceirizacao_eventos (empresa_id, apontamento_id);
COMMENT ON TABLE terceirizacao_eventos IS 'Trilha imutável de custódia e faccionamento. Não é saldo; consumo de insumos é movimentacoes_insumos e entrada do acabado segue o fluxo de apontamento/conclusão da OP.';
COMMENT ON COLUMN ordens_fabricacao.terceiro_id IS 'Terceiro operacional responsável por facção/terceirização; a custódia detalhada fica em terceirizacao_eventos.';
