-- ============================================================================
-- 0048 — REPRESENTANTE 2.0 · CADASTRO MESTRE PROFISSIONAL
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- Até aqui o representante era um cadastro mínimo: nome, CPF, cargo, região
-- (texto livre), telefone, e-mail, comissão padrão, usuário e datas. Faltava o
-- que um ERP empresarial exige do CADASTRO MESTRE: identidade comercial
-- legível (`codigo`), pessoa física OU jurídica (CPF/CNPJ, razão social e nome
-- fantasia), tipo de representante, registro profissional (ex.: CORE),
-- contato profissional (celular além de telefone/WhatsApp/e-mail) e endereço
-- estruturado.
--
-- Esta migration é ADITIVA e IDEMPOTENTE. Ela NÃO reescreve o cadastro, NÃO
-- remove `regiao` (compatibilidade com o texto legado), NÃO cria segunda
-- estrutura comercial e NÃO toca no motor de comissão, na carteira, nas metas,
-- na hierarquia nem nos territórios — cada um continua no seu domínio
-- (docs/ERP-MASTER-ARCHITECTURE.md §8/§9).
--
-- DECISÕES ARQUITETURAIS
-- ----------------------
--   • `codigo` é identificador COMERCIAL, separado do `id` técnico: único por
--     empresa, indexado, pesquisável e preservado historicamente. O backfill
--     gera `REP00001` a partir do id para nenhum registro legado ficar sem
--     código (o índice é parcial, então vazio também é aceito).
--   • `tipo_pessoa` (PF/PJ) define QUAL documento vale. `cpf` e `cnpj` são
--     colunas distintas — nunca se exige os dois e cada um tem índice único
--     PARCIAL por empresa (documento vazio não colide).
--   • `tipo_representante` é o PAPEL comercial (interno, externo, supervisor,
--     coordenador, gerente, parceiro, terceirizado). `cargo` continua sendo a
--     informação funcional — um não substitui o outro.
--   • Endereço ESTRUTURADO (CEP, logradouro, número, complemento, bairro,
--     cidade, UF, país) — não é texto único. País nasce Brasil.
--   • `territorio_id` aponta para o DOMÍNIO de territórios já existente
--     (0041). Não existe segunda tabela de território; o texto legado
--     `regiao` permanece e nada é migrado à força.
--   • Histórico: nada é apagado. A trilha de auditoria (ANTES → EVENTO →
--     DEPOIS) continua sendo a fonte, e o cadastro em uso se DESATIVA.
--   • Nenhuma FK nova em CASCADE: a FK para `territorios` é NO ACTION e o
--     diagnóstico de vínculos (server/src/dependencias.ts) responde 409.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) IDENTIDADE PROFISSIONAL
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS codigo TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS tipo_pessoa TEXT NOT NULL DEFAULT 'PF';
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS razao_social TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS nome_fantasia TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS registro_profissional TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS orgao_registro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS tipo_representante TEXT NOT NULL DEFAULT 'REPRESENTANTE_COMERCIAL';
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS data_nascimento DATE;

-- ----------------------------------------------------------------------------
-- 2) CONTATO PROFISSIONAL (telefone/WhatsApp/e-mail já existiam)
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS celular TEXT;

-- ----------------------------------------------------------------------------
-- 3) ENDEREÇO ESTRUTURADO
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS logradouro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS numero TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS pais TEXT DEFAULT 'Brasil';

-- ----------------------------------------------------------------------------
-- 4) ESTRUTURA COMERCIAL — vínculo com o DOMÍNIO de territórios (0041)
-- ----------------------------------------------------------------------------
ALTER TABLE representantes ADD COLUMN IF NOT EXISTS territorio_id INTEGER REFERENCES territorios(id);

-- Código comercial dos registros legados: identificador legível e estável.
UPDATE representantes
   SET codigo = 'REP' || lpad(id::text, 5, '0')
 WHERE codigo IS NULL OR btrim(codigo) = '';

-- País padrão para o endereço já existente (nada é sobrescrito).
UPDATE representantes SET pais = 'Brasil' WHERE pais IS NULL OR btrim(pais) = '';

-- ----------------------------------------------------------------------------
-- 5) COERÊNCIA (o banco também é autoridade — defesa em profundidade)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_tipo_pessoa_valido
    CHECK (tipo_pessoa IN ('PF', 'PJ'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_tipo_valido
    CHECK (tipo_representante IN (
      'INTERNO', 'EXTERNO', 'REPRESENTANTE_COMERCIAL', 'SUPERVISOR',
      'COORDENADOR', 'GERENTE', 'PARCEIRO', 'TERCEIRIZADO'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UF e CEP no formato canônico que o serviço grava (nunca máscara como regra).
DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_uf_valida
    CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_cep_valido
    CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Data de nascimento plausível (a exatidão é validada no serviço: não futura).
DO $$ BEGIN
  ALTER TABLE representantes ADD CONSTRAINT representantes_nascimento_plausivel
    CHECK (data_nascimento IS NULL OR (data_nascimento >= '1900-01-01' AND data_nascimento < '2100-01-01'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 6) ÍNDICES — unicidade POR EMPRESA e busca
-- ----------------------------------------------------------------------------
-- Código comercial: único por empresa, e só quando informado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_empresa_codigo
  ON representantes (empresa_id, upper(codigo))
  WHERE codigo IS NOT NULL AND btrim(codigo) <> '';

-- CNPJ: único por empresa, comparado por dígitos (cadastro legado com máscara
-- não escapa da regra). CPF continua coberto por uq_representantes_cpf_empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_representantes_cnpj_empresa
  ON representantes (empresa_id, regexp_replace(cnpj, '[^0-9]', '', 'g'))
  WHERE cnpj IS NOT NULL AND regexp_replace(cnpj, '[^0-9]', '', 'g') <> '';

CREATE INDEX IF NOT EXISTS representantes_empresa_ativo_idx
  ON representantes (empresa_id, ativo);
CREATE INDEX IF NOT EXISTS representantes_empresa_tipo_idx
  ON representantes (empresa_id, tipo_representante);
CREATE INDEX IF NOT EXISTS representantes_empresa_pessoa_idx
  ON representantes (empresa_id, tipo_pessoa);
CREATE INDEX IF NOT EXISTS representantes_empresa_territorio_idx
  ON representantes (empresa_id, territorio_id);
CREATE INDEX IF NOT EXISTS representantes_empresa_codigo_idx
  ON representantes (empresa_id, codigo);

-- ----------------------------------------------------------------------------
-- 7) TRIGGER — normalização canônica + território da MESMA empresa
--
-- O serviço normaliza antes de gravar; o banco repete a normalização para que
-- importação, script administrativo e psql não criem um segundo padrão de
-- dado. O território de outra empresa é recusado aqui TAMBÉM (tenant-safe):
-- a validação de serviço é a mensagem amigável, esta é a garantia final.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brobond_representante_valida() RETURNS trigger AS $$
DECLARE
  terr territorios%ROWTYPE;
BEGIN
  NEW.tipo_pessoa := upper(btrim(COALESCE(NULLIF(NEW.tipo_pessoa, ''), 'PF')));
  NEW.tipo_representante := upper(btrim(COALESCE(NULLIF(NEW.tipo_representante, ''), 'REPRESENTANTE_COMERCIAL')));

  IF NEW.codigo IS NOT NULL THEN
    NEW.codigo := upper(btrim(NEW.codigo));
    IF NEW.codigo = '' THEN NEW.codigo := NULL; END IF;
  END IF;
  IF NEW.cpf IS NOT NULL THEN
    NEW.cpf := regexp_replace(NEW.cpf, '[^0-9]', '', 'g');
    IF NEW.cpf = '' THEN NEW.cpf := NULL; END IF;
  END IF;
  IF NEW.cnpj IS NOT NULL THEN
    NEW.cnpj := regexp_replace(NEW.cnpj, '[^0-9]', '', 'g');
    IF NEW.cnpj = '' THEN NEW.cnpj := NULL; END IF;
  END IF;
  IF NEW.cep IS NOT NULL THEN
    NEW.cep := regexp_replace(NEW.cep, '[^0-9]', '', 'g');
    IF NEW.cep = '' THEN NEW.cep := NULL; END IF;
  END IF;
  IF NEW.uf IS NOT NULL THEN
    NEW.uf := upper(btrim(NEW.uf));
    IF NEW.uf = '' THEN NEW.uf := NULL; END IF;
  END IF;
  IF NEW.pais IS NULL OR btrim(NEW.pais) = '' THEN
    NEW.pais := 'Brasil';
  END IF;

  IF NEW.territorio_id IS NOT NULL THEN
    SELECT * INTO terr FROM territorios WHERE id = NEW.territorio_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'território inexistente' USING ERRCODE = '23503';
    END IF;
    IF terr.empresa_id <> NEW.empresa_id THEN
      RAISE EXCEPTION 'o território pertence a outra empresa' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_representante_valida ON representantes;
CREATE TRIGGER trg_representante_valida
  BEFORE INSERT OR UPDATE ON representantes
  FOR EACH ROW EXECUTE FUNCTION brobond_representante_valida();
