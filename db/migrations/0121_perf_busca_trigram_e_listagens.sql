-- ============================================================================
-- 0121 — PERFORMANCE: BUSCA POR TEXTO (trigram) EM PRODUTOS / CLIENTES /
--        FORNECEDORES
--
-- POR QUE ESTA MIGRAÇÃO EXISTE (evidência, não suposição)
-- ------------------------------------------------------
-- A busca do ERP (`searchClause`, server/src/pgstore.ts) monta, para cada termo
-- digitado, um OR entre as colunas pesquisáveis do recurso:
--
--     t.nome::text ILIKE '%termo%'  OR  t.sku::text ILIKE '%termo%'  OR ...
--
-- Um padrão com CURINGA À ESQUERDA (`%termo%`) NÃO pode ser atendido por índice
-- B-tree: o PostgreSQL não consegue aproveitar a ordenação, então o plano é
-- **Seq Scan na tabela inteira** seguido de filtro por linha. Em `produtos`,
-- esse OR percorre todos os campos `search: true` (nome, sku, codigo_barras,
-- marca, tags, material, modelagem, gênero, codigo_item, codigo_categoria,
-- codigo_industria…), o que torna a busca de SKU — a operação mais frequente do
-- PDV e do estoque — proporcional ao tamanho do catálogo.
--
-- O índice correto para ILIKE com curinga à esquerda é GIN com a classe de
-- operadores `gin_trgm_ops` da extensão `pg_trgm`, que indexa os trigramas do
-- texto e resolve o predicado por bitmap. Vários índices GIN na MESMA tabela
-- são combinados pelo planejador por BitmapOr, exatamente como a consulta
-- precisa.
--
-- ESCOPO DELIBERADAMENTE MÍNIMO
-- -----------------------------
-- Só as colunas que o operador realmente digita e que estão em tabelas grandes:
--
--   produtos.nome           — busca por descrição do produto
--   produtos.sku            — busca por referência/SKU (PDV, estoque, compras)
--   produtos.codigo_barras  — leitura/consulta de EAN
--   clientes.nome           — busca de cliente no pedido/venda
--   fornecedores.nome       — busca de fornecedor na compra
--
-- NÃO indexamos os demais campos `search: true` de produtos (marca, tags,
-- material, modelagem, gênero, códigos de origem): são filtros ocasionais e cada
-- índice GIN adicional custa escrita, WAL e espaço em TODO INSERT/UPDATE do
-- catálogo. Índice seletivo seletivo — nunca "um por campo".
--
-- SEGURANÇA / IDEMPOTÊNCIA
-- ------------------------
--   • Se a extensão `pg_trgm` não estiver disponível ou o usuário não puder
--     criá-la, a migração NÃO falha: emite NOTICE e não cria os índices. A busca
--     continua correta (apenas sem aceleração). O boot nunca é derrubado por
--     causa de otimização.
--   • `CREATE INDEX IF NOT EXISTS` — reaplicar não custa nada.
--   • Em tabela JÁ GRANDE em produção, use o caminho sem bloqueio:
--     `node scripts/perf/indices-concurrently.mjs --dry-run` e depois `--apply`
--     (CREATE INDEX CONCURRENTLY, fora de transação). Este arquivo roda dentro
--     da transação da migração e por isso não pode usar CONCURRENTLY.
--
-- ROLLBACK (manutenção autorizada)
--   DROP INDEX IF EXISTS perf_produtos_nome_trgm;
--   DROP INDEX IF EXISTS perf_produtos_sku_trgm;
--   DROP INDEX IF EXISTS perf_produtos_codigo_barras_trgm;
--   DROP INDEX IF EXISTS perf_clientes_nome_trgm;
--   DROP INDEX IF EXISTS perf_fornecedores_nome_trgm;
--   (A extensão pg_trgm pode permanecer: não altera comportamento.)
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ELSE
    RAISE NOTICE 'pg_trgm indisponível neste servidor — índices de busca não serão criados.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm não pôde ser criada (%). Índices de busca não serão criados; a busca segue funcionando sem aceleração.', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE NOTICE 'pg_trgm ausente: pulando índices de busca por trigram.';
    RETURN;
  END IF;

  IF to_regclass('public.produtos') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS perf_produtos_nome_trgm ON produtos USING gin (nome gin_trgm_ops)';
    -- `sku` é curto e único por empresa: o trigram acelera o trecho parcial
    -- ("CAM-0" antes de "CAM-001"), que é como o operador busca.
    EXECUTE 'CREATE INDEX IF NOT EXISTS perf_produtos_sku_trgm ON produtos USING gin (sku gin_trgm_ops)';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'produtos' AND column_name = 'codigo_barras'
    ) THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS perf_produtos_codigo_barras_trgm ON produtos USING gin (codigo_barras gin_trgm_ops)';
    END IF;
  END IF;

  IF to_regclass('public.clientes') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS perf_clientes_nome_trgm ON clientes USING gin (nome gin_trgm_ops)';
  END IF;

  IF to_regclass('public.fornecedores') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS perf_fornecedores_nome_trgm ON fornecedores USING gin (nome gin_trgm_ops)';
  END IF;
END $$;
