-- P0-02 — tenant explícito em conectores, eventos OAuth/webhook e vendas.
-- P0-01 — politicas_comerciais acompanha o tenant do catálogo público.
-- O legado recebe como empresa a empresa padrão atualmente confiável do dono.

-- Catálogo público: as políticas de preço não podem atravessar empresas.
ALTER TABLE politicas_comerciais ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
-- Para regras vinculadas, deriva o tenant só quando catálogo/cliente/coleção
-- apontam todos para a mesma empresa. Regras gerais legadas e relações
-- conflitantes são atribuídas conservadoramente à empresa padrão (1).
UPDATE politicas_comerciais p
   SET empresa_id = COALESCE((
     SELECT MIN(link.empresa_id)
       FROM (
         SELECT c.empresa_id FROM catalogos c WHERE c.id = p.catalogo_id
         UNION
         SELECT cl.empresa_id FROM clientes cl WHERE cl.id = p.cliente_id
         UNION
         SELECT co.empresa_id FROM colecoes co WHERE co.id = p.colecao_id
       ) AS link
      HAVING COUNT(DISTINCT link.empresa_id) = 1
   ), 1)
 WHERE p.empresa_id IS NULL;
ALTER TABLE politicas_comerciais ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE politicas_comerciais ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS politicas_comerciais_empresa_idx ON politicas_comerciais (empresa_id, ativo, prioridade DESC);

-- Conector OAuth: o tenant é persistido no vínculo, não inferido do SKU,
-- de um token global ou da empresa padrão do usuário em futuras operações.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connectors c
   SET empresa_id = COALESCE(u.empresa_id, 1)
  FROM usuarios u
 WHERE c.usuario_id = u.id AND c.empresa_id IS NULL;
UPDATE connectors SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connectors ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connectors ALTER COLUMN empresa_id SET NOT NULL;
DROP INDEX IF EXISTS connectors_usuario_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_empresa_usuario_provider_key
  ON connectors (empresa_id, usuario_id, provider);
CREATE INDEX IF NOT EXISTS connectors_empresa_usuario_status_idx
  ON connectors (empresa_id, usuario_id, status);
CREATE INDEX IF NOT EXISTS connectors_empresa_shop_idx
  ON connectors (empresa_id, provider, shop_id);

-- Cada evento guarda o mesmo tenant do conector. Eventos sem conector
-- sobrevivem usando a empresa vigente do responsável, nunca um tenant
-- recebido no payload externo.
ALTER TABLE connector_events ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connector_events e
   SET empresa_id = COALESCE(
     (SELECT c.empresa_id FROM connectors c WHERE c.id = e.connector_id),
     (SELECT u.empresa_id FROM usuarios u WHERE u.id = e.usuario_id),
     1
   )
 WHERE e.empresa_id IS NULL;
UPDATE connector_events SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connector_events ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connector_events ALTER COLUMN empresa_id SET NOT NULL;
DROP INDEX IF EXISTS connector_events_usuario_id_provider_external_event_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS connector_events_empresa_usuario_provider_external_event_id_key
  ON connector_events (empresa_id, usuario_id, provider, external_event_id);
CREATE INDEX IF NOT EXISTS connector_events_empresa_usuario_provider_created_idx
  ON connector_events (empresa_id, usuario_id, provider, created_at);

-- O state de OAuth é opaco e de uso único; armazena tenant + operador para
-- que o callback público não possa reconstruir contexto por um ID externo.
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
UPDATE connector_oauth_states s
   SET empresa_id = COALESCE(u.empresa_id, 1)
  FROM usuarios u
 WHERE s.usuario_id = u.id AND s.empresa_id IS NULL;
UPDATE connector_oauth_states SET empresa_id = 1 WHERE empresa_id IS NULL;
ALTER TABLE connector_oauth_states ALTER COLUMN empresa_id SET DEFAULT 1;
ALTER TABLE connector_oauth_states ALTER COLUMN empresa_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS connector_oauth_states_empresa_usuario_provider_expires_idx
  ON connector_oauth_states (empresa_id, usuario_id, provider, expires_at);

-- A chave idempotente passa a ser tenant + responsável + canal + pedido.
-- Referências externas antigas são migradas ao namespace equivalente antes
-- de remover a unicidade antiga, preservando unicidade global de `reference`.
UPDATE sales
   SET reference = 'empresa:' || empresa_id::text || ':usuario:' || usuario_id::text || ':' || lower(channel::text) || ':' || external_order_id
 WHERE external_order_id IS NOT NULL
   AND reference NOT LIKE 'empresa:' || empresa_id::text || ':usuario:' || usuario_id::text || ':%';
DROP INDEX IF EXISTS sales_usuario_id_channel_external_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS sales_empresa_usuario_channel_external_order_id_key
  ON sales (empresa_id, usuario_id, channel, external_order_id);
CREATE INDEX IF NOT EXISTS sales_empresa_usuario_channel_occurred_idx
  ON sales (empresa_id, usuario_id, channel, occurred_at DESC);
