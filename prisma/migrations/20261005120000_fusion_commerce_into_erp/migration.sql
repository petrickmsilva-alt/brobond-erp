-- ==================================================================
-- FUSÃO COMMERCE → ERP — Fase 1 (Brobond AI ERP)
-- Migration Prisma: fusion_commerce_into_erp
-- ==================================================================
--
-- Injeta no banco do ERP os objetos core do motor comercial do
-- brobond-ai-commerce (modelos Connector, ConnectorEvent,
-- ConnectorOAuthState, Sale, SaleItem e os enums ConnectionStatus,
-- SaleChannel, ConnectorProvider, SaleStatus), ligados por FK à
-- tabela de usuários do ERP (usuarios) e ao catálogo (produtos,
-- tamanhos).
--
-- CONTRATO DUAL-TRACK (idempotente de propósito):
--   • Este MESMO SQL vive em db/migrations/0012_fusion_commerce_into_erp.sql
--     e é espelhado em db/schema.sql — o boot do ERP (server/src/db.ts)
--     aplica qualquer um dos caminhos primeiro; o segundo converte em
--     no-op. `prisma migrate deploy` registra esta migration em
--     _prisma_migrations; o runner do ERP, em schema_migrations.
--   • Este arquivo cria APENAS objetos novos: nenhuma tabela, coluna
--     ou índice do ERP é alterado. Em particular, `usuarios` NÃO é
--     tocada — o middleware de login permanece intacto.
--
-- TENANCY: no commerce os registros pertenciam a uma Organization; no
-- ERP a âncora é `usuarios` (single-company). Ações ON DELETE:
--   • RESTRICT em Connector/Sale/ConnectorEvent → usuarios
--     (registros de negócio sobrevivem; usuário ERP desativa, não
--     apaga). DELETE acidental em usuarios é bloqueado.
--   • CASCADE em ConnectorOAuthState → usuarios (estado CSRF efêmero).
--   • CASCADE  SaleItem → Sale (item morre com a venda — igual a
--     itens_venda.venda_id).
--   • SET NULL  SaleItem → produtos/tamanhos e ConnectorEvent →
--     Connector (histórico sobrevive à exclusão do catálogo/conector).
-- ==================================================================

-- ------------------------------------------------------------------
-- ENUMS (tipos snake_case, coerentes com o padrão do banco do ERP;
-- @@map no prisma/schema.prisma aponta para estes nomes)
-- ------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "sale_status" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sale_channel" AS ENUM ('BROBOND', 'TIKTOK', 'INSTAGRAM', 'SHOPEE', 'MERCADOLIVRE', 'MERCADOPAGO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "connector_provider" AS ENUM ('TIKTOK', 'INSTAGRAM', 'SHOPEE', 'MERCADOLIVRE', 'MERCADOPAGO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "connection_status" AS ENUM (
    'DISCONNECTED', 'CONNECTED', 'EXPIRED', 'ERROR',
    'PENDING_APPROVAL', 'REAUTH_REQUIRED', 'SANDBOX_ACTIVE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------
-- CONECTORES MULTICANAL
-- ------------------------------------------------------------------

-- Uma integração ativa com marketplace/meio de pagamento
-- (TikTok Shop, Instagram Shopping, Shopee, Mercado Livre, Mercado Pago).
-- Credenciais SEMPRE cifradas em AES-256-GCM (CONNECTOR_ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,                       -- cuid() gerado pelo Prisma
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  provider "connector_provider" NOT NULL,
  status "connection_status" NOT NULL DEFAULT 'DISCONNECTED',
  shop_id TEXT,                              -- id no provedor (shop/conta/coletor)
  shop_name TEXT,
  access_token TEXT,                         -- cifra AES-256-GCM v1.iv.tag.valor
  refresh_token TEXT,                        -- cifra AES-256-GCM
  client_secret TEXT,                        -- cifra AES-256-GCM
  public_key TEXT,                           -- MP public key (cifrada)
  expires_at TIMESTAMPTZ,
  imported_count INTEGER NOT NULL DEFAULT 0, -- KPIs reais de sincronização
  duplicated_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  sync_count INTEGER NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB,                            -- extras não-secretos do provedor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- @updatedAt + default p/ SQL manual
);

-- Um conector por provedor por responsável (contrato do commerce).
CREATE UNIQUE INDEX IF NOT EXISTS connectors_usuario_id_provider_key
  ON connectors (usuario_id, provider);
CREATE INDEX IF NOT EXISTS connectors_usuario_id_status_idx
  ON connectors (usuario_id, status);
CREATE INDEX IF NOT EXISTS connectors_provider_shop_id_idx
  ON connectors (provider, shop_id);

-- Evento bruto ingerido (webhook/polling) com deduplicação por
-- (responsável, provedor, id externo). Sobrevive à exclusão do
-- conector (SET NULL) como trilha de ingestão.
CREATE TABLE IF NOT EXISTS connector_events (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
  provider "connector_provider" NOT NULL,
  external_event_id TEXT NOT NULL,
  topic TEXT,
  payload JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_events_usuario_id_provider_external_event_id_key
  ON connector_events (usuario_id, provider, external_event_id);
CREATE INDEX IF NOT EXISTS connector_events_usuario_id_provider_created_at_idx
  ON connector_events (usuario_id, provider, created_at);
CREATE INDEX IF NOT EXISTS connector_events_connector_id_idx
  ON connector_events (connector_id);

-- Estado CSRF do fluxo OAuth de conexão (SHA-256 do state; expira em
-- minutos). Dado efêmero: CASCADE com o usuário.
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  provider "connector_provider" NOT NULL,
  state_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_oauth_states_state_hash_key
  ON connector_oauth_states (state_hash);
CREATE INDEX IF NOT EXISTS connector_oauth_states_usuario_id_provider_expires_at_idx
  ON connector_oauth_states (usuario_id, provider, expires_at);

-- ------------------------------------------------------------------
-- VENDAS MULTICANAL
-- ------------------------------------------------------------------

-- Receita originada em qualquer canal (loja própria, Shopee, Mercado
-- Livre, Mercado Pago, TikTok Shop, Instagram). Valores em CENTAVOS
-- (convenção do motor financeiro do commerce — Int, sem erro de
-- ponto flutuante). A venda do ERP B2B/offline continua em `vendas`;
-- `sales` é o lado multicanal sincronizado pelos conectores.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,                       -- cuid()
  reference TEXT NOT NULL,                   -- id canônico (checkout próprio)
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status "sale_status" NOT NULL DEFAULT 'PENDING',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel "sale_channel" NOT NULL DEFAULT 'BROBOND',
  external_order_id TEXT,                    -- id do pedido no marketplace
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_reference_key
  ON sales (reference);
-- Idempotência da ingestão: uma linha por (responsável, canal, pedido
-- externo). NULLs são distintos no Postgres → checkout próprio fora
-- da chave.
CREATE UNIQUE INDEX IF NOT EXISTS sales_usuario_id_channel_external_order_id_key
  ON sales (usuario_id, channel, external_order_id);
CREATE INDEX IF NOT EXISTS sales_status_idx ON sales (status);
CREATE INDEX IF NOT EXISTS sales_usuario_id_idx ON sales (usuario_id);
CREATE INDEX IF NOT EXISTS sales_usuario_id_status_idx ON sales (usuario_id, status);
CREATE INDEX IF NOT EXISTS sales_usuario_id_channel_idx ON sales (usuario_id, channel);
CREATE INDEX IF NOT EXISTS sales_channel_occurred_at_idx ON sales (channel, occurred_at);

-- Item da venda multicanal, casado com o catálogo REAL do ERP
-- (produtos + tamanhos) — espelha a semântica de itens_venda.
CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  size_id INTEGER REFERENCES tamanhos(id) ON DELETE SET NULL,
  variacao_externa TEXT,                     -- variante literal do marketplace
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product_id_idx ON sale_items (product_id);
CREATE INDEX IF NOT EXISTS sale_items_size_id_idx ON sale_items (size_id);
