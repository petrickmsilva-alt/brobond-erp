-- 0013) REDIRECT_URI DINÂMICO DO OAUTH DOS CONECTORES
--
-- O painel autenticado envia a origem em que o navegador está rodando
-- (na Render, o host unificado https://brobond-erp.onrender.com); o
-- servidor valida, deriva o caminho canônico
-- /api/connectors/<slug>/callback e persiste a URI escolhida junto com
-- o state CSRF. Na troca do código, o Mercado Livre compara o
-- redirect_uri da autorização com o da troca byte a byte — sem essa
-- coluna as duas pernas podiam divergir quando o redirect vinha da
-- origem dinâmica em vez do ambiente.
--
-- Idempotente (dual-track): o MESMO ALTER vive em db/schema.sql e em
-- prisma/migrations/20261005140000_connector_oauth_redirect_uri —
-- qualquer um dos runners pode chegar primeiro.

ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS redirect_uri TEXT;
