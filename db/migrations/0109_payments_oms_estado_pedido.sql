-- ============================================================================
-- 0109 — PAYMENTS & OMS: MÁQUINA DE ESTADOS EXPLÍCITA E AUDITÁVEL DO PEDIDO
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O ciclo do pedido de venda hoje tem estado (`vendas.status`) e uma máquina de
-- estados ESPALHADA: `aplicarRegrasPedido` (itens.ts) valida duas transições
-- proibidas; o fluxo de expedição grava `expedicao_eventos`; a aprovação grava
-- `auditoria`. Nenhuma trilha ÚNICA responde "por que este pedido está neste
-- estado?" — as provas ficam em três tabelas com formatos diferentes e a
-- transição em si não é declarada em um só lugar.
--
-- Esta migração adiciona UMA trilha cronológica e imutável do estado do pedido:
-- cada mudança de `vendas.status` vira uma linha em `vendas_status_historico`,
-- com estado anterior, novo, responsável, origem, motivo e referência externa.
--
-- ESTA MIGRAÇÃO É ADITIVA. Não altera `vendas`, não mexe em nenhum status
-- existente e não reescreve o passado: a trilha começa a registrar a partir da
-- primeira transição feita depois do deploy. Nenhum número muda.
--
-- REGRAS (não negociáveis)
--   • Multiempresa: `empresa_id` NOT NULL; nada cruza empresa.
--   • Trilha IMUTÁVEL: sem UPDATE/DELETE pela aplicação (ops READ_ONLY no
--     recurso). Corrigir histórico não é operação válida.
--   • A autoridade do ESTADO continua sendo `vendas.status`. Esta tabela é a
--     PROVA da transição, não uma segunda fonte de verdade.
--   • `origem` classifica o CANAL que disparou a transição (erp, expedicao,
--     fiscal, pdv, portal, marketplace, aprovacao, devolucao, sistema) para
--     que a operação consiga filtrar por onde a mudança veio.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vendas_status_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT 'erp',
  motivo TEXT,
  referencia_externa TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nome TEXT,
  dados JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consulta da linha do tempo de um pedido (mais recente primeiro).
CREATE INDEX IF NOT EXISTS vendas_status_historico_idx
  ON vendas_status_historico (empresa_id, venda_id, criado_em DESC);

-- Filtro operacional por origem/canal da transição.
CREATE INDEX IF NOT EXISTS vendas_status_historico_origem_idx
  ON vendas_status_historico (empresa_id, origem);
