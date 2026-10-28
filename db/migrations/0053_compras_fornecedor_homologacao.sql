-- ============================================================================
-- 0053 — COMPRAS: HOMOLOGAÇÃO DE FORNECEDOR, DOCUMENTOS E HISTÓRICO
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O cadastro de fornecedores já existia (razão social, documento, contato,
-- endereço, prazo e condição de pagamento). O que NÃO existia era o processo
-- de HOMOLOGAÇÃO: saber se o fornecedor está apto a receber pedido, com que
-- abrangência, com quais documentos e até quando. Sem isso, qualquer cadastro
-- podia comprar — inclusive um fornecedor suspenso por qualidade.
--
-- O que entra aqui:
--   1) ESTADO DE HOMOLOGAÇÃO no próprio fornecedor (uma coluna, não um
--      cadastro paralelo): PENDENTE → EM_ANALISE → HOMOLOGADO →
--      SUSPENSO → BLOQUEADO. A transição é registrada na trilha (item 3).
--   2) DOCUMENTOS do fornecedor (validade, número, arquivo/referência), cada
--      um com situação própria. "Vencido" é DERIVADO da validade — não é
--      coluna, para não existir status que envelhece sozinho no banco.
--   3) TRILHA DE HOMOLOGAÇÃO (append-only): quem mudou, de qual estado para
--      qual, quando e por quê.
--
-- REGRAS QUE NÃO MUDAM
--   • `fornecedores` continua sendo UMA tabela, por empresa (empresa_id),
--     e continua sendo o único cadastro de fornecedor do ERP;
--   • nada é apagado: SUSPENSO/BLOQUEADO são estados, não DELETE;
--   • nenhum pedido de compra é criado automaticamente por esta migração;
--   • o desempenho do fornecedor (prazo, atendimento, preço) é CALCULADO a
--     partir de compras/itens/recebimentos já existentes — nenhum número é
--     copiado nem duplicado em coluna.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) ESTADO DE HOMOLOGAÇÃO
-- ----------------------------------------------------------------------------
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_status TEXT NOT NULL DEFAULT 'pendente';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_categoria TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_responsavel_id INTEGER REFERENCES usuarios(id);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologado_em TIMESTAMPTZ;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_atualizada_em TIMESTAMPTZ;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS validade_documentos DATE;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS avaliacao_manual NUMERIC(3,1);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS homologacao_motivo TEXT;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_status_valido
    CHECK (homologacao_status IN ('pendente', 'em_analise', 'homologado', 'suspenso', 'bloqueado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_categoria_valida
    CHECK (homologacao_categoria IS NULL OR homologacao_categoria IN
      ('materia_prima', 'embalagem', 'acabamento', 'servico', 'logistica', 'quimico', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_avaliacao_manual_valida
    CHECK (avaliacao_manual IS NULL OR (avaliacao_manual >= 0 AND avaliacao_manual <= 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Homologado exige carimbo de data; suspenso/bloqueado exigem motivo (a
-- decisão precisa ser explicável — mesma lógica de "motivo da perda" no CRM).
DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_homologacao_coerente
    CHECK (
      (homologacao_status <> 'homologado' OR homologado_em IS NOT NULL)
      AND (homologacao_status NOT IN ('suspenso', 'bloqueado') OR (homologacao_motivo IS NOT NULL AND btrim(homologacao_motivo) <> ''))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS fornecedores_homologacao_idx
  ON fornecedores (empresa_id, homologacao_status);

-- ----------------------------------------------------------------------------
-- 2) DOCUMENTOS DO FORNECEDOR
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fornecedor_documentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  numero TEXT,
  emissao DATE,
  validade DATE,
  arquivo_ref TEXT,
  observacoes TEXT,
  situacao TEXT NOT NULL DEFAULT 'pendente',
  validado_por INTEGER REFERENCES usuarios(id),
  validado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS fornecedor_documentos_fornecedor_idx
  ON fornecedor_documentos (empresa_id, fornecedor_id, tipo);
CREATE INDEX IF NOT EXISTS fornecedor_documentos_validade_idx
  ON fornecedor_documentos (empresa_id, validade);

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_tipo_valido
    CHECK (tipo IN ('contrato_social', 'cartao_cnpj', 'certidao_federal', 'certidao_estadual',
                    'certidao_municipal', 'certidao_fgts', 'certidao_trabalhista', 'alvara', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_situacao_valida
    CHECK (situacao IN ('pendente', 'aprovado', 'reprovado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedor_documentos ADD CONSTRAINT fornecedor_documentos_validade_coerente
    CHECK (validade IS NULL OR emissao IS NULL OR validade >= emissao);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 3) TRILHA DE HOMOLOGAÇÃO (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fornecedor_homologacao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fornecedor_homologacao_eventos_idx
  ON fornecedor_homologacao_eventos (empresa_id, fornecedor_id, criado_em);

-- ----------------------------------------------------------------------------
-- 4) BACKFILL CONSERVADOR
--    Fornecedor que JÁ tem pedido de compra comprovadamente aprovado/recebido
--    não pode nascer "pendente" e travar a operação: ele é marcado como já
--    homologado (com data do primeiro pedido). Quem nunca comprou continua
--    pendente — o estado inicial honesto.
--    Nenhum fornecedor é suspenso/bloqueado por backfill: bloqueio é decisão
--    humana, nunca inferência de migração.
-- ----------------------------------------------------------------------------
UPDATE fornecedores f
   SET homologacao_status = 'homologado',
       homologado_em = COALESCE(f.homologado_em, sub.primeiro),
       homologacao_atualizada_em = now()
  FROM (
    SELECT fornecedor_id, MIN(data)::timestamptz AS primeiro
      FROM compras
     WHERE fornecedor_id IS NOT NULL
       AND status IN ('aprovado', 'parcial', 'recebido')
     GROUP BY fornecedor_id
  ) sub
 WHERE f.id = sub.fornecedor_id
   AND f.homologacao_status = 'pendente'
   AND f.homologado_em IS NULL;

-- A trilha registra o backfill (sem usuário: foi o sistema).
INSERT INTO fornecedor_homologacao_eventos (empresa_id, fornecedor_id, status_anterior, status_novo, motivo)
SELECT f.empresa_id, f.id, 'pendente', 'homologado',
       'Homologação registrada na implantação: fornecedor já possui pedido de compra aprovado/recebido.'
  FROM fornecedores f
 WHERE f.homologacao_status = 'homologado'
   AND NOT EXISTS (SELECT 1 FROM fornecedor_homologacao_eventos e WHERE e.fornecedor_id = f.id);
