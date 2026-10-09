-- ============================================================================
-- E4.2 — ownership multiempresa para locais, saldos, movimentos e inventário
--
-- PRECONDICAO: os blocos de diagnóstico rodam antes de qualquer DDL que remova
-- unicidade ou acrescente FK/índice. Não há backfill por texto, reatribuição de
-- empresa nem escolha de linha em duplicidades históricas.
-- Idempotente; executado em transação pelo executor de migrations.
-- ============================================================================

-- O schema.sql executa este mesmo diagnóstico antes dos triggers antigos de
-- herança de empresa. Mantemos a cópia aqui para execução manual da migration e
-- para deixar o gate de upgrade autocontido.
DO $e42_preflight_core$
DECLARE
  duplicatas_locais BIGINT;
  duplicatas_padroes BIGINT;
  duplicatas_saldos BIGINT;
  duplicatas_itens_inventario BIGINT;
  dados_saldos_invalidos BIGINT;
  vinculos_empresa BIGINT;
  vinculos_locais BIGINT;
  nomes_locais_inconsistentes BIGINT;
  saldos_sem_local BIGINT;
  saldos_sem_local_ambiguos BIGINT;
  movimentos_sem_local BIGINT;
  inventarios_sem_local BIGINT;
  pdv_locais_inconsistentes BIGINT := 0;
  pdv_nomes_inconsistentes BIGINT := 0;
  pdv_locais_ambiguos BIGINT := 0;
BEGIN
  SELECT count(*) INTO duplicatas_locais FROM (
    SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_padroes FROM (
    SELECT empresa_id FROM locais WHERE padrao IS TRUE GROUP BY empresa_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_saldos FROM (
    SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
    GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO duplicatas_itens_inventario FROM (
    SELECT empresa_id, inventario_id, produto_id, tamanho_id FROM itens_inventario
    GROUP BY empresa_id, inventario_id, produto_id, tamanho_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dados_saldos_invalidos FROM estoques WHERE produto_id IS NULL OR local IS NULL;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN produtos p ON p.id = e.produto_id
      WHERE e.produto_id IS NULL OR p.id IS NULL OR e.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id
      WHERE m.produto_id IS NULL OR p.id IS NULL OR m.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM estoque_insumos e LEFT JOIN insumos i ON i.id = e.insumo_id
      WHERE e.insumo_id IS NULL OR i.id IS NULL OR e.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN insumos i ON i.id = m.insumo_id
      WHERE m.insumo_id IS NULL OR i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM itens_compra ic
       LEFT JOIN compras c ON c.id = ic.compra_id
       LEFT JOIN produtos p ON p.id = ic.produto_id
       LEFT JOIN insumos i ON i.id = ic.insumo_id
      WHERE ic.compra_id IS NULL OR c.id IS NULL OR ic.empresa_id IS DISTINCT FROM c.empresa_id
         OR (ic.produto_id IS NOT NULL AND (p.id IS NULL OR ic.empresa_id IS DISTINCT FROM p.empresa_id))
         OR (ic.insumo_id IS NOT NULL AND (i.id IS NULL OR ic.empresa_id IS DISTINCT FROM i.empresa_id))) +
    (SELECT count(*) FROM itens_inventario ii
       LEFT JOIN inventarios inv ON inv.id = ii.inventario_id
       LEFT JOIN produtos p ON p.id = ii.produto_id
      WHERE ii.inventario_id IS NULL OR ii.produto_id IS NULL OR inv.id IS NULL OR p.id IS NULL
         OR ii.empresa_id IS DISTINCT FROM inv.empresa_id
         OR ii.empresa_id IS DISTINCT FROM p.empresa_id)
    INTO vinculos_empresa;

  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND (l.id IS NULL OR inv.empresa_id IS DISTINCT FROM l.empresa_id))
    INTO vinculos_locais;
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO nomes_locais_inconsistentes;

  SELECT count(*) INTO saldos_sem_local FROM estoques WHERE local_id IS NULL;
  SELECT count(*) INTO saldos_sem_local_ambiguos FROM estoques e
    WHERE e.local_id IS NULL AND (SELECT count(*) FROM locais l WHERE l.empresa_id = e.empresa_id AND l.nome = e.local) <> 1;
  SELECT count(*) INTO movimentos_sem_local FROM movimentacoes WHERE local_id IS NULL;
  SELECT count(*) INTO inventarios_sem_local FROM inventarios WHERE local_id IS NULL;
  IF saldos_sem_local + movimentos_sem_local + inventarios_sem_local > 0 THEN
    RAISE NOTICE 'E4.2 diagnóstico sem backfill: saldos sem local_id=%, dos quais sem correspondência única de nome na própria empresa=%; movimentações sem local_id=%; inventários sem local_id=%',
      saldos_sem_local, saldos_sem_local_ambiguos, movimentos_sem_local, inventarios_sem_local;
  END IF;

  -- A migration pode ser rodada manualmente antes da coluna aditiva existir.
  -- Diagnostica vínculos já canônicos dinamicamente e nunca infere local_id por
  -- nome para caixas legados.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pdv_caixas' AND column_name = 'local_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM pdv_caixas p LEFT JOIN locais l ON l.id = p.local_id
      WHERE p.local_id IS NOT NULL AND (l.id IS NULL OR p.empresa_id IS DISTINCT FROM l.empresa_id)'
      INTO pdv_locais_inconsistentes;
    EXECUTE 'SELECT count(*) FROM pdv_caixas p JOIN locais l ON l.id = p.local_id
      WHERE p.local_id IS NOT NULL AND p.local IS DISTINCT FROM l.nome'
      INTO pdv_nomes_inconsistentes;
  END IF;
  -- Não menciona local_id: em upgrade, a coluna talvez ainda não exista.
  -- Registra nomes sem resolução única, mas nunca os converte em vínculo.
  SELECT count(*) INTO pdv_locais_ambiguos FROM pdv_caixas p
    WHERE p.local IS NOT NULL
      AND (SELECT count(*) FROM locais l WHERE l.empresa_id = p.empresa_id AND l.nome = p.local) <> 1;
  IF pdv_locais_ambiguos > 0 THEN
    RAISE NOTICE 'E4.2 diagnóstico sem backfill: caixas PDV com nome de local sem correspondência única na própria empresa=%; nenhum local_id foi inferido.', pdv_locais_ambiguos;
  END IF;

  IF duplicatas_locais + duplicatas_padroes + duplicatas_saldos + duplicatas_itens_inventario + dados_saldos_invalidos + vinculos_empresa + vinculos_locais + nomes_locais_inconsistentes + pdv_locais_inconsistentes + pdv_nomes_inconsistentes > 0 THEN
    RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_sem_produto_ou_local=%, vinculos_empresa_inconsistentes=%, vinculos_locais_estrangeiros=%, nomes_locais_inconsistentes=%, vinculos_pdv_estrangeiros=%, nomes_pdv_inconsistentes=%. Nenhum vínculo foi corrigido automaticamente.',
      duplicatas_locais, duplicatas_padroes, duplicatas_saldos, duplicatas_itens_inventario, dados_saldos_invalidos, vinculos_empresa, vinculos_locais, nomes_locais_inconsistentes, pdv_locais_inconsistentes, pdv_nomes_inconsistentes
      USING HINT = 'Revise explicitamente os registros usando empresa_id e IDs canônicos; preserve os dados originais e execute novamente após correção administrativa.';
  END IF;
END
$e42_preflight_core$;

-- Referências operacionais introduzidas em fases posteriores do schema.
-- Novamente, só diagnostica: não altera os links históricos.
DO $e42_preflight_operacional$
DECLARE
  refs_estrangeiras BIGINT;
BEGIN
  SELECT
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compra_recebimentos r ON r.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (r.id IS NULL OR m.empresa_id IS DISTINCT FROM r.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.movimentacao_estorno_id
      WHERE m.movimentacao_estorno_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.transferencia_id
      WHERE m.transferencia_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compra_recebimentos r ON r.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (r.id IS NULL OR m.empresa_id IS DISTINCT FROM r.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM compra_recebimentos r LEFT JOIN compras c ON c.id = r.compra_id
      WHERE r.compra_id IS NULL OR c.id IS NULL OR r.empresa_id IS DISTINCT FROM c.empresa_id) +
    (SELECT count(*) FROM compra_recebimento_itens ri
       LEFT JOIN compra_recebimentos r ON r.id = ri.recebimento_id
       LEFT JOIN itens_compra i ON i.id = ri.item_compra_id
      WHERE ri.recebimento_id IS NULL OR ri.item_compra_id IS NULL OR r.id IS NULL OR i.id IS NULL
         OR ri.empresa_id IS DISTINCT FROM r.empresa_id
         OR ri.empresa_id IS DISTINCT FROM i.empresa_id)
    INTO refs_estrangeiras;

  IF refs_estrangeiras > 0 THEN
    RAISE EXCEPTION 'E4.2 preflight bloqueou o DDL: % referências operacionais ausentes ou de outra empresa (compra, recebimento, item, OP, estorno ou transferência). Nenhuma referência foi alterada.', refs_estrangeiras
      USING HINT = 'Use os SELECTs de diagnóstico documentados em docs/RELATORIO-E4.2.md; não associe por nome nem escolha um destino automaticamente.';
  END IF;
END
$e42_preflight_operacional$;

-- Campos indispensáveis às chaves de estoque/contagem. O diagnóstico acima
-- interrompe antes de tornar os vínculos obrigatórios.
ALTER TABLE estoques ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE estoques ALTER COLUMN local SET NOT NULL;
ALTER TABLE movimentacoes ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE estoque_insumos ALTER COLUMN insumo_id SET NOT NULL;
ALTER TABLE movimentacoes_insumos ALTER COLUMN insumo_id SET NOT NULL;
ALTER TABLE itens_inventario ALTER COLUMN inventario_id SET NOT NULL;
ALTER TABLE itens_inventario ALTER COLUMN produto_id SET NOT NULL;
ALTER TABLE itens_compra ALTER COLUMN compra_id SET NOT NULL;

-- Caixa PDV também guarda o local pelo ID canônico nas novas aberturas.
-- Caixas existentes ficam com local_id NULL; nenhum backfill por nome.
ALTER TABLE pdv_caixas ADD COLUMN IF NOT EXISTS local_id INTEGER REFERENCES locais(id);

-- Remove apenas a antiga unicidade global de locais.nome. O diagnóstico acima
-- ocorre antes e a substituição é por (empresa_id, nome), preservando homônimos
-- válidos entre empresas.
DO $e42_drop_global_local_unique$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.conrelid = 'public.locais'::regclass
       AND con.contype = 'u'
       AND array_length(con.conkey, 1) = 1
       AND a.attname = 'nome'
  LOOP
    EXECUTE format('ALTER TABLE public.locais DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$e42_drop_global_local_unique$;

-- Chaves únicas de destino para FKs compostas e invariantes de unicidade.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_id ON locais (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_empresa_nome ON locais (empresa_id, nome);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_locais_padrao_empresa ON locais (empresa_id) WHERE padrao IS TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_produtos_empresa_id ON produtos (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_inventarios_empresa_id ON inventarios (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_movimentacoes_empresa_id ON movimentacoes (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_insumos_empresa_id ON insumos (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_compras_empresa_id ON compras (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_compra_empresa_id ON itens_compra (empresa_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_recebimentos_empresa_id ON compra_recebimentos (empresa_id, id);
-- Saldo canônico: a chave de movimento usa o ID do local, nunca o nome.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_tam_local_id
  ON estoques (empresa_id, produto_id, tamanho_id, local_id)
  WHERE tamanho_id IS NOT NULL AND local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_sem_tam_local_id
  ON estoques (empresa_id, produto_id, local_id)
  WHERE tamanho_id IS NULL AND local_id IS NOT NULL;
-- Linhas históricas sem local_id permanecem no lugar e têm unicidade por texto
-- apenas para impedir duplicação da mesma chave legada; não são reenquadradas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_tam_legado
  ON estoques (empresa_id, produto_id, tamanho_id, local)
  WHERE tamanho_id IS NOT NULL AND local_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_estoques_empresa_prod_sem_tam_legado
  ON estoques (empresa_id, produto_id, local)
  WHERE tamanho_id IS NULL AND local_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_inv_empresa_prod_tam
  ON itens_inventario (empresa_id, inventario_id, produto_id, tamanho_id) WHERE tamanho_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_itens_inv_empresa_prod_sem_tam
  ON itens_inventario (empresa_id, inventario_id, produto_id) WHERE tamanho_id IS NULL;

CREATE INDEX IF NOT EXISTS e42_estoques_empresa_local_idx ON estoques (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_produto_idx ON movimentacoes (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_local_idx ON movimentacoes (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_mov_empresa_destino_idx ON movimentacoes (empresa_id, local_destino_id);
CREATE INDEX IF NOT EXISTS e42_inv_empresa_local_idx ON inventarios (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_pdv_caixas_empresa_local_idx ON pdv_caixas (empresa_id, local_id);
CREATE INDEX IF NOT EXISTS e42_itens_inv_empresa_inv_idx ON itens_inventario (empresa_id, inventario_id);
CREATE INDEX IF NOT EXISTS e42_itens_inv_empresa_prod_idx ON itens_inventario (empresa_id, produto_id);
CREATE INDEX IF NOT EXISTS e42_estoque_insumos_empresa_insumo_idx ON estoque_insumos (empresa_id, insumo_id);
CREATE INDEX IF NOT EXISTS e42_mov_insumos_empresa_insumo_idx ON movimentacoes_insumos (empresa_id, insumo_id);

-- Integridade composta: o ID estrangeiro precisa pertencer ao mesmo tenant.
-- NOT VALID é validado imediatamente abaixo e também protege toda escrita nova.
DO $e42_foreign_keys$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('estoques', 'fk_e42_estoques_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('estoques', 'fk_e42_estoques_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_destino', 'FOREIGN KEY (empresa_id, local_destino_id) REFERENCES locais (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_estorno', 'FOREIGN KEY (empresa_id, movimentacao_estorno_id) REFERENCES movimentacoes (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_transferencia', 'FOREIGN KEY (empresa_id, transferencia_id) REFERENCES movimentacoes (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id)'),
      ('movimentacoes', 'fk_e42_mov_empresa_item_compra', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id)'),
      ('inventarios', 'fk_e42_inventarios_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('pdv_caixas', 'fk_e42_pdv_caixas_empresa_local', 'FOREIGN KEY (empresa_id, local_id) REFERENCES locais (empresa_id, id)'),
      ('itens_inventario', 'fk_e42_itens_inv_empresa_inventario', 'FOREIGN KEY (empresa_id, inventario_id) REFERENCES inventarios (empresa_id, id) ON DELETE CASCADE'),
      ('itens_inventario', 'fk_e42_itens_inv_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('estoque_insumos', 'fk_e42_estoque_insumos_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_produto', 'FOREIGN KEY (empresa_id, produto_id) REFERENCES produtos (empresa_id, id)'),
      ('itens_compra', 'fk_e42_itens_compra_empresa_insumo', 'FOREIGN KEY (empresa_id, insumo_id) REFERENCES insumos (empresa_id, id)'),
      ('compra_recebimentos', 'fk_e42_recebimentos_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id) ON DELETE CASCADE'),
      ('compra_recebimento_itens', 'fk_e42_recebimento_itens_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id) ON DELETE CASCADE'),
      ('compra_recebimento_itens', 'fk_e42_recebimento_itens_empresa_item', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id) ON DELETE CASCADE'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_compra', 'FOREIGN KEY (empresa_id, compra_id) REFERENCES compras (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_recebimento', 'FOREIGN KEY (empresa_id, recebimento_id) REFERENCES compra_recebimentos (empresa_id, id)'),
      ('movimentacoes_insumos', 'fk_e42_mov_insumos_empresa_item_compra', 'FOREIGN KEY (empresa_id, item_compra_id) REFERENCES itens_compra (empresa_id, id)')
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
$e42_foreign_keys$;

COMMENT ON INDEX uq_e42_locais_empresa_nome IS 'E4.2: local é único apenas dentro da empresa.';
COMMENT ON INDEX uq_e42_locais_padrao_empresa IS 'E4.2: no máximo um local padrão por empresa.';
COMMENT ON INDEX uq_e42_estoques_empresa_prod_sem_tam_local_id IS 'E4.2: célula sem tamanho canônica é única por empresa/produto/ID do local.';
COMMENT ON INDEX uq_e42_estoques_empresa_prod_sem_tam_legado IS 'E4.2: saldos sem local_id preservam unicidade textual legada sem backfill.';
COMMENT ON INDEX uq_e42_itens_inv_empresa_prod_sem_tam IS 'E4.2: linha sem tamanho é única por empresa/inventário/produto.';
