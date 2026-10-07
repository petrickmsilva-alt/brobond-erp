-- ============================================================================
-- 0020 — DOCUMENTOS FISCAIS (NF-e 55 / NFC-e 65) COM MÁQUINA DE ESTADOS
--
-- REGRA INEGOCIÁVEL: um documento só chega a `autorizado` quando um PROVEDOR
-- REAL devolveu protocolo e chave. Não existe transição que invente
-- autorização, e nenhum efeito colateral (baixa de estoque, financeiro) é
-- disparado fora do estado `autorizado`.
--
-- Estados:
--   rascunho ──► pendente ──► processando ──► autorizado ──► cancelado
--                    │             │
--                    │             └──► rejeitado ──► pendente (correção)
--                    └──► erro ──► pendente (retry)
--   (numeração pulada) ──► inutilizado
--
-- Idempotência: `idempotency_key` é única por empresa. Dois cliques/retries
-- com a mesma chave devolvem o MESMO documento, nunca dois.
--
-- Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS documentos_fiscais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),

  -- Origem no ERP (a venda continua sendo a fonte; o documento é um satélite)
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  modelo TEXT NOT NULL DEFAULT '55',           -- 55 = NF-e | 65 = NFC-e
  operacao TEXT NOT NULL DEFAULT 'saida',      -- saida | entrada
  natureza_operacao TEXT,

  -- Máquina de estados
  status TEXT NOT NULL DEFAULT 'rascunho',
  motivo TEXT,                                 -- rejeição/erro legível
  tentativas INTEGER NOT NULL DEFAULT 0,

  -- Numeração (só preenchida quando o documento sai para o provedor)
  serie INTEGER,
  numero INTEGER,
  chave_acesso TEXT,
  protocolo TEXT,
  autorizado_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,
  cancelamento_protocolo TEXT,
  cancelamento_justificativa TEXT,

  -- Provedor
  provider TEXT NOT NULL DEFAULT 'nenhum',
  provider_ref TEXT,                           -- id do documento no provedor
  ambiente TEXT NOT NULL DEFAULT 'homologacao',

  -- Documentos armazenados
  xml TEXT,
  xml_cancelamento TEXT,
  danfe_url TEXT,
  danfe_pdf BYTEA,

  -- Totais congelados no momento do envio (auditoria fiscal)
  valor_produtos NUMERIC(12,2),
  valor_frete NUMERIC(12,2),
  valor_desconto NUMERIC(12,2),
  valor_total NUMERIC(12,2),
  valor_icms NUMERIC(12,2),
  valor_pis NUMERIC(12,2),
  valor_cofins NUMERIC(12,2),
  valor_ipi NUMERIC(12,2),

  -- Efeitos colaterais: aplicados UMA ÚNICA VEZ, na autorização
  estoque_baixado_em TIMESTAMPTZ,
  financeiro_lancado_em TIMESTAMPTZ,

  idempotency_key TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,

  CONSTRAINT documentos_fiscais_modelo_valido CHECK (modelo IN ('55', '65')),
  CONSTRAINT documentos_fiscais_operacao_valida CHECK (operacao IN ('saida', 'entrada')),
  CONSTRAINT documentos_fiscais_ambiente_valido CHECK (ambiente IN ('homologacao', 'producao')),
  CONSTRAINT documentos_fiscais_status_valido CHECK (status IN (
    'rascunho', 'pendente', 'processando', 'autorizado',
    'rejeitado', 'cancelado', 'inutilizado', 'erro'
  )),
  -- Autorizado EXIGE prova do provedor: chave + protocolo. Sem isso o estado
  -- é inalcançável — o banco impede a NF-e fantasma.
  CONSTRAINT documentos_fiscais_autorizado_tem_prova CHECK (
    status <> 'autorizado'
    OR (chave_acesso IS NOT NULL AND protocolo IS NOT NULL
        AND numero IS NOT NULL AND serie IS NOT NULL
        AND provider <> 'nenhum')
  ),
  CONSTRAINT documentos_fiscais_cancelado_tem_origem CHECK (
    status <> 'cancelado' OR chave_acesso IS NOT NULL
  ),
  CONSTRAINT documentos_fiscais_chave_formato CHECK (
    chave_acesso IS NULL OR chave_acesso ~ '^[0-9]{44}$'
  )
);

-- Uma chave de acesso é única no universo — e aqui também.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_chave
  ON documentos_fiscais (chave_acesso) WHERE chave_acesso IS NOT NULL;

-- Numeração não se repete dentro da empresa/modelo/série/ambiente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_numeracao
  ON documentos_fiscais (empresa_id, modelo, serie, numero, ambiente)
  WHERE numero IS NOT NULL;

-- Idempotência da emissão.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_idempotency
  ON documentos_fiscais (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Uma venda não pode ter dois documentos vivos do mesmo modelo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_fiscais_venda_viva
  ON documentos_fiscais (venda_id, modelo)
  WHERE venda_id IS NOT NULL AND status IN ('rascunho', 'pendente', 'processando', 'autorizado');

CREATE INDEX IF NOT EXISTS documentos_fiscais_empresa_status_idx
  ON documentos_fiscais (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS documentos_fiscais_venda_idx ON documentos_fiscais (venda_id);

-- ----------------------------------------------------------------------------
-- Histórico/auditoria imutável do documento: toda transição vira uma linha.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos_fiscais_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  documento_id INTEGER NOT NULL REFERENCES documentos_fiscais(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  evento TEXT NOT NULL,                        -- emitir | consultar | cancelar | inutilizar | rejeicao | erro
  mensagem TEXT,
  payload JSONB,                               -- resposta bruta do provedor (sem segredos)
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documentos_fiscais_eventos_doc_idx
  ON documentos_fiscais_eventos (documento_id, criado_em DESC);

DROP TRIGGER IF EXISTS trg_empresa_documentos_fiscais_eventos ON documentos_fiscais_eventos;
CREATE TRIGGER trg_empresa_documentos_fiscais_eventos
  BEFORE INSERT OR UPDATE ON documentos_fiscais_eventos
  FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa('documentos_fiscais', 'documento_id');

-- ----------------------------------------------------------------------------
-- Inutilização de faixa de numeração (obrigação acessória)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inutilizacoes_fiscais (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  modelo TEXT NOT NULL DEFAULT '55',
  serie INTEGER NOT NULL,
  numero_inicial INTEGER NOT NULL,
  numero_final INTEGER NOT NULL,
  justificativa TEXT NOT NULL,
  ambiente TEXT NOT NULL DEFAULT 'homologacao',
  status TEXT NOT NULL DEFAULT 'pendente',     -- pendente | homologado | rejeitado | erro
  protocolo TEXT,
  motivo TEXT,
  provider TEXT NOT NULL DEFAULT 'nenhum',
  xml TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT inutilizacoes_faixa_valida CHECK (numero_final >= numero_inicial AND numero_inicial > 0),
  CONSTRAINT inutilizacoes_justificativa_minima CHECK (char_length(justificativa) >= 15),
  CONSTRAINT inutilizacoes_status_valido CHECK (status IN ('pendente', 'homologado', 'rejeitado', 'erro')),
  CONSTRAINT inutilizacoes_modelo_valido CHECK (modelo IN ('55', '65'))
);

CREATE INDEX IF NOT EXISTS inutilizacoes_empresa_idx ON inutilizacoes_fiscais (empresa_id, modelo, serie);

-- ----------------------------------------------------------------------------
-- Venda: ligação com o documento fiscal vigente.
-- `nfe_status` legado permanece (a UI atual depende dele) e passa a ser
-- espelho do documento — nunca escrito à mão.
-- ----------------------------------------------------------------------------
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS documento_fiscal_id INTEGER REFERENCES documentos_fiscais(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS nfe_chave TEXT;
CREATE INDEX IF NOT EXISTS vendas_documento_fiscal_idx ON vendas (documento_fiscal_id);
