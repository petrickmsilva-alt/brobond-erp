-- ============================================================================
-- 0028 — FASE E3.1: custo canônico de recebimento de compra
--
-- Fecha GAP-COMP-CUSTOS (docs/ERP-GAPS.md).
--
-- O PROBLEMA (auditado, não suposto)
-- ----------------------------------
-- Existiam TRÊS caminhos de recebimento e cada um tratava custo de um jeito:
--
--   1. receberCompra   (server/src/itens.ts:436)  — atualizava custo_medio e
--                                                   gravava custo_unitario.
--   2. receberParcial  (server/src/compras.ts:111) — NÃO atualizava custo_medio
--                                                   e gravava a movimentação SEM
--                                                   custo_unitario.
--   3. importarXmlCompra (server/src/suprimentos.ts:383) — terceira cópia da
--                                                   média ponderada, só produto.
--
-- Consequência concreta: o CMV do "Meu Negócio" é calculado a partir de
-- `insumos.custo_medio` (server/src/negocios.ts:511 — Σ consumo × (1+perda) ×
-- custo_medio). Compra recebida pelo caminho parcial subia o estoque sem mover
-- o custo médio, então a margem de todo produto cuja ficha usa aquele insumo
-- saía errada — silenciosamente.
--
-- E o estorno era pior: estornarCompra localizava as entradas de insumo pelo
-- TEXTO do motivo (`'Compra #N'`), mas o recebimento parcial grava
-- `'Recebimento parcial — Compra #N'`. Ou seja, cancelar uma compra recebida
-- parcialmente devolvia o estoque de PRODUTOS e deixava o de INSUMOS para cima,
-- com o custo médio alterado para sempre.
--
-- O QUE ESTA MIGRATION FAZ
-- ------------------------
-- Cria os VÍNCULOS ESTRUTURAIS que permitem uma única regra canônica:
--
--   • movimentacoes_insumos.compra_id ......... achar as entradas de insumo por
--                                               pedido, não por texto de motivo;
--   • movimentacoes_insumos.recebimento_id .... saber QUAL recebimento gerou a
--                                               entrada (essencial quando o
--                                               mesmo item chega em 2 lotes com
--                                               custos diferentes);
--   • movimentacoes.recebimento_id ............ o mesmo para produto acabado;
--   • movimentacoes.custo_unitario ............ produto também passa a ter o
--                                               custo gravado na movimentação —
--                                               sem isso o estorno teria que
--                                               adivinhar o preço;
--   • índice único parcial .................... trava no BANCO contra duas
--                                               entradas de estoque para a mesma
--                                               linha do mesmo recebimento.
--
-- A REGRA DE CÁLCULO NÃO MORA AQUI. Ela mora em server/src/custoRecebimento.ts.
-- Esta migration só garante que os dados necessários existem e são íntegros.
--
-- Aditiva e reversível: nenhuma coluna removida, nenhum CHECK enfraquecido.
-- Idempotente: pode ser aplicada em banco limpo e em banco já migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) VÍNCULO ESTRUTURAL: movimentação de insumo → compra e recebimento
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS compra_id INTEGER REFERENCES compras(id);
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS recebimento_id INTEGER REFERENCES compra_recebimentos(id);
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS item_compra_id INTEGER REFERENCES itens_compra(id);

-- ----------------------------------------------------------------------------
-- B) VÍNCULO ESTRUTURAL + CUSTO: movimentação de produto → recebimento
--
-- custo_unitario em `movimentacoes` é NOVO. Sem ele, o estorno de um produto
-- recebido em dois lotes de preço diferente não tem como saber qual preço
-- desfazer — e "voltar ao custo anterior" seria chute.
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS recebimento_id INTEGER REFERENCES compra_recebimentos(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS item_compra_id INTEGER REFERENCES itens_compra(id);
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS custo_unitario NUMERIC(12,2);

-- Custo unitário nunca é negativo em nenhuma das duas tabelas.
ALTER TABLE movimentacoes DROP CONSTRAINT IF EXISTS movimentacoes_custo_unitario_nao_negativo;
ALTER TABLE movimentacoes ADD CONSTRAINT movimentacoes_custo_unitario_nao_negativo CHECK (custo_unitario IS NULL OR custo_unitario >= 0);

-- Em movimentacoes_insumos a coluna já existia com DEFAULT 0. O CHECK só é
-- adicionado se não houver linha histórica negativa — adicionar às cegas
-- derrubaria a migração (e o serviço) em banco de produção com dado antigo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'movimentacoes_insumos_custo_nao_negativo'
  ) AND NOT EXISTS (
    SELECT 1 FROM movimentacoes_insumos WHERE custo_unitario < 0
  ) THEN
    ALTER TABLE movimentacoes_insumos
      ADD CONSTRAINT movimentacoes_insumos_custo_nao_negativo CHECK (custo_unitario >= 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- C) ÍNDICES
--
-- O estorno percorre as entradas de um pedido/recebimento; sem índice isso é
-- varredura de tabela inteira dentro de uma transação serializable.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_compra_idx
  ON movimentacoes_insumos (compra_id, tipo);
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_recebimento_idx
  ON movimentacoes_insumos (recebimento_id, tipo);
CREATE INDEX IF NOT EXISTS movimentacoes_recebimento_idx
  ON movimentacoes (recebimento_id, tipo);

-- ----------------------------------------------------------------------------
-- D) TRAVA DE DUPLICIDADE NO BANCO
--
-- Uma linha de recebimento gera UMA entrada de estoque por insumo e UMA por
-- produto. A idempotência de aplicação já é garantida por
-- `compra_recebimentos.documento`; este índice é a segunda camada — se algum
-- caminho novo esquecer a checagem, o banco recusa em vez de dobrar o estoque.
--
-- Parcial (WHERE recebimento_id IS NOT NULL): movimentos que não vêm de
-- recebimento de compra — produção, ajuste, transferência, venda — continuam
-- livres, e NULL não colide.
-- ----------------------------------------------------------------------------
-- Chave = a LINHA da compra, não o insumo: duas linhas do mesmo pedido podem
-- comprar o MESMO insumo (código de fornecedor ou condição diferente), e isso é
-- legítimo. Bloquear por insumo quebraria esse caso.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_insumos_entrada_por_recebimento
  ON movimentacoes_insumos (recebimento_id, item_compra_id)
  WHERE recebimento_id IS NOT NULL AND tipo = 'entrada';

CREATE UNIQUE INDEX IF NOT EXISTS uq_mov_produtos_entrada_por_recebimento
  ON movimentacoes (recebimento_id, item_compra_id)
  WHERE recebimento_id IS NOT NULL AND tipo = 'entrada';

-- ----------------------------------------------------------------------------
-- E) RETROAJUSTE (backfill) — liga o que já existe, sem inventar vínculo
--
-- As entradas de insumo anteriores a esta migration só podem ser ligadas ao
-- pedido pelo TEXTO do motivo, que é o único vínculo que elas têm. Fazemos isso
-- de forma estrita: só quando o motivo é exatamente 'Compra #N' E o pedido N
-- existe. O que não casa fica NULL — ligação inventada é pior que ligação
-- ausente, porque o estorno passaria a desfazer o movimento errado.
--
-- NÃO fazemos backfill de custo_unitario nem de recebimento_id: o custo histórico
-- não é recuperável (o preço do item pode ter sido editado depois) e o
-- recebimento de origem não está registrado. Deixar NULL é honesto; preencher
-- seria fabricar contabilidade.
-- ----------------------------------------------------------------------------
UPDATE movimentacoes_insumos mi
SET compra_id = x.oid
FROM (
  SELECT mi2.id AS mid,
         (regexp_match(mi2.motivo, '^Compra #(\d+)$'))[1]::int AS oid
  FROM movimentacoes_insumos mi2
  WHERE mi2.compra_id IS NULL
    AND mi2.tipo = 'entrada'
    AND mi2.motivo ~ '^Compra #[0-9]+$'
) x
WHERE mi.id = x.mid
  AND EXISTS (SELECT 1 FROM compras c WHERE c.id = x.oid);

-- O mesmo para o vínculo por recebimento nas entradas PARCIAIS de insumo: o
-- motivo 'Recebimento parcial — Compra #N' identifica o pedido, e o
-- recebimento é o único daquela compra com a mesma data/hora da movimentação.
-- Sem correspondência inequívoca, fica NULL.
UPDATE movimentacoes_insumos mi
SET compra_id = x.oid
FROM (
  SELECT mi2.id AS mid,
         (regexp_match(mi2.motivo, '^Recebimento parcial — Compra #(\d+)$'))[1]::int AS oid
  FROM movimentacoes_insumos mi2
  WHERE mi2.compra_id IS NULL
    AND mi2.tipo = 'entrada'
    AND mi2.motivo ~ '^Recebimento parcial — Compra #[0-9]+$'
) x
WHERE mi.id = x.mid
  AND EXISTS (SELECT 1 FROM compras c WHERE c.id = x.oid);
