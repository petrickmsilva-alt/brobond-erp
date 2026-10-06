-- 0015) CANAL INSTAGRAM_SHOPPING — Hub Omnichannel
--
-- Espelho EXATO (dual-track) de
-- prisma/migrations/20261006120000_instagram_shopping_channel/migration.sql.
-- Qualquer um dos runners pode chegar primeiro: `prisma migrate deploy`
-- ou o boot do ERP (server/src/db.ts aplica db/schema.sql + db/migrations
-- em ordem léxica, uma única vez por banco). Os dois convergem para o
-- mesmo estado porque todo bloco é guardado por consulta ao catálogo.
--
-- CONTEXTO (2026-10-06): o Instagram Shopping deixou de ser um canal de
-- prontidão e passou a ter conector PRÓPRIO, ligado direto à Graph API
-- da Meta (OAuth2 oficial, webhook assinado com `x-hub-signature-256` e
-- catálogo da API de Product Tagging).
--
-- O QUE ESTA MIGRATION FAZ:
--   • RENOMEIA o valor 'INSTAGRAM' do enum `sale_channel` para
--     'INSTAGRAM_SHOPPING'. É RENAME, não ADD: o canal é UM só, e dois
--     rótulos para a mesma vitrine partiriam a receita em duas linhas de
--     relatório. `ALTER TYPE … RENAME VALUE` preserva automaticamente
--     toda linha que já usasse o valor antigo (nenhum UPDATE necessário)
--     e, ao contrário de `ADD VALUE`, é seguro dentro de transação — que
--     é exatamente como o runner do ERP aplica cada arquivo.
--
-- O QUE ESTA MIGRATION NÃO FAZ:
--   • não toca em `connector_provider`: o PROVEDOR continua 'INSTAGRAM'
--     (é a conta comercial da Meta que se conecta). Quem traduz provedor
--     → canal é `saleChannelFromConnectorProvider()`, com mapa tipado e
--     exaustivo em modules/connectors/core/providers.ts;
--   • não cria, apaga nem converte nenhuma linha de `sales`.
--
-- IDEMPOTENTE: o bloco só dispara quando 'INSTAGRAM' ainda existe no
-- enum E 'INSTAGRAM_SHOPPING' ainda não. Reaplicar não faz nada, e num
-- banco novo — criado já com o rótulo correto por db/schema.sql — o
-- bloco simplesmente não dispara.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'sale_channel'
       AND e.enumlabel = 'INSTAGRAM'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'sale_channel'
       AND e.enumlabel = 'INSTAGRAM_SHOPPING'
  )
  THEN
    ALTER TYPE "sale_channel" RENAME VALUE 'INSTAGRAM' TO 'INSTAGRAM_SHOPPING';
  END IF;
END $$;
