import { cifrarSegredo } from '../segredos';
import type { Row } from '../store';

// ============================================================================
// AMBIENTE DE PAGAMENTO (serviço COMPARTILHADO do Payment Engine).
//
// A loja nativa foi RETIRADA (ADR-0007). O reuso de credenciais provisionadas no
// deploy (variáveis de ambiente) NÃO era da vitrine: é do Payment Engine, usado
// por todos os canais. Por isso ele passa a resolver o próprio tenant por
// `COMMERCE_PAGAMENTO_EMPRESA_ID`, sem depender do resolvedor da vitrine
// (que deixou de existir).
//
// Regra inegociável: o ambiente só vale para a empresa EXPLICITAMENTE indicada —
// nunca é fallback global por usuário/tenant. Uma configuração persistida
// (inclusive inativa) tem prioridade; as cifras são transitórias e usam o
// contrato do gateway canônico, também no webhook.
// ============================================================================

/**
 * Empresa cujo ambiente fornece credenciais de pagamento. Fail-closed: sem a
 * variável (ou com valor inválido) não há reuso de ambiente.
 */
export function empresaDoAmbientePagamento(): number | null {
  const valor = String(process.env.COMMERCE_PAGAMENTO_EMPRESA_ID || '').trim();
  const n = Number(valor);
  return valor && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Reutiliza as credenciais de gateway já provisionadas no deploy, sem copiá-las ao banco. */
export async function gatewayAmbientePagamento(empresaId: number): Promise<Row | null> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhook = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!token || !webhook || empresaDoAmbientePagamento() !== empresaId) return null;
  return {
    id: null,
    empresa_id: empresaId,
    provider: 'mercadopago',
    ativo: true,
    ambiente: token.startsWith('TEST-') ? 'teste' : 'producao',
    origem: 'ambiente_commerce',
    credenciais_cifradas: cifrarSegredo(JSON.stringify({ access_token: token })),
    webhook_segredo_cifrado: cifrarSegredo(webhook),
  };
}
