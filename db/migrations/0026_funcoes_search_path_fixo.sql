-- ============================================================================
-- 0026 — search_path fixo nas funções do schema
--
-- O QUE ESTAVA QUEBRADO
-- ---------------------
-- Duas funções do ERP leem tabelas pelo nome simples (`compra_recebimento_itens`,
-- `%I`) sem declarar `SET search_path`. Enquanto a sessão usa o search_path
-- padrão (`"$user", public`) tudo resolve em `public` e ninguém percebe.
--
-- Só que nem toda sessão usa o search_path padrão. O caso que expôs o bug:
--
--   • `pg_restore` emite `SELECT pg_catalog.set_config('search_path', '', false)`
--     no início de CADA restore, justamente para não depender do ambiente;
--   • com o search_path vazio, `brobond_qtd_recebida_item()` não encontra
--     `compra_recebimento_itens`;
--   • essa função está dentro do CHECK `itens_compra_nao_excede_pedido`;
--   • o Postgres faz *inline* da função ao avaliar o CHECK durante o COPY;
--   • resultado: **restaurar um dump de um banco com dados em `itens_compra`
--     falha com "relation does not exist"**.
--
-- Ou seja: o backup era feito todo dia e não era restaurável — e isso só
-- aparece no dia do desastre. A prova de restore do scripts/backup-postgres.sh
-- foi o que pegou.
--
-- Os mesmos riscos valem para `ALTER ROLE ... SET search_path`, apply workers de
-- replicação lógica e qualquer cliente que qualifique o schema explicitamente.
--
-- A CORREÇÃO
-- ----------
-- Fixar o search_path NA FUNÇÃO (`SET search_path = pg_catalog, public`), que é
-- o que a documentação do Postgres recomenda para função chamada por
-- constraint/trigger. `pg_catalog` vem primeiro de propósito: além de resolver
-- operadores e tipos, impede que um objeto malicioso criado em `public`
-- shadows-e uma função do catálogo (CVE de search_path hijacking).
--
-- `CREATE OR REPLACE` mantém assinatura, corpo e volatilidade idênticos — só
-- acrescenta o `SET`. É idempotente: pode rodar quantas vezes quiser.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) brobond_qtd_recebida_item — usada no CHECK itens_compra_nao_excede_pedido
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_qtd_recebida_item(item_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(cri.quantidade), 0)
  FROM compra_recebimento_itens cri
  JOIN compra_recebimentos cr ON cr.id = cri.recebimento_id
  WHERE cri.item_compra_id = item_id;
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public;

-- ----------------------------------------------------------------------------
-- 2) brobond_herdar_empresa — trigger de herança de empresa das 12 tabelas-filhas
--
--    Ela monta SQL com `format('SELECT empresa_id FROM %I ...', pai_tabela)`, e
--    `pai_tabela` chega pelo TG_ARGV sem qualificação de schema. Mesmo risco,
--    mesmo remédio. (No restore ela não dispara porque trigger é criado na fase
--    post-data, depois dos dados — mas em produção qualquer sessão com
--    search_path diferente quebraria a herança de empresa silenciosamente.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_herdar_empresa() RETURNS trigger AS $$
DECLARE
  pai_tabela TEXT := TG_ARGV[0];
  fk_coluna  TEXT := TG_ARGV[1];
  fk_valor   INTEGER;
  empresa    INTEGER;
BEGIN
  EXECUTE format('SELECT ($1).%I', fk_coluna) INTO fk_valor USING NEW;
  IF fk_valor IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT empresa_id FROM %I WHERE id = $1', pai_tabela)
    INTO empresa USING fk_valor;
  IF empresa IS NOT NULL THEN
    NEW.empresa_id := empresa;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
