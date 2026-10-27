-- ============================================================================
-- 0052 — ESTOQUE: TRANSFERÊNCIA FORMAL, RESERVA E DISPONIBILIDADE
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O ERP já movimentava estoque entre locais, mas só por um ÚNICO lançamento
-- (`movimentacoes.tipo = 'transferencia'`): não havia documento, não havia
-- aprovação, não havia "em trânsito" e não havia como saber o que está
-- RESERVADO (venda em separação, OP programada, bloqueio de qualidade).
--
-- Esta migração adiciona três coisas — e NENHUMA delas altera o saldo por
-- conta própria:
--
--   1) TRANSFERÊNCIA FORMAL (documento + itens + eventos)
--      Estados: SOLICITADA → APROVADA → EM_TRANSITO → RECEBIDA
--               (ou CANCELADA, antes da expedição)
--      O saldo só muda em DOIS eventos, pelos lançamentos oficiais:
--        • expedir  → movimentação de SAÍDA no local de origem;
--        • receber  → movimentação de ENTRADA no local de destino.
--      "Em trânsito" é o estado do documento, não um saldo paralelo.
--
--   2) RESERVA / EMPENHO / BLOQUEIO (`estoque_reservas`)
--      Quantidade comprometida por um documento (venda, OP, qualidade),
--      com tipo explícito. Liberar a reserva NÃO movimenta estoque — só
--      devolve a quantidade ao disponível.
--
--   3) DISPONIBILIDADE derivada (sem tabela nova)
--      disponível = físico − reservado − bloqueado − empenhado
--      Calculada por consulta (server/src/estoqueDisponibilidade.ts). Nenhum
--      saldo é duplicado: `estoques.quantidade` continua sendo o FÍSICO.
--
-- REGRAS QUE NÃO MUDAM
--   • multiempresa: toda tabela tem `empresa_id` NOT NULL;
--   • nada é apagado (CANCELADA é estado, não DELETE);
--   • vocabulário fechado por CHECK (defesa em profundidade no banco);
--   • o saldo continua sendo movimentado APENAS por `movimentacoes`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) DOCUMENTO DE TRANSFERÊNCIA
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  origem_local_id INTEGER NOT NULL REFERENCES locais(id),
  destino_local_id INTEGER NOT NULL REFERENCES locais(id),
  status TEXT NOT NULL DEFAULT 'solicitada',
  solicitante_id INTEGER REFERENCES usuarios(id),
  aprovador_id INTEGER REFERENCES usuarios(id),
  solicitada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  aprovada_em TIMESTAMPTZ,
  expedida_em TIMESTAMPTZ,
  recebida_em TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_status_idx
  ON estoque_transferencias (empresa_id, status);
CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_origem_idx
  ON estoque_transferencias (empresa_id, origem_local_id);
CREATE INDEX IF NOT EXISTS estoque_transferencias_empresa_destino_idx
  ON estoque_transferencias (empresa_id, destino_local_id);

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_status_valido
    CHECK (status IN ('solicitada', 'aprovada', 'em_transito', 'recebida', 'cancelada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_locais_diferentes
    CHECK (origem_local_id <> destino_local_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencias ADD CONSTRAINT estoque_transferencias_cancelamento_coerente
    CHECK (status <> 'cancelada' OR (cancelada_em IS NOT NULL AND motivo_cancelamento IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2) ITENS DO DOCUMENTO
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencia_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  transferencia_id INTEGER NOT NULL REFERENCES estoque_transferencias(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade INTEGER NOT NULL,
  quantidade_recebida INTEGER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estoque_transf_itens_transferencia_idx
  ON estoque_transferencia_itens (empresa_id, transferencia_id);
CREATE INDEX IF NOT EXISTS estoque_transf_itens_produto_idx
  ON estoque_transferencia_itens (empresa_id, produto_id, tamanho_id);

DO $$ BEGIN
  ALTER TABLE estoque_transferencia_itens ADD CONSTRAINT estoque_transf_itens_quantidade_positiva
    CHECK (quantidade > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_transferencia_itens ADD CONSTRAINT estoque_transf_itens_recebida_valida
    CHECK (quantidade_recebida IS NULL OR (quantidade_recebida >= 0 AND quantidade_recebida <= quantidade));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 3) EVENTOS DO DOCUMENTO (trilha própria da transferência)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_transferencia_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  transferencia_id INTEGER NOT NULL REFERENCES estoque_transferencias(id),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estoque_transf_eventos_transferencia_idx
  ON estoque_transferencia_eventos (empresa_id, transferencia_id, criado_em);

-- ----------------------------------------------------------------------------
-- 4) RESERVAS / EMPENHOS / BLOQUEIOS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estoque_reservas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  local_id INTEGER REFERENCES locais(id),
  tipo TEXT NOT NULL DEFAULT 'reserva',
  quantidade INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa',
  -- Documento de origem da reserva (venda, OP, transferência, qualidade...).
  -- `origem_recurso` é o nome do RECURSO (não da tabela) para reusar o
  -- diagnóstico de dependências e o vocabulário do ERP.
  origem_recurso TEXT,
  origem_id INTEGER,
  motivo TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  expira_em DATE,
  liberada_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS estoque_reservas_saldo_idx
  ON estoque_reservas (empresa_id, produto_id, tamanho_id, local_id, status);
CREATE INDEX IF NOT EXISTS estoque_reservas_origem_idx
  ON estoque_reservas (empresa_id, origem_recurso, origem_id);

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_tipo_valido
    CHECK (tipo IN ('reserva', 'empenho', 'bloqueio'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_status_valido
    CHECK (status IN ('ativa', 'liberada', 'consumida', 'expirada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_quantidade_positiva
    CHECK (quantidade > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Liberação coerente: liberada/expirada exigem carimbo.
DO $$ BEGIN
  ALTER TABLE estoque_reservas ADD CONSTRAINT estoque_reservas_liberacao_coerente
    CHECK (status NOT IN ('liberada', 'expirada') OR liberada_em IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
