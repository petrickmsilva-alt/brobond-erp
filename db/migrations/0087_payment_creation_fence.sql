-- Reserva persistente de criação legada e trava do ciclo de intenção. Dados
-- antigos não são presumidos como prova e nenhum segredo é armazenado aqui.
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS criacao_operacao_estado TEXT;
ALTER TABLE gateway_cobrancas ADD COLUMN IF NOT EXISTS criacao_operacao_hash TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_cobrancas'::regclass AND conname='gateway_criacao_estado_ck') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT gateway_criacao_estado_ck CHECK (criacao_operacao_estado IS NULL OR criacao_operacao_estado IN ('PROCESSING','UNCERTAIN','SUCCEEDED','FAILED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_cobrancas'::regclass AND conname='gateway_criacao_hash_ck') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT gateway_criacao_hash_ck CHECK (criacao_operacao_hash IS NULL OR criacao_operacao_hash ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END $$;
ALTER TABLE gateway_cobrancas VALIDATE CONSTRAINT gateway_criacao_estado_ck;
ALTER TABLE gateway_cobrancas VALIDATE CONSTRAINT gateway_criacao_hash_ck;
CREATE OR REPLACE FUNCTION fin_proteger_intencao_periodo() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE old_emp INTEGER; new_emp INTEGER; emp INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_emp := OLD.empresa_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_emp := NEW.empresa_id; END IF;
  FOR emp IN SELECT DISTINCT x FROM unnest(ARRAY[old_emp,new_emp]) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM fin_travar_empresa_periodo(emp);
  END LOOP;
  IF TG_OP <> 'INSERT' THEN PERFORM fin_exigir_periodo_financeiro_aberto(old_emp, OLD.created_at::date); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM fin_exigir_periodo_financeiro_aberto(new_emp, NEW.created_at::date); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS fin_periodo_payment_intents ON payment_intents;
CREATE TRIGGER fin_periodo_payment_intents BEFORE INSERT OR UPDATE OR DELETE ON payment_intents FOR EACH ROW EXECUTE FUNCTION fin_proteger_intencao_periodo();
