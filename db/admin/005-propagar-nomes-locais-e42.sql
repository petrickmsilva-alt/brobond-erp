-- ============================================================================
-- PROD-DB-01.5 — PROPAGAÇÃO DO NOME CANÔNICO DE LOCAIS (correção E4.2)
--
-- Corrige, de forma administrativa, auditada e reversível, os registros cujo
-- texto de local ficou defasado do nome canônico apontado por `local_id`.
-- É exatamente a parcela `nomes_locais_inconsistentes` do preflight E4.2
-- (db/migrations/0030_e42_locais_estoque_multempresa.sql) que bloqueia o DDL.
--
-- NÃO é uma migration da aplicação: o boot NUNCA executa este arquivo. Ele é
-- um procedimento manual, rodado por um operador, fora da cadeia automática.
--
-- A regra E4.2 NÃO é alterada, o preflight NÃO é removido nem relaxado.
--
-- ----------------------------------------------------------------------------
-- DUAS OPERAÇÕES DISTINTAS (PROD-DB-01.5 e PROD-DB-01.5.2)
--
--   Operação B — correção de divergência textual real (renome sem propagação).
--   Operação C — NORMALIZAÇÃO CONTROLADA DE CLASSE C (diferença apenas de
--                caixa/espaço). Ex.: "loja" -> "LOJA".
--
-- As duas são MUTUAMENTE EXCLUSIVAS: cada uma aborta se houver casos da outra.
-- Isso impede "misturar classe B com classe C" numa mesma execução.
--
-- COMO USAR (preferência: sempre rodar o DRY-RUN antes)
--
--   DRY-RUN operação B (padrão, não escreve nada):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
--   APPLY operação B (dupla confirmação explícita; COMMIT ao final):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v apply=on -v confirmacao=PROD-DB-01.5 \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
--   DRY-RUN operação C (mostra o que seria normalizado; NÃO escreve):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v normalizar_classe_c=on \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
--   APPLY operação C (TRÍPLICE autorização explícita; COMMIT ao final):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--       -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on \
--       -f db/admin/005-propagar-nomes-locais-e42.sql
--
-- SEGURANÇA:
--   • DRY-RUN por padrão: sem `-v apply=on` NADA é escrito.
--   • APPLY B exige TAMBÉM `-v confirmacao=PROD-DB-01.5`.
--   • APPLY C exige `-v apply=on` E `-v confirmacao=PROD-DB-01.5.2` E
--     `-v normalizar_classe_c=on` — três chaves independentes. Faltando
--     QUALQUER uma, aborta antes de qualquer UPDATE.
--   • Sem `-v normalizar_classe_c=on` o script NUNCA normaliza classe C: a
--     diferença cosmética continua abortando (comportamento do PROD-DB-01.5).
--   • PROD-DB-01.5.2.1: a flag é lida como TEXTO e reconhecida sem diferenciar
--     caixa/espaço (`ON`, ` on ` valem). Um valor não reconhecido aborta com o
--     valor exato recebido — nunca é tratado como "flag ausente". Um marcador de
--     revisão é emitido no log para distinguir uma cópia ANTIGA do arquivo (que
--     nem aceita o terceiro parâmetro) de uma falha de gate.
--   • Tudo roda em UMA transação explícita: APPLY faz COMMIT; qualquer outro
--     caminho (erro, guarda acionada, dry-run) faz ROLLBACK.
--   • Guardas abortam (ROLLBACK) se existir QUALQUER caso classe A (vínculo de
--     outra empresa, texto NULL ou órfão). Nada é alterado quando há ambiguidade.
--   • Operação B aborta se houver classe C; operação C aborta se houver classe B.
--   • Classificação preserva a distinção semântica: só é classe C quando
--     `lower(btrim(texto)) = lower(btrim(nome))` E o texto difere do canônico.
--     Divergência real ("LOJA" vs "LOJA 2", "LOJA CENTRO", "ESTOQUE", ...) é
--     classe B e NUNCA é tratada como cosmética.
--   • AFTER-CHECK fail-closed: após os UPDATEs, reexecuta TODOS os contadores
--     relevantes do preflight E4.2 (0030) e só faz COMMIT se TODOS forem 0.
--     `nomes_locais_inconsistentes=0` isolado NÃO basta — a propagação pode
--     revelar outro bloqueio (ex.: duplicata de saldo com tamanho_id NULL).
--     Se qualquer contador for > 0, aborta e reverte; nada é persistido.
--   • O COMMIT depende de `e42.autorizado`, definido pelo próprio bloco apenas
--     quando a operação autorizada realmente completou; é defesa em profundidade
--     além do `ON_ERROR_STOP`.
--   • PROD-DB-01.5.3 — PREFLIGHT DE COLISÃO DE CLASSE C: antes de QUALQUER
--     UPDATE, o bloco inspeciona os índices ÚNICOS reais das tabelas afetadas
--     (não há lista fixa no código) e verifica se duas linhas distintas passariam
--     a ocupar a MESMA chave depois de trocar o texto pelo nome canônico de
--     `locais`. Se houver QUALQUER colisão, o APPLY aborta ANTES de escrever —
--     o PostgreSQL nunca é quem descobre a violação. O DRY-RUN reporta as
--     colisões e continua sem escrever. Justificativa: a diferença apenas de
--     caixa/espaço NÃO torna a linha automaticamente normalizável — ela pode
--     colidir com uma linha já existente sob uma constraint UNIQUE (caso real:
--     `estoques_produto_id_tamanho_id_local_key`, chave
--     `(produto_id, tamanho_id, local)` = `(7, 5, 'LOJA')`).
--     A normalização NUNCA faz merge nem exclui linhas: a decisão sobre a linha
--     duplicada continua sendo do operador.
--
-- PRECEDENTES: docs/RELATORIO-PROD-DB-01-4.md (diagnóstico read-only),
--              docs/RELATORIO-PROD-DB-01-5.md (correção classe B),
--              docs/RELATORIO-PROD-DB-01-5-2.md (normalização classe C),
--              docs/RELATORIO-PROD-DB-01-5-3.md (pré-detecção de colisão).
-- ============================================================================

\set ON_ERROR_STOP on

-- PROD-DB-01.5.3 — REVISÃO DESTE ARQUIVO.
-- A revisão aparece como coluna no cabeçalho abaixo, de modo que a saída de
-- QUALQUER execução (inclusive um DRY-RUN colado num chamado) identifique sem
-- ambiguidade qual arquivo rodou. O incidente PROD-DB-01.5.2.1 aconteceu porque
-- um operador executou uma CÓPIA ANTIGA (01.5.1), que nem possui o parâmetro
-- `normalizar_classe_c`; o cabeçalho de 2 colunas daquela cópia foi a evidência.
-- Use `db/admin/run-005-e42.sh` para recusar execução de cópia defasada.
\set e42_revisao 'PROD-DB-01.5.3'

-- Modo: APPLY somente com parâmetro explícito; default é DRY-RUN.
\if :{?apply}
\else
  \set apply off
\endif
\if :{?confirmacao}
\else
  \set confirmacao off
\endif
-- Operação C (normalização classe C): DESLIGADA por padrão. Só liga com
-- `-v normalizar_classe_c=on`; sem isso o script mantém o comportamento do
-- PROD-DB-01.5 (classe C continua abortando).
\if :{?normalizar_classe_c}
\else
  \set normalizar_classe_c off
\endif
SELECT set_config('e42.apply', :'apply', false) AS modo_apply,
       set_config('e42.confirmacao', :'confirmacao', false) AS confirmacao,
       set_config('e42.normalizar_classe_c', :'normalizar_classe_c', false) AS normalizar_classe_c,
       :'e42_revisao' AS revisao;

-- Autorização de COMMIT: começa DESLIGADA; o bloco só a liga quando a operação
-- autorizada realmente completou a pós-validação. O wrapper \if abaixo exige
-- esta marca além de `apply=on` (defesa em profundidade; ON_ERROR_STOP já
-- garantiria o ROLLBACK em qualquer erro).
SELECT set_config('e42.autorizado', 'off', false) AS autorizado;

-- Transação explícita: nada é persistido até o COMMIT condicional no fim.
BEGIN;

-- ----------------------------------------------------------------------------
-- BLOCO AUTOCONTIDO. O teste PG (prod-db-015) extrai daqui até o terminador e
-- executa o bloco dentro de uma transação própria que faz ROLLBACK, para provar
-- a correção sem alterar o banco de teste. Mantenha o tag exatamente assim.
-- ----------------------------------------------------------------------------
DO $e42_propagar_nomes_locais$
DECLARE
  aplicar       BOOLEAN := coalesce(current_setting('e42.apply', true), 'off') IN ('on', 'true', '1', 'yes');
  confirmado_b  BOOLEAN := coalesce(current_setting('e42.confirmacao', true), '') = 'PROD-DB-01.5';
  confirmado_c  BOOLEAN := coalesce(current_setting('e42.confirmacao', true), '') = 'PROD-DB-01.5.2';
  -- Reconhecimento da flag de classe C. `current_setting` devolve TEXTO: a caixa
  -- e o espaço são normalizados e só tokens booleanos conhecidos são aceitos.
  -- Um valor não reconhecido é ERRO, nunca "silenciosamente off" — sem isso um
  -- `-v normalizar_classe_c=<valor inesperado>` faria o gate parecer "não
  -- reconhecer a flag" e abortar a classe C como se ela não estivesse ligada.
  normalizar_raw TEXT    := lower(btrim(coalesce(current_setting('e42.normalizar_classe_c', true), 'off')));
  normalizar_c   BOOLEAN := lower(btrim(coalesce(current_setting('e42.normalizar_classe_c', true), 'off'))) IN ('on', 'true', '1', 'yes');
  total_antes   BIGINT;
  total_depois  BIGINT;
  a_casos       BIGINT;
  c_casos       BIGINT;
  b_casos       BIGINT;
  orfaos        BIGINT;
  upd_estoques  BIGINT := 0;
  upd_mov_local BIGINT := 0;
  upd_mov_dest  BIGINT := 0;
  upd_inv       BIGINT := 0;
  -- Contadores do AFTER-CHECK: os MESMOS nomes/regras do preflight E4.2 (0030).
  -- O APPLY é fail-closed: se QUALQUER um ficar > 0, a transação é revertida.
  dup_locais        BIGINT;
  dup_padroes       BIGINT;
  dup_saldos        BIGINT;
  dup_itens_inv     BIGINT;
  saldos_invalidos  BIGINT;
  vinc_empresa      BIGINT;
  vinc_locais       BIGINT;
  pdv_vinc          BIGINT := 0;
  pdv_nomes         BIGINT := 0;
  refs_operacionais BIGINT;
  r             RECORD;
  -- PROD-DB-01.5.3 — preflight de colisão de chave única na normalização C.
  colisoes_total   BIGINT := 0;   -- nº de chaves que passariam a colidir
  colisoes_linhas  BIGINT := 0;   -- nº de linhas envolvidas nessas chaves
  idx_verificados  BIGINT := 0;   -- índices únicos efetivamente inspecionados
  colisoes_resumo  TEXT   := '';  -- relatório acumulado (tabela/índice/chaves)
  viol             BIGINT;        -- chaves em colisão de UM índice
  linhas_idx       BIGINT;        -- linhas envolvidas nas colisões de UM índice
  base_from        TEXT;          -- FROM/JOIN do alvo (tabela + locais canônicos)
  cand             TEXT;          -- condição "linha candidata ao UPDATE classe C"
  pred_sql         TEXT;          -- predicado do índice parcial (verbatim)
  key_args         TEXT;          -- pares 'coluna', <expr pós-update> p/ jsonb
  nao_nulo         TEXT;          -- todas as colunas de chave não nulas
  expr             TEXT;          -- expressão de uma coluna de chave
  tgt              RECORD;        -- alvo (tabela, coluna textual, FK canônica)
  idx_rec          RECORD;        -- índice único inspecionado
  det              RECORD;        -- grupo em colisão (detalhe do relatório)
  i                INT;
BEGIN
  -- -------------------------------------------------------------------------
  -- (0) VALIDAÇÃO DA ENTRADA — a flag de classe C só aceita tokens booleanos
  --     conhecidos. Um valor não reconhecido (typo, acento, idioma) é ERRO
  --     EXPLÍCITO, para NUNCA ser confundido com "o gate não reconheceu a flag"
  --     (o sintoma do PROD-DB-01.5.2.1): `-v normalizar_classe_c=ON` e
  --     `-v normalizar_classe_c= sim ` são aceitos (caixa/espaço normalizados);
  --     `=sim`/`=ligado` abortam dizendo exatamente o valor recebido.
  -- -------------------------------------------------------------------------
  IF normalizar_raw NOT IN ('on', 'true', '1', 'yes', 'off', 'false', '0', 'no') THEN
    RAISE EXCEPTION 'E4.2/01.5.2 APPLY recusado: valor inválido para -v normalizar_classe_c=%. Nada foi alterado.', normalizar_raw
      USING HINT = 'Use um token booleano reconhecido: on/true/1/yes (habilita a classe C) ou off/false/0/no (desabilita).';
  END IF;

  -- Marcador de revisão: identifica QUAL arquivo está em execução. Um operador que
  -- rode uma cópia antiga (sem esta linha e sem o terceiro parâmetro) vê o sintoma
  -- exato do PROD-DB-01.5.2.1 — o gate "não reconhece" a flag. O marcador torna a
  -- causa óbvia no log, em vez de parecer um defeito de lógica.
  RAISE NOTICE 'E4.2/01.5.3 revisão do script: reconhece normalizar_classe_c=% (apply=%, confirmacao=%)',
    normalizar_raw, aplicar, coalesce(current_setting('e42.confirmacao', true), '');

  -- -------------------------------------------------------------------------
  -- (A) DIAGNÓSTICO BEFORE — as quatro parcelas exatas do preflight E4.2.
  -- -------------------------------------------------------------------------
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO total_antes;
  RAISE NOTICE 'E4.2/01.5 BEFORE nomes_locais_inconsistentes=%', total_antes;

  -- -------------------------------------------------------------------------
  -- (B) CLASSIFICAÇÃO por origem (mesma regra de A/B/C do PROD-DB-01.4).
  -- -------------------------------------------------------------------------
  FOR r IN
    WITH inc AS (
      SELECT 'estoques.local'::text AS origem, e.empresa_id AS reg_emp, l.empresa_id AS loc_emp, e.local AS txt, l.nome AS nome
        FROM estoques e JOIN locais l ON l.id = e.local_id
       WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'movimentacoes.local', m.empresa_id, l.empresa_id, m.local, l.nome
        FROM movimentacoes m JOIN locais l ON l.id = m.local_id
       WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'movimentacoes.local_destino', m.empresa_id, l.empresa_id, m.local_destino, l.nome
        FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
       WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
      UNION ALL
      SELECT 'inventarios.local', inv.empresa_id, l.empresa_id, inv.local, l.nome
        FROM inventarios inv JOIN locais l ON l.id = inv.local_id
       WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
    )
    SELECT origem,
      count(*) FILTER (WHERE reg_emp IS DISTINCT FROM loc_emp OR txt IS NULL) AS a,
      count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                         AND lower(btrim(txt)) = lower(btrim(nome)) AND txt IS DISTINCT FROM nome) AS c,
      count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                         AND lower(btrim(txt)) <> lower(btrim(nome))) AS b
    FROM inc GROUP BY origem ORDER BY origem
  LOOP
    RAISE NOTICE 'E4.2/01.5 origem=% A(vínculo/null)=% C(caixa/espaço)=% B(a corrigir)=%', r.origem, r.a, r.c, r.b;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- (C) PROTEÇÃO — classe A aborta SEMPRE (vínculo cruzado, órfão, texto NULL).
  --     Classe B e classe C são operações MUTUAMENTE EXCLUSIVAS: cada uma aborta
  --     se existirem casos da outra. Nunca se "mistura" B com C.
  -- -------------------------------------------------------------------------
  SELECT count(*) INTO orfaos FROM (
    SELECT e.id FROM estoques e LEFT JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT m.id FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT m.id FROM movimentacoes m LEFT JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND l.id IS NULL
    UNION ALL
    SELECT inv.id FROM inventarios inv LEFT JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND l.id IS NULL
  ) o;

  WITH inc AS (
    SELECT 'estoques.local'::text AS origem, e.empresa_id AS reg_emp, l.empresa_id AS loc_emp, e.local AS txt, l.nome AS nome
      FROM estoques e JOIN locais l ON l.id = e.local_id
     WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'movimentacoes.local', m.empresa_id, l.empresa_id, m.local, l.nome
      FROM movimentacoes m JOIN locais l ON l.id = m.local_id
     WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'movimentacoes.local_destino', m.empresa_id, l.empresa_id, m.local_destino, l.nome
      FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
     WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome
    UNION ALL
    SELECT 'inventarios.local', inv.empresa_id, l.empresa_id, inv.local, l.nome
      FROM inventarios inv JOIN locais l ON l.id = inv.local_id
     WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome
  )
  SELECT
    count(*) FILTER (WHERE reg_emp IS DISTINCT FROM loc_emp OR txt IS NULL),
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) = lower(btrim(nome)) AND txt IS DISTINCT FROM nome),
    count(*) FILTER (WHERE reg_emp = loc_emp AND txt IS NOT NULL
                       AND lower(btrim(txt)) <> lower(btrim(nome)))
    INTO a_casos, c_casos, b_casos
  FROM inc;

  -- Classe A (vínculo cruzado, órfão ou texto NULL) aborta SEMPRE — inclusive no
  -- DRY-RUN: exige revisão manual, nunca é resolvida por nome.
  IF orfaos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % registro(s) com local_id apontando para local inexistente (órfão). Nada foi alterado.', orfaos
      USING HINT = 'Corrija o vínculo canônico antes; não associe por nome.';
  END IF;
  IF a_casos > 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % caso(s) classe A (vínculo de outra empresa ou texto de local NULL). Nada foi alterado.', a_casos
      USING HINT = 'Classe A exige revisão manual de empresa_id; não é correção automática por nome.';
  END IF;

  -- Relatório de classificação (sempre emitido, inclusive no DRY-RUN).
  RAISE NOTICE 'E4.2/01.5 classificação: A=% B=% C=% (B=divergência real; C=diferença só de caixa/espaço)', a_casos, b_casos, c_casos;

  -- -------------------------------------------------------------------------
  -- (C.0) PROD-DB-01.5.3 — PREFLIGHT DE COLISÃO DE CHAVE ÚNICA (classe C).
  --
  -- A normalização troca um texto por `locais.nome`. Se esse texto participa de
  -- um índice ÚNICO, duas linhas DISTINTAS podem passar a ocupar a MESMA chave —
  -- e o UPDATE violaria a constraint (foi o caso real de
  -- `estoques_produto_id_tamanho_id_local_key`, `(produto_id, tamanho_id, local)`).
  -- Aqui a colisão é detectada ANTES de qualquer escrita: o PostgreSQL nunca é
  -- quem descobre a violação.
  --
  -- A detecção é GENÉRICA: não há lista fixa de índices no código. Para cada
  -- UPDATE de classe C, introspecta-se `pg_index`/`pg_attribute` e testa-se TODO
  -- índice único (inclusive a chave primária) e válido cujas colunas de chave
  -- incluam a coluna textual normalizada. A chave é avaliada no estado PÓS-update
  -- (a coluna textual vira `locais.nome`; as demais ficam como estão) e o
  -- predicado do índice parcial é aplicado verbatim — assim a semântica de NULL
  -- do índice (linhas com chave nula nunca colidem) é preservada.
  --
  -- Semântica de colisão: um grupo é colisão somente quando TODAS as colunas da
  -- chave são não nulas e iguais entre ≥2 linhas — exatamente o que um índice
  -- único btree rejeita. Um predicado que referencie a coluna textual é
  -- fail-closed (aborta): não se pode afirmar que o índice deixa de valer.
  --
  -- Nenhuma linha é alterada, mesclada ou excluída por este bloco: ele apenas lê.
  -- -------------------------------------------------------------------------
  IF normalizar_c THEN
    -- (C.0a) AUTORIZAÇÃO da operação C — validada ANTES do preflight de colisão,
    --        na ordem obrigatória do APPLY. No DRY-RUN nada disso é exigido (não
    --        há escrita): o modo C reporta e retorna mais abaixo.
    IF aplicar THEN
      IF b_casos > 0 THEN
        RAISE EXCEPTION 'E4.2/01.5.2 ABORTADO: % caso(s) classe B (divergência textual real, não cosmética). A normalização de classe C exige que TODOS os casos sejam cosméticos. Nada foi alterado.', b_casos
          USING HINT = 'Execute primeiro a operação classe B (PROD-DB-01.5) e só depois a classe C; nunca misture as duas.';
      END IF;
      IF NOT confirmado_c THEN
        RAISE EXCEPTION 'E4.2/01.5.2 APPLY recusado: falta -v confirmacao=PROD-DB-01.5.2. Nada foi alterado.'
          USING HINT = 'A normalização de classe C exige a confirmação textual específica PROD-DB-01.5.2 (distinta da classe B).';
      END IF;
    END IF;

    FOR tgt IN
      SELECT * FROM (VALUES
        ('estoques',      'local',         'local_id'),
        ('movimentacoes', 'local',         'local_id'),
        ('movimentacoes', 'local_destino', 'local_destino_id'),
        ('inventarios',   'local',         'local_id')
      ) AS v(tabela, coluna, fk)
    LOOP
      -- A colisão pode ocorrer entre uma linha ATUALIZADA e outra que NÃO é
      -- atualizada (caso real: 'loja' normaliza para 'LOJA' e já existe uma
      -- linha 'LOJA'). Por isso o preflight avalia a tabela INTEIRA no estado
      -- PÓS-update, e não apenas as linhas candidatas ao UPDATE.
      --
      -- `base_from` faz LEFT JOIN com o local canônico; `cand` marca a linha que
      -- o UPDATE de classe C realmente alteraria (mesmo vínculo, mesma empresa,
      -- texto divergente só por caixa/espaço). Para as demais, o texto fica
      -- como está. `filtro` é o estado pós-update aplicado ao predicado do índice.
      base_from := format(
        '%I r LEFT JOIN locais l ON l.id = r.%I',
        tgt.tabela, tgt.fk);
      cand := format(
        '(r.%I IS NOT NULL AND l.id IS NOT NULL AND l.empresa_id = r.empresa_id'
        || ' AND r.%I IS DISTINCT FROM l.nome AND lower(btrim(r.%I)) = lower(btrim(l.nome)))',
        tgt.fk, tgt.coluna, tgt.coluna);

      FOR idx_rec IN
        SELECT c.relname AS idx_nome,
               pg_get_expr(i.indpred, i.indrelid) AS pred,
               pg_get_indexdef(i.indexrelid) AS idx_def,
               ARRAY(
                 SELECT a.attname
                   FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                  WHERE k.ord <= i.indnkeyatts
                  ORDER BY k.ord
               ) AS cols
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = current_schema()
           AND t.relname = tgt.tabela
           -- TODO índice único conta, inclusive a chave primária: a única
           -- razão para excluir a PK seria a suposição de que `id` nunca é a
           -- coluna textual normalizada — suposição que o preflight não faz.
           AND i.indisunique AND i.indisvalid
           AND (
             -- (a) a chave inclui a coluna textual normalizada: o valor da chave
             --     muda e duas linhas podem passar a colidir.
             tgt.coluna = ANY (
                   SELECT a2.attname
                     FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k2(attnum, ord)
                     JOIN pg_attribute a2 ON a2.attrelid = i.indrelid AND a2.attnum = k2.attnum
                    WHERE k2.ord <= i.indnkeyatts
                 )
             -- (b) o predicado do índice parcial referencia a coluna textual:
             --     a linha pode entrar/sair do índice. Não dá para afirmar que
             --     deixa de valer — o bloco trata como fail-closed e aborta.
             OR (i.indpred IS NOT NULL
                 AND pg_get_expr(i.indpred, i.indrelid)
                     ~* ('(^|[^a-z0-9_])' || lower(tgt.coluna) || '([^a-z0-9_]|$)'))
           )
      LOOP
        idx_verificados := idx_verificados + 1;

        -- Fail-closed: predicado que menciona a coluna textual impede afirmar
        -- que o índice deixará de valer (a linha pode entrar/sair do índice).
        -- Não se arrisca — aborta antes de qualquer escrita.
        IF idx_rec.pred IS NOT NULL
           AND idx_rec.pred ~* ('(^|[^a-z0-9_])' || lower(tgt.coluna) || '([^a-z0-9_]|$)') THEN
          RAISE EXCEPTION 'E4.2/01.5.3 ABORTADO: o índice único % em % tem predicado que referencia a coluna normalizada (%) — não é possível afirmar que o índice deixa de valer. Nada foi alterado.',
            idx_rec.idx_nome, tgt.tabela, tgt.coluna
            USING HINT = 'Revise manualmente o índice parcial; o preflight é fail-closed e nunca assume que um predicado sobre a coluna normalizada não colidirá.';
        END IF;

        -- Monta a chave PÓS-update: a coluna textual vira l.nome nas linhas
        -- candidatas (e permanece igual nas demais); as outras colunas da chave
        -- ficam como estão. `key_args` alimenta `jsonb_build_object`, que agrupa
        -- por igualdade exata de coluna e serve para exibir a chave conflitante.
        -- `nao_nulo` reproduz a semântica NULL-distinta de um índice único btree:
        -- uma chave com qualquer coluna nula nunca colide.
        key_args := '';
        nao_nulo := '';
        FOR i IN 1 .. array_length(idx_rec.cols, 1) LOOP
          IF idx_rec.cols[i] = tgt.coluna THEN
            expr := format('(CASE WHEN %s THEN l.nome ELSE r.%I END)', cand, tgt.coluna);
          ELSE
            expr := format('r.%I', idx_rec.cols[i]);
          END IF;
          key_args := key_args || CASE WHEN i > 1 THEN ', ' ELSE '' END
                      || format('%L, %s', idx_rec.cols[i], expr);
          nao_nulo := nao_nulo || CASE WHEN i > 1 THEN ' AND ' ELSE '' END
                      || format('(%s) IS NOT NULL', expr);
        END LOOP;

        -- O predicado do índice parcial é aplicado verbatim: ele nunca
        -- referencia a coluna textual (senão o bloco acima já teria abortado) e
        -- as demais colunas não mudam no UPDATE.
        pred_sql := coalesce(idx_rec.pred, 'true');

        EXECUTE format(
          'SELECT count(*), coalesce(sum(n), 0) FROM ('
          || '  SELECT count(*) AS n'
          || '    FROM %s'
          || '   WHERE (%s) AND (%s)'
          || '   GROUP BY jsonb_build_object(%s)'
          || '  HAVING count(*) > 1'
          || ') g',
          base_from, pred_sql, nao_nulo, key_args
        ) INTO viol, linhas_idx;

        IF viol > 0 THEN
          colisoes_total := colisoes_total + viol;
          colisoes_linhas := colisoes_linhas + linhas_idx;

          -- Relatório por chave: o detalhe usa os dados REAIS (nunca fictícios).
          -- Ordenação DETERMINÍSTICA e independente de collation: sem ORDER BY,
          -- a ordem de `array_agg(DISTINCT ...)` segue a collation do banco
          -- (C.UTF-8 e en_US.utf8/ICU produzem ordens diferentes para o mesmo
          -- dado — ex.: {LOJA,loja} × {loja,LOJA}). O relatório não pode mudar
          -- de forma entre ambientes. Colunas textuais usam COLLATE "C"
          -- (byte a byte); as demais, ordem numérica explícita. Argumentos
          -- posicionais (%n$) porque a coluna textual aparece duas vezes.
          FOR det IN EXECUTE format(
            'SELECT jsonb_build_object(%1$s)::text AS chave,'
            || ' count(*) AS linhas, array_agg(r.id ORDER BY r.id) AS registro_ids,'
            || ' array_agg(DISTINCT r.empresa_id ORDER BY r.empresa_id) AS empresas,'
            || ' array_agg(DISTINCT r.%2$I ORDER BY r.%2$I) AS local_ids,'
            || ' array_agg(DISTINCT r.%3$I COLLATE "C" ORDER BY r.%3$I COLLATE "C") AS locais_atuais,'
            || ' array_agg(DISTINCT l.nome COLLATE "C" ORDER BY l.nome COLLATE "C") AS locais_canonicos'
            || ' FROM %4$s'
            || ' WHERE (%5$s) AND (%6$s)'
            || ' GROUP BY jsonb_build_object(%7$s)'
            || ' HAVING count(*) > 1'
            || ' ORDER BY 1',
            key_args, tgt.fk, tgt.coluna, base_from, pred_sql, nao_nulo, key_args
          )
          LOOP
            colisoes_resumo := colisoes_resumo || format(
              E'\n  • tabela=%s índice=%s chave_conflitante=%s empresa_id=%s local_id=%s local_atual=%s local_canonico=%s linhas=%s registros=%s',
              tgt.tabela, idx_rec.idx_nome, det.chave, det.empresas, det.local_ids,
              det.locais_atuais, det.locais_canonicos, det.linhas, det.registro_ids);
          END LOOP;

          RAISE NOTICE 'E4.2/01.5.3 COLISÃO: tabela=% índice=% coluna=% chaves_conflitantes=% linhas_envolvidas=%',
            tgt.tabela, idx_rec.idx_nome, tgt.coluna, viol, linhas_idx;
        END IF;
      END LOOP;
    END LOOP;

    RAISE NOTICE 'E4.2/01.5.3 preflight de colisão: índices únicos verificados=%, chaves em colisão=%, linhas envolvidas=%',
      idx_verificados, colisoes_total, colisoes_linhas;
  END IF;

  -- -------------------------------------------------------------------------
  -- (C.1) DRY-RUN — padrão. Reporta TODOS os contadores e NÃO escreve nada.
  --       Não aborta por presença de classe B/C (não há escrita); a decisão de
  --       qual operação rodar é explícita no APPLY.
  -- -------------------------------------------------------------------------
  IF NOT aplicar THEN
    RAISE NOTICE 'E4.2/01.5 DRY-RUN: nenhuma escrita.';
    RAISE NOTICE 'E4.2/01.5 DRY-RUN contadores: classe_A=%, classe_B=%, classe_C=%, seria_corrigido_classe_B=%, seria_normalizado_classe_C=%, alterados=0',
      a_casos, b_casos, c_casos, b_casos, c_casos;
    IF normalizar_c THEN
      IF colisoes_total > 0 THEN
        RAISE NOTICE 'E4.2/01.5.3 DRY-RUN: % colisão(ões) de chave única detectada(s) (% linha(s)). O APPLY abortaria ANTES de qualquer UPDATE. Detalhe:%',
          colisoes_total, colisoes_linhas, colisoes_resumo;
      ELSE
        RAISE NOTICE 'E4.2/01.5.3 DRY-RUN: nenhuma colisão de chave única prevista (índices verificados=%); a normalização pode ser aplicada com segurança.', idx_verificados;
      END IF;
      RAISE NOTICE 'E4.2/01.5.2 DRY-RUN: modo classe C habilitado; para aplicar use -v apply=on -v confirmacao=PROD-DB-01.5.2 -v normalizar_classe_c=on';
    ELSE
      RAISE NOTICE 'E4.2/01.5 DRY-RUN: modo classe B (padrão); para aplicar use -v apply=on -v confirmacao=PROD-DB-01.5';
      RAISE NOTICE 'E4.2/01.5.2 DRY-RUN: para normalizar classe C use -v normalizar_classe_c=on -v apply=on -v confirmacao=PROD-DB-01.5.2';
    END IF;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- (C.2) APPLY — operações B e C são MUTUAMENTE EXCLUSIVAS: cada uma aborta se
  --       houver casos da outra. Nunca se "mistura classe B com classe C".
  --       A autorização e o preflight de colisão da classe C já rodaram em
  --       (C.0a)/(C.0); aqui só resta decidir o COMMIT a partir da colisão.
  -- -------------------------------------------------------------------------
  IF normalizar_c THEN
    -- PROD-DB-01.5.3 — COLISÃO DE CHAVE ÚNICA: aborta ANTES de qualquer UPDATE.
    -- O preflight (C.0) já rodou; aqui é a decisão. Nenhum UPDATE abaixo executa
    -- e o COMMIT não ocorre: a transação é revertida pelo wrapper (ON_ERROR_STOP).
    IF colisoes_total > 0 THEN
      RAISE EXCEPTION 'E4.2/01.5.3 ABORTADO: a normalização classe C faria % chave(s) única(s) colidir (% linha(s) envolvida(s)). Nenhum UPDATE foi executado e nada será persistido.', colisoes_total, colisoes_linhas
        USING HINT = 'O PostgreSQL nunca é quem descobre a violação: o preflight aborta ANTES de escrever. Revise as linhas listadas e decida manualmente qual manter — a normalização NÃO faz merge nem exclui registros. Detalhe:' || colisoes_resumo;
    END IF;

    RAISE NOTICE 'E4.2/01.5.2 classificação: A=% B=% C=% (operação classe C autorizada: % a normalizar)', a_casos, b_casos, c_casos, c_casos;
  ELSE
    IF c_casos > 0 THEN
      RAISE EXCEPTION 'E4.2/01.5 ABORTADO: % caso(s) classe C (diferença apenas de caixa/espaço). Nada foi alterado.', c_casos
        USING HINT = 'Diferença cosmética: use a operação explícita -v normalizar_classe_c=on -v confirmacao=PROD-DB-01.5.2 para normalizar; não é propagação de renome.';
    END IF;
    IF NOT confirmado_b THEN
      RAISE EXCEPTION 'E4.2/01.5 APPLY recusado: falta -v confirmacao=PROD-DB-01.5. Nada foi alterado.'
        USING HINT = 'A dupla confirmação evita APPLY acidental.';
    END IF;
    RAISE NOTICE 'E4.2/01.5 classificação: A=% C=% B=% (operação classe B autorizada: todos classe B, correção segura)', a_casos, c_casos, b_casos;
  END IF;

  -- -------------------------------------------------------------------------
  -- (D) CORREÇÃO — junta SEMPRE por local_id + empresa_id (nunca por nome).
  --     Operação C acrescenta a restrição cosmética (defesa em profundidade):
  --     só toca linhas cujo texto difere do canônico APENAS por caixa/espaço.
  -- -------------------------------------------------------------------------
  IF normalizar_c THEN
    UPDATE estoques e SET local = l.nome
      FROM locais l
     WHERE e.local_id = l.id
       AND e.empresa_id = l.empresa_id
       AND e.local IS DISTINCT FROM l.nome
       AND lower(btrim(e.local)) = lower(btrim(l.nome));
    GET DIAGNOSTICS upd_estoques = ROW_COUNT;

    UPDATE movimentacoes m SET local = l.nome
      FROM locais l
     WHERE m.local_id = l.id
       AND m.empresa_id = l.empresa_id
       AND m.local IS DISTINCT FROM l.nome
       AND lower(btrim(m.local)) = lower(btrim(l.nome));
    GET DIAGNOSTICS upd_mov_local = ROW_COUNT;

    UPDATE movimentacoes m SET local_destino = l.nome
      FROM locais l
     WHERE m.local_destino_id = l.id
       AND m.empresa_id = l.empresa_id
       AND m.local_destino IS DISTINCT FROM l.nome
       AND lower(btrim(m.local_destino)) = lower(btrim(l.nome));
    GET DIAGNOSTICS upd_mov_dest = ROW_COUNT;

    UPDATE inventarios inv SET local = l.nome
      FROM locais l
     WHERE inv.local_id = l.id
       AND inv.empresa_id = l.empresa_id
       AND inv.local IS DISTINCT FROM l.nome
       AND lower(btrim(inv.local)) = lower(btrim(l.nome));
    GET DIAGNOSTICS upd_inv = ROW_COUNT;
  ELSE
    UPDATE estoques e SET local = l.nome
      FROM locais l
     WHERE e.local_id = l.id
       AND e.empresa_id = l.empresa_id
       AND e.local IS DISTINCT FROM l.nome;
    GET DIAGNOSTICS upd_estoques = ROW_COUNT;

    UPDATE movimentacoes m SET local = l.nome
      FROM locais l
     WHERE m.local_id = l.id
       AND m.empresa_id = l.empresa_id
       AND m.local IS DISTINCT FROM l.nome;
    GET DIAGNOSTICS upd_mov_local = ROW_COUNT;

    UPDATE movimentacoes m SET local_destino = l.nome
      FROM locais l
     WHERE m.local_destino_id = l.id
       AND m.empresa_id = l.empresa_id
       AND m.local_destino IS DISTINCT FROM l.nome;
    GET DIAGNOSTICS upd_mov_dest = ROW_COUNT;

    UPDATE inventarios inv SET local = l.nome
      FROM locais l
     WHERE inv.local_id = l.id
       AND inv.empresa_id = l.empresa_id
       AND inv.local IS DISTINCT FROM l.nome;
    GET DIAGNOSTICS upd_inv = ROW_COUNT;
  END IF;

  RAISE NOTICE 'E4.2/01.5 atualizados: estoques.local=%, movimentacoes.local=%, movimentacoes.local_destino=%, inventarios.local=% (total=%)',
    upd_estoques, upd_mov_local, upd_mov_dest, upd_inv,
    upd_estoques + upd_mov_local + upd_mov_dest + upd_inv;

  -- -------------------------------------------------------------------------
  -- (E) DIAGNÓSTICO AFTER — FAIL-CLOSED.
  --
  -- Reexecuta TODOS os contadores relevantes do preflight E4.2 (0030) e exige
  -- que TODOS sejam exatamente 0. `nomes_locais_inconsistentes=0` NÃO basta:
  -- a propagação pode revelar OUTRO bloqueio do mesmo preflight (ex.: duas
  -- linhas de estoque com tamanho_id NULL que ficam duplicadas no texto
  -- canônico). Se qualquer contador for > 0, RAISE EXCEPTION ⇒ a transação é
  -- revertida e NADA é persistido.
  --
  -- A lógica de identificação dos registros classe B acima NÃO é alterada: a
  -- correção continua sendo por local_id + empresa_id, nunca por nome textual.
  -- -------------------------------------------------------------------------
  -- (E.1) nomes_locais_inconsistentes — as quatro parcelas exatas da 0030.
  SELECT
    (SELECT count(*) FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.local_id IS NOT NULL AND e.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_id
      WHERE m.local_id IS NOT NULL AND m.local IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM movimentacoes m JOIN locais l ON l.id = m.local_destino_id
      WHERE m.local_destino_id IS NOT NULL AND m.local_destino IS DISTINCT FROM l.nome) +
    (SELECT count(*) FROM inventarios inv JOIN locais l ON l.id = inv.local_id
      WHERE inv.local_id IS NOT NULL AND inv.local IS DISTINCT FROM l.nome)
    INTO total_depois;

  -- (E.2) duplicatas_locais / duplicatas_padroes — idênticas à 0030.
  SELECT count(*) INTO dup_locais FROM (
    SELECT empresa_id, nome FROM locais GROUP BY empresa_id, nome HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_padroes FROM (
    SELECT empresa_id FROM locais WHERE padrao IS TRUE GROUP BY empresa_id HAVING count(*) > 1
  ) d;

  -- (E.3) duplicatas_saldos / duplicatas_itens_inventario / saldos inválidos.
  SELECT count(*) INTO dup_saldos FROM (
    SELECT empresa_id, produto_id, tamanho_id, local FROM estoques
    GROUP BY empresa_id, produto_id, tamanho_id, local HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO dup_itens_inv FROM (
    SELECT empresa_id, inventario_id, produto_id, tamanho_id FROM itens_inventario
    GROUP BY empresa_id, inventario_id, produto_id, tamanho_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO saldos_invalidos FROM estoques WHERE produto_id IS NULL OR local IS NULL;

  -- (E.4) vinculos_empresa — idêntico à 0030.
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

  -- (E.5) vinculos_locais — idêntico à 0030.
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

  -- (E.6) PDV — mesmas regras da 0030, com a coluna aditiva opcional.
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

  -- (E.7) referências operacionais — mesmo segundo preflight da 0030.
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

  RAISE NOTICE 'E4.2/01.5 AFTER nomes_locais_inconsistentes=% (fail-closed) contadores: duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_invalidos=%, vinculos_empresa=%, vinculos_locais=%, pdv_vinculos=%, pdv_nomes=%, refs_operacionais=%',
    total_depois, dup_locais, dup_padroes, dup_saldos, dup_itens_inv, saldos_invalidos,
    vinc_empresa, vinc_locais, pdv_vinc, pdv_nomes, refs_operacionais;

  IF total_depois + dup_locais + dup_padroes + dup_saldos + dup_itens_inv + saldos_invalidos
     + vinc_empresa + vinc_locais + pdv_vinc + pdv_nomes + refs_operacionais <> 0 THEN
    RAISE EXCEPTION 'E4.2/01.5 FALHOU (fail-closed): o estado final NÃO satisfaz o preflight E4.2. nomes_locais_inconsistentes=%, duplicatas_locais=%, duplicatas_padroes=%, duplicatas_saldos=%, duplicatas_itens_inventario=%, saldos_invalidos=%, vinculos_empresa=%, vinculos_locais=%, pdv_vinculos=%, pdv_nomes=%, refs_operacionais=%. Transação revertida: NADA foi persistido.',
      total_depois, dup_locais, dup_padroes, dup_saldos, dup_itens_inv, saldos_invalidos,
      vinc_empresa, vinc_locais, pdv_vinc, pdv_nomes, refs_operacionais
      USING HINT = 'Investigue os contadores > 0 (use db/diagnostico-e42-nomes-locais.sql); a correção não deve mascarar outro bloqueio do preflight.';
  END IF;
  RAISE NOTICE 'E4.2/01.5 AFTER OK: todos os contadores do preflight E4.2 = 0 (nomes_locais_inconsistentes de % para 0)', total_antes;

  -- Marca de autorização de COMMIT: só chega aqui quem passou por TODAS as
  -- guardas, pela confirmação correta e pela pós-validação fail-closed.
  PERFORM set_config('e42.autorizado', 'on', false);
END
$e42_propagar_nomes_locais$;

-- ----------------------------------------------------------------------------
-- (F) SEGURANÇA — COMMIT só no APPLY explícito E autorizado pelo bloco;
--     qualquer outro caminho faz ROLLBACK.
-- ----------------------------------------------------------------------------
\if :apply
  SELECT current_setting('e42.autorizado', true) AS autorizado \gset
  \if :autorizado
    COMMIT;
    \echo 'E4.2/01.5 APPLY: transação COMITADA. Confirme com o diagnóstico read-only (db/diagnostico-e42-nomes-locais.sql) que o contador está em 0.'
  \else
    ROLLBACK;
    \echo 'E4.2/01.5 APPLY NÃO AUTORIZADO: a pós-validação não foi concluída; transação revertida (ROLLBACK). Nenhum dado foi alterado.'
  \endif
\else
  ROLLBACK;
  \echo 'E4.2/01.5 DRY-RUN: transação revertida (ROLLBACK). Nenhum dado foi alterado.'
\endif
