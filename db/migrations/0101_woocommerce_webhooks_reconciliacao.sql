-- 0101 — WOOCOMMERCE MULTI-STORE: WEBHOOKS, IDEMPOTÊNCIA E RECONCILIAÇÃO
--
-- Evolução da migration 0100. Duas estruturas novas, ambas aditivas:
--
--   1) woocommerce_webhook_events — INBOX durável de entregas recebidas das
--      lojas RETAIL e WHOLESALE. Guarda a entrega de forma IDEMPOTENTE (por
--      loja), o tópico, o recurso externo, o hash do corpo CRU e o estado do
--      processamento. NÃO é uma segunda fila de execução: quem processa é o
--      `commerce_outbox` de sempre (ação `woo-webhook`); o inbox é o registro
--      durável + o mecanismo de recuperação de eventos perdidos/presos.
--
--   2) woocommerce_reconciliacao_divergencias — divergências detectadas entre
--      o ERP e cada loja (catálogo, preços, estoque e pedidos), com a
--      CLASSIFICAÇÃO que decide o destino: legítima, corrigível
--      automaticamente ou de intervenção humana. A `fingerprint` dá a
--      identidade lógica da divergência entre execuções (reabre se voltar,
--      fecha quando deixa de ser detectada).
--
-- Aditiva e não destrutiva: nenhum DROP de tabela histórica, nenhum DELETE,
-- nenhum backfill silencioso. `payload` guarda o corpo MINIMIZADO (dados
-- pessoais de pedido são descartados na recepção — ver webhookSeguranca.ts).
--
-- Rollback (manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS woocommerce_reconciliacao_divergencias;
--   DROP TABLE IF EXISTS woocommerce_webhook_events;
--   DELETE FROM schema_migrations WHERE id = '0101_woocommerce_webhooks_reconciliacao.sql';
--   COMMIT;

-- ----------------------------------------------------------------------------
-- 1) INBOX DE WEBHOOKS POR LOJA
--
-- A entrega é identificada por (empresa, loja, delivery_id) quando a loja
-- fornece o ID de entrega; sem ele, a dedupe alternativa é
-- (empresa, loja, tópico, recurso externo, hash do corpo) — documentada e sem
-- descartar atualizações legítimas (um corpo diferente = um evento novo).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS woocommerce_webhook_events (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT NOT NULL,
  CONSTRAINT woocommerce_webhook_events_store_ck CHECK (store_key IN ('RETAIL', 'WHOLESALE')),
  topic TEXT NOT NULL,
  recurso TEXT NOT NULL,
  external_delivery_id TEXT,
  external_resource_id TEXT,
  payload JSONB,
  payload_hash TEXT NOT NULL,
  assinatura_ok BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'recebido',
  CONSTRAINT woocommerce_webhook_events_status_ck
    CHECK (status IN ('recebido', 'enfileirado', 'processado', 'erro', 'rejeitado', 'duplicado')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outbox_id INTEGER,
  correlation_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotência FORTE quando a loja informa o ID de entrega.
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_webhook_delivery
  ON woocommerce_webhook_events (empresa_id, store_key, external_delivery_id)
  WHERE external_delivery_id IS NOT NULL;
-- Dedupe ALTERNATIVA quando não há ID de entrega: corpo idêntico do mesmo
-- tópico/recurso na mesma loja é a MESMA entrega reentregue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_webhook_dedupe
  ON woocommerce_webhook_events (empresa_id, store_key, topic, external_resource_id, payload_hash)
  WHERE external_delivery_id IS NULL;
-- Leitura do painel e do worker por loja e estado.
CREATE INDEX IF NOT EXISTS ix_woo_webhook_loja_status
  ON woocommerce_webhook_events (empresa_id, store_key, status, received_at DESC);
-- Recuperação de eventos presos (recebidos mas nunca enfileirados).
CREATE INDEX IF NOT EXISTS ix_woo_webhook_pendentes
  ON woocommerce_webhook_events (status, received_at) WHERE status IN ('recebido', 'enfileirado');
CREATE INDEX IF NOT EXISTS ix_woo_webhook_recurso
  ON woocommerce_webhook_events (empresa_id, store_key, external_resource_id) WHERE external_resource_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) DIVERGÊNCIAS DE RECONCILIAÇÃO POR LOJA
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS woocommerce_reconciliacao_divergencias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  store_key TEXT NOT NULL,
  CONSTRAINT woocommerce_reconciliacao_store_ck CHECK (store_key IN ('RETAIL', 'WHOLESALE')),
  categoria TEXT NOT NULL,
  CONSTRAINT woocommerce_reconciliacao_categoria_ck
    CHECK (categoria IN ('CATALOGO', 'PRECO', 'ESTOQUE', 'PEDIDOS')),
  tipo TEXT NOT NULL,
  classificacao TEXT NOT NULL,
  CONSTRAINT woocommerce_reconciliacao_classificacao_ck
    CHECK (classificacao IN ('LEGITIMA', 'AUTOMATICA', 'HUMANA')),
  produto_id INTEGER,
  sku TEXT,
  external_product_id TEXT,
  external_variation_id TEXT,
  pedido_ref TEXT,
  detalhe TEXT NOT NULL,
  dados JSONB,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ABERTA',
  CONSTRAINT woocommerce_reconciliacao_status_ck CHECK (status IN ('ABERTA', 'CORRIGIDA', 'IGNORADA')),
  resolucao TEXT,
  detectada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma divergência por identidade lógica (empresa, loja, fingerprint).
CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_divergencia_fingerprint
  ON woocommerce_reconciliacao_divergencias (empresa_id, store_key, fingerprint);
CREATE INDEX IF NOT EXISTS ix_woo_divergencia_aberta
  ON woocommerce_reconciliacao_divergencias (empresa_id, store_key, categoria, status, detectada_em DESC);
CREATE INDEX IF NOT EXISTS ix_woo_divergencia_produto
  ON woocommerce_reconciliacao_divergencias (empresa_id, store_key, produto_id) WHERE produto_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) ÚLTIMA RECONCILIAÇÃO POR LOJA (água-marca operacional do painel)
-- ----------------------------------------------------------------------------
ALTER TABLE woocommerce_sync_state ADD COLUMN IF NOT EXISTS ultima_reconciliacao_em TIMESTAMPTZ;
