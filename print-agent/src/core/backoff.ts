// Backoff exponencial com jitter para o loop de polling: se o ERP está
// hibernando (Render Free) ou a rede caiu, o agente espera progressivamente
// mais em vez de martelar — e volta ao ritmo normal no primeiro sucesso.
export class Backoff {
  private falhas = 0;
  constructor(
    private baseMs = 3000,
    private maxMs = 60_000,
    private random: () => number = Math.random
  ) {}

  sucesso(): void {
    this.falhas = 0;
  }

  /** Próxima espera; `falhou` registra a falha antes de calcular. */
  proximaEspera(falhou: boolean): number {
    if (!falhou) {
      this.sucesso();
      return this.baseMs;
    }
    this.falhas++;
    const bruto = Math.min(this.maxMs, this.baseMs * 2 ** (this.falhas - 1));
    return Math.round(bruto * (0.8 + this.random() * 0.4)); // jitter ±20%
  }
}

export const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
