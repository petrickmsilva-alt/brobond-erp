-- 0008 — Módulo Usuários profissional (ERP):
--   • Dados cadastrais: cargo, departamento, telefone, observações
--   • Ciclo de vida: bloqueio temporário, expiração de acesso, trilha de desativação
--   • Segurança: tentativas falhas por usuário, último IP, auditoria de origem
-- Idempotente (IF NOT EXISTS) — pode rodar em bancos novos e existentes.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cargo TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS departamento TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS observacoes TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_ate TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tentativas_falhas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_falha_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_ip TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acesso_expira_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_por INTEGER;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_por TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_em TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desativado_motivo TEXT;

-- Normaliza registros antigos
UPDATE usuarios SET tentativas_falhas = 0 WHERE tentativas_falhas IS NULL;

-- Índices operacionais do módulo
CREATE INDEX IF NOT EXISTS idx_usuarios_ativo ON usuarios (ativo);
CREATE INDEX IF NOT EXISTS idx_usuarios_perfil ON usuarios (perfil);
CREATE INDEX IF NOT EXISTS idx_usuarios_bloqueado ON usuarios (bloqueado_ate) WHERE bloqueado_ate IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_convite ON usuarios (convite_expira_em) WHERE convite_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_ultimo_login ON usuarios (ultimo_login DESC NULLS LAST);
