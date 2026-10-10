-- ============================================================================
-- E4.2.1 — Integridade, rastreabilidade e localização dos movimentos de estoque.
--
-- Migração NOVA: não altera 0030 nem migrações antigas. Idempotente.
--
--   • movimentacoes.venda_id  — vínculo CANÔNICO entre a baixa, a entrada de
--     devolução e o estorno e a venda. Nullable: o histórico anterior NÃO é
--     associado por SKU, data ou texto ('Venda #n'). Linhas antigas ficam NULL.
--   • vendas.local_saida_id   — local canônico de saída. Preenchido apenas em
--     novas vendas de PDV. Vendas legadas ficam NULL e continuam usando o texto.
--   • devolucoes.idempotency_key — chave da criação de devolução (mesmo
--     mecanismo de documentos_fiscais / remessas).
--   • FKs compostas (empresa_id, …) garantem que o vínculo pertence ao mesmo
--     tenant no próprio banco, inclusive para escritas futuras.
--
-- Preflight: apenas diagnóstico. Se houver vínculo cruzado entre empresas, o
-- DDL é bloqueado e NADA é corrigido automaticamente.
-- ============================================================================

DO $e421_preflight$
DECLARE
  n_dev_venda INTEGER;
  n_devit_dev INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_dev_venda
    FROM devolucoes d JOIN vendas v ON v.id = d.venda_id
   WHERE v.empresa_id IS DISTINCT FROM d.empresa_id;
  SELECT COUNT(*) INTO n_devit_dev
    FROM devolucao_itens i JOIN devolucoes d ON d.id = i.devolucao_id
   WHERE d.empresa_id IS DISTINCT FROM i.empresa_id;
  IF n_dev_venda > 0 OR n_devit_dev > 0 THEN
    RAISE EXCEPTION 'E4.2.1 preflight bloqueou o DDL: devolucoes_de_outra_empresa=%, itens_de_devolucao_de_outra_empresa=%. Nenhuma linha foi alterada.',
      n_dev_venda, n_devit_dev;
  END IF;
END
$e421_preflight$;

ALTER TABLE movimentacoes    ADD COLUMN IF NOT EXISTS venda_id INTEGER;
ALTER TABLE vendas           ADD COLUMN IF NOT EXISTS local_saida_id INTEGER;
ALTER TABLE devolucoes       ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Diagnóstico informativo (depois do ADD COLUMN, para não citar coluna inexistente
-- em banco antigo): saídas de faturamento anteriores à E4.2.1 não têm venda_id.
-- Elas NÃO são associadas agora; o estorno legado as localiza pelo texto exato da
-- mesma empresa enquanto venda_id for NULL.
DO $e421_diagnostico$
DECLARE n_saidas_legadas INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_saidas_legadas
    FROM movimentacoes
   WHERE tipo = 'saida' AND venda_id IS NULL AND motivo LIKE 'Venda #%';
  RAISE NOTICE 'E4.2.1 diagnóstico sem backfill: saídas de venda sem venda_id=%', n_saidas_legadas;
END
$e421_diagnostico$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_vendas_empresa_id ON vendas (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_devolucoes_empresa_id ON devolucoes (empresa_id, id);
CREATE INDEX IF NOT EXISTS e421_mov_empresa_venda_idx ON movimentacoes (empresa_id, venda_id);
CREATE INDEX IF NOT EXISTS e421_vendas_empresa_local_saida_idx ON vendas (empresa_id, local_saida_id);
CREATE INDEX IF NOT EXISTS e421_devolucoes_empresa_venda_idx ON devolucoes (empresa_id, venda_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e421_devolucoes_empresa_idempotency
  ON devolucoes (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

DO $e421_foreign_keys$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('movimentacoes', 'fk_e421_mov_empresa_venda', 'FOREIGN KEY (empresa_id, venda_id) REFERENCES vendas (empresa_id, id)'),
      ('vendas', 'fk_e421_vendas_empresa_local_saida', 'FOREIGN KEY (empresa_id, local_saida_id) REFERENCES locais (empresa_id, id)'),
      ('devolucoes', 'fk_e421_devolucoes_empresa_venda', 'FOREIGN KEY (empresa_id, venda_id) REFERENCES vendas (empresa_id, id)'),
      ('devolucao_itens', 'fk_e421_devolucao_itens_empresa_devolucao', 'FOREIGN KEY (empresa_id, devolucao_id) REFERENCES devolucoes (empresa_id, id) ON DELETE CASCADE')
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
$e421_foreign_keys$;

COMMENT ON COLUMN movimentacoes.venda_id IS 'E4.2.1: venda que originou a baixa, a entrada de devolução ou o estorno. NULL em lançamentos manuais e no histórico anterior (sem backfill).';
COMMENT ON COLUMN vendas.local_saida_id IS 'E4.2.1: local canônico de saída. NULL em vendas legadas (usam local_saida texto).';
COMMENT ON INDEX uq_e421_devolucoes_empresa_idempotency IS 'E4.2.1: criação de devolução é idempotente por chave dentro da empresa.';
