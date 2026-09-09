-- Fase 3B: capacidades comerciais por usuário (herdar/permitir/negar) e alçadas.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_catalogos TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_catalogos IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_compartilhar TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_compartilhar IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_metricas TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_metricas IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_politicas TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_politicas IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_aprovar TEXT NOT NULL DEFAULT 'herdar' CHECK (perm_aprovar IN ('herdar','permitir','negar'));
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS desconto_max_pct NUMERIC(5,2) CHECK (desconto_max_pct IS NULL OR desconto_max_pct BETWEEN 0 AND 100);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS venda_sem_aprovacao_ate NUMERIC(12,2) CHECK (venda_sem_aprovacao_ate IS NULL OR venda_sem_aprovacao_ate >= 0);
