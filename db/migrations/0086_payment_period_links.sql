-- A operação financeira deve validar todos os elos datados, não apenas a
-- primeira liquidação de um intent ou a data declarada do repasse.
CREATE OR REPLACE FUNCTION fin_validar_payment_intent(p_empresa INTEGER, p_intent BIGINT, p_exigir_data BOOLEAN) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE reg RECORD;
BEGIN
  FOR reg IN SELECT settlement_date FROM payment_settlements WHERE empresa_id=p_empresa AND payment_intent_id=p_intent LOOP
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.settlement_date);
  END LOOP;
  FOR reg IN
    SELECT l.data, l.competencia, l.data_baixa
    FROM payment_intents i JOIN gateway_cobrancas g ON g.empresa_id=i.empresa_id AND g.id=i.cobranca_id
    JOIN lancamentos_financeiros l ON l.empresa_id=g.empresa_id AND l.id=g.lancamento_id
    WHERE i.empresa_id=p_empresa AND i.id=p_intent
  LOOP
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.data::date);
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.competencia::date);
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.data_baixa::date);
  END LOOP;
  IF p_exigir_data AND EXISTS (SELECT 1 FROM fin_periodos_contabeis WHERE empresa_id=p_empresa AND abrangencia='financeiro' AND estado IN ('fechando','fechado'))
    AND (EXISTS (SELECT 1 FROM payment_settlements WHERE empresa_id=p_empresa AND payment_intent_id=p_intent AND settlement_date IS NULL)
      OR (NOT EXISTS (SELECT 1 FROM payment_settlements WHERE empresa_id=p_empresa AND payment_intent_id=p_intent AND settlement_date IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM payment_intents i JOIN gateway_cobrancas g ON g.empresa_id=i.empresa_id AND g.id=i.cobranca_id
          JOIN lancamentos_financeiros l ON l.empresa_id=g.empresa_id AND l.id=g.lancamento_id
          WHERE i.empresa_id=p_empresa AND i.id=p_intent AND l.data_baixa IS NOT NULL
        ))) THEN
    RAISE EXCEPTION 'Operação sem data financeira comprovada com período fechado' USING ERRCODE='P2001';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION fin_validar_repasse(p_empresa INTEGER, p_repasse BIGINT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE reg RECORD;
BEGIN
  FOR reg IN SELECT p.settlement_date, e.data AS data_extrato FROM payment_payouts p
    LEFT JOIN fin_extrato_transacoes e ON e.empresa_id=p.empresa_id AND e.id=p.bank_transaction_id
    WHERE p.empresa_id=p_empresa AND p.id=p_repasse LOOP
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.settlement_date);
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.data_extrato);
  END LOOP;
  FOR reg IN SELECT settlement_date FROM payment_settlements WHERE empresa_id=p_empresa AND payout_id=p_repasse LOOP
    PERFORM fin_exigir_periodo_financeiro_aberto(p_empresa, reg.settlement_date);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION fin_proteger_movimento_periodo() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE old_emp INTEGER; new_emp INTEGER; emp INTEGER; bank_date DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_emp := OLD.empresa_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_emp := NEW.empresa_id; END IF;
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
  ELSIF TG_TABLE_NAME='payment_settlements' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.settlement_date);
      PERFORM fin_validar_payment_intent(old_emp,OLD.payment_intent_id,false);
      IF OLD.payout_id IS NOT NULL THEN PERFORM fin_validar_repasse(old_emp,OLD.payout_id); END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.settlement_date);
      PERFORM fin_validar_payment_intent(new_emp,NEW.payment_intent_id,false);
      IF NEW.settlement_date IS NULL AND (NEW.refund_amount > 0 OR NEW.chargeback_amount > 0 OR NEW.dispute_review_required) THEN
        PERFORM fin_validar_payment_intent(new_emp,NEW.payment_intent_id,true);
      END IF;
      IF NEW.payout_id IS NOT NULL THEN PERFORM fin_validar_repasse(new_emp,NEW.payout_id); END IF;
    END IF;
  ELSIF TG_TABLE_NAME='payment_payouts' THEN
    IF TG_OP <> 'INSERT' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(old_emp,OLD.settlement_date);
      PERFORM fin_validar_repasse(old_emp,OLD.id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,NEW.settlement_date);
      IF NEW.bank_transaction_id IS NOT NULL THEN
        SELECT data INTO bank_date FROM fin_extrato_transacoes WHERE empresa_id=new_emp AND id=NEW.bank_transaction_id;
        PERFORM fin_exigir_periodo_financeiro_aberto(new_emp,bank_date);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='payment_operations' THEN
    IF TG_OP <> 'INSERT' THEN PERFORM fin_validar_payment_intent(old_emp,OLD.payment_intent_id,true); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM fin_validar_payment_intent(new_emp,NEW.payment_intent_id,true); END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
