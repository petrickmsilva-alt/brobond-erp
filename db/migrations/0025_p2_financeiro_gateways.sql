-- 0025 — FASE P2: financeiro — gateways de pagamento, webhooks de entrada,
-- comissões efetivadas por recebimento, extrato bancário persistente
-- (OFX/CSV/CNAB) e idempotência de ponta a ponta.
--
-- Princípios:
--   • Nenhum segredo em texto puro: credenciais de gateway e segredos de
--     webhook dormem cifrados (AES-256-GCM, server/src/segredos.ts).
--   • Idempotência por índice único: o mesmo evento de webhook não entra
--     duas vezes; a mesma linha de extrato não importa duas vezes; a mesma
--     comissão não é efetivada duas vezes.
--   • Multiempresa: toda tabela nova é isolada por empresa (padrão 0017).
-- Idempotente — seguro rodar em bancos novos e existentes.

-- ---------------------------------------------------------------------------
-- 1) Configuração de gateway (uma por empresa × provedor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_configs (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider TEXT NOT NULL,                  -- mercadopago | mock | ...
  ambiente TEXT NOT NULL DEFAULT 'producao', -- producao | homologacao | teste
  credenciais_cifradas TEXT,               -- AES-GCM (v1.iv.tag.dados)
  webhook_segredo_cifrado TEXT,            -- segredo p/ validar assinatura de entrada
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_configs_empresa_provider
  ON gateway_configs (empresa_id, LOWER(provider));

-- ---------------------------------------------------------------------------
-- 2) Cobranças criadas via gateway (PIX, boleto, cartão)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_cobrancas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  provider TEXT NOT NULL,
  metodo TEXT NOT NULL,                    -- pix | boleto | cartao_credito | cartao_debito
  venda_id INTEGER REFERENCES vendas(id),
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  valor NUMERIC(12,2) NOT NULL,
  taxa_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  valor_liquido NUMERIC(12,2),
  parcelas INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pendente', -- pendente|autorizada|paga|expirada|cancelada|estornada|falhou
  provider_ref TEXT,                       -- id da cobrança no gateway
  idempotency_key TEXT,                    -- chave do chamador (ou derivada)
  expires_em TIMESTAMPTZ,                  -- expiração (PIX/boleto)
  nosso_numero TEXT,                       -- boleto
  linha_digitavel TEXT,                    -- boleto
  qr_code TEXT,                            -- PIX (BRCode)
  copia_cola TEXT,                         -- PIX copia-e-cola
  nsu TEXT,                                -- cartão
  webhook_evento_id TEXT,                  -- evento que confirmou (auditoria)
  payload JSONB,                           -- resposta bruta do provedor
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_empresa ON gateway_cobrancas (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_venda   ON gateway_cobrancas (venda_id);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_lanc    ON gateway_cobrancas (lancamento_id);
CREATE INDEX IF NOT EXISTS idx_gateway_cobrancas_ref     ON gateway_cobrancas (provider, provider_ref);

-- A mesma cobrança não nasce duas vezes para o mesmo chamador+provedor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_cobrancas_idempotencia
  ON gateway_cobrancas (empresa_id, LOWER(provider), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_valor') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_valor CHECK (valor > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_metodo') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_metodo
      CHECK (metodo IN ('pix','boleto','cartao_credito','cartao_debito')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_gateway_cobrancas_status') THEN
    ALTER TABLE gateway_cobrancas ADD CONSTRAINT ck_gateway_cobrancas_status
      CHECK (status IN ('pendente','autorizada','paga','expirada','cancelada','estornada','falhou')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Webhooks de entrada (eventos de pagamento) — um registro por
--    (provedor, evento). A mesma notificação nunca processa duas vezes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_webhook_events (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id),  -- resolvido ao processar
  provider TEXT NOT NULL,
  evento_id TEXT NOT NULL,                 -- id do evento no provedor (ou hash do corpo)
  evento TEXT,                             -- ex.: payment.paid
  payload JSONB,
  assinatura_ok BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'recebido', -- recebido|processado|erro|ignorado
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ,
  ultima_tentativa_em TIMESTAMPTZ,
  erro TEXT,
  cobranca_id INTEGER,
  lancamento_id INTEGER,
  recebido_em TIMESTAMPTZ DEFAULT now(),
  processado_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gateway_webhook_evento
  ON gateway_webhook_events (LOWER(provider), evento_id);
CREATE INDEX IF NOT EXISTS idx_gateway_webhook_retry
  ON gateway_webhook_events (status, proxima_tentativa_em);

-- ---------------------------------------------------------------------------
-- 4) Comissões — efetivadas conforme RECEBIMENTO da venda (não no pedido).
--    O congelamento no faturamento (vendas.comissao_valor) continua sendo a
--    apuração; aqui vive a efetivação/estorno, parcela a parcela.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comissoes_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  representante_id INTEGER REFERENCES representantes(id),
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  tipo TEXT NOT NULL,                      -- realizada | estornada
  base NUMERIC(12,2) NOT NULL,             -- valor recebido que gerou o evento
  pct NUMERIC(5,2) NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  origem TEXT,                             -- baixa | conciliacao | pdv | cancelamento
  usuario TEXT,
  observacoes TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comissoes_eventos_venda ON comissoes_eventos (venda_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_eventos_rep   ON comissoes_eventos (empresa_id, representante_id);

-- A comissão não é protegida por índice único por lançamento: o mesmo título
-- recebe recebimentos LEGÍTIMOS sucessivos (baixa parcial + quitação) e cada
-- um efetiva sua fração. As travas reais são (a) a transição atômica de
-- status na baixa — o mesmo ato de recebimento não roda duas vezes — e
-- (b) o saldo do livro em código: realizada − estornada ≤ apuração.

-- ---------------------------------------------------------------------------
-- 5) Extrato bancário persistente (OFX / CSV / CNAB)
--    — a importação é idempotente por (conta, hash da linha); o FITID do OFX
--      fica guardado para a conciliação futura nunca duplicar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_extrato_transacoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  conta_id INTEGER REFERENCES contas_financeiras(id),
  origem TEXT NOT NULL DEFAULT 'ofx',      -- ofx | csv | cnab
  linha_hash TEXT NOT NULL,                -- FITID ou hash do conteúdo da linha
  fitid TEXT,
  data DATE,
  valor NUMERIC(12,2) NOT NULL,
  direcao TEXT NOT NULL DEFAULT 'entrada', -- entrada | saida
  descricao TEXT,
  documento TEXT,                          -- nosso número / seu número / NSU (CNAB)
  codigo_movimento TEXT,                   -- código de movimento do retorno (CNAB)
  lancamento_id INTEGER REFERENCES lancamentos_financeiros(id),
  status TEXT NOT NULL DEFAULT 'importada',-- importada|conciliada|divergente|ignorada
  motivo TEXT,
  conciliado_em TIMESTAMPTZ,
  importado_em TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_extrato_linha ON fin_extrato_transacoes (conta_id, linha_hash);
CREATE INDEX IF NOT EXISTS idx_extrato_empresa_status ON fin_extrato_transacoes (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_extrato_conta_data ON fin_extrato_transacoes (conta_id, data DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_extrato_valor_positivo') THEN
    ALTER TABLE fin_extrato_transacoes ADD CONSTRAINT ck_extrato_valor_positivo CHECK (valor > 0) NOT VALID;
  END IF;
END $$;
