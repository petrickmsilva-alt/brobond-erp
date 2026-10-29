-- ============================================================================
-- 0068 — BROBOND COMMERCE OS (GO-LIVE): catálogo multicanal, publicação,
--        pedidos omnichannel, checkout B2C, promoções, frete, outbox e rastreio.
--
-- PRINCÍPIOS (nunca mudar):
--   • ESTOQUE: NÃO existe um segundo motor. Reservas continuam em
--     `estoque_reservas` (origem_recurso = 'commerce_checkout'); disponibilidade
--     segue sendo físico − reservado − empenhado − bloqueado.
--   • VENDAS: o checkout cria a linha analítica `sales` (+ `sale_items` com
--     produto já casado) e a conversão para `vendas` reusa a ponte idempotente
--     (empresa + canal + pedido externo). Esta migration NÃO cria tabelas de
--     venda paralelas — `commerce_pedidos` é só PROJEÇÃO de estado.
--   • PAGAMENTO: a cobrança viva do gateway é `gateway_cobrancas` (webhook
--     assinado + idempotente). Aqui guardamos apenas o vínculo e o estado
--     projetado do checkout.
--   • PREÇO: `produtos.preco_venda` continua sendo a base; `commerce_precos`
--     só acrescenta preço POR CANAL com vigência.
--   • TENANCY: toda tabela nova tem `empresa_id` explícito + índice de
--     escopo; nenhuma leitura sai do tenant do ator.
--
-- Nenhuma tabela histórica é alterada aqui além de índices de apoio.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Configuração da loja própria (1 linha por empresa): frete (FreightProvider),
-- dono do checkout (sales.usuario_id NOT NULL) e expiração do carrinho.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_configuracoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL UNIQUE REFERENCES empresas(id),
  loja_nome TEXT,
  loja_descricao TEXT,
  frete_provedor TEXT NOT NULL DEFAULT 'nenhum',
  CONSTRAINT commerce_frete_provedor_ck CHECK (frete_provedor IN ('nenhum', 'retirada', 'manual')),
  frete_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (frete_valor >= 0),
  frete_gratis_acima NUMERIC(12,2) CHECK (frete_gratis_acima IS NULL OR frete_gratis_acima >= 0),
  frete_prazo_dias INTEGER CHECK (frete_prazo_dias IS NULL OR frete_prazo_dias >= 0),
  checkout_usuario_id INTEGER REFERENCES usuarios(id),
  checkout_expira_minutos INTEGER NOT NULL DEFAULT 60 CHECK (checkout_expira_minutos >= 5 AND checkout_expira_minutos <= 1440),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commerce_configuracoes_empresa ON commerce_configuracoes (empresa_id);

-- ----------------------------------------------------------------------------
-- Projeção de catálogo da vitrine própria. O conteúdo longo continua em
-- `produtos` (descricao/destaque são do cadastro canônico) — aqui só mora o
-- que é da VITRINE: slug público, resumo curto e ordenação.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_produtos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  slug TEXT NOT NULL,
  resumo TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  -- Metadados por canal da VITRINE (ex.: ml_category_id exigido pelo Mercado
  -- Livre na criação do anúncio). JSONB: o servidor nunca inventa esses IDs.
  canal_metadados JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_produtos_produto UNIQUE (empresa_id, produto_id),
  CONSTRAINT uq_commerce_produtos_slug UNIQUE (empresa_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_commerce_produtos_empresa ON commerce_produtos (empresa_id, ordem);

-- ----------------------------------------------------------------------------
-- Preço por canal (sobre a base `produtos.preco_venda`). Vigência opcional;
-- sem linha vigente, o preço efetivo é o de tabela do produto.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_precos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_precos_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  preco NUMERIC(12,2) NOT NULL CHECK (preco >= 0),
  preco_promo NUMERIC(12,2) CHECK (preco_promo IS NULL OR preco_promo >= 0),
  vigencia_inicio DATE,
  vigencia_fim DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_precos UNIQUE (empresa_id, produto_id, canal)
);
CREATE INDEX IF NOT EXISTS ix_commerce_precos_empresa ON commerce_precos (empresa_id, canal);

-- ----------------------------------------------------------------------------
-- FILA DE PUBLICAÇÃO multicanal — máquina de estados + idempotência
-- (empresa + produto + canal + versão). PUBLISHED só após confirmação da
-- API externa (ou da própria vitrine, no canal BROBOND). Nunca fake.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_publicacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_publicacoes_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  versao INTEGER NOT NULL CHECK (versao >= 1),
  estado TEXT NOT NULL DEFAULT 'DRAFT',
  CONSTRAINT commerce_publicacoes_estado_ck CHECK (estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'UPDATE_QUEUED', 'ERROR', 'REJECTED', 'UNPUBLISHED')),
  payload JSONB,
  payload_hash TEXT,
  external_id TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro TEXT,
  proxima_tentativa_em TIMESTAMPTZ,
  publicado_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_publicacoes_versao UNIQUE (empresa_id, produto_id, canal, versao)
);
-- UMA linha no pipeline ativo por (empresa, produto, canal): enfileirar de
-- novo com a mesma versão é idempotente; versão nova é história.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_publicacoes_ativa
  ON commerce_publicacoes (empresa_id, produto_id, canal)
  WHERE estado IN ('DRAFT', 'READY', 'QUEUED', 'PUBLISHING', 'UPDATE_QUEUED');
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_empresa_estado ON commerce_publicacoes (empresa_id, estado, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_publicacoes_retry ON commerce_publicacoes (proxima_tentativa_em)
  WHERE estado IN ('ERROR', 'READY', 'QUEUED', 'UPDATE_QUEUED');

-- ----------------------------------------------------------------------------
-- PROJEÇÃO DE PEDIDOS OMNICHANNEL (checkout próprio + canais). Não é segunda
-- fonte de verdade: `sales` (analítico) e `vendas` (operacional) continuam
-- mandando; esta tabela guarda o que só o checkout precisa — token público,
-- endereço, vínculo da cobrança e a máquina de estados de pós-venda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_pedidos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  canal TEXT NOT NULL,
  CONSTRAINT commerce_pedidos_canal_ck CHECK (canal IN ('BROBOND', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP', 'WOOCOMMERCE', 'INSTAGRAM_SHOPPING')),
  pedido_externo TEXT NOT NULL,
  sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  cobranca_id INTEGER REFERENCES gateway_cobrancas(id) ON DELETE SET NULL,
  checkout_token TEXT UNIQUE,
  chave_checkout TEXT,
  estado TEXT NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',
  CONSTRAINT commerce_pedidos_estado_ck CHECK (estado IN ('AGUARDANDO_PAGAMENTO', 'PAGAMENTO_AUTORIZADO', 'PAGO', 'AGUARDANDO_CORRECAO', 'CONVERTIDO', 'CANCELADO', 'EXPIRADO', 'ESTORNADO', 'ERRO')),
  pagamento_estado TEXT,
  CONSTRAINT commerce_pedidos_pagamento_ck CHECK (pagamento_estado IS NULL OR pagamento_estado IN ('PENDING', 'AUTHORIZED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'CHARGEBACK', 'EXPIRED')),
  frete_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (frete_valor >= 0),
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0),
  cupom_codigo TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  comprador JSONB,
  endereco JSONB,
  expira_em TIMESTAMPTZ,
  pago_em TIMESTAMPTZ,
  convertido_em TIMESTAMPTZ,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_pedidos_externo UNIQUE (empresa_id, canal, pedido_externo)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_pedidos_chave ON commerce_pedidos (empresa_id, chave_checkout)
  WHERE chave_checkout IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_empresa_estado ON commerce_pedidos (empresa_id, estado, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_sale ON commerce_pedidos (empresa_id, sale_id);
CREATE INDEX IF NOT EXISTS ix_commerce_pedidos_cobranca ON commerce_pedidos (cobranca_id);

-- ----------------------------------------------------------------------------
-- OUTBOX — fila de sincronização/aténtação (at-least-once, chave única por
-- empresa + tipo + chave). Conversão, publicação e pushes de canal passam por
-- aqui quando o processamento imediato falha — nunca somem, nunca duplicam.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_outbox (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_outbox_tipo_ck CHECK (tipo IN ('conversao', 'publicacao', 'sincronizacao', 'alerta')),
  chave TEXT NOT NULL,
  payload JSONB,
  estado TEXT NOT NULL DEFAULT 'PENDENTE',
  CONSTRAINT commerce_outbox_estado_ck CHECK (estado IN ('PENDENTE', 'PROCESSANDO', 'PROCESSADO', 'ERRO')),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro TEXT,
  proxima_tentativa_em TIMESTAMPTZ,
  processado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_outbox_chave UNIQUE (empresa_id, tipo, chave)
);
CREATE INDEX IF NOT EXISTS ix_commerce_outbox_fila ON commerce_outbox (estado, proxima_tentativa_em);

-- ----------------------------------------------------------------------------
-- Promoções e cupons (vitrine própria). Cálculo é função pura do servidor
-- (server/src/commerce/regras.ts) — aqui só vive o cadastro + contadores.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_promocoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_promocoes_tipo_ck CHECK (tipo IN ('percentual', 'valor')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  minimo_pedido NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (minimo_pedido >= 0),
  data_inicio DATE NOT NULL,
  data_fim DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_commerce_promocoes_empresa ON commerce_promocoes (empresa_id, ativo);

CREATE TABLE IF NOT EXISTS commerce_cupons (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  tipo TEXT NOT NULL,
  CONSTRAINT commerce_cupons_tipo_ck CHECK (tipo IN ('percentual', 'valor')),
  valor NUMERIC(12,2) NOT NULL CHECK (valor >= 0),
  minimo_pedido NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (minimo_pedido >= 0),
  uso_maximo INTEGER CHECK (uso_maximo IS NULL OR uso_maximo >= 1),
  uso_atual INTEGER NOT NULL DEFAULT 0 CHECK (uso_atual >= 0),
  validade DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_cupons_codigo UNIQUE (empresa_id, codigo)
);
CREATE INDEX IF NOT EXISTS ix_commerce_cupons_empresa ON commerce_cupons (empresa_id, ativo);

-- ----------------------------------------------------------------------------
-- Rastreio/entrega (projeção da entrega; a expedição canônica continua em
-- `vendas.expedicao_etapa` — vocabulário da migration 0032).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_rastreio (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  transportadora TEXT,
  codigo TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'postado',
  CONSTRAINT commerce_rastreio_status_ck CHECK (status IN ('postado', 'em_transito', 'saiu_entrega', 'entregue', 'devolvido', 'extraviado')),
  estimativa_em DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_commerce_rastreio_venda UNIQUE (empresa_id, venda_id)
);
CREATE INDEX IF NOT EXISTS ix_commerce_rastreio_empresa_status ON commerce_rastreio (empresa_id, status);

-- ----------------------------------------------------------------------------
-- Reservas do checkout: idempotência para o motor EXISTENTE de reservas.
-- Uma reserva ativa por (origem de checkout, produto, tamanho, local) —
-- dois checkouts concorrentes do último SKU não criam duas reservas.
-- (`estoque_reservas` já existe; só ganha a trava de idempotência aqui.)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_reservas_checkout
  ON estoque_reservas (origem_recurso, origem_id, produto_id, COALESCE(tamanho_id, 0), COALESCE(local_id, 0))
  WHERE origem_recurso = 'commerce_checkout' AND status = 'ativa';
