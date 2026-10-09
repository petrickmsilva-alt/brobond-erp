-- ============================================================================
-- 0026 — FASE E2: produção completa
--
-- Ataca os gaps GAP-PROD-ESTADOS, GAP-PROD-PERDAS, GAP-PROD-CUSTO-OP,
-- GAP-PROD-CONSUMO-VINCULO, GAP-PROD-APONTAMENTOS, GAP-PROD-EVENTOS e
-- GAP-ESTQ-ORDEM-ID (docs/ERP-GAPS.md).
--
-- Esta migration é ADITIVA e REVERSÍVEL. Nenhuma tabela existente é renomeada,
-- nenhuma coluna é removida, nenhum CHECK existente é enfraquecido. O vínculo
-- antigo por texto (`motivo = 'Consumo — OP #N'`) continua sendo escrito —
-- ele deixa de ser a ÚNICA forma de achar o vínculo, não deixa de existir.
--
-- Blocos:
--   A) Máquina de estados da OP       (liberada, parcial + constraint CHECK)
--   B) Perdas, produzido e custos     (quantidade_*, custo_previsto/real)
--   C) Responsável e local de produção
--   D) Vínculo formal OP → estoque    (movimentacoes.ordem_id + backfill)
--   E) Vínculo formal OP → insumos    (movimentacoes_insumos.ordem_id + backfill)
--   F) Trilha de transições           (ordens_eventos, append-only)
--   G) Apontamentos de produção       (ordens_apontamentos)
--
-- Idempotente: pode ser aplicada duas vezes, em banco limpo e em banco migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) MÁQUINA DE ESTADOS
--
-- Fluxo da especificação:
--   PLANEJADA → LIBERADA → EM_PRODUÇÃO → PARCIAL → CONCLUÍDA   (+ CANCELADA)
--
-- `liberada` e `parcial` são estados NOVOS. Os quatro que já existiam
-- (planejada, em_producao, concluida, cancelada) continuam valendo com o mesmo
-- significado — nenhuma linha existente muda de sentido.
-- ----------------------------------------------------------------------------
-- NULL vira 'planejada' (o DEFAULT da coluna já é esse; só garante o histórico).
UPDATE ordens_fabricacao SET status = 'planejada' WHERE status IS NULL;

-- Diagnóstico ANTES de criar a constraint: se houver status fora do vocabulário,
-- a migration falha com a lista dos ids em vez de um erro críptico de CHECK.
DO $$
DECLARE
  invalidos TEXT;
BEGIN
  SELECT string_agg(id || ':' || status, ', ' ORDER BY id)
    INTO invalidos
    FROM ordens_fabricacao
   WHERE status NOT IN ('planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada');
  IF invalidos IS NOT NULL THEN
    RAISE EXCEPTION
      '0026_producao_completa: status inválido em ordens_fabricacao (%). Corrija esses registros antes de subir — a máquina de estados da E2 só aceita planejada, liberada, em_producao, parcial, concluida e cancelada.',
      invalidos;
  END IF;
END $$;

ALTER TABLE ordens_fabricacao DROP CONSTRAINT IF EXISTS ordens_fabricacao_status_valido;
ALTER TABLE ordens_fabricacao ADD CONSTRAINT ordens_fabricacao_status_valido CHECK (
  status IN ('planejada', 'liberada', 'em_producao', 'parcial', 'concluida', 'cancelada')
);

-- ----------------------------------------------------------------------------
-- B) PERDAS, PRODUZIDO E CUSTOS
--
-- Semântica (é o que o serviço implementa — a coluna só guarda):
--   • quantidade_produzida  peças BOAS apontadas na OP (soma dos apontamentos);
--   • quantidade_perdida    peças refugadas — consumiram insumo e não viram
--                           estoque. É isso que faz a perda custar dinheiro;
--   • custo_previsto        gravado na LIBERAÇÃO: peças planejadas × custo da
--                           ficha técnica naquele momento. Congelado de
--                           propósito: mudar a ficha depois não reescreve o
--                           que foi orçado;
--   • custo_real            insumos realmente baixados + mão de obra e
--                           indiretos reconhecidos na proporção processada.
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS quantidade_produzida INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS quantidade_perdida   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS custo_previsto NUMERIC(12,2);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS custo_real     NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE ordens_fabricacao DROP CONSTRAINT IF EXISTS ordens_fabricacao_qtd_nao_negativa;
ALTER TABLE ordens_fabricacao ADD CONSTRAINT ordens_fabricacao_qtd_nao_negativa CHECK (
  quantidade_produzida >= 0 AND quantidade_perdida >= 0 AND custo_real >= 0
);

-- Perda por tamanho na OP "por grade": espelho de itens_ordem.produzido.
-- Derivável dos apontamentos, mas mantido aqui porque a grade da OP lê a linha.
ALTER TABLE itens_ordem ADD COLUMN IF NOT EXISTS perdido INTEGER NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- C) RESPONSÁVEL, LOCAL DE PRODUÇÃO E MARCOS DE TEMPO
--
-- `faccao` (texto livre) continua existindo: é quem faz fora. `local_producao_id`
-- é onde a peça fica enquanto é produzida — a entrada de produto acabado na
-- conclusão usa este local quando ele existe, e cai no Local padrão quando não.
-- ----------------------------------------------------------------------------
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS responsavel_id      INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS local_producao_id   INTEGER REFERENCES locais(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS liberada_em         TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS liberada_por        INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS iniciada_em         TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS cancelada_em        TIMESTAMPTZ;
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS cancelada_por       INTEGER REFERENCES usuarios(id);
ALTER TABLE ordens_fabricacao ADD COLUMN IF NOT EXISTS motivo_cancelamento TEXT;

-- Índice das consultas do painel e do planejamento (empresa + status).
CREATE INDEX IF NOT EXISTS ordens_fabricacao_empresa_status_idx
  ON ordens_fabricacao (empresa_id, status);
CREATE INDEX IF NOT EXISTS ordens_fabricacao_empresa_previsao_idx
  ON ordens_fabricacao (empresa_id, previsao);

-- ----------------------------------------------------------------------------
-- D) VÍNCULO FORMAL OP → ESTOQUE  (GAP-ESTQ-ORDEM-ID)
--
-- Antes: a entrada de produto acabado era achada por TEXTO
-- (`motivo = 'Produção concluída — OP #N'`, server/src/producao.ts). Renomear a
-- string quebrava o estorno em silêncio. Agora a coluna existe, tem FK e índice;
-- o texto continua sendo escrito para legibilidade na tela de Movimentações.
--
-- ON DELETE SET NULL: apagar a OP não pode apagar a história do estoque.
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS ordem_id INTEGER REFERENCES ordens_fabricacao(id) ON DELETE SET NULL;

-- Backfill seguro: só preenche quando o id extraído do motivo REALMENTE existe
-- em ordens_fabricacao. Motivo sem padrão, ou com id órfão, fica NULL — nunca
-- se inventa vínculo.
UPDATE movimentacoes m
   SET ordem_id = x.oid::int
  FROM (
    SELECT mm.id, (regexp_match(mm.motivo, 'OP #(\d+)'))[1] AS oid
      FROM movimentacoes mm
     WHERE mm.ordem_id IS NULL
       AND mm.motivo ~ 'OP #[0-9]+'
  ) x
 WHERE m.id = x.id
   AND x.oid IS NOT NULL
   AND EXISTS (SELECT 1 FROM ordens_fabricacao o WHERE o.id = x.oid::int);

CREATE INDEX IF NOT EXISTS movimentacoes_ordem_idx       ON movimentacoes (ordem_id);
CREATE INDEX IF NOT EXISTS movimentacoes_empresa_ordem_idx ON movimentacoes (empresa_id, ordem_id);

-- ----------------------------------------------------------------------------
-- E) VÍNCULO FORMAL OP → INSUMOS  (GAP-PROD-CONSUMO-VINCULO)
-- ----------------------------------------------------------------------------
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS ordem_id INTEGER REFERENCES ordens_fabricacao(id) ON DELETE SET NULL;

UPDATE movimentacoes_insumos mi
   SET ordem_id = x.oid::int
  FROM (
    SELECT mm.id, (regexp_match(mm.motivo, 'OP #(\d+)'))[1] AS oid
      FROM movimentacoes_insumos mm
     WHERE mm.ordem_id IS NULL
       AND mm.motivo ~ 'OP #[0-9]+'
  ) x
 WHERE mi.id = x.id
   AND x.oid IS NOT NULL
   AND EXISTS (SELECT 1 FROM ordens_fabricacao o WHERE o.id = x.oid::int);

CREATE INDEX IF NOT EXISTS movimentacoes_insumos_ordem_idx         ON movimentacoes_insumos (ordem_id);
CREATE INDEX IF NOT EXISTS movimentacoes_insumos_empresa_ordem_idx ON movimentacoes_insumos (empresa_id, ordem_id);

-- ----------------------------------------------------------------------------
-- F) TRILHA DE TRANSIÇÕES DA OP  (GAP-PROD-EVENTOS)
--
-- Append-only, no mesmo formato das demais trilhas do ERP (expedicao_eventos,
-- envio_eventos, proposta_eventos). A empresa é DERIVADA da OP por trigger:
-- até um INSERT em SQL cru cai na empresa certa.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordens_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  de_status TEXT,
  para_status TEXT,
  mensagem TEXT,
  dados JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordens_eventos_evento_valido CHECK (evento IN (
    'criada', 'liberada', 'iniciada', 'apontamento', 'perda', 'consumo',
    'parcial', 'concluida', 'reaberta', 'cancelada', 'atalho', 'edicao'
  ))
);

CREATE INDEX IF NOT EXISTS ordens_eventos_ordem_idx   ON ordens_eventos (ordem_id, criado_em);
CREATE INDEX IF NOT EXISTS ordens_eventos_empresa_idx ON ordens_eventos (empresa_id, ordem_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- G) APONTAMENTOS DE PRODUÇÃO  (GAP-PROD-APONTAMENTOS)
--
-- Um apontamento é o que o chão de fábrica informa: "fiz N peças boas e
-- refuguei M neste tamanho". É ele que alimenta quantidade_produzida,
-- quantidade_perdida e o custo real — e é ele que consome insumo durante a
-- produção, em vez de tudo de uma vez na conclusão.
--
-- `idempotency_key` evita o duplo apontamento do mesmo turno quando a rede
-- repete o POST (mesmo mecanismo de `envios`).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordens_apontamentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  ordem_id INTEGER NOT NULL REFERENCES ordens_fabricacao(id) ON DELETE CASCADE,
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade_produzida INTEGER NOT NULL DEFAULT 0,
  quantidade_perdida INTEGER NOT NULL DEFAULT 0,
  observacoes TEXT,
  idempotency_key TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  apontado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordens_apontamentos_qtd_valida CHECK (
    quantidade_produzida >= 0
    AND quantidade_perdida >= 0
    AND (quantidade_produzida > 0 OR quantidade_perdida > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ordens_apontamentos_idem_uniq
  ON ordens_apontamentos (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordens_apontamentos_ordem_idx   ON ordens_apontamentos (ordem_id, apontado_em);
CREATE INDEX IF NOT EXISTS ordens_apontamentos_empresa_idx ON ordens_apontamentos (empresa_id, ordem_id, apontado_em DESC);

-- ----------------------------------------------------------------------------
-- Herança de empresa por trigger (mesma função de 0017, novos pares).
-- Reutiliza brobond_herdar_empresa, que já existe no schema.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_empresa_ordens_eventos ON ordens_eventos;
CREATE TRIGGER trg_empresa_ordens_eventos
  BEFORE INSERT OR UPDATE ON ordens_eventos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('ordens_fabricacao', 'ordem_id');

DROP TRIGGER IF EXISTS trg_empresa_ordens_apontamentos ON ordens_apontamentos;
CREATE TRIGGER trg_empresa_ordens_apontamentos
  BEFORE INSERT OR UPDATE ON ordens_apontamentos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('ordens_fabricacao', 'ordem_id');
