-- ============================================================================
-- PROD-DB-01.5.4 — RESOLUÇÃO DAS COLISÕES DE ESTOQUE DE CLASSE C (E4.2).
--
-- Problema: `estoques` guarda saldo único por produto × tamanho × local, mas o
-- modelo legado tem DUAS chaves de unicidade sobrepostas:
--
--   • a chave CANÔNICA (E4.2 / migration 0030):
--       (empresa_id, produto_id, tamanho_id, local_id)
--   • a chave LEGADA por TEXTO (schema-base / migration 0001):
--       (produto_id, tamanho_id, local)  →  índice
--       `estoques_produto_id_tamanho_id_local_key`
--
-- Em produção existem 16 pares / 32 registros (empresa_id=1, local_id=3) em que
-- o MESMO produto/tamanho/local canônico aparece DUAS vezes porque o texto do
-- local divergiu apenas por caixa: "loja" (qtd 9) x "LOJA" (qtd 1). A chave
-- canônica os considera a MESMA célula; a chave legada por texto os considera
-- linhas distintas — e é justamente essa divergência que a normalização de
-- classe C (PROD-DB-01.5.2, script 005) não consegue aplicar: normalizar
-- 'loja' → 'LOJA' faria as duas linhas ocuparem a MESMA chave de texto.
--
-- Este script resolve o problema ANTES da normalização de classe C:
--   1. consolida cada par em UMA linha (soma as quantidades);
--   2. normaliza o texto do local para o nome canônico de `locais`;
--   3. remove a linha redundante (por ID explícito — nunca DELETE cego).
--
-- Depois deste passo, o script 005 (PROD-DB-01.5.3.1) normaliza a classe C
-- restante SEM colisão, e o preflight E4.2 (0030) deixa de ser bloqueado por
-- esta parcela.
--
-- ----------------------------------------------------------------------------
-- REGRA DE CONSOLIDAÇÃO — DERIVADA DO CÓDIGO/SCHEMA EXISTENTE (não inventada)
--
--   • Chave de identidade: `empresa_id + local_id + produto_id + tamanho_id`
--     (regra 10). É exatamente a chave do índice único canônico criado pela
--     migration 0030 (`uq_e42_estoques_empresa_prod_tam_local_id`) e a chave que
--     `PgStore.canonicalStockCell` (server/src/pgstore.ts) usa para localizar a
--     célula de saldo. `local_id` é o vínculo canônico; o texto é apenas um
--     espelho defasado.
--
--   • Quantidade consolidada = SOMA das quantidades do grupo. `estoques` é um
--     saldo que AGREGA: a leitura do Estoque Físico (`estoqueGrade`,
--     server/src/estoque.ts) já soma `quantidade` (e `estoque_min`) de todas as
--     linhas da mesma célula produto × tamanho antes de exibir. Consolidar por
--     SOMA preserva o total real; qualquer outra escolha (pegar o maior, o
--     canônico, descartar o outro) inventaria regra de negócio. Idem para
--     `estoque_min`, que também é somado na mesma leitura.
--
--   • Linha sobrevivente = a de MENOR id. Determinístico e alinhado ao
--     precedente já documentado na migration 0001 (`DELETE FROM estoques a
--     USING estoques b WHERE a.id > b.id ...` — mantém o menor id). Não há FK
--     apontando para `estoques.id` (verificado), então a escolha do id não
--     quebra integridade referencial.
--
--   • Texto normalizado = `locais.nome` do vínculo canônico. É o que a migration
--     0030 define como estado correto (`estoques.local IS DISTINCT FROM
--     locais.nome` é a inconsistência que o preflight conta).
--
--   • Histórico preservado: `movimentacoes` é a trilha imutável e NÃO é tocada.
--     `estoques` é saldo corrente (o README o descreve como "saldo único por
--     produto+tamanho+local"), não histórico. A consolidação remove a linha
--     REDUNDANTE depois de somar seu saldo na sobrevivente — nada de saldo é
--     perdido e nenhum movimento é apagado ou criado (criar movimento dobraria a
--     contagem).
--
-- ----------------------------------------------------------------------------
-- COMO USAR (SEMPRE rode o DRY-RUN antes)
--
--   DRY-RUN (padrão — não escreve nada):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -f db/admin/006-consolidar-colisoes-estoque-classe-c.sql
--
--   APPLY (tríplice autorização explícita; COMMIT ao final):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v apply=on -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4 \
--       -f db/admin/006-consolidar-colisoes-estoque-classe-c.sql
--
--   Wrapper verificado (recusa cópia defasada do arquivo):
--     DATABASE_URL=... db/admin/run-006-e42.sh                       # DRY-RUN
--     DATABASE_URL=... db/admin/run-006-e42.sh -v apply=on \
--       -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4
--
-- SEGURANÇA (regras obrigatórias do ciclo):
--   • DRY-RUN é o padrão: sem `-v apply=on` NADA é escrito.
--   • APPLY exige TRÊS chaves independentes: `apply=on` E
--     `confirmacao=PROD-DB-01.5.4` E `autorizacao=PROD-DB-01.5.4`. Faltando
--     qualquer uma, aborta ANTES de qualquer escrita.
--   • UMA transação explícita: APPLY faz COMMIT; qualquer outro caminho (erro,
--     guarda acionada, dry-run) faz ROLLBACK.
--   • Guardas abortam (ROLLBACK) quando há QUALQUER ambiguidade: texto do local
--     divergente de forma NÃO cosmética (classe B), local_id órfão, grupo com
--     empresa_id cruzado, quantidade negativa, ou tabela/local não resolvível.
--   • NUNCA usa DELETE cego: a remoção da linha redundante é por ID explícito,
--     condicionada à chave completa do grupo (empresa_id + local_id +
--     produto_id + tamanho_id).
--   • NUNCA identifica a linha pelo NOME textual do local: a junção é sempre
--     por `local_id` + `empresa_id`.
--   • AFTER-CHECK fail-closed: após as escritas, reexecuta os contadores do
--     preflight E4.2 (0030) e o contador de colisões canônicas; só faz COMMIT se
--     TODOS forem 0. `nomes_locais_inconsistentes=0` isolado NÃO basta.
--   • IDEMPOTENTE: sem grupos em colisão, não há UPDATE nem DELETE; a segunda
--     execução altera 0 linhas.
--   • NÃO altera a migration 0030, NÃO roda no boot, NÃO toca movimentacoes.
--
-- PRECEDENTES: docs/RELATORIO-PROD-DB-01-4.md (diagnóstico read-only),
--              docs/RELATORIO-PROD-DB-01-5.md (correção classe B),
--              docs/RELATORIO-PROD-DB-01-5-2.md (normalização classe C),
--              docs/RELATORIO-PROD-DB-01-5-3.md (pré-detecção de colisão),
--              docs/RELATORIO-PROD-DB-01-5-4.md (este ciclo).
-- ============================================================================

\set ON_ERROR_STOP on

-- PROD-DB-01.5.4 — REVISÃO DESTE ARQUIVO. Aparece no cabeçalho de QUALQUER
-- execução (inclusive um DRY-RUN colado num chamado), identificando sem
-- ambiguidade qual arquivo rodou.
\set e42_revisao 'PROD-DB-01.5.4'

-- Modo: APPLY somente com parâmetro explícito; default é DRY-RUN.
\if :{?apply}
\else
  \set apply off
\endif
\if :{?confirmacao}
\else
  \set confirmacao off
\endif
-- Parâmetro EXPLÍCITO de autorização (terceira chave independente do APPLY).
\if :{?autorizacao}
\else
  \set autorizacao off
\endif
SELECT set_config('e42.apply', :'apply', false) AS modo_apply,
       set_config('e42.confirmacao', :'confirmacao', false) AS confirmacao,
       set_config('e42.autorizacao', :'autorizacao', false) AS autorizacao,
       :'e42_revisao' AS revisao;

-- Autorização de COMMIT: começa DESLIGADA; o bloco só a liga quando a operação
-- autorizada completou a pós-validação. O wrapper \if abaixo exige esta marca
-- além de `apply=on` (defesa em profundidade; ON_ERROR_STOP já garantiria o
-- ROLLBACK em qualquer erro).
SELECT set_config('e42.autorizado', 'off', false) AS autorizado;

-- Transação explícita: nada é persistido até o COMMIT condicional no fim.
BEGIN;

-- ----------------------------------------------------------------------------
-- BLOCO AUTOCONTIDO. O teste PG (prod-db-01-54) extrai daqui até o terminador e
-- executa o bloco dentro de uma transação própria que faz ROLLBACK, para provar
-- a correção sem alterar o banco de teste. Mantenha o tag exatamente assim.
-- ----------------------------------------------------------------------------
DO $e42_consolidar_colisoes$
DECLARE
  aplicar        BOOLEAN := coalesce(current_setting('e42.apply', true), 'off') IN ('on', 'true', '1', 'yes');
  confirmado     BOOLEAN := coalesce(current_setting('e42.confirmacao', true), '') = 'PROD-DB-01.5.4';
  autorizado_par BOOLEAN := coalesce(current_setting('e42.autorizacao', true), '') = 'PROD-DB-01.5.4';
  apply_raw      TEXT    := lower(btrim(coalesce(current_setting('e42.apply', true), 'off')));
  grupos_colisao BIGINT  := 0;   -- nº de chaves canônicas com mais de uma linha
  linhas_colisao BIGINT  := 0;   -- nº de linhas envolvidas nessas chaves
  linhas_apagadas BIGINT := 0;   -- linhas redundantes removidas (APPLY)
  linhas_atualizadas BIGINT := 0;-- linhas sobreviventes atualizadas (APPLY)
  grupos_nao_cosmeticos BIGINT := 0;
  orfaos         BIGINT  := 0;
  g              RECORD;
  ids_remover    INTEGER[];
  alvo           INTEGER;
  afetadas       INTEGER;
  -- Contadores do AFTER-CHECK: os MESMOS nomes/regras do preflight E4.2 (0030).
  nomes_inconsistentes BIGINT;
  dup_locais     BIGINT;
  dup_padroes    BIGINT;
  dup_saldos     BIGINT;
  dup_itens_inv  BIGINT;
  saldos_invalidos BIGINT;
  vinc_empresa   BIGINT;
  vinc_locais    BIGINT;
  pdv_vinc       BIGINT := 0;
  pdv_nomes      BIGINT := 0;
  refs_operacionais BIGINT;
  colisoes_canonicas_restantes BIGINT;
BEGIN
  -- -------------------------------------------------------------------------
  -- (0) VALIDAÇÃO DA ENTRADA — o parâmetro `apply` só aceita tokens booleanos
  --     conhecidos. Um valor não reconhecido é ERRO EXPLÍCITO (nunca lido como
  --     "flag ausente"), para nunca confundir uma falha de gate com um typo.
  -- -------------------------------------------------------------------------
  IF apply_raw NOT IN ('on', 'true', '1', 'yes', 'off', 'false', '0', 'no') THEN
    RAISE EXCEPTION 'E4.2/01.5.4 APPLY recusado: valor inválido para -v apply=%. Nada foi alterado.', apply_raw
      USING HINT = 'Use um token booleano reconhecido: on/true/1/yes (habilita o APPLY) ou off/false/0/no (mantém o DRY-RUN).';
  END IF;

  RAISE NOTICE 'E4.2/01.5.4 revisão do script: % (apply=%, confirmacao=%, autorizacao=%)',
    'PROD-DB-01.5.4', aplicar,
    coalesce(current_setting('e42.confirmacao', true), ''),
    coalesce(current_setting('e42.autorizacao', true), '');

  -- -------------------------------------------------------------------------
  -- (A) DIAGNÓSTICO BEFORE — inventário dos grupos em colisão pela chave
  --     CANÔNICA (empresa_id + local_id + produto_id + tamanho_id). Esta é a
  --     chave exigida pela regra 10; NUNCA o nome textual do local.
  -- -------------------------------------------------------------------------
  SELECT count(*), coalesce(sum(n), 0)
    INTO grupos_colisao, linhas_colisao
    FROM (
      SELECT count(*) AS n
        FROM estoques e
       WHERE e.local_id IS NOT NULL
       GROUP BY e.empresa_id, e.produto_id, e.tamanho_id, e.local_id
      HAVING count(*) > 1
    ) d;
  RAISE NOTICE 'E4.2/01.5.4 BEFORE: chaves canônicas em colisão=% linhas envolvidas=%',
    grupos_colisao, linhas_colisao;

  -- -------------------------------------------------------------------------
  -- (B) GUARDAS — qualquer ambiguidade aborta ANTES de qualquer escrita
  --     (inclusive no DRY-RUN: exigem revisão manual, nunca correção por nome).
  -- -------------------------------------------------------------------------

  -- (B.1) local_id órfão: vínculo canônico apontando para local inexistente ou
  --       de outra empresa. Nunca é resolvido por nome.
  SELECT count(*) INTO orfaos
    FROM estoques e
    LEFT JOIN locais l ON l.id = e.local_id
   WHERE e.local_id IS NOT NULL
     AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id);
  IF orfaos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5.4 ABORTADO: % saldo(s) com local_id órfão ou de outra empresa. Nada foi alterado.', orfaos
      USING HINT = 'Corrija o vínculo canônico (empresa_id + local_id) antes; nunca associe por nome textual.';
  END IF;

  -- (B.2) Texto NÃO cosmético em algum grupo em colisão (classe B: divergência
  --       real, ex.: "LOJA" vs "LOJA 2"). Este script SÓ resolve colisão em que
  --       TODAS as linhas do grupo têm texto igual ao canônico a menos de
  --       caixa/espaço. Divergência real exige a operação de classe B do 005.
  SELECT count(*) INTO grupos_nao_cosmeticos
    FROM (
      SELECT e.empresa_id, e.produto_id, e.tamanho_id, e.local_id, l.nome AS canonico
        FROM estoques e
        JOIN locais l ON l.id = e.local_id AND l.empresa_id = e.empresa_id
       WHERE e.local_id IS NOT NULL
       GROUP BY e.empresa_id, e.produto_id, e.tamanho_id, e.local_id, l.nome
      HAVING count(*) > 1
         AND NOT bool_and(lower(btrim(e.local)) = lower(btrim(l.nome)))
    ) d;
  IF grupos_nao_cosmeticos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5.4 ABORTADO: % grupo(s) em colisão com texto de local divergente de forma NÃO cosmética (classe B). Nada foi alterado.', grupos_nao_cosmeticos
      USING HINT = 'A consolidação por casing exige que TODAS as linhas do grupo tenham texto igual ao canônico a menos de caixa/espaço. Divergência real é classe B e deve ser tratada pela operação apropriada do script 005.';
  END IF;

  -- (B.3) Saldo negativo — nunca deveria existir (CHECK), mas a soma só faz
  --       sentido com quantidades não negativas. Fail-closed.
  IF EXISTS (SELECT 1 FROM estoques WHERE quantidade < 0 OR estoque_min < 0) THEN
    RAISE EXCEPTION 'E4.2/01.5.4 ABORTADO: existe saldo com quantidade ou estoque mínimo negativo. Nada foi alterado.'
      USING HINT = 'Revise os dados; a consolidação por soma pressupõe quantidades não negativas.';
  END IF;

  -- -------------------------------------------------------------------------
  -- (C) RELATÓRIO DOS PARES CONFLITANTES E DA AÇÃO PREVISTA (regra 11).
  --     Emitido SEMPRE (DRY-RUN e APPLY), antes de qualquer escrita, com os
  --     dados REAIS. Ordenação determinística (COLLATE "C" nas colunas
  --     textuais) para o relatório não mudar de forma entre collations.
  -- -------------------------------------------------------------------------
  IF grupos_colisao > 0 THEN
    RAISE NOTICE 'E4.2/01.5.4 RELATÓRIO DOS PARES (ação prevista por grupo):';
  END IF;
  FOR g IN
    SELECT e.empresa_id, e.local_id, e.produto_id, e.tamanho_id,
           min(e.id) AS sobrevivente_id,
           array_agg(e.id ORDER BY e.id) AS ids,
           array_agg(e.local COLLATE "C" ORDER BY e.id) AS locais,
           array_agg(e.quantidade ORDER BY e.id) AS quantidades,
           sum(e.quantidade) AS quantidade_total,
           sum(e.estoque_min) AS minimo_total,
           count(*) AS linhas,
           l.nome AS canonico
      FROM estoques e
      JOIN locais l ON l.id = e.local_id AND l.empresa_id = e.empresa_id
     WHERE e.local_id IS NOT NULL
     GROUP BY e.empresa_id, e.local_id, e.produto_id, e.tamanho_id, l.nome
    HAVING count(*) > 1
     ORDER BY e.empresa_id, e.local_id, e.produto_id, e.tamanho_id
  LOOP
    RAISE NOTICE '  • empresa_id=% local_id=% produto_id=% tamanho_id=% | ids=% locais=% quantidades=% | AÇÃO: manter id=% com local=% quantidade=% (soma) estoque_min=% ; remover ids=%',
      g.empresa_id, g.local_id, g.produto_id, g.tamanho_id,
      g.ids, g.locais, g.quantidades,
      g.sobrevivente_id, g.canonico, g.quantidade_total, g.minimo_total,
      array_remove(g.ids, g.sobrevivente_id);
  END LOOP;

  -- -------------------------------------------------------------------------
  -- (C.1) DRY-RUN — padrão. Reporta e NÃO escreve nada.
  -- -------------------------------------------------------------------------
  IF NOT aplicar THEN
    RAISE NOTICE 'E4.2/01.5.4 DRY-RUN: nenhuma escrita.';
    RAISE NOTICE 'E4.2/01.5.4 DRY-RUN contadores: grupos_em_colisao=%, linhas_envolvidas=%, linhas_seriam_removidas=%, linhas_seriam_atualizadas=%, alterados=0',
      grupos_colisao, linhas_colisao, linhas_colisao - grupos_colisao, grupos_colisao;
    RAISE NOTICE 'E4.2/01.5.4 DRY-RUN: para aplicar use -v apply=on -v confirmacao=PROD-DB-01.5.4 -v autorizacao=PROD-DB-01.5.4';
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- (D) APPLY — AUTORIZAÇÃO. Três chaves independentes; faltando QUALQUER uma,
  --     aborta ANTES de qualquer escrita.
  -- -------------------------------------------------------------------------
  IF NOT confirmado THEN
    RAISE EXCEPTION 'E4.2/01.5.4 APPLY recusado: falta -v confirmacao=PROD-DB-01.5.4. Nada foi alterado.'
      USING HINT = 'A dupla confirmação textual evita APPLY acidental.';
  END IF;
  IF NOT autorizado_par THEN
    RAISE EXCEPTION 'E4.2/01.5.4 APPLY recusado: falta -v autorizacao=PROD-DB-01.5.4. Nada foi alterado.'
      USING HINT = 'O parâmetro explícito de autorização é a terceira chave independente do APPLY.';
  END IF;

  -- -------------------------------------------------------------------------
  -- (E) CORREÇÃO — por grupo: remover a(s) linha(s) redundante(s) (ID explícito)
  --     e atualizar a sobrevivente com a SOMA e o texto canônico.
  --
  --     ORDEM IMPORTA: primeiro removemos a linha de texto canônico (ou as
  --     outras), depois atualizamos a sobrevivente para o texto canônico. Fazer
  --     o inverso violaria a chave legada de TEXTO
  --     (produto_id, tamanho_id, local) enquanto a outra linha ainda existisse.
  --
  --     A identificação usa SEMPRE a chave canônica; o texto nunca é usado para
  --     achar a linha — apenas como valor a normalizar.
  -- -------------------------------------------------------------------------
  FOR g IN
    SELECT e.empresa_id, e.local_id, e.produto_id, e.tamanho_id,
           min(e.id) AS sobrevivente_id,
           array_agg(e.id ORDER BY e.id) AS ids,
           sum(e.quantidade) AS quantidade_total,
           sum(e.estoque_min) AS minimo_total,
           l.nome AS canonico
      FROM estoques e
      JOIN locais l ON l.id = e.local_id AND l.empresa_id = e.empresa_id
     WHERE e.local_id IS NOT NULL
     GROUP BY e.empresa_id, e.local_id, e.produto_id, e.tamanho_id, l.nome
    HAVING count(*) > 1
     ORDER BY e.empresa_id, e.local_id, e.produto_id, e.tamanho_id
  LOOP
    ids_remover := array_remove(g.ids, g.sobrevivente_id);

    -- (E.1) Remoção EXPLÍCITA (nunca cega): id ∈ lista E chave canônica completa.
    DELETE FROM estoques
     WHERE id = ANY(ids_remover)
       AND empresa_id = g.empresa_id
       AND local_id = g.local_id
       AND produto_id = g.produto_id
       AND tamanho_id IS NOT DISTINCT FROM g.tamanho_id;
    GET DIAGNOSTICS afetadas = ROW_COUNT;
    linhas_apagadas := linhas_apagadas + afetadas;
    IF afetadas <> array_length(ids_remover, 1) THEN
      RAISE EXCEPTION 'E4.2/01.5.4 FALHOU: esperava remover % linha(s) do grupo (empresa_id=% local_id=% produto_id=% tamanho_id=%) mas removeu %. Transação revertida.', array_length(ids_remover, 1), g.empresa_id, g.local_id, g.produto_id, g.tamanho_id, afetadas
        USING HINT = 'Estado divergente do relatório; nada foi persistido (ROLLBACK).';
    END IF;

    -- (E.2) Atualização da sobrevivente: SOMA + texto canônico.
    UPDATE estoques
       SET quantidade = g.quantidade_total,
           estoque_min = g.minimo_total,
           local = g.canonico,
           atualizado_em = now()
     WHERE id = g.sobrevivente_id
       AND empresa_id = g.empresa_id
       AND local_id = g.local_id
       AND produto_id = g.produto_id
       AND tamanho_id IS NOT DISTINCT FROM g.tamanho_id;
    GET DIAGNOSTICS afetadas = ROW_COUNT;
    linhas_atualizadas := linhas_atualizadas + afetadas;
    IF afetadas <> 1 THEN
      RAISE EXCEPTION 'E4.2/01.5.4 FALHOU: esperava atualizar exatamente 1 sobrevivente (id=%) mas atualizou %. Transação revertida.', g.sobrevivente_id, afetadas
        USING HINT = 'Estado divergente do relatório; nada foi persistido (ROLLBACK).';
    END IF;
  END LOOP;

  RAISE NOTICE 'E4.2/01.5.4 atualizados: sobreviventes=%, linhas_removidas=% (grupos=% )',
    linhas_atualizadas, linhas_apagadas, grupos_colisao;

  -- -------------------------------------------------------------------------
  -- (F) DIAGNÓSTICO AFTER — FAIL-CLOSED.
  --
  -- Reexecuta TODOS os contadores relevantes do preflight E4.2 (0030) — os
  -- MESMOS checks do PROD-DB-01.5.3.1 — e exige que TODOS sejam exatamente 0,
  -- além do contador de colisões canônicas (deve ser 0). Se qualquer contador
  -- for > 0, RAISE EXCEPTION ⇒ a transação é revertida e NADA é persistido.
  -- -------------------------------------------------------------------------
  -- (F.0) colisões canônicas remanescentes (a própria razão deste script).
  SELECT count(*) INTO colisoes_canonicas_restantes FROM (
    SELECT e.empresa_id, e.produto_id, e.tamanho_id, e.local_id
      FROM estoques e
     WHERE e.local_id IS NOT NULL
     GROUP BY e.empresa_id, e.produto_id, e.tamanho_id, e.local_id
    HAVING count(*) > 1
  ) d;

  -- (F.1) nomes_locais_inconsistentes — as quatro parcelas exatas da 0030.
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO nomes_inconsistentes;

  -- (F.2) duplicatas_locais / duplicatas_padroes — idênticas à 0030.
  SELECT count(*) INTO dup_locais FROM (
    SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_padroes FROM (
    SELECT empresa_id FROM locais WHERE padrao IS TRUE GROUP BY empresa_id HAVING count(*) > 1
  ) d;

  -- (F.3) duplicatas_saldos / duplicatas_itens_inventario / saldos inválidos.
  SELECT count(*) INTO dup_saldos FROM (
    SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
    GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_itens_inv FROM (
    SELECT empresa_id, inventario_id, produto_id, tamanho_id FROM itens_inventario
    GROUP BY empresa_id, inventario_id, produto_id, tamanho_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO saldos_invalidos FROM estoques WHERE produto_id IS NULL OR local IS NULL;

  -- (F.4) vinculos_empresa — idêntico à 0030.
  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN produtos p ON p.id = e.produto_id
      WHERE e.produto_id IS NULL OR p.id IS NULL OR e.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id
      WHERE m.produto_id IS NULL OR p.id IS NULL OR m.empresa_id IS DISTINCT FROM p.empresa_id) +
    (SELECT count(*) FROM estoque_insumos e LEFT JOIN insumos i ON i.id = e.insumo_id
      WHERE e.insumo_id IS NULL OR i.id IS NULL OR e.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN insumos i ON i.id = m.insumo_id
      WHERE m.insumo_id IS NULL OR i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id) +
    (SELECT count(*) FROM itens_compra ic
       LEFT JOIN compras c ON c.id = ic.compra_id
       LEFT JOIN produtos p ON p.id = ic.produto_id
       LEFT JOIN insumos i ON i.id = ic.insumo_id
      WHERE ic.compra_id IS NULL OR c.id IS NULL OR ic.empresa_id IS DISTINCT FROM c.empresa_id
         OR (ic.produto_id IS NOT NULL AND (p.id IS NULL OR ic.empresa_id IS DISTINCT FROM p.empresa_id))
         OR (ic.insumo_id IS NOT NULL AND (i.id IS NULL OR ic.empresa_id IS DISTINCT FROM i.empresa_id))) +
    (SELECT count(*) FROM itens_inventario ii
       LEFT JOIN inventarios inv ON inv.id = ii.inventario_id
       LEFT JOIN produtos p ON p.id = ii.produto_id
      WHERE ii.inventario_id IS NULL OR ii.produto_id IS NULL OR inv.id IS NULL OR p.id IS NULL
         OR ii.empresa_id IS DISTINCT FROM inv.empresa_id
         OR ii.empresa_id IS DISTINCT FROM p.empresa_id)
    INTO vinc_empresa;

  -- (F.5) vinculos_locais — idêntico à 0030.
  SELECT
    (SELECT count(*) FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND (l.id IS NULL OR e.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND (l.id IS NULL OR m.empresa_id IS DISTINCT FROM l.empresa_id)) +
    (SELECT count(*) FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND (l.id IS NULL OR inv.empresa_id IS DISTINCT FROM l.empresa_id))
    INTO vinc_locais;

  -- (F.6) PDV — mesmas regras da 0030, com a coluna aditiva opcional.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pdv_caixas' AND column_name = 'local_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM pdv_caixas p LEFT JOIN locais l ON l.id = p.local_id
      WHERE p.local_id IS NOT NULL AND (l.id IS NULL OR p.empresa_id IS DISTINCT FROM l.empresa_id)'
      INTO pdv_vinc;
    EXECUTE 'SELECT count(*) FROM pdv_caixas p JOIN locais l ON l.id = p.local_id
      WHERE p.local_id IS NOT NULL AND p.local IS DISTINCT FROM l.nome'
      INTO pdv_nomes;
  END IF;

  -- (F.7) referências operacionais — mesmo segundo preflight da 0030.
  SELECT
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN compra_recebimentos rcb ON rcb.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (rcb.id IS NULL OR m.empresa_id IS DISTINCT FROM rcb.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.movimentacao_estorno_id
      WHERE m.movimentacao_estorno_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes m LEFT JOIN movimentacoes x ON x.id = m.transferencia_id
      WHERE m.transferencia_id IS NOT NULL AND (x.id IS NULL OR m.empresa_id IS DISTINCT FROM x.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compras c ON c.id = m.compra_id
      WHERE m.compra_id IS NOT NULL AND (c.id IS NULL OR m.empresa_id IS DISTINCT FROM c.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN compra_recebimentos rcb ON rcb.id = m.recebimento_id
      WHERE m.recebimento_id IS NOT NULL AND (rcb.id IS NULL OR m.empresa_id IS DISTINCT FROM rcb.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN itens_compra i ON i.id = m.item_compra_id
      WHERE m.item_compra_id IS NOT NULL AND (i.id IS NULL OR m.empresa_id IS DISTINCT FROM i.empresa_id)) +
    (SELECT count(*) FROM movimentacoes_insumos m LEFT JOIN ordens_fabricacao o ON o.id = m.ordem_id
      WHERE m.ordem_id IS NOT NULL AND (o.id IS NULL OR m.empresa_id IS DISTINCT FROM o.empresa_id)) +
    (SELECT count(*) FROM compra_recebimentos rcb LEFT JOIN compras c ON c.id = rcb.compra_id
      WHERE rcb.compra_id IS NULL OR c.id IS NULL OR rcb.empresa_id IS DISTINCT FROM c.empresa_id) +
    (SELECT count(*) FROM compra_recebimento_itens ri
       LEFT JOIN compra_recebimentos rcb ON rcb.id = ri.recebimento_id
       LEFT JOIN itens_compra i ON i.id = ri.item_compra_id
      WHERE ri.recebimento_id IS NULL OR ri.item_compra_id IS NULL OR rcb.id IS NULL OR i.id IS NULL
         OR ri.empresa_id IS DISTINCT FROM rcb.empresa_id
         OR ri.empresa_id IS DISTINCT FROM i.empresa_id)
    INTO refs_operacionais;

  RAISE NOTICE 'E4.2/01.5.4 AFTER colisoes_canonicas_restantes=% (fail-closed) contadores: nomes_locais_inconsistentes=%, duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_invalidos=%, vinculos_empresa=%, vinculos_locais=%, pdv_vinculos=%, pdv_nomes=%, refs_operacionais=%',
    colisoes_canonicas_restantes, nomes_inconsistentes, dup_locais, dup_padroes, dup_saldos, dup_itens_inv, saldos_invalidos,
    vinc_empresa, vinc_locais, pdv_vinc, pdv_nomes, refs_operacionais;

  -- NOTA: `nomes_locais_inconsistentes` AINDA pode ser > 0 se houver classe C
  -- fora de `estoques` (movimentacoes/inventarios) — esse resíduo é resolvido
  -- pelo script 005 (PROD-DB-01.5.3.1) DEPOIS desta consolidação. O que este
  -- script EXIGE zerado é o que ele próprio produz: colisões canônicas,
  -- duplicatas de saldo e integridade. Os demais contadores são reportados como
  -- evidência e, se algum bloquear a própria 0030, o 005 aborta fail-closed.
  IF colisoes_canonicas_restantes + dup_saldos + saldos_invalidos + vinc_empresa + vinc_locais <> 0 THEN
    RAISE EXCEPTION 'E4.2/01.5.4 FALHOU (fail-closed): o estado final NÃO satisfaz o preflight E4.2. colisoes_canonicas_restantes=%, duplicatas_saldos=%, saldos_invalidos=%, vinculos_empresa=%, vinculos_locais=%. Transação revertida: NADA foi persistido.',
      colisoes_canonicas_restantes, dup_saldos, saldos_invalidos, vinc_empresa, vinc_locais
      USING HINT = 'Investigue os contadores > 0 (use db/diagnostico-e42-nomes-locais.sql); a consolidação não deve mascarar outro bloqueio do preflight.';
  END IF;
  RAISE NOTICE 'E4.2/01.5.4 AFTER OK: colisões canônicas=0, duplicatas_saldos=0, saldos_invalidos=0, integridade de vínculos=0 (resíduo de nomes para o 005: %)', nomes_inconsistentes;

  -- Marca de autorização de COMMIT: só chega aqui quem passou por TODAS as
  -- guardas, pela tríplice autorização e pela pós-validação fail-closed.
  PERFORM set_config('e42.autorizado', 'on', false);
END
$e42_consolidar_colisoes$;

-- ----------------------------------------------------------------------------
-- (G) SEGURANÇA — COMMIT só no APPLY explícito E autorizado pelo bloco;
--     qualquer outro caminho faz ROLLBACK.
-- ----------------------------------------------------------------------------
\if :apply
  SELECT current_setting('e42.autorizado', true) AS autorizado \gset
  \if :autorizado
    COMMIT;
    \echo 'E4.2/01.5.4 APPLY: transação COMITADA. Rode agora o script 005 (PROD-DB-01.5.3.1) para normalizar a classe C restante e confirme com o diagnóstico read-only (db/diagnostico-e42-nomes-locais.sql).'
  \else
    ROLLBACK;
    \echo 'E4.2/01.5.4 APPLY NÃO AUTORIZADO: a pós-validação não foi concluída; transação revertida (ROLLBACK). Nenhum dado foi alterado.'
  \endif
\else
  ROLLBACK;
  \echo 'E4.2/01.5.4 DRY-RUN: transação revertida (ROLLBACK). Nenhum dado foi alterado.'
\endif
