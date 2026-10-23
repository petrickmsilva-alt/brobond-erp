-- ============================================================================
-- PROD-CONSOLIDAR-LOCAIS-E1 — CONSOLIDAÇÃO DEFINITIVA DE LOCAIS DE ESTOQUE
--
-- Contexto de produção confirmado:
--   • empresa_id = 1 possui dois locais ativos criados por divergência de caixa:
--       - id = 3, nome = 'LOJA', ativo = true   (oficial operacional)
--       - id = 6, nome = 'loja', ativo = true   (duplicado legado a consolidar)
--   • Regra de negócio confirmada:
--       A empresa deve possuir APENAS UM local de estoque operacional:
--         ID 3 — 'LOJA' (ativo = true, padrao = true)
--       O local ID 6 ('loja') deve ter 100% do seu saldo consolidado em ID 3,
--       suas referências operacionais em aberto migradas para ID 3, seu
--       histórico integralmente preservado, e ficar inativo (ativo = false).
--
-- Regras de consolidação aplicadas por combinação (empresa_id + produto_id + tamanho_id):
--   • Caso 1 — existe SOMENTE no local de origem (ID 6):
--       Transfere a célula para o local de destino (ID 3, local = 'LOJA').
--   • Caso 2 — existe NOS DOIS locais (ID 3 e ID 6, com tamanho_id igual ou ambos NULL):
--       Consolida em uma ÚNICA célula canônica no local 3:
--         quantidade_final  = quantidade_local_3 + quantidade_local_6
--         estoque_min_final = GREATEST(COALESCE(estoque_min_local_3, 0),
--                                      COALESCE(estoque_min_local_6, 0))
--       Remove a célula redundante do local 6 por ID explícito + chave completa.
--
-- Separação semântica de referências por tabela:
--   1. MIGRADAS PARA ID 3 ('LOJA') — estado operacional vivo / futuro:
--        • estoques (saldo corrente consolidado integralmente em ID 3)
--        • pdv_caixas ABERTOS (status = 'aberto' e local_id = 6)
--        • vendas NÃO FATURADAS em aberto (status NOT IN ('faturada','entregue','cancelada')
--          e faturada_em IS NULL que apontavam para local 6 / 'loja')
--        • ordens_fabricacao EM ABERTO (status NOT IN ('concluida','cancelada') e local_producao_id = 6)
--        • compras / itens_compra PENDENTES/PARCIAIS (status IN ('pendente','aprovado','parcial') com 'loja')
--        • devolucoes PENDENTES/EM TRÂNSITO (status IN ('solicitada','autorizada','em_transito') com 'loja')
--   2. PRESERVADAS IMUTÁVEIS — histórico auditável (NUNCA apagadas nem reescritas):
--        • movimentacoes (100% intocadas — nem apagadas, nem reescritas, nem criadas)
--        • vendas faturadas / entregues / canceladas e itens_venda (100% intocadas)
--        • pdv_caixas fechados (status = 'fechado')
--        • inventarios fechados (status = 'fechado'; inventário 'aberto' aborta fail-closed)
--        • ordens_fabricacao concluídas / canceladas
--        • compras recebidas / canceladas e compra_recebimentos
--        • devolucoes recebidas / recusadas / canceladas
--        • auditoria (cadeia criptográfica 100% intocada)
--        • locais.id = 6 mantido fisicamente com nome = 'loja', ativo = false, padrao = false
--
-- COMO EXECUTAR:
--   1) BACKUP OBRIGATÓRIO ANTES DO APPLY:
--        pg_dump --format=custom --no-owner --file="backup_pre_consolidacao_$(date +%Y%m%d_%H%M%S).dump" "$DATABASE_URL"
--
--   2) DRY-RUN (padrão — valida antes, simula toda a consolidação e valida depois,
--      revertendo tudo com ROLLBACK ao final; ZERO bytes persistidos):
--        DATABASE_URL=... db/admin/run-007-e42.sh
--      ou diretamente via psql:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f db/admin/007-consolidar-locais-estoque-empresa1.sql
--
--   3) APPLY (tríplice autorização explícita; COMMIT somente se 100% das validações
--      ANTES e DEPOIS passarem sem divergência):
--        DATABASE_URL=... db/admin/run-007-e42.sh \
--          -v apply=on \
--          -v confirmacao=PROD-CONSOLIDAR-LOCAIS-E1 \
--          -v autorizacao=PROD-CONSOLIDAR-LOCAIS-E1
-- ============================================================================

\set ON_ERROR_STOP on
\set revisao 'PROD-CONSOLIDAR-LOCAIS-E1'

\if :{?apply}
\else
  \set apply off
\endif
\if :{?confirmacao}
\else
  \set confirmacao off
\endif
\if :{?autorizacao}
\else
  \set autorizacao off
\endif
\if :{?empresa_id}
\else
  \set empresa_id 1
\endif
\if :{?local_destino_id}
\else
  \set local_destino_id 3
\endif
\if :{?local_origem_id}
\else
  \set local_origem_id 6
\endif

SELECT set_config('brobond.apply', :'apply', false) AS modo_apply,
       set_config('brobond.confirmacao', :'confirmacao', false) AS confirmacao,
       set_config('brobond.autorizacao', :'autorizacao', false) AS autorizacao,
       set_config('brobond.empresa_id', :'empresa_id', false) AS empresa_alvo,
       set_config('brobond.local_destino_id', :'local_destino_id', false) AS local_destino_alvo,
       set_config('brobond.local_origem_id', :'local_origem_id', false) AS local_origem_alvo,
       :'revisao' AS revisao;

SELECT set_config('brobond.autorizado', 'off', false) AS autorizado;

BEGIN;

DO $consolidar_locais$
DECLARE
  v_apply_raw        TEXT    := lower(btrim(coalesce(current_setting('brobond.apply', true), 'off')));
  v_aplicar          BOOLEAN := v_apply_raw IN ('on', 'true', '1', 'yes');
  v_confirmado       BOOLEAN := coalesce(current_setting('brobond.confirmacao', true), '') = 'PROD-CONSOLIDAR-LOCAIS-E1';
  v_autorizado_par   BOOLEAN := coalesce(current_setting('brobond.autorizacao', true), '') = 'PROD-CONSOLIDAR-LOCAIS-E1';
  v_empresa_id       INTEGER := coalesce(nullif(btrim(current_setting('brobond.empresa_id', true)), ''), '1')::integer;
  v_destino_id       INTEGER := coalesce(nullif(btrim(current_setting('brobond.local_destino_id', true)), ''), '3')::integer;
  v_origem_id        INTEGER := coalesce(nullif(btrim(current_setting('brobond.local_origem_id', true)), ''), '6')::integer;

  v_destino_rec      RECORD;
  v_origem_rec       RECORD;

  -- Contadores BEFORE
  v_locais_ativos_antes       BIGINT;
  v_outros_ativos_antes       BIGINT;
  v_linhas_dest_antes         BIGINT;
  v_qtd_dest_antes            BIGINT;
  v_linhas_orig_antes         BIGINT;
  v_qtd_orig_antes            BIGINT;
  v_linhas_emp_antes          BIGINT;
  v_qtd_emp_antes             BIGINT;
  v_linhas_outras_emp_antes   BIGINT;
  v_qtd_outras_emp_antes      BIGINT;

  v_caso1_linhas              BIGINT;
  v_caso1_qtd                 BIGINT;
  v_caso2_pares               BIGINT;
  v_caso2_qtd_origem          BIGINT;

  -- Contadores de integridade / guardas BEFORE
  v_saldos_negativos          BIGINT;
  v_saldos_sem_local_id       BIGINT;
  v_saldos_orfaos             BIGINT;
  v_colisoes_internas_antes   BIGINT;
  v_inventarios_abertos       BIGINT;

  -- Referências ao local de origem (operacionais vs históricas)
  v_pdv_abertos_orig          BIGINT;
  v_pdv_fechados_orig         BIGINT;
  v_vendas_abertas_orig       BIGINT;
  v_vendas_hist_orig          BIGINT;
  v_vendas_total_antes        BIGINT;
  v_itens_venda_total_antes   BIGINT;
  v_ops_abertas_orig          BIGINT;
  v_ops_hist_orig             BIGINT;
  v_compras_abertas_orig      BIGINT;
  v_compras_hist_orig         BIGINT;
  v_recebimentos_hist_orig    BIGINT;
  v_devs_abertas_orig         BIGINT;
  v_devs_hist_orig            BIGINT;
  v_inv_fechados_orig         BIGINT;
  v_mov_origem_antes          BIGINT;
  v_mov_destino_antes         BIGINT;
  v_mov_total_antes           BIGINT;
  v_auditoria_total_antes     BIGINT;

  -- Execução
  v_ja_consolidado            BOOLEAN := false;
  v_afetadas                  INTEGER;
  v_caso2_removidas           BIGINT := 0;
  v_caso2_atualizadas         BIGINT := 0;
  v_caso1_migradas            BIGINT := 0;
  v_pdv_migrados              BIGINT := 0;
  v_vendas_migradas           BIGINT := 0;
  v_ops_migradas              BIGINT := 0;
  v_compras_migradas          BIGINT := 0;
  v_itens_compra_migrados     BIGINT := 0;
  v_devs_migradas             BIGINT := 0;
  r_par                       RECORD;

  -- Contadores AFTER
  v_locais_ativos_depois      BIGINT;
  v_linhas_dest_depois        BIGINT;
  v_qtd_dest_depois           BIGINT;
  v_linhas_orig_depois        BIGINT;
  v_qtd_orig_depois           BIGINT;
  v_linhas_emp_depois         BIGINT;
  v_qtd_emp_depois            BIGINT;
  v_linhas_outras_emp_depois  BIGINT;
  v_qtd_outras_emp_depois     BIGINT;
  v_colisoes_canon_depois     BIGINT;
  v_colisoes_texto_depois     BIGINT;
  v_nomes_div_estoques        BIGINT;
  v_divergencias_sku_tam      BIGINT;
  v_mov_origem_depois         BIGINT;
  v_mov_destino_depois        BIGINT;
  v_mov_total_depois          BIGINT;
  v_vendas_total_depois       BIGINT;
  v_vendas_hist_depois        BIGINT;
  v_itens_venda_total_depois  BIGINT;
  v_pdv_fechados_depois       BIGINT;
  v_inv_fechados_depois       BIGINT;
  v_ops_hist_depois           BIGINT;
  v_compras_hist_depois       BIGINT;
  v_recebimentos_hist_depois  BIGINT;
  v_devs_hist_depois          BIGINT;
  v_auditoria_total_depois    BIGINT;
BEGIN
  -- =========================================================================
  -- (0) VALIDAÇÃO ESTRITA DE PARÂMETROS E AUTORIZAÇÃO
  -- =========================================================================
  IF v_apply_raw NOT IN ('on', 'true', '1', 'yes', 'off', 'false', '0', 'no') THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: valor inválido para -v apply=%. Nada foi alterado.', v_apply_raw
      USING HINT = 'Use on/true/1/yes para APPLY ou off/false/0/no (padrão) para DRY-RUN.';
  END IF;

  IF v_aplicar AND (NOT v_confirmado OR NOT v_autorizado_par) THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 APPLY RECUSADO: faltam chaves explícitas (-v confirmacao=PROD-CONSOLIDAR-LOCAIS-E1 -v autorizacao=PROD-CONSOLIDAR-LOCAIS-E1). Nada foi alterado.'
      USING HINT = 'Execute primeiro em DRY-RUN (sem parâmetros) e depois repita com a tríplice autorização.';
  END IF;

  IF v_empresa_id <= 0 OR v_destino_id <= 0 OR v_origem_id <= 0 OR v_destino_id = v_origem_id THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: parâmetros inválidos (empresa_id=%, destino=%, origem=%).',
      v_empresa_id, v_destino_id, v_origem_id;
  END IF;

  RAISE NOTICE '============================================================================';
  RAISE NOTICE 'PROD-CONSOLIDAR-LOCAIS-E1 — modo=% | empresa_id=% | origem=% -> destino=%',
    CASE WHEN v_aplicar THEN 'APPLY' ELSE 'DRY-RUN' END, v_empresa_id, v_origem_id, v_destino_id;
  RAISE NOTICE '============================================================================';

  -- Trava os locais da empresa em ordem determinística para serializar contra operações concorrentes.
  PERFORM 1 FROM locais WHERE empresa_id = v_empresa_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM estoques WHERE empresa_id = v_empresa_id ORDER BY id FOR UPDATE;

  SELECT id, empresa_id, nome, coalesce(ativo, true) AS ativo, coalesce(padrao, false) AS padrao
    INTO v_destino_rec
    FROM locais
   WHERE id = v_destino_id AND empresa_id = v_empresa_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: local de destino id=% não encontrado na empresa_id=%.', v_destino_id, v_empresa_id;
  END IF;

  SELECT id, empresa_id, nome, coalesce(ativo, true) AS ativo, coalesce(padrao, false) AS padrao
    INTO v_origem_rec
    FROM locais
   WHERE id = v_origem_id AND empresa_id = v_empresa_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: local de origem id=% não encontrado na empresa_id=%.', v_origem_id, v_empresa_id;
  END IF;

  IF NOT v_destino_rec.ativo THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: local oficial de destino id=% (%) está inativo!', v_destino_id, v_destino_rec.nome;
  END IF;

  -- =========================================================================
  -- (A) VALIDAÇÃO ANTES (BEFORE CHECKS & GUARDAS FAIL-CLOSED)
  -- =========================================================================
  SELECT count(*) INTO v_locais_ativos_antes
    FROM locais WHERE empresa_id = v_empresa_id AND coalesce(ativo, true) IS TRUE;

  SELECT count(*) INTO v_outros_ativos_antes
    FROM locais
   WHERE empresa_id = v_empresa_id
     AND coalesce(ativo, true) IS TRUE
     AND id NOT IN (v_destino_id, v_origem_id);
  IF v_outros_ativos_antes > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: existem % outro(s) local(is) ativo(s) em empresa_id=% além de % e %. Revise antes de consolidar em local único.',
      v_outros_ativos_antes, v_empresa_id, v_destino_id, v_origem_id;
  END IF;

  -- Guardas de integridade pré-consolidação
  SELECT count(*) INTO v_saldos_negativos
    FROM estoques
   WHERE empresa_id = v_empresa_id AND (quantidade < 0 OR coalesce(estoque_min, 0) < 0);
  IF v_saldos_negativos > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: % linha(s) com quantidade ou estoque_min negativo em estoques.', v_saldos_negativos;
  END IF;

  SELECT count(*) INTO v_saldos_sem_local_id
    FROM estoques WHERE empresa_id = v_empresa_id AND local_id IS NULL;
  IF v_saldos_sem_local_id > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: % linha(s) de estoques com local_id NULL na empresa_id=%. Vincule o local antes de consolidar.',
      v_saldos_sem_local_id, v_empresa_id;
  END IF;

  SELECT count(*) INTO v_saldos_orfaos
    FROM estoques e
    LEFT JOIN locais l ON l.id = e.local_id
   WHERE e.empresa_id = v_empresa_id
     AND (l.id IS NULL OR l.empresa_id IS DISTINCT FROM e.empresa_id);
  IF v_saldos_orfaos > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: % linha(s) com local_id órfão/cruzado na empresa_id=%.', v_saldos_orfaos, v_empresa_id;
  END IF;

  SELECT count(*) INTO v_colisoes_internas_antes
    FROM (
      SELECT empresa_id, produto_id, tamanho_id, local_id
        FROM estoques
       WHERE empresa_id = v_empresa_id
       GROUP BY empresa_id, produto_id, tamanho_id, local_id
      HAVING count(*) > 1
    ) d;
  IF v_colisoes_internas_antes > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: há % colisão(ões) interna(s) na mesma célula (empresa+produto+tamanho+local_id). Execute db/admin/006-consolidar-colisoes-estoque-classe-c.sql antes.',
      v_colisoes_internas_antes;
  END IF;

  SELECT count(*) INTO v_inventarios_abertos
    FROM inventarios
   WHERE empresa_id = v_empresa_id
     AND status = 'aberto'
     AND local_id IN (v_destino_id, v_origem_id);
  IF v_inventarios_abertos > 0 THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 ABORTADO: existe(m) % inventário(s) ABERTO(S) nos locais %/%. Feche ou exclua o inventário aberto antes de consolidar.',
      v_inventarios_abertos, v_destino_id, v_origem_id;
  END IF;

  -- Contagens e somas de estoque ANTES
  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_dest_antes, v_qtd_dest_antes
    FROM estoques WHERE empresa_id = v_empresa_id AND local_id = v_destino_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_orig_antes, v_qtd_orig_antes
    FROM estoques WHERE empresa_id = v_empresa_id AND local_id = v_origem_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_emp_antes, v_qtd_emp_antes
    FROM estoques WHERE empresa_id = v_empresa_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_outras_emp_antes, v_qtd_outras_emp_antes
    FROM estoques WHERE empresa_id <> v_empresa_id;

  -- Snapshot por (produto_id, tamanho_id) ANTES para prova matemática exata item a item no AFTER-CHECK
  CREATE TEMP TABLE _consolidacao_snapshot_antes ON COMMIT DROP AS
  SELECT
    e.produto_id,
    e.tamanho_id,
    sum(e.quantidade)::bigint AS qtd_total_antes,
    max(coalesce(e.estoque_min, 0)) FILTER (WHERE e.local_id IN (v_destino_id, v_origem_id)) AS min_esperado_3_6
  FROM estoques e
  WHERE e.empresa_id = v_empresa_id
  GROUP BY e.produto_id, e.tamanho_id;

  -- Caso 1 (somente em origem) vs Caso 2 (nos dois locais)
  SELECT count(*), coalesce(sum(e6.quantidade), 0)
    INTO v_caso1_linhas, v_caso1_qtd
    FROM estoques e6
   WHERE e6.empresa_id = v_empresa_id
     AND e6.local_id = v_origem_id
     AND NOT EXISTS (
       SELECT 1 FROM estoques e3
        WHERE e3.empresa_id = v_empresa_id
          AND e3.local_id = v_destino_id
          AND e3.produto_id = e6.produto_id
          AND e3.tamanho_id IS NOT DISTINCT FROM e6.tamanho_id
     );

  SELECT count(*), coalesce(sum(e6.quantidade), 0)
    INTO v_caso2_pares, v_caso2_qtd_origem
    FROM estoques e6
    JOIN estoques e3
      ON e3.empresa_id = e6.empresa_id
     AND e3.local_id = v_destino_id
     AND e3.produto_id = e6.produto_id
     AND e3.tamanho_id IS NOT DISTINCT FROM e6.tamanho_id
   WHERE e6.empresa_id = v_empresa_id
     AND e6.local_id = v_origem_id;

  -- Mapeamento completo de referências em TODAS as tabelas do banco
  SELECT count(*) INTO v_pdv_abertos_orig
    FROM pdv_caixas WHERE empresa_id = v_empresa_id AND status = 'aberto' AND local_id = v_origem_id;
  SELECT count(*) INTO v_pdv_fechados_orig
    FROM pdv_caixas WHERE empresa_id = v_empresa_id AND status <> 'aberto' AND local_id = v_origem_id;

  SELECT count(*) INTO v_vendas_total_antes FROM vendas WHERE empresa_id = v_empresa_id;
  SELECT count(*) INTO v_itens_venda_total_antes FROM itens_venda WHERE empresa_id = v_empresa_id;

  SELECT count(*) INTO v_vendas_abertas_orig
    FROM vendas
   WHERE empresa_id = v_empresa_id
     AND status NOT IN ('faturada', 'entregue', 'cancelada')
     AND faturada_em IS NULL
     AND (
       local_saida_id = v_origem_id
       OR (local_saida_id IS NULL AND local_saida IS DISTINCT FROM v_destino_rec.nome AND lower(btrim(coalesce(local_saida, ''))) = lower(btrim(v_origem_rec.nome)))
     );

  SELECT count(*) INTO v_vendas_hist_orig
    FROM vendas
   WHERE empresa_id = v_empresa_id
     AND (status IN ('faturada', 'entregada', 'entregue', 'cancelada') OR faturada_em IS NOT NULL)
     AND local_saida_id = v_origem_id;

  SELECT count(*) INTO v_ops_abertas_orig
    FROM ordens_fabricacao
   WHERE empresa_id = v_empresa_id
     AND status NOT IN ('concluida', 'cancelada')
     AND local_producao_id = v_origem_id;

  SELECT count(*) INTO v_ops_hist_orig
    FROM ordens_fabricacao
   WHERE empresa_id = v_empresa_id
     AND status IN ('concluida', 'cancelada')
     AND local_producao_id = v_origem_id;

  SELECT count(*) INTO v_compras_abertas_orig
    FROM compras
   WHERE empresa_id = v_empresa_id
     AND status IN ('pendente', 'aprovado', 'parcial')
     AND local_entrada IS DISTINCT FROM v_destino_rec.nome
     AND lower(btrim(coalesce(local_entrada, ''))) = lower(btrim(v_origem_rec.nome));

  SELECT count(*) INTO v_compras_hist_orig
    FROM compras
   WHERE empresa_id = v_empresa_id
     AND status IN ('recebido', 'cancelado')
     AND local_entrada = v_origem_rec.nome;

  SELECT count(*) INTO v_recebimentos_hist_orig
    FROM compra_recebimentos
   WHERE empresa_id = v_empresa_id AND local = v_origem_rec.nome;

  SELECT count(*) INTO v_devs_abertas_orig
    FROM devolucoes
   WHERE empresa_id = v_empresa_id
     AND status IN ('solicitada', 'autorizada', 'em_transito')
     AND local_entrada IS DISTINCT FROM v_destino_rec.nome
     AND lower(btrim(coalesce(local_entrada, ''))) = lower(btrim(v_origem_rec.nome));

  SELECT count(*) INTO v_devs_hist_orig
    FROM devolucoes
   WHERE empresa_id = v_empresa_id
     AND status IN ('recebida', 'recusada', 'cancelada')
     AND local_entrada = v_origem_rec.nome;

  SELECT count(*) INTO v_inv_fechados_orig
    FROM inventarios WHERE empresa_id = v_empresa_id AND status = 'fechado' AND local_id = v_origem_id;

  SELECT count(*) INTO v_mov_origem_antes
    FROM movimentacoes WHERE empresa_id = v_empresa_id AND local_id = v_origem_id;
  SELECT count(*) INTO v_mov_destino_antes
    FROM movimentacoes WHERE empresa_id = v_empresa_id AND local_destino_id = v_origem_id;
  SELECT count(*) INTO v_mov_total_antes
    FROM movimentacoes WHERE empresa_id = v_empresa_id;
  SELECT count(*) INTO v_auditoria_total_antes FROM auditoria;

  RAISE NOTICE 'BEFORE — locais_ativos=% | destino(id=%, nome=%, ativo=%, padrao=%): % linhas / % un. | origem(id=%, nome=%, ativo=%, padrao=%): % linhas / % un. | TOTAL FÍSICO EMPRESA=% linhas / % un.',
    v_locais_ativos_antes,
    v_destino_rec.id, v_destino_rec.nome, v_destino_rec.ativo, v_destino_rec.padrao, v_linhas_dest_antes, v_qtd_dest_antes,
    v_origem_rec.id, v_origem_rec.nome, v_origem_rec.ativo, v_origem_rec.padrao, v_linhas_orig_antes, v_qtd_orig_antes,
    v_linhas_emp_antes, v_qtd_emp_antes;

  RAISE NOTICE 'BEFORE — Caso 1 (somente origem %): % linhas / % un. | Caso 2 (colisão % + %): % pares / % un. somadas ao destino',
    v_origem_id, v_caso1_linhas, v_caso1_qtd, v_destino_id, v_origem_id, v_caso2_pares, v_caso2_qtd_origem;

  RAISE NOTICE 'BEFORE — Referências operacionais a migrar (origem -> destino): pdv_abertos=%, vendas_abertas=%, ops_abertas=%, compras_abertas=%, devolucoes_abertas=%',
    v_pdv_abertos_orig, v_vendas_abertas_orig, v_ops_abertas_orig, v_compras_abertas_orig, v_devs_abertas_orig;

  RAISE NOTICE 'BEFORE — Referências históricas preservadas IMUTÁVEIS: movimentacoes(origem=%, destino=%, total=%), vendas_hist=%, itens_venda=%, pdv_fechados=%, inv_fechados=%, ops_hist=%, compras_hist=%, recebimentos_hist=%, devs_hist=%, auditoria=%',
    v_mov_origem_antes, v_mov_destino_antes, v_mov_total_antes, v_vendas_hist_orig, v_itens_venda_total_antes,
    v_pdv_fechados_orig, v_inv_fechados_orig, v_ops_hist_orig, v_compras_hist_orig, v_recebimentos_hist_orig,
    v_devs_hist_orig, v_auditoria_total_antes;

  -- Detalhamento determinístico de todos os pares em colisão (Caso 2)
  FOR r_par IN
    SELECT
      e3.id AS id_dest,
      e6.id AS id_orig,
      e3.produto_id,
      p.sku,
      p.nome AS produto_nome,
      e3.tamanho_id,
      coalesce(t.codigo, 'SEM_TAMANHO') AS tamanho_codigo,
      e3.quantidade AS qtd_dest,
      e6.quantidade AS qtd_orig,
      (e3.quantidade + e6.quantidade) AS qtd_final,
      coalesce(e3.estoque_min, 0) AS min_dest,
      coalesce(e6.estoque_min, 0) AS min_orig,
      GREATEST(coalesce(e3.estoque_min, 0), coalesce(e6.estoque_min, 0)) AS min_final
    FROM estoques e6
    JOIN estoques e3
      ON e3.empresa_id = e6.empresa_id
     AND e3.local_id = v_destino_id
     AND e3.produto_id = e6.produto_id
     AND e3.tamanho_id IS NOT DISTINCT FROM e6.tamanho_id
    JOIN produtos p ON p.id = e3.produto_id
    LEFT JOIN tamanhos t ON t.id = e3.tamanho_id
   WHERE e6.empresa_id = v_empresa_id
     AND e6.local_id = v_origem_id
   ORDER BY e3.produto_id, e3.tamanho_id NULLS FIRST
  LOOP
    RAISE NOTICE '  [CASO 2 COLISÃO] sku=% (%) tam=% | local_% (id=%)=% + local_% (id=%)=% => CONSOLIDADO=% | estoque_min: max(%, %)=%',
      r_par.sku, r_par.produto_nome, r_par.tamanho_codigo,
      v_destino_id, r_par.id_dest, r_par.qtd_dest,
      v_origem_id, r_par.id_orig, r_par.qtd_orig,
      r_par.qtd_final, r_par.min_dest, r_par.min_orig, r_par.min_final;
  END LOOP;

  -- =========================================================================
  -- (B) DETECÇÃO DE IDEMPOTÊNCIA (SEGUNDA EXECUÇÃO APÓS CONSOLIDAÇÃO)
  -- =========================================================================
  v_ja_consolidado := (
    NOT v_origem_rec.ativo
    AND NOT v_origem_rec.padrao
    AND v_destino_rec.ativo
    AND v_destino_rec.padrao
    AND v_linhas_orig_antes = 0
    AND v_pdv_abertos_orig = 0
    AND v_vendas_abertas_orig = 0
    AND v_ops_abertas_orig = 0
    AND v_compras_abertas_orig = 0
    AND v_devs_abertas_orig = 0
  );

  IF v_ja_consolidado THEN
    RAISE NOTICE 'IDEMPOTENTE: consolidação já aplicada anteriormente (0 linhas a alterar). Executando pós-validação completa...';
  ELSE
    -- =======================================================================
    -- (C) APLICAÇÃO TRANSACIONAL (EXECUTADA EM APPLY E VALIDADA EM SIMULAÇÃO DRY-RUN)
    -- =======================================================================

    -- (C.1) Caso 2: existe nos DOIS locais -> remove linha redundante de local_origem
    --       por ID explícito + chave completa e soma quantidade + GREATEST(estoque_min) em local_destino.
    FOR r_par IN
      SELECT
        e3.id AS id_dest,
        e6.id AS id_orig,
        e3.produto_id,
        e3.tamanho_id,
        (e3.quantidade + e6.quantidade) AS qtd_final,
        GREATEST(coalesce(e3.estoque_min, 0), coalesce(e6.estoque_min, 0)) AS min_final
      FROM estoques e6
      JOIN estoques e3
        ON e3.empresa_id = e6.empresa_id
       AND e3.local_id = v_destino_id
       AND e3.produto_id = e6.produto_id
       AND e3.tamanho_id IS NOT DISTINCT FROM e6.tamanho_id
     WHERE e6.empresa_id = v_empresa_id
       AND e6.local_id = v_origem_id
     ORDER BY e3.produto_id, e3.tamanho_id NULLS FIRST
    LOOP
      DELETE FROM estoques
       WHERE id = r_par.id_orig
         AND empresa_id = v_empresa_id
         AND local_id = v_origem_id
         AND produto_id = r_par.produto_id
         AND tamanho_id IS NOT DISTINCT FROM r_par.tamanho_id;
      GET DIAGNOSTICS v_afetadas = ROW_COUNT;
      IF v_afetadas <> 1 THEN
        RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 FALHOU: esperava remover 1 linha de origem (id=%), removeu %.', r_par.id_orig, v_afetadas;
      END IF;
      v_caso2_removidas := v_caso2_removidas + v_afetadas;

      UPDATE estoques
         SET quantidade = r_par.qtd_final,
             estoque_min = r_par.min_final,
             local = v_destino_rec.nome,
             atualizado_em = now()
       WHERE id = r_par.id_dest
         AND empresa_id = v_empresa_id
         AND local_id = v_destino_id
         AND produto_id = r_par.produto_id
         AND tamanho_id IS NOT DISTINCT FROM r_par.tamanho_id;
      GET DIAGNOSTICS v_afetadas = ROW_COUNT;
      IF v_afetadas <> 1 THEN
        RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 FALHOU: esperava atualizar 1 linha de destino (id=%), atualizou %.', r_par.id_dest, v_afetadas;
      END IF;
      v_caso2_atualizadas := v_caso2_atualizadas + v_afetadas;
    END LOOP;

    -- (C.2) Caso 1: existe SOMENTE em local_origem -> transfere célula para local_destino.
    UPDATE estoques
       SET local_id = v_destino_id,
           local = v_destino_rec.nome,
           estoque_min = coalesce(estoque_min, 0),
           atualizado_em = now()
     WHERE empresa_id = v_empresa_id
       AND local_id = v_origem_id;
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    IF v_afetadas <> v_caso1_linhas THEN
      RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 FALHOU: esperava migrar % linha(s) exclusivas de origem, migrou %.', v_caso1_linhas, v_afetadas;
    END IF;
    v_caso1_migradas := v_afetadas;

    -- Normaliza texto residual em estoques de destino, se houver.
    UPDATE estoques
       SET local = v_destino_rec.nome,
           atualizado_em = now()
     WHERE empresa_id = v_empresa_id
       AND local_id = v_destino_id
       AND local IS DISTINCT FROM v_destino_rec.nome;

    -- (C.3) Migração APENAS das referências operacionais em aberto (histórico permanece intacto!)
    UPDATE pdv_caixas
       SET local_id = v_destino_id,
           local = v_destino_rec.nome
     WHERE empresa_id = v_empresa_id
       AND status = 'aberto'
       AND local_id = v_origem_id;
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_pdv_migrados := v_afetadas;

    UPDATE vendas
       SET local_saida_id = CASE WHEN local_saida_id = v_origem_id THEN v_destino_id ELSE local_saida_id END,
           local_saida = v_destino_rec.nome
     WHERE empresa_id = v_empresa_id
       AND status NOT IN ('faturada', 'entregue', 'cancelada')
       AND faturada_em IS NULL
       AND (
         local_saida_id = v_origem_id
         OR (local_saida_id IS NULL AND local_saida IS DISTINCT FROM v_destino_rec.nome AND lower(btrim(coalesce(local_saida, ''))) = lower(btrim(v_origem_rec.nome)))
       );
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_vendas_migradas := v_afetadas;

    UPDATE ordens_fabricacao
       SET local_producao_id = v_destino_id
     WHERE empresa_id = v_empresa_id
       AND status NOT IN ('concluida', 'cancelada')
       AND local_producao_id = v_origem_id;
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_ops_migradas := v_afetadas;

    UPDATE itens_compra ic
       SET local = v_destino_rec.nome
      FROM compras c
     WHERE c.id = ic.compra_id
       AND c.empresa_id = v_empresa_id
       AND ic.empresa_id = v_empresa_id
       AND c.status IN ('pendente', 'aprovado', 'parcial')
       AND ic.local IS DISTINCT FROM v_destino_rec.nome
       AND lower(btrim(coalesce(ic.local, ''))) = lower(btrim(v_origem_rec.nome));
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_itens_compra_migrados := v_afetadas;

    UPDATE compras
       SET local_entrada = v_destino_rec.nome
     WHERE empresa_id = v_empresa_id
       AND status IN ('pendente', 'aprovado', 'parcial')
       AND local_entrada IS DISTINCT FROM v_destino_rec.nome
       AND lower(btrim(coalesce(local_entrada, ''))) = lower(btrim(v_origem_rec.nome));
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_compras_migradas := v_afetadas;

    UPDATE devolucoes
       SET local_entrada = v_destino_rec.nome
     WHERE empresa_id = v_empresa_id
       AND status IN ('solicitada', 'autorizada', 'em_transito')
       AND local_entrada IS DISTINCT FROM v_destino_rec.nome
       AND lower(btrim(coalesce(local_entrada, ''))) = lower(btrim(v_origem_rec.nome));
    GET DIAGNOSTICS v_afetadas = ROW_COUNT;
    v_devs_migradas := v_afetadas;

    -- (C.4) Desativa local de origem (sem excluir!) e consolida local de destino como único ativo padrão.
    --       ORDEM CRÍTICA: limpa `padrao` antes de promover destino para respeitar `uq_e42_locais_padrao_empresa`.
    UPDATE locais
       SET padrao = false,
           atualizado_em = now()
     WHERE empresa_id = v_empresa_id
       AND padrao IS TRUE
       AND id <> v_destino_id;

    UPDATE locais
       SET ativo = false,
           padrao = false,
           atualizado_em = now()
     WHERE id = v_origem_id
       AND empresa_id = v_empresa_id;

    UPDATE locais
       SET ativo = true,
           padrao = true,
           atualizado_em = now()
     WHERE id = v_destino_id
       AND empresa_id = v_empresa_id;
  END IF;

  -- =========================================================================
  -- (D) VALIDAÇÃO DEPOIS (AFTER-CHECK FAIL-CLOSED COMPLETO)
  -- =========================================================================
  SELECT id, empresa_id, nome, coalesce(ativo, true) AS ativo, coalesce(padrao, false) AS padrao
    INTO v_destino_rec FROM locais WHERE id = v_destino_id AND empresa_id = v_empresa_id;
  SELECT id, empresa_id, nome, coalesce(ativo, true) AS ativo, coalesce(padrao, false) AS padrao
    INTO v_origem_rec FROM locais WHERE id = v_origem_id AND empresa_id = v_empresa_id;

  SELECT count(*) INTO v_locais_ativos_depois
    FROM locais WHERE empresa_id = v_empresa_id AND coalesce(ativo, true) IS TRUE;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_dest_depois, v_qtd_dest_depois
    FROM estoques WHERE empresa_id = v_empresa_id AND local_id = v_destino_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_orig_depois, v_qtd_orig_depois
    FROM estoques WHERE empresa_id = v_empresa_id AND local_id = v_origem_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_emp_depois, v_qtd_emp_depois
    FROM estoques WHERE empresa_id = v_empresa_id;

  SELECT count(*), coalesce(sum(quantidade), 0)
    INTO v_linhas_outras_emp_depois, v_qtd_outras_emp_depois
    FROM estoques WHERE empresa_id <> v_empresa_id;

  SELECT count(*) INTO v_saldos_negativos
    FROM estoques WHERE empresa_id = v_empresa_id AND (quantidade < 0 OR coalesce(estoque_min, 0) < 0);

  SELECT count(*) INTO v_colisoes_canon_depois
    FROM (
      SELECT empresa_id, produto_id, tamanho_id, local_id
        FROM estoques
       WHERE empresa_id = v_empresa_id
       GROUP BY empresa_id, produto_id, tamanho_id, local_id
      HAVING count(*) > 1
    ) d;

  SELECT count(*) INTO v_colisoes_texto_depois
    FROM (
      SELECT empresa_id, produto_id, tamanho_id, local
        FROM estoques
       WHERE empresa_id = v_empresa_id
       GROUP BY empresa_id, produto_id, tamanho_id, local
      HAVING count(*) > 1
    ) d;

  SELECT count(*) INTO v_nomes_div_estoques
    FROM estoques e
    JOIN locais l ON l.id = e.local_id
   WHERE e.empresa_id = v_empresa_id
     AND e.local IS DISTINCT FROM l.nome;

  -- Verifica conservação exata de quantidade E estoque_min por CADA (produto_id, tamanho_id)
  SELECT count(*) INTO v_divergencias_sku_tam
    FROM _consolidacao_snapshot_antes s
    FULL OUTER JOIN (
      SELECT
        e.produto_id,
        e.tamanho_id,
        sum(e.quantidade)::bigint AS qtd_total_depois,
        max(coalesce(e.estoque_min, 0)) FILTER (WHERE e.local_id = v_destino_id) AS min_dest_depois,
        count(*) FILTER (WHERE e.local_id = v_destino_id) AS linhas_dest
      FROM estoques e
      WHERE e.empresa_id = v_empresa_id
      GROUP BY e.produto_id, e.tamanho_id
    ) d
      ON d.produto_id = s.produto_id
     AND d.tamanho_id IS NOT DISTINCT FROM s.tamanho_id
   WHERE s.produto_id IS NULL
      OR d.produto_id IS NULL
      OR d.qtd_total_depois <> s.qtd_total_antes
      OR d.linhas_dest <> 1
      OR d.min_dest_depois IS DISTINCT FROM s.min_esperado_3_6;

  -- Verifica preservação integral de TODO o histórico
  SELECT count(*) INTO v_mov_origem_depois
    FROM movimentacoes WHERE empresa_id = v_empresa_id AND local_id = v_origem_id;
  SELECT count(*) INTO v_mov_destino_depois
    FROM movimentacoes WHERE empresa_id = v_empresa_id AND local_destino_id = v_origem_id;
  SELECT count(*) INTO v_mov_total_depois
    FROM movimentacoes WHERE empresa_id = v_empresa_id;
  SELECT count(*) INTO v_vendas_total_depois
    FROM vendas WHERE empresa_id = v_empresa_id;
  SELECT count(*) INTO v_vendas_hist_depois
    FROM vendas
   WHERE empresa_id = v_empresa_id
     AND (status IN ('faturada', 'entregada', 'entregue', 'cancelada') OR faturada_em IS NOT NULL)
     AND local_saida_id = v_origem_id;
  SELECT count(*) INTO v_itens_venda_total_depois
    FROM itens_venda WHERE empresa_id = v_empresa_id;
  SELECT count(*) INTO v_pdv_fechados_depois
    FROM pdv_caixas WHERE empresa_id = v_empresa_id AND status <> 'aberto' AND local_id = v_origem_id;
  SELECT count(*) INTO v_inv_fechados_depois
    FROM inventarios WHERE empresa_id = v_empresa_id AND status = 'fechado' AND local_id = v_origem_id;
  SELECT count(*) INTO v_ops_hist_depois
    FROM ordens_fabricacao WHERE empresa_id = v_empresa_id AND status IN ('concluida', 'cancelada') AND local_producao_id = v_origem_id;
  SELECT count(*) INTO v_compras_hist_depois
    FROM compras WHERE empresa_id = v_empresa_id AND status IN ('recebido', 'cancelado') AND local_entrada = v_origem_rec.nome;
  SELECT count(*) INTO v_recebimentos_hist_depois
    FROM compra_recebimentos WHERE empresa_id = v_empresa_id AND local = v_origem_rec.nome;
  SELECT count(*) INTO v_devs_hist_depois
    FROM devolucoes WHERE empresa_id = v_empresa_id AND status IN ('recebida', 'recusada', 'cancelada') AND local_entrada = v_origem_rec.nome;
  SELECT count(*) INTO v_auditoria_total_depois FROM auditoria;

  IF v_locais_ativos_depois <> 1
     OR NOT v_destino_rec.ativo
     OR NOT v_destino_rec.padrao
     OR v_origem_rec.id IS NULL
     OR v_origem_rec.ativo
     OR v_origem_rec.padrao
     OR v_linhas_orig_depois <> 0
     OR v_qtd_orig_depois <> 0
     OR v_qtd_emp_depois <> v_qtd_emp_antes
     OR v_qtd_dest_depois <> (v_qtd_dest_antes + v_qtd_orig_antes)
     OR v_linhas_dest_depois <> (v_linhas_dest_antes + v_caso1_linhas)
     OR v_linhas_outras_emp_depois <> v_linhas_outras_emp_antes
     OR v_qtd_outras_emp_depois <> v_qtd_outras_emp_antes
     OR v_saldos_negativos <> 0
     OR v_colisoes_canon_depois <> 0
     OR v_colisoes_texto_depois <> 0
     OR v_nomes_div_estoques <> 0
     OR v_divergencias_sku_tam <> 0
     OR v_mov_origem_depois <> v_mov_origem_antes
     OR v_mov_destino_depois <> v_mov_destino_antes
     OR v_mov_total_depois <> v_mov_total_antes
     OR v_vendas_total_depois <> v_vendas_total_antes
     OR v_vendas_hist_depois <> v_vendas_hist_orig
     OR v_itens_venda_total_depois <> v_itens_venda_total_antes
     OR v_pdv_fechados_depois <> v_pdv_fechados_orig
     OR v_inv_fechados_depois <> v_inv_fechados_orig
     OR v_ops_hist_depois <> v_ops_hist_orig
     OR v_compras_hist_depois <> v_compras_hist_orig
     OR v_recebimentos_hist_depois <> v_recebimentos_hist_orig
     OR v_devs_hist_depois <> v_devs_hist_orig
     OR v_auditoria_total_depois <> v_auditoria_total_antes
  THEN
    RAISE EXCEPTION 'PROD-CONSOLIDAR-LOCAIS-E1 AFTER-CHECK FALHOU (ROLLBACK): ativos=% dest_ativo=% orig_ativo=% qtd_antes=% qtd_depois=% orig_linhas=% colisoes_canon=% colisoes_txt=% div_sku=%',
      v_locais_ativos_depois, v_destino_rec.ativo, v_origem_rec.ativo,
      v_qtd_emp_antes, v_qtd_emp_depois, v_linhas_orig_depois,
      v_colisoes_canon_depois, v_colisoes_texto_depois, v_divergencias_sku_tam;
  END IF;

  RAISE NOTICE 'AFTER  — locais_ativos=% (ID % "%" ativo=% padrao=% | ID % "%" ativo=% padrao=%)',
    v_locais_ativos_depois,
    v_destino_rec.id, v_destino_rec.nome, v_destino_rec.ativo, v_destino_rec.padrao,
    v_origem_rec.id, v_origem_rec.nome, v_origem_rec.ativo, v_origem_rec.padrao;

  RAISE NOTICE 'AFTER  — estoques destino(id=%): % linhas / % un. | origem(id=%): % linhas / % un. | SOMA ANTES=% SOMA DEPOIS=% (DIFERENÇA=0) | colisoes=0 | negativos=0',
    v_destino_id, v_linhas_dest_depois, v_qtd_dest_depois,
    v_origem_id, v_linhas_orig_depois, v_qtd_orig_depois,
    v_qtd_emp_antes, v_qtd_emp_depois;

  RAISE NOTICE 'AFTER  — operações realizadas: caso2_pares_consolidados=%, caso2_linhas_removidas=%, caso1_linhas_migradas=%, pdv_migrados=%, vendas_abertas_migradas=%, ops_abertas_migradas=%, compras_abertas_migradas=%, itens_compra_migrados=%, devolucoes_abertas_migradas=%',
    v_caso2_atualizadas, v_caso2_removidas, v_caso1_migradas,
    v_pdv_migrados, v_vendas_migradas, v_ops_migradas, v_compras_migradas, v_itens_compra_migrados, v_devs_migradas;

  RAISE NOTICE 'AFTER  — histórico 100%% preservado: movimentacoes=%, vendas=%, itens_venda=%, auditoria=%, outras_empresas=% un.',
    v_mov_total_depois, v_vendas_total_depois, v_itens_venda_total_depois, v_auditoria_total_depois, v_qtd_outras_emp_depois;

  IF v_aplicar THEN
    PERFORM set_config('brobond.autorizado', 'on', false);
  END IF;
END
$consolidar_locais$;

\if :apply
  SELECT current_setting('brobond.autorizado', true) AS autorizado \gset
  \if :autorizado
    COMMIT;
    \echo 'PROD-CONSOLIDAR-LOCAIS-E1 APPLY: transação COMITADA com sucesso. ID 3 (LOJA) é o único local operacional ativo; ID 6 (loja) consolidado e inativado; histórico 100% preservado.'
  \else
    ROLLBACK;
    \echo 'PROD-CONSOLIDAR-LOCAIS-E1 APPLY NÃO AUTORIZADO: transação revertida (ROLLBACK). Nenhum dado foi alterado.'
  \endif
\else
  ROLLBACK;
  \echo 'PROD-CONSOLIDAR-LOCAIS-E1 DRY-RUN: validação ANTES + simulação completa + validação DEPOIS aprovadas; transação revertida (ROLLBACK). Nenhum dado foi alterado.'
\endif
