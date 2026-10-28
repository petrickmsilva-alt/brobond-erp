-- ============================================================================
-- 0058 — CRM: FECHAMENTO DO HARDENING P2/P3
--
-- Esta migration fecha TRÊS pendências reais apontadas na matriz de gaps e
-- resolve, no banco, a constraint `crm_etapas.chave` que nasceu NOT VALID na
-- 0057 e nunca foi validada:
--
--   GAP-P2-19 — o histórico de estágio guardava só a CHAVE (`estagio_novo`).
--               Renomear `crm_etapas.nome` reescrevia a leitura do passado.
--               Aqui o histórico passa a guardar SNAPSHOT do que existia no
--               momento da transição: id + nome da etapa anterior e da nova,
--               o funil e o nome do usuário.
--
--   GAP-P2-20 — `crm_etapas_chave_formato` foi criada NOT VALID. Uma
--               constraint NOT VALID protege escrita nova mas NÃO prova que
--               os dados existentes obedecem à regra. Aqui os dados inválidos
--               são corrigidos de forma DETERMINÍSTICA (normalização de
--               caixa/acento/pontuação) e a constraint é VALIDADA de verdade.
--
--   GAP-P2-18 — reordenação de etapas. O banco passa a garantir o invariante
--               "uma ordem por etapa dentro do funil" (índice único), depois
--               de renumerar o que existia para uma sequência contígua 1..N.
--
-- REGRAS RESPEITADAS
-- ------------------
--   • Nada é apagado. Nenhum registro histórico é inventado.
--   • Linha histórica antiga NÃO recebe nome retroativo: `snapshot_versao = 0`
--     marca "não havia snapshot" e a API devolve `nome_historico_indisponivel`
--     em vez de fingir que o nome atual era o da época.
--   • `crm_etapas.chave` é a identidade estável citada por
--     `crm_oportunidades.etapa`; por isso a normalização roda em DOIS passos
--     (renomear a chave E propagar para as oportunidades que a citavam) para
--     não deixar oportunidade apontando para chave que não existe mais.
--   • `id` das etapas nunca muda.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) HISTÓRICO DE ESTÁGIO — SNAPSHOT HISTÓRICO
--
-- A trilha deixa de depender do cadastro ATUAL para descrever o passado.
-- `snapshot_versao` é o marcador honesto de "esta linha tem snapshot":
--   0 = linha anterior a esta migration (nome/id desconhecidos no momento)
--   1 = linha gravada já com snapshot
-- ----------------------------------------------------------------------------
ALTER TABLE crm_oportunidade_estagio_historico
  ADD COLUMN IF NOT EXISTS funil_id INTEGER,
  ADD COLUMN IF NOT EXISTS estagio_anterior_id INTEGER,
  ADD COLUMN IF NOT EXISTS estagio_novo_id INTEGER,
  ADD COLUMN IF NOT EXISTS estagio_anterior_nome TEXT,
  ADD COLUMN IF NOT EXISTS estagio_novo_nome TEXT,
  ADD COLUMN IF NOT EXISTS usuario_nome TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_versao SMALLINT NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE crm_oportunidade_estagio_historico
    ADD CONSTRAINT crm_estagio_hist_snapshot_versao_valida
    CHECK (snapshot_versao IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- As colunas de ID são SNAPSHOT: apontam para a etapa que existia na hora da
-- transição. A FK é composta por empresa (padrão E4.2) e usa
-- `ON DELETE SET NULL` nas PRÓPRIAS colunas de snapshot — excluir uma etapa
-- não reescreve o nome já gravado e não fica impedido por causa de histórico.
DO $$ BEGIN
  ALTER TABLE crm_oportunidade_estagio_historico
    ADD CONSTRAINT fk_crm_estagio_hist_etapa_anterior
    FOREIGN KEY (empresa_id, estagio_anterior_id)
    REFERENCES crm_etapas (empresa_id, id)
    ON DELETE SET NULL (estagio_anterior_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_column THEN NULL;  -- instalação sem a 0057 aplicada
END $$;

DO $$ BEGIN
  ALTER TABLE crm_oportunidade_estagio_historico
    ADD CONSTRAINT fk_crm_estagio_hist_etapa_nova
    FOREIGN KEY (empresa_id, estagio_novo_id)
    REFERENCES crm_etapas (empresa_id, id)
    ON DELETE SET NULL (estagio_novo_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_column THEN NULL;
END $$;

-- Alvo da FK composta abaixo: o par (empresa_id, id) precisa ser único para o
-- PostgreSQL aceitar a referência. Mesmo padrão da 0057 para `crm_etapas`.
CREATE UNIQUE INDEX IF NOT EXISTS uq_e42_crm_funis_empresa_id
  ON crm_funis (empresa_id, id);

DO $$ BEGIN
  ALTER TABLE crm_oportunidade_estagio_historico
    ADD CONSTRAINT fk_crm_estagio_hist_funil
    FOREIGN KEY (empresa_id, funil_id)
    REFERENCES crm_funis (empresa_id, id)
    ON DELETE SET NULL (funil_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;   -- base sem crm_funis
END $$;

CREATE INDEX IF NOT EXISTS crm_estagio_hist_etapa_nova_idx
  ON crm_oportunidade_estagio_historico (empresa_id, estagio_novo_id);

COMMENT ON COLUMN crm_oportunidade_estagio_historico.snapshot_versao IS
  'CRM 3.0/0058: 0 = linha anterior ao snapshot (nome/id da etapa não foram registrados na época; NÃO são inferidos do cadastro atual); 1 = snapshot gravado na transição.';
COMMENT ON COLUMN crm_oportunidade_estagio_historico.estagio_novo_nome IS
  'CRM 3.0/0058: rótulo da etapa NO MOMENTO da transição. Renomear a etapa depois NÃO altera este valor.';

-- ----------------------------------------------------------------------------
-- 2) `crm_etapas.chave` — NORMALIZAÇÃO DETERMINÍSTICA + VALIDATE CONSTRAINT
--
-- A regra é `^[a-z][a-z0-9_]{0,39}$` (a mesma da 0057). Nenhuma chave é
-- "inventada": a transformação é puramente mecânica (minúscula, sem acento,
-- pontuação → `_`) e preserva o significado. Colisão dentro do funil recebe
-- sufixo numérico — e, quando acontece, as oportunidades que citavam a chave
-- antiga são atualizadas para a chave final, para não sobrar referência órfã.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  base TEXT;
  nova TEXT;
  n INTEGER;
  antiga TEXT;
BEGIN
  FOR r IN
    SELECT id, funil_id, chave FROM crm_etapas
     WHERE chave IS NULL OR chave !~ '^[a-z][a-z0-9_]{0,39}$'
     ORDER BY id
  LOOP
    antiga := r.chave;

    base := coalesce(r.chave, '');
    base := lower(btrim(base));
    -- acentos → ASCII (sem depender da extensão unaccent, que não é padrão)
    base := translate(base,
      'áàâãäåéèêëíìîïóòôõöúùûüçñýÿÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
      'aaaaaaeeeeiiiiooooouuuucnyyAAAAAAEEEEIIIIOOOOOUUUUCNY');
    base := regexp_replace(base, '[^a-z0-9]+', '_', 'g');
    base := regexp_replace(base, '^_+', '', 'g');
    base := regexp_replace(base, '_+$', '', 'g');
    base := regexp_replace(base, '_{2,}', '_', 'g');
    IF base = '' THEN base := 'etapa'; END IF;
    IF base !~ '^[a-z]' THEN base := 'e_' || base; END IF;
    base := left(base, 40);
    base := regexp_replace(base, '_+$', '', 'g');

    nova := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM crm_etapas x
       WHERE x.funil_id = r.funil_id AND x.chave = nova AND x.id <> r.id
    ) LOOP
      n := n + 1;
      nova := left(base, 40 - (length(n::text) + 1)) || '_' || n;
    END LOOP;

    UPDATE crm_etapas SET chave = nova, atualizado_em = now() WHERE id = r.id;

    -- Referência textual preservada: a oportunidade que citava a chave antiga
    -- passa a citar a chave final (mesma etapa, mesmo funil, mesmo id).
    IF antiga IS NOT NULL AND antiga <> nova THEN
      UPDATE crm_oportunidades
         SET etapa = nova, atualizado_em = now()
       WHERE empresa_id = (SELECT empresa_id FROM crm_etapas WHERE id = r.id)
         AND funil_id = r.funil_id
         AND etapa = antiga;
    END IF;

    RAISE NOTICE '0058: crm_etapas #% — chave % → %', r.id, coalesce(antiga, '(nula)'), nova;
  END LOOP;
END $$;

-- Agora a constraint existente pode ser VALIDADA. Se a 0057 não tiver rodado
-- (banco criado só com a base), a constraint é criada já válida — o estado
-- final é o mesmo: regra em vigor E comprovada nos dados.
DO $$ BEGIN
  ALTER TABLE crm_etapas VALIDATE CONSTRAINT crm_etapas_chave_formato;
EXCEPTION
  WHEN undefined_object THEN
    ALTER TABLE crm_etapas ADD CONSTRAINT crm_etapas_chave_formato
      CHECK (chave ~ '^[a-z][a-z0-9_]{0,39}$');
END $$;

-- ----------------------------------------------------------------------------
-- 3) ORDEM DO FUNIL — SEQUÊNCIA CONTÍGUA E ÚNICA
--
-- Reordenar etapas só é seguro se "ordem" for única POR FUNIL. Antes disso o
-- campo era só um número: duas etapas podiam ter ordem 0 e a posição exibida
-- dependia do desempate por nome. A renumeração abaixo é determinística
-- (ordem, id) e o índice único passa a impedir duplicata — inclusive em SQL
-- manual, não só pela API.
-- ----------------------------------------------------------------------------
WITH renumeradas AS (
  SELECT id, row_number() OVER (PARTITION BY funil_id ORDER BY ordem, id)::int AS nova_ordem
    FROM crm_etapas
)
UPDATE crm_etapas e
   SET ordem = r.nova_ordem, atualizado_em = now()
  FROM renumeradas r
 WHERE e.id = r.id
   AND e.ordem IS DISTINCT FROM r.nova_ordem;

CREATE UNIQUE INDEX IF NOT EXISTS crm_etapas_funil_ordem_unico
  ON crm_etapas (funil_id, ordem);

COMMENT ON INDEX crm_etapas_funil_ordem_unico IS
  'CRM 3.0/0058: posição da etapa é única dentro do funil. A reordenação transacional (POST /api/crm/funis/:id/etapas/reordenar) renumera 1..N na mesma transação.';

-- ----------------------------------------------------------------------------
-- 4) LEAD SCORING — CLASSIFICAÇÃO E FATORES ESTRUTURADOS
--
-- O score já existia como número + frase. Para ser AUDITÁVEL, cada parcela
-- precisa ser legível por programa (não só por humano) — daí `score_fatores`
-- em JSONB e a classificação derivada do próprio score.
-- ----------------------------------------------------------------------------
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_classificacao TEXT;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS score_fatores JSONB;

DO $$ BEGIN
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_score_classificacao_valida
    CHECK (score_classificacao IS NULL OR score_classificacao IN ('frio', 'morno', 'quente', 'prioritario'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN crm_leads.score_classificacao IS
  'CRM 3.0/0058: faixa derivada do score (frio < 25 ≤ morno < 50 ≤ quente < 75 ≤ prioritario). Calculada pelo servidor; o cliente não escreve.';
COMMENT ON COLUMN crm_leads.score_fatores IS
  'CRM 3.0/0058: cada parcela do score com nome, pontos e evidência — permite auditar o número sem reexecutar a regra.';

-- ----------------------------------------------------------------------------
-- 5) ATIVIDADES — LEMBRETE DISPARADO UMA ÚNICA VEZ
--
-- Sem marca de envio, um scheduler que roda a cada minuto reenviaria o mesmo
-- lembrete para sempre. `lembrete_enviado_em` é a chave de idempotência do
-- disparo (UPDATE condicional ... WHERE lembrete_enviado_em IS NULL).
-- ----------------------------------------------------------------------------
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS lembrete_enviado_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMPTZ;
ALTER TABLE crm_atividades ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

CREATE INDEX IF NOT EXISTS crm_atividades_lembrete_pendente_idx
  ON crm_atividades (empresa_id, lembrete_em)
  WHERE status = 'pendente' AND lembrete_enviado_em IS NULL;

COMMENT ON COLUMN crm_atividades.lembrete_enviado_em IS
  'CRM 3.0/0058: instante em que o lembrete virou notificação. NULL = ainda não disparado. Marca de idempotência: o disparo é um UPDATE ... WHERE lembrete_enviado_em IS NULL.';
