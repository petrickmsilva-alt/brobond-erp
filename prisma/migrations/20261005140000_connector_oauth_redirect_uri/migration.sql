-- Redirect_uri dinâmico do OAuth dos conectores: a URI escolhida na
-- autorização (origem do painel validada + caminho canônico do callback)
-- é persistida com o state CSRF e reutilizada VERBATIM na troca do
-- código — o Mercado Livre compara as duas pernas byte a byte.
--
-- Idempotente (dual-track): o MESMO ALTER vive em db/schema.sql e em
-- db/migrations/0013_connector_oauth_redirect_uri.sql.

ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS redirect_uri TEXT;
