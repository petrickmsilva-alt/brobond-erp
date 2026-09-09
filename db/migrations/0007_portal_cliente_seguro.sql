-- Fase 4: acessos aleatórios revogáveis e decisões imutáveis sobre cotações.
CREATE TABLE IF NOT EXISTS portal_acessos (
  id BIGSERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expira_em TIMESTAMPTZ,
  revogado_em TIMESTAMPTZ,
  ultimo_acesso_em TIMESTAMPTZ,
  acessos INTEGER NOT NULL DEFAULT 0 CHECK (acessos >= 0),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_acessos_cliente ON portal_acessos(cliente_id, criado_em DESC);
CREATE TABLE IF NOT EXISTS cotacao_decisoes (
  id BIGSERIAL PRIMARY KEY,
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  decisao TEXT NOT NULL CHECK (decisao IN ('aceitar','recusar','alteracao')),
  responsavel TEXT NOT NULL,
  mensagem TEXT,
  proposta_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cotacao_decisoes_venda ON cotacao_decisoes(venda_id, criado_em DESC);
