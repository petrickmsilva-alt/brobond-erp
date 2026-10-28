-- ============================================================================
-- 0061 — FECHAMENTO DO CONTRATO TIPO × COLUNA (P2-10)
--
-- O QUE ESTAVA ERRADO
-- -------------------
-- O contrato declarado em `server/src/resources.ts` e o banco real divergiam em
-- TRÊS pontos, e o gate `server/test/pg/contrato-tipo-coluna.test.ts` reprovava:
--
--   1. `crm_funis.nome`  — o recurso declara `uniqueEmpresa` (nome único DENTRO
--      da empresa), mas o banco só tinha `(empresa_id, id)`. Nome de funil
--      repetido passava pelo banco e o serviço tinha de adivinhar qual era qual.
--   2. `fiscal_obrigacoes.codigo` — o recurso declarava `unique` GLOBAL; o banco
--      tem `(empresa_id, codigo)`. O banco estava certo (duas empresas podem ter
--      a mesma obrigação) e a DECLARAÇÃO é que mentia. Corrigida em
--      `resources.ts` para `uniqueEmpresa`.
--   3. `plano_contas.codigo` — mesmo caso: o banco é por empresa (correto) e a
--      declaração dizia global. Corrigida em `resources.ts`.
--
-- POR QUE A CORREÇÃO É ASSIM
-- --------------------------
-- Os itens 2 e 3 NÃO pedem mudança de banco: a unicidade por empresa é a regra
-- certa no multiempresa, e afrouxar o índice seria pior. O erro era a declaração.
-- O item 1 é o contrário: a declaração está certa e faltava o índice. Criar o
-- índice sem tratar duplicata existente faria a migration FALHAR em base real —
-- então há normalização ANTES, determinística e auditável.
--
-- NORMALIZAÇÃO DE NOMES REPETIDOS (item 1)
-- ----------------------------------------
-- Funil com nome repetido na mesma empresa recebe sufixo ` (2)`, ` (3)`... em
-- ordem de `id` (o mais antigo mantém o nome). Nada é apagado e nada é
-- renomeado sem necessidade: se não houver duplicata, a migration não toca em
-- linha nenhuma.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  novo TEXT;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT id, empresa_id, nome,
           ROW_NUMBER() OVER (PARTITION BY empresa_id, nome ORDER BY id) AS posicao
      FROM crm_funis
  LOOP
    IF r.posicao > 1 THEN
      n := r.posicao;
      LOOP
        novo := left(btrim(r.nome), 110) || ' (' || n || ')';
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM crm_funis f
           WHERE f.empresa_id = r.empresa_id
             AND f.nome = novo
             AND f.id <> r.id
        );
        n := n + 1;
      END LOOP;
      UPDATE crm_funis SET nome = novo, atualizado_em = now() WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- Índice SIMPLES em (empresa_id, nome): o contrato tipo × coluna reconhece
-- unicidade por coluna, não por expressão. Case-insensitive ficaria fora do
-- contrato e passaria a ser uma regra só do serviço — pior: invisível ao banco.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_funis_empresa_nome
  ON crm_funis (empresa_id, nome);

COMMENT ON INDEX uq_crm_funis_empresa_nome IS
  'P2-10/0061: nome de funil é único DENTRO da empresa. Espelha a declaração uniqueEmpresa de resources.ts.';
