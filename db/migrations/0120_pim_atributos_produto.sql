-- ============================================================================
-- 0120 — PIM: ATRIBUTOS DE PRODUTO (composição, material, modelagem, gênero,
--        origem do dado e ATRIBUTOS ADICIONAIS)
--
-- A planilha-base ("TABELA DE PREÇO BASE PARA ERP.xlsx") traz informação de
-- cadastro que o modelo não tinha onde guardar sem esmagá-la em texto livre:
--   • Fornecedor (aba "Política Comercial Roupas (2)" — LEMONETTE/CEREJA DOCE) e
--     Tipo (PÇ/UN) — usados no de-para e na unidade de medida;
--   • colunas próprias de cada aba (nomes de fornecedor, colunas calculadas de
--     conferência) que NÃO são preço oficial nem devem ser descartadas em
--     silêncio.
--
-- Esta migração NÃO inventa valor: todo atributo nasce NULO/vazio e só passa a
-- valer quando o Diretor/importador o preenche. Também NÃO cria uma segunda
-- fonte de verdade de estoque nem um segundo motor de preço.
--
-- Aditiva e idempotente. Rollback (manutenção autorizada):
--   BEGIN;
--   DROP INDEX IF EXISTS produtos_origem_dados_idx;
--   DROP INDEX IF EXISTS produtos_atributos_adicionais_gin;
--   ALTER TABLE produtos
--     DROP COLUMN IF EXISTS composicao_material,   -- nome reservado: ver nota
--     ...
--   DELETE FROM schema_migrations WHERE id = '0120_pim_atributos_produto.sql';
--   COMMIT;
--
-- Nota de rollback: as colunas abaixo são o conjunto exato criado aqui.
--   material, modelagem, genero, origem_dados, atributos_adicionais.
--   (`composicao` já existe desde o schema-base e NÃO é recriada.)
-- ============================================================================

-- Composição já existe (`produtos.composicao`) — não duplicar.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS material TEXT;              -- ex.: algodão, poliéster, linho
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS modelagem TEXT;             -- ex.: skinny, regular, wide, oversized
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS genero TEXT;                -- ex.: masculino, feminino, unissex, infantil
-- Origem do dado de cadastro: 'planilha' | 'manual' | 'importacao' | 'api'...
-- Governa a procedência do registro (auditoria do PIM), não o preço.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS origem_dados TEXT;
-- ATRIBUTOS ADICIONAIS: propriedades realmente variáveis da planilha (colunas
-- próprias de cada aba, metadados de fornecedor) que não têm coluna tipada.
-- É um BOLSA de atributos — nunca substitui as colunas relacionais centrais
-- (SKU, preço, cor, tamanho, categoria), que continuam sendo a fonte canônica.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS atributos_adicionais JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Índices: procedência do cadastro e busca dentro dos atributos adicionais.
CREATE INDEX IF NOT EXISTS produtos_origem_dados_idx ON produtos (empresa_id, origem_dados);
CREATE INDEX IF NOT EXISTS produtos_atributos_adicionais_gin ON produtos USING gin (atributos_adicionais);

-- `atributos_adicionais` precisa ser um OBJETO JSON (nunca escalar/lista): o
-- código sempre grava um mapa chave→valor. CHECK aditivo e idempotente.
ALTER TABLE produtos DROP CONSTRAINT IF EXISTS produtos_atributos_adicionais_obj_ck;
ALTER TABLE produtos
  ADD CONSTRAINT produtos_atributos_adicionais_obj_ck
  CHECK (jsonb_typeof(atributos_adicionais) = 'object');
