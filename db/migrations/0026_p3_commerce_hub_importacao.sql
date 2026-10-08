-- ============================================================================
-- 0026 — FASE P3: HUB E-COMMERCE (ERP ↔ CANAIS), OBSERVABILIDADE DE INTEGRAÇÃO
--        E IMPORTAÇÃO/MIGRAÇÃO RASTREÁVEL.
--
-- O que entra aqui e por quê:
--   1) `empresa_id` nos conectores e nos eventos: até a P2 a tenancy dos
--      conectores era só o `usuario_id` (herança do commerce). O §18 da
--      especificação exige isolamento por EMPRESA também nas integrações —
--      a receita de marketplace passa a ser carimbada na empresa ativa no
--      momento da conexão, e a venda de canal entra em `sales.empresa_id`.
--   2) `attempts`/`last_error`/`next_retry_at` em `connector_events`: retry
--      controlado com backoff (§16) e trilha de erro por entrega (§6).
--   3) `commerce_pedidos_externos`: pedido do canal → venda do ERP com
--      idempotência por (empresa, provedor, id externo) — receber o mesmo
--      pedido duas vezes NUNCA cria duas vendas (§7).
--   4) `integration_logs`: observabilidade das integrações (§15) — provedor,
--      operação, request id, id externo, status, erro, tentativa, duração.
--      Nunca guarda token/senha/segredo.
--   5) `importacoes_lotes` + colunas de origem em `movimentacoes` e
--      `lancamentos_financeiros`: a migração de dados (§10-§14) passa a ter
--      lote auditável, e o saldo inicial/título importado guarda de onde veio.
--
-- Idempotente: pode ser reaplicada sem efeito colateral.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Empresa ativa nos conectores e nos eventos de integração
-- ----------------------------------------------------------------------------
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS connectors_empresa_provider_idx ON connectors (empresa_id, provider);

ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id);
CREATE INDEX IF NOT EXISTS connector_events_empresa_provider_created_idx
  ON connector_events (empresa_id, provider, created_at);

-- Retry controlado (§16): quantas tentativas, qual foi o último erro e quando
-- vale a pena tentar de novo. O worker usa isto em vez de retentar para sempre.
ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS connector_events_retry_idx
  ON connector_events (next_retry_at)
  WHERE processed_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2) Pedido do canal externo → venda do ERP (idempotência por empresa/canal/id)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_pedidos_externos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider "connector_provider" NOT NULL,
  external_order_id TEXT NOT NULL,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  status_externo TEXT,
  status_erp TEXT,
  referencia_erp TEXT,                        -- ex.: "NUVEMSHOP-1234" gravado em vendas.pedido_cliente
  payload JSONB,
  importado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  -- A trava da idempotência é o índice, não a sorte do chamador.
  UNIQUE (empresa_id, provider, external_order_id)
);

CREATE INDEX IF NOT EXISTS commerce_pedidos_externos_empresa_idx
  ON commerce_pedidos_externos (empresa_id, provider, importado_em DESC);
CREATE INDEX IF NOT EXISTS commerce_pedidos_externos_venda_idx
  ON commerce_pedidos_externos (venda_id);

-- ----------------------------------------------------------------------------
-- 3) Log de integração (observabilidade §15) — NUNCA guarda credencial
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_logs (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider TEXT NOT NULL,
  operacao TEXT NOT NULL,                     -- fetchOrders | pushStock | pushPrice | pushTracking | test | webhook
  request_id TEXT,
  external_id TEXT,
  status TEXT NOT NULL,                       -- ok | erro | ignorado | nao_suportado | pendente
  tentativa INTEGER NOT NULL DEFAULT 1,
  duracao_ms INTEGER,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_logs_empresa_idx ON integration_logs (empresa_id, criado_em DESC);
-- Retry controlado (§16): a linha de log guarda a entidade afetada e quando
-- vale a pena tentar de novo. Sem isso, "retry" viraria laço infinito.
ALTER TABLE integration_logs ADD COLUMN IF NOT EXISTS entidade TEXT;
ALTER TABLE integration_logs ADD COLUMN IF NOT EXISTS proxima_tentativa_em TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS integration_logs_provider_operacao_idx
  ON integration_logs (provider, operacao, criado_em DESC);
CREATE INDEX IF NOT EXISTS integration_logs_retry_idx
  ON integration_logs (proxima_tentativa_em)
  WHERE status = 'erro';

-- ----------------------------------------------------------------------------
-- 4) Lote de importação/migração rastreável (§11, §13, §14)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS importacoes_lotes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,                         -- produtos | variacoes | composicoes | clientes | fornecedores | insumos | estoque | titulos | pedidos
  arquivo TEXT,
  origem_hash TEXT,                           -- sha-256 do conteúdo: permite provar reenvio idêntico
  total INTEGER NOT NULL DEFAULT 0,
  importados INTEGER NOT NULL DEFAULT 0,
  ignorados INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmado',  -- confirmado | abortado
  detalhes JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS importacoes_lotes_empresa_idx ON importacoes_lotes (empresa_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 5) Rastreabilidade do que foi importado (estoque inicial e títulos abertos)
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS origem TEXT;
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS custo_unitario NUMERIC(12,2);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS lote_importacao_id INTEGER REFERENCES importacoes_lotes(id) ON DELETE SET NULL;

ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS documento TEXT;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS origem TEXT;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS pessoa_tipo TEXT;   -- cliente | fornecedor
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS pessoa_id INTEGER;
ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS lote_importacao_id INTEGER REFERENCES importacoes_lotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS movimentacoes_lote_idx ON movimentacoes (lote_importacao_id);
CREATE INDEX IF NOT EXISTS lanc_fin_lote_idx ON lancamentos_financeiros (lote_importacao_id);
CREATE INDEX IF NOT EXISTS lanc_fin_vencimento_status_idx ON lancamentos_financeiros (empresa_id, status, vencimento);

-- Saldo inicial e histórico de pedidos também guardam de ONDE vieram: a
-- reimportação de um arquivo é reconhecível e o relatório consegue separar o
-- que nasceu no ERP do que foi migrado (§11, §13).
ALTER TABLE estoques ADD COLUMN IF NOT EXISTS origem TEXT;
ALTER TABLE estoques ADD COLUMN IF NOT EXISTS lote_importacao_id INTEGER REFERENCES importacoes_lotes(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS origem TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS lote_importacao_id INTEGER REFERENCES importacoes_lotes(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- 6) MAPEAMENTO EXPLÍCITO ERP ↔ CANAL (§3): o canal não compartilha o modelo
--    do ERP. Cada linha liga uma chave interna (SKU, id de pedido interno) a
--    um id externo do canal. Sem mapeamento, o hub NÃO adivinha: reporta
--    "sem mapeamento" e o operador cadastra.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_mapeamentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  canal TEXT NOT NULL,                          -- MERCADOLIVRE | NUVEMSHOP | WOOCOMMERCE
  recurso TEXT NOT NULL,                        -- produto | variacao | pedido | envio
  interno_id INTEGER,
  chave_interna TEXT,                           -- SKU (produto/variacao) ou id interno
  externo_id TEXT NOT NULL,                     -- id/link no canal
  metadata JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  UNIQUE (empresa_id, canal, recurso, externo_id)
);
CREATE INDEX IF NOT EXISTS commerce_mapeamentos_empresa_idx
  ON commerce_mapeamentos (empresa_id, canal, recurso);
CREATE INDEX IF NOT EXISTS commerce_mapeamentos_chave_idx
  ON commerce_mapeamentos (empresa_id, canal, recurso, chave_interna);

CREATE INDEX IF NOT EXISTS estoques_lote_idx ON estoques (lote_importacao_id);
CREATE INDEX IF NOT EXISTS vendas_lote_idx ON vendas (lote_importacao_id);
