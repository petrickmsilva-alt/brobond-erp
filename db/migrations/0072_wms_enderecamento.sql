-- WMS: endereçamento no cadastro canônico de locais. Não cria saldo ou movimento.
ALTER TABLE locais ADD COLUMN IF NOT EXISTS nivel_wms TEXT NOT NULL DEFAULT 'local';
ALTER TABLE locais ADD COLUMN IF NOT EXISTS local_pai_id INTEGER;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_nivel_wms_ck CHECK (nivel_wms IN ('local', 'armazem', 'zona', 'endereco'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_pai_wms_ck CHECK (
    (nivel_wms IN ('local', 'armazem') AND local_pai_id IS NULL) OR
    (nivel_wms IN ('zona', 'endereco') AND local_pai_id IS NOT NULL AND local_pai_id <> id)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE locais ADD CONSTRAINT locais_pai_empresa_fk
    FOREIGN KEY (empresa_id, local_pai_id) REFERENCES locais (empresa_id, id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS locais_wms_pai_idx ON locais (empresa_id, local_pai_id, nivel_wms);
