// ============================================================================
// GANCHO DE CONVERSÃO — ponte sales → vendas (marketplaceOperacional).
//
// O Commerce precisa, na MESMA transação SERIALIZABLE da conversão, de duas
// coisas antes do faturamento:
//   1. consumir a RESERVA de checkout (senão o próprio estoque reservado
//      bloqueia o faturamento — disponível = físico − reservado);
//   2. carimbar frete/desconto do checkout na venda operacional.
//
// O módulo commerce registra a função; a ponte CHAMA se houver. Registro é
// best-effort por contrato da ponte? NÃO — aqui a falha propaga: dinheiro e
// estoque não são best-effort. Com hook nulo (fora do boot do servidor) nada
// muda para os testes legados.
// ============================================================================
import type { Tx } from './store';

export type ConversaoContexto = {
  saleId: string;
  empresaId: number;
  vendaId: number;
  canal: string;
  pedidoExternoId: string;
};

export type GanchoConversao = (ctx: ConversaoContexto, tx: Tx) => Promise<void>;

let gancho: GanchoConversao | null = null;

/** Registra (ou desliga com null) o gancho pré-faturamento da conversão. */
export function setOnVendaConvertendo(fn: GanchoConversao | null): void {
  gancho = fn;
}

/** Executa o gancho dentro da transação — sem hook, nada a fazer. */
export async function executarGanchoConversao(ctx: ConversaoContexto, tx: Tx): Promise<void> {
  if (!gancho) return;
  await gancho(ctx, tx);
}
