-- Fase 2: compartilhamentos individualizados e eventos comerciais.
CREATE TABLE IF NOT EXISTS catalogo_compartilhamentos (
  id BIGSERIAL PRIMARY KEY,
  catalogo_id INTEGER NOT NULL REFERENCES catalogos(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  canal TEXT NOT NULL DEFAULT 'link',
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  primeiro_acesso_em TIMESTAMPTZ,
  ultimo_acesso_em TIMESTAMPTZ,
  acessos INTEGER NOT NULL DEFAULT 0 CHECK (acessos >= 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalogo_comp_catalogo ON catalogo_compartilhamentos(catalogo_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_catalogo_comp_cliente ON catalogo_compartilhamentos(cliente_id, criado_em DESC);
CREATE TABLE IF NOT EXISTS catalogo_eventos (
  id BIGSERIAL PRIMARY KEY,
  compartilhamento_id BIGINT REFERENCES catalogo_compartilhamentos(id) ON DELETE CASCADE,
  catalogo_id INTEGER NOT NULL REFERENCES catalogos(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('abertura','produto_visualizado','carrinho_iniciado','pedido_enviado')),
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalogo_eventos_funil ON catalogo_eventos(catalogo_id, tipo, criado_em DESC);
