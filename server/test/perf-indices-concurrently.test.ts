// ============================================================================
// TESTES AUTOMATIZADOS — CORREÇÃO CIRÚRGICA Nº 1
// (`scripts/perf/indices-concurrently.mjs`)
//
// Cobre todos os cenários exigidos:
//   1. Índice inexistente (dry-run e --apply)
//   2. Índice existente válido (indisvalid=true) e pronto (indisready=true)
//   3. Índice existente inválido (indisvalid=false)
//   4. Índice existente não pronto (indisready=false)
//   5. Interrupção segura (código != 0, instrução manual explícita, ZERO auto-DROP)
//   6. Revalidação final dos 5 índices antes de declarar sucesso
//   7. Guardrail CLI: exige PERF_DB_URL sem fallback para DATABASE_URL
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — módulo ESM operacional em scripts/perf/
import {
  ESQUEMA,
  INDICES,
  consultarEstadoIndice,
  executarHomologacaoIndices,
} from '../../scripts/perf/indices-concurrently.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = path.resolve(__dirname, '../..');
const SCRIPT_INDICES = path.join(RAIZ_REPO, 'scripts/perf/indices-concurrently.mjs');

interface EstadoSimuladoIndice {
  existe: boolean;
  tabela_real?: string;
  indisvalid?: boolean;
  indisready?: boolean;
  tamanho?: string;
}

function criarLoggerCapturado() {
  const logs: string[] = [];
  const erros: string[] = [];
  return {
    logs,
    erros,
    logger: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => erros.push(args.map(String).join(' ')),
    },
    textoCompleto() {
      return [...logs, ...erros].join('\n');
    },
  };
}

function criarClienteMock(opcoes?: {
  pgTrgmDisponivel?: boolean;
  pgTrgmInstalada?: boolean;
  colunasAusentes?: string[];
  estadoInicial?: Record<string, EstadoSimuladoIndice>;
  estadoPosCriacao?: Record<string, Partial<EstadoSimuladoIndice>>;
  degradarNaSegundaPassagem?: Record<string, Partial<EstadoSimuladoIndice>>;
}) {
  const disponivel = opcoes?.pgTrgmDisponivel ?? true;
  let instalada = opcoes?.pgTrgmInstalada ?? true;
  const colunasAusentes = new Set(opcoes?.colunasAusentes ?? []);
  const mapa = new Map<string, EstadoSimuladoIndice>();
  for (const [nome, est] of Object.entries(opcoes?.estadoInicial ?? {})) {
    mapa.set(nome, { ...est });
  }
  const consultasIndice = new Map<string, number>();
  const queriesExecutadas: Array<{ sql: string; params: unknown[] }> = [];

  const cliente = {
    queriesExecutadas,
    async query(sql: string, params: unknown[] = []) {
      const sqlNormalizado = sql.replace(/\s+/g, ' ').trim();
      queriesExecutadas.push({ sql: sqlNormalizado, params });

      if (sqlNormalizado.includes('FROM pg_available_extensions')) {
        assert.deepEqual(params, ['pg_trgm'], 'consulta a pg_available_extensions deve ser parametrizada');
        return { rowCount: disponivel ? 1 : 0, rows: disponivel ? [{ '?column?': 1 }] : [] };
      }

      if (sqlNormalizado.includes('FROM pg_extension')) {
        assert.deepEqual(params, ['pg_trgm'], 'consulta a pg_extension deve ser parametrizada');
        return { rowCount: instalada ? 1 : 0, rows: instalada ? [{ '?column?': 1 }] : [] };
      }

      if (sqlNormalizado === 'CREATE EXTENSION IF NOT EXISTS pg_trgm') {
        instalada = true;
        return { rowCount: 0, rows: [] };
      }

      if (sqlNormalizado.includes('tabela_existe') && sqlNormalizado.includes('information_schema.columns')) {
        assert.equal(params.length, 3, 'consulta de aplicabilidade deve usar 3 parâmetros ($1,$2,$3)');
        const [, tabela, coluna] = params as [string, string, string];
        const chave = `${tabela}.${coluna}`;
        const ausente = colunasAusentes.has(chave);
        return {
          rowCount: 1,
          rows: [{ tabela_existe: true, coluna_existe: !ausente }],
        };
      }

      if (sqlNormalizado.includes('FROM pg_class c') && sqlNormalizado.includes('JOIN pg_index i')) {
        assert.equal(params.length, 2, 'consulta a pg_index deve ser parametrizada por schema e nome');
        const [esquema, nome] = params as [string, string];
        const n = (consultasIndice.get(nome) ?? 0) + 1;
        consultasIndice.set(nome, n);

        const def = INDICES.find((d: { nome: string }) => d.nome === nome);
        const est = mapa.get(nome);
        if (!est || !est.existe) {
          return { rowCount: 0, rows: [] };
        }

        const degradacao = n >= 2 ? opcoes?.degradarNaSegundaPassagem?.[nome] : undefined;
        const efetivo = { ...est, ...(degradacao ?? {}) };
        return {
          rowCount: 1,
          rows: [
            {
              nome,
              esquema,
              tabela_real: efetivo.tabela_real ?? def?.tabela ?? 'produtos',
              indisvalid: efetivo.indisvalid ?? true,
              indisready: efetivo.indisready ?? true,
              tamanho: efetivo.tamanho ?? '32 kB',
            },
          ],
        };
      }

      const matchCreate = /^CREATE INDEX CONCURRENTLY IF NOT EXISTS (\S+) ON (\S+)\.(\S+) USING gin /i.exec(
        sqlNormalizado
      );
      if (matchCreate) {
        const [, nome, , tabela] = matchCreate;
        const override = opcoes?.estadoPosCriacao?.[nome] ?? {};
        mapa.set(nome, {
          existe: override.existe ?? true,
          tabela_real: override.tabela_real ?? tabela,
          indisvalid: override.indisvalid ?? true,
          indisready: override.indisready ?? true,
          tamanho: override.tamanho ?? '64 kB',
        });
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`SQL inesperado no mock: ${sqlNormalizado}`);
    },
  };

  return cliente;
}

function afirmarZeroDropEZeroTransacao(queries: Array<{ sql: string }>) {
  for (const { sql } of queries) {
    assert.ok(!/\bDROP\b/i.test(sql), `NUNCA deve executar DROP automaticamente; visto: ${sql}`);
    assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql), `CONCURRENTLY não pode abrir transação; visto: ${sql}`);
  }
}

test('Catálogo de índices: mantém exatamente os 5 índices da Migration 0121 no schema public', () => {
  assert.equal(ESQUEMA, 'public');
  assert.equal(INDICES.length, 5);
  assert.deepEqual(
    INDICES.map((i: { nome: string }) => i.nome),
    [
      'perf_produtos_nome_trgm',
      'perf_produtos_sku_trgm',
      'perf_produtos_codigo_barras_trgm',
      'perf_clientes_nome_trgm',
      'perf_fornecedores_nome_trgm',
    ]
  );
});

test('Caso 1 — Índices inexistentes em dry-run: planeja os 5 sem alterar nada no banco', async () => {
  const cliente = criarClienteMock({ pgTrgmInstalada: false });
  const cap = criarLoggerCapturado();

  const res = await executarHomologacaoIndices(cliente, { aplicar: false, logger: cap.logger });

  assert.equal(res.ok, true);
  assert.equal(res.codigoSaida, 0);
  assert.equal(res.modo, 'dry-run');
  assert.equal(res.criados, 0);
  assert.equal(res.pendentes.length, 5);
  assert.equal(res.indices.length, 5);
  assert.ok(res.indices.every((i: { existe: boolean }) => i.existe === false));
  assert.ok(
    !cliente.queriesExecutadas.some((q) => q.sql.startsWith('CREATE INDEX')),
    'dry-run não pode executar CREATE INDEX'
  );
  afirmarZeroDropEZeroTransacao(cliente.queriesExecutadas);
});

test('Caso 2 — Índices já existentes, válidos (indisvalid=true) e prontos (indisready=true): pula criação e homologa', async () => {
  const estadoInicial = Object.fromEntries(
    INDICES.map((d: { nome: string; tabela: string }) => [
      d.nome,
      { existe: true, tabela_real: d.tabela, indisvalid: true, indisready: true, tamanho: '48 kB' },
    ])
  );
  const cliente = criarClienteMock({ estadoInicial });
  const cap = criarLoggerCapturado();

  const res = await executarHomologacaoIndices(cliente, { aplicar: true, logger: cap.logger });

  assert.equal(res.ok, true);
  assert.equal(res.codigoSaida, 0);
  assert.equal(res.criados, 0);
  assert.equal(res.indices.length, 5);
  assert.ok(res.indices.every((i: { indisvalid: boolean; indisready: boolean }) => i.indisvalid && i.indisready));
  assert.ok(!cliente.queriesExecutadas.some((q) => q.sql.startsWith('CREATE INDEX')));
  assert.match(cap.textoCompleto(), /já existe, válido e pronto/);
  assert.match(cap.textoCompleto(), /Homologação concluída: 5 índice\(s\) aplicável\(is\) validados/);
  afirmarZeroDropEZeroTransacao(cliente.queriesExecutadas);
});

test('Caso 3 — Índice existente INVÁLIDO (indisvalid=false): interrompe com código != 0, instrui recuperação e NUNCA faz DROP', async () => {
  const cliente = criarClienteMock({
    estadoInicial: {
      perf_produtos_nome_trgm: { existe: true, indisvalid: true, indisready: true },
      perf_produtos_sku_trgm: { existe: true, indisvalid: false, indisready: true },
    },
  });
  const cap = criarLoggerCapturado();

  const res = await executarHomologacaoIndices(cliente, { aplicar: true, logger: cap.logger });

  assert.equal(res.ok, false);
  assert.notEqual(res.codigoSaida, 0);
  assert.equal(res.motivo, 'indice_invalido_ou_nao_pronto');
  assert.equal(res.indiceProblema, 'perf_produtos_sku_trgm');
  assert.match(cap.textoCompleto(), /public\.perf_produtos_sku_trgm/);
  assert.match(cap.textoCompleto(), /indisvalid=false/);
  assert.match(cap.textoCompleto(), /DROP INDEX CONCURRENTLY public\.perf_produtos_sku_trgm;/);
  assert.doesNotMatch(cap.textoCompleto(), /Homologação concluída/);
  assert.ok(!cliente.queriesExecutadas.some((q) => q.sql.startsWith('CREATE INDEX')));
  afirmarZeroDropEZeroTransacao(cliente.queriesExecutadas);
});

test('Caso 4 — Índice existente NÃO PRONTO (indisready=false): interrompe em dry-run e em --apply sem auto-DROP', async () => {
  for (const aplicar of [false, true]) {
    const cliente = criarClienteMock({
      estadoInicial: {
        perf_clientes_nome_trgm: { existe: true, indisvalid: true, indisready: false },
      },
    });
    const cap = criarLoggerCapturado();

    const res = await executarHomologacaoIndices(cliente, { aplicar, logger: cap.logger });

    assert.equal(res.ok, false);
    assert.equal(res.codigoSaida, 1);
    assert.equal(res.indiceProblema, 'perf_clientes_nome_trgm');
    assert.match(cap.textoCompleto(), /public\.perf_clientes_nome_trgm/);
    assert.match(cap.textoCompleto(), /indisready=false/);
    assert.match(cap.textoCompleto(), /Instrução de recuperação manual/);
    assert.doesNotMatch(cap.textoCompleto(), /Homologação concluída/);
    afirmarZeroDropEZeroTransacao(cliente.queriesExecutadas);
  }
});

test('Caso 5 — Criação --apply e revalidação final dos 5 índices: cria CONCURRENTLY e confirma todos válidos e prontos', async () => {
  const cliente = criarClienteMock({ pgTrgmInstalada: false });
  const cap = criarLoggerCapturado();

  const res = await executarHomologacaoIndices(cliente, { aplicar: true, logger: cap.logger });

  assert.equal(res.ok, true);
  assert.equal(res.codigoSaida, 0);
  assert.equal(res.criados, 5);
  assert.equal(res.indices.length, 5);
  for (const est of res.indices) {
    assert.equal(est.esquema, 'public');
    assert.equal(est.existe, true);
    assert.equal(est.indisvalid, true);
    assert.equal(est.indisready, true);
  }
  const creates = cliente.queriesExecutadas.filter((q) => q.sql.startsWith('CREATE INDEX CONCURRENTLY'));
  assert.equal(creates.length, 5);
  afirmarZeroDropEZeroTransacao(cliente.queriesExecutadas);
});

test('Caso 6 — Falha pós-criação ou na revalidação final: nunca declara sucesso se algum índice ficar inválido', async () => {
  // 6a: CREATE INDEX CONCURRENTLY deixa o índice inválido imediatamente
  const clienteFalhaImediata = criarClienteMock({
    estadoPosCriacao: {
      perf_fornecedores_nome_trgm: { existe: true, indisvalid: false, indisready: false },
    },
  });
  const cap1 = criarLoggerCapturado();
  const r1 = await executarHomologacaoIndices(clienteFalhaImediata, { aplicar: true, logger: cap1.logger });
  assert.equal(r1.ok, false);
  assert.equal(r1.codigoSaida, 1);
  assert.equal(r1.motivo, 'indice_invalido_apos_criacao');
  assert.equal(r1.indiceProblema, 'perf_fornecedores_nome_trgm');
  assert.doesNotMatch(cap1.textoCompleto(), /Homologação concluída/);
  afirmarZeroDropEZeroTransacao(clienteFalhaImediata.queriesExecutadas);

  // 6b: índice fica inválido na 2ª passagem de validação final dos 5 índices
  const estadoInicial = Object.fromEntries(
    INDICES.map((d: { nome: string; tabela: string }) => [
      d.nome,
      { existe: true, tabela_real: d.tabela, indisvalid: true, indisready: true },
    ])
  );
  const clienteFalhaFinal = criarClienteMock({
    estadoInicial,
    degradarNaSegundaPassagem: {
      perf_produtos_codigo_barras_trgm: { indisvalid: false },
    },
  });
  const cap2 = criarLoggerCapturado();
  const r2 = await executarHomologacaoIndices(clienteFalhaFinal, { aplicar: true, logger: cap2.logger });
  assert.equal(r2.ok, false);
  assert.equal(r2.codigoSaida, 1);
  assert.equal(r2.motivo, 'validacao_final_indice_invalido');
  assert.equal(r2.indiceProblema, 'perf_produtos_codigo_barras_trgm');
  assert.doesNotMatch(cap2.textoCompleto(), /Homologação concluída/);
  afirmarZeroDropEZeroTransacao(clienteFalhaFinal.queriesExecutadas);
});

test('consultarEstadoIndice detecta índice associado a tabela divergente', async () => {
  const cliente = criarClienteMock({
    estadoInicial: {
      perf_produtos_nome_trgm: {
        existe: true,
        tabela_real: 'clientes',
        indisvalid: true,
        indisready: true,
      },
    },
  });
  const estado = await consultarEstadoIndice(cliente, INDICES[0], 'public');
  assert.equal(estado.existe, true);
  assert.equal(estado.tabela_correta, false);
});

test('Caso 7 — CLI exige PERF_DB_URL explicitamente e NUNCA usa DATABASE_URL como fallback', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_INDICES], {
    cwd: RAIZ_REPO,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://usuario:segredo@127.0.0.1:5432/nao_deve_usar',
      PERF_DB_URL: '',
    },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /PERF_DB_URL/);
  assert.doesNotMatch(proc.stderr, /segredo/);
  assert.doesNotMatch(proc.stdout, /segredo/);
});
