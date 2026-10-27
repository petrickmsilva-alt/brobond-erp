-- ============================================================================
-- 0044 — MA-04 · METAS COMERCIAIS (domínio próprio, realizado DERIVADO)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Meta NÃO é atributo de representante (`representantes.meta_valor` seria a
-- modelagem errada). É planejamento com período + alvo + métrica + recorte.
--
-- O QUE ESTA TABELA NÃO TEM — DE PROPÓSITO
--   • `realizado`   — é SEMPRE derivado das vendas/itens (consulta);
--   • `atingimento` — é `realizado / meta`, calculado;
--   • `variacao`    — idem.
-- Nenhum usuário digita "82%". O servidor calcula (server/src/comercial.ts).
--
-- ALVOS SUPORTADOS (um por meta): representante, equipe, território, empresa.
-- MÉTRICAS: faturamento, quantidade, margem, pedidos, clientes.
-- RECORTES: todos, produto, categoria, coleção.
-- PERÍODO: mensal, trimestral ou anual (granularidade declarada; o realizado é
--          sempre apurado pela janela `periodo_inicio..periodo_fim`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS metas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT,
  alvo_tipo TEXT NOT NULL,
  representante_id INTEGER REFERENCES representantes(id),
  equipe_id INTEGER REFERENCES equipes_comerciais(id),
  territorio_id INTEGER REFERENCES territorios(id),
  metrica TEXT NOT NULL,
  recorte_tipo TEXT NOT NULL DEFAULT 'todos',
  produto_id INTEGER REFERENCES produtos(id),
  categoria_id INTEGER REFERENCES categorias(id),
  colecao_id INTEGER REFERENCES colecoes(id),
  periodo_inicio DATE NOT NULL,
  periodo_fim DATE NOT NULL,
  granularidade TEXT NOT NULL DEFAULT 'mensal',
  valor_meta NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_meta NUMERIC(14,3) NOT NULL DEFAULT 0,
  distribuicao TEXT NOT NULL DEFAULT 'linear',
  status TEXT NOT NULL DEFAULT 'ativa',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT metas_alvo_valido CHECK (alvo_tipo IN ('representante', 'equipe', 'territorio', 'empresa')),
  CONSTRAINT metas_metrica_valida CHECK (metrica IN ('faturamento', 'quantidade', 'margem', 'pedidos', 'clientes')),
  CONSTRAINT metas_recorte_valido CHECK (recorte_tipo IN ('todos', 'produto', 'categoria', 'colecao')),
  CONSTRAINT metas_granularidade_valida CHECK (granularidade IN ('mensal', 'trimestral', 'anual')),
  CONSTRAINT metas_distribuicao_valida CHECK (distribuicao IN ('linear', 'unica')),
  CONSTRAINT metas_status_valido CHECK (status IN ('rascunho', 'ativa', 'encerrada', 'cancelada')),
  CONSTRAINT metas_periodo_coerente CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT metas_valor_nao_negativo CHECK (valor_meta >= 0 AND quantidade_meta >= 0),
  CONSTRAINT metas_algum_alvo CHECK (valor_meta > 0 OR quantidade_meta > 0),
  -- O alvo preenchido tem de ser EXATAMENTE o do tipo declarado.
  CONSTRAINT metas_alvo_coerente CHECK (
    (alvo_tipo = 'representante' AND representante_id IS NOT NULL AND equipe_id IS NULL AND territorio_id IS NULL)
    OR (alvo_tipo = 'equipe' AND equipe_id IS NOT NULL AND representante_id IS NULL AND territorio_id IS NULL)
    OR (alvo_tipo = 'territorio' AND territorio_id IS NOT NULL AND representante_id IS NULL AND equipe_id IS NULL)
    OR (alvo_tipo = 'empresa' AND representante_id IS NULL AND equipe_id IS NULL AND territorio_id IS NULL)
  ),
  -- O recorte preenchido tem de ser EXATAMENTE o do tipo declarado.
  CONSTRAINT metas_recorte_coerente CHECK (
    (recorte_tipo = 'todos' AND produto_id IS NULL AND categoria_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'produto' AND produto_id IS NOT NULL AND categoria_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'categoria' AND categoria_id IS NOT NULL AND produto_id IS NULL AND colecao_id IS NULL)
    OR (recorte_tipo = 'colecao' AND colecao_id IS NOT NULL AND produto_id IS NULL AND categoria_id IS NULL)
  )
);

-- Duas metas ATIVAS idênticas (mesmo alvo, métrica, recorte e período) seriam
-- dado ambíguo: o índice impede. Sobreposição de período é recusada pelo
-- serviço (409).
CREATE UNIQUE INDEX IF NOT EXISTS uq_metas_alvo_ativa
  ON metas (
    empresa_id, alvo_tipo, metrica, recorte_tipo, periodo_inicio, periodo_fim,
    COALESCE(representante_id, 0), COALESCE(equipe_id, 0), COALESCE(territorio_id, 0),
    COALESCE(produto_id, 0), COALESCE(categoria_id, 0), COALESCE(colecao_id, 0)
  )
  WHERE status = 'ativa';

CREATE INDEX IF NOT EXISTS metas_empresa_periodo_idx
  ON metas (empresa_id, periodo_inicio, periodo_fim);
CREATE INDEX IF NOT EXISTS metas_representante_idx
  ON metas (empresa_id, representante_id, status);
CREATE INDEX IF NOT EXISTS metas_equipe_idx
  ON metas (empresa_id, equipe_id, status);
CREATE INDEX IF NOT EXISTS metas_territorio_idx
  ON metas (empresa_id, territorio_id, status);
