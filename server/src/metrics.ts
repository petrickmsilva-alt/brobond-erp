// ============================================================================
// BROBOND ERP — MÉTRICAS DE PERFORMANCE (em processo, sem dependência externa).
//
// Objetivo: provar ONDE o tempo é gasto — tempo total HTTP, tempo de banco por
// requisição, espera por conexão do pool, chamadas externas, lag do event loop,
// CPU e memória — com P50/P95/P99 por rota.
//
// REGRAS DE PRIVACIDADE (inegociáveis):
//   • NUNCA registramos corpo, query string, cookies, Authorization, e-mail,
//     CPF/CNPJ, token ou qualquer valor de parâmetro.
//   • Métricas de SQL guardam apenas uma IMPRESSÃO DIGITAL normalizada
//     (verbo + tabelas, literais removidos). Valores nunca entram.
//   • Rotas são registradas pelo PADRÃO declarado (`req.route.path`), nunca pela
//     URL bruta. `:resource` só entra se casar com um slug conhecido.
//   • Chamadas externas guardam apenas o HOST (nunca path com token).
//
// O coletor é sempre ativo e custa O(1) por evento (ring buffer de tamanho fixo).
// A leitura fica em /api/metrics (admin) ou no log periódico.
// ============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Amostragem com percentis exatos sobre uma janela recente (ring buffer).
// ---------------------------------------------------------------------------
export class Amostra {
  readonly capacidade: number;
  private readonly buf: Float64Array;
  private pos = 0;
  private n = 0;
  total = 0;
  soma = 0;
  minimo = Number.POSITIVE_INFINITY;
  maximo = 0;
  erros = 0;
  ultimo = 0;

  constructor(capacidade: number) {
    this.capacidade = capacidade;
    this.buf = new Float64Array(capacidade);
  }

  registrar(valor: number, erro = false): void {
    if (!Number.isFinite(valor) || valor < 0) return;
    this.buf[this.pos] = valor;
    this.pos = (this.pos + 1) % this.capacidade;
    if (this.n < this.capacidade) this.n++;
    this.total++;
    this.soma += valor;
    this.ultimo = valor;
    if (valor < this.minimo) this.minimo = valor;
    if (valor > this.maximo) this.maximo = valor;
    if (erro) this.erros++;
  }

  /** Percentil por posto mais próximo sobre a janela (0..100). */
  percentil(p: number): number {
    if (!this.n) return 0;
    const copia = this.buf.slice(0, this.n);
    copia.sort();
    const idx = Math.min(copia.length - 1, Math.max(0, Math.ceil((p / 100) * copia.length) - 1));
    // Arredonda para 2 casas: o valor é milissegundos com resolução de
    // microssegundos (`performance.now`), e o float completo só polui o relatório.
    return Math.round(copia[idx] * 100) / 100;
  }

  get media(): number {
    return this.total ? Math.round((this.soma / this.total) * 100) / 100 : 0;
  }

  resumo() {
    return {
      total: this.total,
      erros: this.erros,
      media_ms: this.media,
      p50_ms: this.percentil(50),
      p95_ms: this.percentil(95),
      p99_ms: this.percentil(99),
      max_ms: this.maximo,
      ultimo_ms: this.ultimo,
      amostras: this.n,
    };
  }
}

const LIMITE_ROTAS = 400;
const LIMITE_CONSULTAS = 200;
const LIMITE_EXTERNOS = 60;

/** Mapa limitado: quando estoura, descarta a chave mais antiga (inserção). */
class MapaLimitado<V> extends Map<string, V> {
  constructor(private readonly limite: number) {
    super();
  }
  override set(k: string, v: V): this {
    if (!this.has(k) && this.size >= this.limite) {
      const primeira = this.keys().next();
      if (!primeira.done) this.delete(primeira.value);
    }
    return super.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Contexto por requisição (AsyncLocalStorage): atribui tempo de banco, espera
// por conexão e chamadas externas à requisição que as originou.
// ---------------------------------------------------------------------------
export interface ContextoRequisicao {
  requestId: string;
  metodo: string;
  rota: string;
  inicio: number;
  /** Soma do tempo de todas as consultas SQL desta requisição. */
  dbMs: number;
  dbConsultas: number;
  /** Tempo esperando vaga/conexão no pool. */
  esperaMs: number;
  externoMs: number;
  externoChamadas: number;
  /** Marcas de fase opcionais (ex.: middleware → handler). */
  fases?: Record<string, number>;
}

export const contextoRequisicao = new AsyncLocalStorage<ContextoRequisicao>();

export function agoraMs(): number {
  return performance.now();
}

/** Executa `fn` com o contexto da requisição disponível para todo o await chain. */
export function comContexto<T>(ctx: ContextoRequisicao, fn: () => T): T {
  return contextoRequisicao.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Registro global
// ---------------------------------------------------------------------------
const httpPorRota = new MapaLimitado<Amostra>(LIMITE_ROTAS);
const dbGlobal = new Amostra(2048);
const dbEspera = new Amostra(2048);
const dbPorImpressao = new MapaLimitado<Amostra>(LIMITE_CONSULTAS);
const externos = new MapaLimitado<Amostra>(LIMITE_EXTERNOS);
const frontendPorTela = new MapaLimitado<Amostra>(200);
const contadores = new Map<string, number>();
const gargalos: Gargalo[] = [];
const LIMITE_GARGALOS = 200;

/** Consulta lenta (ou requisição lenta) registrada para diagnóstico. */
export interface Gargalo {
  quando: string;
  tipo: 'sql' | 'http' | 'externo';
  impressao: string;
  ms: number;
  rota?: string;
  linhas?: number;
}

let emVoo = 0;
let emVooMaximo = 0;
let picoEsperaPool = 0;
let iniciadoEm = Date.now();

export function incrementar(nome: string, delta = 1): void {
  contadores.set(nome, (contadores.get(nome) ?? 0) + delta);
}

export function lerContador(nome: string): number {
  return contadores.get(nome) ?? 0;
}

function registrarGargalo(g: Gargalo) {
  gargalos.push(g);
  if (gargalos.length > LIMITE_GARGALOS) gargalos.shift();
}

/**
 * Impressão digital SEGURA de um SQL: verbo + tabelas, sem literais.
 *
 * Remove comentários, colapsa espaços, troca todo literal (string, número,
 * data) por `?` e mantém apenas os identificadores de tabela após
 * FROM/JOIN/UPDATE/INTO. É o suficiente para agrupar consultas iguais e
 * comparar planos, sem nunca guardar dado de cliente.
 */
export function impressaoSql(sql: string): string {
  const limpo = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'([^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  const verbo = (/^\s*(\w+)/.exec(limpo)?.[1] ?? 'outro').toLowerCase();
  const tabelas = [
    ...limpo.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi),
  ]
    .map((m) => m[1].toLowerCase())
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 4);
  return `${verbo} ${tabelas.join(',') || '(sem-tabela)'}`.slice(0, 120);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export function registrarHttp(rota: string, metodo: string, status: number, ms: number, bytes = 0): void {
  const chave = `${metodo} ${rota}`;
  let amostra = httpPorRota.get(chave);
  if (!amostra) {
    amostra = new Amostra(1024);
    httpPorRota.set(chave, amostra);
  }
  amostra.registrar(ms, status >= 500);
  incrementar(`http.status.${Math.floor(status / 100)}xx`);
  incrementar('http.total');
  if (bytes > 0) incrementar('http.bytes', bytes);
  if (ms >= LIMIAR_LENTO_HTTP) {
    registrarGargalo({
      quando: new Date().toISOString(),
      tipo: 'http',
      impressao: chave,
      ms: Math.round(ms),
      rota: chave,
    });
  }
}

export function requisicaoIniciada(): void {
  emVoo++;
  if (emVoo > emVooMaximo) emVooMaximo = emVoo;
}

export function requisicaoFinalizada(): void {
  if (emVoo > 0) emVoo--;
}

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
const LIMIAR_LENTO_SQL = Number(process.env.PERF_SQL_LENTO_MS) || 300;
const LIMIAR_LENTO_HTTP = Number(process.env.PERF_HTTP_LENTO_MS) || 1500;

export function registrarConsulta(sql: string, ms: number, linhas = 0, erro = false): void {
  const impressao = impressaoSql(sql);
  dbGlobal.registrar(ms, erro);
  let amostra = dbPorImpressao.get(impressao);
  if (!amostra) {
    amostra = new Amostra(256);
    dbPorImpressao.set(impressao, amostra);
  }
  amostra.registrar(ms, erro);

  const ctx = contextoRequisicao.getStore();
  if (ctx) {
    ctx.dbMs += ms;
    ctx.dbConsultas++;
  }
  if (ms >= LIMIAR_LENTO_SQL) {
    registrarGargalo({
      quando: new Date().toISOString(),
      tipo: 'sql',
      impressao,
      ms: Math.round(ms),
      rota: ctx?.rota,
      linhas,
    });
  }
}

export function registrarEsperaPool(ms: number): void {
  dbEspera.registrar(ms);
  const ctx = contextoRequisicao.getStore();
  if (ctx) ctx.esperaMs += ms;
}

export function registrarPicoEspera(quantidade: number): void {
  if (quantidade > picoEsperaPool) picoEsperaPool = quantidade;
}

// ---------------------------------------------------------------------------
// Serviços externos
// ---------------------------------------------------------------------------
export function registrarExterno(nome: string, ms: number, ok: boolean): void {
  let amostra = externos.get(nome);
  if (!amostra) {
    amostra = new Amostra(256);
    externos.set(nome, amostra);
  }
  amostra.registrar(ms, !ok);
  const ctx = contextoRequisicao.getStore();
  if (ctx) {
    ctx.externoMs += ms;
    ctx.externoChamadas++;
    // Rastrear como fase ajuda a separar "espera de terceiro" de "nosso código".
    ctx.fases = { ...(ctx.fases ?? {}), [`externo:${nome}`]: ms };
  }
  if (!ok) incrementar('externo.erro');
}

// ---------------------------------------------------------------------------
// Frontend (RUM): o navegador envia, o servidor agrega.
// ---------------------------------------------------------------------------
export interface AmostraFrontend {
  tela: string;
  /** Tempo até a tela ficar utilizável (ms). */
  ms: number;
  /** TTFB da navegação (ms). */
  ttfb_ms?: number;
  /** Bytes transferidos da API nesta tela. */
  api_bytes?: number;
  /** Quantidade de chamadas de API nesta tela. */
  api_chamadas?: number;
  /** Requisições repetidas evitadas pelo coalescing. */
  api_deduplicadas?: number;
}

/**
 * Normaliza o rótulo de tela TAMBÉM no servidor (defesa em profundidade):
 * descarta query/fragmento, e-mails, UUIDs, CPF/CNPJ e segmentos numéricos
 * antes de agregar em memória, mesmo se um cliente enviar URL não normalizada.
 */
function normalizarTelaRum(bruto: unknown): string {
  const semQuery = String(bruto || '').split(/[?#]/)[0];
  return (
    semQuery
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g, ':redigido')
      .replace(/\b\d{2,3}\.?\d{3}\.?\d{3}[/-]?\d{2,4}(?:-?\d{2})?\b/g, ':id')
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
      .replace(/\/\d+/g, '/:id')
      .slice(0, 80)
      .replace(/[^\w/:#.-]/g, '') || '(desconhecida)'
  );
}

export function registrarFrontend(a: AmostraFrontend): void {
  const tela = normalizarTelaRum(a.tela);
  if (!Number.isFinite(a.ms) || a.ms < 0 || a.ms > 600_000) return;
  let amostra = frontendPorTela.get(tela);
  if (!amostra) {
    amostra = new Amostra(512);
    frontendPorTela.set(tela, amostra);
  }
  amostra.registrar(a.ms);
  if (Number.isFinite(a.ttfb_ms)) {
    let ttfb = frontendPorTela.get(`${tela} ttfb`);
    if (!ttfb) {
      ttfb = new Amostra(256);
      frontendPorTela.set(`${tela} ttfb`, ttfb);
    }
    ttfb.registrar(Number(a.ttfb_ms));
  }
  if (Number.isFinite(a.api_chamadas)) incrementar('frontend.api_chamadas', Number(a.api_chamadas));
  if (Number.isFinite(a.api_bytes)) incrementar('frontend.api_bytes', Number(a.api_bytes));
  if (Number.isFinite(a.api_deduplicadas)) incrementar('frontend.api_deduplicadas', Number(a.api_deduplicadas));
}

// ---------------------------------------------------------------------------
// Processo: CPU, memória, event loop
// ---------------------------------------------------------------------------
// `monitorEventLoopDelay` mede o atraso de um timer periódico. Com loop OCIOSO
// o valor reportado tende à própria resolução do amostrador (não a zero), o que
// faria um servidor saudável parecer "20 ms de lag". Reportamos o atraso ACIMA
// da resolução esperada, que é o que de fato indica bloqueio do event loop.
const RESOLUCAO_LAG_MS = 10;
const histogramaLag = monitorEventLoopDelay({ resolution: RESOLUCAO_LAG_MS });
let lagAtivo = false;
let cpuAnterior = process.cpuUsage();
let cpuAnteriorEm = Date.now();
let cpuPercentual = 0;

export function iniciarColetaDeProcesso(): void {
  if (lagAtivo) return;
  lagAtivo = true;
  histogramaLag.enable();
  iniciadoEm = Date.now();
  const t = setInterval(() => {
    const uso = process.cpuUsage(cpuAnterior);
    const agora = Date.now();
    const decorridoMs = Math.max(1, agora - cpuAnteriorEm);
    cpuPercentual = Math.round(((uso.user + uso.system) / 1000 / decorridoMs) * 1000) / 10;
    cpuAnterior = process.cpuUsage();
    cpuAnteriorEm = agora;
    const poolStats = (globalThis as { __brobondPool?: Pool }).__brobondPool;
    if (poolStats) registrarPicoEspera(poolStats.waitingCount ?? 0);
  }, 5_000);
  t.unref?.();
}

/** Atraso acima da resolução do amostrador (0 = loop sem bloqueio perceptível). */
function lagAcimaDaResolucao(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0) return 0;
  return Math.round((Math.max(0, ns / 1e6 - RESOLUCAO_LAG_MS)) * 100) / 100;
}

function resumoProcesso() {
  const mem = process.memoryUsage();
  return {
    uptime_s: Math.round((Date.now() - iniciadoEm) / 1000),
    rss_mb: Math.round((mem.rss / 1048576) * 10) / 10,
    heap_usado_mb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    heap_total_mb: Math.round((mem.heapTotal / 1048576) * 10) / 10,
    externo_mb: Math.round((mem.external / 1048576) * 10) / 10,
    cpu_pct: cpuPercentual,
    event_loop_lag_p50_ms: lagAcimaDaResolucao(histogramaLag.percentile(50)),
    event_loop_lag_p95_ms: lagAcimaDaResolucao(histogramaLag.percentile(95)),
    event_loop_lag_p99_ms: lagAcimaDaResolucao(histogramaLag.percentile(99)),
    event_loop_lag_max_ms: lagAcimaDaResolucao(histogramaLag.max),
    requisicoes_em_voo: emVoo,
    requisicoes_em_voo_pico: emVooMaximo,
    carga_ultima_1min: Math.round((process as unknown as { _getActiveRequests?: () => number })._getActiveRequests?.() ?? 0),
  };
}

function resumoPool(pool: Pool | null | undefined) {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    ociosas: pool.idleCount,
    em_uso: pool.totalCount - pool.idleCount,
    aguardando: pool.waitingCount,
    aguardando_pico: picoEsperaPool,
    max_configurado: (pool as unknown as { options?: { max?: number } }).options?.max ?? null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot / export
// ---------------------------------------------------------------------------
export interface Snapshot {
  gerado_em: string;
  processo: ReturnType<typeof resumoProcesso>;
  http: Record<string, ReturnType<Amostra['resumo']>>;
  banco: {
    global: ReturnType<Amostra['resumo']>;
    espera_pool: ReturnType<Amostra['resumo']>;
    pool: ReturnType<typeof resumoPool>;
    consultas: Array<{ impressao: string } & ReturnType<Amostra['resumo']>>;
  };
  externos: Record<string, ReturnType<Amostra['resumo']>>;
  frontend: Record<string, ReturnType<Amostra['resumo']>>;
  gargalos: Gargalo[];
  contadores: Record<string, number>;
}

let poolRegistrado: Pool | null = null;

export function snapshot(): Snapshot {
  const consultas = [...dbPorImpressao.entries()]
    .map(([impressao, amostra]) => ({ impressao, ...amostra.resumo() }))
    .sort((a, b) => b.p95_ms * b.total - a.p95_ms * a.total)
    .slice(0, 50);
  const http: Record<string, ReturnType<Amostra['resumo']>> = {};
  for (const [rota, amostra] of httpPorRota) http[rota] = amostra.resumo();
  return {
    gerado_em: new Date().toISOString(),
    processo: resumoProcesso(),
    http,
    banco: {
      global: dbGlobal.resumo(),
      espera_pool: dbEspera.resumo(),
      pool: resumoPool(poolRegistrado),
      consultas,
    },
    externos: Object.fromEntries([...externos].map(([k, v]) => [k, v.resumo()])),
    frontend: Object.fromEntries([...frontendPorTela].map(([k, v]) => [k, v.resumo()])),
    gargalos: [...gargalos].slice(-50).reverse(),
    contadores: Object.fromEntries(contadores),
  };
}

/** Formato de texto Prometheus (para scrape opcional). */
export function prometheus(): string {
  const linhas: string[] = [];
  const p = resumoProcesso();
  linhas.push('# HELP brobond_processo_rss_mb Memoria residente em MB');
  linhas.push('# TYPE brobond_processo_rss_mb gauge');
  linhas.push(`brobond_processo_rss_mb ${p.rss_mb}`);
  linhas.push(`brobond_processo_heap_usado_mb ${p.heap_usado_mb}`);
  linhas.push(`brobond_processo_cpu_pct ${p.cpu_pct}`);
  linhas.push(`brobond_event_loop_lag_p99_ms ${p.event_loop_lag_p99_ms}`);
  linhas.push(`brobond_requisicoes_em_voo ${p.requisicoes_em_voo}`);
  const pool = resumoPool(poolRegistrado);
  if (pool) {
    linhas.push(`brobond_pool_conexoes_total ${pool.total}`);
    linhas.push(`brobond_pool_em_uso ${pool.em_uso}`);
    linhas.push(`brobond_pool_aguardando ${pool.aguardando}`);
  }
  linhas.push('# TYPE brobond_http_duracao_ms summary');
  for (const [rota, amostra] of httpPorRota) {
    const r = amostra.resumo();
    const rotulo = rota.replace(/"/g, '');
    linhas.push(`brobond_http_duracao_ms{rota="${rotulo}",quantil="0.5"} ${r.p50_ms}`);
    linhas.push(`brobond_http_duracao_ms{rota="${rotulo}",quantil="0.95"} ${r.p95_ms}`);
    linhas.push(`brobond_http_duracao_ms{rota="${rotulo}",quantil="0.99"} ${r.p99_ms}`);
    linhas.push(`brobond_http_requisicoes_total{rota="${rotulo}"} ${r.total}`);
    linhas.push(`brobond_http_erros_total{rota="${rotulo}"} ${r.erros}`);
  }
  linhas.push('# TYPE brobond_db_duracao_ms summary');
  const db = dbGlobal.resumo();
  linhas.push(`brobond_db_duracao_ms{quantil="0.5"} ${db.p50_ms}`);
  linhas.push(`brobond_db_duracao_ms{quantil="0.95"} ${db.p95_ms}`);
  linhas.push(`brobond_db_duracao_ms{quantil="0.99"} ${db.p99_ms}`);
  linhas.push(`brobond_db_consultas_total ${db.total}`);
  return `${linhas.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Instrumentação do pool pg — um único ponto cobre TODA consulta do processo
// (CRUD, transações, cron, commerce, backups), inclusive `pool.query` e
// `client.query` dentro de transação.
// ---------------------------------------------------------------------------
const clientesInstrumentados = new WeakSet<PoolClient>();

/** Callback no estilo node (err, resultado) usado pelas sobrecargas do `pg`. */
type CallbackPg = (...args: unknown[]) => unknown;

function instrumentarCliente(client: PoolClient): void {
  if (clientesInstrumentados.has(client)) return;
  clientesInstrumentados.add(client);
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;

  (client as unknown as { query: (...args: unknown[]) => unknown }).query = function (
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const primeiro = args[0] as unknown;
    const sql =
      typeof primeiro === 'string'
        ? primeiro
        : ((primeiro as { text?: string } | undefined)?.text ?? '');
    const inicio = agoraMs();
    const cb =
      typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as CallbackPg) : null;

    const finalizar = (resultado: unknown, erro: unknown) => {
      const ms = agoraMs() - inicio;
      const linhas =
        (resultado as { rowCount?: number | null; rows?: unknown[] } | undefined)?.rowCount ??
        (resultado as { rows?: unknown[] } | undefined)?.rows?.length ??
        0;
      registrarConsulta(sql, ms, Number(linhas) || 0, Boolean(erro));
    };

    if (cb) {
      const envolvido = (...retorno: unknown[]) => {
        finalizar(retorno[1], retorno[0]);
        return cb(...retorno);
      };
      args[args.length - 1] = envolvido;
      return original(...args);
    }

    let promessa: Promise<unknown>;
    try {
      promessa = original(...args) as Promise<unknown>;
    } catch (e) {
      finalizar(undefined, e);
      throw e;
    }
    if (!promessa || typeof (promessa as Promise<unknown>).then !== 'function') return promessa;
    return promessa.then(
      (r) => {
        finalizar(r, null);
        return r;
      },
      (e) => {
        finalizar(undefined, e);
        throw e;
      }
    );
  } as never;
}

/**
 * Instrumenta o pool: tempo de espera por conexão (fila do pg) + cada consulta.
 * Não altera semântica: os métodos originais são chamados com os mesmos
 * argumentos e o mesmo `this`; callbacks e promises continuam iguais.
 */
export function instrumentarPool(pool: Pool): void {
  if (poolRegistrado === pool) return;
  poolRegistrado = pool;
  (globalThis as { __brobondPool?: Pool }).__brobondPool = pool;

  pool.on('connect', (client) => instrumentarCliente(client));
  // Clientes já existentes no momento da instrumentação (ex.: order reorder).
  const existentes = (pool as unknown as { _clients?: PoolClient[] })._clients ?? [];
  for (const cliente of existentes) instrumentarCliente(cliente);

  const connectOriginal = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = function (
    ...args: unknown[]
  ): unknown {
    const inicio = agoraMs();
    const cb = typeof args[0] === 'function' ? (args[0] as CallbackPg) : null;
    if (cb) args.shift();

    let promessa: Promise<PoolClient>;
    try {
      promessa = connectOriginal(...args) as Promise<PoolClient>;
    } catch (e) {
      registrarEsperaPool(agoraMs() - inicio);
      if (cb) {
        cb(e);
        return undefined;
      }
      throw e;
    }
    promessa.then(
      () => registrarEsperaPool(agoraMs() - inicio),
      () => registrarEsperaPool(agoraMs() - inicio)
    );
    if (cb) {
      promessa.then(
        (c) => cb(null, c),
        (e) => cb(e)
      );
      return undefined;
    }
    return promessa;
  } as never;
}

// ---------------------------------------------------------------------------
// Instrumentação de fetch (serviços externos) — guarda apenas o host.
// ---------------------------------------------------------------------------
export function instrumentarFetchGlobal(): void {
  const original = globalThis.fetch;
  if (!original || (original as { __brobond?: boolean }).__brobond) return;
  const envolvido = async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.toString() : entrada.url;
    // Só HTTP(S) absoluto; URL interna/relativa não é "serviço externo".
    let host = '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return original(entrada, init);
      host = u.host;
    } catch {
      return original(entrada, init);
    }
    const inicio = agoraMs();
    try {
      const resposta = await original(entrada, init);
      registrarExterno(host, agoraMs() - inicio, resposta.ok);
      return resposta;
    } catch (e) {
      registrarExterno(host, agoraMs() - inicio, false);
      throw e;
    }
  };
  (envolvido as { __brobond?: boolean }).__brobond = true;
  globalThis.fetch = envolvido as typeof fetch;
}
