-- 0009 — Módulo Usuários, Onda 3:
--   • Bloqueio manual de conta (aplicado pelo administrador, sem prazo)
--   • Códigos de recuperação do MFA (JSON com hashes SHA-256 + uso)
-- Idempotente (IF NOT EXISTS) — pode rodar em bancos novos e existentes.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueio_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mfa_backup_hashes TEXT;

UPDATE usuarios SET bloqueio_manual = FALSE WHERE bloqueio_manual IS NULL;

CREATE INDEX IF NOT EXISTS idx_usuarios_bloqueio_manual ON usuarios (bloqueio_manual) WHERE bloqueio_manual = TRUE;
