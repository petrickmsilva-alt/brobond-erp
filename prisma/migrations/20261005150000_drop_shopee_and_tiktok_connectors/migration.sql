-- ==================================================================
-- DESPROVISIONAMENTO DOS CONECTORES NATIVOS DE SHOPEE E TIKTOK
-- Migration Prisma: drop_shopee_and_tiktok_connectors
-- ==================================================================
--
-- DECISÃO ESTRATÉGICA DO DIRETOR (2026-10-05): os conectores nativos
-- da SHOPEE e do TIKTOK saem do ecossistema — as barreiras
-- burocráticas de suas APIs inviabilizam a manutenção. O Hub
-- Omnichannel passa a usar a NUVEMSHOP como plataforma-ponte para a
-- triangulação de vendas (incluindo o catálogo do TikTok), formando o
-- trio de produção MERCADOLIVRE · MERCADOPAGO · NUVEMSHOP.
--
-- CONTRATO DESTA MIGRATION (A ORDEM IMPORTA):
--   1. DELETE dos registros antigos PRIMEIRO — nenhuma linha pode
--      carregar 'SHOPEE'/'TIKTOK' no instante em que os tipos enum
--      forem reescritos (o cast do Postgres recusaria o valor órfão e
--      travaria a migration no meio do caminho);
--   2. RECONSTRUÇÃO dos tipos enum `connector_provider` e
--      `sale_channel` DEPOIS: o PostgreSQL não possui
--      `ALTER TYPE ... DROP VALUE`, então cada tipo é recriado sem
--      SHOPEE/TIKTOK (e já com NUVEMSHOP), as colunas migram para o
--      tipo novo e o tipo antigo é descartado.
--
-- Idempotente (dual-track): o MESMO SQL vive em
-- db/migrations/0014_drop_shopee_and_tiktok_connectors.sql e o estado
-- final já está espelhado em db/schema.sql (bancos novos nascem com os
-- enums já limpos). Qualquer um dos runners pode chegar primeiro; o
-- segundo converte em no-op. `prisma migrate deploy` registra esta
-- migration em _prisma_migrations; o runner do ERP, em
-- schema_migrations.
-- ==================================================================

-- ------------------------------------------------------------------
-- 1) LIMPEZA DOS REGISTROS ANTIGOS (ANTES de alterar os enums)
-- ------------------------------------------------------------------

-- Conexões, estados CSRF e eventos das plataformas desprovisionadas:
-- credencial cifrada e trilha de push não têm sentido sem a plataforma.
-- Os DELETEs comparam em TEXT (provider::text), não em enum: no
-- dual-track a migration roda duas vezes (runner do ERP e `prisma
-- migrate deploy`), e na segunda passada o enum JÁ não contém mais
-- 'SHOPEE'/'TIKTOK' — um literal em enum inexistente abortaria o
-- re-run com "invalid input value for enum".
DELETE FROM connector_oauth_states WHERE provider::text IN ('SHOPEE', 'TIKTOK');
DELETE FROM connector_events       WHERE provider::text IN ('SHOPEE', 'TIKTOK');
DELETE FROM connectors             WHERE provider::text IN ('SHOPEE', 'TIKTOK');

-- Vendas ingeridas pelos canais removidos. A venda multicanal é o
-- ESPELHO do pedido na plataforma de origem — sem a plataforma não há
-- o que conciliar; os itens caem junto (sale_items.sale_id é ON DELETE
-- CASCADE). O DELETE intencional (em vez de UPDATE de canal) preserva
-- a semântica do split de receita por canal: receita de Shopee/TikTok
-- antiga não pode ser re-rotulada como outro canal.
DELETE FROM sales WHERE channel::text IN ('SHOPEE', 'TIKTOK');

-- ------------------------------------------------------------------
-- 2) RECONSTRUÇÃO DOS ENUMS (remove SHOPEE/TIKTOK, adiciona NUVEMSHOP)
-- ------------------------------------------------------------------

-- connector_provider — colunas: connectors.provider,
-- connector_events.provider, connector_oauth_states.provider.
DO $$ BEGIN
  CREATE TYPE "connector_provider_novo" AS ENUM ('INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connectors             ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
ALTER TABLE connector_events       ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
ALTER TABLE connector_oauth_states ALTER COLUMN provider TYPE "connector_provider_novo" USING provider::text::"connector_provider_novo";
DROP TYPE IF EXISTS "connector_provider";
ALTER TYPE "connector_provider_novo" RENAME TO "connector_provider";

-- sale_channel — coluna: sales.channel. O DEFAULT 'BROBOND' precisa
-- sair antes da troca de tipo (o Postgres não converte default
-- automaticamente) e volta logo depois, apontando para o tipo novo.
DO $$ BEGIN
  CREATE TYPE "sale_channel_novo" AS ENUM ('BROBOND', 'INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE sales ALTER COLUMN channel DROP DEFAULT;
ALTER TABLE sales ALTER COLUMN channel TYPE "sale_channel_novo" USING channel::text::"sale_channel_novo";
ALTER TABLE sales ALTER COLUMN channel SET DEFAULT 'BROBOND';
DROP TYPE IF EXISTS "sale_channel";
ALTER TYPE "sale_channel_novo" RENAME TO "sale_channel";
