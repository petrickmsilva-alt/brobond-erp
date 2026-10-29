import { cifrarSegredo } from '../segredos';
import type { Row } from '../store';
import { empresaDaVitrine } from './loja-base';

/** Reutiliza as credenciais já provisionadas no deploy, sem copiá-las ao banco.
 * Exclusivo da empresa determinística da vitrine. Nunca é um fallback global
 * por usuário/tenant. Uma configuração persistida (inclusive inativa) tem prioridade.
 * As cifras são transitórias e usam o contrato do gateway canônico, também no webhook.
 */
export async function gatewayAmbienteDaVitrine(empresaId: number): Promise<Row | null> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhook = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!token || !webhook || await empresaDaVitrine() !== empresaId) return null;
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
