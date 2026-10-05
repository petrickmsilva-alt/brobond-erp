-- ==================================================================
-- DROP SHOPEE AND TIKTOK CONNECTORS — Hub Omnichannel (2026-10-05)
-- ==================================================================
--
-- DECISÃO DE NEGÓCIO (diretoria): os conectores NATIVOS de SHOPEE e
-- TIKTOK saem COMPLETAMENTE do ecossistema por causa das restrições e
-- barreiras burocráticas das APIs dessas plataformas. A triangulação de
-- vendas — inclusive o catálogo exibido no TikTok — passa a acontecer
-- pela NUVEMSHOP, que entra como plataforma-ponte do Hub.
--
-- O QUE ESTA MIGRATION FAZ, NESTA ORDEM (a ordem é o contrato):
--   1) EXPURGO DOS DADOS: `DELETE` dos registros dos dois canais em
--      sale_items → sales → connector_events → connector_oauth_states →
--      connectors. Primeiro os filhos, depois os pais: nenhuma FK é
--      violada e nenhuma linha órfã sobra.
--   2) ALTERAÇÃO DA ESTRUTURA: o Postgres NÃO sabe remover valor de
--      enum, então cada tipo é RECRIADO sem 'SHOPEE'/'TIKTOK' e com
--      'NUVEMSHOP', as colunas são religadas ao tipo novo e o tipo
--      antigo é descartado. Só é possível porque o passo (1) garantiu
--      que nenhuma linha ainda usa os valores removidos.
--
-- IDEMPOTENTE por projeto: todo bloco é guardado por consulta ao
-- catálogo (pg_enum / to_regclass). Reaplicar não faz nada, e num banco
-- novo — criado já com os enums corretos por db/schema.sql — os blocos
-- simplesmente não disparam. Isso mantém o contrato dual-track do
-- repositório (prisma migrate deploy E o boot do ERP convergem para o
-- mesmo estado).
--
-- DEFAULTS: `sales.channel` tem DEFAULT 'BROBOND'. Um default que
-- referencia o tipo antigo impede o ALTER COLUMN TYPE, por isso ele é
-- derrubado antes e recriado depois, idêntico.

-- ------------------------------------------------------------------
-- 1) EXPURGO DOS REGISTROS ANTIGOS (DELETE antes de mexer no enum)
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.sales') IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'sale_channel'
          AND e.enumlabel IN ('SHOPEE', 'TIKTOK')
     )
  THEN
    -- Itens primeiro (FK sale_items.sale_id → sales.id).
    IF to_regclass('public.sale_items') IS NOT NULL THEN
      DELETE FROM sale_items
       WHERE sale_id IN (SELECT id FROM sales WHERE channel::text IN ('SHOPEE', 'TIKTOK'));
    END IF;

    DELETE FROM sales WHERE channel::text IN ('SHOPEE', 'TIKTOK');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'connector_provider'
       AND e.enumlabel IN ('SHOPEE', 'TIKTOK')
  )
  THEN
    -- Eventos e estados OAuth antes dos conectores (FKs apontam para cá).
    IF to_regclass('public.connector_events') IS NOT NULL THEN
      DELETE FROM connector_events WHERE provider::text IN ('SHOPEE', 'TIKTOK');
    END IF;

    IF to_regclass('public.connector_oauth_states') IS NOT NULL THEN
      DELETE FROM connector_oauth_states WHERE provider::text IN ('SHOPEE', 'TIKTOK');
    END IF;

    -- As credenciais cifradas dos dois canais morrem aqui: esta
    -- aplicação nunca mais conseguirá chamar as APIs deles.
    IF to_regclass('public.connectors') IS NOT NULL THEN
      DELETE FROM connectors WHERE provider::text IN ('SHOPEE', 'TIKTOK');
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- 2) ESTRUTURA — enum `sale_channel` sem SHOPEE/TIKTOK, com NUVEMSHOP
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'sale_channel'
       AND e.enumlabel IN ('SHOPEE', 'TIKTOK')
  )
  THEN
    ALTER TYPE "sale_channel" RENAME TO "sale_channel_old";
    CREATE TYPE "sale_channel" AS ENUM ('BROBOND', 'INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');

    IF to_regclass('public.sales') IS NOT NULL THEN
      ALTER TABLE sales ALTER COLUMN channel DROP DEFAULT;
      ALTER TABLE sales
        ALTER COLUMN channel TYPE "sale_channel" USING channel::text::"sale_channel";
      ALTER TABLE sales ALTER COLUMN channel SET DEFAULT 'BROBOND';
    END IF;

    DROP TYPE "sale_channel_old";

  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'sale_channel'
       AND e.enumlabel = 'NUVEMSHOP'
  )
  THEN
    -- Banco já expurgado antes (ou criado sem os dois valores): só falta
    -- o canal novo da plataforma-ponte.
    ALTER TYPE "sale_channel" ADD VALUE 'NUVEMSHOP';
  END IF;
END $$;

-- ------------------------------------------------------------------
-- 3) ESTRUTURA — enum `connector_provider` idem
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'connector_provider'
       AND e.enumlabel IN ('SHOPEE', 'TIKTOK')
  )
  THEN
    ALTER TYPE "connector_provider" RENAME TO "connector_provider_old";
    CREATE TYPE "connector_provider" AS ENUM ('INSTAGRAM', 'MERCADOLIVRE', 'MERCADOPAGO', 'NUVEMSHOP');

    IF to_regclass('public.connectors') IS NOT NULL THEN
      ALTER TABLE connectors
        ALTER COLUMN provider TYPE "connector_provider" USING provider::text::"connector_provider";
    END IF;

    IF to_regclass('public.connector_events') IS NOT NULL THEN
      ALTER TABLE connector_events
        ALTER COLUMN provider TYPE "connector_provider" USING provider::text::"connector_provider";
    END IF;

    IF to_regclass('public.connector_oauth_states') IS NOT NULL THEN
      ALTER TABLE connector_oauth_states
        ALTER COLUMN provider TYPE "connector_provider" USING provider::text::"connector_provider";
    END IF;

    DROP TYPE "connector_provider_old";

  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'connector_provider'
       AND e.enumlabel = 'NUVEMSHOP'
  )
  THEN
    ALTER TYPE "connector_provider" ADD VALUE 'NUVEMSHOP';
  END IF;
END $$;
