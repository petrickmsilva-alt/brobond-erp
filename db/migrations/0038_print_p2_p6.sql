-- ============================================================================
-- 0038 — Programa de Impressão Profissional (P2 + P3 + P4 + P5 + P6).
--
-- Escopo desta migration (100% aditiva, idempotente, sem DML e sem downtime):
--   1. PDV (P2):
--      • vendas.idempotency_key + índice único parcial por empresa — impede
--        duplicar venda ou cupom automático em refresh/timeout/retry.
--      • vendas.pdv_valor_recebido, vendas.pdv_troco, vendas.pdv_operador_id e
--        pdv_pagamentos.valor_informado — permitem que o backend reconstrua o
--        cupom de venda com 100% de fidelidade na impressão e na reimpressão,
--        preservando pdv_pagamentos.valor (líquido na gaveta).
--   2. Fila e Auditoria Operacional (P5/P6):
--      • print_jobs.printer_protocol e print_jobs.reprint_reason — rastreio
--        explícito do protocolo efetivo e do motivo opcional de reimpressão.
--      • índices compostos por empresa para consulta rápida de histórico por
--        source_ref, doc_type, agente, usuário solicitante e cadeia reprint_of.
--   3. Configuração Multi-Impressora por Terminal (P5):
--      • print_terminals — vincula cada terminal da empresa (ex.: CAIXA-1,
--        EXPEDICAO-1) ao agente opcional e às impressoras/protocolos de
--        recibo, etiqueta, documento e contingência, além de políticas de
--        auto-impressão no PDV e reimpressão por operador.
--
-- Reversão documentada (manual, apenas se necessário em homologação):
--   DROP TABLE IF EXISTS print_terminals;
--   DROP INDEX IF EXISTS print_jobs_reprint_idx, print_jobs_user_idx,
--     print_jobs_agent_idx, print_jobs_doc_type_idx, print_jobs_source_ref_idx,
--     uq_vendas_empresa_idempotency;
--   ALTER TABLE print_jobs DROP COLUMN IF EXISTS reprint_reason,
--     DROP COLUMN IF EXISTS printer_protocol;
--   ALTER TABLE pdv_pagamentos DROP COLUMN IF EXISTS valor_informado;
--   ALTER TABLE vendas DROP COLUMN IF EXISTS pdv_operador_id,
--     DROP COLUMN IF EXISTS pdv_troco,
--     DROP COLUMN IF EXISTS pdv_valor_recebido,
--     DROP COLUMN IF EXISTS idempotency_key;
-- ============================================================================

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_valor_recebido NUMERIC(12,2);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_troco NUMERIC(12,2);
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_operador_id INTEGER REFERENCES usuarios(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_empresa_idempotency
  ON vendas (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE pdv_pagamentos ADD COLUMN IF NOT EXISTS valor_informado NUMERIC(12,2);

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_protocol TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS reprint_reason TEXT;

CREATE INDEX IF NOT EXISTS print_jobs_source_ref_idx
  ON print_jobs (empresa_id, source_ref, criado_em DESC)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_doc_type_idx
  ON print_jobs (empresa_id, doc_type, criado_em DESC);

CREATE INDEX IF NOT EXISTS print_jobs_agent_idx
  ON print_jobs (empresa_id, claimed_by_agent_id, criado_em DESC)
  WHERE claimed_by_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_user_idx
  ON print_jobs (empresa_id, requested_by, criado_em DESC)
  WHERE requested_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS print_jobs_reprint_idx
  ON print_jobs (empresa_id, reprint_of)
  WHERE reprint_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS print_terminals (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  agent_id INTEGER REFERENCES print_agents(id) ON DELETE SET NULL,
  default_printer TEXT,
  receipt_printer TEXT,
  receipt_protocol TEXT NOT NULL DEFAULT 'escpos',
  receipt_width_cols INTEGER NOT NULL DEFAULT 48,
  label_printer TEXT,
  label_protocol TEXT NOT NULL DEFAULT 'zpl',
  document_printer TEXT,
  document_protocol TEXT NOT NULL DEFAULT 'pdf',
  fallback_mode TEXT NOT NULL DEFAULT 'browser_pdf',
  auto_print_pdv BOOLEAN NOT NULL DEFAULT true,
  allow_operator_reprint BOOLEAN NOT NULL DEFAULT true,
  copies_recibo INTEGER NOT NULL DEFAULT 1,
  copies_documento INTEGER NOT NULL DEFAULT 1,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT print_terminals_receipt_proto_valido CHECK (receipt_protocol IN ('escpos', 'text')),
  CONSTRAINT print_terminals_label_proto_valido CHECK (label_protocol IN ('zpl', 'epl2', 'a4')),
  CONSTRAINT print_terminals_doc_proto_valido CHECK (document_protocol IN ('pdf', 'escpos', 'text')),
  CONSTRAINT print_terminals_fallback_valido CHECK (fallback_mode IN ('browser_pdf', 'browser_html', 'queue_only', 'none')),
  CONSTRAINT print_terminals_copies_valido CHECK (copies_recibo >= 1 AND copies_recibo <= 10 AND copies_documento >= 1 AND copies_documento <= 10),
  CONSTRAINT print_terminals_cols_valido CHECK (receipt_width_cols IN (32, 42, 48))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_print_terminals_empresa_codigo
  ON print_terminals (empresa_id, codigo);

CREATE INDEX IF NOT EXISTS print_terminals_empresa_ativo_idx
  ON print_terminals (empresa_id, ativo);
