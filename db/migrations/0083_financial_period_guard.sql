-- Explicit financial close expands the existing accounting-period control; it
-- does not create a second ledger. Legacy closes remain accounting-only until
-- an authorised actor explicitly performs the financial close.
ALTER TABLE fin_periodos_contabeis ADD COLUMN IF NOT EXISTS abrangencia TEXT NOT NULL DEFAULT 'escrituracao';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fin_periodos_contabeis'::regclass AND conname='fin_periodos_abrangencia_ck') THEN
    ALTER TABLE fin_periodos_contabeis ADD CONSTRAINT fin_periodos_abrangencia_ck CHECK (abrangencia IN ('escrituracao','financeiro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='fin_periodos_contabeis'::regclass AND conname='fin_periodos_estado_v2_ck') THEN
    ALTER TABLE fin_periodos_contabeis ADD CONSTRAINT fin_periodos_estado_v2_ck CHECK (estado IN ('aberto','fechando','fechado'));
  END IF;
END $$;
-- Replace the old state check only after the compatible check is in place.
ALTER TABLE fin_periodos_contabeis DROP CONSTRAINT IF EXISTS fin_periodos_contabeis_estado_check;

-- One fencing row per company. The update also makes a stale SERIALIZABLE
-- writer abort instead of accepting a snapshot from before a completed close.
CREATE TABLE IF NOT EXISTS fin_periodos_travas_empresa (
  empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
  versao BIGINT NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION fin_travar_empresa_periodo(p_empresa INTEGER) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_empresa IS NULL OR p_empresa <= 0 THEN
    RAISE EXCEPTION 'Empresa obrigatória para controle de período' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contabil:' || p_empresa::text, 0));
  INSERT INTO fin_periodos_travas_empresa(empresa_id,versao) VALUES(p_empresa,1)
    ON CONFLICT (empresa_id) DO UPDATE SET versao=fin_periodos_travas_empresa.versao+1;
END $$;
CREATE OR REPLACE FUNCTION fin_exigir_periodo_financeiro_aberto(p_empresa INTEGER, p_data DATE) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_data IS NOT NULL AND EXISTS (
    SELECT 1 FROM fin_periodos_contabeis p
    WHERE p.empresa_id=p_empresa AND p.competencia=date_trunc('month',p_data)::date
      AND p.abrangencia='financeiro' AND p.estado IN ('fechando','fechado')
  ) THEN
    RAISE EXCEPTION 'Período financeiro fechado' USING ERRCODE='P2001';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fin_proteger_movimento_periodo() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE old_emp INTEGER; new_emp INTEGER; emp INTEGER; old_date DATE; new_date DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_emp := OLD.empresa_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_emp := NEW.empresa_id; END IF;
  -- Consistent order even for an (otherwise disallowed) cross-company change.
  FOR emp IN SELECT DISTINCT x FROM unnest(ARRAY[old_emp,new_emp]) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM fin_travar_empresa_periodo(emp);
  END LOOP;
  IF TG_TABLE_NAME='lancamentos_financeiros' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.data);
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.competencia);
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.data_baixa);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.data);
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.competencia);
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.data_baixa);
    END IF;
  ELSIF TG_TABLE_NAME='fin_extrato_transacoes' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.data); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.data); END IF;
  ELSIF TG_TABLE_NAME IN ('payment_settlements','payment_payouts') THEN
    IF TG_OP <> 'INSERT' THEN PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.settlement_date); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.settlement_date); END IF;
  ELSIF TG_TABLE_NAME='payment_operations' THEN
    IF TG_OP <> 'INSERT' THEN
      SELECT settlement_date INTO old_date FROM payment_settlements WHERE empresa_id=old_emp AND payment_intent_id=OLD.payment_intent_id;
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,old_date);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT settlement_date INTO new_date FROM payment_settlements WHERE empresa_id=new_emp AND payment_intent_id=NEW.payment_intent_id;
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,new_date);
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$
DECLARE tabela TEXT; nome TEXT;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['lancamentos_financeiros','fin_extrato_transacoes','payment_settlements','payment_payouts','payment_operations'] LOOP
    nome := 'fin_periodo_guard_' || tabela;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(tabela) AND tgname=nome AND NOT tgisinternal) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fin_proteger_movimento_periodo()',nome,tabela);
    END IF;
  END LOOP;
END $$;
