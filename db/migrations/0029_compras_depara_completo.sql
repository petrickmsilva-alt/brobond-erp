-- ============================================================================
-- 0029 — DE-PARA DE SKU DE FORNECEDOR COMPLETO  (E3.2 · GAP-COMP-DEPARA-MENU)
--
-- Por que esta migração existe
-- ----------------------------
-- `produto_fornecedor_skus` já traduzia o código do fornecedor para o produto do
-- ERP, e era o que `importarXmlCompra` usava para resolver os itens da NF-e. Mas
-- ela guardava APENAS a associação:
--
--     fornecedor_id | codigo_fornecedor | produto_id | tamanho_id
--
-- Faltava o que um comprador precisa para MANTER o de-para sem abrir a NF:
--
--   • `descricao`  — como o fornecedor chama o item. Sem isso a linha é só um
--                    código solto e ninguém sabe conferir se o de-para está certo.
--   • `unidade`    — a unidade em que o fornecedor vende (CX, PC, KG, M). A
--                    quantidade da NF só faz sentido diante dela.
--   • `ativo`      — inativar um de-para obsoleto. Apagar destruiria o histórico
--                    das importações que o usaram; inativar preserva e para de
--                    sugerir.
--
-- Nada aqui é destrutivo: as três colunas entram com DEFAULT, então as linhas
-- existentes continuam válidas e o importador de XML não muda de comportamento.
--
-- Idempotente e reversível (ver o bloco de rollback no fim).
-- ============================================================================

-- ---- 1) colunas -----------------------------------------------------------
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS unidade   TEXT;
ALTER TABLE produto_fornecedor_skus ADD COLUMN IF NOT EXISTS ativo     BOOLEAN NOT NULL DEFAULT true;

-- A descrição do fornecedor costuma vir em caixa alta e com espaços duplos no
-- XML; normalizar na gravação é responsabilidade da aplicação, não do banco.
-- Aqui só garantimos que texto vazio não vire um valor "fantasma".
UPDATE produto_fornecedor_skus SET descricao = NULL WHERE btrim(COALESCE(descricao, '')) = '';
UPDATE produto_fornecedor_skus SET unidade   = NULL WHERE btrim(COALESCE(unidade, ''))   = '';

-- ---- 2) índice de busca ---------------------------------------------------
-- O de-para é consultado o tempo todo pelo par (fornecedor, código) — esse já é
-- UNIQUE. O que faltava era achar pelo PRODUTO: "de quais fornecedores eu
-- compro este SKU?" e a pesquisa por descrição na tela.
CREATE INDEX IF NOT EXISTS produto_fornecedor_skus_produto_idx
  ON produto_fornecedor_skus (produto_id);
CREATE INDEX IF NOT EXISTS produto_fornecedor_skus_ativos_idx
  ON produto_fornecedor_skus (empresa_id, ativo)
  WHERE ativo;

-- ============================================================================
-- ROLLBACK (aplicar manualmente; não roda sozinho)
--
--   DROP INDEX IF EXISTS produto_fornecedor_skus_ativos_idx;
--   DROP INDEX IF EXISTS produto_fornecedor_skus_produto_idx;
--   ALTER TABLE produto_fornecedor_skus DROP COLUMN IF EXISTS ativo;
--   ALTER TABLE produto_fornecedor_skus DROP COLUMN IF EXISTS unidade;
--   ALTER TABLE produto_fornecedor_skus DROP COLUMN IF EXISTS descricao;
-- ============================================================================
