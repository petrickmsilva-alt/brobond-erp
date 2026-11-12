-- ============================================================================
-- 0119 — COMMERCE ENGINE: INTEGRIDADE E HISTÓRICO DA PRECIFICAÇÃO
--
-- Corretivo da revisão arquitetural da PR #131. A 0118 criou a camada de preço
-- por condição, a memória de precificação e a política de preço mínimo; esta
-- migração corrige quatro lacunas reais apontadas na revisão, SEM criar um
-- segundo motor e SEM tocar em `produtos.preco_venda`/`preco_atacado`:
--
--   1. MEMÓRIA HISTÓRICA — `precificacao_memoria.produto_id`/`empresa_id` eram
--      ON DELETE CASCADE: apagar o produto (ou a empresa) APAGAVA a memória de
--      como o preço foi formado. Vira RESTRICT: a memória é histórico e não
--      pode ser destruída por uma exclusão de cadastro (mesma política já
--      aplicada a `vendas`). Cliente/venda/usuário seguem SET NULL (preservam).
--
--   2. VIGÊNCIA E HISTÓRICO DO PREÇO POR CONDIÇÃO — `produto_precos_condicao`
--      guardava um preço por (produto, canal, condição) sem vigência própria.
--      Ganha vigência inicial/final + autoria e uma tabela de HISTÓRICO
--      (`produto_precos_condicao_historico`), análoga a `listas_preco_historico`
--      mas no eixo (produto × canal × condição). A reimportação da planilha
--      passa a VERSIONAR (fecha a vigência anterior e abre a nova), nunca
--      apagando silenciosamente o preço anterior.
--
--   3. INTEGRIDADE DA CONDIÇÃO — FK COMPOSTA `(empresa_id, condicao)` →
--      `condicoes_pagamento (empresa_id, codigo)`: não existe preço de condição
--      órfã nem condição de outra empresa.
--
--   4. CUMULATIVIDADE EXPLÍCITA — o preço oficial da condição é o preço FINAL
--      por padrão. Desconto adicional só incide se houver autorização explícita
--      (`politicas_comerciais.autoriza_cumulativo` OU uma regra dedicada em
--      `politica_comercial_descontos_cumulativos`, com escopo/canal/cliente/
--      condição/prioridade/limites).
--
-- Aditiva e idempotente. Rollback (manutenção autorizada):
--   BEGIN;
--   DROP TABLE IF EXISTS politica_comercial_descontos_cumulativos;
--   DROP TABLE IF EXISTS produto_precos_condicao_historico;
--   ALTER TABLE politicas_comerciais DROP COLUMN IF EXISTS autoriza_cumulativo;
--   ALTER TABLE produto_precos_condicao
--     DROP COLUMN IF EXISTS vigencia_inicio, DROP COLUMN IF EXISTS vigencia_fim,
--     DROP COLUMN IF EXISTS criado_por, DROP COLUMN IF EXISTS atualizado_por;
--   DELETE FROM schema_migrations WHERE id = '0119_commerce_engine_preco_integridade.sql';
--   COMMIT;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) MEMÓRIA DE PRECIFICAÇÃO — proteção referencial (histórico não se apaga)
-- ----------------------------------------------------------------------------
ALTER TABLE precificacao_memoria DROP CONSTRAINT IF EXISTS precificacao_memoria_produto_id_fkey;
ALTER TABLE precificacao_memoria
  ADD CONSTRAINT precificacao_memoria_produto_id_fkey
  FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE RESTRICT;

ALTER TABLE precificacao_memoria DROP CONSTRAINT IF EXISTS precificacao_memoria_empresa_id_fkey;
ALTER TABLE precificacao_memoria
  ADD CONSTRAINT precificacao_memoria_empresa_id_fkey
  FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE RESTRICT;

-- O preço OFICIAL por condição é dado comercial do produto: apagar o produto
-- não pode apagá-lo em silêncio. Passa de CASCADE para RESTRICT (o produto se
-- DESATIVA, não se exclui — mesma política de `lotes`).
ALTER TABLE produto_precos_condicao DROP CONSTRAINT IF EXISTS produto_precos_condicao_produto_id_fkey;
ALTER TABLE produto_precos_condicao
  ADD CONSTRAINT produto_precos_condicao_produto_id_fkey
  FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE RESTRICT;

-- ----------------------------------------------------------------------------
-- 2) PREÇO POR CONDIÇÃO — vigência, autoria e histórico
-- ----------------------------------------------------------------------------
ALTER TABLE produto_precos_condicao
  ADD COLUMN IF NOT EXISTS vigencia_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS vigencia_fim DATE,
  ADD COLUMN IF NOT EXISTS criado_por INTEGER REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS atualizado_por INTEGER REFERENCES usuarios(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'produto_precos_condicao_vigencia_ck') THEN
    ALTER TABLE produto_precos_condicao
      ADD CONSTRAINT produto_precos_condicao_vigencia_ck
      CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio);
  END IF;
END $$;

-- Uma única linha VIGENTE (vigencia_fim IS NULL) por (empresa, produto, canal,
-- condição). As linhas HISTÓRICAS (vigencia_fim preenchida) não são limitadas:
-- é assim que a história sobrevive a reimportações.
DROP INDEX IF EXISTS uq_produto_precos_condicao;
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_precos_condicao_vigente
  ON produto_precos_condicao (empresa_id, produto_id, canal, condicao)
  WHERE vigencia_fim IS NULL;

CREATE TABLE IF NOT EXISTS produto_precos_condicao_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  canal TEXT NOT NULL,
  condicao TEXT NOT NULL,
  preco_anterior NUMERIC(12,2),
  preco_novo NUMERIC(12,2),
  vigencia_inicio DATE,
  vigencia_fim DATE,
  origem TEXT NOT NULL DEFAULT 'planilha',
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT produto_precos_condicao_historico_canal_ck CHECK (canal IN ('atacado', 'varejo'))
);
CREATE INDEX IF NOT EXISTS produto_precos_condicao_historico_idx
  ON produto_precos_condicao_historico (empresa_id, produto_id, canal, condicao, criado_em DESC);

-- ----------------------------------------------------------------------------
-- 3) INTEGRIDADE DA CONDIÇÃO — FK composta (empresa, condição)
--
-- `condicoes_pagamento` já tem o índice único (empresa_id, codigo) que a FK
-- exige. O par (empresa_id, condicao) do preço tem de existir no catálogo: sem
-- isso, um preço poderia apontar para uma condição inexistente ou de OUTRA
-- empresa. (O canal compatível é validado no aplicativo, porque
-- `condicoes_pagamento.canal` admite 'todos' e não há expressão de CHECK que
-- compare duas tabelas.)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_produto_precos_condicao_condicao') THEN
    ALTER TABLE produto_precos_condicao
      ADD CONSTRAINT fk_produto_precos_condicao_condicao
      FOREIGN KEY (empresa_id, condicao)
      REFERENCES condicoes_pagamento (empresa_id, codigo);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4) CUMULATIVIDADE EXPLÍCITA DE DESCONTO
-- ----------------------------------------------------------------------------
ALTER TABLE politicas_comerciais
  ADD COLUMN IF NOT EXISTS autoriza_cumulativo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS politica_comercial_descontos_cumulativos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  escopo TEXT NOT NULL DEFAULT 'geral',
  canal TEXT,
  condicao TEXT,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  prioridade INTEGER NOT NULL DEFAULT 0,
  inicio_em DATE,
  fim_em DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT politica_comercial_descontos_cumulativos_escopo_ck
    CHECK (escopo IN ('geral', 'canal', 'condicao', 'cliente', 'produto')),
  CONSTRAINT politica_comercial_descontos_cumulativos_canal_ck
    CHECK (canal IS NULL OR canal IN ('varejo', 'atacado', 'todos')),
  CONSTRAINT politica_comercial_descontos_cumulativos_desconto_ck
    CHECK (desconto_pct BETWEEN 0 AND 100),
  CONSTRAINT politica_comercial_descontos_cumulativos_vigencia_ck
    CHECK (inicio_em IS NULL OR fim_em IS NULL OR fim_em >= inicio_em)
);
CREATE INDEX IF NOT EXISTS politica_comercial_descontos_cumulativos_idx
  ON politica_comercial_descontos_cumulativos (empresa_id, escopo, canal);
