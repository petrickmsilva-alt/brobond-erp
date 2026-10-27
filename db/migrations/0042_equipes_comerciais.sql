-- ============================================================================
-- 0042 — MA-06 · EQUIPES COMERCIAIS E HIERARQUIA
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O cadastro de representantes é FINALIZADO e não recebe colunas de equipe,
-- líder ou supervisor. Equipe e hierarquia são ESTRUTURA ORGANIZACIONAL
-- (ERP-MASTER-ARCHITECTURE.md §8): entidades próprias, com vigência, para
-- preservar histórico e permitir roll-up de vendas/metas/comissão.
--
--   • equipes_comerciais   — a equipe (nome, líder, território, status);
--   • equipe_membros       — composição com papel, participação e vigência;
--   • representante_hierarquia — supervisor → subordinado (N níveis).
--
-- REGRAS
--   • um representante tem NO MÁXIMO um supervisor ativo (árvore, não grafo);
--   • ciclo é impossível (trigger sobe a cadeia + validação de serviço);
--   • histórico: saída/fim encerram a vigência — nada é apagado;
--   • `equipe_membros` é COMPOSIÇÃO da equipe (linha-filha): CASCADE, como
--     `itens_venda`/`grade_tamanhos`. As FKs para representantes são NO ACTION
--     (o diagnóstico de vínculos responde 409 antes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS equipes_comerciais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT,
  nome TEXT NOT NULL,
  descricao TEXT,
  lider_id INTEGER REFERENCES representantes(id),
  territorio_id INTEGER REFERENCES territorios(id),
  status TEXT NOT NULL DEFAULT 'ativo',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT equipes_comerciais_status_valido CHECK (status IN ('ativo', 'inativo'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_equipes_comerciais_empresa_nome
  ON equipes_comerciais (empresa_id, upper(nome));
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipes_comerciais_empresa_codigo
  ON equipes_comerciais (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';
CREATE INDEX IF NOT EXISTS equipes_comerciais_empresa_status_idx
  ON equipes_comerciais (empresa_id, status);
CREATE INDEX IF NOT EXISTS equipes_comerciais_lider_idx
  ON equipes_comerciais (empresa_id, lider_id);

CREATE TABLE IF NOT EXISTS equipe_membros (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  equipe_id INTEGER NOT NULL REFERENCES equipes_comerciais(id) ON DELETE CASCADE,
  representante_id INTEGER NOT NULL REFERENCES representantes(id),
  papel TEXT NOT NULL DEFAULT 'membro',
  participacao_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  entrada DATE NOT NULL DEFAULT CURRENT_DATE,
  saida DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT equipe_membros_papel_valido CHECK (papel IN ('membro', 'lider', 'supervisor')),
  CONSTRAINT equipe_membros_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT equipe_membros_vigencia CHECK (saida IS NULL OR saida >= entrada),
  CONSTRAINT equipe_membros_participacao CHECK (participacao_pct > 0 AND participacao_pct <= 100)
);

-- Um representante não entra duas vezes na MESMA equipe com vigência aberta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipe_membros_aberto
  ON equipe_membros (empresa_id, equipe_id, representante_id)
  WHERE status = 'ativo' AND saida IS NULL;
CREATE INDEX IF NOT EXISTS equipe_membros_equipe_idx
  ON equipe_membros (empresa_id, equipe_id, status);
CREATE INDEX IF NOT EXISTS equipe_membros_representante_idx
  ON equipe_membros (empresa_id, representante_id, status);

CREATE TABLE IF NOT EXISTS representante_hierarquia (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  supervisor_id INTEGER NOT NULL REFERENCES representantes(id),
  subordinado_id INTEGER NOT NULL REFERENCES representantes(id),
  nivel TEXT NOT NULL DEFAULT 'supervisor',
  inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fim DATE,
  status TEXT NOT NULL DEFAULT 'ativo',
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT representante_hierarquia_nivel_valido CHECK (nivel IN ('diretor', 'gerente', 'supervisor', 'coordenador')),
  CONSTRAINT representante_hierarquia_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT representante_hierarquia_sem_auto CHECK (supervisor_id <> subordinado_id),
  CONSTRAINT representante_hierarquia_vigencia CHECK (fim IS NULL OR fim >= inicio)
);

-- Árvore: no máximo UM supervisor ativo por subordinado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representante_hierarquia_ativa
  ON representante_hierarquia (empresa_id, subordinado_id)
  WHERE status = 'ativo' AND fim IS NULL;
CREATE INDEX IF NOT EXISTS representante_hierarquia_supervisor_idx
  ON representante_hierarquia (empresa_id, supervisor_id, status);

-- ----------------------------------------------------------------------------
-- Ciclo hierárquico é impossível: sobe a cadeia de supervisores a partir do
-- supervisor proposto e recusa se alcançar o próprio subordinado.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_hierarquia_sem_ciclo() RETURNS trigger AS $$
DECLARE
  atual  INTEGER := NEW.supervisor_id;
  passos INTEGER := 0;
BEGIN
  IF NEW.supervisor_id = NEW.subordinado_id THEN
    RAISE EXCEPTION 'um representante não pode ser supervisor de si mesmo' USING ERRCODE = '23514';
  END IF;

  WHILE atual IS NOT NULL LOOP
    IF atual = NEW.subordinado_id THEN
      RAISE EXCEPTION 'hierarquia comercial com ciclo' USING ERRCODE = '23514';
    END IF;
    passos := passos + 1;
    IF passos > 25 THEN
      RAISE EXCEPTION 'hierarquia comercial excede 25 níveis' USING ERRCODE = '23514';
    END IF;
    SELECT h.supervisor_id INTO atual
      FROM representante_hierarquia h
     WHERE h.subordinado_id = atual
       AND h.status = 'ativo'
       AND h.fim IS NULL
       AND h.empresa_id = NEW.empresa_id
       AND (TG_OP = 'INSERT' OR h.id <> NEW.id)
     LIMIT 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_representante_hierarquia_ciclo ON representante_hierarquia;
CREATE TRIGGER trg_representante_hierarquia_ciclo
  BEFORE INSERT OR UPDATE ON representante_hierarquia
  FOR EACH ROW EXECUTE FUNCTION brobond_hierarquia_sem_ciclo();
