-- ============================================================================
-- 0021 — CADASTROS DE PESSOAS COMPLETOS (clientes, fornecedores, vendedores)
--
-- Motivo imediato: a NF-e exige do destinatário muito mais do que nome e
-- documento — indicador de IE, endereço completo com código de município e
-- UF. Faltando isso, o faturamento morre no validador da SEFAZ.
--
-- Nenhuma coluna existente é renomeada ou removida:
--   • `clientes.nome` continua sendo o rótulo do registro;
--   • `clientes.cnpj_cpf` continua sendo o documento;
--   • `representantes` é EVOLUÍDO para vendedor/funcionário em vez de
--     ganhar uma entidade duplicada (regra 6 da especificação).
--
-- Idempotente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CLIENTES — PF/PJ, fiscal, endereço e comercial
-- ----------------------------------------------------------------------------
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pessoa TEXT NOT NULL DEFAULT 'pj';   -- pf | pj | estrangeiro
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS rg_ie TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS indicador_ie TEXT NOT NULL DEFAULT '9'; -- 1 contribuinte | 2 isento | 9 não contribuinte
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS im TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS suframa TEXT;

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;              -- IBGE
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pais TEXT NOT NULL DEFAULT 'Brasil';

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS limite_credito NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS representante_id INTEGER REFERENCES representantes(id);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS observacoes TEXT;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_pessoa_valida CHECK (pessoa IN ('pf', 'pj', 'estrangeiro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_indicador_ie_valido CHECK (indicador_ie IN ('1', '2', '9'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_uf_valida
    CHECK (uf IS NULL OR uf = '' OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_limite_credito_nao_negativo CHECK (limite_credito >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill conservador: quem já tem CPF (11 dígitos) é PF; o resto segue PJ,
-- que é o default histórico do cadastro.
UPDATE clientes
   SET pessoa = 'pf'
 WHERE pessoa = 'pj'
   AND cnpj_cpf IS NOT NULL
   AND length(regexp_replace(cnpj_cpf, '[^0-9]', '', 'g')) = 11;

-- Documento único POR EMPRESA (duas empresas do grupo podem atender o mesmo
-- cliente). Índice parcial: cadastro sem documento continua permitido.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_documento_empresa
  ON clientes (empresa_id, regexp_replace(cnpj_cpf, '[^0-9]', '', 'g'))
  WHERE cnpj_cpf IS NOT NULL AND regexp_replace(cnpj_cpf, '[^0-9]', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS clientes_representante_idx ON clientes (representante_id);

-- ----------------------------------------------------------------------------
-- 2) FORNECEDORES — espelho fiscal/comercial do cliente
-- ----------------------------------------------------------------------------
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS pessoa TEXT NOT NULL DEFAULT 'pj';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS ie TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS indicador_ie TEXT NOT NULL DEFAULT '1';
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS im TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS prazo_entrega_dias INTEGER;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS condicao_pagamento TEXT;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS observacoes TEXT;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_pessoa_valida CHECK (pessoa IN ('pf', 'pj', 'estrangeiro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_indicador_ie_valido CHECK (indicador_ie IN ('1', '2', '9'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_uf_valida
    CHECK (uf IS NULL OR uf = '' OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_documento_empresa
  ON fornecedores (empresa_id, regexp_replace(cnpj, '[^0-9]', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '[^0-9]', '', 'g') <> '';

-- Contatos adicionais do fornecedor (compras, financeiro, expedição...).
CREATE TABLE IF NOT EXISTS fornecedor_contatos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cargo TEXT,
  email TEXT,
  telefone TEXT,
  whatsapp TEXT,
  principal BOOLEAN NOT NULL DEFAULT FALSE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fornecedor_contatos_fornecedor_idx ON fornecedor_contatos (fornecedor_id);
CREATE INDEX IF NOT EXISTS fornecedor_contatos_empresa_idx ON fornecedor_contatos (empresa_id);

DROP TRIGGER IF EXISTS trg_empresa_fornecedor_contatos ON fornecedor_contatos;
CREATE TRIGGER trg_empresa_fornecedor_contatos
  BEFORE INSERT OR UPDATE ON fornecedor_contatos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('fornecedores', 'fornecedor_id');

-- ----------------------------------------------------------------------------
-- 3) REPRESENTANTES → VENDEDORES / FUNCIONÁRIOS
--
-- A entidade existente é EVOLUÍDA (regra: não duplicar). `comissao_pct`,
-- `regiao`, `telefone` e `email` continuam valendo como estão.
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cpf TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cargo TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS admissao DATE;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS desligamento DATE;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS observacoes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_cpf_empresa
  ON representantes (empresa_id, regexp_replace(cpf, '[^0-9]', '', 'g'))
  WHERE cpf IS NOT NULL AND regexp_replace(cpf, '[^0-9]', '', 'g') <> '';

-- Um usuário do sistema representa no máximo um vendedor por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_usuario_empresa
  ON representantes (empresa_id, usuario_id)
  WHERE usuario_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_desligamento_coerente
    CHECK (desligamento IS NULL OR admissao IS NULL OR desligamento >= admissao);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
