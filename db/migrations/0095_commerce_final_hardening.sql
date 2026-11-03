-- Commerce final hardening: preserve provider-issued PIX fields and notification receipts.
-- Additive-only migration; no secrets, external calls, or data fabrication.
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS qr_code_base64 TEXT;
ALTER TABLE commerce_notificacoes ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE commerce_notificacoes ADD COLUMN IF NOT EXISTS provider_status TEXT;
CREATE INDEX IF NOT EXISTS ix_commerce_notificacoes_provider_message
  ON commerce_notificacoes (empresa_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
COMMENT ON COLUMN gateway_cobrancas.qr_code_base64 IS 'QR image payload returned by the payment provider; NULL when not supplied';
COMMENT ON COLUMN commerce_notificacoes.provider_message_id IS 'Message identifier returned by the external provider (for example Meta WhatsApp Cloud API)';
COMMENT ON COLUMN commerce_notificacoes.provider_status IS 'Provider acceptance/delivery status; HTTP success is not delivery proof';
