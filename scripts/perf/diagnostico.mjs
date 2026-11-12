#!/usr/bin/env node
// ============================================================================
// DIAGNÓSTICO DE LATÊNCIA POR ROTA — Brobond ERP/Commerce
//
// Mede, contra uma instância REAL da aplicação (local, Render ou VPS):
//   • tempo total HTTP por rota → P50 / P95 / P99 / máx;
//   • as FASES informadas pelo servidor no cabeçalho `Server-Timing`
//     (app, db, pool, externo) — separa "banco lento" de "rede/API lenta";
//   • bytes transferidos e se a resposta veio comprimida;
//   • a PRIMEIRA requisição (cold start) separada das demais — num plano com
//     suspensão por inatividade, ela é ordens de grandeza maior e contamina a
//     média se misturada;
//   • chamadas repetidas ao mesmo recurso (baseline de payload).
//
// Uso:
//   PERF_EMAIL=... PERF_SENHA=... node scripts/perf/diagnostico.mjs \
//     [--base https://brobond-erp.onrender.com] [--iteracoes 15] [--concorrencia 1] \
//     [--rotas arquivo.json] [--saida relatorio.json] [--markdown tabela.md]
//
// A conta usada deve ser de TESTE/observação e NÃO ter MFA (o script não
// automatiza TOTP). Nenhuma senha ou token é impresso no relatório.
// ============================================================================
import { performance } from 'node:perf_hooks';
import { autenticar as autenticarComMfa } from './_auth.mjs';

const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const BASE = String(arg('base', process.env.PERF_BASE || 'http://127.0.0.1:3001')).replace(/\/$/, '');
const ITERACOES = Number(arg('iteracoes', 15));
const CONCORRENCIA = Math.max(1, Number(arg('concorrencia', 1)));
const TIMEOUT_MS = Number(arg('timeout', 60_000));
const EMAIL = process.env.PERF_EMAIL || '';
const SENHA = process.env.PERF_SENHA || '';
const SAIDA = arg('saida', '');
const MARKDOWN = arg('markdown', '');
const ROTAS_ARQ = arg('rotas', '');

// Rotas representativas do ciclo comercial. Todas são SOMENTE LEITURA: o
// diagnóstico nunca cria, edita ou exclui nada — não gera dado em produção.
// Caminhos sem `id` explícito dependem de registros existentes; quando o id é
// necessário, o script tenta descobri-lo pela própria listagem.
const ROTAS_PADRAO = [
  { nome: 'health (sem auth)', caminho: '/api/health', auth: false },
  { nome: 'auth/me', caminho: '/api/auth/me' },
  { nome: 'meta (metadados dos módulos)', caminho: '/api/meta' },
  { nome: 'produtos (lista 25)', caminho: '/api/produtos?page=1&pageSize=25' },
  { nome: 'produtos (busca por texto)', caminho: '/api/produtos?page=1&pageSize=25&q=CAMISA' },
  { nome: 'produtos (options — selects)', caminho: '/api/produtos/options' },
  { nome: 'grade de estoque', caminho: '/api/estoques/grade?produto_id=1' },
  { nome: 'movimentações (lista 25)', caminho: '/api/movimentacoes?page=1&pageSize=25' },
  { nome: 'vendas (lista 25)', caminho: '/api/vendas?page=1&pageSize=25' },
  { nome: 'clientes (lista 25)', caminho: '/api/clientes?page=1&pageSize=25' },
  { nome: 'dashboard', caminho: '/api/dashboard' },
  { nome: 'busca de SKU (produtos/busca)', caminho: '/api/produtos/busca?q=CAM&pageSize=20' },
];

function percentil(valores, p) {
  if (!valores.length) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  const idx = Math.min(ordenado.length - 1, Math.max(0, Math.ceil((p / 100) * ordenado.length) - 1));
  return Math.round(ordenado[idx] * 100) / 100;
}

/** Extrai as fases de `Server-Timing: app;dur=12, db;dur=8;desc="3 consultas"`. */
function lerServerTiming(valor) {
  const fases = {};
  if (!valor) return fases;
  for (const parte of valor.split(',')) {
    const m = /^\s*([a-zA-Z0-9_-]+)\s*;\s*dur\s*=\s*([\d.]+)/.exec(parte);
    if (m) fases[m[1]] = Number(m[2]);
  }
  return fases;
}

async function requisitar(caminho, token, { metodo = 'GET', corpo } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (corpo) headers['Content-Type'] = 'application/json';
  const inicio = performance.now();
  try {
    const res = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controller.signal,
    });
    const texto = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: performance.now() - inicio,
      bytes: Buffer.byteLength(texto),
      comprimido: Boolean(res.headers.get('content-encoding')),
      fases: lerServerTiming(res.headers.get('server-timing')),
      requestId: res.headers.get('x-request-id') || null,
      texto,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function autenticar() {
  if (!EMAIL || !SENHA) {
    console.error('⚠️  PERF_EMAIL/PERF_SENHA não definidos: medindo apenas rotas públicas.');
    return null;
  }
  try {
    // Suporta MFA: se o segundo fator já está ativo, informe PERF_TOTP_SECRET.
    // O segredo nunca é impresso.
    const { token, mfa } = await autenticarComMfa(BASE, {
      email: EMAIL,
      senha: SENHA,
      totpSegredo: process.env.PERF_TOTP_SECRET || '',
    });
    if (!token) throw new Error('login não devolveu token');
    console.log(`✅ Autenticado como ${EMAIL}${mfa ? ' (MFA)' : ''} — token não é exibido.`);
    return token;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
}

/** Executa N iterações com concorrência fixa; devolve amostras por rota. */
async function medirRota(rota, token) {
  const amostras = [];
  const erros = [];
  let proxima = 0;
  const executar = async (primeira) => {
    if (primeira) {
      // A PRIMEIRA chamada é medida isolada: é ela que carrega o cold start.
      const r = await requisitar(rota.caminho, rota.auth === false ? null : token);
      return { ...r, primeira: true };
    }
    while (proxima < ITERACOES) {
      proxima++;
      const r = await requisitar(rota.caminho, rota.auth === false ? null : token);
      if (!r.ok) erros.push(r.status);
      amostras.push(r);
    }
    return null;
  };
  const fria = await executar(true);
  await Promise.all(Array.from({ length: CONCORRENCIA }, () => (token || rota.auth === false ? executar(false) : null)));
  const temps = amostras.map((a) => a.ms);
  const fasesTotais = { app: [], db: [], pool: [], externo: [] };
  for (const a of amostras) {
    for (const [k, v] of Object.entries(a.fases)) {
      if (fasesTotais[k]) fasesTotais[k].push(v);
    }
  }
  const ultima = amostras[amostras.length - 1] || fria;
  return {
    rota: rota.nome,
    caminho: rota.caminho,
    requisicoes: amostras.length,
    erros: erros.length,
    status_erro: [...new Set(erros)],
    primeira_ms: fria ? Math.round(fria.ms) : null,
    p50_ms: percentil(temps, 50),
    p95_ms: percentil(temps, 95),
    p99_ms: percentil(temps, 99),
    max_ms: percentil(temps, 100),
    media_ms: Math.round((temps.reduce((a, b) => a + b, 0) / Math.max(1, temps.length)) * 100) / 100,
    servidor_app_p50_ms: percentil(fasesTotais.app, 50),
    servidor_db_p50_ms: percentil(fasesTotais.db, 50),
    servidor_pool_p50_ms: percentil(fasesTotais.pool, 50),
    servidor_externo_p50_ms: percentil(fasesTotais.externo, 50),
    bytes: ultima ? ultima.bytes : 0,
    comprimido: ultima ? ultima.comprimido : false,
    request_id_exemplo: ultima ? ultima.requestId : null,
  };
}

function tabelaMarkdown(resultados, meta) {
  const linhas = [
    `| Rota | 1ª (cold) | P50 | P95 | P99 | Máx | Servidor P50 (app/db/externo) | Bytes | gzip | Erros |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of resultados) {
    linhas.push(
      `| ${r.rota} | ${r.primeira_ms ?? '—'} ms | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} | ${r.max_ms} | ` +
        `${r.servidor_app_p50_ms} / ${r.servidor_db_p50_ms} / ${r.servidor_externo_p50_ms} ms | ` +
        `${r.bytes} | ${r.comprimido ? 'sim' : 'não'} | ${r.erros} |`
    );
  }
  return [
    `# Diagnóstico de latência — ${meta.base}`,
    '',
    `Gerado em ${meta.gerado_em} • ${meta.iteracoes} iterações por rota (concorrência ${meta.concorrencia}).`,
    'Todas as rotas são somente leitura; nenhum dado foi criado ou alterado.',
    '',
    ...linhas,
    '',
    '**Como ler:** `1ª (cold)` é a primeira chamada do processo — em plano com suspensão por',
    'inatividade ela inclui acordar a instância e o banco. `P50/P95/P99` são as chamadas seguintes.',
    'A coluna *Servidor* vem do cabeçalho `Server-Timing` da própria API: se `app` é próximo do',
    'total HTTP, o tempo é do servidor; se o total é muito maior que `app`, o custo está na rede',
    'ou no frontend.',
  ].join('\n');
}

async function main() {
  console.log(`🔎 Diagnóstico de latência em ${BASE}`);
  const token = await autenticar();
  let rotas = ROTAS_PADRAO;
  if (ROTAS_ARQ) {
    const { readFileSync } = await import('node:fs');
    rotas = JSON.parse(readFileSync(ROTAS_ARQ, 'utf8'));
  }
  const resultados = [];
  for (const rota of rotas) {
    if (rota.auth !== false && !token) {
      resultados.push({ rota: rota.nome, caminho: rota.caminho, ignorada: 'sem autenticação', requisicoes: 0, erros: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0, media_ms: 0, primeira_ms: null, servidor_app_p50_ms: 0, servidor_db_p50_ms: 0, servidor_pool_p50_ms: 0, servidor_externo_p50_ms: 0, bytes: 0, comprimido: false });
      continue;
    }
    process.stdout.write(`  • ${rota.nome} … `);
    const r = await medirRota(rota, token);
    console.log(`P50 ${r.p50_ms}ms · P95 ${r.p95_ms}ms${r.erros ? ` · ${r.erros} erro(s)` : ''}`);
    resultados.push(r);
  }

  const relatorio = {
    base: BASE,
    gerado_em: new Date().toISOString(),
    iteracoes: ITERACOES,
    concorrencia: CONCORRENCIA,
    rotas: resultados,
  };
  if (SAIDA) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SAIDA, JSON.stringify(relatorio, null, 2));
    console.log(`💾 JSON salvo em ${SAIDA}`);
  }
  if (MARKDOWN) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(MARKDOWN, tabelaMarkdown(resultados, relatorio));
    console.log(`📄 Markdown salvo em ${MARKDOWN}`);
  }
  if (!SAIDA && !MARKDOWN) console.log(JSON.stringify(relatorio, null, 2));
}

main().catch((e) => {
  console.error('❌ Falha no diagnóstico:', e?.message || e);
  process.exit(1);
});
