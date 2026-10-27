-- ============================================================================
-- 0041 — MA-02 · TERRITÓRIOS (domínio próprio, hierárquico)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Até aqui "território" era `representantes.regiao TEXT` (texto livre) e o
-- endereço do cliente. Isso não hierarquiza, não tem dono, não tem status e não
-- serve para carteira, meta nem indicador territorial.
--
-- Esta migration cria o DOMÍNIO de território — separado do cadastro de
-- representante (docs/ERP-MASTER-ARCHITECTURE.md §9). Ela é ADITIVA e
-- IDEMPOTENTE: não altera nenhuma tabela existente e NÃO migra
-- `representantes.regiao` (o texto legado continua valendo; um de-para futuro
-- pode popular `representante_territorio` sem apagar nada).
--
-- PRINCÍPIOS
--   • hierarquia LIVRE (auto-FK), não uma árvore fixa de níveis;
--   • território pode ser NÃO geográfico (comercial, digital, key account,
--     especial, canal) — geografia é opcional (uf/cidade);
--   • ciclo hierárquico é impossível: recusado pelo trigger no banco E pela
--     validação de serviço (defesa em profundidade);
--   • pai de outra empresa é recusado pelo trigger;
--   • `nivel` é DERIVADO do pai (nunca digitado à mão), limitado a 10;
--   • desativação (`status = 'inativo'`) preserva todo o histórico;
--   • exclusão com dependência continua devolvendo 409 pelo diagnóstico
--     (server/src/dependencias.ts) — nenhuma FK em CASCADE é criada aqui.
-- ============================================================================

CREATE TABLE IF NOT EXISTS territorios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT,
  nome TEXT NOT NULL,
  descricao TEXT,
  tipo TEXT NOT NULL DEFAULT 'comercial',
  territorio_pai_id INTEGER REFERENCES territorios(id),
  nivel INTEGER NOT NULL DEFAULT 1,
  responsavel_id INTEGER REFERENCES representantes(id),
  uf TEXT,
  cidade TEXT,
  status TEXT NOT NULL DEFAULT 'ativo',
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT territorios_status_valido CHECK (status IN ('ativo', 'inativo')),
  CONSTRAINT territorios_tipo_valido CHECK (tipo IN (
    'pais', 'estado', 'regiao', 'cidade', 'zona',
    'comercial', 'digital', 'key_account', 'especial', 'canal'
  )),
  CONSTRAINT territorios_nivel_valido CHECK (nivel >= 1 AND nivel <= 10),
  CONSTRAINT territorios_sem_auto_pai CHECK (territorio_pai_id IS NULL OR territorio_pai_id <> id)
);

-- Código é único POR EMPRESA — e só quando informado (nulo/vazio não colide).
CREATE UNIQUE INDEX IF NOT EXISTS uq_territorios_empresa_codigo
  ON territorios (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';

-- Nome é único entre irmãos (mesma empresa + mesmo pai). Sem isso, dois
-- "Zona Sul" no mesmo pai tornariam o relatório ambíguo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_territorios_empresa_nome_pai
  ON territorios (empresa_id, upper(nome), COALESCE(territorio_pai_id, 0));

CREATE INDEX IF NOT EXISTS territorios_empresa_pai_idx
  ON territorios (empresa_id, territorio_pai_id);
CREATE INDEX IF NOT EXISTS territorios_empresa_status_idx
  ON territorios (empresa_id, status);
CREATE INDEX IF NOT EXISTS territorios_empresa_tipo_idx
  ON territorios (empresa_id, tipo);
CREATE INDEX IF NOT EXISTS territorios_responsavel_idx
  ON territorios (empresa_id, responsavel_id);

-- ----------------------------------------------------------------------------
-- Hierarquia sã: pai da MESMA empresa, nível derivado, sem ciclo.
-- A checagem de ciclo sobe a cadeia a partir do pai; profundidade máxima 10
-- (a mesma do CHECK de nivel) impede laço infinito mesmo em dado corrompido.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_territorio_valida() RETURNS trigger AS $$
DECLARE
  pai        territorios%ROWTYPE;
  atual      INTEGER;
  passos     INTEGER := 0;
BEGIN
  IF NEW.nivel IS NULL OR NEW.nivel < 1 THEN
    NEW.nivel := 1;
  END IF;

  IF NEW.territorio_pai_id IS NULL THEN
    NEW.nivel := 1;
    RETURN NEW;
  END IF;

  SELECT * INTO pai FROM territorios WHERE id = NEW.territorio_pai_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'território pai inexistente' USING ERRCODE = '23503';
  END IF;
  IF pai.empresa_id <> NEW.empresa_id THEN
    RAISE EXCEPTION 'o território pai pertence a outra empresa' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS NOT NULL AND pai.id = NEW.id THEN
    RAISE EXCEPTION 'um território não pode ser pai de si mesmo' USING ERRCODE = '23514';
  END IF;

  NEW.nivel := COALESCE(pai.nivel, 1) + 1;
  IF NEW.nivel > 10 THEN
    RAISE EXCEPTION 'hierarquia de territórios excede 10 níveis' USING ERRCODE = '23514';
  END IF;

  atual := pai.id;
  WHILE atual IS NOT NULL LOOP
    passos := passos + 1;
    IF passos > 10 THEN
      RAISE EXCEPTION 'hierarquia de territórios com ciclo' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS NOT NULL AND atual = NEW.id THEN
      RAISE EXCEPTION 'hierarquia de territórios com ciclo' USING ERRCODE = '23514';
    END IF;
    SELECT territorio_pai_id INTO atual FROM territorios WHERE id = atual;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_territorios_valida ON territorios;
CREATE TRIGGER trg_territorios_valida
  BEFORE INSERT OR UPDATE ON territorios
  FOR EACH ROW EXECUTE FUNCTION brobond_territorio_valida();
