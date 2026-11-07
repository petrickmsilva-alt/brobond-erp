-- ============================================================================
-- FASE 2 — INTEGRIDADE CROSS-TENANT DO CRM (GAP-P2-04), padrão E4.2.
--
-- Contexto: as tabelas crm_* têm empresa_id, mas as FKs de relacionamento são
-- SIMPLES (ex.: crm_oportunidades.lead_id → crm_leads(id)). A API já garante o
-- recorte por empresa (404 cross-tenant), porém um SQL manual poderia apontar um
-- registro do CRM para um pai de OUTRA empresa. Este ciclo fecha isso NO BANCO,
-- com FKs compostas (empresa_id, <fk_id>) → (empresa_id, id), no mesmo padrão
-- já usado em locais/estoque/compras (migração 0030, índices uq_e42_*).
--
-- Aditiva e idempotente. Não remove dados nem colunas. Não altera nenhuma FK
-- existente (as FKs simples continuam válidas; a composta acrescenta a garantia
-- de mesmo tenant). `NOT VALID` protege toda escrita nova imediatamente e o
-- `VALIDATE` verifica o legado — se houver linha inconsistente, a migração
-- FALHA em voz alta (não mascara dado sujo). Diagnóstico no fim do arquivo.
--
-- Rollback (somente manutenção autorizada):
--   BEGIN;
--   ALTER TABLE crm_oportunidades DROP CONSTRAINT IF EXISTS fk_e42_crm_oportunidades_empresa_lead;
--   ... (demais fk_e42_crm_*)
--   DROP INDEX IF EXISTS uq_e42_crm_leads_empresa_id; ...
--   DELETE FROM schema_migrations WHERE id = '0104_crm_integridade_multempresa.sql';
--   COMMIT;
-- ============================================================================

-- 1. Chaves únicas de DESTINO para as FKs compostas.
--    Cada pai precisa de UNIQUE (empresa_id, id) para ser alvo de FK composta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_leads_empresa_id ON crm_leads (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_oportunidades_empresa_id ON crm_oportunidades (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_motivos_perda_empresa_id ON crm_motivos_perda (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_origens_empresa_id ON crm_origens (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_funis_empresa_id ON crm_funis (empresa_id, id);
-- `clientes` é pai de lead/oportunidade/atividade: a chave de destino já pode
-- existir em outro ciclo; o IF NOT EXISTS torna a migração reaplicável.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_clientes_empresa_id ON clientes (empresa_id, id);

-- 2. FKs COMPOSTAS: o id estrangeiro precisa pertencer à MESMA empresa.
--    NOT VALID + VALIDATE: protege escrita nova e confere o legado.
DO $e42_crm_foreign_keys$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('crm_oportunidades', 'fk_e42_crm_oportunidades_empresa_lead', 'FOREIGN KEY (empresa_id, lead_id) REFERENCES crm_leads (empresa_id, id)'),
      ('crm_oportunidades', 'fk_e42_crm_oportunidades_empresa_cliente', 'FOREIGN KEY (empresa_id, cliente_id) REFERENCES clientes (empresa_id, id)'),
      ('crm_oportunidades', 'fk_e42_crm_oportunidades_empresa_motivo', 'FOREIGN KEY (empresa_id, motivo_perda_id) REFERENCES crm_motivos_perda (empresa_id, id)'),
      ('crm_atividades', 'fk_e42_crm_atividades_empresa_lead', 'FOREIGN KEY (empresa_id, lead_id) REFERENCES crm_leads (empresa_id, id)'),
      ('crm_atividades', 'fk_e42_crm_atividades_empresa_oportunidade', 'FOREIGN KEY (empresa_id, oportunidade_id) REFERENCES crm_oportunidades (empresa_id, id)'),
      ('crm_atividades', 'fk_e42_crm_atividades_empresa_cliente', 'FOREIGN KEY (empresa_id, cliente_id) REFERENCES clientes (empresa_id, id)'),
      ('crm_oportunidade_estagio_historico', 'fk_e42_crm_hist_empresa_oportunidade', 'FOREIGN KEY (empresa_id, oportunidade_id) REFERENCES crm_oportunidades (empresa_id, id) ON DELETE CASCADE'),
      ('crm_leads', 'fk_e42_crm_leads_empresa_cliente', 'FOREIGN KEY (empresa_id, cliente_id) REFERENCES clientes (empresa_id, id)'),
      ('crm_campanhas', 'fk_e42_crm_campanhas_empresa_origem', 'FOREIGN KEY (empresa_id, origem_id) REFERENCES crm_origens (empresa_id, id)'),
      ('crm_etapas', 'fk_e42_crm_etapas_empresa_funil', 'FOREIGN KEY (empresa_id, funil_id) REFERENCES crm_funis (empresa_id, id) ON DELETE CASCADE')
    ) AS v(tabela, nome, ddl)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.' || fk.tabela) AND conname = fk.nome
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', fk.tabela, fk.nome, fk.ddl);
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', fk.tabela, fk.nome);
  END LOOP;
END
$e42_crm_foreign_keys$;

CREATE INDEX IF NOT EXISTS e42_crm_oport_empresa_lead_idx ON crm_oportunidades (empresa_id, lead_id);
CREATE INDEX IF NOT EXISTS e42_crm_oport_empresa_cliente_idx ON crm_oportunidades (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS e42_crm_ativ_empresa_oport_idx ON crm_atividades (empresa_id, oportunidade_id);
CREATE INDEX IF NOT EXISTS e42_crm_hist_empresa_oport_idx ON crm_oportunidade_estagio_historico (empresa_id, oportunidade_id);
CREATE INDEX IF NOT EXISTS e42_crm_etapas_empresa_funil_idx ON crm_etapas (empresa_id, funil_id);

COMMENT ON INDEX uq_e42_crm_oportunidades_empresa_id IS 'E4.2/CRM: oportunidade é única por (empresa, id) — alvo de FK composta.';
COMMENT ON INDEX uq_e42_crm_leads_empresa_id IS 'E4.2/CRM: lead é único por (empresa, id) — alvo de FK composta.';

-- ============================================================================
-- DIAGNÓSTICO (executar ANTES em banco com dados, se o VALIDATE falhar).
-- Lista linhas do CRM cujo pai pertence a OUTRA empresa — é o que a FK composta
-- passa a proibir. Não é executado pela migração; serve ao saneamento.
--
--   SELECT 'oportunidades.lead_id' AS rel, o.id, o.empresa_id AS empresa_filho,
--          l.empresa_id AS empresa_pai
--     FROM crm_oportunidades o JOIN crm_leads l ON l.id = o.lead_id
--    WHERE o.lead_id IS NOT NULL AND l.empresa_id <> o.empresa_id
--   UNION ALL
--   SELECT 'atividades.oportunidade_id', a.id, a.empresa_id, o.empresa_id
--     FROM crm_atividades a JOIN crm_oportunidades o ON o.id = a.oportunidade_id
--    WHERE a.oportunidade_id IS NOT NULL AND o.empresa_id <> a.empresa_id;
--
-- Plano de saneamento: realinhar `empresa_id` do filho ao do pai quando a origem
-- é inequívoca; caso contrário, anular a referência (NULL) e registrar na
-- auditoria. Nunca fundir empresas nem reatribuir histórico sem evidência.
-- ============================================================================
