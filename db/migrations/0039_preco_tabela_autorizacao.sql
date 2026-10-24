-- ============================================================================
-- 0039 — AUTORIZAÇÃO PARA ALTERAR O PREÇO DE TABELA NA VENDA.
--
-- O preço de tabela é a referência comercial da precificação/cadastro. Dentro
-- do módulo de venda, o desconto NÃO incide sobre ele (a base é o preço de
-- venda), mas ele continua sendo dado sensível: só o administrador — ou quem
-- ele autorizar explicitamente — pode alterá-lo.
--
-- A permissão segue o padrão das capacidades comerciais existentes
-- ('herdar' | 'permitir' | 'negar'). O DEFAULT 'herdar' NÃO libera: a
-- autorização precisa ser explícita. A checagem é feita no SERVIDOR
-- (server/src/services.ts :: podeEditarPrecoTabela); esconder o campo na tela
-- não é autorização.
--
-- 100% aditiva e idempotente: nenhum dado é reescrito, nenhuma coluna removida.
-- ============================================================================
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perm_preco_tabela TEXT NOT NULL DEFAULT 'herdar'
  CHECK (perm_preco_tabela IN ('herdar','permitir','negar'));
