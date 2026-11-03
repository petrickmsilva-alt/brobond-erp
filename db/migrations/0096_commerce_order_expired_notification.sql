-- Commerce: evento transacional ORDER_EXPIRED (pedido expirado ≠ cancelado).
-- Não destrutiva: apenas AMPLIA o CHECK de commerce_notificacoes.evento.
-- Nenhuma linha existente é alterada; nenhum dado é fabricado.
-- Antes, a expiração do checkout (PIX vencido) disparava ORDER_CANCELLED e o
-- cliente recebia "Seu pedido foi cancelado" sem saber que o prazo terminou.
ALTER TABLE commerce_notificacoes DROP CONSTRAINT IF EXISTS commerce_notificacoes_evento_ck;
ALTER TABLE commerce_notificacoes ADD CONSTRAINT commerce_notificacoes_evento_ck CHECK (evento IN (
  'ORDER_CREATED', 'PIX_GENERATED', 'PAYMENT_PENDING', 'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'ORDER_PROCESSING', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED',
  'ORDER_EXPIRED'
));
COMMENT ON COLUMN commerce_notificacoes.provider_status IS 'Provider acceptance/delivery status (REQUEST_ACCEPTED, SMTP_ACCEPTED) or NAO_CONFIGURADO/CONSOLIDADO; HTTP success is not delivery proof';
