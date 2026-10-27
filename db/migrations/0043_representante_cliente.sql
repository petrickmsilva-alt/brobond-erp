-- ============================================================================
-- 0043 — MA-03 · CARTEIRA TEMPORAL (representante × cliente)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Hoje o vínculo é `clientes.representante_id` (uma coluna): ao trocar o
-- representante, o vínculo anterior se perde — não há histórico de carteira.
--
-- `representante_cliente` guarda a CARTEIRA COM VIGÊNCIA:
--
--   01/01/2026 → Representante A   (fim = 2026-06-30)
--   01/07/2026 → Representante B   (fim = NULL)
--
-- Trocar de representante ENCERRA a vigência anterior; nunca sobrescreve nem
-- apaga. As vendas antigas continuam com o `representante_id` congelado no
-- próprio documento (vendas/itens já são assim) — o histórico não depende da
-- carteira atual.
--
-- REGRAS
--   • no máximo UMA carteira ABERTA (`fim IS NULL` + `status='ativo'`) por
--     cliente/empresa — índice único parcial (a exclusividade é do banco);
--   • sobreposição de vigência entre linhas é recusada pelo serviço (409) —
--     período sobreposto tornaria ambíguo "quem é o representante do cliente";
--   • `participacao_pct` já prepara carteira COMPARTILHADA (dois representantes
--     no mesmo cliente somando 100%);
--   • `clientes.representante_id` NÃO é alterado: continua sendo o vínculo
--     vigente "de conveniência" das telas. A carteira é a fonte temporal.
-- ============================================================================

CREATE TABLE IF NOT EXISTS representante_cliente (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  territorio_id INTEGER REFERENCES territorios(id),
  inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fim DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  prioridade INTEGER NOT NULL DEFAULT 1,
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT representante_cliente_status_valido CHECK (status IN ('ativo', 'encerrado', 'cancelado')),
  CONSTRAINT representante_cliente_vigencia CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT representante_cliente_participacao CHECK (participacao_pct > 0 AND participacao_pct <= 100),
  CONSTRAINT representante_cliente_prioridade CHECK (prioridade >= 1 AND prioridade <= 9),
  CONSTRAINT representante_cliente_encerrado_tem_fim CHECK (status <> 'encerrado' OR fim IS NOT NULL)
);

-- Exclusividade: uma única carteira ABERTA por cliente/empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representante_cliente_aberta
  ON representante_cliente (empresa_id, cliente_id)
  WHERE status = 'ativo' AND fim IS NULL;

CREATE INDEX IF NOT EXISTS representante_cliente_emp_rep_idx
  ON representante_cliente (empresa_id, representante_id, status);
CREATE INDEX IF NOT EXISTS representante_cliente_emp_cli_idx
  ON representante_cliente (empresa_id, cliente_id, inicio);
CREATE INDEX IF NOT EXISTS representante_cliente_territorio_idx
  ON representante_cliente (empresa_id, territorio_id);
