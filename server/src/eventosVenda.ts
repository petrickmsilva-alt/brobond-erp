// ============================================================
// Eventos da venda do ERP — gancho de ciclo de vida (ERP-04).
//
// Por que este arquivo existe: o motor 1. MEU NEGÓCIOS precisa saber que
// uma venda do ERP mudou de estado (faturada / estornada) para manter a
// projeção `vendas → sales` fresca — ver docs/ADR-001-FONTE-UNICA-FATURAMENTO.md.
//
// O fluxo operacional da venda (`server/src/itens.ts`) NÃO pode importar o
// motor: `negocios.ts` importa `services.ts`, que importa `itens.ts` — um
// import de mão dupla criaria ciclo. Este módulo é folha: não importa nada do
// ERP, só anuncia. É o mesmo contrato do gancho de ingestão dos conectores
// (`modules/connectors/core/sale-events.ts`): o anunciante é agnóstico e a
// notificação NUNCA derruba o fluxo que a disparou.
// ============================================================

export interface VendaErpEvento {
  vendaId: number;
  /** Ator que executou a transição (faturamento/estorno); pode ser nulo. */
  usuarioId: number | null;
  /** Estado final da venda no momento do anúncio. */
  status: 'faturada' | 'entregue' | 'cancelada';
}

export type VendaErpListener = (evento: VendaErpEvento) => void | Promise<void>;

let listener: VendaErpListener | null = null;

export function setOnVendaErpAlterada(fn: VendaErpListener | null): void {
  listener = fn;
}

/**
 * Anuncia a venda faturada/estornada. O listener roda em segundo plano
 * (o motor agenda a projeção com debounce), então esta função é síncrona e
 * "best effort": nunca lança, nunca atrasa o fluxo da venda.
 */
export function notificarVendaErpAlterada(evento: VendaErpEvento): void {
  if (!listener) return;
  try {
    const resultado = listener(evento);
    if (resultado && typeof (resultado as Promise<void>).catch === 'function') {
      void (resultado as Promise<void>).catch((erro) => {
        console.warn('⚠️  Motor 1. MEU NEGÓCIOS: listener de venda do ERP falhou —', erro instanceof Error ? erro.message : erro);
      });
    }
  } catch (erro) {
    console.warn('⚠️  Motor 1. MEU NEGÓCIOS: listener de venda do ERP falhou —', erro instanceof Error ? erro.message : erro);
  }
}
