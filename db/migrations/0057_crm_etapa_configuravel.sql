-- ============================================================================
-- 0057 — CRM: ETAPA DE OPORTUNIDADE REALMENTE CONFIGURÁVEL
--
-- PROBLEMA QUE ESTA MIGRAÇÃO RESOLVE
-- ----------------------------------
-- A 0051 criou `crm_funis` e `crm_etapas`, mas a oportunidade continuou presa
-- ao vocabulário FIXO da 0049:
--
--   CHECK (etapa IN ('prospeccao','qualificacao','proposta','negociacao','fechamento'))
--
-- Consequência real: cadastrar a etapa "Demonstração" no funil da empresa NÃO
-- permitia usar essa etapa em uma oportunidade. Ou seja, "funil configurável"
-- era verdade para o cadastro e mentira para o uso. Esta migração fecha essa
-- distância sem criar estrutura paralela:
--
--   1) `crm_oportunidades.etapa_id` passa a ser a REFERÊNCIA OPERACIONAL para
--      a etapa do cadastro (`crm_etapas.id`), com FK COMPOSTA por
--      (empresa_id, etapa_id) — o banco impede etapa de outro tenant.
--   2) `crm_oportunidades.etapa` (texto) é PRESERVADA. Ela deixa de ser a
--      autoridade e passa a ser a chave da etapa (cópia de `crm_etapas.chave`),
--      mantida para histórico, relatórios, índices existentes e compatibilidade
--      com integrações que já enviam/recebem a chave textual.
--   3) O CHECK de vocabulário fixo é SUBSTITUÍDO por "não vazio". Ele era
--      exatamente o que impedia etapa nova. A integridade passa a ser:
--      FK para o cadastro + validação de funil/ativo no serviço.
--
-- O QUE ESTA MIGRAÇÃO **NÃO** FAZ
-- -------------------------------
--   • NÃO remove `etapa` (nem coluna, nem dado): a remoção destruiria histórico
--     e quebraria leitores existentes; a prova de segurança é o backfill abaixo.
--   • NÃO cria tabela nova, nem `crm_oportunidades_v2`, nem etapa paralela.
--   • NÃO reescreve chaves: o backfill só PREENCHE `etapa_id` onde está nulo.
--   • NÃO apaga funil/etapa: `crm_etapas` continua com DELETE bloqueado por FK
--     RESTRICT quando houver oportunidade apontando para ela.
--
-- COMPATIBILIDADE
-- ---------------
--   • Registro antigo sem `etapa_id`: o backfill casa por (empresa, funil, chave)
--     e, se não houver casamento exato, usa a etapa de mesma chave no funil
--     padrão da empresa. Nada é inventado: só se aponta para etapa que já
--     existe no cadastro da MESMA empresa.
--   • Se a empresa não tiver nenhuma etapa cadastrada (base legada, por
--     exemplo), `etapa_id` permanece NULL e o texto continua valendo — é o
--     caminho de compatibilidade documentado no serviço (`crm.ts`).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) REFERÊNCIA OPERACIONAL PARA A ETAPA
-- ----------------------------------------------------------------------------
ALTER TABLE crm_oportunidades ADD COLUMN IF NOT EXISTS etapa_id INTEGER;

-- ----------------------------------------------------------------------------
-- 2) INTEGRIDADE MULTIEMPRESA NO PRÓPRIO BANCO (padrão E4.2)
--
-- `crm_etapas` já tem `empresa_id`; o índice único (empresa_id, id) permite a
-- FK composta que impede apontar para etapa de outra empresa mesmo em SQL
-- manual — a API sozinha não seria garantia suficiente.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_etapas_empresa_id
  ON crm_etapas (empresa_id, id);

DO $$ BEGIN
  ALTER TABLE crm_oportunidades
    ADD CONSTRAINT fk_e42_crm_oportunidades_empresa_etapa
    FOREIGN KEY (empresa_id, etapa_id) REFERENCES crm_etapas (empresa_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_etapa_id_idx
  ON crm_oportunidades (empresa_id, etapa_id);

-- ----------------------------------------------------------------------------
-- 3) CHAVE DA ETAPA COM FORMATO CANÔNICO
--
-- `chave` é a ponte entre cadastro e `crm_oportunidades.etapa`. Sem formato
-- canônico, "Demonstração" e "demonstracao" virariam chaves diferentes e o
-- mesmo estágio apareceria duas vezes no relatório. A constraint entra como
-- NOT VALID para não derrubar linha legada criada antes desta regra.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_chave_formato
    CHECK (chave ~ '^[a-z][a-z0-9_]{0,39}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 4) O CHECK DE VOCABULÁRIO FIXO SAI — ELE ERA O BLOQUEIO
--
-- Substituído por "chave não vazia". A validade agora é: a etapa existe no
-- cadastro da empresa (FK composta acima), pertence ao funil e está ativa
-- (validação no serviço, dentro da mesma transação da mudança).
-- ----------------------------------------------------------------------------
ALTER TABLE crm_oportunidades DROP CONSTRAINT IF EXISTS crm_oportunidades_etapa_valido;

DO $$ BEGIN
  ALTER TABLE crm_oportunidades ADD CONSTRAINT crm_oportunidades_etapa_nao_vazia
    CHECK (etapa IS NOT NULL AND btrim(etapa) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN crm_oportunidades.etapa IS
  'CRM 3.0/0057: chave da etapa do funil (cópia de crm_etapas.chave). Mantida para histórico e compatibilidade; a referência operacional é etapa_id.';

-- ----------------------------------------------------------------------------
-- 5) BACKFILL DETERMINÍSTICO
--
-- Só preenche onde está vazio. Casamento exato primeiro (mesma empresa, mesmo
-- funil quando a oportunidade já tem funil, mesma chave); depois, o funil
-- PADRÃO da empresa. Nenhuma etapa é criada aqui.
-- ----------------------------------------------------------------------------
UPDATE crm_oportunidades o
   SET etapa_id = e.id
  FROM crm_etapas e
 WHERE o.etapa_id IS NULL
   AND e.empresa_id = o.empresa_id
   AND e.chave = o.etapa
   AND (o.funil_id IS NULL OR e.funil_id = o.funil_id);

UPDATE crm_oportunidades o
   SET etapa_id = e.id,
       funil_id = COALESCE(o.funil_id, e.funil_id)
  FROM crm_etapas e
  JOIN crm_funis f ON f.id = e.funil_id AND f.empresa_id = e.empresa_id
 WHERE o.etapa_id IS NULL
   AND e.empresa_id = o.empresa_id
   AND f.padrao
   AND e.chave = o.etapa;

-- Diagnóstico honesto: se sobrou oportunidade sem vínculo, ela aparece aqui (e
-- continua funcionando pelo texto) em vez de o backfill "adivinhar" a etapa.
DO $$
DECLARE n_sem_vinculo INTEGER;
BEGIN
  SELECT COUNT(*) INTO n_sem_vinculo FROM crm_oportunidades WHERE etapa_id IS NULL;
  IF n_sem_vinculo > 0 THEN
    RAISE NOTICE '0057: % oportunidade(s) seguem SEM etapa_id (nenhuma etapa cadastrada compatível na empresa). O texto de `etapa` continua válido.', n_sem_vinculo;
  END IF;
END $$;
