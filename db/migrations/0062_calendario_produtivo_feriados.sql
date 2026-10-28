-- ============================================================================
-- 0062 — CALENDÁRIO PRODUTIVO: FERIADOS POR EMPRESA (P2-15)
--
-- O QUE ESTAVA ERRADO
-- -------------------
-- A capacidade de produção contava dias úteis como "seg–sex". Em novembro isso
-- superestima a capacidade (2 feriados nacionais), em julho também, e em cidade
-- com feriado municipal o erro é maior ainda. Capacidade inflada = gargalo
-- escondido = prazo prometido que não se cumpre.
--
-- A DECISÃO
-- ---------
-- Feriado é DADO da empresa, não lista embutida no código:
--   • `data`       — o dia exato;
--   • `recorrente` — feriado de data fixa que se repete todo ano (25/12, 01/01,
--                    Aniversário da cidade). A recorrência é pelo DIA/MÊS;
--   • `tipo`       — nacional/estadual/municipal/empresa, para o usuário saber
--                    de onde veio;
--   • `uf`         — preenchido em feriado estadual/municipal.
--
-- Feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi) NÃO são
-- derivados por algoritmo nenhum: entram como `data` fixa, UMA linha por ano, porque
-- calcular a Páscoa e inventar o calendário de cada município criaria feriado
-- onde não existe.
--
-- O QUE O SISTEMA FAZ COM ISSO
-- ----------------------------
-- `server/src/calendario.ts`:
--   • `diasUteis(de, ate, empresaId)` — seg–sex MENOS feriados;
--   • `feriadosDoPeriodo(...)` — a lista que entrou no cálculo (auditável);
--   • capacidade de produção e MRP passam a usar esse calendário e a DEVOLVER
--     quais feriados foram considerados (`calendario`).
-- Sem feriado cadastrado, o comportamento é o anterior (seg–sex) e a resposta
-- diz `feriados_considerados: 0` — nada muda silenciosamente em base existente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS feriados (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  data DATE NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'nacional',
  uf TEXT,
  /** Feriado de data fixa: repete todo ano no mesmo dia/mês. */
  recorrente BOOLEAN NOT NULL DEFAULT FALSE,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

-- Um dia é feriado uma vez só por empresa. `data` guarda o ano de referência do
-- cadastro; a recorrência é aplicada na leitura (dia/mês), então não há risco
-- de colidir com o mesmo feriado do ano seguinte.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feriados_empresa_data
  ON feriados (empresa_id, data);

CREATE INDEX IF NOT EXISTS feriados_empresa_recorrente_idx
  ON feriados (empresa_id, ativo, recorrente);

DO $$ BEGIN
  ALTER TABLE feriados ADD CONSTRAINT feriados_tipo_valido
    CHECK (tipo IN ('nacional', 'estadual', 'municipal', 'empresa'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE feriados IS
  'P2-15/0062: calendário produtivo por empresa. `diasUteis` = seg–sex menos estes dias; `recorrente` repete todo ano no mesmo dia/mês (feriados móveis entram como linha anual, não são derivados).';
COMMENT ON COLUMN feriados.recorrente IS
  'P2-15/0062: feriado de data fixa repetido anualmente (25/12, 01/01). Feriados móveis (Carnaval, Sexta-feira Santa) NÃO são derivados — cadastre uma linha por ano.';
