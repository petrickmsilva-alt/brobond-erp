-- Um estado de disputa/chargeback não comprova o valor efetivamente debitado.
-- Valores antigos são preservados, mas sua origem não é presumida como prova.
ALTER TABLE payment_disputes ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS amount_source TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payment_disputes'::regclass AND conname = 'payment_disputes_amount_source_ck') THEN
    ALTER TABLE payment_disputes ADD CONSTRAINT payment_disputes_amount_source_ck CHECK (
      (amount_source = 'UNKNOWN' AND amount IS NULL) OR
      (amount_source = 'MANUAL_REPORTED' AND amount IS NOT NULL AND amount > 0) OR
      amount_source = 'LEGACY_UNVERIFIED'
    ) NOT VALID;
  END IF;
END $$;
ALTER TABLE payment_disputes VALIDATE CONSTRAINT payment_disputes_amount_source_ck;
ALTER TABLE payment_settlements ADD COLUMN IF NOT EXISTS dispute_review_required BOOLEAN NOT NULL DEFAULT false;
-- Bloqueia conciliação enganosa de estados já registrados; não altera valores,
-- extratos nem lançamentos. O histórico financeiro legado exige revisão.
UPDATE payment_settlements s SET dispute_review_required = true, status = 'DIVERGENT'
FROM payment_intents i
WHERE i.empresa_id = s.empresa_id AND i.id = s.payment_intent_id
  AND (i.status IN ('DISPUTED', 'CHARGEBACK') OR EXISTS (
    SELECT 1 FROM payment_disputes d WHERE d.empresa_id = s.empresa_id AND d.payment_intent_id = s.payment_intent_id
      AND d.provider_reference = s.provider_reference
  )) AND (NOT s.dispute_review_required OR s.status <> 'DIVERGENT');
UPDATE payment_payouts p SET status = 'DIVERGENT'
WHERE p.status <> 'DIVERGENT' AND EXISTS (
  SELECT 1 FROM payment_settlements s WHERE s.empresa_id = p.empresa_id AND s.payout_id = p.id AND s.dispute_review_required
);
