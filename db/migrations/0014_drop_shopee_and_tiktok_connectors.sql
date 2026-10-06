-- 0014) DESPROVISIONAMENTO DOS CONECTORES NATIVOS DE SHOPEE E TIKTOK
--
-- Decisão estratégica do Diretor (2026-10-05): os conectores nativos da
-- SHOPEE e do TIKTOK saem do ecossistema por barreiras burocráticas de
-- suas APIs. A NUVEMSHOP assume a triangulação de vendas (incluindo o
-- catálogo do TikTok) como plataforma-ponte do Hub Omnichannel — trio
-- de produção: MERCADOLIVRE · MERCADOPAGO · NUVEMSHOP.
--
-- A ordem importa: primeiro o DELETE limpa TODO registro que carregue
-- 'SHOPEE'/'TIKTOK' (o Postgres recusaria o cast de valor órfão na
-- reescrita do tipo); depois os enums `connector_provider` e
-- `sale_channel` são RECONSTRUÍDOS — o Postgres não tem
-- ALTER TYPE ... DROP VALUE, então o tipo novo (sem SHOPEE/TIKTOK, com
-- NUVEMSHOP) substitui o antigo coluna a coluna.
--
-- Idempotente (dual-track): o MESMO SQL vive em
-- prisma/migrations/20261005150000_drop_shopee_and_tiktok_connectors e o
-- estado final já está espelhado em db/schema.sql (bancos novos nascem
-- com os enums já limpos) — qualquer um dos runners pode chegar primeiro.

-- 1) Registros antigos: conexões, estados CSRF, eventos de webhook e as
--    vendas espelho ingeridas dos canais removidos (itens caem junto —
--    sale_items.sale_id é ON DELETE CASCADE).
-- Os DELETEs comparam em TEXT (provider::text), não em enum: no
-- dual-track a migration roda duas vezes (runner do ERP e `prisma
-- migrate deploy`), e na segunda passada o enum JÁ não contém mais
-- 'SHOPEE'/'TIKTOK' — um literal em enum inexistente abortaria o
-- re-run com "invalid input value for enum".
DELETE FROM connector_oauth_states WHERE provider::text IN ('SHOPEE', 'TIKTOK');
DELETE FROM connector_events       WHERE provider::text IN ('SHOPEE', 'TIKTOK');
DELETE FROM connectors             WHERE provider::text IN ('SHOPEE', 'TIKTOK');
DELETE FROM sales WHERE channel::text IN ('SHOPEE', 'TIKTOK');

-- 2) Enum connector_provider (connectors, connector_events,
--    connector_oauth_states) sem SHOPEE/TIKTOK e com NUVEMSHOP.
DO $$ BEGIN
  CREATE TYPE "connector_provider_novo" AS ENUM ('INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connectors             ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
ALTER TABLE connector_events       ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
ALTER TABLE connector_oauth_states ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
DROP TYPE IF EXISTS "connector_provider";
ALTER TYPE "connector_provider_novo" RENAME TO "connector_provider";

-- 3) Enum sale_channel (sales) sem SHOPEE/TIKTOK e com NUVEMSHOP. O
--    DEFAULT 'BROBOND' sai antes da troca de tipo (o Postgres não
--    converte default automaticamente) e volta logo depois.
DO $$ BEGIN
  CREATE TYPE "sale_channel_novo" AS ENUM ('BROBOND', 'INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sales ALTER COLUMN channel DROP DEFAULT;
ALTER TABLE sales ALTER COLUMN channel TYPE "sale_channel_novo" USING channel::text::"sale_channel_novo";
ALTER TABLE sales ALTER COLUMN channel SET DEFAULT 'BROBOND';
DROP TYPE IF EXISTS "sale_channel";
ALTER TYPE "sale_channel_novo" RENAME TO "sale_channel";
