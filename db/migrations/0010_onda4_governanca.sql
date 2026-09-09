-- 0010 — Governança de acesso (Onda 4):
--   • usuarios.senha_historico: JSON com hashes das últimas senhas (política de
--     histórico — impede reutilização). Nunca sai pela API.
--   • usuarios.acesso_certificado_*: carimbo da certificação de acessos
--     (quem revisou o acesso, quando, com qual observação).
--   • configuracoes: chave→valor (política de senha configurável, etc.).
--   • webhooks + webhook_entregas: integrações de eventos de usuário.
-- Idempotente (IF NOT EXISTS) — pode rodar em bancos novos e existentes.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_historico TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_por TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_certificado_obs TEXT;

CREATE TABLE IF NOT EXISTS configuracoes (
  id SERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,
  valor TEXT NOT NULL DEFAULT '',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT NOT NULL,
  segredo_cifrado TEXT,
  eventos TEXT NOT NULL DEFAULT '[]',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_entregas (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'erro',
  tentativas INTEGER NOT NULL DEFAULT 1,
  resposta_status INTEGER,
  resposta_corpo TEXT,
  erro TEXT,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webhook_entregas_webhook ON webhook_entregas (webhook_id, id DESC);

UPDATE usuarios SET senha_historico = NULL WHERE senha_historico = '';
