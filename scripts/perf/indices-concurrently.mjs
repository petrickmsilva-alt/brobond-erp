#!/usr/bin/env node
// ============================================================================
// CRIAÇÃO E HOMOLOGAÇÃO SEGURA DOS ÍNDICES DA MIGRAÇÃO 0121 (CONCURRENTLY)
//
// POR QUE UM SCRIPT, SE JÁ EXISTE MIGRAÇÃO?
//   A migração 0121 roda dentro da transação do runner de migrações — e
//   `CREATE INDEX CONCURRENTLY` NÃO pode rodar em transação. Em produção,
//   `CREATE INDEX` transacional bloqueia escrita na tabela enquanto constrói.
//   Este script prepara e valida os 5 índices fora de transação ANTES do deploy:
//
//     1. verifica se pg_trgm está disponível e instalada;
//     2. consulta cada índice pelo schema (`public`) e nome em `pg_index`,
//        conferindo existência real, `indisvalid` e `indisready`;
//     3. se o índice já existir válido e pronto, informa e pula;
//     4. se o índice existir INVÁLIDO ou NÃO PRONTO, interrompe imediatamente
//        com código != 0 e instrução explícita de recuperação manual (NUNCA
//        executa DROP automaticamente);
//     5. em dry-run (padrão), mostra exatamente o que faria sem alterar nada;
//     6. com --apply, cria cada índice ausente com CONCURRENTLY e, ao final,
//        revalida todos os 5 índices aplicáveis em `pg_index`. O sucesso só é
//        declarado quando todos os aplicáveis estão válidos e prontos.
//
// Uso:
//   PERF_DB_URL='postgres://...' node scripts/perf/indices-concurrently.mjs            # dry-run
//   PERF_DB_URL='postgres://...' node scripts/perf/indices-concurrently.mjs --apply    # aplica
//
// PRÉ-REQUISITOS DE OPERAÇÃO (não automatizados de propósito)
//   • Utiliza exclusivamente PERF_DB_URL (nunca usa DATABASE_URL como fallback).
//   • Backup/ponto de recuperação verificado ANTES (Neon restore point / dump).
//   • Janela de baixo tráfego: CONCURRENTLY evita bloqueio, mas consome CPU/IO.
// ============================================================================
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ESQUEMA = 'public';

// Espelha exatamente os 5 índices GIN definidos em db/migrations/0121.
export const INDICES = Object.freeze([
  Object.freeze({
    tabela: 'produtos',
    coluna: 'nome',
    nome: 'perf_produtos_nome_trgm',
    expressao: '(nome gin_trgm_ops)',
  }),
  Object.freeze({
    tabela: 'produtos',
    coluna: 'sku',
    nome: 'perf_produtos_sku_trgm',
    expressao: '(sku gin_trgm_ops)',
  }),
  Object.freeze({
    tabela: 'produtos',
    coluna: 'codigo_barras',
    nome: 'perf_produtos_codigo_barras_trgm',
    expressao: '(codigo_barras gin_trgm_ops)',
  }),
  Object.freeze({
    tabela: 'clientes',
    coluna: 'nome',
    nome: 'perf_clientes_nome_trgm',
    expressao: '(nome gin_trgm_ops)',
  }),
  Object.freeze({
    tabela: 'fornecedores',
    coluna: 'nome',
    nome: 'perf_fornecedores_nome_trgm',
    expressao: '(nome gin_trgm_ops)',
  }),
]);

export function instrucaoRecuperacaoManual(esquema, nome) {
  return (
    `Instrução de recuperação manual (NUNCA executada automaticamente; exige análise e autorização): ` +
    `conecte-se fora de transação, execute "DROP INDEX CONCURRENTLY ${esquema}.${nome};" ` +
    `e em seguida reexecute "npm run perf:indices" (dry-run) e "npm run perf:indices -- --apply".`
  );
}

/**
 * Consulta aplicabilidade (tabela + coluna no schema) e estado real do índice
 * em `pg_index` (`indisvalid`, `indisready`, tabela associada e tamanho), usando
 * apenas consultas parametrizadas.
 */
export async function consultarEstadoIndice(cliente, def, esquema = ESQUEMA) {
  const { rows: metaRows } = await cliente.query(
    `SELECT
       EXISTS (
         SELECT 1
           FROM pg_class t
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1
            AND t.relname = $2
            AND t.relkind IN ('r', 'p')
       ) AS tabela_existe,
       EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
            AND column_name = $3
       ) AS coluna_existe`,
    [esquema, def.tabela, def.coluna]
  );
  const tabelaExiste = Boolean(metaRows[0]?.tabela_existe);
  const colunaExiste = Boolean(metaRows[0]?.coluna_existe);
  const aplicavel = tabelaExiste && colunaExiste;

  const { rows: idxRows } = await cliente.query(
    `SELECT
       c.relname AS nome,
       n.nspname AS esquema,
       t.relname AS tabela_real,
       i.indisvalid AS indisvalid,
       i.indisready AS indisready,
       pg_size_pretty(pg_relation_size(c.oid)) AS tamanho
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_class t ON t.oid = i.indrelid
     WHERE n.nspname = $1
       AND c.relname = $2`,
    [esquema, def.nome]
  );

  const idx = idxRows[0];
  if (!idx) {
    return {
      esquema,
      nome: def.nome,
      tabela: def.tabela,
      coluna: def.coluna,
      aplicavel,
      existe: false,
      tabela_correta: null,
      indisvalid: null,
      indisready: null,
      tamanho: null,
    };
  }

  return {
    esquema,
    nome: def.nome,
    tabela: def.tabela,
    tabela_real: idx.tabela_real,
    coluna: def.coluna,
    aplicavel,
    existe: true,
    tabela_correta: idx.tabela_real === def.tabela,
    indisvalid: Boolean(idx.indisvalid),
    indisready: Boolean(idx.indisready),
    tamanho: idx.tamanho ?? '0 bytes',
  };
}

function indiceIntegro(estado) {
  return (
    estado.existe === true &&
    estado.tabela_correta === true &&
    estado.indisvalid === true &&
    estado.indisready === true
  );
}

function descreverProblemaIndice(estado) {
  const partes = [];
  if (estado.indisvalid !== true) partes.push(`indisvalid=${estado.indisvalid}`);
  if (estado.indisready !== true) partes.push(`indisready=${estado.indisready}`);
  if (estado.tabela_correta === false) {
    partes.push(`tabela_associada=${estado.tabela_real} (esperado ${estado.tabela})`);
  }
  return partes.join(', ') || 'estado inconsistente';
}

/**
 * Executa a inspeção (dry-run) ou criação + homologação final (`aplicar: true`)
 * dos 5 índices GIN de trigram. Nunca executa DROP.
 */
export async function executarHomologacaoIndices(
  cliente,
  { aplicar = false, esquema = ESQUEMA, definicoes = INDICES, logger = console } = {}
) {
  const dispRes = await cliente.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = $1`,
    ['pg_trgm']
  );
  const instRes = await cliente.query(
    `SELECT 1 FROM pg_extension WHERE extname = $1`,
    ['pg_trgm']
  );
  const disponivel = (dispRes.rowCount ?? dispRes.rows?.length ?? 0) > 0;
  const instalada = (instRes.rowCount ?? instRes.rows?.length ?? 0) > 0;
  logger.log(`pg_trgm disponível: ${disponivel} · instalada: ${instalada}`);

  if (!disponivel) {
    logger.error(
      '⛔ pg_trgm não está disponível neste servidor PostgreSQL: não é possível homologar os 5 índices GIN.'
    );
    return {
      ok: false,
      codigoSaida: 1,
      motivo: 'pg_trgm_indisponivel',
      criados: 0,
      indices: [],
    };
  }

  if (!instalada) {
    if (!aplicar) {
      logger.log('→ [dry-run] criaria a extensão: CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    } else {
      await cliente.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      logger.log('✅ Extensão pg_trgm garantida.');
    }
  }

  let criados = 0;
  const planejados = [];

  // 1ª passagem: inspeciona cada índice em pg_index; se existir inválido ou não
  // pronto, interrompe imediatamente sem DROP automático.
  for (const def of definicoes) {
    const estado = await consultarEstadoIndice(cliente, def, esquema);

    if (estado.existe) {
      if (!indiceIntegro(estado)) {
        const detalhe = descreverProblemaIndice(estado);
        logger.error(
          `⛔ Índice existente inválido ou não pronto: ${esquema}.${def.nome} na tabela ${esquema}.${def.tabela} (${detalhe}).`
        );
        logger.error(instrucaoRecuperacaoManual(esquema, def.nome));
        return {
          ok: false,
          codigoSaida: 1,
          motivo: 'indice_invalido_ou_nao_pronto',
          indiceProblema: def.nome,
          criados,
          indices: [estado],
        };
      }
      logger.log(
        `= ${esquema}.${def.nome} (${def.tabela}): já existe, válido e pronto ` +
          `(indisvalid=true, indisready=true, tamanho=${estado.tamanho}). Pulando.`
      );
      continue;
    }

    if (!estado.aplicavel) {
      logger.log(
        `- ${esquema}.${def.tabela}.${def.coluna}: tabela/coluna ausente neste banco (não aplicável), pulando ${def.nome}.`
      );
      continue;
    }

    const ddl = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${def.nome} ON ${esquema}.${def.tabela} USING gin ${def.expressao}`;
    if (!aplicar) {
      planejados.push(def.nome);
      logger.log(`→ [dry-run] ${ddl}`);
      continue;
    }

    logger.log(`… criando ${esquema}.${def.nome} (CONCURRENTLY, fora de transação, sem bloquear escrita)`);
    const inicio = Date.now();
    await cliente.query(ddl);
    const ms = Date.now() - inicio;
    criados++;

    const posCriacao = await consultarEstadoIndice(cliente, def, esquema);
    if (!indiceIntegro(posCriacao)) {
      const detalhe = posCriacao.existe ? descreverProblemaIndice(posCriacao) : 'índice ausente após CREATE INDEX CONCURRENTLY';
      logger.error(
        `⛔ Falha na validação imediata de ${esquema}.${def.nome} após criação (${detalhe}).`
      );
      logger.error(instrucaoRecuperacaoManual(esquema, def.nome));
      return {
        ok: false,
        codigoSaida: 1,
        motivo: 'indice_invalido_apos_criacao',
        indiceProblema: def.nome,
        criados,
        indices: [posCriacao],
      };
    }
    logger.log(
      `✅ ${esquema}.${def.nome} criado em ${ms} ms · ${posCriacao.tamanho} · ` +
        `indisvalid=${posCriacao.indisvalid} · indisready=${posCriacao.indisready}`
    );
  }

  // 2ª passagem obrigatória: revalida os 5 índices em pg_index ao final.
  const estadosFinais = [];
  for (const def of definicoes) {
    estadosFinais.push(await consultarEstadoIndice(cliente, def, esquema));
  }

  logger.log('\n── Relatório de validação dos 5 índices (pg_index) ──');
  for (const e of estadosFinais) {
    logger.log(
      `  • ${e.esquema}.${e.nome} | tabela=${e.tabela} | aplicável=${e.aplicavel} | ` +
        `existe=${e.existe} | indisvalid=${e.indisvalid} | indisready=${e.indisready} | ` +
        `tamanho=${e.tamanho ?? '—'}`
    );
  }

  const invalidosFinais = estadosFinais.filter((e) => e.existe && !indiceIntegro(e));
  if (invalidosFinais.length > 0) {
    const primeiro = invalidosFinais[0];
    logger.error(
      `⛔ Validação final reprovada: ${primeiro.esquema}.${primeiro.nome} (${descreverProblemaIndice(primeiro)}).`
    );
    logger.error(instrucaoRecuperacaoManual(primeiro.esquema, primeiro.nome));
    return {
      ok: false,
      codigoSaida: 1,
      motivo: 'validacao_final_indice_invalido',
      indiceProblema: primeiro.nome,
      criados,
      indices: estadosFinais,
    };
  }

  if (!aplicar) {
    logger.log(
      planejados.length > 0
        ? `\nDry-run concluído: ${planejados.length} índice(s) pendente(s) de criação (${planejados.join(', ')}). Nada foi alterado no banco; use --apply após backup verificável.`
        : '\nDry-run concluído: todos os índices aplicáveis já existem, válidos e prontos. Nada foi alterado no banco.'
    );
    return {
      ok: true,
      codigoSaida: 0,
      modo: 'dry-run',
      pendentes: planejados,
      criados: 0,
      indices: estadosFinais,
    };
  }

  const aplicaveis = estadosFinais.filter((e) => e.aplicavel);
  const faltantesOuInvalidos = aplicaveis.filter((e) => !indiceIntegro(e));
  if (faltantesOuInvalidos.length > 0) {
    const primeiro = faltantesOuInvalidos[0];
    logger.error(
      `⛔ Homologação NÃO concluída: ${faltantesOuInvalidos.length} índice(s) aplicável(is) não estão válidos e prontos (primeiro: ${primeiro.esquema}.${primeiro.nome}).`
    );
    if (primeiro.existe) {
      logger.error(instrucaoRecuperacaoManual(primeiro.esquema, primeiro.nome));
    }
    return {
      ok: false,
      codigoSaida: 1,
      motivo: 'aplicaveis_incompletos',
      indiceProblema: primeiro.nome,
      criados,
      indices: estadosFinais,
    };
  }

  logger.log(
    `\n✅ Homologação concluída: ${aplicaveis.length} índice(s) aplicável(is) validados em pg_index ` +
      `(indisvalid=true, indisready=true; ${criados} criado(s) nesta execução).`
  );
  return {
    ok: true,
    codigoSaida: 0,
    modo: 'apply',
    criados,
    indices: estadosFinais,
  };
}

function executadoDiretamente() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executadoDiretamente()) {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--apply');
  // Regra estrita: usa EXCLUSIVAMENTE PERF_DB_URL (nunca DATABASE_URL como fallback).
  const urlBanco = process.env.PERF_DB_URL || '';

  if (!urlBanco.trim()) {
    console.error('Defina PERF_DB_URL (DATABASE_URL nunca é usada como fallback). Abortando.');
    process.exit(2);
  }

  const { default: pg } = await import('pg');
  const cliente = new pg.Client({
    connectionString: urlBanco,
    application_name: 'brobond-perf-indices',
  });
  await cliente.connect();

  try {
    const resultado = await executarHomologacaoIndices(cliente, { aplicar });
    if (!resultado.ok || resultado.codigoSaida !== 0) {
      process.exit(resultado.codigoSaida || 1);
    }
  } finally {
    await cliente.end().catch(() => undefined);
  }
}
