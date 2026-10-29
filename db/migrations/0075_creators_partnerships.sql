-- Creators e campanhas têm identidade própria. A atribuição referencia o
-- checkout existente; não cria venda, cliente, comissão, caixa ou estoque.
CREATE TABLE IF NOT EXISTS creator_profiles (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  platform TEXT NOT NULL CHECK (platform IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OTHER')),
  handle TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 100),
  niche TEXT CHECK (niche IS NULL OR length(niche) <= 100),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_profiles_handle_uq ON creator_profiles (empresa_id, platform, lower(handle));
CREATE INDEX IF NOT EXISTS creator_profiles_page_idx ON creator_profiles (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS creator_campaigns (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  objective TEXT NOT NULL CHECK (length(trim(objective)) BETWEEN 8 AND 500),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK (ends_on >= starts_on),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS creator_campaigns_page_idx ON creator_campaigns (empresa_id, status, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_cupons_empresa_id_uq ON commerce_cupons (empresa_id, id);
CREATE TABLE IF NOT EXISTS creator_partnerships (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  creator_id BIGINT NOT NULL,
  campaign_id BIGINT NOT NULL,
  coupon_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'ACTIVE', 'PAUSED', 'ENDED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by INTEGER REFERENCES usuarios(id),
  updated_by INTEGER REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, creator_id, campaign_id),
  FOREIGN KEY (empresa_id, creator_id) REFERENCES creator_profiles (empresa_id, id),
  FOREIGN KEY (empresa_id, campaign_id) REFERENCES creator_campaigns (empresa_id, id),
  FOREIGN KEY (empresa_id, coupon_id) REFERENCES commerce_cupons (empresa_id, id)
);
-- Um cupom não pode ser transferido para outra parceria, inclusive após fim:
-- assim as atribuições históricas não mudam de dono.
CREATE UNIQUE INDEX IF NOT EXISTS creator_partnerships_coupon_uq ON creator_partnerships (empresa_id, coupon_id) WHERE coupon_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS creator_partnerships_page_idx ON creator_partnerships (empresa_id, status, id DESC);

CREATE TABLE IF NOT EXISTS creator_attributions (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  partnership_id BIGINT NOT NULL,
  order_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, order_id),
  FOREIGN KEY (empresa_id, partnership_id) REFERENCES creator_partnerships (empresa_id, id),
  FOREIGN KEY (empresa_id, order_id) REFERENCES commerce_pedidos (empresa_id, id)
);
CREATE INDEX IF NOT EXISTS creator_attributions_page_idx ON creator_attributions (empresa_id, partnership_id, id DESC);

CREATE TABLE IF NOT EXISTS creator_commands (
  id BIGSERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  entity TEXT NOT NULL CHECK (entity IN ('profile', 'campaign', 'partnership')),
  entity_id BIGINT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES usuarios(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, idempotency_key)
);
