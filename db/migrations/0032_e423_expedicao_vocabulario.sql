-- ============================================================================
-- E4.2.3 — Vocabulário canônico da máquina de expedição (AUD-01).
--
-- Migração NOVA: não altera 0024 nem migrações antigas. Idempotente.
--
-- O CHECK `expedicao_eventos_etapa_valida` criado em 0024 aceitava o
-- vocabulário antigo de PASSOS (separacao, conferencia, embalagem, expedicao),
-- enquanto a máquina de estados — `vendas.expedicao_etapa`, backend, frontend e
-- testes — usa o vocabulário canônico de ESTADOS:
--
--   pendente → separacao → conferida → embalada → expedida
--
-- Resultado observado (reproduzido em PostgreSQL real antes desta correção):
-- `embalar` gravava etapa 'embalada' e `expedir` gravava 'expedida'; o CHECK
-- recusava com SQLSTATE 23514 (`expedicao_eventos_etapa_valida`) e a operação
-- retornava HTTP 500 com rollback da transação inteira.
--
-- Correção estrutural: o CHECK passa a exigir o vocabulário canônico — o mesmo
-- de `vendas.expedicao_etapa`. Uma única linguagem de domínio; sem mapeamento
-- artificial permanente (embalada→embalagem, expedida→expedicao).
--
-- DADOS HISTÓRICOS — sem backfill heurístico:
--   linhas gravadas antes desta migração podem conter 'conferencia',
--   'embalagem' ou 'expedicao'. Elas NÃO são convertidas nem apagadas:
--   preservação de dados > aparência de limpeza. A equivalência segura não é
--   determinável aqui — a etapa gravada dependia do código da época e nenhum
--   outro campo registra a transição real de forma a reconstruir o estado
--   canônico sem inventar associação. Estratégia:
--     1) a contagem por valor é emitida em RAISE NOTICE neste upgrade;
--     2) se existir linha incompatível, o CHECK novo é criado NOT VALID:
--        escritas NOVAS já são limitadas ao vocabulário canônico e as linhas
--        históricas permanecem intactas;
--     3) sem linha incompatível, o CHECK é validado normalmente;
--     4) uma migração futura pode VALIDATE CONSTRAINT depois de tratamento
--        explícito dos dados históricos (fora do escopo E4.2.3).
-- ============================================================================

-- --------------------------------------------------------------------
-- 1) Diagnóstico (somente leitura): contagem por valor de etapa.
-- --------------------------------------------------------------------
DO $e423_diagnostico$
DECLARE
  r RECORD;
  n_incomp INTEGER;
  n_total INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_total FROM expedicao_eventos;
  SELECT COUNT(*) INTO n_incomp FROM expedicao_eventos
   WHERE etapa NOT IN ('pendente', 'separacao', 'conferida', 'embalada', 'expedida');
  RAISE NOTICE 'E4.2.3 diagnóstico sem backfill: expedicao_eventos total=%, fora_do_vocabulario_canonico=%', n_total, n_incomp;
  FOR r IN SELECT etapa, COUNT(*) AS n FROM expedicao_eventos GROUP BY etapa ORDER BY etapa LOOP
    RAISE NOTICE 'E4.2.3 diagnóstico: etapa="%" quantidade=%', r.etapa, r.n;
  END LOOP;
  IF n_incomp > 0 THEN
    RAISE NOTICE 'E4.2.3: existem linhas históricas com vocabulário antigo. ELAS NÃO SÃO CONVERTIDAS (sem backfill heurístico). O CHECK novo será criado NOT VALID e a VALIDATE CONSTRAINT fica pendente até tratamento explícito.';
  END IF;
END
$e423_diagnostico$;

-- --------------------------------------------------------------------
-- 2) Substitui o CHECK pelo vocabulário canônico.
--    NOT VALID primeiro: escritas novas são limitadas imediatamente e
--    linhas históricas não bloqueiam o DDL. VALIDATE só quando o conjunto
--    existente já está no vocabulário canônico.
-- --------------------------------------------------------------------
ALTER TABLE expedicao_eventos DROP CONSTRAINT IF EXISTS expedicao_eventos_etapa_valida;

DO $e423_check$
DECLARE
  n_incomp INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_incomp FROM expedicao_eventos
   WHERE etapa NOT IN ('pendente', 'separacao', 'conferida', 'embalada', 'expedida');
  EXECUTE $ddl$
    ALTER TABLE expedicao_eventos ADD CONSTRAINT expedicao_eventos_etapa_valida CHECK (etapa IN (
      'pendente', 'separacao', 'conferida', 'embalada', 'expedida'
    )) NOT VALID
  $ddl$;
  IF n_incomp = 0 THEN
    EXECUTE 'ALTER TABLE expedicao_eventos VALIDATE CONSTRAINT expedicao_eventos_etapa_valida';
    RAISE NOTICE 'E4.2.3: CHECK expedicao_eventos_etapa_valida validado no vocabulário canônico.';
  ELSE
    RAISE NOTICE 'E4.2.3: CHECK expedicao_eventos_etapa_valida criado NOT VALID (linhas históricas incompatíveis=%). Novas escritas já são limitadas ao vocabulário canônico.', n_incomp;
  END IF;
END
$e423_check$;

COMMENT ON CONSTRAINT expedicao_eventos_etapa_valida ON expedicao_eventos IS
  'E4.2.3: vocabulário canônico da máquina de expedição (pendente, separacao, conferida, embalada, expedida) — o mesmo de vendas.expedicao_etapa. Linhas históricas com conferencia/embalagem/expedicao são preservadas sem conversão; se existirem, o CHECK fica NOT VALID até tratamento explícito.';
