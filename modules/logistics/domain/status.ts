// ============================================================================
// MOTOR DE FRETE › NORMALIZAÇÃO DE STATUS (PURO)
//
// Cada transportadora descreve o evento com o seu vocabulário ("Objeto
// entregue ao destinatário", "DELIVERED", "Saiu para entrega"). Este módulo
// traduz esse texto BRUTO para o vocabulário único do ERP.
//
// Duas garantias:
//   • status desconhecido NÃO vira progresso: mantém o status atual (não
//     inventa "entregue" a partir de um texto ambíguo);
//   • a tradução é determinística e testável — a mesma entrada produz sempre a
//     mesma saída, sem depender de rede.
// ============================================================================
import type { StatusLogistico } from './contract';

type Regra = { re: RegExp; status: StatusLogistico };

/**
 * Ordem IMPORTA: as regras mais específicas/terminais vêm primeiro. Um texto
 * que contenha "entregue" e "trânsito" (ex.: "saiu para entrega") casa na
 * primeira regra que se aplica.
 */
const REGRAS: Regra[] = [
  // entregue / finalizado
  { re: /entregue ao destinat|entregue com sucesso|delivered|entrega realizada|finalizad|recebido pelo destinat|objeto entregue/i, status: 'entregue' },
  // tentativa de entrega frustrada
  { re: /tentativa de entrega|ausente|destinat.*ausente|delivery attempt|nao atendido|não atendido|recusado pelo destinat/i, status: 'tentativa_falha' },
  // em rota de entrega
  { re: /saiu para entrega|em rota|out for delivery|em entrega|roteiriza/i, status: 'em_rota' },
  // devolvido
  { re: /devolv|returned|devolução|restituid/i, status: 'devolvido' },
  // extraviado / avariado
  { re: /extrav|lost|avaria|danificad|sinistr/i, status: 'extraviado' },
  // em trânsito
  { re: /em tr[âa]nsito|tr[âa]nsito|transit|a caminho|encaminhad|dispatch|em transfer|transfer[êe]ncia|roteiriza.*centro/i, status: 'em_transito' },
  // postado / coletado
  { re: /postad|post|coletad|collected|aceito|recebido pela transportadora|in transit|expedid/i, status: 'postado' },
  // cancelado
  { re: /cancelad|canceled|cancelled/i, status: 'cancelado' },
];

/**
 * Traduz o status BRUTO para o vocabulário do ERP.
 * Desconhecido mantém o `atual` — nunca inventa progresso.
 */
export function normalizarStatus(statusBruto: string, atual: StatusLogistico): StatusLogistico {
  const s = String(statusBruto || '').trim();
  if (!s) return atual;
  for (const regra of REGRAS) {
    if (regra.re.test(s)) return regra.status;
  }
  return atual;
}

/** O status bruto indica entrega concluída? (usado por reconciliação) */
export function indicaEntrega(statusBruto: string): boolean {
  return /entregue ao destinat|entregue com sucesso|delivered|entrega realizada|objeto entregue/i.test(String(statusBruto || ''));
}
