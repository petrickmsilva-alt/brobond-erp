-- ============================================================================
-- 0094 — STOREFRONT ENTERPRISE (loja própria /loja/*)
--
-- Migração INCREMENTAL, idempotente e aplicada pela cadeia versionada
-- (server/src/db.ts → aplicarMigrationsVersionadas). Nenhuma linha existente
-- é apagada, renomeada ou alterada em silêncio; todo DDL é ADD/IF NOT EXISTS.
--
-- Reaproveita estruturas existentes: `arquivos` (galeria), `commerce_outbox`
-- (fila), `commerce_pedidos.comprador` (contato), `gateway_cobrancas`
-- (cobrança PIX). NÃO cria segunda loja, segundo checkout, segundo pedido,
-- segundo estoque, segundo ledger ou segunda integração com Mercado Pago.
--
-- Rollback: as colunas/tabela/índices são ADITIVOS — para reverter é preciso
-- confirmar ausência de dados antes de qualquer DROP COLUMN/DROP TABLE
-- (destrutivo), por isso NENHUM DROP destrutivo é executado aqui.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Galeria profissional: alt text, ativação e mídia por variação
--    (em bancos novos estas colunas já nascem em db/bootstrap.sql).
-- ---------------------------------------------------------------------------
ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS alt_text TEXT;
ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE arquivos ADD COLUMN IF NOT EXISTS variante_id INTEGER REFERENCES tamanhos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_arquivos_galeria
  ON arquivos (recurso, registro_id, ativo, principal DESC, ordem ASC, id ASC);
CREATE INDEX IF NOT EXISTS ix_arquivos_variante
  ON arquivos (recurso, registro_id, variante_id) WHERE variante_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) NOTIFICATION ORCHESTRATOR — 1 linha por evento/canal/destinatário.
--    UNIQUE (empresa_id, chave_idempotencia) impede reenvio em webhook
--    duplicado. Marketing NÃO vive aqui (consentimento separado no pedido).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_notificacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  pedido_id INTEGER REFERENCES commerce_pedidos(id) ON DELETE SET NULL,
  evento TEXT NOT NULL,
  CONSTRAINT commerce_notificacoes_evento_ck CHECK (evento IN (
    'ORDER_CREATED', 'PIX_GENERATED', 'PAYMENT_PENDING', 'PAYMENT_APPROVED',
    'PAYMENT_REJECTED',
    'ORDER_PROCESSING', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED'
  )),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_notificacoes_canal_ck CHECK (canal IN ('EMAIL', 'WHATSAPP')),
  destinatario TEXT NOT NULL,
  template TEXT,
  estado TEXT NOT NULL DEFAULT 'PENDENTE',
  CONSTRAINT commerce_notificacoes_estado_ck CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'ENVIADO', 'ERRO', 'IGNORADO')),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro TEXT,
  chave_idempotencia TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ,
  CONSTRAINT uq_commerce_notificacoes_idempotencia UNIQUE (empresa_id, chave_idempotencia)
);
CREATE INDEX IF NOT EXISTS ix_commerce_notificacoes_fila
  ON commerce_notificacoes (empresa_id, estado, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_notificacoes_pedido
  ON commerce_notificacoes (empresa_id, pedido_id, evento);

-- ---------------------------------------------------------------------------
-- 3) NENHUMA alteração no `commerce_outbox` (sem DROP CONSTRAINT aqui).
--    Motivo técnico REAL (confirmado em PostgreSQL): a migração 0090, quando a
--    cadeia é reaplicada num banco com dados (drift/recovery), executa
--    DROP + ADD de `commerce_outbox_tipo_ck` com um conjunto MAIS ESTREITO.
--    Um tipo novo (`notificacao`) faria esse ADD falhar com
--    "check constraint ... is violated by some row" e degradaria o ERP.
--    Os eventos de comunicação usam `sincronizacao` + payload.acao, valor já
--    aceito por 0068 E por 0090 — sem editar migration aplicada e sem perder
--    a semântica DOMAIN EVENT → OUTBOX → NOTIFICATION ORCHESTRATOR.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4) Point lookup por slug e leitura de catálogo/categoria sem varredura
--    completa. Nenhum dado é alterado.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_commerce_produtos_empresa_slug_lower
  ON commerce_produtos (empresa_id, lower(slug));
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_canal_estado
  ON commerce_publicacoes (empresa_id, canal, estado, produto_id);
CREATE INDEX IF NOT EXISTS ix_produtos_categoria_ativo
  ON produtos (empresa_id, categoria_id, ativo) WHERE categoria_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) PIX via Orders API: ticket_url REAL devolvido pelo provedor. Cobranças
--    legadas permanecem NULL (a tela omite o link, nunca fabrica um).
-- ---------------------------------------------------------------------------
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS ticket_url TEXT;
COMMENT ON COLUMN gateway_cobrancas.ticket_url IS 'ticket_url real retornado pelo provedor (Orders API); NULL para cobranças legadas';
