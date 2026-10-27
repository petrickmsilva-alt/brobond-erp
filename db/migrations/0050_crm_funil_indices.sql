-- ============================================================================
-- 0050 — CRM 3.0 · ÍNDICES DO FUNIL E CONTRATO DE CONVERSÃO (Lead → Oportunidade)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- A 0049 criou o CRM 3.0 completo. Esta migration é a continuação ADITIVA e
-- IDEMPOTENTE do hardening do funil — nenhuma tabela nova, nenhuma coluna nova,
-- nenhum dado reescrito. Ela faz duas coisas:
--
--   1) cobre as duas consultas quentes que ficaram sem índice;
--   2) documenta (no próprio banco) o contrato de conversão do lead.
--
-- 1) ÍNDICES QUE FALTAVAM
--    • crm_leads (empresa_id, origem)
--      `origem` é filtro de primeira classe da listagem de leads (Fase 7 do
--      hardening: origem consistente, indexada e pronta para virar catálogo
--      quando houver campanhas). Sem o índice, filtrar por origem varre todos
--      os leads do tenant.
--
--    • crm_oportunidades (empresa_id, lead_id)
--      A conversão Lead → Oportunidade é idempotente: repetir a chamada
--      devolve a MESMA oportunidade, e a busca é exatamente
--      `WHERE empresa_id = $1 AND lead_id = $2`. O índice existente é só
--      `(lead_id)`; o composto serve também ao drill-down do funil por lead.
--
-- 2) CONTRATO DE CONVERSÃO (sem DDL — regra de aplicação)
--    `crm_leads.lead_convertido_em` é a chave de idempotência da conversão.
--    Ela é escrita EXCLUSIVAMENTE pelo endpoint
--    `POST /api/crm/leads/:id/converter` (server/src/crm.ts), com
--    compare-and-swap (`UPDATE ... WHERE lead_convertido_em IS NULL`) dentro da
--    mesma transação serializable que cria a oportunidade. O CRUD genérico não
--    consegue gravá-la: no recurso ela é `readonly` (writableFields a exclui),
--    então um PUT do cliente não forja "lead convertido".
--
--    Não há FK de `crm_oportunidades.lead_id` para o "lead convertido": a
--    relação é histórica e pode haver mais de uma oportunidade por lead ao
--    longo do tempo (recompra/upsell). O que se garante é que UMA conversão
--    crie UMA oportunidade — não que exista apenas uma na vida do lead.
--
-- O QUE NÃO FOI CRIADO (e por quê)
--   • Índices para ordenação por valor/data: a listagem do CRM ordena por
--     `criado_em DESC` (padrão do recurso) ou por `data_atividade`, e o volume
--     por tenant é baixo (dezenas/centenas). Índice só quando houver evidência
--     de plano ruim — nada de otimização especulativa.
--   • Tabela de "histórico de estágio": `crm_oportunidades` guarda a etapa
--     ATUAL e a auditoria (cadeia de hashes) guarda quem mudou o quê e quando.
--     Um histórico dedicado do funil é evolução P2 (ver ERP-3.0-GAP-MATRIX).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Leads — filtro por origem dentro do tenant
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS crm_leads_empresa_origem_idx
  ON crm_leads (empresa_id, origem);

-- ----------------------------------------------------------------------------
-- 2) Oportunidades — idempotência da conversão e drill-down por lead
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS crm_oportunidades_empresa_lead_idx
  ON crm_oportunidades (empresa_id, lead_id);
