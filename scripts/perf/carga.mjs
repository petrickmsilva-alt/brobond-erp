#!/usr/bin/env node
// ============================================================================
// TESTE DE CARGA PROGRESSIVO — Brobond ERP/Commerce
//
// Estágios crescentes de usuários simultâneos com uma MISTURA de operações
// representativas (login, consulta de produtos, busca de SKU, estoque,
// listagens, dashboard). Mede, por estágio:
//   • requisições por segundo (throughput) e tempo total;
//   • P50 / P95 / P99 e máximo por operação;
//   • taxa de erro por status (4xx e 5xx separados);
//   • o que o SERVIDOR relata: lag do event loop, CPU, memória, pool e as
//     rotas mais lentas (lido de /api/admin/metrics antes/depois do estágio).
//
// Uso:
//   PERF_EMAIL=... PERF_SENHA=... node scripts/perf/carga.mjs \
//     [--base https://brobond-erp.onrender.com] [--estagios 1,5,10,25] \
//     [--duracao 20] [--rotas arquivo.json] [--saida resultado.json]
//
// REGRAS DE SEGURANÇA
//   • Somente operações de LEITURA por padrão. Escrita só entra se o arquivo de
//     rotas declarar `{ "metodo": "POST", ... }` explicitamente.
//   • NÃO rode contra produção: use um ambiente com banco de teste (é o que
//     garante "não gerar dados de teste no banco de produção").
//   • A senha só é usada no login; nunca é impressa.
// ============================================================================
import { performance } from 'node:perf_hooks';
import { autenticar as autenticarComMfa } from './_auth.mjs';

const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const BASE = String(arg('base', process.env.PERF_BASE || 'http://127.0.0.1:3001')).replace(/\/$/, '');
const DURACAO_S = Math.max(5, Number(arg('duracao', 20)));
const ESTAGIOS = String(arg('estagios', '1,5,10,25')).split(',').map((n) => Math.max(1, Number(n)));
const SAIDA = arg('saida', '');
const ROTAS_ARQ = arg('rotas', '');
const PAUSA_S = Number(arg('pausa', 3));
const EMAIL = process.env.PERF_EMAIL || '';
const SENHA = process.env.PERF_SENHA || '';

// Mistura de operações: pesos refletem o uso real do ERP (muita consulta,
// pouca escrita). Todas somente leitura por padrão.
const ROTAS_PADRAO = [
  { nome: 'produtos lista', caminho: '/api/produtos?page=1&pageSize=25', peso: 30 },
  { nome: 'produtos busca', caminho: '/api/produtos?page=1&pageSize=25&q=CAM', peso: 20 },
  { nome: 'busca SKU', caminho: '/api/produtos/busca?q=CAM&pageSize=20', peso: 15 },
  { nome: 'estoque grade', caminho: '/api/estoques/grade?produto_id=1', peso: 10 },
  { nome: 'movimentacoes', caminho: '/api/movimentacoes?page=1&pageSize=25', peso: 10 },
  { nome: 'dashboard', caminho: '/api/dashboard', peso: 8 },
  { nome: 'options', caminho: '/api/produtos/options', peso: 5 },
  { nome: 'meta', caminho: '/api/meta', peso: 2 },
];

function percentil(valores, p) {
  if (!valores.length) return 0;
  const o = [...valores].sort((a, b) => a - b);
  const i = Math.min(o.length - 1, Math.max(0, Math.ceil((p / 100) * o.length) - 1));
  return Math.round(o[i] * 100) / 100;
}

function sortear(rotas) {
  const total = rotas.reduce((a, r) => a + (r.peso ?? 1), 0);
  let n = Math.random() * total;
  for (const r of rotas) {
    n -= r.peso ?? 1;
    if (n <= 0) return r;
  }
  return rotas[rotas.length - 1];
}

async function chamar(rota, token) {
  const inicio = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${BASE}${rota.caminho}`, {
      method: rota.metodo || 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rota.corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: rota.corpo ? JSON.stringify(rota.corpo) : undefined,
      // `fetch` do Node mantém keep-alive por padrão: mede-se a aplicação, não
      // o handshake TCP de cada requisição.
      signal: controller.signal,
    });
    await res.arrayBuffer();
    return { ms: performance.now() - inicio, status: res.status, erro: !res.ok };
  } catch (e) {
    return { ms: performance.now() - inicio, status: 0, erro: true, abortado: e?.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  if (!EMAIL || !SENHA) return null;
  try {
    const { token } = await autenticarComMfa(BASE, {
      email: EMAIL,
      senha: SENHA,
      totpSegredo: process.env.PERF_TOTP_SECRET || '',
    });
    return token;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
}

/** Lê o estado do servidor para correlacionar carga × recurso. */
async function estadoServidor(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${BASE}/api/admin/metrics`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const s = await res.json();
    return {
      cpu_pct: s?.processo?.cpu_pct ?? null,
      rss_mb: s?.processo?.rss_mb ?? null,
      lag_p99_ms: s?.processo?.event_loop_lag_p99_ms ?? null,
      em_voo_pico: s?.processo?.requisicoes_em_voo_pico ?? null,
      pool: s?.banco?.pool ?? null,
      espera_pool_p95_ms: s?.banco?.espera_pool?.p95_ms ?? null,
      db_p95_ms: s?.banco?.global?.p95_ms ?? null,
      rotas_mais_lentas: Object.entries(s?.http ?? {})
        .map(([rota, v]) => ({ rota, p95: v.p95_ms, total: v.total, erros: v.erros }))
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, 5),
    };
  } catch {
    return null;
  }
}

async function executarEstagio(concorrencia, rotas, token, antes) {
  const amostras = [];
  const porRota = new Map();
  const erros = {};
  const inicio = performance.now();
  const fim = inicio + DURACAO_S * 1000;
  let total = 0;

  async function trabalhador() {
    while (performance.now() < fim) {
      const rota = sortear(rotas);
      const r = await chamar(rota, token);
      total++;
      if (r.erro) erros[r.status || 'rede'] = (erros[r.status || 'rede'] ?? 0) + 1;
      amostras.push(r.ms);
      const lista = porRota.get(rota.nome) ?? [];
      lista.push(r.ms);
      porRota.set(rota.nome, lista);
    }
  }

  await Promise.all(Array.from({ length: concorrencia }, trabalhador));
  const decorrido = (performance.now() - inicio) / 1000;
  const depois = await estadoServidor(token);
  const ordenado = [...amostras].sort((a, b) => a - b);

  return {
    concorrencia,
    duracao_s: Math.round(decorrido * 10) / 10,
    requisicoes: total,
    rps: Math.round((total / decorrido) * 100) / 100,
    erros_total: Object.values(erros).reduce((a, b) => a + b, 0),
    erros_por_status: erros,
    p50_ms: percentil(ordenado, 50),
    p95_ms: percentil(ordenado, 95),
    p99_ms: percentil(ordenado, 99),
    max_ms: percentil(ordenado, 100),
    por_rota: Object.fromEntries(
      [...porRota].map(([nome, v]) => [nome, { n: v.length, p50: percentil(v, 50), p95: percentil(v, 95), p99: percentil(v, 99) }])
    ),
    servidor_antes: antes,
    servidor_depois: depois,
  };
}

async function main() {
  console.log(`🚦 Teste de carga — ${BASE}`);
  console.log(`   estágios: ${ESTAGIOS.join(', ')} usuários simultâneos · ${DURACAO_S}s por estágio`);
  const token = await login();
  if (!token) console.error('⚠️  Sem credenciais: apenas rotas públicas serão testadas.');
  let rotas = ROTAS_PADRAO;
  if (ROTAS_ARQ) {
    const { readFileSync } = await import('node:fs');
    rotas = JSON.parse(readFileSync(ROTAS_ARQ, 'utf8'));
  }
  const escritas = rotas.filter((r) => (r.metodo || 'GET') !== 'GET');
  if (escritas.length) {
    console.warn(`⚠️  ${escritas.length} rota(s) de ESCRITA declaradas no arquivo — use SOMENTE ambiente de teste.`);
  }

  // Aquecimento: não conta no resultado, garante que cold start não vira P99.
  console.log('🔥 Aquecimento (10s)…');
  await executarEstagio(1, rotas, token, null).catch(() => undefined);

  const estagios = [];
  for (const c of ESTAGIOS) {
    const antes = await estadoServidor(token);
    process.stdout.write(`▶️  ${c} simultâneos… `);
    const r = await executarEstagio(c, rotas, token, antes);
    console.log(`RPS ${r.rps} · P50 ${r.p50_ms}ms · P95 ${r.p95_ms}ms · P99 ${r.p99_ms}ms · erros ${r.erros_total}`);
    estagios.push(r);
    if (PAUSA_S) await new Promise((res) => setTimeout(res, PAUSA_S * 1000));
  }

  const resultado = {
    base: BASE,
    gerado_em: new Date().toISOString(),
    duracao_por_estagio_s: DURACAO_S,
    estagios,
  };
  if (SAIDA) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SAIDA, JSON.stringify(resultado, null, 2));
    console.log(`💾 Resultado salvo em ${SAIDA}`);
  } else {
    console.log(JSON.stringify(resultado, null, 2));
  }

  // Veredito rápido contra as metas acordadas.
  const metas = {
    'consulta simples (produtos lista)': 500,
    'listagem paginada': 800,
    'busca SKU': 500,
  };
  console.log('\n📊 Metas (P95):');
  for (const [nome, alvo] of Object.entries(metas)) {
    const chave = Object.keys(estagios[0]?.por_rota ?? {}).find((k) => k.toLowerCase().includes(nome.split(' ')[0]));
    if (!chave) continue;
    const pior = Math.max(...estagios.map((e) => e.por_rota[chave]?.p95 ?? 0));
    console.log(`   ${chave}: pior P95 ${pior} ms (meta ${alvo} ms) ${pior <= alvo ? '✅' : '❌'}`);
  }
}

main().catch((e) => {
  console.error('❌ Falha no teste de carga:', e?.message || e);
  process.exit(1);
});
