-- ============================================================================
-- 0054 — PRODUÇÃO: RECURSO PRODUTIVO, CAPACIDADE E CARGA (MRP 3.0)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A produção já sabia O QUE fabricar (OP, ficha técnica, apontamento, MRP de
-- insumos a partir das OPs em aberto). Não sabia ONDE fabricar nem QUANTO cabe:
-- não havia recurso produtivo (costura, corte, estamparia, bordado, facção),
-- nem capacidade diária, nem forma de responder "qual é o gargalo da semana?".
--
-- O que entra aqui:
--   1) `producao_recursos` — o recurso produtivo POR EMPRESA: nome, tipo,
--      capacidade diária (peças/dia), eficiência e ativo. É um CADASTRO, não um
--      indicador: capacidade é dado de engenharia, informado por quem produz.
--   2) `ordens_fabricacao.recurso_id` — a ligação OP → recurso. NULA de
--      propósito: OP sem recurso continua válida (o gargalo é DERIVADO, e uma
--      OP sem alocação aparece como "sem recurso", nunca como zero).
--
-- REGRAS QUE NÃO MUDAM
--   • a carga NÃO é coluna: é Σ do que falta produzir nas OPs do recurso no
--     período (server/src/producaoCapacidade.ts). Nenhum número é duplicado;
--   • MRP é SUGESTÃO DE LEITURA — esta migração e o endpoint não criam pedido
--     de compra. Gerar compra continua exigindo ação explícita do usuário;
--   • nada é apagado: recurso sai de uso por `ativo = false`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS producao_recursos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'costura',
  capacidade_diaria INTEGER NOT NULL DEFAULT 0,
  eficiencia_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  dias_uteis_semana INTEGER NOT NULL DEFAULT 5,
  local_id INTEGER REFERENCES locais(id),
  responsavel_id INTEGER REFERENCES usuarios(id),
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS producao_recursos_empresa_idx
  ON producao_recursos (empresa_id, ativo, nome);

DO $$ BEGIN
  ALTER TABLE producao_recursos ADD CONSTRAINT producao_recursos_tipo_valido
    CHECK (tipo IN ('corte', 'costura', 'estamparia', 'bordado', 'acabamento', 'embalagem', 'faccao', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE producao_recursos ADD CONSTRAINT producao_recursos_capacidade_valida
    CHECK (capacidade_diaria >= 0 AND eficiencia_pct >= 0 AND eficiencia_pct <= 200
           AND dias_uteis_semana BETWEEN 1 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- OP → RECURSO (a alocação é decisão do planejador; sem recurso é válido)
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS recurso_id INTEGER REFERENCES producao_recursos(id);

CREATE INDEX IF NOT EXISTS ordens_fabricacao_recurso_idx
  ON ordens_fabricacao (empresa_id, recurso_id, previsao);
