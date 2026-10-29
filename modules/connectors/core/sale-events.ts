/**
 * Gancho de pós-ingestão de vendas — notificação de que uma venda de
 * marketplace foi criada/atualizada em `sales`.
 *
 * Motor analítico "1. MEU NEGÓCIOS": o servidor registra um listener
 * no boot (`server/src/negocios.ts`) para recalcular a margem da venda
 * afetada e refrescar a curva ABC em segundo plano, com debounce. O
 * módulo de conectores permanece agnóstico de framework — ele só
 * anuncia o evento, nunca conhece o motor.
 *
 * Mesmo contrato de robustez do gancho de auditoria: a notificação
 * NUNCA derruba a ingestão — falha no listener é logada e a venda já
 * gravada permanece íntegra (o ciclo de recálculo do motor pega o que
 * escapar).
 */

export interface SaleIngestedEvent {
  /** Empresa da venda, derivada da conexão que a ingeriu. */
  empresaId: number;
  saleId: string;
  /** `created` = nova venda; `updated` = reescrita por reentrega corrigida. */
  outcome: 'created' | 'updated';
  channel: string;
}

export type SaleIngestedListener = (event: SaleIngestedEvent) => void | Promise<void>;

let listener: SaleIngestedListener | null = null;
/**
 * Listadores ADICIONAIS (registram-se sem sobrescrever o principal).
 * O Commerce OS usa este caminho para a conversão automática sales → vendas
 * enquanto o listener principal continua sendo o motor 1. MEU NEGÓCIOS.
 */
const extras = new Set<SaleIngestedListener>();

export function setOnSaleIngested(fn: SaleIngestedListener | null): void {
  listener = fn;
}

/** Registra um ouvinte adicional (retorna função de remoção). */
export function addOnSaleIngested(fn: SaleIngestedListener): () => void {
  extras.add(fn);
  return () => extras.delete(fn);
}

/** Notifica o(s) servidor(es) — "best effort", nunca lança. */
export async function notifySaleIngested(event: SaleIngestedEvent): Promise<void> {
  const alvos: SaleIngestedListener[] = listener ? [listener, ...extras] : [...extras];
  if (!alvos.length) return;
  for (const alvo of alvos) {
    try {
      await alvo(event);
    } catch (error) {
      console.warn(
        '⚠️  Listener de pós-ingestão de vendas indisponível:',
        error instanceof Error ? error.message : error
      );
    }
  }
}
