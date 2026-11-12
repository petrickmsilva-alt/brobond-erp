#!/usr/bin/env node
// ============================================================================
// DIAGNÓSTICO DE LATÊNCIA POR ROTA — Brobond ERP/Commerce
//
// Mede, contra uma instância REAL da aplicação (local, Render ou VPS):
//   • tempo total HTTP por rota → P50 / P95 / P99 / máx;
//   • as FASES informadas pelo servidor no cabeçalho `Server-Timing`
//     (app, db, pool, externo) — separa "banco lento" de "rede/API lenta";
//   • bytes transferidos e se a resposta veio comprimida;
//   • a PRIMEIRA requisição (cold start) separada das demais;
//   • chamadas repetidas ao mesmo recurso (baseline de payload).
//
// ESCOPO SOMENTE LEITURA × EFEITOS DE AUTENTICAÇÃO (ler antes de executar):
//   • Rotas comerciais/operacionais medidas: ESTRITAMENTE GET (somente leitura).
//     Qualquer rota customizada com método diferente de GET ou com corpo é
//     recusada antes de executar. Nenhum produto, estoque, pedido, venda,
//     cliente ou lançamento financeiro é criado, editado ou excluído.
//   • Autenticação: quando `PERF_EMAIL` e `PERF_SENHA` (e `PERF_TOTP_SECRET`
//     para contas com MFA/TOTP ativo) são fornecidos, o login executa
//     `POST /api/auth/login` e, se exigido pelo segundo fator, os endpoints de
//     MFA (`/api/auth/mfa/desafio` / `/api/auth/login/mfa`), podendo produzir
//     efeitos operacionais de autenticação (criação de sessão, registro na
//     trilha de auditoria de acesso e estado de desafio MFA).
//   • Conta: utilize EXCLUSIVAMENTE conta técnica autorizada para diagnóstico;
//     nunca utilize conta pessoal de usuário real sem autorização explícita.
//   • Privacidade: senha, e-mail, token JWT, segredo TOTP e cookies nunca são
//     impressos no console nem salvos nos artefatos JSON ou Markdown.
//
// Uso:
//   PERF_EMAIL=... PERF_SENHA=... PERF_TOTP_SECRET=... node scripts/perf/diagnostico.mjs \
//     [--base https://brobond-erp.onrender.com] [--iteracoes 20] [--concorrencia 1] \
//     [--rotas arquivo.json] [--saida relatorio.json] [--markdown tabela.md]
// ============================================================================
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { autenticar as autenticarComMfa } from './_auth.mjs';

export const AVISO_ESCOPO_AUTENTICACAO =
  'A medição das rotas comerciais e operacionais executa exclusivamente requisições GET (somente leitura: ' +
  'nenhum registro comercial, fiscal, financeiro ou de estoque é criado, editado ou excluído). ' +
  'Quando executado com credenciais técnicas, o fluxo de autenticação (POST /api/auth/login e, quando exigido, ' +
  'desafio MFA/TOTP) pode gerar efeitos operacionais de sessão, auditoria de acesso e estado temporário de MFA.';

// Rotas representativas do ciclo comercial — todas estritamente GET (somente leitura).
export const ROTAS_PADRAO = Object.freeze([
  Object.freeze({ nome: 'health (sem auth)', caminho: '/api/health', auth: false }),
  Object.freeze({ nome: 'health/db (sem auth)', caminho: '/api/health/db', auth: false }),
  Object.freeze({ nome: 'auth/me', caminho: '/api/auth/me' }),
  Object.freeze({ nome: 'meta (metadados dos módulos)', caminho: '/api/meta' }),
  Object.freeze({ nome: 'produtos (lista 25)', caminho: '/api/produtos?page=1&pageSize=25' }),
  Object.freeze({ nome: 'produtos (busca por texto)', caminho: '/api/produtos?page=1&pageSize=25&q=CAMISA' }),
  Object.freeze({ nome: 'produtos (options — selects)', caminho: '/api/produtos/options' }),
  Object.freeze({ nome: 'grade de estoque', caminho: '/api/estoques/grade?produto_id=1' }),
  Object.freeze({ nome: 'movimentações (lista 25)', caminho: '/api/movimentacoes?page=1&pageSize=25' }),
  Object.freeze({ nome: 'vendas (lista 25)', caminho: '/api/vendas?page=1&pageSize=25' }),
  Object.freeze({ nome: 'clientes (lista 25)', caminho: '/api/clientes?page=1&pageSize=25' }),
  Object.freeze({ nome: 'dashboard', caminho: '/api/dashboard' }),
  Object.freeze({ nome: 'busca de SKU (produtos/busca)', caminho: '/api/produtos/busca?q=CAM&pageSize=20' }),
]);

/**
 * Garante que todas as rotas declaradas para o diagnóstico sejam estritamente
 * GET e sem payload de escrita.
 */
export function validarRotasSomenteLeitura(rotas) {
  if (!Array.isArray(rotas) || rotas.length === 0) {
    throw new Error('A lista de rotas do diagnóstico deve ser um array não vazio.');
  }
  for (const r of rotas) {
    if (!r || typeof r !== 'object') {
      throw new Error('Rota inválida no diagnóstico.');
    }
    const metodo = String(r.metodo ?? r.method ?? 'GET').trim().toUpperCase();
    if (metodo !== 'GET') {
      throw new Error(
        `Rota "${r.nome || r.caminho || '(sem nome)'}" recusada: o diagnóstico aceita exclusivamente método GET (recebido: ${metodo}).`
      );
    }
    if (r.corpo !== undefined || r.body !== undefined) {
      throw new Error(
        `Rota "${r.nome || r.caminho || '(sem nome)'}" recusada: o diagnóstico somente leitura não permite corpo de requisição.`
      );
    }
    const caminho = String(r.caminho || '');
    if (!caminho.startsWith('/')) {
      throw new Error(
        `Rota "${r.nome || caminho || '(sem nome)'}" recusada: caminho deve iniciar com "/".`
      );
    }
  }
  return rotas;
}

export function percentil(valores, p) {
  if (!valores.length) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  const idx = Math.min(ordenado.length - 1, Math.max(0, Math.ceil((p / 100) * ordenado.length) - 1));
  return Math.round(ordenado[idx] * 100) / 100;
}

/** Extrai as fases de `Server-Timing: app;dur=12, db;dur=8;desc="3 consultas"`. */
export function lerServerTiming(valor) {
  const fases = {};
  if (!valor) return fases;
  for (const parte of valor.split(',')) {
    const m = /^\s*([a-zA-Z0-9_-]+)\s*;\s*dur\s*=\s*([\d.]+)/.exec(parte);
    if (m) fases[m[1]] = Number(m[2]);
  }
  return fases;
}

async function requisitarGet(base, caminho, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const inicio = performance.now();
  try {
    const res = await fetch(`${base}${caminho}`, {
      method: 'GET',
      headers,
      credentials: 'omit',
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer();
    return {
      ok: res.ok,
      status: res.status,
      ms: performance.now() - inicio,
      bytes: buf.byteLength,
      comprimido: Boolean(res.headers.get('content-encoding')),
      contentEncoding: res.headers.get('content-encoding') || null,
      fases: lerServerTiming(res.headers.get('server-timing')),
      requestId: res.headers.get('x-request-id') || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Executa N iterações GET com concorrência fixa; devolve apenas métricas agregadas (sem corpo/credenciais). */
async function medirRota(base, rota, token, { iteracoes, concorrencia, timeoutMs }) {
  const amostras = [];
  const erros = [];
  const codigosHttp = new Set();
  let proxima = 0;

  const usarToken = rota.auth === false ? null : token;
  const fria = await requisitarGet(base, rota.caminho, usarToken, timeoutMs);
  codigosHttp.add(fria.status);

  const executar = async () => {
    while (proxima < iteracoes) {
      proxima++;
      const r = await requisitarGet(base, rota.caminho, usarToken, timeoutMs);
      codigosHttp.add(r.status);
      if (!r.ok) erros.push(r.status);
      amostras.push(r);
    }
  };

  await Promise.all(Array.from({ length: concorrencia }, () => executar()));
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
    metodo: 'GET',
    requisicoes: amostras.length,
    codigos_http: [...codigosHttp].sort((a, b) => a - b),
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
    content_encoding: ultima ? ultima.contentEncoding : null,
    request_id_exemplo: ultima ? ultima.requestId : null,
  };
}

export function tabelaMarkdown(resultados, meta) {
  const medidas = resultados.filter((r) => !r.ignorada);
  const naoMedidas = resultados.filter((r) => r.ignorada);
  const linhas = [
    `| Rota | 1ª (cold) | P50 | P95 | P99 | Máx | Servidor P50 (app/db/externo) | Bytes | gzip | HTTP | Erros |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of medidas) {
    const codigos = Array.isArray(r.codigos_http) && r.codigos_http.length ? r.codigos_http.join(',') : '—';
    linhas.push(
      `| ${r.rota} | ${r.primeira_ms ?? '—'} ms | ${r.p50_ms} | ${r.p95_ms} | ${r.p99_ms} | ${r.max_ms} | ` +
        `${r.servidor_app_p50_ms} / ${r.servidor_db_p50_ms} / ${r.servidor_externo_p50_ms} ms | ` +
        `${r.bytes} | ${r.comprimido ? 'sim' : 'não'} | ${codigos} | ${r.erros} |`
    );
  }
  const secoes = [
    `# Diagnóstico de latência — ${meta.base}`,
    '',
    `Gerado em ${meta.gerado_em} • ${meta.iteracoes} iterações por rota (concorrência ${meta.concorrencia}).`,
    '',
    `> **Escopo e efeitos operacionais:** ${AVISO_ESCOPO_AUTENTICACAO}`,
    `>Modo desta execução: ${meta.escopo?.modo_autenticacao ?? 'somente rotas públicas'} (credenciais e tokens nunca são registrados neste relatório).`,
    '',
    ...linhas,
  ];
  if (naoMedidas.length > 0) {
    secoes.push(
      '',
      '## Rotas autenticadas não medidas nesta execução',
      '',
      ...naoMedidas.map((r) => `- \`GET ${r.caminho}\` (${r.rota}) — motivo: ${r.ignorada}`)
    );
  }
  secoes.push(
    '',
    '**Como ler:** `1ª (cold)` é a primeira chamada do processo — em plano com suspensão por',
    'inatividade ela inclui acordar a instância e o banco. `P50/P95/P99` são as chamadas seguintes.',
    'A coluna *Servidor* vem do cabeçalho `Server-Timing` da própria API: se `app` é próximo do',
    'total HTTP, o tempo é do servidor; se o total é muito maior que `app`, o custo está na rede',
    'ou no frontend.'
  );
  return secoes.join('\n');
}

export async function executarDiagnostico({
  base,
  iteracoes = 15,
  concorrencia = 1,
  timeoutMs = 60_000,
  rotas = ROTAS_PADRAO,
  credenciais = {},
  logger = console,
} = {}) {
  const baseLimpa = String(base || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const rotasValidadas = validarRotasSomenteLeitura(rotas);

  let infoAuth = { token: null, publico: true, mfa: false, efeitosOperacionais: [] };
  if (credenciais.email && credenciais.senha) {
    infoAuth = await autenticarComMfa(baseLimpa, {
      email: credenciais.email,
      senha: credenciais.senha,
      totpSegredo: credenciais.totpSegredo || '',
    });
    if (!infoAuth.token) throw new Error('login não devolveu token');
    logger.log(
      `✅ Autenticado com conta técnica autorizada${infoAuth.mfa ? ' (MFA/TOTP verificado)' : ''} — credenciais e token omitidos.`
    );
  } else {
    logger.error('⚠️  PERF_EMAIL/PERF_SENHA não definidos: medindo apenas rotas públicas (zero sessão criada).');
  }

  const resultados = [];
  const naoMedidas = [];
  for (const rota of rotasValidadas) {
    if (rota.auth !== false && !infoAuth.token) {
      naoMedidas.push(rota.caminho);
      resultados.push({
        rota: rota.nome,
        caminho: rota.caminho,
        metodo: 'GET',
        ignorada: 'sem autenticação (credenciais técnicas ausentes)',
        requisicoes: 0,
        codigos_http: [],
        erros: 0,
        status_erro: [],
        p50_ms: 0,
        p95_ms: 0,
        p99_ms: 0,
        max_ms: 0,
        media_ms: 0,
        primeira_ms: null,
        servidor_app_p50_ms: 0,
        servidor_db_p50_ms: 0,
        servidor_pool_p50_ms: 0,
        servidor_externo_p50_ms: 0,
        bytes: 0,
        comprimido: false,
        content_encoding: null,
      });
      continue;
    }
    const r = await medirRota(baseLimpa, rota, infoAuth.token, {
      iteracoes,
      concorrencia: Math.max(1, concorrencia),
      timeoutMs,
    });
    logger.log(`  • ${rota.nome}: P50 ${r.p50_ms}ms · P95 ${r.p95_ms}ms${r.erros ? ` · ${r.erros} erro(s)` : ''}`);
    resultados.push(r);
  }

  return {
    base: baseLimpa,
    gerado_em: new Date().toISOString(),
    iteracoes,
    concorrencia: Math.max(1, concorrencia),
    escopo: {
      rotas_comerciais_somente_leitura: true,
      metodo_exclusivo_rotas: 'GET',
      autenticado: Boolean(infoAuth.token),
      mfa_utilizado: Boolean(infoAuth.mfa),
      modo_autenticacao: infoAuth.token
        ? infoAuth.mfa
          ? 'conta_tecnica_com_mfa_totp'
          : 'conta_tecnica_sem_mfa'
        : 'somente_rotas_publicas',
      efeitos_operacionais_autenticacao: infoAuth.efeitosOperacionais ?? [],
      aviso: AVISO_ESCOPO_AUTENTICACAO,
    },
    rotas_nao_medidas: naoMedidas,
    rotas: resultados,
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
  const TOTP = process.env.PERF_TOTP_SECRET || '';
  const SAIDA = arg('saida', '');
  const MARKDOWN = arg('markdown', '');
  const ROTAS_ARQ = arg('rotas', '');

  (async () => {
    console.log(`🔎 Diagnóstico de latência em ${BASE}`);
    let rotas = ROTAS_PADRAO;
    if (ROTAS_ARQ) {
      const { readFileSync } = await import('node:fs');
      rotas = JSON.parse(readFileSync(ROTAS_ARQ, 'utf8'));
    }
    validarRotasSomenteLeitura(rotas);

    let relatorio;
    try {
      relatorio = await executarDiagnostico({
        base: BASE,
        iteracoes: ITERACOES,
        concorrencia: CONCORRENCIA,
        timeoutMs: TIMEOUT_MS,
        rotas,
        credenciais: { email: EMAIL, senha: SENHA, totpSegredo: TOTP },
      });
    } catch (e) {
      console.error(`❌ ${e?.message || e}`);
      process.exit(2);
    }

    if (SAIDA) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(SAIDA, JSON.stringify(relatorio, null, 2));
      console.log(`💾 JSON salvo em ${SAIDA}`);
    }
    if (MARKDOWN) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(MARKDOWN, tabelaMarkdown(relatorio.rotas, relatorio));
      console.log(`📄 Markdown salvo em ${MARKDOWN}`);
    }
    if (!SAIDA && !MARKDOWN) console.log(JSON.stringify(relatorio, null, 2));
  })().catch((e) => {
    console.error('❌ Falha no diagnóstico:', e?.message || e);
    process.exit(1);
  });
}
