-- ============================================================================
-- 0124 — BL-017 · permitir carteira compartilhada por participação
--
-- 0043 criou um índice único por (empresa_id, cliente_id) para vínculos
-- abertos. A regra comercial, porém, permite vários representantes no mesmo
-- cliente quando as participações parciais somadas não ultrapassam 100%.
--
-- A exclusividade é substituída por integridade temporal e agregada: a aplicação e
-- o trigger serializam por cliente; o banco rejeita sobreposição incompatível e
-- soma aberta acima de 100%, inclusive em SQL direto.
-- O índice representante_cliente_emp_cli_idx já cobre as consultas.
-- ============================================================================

DROP INDEX IF EXISTS uq_representante_cliente_aberta;

CREATE OR REPLACE FUNCTION representante_cliente_validar_participacao_aberta()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  participacao_existente NUMERIC;
  sobreposicao_invalida BOOLEAN;
BEGIN
  IF NEW.status = 'cancelado' THEN
    RETURN NEW;
  END IF;

  -- Mesma chave de trava usada por comercial.ts: empresa + cliente.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'representante_cliente:' || NEW.empresa_id::text || ':' || NEW.cliente_id::text,
      0
    )
  );

  -- Espelha periodosSobrepostos/compartilhado da aplicação. Um vínculo
  -- ativo só pode sobrepor outro se AMBOS forem abertos e parciais.
  SELECT EXISTS (
    SELECT 1
      FROM representante_cliente rc
     WHERE rc.empresa_id = NEW.empresa_id
       AND rc.cliente_id = NEW.cliente_id
       AND rc.id IS DISTINCT FROM NEW.id
       AND rc.status <> 'cancelado'
       AND rc.inicio <= COALESCE(NEW.fim, DATE '9999-12-31')
       AND NEW.inicio <= COALESCE(rc.fim, DATE '9999-12-31')
       AND NOT (
         NEW.status = 'ativo'
         AND NEW.fim IS NULL
         AND NEW.participacao_pct < 100
         AND rc.status = 'ativo'
         AND rc.fim IS NULL
         AND rc.participacao_pct < 100
       )
       -- Takeover/encerramento em lote: cada vínculo parcial aberto pode ser
       -- encerrado sequencialmente enquanto os demais participantes parciais
       -- ainda estão abertos ou já foram encerrados na mesma transação.
       AND NOT (
         TG_OP = 'UPDATE'
         AND OLD.status = 'ativo'
         AND OLD.fim IS NULL
         AND OLD.participacao_pct < 100
         AND NEW.status = 'encerrado'
         AND NEW.fim IS NOT NULL
         AND NEW.participacao_pct < 100
         AND rc.participacao_pct < 100
         AND (
           (rc.status = 'ativo' AND rc.fim IS NULL)
           OR (rc.status = 'encerrado' AND rc.fim IS NOT NULL)
         )
       )
  )
    INTO sobreposicao_invalida;

  IF sobreposicao_invalida THEN
    RAISE EXCEPTION
      'O vínculo informado se sobrepõe a uma atribuição que não admite compartilhamento.'
      USING ERRCODE = '23514',
            CONSTRAINT = 'representante_cliente_vigencia_sobreposta';
  END IF;

  IF NEW.status = 'ativo' AND NEW.fim IS NULL THEN
    SELECT COALESCE(SUM(rc.participacao_pct), 0)
      INTO participacao_existente
      FROM representante_cliente rc
     WHERE rc.empresa_id = NEW.empresa_id
       AND rc.cliente_id = NEW.cliente_id
       AND rc.status = 'ativo'
       AND rc.fim IS NULL
       AND rc.inicio <= COALESCE(NEW.fim, DATE '9999-12-31')
       AND NEW.inicio <= COALESCE(rc.fim, DATE '9999-12-31')
       AND rc.id IS DISTINCT FROM NEW.id;

    IF participacao_existente + NEW.participacao_pct > 100.0001 THEN
      RAISE EXCEPTION
        'A soma das participações abertas deste cliente excederia 100%% (atual: %, nova: %).',
        participacao_existente,
        NEW.participacao_pct
        USING ERRCODE = '23514',
              CONSTRAINT = 'representante_cliente_participacao_aberta';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_representante_cliente_participacao_aberta
  ON representante_cliente;

CREATE TRIGGER trg_representante_cliente_participacao_aberta
BEFORE INSERT OR UPDATE OF empresa_id, cliente_id, participacao_pct, inicio, fim, status
ON representante_cliente
FOR EACH ROW
EXECUTE FUNCTION representante_cliente_validar_participacao_aberta();
