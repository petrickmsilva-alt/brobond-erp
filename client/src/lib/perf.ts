// ============================================================================
// RUM (Real User Monitoring) do Brobond ERP — leve, sem dependência e sem
// dado pessoal.
//
// O que é medido, por TELA:
//   • tempo até o primeiro paint da rota depois da navegação;
//   • TTFB da navegação (PerformanceNavigationTiming);
//   • quantidade de chamadas de API, bytes recebidos e quantas foram
//     DEDUPLICADAS pelo coalescing do `apiFetch`;
//   • latência por endpoint (para achar a chamada que trava a tela).
//
// O que NUNCA é enviado: URL com query, corpo de resposta, token, e-mail,
// nome de cliente, valores financeiros. Só contagens e milissegundos.
//
// O envio é agregado (a cada ~20s ou ao esconder a aba) para não criar tráfego
// de telemetria — irônico seria piorar a latência medindo a latência.
// ============================================================================

const ENDPOINT = '/api/metrics/frontend';
const INTERVALO_ENVIO_MS = 20_000;
/** Endpoints que não entram na conta (evita realimentar a própria medição). */
const IGNORAR = [/^\/metrics/];

type AcumuladoTela = {
  tela: string;
  api_chamadas: number;
  api_bytes: number;
  api_deduplicadas: number;
  inicio: number;
  enviado: boolean;
};

let atual: AcumuladoTela | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let enviando = false;

function endpointIgnorado(path: string): boolean {
  return IGNORAR.some((re) => re.test(path));
}

/** Converte uma URL de tela em rótulo estável: `/produtos/123` → `/produtos/:id`. */
export function rotuloDeTela(pathname: string): string {
  return String(pathname || '/')
    .split('?')[0]
    // UUID primeiro: se o padrão numérico rodasse antes, ele comeria os dígitos
    // iniciais do identificador e sobraria lixo no rótulo.
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id')
    .slice(0, 80);
}

function garantido(): AcumuladoTela {
  if (!atual) {
    atual = {
      tela: rotuloDeTela(typeof window !== 'undefined' ? window.location.pathname : '/'),
      api_chamadas: 0,
      api_bytes: 0,
      api_deduplicadas: 0,
      inicio: performance.now(),
      enviado: false,
    };
  }
  return atual;
}

/** Chamado pelo `apiFetch` a cada resposta (inclusive quando deduplicada). */
export function registrarChamadaApi(path: string, ms: number, bytes: number, deduplicada: boolean): void {
  if (typeof window === 'undefined') return;
  if (endpointIgnorado(path)) return;
  const a = garantido();
  a.api_chamadas++;
  a.api_bytes += Math.max(0, bytes || 0);
  if (deduplicada) a.api_deduplicadas++;
  // Marca para diagnóstico local (DevTools › Performance) sem gerar log.
  try {
    performance.mark(`api:${path.split('?')[0]}:${Math.round(ms)}ms`);
  } catch {
    /* performance.mark pode estourar se o nome for longo — irrelevante */
  }
}

/**
 * Marca o início de uma navegação e agenda a medição do primeiro paint.
 * Usa dois `requestAnimationFrame` (o segundo já é pós-paint) para não medir
 * antes de o navegador efetivamente desenhar a rota.
 */
export function iniciarMedicaoTela(pathname: string): void {
  if (typeof window === 'undefined') return;
  // Fecha a tela anterior antes de abrir a nova.
  finalizarMedicaoTela();
  atual = {
    tela: rotuloDeTela(pathname),
    api_chamadas: 0,
    api_bytes: 0,
    api_deduplicadas: 0,
    inicio: performance.now(),
    enviado: false,
  };
  if (!timer) {
    timer = setInterval(() => void enviar(), INTERVALO_ENVIO_MS);
    window.addEventListener('pagehide', () => void enviar(true), { once: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void enviar(true);
    });
  }
}

function ttfbDaNavegacao(): number | undefined {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && Number.isFinite(nav.responseStart)) return Math.max(0, Math.round(nav.responseStart));
  } catch {
    /* API ausente em navegadores antigos */
  }
  return undefined;
}

/** Fecha a medição da tela atual no próximo paint e a enfileira para envio. */
export function finalizarMedicaoTela(): void {
  if (typeof window === 'undefined' || !atual) return;
  const a = atual;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (a.enviado) return;
      const ms = Math.round(performance.now() - a.inicio);
      if (ms <= 0 || ms > 600_000) return;
      fila.push({
        tela: a.tela,
        ms,
        ttfb_ms: ttfbDaNavegacao(),
        api_bytes: a.api_bytes,
        api_chamadas: a.api_chamadas,
        api_deduplicadas: a.api_deduplicadas,
      });
      a.enviado = true;
      if (fila.length >= 20) void enviar();
    });
  });
}

type Amostra = {
  tela: string;
  ms: number;
  ttfb_ms?: number;
  api_bytes?: number;
  api_chamadas?: number;
  api_deduplicadas?: number;
};

const fila: Amostra[] = [];

/** Envia o lote. Silencioso por desenho: telemetria nunca atrapalha o usuário. */
export async function enviar(keepalive = false): Promise<void> {
  if (enviando || !fila.length) return;
  if (typeof window === 'undefined') return;
  const amostras = fila.splice(0, 50);
  enviando = true;
  try {
    const token = localStorage.getItem('brobond_token');
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ amostras }),
      keepalive,
    });
  } catch {
    // Sem rede (ou endpoint indisponível): descarta o lote. Não há retry —
    // reenviar telemetria em um cliente com problema de rede só piora.
  } finally {
    enviando = false;
  }
}
